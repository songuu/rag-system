import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import { createReferenceProductionAskProducer, ProductionAskProducerError } from './production-ask-producer';
import type { ReferenceAskProducerRunProof } from './production-ask-producer';
import { createReferenceProductionStageQualityCollector } from './production-stage-gate';
import type { ReferenceStageQualityReport } from './production-stage-gate';

type Fields = Record<string, unknown>;
type Phase = 'warmup' | 'trial';
type Mode = 'off' | 'shadow' | 'active';
const CODES = ['invalid-config', 'invalid-request', 'busy', 'halted', 'already-executed', 'producer-failed', 'pairing-failed', 'capacity-exhausted'] as const;
type Code = typeof CODES[number];
export class ProductionAskRunnerError extends Error {
  readonly code: Code;
  readonly pendingCompletionUnknown: boolean;
  readonly requestMayHaveBeenDispatched: boolean;
  readonly mutationMayHaveOccurred: boolean;
  readonly productionAccepted = false;
  readonly automaticRetryAllowed = false;
  constructor(code: Code, pending = false, dispatched = false, mutation = false) {
    const safe = CODES.includes(code) ? code : 'producer-failed';
    super('[reference paired Ask runner] ' + safe); this.name = 'ProductionAskRunnerError'; this.code = safe;
    this.pendingCompletionUnknown = pending; this.requestMayHaveBeenDispatched = dispatched; this.mutationMayHaveOccurred = mutation;
    Object.freeze(this);
  }
}
export interface ReferenceAskPairedCase {
  readonly caseIndex: number;
  readonly offRequestPlanHash: string;
  readonly treatmentRequestPlanHash: string;
  readonly requestBodySha256: string;
  readonly offObservationHash: string;
  readonly treatmentObservationHash: string;
  readonly pairHash: string;
}
export interface ReferenceAskPairedRun {
  readonly phase: Phase;
  readonly ordinal: number;
  readonly off: ReferenceAskProducerRunProof;
  readonly treatment: ReferenceAskProducerRunProof;
  readonly cases: readonly ReferenceAskPairedCase[];
  readonly pairHash: string;
}
export interface ReferenceAskRunnerProof {
  readonly schemaVersion: 'kg-reference-paired-ask-run/v1';
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-owned-complete-paired-execution';
  readonly productionAccepted: false;
  readonly stageAcceptanceComplete: false;
  readonly executionAuthorized: false;
  readonly registryAuthenticated: false;
  readonly serverBindingAuthenticated: false;
  readonly sideEffectPolicyVerified: false;
  readonly machineGateComputed: false;
  readonly completeRosterExecuted: true;
  readonly samplingExecuted: true;
  readonly stage: 'T16' | 'T17';
  readonly bindingHash: string;
  readonly sampling: { readonly trialCount: number; readonly warmupCount: number };
  readonly transportCalls: number;
  readonly trialTransportCalls: number;
  readonly warmups: readonly ReferenceAskPairedRun[];
  readonly trials: readonly ReferenceAskPairedRun[];
  readonly qualityReport: ReferenceStageQualityReport;
  readonly proofHash: string;
}

/** Own the original producer, never accept a caller's result or runArm callback.
 * Execute every frozen slot and keep the complete confidential indices. This
 * proves local pairing only: it is NOT SideEffectPolicy, a stage machine gate,
 * an enterprise authorization, or a resumable/cancellable production run. */
