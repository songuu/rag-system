import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { toDocumentCatalogItem, summarizeDocumentCatalog } = await import('./document-catalog.ts');

test('summary separates stored chunks from searchable chunks after disabling a document', () => {
  const documents = [645, 718, 12, 26, 1, 2, 1].map((chunkCount, index) => ({
    enabled: index !== 0, lifecycle: 'active', chunkCount, byteSize: 100,
    milvusStatus: 'ready', elasticsearchStatus: 'ready',
  }));
  const original = structuredClone(documents);
  assert.deepEqual(summarizeDocumentCatalog(documents, 'active'), {
    documentCount: 7, enabledDocumentCount: 6, disabledDocumentCount: 1,
    chunkCount: 1405, searchableChunkCount: 760, disabledChunkCount: 645,
    byteSize: 700, syncedCount: 7, elasticsearchMode: 'active',
  });
  assert.deepEqual(documents, original);
});

test('disabled and deleting documents contribute zero searchable chunks while keeping stored totals', () => {
  const result = summarizeDocumentCatalog([
    { enabled: false, lifecycle: 'active', chunkCount: 8, byteSize: 50, milvusStatus: 'ready', elasticsearchStatus: 'ready' },
    { enabled: true, lifecycle: 'deleting', chunkCount: 2, byteSize: 20, milvusStatus: 'ready', elasticsearchStatus: 'pending' },
  ], 'active');
  assert.equal(result.chunkCount, 10);
  assert.equal(result.searchableChunkCount, 0);
  assert.equal(result.disabledChunkCount, 10);
  assert.equal(result.enabledDocumentCount, 0);
  assert.equal(result.disabledDocumentCount, 2);
  assert.equal(result.syncedCount, 1);
  assert.equal(summarizeDocumentCatalog([], 'off').searchableChunkCount, 0);
});

test('catalog maps canonical pipeline assets to document management records', () => {
  const result = toDocumentCatalogItem({
    id: '0f9fd454-a99a-43e7-bd5e-3d97241e6d57',
    external_document_id: 'vendor-sop',
    original_name: '04-vendor-procurement-sop.pdf',
    content_type: 'application/pdf',
    byte_size: '4096',
    metadata: {
      source_kind: 'pdf',
      persistence_status: 'ready',
      chunks: 8,
      document: {
        documentVersion: 'sha256:abc',
        trustLevel: 'reviewed',
      },
    },
    created_at: '2026-09-13T11:13:00.000Z',
    updated_at: '2026-09-13T11:15:00.000Z',
    lexical_chunk_count: '8',
    lexical_event_status: 'published',
  }, 'active');

  assert.deepEqual(result, {
    id: '0f9fd454-a99a-43e7-bd5e-3d97241e6d57',
    documentId: 'vendor-sop',
    name: '04-vendor-procurement-sop.pdf',
    contentType: 'application/pdf',
    sourceKind: 'pdf',
    byteSize: 4096,
    chunkCount: 8,
    documentVersion: 'sha256:abc',
    trustLevel: 'reviewed',
    createdAt: '2026-09-13T11:13:00.000Z',
    updatedAt: '2026-09-13T11:15:00.000Z',
    milvusStatus: 'ready',
    elasticsearchStatus: 'ready',
    enabled: true,
    lifecycle: 'active',
  });
});

test('catalog reports disabled and pending Elasticsearch projections explicitly', () => {
  const base = {
    id: 'asset-1', external_document_id: 'doc-1', original_name: 'doc.md',
    content_type: 'text/markdown', byte_size: 12,
    metadata: { source_kind: 'markdown', chunks: 1 },
    created_at: new Date('2026-09-13T11:13:00.000Z'),
    updated_at: new Date('2026-09-13T11:13:00.000Z'),
    lexical_chunk_count: 0, lexical_event_status: null,
  };
  assert.equal(toDocumentCatalogItem(base, 'off').elasticsearchStatus, 'disabled');
  assert.equal(toDocumentCatalogItem(base, 'active').elasticsearchStatus, 'pending');
});
