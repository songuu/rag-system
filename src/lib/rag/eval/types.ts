export const RAG_EVAL_DATASET_SCHEMA_VERSION = 'rag-eval-dataset/v1' as const;
export const RAG_EVAL_DATASET_SCHEMA_VERSION_V2 = 'rag-eval-dataset/v2' as const;

export type RagEvalDatasetSchemaVersion =
  | typeof RAG_EVAL_DATASET_SCHEMA_VERSION
  | typeof RAG_EVAL_DATASET_SCHEMA_VERSION_V2;

export type RagEvalRelevance = 1 | 2 | 3;

export type RagEvalTokenMeasurement = 'provider' | 'estimated' | 'unavailable';

export type RagEvalCostMeasurement =
  | 'provider'
  | 'configured-estimate'
  | 'unavailable';

export interface RagEvalCorpusDocument {
  evidenceId: string;
  documentId: string;
  documentVersion?: string;
  tenantId?: string;
  corpusId?: string;
  trustLevel?: 'trusted' | 'reviewed' | 'external' | 'quarantined';
  source: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RagEvalSpan {
  startOffset: number;
  endOffset: number;
}

export interface RagEvalGoldEvidence {
  evidenceId: string;
  relevance: RagEvalRelevance;
  spans?: RagEvalSpan[];
}

export interface RagEvalExpectedAnswer {
  /**
   * Each outer item is one required fact. Inner strings are accepted textual
   * alternatives for that fact, for example a full name and its abbreviation.
   */
  requiredFacts: string[][];
}

export interface RagEvalCase {
  id: string;
  query: string;
  tags: string[];
  goldEvidence: RagEvalGoldEvidence[];
  expectedAnswer?: RagEvalExpectedAnswer;
  expectedAbstain: boolean;
  scope?: RagEvalScope;
  allowedPolicies?: string[];
  allowedLanes?: string[];
  securityExpectations?: RagEvalSecurityExpectations;
}

export interface RagEvalTargetCase {
  query: string;
  scope?: RagEvalScope;
}

export interface RagEvalScope {
  tenantId: string;
  corpusId: string;
  allowedTrustLevels: Array<'trusted' | 'reviewed' | 'external'>;
}

export interface RagEvalSecurityExpectations {
  forbiddenEvidenceIds: string[];
  forbiddenAnswerPatterns: string[];
}

export interface RagEvalDataset {
  schemaVersion: RagEvalDatasetSchemaVersion;
  datasetId: string;
  datasetVersion: string;
  corpus: RagEvalCorpusDocument[];
  cases: RagEvalCase[];
}

export interface RagEvalRetrievedEvidence {
  evidenceId: string;
  score: number;
  content: string;
  source: string;
  tenantId?: string;
  corpusId?: string;
  documentId?: string;
  documentVersion?: string;
  trustLevel?: 'trusted' | 'reviewed' | 'external' | 'quarantined';
  laneId?: string;
}

export interface RagEvalCitation {
  evidenceId: string;
  startOffset: number;
  endOffset: number;
}

export interface RagEvalUsage {
  retrievalLatencyMs: number;
  generationLatencyMs: number;
  totalLatencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  tokenMeasurement: RagEvalTokenMeasurement;
  costUsd?: number;
  costMeasurement: RagEvalCostMeasurement;
  embeddingCalls: number;
  generationCalls: number;
}

export interface RagEvalTargetResult {
  answer: string;
  abstained: boolean;
  evidence: RagEvalRetrievedEvidence[];
  citations?: RagEvalCitation[];
  policyId?: string;
  laneIds?: string[];
  usage: RagEvalUsage;
  traceId?: string;
}

export interface RagEvalTargetInput {
  evalCase: RagEvalTargetCase;
  corpus: readonly RagEvalCorpusDocument[];
  topK: number;
}

export interface RagEvalTarget {
  readonly id: string;
  run(input: RagEvalTargetInput): Promise<RagEvalTargetResult>;
}

export interface RagEvalRetrievalMetrics {
  recallAtK: number | null;
  reciprocalRankAtK: number | null;
  ndcgAtK: number | null;
}

export interface RagEvalCitationMetrics {
  validity: number | null;
  precision: number | null;
  coverage: number | null;
  meanSpanIou: number | null;
}

export interface RagEvalSecurityMetrics {
  crossTenantHits: number;
  crossCorpusHits: number;
  disallowedTrustHits: number;
  forbiddenEvidenceHits: number;
  forbiddenAnswerPatternHits: number;
  disallowedPolicyHits: number;
  disallowedLaneHits: number;
}

export interface RagEvalAnswerMetrics {
  requiredFactCoverage: number | null;
  abstainCorrect: boolean;
}

export interface RagEvalCompletedCaseResult {
  caseId: string;
  status: 'completed';
  answer: string;
  abstained: boolean;
  expectedAbstain: boolean;
  evidence: RagEvalRetrievedEvidence[];
  retrieval: RagEvalRetrievalMetrics;
  citations: RagEvalCitationMetrics;
  citationDetails: RagEvalCitation[];
  security: RagEvalSecurityMetrics;
  answerMetrics: RagEvalAnswerMetrics;
  usage: RagEvalUsage;
  policyId?: string;
  laneIds?: string[];
  traceId?: string;
}

export interface RagEvalFailedCaseResult {
  caseId: string;
  status: 'failed';
  error: string;
}

export type RagEvalCaseResult = RagEvalCompletedCaseResult | RagEvalFailedCaseResult;

export interface RagEvalSummary {
  totalCases: number;
  completedCases: number;
  failedCases: number;
  errorRate: number;
  retrievalMetricCoverageRatio: number;
  answerMetricCoverageRatio: number;
  meanRecallAtK: number | null;
  meanReciprocalRankAtK: number | null;
  meanNdcgAtK: number | null;
  meanRequiredFactCoverage: number | null;
  abstainAccuracy: number | null;
  abstain: {
    unanswerableTruePositiveRate: number | null;
    answerableFalsePositiveRate: number | null;
    answerCoverage: number | null;
    selectiveAccuracy: number | null;
  };
  citation: {
    metricCoverageRatio: number;
    meanValidity: number | null;
    meanPrecision: number | null;
    meanCoverage: number | null;
    meanSpanIou: number | null;
  };
  security: RagEvalSecurityMetrics;
  latencyMs: {
    p50: number | null;
    p95: number | null;
  };
  tokens: {
    inputTotal: number | null;
    outputTotal: number | null;
    coverageRatio: number;
  };
  costUsd: {
    total: number | null;
    coverageRatio: number;
  };
  calls: {
    embeddingTotal: number;
    generationTotal: number;
  };
}

export interface RagEvalRunReport {
  schemaVersion: 'rag-eval-run/v1';
  runId: string;
  startedAt: string;
  completedAt: string;
  dataset: {
    schemaVersion: RagEvalDatasetSchemaVersion;
    id: string;
    version: string;
    sha256: string;
  };
  target: {
    id: string;
  };
  configuration: {
    topK: number;
  };
  metadata?: Record<string, unknown>;
  cases: RagEvalCaseResult[];
  summary: RagEvalSummary;
}
