import { randomUUID } from 'node:crypto';

import { createRagEvalDatasetHash, parseRagEvalDataset } from './dataset';
import {
  evaluateAnswer,
  evaluateCitations,
  evaluateRetrieval,
  evaluateSecurity,
  summarizeEvalCaseResults,
} from './metrics';
import type {
  RagEvalCaseResult,
  RagEvalAgentTrajectory,
  RagEvalDataset,
  RagEvalRunReport,
  RagEvalTarget,
  RagEvalTargetResult,
} from './types';
import { RAG_EVAL_DATASET_SCHEMA_VERSION_V2 } from './types';
import { evaluateRetrievalStages } from './retrieval-stage-metrics';
import { validateExperimentContract, type RagEvalExperiment } from './experiment-contract';
import { assessRagEvalCase, parseQualitySidecar, type QualitySidecar, type QualityContext, type SemanticJudge } from './quality-scoring';
import { canonicalJsonSha256 } from './canonical-json';
import { createHash } from 'node:crypto';
import { stableStringify } from './dataset';
import { validateEvalUsageObservation, estimateEvalGenerationCost, type EvalTokenPricing } from './usage-metering';

export interface RunRagEvalOptions {
  topK?: number;
  runId?: string;
  metadata?: Record<string, unknown>;
  clock?: () => Date;
  experiment?: RagEvalExperiment;
  assessment?: { sidecar: QualitySidecar; context?: QualityContext; judge?: SemanticJudge; signal?: AbortSignal;
    judgeIdentity?: { id: string; revision: string; rubricVersion: string } };
  usagePricing?: EvalTokenPricing;
  evaluatorImplementationSha256?: string;
  stopOnFailure?: boolean;
}

export async function runRagEval(
  datasetInput: RagEvalDataset | unknown,
  target: RagEvalTarget,
  options: RunRagEvalOptions = {}
): Promise<RagEvalRunReport> {
  const dataset = parseRagEvalDataset(datasetInput);
  const topK = options.topK ?? 5;
  assertPositiveInteger(topK, 'topK');
  if (options.evaluatorImplementationSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.evaluatorImplementationSha256)) throw new Error('[rag-eval runner] invalid evaluator implementation digest');
  if (options.usagePricing !== undefined) estimateEvalGenerationCost({ measurement: 'unavailable' }, options.usagePricing);
  const experiment = options.experiment === undefined ? undefined : validateExperimentContract(dataset, options.experiment);
  if (experiment && topK !== experiment.configuration.retrieval.topK) throw new Error('[rag-eval runner] experiment topK mismatch');
  const annotations = options.assessment === undefined ? undefined : parseQualitySidecar(options.assessment.sidecar,
    { datasetSha256: createRagEvalDatasetHash(dataset), caseIds: dataset.cases.map(item => item.id) });
  if (annotations) for (const item of dataset.cases) {
    const disposition = annotations.cases[item.id]?.expectedDisposition;
    if (disposition && ((disposition === 'answer') === item.expectedAbstain
      || item.expectedDisposition !== undefined && disposition !== item.expectedDisposition)) {
      throw new Error('[rag-eval runner] quality disposition contradicts dataset annotation: ' + item.id);
    }
  }
  const assessmentBinding = annotations === undefined ? undefined : {
    annotationsSha256: createHash('sha256').update(stableStringify(annotations)).digest('hex'), contextSha256: canonicalJsonSha256(options.assessment?.context ?? {}),
    judge: options.assessment?.judge ? options.assessment.judgeIdentity ?? { id: 'unidentified', revision: 'unknown', rubricVersion: 'unknown' } : null,
  };
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const results: RagEvalCaseResult[] = [];
  let stopped = false;

  for (const evalCase of dataset.cases) {
    if (stopped) { results.push({ caseId: evalCase.id, status: 'failed', error: '[rag-eval runner] not attempted after an earlier failed case' }); continue; }
    try {
      const targetResult = await target.run({
        evalCase: {
          query: evalCase.query,
          ...(evalCase.scope === undefined
            ? {}
            : {
                scope: {
                  tenantId: evalCase.scope.tenantId,
                  corpusId: evalCase.scope.corpusId,
                  allowedTrustLevels: [...evalCase.scope.allowedTrustLevels],
                },
              }),
        },
        corpus: dataset.corpus,
        topK,
      });
      validateTargetResult(dataset, targetResult);
      const citationDetails = targetResult.citations ?? [];
      const citationMetrics = evaluateCitations(evalCase, targetResult.evidence, citationDetails);
      // Numbered references identify a whole passage, not an observed supporting span.
      if (targetResult.observation?.citations === 'reference-only') {
        citationMetrics.precision = null; citationMetrics.coverage = null; citationMetrics.meanSpanIou = null;
      }
      const answerMetrics = evaluateAnswer(evalCase, targetResult.answer, targetResult.abstained);
      if (targetResult.observation?.disposition === 'unavailable') answerMetrics.abstainCorrect = null;
      const usageObservation = targetResult.usageObservation === undefined ? undefined : validateEvalUsageObservation(targetResult.usageObservation);
      if (usageObservation && options.usagePricing) usageObservation.costsUsd = { ...usageObservation.costsUsd,
        generation: estimateEvalGenerationCost(usageObservation.tokens, options.usagePricing) };
      results.push({
        caseId: evalCase.id,
        status: 'completed',
        answer: targetResult.answer,
        abstained: targetResult.abstained,
        expectedAbstain: evalCase.expectedAbstain,
        evidence: targetResult.evidence,
        retrieval: evaluateRetrieval(
          evalCase.goldEvidence,
          targetResult.evidence.map(evidence => evidence.evidenceId),
          topK
        ),
        citations: citationMetrics,
        citationDetails,
        security: evaluateSecurity(evalCase, targetResult),
        answerMetrics,
        ...(targetResult.retrievalStages === undefined ? {} : {
          stageEvidenceIds: targetResult.retrievalStages,
          retrievalStages: evaluateRetrievalStages(evalCase.goldEvidence, targetResult.retrievalStages, topK, evalCase.requiredEvidenceGroups, targetResult.evidence),
        }),
        ...(evalCase.expectedDisposition === undefined ? {} : { dispositionCorrect: targetResult.disposition === undefined
          ? null : evalCase.expectedDisposition === targetResult.disposition }),
        ...(targetResult.observation === undefined ? {} : { observation: targetResult.observation }),
        ...(usageObservation === undefined ? {} : { usageObservation }),
        ...(annotations === undefined ? {} : { quality: await assessRagEvalCase(evalCase, targetResult, annotations.cases[evalCase.id], options.assessment) }),
        usage: targetResult.usage,
        ...(targetResult.trajectory === undefined ? {} : { trajectory: targetResult.trajectory }),
        ...(targetResult.policyId === undefined
          ? {}
          : { policyId: targetResult.policyId }),
        ...(targetResult.laneIds === undefined
          ? {}
          : { laneIds: [...targetResult.laneIds] }),
        ...(targetResult.traceId === undefined ? {} : { traceId: targetResult.traceId }),
      });
    } catch (error) {
      if (options.stopOnFailure) stopped = true;
      results.push({
        caseId: evalCase.id,
        status: 'failed',
        error: formatError(error),
        ...(error instanceof Error && 'trajectory' in error && error.trajectory
          ? { trajectory: error.trajectory as RagEvalAgentTrajectory } : {}),
      });
    }
  }

  return {
    schemaVersion: 'rag-eval-run/v1',
    runId: options.runId ?? `rag-eval-${Date.now()}-${randomUUID().slice(0, 8)}`,
    startedAt,
    completedAt: clock().toISOString(),
    dataset: {
      schemaVersion: dataset.schemaVersion,
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      sha256: createRagEvalDatasetHash(dataset),
    },
    target: {
      id: target.id,
    },
    configuration: {
      topK,
      ...(experiment === undefined ? {} : { experiment }),
      ...(assessmentBinding === undefined ? {} : { assessment: assessmentBinding }),
      ...(options.evaluatorImplementationSha256 === undefined ? {} : { evaluatorImplementationSha256: options.evaluatorImplementationSha256 }),
      ...(options.usagePricing === undefined ? {} : { usagePricing: options.usagePricing }),
    },
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    cases: results,
    summary: summarizeEvalCaseResults(results),
  };
}

