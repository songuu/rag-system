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

const {
  parseDocumentSearchRequest,
  presentDocumentSearchEvidence,
} = await import('./document-search-contract.ts');

test('document search defaults to Milvus + Elasticsearch hybrid retrieval', () => {
  assert.deepEqual(parseDocumentSearchRequest({ query: '供应商 营业问卷' }), {
    query: '供应商 营业问卷',
    strategy: 'hybrid',
    topK: 12,
  });
});

test('document search validates bounded filters and identifiers', () => {
  assert.deepEqual(parseDocumentSearchRequest({
    query: '合同',
    strategy: 'keyword',
    topK: 24,
    documentId: 'vendor-sop-v2',
    fileType: 'pdf',
  }), {
    query: '合同',
    strategy: 'keyword',
    topK: 24,
    documentId: 'vendor-sop-v2',
    fileType: 'pdf',
  });

  assert.throws(() => parseDocumentSearchRequest({ query: ' ' }), /query/i);
  assert.throws(() => parseDocumentSearchRequest({ query: 'ok', topK: 101 }), /topK/i);
  assert.throws(
    () => parseDocumentSearchRequest({ query: 'ok', documentId: '../outside' }),
    /documentId/i
  );
});

test('document evidence is exposed as a bounded user-facing result', () => {
  const [result] = presentDocumentSearchEvidence([{
    id: 'chunk-1',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'vendor-sop',
    documentVersion: 'sha256:abc',
    content: '供应商需要提交营业执照与信息安全问卷。',
    source: '04-vendor-procurement-sop.pdf',
    page: 4,
    retrievalScore: 0.032,
    trustLevel: 'reviewed',
    laneId: 'document-search',
    metadata: {
      matchedLanes: ['dense', 'lexical'],
      chunkIndex: 2,
      totalChunks: 8,
      secret: 'must-not-leak',
    },
  }]);

  assert.deepEqual(result, {
    id: 'chunk-1',
    documentId: 'vendor-sop',
    documentVersion: 'sha256:abc',
    title: '04-vendor-procurement-sop.pdf',
    snippet: '供应商需要提交营业执照与信息安全问卷。',
    page: 4,
    score: 0.032,
    trustLevel: 'reviewed',
    match: 'hybrid',
    chunkIndex: 2,
    totalChunks: 8,
  });
  assert.equal('metadata' in result, false);
});
