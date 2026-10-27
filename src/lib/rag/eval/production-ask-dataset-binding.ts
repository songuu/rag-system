import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createRagEvalDatasetHash, parseRagEvalDataset } from './dataset';
import { createReferenceProductionAskTargetPlanner } from './production-ask-target';
import type { ReferenceProductionAskRequestPlan } from './production-ask-target';
import { runRagEval } from './runner';
import type { RagEvalAnswerMetrics, RagEvalCaseResult, RagEvalCitationMetrics, RagEvalRetrievalMetrics,
  RagEvalSecurityMetrics, RagEvalSummary, RagEvalTargetResult, RagEvalUsage } from './types';

type Fields = Record<string, unknown>;
type BindingErrorCode = 'invalid-config' | 'invalid-request';

// A separate reference resource profile, not approved production thresholds.
// Raw datasets must not inherit the small canonical contract-object budget.
const RESOURCE_BUDGET = Object.freeze({
  maxJsonBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 200_000,
});

interface ReferenceAssurance {
  readonly classification: 'confidential';
  readonly rawDatasetVerified: true;
  readonly productionAuthorized: false;
  readonly stageAcceptanceComplete: false;
  readonly executionAuthorized: false;
  readonly registryAuthenticated: false;
  readonly networkEnforced: false;
}

export interface ReferenceProductionAskDatasetBindingProof extends ReferenceAssurance {
  readonly schemaVersion: 'kg-production-ask-dataset-binding/v1';
  readonly validationLevel: 'local-reference-dataset-correspondence';
  readonly datasetFrozen: true;
  readonly configurationHash: string;
  readonly rawJsonSha256: string;
  readonly binding: ReferenceProductionAskRequestPlan['binding'];
  readonly dataset: {
    readonly id: string;
    readonly version: string;
    readonly schemaVersion: 'rag-eval-dataset/v2';
    readonly normalizedSha256: string;
    readonly rosterSha256: string;
    readonly caseCount: number;
    readonly corpusCount: number;
  };
  readonly resourceBudget: typeof RESOURCE_BUDGET;
  readonly bindingHash: string;
}

export interface ReferenceProductionDatasetBoundAskPlan extends ReferenceAssurance {
  readonly schemaVersion: 'kg-production-dataset-bound-ask-plan/v1';
  readonly validationLevel: 'local-reference-dataset-bound-ask-plan';
  readonly bindingProof: ReferenceProductionAskDatasetBindingProof;
  readonly requestPlan: ReferenceProductionAskRequestPlan;
  readonly caseIndex: number;
  readonly planHash: string;
}

/** Do not expose JSON/parser errors containing rejected query, gold or IDs. */
export class ProductionAskDatasetBindingError extends Error {
  readonly code: BindingErrorCode;
  readonly phase: 'configuration' | 'request';
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;

  constructor(code: BindingErrorCode = 'invalid-config') {
    const safeCode = code === 'invalid-request' ? 'invalid-request' : 'invalid-config';
    super('[production Ask dataset binding] ' + safeCode);
    this.name = 'ProductionAskDatasetBindingError';
    this.code = safeCode;
    this.phase = safeCode === 'invalid-config' ? 'configuration' : 'request';
    Object.freeze(this);
  }
}

/** Pure complete-dataset correspondence, not a runner or a network permit.
 * Full gold, provenance, metadata and cross-scope canaries remain private and
 * enter the existing RagEval hash without filtering, truncation or re-keying.
 * The unchanged nested request plan still only claims manifest membership;
 * this wrapper records the additional actual-dataset check explicitly. */
export function createReferenceProductionAskDatasetBinding(
  inputOptions: unknown,
  actualDatasetJson: unknown,
  ...extraInputs: unknown[]
) {
  return prepareDatasetBinding(inputOptions, actualDatasetJson, extraInputs).binding;
}