function validateTargetResult(
  dataset: RagEvalDataset,
  result: RagEvalTargetResult
): void {
  if (typeof result.answer !== 'string') {
    throw new Error('[rag-eval runner] target answer must be a string');
  }
  if (typeof result.abstained !== 'boolean') {
    throw new Error('[rag-eval runner] target abstained must be a boolean');
  }
  if (!Array.isArray(result.evidence)) {
    throw new Error('[rag-eval runner] target evidence must be an array');
  }
  const corpusByEvidenceId = new Map(
    dataset.corpus.map(item => [item.evidenceId, item])
  );
  const seenEvidence = new Set<string>();
  const isV2 = dataset.schemaVersion === RAG_EVAL_DATASET_SCHEMA_VERSION_V2;
  if (result.retrievalStages !== undefined) {
    for (const ids of Object.values(result.retrievalStages)) {
      if (!Array.isArray(ids) || ids.some(id => !corpusByEvidenceId.has(id)) || new Set(ids).size !== ids.length) {
        throw new Error('[rag-eval runner] stage snapshot contains unknown or duplicate evidence');
      }
    }
  }
  for (const [index, evidence] of result.evidence.entries()) {
    assertNonEmptyString(evidence.evidenceId, `evidence[${index}].evidenceId`);
    const canonicalEvidence = corpusByEvidenceId.get(evidence.evidenceId);
    if (!canonicalEvidence) {
      throw new Error(
        `[rag-eval runner] evidence[${index}] references unknown corpus evidence ${evidence.evidenceId}`
      );
    }
    if (seenEvidence.has(evidence.evidenceId)) {
      throw new Error(
        `[rag-eval runner] evidence[${index}] duplicates ${evidence.evidenceId}`
      );
    }
    seenEvidence.add(evidence.evidenceId);
    assertFiniteNumber(evidence.score, `evidence[${index}].score`);
    assertNonEmptyString(evidence.content, `evidence[${index}].content`);
    assertNonEmptyString(evidence.source, `evidence[${index}].source`);
    if (isV2) {
      assertNonEmptyString(evidence.tenantId, `evidence[${index}].tenantId`);
      assertNonEmptyString(evidence.corpusId, `evidence[${index}].corpusId`);
      assertNonEmptyString(evidence.documentId, `evidence[${index}].documentId`);
      assertNonEmptyString(
        evidence.documentVersion,
        `evidence[${index}].documentVersion`
      );
      assertNonEmptyString(evidence.laneId, `evidence[${index}].laneId`);
      if (
        evidence.trustLevel !== 'trusted' &&
        evidence.trustLevel !== 'reviewed' &&
        evidence.trustLevel !== 'external' &&
        evidence.trustLevel !== 'quarantined'
      ) {
        throw new Error(
          `[rag-eval runner] evidence[${index}].trustLevel is invalid`
        );
      }
      assertCanonicalEvidenceMatch(evidence, canonicalEvidence, index);
    }
  }

  if (isV2 && !Array.isArray(result.citations)) {
    throw new Error('[rag-eval runner] V2 target citations must be an array');
  }
  for (const [index, citation] of (result.citations ?? []).entries()) {
    assertNonEmptyString(citation.evidenceId, `citations[${index}].evidenceId`);
    assertNonNegativeInteger(
      citation.startOffset,
      `citations[${index}].startOffset`
    );
    assertNonNegativeInteger(
      citation.endOffset,
      `citations[${index}].endOffset`
    );
    if (citation.endOffset <= citation.startOffset) {
      throw new Error(
        `[rag-eval runner] citations[${index}] endOffset must exceed startOffset`
      );
    }
  }
  if (isV2) {
    assertNonEmptyString(result.policyId, 'policyId');
    if (!Array.isArray(result.laneIds) || result.laneIds.length === 0) {
      throw new Error('[rag-eval runner] V2 target laneIds must be a non-empty array');
    }
    const seenLanes = new Set<string>();
    for (const [index, laneId] of result.laneIds.entries()) {
      assertNonEmptyString(laneId, `laneIds[${index}]`);
      if (seenLanes.has(laneId)) {
        throw new Error(`[rag-eval runner] laneIds[${index}] is duplicated`);
      }
      seenLanes.add(laneId);
    }
  }

  const usage = result.usage;
  if (!usage || typeof usage !== 'object') {
    throw new Error('[rag-eval runner] target usage must be an object');
  }
  for (const [label, value] of [
    ['retrievalLatencyMs', usage.retrievalLatencyMs],
    ['generationLatencyMs', usage.generationLatencyMs],
    ['totalLatencyMs', usage.totalLatencyMs],
    ['embeddingCalls', usage.embeddingCalls],
    ['generationCalls', usage.generationCalls],
  ] as const) {
    assertNonNegativeFinite(value, 'usage.' + label);
  }
  for (const [label, value] of [
    ['inputTokens', usage.inputTokens],
    ['outputTokens', usage.outputTokens],
    ['partialInputTokens', usage.partialInputTokens],
    ['partialOutputTokens', usage.partialOutputTokens],
    ['costUsd', usage.costUsd],
  ] as const) {
    if (value !== undefined) {
      assertNonNegativeFinite(value, 'usage.' + label);
    }
  }
}

