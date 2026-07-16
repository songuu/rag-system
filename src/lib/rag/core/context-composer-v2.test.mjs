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

const { composeEvidenceContextV2, estimateEvidenceContextTokens } = await import('./context-composer.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('v2 document order groups sources stably and orders spans within each document', () => {
  const evidence = [
    createEvidence('a-2', 'doc-a', 2, 20),
    createEvidence('b-1', 'doc-b', 1, 0),
    createEvidence('a-1', 'doc-a', 1, 0),
  ];
  const result = composeEvidenceContextV2(evidence, {
    maxTokens: 1000,
    order: 'document',
  });
  assert.deepEqual(result.includedEvidenceIds, ['a-1', 'a-2', 'b-1']);
  assert.ok(result.context.indexOf('content-a-1') < result.context.indexOf('content-a-2'));
  assert.match(result.context, /page: 1/);
  assert.equal(result.truncated, false);
});

test('v2 respects injected token budget and returns the exact included span', () => {
  const item = {
    ...createEvidence('a', 'doc-a', 1, 100),
    content: 'x'.repeat(100),
    startOffset: 100,
    endOffset: 200,
  };
  const result = composeEvidenceContextV2([item], {
    maxTokens: 55,
    includeScores: false,
    includeStructure: false,
    estimateTokens: value => value.length,
  });
  assert.ok(result.context.length <= 55);
  assert.equal(result.tokenEstimate, result.context.length);
  assert.equal(result.includedEvidence.length, 1);
  assert.equal(result.includedEvidence[0].content.length, result.context.length - '[1] (source: doc-a.pdf)\n'.length);
  assert.equal(
    result.includedEvidence[0].endOffset,
    100 + result.includedEvidence[0].content.length
  );
  assert.equal(result.includedEvidence[0].metadata.contextTruncated, true);
  assert.equal(result.truncated, true);
});

test('v2 does not claim evidence inclusion when only a header fits', () => {
  const result = composeEvidenceContextV2([createEvidence('a', 'doc-a', 1, 0)], {
    maxTokens: 2,
    estimateTokens: value => value.length,
  });
  assert.equal(result.context, '');
  assert.deepEqual(result.includedEvidenceIds, []);
  assert.deepEqual(result.excludedEvidenceIds, ['a']);
  assert.equal(result.truncated, true);
});

test('v2 enforces canonical scope and trust before composing', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['reviewed'],
    enforceIsolation: true,
  });
  assert.throws(
    () => composeEvidenceContextV2([{ ...createEvidence('a', 'doc-a', 1, 0), corpusId: 'other' }], { scope }),
    /corpus scope mismatch/
  );
  assert.throws(
    () => composeEvidenceContextV2([{ ...createEvidence('a', 'doc-a', 1, 0), trustLevel: 'quarantined' }]),
    /quarantined/
  );
  assert.throws(
    () => composeEvidenceContextV2([
      { ...createEvidence('a', 'doc-a', 1, 0), content: 'x'.repeat(1000) },
      { ...createEvidence('b', 'doc-b', 1, 0), corpusId: 'other' },
    ], { scope, maxTokens: 2 }),
    /corpus scope mismatch/
  );
});

test('default estimator accounts conservatively for CJK and custom estimator is validated', () => {
  assert.equal(estimateEvidenceContextTokens('abcd中文'), 3);
  assert.throws(
    () => composeEvidenceContextV2([createEvidence('a', 'doc-a', 1, 0)], { estimateTokens: () => Number.NaN }),
    /finite non-negative/
  );
});

test('v2 rejects duplicate evidence identity and non-finite displayed scores', () => {
  const item = createEvidence('a', 'doc-a', 1, 0);
  assert.throws(
    () => composeEvidenceContextV2([item, { ...item }]),
    /IDs must be unique/
  );
  assert.throws(
    () => composeEvidenceContextV2([{ ...item, retrievalScore: Number.NaN }]),
    /score must be finite/
  );
});

test('header-only compatibility output does not claim empty evidence inclusion', () => {
  const result = composeEvidenceContextV2([{
    ...createEvidence('a', 'doc-a', 1, 0),
    source: undefined,
  }], {
    maxTokens: 4,
    includeScores: false,
    includeStructure: false,
    estimateTokens: value => value.length,
    allowHeaderOnly: true,
  });
  assert.equal(result.context, '[1]\n');
  assert.deepEqual(result.includedEvidenceIds, []);
  assert.deepEqual(result.excludedEvidenceIds, ['a']);
});

function createEvidence(id, documentId, page, startOffset) {
  const content = 'content-' + id;
  return {
    id,
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId,
    documentVersion: 'v1',
    content,
    source: documentId + '.pdf',
    page,
    sectionPath: ['Section', String(page)],
    startOffset,
    endOffset: startOffset + content.length,
    retrievalScore: 0.9,
    trustLevel: 'reviewed',
    laneId: 'dense',
    metadata: {},
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
