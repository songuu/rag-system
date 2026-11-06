import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { PostgresElasticsearchPublicationOperations, createPersistedElasticsearchIndex } = await import('./publication-operation.ts');
const digest = `sha256:${'a'.repeat(64)}`;
const attempt = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a', generation: '3', revision: '7',
  manifestDigest: digest, physicalCollection: 'rag_publication_0123456789abcdef0123456789abcdef',
  leaseToken: '00000000-0000-4000-8000-000000000001' };
const identity = { tenantId: attempt.tenantId, corpusId: attempt.corpusId, documentId: attempt.documentId,
  generation: attempt.generation, documentVersion: 'v1' };
const operation = { operationId: '00000000-0000-4000-8000-000000000002', version: 1,
  indexName: `codex-generation-seal-${'a'.repeat(32)}`, marker: 'b'.repeat(64), identity,
  status: 'prepared', indexUuid: null };

test('persists prepared identity in one parameterized scoped CAS call', async () => {
  const calls = [];
  const store = new PostgresElasticsearchPublicationOperations({ async query(sql, values) {
    calls.push({ sql, values }); return { rows: [{ result: operation }] };
  } });
  const result = await store.prepare(attempt, 'v1');
  assert.deepEqual(result, operation);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /rag_elasticsearch_publication_operation\(\$1,\$2,\$3,\$4,\$5::jsonb\)/);
  assert.deepEqual(calls[0].values.slice(0, 4), ['prepare', 'tenant-a', 'corpus-a', 'document-a']);
  const submitted = JSON.parse(calls[0].values[4]);
  assert.equal(submitted.leaseToken, attempt.leaseToken);
  assert.equal(submitted.contentVersion, 'v1');
  assert.equal(submitted.generation, '3');
});

test('rejects foreign or version-mismatched database response before exposing it', async () => {
  for (const changed of [
    { ...operation, identity: { ...identity, tenantId: 'other' } },
    { ...operation, identity: { ...identity, generation: '4' } },
    { ...operation, identity: { ...identity, documentVersion: 'v2' } },
    { ...operation, indexName: 'other-index' },
  ]) {
    const store = new PostgresElasticsearchPublicationOperations({ query: async () => ({ rows: [{ result: changed }] }) });
    await assert.rejects(store.prepare(attempt, 'v1'));
  }
});

test('create is fenced by durable intent before external request and binds only observed UUID', async () => {
  const calls = [];
  const index = { indexName: operation.indexName, indexUuid: 'es-uuid' };
  const store = {
    async prepare() { calls.push('prepare'); return operation; },
    async startCreate() { calls.push('start'); return { ...operation, status: 'creating' }; },
    async bindObserved(_attempt, _op, client) { calls.push('inspect-and-bind'); assert.equal(client, 'es'); return { ...operation, status: 'bound', indexUuid: index.indexUuid }; },
  };
  const result = await createPersistedElasticsearchIndex({ store, client: 'es', attempt, contentVersion: 'v1',
    create: async input => { calls.push('create'); assert.deepEqual(input.operation.identity, identity); return index; } });
  assert.deepEqual(calls, ['prepare', 'start', 'create', 'inspect-and-bind']);
  assert.equal(result.handle, index);
  assert.equal(result.operation.indexUuid, index.indexUuid);
});

test('unknown external create outcome stays durable and is not retried or deleted', async () => {
  const calls = [];
  const store = { async prepare() { calls.push('prepare'); return operation; }, async startCreate() { calls.push('start'); return { ...operation, status: 'creating' }; },
    async bindObserved() { calls.push('bind'); throw new Error('unexpected'); } };
  await assert.rejects(createPersistedElasticsearchIndex({ store, client: {}, attempt, contentVersion: 'v1',
    create: async () => { calls.push('create'); throw new Error('timeout'); } }), error => error.code === 'ELASTICSEARCH_CREATE_OUTCOME_UNKNOWN'
      && error.operationId === operation.operationId);
  assert.deepEqual(calls, ['prepare', 'start', 'create']);
});

test('unknown database start outcome returns the persisted operation ID without calling ES', async () => {
  const calls = [];
  const store = { async prepare() { calls.push('prepare'); return operation; },
    async startCreate() { calls.push('start'); throw new Error('database connection lost'); },
    async bindObserved() { calls.push('bind'); throw new Error('unexpected'); } };
  await assert.rejects(createPersistedElasticsearchIndex({ store, client: {}, attempt, contentVersion: 'v1',
    create: async () => { calls.push('create'); throw new Error('unexpected'); } }),
  error => error.code === 'ELASTICSEARCH_CREATE_OUTCOME_UNKNOWN' && error.operationId === operation.operationId);
  assert.deepEqual(calls, ['prepare', 'start']);
});

test('persisted identity never allows a different UUID to be accepted from ES readback', async () => {
  const store = { async prepare() { return operation; }, async startCreate() { return { ...operation, status: 'creating' }; },
    async bindObserved() { return { ...operation, status: 'bound', indexUuid: 'other-uuid' }; } };
  await assert.rejects(createPersistedElasticsearchIndex({ store, client: {}, attempt, contentVersion: 'v1',
    create: async () => ({ indexName: operation.indexName, indexUuid: 'correct-uuid' }) }),
  error => error.code === 'ELASTICSEARCH_CREATE_OUTCOME_UNKNOWN');
});

test('binding rejects forged index name and marker before contacting ES', async () => {
  const creating = { ...operation, status: 'creating' };
  for (const forged of [
    { ...creating, indexName: `codex-generation-seal-${'c'.repeat(32)}` },
    { ...creating, marker: 'd'.repeat(64) },
    { ...creating, identity: { ...identity, documentVersion: 'v2' } },
  ]) {
    const calls = [];
    const store = new PostgresElasticsearchPublicationOperations({ async query(_sql, values) {
      calls.push(values[0]); return { rows: [{ result: creating }] };
    } });
    const client = { indices: { async get() { calls.push('ES'); throw new Error('unexpected ES access'); } } };
    await assert.rejects(store.bindObserved(attempt, forged, client), error => error.code === 'ELASTICSEARCH_PUBLICATION_CONFLICT');
    assert.deepEqual(calls, ['read']);
  }
});

test('bind carries observed index identity into the database compare-and-set', async () => {
  const creating = { ...operation, status: 'creating' };
  const calls = [];
  const store = new PostgresElasticsearchPublicationOperations({ async query(_sql, values) {
    calls.push(values);
    return { rows: [{ result: values[0] === 'read' ? creating : { ...creating, status: 'bound', indexUuid: 'es-uuid' } }] };
  } });
  const client = { indices: { async get() { return { [creating.indexName]: { aliases: {},
    mappings: { _meta: { generation_owner: creating.marker } }, settings: { index: { uuid: 'es-uuid' } } } }; } } };
  const result = await store.bindObserved(attempt, creating, client);
  assert.equal(result.indexUuid, 'es-uuid');
  const args = JSON.parse(calls[1][4]);
  assert.equal(args.indexName, creating.indexName);
  assert.equal(args.marker, creating.marker);
  assert.equal(args.contentVersion, 'v1');
  assert.equal(args.indexUuid, 'es-uuid');
});
