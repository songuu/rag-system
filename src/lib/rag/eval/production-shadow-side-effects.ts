import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { attachProviderPromiseDrain, boundedAskRequestCall } from './bounded-provider-call';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import { createReferenceProductionAskRunner, ProductionAskRunnerError } from './production-ask-runner';
import type { ReferenceAskRunnerProof } from './production-ask-runner';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import type { ReferenceOwnedAskRequest } from './production-ask-producer';
import type { ShadowSideEffectReadbackRequest } from './production-ask-transport-ports';
import { createReferenceShadowArtifactWriter, ProductionAskArtifactWriterError } from './production-ask-artifact-writer';
import type { ReferenceShadowArtifactObservation } from './production-ask-artifact-writer';

type Fields = Record<string, unknown>;
type Call = (request: unknown) => unknown;
type Port = { receiver: object; methods: Readonly<Record<string, Call>> };
type Point = ShadowSideEffectReadbackRequest['point'];
const ZERO = ['graphCache', 'pointer', 'outbox', 'buildJob', 'neo4j', 'milvus', 'index', 'mode', 'traffic'] as const;
const ALLOWED = ['encryptedAudit', 'controlledTelemetry', 'modelBilling', 'equivalentOrdinaryCache'] as const;
const SERVING = ['servedEvidence', 'context', 'prompt', 'cacheIdentity'] as const;
const CODES = ['invalid-config', 'invalid-request', 'invalid-clock', 'invalid-key', 'invalid-readback', 'side-effect-mismatch',
  'operation-timeout', 'operation-failed', 'capacity-exhausted', 'execution-failed', 'busy', 'halted', 'already-executed'] as const;
type Code = typeof CODES[number];
type Phase = 'configuration' | 'clock' | 'readback' | 'archive' | 'transport' | 'comparison' | 'execution';
const mono = performance.now.bind(performance), apply = Reflect.apply;
const profile = Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const });
const errors = new WeakSet<object>(), hasError = WeakSet.prototype.has.bind(errors), addError = WeakSet.prototype.add.bind(errors);
export class ShadowSideEffectError extends Error {
  readonly code: Code; readonly phase: Phase; readonly pendingCompletionUnknown: boolean;
  readonly mutationMayHaveOccurred: boolean; readonly requestMayHaveBeenDispatched: boolean;
  readonly productionAccepted = false; readonly automaticRetryAllowed = false;
  constructor(code: Code, phase: Phase, pending = false, mutation = false, posted = false) {
    const safe = CODES.includes(code) ? code : 'operation-failed'; super('[shadow side effect] ' + phase + ': ' + safe);
    this.name = 'ShadowSideEffectError'; this.code = safe; this.phase = phase; this.pendingCompletionUnknown = pending;
    this.mutationMayHaveOccurred = mutation; this.requestMayHaveBeenDispatched = posted; addError(this); Object.freeze(this);
  }
}
interface Observation {
  readonly point: Point; readonly requestPlanHash: string | null; readonly stateHash: string; readonly rawSha256: string;
  readonly clockReadingHash: string; readonly recordHash: string;
  readonly archive: ReferenceShadowArtifactObservation;
}
interface CaseObservation {
  readonly phase: 'warmup' | 'trial'; readonly ordinal: number; readonly caseIndex: number; readonly mode: 'off' | 'shadow';
  readonly requestPlanHash: string; readonly requestBodySha256: string; readonly responseBodySha256: string;
  readonly fields: readonly { readonly field: typeof SERVING[number]; readonly sha256: string }[];
  readonly beforeHash: string; readonly afterHash: string; readonly recordHash: string;
}
interface PairedCase { readonly phase: 'warmup' | 'trial'; readonly ordinal: number; readonly caseIndex: number;
  readonly off: CaseObservation; readonly shadow: CaseObservation; readonly recordHash: string }
