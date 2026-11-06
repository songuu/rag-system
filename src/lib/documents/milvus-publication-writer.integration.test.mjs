import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { MilvusPublicationWriter } = await import('./milvus-publication-writer.ts');
const enabled = process.env.RAG_MILVUS_WRITER_LOCAL_TEST === '1';
if (enabled && process.env.TEST_MILVUS_ADDRESS !== '127.0.0.1:19530') {
  throw new Error('The isolated writer test requires TEST_MILVUS_ADDRESS=127.0.0.1:19530.');
}
function success(response) { assert.equal((response.status ?? response).error_code, 'Success'); }

test('isolated local collection is read back with real stored vectors', { skip: !enabled }, async () => {
  const client = new MilvusClient({ address: '127.0.0.1:19530', timeout: 10000 });
  const suffix = randomUUID().replaceAll('-', '');
  const collection = `rag_publication_${suffix}`;
  const scope = { tenantId: `writer-${suffix}`, corpusId: `writer-${suffix}`, enforceIsolation: true, allowedTrustLevels: ['trusted'] };
  const chunks = Array.from({ length: 35 }, (_, chunkIndex) => ({ documentId: 'document', documentVersion: 'version',
    generation: 1, trustLevel: 'trusted', chunkIndex, content: `Evidence ${chunkIndex}`, embedding: [chunkIndex / 100, 1] }));
  let owned = false;
  let settled = false;
  try {
    const existing = await client.hasCollection({ collection_name: collection }); success(existing); assert.equal(existing.value, false);
    // The random name was verified absent; only this test's collection is eligible for cleanup.
    owned = true;
    const writer = new MilvusPublicationWriter({ client, collection, scope, dimension: 2, chunks,
      checkLease: async () => true, timeoutMs: 10000 });
    const observed = await writer.observe();
    assert.equal(observed.count, chunks.length);
    assert.equal(observed.kind, 'multi-read-observation');
    assert.equal(observed.productionAuthorized, false);
    settled = true;
  } finally {
    try {
      // A timeout can leave a remote mutation in flight. Do not drop its
      // collection or let a subsequent attempt reuse its physical name.
      if (owned && settled) {
        assert.match(collection, /^rag_publication_[a-f0-9]{32}$/);
        const existing = await client.hasCollection({ collection_name: collection }); success(existing);
        if (existing.value) success(await client.dropCollection({ collection_name: collection }));
        const removed = await client.hasCollection({ collection_name: collection }); success(removed); assert.equal(removed.value, false);
      } else if (owned) {
        console.error(`Abandoned test collection retained for manual inspection: ${collection}`);
      }
    } finally { await client.closeConnection(); }
  }
});
