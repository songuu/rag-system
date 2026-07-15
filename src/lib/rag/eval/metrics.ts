import type {
  RagEvalAnswerMetrics,
  RagEvalCase,
  RagEvalCaseResult,
  RagEvalCitation,
  RagEvalCitationMetrics,
  RagEvalGoldEvidence,
  RagEvalRetrievedEvidence,
  RagEvalRetrievalMetrics,
  RagEvalSecurityMetrics,
  RagEvalSummary,
  RagEvalTargetResult,
} from './types';

export function evaluateRetrieval(
  goldEvidence: readonly RagEvalGoldEvidence[],
  retrievedEvidenceIds: readonly string[],
  topK: number
): RagEvalRetrievalMetrics {
  assertPositiveInteger(topK, 'topK');
  if (goldEvidence.length === 0) {
    return {
      recallAtK: null,
      reciprocalRankAtK: null,
      ndcgAtK: null,
    };
  }

  const goldById = new Map(goldEvidence.map(gold => [gold.evidenceId, gold.relevance]));
  const rankedIds = unique(retrievedEvidenceIds).slice(0, topK);
  const hits = rankedIds.filter(evidenceId => goldById.has(evidenceId));
  const firstRelevantRank = rankedIds.findIndex(evidenceId => goldById.has(evidenceId));
  const actualDcg = discountedCumulativeGain(
    rankedIds.map(evidenceId => goldById.get(evidenceId) ?? 0)
  );
  const idealDcg = discountedCumulativeGain(
    goldEvidence
      .map(gold => gold.relevance)
      .sort((left, right) => right - left)
      .slice(0, topK)
  );

  return {
    recallAtK: hits.length / goldEvidence.length,
    reciprocalRankAtK: firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1),
    ndcgAtK: idealDcg === 0 ? 0 : actualDcg / idealDcg,
  };
}

export function evaluateAnswer(
  evalCase: RagEvalCase,
  answer: string,
  abstained: boolean
): RagEvalAnswerMetrics {
  const normalizedAnswer = normalizeFactText(answer);
  const requiredFacts = evalCase.expectedAnswer?.requiredFacts;
  const coveredFacts = requiredFacts?.filter(alternatives =>
    alternatives.some(alternative => normalizedAnswer.includes(normalizeFactText(alternative)))
  ).length;

  return {
    requiredFactCoverage:
      requiredFacts === undefined || requiredFacts.length === 0
        ? null
        : (coveredFacts ?? 0) / requiredFacts.length,
    abstainCorrect: evalCase.expectedAbstain === abstained,
  };
}

export function evaluateCitations(
  evalCase: RagEvalCase,
  evidence: readonly RagEvalRetrievedEvidence[],
  citations: readonly RagEvalCitation[]
): RagEvalCitationMetrics {
  const goldSpans = evalCase.goldEvidence.flatMap(gold =>
    (gold.spans ?? []).map(span => ({
      evidenceId: gold.evidenceId,
      ...span,
    }))
  );
  if (goldSpans.length === 0) {
    return {
      validity: null,
      precision: null,
      coverage: null,
      meanSpanIou: null,
    };
  }

  const evidenceById = new Map(evidence.map(item => [item.evidenceId, item]));
  const validCitations = citations.filter(citation => {
    const item = evidenceById.get(citation.evidenceId);
    return Boolean(
      item &&
      Number.isInteger(citation.startOffset) &&
      Number.isInteger(citation.endOffset) &&
      citation.startOffset >= 0 &&
      citation.endOffset > citation.startOffset &&
      citation.endOffset <= item.content.length
    );
  });
  const citationsWithGoldOverlap = validCitations.filter(citation =>
    goldSpans.some(gold =>
      gold.evidenceId === citation.evidenceId &&
      spanOverlap(citation, gold) > 0
    )
  );
  const coveredGold = goldSpans.filter(gold =>
    validCitations.some(citation =>
      citation.evidenceId === gold.evidenceId &&
      spanOverlap(citation, gold) > 0
    )
  );
  const bestIouByGold = goldSpans.map(gold =>
    Math.max(
      0,
      ...validCitations
        .filter(citation => citation.evidenceId === gold.evidenceId)
        .map(citation => spanIou(citation, gold))
    )
  );

  return {
    validity: citations.length === 0 ? 0 : validCitations.length / citations.length,
    precision:
      citations.length === 0 ? 0 : citationsWithGoldOverlap.length / citations.length,
    coverage: coveredGold.length / goldSpans.length,
    meanSpanIou: meanNullable(bestIouByGold),
  };
}