function assertCanonicalEvidenceMatch(
  evidence: RagEvalTargetResult['evidence'][number],
  canonical: RagEvalDataset['corpus'][number],
  index: number
): void {
  for (const field of [
    'content',
    'source',
    'tenantId',
    'corpusId',
    'documentId',
    'documentVersion',
    'trustLevel',
  ] as const) {
    if (field === 'content' && evidence.servedSpan !== undefined) {
      const span = evidence.servedSpan;
      if (!Number.isInteger(span.startOffset) || !Number.isInteger(span.endOffset) || span.startOffset !== 0
        || span.endOffset <= span.startOffset || span.endOffset > canonical.content.length
        || canonical.content.slice(span.startOffset, span.endOffset) !== evidence.content) {
        throw new Error('[rag-eval runner] served evidence span/content does not match canonical corpus');
      }
      continue;
    }
    if (evidence[field] !== canonical[field]) {
      throw new Error(
        `[rag-eval runner] evidence[${index}].${field} does not match canonical corpus evidence ${evidence.evidenceId}`
      );
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[rag-eval runner] ${label} must be a positive integer`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('[rag-eval runner] ' + label + ' must be a non-empty string');
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('[rag-eval runner] ' + label + ' must be finite');
  }
}

function assertNonNegativeFinite(value: unknown, label: string): asserts value is number {
  assertFiniteNumber(value, label);
  if (value < 0) {
    throw new Error('[rag-eval runner] ' + label + ' must be non-negative');
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      '[rag-eval runner] ' + label + ' must be a non-negative integer'
    );
  }
}
