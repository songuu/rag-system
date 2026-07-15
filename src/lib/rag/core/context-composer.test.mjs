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

const { composeEvidenceContext } = await import('./context-composer.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('context composer consumes canonical evidence and enforces scope', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['reviewed'],
    enforceIsolation: true,
  });
  const context = composeEvidenceContext(
    [createEvidence()],
    { scope, includeScores: true }
  );
  assert.match(context, /score: 0.9000/);
  assert.match(context, /source: guide.pdf/);
  assert.match(context, /canonical evidence/);

  assert.throws(
    () =>
      composeEvidenceContext(
        [{ ...createEvidence(), corpusId: 'corpus-b' }],
        { scope }
      ),
    /corpus scope mismatch/
  );
});

test('context composer never sends quarantined evidence to generation', () => {
  assert.throws(
    () => composeEvidenceContext([{ ...createEvidence(), trustLevel: 'quarantined' }]),
    /quarantined/
  );
});

test('context composer truncates an oversized first evidence instead of returning empty context', () => {
  const context = composeEvidenceContext(
    [{ ...createEvidence(), content: 'x'.repeat(200) }],
    { maxCharacters: 64, includeScores: false }
  );
  assert.equal(context.length, 64);
  assert.match(context, /^\[1\]/);
});

test('context truncation never emits a lone UTF-16 surrogate', () => {
  const context = composeEvidenceContext(
    [{ ...createEvidence(), source: undefined, content: '😀 evidence' }],
    { maxCharacters: 5, includeScores: false }
  );
  const lastCodeUnit = context.charCodeAt(context.length - 1);
  assert.equal(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff, false);
  assert.equal(context, '[1]\n');
});

function createEvidence() {
  return {
    id: 'evidence-1',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-1',
    documentVersion: 'v1',
    content: 'canonical evidence',
    source: 'guide.pdf',
    retrievalScore: 0.9,
    trustLevel: 'reviewed',
    laneId: 'dense',
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
