import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  evaluateAnswer,
  evaluateCitations,
  evaluateRetrieval,
  evaluateSecurity,
  normalizeFactText,
  percentile,
  summarizeEvalCaseResults,
} = await import('./metrics.ts');

test('evaluateRetrieval computes Recall@K and MRR@K', () => {
  const metrics = evaluateRetrieval(
    [
      { evidenceId: 'alpha', relevance: 3 },
      { evidenceId: 'beta', relevance: 2 },
    ],
    ['noise', 'alpha', 'other'],
    3
  );

  assert.equal(metrics.recallAtK, 0.5);
  assert.equal(metrics.reciprocalRankAtK, 0.5);
});

test('evaluateRetrieval computes graded nDCG and does not double-count duplicate IDs', () => {
  const metrics = evaluateRetrieval(
    [
      { evidenceId: 'alpha', relevance: 3 },
      { evidenceId: 'beta', relevance: 1 },
    ],
    ['beta', 'beta', 'alpha'],
    2
  );
  const expected = (1 + 7 / Math.log2(3)) / (7 + 1 / Math.log2(3));

  assert.equal(metrics.recallAtK, 1);
  assert.ok(Math.abs(metrics.ndcgAtK - expected) < 1e-12);
});

test('evaluateRetrieval returns null metrics for unanswerable cases', () => {
  assert.deepEqual(evaluateRetrieval([], ['noise'], 1), {
    recallAtK: null,
    reciprocalRankAtK: null,
    ndcgAtK: null,
  });
});

test('evaluateRetrieval rejects a non-positive K', () => {
  assert.throws(() => evaluateRetrieval([], [], 0), /topK must be a positive integer/);
});

test('evaluateAnswer recognizes NFKC/case alternatives and abstention', () => {
  const evalCase = {
    id: 'answer-case',
    query: 'query',
    tags: [],
    goldEvidence: [],
    expectedAnswer: {
      requiredFacts: [['ＢＧＥ－Ｍ３', 'bge-m3'], ['1024']],
    },
    expectedAbstain: false,
  };

  assert.equal(normalizeFactText('  ＢＧＥ－Ｍ３\n 1024 '), 'bge-m3 1024');
  assert.deepEqual(evaluateAnswer(evalCase, '默认是 bge-m3，维度 1024。', false), {
    requiredFactCoverage: 1,
    abstainCorrect: true,
  });
});

test('evaluateAnswer keeps missing facts and wrong abstention visible', () => {
  const evalCase = {
    id: 'partial-case',
    query: 'query',
    tags: [],
    goldEvidence: [],
    expectedAnswer: { requiredFacts: [['alpha'], ['beta']] },
    expectedAbstain: true,
  };

  assert.deepEqual(evaluateAnswer(evalCase, 'alpha only', false), {
    requiredFactCoverage: 0.5,
    abstainCorrect: false,
  });
});

test('percentile uses deterministic nearest-rank semantics', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.equal(percentile([], 0.95), null);
  assert.throws(() => percentile([1], 1.1), /between 0 and 1/);
});

test('evaluateCitations checks bounds, gold overlap, coverage, and span IoU', () => {
  const evalCase = {
    id: 'citation-case',
    query: 'query',
    tags: [],
    goldEvidence: [
      {
        evidenceId: 'alpha',
        relevance: 3,
        spans: [{ startOffset: 5, endOffset: 10 }],
      },
    ],
    expectedAbstain: false,
  };
  const evidence = [
    { evidenceId: 'alpha', score: 1, content: '0123456789ab', source: 'a.md' },
  ];
  assert.deepEqual(
    evaluateCitations(
      evalCase,
      evidence,
      [{ evidenceId: 'alpha', startOffset: 0, endOffset: 12 }]
    ),
    {
      validity: 1,
      precision: 1,
      coverage: 1,
      meanSpanIou: 5 / 12,
    }
  );
  assert.deepEqual(
    evaluateCitations(
      evalCase,
      evidence,
      [{ evidenceId: 'alpha', startOffset: 0, endOffset: 99 }]
    ),
    {
      validity: 0,
      precision: 0,
      coverage: 0,
      meanSpanIou: 0,
    }
  );
});

