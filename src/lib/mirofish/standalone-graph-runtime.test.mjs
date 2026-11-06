import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const runtime = await import('./standalone-graph-runtime.ts');
const { MemoryMiroFishRuntimeStore } = await import('./runtime-store.ts');
const { createMiroFishGraphVersion } = await import('../knowledge-graph/mirofish-adapter.ts');
function fixture() {
  const scope = { tenantId: `graph-${randomUUID()}`, corpusId: 'corpus' };
  const records = new MemoryMiroFishRuntimeStore(scope);
  const values = new Map(); let enqueued = 0; let resumed = 0;
  const jobs = {
    async get(requested, id) { return requested.tenantId === scope.tenantId && requested.corpusId === scope.corpusId ? values.get(id) ?? null : null; },
    async enqueueDocumentBuild(requested, identity, metadata) {
      assert.equal(requested.tenantId, scope.tenantId);
      assert.ok(await records.read('graph', metadata.mirofishStandalone.requestId), 'source must be saved before queue insertion');
      assert(Buffer.byteLength(JSON.stringify(metadata)) < 16 * 1024);
      assert(!JSON.stringify(metadata).includes('private seed text'));
      const job = { id: randomUUID(), ...scope, graphVersion: createMiroFishGraphVersion(identity), status: 'queued', progress: 0,
        metadata: { ...metadata, documentIdentity: identity }, attempts: 0, leaseToken: null, leaseExpiresAt: null, artifactDigest: null, errorCode: null };
      values.set(job.id, job); enqueued++; return job;
    },
    async resumeFailedDocumentBuild(_scope, _identity, id) { resumed++; const job = values.get(id); job.status = 'queued'; return job; },
  };
  const input = { projectId: `proj_${randomUUID()}`, text: 'private seed text\n'.repeat(8000),
    ontology: { entity_types: [], edge_types: [], analysis_summary: '' }, chunkSize: 600, chunkOverlap: 50, trustLevel: 'external',
    modelOverride: { provider: 'ollama', modelName: 'llama3.1', temperature: .1 }, embeddingModel: 'qwen3-embedding:latest', embeddingProvider: 'ollama' };
  return { scope, records, jobs, input, values, counts: () => ({ enqueued, resumed }), dependencies: { records, jobs } };
}

test('freezing accepts an absent server TTL and hashes large text without canonical JSON size limits', () => {
  const f = fixture();
  const request = runtime.freezeStandaloneGraphRequest({ ...f.input, text: 'large text '.repeat(40_000), ttlMs: undefined }, f.scope);
  assert.equal(request.text.length, 440_000);
  assert.match(request.requestDigest, /^sha256:[a-f0-9]{64}$/);
  const withoutTtl = runtime.freezeStandaloneGraphRequest({ ...f.input, text: request.text }, f.scope);
  assert.equal(request.profileHash, withoutTtl.profileHash);
});

