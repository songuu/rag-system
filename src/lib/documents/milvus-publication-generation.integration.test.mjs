import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { buildPublicationCollectionSchema, createPublicationChunk, createPublicationViewItem,
  publicationManifestEntry, MilvusPublicationGenerationAdapter } from './milvus-publication-generation.ts';

const enabled = process.env.RAG_MILVUS_GENERATION_LOCAL_TEST === '1';
if (enabled && process.env.TEST_MILVUS_ADDRESS !== '127.0.0.1:19530') {
  throw new Error('The isolated Milvus test requires TEST_MILVUS_ADDRESS=127.0.0.1:19530.');
}
function success(response) { assert.equal((response.status ?? response).error_code, 'Success'); }

test('isolated collection keeps generations separate before top K and rejects cross-scope hits', { skip: !enabled }, async () => {
  const client = new MilvusClient({ address: '127.0.0.1:19530', timeout: 10000 });
  const suffix = randomUUID().replaceAll('-', '');
  const collection = `rag_generation_test_${suffix}`;
  const scope = { tenantId: `gen-${suffix}`, corpusId: `gen-${suffix}`, enforceIsolation: true, allowedTrustLevels: ['trusted'] };
  let owned = false;
  try {
    const initial = await client.hasCollection({ collection_name: collection });
    success(initial); assert.equal(initial.value, false);
    // Cleanup this random, verified-new name even when create times out after server acceptance.
    owned = true;
    success(await client.createCollection(buildPublicationCollectionSchema(collection, 2)));
    success(await client.createIndex({ collection_name: collection, field_name: 'embedding', index_name: 'generation_vector_index', index_type: 'FLAT', metric_type: 'COSINE' }));
    success(await client.loadCollectionSync({ collection_name: collection }));
    const adapter = new MilvusPublicationGenerationAdapter(client, collection, 2);
    const common = { documentId: 'same', documentVersion: 'same-content', trustLevel: 'trusted', chunkIndex: 0, content: 'evidence' };
    const old = await adapter.insert(scope, [{ ...common, generation: 1, embedding: [1, 0] }]);
    const currentChunk = { ...common, generation: 2, embedding: [0, 1] };
    const current = await adapter.insert(scope, [currentChunk]);
    // These two rows score higher but are not part of the authorized version or manifest.
    await adapter.insert(scope, [{ ...common, generation: 2, documentVersion: 'other-content', embedding: [1, 0] }]);
    await adapter.insert(scope, [{ ...common, generation: 2, chunkIndex: 1, content: 'not in the manifest', embedding: [1, 0] }]);
    assert.notEqual(old.ids[0], current.ids[0]);
    assert.equal(old.verified, false); assert.equal(current.verified, false);
    success(await client.flushSync({ collection_names: [collection] }));
    // Higher-scoring old generation, wrong version and unlisted chunk are all excluded before limit=1.
    const manifest = { documentId: 'same', generation: 2, documentVersion: 'same-content',
      chunks: [publicationManifestEntry(createPublicationChunk(scope, currentChunk, 2))] };
    const view = createPublicationViewItem(scope, manifest);
    const hits = await adapter.search(scope, [view], [1, 0], 1);
    assert.equal(hits.length, 1); assert.equal(Number(hits[0].publication_generation), 2);
    assert.equal(hits[0].id, current.ids[0]);
    const contentInput = { ...currentChunk, documentId: 'tampered-content' };
    const versionInput = { ...currentChunk, documentId: 'tampered-version' };
    const contentRow = createPublicationChunk(scope, contentInput, 2);
    const versionRow = createPublicationChunk(scope, versionInput, 2);
    success(await client.insert({ collection_name: collection, data: [
      { ...contentRow, content: 'attacker supplied content' },
      { ...versionRow, document_version: 'other-version' },
    ] }));
    success(await client.flushSync({ collection_names: [collection] }));
    success(await client.releaseCollection({ collection_name: collection }));
    success(await client.loadCollectionSync({ collection_name: collection }));
    const contentView = createPublicationViewItem(scope, { documentId: contentInput.documentId, generation: 2,
      documentVersion: contentInput.documentVersion, chunks: [publicationManifestEntry(contentRow)] });
    const versionView = createPublicationViewItem(scope, { documentId: versionInput.documentId, generation: 2,
      documentVersion: versionInput.documentVersion, chunks: [publicationManifestEntry(versionRow)] });
    await assert.rejects(adapter.search(scope, [contentView], [0, 1], 1), /trusted publication manifest/);
    assert.deepEqual(await adapter.search(scope, [versionView], [0, 1], 1), []);
    const foreign = { ...scope, tenantId: `${scope.tenantId}-other` };
    assert.deepEqual(await adapter.search(foreign, [createPublicationViewItem(foreign, manifest)], [1, 0], 1), []);
  } finally {
    try {
      if (owned) {
        assert.match(collection, /^rag_generation_test_[a-f0-9]{32}$/);
        const existing = await client.hasCollection({ collection_name: collection });
        success(existing);
        if (existing.value) success(await client.dropCollection({ collection_name: collection }));
      }
    } finally { await client.closeConnection(); }
  }
});