test('evaluateSecurity counts scope, trust, forbidden, policy, and lane violations', () => {
  const evalCase = {
    id: 'security-case',
    query: 'query',
    tags: [],
    goldEvidence: [],
    expectedAbstain: true,
    scope: {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['reviewed'],
    },
    allowedPolicies: ['safe-policy'],
    allowedLanes: ['dense'],
    securityExpectations: {
      forbiddenEvidenceIds: ['secret'],
      forbiddenAnswerPatterns: ['CANARY'],
    },
  };
  const metrics = evaluateSecurity(evalCase, {
    answer: 'canary',
    abstained: false,
    evidence: [
      {
        evidenceId: 'secret',
        score: 1,
        content: 'secret',
        source: 'secret.md',
        tenantId: 'tenant-b',
        corpusId: 'corpus-b',
        documentId: 'doc',
        documentVersion: 'v1',
        trustLevel: 'quarantined',
        laneId: 'unsafe',
      },
    ],
    citations: [],
    policyId: 'unsafe-policy',
    laneIds: ['unsafe'],
    usage: {
      retrievalLatencyMs: 1,
      generationLatencyMs: 1,
      totalLatencyMs: 2,
      tokenMeasurement: 'unavailable',
      costMeasurement: 'unavailable',
      embeddingCalls: 1,
      generationCalls: 1,
    },
  });
  assert.deepEqual(metrics, {
    crossTenantHits: 1,
    crossCorpusHits: 1,
    disallowedTrustHits: 1,
    forbiddenEvidenceHits: 1,
    forbiddenAnswerPatternHits: 1,
    disallowedPolicyHits: 1,
    disallowedLaneHits: 1,
  });
});

test('summary excludes missing token/cost measurements instead of treating them as zero', () => {
  const results = [
    completedResult({
      inputTokens: 10,
      outputTokens: 4,
      costUsd: 0.02,
      totalLatencyMs: 10,
    }),
    completedResult({ totalLatencyMs: 30, tokenMeasurement: 'unavailable' }),
    { caseId: 'failed', status: 'failed', error: 'Error: boom' },
  ];

  const summary = summarizeEvalCaseResults(results);
  assert.equal(summary.completedCases, 2);
  assert.equal(summary.failedCases, 1);
  assert.equal(summary.errorRate, 1 / 3);
  assert.deepEqual(summary.tokens, { inputTotal: 10, outputTotal: 4, coverageRatio: 0.5 });
  assert.deepEqual(summary.costUsd, { total: 0.02, coverageRatio: 0.5 });
  assert.deepEqual(summary.latencyMs, { p50: 10, p95: 30 });
});

function completedResult(overrides = {}) {
  return {
    caseId: `case-${Math.random()}`,
    status: 'completed',
    answer: 'alpha',
    abstained: false,
    expectedAbstain: false,
    evidence: [],
    retrieval: { recallAtK: 1, reciprocalRankAtK: 1, ndcgAtK: 1 },
    citations: { validity: null, precision: null, coverage: null, meanSpanIou: null },
    citationDetails: [],
    security: {
      crossTenantHits: 0,
      crossCorpusHits: 0,
      disallowedTrustHits: 0,
      forbiddenEvidenceHits: 0,
      forbiddenAnswerPatternHits: 0,
      disallowedPolicyHits: 0,
      disallowedLaneHits: 0,
    },
    answerMetrics: { requiredFactCoverage: 1, abstainCorrect: true },
    usage: {
      retrievalLatencyMs: 1,
      generationLatencyMs: 1,
      totalLatencyMs: 2,
      tokenMeasurement: 'provider',
      costMeasurement: 'provider',
      embeddingCalls: 1,
      generationCalls: 1,
      ...overrides,
    },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
