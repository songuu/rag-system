import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { MilvusKnowledgeGraphPublicationReadback } = await import('./milvus-publication-readback.ts');
if (process.env.RAG_MILVUS_PUBLICATION_LOCAL_TEST !== '1' || process.env.TEST_MILVUS_ADDRESS !== '127.0.0.1:19530') {
  throw new Error('Explicit verified local Milvus publication test configuration is required.');
}
function success(response) { assert.equal((response.status ?? response).error_code, 'Success'); }
function row(id, index, scope, extra = {}) { return { id, content: `Synthetic publication passage ${index}`, embedding: [1, 0, 0, 0],
  source: 'isolated-publication-test', metadata_json: '{}', created_at: 1, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
  document_id: '课程甲', document_version: '版本/一', trust_level: 'trusted', chunk_index: index, total_chunks: 3, ...extra }; }

// Only this freshly resolved random collection is ever written or dropped.
// No ambient address/database selector, shared collection or schema mutation.
async function isolated(work) {
  const client = new MilvusClient({ address: '127.0.0.1:19530', timeout: 10000 });
  const suffix = randomUUID().replaceAll('-', ''); const collection = `rag_publication_test_${suffix}`;
  const scope = { environment: 'isolated-local', tenantId: `milpub-${suffix}`, corpusId: `milcorpus-${suffix}` };
  let owned = false;
  try {
    const existing = await client.hasCollection({ collection_name: collection }); success(existing); assert.equal(existing.value, false);
    owned = true;
    success(await client.createCollection({ collection_name: collection, enable_dynamic_field: false, fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 256 },
      { name: 'content', data_type: DataType.VarChar, max_length: 65535 },
      { name: 'embedding', data_type: DataType.FloatVector, dim: 4 },
      { name: 'source', data_type: DataType.VarChar, max_length: 1024 },
      { name: 'metadata_json', data_type: DataType.VarChar, max_length: 65535 },
      { name: 'created_at', data_type: DataType.Int64 },
      ...['tenant_id', 'corpus_id'].map(name => ({ name, data_type: DataType.VarChar, max_length: 128 })),
      ...['document_id', 'document_version'].map(name => ({ name, data_type: DataType.VarChar, max_length: 256 })),
      { name: 'trust_level', data_type: DataType.VarChar, max_length: 32 },
      ...['chunk_index', 'total_chunks'].map(name => ({ name, data_type: DataType.Int64 })),
    ] }));
    success(await client.insert({ collection_name: collection, data: [row("片段'一", 0, scope), row('😀片段', 1, scope), row('中/片段', 2, scope),
      row('foreign-tenant', 0, scope, { tenant_id: `${scope.tenantId}-other` }), row('foreign-corpus', 0, scope, { corpus_id: `${scope.corpusId}-other` })] }));
    success(await client.createIndex({ collection_name: collection, field_name: 'embedding', index_name: 'publication_vector_index', index_type: 'FLAT', metric_type: 'COSINE' }));
    success(await client.loadCollectionSync({ collection_name: collection }));
    const reader = new MilvusKnowledgeGraphPublicationReadback(client, { executionProfile: 'local-reference', scope, collection,
      operationTimeoutMs: 10000, maxReads: 4, pageSize: 2, maxRows: 65536, maxTotalRowBytes: 64 * 1024 * 1024, maxQueryParameterBytes: 64 * 1024 * 1024 });
    await work({ client, reader, scope, collection });
  } finally {
    try {
      if (owned) {
        assert.match(collection, /^rag_publication_test_[a-f0-9]{32}$/);
        const existing = await client.hasCollection({ collection_name: collection }); success(existing);
        if (existing.value) success(await client.dropCollection({ collection_name: collection }));
        const removed = await client.hasCollection({ collection_name: collection }); success(removed); assert.equal(removed.value, false);
      }
    } finally { await client.closeConnection(); }
  }
}
test('actual SDK reads complete scoped scalar rows and all schema/index identities without hiding versions or trust', async () => isolated(async f => {
  const first = await f.reader.readPublication({}); assert.deepEqual(first.scope, f.scope); assert.equal(first.collection, f.collection);
  assert.equal(first.rows.length, 3); assert.deepEqual(new Set(first.rows.map(v => v.id)), new Set(["片段'一", '😀片段', '中/片段']));
  assert.deepEqual([...first.rows].sort((a, b) => a.chunk_index - b.chunk_index).map(v => v.chunk_index), [0, 1, 2]);
  assert.ok(first.rows.every(v => v.document_id === '课程甲' && v.document_version === '版本/一' && v.total_chunks === 3));
  assert.equal(first.schemaManifest.schema.fields.length, 13); assert.equal(first.indexManifest.indexes.length, 1);
  assert.equal(first.indexManifest.indexes[0].field_name, 'embedding'); assert.equal(first.indexManifest.indexes[0].state, 'Finished');
  assert.ok(Object.isFrozen(first.rows)); assert.equal(f.reader.productionCapable, false); assert.ok(!Object.hasOwn(first, 'productionAuthorized'));
  success(await f.client.insert({ collection_name: f.collection, data: [row('extra-version', 0, f.scope, { document_version: '版本/二', trust_level: 'external', total_chunks: 1 }),
    row('extra-trust', 0, f.scope, { document_id: '待隔离', document_version: 'v1', trust_level: 'quarantined', total_chunks: 1 })] }));
  const second = await f.reader.readPublication({}); assert.equal(second.rows.length, 5);
  assert.ok(second.rows.some(v => v.id === 'extra-version' && v.document_version === '版本/二' && v.trust_level === 'external'));
  assert.ok(second.rows.some(v => v.id === 'extra-trust' && v.trust_level === 'quarantined'));
  assert.deepEqual(second.schemaManifest, first.schemaManifest); assert.deepEqual(second.indexManifest, first.indexManifest);
}));
test('actual server accepts the full 65536-element maximum-PK-byte exclusion template, not only a small fixture page', async () => isolated(async f => {
  const seenIds = Array.from({ length: 65536 }, (_, index) => `${String(index).padStart(6, '0')}${'q'.repeat(250)}`);
  assert.equal(seenIds.length, 65536); assert.ok(seenIds.every(v => Buffer.byteLength(v) === 256));
  const result = await f.client.query({ collection_name: f.collection, output_fields: ['count(*)'], consistency_level: 'Strong', timeout: 10000,
    filter: 'tenant_id == {tenantId} && corpus_id == {corpusId} && id not in {seenIds}',
    exprValues: { tenantId: f.scope.tenantId, corpusId: f.scope.corpusId, seenIds } });
  success(result); assert.equal(Number(result.data[0]['count(*)']), 3);
  console.log(JSON.stringify({ capability: 'local-full-exclusion-template', elementCount: seenIds.length, idUtf8Bytes: 256, parameterStringBytes: 65536 * 256,
    productionAuthorized: false, provesStored65536Rows: false }));
}));