function prepareDatasetBinding(
  inputOptions: unknown,
  actualDatasetJson: unknown,
  extraInputs: unknown[]
) {
  try {
    if (extraInputs.length !== 0) throw new Error();
    const options = record(freezeDeep(JSON.parse(canonicalJson(inputOptions))));
    const planner = createReferenceProductionAskTargetPlanner(options);
    // Reject carriers before conversion: no getters, toJSON, Proxy or then.
    const parsedJson = parseReferenceJson(actualDatasetJson);
    const dataset = freezeDeep(parseRagEvalDataset(parsedJson));
    const base = record(record(options.manifest).base);
    const expectedDataset = record(base.dataset);
    const scope = record(base.scope);
    if (dataset.schemaVersion !== 'rag-eval-dataset/v2'
      || dataset.schemaVersion !== expectedDataset.schemaVersion
      || dataset.datasetId !== expectedDataset.id
      || dataset.datasetVersion !== expectedDataset.version) throw new Error();
    const normalizedSha256 = createRagEvalDatasetHash(dataset);
    if (normalizedSha256 !== expectedDataset.normalizedSha256) throw new Error();
    const roster = dataset.cases.map(value => value.id);
    const expectedRoster = expectedDataset.roster as readonly string[];
    if (roster.length !== expectedRoster.length
      || roster.some((value, index) => value !== expectedRoster[index])) throw new Error();
    const rosterSha256 = canonicalJsonSha256(roster);
    if (rosterSha256 !== expectedDataset.rosterSha256) throw new Error();
    const trustLevels = scope.allowedTrustLevels as readonly string[];
    for (const value of dataset.cases) {
      const caseScope = value.scope;
      if (!caseScope || caseScope.tenantId !== scope.tenantId || caseScope.corpusId !== scope.corpusId
        || caseScope.allowedTrustLevels.length !== trustLevels.length
        || caseScope.allowedTrustLevels.some(level => !trustLevels.includes(level))) throw new Error();
    }
    // Both supported stages guarantee at least one trial; this is pure planning.
    const initialPlan = planner.planRequest({ caseId: roster[0], rolloutMode: 'off', phase: 'trial', ordinal: 0 });
    const core: Omit<ReferenceProductionAskDatasetBindingProof, 'bindingHash'> = {
      schemaVersion: 'kg-production-ask-dataset-binding/v1',
      validationLevel: 'local-reference-dataset-correspondence',
      classification: 'confidential',
      rawDatasetVerified: true,
      productionAuthorized: false,
      stageAcceptanceComplete: false,
      executionAuthorized: false,
      registryAuthenticated: false,
      networkEnforced: false,
      datasetFrozen: true,
      configurationHash: initialPlan.configurationHash,
      rawJsonSha256: createHash('sha256').update(actualDatasetJson as string, 'utf8').digest('hex'),
      binding: initialPlan.binding,
      dataset: {
        id: dataset.datasetId,
        version: dataset.datasetVersion,
        schemaVersion: dataset.schemaVersion,
        normalizedSha256,
        rosterSha256,
        caseCount: dataset.cases.length,
        corpusCount: dataset.corpus.length,
      },
      resourceBudget: RESOURCE_BUDGET,
    };
    const bindingProof: ReferenceProductionAskDatasetBindingProof = freezeDeep({
      ...core, bindingHash: canonicalJsonSha256(core),
    });
    const binding = Object.freeze({
      executionProfile: 'local-reference' as const,
      productionCapable: false as const,
      bindingProof,
      planRequest(input: unknown, ...extraRequests: unknown[]): ReferenceProductionDatasetBoundAskPlan {
        try {
          if (extraRequests.length !== 0) throw new Error();
          const requestPlan = planner.planRequest(input);
          const caseIndex = dataset.cases.findIndex(value => value.id === requestPlan.requestIdentity.caseId);
          if (caseIndex < 0) throw new Error();
          const planCore: Omit<ReferenceProductionDatasetBoundAskPlan, 'planHash'> = {
            schemaVersion: 'kg-production-dataset-bound-ask-plan/v1',
            validationLevel: 'local-reference-dataset-bound-ask-plan',
            classification: 'confidential',
            rawDatasetVerified: true,
            productionAuthorized: false,
            stageAcceptanceComplete: false,
            executionAuthorized: false,
            registryAuthenticated: false,
            networkEnforced: false,
            bindingProof,
            requestPlan,
            caseIndex,
          };
          return freezeDeep({ ...planCore, planHash: canonicalJsonSha256(planCore) });
        } catch {
          throw new ProductionAskDatasetBindingError('invalid-request');
        }
      },
    });
    return Object.freeze({ options, dataset, binding });
  } catch {
    throw new ProductionAskDatasetBindingError('invalid-config');
  }
}

type EvaluationErrorCode = 'invalid-config' | 'invalid-results' | 'evaluation-failed';

export class ProductionAskReferenceEvaluationError extends Error {
  readonly code: EvaluationErrorCode;
  readonly phase: 'configuration' | 'request' | 'evaluation';
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;

