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

const { runRagEval } = await import('./runner.ts');

test('runRagEval records identity, metrics, usage, and deterministic metadata', async () => {
  const clockValues = [new Date('2026-07-15T01:00:00.000Z'), new Date('2026-07-15T01:00:01.000Z')];
  const target = {
    id: 'fixture-target',
    async run({ evalCase }) {
      assert.deepEqual(Object.keys(evalCase).sort(), ['query']);
      return targetResult(evalCase.query === 'alpha?' ? 'alpha' : 'noise', evalCase.query === 'unknown?');
    },
  };

  const report = await runRagEval(createDataset(), target, {
    topK: 1,
    runId: 'run-fixed',
    metadata: { gitSha: 'abc123' },
    clock: () => clockValues.shift(),
  });

  assert.equal(report.runId, 'run-fixed');
  assert.equal(report.startedAt, '2026-07-15T01:00:00.000Z');
  assert.equal(report.completedAt, '2026-07-15T01:00:01.000Z');
  assert.equal(report.dataset.id, 'runner-fixture');
  assert.match(report.dataset.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.metadata, { gitSha: 'abc123' });
  assert.equal(report.cases[0].retrieval.recallAtK, 1);
  assert.equal(report.cases[0].answerMetrics.requiredFactCoverage, 1);
  assert.equal(report.cases[1].retrieval.recallAtK, null);
  assert.equal(report.summary.abstainAccuracy, 1);
});

test('runRagEval is fail-soft per case and continues after a target error', async () => {
  const visited = [];
  const target = {
    id: 'partly-broken-target',
    async run({ evalCase }) {
      visited.push(evalCase.query);
      if (evalCase.query === 'alpha?') {
        throw new Error('provider unavailable');
      }
      return targetResult('noise', true);
    },
  };

  const report = await runRagEval(createDataset(), target, { runId: 'run-fail-soft' });

  assert.deepEqual(visited, ['alpha?', 'unknown?']);
  assert.equal(report.cases[0].status, 'failed');
  assert.match(report.cases[0].error, /provider unavailable/);
  assert.equal(report.cases[1].status, 'completed');
  assert.equal(report.summary.failedCases, 1);
  assert.equal(report.summary.completedCases, 1);
  assert.equal(report.summary.errorRate, 0.5);
});

test('runRagEval executes cases sequentially', async () => {
  let concurrent = 0;
  let maximumConcurrent = 0;
  const target = {
    id: 'sequential-target',
    async run({ evalCase }) {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return targetResult(evalCase.query === 'alpha?' ? 'alpha' : 'noise', evalCase.query === 'unknown?');
    },
  };

  await runRagEval(createDataset(), target);
  assert.equal(maximumConcurrent, 1);
});

test('runRagEval rejects invalid topK before invoking a target', async () => {
  let calls = 0;
  const target = {
    id: 'unused-target',
    async run() {
      calls += 1;
      return targetResult('alpha', false);
    },
  };

  await assert.rejects(runRagEval(createDataset(), target, { topK: 0 }), /positive integer/);
  assert.equal(calls, 0);
});

test('E1b runner exposes only query and scope while retaining evaluator-only labels', async () => {
  const target = {
    id: 'safe-policy',
    async run({ evalCase }) {
      assert.deepEqual(Object.keys(evalCase).sort(), ['query', 'scope']);
      assert.equal('id' in evalCase, false);
      assert.equal('tags' in evalCase, false);
      assert.equal('goldEvidence' in evalCase, false);
      return {
        answer: 'alpha fact',
        abstained: false,
        evidence: [
          {
            evidenceId: 'alpha',
            score: 1,
            content: 'alpha fact',
            source: 'alpha.md',
            tenantId: 'tenant-a',
            corpusId: 'corpus-a',
            documentId: 'doc-alpha',
            documentVersion: 'v1',
            trustLevel: 'reviewed',
            laneId: 'dense',
          },
        ],
        citations: [{ evidenceId: 'alpha', startOffset: 0, endOffset: 10 }],
        policyId: 'safe-policy',
        laneIds: ['dense'],
        usage: targetResult('alpha', false).usage,
      };
    },
  };

  const report = await runRagEval(createV2Dataset(), target);
  assert.equal(report.cases[0].status, 'completed');
  assert.equal(report.cases[0].citations.validity, 1);
  assert.equal(report.cases[0].citations.precision, 1);
  assert.equal(report.cases[0].citations.coverage, 1);
  assert.equal(report.summary.security.crossTenantHits, 0);
});

test('E1b runner fails a case on unknown, duplicate, or non-finite evidence', async () => {
  for (const evidence of [
    [
      {
        evidenceId: 'missing',
        score: 1,
        content: 'x',
        source: 'x',
      },
    ],
    [
      {
        evidenceId: 'alpha',
        score: 1,
        content: 'alpha fact',
        source: 'alpha.md',
      },
      {
        evidenceId: 'alpha',
        score: 0.5,
        content: 'alpha fact',
        source: 'alpha.md',
      },
    ],
    [
      {
        evidenceId: 'alpha',
        score: Number.NaN,
        content: 'alpha fact',
        source: 'alpha.md',
      },
    ],
  ]) {
    const report = await runRagEval(createDataset(), {
      id: 'bad-target',
      async run() {
        return {
          ...targetResult('alpha', false),
          evidence,
        };
      },
    });
    assert.equal(report.cases[0].status, 'failed');
  }
});

test('E1b runner rejects target-reported provenance that differs from canonical corpus', async () => {
  const canonicalEvidence = {
    evidenceId: 'alpha',
    score: 1,
    content: 'alpha fact',
    source: 'alpha.md',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-alpha',
    documentVersion: 'v1',
    trustLevel: 'reviewed',
    laneId: 'dense',
  };

  for (const [field, value] of [
    ['content', 'forged content'],
    ['source', 'forged.md'],
    ['tenantId', 'tenant-b'],
    ['corpusId', 'corpus-b'],
    ['documentId', 'doc-forged'],
    ['documentVersion', 'v999'],
    ['trustLevel', 'trusted'],
  ]) {
    const report = await runRagEval(createV2Dataset(), {
      id: 'safe-policy',
      async run() {
        return {
          answer: 'alpha fact',
          abstained: false,
          evidence: [{ ...canonicalEvidence, [field]: value }],
          citations: [{ evidenceId: 'alpha', startOffset: 0, endOffset: 5 }],
          policyId: 'safe-policy',
          laneIds: ['dense'],
          usage: targetResult('alpha', false).usage,
        };
      },
    });
    assert.equal(report.cases[0].status, 'failed');
    assert.ok(report.cases[0].error.includes(`evidence[0].${field}`));
  }
});

function createDataset() {
  return {
    schemaVersion: 'rag-eval-dataset/v1',
    datasetId: 'runner-fixture',
    datasetVersion: '1.0.0',
    corpus: [
      {
        evidenceId: 'alpha',
        documentId: 'doc-alpha',
        source: 'alpha.md',
        content: 'alpha fact',
      },
      {
        evidenceId: 'noise',
        documentId: 'doc-noise',
        source: 'noise.md',
        content: 'irrelevant',
      },
    ],
    cases: [
      {
        id: 'answerable',
        query: 'alpha?',
        tags: ['answerable'],
        goldEvidence: [{ evidenceId: 'alpha', relevance: 3 }],
        expectedAnswer: { requiredFacts: [['alpha']] },
        expectedAbstain: false,
      },
      {
        id: 'unknown',
        query: 'unknown?',
        tags: ['unanswerable'],
        goldEvidence: [],
        expectedAbstain: true,
      },
    ],
  };
}

function createV2Dataset() {
  return {
    schemaVersion: 'rag-eval-dataset/v2',
    datasetId: 'runner-v2',
    datasetVersion: '2.0.0',
    corpus: [
      {
        evidenceId: 'alpha',
        documentId: 'doc-alpha',
        documentVersion: 'v1',
        tenantId: 'tenant-a',
        corpusId: 'corpus-a',
        trustLevel: 'reviewed',
        source: 'alpha.md',
        content: 'alpha fact',
      },
    ],
    cases: [
      {
        id: 'answerable-label-must-stay-hidden',
        query: 'alpha?',
        tags: ['answerable', 'citation'],
        goldEvidence: [
          {
            evidenceId: 'alpha',
            relevance: 3,
            spans: [{ startOffset: 0, endOffset: 5 }],
          },
        ],
        expectedAnswer: { requiredFacts: [['alpha']] },
        expectedAbstain: false,
        scope: {
          tenantId: 'tenant-a',
          corpusId: 'corpus-a',
          allowedTrustLevels: ['reviewed'],
        },
        allowedPolicies: ['safe-policy'],
        allowedLanes: ['dense'],
        securityExpectations: {
          forbiddenEvidenceIds: [],
          forbiddenAnswerPatterns: ['FORBIDDEN_CANARY'],
        },
      },
    ],
  };
}

function targetResult(evidenceId, abstained) {
  return {
    answer: abstained ? '无法根据知识库回答。' : 'alpha fact',
    abstained,
    evidence: [{ evidenceId, score: 1, content: 'alpha fact', source: 'alpha.md' }],
    usage: {
      retrievalLatencyMs: 2,
      generationLatencyMs: 3,
      totalLatencyMs: 5,
      inputTokens: 4,
      outputTokens: 2,
      tokenMeasurement: 'provider',
      costUsd: 0.001,
      costMeasurement: 'provider',
      embeddingCalls: 1,
      generationCalls: 1,
    },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
