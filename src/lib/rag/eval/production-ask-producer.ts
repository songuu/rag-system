import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { parseRagEvalDataset } from './dataset';
import { runRagEval } from './runner';
import { attachProviderPromiseDrain, boundedAskRequestCall, boundedProviderCallWithRejection } from './bounded-provider-call';
import { createReferenceProductionAskDatasetBinding, createReferenceProductionAskMeasurementEvaluator } from './production-ask-dataset-binding';
import type { ReferenceProductionAskEvaluationProof, ReferenceProductionAskMeasurementsProof } from './production-ask-dataset-binding';
import { createReferenceProductionAskArtifactWriter } from './production-ask-artifact-writer';
import type { ReferenceAskArtifactObservation } from './production-ask-artifact-writer';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import type { ReferenceProductionAskRequestPlan } from './production-ask-target';
import type { RagEvalCitation, RagEvalRetrievedEvidence, RagEvalTargetResult, RagEvalUsage } from './types';
import { buildReferenceAskRequestBody, validateReferenceAskDeployment } from './production-ask-request-contract';
import { RAG_CLIENT_REQUEST_TIMEOUT_MS } from '../core/request-budgets';
import { assertRagResponseTrace } from '../core/http-contract';

type Fields = Record<string, unknown>;
type Arm = { readonly rolloutMode: 'off' | 'shadow' | 'active'; readonly phase: 'trial' | 'warmup'; readonly ordinal: number };
type BodyType = 'request' | 'gold' | 'response' | 'error' | 'telemetry';
type Call = (input: unknown) => unknown;
interface Port { readonly receiver: object; readonly methods: Readonly<Record<string, Call>> }
const now = performance.now.bind(performance), apply = Reflect.apply;
const CODES = ['invalid-config', 'invalid-request', 'busy', 'halted', 'already-executed', 'invalid-clock',
  'invalid-deployment', 'invalid-response', 'artifact-failed', 'request-failed', 'operation-timeout', 'oracle-failed', 'capacity-exhausted'] as const;
type Code = typeof CODES[number];
type Phase = 'configuration' | 'preflight' | 'clock' | 'deployment' | 'artifact' | 'transport' | 'oracle';
const ownedRunProofs = new WeakSet<object>();
const addOwnedRunProof = WeakSet.prototype.add.bind(ownedRunProofs), hasOwnedRunProof = WeakSet.prototype.has.bind(ownedRunProofs);
/** In-process provenance only, never authentication or a production grant.
 * Serialized/clone/proxy success labels cannot replace an actual private run. */
export function isReferenceAskProducerRunProof(input: unknown): input is ReferenceAskProducerRunProof {
  return typeof input === 'object' && input !== null && hasOwnedRunProof(input);
}
export class ProductionAskProducerError extends Error {
  readonly code: Code;
  readonly phase: Phase;
  readonly pendingCompletionUnknown: boolean;
  readonly requestMayHaveBeenDispatched: boolean;
  readonly mutationMayHaveOccurred: boolean;
  readonly productionAccepted = false;
  readonly automaticRetryAllowed = false;
  constructor(code: Code, phase: Phase, pending = false, posted = false, mutation = false) {
    const safe = CODES.includes(code) ? code : 'invalid-response';
    super('[production Ask producer] ' + safe);
    this.name = 'ProductionAskProducerError'; this.code = safe; this.phase = phase;
    this.pendingCompletionUnknown = pending; this.requestMayHaveBeenDispatched = posted; this.mutationMayHaveOccurred = mutation;
    Object.freeze(this);
  }
}
export interface ReferenceOwnedAskRequest {
  readonly schemaVersion: 'kg-reference-owned-ask-request/v1';
  readonly requestPlan: ReferenceProductionAskRequestPlan;
  readonly bodyBase64url: string;
  readonly bodySha256: string;
  readonly deploymentHash: string;
}
export interface ReferenceAskProducedCase {
  readonly requestPlanHash: string;
  readonly requestBodySha256: string;
  readonly responseBodySha256: string;
  readonly citationSource: 'response' | 'absent';
  readonly measurementSource: 'local-reference-correlated-transport';
  readonly artifacts: readonly { readonly artifactType: BodyType; readonly observation: ReferenceAskArtifactObservation }[];
  readonly observationHash: string;
}
export interface ReferenceAskProducerRunProof {
  readonly schemaVersion: 'kg-reference-ask-producer-run/v1';
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-owned-request-response-oracle';
  readonly productionAccepted: false;
  readonly stageAcceptanceComplete: false;
  readonly registryAuthenticated: false;
  readonly networkEnforced: false;
  readonly serverBindingAuthenticated: false;
  readonly requestBodiesOwned: true;
  readonly transportCallsObserved: true;
  readonly oracleConsumed: true;
  readonly arm: Arm;
  readonly bindingHash: string;
  readonly transportCalls: number;
  readonly cases: readonly ReferenceAskProducedCase[];
  readonly evaluation: ReferenceProductionAskEvaluationProof;
  readonly measurements: ReferenceProductionAskMeasurementsProof;
  readonly proofHash: string;
}