export function createReferenceProductionAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputPorts: unknown,
  ...extras: unknown[]) {
  let producer: ReturnType<typeof createReferenceProductionAskProducer>;
  let binding: ReturnType<typeof createReferenceProductionAskDatasetBinding>;
  let quality: ReturnType<typeof createReferenceProductionStageQualityCollector>;
  let stage: 'T16' | 'T17', treatment: 'shadow' | 'active', sampling: ReferenceAskRunnerProof['sampling'], roster: readonly string[];
  try {
    if (extras.length) throw new Error();
    const options = record(freeze(JSON.parse(canonicalJson(inputOptions))));
    exact(options, ['executionProfile', 'askOptions', 'artifacts']); if (options.executionProfile !== 'local-reference') throw new Error();
    binding = createReferenceProductionAskDatasetBinding(options.askOptions, actualDatasetJson);
    const manifest = record(record(options.askOptions).manifest), base = record(manifest.base);
    roster = record(base.dataset).roster as readonly string[];
    stage = binding.planRequest({ caseId: roster[0], rolloutMode: 'off', phase: 'trial', ordinal: 0 }).requestPlan.stage;
    treatment = stage === 'T16' ? 'shadow' : 'active';
    sampling = record(record(manifest[stage === 'T16' ? 't16' : 't17']).sampling) as unknown as ReferenceAskRunnerProof['sampling'];
    // Even just the mandatory fixed-size pairing records must fit the original
    // resource profile. Reject impossible complete schedules before port IO;
    // this never silently reduces an approved roster or sampling count.
    const zero = '0'.repeat(64);
    const minimumPairBytes = Buffer.byteLength(JSON.stringify(roster.map((_, caseIndex) => ({ caseIndex,
      offRequestPlanHash: zero, treatmentRequestPlanHash: zero, requestBodySha256: zero,
      offObservationHash: zero, treatmentObservationHash: zero, pairHash: zero }))));
    if (minimumPairBytes * (sampling.warmupCount + sampling.trialCount) > binding.bindingProof.resourceBudget.maxJsonBytes) {
      throw new ProductionAskRunnerError('capacity-exhausted');
    }
    quality = createReferenceProductionStageQualityCollector(options.askOptions, actualDatasetJson);
    producer = createReferenceProductionAskProducer(options, actualDatasetJson, inputPorts);
  } catch (error) {
    if (error instanceof ProductionAskRunnerError) throw error;
    throw new ProductionAskRunnerError('invalid-config');
  }
  let closed = false, busy = false, used = false, started = false, producerClosed = false, operationPending = false, pendingAtClose = false;
  function closeProducer() { if (!producerClosed) { producerClosed = true; producer.close(); quality.close(); } }
  const fail = (code: Code, pending = pendingAtClose || operationPending, dispatched = started, mutation = started) =>
    new ProductionAskRunnerError(code, pending, dispatched, mutation);
  function assertOpen() { if (closed) throw fail('halted'); }
  const pairCases = (off: ReferenceAskProducerRunProof, selected: ReferenceAskProducerRunProof, phase: Phase, ordinal: number): readonly ReferenceAskPairedCase[] => {
    if (off.bindingHash !== binding.bindingProof.bindingHash || selected.bindingHash !== off.bindingHash
      || off.cases.length !== roster.length || selected.cases.length !== roster.length
      || off.transportCalls !== roster.length || selected.transportCalls !== roster.length) throw fail('pairing-failed');
    for (const [proof, mode] of [[off, 'off'], [selected, treatment]] as const) {
      if (proof.arm.rolloutMode !== mode || proof.arm.phase !== phase || proof.arm.ordinal !== ordinal
        || proof.evaluation.summary.completedCases !== roster.length || proof.evaluation.summary.failedCases !== 0) throw fail('pairing-failed');
    }
    return roster.map((caseId, caseIndex) => {
      const left = off.cases[caseIndex], right = selected.cases[caseIndex];
      const plan = (rolloutMode: Mode) => binding.planRequest({ caseId, rolloutMode, phase, ordinal }).requestPlan.planHash;
      if (left.requestPlanHash !== plan('off') || right.requestPlanHash !== plan(treatment)
        || left.requestBodySha256 !== right.requestBodySha256
        || [left, right].some(c => c.artifacts.find(a => a.artifactType === 'gold')?.observation.bodySha256 !== binding.bindingProof.rawJsonSha256)) throw fail('pairing-failed');
      const core = { caseIndex, offRequestPlanHash: left.requestPlanHash, treatmentRequestPlanHash: right.requestPlanHash,
        requestBodySha256: left.requestBodySha256, offObservationHash: left.observationHash, treatmentObservationHash: right.observationHash };
      return freeze({ ...core, pairHash: canonicalJsonSha256(core) });
    });
  };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    close(): void { closed = true; pendingAtClose ||= operationPending; closeProducer(); },
    async run(input: unknown, ...extra: unknown[]): Promise<ReferenceAskRunnerProof> {
      assertOpen(); if (busy) throw fail('busy'); if (used) throw fail('already-executed');
      try { if (extra.length) throw new Error(); exact(record(JSON.parse(canonicalJson(input))), []); }
      catch { throw fail('invalid-request', false, false, false); }
      busy = true; used = true;
      const warmups: ReferenceAskPairedRun[] = [], trials: ReferenceAskPairedRun[] = [];
      const core: Omit<ReferenceAskRunnerProof, 'proofHash' | 'qualityReport'> = { schemaVersion: 'kg-reference-paired-ask-run/v1', classification: 'confidential',
        validationLevel: 'local-reference-owned-complete-paired-execution', productionAccepted: false, stageAcceptanceComplete: false,
        executionAuthorized: false, registryAuthenticated: false, serverBindingAuthenticated: false, sideEffectPolicyVerified: false, machineGateComputed: false,
        completeRosterExecuted: true, samplingExecuted: true, stage, bindingHash: binding.bindingProof.bindingHash, sampling,
        transportCalls: 2 * roster.length * (sampling.warmupCount + sampling.trialCount), trialTransportCalls: 2 * roster.length * sampling.trialCount,
        warmups, trials };
      const budget = binding.bindingProof.resourceBudget;
      let bytes = Buffer.byteLength(JSON.stringify({ ...core, proofHash: '0'.repeat(64) })), nodes = countNodes({ ...core, proofHash: '' }, budget.maxNodes), calls = 0;
      const runArm = async (rolloutMode: Mode, phase: Phase, ordinal: number) => {
        assertOpen(); started = true; operationPending = true;
        try { const result = await producer.runArm({ rolloutMode, phase, ordinal }); assertOpen(); quality.observeArm(result); return result; }
        finally { operationPending = false; }
      };
      try {
        for (const phase of ['warmup', 'trial'] as const) {
          const output = phase === 'warmup' ? warmups : trials, count = sampling[phase === 'warmup' ? 'warmupCount' : 'trialCount'];
          for (let ordinal = 0; ordinal < count; ordinal++) {
            assertOpen(); const off = await runArm('off', phase, ordinal); assertOpen();
            // Once even the completed first arm cannot fit, there is no valid
            // complete pair to construct: do not dispatch its second arm.
            if (bytes + Buffer.byteLength(JSON.stringify(off)) > budget.maxJsonBytes
              || nodes + countNodes(off, budget.maxNodes) > budget.maxNodes) throw fail('capacity-exhausted');
            const selected = await runArm(treatment, phase, ordinal); assertOpen();
            const cases = pairCases(off, selected, phase, ordinal);
            const pair = freeze({ phase, ordinal, off, treatment: selected, cases,
              pairHash: canonicalJsonSha256({ phase, ordinal, bindingHash: core.bindingHash, off: off.proofHash, treatment: selected.proofHash,
                cases: digestSequence('kg-reference-paired-ask-cases/v1', cases.map(c => c.pairHash)) }) });
            const addedBytes = Buffer.byteLength(JSON.stringify(pair)) + (output.length ? 1 : 0), addedNodes = countNodes(pair, budget.maxNodes);
            if (bytes + addedBytes > budget.maxJsonBytes || nodes + addedNodes > budget.maxNodes) throw fail('capacity-exhausted');
            output.push(pair); bytes += addedBytes; nodes += addedNodes; calls += off.transportCalls + selected.transportCalls;
          }
        }
        assertOpen(); if (calls !== core.transportCalls) throw fail('pairing-failed');
        // Hash complete ordered producer/case roots, never serialize a large
        // report through the smaller canonical control-object budget or average
        // trial percentiles. Warmup observations remain a separate population.
        const qualityReport = quality.finish({}); assertOpen();
        if (bytes + Buffer.byteLength(JSON.stringify(qualityReport)) > budget.maxJsonBytes || nodes + countNodes(qualityReport, budget.maxNodes) > budget.maxNodes) throw fail('capacity-exhausted');
        const result = freeze({ ...core, qualityReport, proofHash: canonicalJsonSha256({ ...core, qualityReport: qualityReport.reportHash,
          warmups: digestSequence('kg-reference-paired-ask-warmups/v1', warmups.map(p => p.pairHash)),
          trials: digestSequence('kg-reference-paired-ask-trials/v1', trials.map(p => p.pairHash)) }) });
        // Include the newly added field name/separator and every full value,
        // not just the separately counted quality JSON payload.
        if (Buffer.byteLength(JSON.stringify(result)) > budget.maxJsonBytes) throw fail('capacity-exhausted');
        return result;
      } catch (error) {
        closed = true;
        if (error instanceof ProductionAskRunnerError) throw fail(error.code, pendingAtClose || error.pendingCompletionUnknown,
          started || error.requestMayHaveBeenDispatched, started || error.mutationMayHaveOccurred);
        if (error instanceof ProductionAskProducerError) throw fail(pendingAtClose ? 'halted' : 'producer-failed',
          pendingAtClose || error.pendingCompletionUnknown, started || error.requestMayHaveBeenDispatched, started || error.mutationMayHaveOccurred);
        throw fail('producer-failed', true);
      } finally { busy = false; closeProducer(); }
    },
  });
}
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, keys: readonly string[]): void { if (Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new Error(); }
function countNodes(input: unknown, maximum: number): number {
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > maximum || depth > 64) throw new ProductionAskRunnerError('capacity-exhausted');
    if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(input, 0); return nodes;
}
function digestSequence(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256').update(domain).update('\0').update(String(values.length)).update('\0');
  for (const value of values) { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(); hash.update(value); } return hash.digest('hex');
}
function freeze<T>(input: T): T { if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }
