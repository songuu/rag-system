import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const { evaluateRagEvalGate } = await import('./gate.ts');
const { runRagEval } = await import('./runner.ts');

test('E1b gate passes only the V2 citation, abstain, and security hard boundary', () => {
  const result = evaluateRagEvalGate(createReport(), 'e1b');
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test('E1b gate reports each injected hard-boundary violation', () => {
  const mutations = [
    [report => { report.dataset.schemaVersion = 'rag-eval-dataset/v1'; }, 'DATASET_SCHEMA'],
    [report => { report.summary.failedCases = 1; }, 'FAILED_CASES'],
    [report => { report.summary.meanRecallAtK = 0.5; }, 'RECALL_AT_K'],
    [report => { report.summary.meanRequiredFactCoverage = 0.5; }, 'REQUIRED_FACT_COVERAGE'],
    [report => { report.summary.answerMetricCoverageRatio = 0.5; }, 'ANSWER_METRIC_COVERAGE'],
    [report => { report.summary.citation.meanValidity = 0.5; }, 'CITATION_VALIDITY'],
    [report => { report.summary.citation.meanPrecision = 0.5; }, 'CITATION_PRECISION'],
    [report => { report.summary.citation.meanCoverage = 0.5; }, 'CITATION_COVERAGE'],
    [report => { report.summary.citation.meanSpanIou = 0.29; }, 'CITATION_SPAN_IOU'],
    [report => { report.summary.abstain.unanswerableTruePositiveRate = 0; }, 'UNANSWERABLE_TPR'],
    [report => { report.summary.abstain.answerableFalsePositiveRate = 0.5; }, 'ANSWERABLE_ABSTAIN_FPR'],
    [report => { report.summary.abstain.selectiveAccuracy = 0.5; }, 'SELECTIVE_ACCURACY'],
    [report => { report.summary.security.crossTenantHits = 1; }, 'SECURITY_CROSS_TENANT_HITS'],
    [report => { report.summary.security.disallowedTrustHits = 1; }, 'SECURITY_DISALLOWED_TRUST_HITS'],
    [report => { report.summary.security.forbiddenAnswerPatternHits = 1; }, 'SECURITY_FORBIDDEN_ANSWER_PATTERN_HITS'],
  ];

  for (const [mutate, expectedCode] of mutations) {
    const report = createReport();
    mutate(report);
    const result = evaluateRagEvalGate(report, 'e1b');
    assert.equal(result.passed, false);
    assert.ok(result.findings.some(finding => finding.code === expectedCode));
  }
});

test('none gate never blocks a report', () => {
  const report = createReport();
  report.summary.failedCases = 99;
  assert.equal(evaluateRagEvalGate(report, 'none').passed, true);
});

test('E1b canaries catch independent tenant, corpus, and trust scope bypasses', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('./fixtures/e1b-canonical-v2.json', import.meta.url),
      'utf8'
    )
  );
  const report = await runRagEval(fixture, {
    id: 'fixture-hash-dense-v2',
    async run({ evalCase, corpus }) {
      const markerToEvidenceId = [
        ['TENANT_B_SECRET_CANARY', 'tenant-b-secret'],
        ['CORPUS_B_SECRET_CANARY', 'same-tenant-other-corpus'],
        ['EXTERNAL_TRUST_CANARY', 'external-trust-canary'],
      ];
      const match = markerToEvidenceId.find(([marker]) =>
        evalCase.query.includes(marker)
      );
      const document = match
        ? corpus.find(item => item.evidenceId === match[1])
        : undefined;
      return {
        answer: document?.content ?? '根据当前知识库无法回答该问题。',
        abstained: document === undefined,
        evidence: document
          ? [{
              evidenceId: document.evidenceId,
              score: 1,
              content: document.content,
              source: document.source,
              tenantId: document.tenantId,
              corpusId: document.corpusId,
              documentId: document.documentId,
              documentVersion: document.documentVersion,
              trustLevel: document.trustLevel,
              laneId: 'dense-vector-required',
            }]
          : [],
        citations: [],
        policyId: 'fixture-hash-dense-v2',
        laneIds: ['dense-vector-required'],
        usage: {
          retrievalLatencyMs: 0,
          generationLatencyMs: 0,
          totalLatencyMs: 0,
          tokenMeasurement: 'unavailable',
          costMeasurement: 'unavailable',
          embeddingCalls: 0,
          generationCalls: 0,
        },
      };
    },
  });

  assert.equal(report.summary.security.crossTenantHits, 1);
  assert.equal(report.summary.security.crossCorpusHits, 1);
  assert.equal(report.summary.security.disallowedTrustHits, 1);
  assert.equal(report.summary.security.forbiddenEvidenceHits, 3);
  assert.equal(report.summary.security.forbiddenAnswerPatternHits, 3);
  const gate = evaluateRagEvalGate(report, 'e1b');
  assert.equal(gate.passed, false);
  assert.ok(
    gate.findings.some(finding => finding.code === 'SECURITY_CROSS_TENANT_HITS')
  );
  assert.ok(
    gate.findings.some(finding => finding.code === 'SECURITY_CROSS_CORPUS_HITS')
  );
  assert.ok(
    gate.findings.some(finding => finding.code === 'SECURITY_DISALLOWED_TRUST_HITS')
  );
});

function createReport() {
  return {
    dataset: {
      schemaVersion: 'rag-eval-dataset/v2',
      id: 'fixture',
      version: '2',
      sha256: 'a'.repeat(64),
    },
    summary: {
      failedCases: 0,
      meanRecallAtK: 1,
      meanRequiredFactCoverage: 1,
      answerMetricCoverageRatio: 1,
      citation: {
        meanValidity: 1,
        meanPrecision: 1,
        meanCoverage: 1,
        meanSpanIou: 0.5,
      },
      abstain: {
        unanswerableTruePositiveRate: 1,
        answerableFalsePositiveRate: 0,
        selectiveAccuracy: 1,
      },
      security: {
        crossTenantHits: 0,
        crossCorpusHits: 0,
        disallowedTrustHits: 0,
        forbiddenEvidenceHits: 0,
        forbiddenAnswerPatternHits: 0,
        disallowedPolicyHits: 0,
        disallowedLaneHits: 0,
      },
    },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
