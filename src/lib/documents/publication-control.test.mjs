import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { PostgresDocumentPublicationStore, PublicationControlError } = await import('./publication-control.ts');
const digest = `sha256:${'a'.repeat(64)}`;
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a' };
const physicalCollection = 'publication_test_123';
const attempt = { ...scope, generation: '7', revision: '4', leaseToken: '00000000-0000-4000-8000-000000000001', manifestDigest: digest, physicalCollection };

test('store calls only the parameterized database CAS function', async () => {
  const calls = [];
  const store = new PostgresDocumentPublicationStore({ async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ result: { generation: '7', revision: '4', manifestDigest: digest, physicalCollection } }] };
  } });
  const result = await store.begin({ ...scope, idempotencyKey: 'request', contentVersion: 'v1', manifestDigest: digest, requiredProviders: ['milvus'], physicalCollection });
  assert.equal(result.generation, '7');
  assert.equal('leaseToken' in result, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /select public\.rag_publication_control\(\$1,\$2,\$3,\$4,\$5::jsonb\)/);
  assert.deepEqual(calls[0].values.slice(0, 4), ['begin', scope.tenantId, scope.corpusId, scope.documentId]);
});

test('manifest and required providers are validated before persistence', async () => {
  const store = new PostgresDocumentPublicationStore({ query: async () => { throw new Error('unexpected query'); } });
  for (const bad of [
    { manifestDigest: 'bad', requiredProviders: ['milvus'] },
    { manifestDigest: digest, requiredProviders: [] },
    { manifestDigest: digest, requiredProviders: ['milvus', 'milvus'] },
    { manifestDigest: digest, requiredProviders: ['rabbitmq'] },
  ]) await assert.rejects(store.begin({ ...scope, idempotencyKey: 'request', contentVersion: 'v1', physicalCollection, ...bad }),
    error => error instanceof PublicationControlError && error.code === 'PUBLICATION_INVALID_INPUT');
});

test('observation is bound to expected scope and never records an invalid result', async () => {
  const calls = [];
  const store = new PostgresDocumentPublicationStore({ async query(_sql, values) { calls.push(values[0]); return { rows: [{ result: {} }] }; } });
  await assert.rejects(store.observeAndRecord(attempt, 'milvus', async () => ({
    ...scope, tenantId: 'other-tenant', generation: '7', provider: 'milvus', manifestDigest: digest, evidenceDigest: digest, physicalCollection,
  })), error => error.code === 'PUBLICATION_INVALID_PROOF');
  assert.deepEqual(calls, ['check']);
});

test('publication remains disabled until generation writes can be sealed', async () => {
  const store = new PostgresDocumentPublicationStore({ query: async () => { throw new Error('unexpected query'); } });
  await assert.rejects(store.publish(attempt), error => error.code === 'PUBLICATION_NOT_IMPLEMENTED');
});

test('database CAS conflicts are exposed without retrying with the same generation', async () => {
  const operations = [];
  const store = new PostgresDocumentPublicationStore({ async query(_sql, values) {
    operations.push(values[0]); throw Object.assign(new Error('conflict'), { code: 'P0001' });
  } });
  const { leaseToken: ignored, ...candidate } = attempt;
  void ignored;
  await assert.rejects(store.claim(candidate), error => error.code === 'PUBLICATION_CONFLICT');
  assert.deepEqual(operations, ['claim']);
});

test('revocation requires a bounded expected revision', async () => {
  const store = new PostgresDocumentPublicationStore({ query: async () => { throw new Error('unexpected query'); } });
  for (const expectedRevision of [undefined, '-1', '01', '9223372036854775808']) {
    await assert.rejects(store.revoke({ ...scope, expectedRevision }), error => error.code === 'PUBLICATION_INVALID_INPUT');
  }
});