export interface ReferenceShadowSideEffectReport {
  readonly schemaVersion: 'kg-reference-shadow-side-effects/v1'; readonly classification: 'confidential';
  readonly sideEffectComparisonsComputed: true; readonly sideEffectPolicyVerified: false; readonly sourceAuthenticated: false;
  readonly machineGateComputed: false; readonly productionAccepted: false; readonly stageAcceptanceComplete: false;
  readonly rawReadbacksEncryptedAndMatched: true;
  readonly comparisonWindow: 'first-to-last-source-observation';
  readonly bindingHash: string; readonly providerRegistrationHash: string; readonly observationCount: number; readonly pairedCaseCount: number;
  readonly observations: readonly Observation[]; readonly pairedCases: readonly PairedCase[];
  readonly zeroMutationChecks: readonly { readonly field: typeof ZERO[number]; readonly delta: 0; readonly status: 'passed' }[];
  readonly servingChecks: readonly { readonly field: typeof SERVING[number]; readonly pairs: number; readonly status: 'passed' }[];
  readonly allowedEffectDeltas: Readonly<Record<typeof ALLOWED[number], number>>;
  readonly blockers: readonly string[]; readonly reportHash: string;
}
export interface ReferenceShadowSideEffectAskProof {
  readonly schemaVersion: 'kg-reference-shadow-side-effect-ask-run/v1'; readonly classification: 'confidential';
  readonly productionAccepted: false; readonly stageAcceptanceComplete: false; readonly machineGateComputed: false;
  readonly sideEffectPolicyVerified: false; readonly sourceAuthenticated: false;
  readonly run: ReferenceAskRunnerProof; readonly sideEffects: ReferenceShadowSideEffectReport; readonly proofHash: string;
}

/** Actual readback around the private complete sampler, not caller decisions.
 * Full state + monotonic mutation counts catch same-cardinality changes/ABA.
 * Readback bytes use the original separate readback-proof namespace. Matching
 * crypto/readback cannot certify source IAM or cache-equivalence semantics. */
export function createReferenceShadowSideEffectAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputPorts: unknown, ...extra: unknown[]) {
  let options: Fields, ask: Fields, artifacts: Fields, binding: ReturnType<typeof createReferenceProductionAskDatasetBinding>;
  let native: Port, clock: Port, readback: Port, rawPorts: Fields, registrationHash: string, actorId: string, timeout: number;
  let archiveKms: Port, archiveStore: Port;
  let roster: readonly string[];
  try {
    if (extra.length) throw new Error(); options = record(snapshot(inputOptions)); exact(options, ['executionProfile', 'askOptions', 'artifacts']);
    if (options.executionProfile !== 'local-reference') throw new Error(); ask = record(options.askOptions); artifacts = record(options.artifacts);
    binding = createReferenceProductionAskDatasetBinding(ask, actualDatasetJson);
    const manifest = record(ask.manifest), base = record(manifest.base); roster = record(base.dataset).roster as readonly string[];
    if (binding.planRequest({ caseId: roster[0], rolloutMode: 'off', phase: 'trial', ordinal: 0 }).requestPlan.stage !== 'T16') throw new Error();
    const effects = record(record(manifest.t16).sideEffectPolicy);
    const selected = (record(base.providers).bindings as Fields[]).find(p => p.purpose === 'publication-readback');
    const registration = (record(ask.deploymentPolicy).registrations as Fields[]).find(p => p.purpose === 'publication-readback' && p.providerId === effects.readbackProviderId);
    if (!selected || !registration) throw new Error();
    for (const key of ['providerId', 'adapterDigest', 'version', 'configHash']) same(selected[key], registration[key]);
    registrationHash = canonicalJsonSha256(registration); actorId = record(record(ask.expectedExecutionPayload).participants).readOnlyId as string;
    timeout = Math.min(integer(artifacts.operationTimeoutMs, 1, 60000), integer(record(registration.networkPolicy).requestTimeoutMs, 1, 285000));
    rawPorts = descriptors(inputPorts); exact(rawPorts, ['clock', 'kms', 'store', 'transport', 'readback']);
    native = capture(rawPorts.transport, ['readDeployment', 'post'], ['close']); clock = capture(rawPorts.clock, ['readTime'], ['advanceTo', 'setAvailability']);
    readback = capture(rawPorts.readback, ['readShadowState']);
    archiveKms = capture(rawPorts.kms, ['encryptArtifact', 'decryptArtifact'], ['rotateKey', 'revokeKey']);
    archiveStore = capture(rawPorts.store, ['sealEncryptedArtifact', 'readExact']);
  } catch { throw new ShadowSideEffectError('invalid-config', 'configuration'); }
  let phase: Phase = 'execution', closed = false, busy = false, used = false, transportClosed = false;
  let pending = 0, unknown = false, mutation = false, posted = false, last: AuthorityClockReading | null = null;
  let firstFault: ShadowSideEffectError | null = null;
  let archiveDeadline = Infinity, archivePort: Port;
  const budget = binding.bindingProof.resourceBudget, challenges = new Set<string>();
  const observations: Observation[] = [], pairs: PairedCase[] = [], offCases = new Map<string, CaseObservation>();
  let firstState: Fields | null = null, previousState: Fields | null = null, bytes = 0, nodes = 0;
  const fail = (code: Code, pendingUnknown = unknown || pending > 0) => {
    const error = new ShadowSideEffectError(code, phase, pendingUnknown, mutation, posted); firstFault ??= error; return error;
  };
  const assertOpen = () => { if (closed) throw fail('halted'); };
  let archiveParentGate: () => void = assertOpen;
  function nonce(): string { if (challenges.size >= 10000) throw fail('capacity-exhausted'); const value = randomBytes(16).toString('hex');
    if (challenges.has(value)) throw fail('invalid-readback'); challenges.add(value); return value; }
  function closeTransport() { if (!transportClosed) { transportClosed = true; if (native.methods.close) { try {
    const returned = apply(native.methods.close, native.receiver, []); if (returned !== undefined) attachProviderPromiseDrain(returned);
  } catch { /* Local fence is already established; no cancellation claim. */ } } } }
  async function invoke(port: Port, method: string, request: unknown, maximum: number, beforeDispatch: () => void = assertOpen): Promise<{ readonly value: unknown }> {
    assertOpen(); pending++;
    const result = await boundedAskRequestCall(() => { beforeDispatch(); return apply(port.methods[method], port.receiver, [request]); }, maximum);
    pending--; unknown ||= 'pendingCompletionUnknown' in result && result.pendingCompletionUnknown; assertOpen();
    // A private nested writer already classified its owned failure. Do not
    // replace that exact-readback/key/clock fault with this carrier observer's
    // generic rejection label; uncertainty has already been merged above.
    if (result.status !== 'fulfilled') throw firstFault ?? fail(result.status === 'timeout' ? 'operation-timeout' : 'operation-failed');
    return Object.freeze({ value: result.value });
  }
  async function observe(point: Point, request: ReferenceOwnedAskRequest | null, responseHash: string | null, postDeadline = Infinity): Promise<{ state: Fields; observation: Observation }> {
    const postGate = () => { assertOpen(); if (mono() >= postDeadline) throw fail('operation-timeout'); }; postGate();
    assertOpen(); phase = 'clock'; const clockRequest = freeze({ context: { executionProfile: 'local-reference', binding: binding.bindingProof.binding, actorId }, requestNonce: nonce() });
    const clockRequestedAt = mono();
    const actualClock = await invoke(clock, 'readTime', clockRequest, Math.min(timeout, Math.max(1, Math.floor(postDeadline - mono()))), postGate); postGate(); let reading: AuthorityClockReading;
    try { reading = validateAuthorityClockReading(snapshot(actualClock.value), { request: clockRequest, sourceIdentityRef: artifacts.clockIdentityRef,
      maxUncertaintyMs: artifacts.maxClockUncertaintyMs, previousReading: last }).reading;
      if (reading.assurance !== 'local-reference' || reading.productionTimeAuthenticated !== false) throw new Error(); last = reading;
    } catch { throw fail('invalid-clock'); }
    const execution = record(ask.expectedExecutionPayload), window = record(execution.window), at = Date.parse(reading.observedAt), started = mono();
    const validFrom = Math.max(Date.parse(window.startsAt as string), Date.parse(execution.notBefore as string));
    const validUntil = Math.min(Date.parse(window.endsAt as string), Date.parse(execution.expiresAt as string));
    const check = () => { postGate(); if (mono() - started >= timeout) throw fail('operation-timeout');
      if (at - reading.uncertaintyMs < validFrom
        // Include reading transit time in its conservative validity interval,
        // while keeping the separate clock/readback timeout budgets unchanged.
        || at + reading.uncertaintyMs + Math.max(0, mono() - clockRequestedAt) >= validUntil) throw fail('invalid-clock'); };
    check(); phase = 'readback';
    const selector: ShadowSideEffectReadbackRequest = freeze({ schemaVersion: 'kg-reference-shadow-state-request/v1', binding: binding.bindingProof.binding,
      actorId, authorizationDigest: record(ask.executionAuthorizationRef).sha256 as string, providerRegistrationHash: registrationHash,
      requestNonce: nonce(), observedAt: reading.observedAt, point, requestPlanHash: request?.requestPlan.planHash ?? null,
      requestBodySha256: request?.bodySha256 ?? null, responseBodySha256: responseHash });
    const actual = await invoke(readback, 'readShadowState', selector, Math.max(1, Math.floor(Math.min(timeout - (mono() - started), postDeadline - mono()))), check); check();
    let state: Fields;
    try {
      if (typeof actual.value !== 'string') throw new Error();
      if (Buffer.byteLength(actual.value) > budget.maxJsonBytes) throw fail('capacity-exhausted');
      bytes += Buffer.byteLength(actual.value); if (bytes > budget.maxJsonBytes) throw fail('capacity-exhausted');
      state = record(JSON.parse(actual.value)); exact(state, ['schemaVersion', 'requestNonce', 'requestHash', 'providerRegistrationHash', 'binding', 'observedAt', 'zeroMutation', 'allowedEffects', 'serving']);
      same(state.schemaVersion, 'kg-reference-shadow-state/v1'); same(state.requestNonce, selector.requestNonce); same(state.requestHash, canonicalJsonSha256(selector));
      same(state.providerRegistrationHash, registrationHash); same(state.binding, selector.binding); same(state.observedAt, selector.observedAt);
      const zero = record(state.zeroMutation), allowed = record(state.allowedEffects); exact(zero, ZERO); exact(allowed, ALLOWED);
      for (const field of ZERO) { const value = record(zero[field]); exact(value, ['mutationCount', 'state']); integer(value.mutationCount, 0, Number.MAX_SAFE_INTEGER); }
      for (const field of ALLOWED) integer(allowed[field], 0, Number.MAX_SAFE_INTEGER);
      if (point === 'post-after' && state.serving === null) throw new Error();
      if (state.serving !== null) { const served = record(state.serving); exact(served, ['requestPlanHash', 'requestBodySha256', 'responseBodySha256', ...SERVING]);
        for (const key of ['requestPlanHash', 'requestBodySha256', 'responseBodySha256']) hex(served[key]); }
      const hashed = fullHash(state, budget.maxJsonBytes, budget.maxNodes, check); nodes += hashed.nodes;
      if (nodes > budget.maxNodes) throw fail('capacity-exhausted'); freeze(state); check();
      phase = 'archive'; archiveDeadline = Math.min(postDeadline, started + timeout); archiveParentGate = check;
      const archived = await invoke(archivePort, 'sealReadback', JSON.stringify({ schemaVersion: 'kg-reference-shadow-artifact-payload/v1',
        observationIndex: observations.length, request: selector, payloadBase64url: Buffer.from(actual.value).toString('base64url') }),
        Math.max(1, Math.floor(archiveDeadline - mono())), check); check();
      const archive = archived.value as ReferenceShadowArtifactObservation;
      if (archive.bodySha256 !== sha(actual.value) || archive.readbackRequestHash !== canonicalJsonSha256(selector)
        || archive.observationIndex !== observations.length || archive.encryptedReadbackMatched !== true) throw fail('invalid-readback');
      const core = { point, requestPlanHash: selector.requestPlanHash, stateHash: hashed.sha256, rawSha256: sha(actual.value),
        clockReadingHash: canonicalJsonSha256(reading), archive };
      const observation = freeze({ ...core, recordHash: canonicalJsonSha256(core) }); observations.push(observation);
      phase = 'comparison';
      if (previousState) {
        for (const field of ZERO) if (fullHash(record(previousState.zeroMutation)[field], budget.maxJsonBytes, budget.maxNodes, check).sha256
          !== fullHash(zero[field], budget.maxJsonBytes, budget.maxNodes, check).sha256) throw fail('side-effect-mismatch');
        for (const field of ALLOWED) if ((allowed[field] as number) < (record(previousState.allowedEffects)[field] as number)) throw fail('side-effect-mismatch');
      }
      firstState ??= state; previousState = state; check(); return Object.freeze({ state, observation });
    } catch (error) { if (owned(error)) { firstFault ??= error; throw error; } throw fail('invalid-readback'); }
  }
  const transport = { ...profile,
    readDeployment: (request: unknown) => { assertOpen(); return apply(native.methods.readDeployment, native.receiver, [request]); },
    async post(request: ReferenceOwnedAskRequest): Promise<string> {
      // The parent's request budget includes our readback. A new full native
      // budget after synchronous/microtask work could dispatch after expiry.
      const postDeadline = mono() + request.requestPlan.target.networkPolicy.requestTimeoutMs;
      const postGate = () => { assertOpen(); if (mono() >= postDeadline) throw fail('operation-timeout'); };
      const before = await observe('post-before', request, null, postDeadline); postGate(); phase = 'transport';
      const remaining = Math.floor(postDeadline - mono()); if (remaining < 1) throw fail('operation-timeout');
      const raw = await invoke(native, 'post', request, remaining, () => { postGate(); posted = true; }); postGate();
      let responseHash: string;
      try { if (typeof raw.value !== 'string') throw new Error();
        // Keep the ORIGINAL producer's response limits, not the smaller state
        // budget. Guard before allocations and any additional readback IO.
        if (Buffer.byteLength(raw.value) > 24 * 1024 * 1024) throw fail('capacity-exhausted');
        const wire = record(JSON.parse(raw.value)); let responseNodes = 0;
        const visit = (value: unknown, depth: number) => { postGate(); if (++responseNodes > 200000 || depth > 64) throw fail('capacity-exhausted');
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
          if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1); };
        visit(wire, 0); const text = wire.bodyBase64url, maximum = Math.min(request.requestPlan.target.networkPolicy.maxResponseBytes, 16 * 1024 * 1024);
        if (typeof text !== 'string') throw new Error();
        if (text.length > 4 * Math.ceil(maximum / 3)) throw fail('capacity-exhausted');
        if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error(); postGate();
        const body = Buffer.from(text, 'base64url'); if (body.byteLength > maximum) throw fail('capacity-exhausted');
        if (body.toString('base64url') !== text) throw new Error(); responseHash = sha(body); postGate();
      } catch (error) { if (owned(error)) throw error; throw fail('invalid-readback'); }
      const after = await observe('post-after', request, responseHash, postDeadline); phase = 'comparison';
      const served = record(after.state.serving); for (const [key, expected] of Object.entries({ requestPlanHash: request.requestPlan.planHash,
        requestBodySha256: request.bodySha256, responseBodySha256: responseHash })) if (served[key] !== expected) throw fail('invalid-readback');
      const identity = request.requestPlan.requestIdentity, caseIndex = roster.indexOf(identity.caseId);
      if (caseIndex < 0 || identity.rolloutMode === 'active') throw fail('invalid-readback');
      const fields = SERVING.map(field => ({ field, sha256: fullHash(served[field], budget.maxJsonBytes, budget.maxNodes, postGate).sha256 }));
      const core = { phase: identity.phase, ordinal: identity.ordinal, caseIndex, mode: identity.rolloutMode,
        requestPlanHash: request.requestPlan.planHash, requestBodySha256: request.bodySha256, responseBodySha256: responseHash, fields,
        beforeHash: before.observation.recordHash, afterHash: after.observation.recordHash };
      const current: CaseObservation = freeze({ ...core, recordHash: canonicalJsonSha256(core) }), key = identity.phase + ':' + identity.ordinal + ':' + caseIndex;
      if (identity.rolloutMode === 'off') { if (offCases.has(key)) throw fail('invalid-readback'); offCases.set(key, current); }
      else { const off = offCases.get(key); if (!off || off.requestBodySha256 !== current.requestBodySha256) throw fail('invalid-readback');
        for (let i = 0; i < SERVING.length; i++) if (off.fields[i].sha256 !== current.fields[i].sha256) throw fail('side-effect-mismatch');
        const pair = { phase: identity.phase, ordinal: identity.ordinal, caseIndex, off, shadow: current };
        pairs.push(freeze({ ...pair, recordHash: canonicalJsonSha256({ phase: pair.phase, ordinal: pair.ordinal, caseIndex, off: off.recordHash, shadow: current.recordHash }) })); }
      postGate(); return raw.value as string;
    }, close: closeTransport };
  // Every PRIVATE writer callback rechecks the parent budget in the same
  // stack, including callbacks settling after outer timeout/close. An inner
  // artifact budget cannot grant more time than the actual POST/readback.
  // A fresh reference timestamp is not a new authorization window. Include
  // the source reading's uncertainty + elapsed time in EVERY raw dispatch,
  // not only after an entire archive has already written its audit objects.
  const archiveGate = () => { assertOpen(); archiveParentGate(); if (mono() >= archiveDeadline) throw fail('operation-timeout'); };
  const archiveForward = (port: Port, method: string, mayMutate = false) => (request: unknown) => {
    archiveGate(); if (mayMutate) mutation = true; return apply(port.methods[method], port.receiver, [request]);
  };
  let archiveWriter: ReturnType<typeof createReferenceShadowArtifactWriter>;
  let sampler: ReturnType<typeof createReferenceProductionAskRunner>;
  try {
    archiveWriter = createReferenceShadowArtifactWriter(options, actualDatasetJson, {
      clock: { ...profile, readTime: archiveForward(clock, 'readTime') },
      kms: { ...profile, encryptArtifact: archiveForward(archiveKms, 'encryptArtifact', true), decryptArtifact: archiveForward(archiveKms, 'decryptArtifact') },
      store: { ...profile, sealEncryptedArtifact: archiveForward(archiveStore, 'sealEncryptedArtifact', true), readExact: archiveForward(archiveStore, 'readExact') } });
    archivePort = Object.freeze({ receiver: archiveWriter, methods: Object.freeze({ async sealReadback(input: unknown) {
      try { return await archiveWriter.sealReadback(input); }
      catch (error) {
        if (error instanceof ProductionAskArtifactWriterError) {
          unknown ||= error.pendingCompletionUnknown; mutation ||= error.mutationMayHaveOccurred;
          const code = CODES.includes(error.code as Code) ? error.code as Code : 'operation-failed';
          firstFault ??= new ShadowSideEffectError(code, 'archive', unknown, mutation, posted);
        }
        throw error;
      }
    } }) });
  } catch { throw new ShadowSideEffectError('invalid-config', 'configuration'); }
  try { sampler = createReferenceProductionAskRunner(options, actualDatasetJson, { clock: rawPorts.clock, kms: rawPorts.kms, store: rawPorts.store, transport }); }
  catch { throw new ShadowSideEffectError('invalid-config', 'configuration'); }
  return Object.freeze({ ...profile,
    close(): void { closed = true; unknown ||= pending > 0; sampler.close(); archiveWriter.close(); closeTransport(); },
    async run(input: unknown, ...extras: unknown[]): Promise<ReferenceShadowSideEffectAskProof> {
      assertOpen(); if (busy) throw new ShadowSideEffectError('busy', phase, unknown || pending > 0, mutation, posted); if (used) throw fail('already-executed');
      try { if (extras.length) throw new Error(); exact(record(snapshot(input)), []); } catch { throw fail('invalid-request', false); }
      busy = true; used = true; firstFault = null;
      try {
        await observe('run-before', null, null); assertOpen(); phase = 'execution'; mutation = true;
        const run = await sampler.run({}); assertOpen(); await observe('run-after', null, null); assertOpen(); phase = 'comparison';
        if (!firstState || !previousState || observations.length !== 2 + 2 * run.transportCalls || pairs.length !== run.transportCalls / 2) throw fail('invalid-readback');
        const core: Omit<ReferenceShadowSideEffectReport, 'reportHash'> = { schemaVersion: 'kg-reference-shadow-side-effects/v1', classification: 'confidential',
          sideEffectComparisonsComputed: true, sideEffectPolicyVerified: false, sourceAuthenticated: false, machineGateComputed: false, productionAccepted: false,
          rawReadbacksEncryptedAndMatched: true,
          comparisonWindow: 'first-to-last-source-observation',
          stageAcceptanceComplete: false, bindingHash: binding.bindingProof.bindingHash, providerRegistrationHash: registrationHash,
          observationCount: observations.length, pairedCaseCount: pairs.length, observations, pairedCases: pairs,
          zeroMutationChecks: ZERO.map(field => ({ field, delta: 0, status: 'passed' })), servingChecks: SERVING.map(field => ({ field, pairs: pairs.length, status: 'passed' })),
          allowedEffectDeltas: Object.fromEntries(ALLOWED.map(field => [field, (record(previousState!.allowedEffects)[field] as number) - (record(firstState!.allowedEffects)[field] as number)])) as Record<typeof ALLOWED[number], number>,
          blockers: ['source-iam-and-authentication-unverified', 'ordinary-cache-equivalence-definition-unavailable'] };
        const sideEffects = freeze({ ...core, reportHash: canonicalJsonSha256({ ...core, observations: roots('observations', observations.map(o => o.recordHash)), pairedCases: roots('pairs', pairs.map(p => p.recordHash)) }) });
        const proof = freeze({ schemaVersion: 'kg-reference-shadow-side-effect-ask-run/v1' as const, classification: 'confidential' as const,
          productionAccepted: false as const, stageAcceptanceComplete: false as const, machineGateComputed: false as const, sideEffectPolicyVerified: false as const,
          sourceAuthenticated: false as const, run, sideEffects, proofHash: canonicalJsonSha256({ run: run.proofHash, sideEffects: sideEffects.reportHash }) });
        fullHash(proof, budget.maxJsonBytes, budget.maxNodes, assertOpen); return proof;
      } catch (error) {
        closed = true; if (error instanceof ProductionAskRunnerError) { unknown ||= error.pendingCompletionUnknown; mutation ||= error.mutationMayHaveOccurred; posted ||= error.requestMayHaveBeenDispatched; }
        const known = owned(error) ? error : firstFault;
        if (known) throw new ShadowSideEffectError(known.code, known.phase, unknown || known.pendingCompletionUnknown, mutation || known.mutationMayHaveOccurred, posted || known.requestMayHaveBeenDispatched);
        throw fail('execution-failed', true);
      } finally { busy = false; sampler.close(); archiveWriter.close(); closeTransport(); }
    } });
}
function owned(input: unknown): input is ShadowSideEffectError { return input !== null && typeof input === 'object' && hasError(input); }
function record(input: unknown): Fields { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, keys: readonly string[]) { if (Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new Error(); }
function integer(input: unknown, min: number, max: number): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); return input; }
function hex(input: unknown): void { if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new Error(); }
function same(a: unknown, b: unknown) { if (canonicalJson(a) !== canonicalJson(b)) throw new Error(); }
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function freeze<T>(input: T): T { if (input && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input); } return input; }
function sha(input: string | Buffer): string { return createHash('sha256').update(input).digest('hex'); }
function descriptors(input: unknown): Fields {
  if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
  const fields: Fields = Object.create(null); for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') throw new Error(); const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(); fields[key] = descriptor.value;
  } return fields;
}
function capture(input: unknown, names: readonly string[], optional: readonly string[] = []): Port {
  const fields = descriptors(input); if (fields.executionProfile !== 'local-reference' || fields.productionCapable !== false) throw new Error();
  if (Object.keys(fields).some(k => !['executionProfile', 'productionCapable', ...names, ...optional].includes(k))) throw new Error();
  const methods: Record<string, Call> = {}; for (const key of [...names, ...optional]) {
    if (!Object.hasOwn(fields, key) && optional.includes(key)) continue;
    if (typeof fields[key] !== 'function' || types.isProxy(fields[key])) throw new Error(); methods[key] = fields[key] as Call;
  } return Object.freeze({ receiver: input as object, methods: Object.freeze(methods) });
}
function roots(domain: string, values: readonly string[]): string { const h = createHash('sha256').update('kg-shadow-effects/' + domain + '/v1\0' + values.length + '\0');
  values.forEach(v => h.update(v)); return h.digest('hex'); }
