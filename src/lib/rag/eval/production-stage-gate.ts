import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import type { ReferenceAskCaseMeasurement } from './production-ask-dataset-binding';
import { isReferenceAskProducerRunProof } from './production-ask-producer';
import { HARD_GATE_LIMITS, validateManifestExecutionBinding } from './production-gate-manifest';
import { summarizeEvalCaseResults } from './metrics';
import type { RagEvalCaseResult, RagEvalSummary, RagEvalUsage } from './types';

type Fields = Record<string, unknown>;
type Phase = 'warmup' | 'trial';
type Mode = 'off' | 'shadow' | 'active';
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
const CODES = ['invalid-config', 'invalid-request', 'invalid-proof', 'incomplete-population', 'capacity-exhausted', 'halted', 'already-completed'] as const;
type Code = typeof CODES[number];
export class ProductionStageQualityError extends Error {
  readonly code: Code; readonly productionAccepted = false; readonly machineGateComputed = false; readonly automaticRetryAllowed = false;
  constructor(code: Code) { const safe = CODES.includes(code) ? code : 'invalid-proof'; super('[reference stage quality] ' + safe);
    this.name = 'ProductionStageQualityError'; this.code = safe; Object.freeze(this); }
}
export interface ReferenceStageMetricCheck {
  readonly metric: string; readonly direction: 'min' | 'max'; readonly limit: number; readonly actual: number | null;
  readonly status: 'passed' | 'failed' | 'unavailable' | 'not-run';
}
export interface ReferenceStagePopulation {
  readonly phase: Phase; readonly rolloutMode: Mode; readonly caseCount: number; readonly armCount: number;
  readonly populationRootSha256: string; readonly summary: DeepReadonly<RagEvalSummary>;
  readonly qualityChecks: readonly ReferenceStageMetricCheck[]; readonly securityChecks: readonly ReferenceStageMetricCheck[];
}
export interface ReferenceStageQualityReport {
  readonly schemaVersion: 'kg-reference-stage-quality/v1'; readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-owned-population-comparison';
  readonly stage: 'T16' | 'T17'; readonly bindingHash: string; readonly manifestHash: string; readonly thresholdsHash: string;
  readonly qualityComparisonsComputed: true; readonly machineGateComputed: false; readonly productionAccepted: false;
  readonly stageAcceptanceComplete: false; readonly sideEffectPolicyVerified: false; readonly runtimeHardGatesVerified: false;
  readonly sourceAuthenticated: false; readonly verdict: 'failed' | 'incomplete'; readonly populationCaseCount: number;
  readonly blockers: readonly string[]; readonly populations: readonly ReferenceStagePopulation[]; readonly reportHash: string;
}

/** Compare the complete actually-owned numerical populations to the original
 * frozen limits. Missing definitions/runtime/SideEffect evidence remain explicit;
 * this module cannot issue a complete stage verdict or an execution authority. */
