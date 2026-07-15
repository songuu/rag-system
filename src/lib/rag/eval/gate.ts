import type { RagEvalRunReport } from './types';

export type RagEvalGateProfile = 'none' | 'e1b';

export interface RagEvalGateFinding {
  code: string;
  actual: number | string | null;
  expected: string;
}

export interface RagEvalGateResult {
  profile: RagEvalGateProfile;
  passed: boolean;
  findings: RagEvalGateFinding[];
}

export function evaluateRagEvalGate(
  report: RagEvalRunReport,
  profile: RagEvalGateProfile
): RagEvalGateResult {
  if (profile === 'none') {
    return { profile, passed: true, findings: [] };
  }

  const findings: RagEvalGateFinding[] = [];
  expectEqual(
    findings,
    'DATASET_SCHEMA',
    report.dataset.schemaVersion,
    'rag-eval-dataset/v2'
  );
  expectEqual(findings, 'FAILED_CASES', report.summary.failedCases, 0);
  expectEqual(
    findings,
    'RECALL_AT_K',
    report.summary.meanRecallAtK,
    1
  );
  expectEqual(
    findings,
    'REQUIRED_FACT_COVERAGE',
    report.summary.meanRequiredFactCoverage,
    1
  );
  expectEqual(
    findings,
    'ANSWER_METRIC_COVERAGE',
    report.summary.answerMetricCoverageRatio,
    1
  );
  expectEqual(
    findings,
    'CITATION_VALIDITY',
    report.summary.citation.meanValidity,
    1
  );
  expectEqual(
    findings,
    'CITATION_PRECISION',
    report.summary.citation.meanPrecision,
    1
  );
  expectEqual(
    findings,
    'CITATION_COVERAGE',
    report.summary.citation.meanCoverage,
    1
  );
  expectAtLeast(
    findings,
    'CITATION_SPAN_IOU',
    report.summary.citation.meanSpanIou,
    0.3
  );
  expectEqual(
    findings,
    'UNANSWERABLE_TPR',
    report.summary.abstain.unanswerableTruePositiveRate,
    1
  );
  expectEqual(
    findings,
    'ANSWERABLE_ABSTAIN_FPR',
    report.summary.abstain.answerableFalsePositiveRate,
    0
  );
  expectEqual(
    findings,
    'SELECTIVE_ACCURACY',
    report.summary.abstain.selectiveAccuracy,
    1
  );
  for (const [field, value] of Object.entries(report.summary.security)) {
    expectEqual(
      findings,
      'SECURITY_' + field.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase(),
      value,
      0
    );
  }

  return {
    profile,
    passed: findings.length === 0,
    findings,
  };
}

function expectAtLeast(
  findings: RagEvalGateFinding[],
  code: string,
  actual: number | null,
  minimum: number
): void {
  if (actual === null || actual < minimum) {
    findings.push({
      code,
      actual,
      expected: `>= ${minimum}`,
    });
  }
}

function expectEqual(
  findings: RagEvalGateFinding[],
  code: string,
  actual: number | string | null,
  expected: number | string
): void {
  if (actual !== expected) {
    findings.push({
      code,
      actual,
      expected: String(expected),
    });
  }
}