/** Parsed full state uses the original raw-data resource profile, NOT the
 * 256KiB control-object ceiling. No truncation or caller resource overrides. */
function fullHash(input: unknown, maxBytes: number, maxNodes: number, check: () => void): { sha256: string; nodes: number } {
  const h = createHash('sha256'); let bytes = 0, nodes = 0;
  const add = (text: string) => { check(); bytes += Buffer.byteLength(text); if (bytes > maxBytes) throw new ShadowSideEffectError('capacity-exhausted', 'readback'); h.update(text); };
  const string = (text: string) => { for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) {
    const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(); } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(); } return JSON.stringify(text); };
  const visit = (v: unknown, depth: number) => { check(); if (++nodes > maxNodes || depth > 64) throw new ShadowSideEffectError('capacity-exhausted', 'readback');
    if (typeof v === 'string') { add(string(v)); return; } if (v === null || typeof v !== 'object') { add(canonicalJson(v)); return; }
    if (types.isProxy(v)) throw new Error(); if (Array.isArray(v)) { add('['); v.forEach((child, i) => { if (i) add(','); visit(child, depth + 1); }); add(']'); }
    else { add('{'); Object.keys(v).sort().forEach((k, i) => { if (i) add(','); add(string(k)); add(':'); visit((v as Fields)[k], depth + 1); }); add('}'); }
  }; visit(input, 0); check(); return { sha256: h.digest('hex'), nodes };
}
