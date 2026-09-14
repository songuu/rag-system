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

const { toDocumentCatalogItem } = await import('./document-catalog.ts');

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
