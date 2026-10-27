import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
let subject;
try { subject = await import('./postgres-publication-readback.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = v => structuredClone(v);
function fixture() {
  const scope = { environment: 'test-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const manifest = { schemaVersion: 'kg-build-publication-manifest/v1', tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a',
    artifactDigest: `sha256:${'a'.repeat(64)}`, documents: [{ documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' },
      { documentId: 'doc-b', documentVersion: 'v2', trustLevel: 'trusted' }] };
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: 3 };
  const publication = { pointer, outbox: { ...pointer, eventType: 'graph.snapshot.activated', publishedAt: '2026-10-10T06:00:00.000Z', deadLetteredAt: null },
    buildJob: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'published', artifactDigest: manifest.artifactDigest, publicationManifest: manifest } };
  const calls = []; const response = { rows: [{ publication }], rowCount: 1 };
  const client = { query(text, values) { calls.push({ text, values }); return Promise.resolve(clone(response)); } };
  const options = { executionProfile: 'local-reference', scope, operationTimeoutMs: 1000, maxReads: 4 };
  return { scope, manifest, publication, response, client, options, calls };
}
const reject = code => e => e instanceof subject.PostgresPublicationReadbackError && e.code === code && e.productionAuthorized === false
  && !/secret-token|tenant-a|doc-a|postgres:\/\//.test(e.message);

test('native PostgreSQL publication business readback entry point exists', () => {
  assert.equal(typeof subject.PostgresKnowledgeGraphPublicationReadback, 'function');
});
test('one parameterized SELECT reads all publication relations without filtering to expected graph/docs', async () => {
  const f = fixture(); const reader = new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options);
  const result = await reader.readPublication({}); assert.deepEqual(result.scope, f.scope);
  assert.deepEqual(result.buildJob.documents, f.manifest.documents); assert.equal(result.pointer.revision, 3);
  assert.ok(Object.isFrozen(result.buildJob.documents)); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].values, ['tenant-a', 'corpus-a']);
  assert.match(f.calls[0].text, /left join public\.graph_publication_outbox/); assert.match(f.calls[0].text, /left join public\.graph_build_jobs/);
  assert.match(f.calls[0].text, /event\.revision = pointer\.revision/); assert.match(f.calls[0].text, /job\.graph_version = pointer\.graph_version/);
  assert.match(f.calls[0].text, /date_trunc\('milliseconds', event\.published_at\)/);
  assert.match(f.calls[0].text, /then interval '1 millisecond' else interval '0' end\) at time zone 'UTC'/);
  assert.doesNotMatch(f.calls[0].text, /\b(insert|update|delete|for update|for share)\b/i);
  assert.doesNotMatch(f.calls[0].text, /tenant-a|doc-a|graph-a|limit\s+1/);
  assert.equal(reader.productionCapable, false); assert.equal(reader.executionProfile, 'local-reference');
  assert.ok(!Object.hasOwn(result, 'consistencyVerified')); assert.ok(!Object.hasOwn(result, 'productionAuthorized'));
});
test('absent, ambiguous and legacy metadata cannot fabricate an acknowledged complete publication', async () => {
  for (const edit of [f => { f.response.rows = []; f.response.rowCount = 0; }, f => { f.response.rows.push(clone(f.response.rows[0])); f.response.rowCount = 2; },
    f => { f.publication.outbox = null; }, f => { f.publication.buildJob = null; }, f => { f.publication.buildJob.publicationManifest = null; },
    f => { f.publication.buildJob.documentIdentity = { ...f.manifest.documents[0] }; delete f.publication.buildJob.publicationManifest; }]) {
    const f = fixture(); edit(f); await assert.rejects(new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
    assert.equal(f.calls.length, 1);
  }
});
test('scope, pointer/outbox/job and persisted manifest relations are checked independently', async () => {
  for (const edit of [p => { p.pointer.tenantId = 'other'; }, p => { p.pointer.revision = 0; }, p => { p.outbox.revision++; },
    p => { p.outbox.graphVersion = 'other'; }, p => { p.outbox.eventType = 'graph.snapshot.deactivated'; }, p => { p.outbox.publishedAt = null; },
    p => { p.outbox.deadLetteredAt = '2026-10-10T06:00:00.000Z'; }, p => { p.buildJob.status = 'validated'; },
    p => { p.buildJob.publicationManifest.tenantId = 'other'; }, p => { p.buildJob.publicationManifest.graphVersion = 'other'; },
    p => { p.buildJob.publicationManifest.artifactDigest = `sha256:${'b'.repeat(64)}`; }, p => { p.buildJob.publicationManifest.documents.pop(); p.buildJob.publicationManifest.documents.push(clone(p.buildJob.publicationManifest.documents[0])); }]) {
    const f = fixture(); edit(f.publication); await assert.rejects(new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
  }
});
test('callbacks and scope are frozen; caller selectors/success and unsafe carriers reject without hooks', async () => {
  const f = fixture(); const reader = new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options); let hooks = 0;
  f.options.scope.tenantId = 'other'; Object.defineProperty(f.client, 'query', { get() { hooks++; throw new Error('secret-token'); } });
  for (const request of [{ scope: f.scope }, { passed: true }, { get field() { hooks++; return true; } }, new Proxy({}, { ownKeys() { hooks++; return []; } })]) {
    await assert.rejects(reader.readPublication(request), reject('invalid-request'));
  }
  const result = await reader.readPublication({}); assert.equal(result.scope.tenantId, 'tenant-a'); assert.equal(hooks, 0);
  assert.equal(f.calls.length, 1);
});
test('configuration, read capacity and live SQL failures remain explicit and never auto-retry', async () => {
  for (const edit of [o => { o.executionProfile = 'enterprise'; }, o => { o.scope.environment = '*'; }, o => { o.maxReads = 0; }, o => { o.operationTimeoutMs = 0; }, o => { o.extra = true; }]) {
    const f = fixture(); edit(f.options); assert.throws(() => new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options), reject('invalid-config')); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.options.maxReads = 1; const reader = new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options);
  await reader.readPublication({}); await assert.rejects(reader.readPublication({}), reject('read-limit')); assert.equal(f.calls.length, 1);
  const g = fixture(); g.client.query = () => Promise.reject(new Error('postgres://secret-token@invalid')); const broken = new subject.PostgresKnowledgeGraphPublicationReadback(g.client, g.options);
  await assert.rejects(broken.readPublication({}), reject('query-failed'));
});
test('UNKNOWN timeout is terminal, late SELECT fulfillment does not produce a cached result', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 50; let release; let started; const entered = new Promise(r => { started = r; });
  f.client.query = () => { started(); return new Promise(resolve => { release = () => resolve(clone(f.response)); }); }; t.after(() => release?.());
  const reader = new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await entered;
  await assert.rejects(pending, e => reject('query-timeout')(e) && e.pendingCompletionUnknown);
  release(); await new Promise(resolve => setImmediate(resolve)); await assert.rejects(reader.readPublication({}), reject('halted'));
});