  constructor(code: EvaluationErrorCode) {
    const safeCode = code === 'invalid-results' || code === 'evaluation-failed' ? code : 'invalid-config';
    super('[production Ask reference evaluation] ' + safeCode);
    this.name = 'ProductionAskReferenceEvaluationError';
    this.code = safeCode;
    this.phase = safeCode === 'invalid-config' ? 'configuration'
      : safeCode === 'invalid-results' ? 'request' : 'evaluation';
    Object.freeze(this);
  }
}

export interface ReferenceProductionAskEvaluationProof extends ReferenceAssurance {
  readonly schemaVersion: 'kg-reference-ask-evaluation/v1';
  readonly validationLevel: 'local-reference-oracle-consumption';
  readonly runnerConsumed: true;
  readonly resultSource: 'offline-reference';
  readonly bindingHash: string;
  readonly datasetSha256: string;
  readonly resultsSha256: string;
  readonly topK: number;
  readonly arm: {
    readonly rolloutMode: ReferenceProductionAskRequestPlan['requestIdentity']['rolloutMode'];
    readonly phase: ReferenceProductionAskRequestPlan['requestIdentity']['phase'];
    readonly ordinal: number;
  };
  readonly requestPlanSetSha256: string;
  readonly caseOutcomeSha256: string;
  readonly summary: Readonly<RagEvalSummary>;
  readonly proofHash: string;
}

export type ReferenceAskCaseMeasurement = {
  readonly caseIndex: number; readonly status: 'failed'; readonly failureCode: 'runner-case-failed';
} | {
  readonly caseIndex: number; readonly status: 'completed';
  readonly expectedAbstain: boolean; readonly abstained: boolean;
  readonly retrieval: Readonly<RagEvalRetrievalMetrics>; readonly citations: Readonly<RagEvalCitationMetrics>;
  readonly security: Readonly<RagEvalSecurityMetrics>; readonly answerMetrics: Readonly<RagEvalAnswerMetrics>;
  readonly usage: Readonly<Omit<RagEvalUsage, 'inputTokens' | 'outputTokens' | 'partialInputTokens' | 'partialOutputTokens' | 'costUsd'> & {
    readonly inputTokens: number | null; readonly outputTokens: number | null;
    readonly partialInputTokens: number | null; readonly partialOutputTokens: number | null; readonly costUsd: number | null;
  }>;
};
export interface ReferenceProductionAskMeasurementsProof extends ReferenceAssurance {
  readonly schemaVersion: 'kg-reference-ask-measurements/v1';
  readonly validationLevel: 'local-reference-complete-oracle-population';
  readonly resultSource: 'offline-reference'; readonly machineGateComputed: false;
  readonly evaluation: ReferenceProductionAskEvaluationProof;
  readonly caseMeasurements: readonly ReferenceAskCaseMeasurement[];
  readonly measurementsRootSha256: string; readonly proofHash: string;
}

/** Consume full frozen labels with the original runner and its private result
 * validator. Offline result bytes are NOT evidence of an executed Ask query,
 * provider authenticity, production permission, or stage acceptance. */
export function createReferenceProductionAskEvaluator(
  inputOptions: unknown,
  actualDatasetJson: unknown,
  ...extraInputs: unknown[]
) {
  const engine = createReferenceEvaluationEngine(inputOptions, actualDatasetJson, extraInputs);
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    bindingProof: engine.bindingProof,
    async evaluateReferenceResults(input: unknown, ...extras: unknown[]): Promise<ReferenceProductionAskEvaluationProof> {
      return (await engine.evaluateActualResults(input, ...extras)).evaluation;
    } });
}

/** Full numerical population from the SAME private original scoring run.
 * The legacy proof/hash remains unchanged. No raw answer, ID, labels or error
 * crosses this boundary, and offline observations grant no stage authority. */