/** Own complete validated input, POST bodies, received bytes and the original
 * oracle. The only execution selector is an approved arm/phase/ordinal.
 * Ports are explicit confidential reference handoffs, NOT network enforcement,
 * server/measurement authentication or an enterprise permit. They may later
 * wrap an approved transport, but caller markers cannot upgrade this profile.
 * No query/gold/result injection, automatic retry, cancellation or restart
 * protection is offered. Failure/close fences this instance permanently. */
export function createReferenceProductionAskProducer(inputOptions: unknown, actualDatasetJson: unknown, inputPorts: unknown, ...extras: unknown[]) {
  let options: Fields, binding: ReturnType<typeof createReferenceProductionAskDatasetBinding>;
  let evaluator: ReturnType<typeof createReferenceProductionAskMeasurementEvaluator>;
  let writer: ReturnType<typeof createReferenceProductionAskArtifactWriter>;
  let transport: Port, clock: Port;
  let dataset: ReturnType<typeof parseRagEvalDataset>;
  let bodies: readonly Buffer[], gold: Buffer, artifactTimeout: number;
  let base: Fields, artifacts: Fields, executor: string;
  try {
    if (extras.length) throw new Error();
    options = record(snapshot(inputOptions)); exact(options, ['executionProfile', 'askOptions', 'artifacts']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const ask = record(options.askOptions);
    binding = createReferenceProductionAskDatasetBinding(ask, actualDatasetJson);
    // The original binder already bounded and validated this immutable string.
    // Reuse the original parser, never export its full private result or labels.
    dataset = freeze(parseRagEvalDataset(JSON.parse(actualDatasetJson as string)));
    gold = Buffer.from(actualDatasetJson as string, 'utf8');
    base = record(record(ask.manifest).base); artifacts = record(options.artifacts);
    artifactTimeout = artifacts.operationTimeoutMs as number;
    const model = record(base.models), llm = text(record(model.llm).id), embedding = text(record(model.embedding).id);
    bodies = dataset.cases.map(c => {
      const body = buildReferenceAskRequestBody({ question: c.query, topK: record(base.parameters).topK, corpusId: c.scope?.corpusId,
        llmModel: llm, embeddingModel: embedding });
      const plan = binding.planRequest({ caseId: c.id, rolloutMode: 'off', phase: 'trial', ordinal: 0 }).requestPlan;
      // Unsupported frozen budgets are rejected, never silently shortened.
      if (plan.target.networkPolicy.requestTimeoutMs > RAG_CLIENT_REQUEST_TIMEOUT_MS) throw new Error();
      return body;
    });
    executor = text(record(record(ask.expectedExecutionPayload).participants).executorId);
    const ports = descriptors(inputPorts, ['clock', 'kms', 'store', 'transport']); exact(ports, ['clock', 'kms', 'store', 'transport']);
    transport = capture(ports.transport, ['readDeployment', 'post'], ['close']);
    clock = capture(ports.clock, ['readTime'], ['advanceTo', 'setAvailability']);
    writer = createReferenceProductionAskArtifactWriter(options, actualDatasetJson, { clock: ports.clock, kms: ports.kms, store: ports.store });
    evaluator = createReferenceProductionAskMeasurementEvaluator(ask, actualDatasetJson);
  } catch { throw new ProductionAskProducerError('invalid-config', 'configuration'); }

  let closed = false, busy = false, phase: Phase = 'preflight', deadline = Infinity, posted = false, mutation = false;
  let previousClock: AuthorityClockReading | null = null;
  let transportCloseCalled = false;
  const usedArms = new Set<string>(), challenges = new Set<string>();
  const fail = (code: Code, pending = false) => new ProductionAskProducerError(code, phase, pending, posted, mutation);
  const assertOpen = () => { if (closed) throw fail('halted'); if (now() >= deadline) throw fail('operation-timeout'); };
  const remaining = (budget: number) => Math.min(budget, Math.max(1, Math.ceil(deadline - now())));
  function haltOwned(): void {
    closed = true; writer.close();
    if (transportCloseCalled || !transport.methods.close) return; transportCloseCalled = true;
    // Call synchronously so a held native Secret cannot resume before fencing.
    // Drop raw throws and drain only through the original Promise firewall; a
    // callback return is not proof of cancellation or remote rollback.
    try {
      const returned = apply(transport.methods.close, transport.receiver, []);
      if (returned !== undefined) attachProviderPromiseDrain(returned);
    } catch { /* The producer/writer are already permanently fenced. */ }
  }
  async function invoke(current: Phase, callback: () => unknown, budget: number): Promise<{ readonly value: unknown }> {
    phase = current; assertOpen();
    const observed = await boundedAskRequestCall(() => { assertOpen(); return callback(); }, remaining(budget));
    phase = current;
    // Preserve the observed pending state even when synchronous callback work
    // has already exhausted the outer deadline. A deadline is not cancellation.
    if (observed.status === 'timeout') throw fail('operation-timeout', observed.pendingCompletionUnknown);
    if (observed.status !== 'fulfilled') throw fail(closed ? 'halted' : current === 'deployment' ? 'invalid-deployment' : current === 'clock' ? 'invalid-clock' : 'invalid-response', true);
    assertOpen();
    return Object.freeze({ value: observed.value });
  }
  async function freshClock(plan: ReferenceProductionAskRequestPlan) {
    if (challenges.size >= 10000) throw fail('capacity-exhausted');
    const nonce = randomBytes(16).toString('hex'); if (challenges.has(nonce)) throw fail('invalid-clock'); challenges.add(nonce);
    const request = freeze({ context: { executionProfile: 'local-reference', binding: plan.binding, actorId: executor }, requestNonce: nonce });
    const { value } = await invoke('clock', () => apply(clock.methods.readTime, clock.receiver, [request]), artifactTimeout);
    try {
      const valid = validateAuthorityClockReading(snapshot(value), { request, sourceIdentityRef: artifacts.clockIdentityRef,
        maxUncertaintyMs: artifacts.maxClockUncertaintyMs, previousReading: previousClock });
      const reading = valid.reading, at = Date.parse(reading.observedAt);
      if (at - reading.uncertaintyMs < Date.parse(plan.effectiveWindow.startsAt)
        || at + reading.uncertaintyMs >= Date.parse(plan.effectiveWindow.endsAt)) throw new Error();
      previousClock = reading; return { at, uncertainty: reading.uncertaintyMs, observedMono: now() };
    } catch { throw fail('invalid-clock'); }
  }
  function clockGate(plan: ReferenceProductionAskRequestPlan, reading: Awaited<ReturnType<typeof freshClock>>) {
    assertOpen();
    if (reading.at + reading.uncertainty + Math.max(0, now() - reading.observedMono) >= Date.parse(plan.effectiveWindow.endsAt)) throw fail('invalid-clock');
  }
  async function archive(type: BodyType, bytes: Buffer, plan: ReferenceProductionAskRequestPlan): Promise<ReferenceAskArtifactObservation> {
    phase = 'artifact'; assertOpen(); mutation = true;
    const r = plan.requestIdentity;
    const payload = JSON.stringify({ schemaVersion: 'kg-reference-ask-artifact-payload/v1',
      request: { caseId: r.caseId, rolloutMode: r.rolloutMode, phase: r.phase, ordinal: r.ordinal }, artifactType: type, payloadBase64url: bytes.toString('base64url') });
    const observed = await boundedProviderCallWithRejection(() => { assertOpen(); return writer.sealReadback(payload); }, remaining(artifactTimeout));
    phase = 'artifact';
    if (observed.status !== 'fulfilled') throw fail(observed.status === 'timeout' ? 'operation-timeout' : 'artifact-failed', true);
    assertOpen();
    // This value comes only from our privately constructed writer, not a caller
    // supplied layout/observation; conservative errors never read its raw reason.
    return observed.value as ReferenceAskArtifactObservation;
  }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    bindingProof: binding.bindingProof,
    close(): void { haltOwned(); },
    async runArm(input: unknown, ...extra: unknown[]): Promise<ReferenceAskProducerRunProof> {
      if (closed) throw fail('halted'); if (busy) throw fail('busy');
      let selector: Arm, plans: ReturnType<typeof binding.planRequest>[];
      try {
        if (extra.length) throw new Error();
        const raw = record(snapshot(input)); exact(raw, ['rolloutMode', 'phase', 'ordinal']);
        plans = dataset.cases.map(c => binding.planRequest({ caseId: c.id, ...raw }));
        selector = raw as unknown as Arm;
      } catch { throw new ProductionAskProducerError('invalid-request', 'preflight'); }
      const slot = canonicalJson(selector);
      if (usedArms.has(slot)) throw fail('already-executed');
      if (usedArms.size >= 10000) throw fail('capacity-exhausted');
      usedArms.add(slot); busy = true;
      const cases: ReferenceAskProducedCase[] = [], entries: { request: object; result: RagEvalTargetResult }[] = [];
      const resultEnvelope = { schemaVersion: 'kg-reference-ask-results/v1', bindingHash: binding.bindingProof.bindingHash, entries };
      const resultBudget = binding.bindingProof.resourceBudget;
      let resultBytes = Buffer.byteLength(JSON.stringify(resultEnvelope)), resultNodes = jsonNodes(resultEnvelope);
      let transportCalls = 0;
      try {
        for (const [index, bound] of plans.entries()) {
          const plan = bound.requestPlan, timeout = plan.target.networkPolicy.requestTimeoutMs;
          deadline = now() + 2 * timeout + 4 * artifactTimeout; posted = false; phase = 'preflight'; assertOpen();
          const beforeDeployment = await freshClock(plan);
          const deployed = await invoke('deployment', () => { clockGate(plan, beforeDeployment); return apply(transport.methods.readDeployment, transport.receiver, [plan]); }, timeout);
          let deployment: Fields;
          try { deployment = parseJson(deployed.value); validateReferenceAskDeployment(deployment, plan, base); } catch { throw fail('invalid-deployment'); }
          const actualArtifacts: { artifactType: BodyType; observation: ReferenceAskArtifactObservation }[] = [];
          const seal = async (type: BodyType, bytes: Buffer) => { actualArtifacts.push({ artifactType: type, observation: await archive(type, bytes, plan) }); };
          const body = bodies[index]; await seal('request', body); await seal('gold', gold);
          const request: ReferenceOwnedAskRequest = freeze({ schemaVersion: 'kg-reference-owned-ask-request/v1', requestPlan: plan,
            bodyBase64url: body.toString('base64url'), bodySha256: digest(body), deploymentHash: canonicalJsonSha256(deployment) });
          const beforePost = await freshClock(plan);
          const received = await invoke('transport', () => { clockGate(plan, beforePost); posted = true; transportCalls++; return apply(transport.methods.post, transport.receiver, [request]); }, timeout);
          let response: Fields, bytes: Buffer;
          try { response = parseJson(received.value); bytes = validateResponse(response, request); } catch { throw fail('invalid-response'); }
          const status = response.status as number;
          await seal(status === 200 ? 'response' : 'error', bytes);
          if (status !== 200) {
            await seal('telemetry', Buffer.from(JSON.stringify({ schemaVersion: 'kg-reference-ask-telemetry/v1', requestPlanHash: plan.planHash,
              requestBodySha256: request.bodySha256, responseBodySha256: digest(bytes), status, result: 'http-failed' })));
            phase = 'transport'; throw fail('request-failed');
          }
          let result: RagEvalTargetResult, citationSource: 'response' | 'absent';
          try {
            const projected = projectResponse(bytes, response, request);
            result = projected.result; citationSource = projected.citationSource;
          } catch { throw fail('invalid-response'); }
          phase = 'oracle'; assertOpen();
          const r = plan.requestIdentity;
          const entry = { request: { caseId: r.caseId, rolloutMode: r.rolloutMode, phase: r.phase, ordinal: r.ordinal }, result };
          const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0), entryNodes = jsonNodes(entry);
          // Reuse the original evaluator's declared aggregate budget. A valid
          // response must not allow an already-unrepresentable arm to dispatch
          // more requests or retain an unbounded collection of full results.
          if (resultBytes + entryBytes > resultBudget.maxJsonBytes || resultNodes + entryNodes > resultBudget.maxNodes) throw fail('capacity-exhausted');
          const single = await runRagEval({ ...dataset, cases: [dataset.cases[index]] }, { id: 'reference-observed-transport', async run() { return result; } },
            { topK: record(base.parameters).topK as number });
          assertOpen();
          if (single.summary.failedCases !== 0 || Object.values(single.summary.security).some(n => n !== 0)) throw fail('oracle-failed');
          await seal('telemetry', Buffer.from(JSON.stringify({ schemaVersion: 'kg-reference-ask-telemetry/v1', requestPlanHash: plan.planHash,
            requestBodySha256: request.bodySha256, responseBodySha256: digest(bytes), status,
            measurementSource: 'local-reference-correlated-transport', measurement: response.measurement, citationSource })));
          const core = { requestPlanHash: plan.planHash, requestBodySha256: request.bodySha256, responseBodySha256: digest(bytes), citationSource,
            measurementSource: 'local-reference-correlated-transport' as const, artifacts: actualArtifacts };
          // Artifact observations already bind their complete indices. Hash
          // those identities, not a potentially multi-MiB control JSON object;
          // return all original observations and indices without truncation.
          cases.push(freeze({ ...core, observationHash: canonicalJsonSha256({ ...core,
            artifacts: actualArtifacts.map(a => ({ artifactType: a.artifactType, observationHash: a.observation.observationHash })) }) }));
          entries.push(freeze(entry)); resultBytes += entryBytes; resultNodes += entryNodes;
        }
        phase = 'oracle'; assertOpen();
        const measurements = await evaluator.evaluateReferenceMeasurements(JSON.stringify(resultEnvelope)), evaluation = measurements.evaluation;
        assertOpen(); if (evaluation.summary.failedCases !== 0) throw fail('oracle-failed');
        const core: Omit<ReferenceAskProducerRunProof, 'proofHash'> = {
          schemaVersion: 'kg-reference-ask-producer-run/v1', classification: 'confidential', validationLevel: 'local-reference-owned-request-response-oracle',
          productionAccepted: false, stageAcceptanceComplete: false, registryAuthenticated: false, networkEnforced: false,
          serverBindingAuthenticated: false, requestBodiesOwned: true, transportCallsObserved: true, oracleConsumed: true,
          arm: selector, bindingHash: binding.bindingProof.bindingHash, transportCalls, cases, evaluation, measurements };
        const proof = freeze({ ...core, proofHash: canonicalJsonSha256({ ...core,
          cases: orderedHashes('kg-reference-ask-producer-cases/v1', cases.map(c => c.observationHash)), evaluation: evaluation.proofHash,
          measurements: measurements.proofHash }) });
        addOwnedRunProof(proof); return proof;
      } catch (error) {
        haltOwned();
        // Only our private static errors are retained. No SDK rejection, body,
        // endpoint, query, gold or original runner error escapes this boundary.
        if (error instanceof ProductionAskProducerError) throw error;
        throw fail('oracle-failed', true);
      } finally { busy = false; entries.length = 0; }
    },
  });
}