test('concurrent reads reject without a second SELECT or consuming the read budget', async t => {
  const f = fixture(); f.options.maxReads = 1; let release; let started;
  const entered = new Promise(resolve => { started = resolve; }); let calls = 0;
  f.client.query = () => { calls++; started(); return new Promise(resolve => { release = () => resolve(clone(f.response)); }); };
  t.after(() => release?.());
  const reader = new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options);
  const pending = reader.readPublication({}); await entered;
  await assert.rejects(reader.readPublication({}), reject('busy')); assert.equal(calls, 1);
  release(); assert.deepEqual((await pending).buildJob.documents, f.manifest.documents);
  await assert.rejects(reader.readPublication({}), reject('read-limit')); assert.equal(calls, 1);
});

test('unsafe query carriers halt without invoking then/getter/Proxy hooks', async () => {
  for (const kind of ['thenable', 'proxy']) {
    const f = fixture(); let hooks = 0; let calls = 0;
    const carrier = kind === 'thenable' ? { get then() { hooks++; throw new Error('secret-token'); } }
      : new Proxy(Promise.resolve(clone(f.response)), { get() { hooks++; throw new Error('secret-token'); } });
    f.client.query = () => { calls++; return carrier; };
    const reader = new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), reject('provider-contract-invalid'));
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(calls, 1); assert.equal(hooks, 0);
  }
});

test('unsafe resolved SQL payloads reject without invoking data hooks', async () => {
  for (const kind of ['getter', 'proxy']) {
    const f = fixture(); let hooks = 0;
    const payload = kind === 'getter' ? { get rows() { hooks++; throw new Error('secret-token'); }, rowCount: 1 }
      : new Proxy(f.response, { ownKeys() { hooks++; throw new Error('secret-token'); } });
    f.client.query = () => Promise.resolve(payload);
    await assert.rejects(new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
    assert.equal(hooks, 0);
  }
});

test('native readback preserves existing opaque document ID/version values without using them as SQL selectors', async () => {
  const f = fixture(); f.manifest.documents = [{ documentId: '课程甲/doc', documentVersion: '版本/一', trustLevel: 'reviewed' }];
  const result = await new subject.PostgresKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  assert.deepEqual(result.buildJob.documents, f.manifest.documents);
  assert.deepEqual(f.calls[0].values, ['tenant-a', 'corpus-a']); assert.doesNotMatch(f.calls[0].text, /课程甲|版本/);
});