test('source hashing rejects unpaired UTF-16 surrogates instead of replacing them during UTF-8 encoding', async () => {
  const f = fixture();
  assert.throws(() => runtime.freezeStandaloneGraphRequest({ ...f.input, text: '\ud800' }, f.scope));
  assert.throws(() => runtime.freezeStandaloneGraphRequest({ ...f.input, text: '\udc00' }, f.scope));
  assert.equal(runtime.freezeStandaloneGraphRequest({ ...f.input, text: '👋' }, f.scope).text, '👋');
  const taskId = await runtime.enqueueStandaloneGraphBuild({ ...f.input, text: '\ufffd' }, f.scope, null, f.dependencies);
  const job = f.values.get(runtime.standaloneGraphJobId(taskId));
  const request = await runtime.readStandaloneGraphRequest(job, f.records);
  await f.records.write('graph', request.id, { ...request, text: '\ud800' });
  await assert.rejects(runtime.readStandaloneGraphRequest(job, f.records));
});
test('standalone graph stores large private source outside job metadata and recovers task status after a module reload', async () => {
  const f = fixture();
  const taskId = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, null, f.dependencies);
  const job = f.values.get(runtime.standaloneGraphJobId(taskId));
  job.status = 'running'; job.progress = .55;
  const freshRuntime = await import('./standalone-graph-runtime.ts?reloaded');
  const status = await freshRuntime.readStandaloneGraphTask(taskId, f.scope, f.dependencies);
  assert.equal(status.status, 'processing'); assert.equal(status.progress, 55);
  assert(!JSON.stringify(status).includes('private seed text'));
  const request = await runtime.readStandaloneGraphRequest(job, f.records);
  assert.equal(request.text, f.input.text); assert.equal(request.taskId, taskId);
  assert.equal(request.documentVersion, job.metadata.documentIdentity.documentVersion);
});
test('staging alone never unlocks graph completion and foreign scope remains hidden', async () => {
  const f = fixture(); const task = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, null, f.dependencies);
  const job = f.values.get(runtime.standaloneGraphJobId(task)); job.status = 'staged'; job.progress = 1;
  const staged = await runtime.readStandaloneGraphTask(task, f.scope, f.dependencies);
  assert.equal(staged.status, 'processing'); assert.equal(staged.graphId, undefined); assert.equal(staged.progress, 99);
  assert.equal(await runtime.readStandaloneGraphTask(task, { ...f.scope, corpusId: 'foreign' }, f.dependencies), null);
  job.status = 'validated';
  const complete = await runtime.readStandaloneGraphTask(task, f.scope, f.dependencies);
  assert.equal(complete.status, 'completed'); assert.equal(complete.progress, 100);
  assert.equal(complete.graphId, job.metadata.documentIdentity.documentId);
});
test('freezing the server default also supports Azure without allowing endpoint or credential overrides', () => {
  const f = fixture();
  const input = { ...f.input, modelOverride: { provider: 'azure', modelName: 'server-deployment', temperature: .1 } };
  assert.equal(runtime.freezeStandaloneGraphRequest(input, f.scope).modelOverride.provider, 'azure');
  assert.throws(() => runtime.freezeStandaloneGraphRequest({ ...input, modelOverride: { ...input.modelOverride, baseUrl: 'http://untrusted.invalid' } }, f.scope));
});
test('retry keeps the original job and extraction checkpoint when the frozen request is unchanged', async () => {
  const f = fixture(); const task = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, null, f.dependencies);
  const job = f.values.get(runtime.standaloneGraphJobId(task)); job.status = 'failed';
  job.metadata.graphExtractionCheckpoint = { profile: 'saved', segments: { leaf: { value: 'completed' } } };
  assert.equal(await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, task, f.dependencies), task);
  assert.deepEqual(f.counts(), { enqueued: 1, resumed: 1 });
  assert.equal(job.metadata.graphExtractionCheckpoint.segments.leaf.value, 'completed');
  job.status = 'running';
  await assert.rejects(runtime.enqueueStandaloneGraphBuild({ ...f.input, text: 'different source' }, f.scope, task, f.dependencies), /项目已有图谱构建任务/);
  assert.equal(f.counts().enqueued, 1);
});
test('request tracing and actor fields never change a durable source identity on recovery', async () => {
  const f = fixture(); const task = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, null, f.dependencies);
  const job = f.values.get(runtime.standaloneGraphJobId(task)); job.status = 'failed';
  assert.equal(await runtime.enqueueStandaloneGraphBuild(f.input, { ...f.scope, actorId: 'owner', requestId: 'new-request' }, task, f.dependencies), task);
  const saved = await runtime.readStandaloneGraphRequest(job, f.records);
  assert.deepEqual(saved.scope, f.scope);
});
test('recovery finds an active queued job even when the project still points at an older task', async () => {
  const f = fixture(); const task = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, null, f.dependencies);
  const restored = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, `task_${randomUUID()}`,
    { ...f.dependencies, findActive: async () => task });
  assert.equal(restored, task); assert.equal(f.counts().enqueued, 1);
});
test('tampered source, profile, or job identity is rejected before executing a model', async () => {
  const f = fixture(); const task = await runtime.enqueueStandaloneGraphBuild(f.input, f.scope, null, f.dependencies);
  const job = f.values.get(runtime.standaloneGraphJobId(task)); const request = await runtime.readStandaloneGraphRequest(job, f.records);
  for (const patch of [{ text: 'changed' }, { scope: undefined }, { profileHash: 'changed' }]) {
    await f.records.write('graph', request.id, { ...request, ...patch });
    await assert.rejects(runtime.readStandaloneGraphRequest(job, f.records), error => error.code === 'MIROFISH_GRAPH_REQUEST_INVALID');
  }
  await f.records.write('graph', request.id, request);
  job.graphVersion = 'other-version';
  await assert.rejects(runtime.readStandaloneGraphRequest(job, f.records), error => error.code === 'MIROFISH_GRAPH_REQUEST_INVALID');
});