export function evaluateSecurity(
  evalCase: RagEvalCase,
  targetResult: RagEvalTargetResult
): RagEvalSecurityMetrics {
  const empty = emptySecurityMetrics();
  const scope = evalCase.scope;
  const expectations = evalCase.securityExpectations;
  const allowedPolicies = evalCase.allowedPolicies;
  const allowedLanes = evalCase.allowedLanes;
  if (!scope && !expectations && !allowedPolicies && !allowedLanes) {
    return empty;
  }

  const forbiddenEvidenceIds = new Set(expectations?.forbiddenEvidenceIds ?? []);
  const normalizedAnswer = normalizeSecurityText(targetResult.answer);
  const laneIds = unique([
    ...(targetResult.laneIds ?? []),
    ...targetResult.evidence.flatMap(item => item.laneId ? [item.laneId] : []),
  ]);

  return {
    crossTenantHits: scope
      ? targetResult.evidence.filter(item => item.tenantId !== scope.tenantId).length
      : 0,
    crossCorpusHits: scope
      ? targetResult.evidence.filter(item => item.corpusId !== scope.corpusId).length
      : 0,
    disallowedTrustHits: scope
      ? targetResult.evidence.filter(
          item =>
            item.trustLevel === undefined ||
            item.trustLevel === 'quarantined' ||
            !scope.allowedTrustLevels.includes(item.trustLevel)
        ).length
      : 0,
    forbiddenEvidenceHits: targetResult.evidence.filter(item =>
      forbiddenEvidenceIds.has(item.evidenceId)
    ).length,
    forbiddenAnswerPatternHits: (expectations?.forbiddenAnswerPatterns ?? [])
      .filter(pattern =>
        normalizedAnswer.includes(normalizeSecurityText(pattern))
      ).length,
    disallowedPolicyHits:
      allowedPolicies === undefined
        ? 0
        : targetResult.policyId !== undefined &&
            allowedPolicies.includes(targetResult.policyId)
          ? 0
          : 1,
    disallowedLaneHits:
      allowedLanes === undefined
        ? 0
        : laneIds.length === 0
          ? 1
          : laneIds.filter(laneId => !allowedLanes.includes(laneId)).length,
  };
}

export function summarizeEvalCaseResults(results: readonly RagEvalCaseResult[]): RagEvalSummary {
  const completed = results.filter(result => result.status === 'completed');
  const failedCases = results.length - completed.length;
  const retrievalMetricCases = completed.filter(result => result.retrieval.recallAtK !== null);
  const answerMetricCases = completed.filter(
    result => result.answerMetrics.requiredFactCoverage !== null
  );
  const tokenCases = completed.filter(
    result => result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined
  );
  const costCases = completed.filter(result => result.usage.costUsd !== undefined);
  const latencies = completed.map(result => result.usage.totalLatencyMs);
  const unanswerableCases = completed.filter(result => result.expectedAbstain);
  const answerableCases = completed.filter(result => !result.expectedAbstain);
  const answeredCases = completed.filter(result => !result.abstained);
  const citationCases = completed.filter(result => result.citations.coverage !== null);
  const security = completed.reduce(
    (total, result) => addSecurityMetrics(total, result.security),
    emptySecurityMetrics()
  );

  return {
    totalCases: results.length,
    completedCases: completed.length,
    failedCases,
    errorRate: results.length === 0 ? 0 : failedCases / results.length,
    retrievalMetricCoverageRatio:
      completed.length === 0 ? 0 : retrievalMetricCases.length / completed.length,
    answerMetricCoverageRatio:
      answerableCases.length === 0
        ? 0
        : answerMetricCases.length / answerableCases.length,
    meanRecallAtK: meanNullable(retrievalMetricCases.map(result => result.retrieval.recallAtK)),
    meanReciprocalRankAtK: meanNullable(
      retrievalMetricCases.map(result => result.retrieval.reciprocalRankAtK)
    ),
    meanNdcgAtK: meanNullable(retrievalMetricCases.map(result => result.retrieval.ndcgAtK)),
    meanRequiredFactCoverage: meanNullable(
      answerMetricCases.map(result => result.answerMetrics.requiredFactCoverage)
    ),
    abstainAccuracy: meanNullable(
      completed.map(result => (result.answerMetrics.abstainCorrect ? 1 : 0))
    ),
    abstain: {
      unanswerableTruePositiveRate: meanNullable(
        unanswerableCases.map(result => result.abstained ? 1 : 0)
      ),
      answerableFalsePositiveRate: meanNullable(
        answerableCases.map(result => result.abstained ? 1 : 0)
      ),
      answerCoverage: meanNullable(
        completed.map(result => result.abstained ? 0 : 1)
      ),
      selectiveAccuracy: meanNullable(
        answeredCases.map(result => {
          if (result.expectedAbstain) return 0;
          const coverage = result.answerMetrics.requiredFactCoverage;
          return coverage === null
            ? result.answerMetrics.abstainCorrect ? 1 : 0
            : coverage === 1 ? 1 : 0;
        })
      ),
    },
    citation: {
      metricCoverageRatio:
        completed.length === 0 ? 0 : citationCases.length / completed.length,
      meanValidity: meanNullable(citationCases.map(result => result.citations.validity)),
      meanPrecision: meanNullable(citationCases.map(result => result.citations.precision)),
      meanCoverage: meanNullable(citationCases.map(result => result.citations.coverage)),
      meanSpanIou: meanNullable(citationCases.map(result => result.citations.meanSpanIou)),
    },
    security,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    tokens: {
      inputTotal:
        tokenCases.length === 0
          ? null
          : tokenCases.reduce((total, result) => total + (result.usage.inputTokens ?? 0), 0),
      outputTotal:
        tokenCases.length === 0
          ? null
          : tokenCases.reduce((total, result) => total + (result.usage.outputTokens ?? 0), 0),
      coverageRatio: completed.length === 0 ? 0 : tokenCases.length / completed.length,
    },
    costUsd: {
      total:
        costCases.length === 0
          ? null
          : costCases.reduce((total, result) => total + (result.usage.costUsd ?? 0), 0),
      coverageRatio: completed.length === 0 ? 0 : costCases.length / completed.length,
    },
    calls: {
      embeddingTotal: completed.reduce(
        (total, result) => total + result.usage.embeddingCalls,
        0
      ),
      generationTotal: completed.reduce(
        (total, result) => total + result.usage.generationCalls,
        0
      ),
    },
  };
}