export function createReferenceProductionStageQualityCollector(inputOptions: unknown, actualDatasetJson: unknown, ...extras: unknown[]) {
  let binding: ReturnType<typeof createReferenceProductionAskDatasetBinding>, manifestHash: string, thresholdsHash: string;
  let quality: Fields, stage: 'T16' | 'T17', treatment: 'shadow' | 'active', rosterCount: number;
  let warmupCount: number, trialCount: number;
  try {
    if (extras.length) throw new Error(); const options = record(JSON.parse(canonicalJson(inputOptions)));
    binding = createReferenceProductionAskDatasetBinding(options, actualDatasetJson);
    const view = validateManifestExecutionBinding({ manifest: options.manifest, expectedExecutionPayload: options.expectedExecutionPayload,
      executionAuthorizationRef: options.executionAuthorizationRef });
    if (view.stage !== 'T16' && view.stage !== 'T17') throw new Error(); stage = view.stage; treatment = stage === 'T16' ? 'shadow' : 'active';
    manifestHash = view.manifestHash; thresholdsHash = view.identities.thresholdsHash; quality = freeze(record(view.thresholds.quality));
    const sampling = record(view.thresholds.sampling); warmupCount = sampling.warmupCount as number; trialCount = sampling.trialCount as number;
    rosterCount = record(record(record(options.manifest).base).dataset).roster instanceof Array
      ? (record(record(record(options.manifest).base).dataset).roster as unknown[]).length : 0;
    if (!rosterCount) throw new Error();
  } catch { throw new ProductionStageQualityError('invalid-config'); }
  const groups = new Map<string, { phase: Phase; rolloutMode: Mode; rows: ReferenceAskCaseMeasurement[]; roots: string[] }>();
  for (const phase of ['warmup', 'trial'] as const) for (const rolloutMode of ['off', treatment] as const) groups.set(phase + ':' + rolloutMode, { phase, rolloutMode, rows: [], roots: [] });
  let closed = false, completed = false, observedArms = 0, bytes = 0, nodes = 0;
  const fail = (code: Code) => new ProductionStageQualityError(code);
  const assertOpen = () => { if (closed) throw fail('halted'); if (completed) throw fail('already-completed'); };
  const budget = binding.bindingProof.resourceBudget, totalArms = 2 * (warmupCount + trialCount);
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    close(): void { closed = true; },
    observeArm(input: unknown, ...extra: unknown[]): void {
      assertOpen();
      try {
        // Check identity BEFORE reflecting any caller-supplied field or hook.
        if (extra.length || !isReferenceAskProducerRunProof(input) || observedArms >= totalArms) throw fail('invalid-proof');
        const warm = observedArms < 2 * warmupCount, phase: Phase = warm ? 'warmup' : 'trial';
        const ordinal = Math.floor((observedArms - (warm ? 0 : 2 * warmupCount)) / 2), mode: Mode = observedArms % 2 === 0 ? 'off' : treatment;
        if (input.bindingHash !== binding.bindingProof.bindingHash || input.arm.phase !== phase || input.arm.ordinal !== ordinal || input.arm.rolloutMode !== mode
          || input.cases.length !== rosterCount || input.measurements.caseMeasurements.length !== rosterCount || input.measurements.evaluation !== input.evaluation
          || input.evaluation.summary.failedCases !== 0 || input.measurements.caseMeasurements.some((m, i) => m.caseIndex !== i || m.status !== 'completed')) throw fail('invalid-proof');
        const batch = input.measurements.caseMeasurements;
        const addedBytes = Buffer.byteLength(JSON.stringify(batch)), addedNodes = countNodes(batch, budget.maxNodes);
        if (bytes + addedBytes > budget.maxJsonBytes || nodes + addedNodes > budget.maxNodes) throw fail('capacity-exhausted');
        const group = groups.get(phase + ':' + mode)!; group.rows.push(...batch); group.roots.push(input.measurements.proofHash);
        observedArms++; bytes += addedBytes; nodes += addedNodes;
      } catch (error) { closed = true; throw error instanceof ProductionStageQualityError ? error : fail('invalid-proof'); }
    },
    finish(input: unknown, ...extra: unknown[]): ReferenceStageQualityReport {
      assertOpen();
      try { if (extra.length) throw new Error(); const request = record(JSON.parse(canonicalJson(input))); if (Object.keys(request).length) throw new Error(); }
      catch { throw fail('invalid-request'); }
      if (observedArms !== totalArms) { closed = true; throw fail('incomplete-population'); }
      try {
        const populations = [...groups.values()].map(group => {
          // Only original independently-scored numerical fields are aggregated.
          // Empty content placeholders are NEVER fed back through the oracle.
          const summary = summarizeEvalCaseResults(group.rows.map(toAggregationCase));
          const qualityChecks: ReferenceStageMetricCheck[] = group.phase === 'trial' ? Object.entries(quality).map(([metric, rawLimit]) => {
            const threshold = record(rawLimit), direction = Object.hasOwn(threshold, 'min') ? 'min' as const : 'max' as const;
            const actual = lookupQuality(summary, metric); return compare(metric, direction, threshold[direction] as number, actual, 'unavailable');
          }) : [];
          const securityChecks = Object.keys(HARD_GATE_LIMITS).map(metric => compare(metric, 'max', 0,
            group.rows.length > 0 && Object.hasOwn(summary.security, metric) ? summary.security[metric as keyof typeof summary.security] : null, 'not-run'));
          return { phase: group.phase, rolloutMode: group.rolloutMode, caseCount: group.rows.length, armCount: group.roots.length,
            populationRootSha256: hashRoots(binding.bindingProof.bindingHash, group.phase, group.rolloutMode, group.roots), summary, qualityChecks, securityChecks };
        });
        const blockers = ['side-effect-readback-unavailable', 'runtime-hard-gate-measurements-unavailable', 'timeout-measurement-unavailable',
          stage === 'T16' ? 'semantic-degradation-definition-unavailable' : 'multi-hop-population-definition-unavailable'];
        const verdict = populations.some(p => [...p.qualityChecks, ...p.securityChecks].some(c => c.status === 'failed')) ? 'failed' as const : 'incomplete' as const;
        const populationCaseCount = populations.reduce((n, p) => n + p.caseCount, 0);
        if (populationCaseCount !== rosterCount * totalArms) throw fail('incomplete-population');
        const core: Omit<ReferenceStageQualityReport, 'reportHash'> = { schemaVersion: 'kg-reference-stage-quality/v1', classification: 'confidential',
          validationLevel: 'local-reference-owned-population-comparison', stage, bindingHash: binding.bindingProof.bindingHash, manifestHash, thresholdsHash,
          qualityComparisonsComputed: true, machineGateComputed: false, productionAccepted: false, stageAcceptanceComplete: false,
          sideEffectPolicyVerified: false, runtimeHardGatesVerified: false, sourceAuthenticated: false, verdict,
          populationCaseCount, blockers, populations };
        const result = freeze({ ...core, reportHash: canonicalJsonSha256(core) }); completed = true; return result;
      } catch (error) { closed = true; throw error instanceof ProductionStageQualityError ? error : fail('invalid-proof'); }
    } });
}
function toAggregationCase(value: ReferenceAskCaseMeasurement): RagEvalCaseResult {
  if (value.status === 'failed') return { caseId: 'private-aggregation', status: 'failed', error: 'runner-case-failed' };
  const usage = Object.fromEntries(Object.entries(value.usage).filter(([, v]) => v !== null)) as unknown as RagEvalUsage;
  return { caseId: 'private-aggregation', status: 'completed', answer: '', evidence: [], citationDetails: [], expectedAbstain: value.expectedAbstain,
    abstained: value.abstained, retrieval: value.retrieval, citations: value.citations, security: value.security, answerMetrics: value.answerMetrics, usage };
}
function lookupQuality(summary: RagEvalSummary, metric: string): number | null {
  if (metric === 'timeoutRate' || metric === 'semanticDegradation' || metric === 'multiHop.meanRequiredFactCoverage') return null;
  let value: unknown = summary; for (const name of metric.split('.')) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, name)) return null; value = (value as Fields)[name]; }
  if (value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(); return value;
}
function compare(metric: string, direction: 'min' | 'max', limit: number, actual: number | null, unavailable: 'unavailable' | 'not-run'): ReferenceStageMetricCheck {
  if (!Number.isFinite(limit) || actual !== null && !Number.isFinite(actual)) throw new Error();
  return { metric, direction, limit, actual, status: actual === null ? unavailable : (direction === 'min' ? actual >= limit : actual <= limit) ? 'passed' : 'failed' };
}
function hashRoots(binding: string, phase: Phase, mode: Mode, roots: readonly string[]): string {
  const hash = createHash('sha256').update('kg-reference-stage-population/v1').update('\0').update(binding).update('\0').update(phase).update('\0').update(mode).update('\0').update(String(roots.length)).update('\0');
  for (const root of roots) hash.update(root); return hash.digest('hex');
}
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function countNodes(input: unknown, maximum: number): number {
  let count = 0; const visit = (value: unknown, depth: number) => { if (++count > maximum || depth > 64) throw new ProductionStageQualityError('capacity-exhausted');
    if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1); }; visit(input, 0); return count;
}
function freeze<T>(input: T): T { if (input && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input); } return input; }
