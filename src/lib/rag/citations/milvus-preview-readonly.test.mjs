import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { MilvusVectorStore } = await import('../../milvus-client.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['external'], enforceIsolation: true };
const identity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'version-a', trustLevel: 'external' };
const required = ['id', 'content', 'source', 'metadata_json', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks'];

function makeStore(client) {
  const store = new MilvusVectorStore({ collectionName: 'citations-test', embeddingDimension: 768, consistencyLevel: 'Eventually' });
  store.client = client; store.isConnected = true;
  store.initializeCollection = async () => { throw new Error('FORBIDDEN_COLLECTION_INITIALIZATION'); };
  return store;
}

test('read-only graph source query describes existing schema and always sends Strong without initializing', async () => {
  let query;
  const store = makeStore({ async describeCollection() { return { status: { error_code: 'Success' }, schema: { fields: required.map(name => ({ name })) } }; }, async query(input) { query = input; return { status: { error_code: 'Success' }, data: [] }; } });
  assert.deepEqual(await store.queryDocumentRows(scope, identity, 1, { readOnly: true, consistencyLevel: 'Strong' }), []);
  assert.equal(query.consistency_level, ConsistencyLevelEnum.Strong); assert.equal(query.limit, 2);
  assert.equal(query.exprValues.documentVersion, identity.documentVersion);
});

test('read-only preview refuses missing collection/schema and unknown data without create or load', async () => {
  for (const response of [{ status: { error_code: 'CollectionNotExists' } }, { status: { error_code: 'Success' }, schema: { fields: [] } }]) {
    let queries = 0;
    const store = makeStore({ async describeCollection() { return response; }, async query() { queries++; throw new Error(); } });
    await assert.rejects(store.queryDocumentRows(scope, identity, 1, { readOnly: true, consistencyLevel: 'Strong' }), error => !error.message.includes('FORBIDDEN_COLLECTION_INITIALIZATION'));
    assert.equal(queries, 0);
  }
  const store = makeStore({ async describeCollection() { return { status: { error_code: 'Success' }, schema: { fields: required.map(name => ({ name })) } }; }, async query() { return { status: { error_code: 'Success' }, data: null }; } });
  await assert.rejects(store.queryDocumentRows(scope, identity, 1, { readOnly: true, consistencyLevel: 'Strong' }));
});
