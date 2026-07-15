import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { adaptMilvusSearchResultsToEvidence } = await import('./legacy-evidence-adapter.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('Milvus adapter preserves canonical identity, span, score, source and scope', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  });
  const [evidence] = adaptMilvusSearchResultsToEvidence(
    [
      {
        id: 'chunk-1',
        content: 'alpha evidence',
        score: 0.91,
        distance: 0.09,
        metadata: {
          tenant_id: 'tenant-a',
          corpus_id: 'corpus-a',
          document_id: 'doc-1',
          document_version: 'sha256:abc',
          trust_level: 'reviewed',
          source: 'guide.pdf',
          page: 4,
          section_path: ['Install', 'Windows'],
          start_offset: 10,
          end_offset: 24,
        },
      },
    ],
    { laneId: 'dense-vector-required', scope }
  );

  assert.deepEqual(
    {
      id: evidence.id,
      tenantId: evidence.tenantId,
      corpusId: evidence.corpusId,
      documentId: evidence.documentId,
      documentVersion: evidence.documentVersion,
      content: evidence.content,
      source: evidence.source,
      page: evidence.page,
      sectionPath: evidence.sectionPath,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      retrievalScore: evidence.retrievalScore,
      trustLevel: evidence.trustLevel,
      laneId: evidence.laneId,
    },
    {
      id: 'chunk-1',
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      documentId: 'doc-1',
      documentVersion: 'sha256:abc',
      content: 'alpha evidence',
      source: 'guide.pdf',
      page: 4,
      sectionPath: ['Install', 'Windows'],
      startOffset: 10,
      endOffset: 24,
      retrievalScore: 0.91,
      trustLevel: 'reviewed',
      laneId: 'dense-vector-required',
    }
  );
});

test('Milvus adapter rejects cross-scope and quarantined evidence before generation', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed', 'quarantined'],
    enforceIsolation: true,
  });
  const base = {
    id: 'chunk-1',
    content: 'evidence',
    score: 0.9,
    distance: 0.1,
  };

  assert.throws(
    () =>
      adaptMilvusSearchResultsToEvidence(
        [{ ...base, metadata: { tenant_id: 'tenant-b', corpus_id: 'corpus-a', trust_level: 'reviewed' } }],
        { laneId: 'dense', scope }
      ),
    /tenant scope mismatch/
  );
  assert.throws(
    () =>
      adaptMilvusSearchResultsToEvidence(
        [{ ...base, metadata: { tenant_id: 'tenant-a', corpus_id: 'corpus-a', trust_level: 'quarantined' } }],
        { laneId: 'dense', scope }
      ),
    /quarantined/
  );
});

test('Milvus adapter creates deterministic local legacy identities', () => {
  const scope = createRetrievalScope({
    tenantId: 'local',
    corpusId: 'default',
    enforceIsolation: false,
  });
  const input = [{
    id: '',
    content: 'legacy evidence',
    score: 0.7,
    distance: 0.3,
    metadata: { source: 'legacy.txt' },
  }];

  const first = adaptMilvusSearchResultsToEvidence(input, { laneId: 'dense', scope });
  const second = adaptMilvusSearchResultsToEvidence(input, { laneId: 'dense', scope });
  assert.equal(first[0].id, second[0].id);
  assert.equal(first[0].documentVersion, 'legacy-v1');
  assert.equal(first[0].trustLevel, 'external');
});

test('Milvus adapter gives authoritative scalar aliases precedence over metadata JSON', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['external'],
    enforceIsolation: true,
  });
  const [evidence] = adaptMilvusSearchResultsToEvidence(
    [{
      id: 'chunk-authoritative',
      content: 'evidence',
      score: 0.8,
      distance: 0.2,
      metadata: {
        tenantId: 'tenant-b',
        tenant_id: 'tenant-a',
        corpusId: 'corpus-b',
        corpus_id: 'corpus-a',
        documentId: 'spoofed-document',
        document_id: 'authoritative-document',
        trustLevel: 'trusted',
        trust_level: 'external',
      },
    }],
    { laneId: 'dense', scope }
  );

  assert.equal(evidence.tenantId, 'tenant-a');
  assert.equal(evidence.corpusId, 'corpus-a');
  assert.equal(evidence.documentId, 'authoritative-document');
  assert.equal(evidence.trustLevel, 'external');
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