export function createReferenceProductionAskMeasurementEvaluator(
  inputOptions: unknown, actualDatasetJson: unknown, ...extraInputs: unknown[]
) {
  const engine = createReferenceEvaluationEngine(inputOptions, actualDatasetJson, extraInputs);
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    bindingProof: engine.bindingProof,
    async evaluateReferenceMeasurements(input: unknown, ...extras: unknown[]): Promise<ReferenceProductionAskMeasurementsProof> {
      const { evaluation, cases } = await engine.evaluateActualResults(input, ...extras);
      try {
        const caseMeasurements = cases.map(projectCaseMeasurement);
        const measurementsRootSha256 = orderedDigest('kg-reference-ask-case-measurements/v1', evaluation.bindingHash, caseMeasurements.map(canonicalJsonSha256));
        const core: Omit<ReferenceProductionAskMeasurementsProof, 'proofHash'> = {
          schemaVersion: 'kg-reference-ask-measurements/v1', classification: 'confidential',
          validationLevel: 'local-reference-complete-oracle-population', resultSource: 'offline-reference',
          rawDatasetVerified: true, productionAuthorized: false, stageAcceptanceComplete: false, executionAuthorized: false,
          registryAuthenticated: false, networkEnforced: false, machineGateComputed: false,
          evaluation, caseMeasurements, measurementsRootSha256 };
        assertJsonResourceBudget(core);
        if (Buffer.byteLength(JSON.stringify({ ...core, proofHash: '0'.repeat(64) })) > RESOURCE_BUDGET.maxJsonBytes) throw new Error();
        // Hash each bounded record before folding the entire ordered population.
        // Never feed a >256KiB full roster into the control-object canonicalizer.
        return freezeDeep({ ...core, proofHash: canonicalJsonSha256({ ...core,
          evaluation: evaluation.proofHash, caseMeasurements: measurementsRootSha256 }) });
      } catch { throw new ProductionAskReferenceEvaluationError('evaluation-failed'); }
    } });
}

function createReferenceEvaluationEngine(inputOptions: unknown, actualDatasetJson: unknown, extraInputs: unknown[]) {
  try {
    const { options, dataset, binding } = prepareDatasetBinding(inputOptions, actualDatasetJson, extraInputs);
    const topK = record(record(record(options.manifest).base).parameters).topK as number;
    return Object.freeze({
      executionProfile: 'local-reference' as const,
      productionCapable: false as const,
      bindingProof: binding.bindingProof,
      async evaluateActualResults(
        actualResultsJson: unknown, ...extraResults: unknown[]
      ): Promise<{ readonly evaluation: ReferenceProductionAskEvaluationProof; readonly cases: readonly RagEvalCaseResult[] }> {
        let plans: ReferenceProductionDatasetBoundAskPlan[];
        let targetResults: RagEvalTargetResult[];
        try {
          if (extraResults.length !== 0) throw new Error();
          const input = record(parseReferenceJson(actualResultsJson));
          exactFields(input, ['schemaVersion', 'bindingHash', 'entries']);
          if (input.schemaVersion !== 'kg-reference-ask-results/v1'
            || input.bindingHash !== binding.bindingProof.bindingHash
            || !Array.isArray(input.entries) || input.entries.length !== dataset.cases.length) throw new Error();
          plans = [];
          targetResults = [];
          for (const [index, value] of input.entries.entries()) {
            const entry = record(value);
            exactFields(entry, ['request', 'result']);
            const plan = binding.planRequest(entry.request);
            if (plan.caseIndex !== index) throw new Error();
            const identity = plan.requestPlan.requestIdentity;
            const first = plans[0]?.requestPlan.requestIdentity;
            if (first && (identity.rolloutMode !== first.rolloutMode
              || identity.phase !== first.phase || identity.ordinal !== first.ordinal)) throw new Error();
            assertResultSurface(entry.result);
            plans.push(plan);
            targetResults.push(freezeDeep(entry.result) as RagEvalTargetResult);
          }
        } catch {
          throw new ProductionAskReferenceEvaluationError('invalid-results');
        }
        try {
          // Each invocation owns its cursor: concurrent arms cannot interleave.
          // No caller callback, query export, transport or credentials exist.
          let nextCase = 0;
          const report = await runRagEval(dataset, {
            id: 'offline-reference',
            async run() { return targetResults[nextCase++]; },
          }, { topK, runId: binding.bindingProof.binding.runNonce });
          if (nextCase !== dataset.cases.length || report.cases.length !== dataset.cases.length
            || report.dataset.sha256 !== binding.bindingProof.dataset.normalizedSha256
            || report.configuration.topK !== topK
            || report.cases.some((value, index) => value.caseId !== dataset.cases[index].id)) throw new Error();
          const identity = plans[0].requestPlan.requestIdentity;
          const outcomeHashes = report.cases.map(value => canonicalJsonSha256(value.status === 'completed'
            ? { caseId: value.caseId, status: value.status, retrieval: value.retrieval,
              citations: value.citations, security: value.security, answerMetrics: value.answerMetrics }
            : { caseId: value.caseId, status: 'failed', failureCode: 'runner-case-failed' }));
          const core: Omit<ReferenceProductionAskEvaluationProof, 'proofHash'> = {
            schemaVersion: 'kg-reference-ask-evaluation/v1',
            validationLevel: 'local-reference-oracle-consumption',
            classification: 'confidential',
            rawDatasetVerified: true,
            productionAuthorized: false,
            stageAcceptanceComplete: false,
            executionAuthorized: false,
            registryAuthenticated: false,
            networkEnforced: false,
            runnerConsumed: true,
            resultSource: 'offline-reference',
            bindingHash: binding.bindingProof.bindingHash,
            datasetSha256: report.dataset.sha256,
            resultsSha256: createHash('sha256').update(actualResultsJson as string, 'utf8').digest('hex'),
            topK,
            arm: { rolloutMode: identity.rolloutMode, phase: identity.phase, ordinal: identity.ordinal },
            requestPlanSetSha256: orderedDigest('kg-reference-ask-request-plan-set/v1',
              binding.bindingProof.bindingHash, plans.map(value => value.planHash)),
            caseOutcomeSha256: orderedDigest('kg-reference-ask-case-outcomes/v1',
              binding.bindingProof.bindingHash, outcomeHashes),
            summary: projectSummary(report.summary),
          };
          const evaluation = freezeDeep({ ...core, proofHash: canonicalJsonSha256(core) });
          // Raw scored cases are visible only to our private public projections;
          // neither factory exposes this engine or accepts a replacement report.
          return { evaluation, cases: report.cases };
        } catch {
          // The runner's error strings can contain private evidence IDs/content.
          throw new ProductionAskReferenceEvaluationError('evaluation-failed');
        }
      },
    });
  } catch {
    throw new ProductionAskReferenceEvaluationError('invalid-config');
  }
}

