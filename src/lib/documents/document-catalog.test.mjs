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

const { toDocumentCatalogItem, summarizeDocumentCatalog, toPublishedDocumentCatalogItem } = await import('./document-catalog.ts');

test('published catalog uses authoritative generation metadata and never claims live verification', () => {
  const item=toPublishedDocumentCatalogItem({assetId:'asset',documentId:'upload:one',originalName:'新文档.txt',contentType:'text/plain',
    sourceKind:'text',byteSize:512,createdAt:'2026-11-04T01:00:00Z',contentVersion:'sha256:version',
    milvusVerifiedAt:'2026-11-04T01:01:00Z',elasticsearchVerifiedAt:'2026-11-04T01:02:00Z',
    milvus:{chunks:[{trustLevel:'external'}]}});
  assert.equal(item.name,'新文档.txt');assert.equal(item.byteSize,512);assert.equal(item.chunkCount,1);
  assert.equal(item.documentId,'upload:one');assert.equal(item.enabled,true);
  assert.equal(summarizeDocumentCatalog([item],'active').syncedCount,null);
  assert.throws(()=>toPublishedDocumentCatalogItem({...item,byteSize:null}));
});

test('summary separates stored chunks from searchable chunks after disabling a document', () => {
  const documents = [645, 718, 12, 26, 1, 2, 1].map((chunkCount, index) => ({
    enabled: index !== 0, lifecycle: 'active', chunkCount, byteSize: 100,
    milvusStatus: 'ready', elasticsearchStatus: 'ready',
  }));
  const original = structuredClone(documents);
  assert.deepEqual(summarizeDocumentCatalog(documents, 'active'), {
    documentCount: 7, enabledDocumentCount: 6, disabledDocumentCount: 1,
    chunkCount: 1405, searchableChunkCount: 760, disabledChunkCount: 645,
    byteSize: 700, syncedCount: null, lexicalProjectedCount: 7, elasticsearchMode: 'active',
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
  assert.equal(result.syncedCount, null);
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
    lexical_event_version: 'sha256:abc',
    lexical_event_type: 'upsert',
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
    milvusStatus: 'unknown',
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
  assert.equal(toDocumentCatalogItem(base, 'active').elasticsearchStatus, 'unknown');
});

test('projection status binds the latest upsert and chunk count to the document version', () => {
  const row = {
    id: 'asset-1', external_document_id: 'doc-1', original_name: 'doc.txt',
    content_type: 'text/plain', byte_size: 12,
    metadata: { source_kind: 'text', persistence_status: 'ready', chunks: 2, document: { documentVersion: 'v2' } },
    created_at: new Date(), updated_at: new Date(),
    lexical_chunk_count: 2, lexical_event_status: 'published', lexical_event_version: 'v2', lexical_event_type: 'upsert',
  };
  assert.equal(toDocumentCatalogItem(row, 'active').milvusStatus, 'unknown');
  assert.equal(toDocumentCatalogItem(row, 'active').elasticsearchStatus, 'ready');
  assert.equal(toDocumentCatalogItem({ ...row, lexical_event_version: 'v1' }, 'active').elasticsearchStatus, 'stale');
  assert.equal(toDocumentCatalogItem({ ...row, lexical_event_type: 'delete' }, 'active').elasticsearchStatus, 'stale');
  assert.equal(toDocumentCatalogItem({ ...row, lexical_chunk_count: 1 }, 'active').elasticsearchStatus, 'stale');
  assert.equal(toDocumentCatalogItem({ ...row, lexical_event_status: 'pending' }, 'active').elasticsearchStatus, 'pending');
  assert.equal(toDocumentCatalogItem({ ...row, lexical_event_status: 'failed' }, 'active').elasticsearchStatus, 'failed');
  assert.equal(toDocumentCatalogItem({ ...row, lexical_event_status: null, lexical_event_version: null, lexical_event_type: null }, 'active').elasticsearchStatus, 'pending');
  assert.equal(toDocumentCatalogItem({ ...row, metadata: { source_kind: 'text', chunks: 2 } }, 'active').elasticsearchStatus, 'unknown');
});
