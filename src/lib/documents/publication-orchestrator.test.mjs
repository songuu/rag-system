import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { observePublication } = await import('./publication-orchestrator.ts');

const digest = `sha256:${'a'.repeat(64)}`;
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a' };
const candidate = { ...scope, generation: '1', revision: '1', manifestDigest: digest, physicalCollection: 'rag_publication_a' };
const attempt = { ...candidate, leaseToken: 'token-1' };
const request = { ...scope, idempotencyKey: 'request-a', contentVersion: 'content-v1', manifestDigest: digest,
  physicalCollection: 'rag_publication_a', requiredProviders: ['milvus', 'elasticsearch'] };
const observation = provider => ({ ...candidate, provider, contentVersion: 'content-v1', evidenceDigest: `sha256:${'b'.repeat(64)}`, productionAuthorized: false });
const esIdentity = { indexName: `codex-generation-seal-${'c'.repeat(32)}`, ownerMarker: 'd'.repeat(64), contentVersion: 'content-v1' };
const esUuid = 'es-index-uuid-123';

function fixture(overrides = {}) {
  const calls = [];
  const store = {
    async begin(input) { calls.push('begin'); assert.deepEqual(input, request); return candidate; },
    async claim(input) { calls.push('claim'); assert.deepEqual(input, candidate); return attempt; },
    async renew(input) { calls.push('renew'); assert.deepEqual(input, attempt); },
    async abandon(input) { calls.push('abandon'); assert.deepEqual(input, attempt); },
    async observeAndRecord(input, provider, observer) {
      calls.push(`record:${provider}`); assert.deepEqual(input, attempt);
      return observer({ ...input, provider });
    },
    async publish() { throw new Error('publish must never be invoked'); },
    ...overrides.store,
  };
  const ports = {
    store,
    async persistElasticsearchOperation(input) {
      calls.push('persist-es'); assert.equal(Object.hasOwn(input, 'leaseToken'), false);
      return { ...input, ...esIdentity, operationId: 'es-operation-a', persisted: true };
    },
    async createElasticsearchIndex(input, operation) {
      calls.push('create-es'); assert.equal(operation.operationId, 'es-operation-a');
      return { ...input, ...esIdentity, indexUuid: esUuid, productionAuthorized: false };
    },
    async observeMilvus(input) { calls.push('milvus'); assert.deepEqual(input, attempt); return observation('milvus'); },
    async observeElasticsearch(input, esOperation, esIndex) {
      calls.push('elasticsearch'); assert.deepEqual(input, attempt); assert.equal(esOperation.operationId, 'es-operation-a');
      assert.equal(esIndex.indexUuid, esUuid);
      return { ...observation('elasticsearch'), ...esIdentity, indexUuid: esUuid };
    },
    ...overrides.ports,
  };
  return { calls, ports };
}

test('records only bound non-production observations after persisting ES operation identity', async () => {
  const { calls, ports } = fixture();
  const result = await observePublication(request, ports, { timeoutMs: 100 });
  assert.equal(result.status, 'observed');
  assert.equal(result.productionAuthorized, false);
  assert.equal(result.graph, 'not-requested');
  assert.ok(calls.indexOf('persist-es') < calls.indexOf('elasticsearch'));
  assert.ok(calls.indexOf('persist-es') < calls.indexOf('create-es'));
  assert.ok(calls.indexOf('create-es') < calls.indexOf('elasticsearch'));
  assert.ok(calls.indexOf('record:milvus') < calls.indexOf('record:elasticsearch'));
  assert.ok(!calls.includes('publish'));
});

test('optional unavailable graph remains explicitly unavailable while text observations remain non-production', async () => {
  const { ports } = fixture({ ports: { async observeGraph() { return { status: 'unavailable' }; } } });
  const result = await observePublication(request, ports, { timeoutMs: 100 });
  assert.equal(result.status, 'observed');
  assert.equal(result.graph, 'unavailable');
  assert.equal(result.productionAuthorized, false);
});

test('optional observed graph is never labeled ready or recorded as verified', async () => {
  const { calls, ports } = fixture({ ports: { async observeGraph() { return { status: 'observed', observation: observation('neo4j') }; } } });
  const result = await observePublication(request, ports, { timeoutMs: 100 });
  assert.equal(result.graph, 'observed');
  assert.ok(!calls.includes('record:neo4j'));
});