function projectCaseMeasurement(value: RagEvalCaseResult, caseIndex: number): ReferenceAskCaseMeasurement {
  if (value.status === 'failed') return { caseIndex, status: 'failed', failureCode: 'runner-case-failed' };
  // The legacy runner validates usage numbers, not these enum fields. Keep its
  // accepted input domain intact, but never export untrusted JSON as an enum.
  if (!['provider', 'partial', 'estimated', 'unavailable'].includes(value.usage.tokenMeasurement)
    || !['provider', 'configured-estimate', 'unavailable'].includes(value.usage.costMeasurement)) throw new Error();
  return { caseIndex, status: 'completed', expectedAbstain: value.expectedAbstain, abstained: value.abstained,
    retrieval: numericProjection(value.retrieval, ['recallAtK', 'reciprocalRankAtK', 'ndcgAtK']),
    citations: numericProjection(value.citations, ['validity', 'precision', 'coverage', 'meanSpanIou']),
    security: numericProjection(value.security, ['crossTenantHits', 'crossCorpusHits', 'disallowedTrustHits',
      'forbiddenEvidenceHits', 'forbiddenAnswerPatternHits', 'disallowedPolicyHits', 'disallowedLaneHits']),
    answerMetrics: { ...numericProjection({ requiredFactCoverage: value.answerMetrics.requiredFactCoverage }, ['requiredFactCoverage']),
      abstainCorrect: value.answerMetrics.abstainCorrect },
    usage: { ...numericProjection({ retrievalLatencyMs: value.usage.retrievalLatencyMs, generationLatencyMs: value.usage.generationLatencyMs,
      totalLatencyMs: value.usage.totalLatencyMs, embeddingCalls: value.usage.embeddingCalls, generationCalls: value.usage.generationCalls,
      inputTokens: value.usage.inputTokens ?? null, outputTokens: value.usage.outputTokens ?? null,
      partialInputTokens: value.usage.partialInputTokens ?? null, partialOutputTokens: value.usage.partialOutputTokens ?? null, costUsd: value.usage.costUsd ?? null },
    ['retrievalLatencyMs', 'generationLatencyMs', 'totalLatencyMs', 'embeddingCalls', 'generationCalls', 'inputTokens', 'outputTokens', 'partialInputTokens', 'partialOutputTokens', 'costUsd']),
    tokenMeasurement: value.usage.tokenMeasurement, costMeasurement: value.usage.costMeasurement } };
}

function parseReferenceJson(input: unknown): unknown {
  if (typeof input !== 'string' || input.length > RESOURCE_BUDGET.maxJsonBytes
    || Buffer.byteLength(input, 'utf8') > RESOURCE_BUDGET.maxJsonBytes) throw new Error();
  const parsed: unknown = JSON.parse(input);
  assertJsonResourceBudget(parsed);
  return parsed;
}