function normalizeSecurityText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function spanOverlap(
  left: { startOffset: number; endOffset: number },
  right: { startOffset: number; endOffset: number }
): number {
  return Math.max(
    0,
    Math.min(left.endOffset, right.endOffset) -
      Math.max(left.startOffset, right.startOffset)
  );
}

function spanIou(
  left: { startOffset: number; endOffset: number },
  right: { startOffset: number; endOffset: number }
): number {
  const intersection = spanOverlap(left, right);
  if (intersection === 0) return 0;
  const union =
    Math.max(left.endOffset, right.endOffset) -
    Math.min(left.startOffset, right.startOffset);
  return union === 0 ? 0 : intersection / union;
}

function emptySecurityMetrics(): RagEvalSecurityMetrics {
  return {
    crossTenantHits: 0,
    crossCorpusHits: 0,
    disallowedTrustHits: 0,
    forbiddenEvidenceHits: 0,
    forbiddenAnswerPatternHits: 0,
    disallowedPolicyHits: 0,
    disallowedLaneHits: 0,
  };
}

function addSecurityMetrics(
  left: RagEvalSecurityMetrics,
  right: RagEvalSecurityMetrics
): RagEvalSecurityMetrics {
  return {
    crossTenantHits: left.crossTenantHits + right.crossTenantHits,
    crossCorpusHits: left.crossCorpusHits + right.crossCorpusHits,
    disallowedTrustHits: left.disallowedTrustHits + right.disallowedTrustHits,
    forbiddenEvidenceHits: left.forbiddenEvidenceHits + right.forbiddenEvidenceHits,
    forbiddenAnswerPatternHits:
      left.forbiddenAnswerPatternHits + right.forbiddenAnswerPatternHits,
    disallowedPolicyHits: left.disallowedPolicyHits + right.disallowedPolicyHits,
    disallowedLaneHits: left.disallowedLaneHits + right.disallowedLaneHits,
  };
}

export function percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) {
    return null;
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('[rag-eval metrics] probability must be between 0 and 1');
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

export function normalizeFactText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function discountedCumulativeGain(relevances: readonly number[]): number {
  return relevances.reduce(
    (total, relevance, index) =>
      total + (Math.pow(2, relevance) - 1) / Math.log2(index + 2),
    0
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  if (available.length === 0) {
    return null;
  }
  return available.reduce((total, value) => total + value, 0) / available.length;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[rag-eval metrics] ${label} must be a positive integer`);
  }
}
