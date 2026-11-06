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
const { createStandaloneGraphBuildHandler } = await import('./standalone-graph-worker.ts');
const { freezeStandaloneGraphRequest, standaloneGraphIdentity, STANDALONE_GRAPH_TRIGGER } = await import('./standalone-graph-runtime.ts');
const { MemoryMiroFishRuntimeStore } = await import('./runtime-store.ts');
const { createMiroFishGraphVersion } = await import('../knowledge-graph/mirofish-adapter.ts');
async function fixture() {
  const scope = { tenantId: `worker-${randomUUID()}`, corpusId: 'corpus' };
  const request = freezeStandaloneGraphRequest({ projectId: `proj_${randomUUID()}`, text: 'Alice builds software.',
    ontology: { entity_types: [{ name: 'PERSON', description: '', attributes: [], examples: [] }], edge_types: [], analysis_summary: '' },
    chunkSize: 600, chunkOverlap: 50, trustLevel: 'external', modelOverride: { provider: 'ollama', modelName: 'test-model' },
    embeddingModel: 'test-embedding', embeddingProvider: 'ollama' }, scope);
  const records = new MemoryMiroFishRuntimeStore(scope); await records.write('graph', request.id, request, { projectId: request.projectId });
  const identity = standaloneGraphIdentity(request);
  const job = { id: randomUUID(), ...scope, graphVersion: createMiroFishGraphVersion(identity), status: 'running', progress: 0,
    leaseToken: randomUUID(), metadata: { trigger: STANDALONE_GRAPH_TRIGGER, documentIdentity: identity,
      mirofishStandalone: { requestId: request.id, projectId: request.projectId, requestDigest: request.requestDigest, profileHash: request.profileHash } } };
  const graph = { graph_id: request.documentId, artifact_version: 'mirofish-graph-v2', node_count: 2, edge_count: 1,
    nodes: [{ uuid: 'alice', name: 'Alice', labels: ['PERSON'], summary: 'Developer', attributes: {} },
      { uuid: 'concept', name: 'Software', labels: ['CONCEPT'], summary: 'Software', attributes: {} }],
    edges: [{ uuid: 'edge', source_node_uuid: 'alice', target_node_uuid: 'concept', name: 'builds', fact: 'Alice builds software.', attributes: {} }],
    passages: [{ id: 'passage', document_id: request.documentId, content: request.text, index: 0, start_offset: 0, end_offset: request.text.length }],
    communities: [{ id: 'community', name: 'Development', entities: ['alice', 'concept'], relations: ['edge'], summary: '', keywords: [], level: 0 }] };
  const observed = { extracts: 0, writes: [], checkpoints: [], renewals: 0 };
  let prepared = null;
  const dependencies = { records, leaseMs: 90_000,
    commandStore: { async getCompatibilityDescriptor() { return null; } },
    checkpointStore: { async saveExtractionCheckpoint(value) { observed.checkpoints.push(value); }, async renewExtractionLease() { observed.renewals++; } },
    prepared: { async load() { return prepared; }, async save(_job, _request, artifact) { prepared ??= structuredClone(artifact); return structuredClone(prepared); } },
    async extractGraph(saved, checkpoint, signal) {
      observed.extracts++; assert.equal(saved.requestDigest, request.requestDigest); signal?.throwIfAborted();
      await checkpoint.save({ key: '0:0:21', sourceDigest: 'sha256:source', progress: .75 }, { kind: 'complete', result: { entities: [], relations: [] } });
      return structuredClone(graph);
    },
    artifactStore: { async put(artifact, options) {
      observed.writes.push({ artifact, options }); return { identity, artifactDigest: `sha256:${'a'.repeat(64)}` };
    } },
  };
  return { scope, request, records, job, graph, observed, dependencies };
}
test('standalone worker restores private source, saves checkpoints, filters ontology and publishes with its lease', async () => {
  const f = await fixture(); const result = await createStandaloneGraphBuildHandler(f.dependencies)(f.job);
  assert.equal(result.status, 'staged'); assert.equal(f.observed.extracts, 1); assert.equal(f.observed.checkpoints.length, 1);
  const { artifact, options } = f.observed.writes[0];
  assert.equal(artifact.graph.node_count, 1); assert.equal(artifact.graph.edge_count, 0);
  assert.deepEqual(artifact.graph.communities[0].entities, ['alice']);
  assert.equal(options.graphName, f.request.graphName);
  assert.deepEqual(options.buildLease, { jobId: f.job.id, leaseToken: f.job.leaseToken });
  assert(f.observed.renewals > 0);
});
test('a fresh worker resumes a prepared artifact after process loss without repeating extraction', async () => {
  const f = await fixture(); let failed = false;
  const put = f.dependencies.artifactStore.put;
  f.dependencies.artifactStore.put = async (...args) => { if (!failed) { failed = true; throw new Error('process stopped before staging'); } return put(...args); };
  await assert.rejects(createStandaloneGraphBuildHandler(f.dependencies)(f.job), /process stopped/);
  const second = await createStandaloneGraphBuildHandler(f.dependencies)({ ...f.job, leaseToken: randomUUID() });
  assert.equal(second.status, 'staged'); assert.equal(f.observed.extracts, 1);
  assert.equal(f.observed.writes.length, 1);
});
test('a changed source identity or an aborted job never reaches publication', async () => {
  const f = await fixture();
  await f.records.write('graph', f.request.id, { ...f.request, text: 'tampered' });
  await assert.rejects(createStandaloneGraphBuildHandler(f.dependencies)(f.job), error => error.code === 'MIROFISH_GRAPH_REQUEST_INVALID');
  assert.equal(f.observed.extracts, 0);
  await f.records.write('graph', f.request.id, f.request);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createStandaloneGraphBuildHandler(f.dependencies)(f.job, controller.signal));
  assert.equal(f.observed.writes.length, 0);
});
test('lost ownership before preparing or staging rejects the write', async () => {
  const f = await fixture();
  f.dependencies.checkpointStore.renewExtractionLease = async () => { throw new Error('lease lost'); };
  await assert.rejects(createStandaloneGraphBuildHandler(f.dependencies)(f.job), /lease lost/);
  assert.equal(f.observed.writes.length, 0);
});