function exactFields(value: Fields, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error();
}

/** JSON-derived, known target fields only. Semantic validation remains owned
 * by runRagEval: invalid provenance must become its original failed-case path. */
function assertResultSurface(input: unknown): void {
  const result = record(input);
  exactFields(result, ['answer', 'abstained', 'evidence', 'usage'],
    ['citations', 'policyId', 'laneIds', 'traceId', 'trajectory']);
  if (Array.isArray(result.evidence)) for (const value of result.evidence) {
    exactFields(record(value), ['evidenceId', 'score', 'content', 'source'],
      ['tenantId', 'corpusId', 'documentId', 'documentVersion', 'trustLevel', 'laneId']);
  }
  if (Array.isArray(result.citations)) for (const value of result.citations) {
    exactFields(record(value), ['evidenceId', 'startOffset', 'endOffset']);
  }
  const usage = record(result.usage);
  exactFields(usage, ['retrievalLatencyMs', 'generationLatencyMs', 'totalLatencyMs',
    'tokenMeasurement', 'costMeasurement', 'embeddingCalls', 'generationCalls'],
  ['inputTokens', 'outputTokens', 'partialInputTokens', 'partialOutputTokens', 'costUsd']);
  if (Object.hasOwn(result, 'trajectory')) {
    const trajectory = record(result.trajectory);
    exactFields(trajectory, [], ['mode', 'decisionMode', 'modelCallCount', 'modelResponseCount',
      'modelCallMeasurement', 'providerRetryMeasurement', 'toolCallCount', 'retrievalCallCount',
      'rerankCallCount', 'searchCallCount', 'searchStopReason', 'contextTokenEstimate',
      'deliveredEvidenceCount', 'citationValidation', 'abstainDecision', 'budget', 'budgetViolations']);
    if (Object.hasOwn(trajectory, 'budget')) exactFields(record(trajectory.budget),
      ['maxDurationMs', 'maxContextTokens', 'maxEvidence', 'maxSearches']);
  }
}

/** Hash per-case small projections before folding them. The full roster is
 * never truncated to the small canonical contract-object byte limit. */
function orderedDigest(domain: string, bindingHash: string, hashes: readonly string[]): string {
  const digest = createHash('sha256').update(domain).update('\0').update(bindingHash)
    .update('\0').update(String(hashes.length)).update('\0');
  for (const hash of hashes) digest.update(hash);
  return digest.digest('hex');
}

function numericProjection<T extends object>(source: T, keys: readonly (keyof T)[]): T {
  const output = {} as T;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error();
    output[key] = value;
  }
  return output;
}

function projectSummary(summary: RagEvalSummary): RagEvalSummary {
  return {
    ...numericProjection(summary, ['totalCases', 'completedCases', 'failedCases', 'errorRate',
      'retrievalMetricCoverageRatio', 'answerMetricCoverageRatio', 'meanRecallAtK',
      'meanReciprocalRankAtK', 'meanNdcgAtK', 'meanRequiredFactCoverage', 'abstainAccuracy']),
    abstain: numericProjection(summary.abstain, ['unanswerableTruePositiveRate',
      'answerableFalsePositiveRate', 'answerCoverage', 'selectiveAccuracy']),
    citation: numericProjection(summary.citation, ['metricCoverageRatio',
      'meanValidity', 'meanPrecision', 'meanCoverage', 'meanSpanIou']),
    security: numericProjection(summary.security, ['crossTenantHits', 'crossCorpusHits',
      'disallowedTrustHits', 'forbiddenEvidenceHits', 'forbiddenAnswerPatternHits',
      'disallowedPolicyHits', 'disallowedLaneHits']),
    latencyMs: numericProjection(summary.latencyMs, ['p50', 'p95']),
    tokens: numericProjection(summary.tokens, ['inputTotal', 'outputTotal', 'coverageRatio']),
    costUsd: numericProjection(summary.costUsd, ['total', 'coverageRatio']),
    calls: numericProjection(summary.calls, ['embeddingTotal', 'generationTotal']),
  };
}

function record(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Fields;
}

/** Only visit JSON.parse-derived data. Bound recursion before the old parser
 * and hash run, including unknown fields that normalization later projects out. */
function assertJsonResourceBudget(input: unknown): void {
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > RESOURCE_BUDGET.maxNodes || depth > RESOURCE_BUDGET.maxDepth) throw new Error();
    // JSON exponent overflow otherwise hashes as null through JSON.stringify.
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  }
  visit(input, 0);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