test('unexpected graph failures do not silently become optional unavailability', async () => {
  const { ports } = fixture({ ports: { async observeGraph() { throw new Error('authority or integrity failure'); } } });
  const result = await observePublication(request, ports, { timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'neo4j');
  assert.equal(result.disposition, 'abandoned');
});

test('unsafe generation is rejected before claiming or calling a provider', async () => {
  const { calls, ports } = fixture({ store: { async begin() { return { ...candidate, generation: '9007199254740992' }; } } });
  const result = await observePublication(request, ports, { timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'begin');
  assert.equal(result.disposition, 'unknown');
  assert.ok(!calls.includes('claim'));
  assert.ok(!calls.includes('milvus'));
});

test('a store that does not execute its observer cannot report an observation', async () => {
  const { ports } = fixture({ store: { async observeAndRecord() {} } });
  const result = await observePublication(request, ports, { timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'milvus');
  assert.equal(result.disposition, 'abandoned');
});

for (const [field, value] of [
  ['indexName', `codex-generation-seal-${'f'.repeat(32)}`],
  ['ownerMarker', 'f'.repeat(64)],
  ['indexUuid', 'different-index-uuid'],
  ['contentVersion', 'other-content'],
]) {
  test(`rejects Elasticsearch observation with wrong ${field}`, async () => {
    const { calls, ports } = fixture({ ports: { async observeElasticsearch() {
      return { ...observation('elasticsearch'), ...esIdentity, indexUuid: esUuid, [field]: value };
    } } });
    const result = await observePublication(request, ports, { timeoutMs: 100 });
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'elasticsearch');
    assert.equal(result.disposition, 'abandoned');
    assert.ok(calls.includes('abandon'));
  });
}

for (const [field, value] of [
  ['indexName', `codex-generation-seal-${'f'.repeat(32)}`],
  ['ownerMarker', 'f'.repeat(64)],
  ['contentVersion', 'other-content'],
]) {
  test(`rejects created Elasticsearch index with wrong ${field}`, async () => {
    const { calls, ports } = fixture({ ports: { async createElasticsearchIndex(input) {
      return { ...input, ...esIdentity, indexUuid: esUuid, productionAuthorized: false, [field]: value };
    } } });
    const result = await observePublication(request, ports, { timeoutMs: 100 });
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'create-elasticsearch-index');
    assert.equal(result.disposition, 'abandoned');
    assert.ok(!calls.includes('milvus'));
  });
}

for (const [label, overrides, phase] of [
  ['different scope', { ports: { async observeMilvus() { return { ...observation('milvus'), tenantId: 'tenant-b' }; } } }, 'milvus'],
  ['different generation', { ports: { async observeMilvus() { return { ...observation('milvus'), generation: '2' }; } } }, 'milvus'],
  ['different content version', { ports: { async observeMilvus() { return { ...observation('milvus'), contentVersion: 'other' }; } } }, 'milvus'],
  ['production proof', { ports: { async observeMilvus() { return { ...observation('milvus'), productionAuthorized: true }; } } }, 'milvus'],
  ['missing persisted ES operation', { ports: { async persistElasticsearchOperation() { return { ...attempt, operationId: 'x', persisted: false }; } } }, 'persist-elasticsearch-operation'],
  ['persisted operation contains lease token', { ports: { async persistElasticsearchOperation() { return { ...attempt, operationId: 'x', persisted: true }; } } }, 'persist-elasticsearch-operation'],
  ['lease revoked', { store: { async renew() { throw new Error('revoked'); } } }, 'persist-elasticsearch-operation'],
]) {
  test(`${label} abandons the claimed generation`, async () => {
    const { calls, ports } = fixture(overrides);
    const result = await observePublication(request, ports, { timeoutMs: 100 });
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, phase);
    assert.equal(result.disposition, 'abandoned');
    assert.equal(result.productionAuthorized, false);
    assert.ok(calls.includes('abandon'));
  });
}

test('a timed-out backend can finish late but never proceeds to the next stage', async () => {
  let finish;
  const late = new Promise(resolve => { finish = resolve; });
  const { calls, ports } = fixture({ ports: { async observeMilvus() { calls.push('milvus'); return late; } } });
  const result = await observePublication(request, ports, { timeoutMs: 10 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure, 'timeout');
  assert.equal(result.disposition, 'abandoned');
  finish(observation('milvus'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!calls.includes('elasticsearch'));
});

test('failure to abandon is reported as unknown rather than claiming cleanup', async () => {
  const { ports } = fixture({ ports: {
    async observeMilvus() { throw new Error('write outcome unknown'); },
  }, store: { async abandon() { throw new Error('database unavailable'); } } });
  const result = await observePublication(request, ports, { timeoutMs: 30 });
  assert.equal(result.status, 'failed');
  assert.equal(result.disposition, 'unknown');
});

test('duplicate claim refusal never starts backend operations', async () => {
  const { calls, ports } = fixture({ store: { async claim() { throw new Error('already claimed'); } } });
  const result = await observePublication(request, ports, { timeoutMs: 30 });
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'claim');
  assert.equal(result.disposition, 'unknown');
  assert.ok(!calls.includes('milvus'));
});

test('abort before begin performs no database or backend work', async () => {
  const { calls, ports } = fixture();
  const controller = new AbortController(); controller.abort();
  const result = await observePublication(request, ports, { timeoutMs: 30, signal: controller.signal });
  assert.equal(result.failure, 'cancelled');
  assert.equal(result.disposition, 'not-started');
  assert.deepEqual(calls, []);
});
