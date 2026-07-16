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

const { decideRagAbstention } = await import('./abstention-policy.ts');

test('no evidence and uncalibrated evidence abstain explicitly', () => {
  assert.equal(decideRagAbstention(baseInput([])).reason, 'no_evidence');
  const uncalibrated = decideRagAbstention({
    ...baseInput([evidence('a', 'dense', 'doc-a', 0.9)]),
    calibration: { version: 'fixture-v1', lanes: {} },
  });
  assert.equal(uncalibrated.reason, 'uncalibrated_lane_evidence');
});

test('per-lane threshold uses configured score field', () => {
  const item = { ...evidence('a', 'dense', 'doc-a', 0.8), rerankScore: 0.2 };
  const rerankDecision = decideRagAbstention({
    ...baseInput([item]),
    calibration: {
      version: 'fixture-v1',
      lanes: { dense: { minimumScore: 0.5, scoreField: 'rerank' } },
    },
  });
  assert.equal(rerankDecision.reason, 'all_evidence_below_lane_threshold');

  const retrievalDecision = decideRagAbstention({
    ...baseInput([item]),
    calibration: {
      version: 'fixture-v1',
      lanes: { dense: { minimumScore: 0.5, scoreField: 'retrieval' } },
    },
  });
  assert.equal(retrievalDecision.abstain, false);
});

test('identifier requires calibrated lexical proof, not a high dense score', () => {
  const denseOnly = decideRagAbstention({
    ...baseInput([evidence('a', 'dense', 'doc-a', 0.99)]),
    queryKind: 'identifier',
  });
  assert.equal(denseOnly.reason, 'identifier_requires_lexical_evidence');

  const hybridEvidence = {
    ...evidence('b', 'hybrid', 'doc-a', 0.8),
    metadata: { lexicalMatch: true },
  };
  const hybrid = decideRagAbstention({
    ...baseInput([hybridEvidence]),
    queryKind: 'identifier',
    laneKinds: { hybrid: 'hybrid' },
    calibration: { version: 'fixture-v1', lanes: { hybrid: { minimumScore: 0.5 } } },
  });
  assert.equal(hybrid.abstain, false);
});

test('global and multi-hop questions require distinct supporting documents', () => {
  const oneDocument = decideRagAbstention({
    ...baseInput([
      evidence('a', 'dense', 'doc-a', 0.9),
      evidence('b', 'dense', 'doc-a', 0.8),
    ]),
    queryKind: 'global',
  });
  assert.equal(oneDocument.reason, 'insufficient_distinct_documents');
  assert.equal(oneDocument.distinctDocumentCount, 1);

  const twoDocuments = decideRagAbstention({
    ...baseInput([
      evidence('a', 'dense', 'doc-a', 0.9),
      evidence('b', 'dense', 'doc-b', 0.8),
    ]),
    queryKind: 'multi-hop',
  });
  assert.equal(twoDocuments.abstain, false);
  assert.equal(twoDocuments.distinctDocumentCount, 2);
});

test('quarantined or non-finite evidence fails closed', () => {
  const unsafe = decideRagAbstention({
    ...baseInput([{ ...evidence('a', 'dense', 'doc-a', 0.9), trustLevel: 'quarantined' }]),
  });
  assert.equal(unsafe.reason, 'unsafe_evidence');
  const invalid = decideRagAbstention({
    ...baseInput([evidence('a', 'dense', 'doc-a', Number.NaN)]),
  });
  assert.equal(invalid.reason, 'invalid_evidence_score');
});

test('ordered evidence without scores must be opted in by calibration', () => {
  const item = { ...evidence('a', 'ordered', 'doc-a', 0.9), retrievalScore: undefined };
  const decision = decideRagAbstention({
    ...baseInput([item]),
    laneKinds: { ordered: 'ordered' },
    calibration: {
      version: 'ordered-v1',
      lanes: { ordered: { minimumScore: 0, allowMissingScore: true } },
    },
  });
  assert.equal(decision.abstain, false);
});

test('calibration fields are validated at runtime', () => {
  assert.throws(
    () => decideRagAbstention({
      ...baseInput([evidence('a', 'dense', 'doc-a', 0.9)]),
      calibration: {
        version: 'fixture-v1',
        lanes: { dense: { minimumScore: 0.5, scoreField: 'mystery' } },
      },
    }),
    /scoreField is invalid/
  );
});

function baseInput(items) {
  return {
    queryKind: 'semantic',
    evidence: items,
    laneKinds: { dense: 'dense' },
    calibration: {
      version: 'fixture-v1',
      lanes: { dense: { minimumScore: 0.5, scoreField: 'best' } },
    },
  };
}

function evidence(id, laneId, documentId, retrievalScore) {
  return {
    id,
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId,
    documentVersion: 'v1',
    content: 'content-' + id,
    retrievalScore,
    trustLevel: 'reviewed',
    laneId,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