function validateResponse(value: Fields, request: ReferenceOwnedAskRequest): Buffer {
  exact(value, ['schemaVersion', 'requestPlanHash', 'requestBodySha256', 'deploymentHash', 'url', 'status', 'headers', 'bodyBase64url'], ['measurement']);
  if (value.schemaVersion !== 'kg-reference-ask-response/v1' || value.requestPlanHash !== request.requestPlan.planHash
    || value.requestBodySha256 !== request.bodySha256 || value.deploymentHash !== request.deploymentHash || value.url !== request.requestPlan.target.url
    || typeof value.status !== 'number' || !Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599) throw new Error();
  const bytes = decodeBytes(value.bodyBase64url, Math.min(request.requestPlan.target.networkPolicy.maxResponseBytes, 16 * 1024 * 1024));
  if (!Object.hasOwn(value, 'measurement')) { if (value.status === 200) throw new Error(); return bytes; }
  const measure = record(value.measurement); exact(measure, ['schemaVersion', 'requestPlanHash', 'requestBodySha256', 'responseBodySha256', 'abstained', 'usage']);
  if (measure.schemaVersion !== 'kg-reference-ask-measurement/v1' || measure.requestPlanHash !== request.requestPlan.planHash
    || measure.requestBodySha256 !== request.bodySha256 || measure.responseBodySha256 !== digest(bytes) || typeof measure.abstained !== 'boolean') throw new Error();
  validateUsage(measure.usage); return bytes;
}
function projectResponse(bytes: Buffer, response: Fields, request: ReferenceOwnedAskRequest): { result: RagEvalTargetResult; citationSource: 'response' | 'absent' } {
  const body = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), wanted = record(JSON.parse(Buffer.from(request.bodyBase64url, 'base64url').toString('utf8')));
  if (body.success !== true || body.question !== wanted.question || typeof body.answer !== 'string' || body.storageBackend !== 'milvus') throw new Error();
  const models = record(body.models); if (models.llm !== wanted.llmModel || models.embedding !== wanted.embeddingModel) throw new Error();
  const headers = record(response.headers); exact(headers, ['x-rag-policy', 'x-rag-trace-id', 'x-rag-status']);
  if (headers['x-rag-status'] !== 'completed') throw new Error(); assertRagResponseTrace(body.traceId, text(headers['x-rag-trace-id']));
  const details = record(body.retrievalDetails); if (record(details.graph).requestedMode !== request.requestPlan.requestIdentity.rolloutMode) throw new Error();
  const measure = record(response.measurement), abstention = record(details.abstention);
  if (typeof measure.abstained !== 'boolean') throw new Error();
  if (abstention.mode === 'active' && abstention.abstain !== measure.abstained) throw new Error();
  if (!Array.isArray(body.evidence) || !Array.isArray(body.laneExecutions)) throw new Error();
  const evidence: RagEvalRetrievedEvidence[] = body.evidence.map(raw => {
    const e = record(raw); if (Object.hasOwn(e, 'evidenceId') && e.evidenceId !== e.id) throw new Error();
    const score = e.retrievalScore ?? e.score; if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error();
    const projected: RagEvalRetrievedEvidence = { evidenceId: stringValue(e.id), score, content: stringValue(e.content), source: stringValue(e.source) };
    for (const key of ['tenantId', 'corpusId', 'documentId', 'documentVersion', 'laneId'] as const) {
      if (Object.hasOwn(e, key)) projected[key] = stringValue(e[key]);
    }
    if (Object.hasOwn(e, 'trustLevel')) {
      const trust = e.trustLevel;
      if (trust !== 'trusted' && trust !== 'reviewed' && trust !== 'external' && trust !== 'quarantined') throw new Error();
      projected.trustLevel = trust;
    }
    return projected;
  });
  const present = Object.hasOwn(body, 'citations'); if (present && !Array.isArray(body.citations)) throw new Error();
  const citations: RagEvalCitation[] = present ? (body.citations as unknown[]).map(raw => {
    const c = record(raw); exact(c, ['evidenceId', 'startOffset', 'endOffset']);
    return { evidenceId: stringValue(c.evidenceId), startOffset: countValue(c.startOffset), endOffset: countValue(c.endOffset) };
  }) : [];
  return { result: { answer: body.answer, abstained: measure.abstained, evidence, citations,
    policyId: text(headers['x-rag-policy']), traceId: text(body.traceId), laneIds: [...new Set(body.laneExecutions.map(e => text(record(e).laneId)))],
    usage: validateUsage(measure.usage) }, citationSource: present ? 'response' : 'absent' };
}
function validateUsage(input: unknown): RagEvalUsage {
  const value = record(input), required = ['retrievalLatencyMs', 'generationLatencyMs', 'totalLatencyMs', 'embeddingCalls', 'generationCalls', 'tokenMeasurement', 'costMeasurement'];
  exact(value, required, ['inputTokens', 'outputTokens', 'partialInputTokens', 'partialOutputTokens', 'costUsd']);
  for (const [key, x] of Object.entries(value)) if (!['tokenMeasurement', 'costMeasurement'].includes(key)
    && (typeof x !== 'number' || !Number.isFinite(x) || x < 0)) throw new Error();
  const token = value.tokenMeasurement, cost = value.costMeasurement;
  if (token !== 'provider' && token !== 'partial' && token !== 'estimated' && token !== 'unavailable') throw new Error();
  if (cost !== 'provider' && cost !== 'configured-estimate' && cost !== 'unavailable') throw new Error();
  if (value.tokenMeasurement === 'unavailable' && ['inputTokens', 'outputTokens', 'partialInputTokens', 'partialOutputTokens'].some(k => Object.hasOwn(value, k))) throw new Error();
  if (value.costMeasurement === 'unavailable' && Object.hasOwn(value, 'costUsd')) throw new Error();
  const usage: RagEvalUsage = { retrievalLatencyMs: numberValue(value.retrievalLatencyMs), generationLatencyMs: numberValue(value.generationLatencyMs),
    totalLatencyMs: numberValue(value.totalLatencyMs), embeddingCalls: countValue(value.embeddingCalls), generationCalls: countValue(value.generationCalls),
    tokenMeasurement: token, costMeasurement: cost };
  for (const key of ['inputTokens', 'outputTokens', 'partialInputTokens', 'partialOutputTokens'] as const) {
    if (Object.hasOwn(value, key)) usage[key] = countValue(value[key]);
  }
  if (Object.hasOwn(value, 'costUsd')) usage.costUsd = numberValue(value.costUsd);
  return freeze(usage);
}
function parseJson(input: unknown): Fields {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 24 * 1024 * 1024) throw new Error();
  const value: unknown = JSON.parse(input); let nodes = 0;
  function visit(x: unknown, depth: number) { if (++nodes > 200000 || depth > 64 || typeof x === 'number' && !Number.isFinite(x)) throw new Error();
    if (x && typeof x === 'object') for (const child of Object.values(x)) visit(child, depth + 1); }
  visit(value, 0); return record(value);
}
function decodeBytes(input: unknown, max: number): Buffer {
  if (typeof input !== 'string' || input.length > 4 * Math.ceil(max / 3) || !/^[A-Za-z0-9_-]*$/.test(input)) throw new Error();
  const bytes = Buffer.from(input, 'base64url'); if (bytes.byteLength > max || bytes.toString('base64url') !== input) throw new Error(); return bytes;
}
function descriptors(input: unknown, allowed: readonly string[]): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
  const out: Fields = Object.create(null); for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error(); const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error(); out[key] = d.value;
  } return out;
}
function capture(input: unknown, names: readonly string[], optional: readonly string[] = []): Port {
  const fields = ['executionProfile', 'productionCapable', ...names], value = descriptors(input, [...fields, ...optional]);
  exact(value, fields, optional); if (value.executionProfile !== 'local-reference' || value.productionCapable !== false) throw new Error();
  const captured = names.concat(optional.filter(k => k === 'close' && Object.hasOwn(value, k)));
  for (const key of captured) if (typeof value[key] !== 'function' || types.isProxy(value[key])) throw new Error();
  return Object.freeze({ receiver: input as object, methods: Object.freeze(Object.fromEntries(captured.map(k => [k, value[k] as Call]))) });
}
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(k => !Object.hasOwn(input, k)) || Object.keys(input).some(k => !required.includes(k) && !optional.includes(k))) throw new Error();
}
function text(input: unknown): string { if (typeof input !== 'string' || input.length === 0 || input.length > 256) throw new Error(); return input; }
function stringValue(input: unknown): string { if (typeof input !== 'string') throw new Error(); return input; }
function numberValue(input: unknown): number { if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) throw new Error(); return input; }
function countValue(input: unknown): number { const value = numberValue(input); if (!Number.isSafeInteger(value)) throw new Error(); return value; }
function jsonNodes(input: unknown): number {
  return 1 + (input && typeof input === 'object' ? Object.values(input).reduce<number>((n, value) => n + jsonNodes(value), 0) : 0);
}
function orderedHashes(domain: string, hashes: readonly string[]): string {
  const hash = createHash('sha256').update(domain).update('\0').update(String(hashes.length)).update('\0');
  for (const value of hashes) { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(); hash.update(value); }
  return hash.digest('hex');
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function freeze<T>(input: T): T { if (input && typeof input === 'object') { for (const x of Object.values(input)) freeze(x); Object.freeze(input); } return input; }
