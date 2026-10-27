import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { MilvusVectorStore } = await import('../../milvus-client.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['external'], enforceIsolation: true };
const identity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'rev-a', trustLevel: 'external' };
const required = ['id', 'content', 'source', 'metadata_json', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks'];
function storeWithQuery(onQuery) {
  const store = new MilvusVectorStore({ collectionName: 'dataset-test', embeddingDimension: 768 });
  store.client = { async describeCollection() { return { status: { error_code: 'Success' }, schema: { fields: required.map(name => ({ name })) } }; },
    async query(query) { onQuery(query); return { status: { error_code: 'Success' }, data: [] }; } };
  store.isConnected = true;
  store.initializeCollection = async () => { throw new Error('must not initialize'); };
  return store;
}
test('knowledge sampling reads only bounded requested indices from an exact large revision', async () => {
  let query;
  const store = storeWithQuery(value => { query = value; });
  await store.queryDocumentRows(scope, identity, 2000, { readOnly: true, chunkIndices: [0, 999, 1999] });
  assert.equal(query.limit, 4);
  assert.match(query.filter, /chunk_index in \{sampleChunkIndices\}/);
  assert.deepEqual(query.exprValues.sampleChunkIndices, [0, 999, 1999]);
  assert.equal(query.exprValues.documentVersion, 'rev-a');
  assert.match(query.filter, /tenant_id == \{tenantId\}/);
});
test('sampling rejects malformed bounds before provider IO and leaves full-document limits intact', async () => {
  let calls = 0;
  const store = storeWithQuery(() => { calls++; });
  for (const chunkIndices of [[], [0, 0], [-1], [2000], [1.2], Array.from({ length: 49 }, (_, index) => index)]) {
    await assert.rejects(store.queryDocumentRows(scope, identity, 2000, { readOnly: true, chunkIndices }));
  }
  await assert.rejects(store.queryDocumentRows(scope, identity, 2000));
  await assert.rejects(store.queryDocumentRows(scope, identity, 2000, { chunkIndices: [0] }));
  await assert.rejects(store.queryDocumentRows(scope, identity, 100001, { readOnly: true, chunkIndices: [0] }));
  assert.equal(calls, 0);
});
