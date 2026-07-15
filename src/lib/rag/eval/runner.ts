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
  RagEvalDataset,
  RagEvalRunReport,
  RagEvalTarget,
  RagEvalTargetResult,
} from './types';
import { RAG_EVAL_DATASET_SCHEMA_VERSION_V2 } from './types';

export interface RunRagEvalOptions {
  topK?: number;
  runId?: string;
  metadata?: Record<string, unknown>;
  clock?: () => Date;
}

export async function runRagEval(
  datasetInput: RagEvalDataset | unknown,
  target: RagEvalTarget,
  options: RunRagEvalOptions = {}
): Promise<RagEvalRunReport> {
  const dataset = parseRagEvalDataset(datasetInput);
  const topK = options.topK ?? 5;
  assertPositiveInteger(topK, 'topK');
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const results: RagEvalCaseResult[] = [];

  for (const evalCase of dataset.cases) {
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
        citations: evaluateCitations(
          evalCase,
          targetResult.evidence,
          citationDetails
        ),
        citationDetails,
        security: evaluateSecurity(evalCase, targetResult),
        answerMetrics: evaluateAnswer(
          evalCase,
          targetResult.answer,
          targetResult.abstained
        ),
        usage: targetResult.usage,
        ...(targetResult.policyId === undefined
          ? {}
          : { policyId: targetResult.policyId }),
        ...(targetResult.laneIds === undefined
          ? {}
          : { laneIds: [...targetResult.laneIds] }),
        ...(targetResult.traceId === undefined ? {} : { traceId: targetResult.traceId }),
      });
    } catch (error) {
      results.push({
        caseId: evalCase.id,
        status: 'failed',
        error: formatError(error),
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
