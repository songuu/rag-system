import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { attachProviderPromiseDrain, boundedProviderCall } from './bounded-provider-call';
import type { BoundedProviderObservation } from './bounded-provider-call';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import { createReferenceProductionAskRunner, ProductionAskRunnerError } from './production-ask-runner';
import type { ReferenceAskRunnerProof } from './production-ask-runner';
import { createReferenceShadowSideEffectAskRunner, ShadowSideEffectError } from './production-shadow-side-effects';
import type { ReferenceShadowSideEffectReport } from './production-shadow-side-effects';
import { createReferenceAskHttpsTransport, ProductionAskHttpsTransportError } from './production-ask-https-transport';
import { createReferenceAuthorizationSignatureVerifier, validateAuthorizationEnvelope } from './production-authorization';
import type { ExecutionAuthorizationPayload } from './production-authorization';
import { createReferenceAuthorityApprovalVerifier, AuthorityApprovalError } from './production-authority-approval';
import type { NonceOutcome } from './production-authority-approval';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import { createReferenceProviderEvidenceVerifier, ProviderEvidenceError } from './production-provider-evidence';
import type { ProviderEvidenceReadbackDecision, ProviderEvidenceObject } from './production-provider-evidence';
import { createReferenceProviderTrustVerifier } from './production-provider-trust';

type Fields = Record<string, unknown>;
type Call = (input: unknown) => unknown;
type Port = { readonly receiver: object; readonly methods: Readonly<Record<string, Call>> };
type Phase = 'configuration' | 'preflight' | 'approval' | 'evidence' | 'clock' | 'artifact' | 'transport' | 'evaluation' | 'readback' | 'comparison';
const CODES = ['invalid-config', 'invalid-request', 'busy', 'halted', 'already-executed', 'approval-failed', 'evidence-failed',
  'clock-failed', 'operation-failed', 'operation-timeout', 'execution-failed', 'capacity-exhausted', 'side-effect-failed'] as const;
type Code = typeof CODES[number];
const mono = performance.now.bind(performance), apply = Reflect.apply;
const profile = Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const });
export class AuthorityAskRunnerError extends Error {
  readonly code: Code; readonly phase: Phase; readonly nonceOutcome: NonceOutcome;
  readonly pendingCompletionUnknown: boolean; readonly mutationMayHaveOccurred: boolean; readonly requestMayHaveBeenDispatched: boolean;
  readonly productionAccepted = false; readonly automaticRetryAllowed = false;
  constructor(code: Code, phase: Phase, nonce: NonceOutcome = 'not-attempted', pending = false, mutation = false, posted = false) {
    const safe = CODES.includes(code) ? code : 'execution-failed'; super('[authority Ask runner] ' + phase + ': ' + safe);
    this.name = 'AuthorityAskRunnerError'; this.code = safe; this.phase = phase; this.nonceOutcome = nonce;
    this.pendingCompletionUnknown = pending; this.mutationMayHaveOccurred = mutation; this.requestMayHaveBeenDispatched = posted; Object.freeze(this);
  }
}
export interface ReferenceAuthorityAskRunProof {
  readonly schemaVersion: 'kg-reference-authority-ask-run/v1'; readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-authority-native-paired-consumption';
  readonly productionAccepted: false; readonly stageAcceptanceComplete: false; readonly executionAuthorized: false;
  readonly registryAuthenticated: false; readonly sourceAuthenticated: false; readonly machineGateComputed: false;
  readonly executionSignatureVerified: true; readonly executionNonceConsumed: true;
  readonly approvalDecisionHash: string; readonly nonceClaimRef: { readonly objectId: string; readonly objectVersion: string; readonly sha256: string };
  readonly checkpoints: readonly ProviderEvidenceReadbackDecision[]; readonly run: ReferenceAskRunnerProof; readonly proofHash: string;
}
export interface ReferenceAuthorityShadowCheckpoint extends Omit<ProviderEvidenceReadbackDecision, 'providers'> {
  readonly providerSetIndex: number;
}
export interface ReferenceAuthorityShadowAskRunProof extends Omit<ReferenceAuthorityAskRunProof, 'schemaVersion' | 'validationLevel' | 'checkpoints'> {
  readonly schemaVersion: 'kg-reference-authority-shadow-ask-run/v1';
  readonly validationLevel: 'local-reference-authority-native-shadow-consumption';
  readonly sideEffectPolicyVerified: false;
  readonly checkpointProviderSets: readonly ProviderEvidenceReadbackDecision['providers'][];
  readonly checkpoints: readonly ReferenceAuthorityShadowCheckpoint[];
  readonly sideEffects: ReferenceShadowSideEffectReport;
}
interface AuthorityRunner<Proof> {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  readonly close: () => void;
  readonly run: (input: unknown, ...extra: unknown[]) => Promise<Proof>;
}

/** Actual local authority -> private native HTTPS -> private complete sampler.
 * A real signature/nonce/readback is not enterprise IAM, online revocation or
 * source authentication. All reference/production boundaries remain false. */
export function createReferenceAuthorityAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputNetwork: unknown,
  inputPorts: unknown, ...extras: unknown[]) {
  return createAuthorityAskRunner(inputOptions, actualDatasetJson, inputNetwork, inputPorts, false, extras);
}

/** One authority-owned T16 execution, not independently produced reports joined
 * by matching hashes. The private Shadow facade retains its full-byte archive,
 * original sampler and explicit unverified IAM/cache-equivalence blockers. */
export function createReferenceAuthorityShadowAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputNetwork: unknown,
  inputPorts: unknown, ...extras: unknown[]) {
  return createAuthorityAskRunner(inputOptions, actualDatasetJson, inputNetwork, inputPorts, true, extras);
}

function createAuthorityAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputNetwork: unknown,
  inputPorts: unknown, shadow: false, extras: unknown[]): AuthorityRunner<ReferenceAuthorityAskRunProof>;
function createAuthorityAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputNetwork: unknown,
  inputPorts: unknown, shadow: true, extras: unknown[]): AuthorityRunner<ReferenceAuthorityShadowAskRunProof>;
function createAuthorityAskRunner(inputOptions: unknown, actualDatasetJson: unknown, inputNetwork: unknown,
  inputPorts: unknown, shadow: boolean, extras: unknown[]): AuthorityRunner<ReferenceAuthorityAskRunProof | ReferenceAuthorityShadowAskRunProof> {
  let base: Fields, authority: Fields, approvalOptions: Fields, evidenceOptions: Fields, selection: Fields;
  let expected: ExecutionAuthorizationPayload, envelope: ReturnType<typeof validateAuthorizationEnvelope>['envelope'];
  let binding: ReturnType<typeof createReferenceProductionAskDatasetBinding>, signature: ReturnType<typeof createReferenceAuthorizationSignatureVerifier>;
  let raw: Record<string, Port>, timeout: number;
  try {
    if (extras.length) throw new Error(); const options = record(snapshot(inputOptions));
    exact(options, ['executionProfile', 'askOptions', 'artifacts', 'authority']); if (options.executionProfile !== 'local-reference') throw new Error();
    base = freeze({ executionProfile: options.executionProfile, askOptions: options.askOptions, artifacts: options.artifacts });
    const ask = record(base.askOptions), artifacts = record(base.artifacts);
    binding = createReferenceProductionAskDatasetBinding(ask, actualDatasetJson);
    authority = record(options.authority); exact(authority, ['executionEnvelope', 'approvalOptions', 'evidenceOptions']);
    envelope = validateAuthorizationEnvelope(authority.executionEnvelope).envelope;
    if (envelope.kind !== 'execution') throw new Error(); expected = envelope.payload;
    if (shadow && expected.stage !== 'T16') throw new Error();
    same(expected, ask.expectedExecutionPayload); same(canonicalJsonSha256(envelope), record(ask.executionAuthorizationRef).sha256);
    approvalOptions = record(authority.approvalOptions); evidenceOptions = record(authority.evidenceOptions);
    same(approvalOptions.scope, expected.scope); same(approvalOptions.actors, { verifierId: expected.participants.executorId, readOnlyId: expected.participants.readOnlyId });
    same(evidenceOptions.scope, expected.scope); same(evidenceOptions.registryRef, ask.policyRef);
    same(evidenceOptions.readerId, expected.participants.readOnlyId); same(evidenceOptions.readerAuthorizationDigest, record(ask.executionAuthorizationRef).sha256);
    for (const config of [approvalOptions, evidenceOptions]) same(config.clockIdentityRef, artifacts.clockIdentityRef);
    same(evidenceOptions.observationWindow, expected.window);
    selection = freeze({ stage: expected.stage, scope: expected.scope, runNonce: expected.runNonce, manifestHash: expected.manifestHash,
      providers: record(record(ask.manifest).base).providers, executionProvidersHash: expected.providersHash });
    same(evidenceOptions.expectedSelection, selection);
    signature = createReferenceAuthorizationSignatureVerifier({ executionProfile: 'local-reference', keys: approvalOptions.keys });
    signature.verifySignature({ envelope, expectedPayload: expected, observedAt: expected.notBefore });
    const portNames = ['clock', 'kms', 'store', 'secret', 'deployment', 'measurement', 'registry', 'evidence', 'nonceStore', ...(shadow ? ['readback'] : [])];
    const ports = descriptors(inputPorts, portNames); exact(ports, portNames);
    const methods: Record<string, readonly string[]> = { clock: ['readTime'], kms: ['encryptArtifact', 'decryptArtifact'], store: ['sealEncryptedArtifact', 'readExact'],
      secret: ['readAskCredential'], deployment: ['readDeployment'], measurement: ['readMeasurement'], registry: ['readExactPolicy'],
      evidence: ['readExactConformance', 'readRuntimeMeasurement'], nonceStore: ['consumeAuthorizationNonce', 'readExactNonceClaim'] };
    if (shadow) methods.readback = ['readShadowState'];
    raw = Object.fromEntries(Object.entries(methods)
      .map(([name, methods]) => [name, capture(ports[name], methods, name === 'clock' ? ['advanceTo', 'setAvailability'] : [])]));
    timeout = Math.min(approvalOptions.operationTimeoutMs as number, evidenceOptions.operationTimeoutMs as number, artifacts.operationTimeoutMs as number);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error();
  } catch { throw new AuthorityAskRunnerError('invalid-config', 'configuration'); }
  let phase: Phase = 'preflight', closed = false, busy = false, used = false, armed = false, checking = false;
  let nonceOutcome: NonceOutcome = 'not-attempted', mutation = false, posted = false, unknown = false, pending = 0;
  let last: AuthorityClockReading | null = null, lastMono = -Infinity, fault: AuthorityAskRunnerError | null = null;
  let trustedUntil = -Infinity;
  const actorReadings = new Map<string, AuthorityClockReading>(), clockChallenges = new Set<string>(), checkpoints: ProviderEvidenceReadbackDecision[] = [];
  const shadowCheckpoints: ReferenceAuthorityShadowCheckpoint[] = [];
  const checkpointProviderSets: ProviderEvidenceReadbackDecision['providers'][] = [], providerSetIndices = new Map<string, number>();
  let checkpointBytes = shadow ? Buffer.byteLength('{"checkpointProviderSets":[],"checkpoints":[]}') : 2, checkpointNodes = shadow ? 3 : 1;
  let activeSources: { conformanceObjects: ProviderEvidenceObject[]; runtimeObjects: ProviderEvidenceObject[] } | null = null;
  let stagedSources = { conformanceObjects: [] as ProviderEvidenceObject[], runtimeObjects: [] as ProviderEvidenceObject[] };
  let stopReject: ((error: AuthorityAskRunnerError) => void) | null = null;
  const fail = (code: Code, pendingUnknown = unknown || pending > 0) => new AuthorityAskRunnerError(code, phase, nonceOutcome, unknown || pendingUnknown, mutation, posted);
  const assertOpen = () => { if (closed) throw fail('halted'); };
  async function settle(observation: Promise<BoundedProviderObservation>, alreadyDispatched = false, shadowState = false): Promise<unknown> {
    const result = await observation;
    // A skipped observation callback says nothing about the already-issued raw
    // work. Drain attachment alone cannot authenticate its completion.
    pending--; if (result.status === 'timeout' || result.status === 'invalid-return') unknown ||= alreadyDispatched || result.pendingCompletionUnknown;
    assertOpen();
    if (result.status !== 'fulfilled') { fault = fail(result.status === 'timeout' ? 'operation-timeout' : 'operation-failed'); throw fault; }
    if (shadowState) {
      // This one private source carries raw state, not a small control object.
      // Primitive-only handoff cannot adopt an attacker-supplied then getter;
      // the existing facade owns full parsing, node/depth limits and encryption.
      if (typeof result.value !== 'string') { fault = fail('operation-failed', false); throw fault; }
      if (Buffer.byteLength(result.value) > binding.bindingProof.resourceBudget.maxJsonBytes) { fault = fail('capacity-exhausted', false); throw fault; }
      return result.value;
    }
    try {
      // A native Promise payload must not be adopted by our own async return.
      // Only detached JSON/primitive data crosses to the original consumers.
      return snapshot(result.value);
    } catch { fault = fail('operation-failed', false); throw fault; }
  }
  function observe(port: Port, method: string, input: unknown): Promise<unknown> {
    assertOpen(); pending++;
    return settle(boundedProviderCall(() => { assertOpen(); return apply(port.methods[method], port.receiver, [input]); }, timeout));
  }
  function dispatch(port: Port, method: string, input: unknown, shadowState = false): Promise<unknown> {
    // The original owner's absolute-deadline/peer gate just ran on this stack.
    // Start the raw operation synchronously, and drain its return immediately;
    // a second BPC callback must never defer the actual business dispatch.
    dispatchLive(); const started = mono(); pending++; let returned: unknown;
    try { returned = apply(port.methods[method], port.receiver, [input]); }
    catch { pending--; fault = fail('operation-failed', false); throw fault; }
    if (attachProviderPromiseDrain(returned).status !== 'attached') {
      pending--; unknown = true; fault = fail('operation-failed'); throw fault;
    }
    const remaining = Math.floor(timeout - (mono() - started));
    if (remaining < 1) { pending--; unknown = true; fault = fail('operation-timeout'); throw fault; }
    // Only the already-drained return is observed later. The local observation
    // budget includes synchronous dispatch time; the owner's budget is intact.
    return settle(boundedProviderCall(() => returned, remaining), true, shadowState);
  }
  function live(): void {
    assertOpen(); if (!last) throw fail('clock-failed');
    const at = Date.parse(last.observedAt), elapsed = Math.max(0, mono() - lastMono);
    try {
      // Both edges belong to this one ordered interval. Reuse only its detached
      // configuration, not a prior successful decision or another clock's state.
      const trust = activeSources && !checking ? createReferenceProviderTrustVerifier({ executionProfile: 'local-reference',
        policy: record(base.askOptions).deploymentPolicy, policyRef: evidenceOptions.registryRef, authorityKeys: evidenceOptions.authorityKeys }) : null;
      for (const value of [at - last.uncertaintyMs, at + last.uncertaintyMs + elapsed]) {
        if (value < Date.parse(expected.window.startsAt) || value >= Date.parse(expected.window.endsAt)) throw new Error();
        const observedAt = new Date(value).toISOString(); signature.verifySignature({ envelope, expectedPayload: expected, observedAt });
        if (trust && activeSources) trust.verifySelection({ ...selection, observedAt, ...activeSources });
      }
      if (activeSources && !checking) {
        const keyExpiry = (keys: unknown, signer: Fields) => Date.parse(record((keys as Fields[])
          .find(key => key.keyId === signer.keyId && key.keyVersion === signer.keyVersion)).validUntil as string);
        trustedUntil = Math.min(Date.parse(expected.window.endsAt), Date.parse(expected.expiresAt),
          keyExpiry(approvalOptions.keys, record(envelope.signature)),
          Date.parse(record(record(base.askOptions).deploymentPolicy).validUntil as string),
          ...[...activeSources.conformanceObjects, ...activeSources.runtimeObjects].flatMap(object => {
            const attestation = record(object.attestation);
            return [Date.parse(record(attestation.body).expiresAt as string), keyExpiry(evidenceOptions.authorityKeys, record(attestation.signature))];
          }));
        if (!Number.isFinite(trustedUntil)) throw new Error();
      }
    } catch { fault = fail('clock-failed', false); throw fault; }
  }
  function dispatchLive(): void {
    assertOpen(); if (!armed) throw fail('approval-failed');
    // Crypto and complete source readbacks finish inside the owner's fresh-clock
    // await. This cheap immutable expiry fence adds neither IO nor an await after
    // the owner's absolute deadline/peer gate. It is not online revocation.
    if (!last || Date.parse(last.observedAt) + last.uncertaintyMs + Math.max(0, mono() - lastMono) >= trustedUntil) throw fail('clock-failed', false);
  }
  async function readTime(input: unknown): Promise<AuthorityClockReading> {
    // The original writer/native owner rechecks its absolute deadline after this
    // await. Never move a checkpoint into its final business dispatch callback.
    if (armed && !checking) await checkpoint();
    phase = 'clock'; const request = snapshot(input), actor = record(record(request).context).actorId as string;
    const value = await observe(raw.clock, 'readTime', request);
    try {
      const reading = validateAuthorityClockReading(value, { request, sourceIdentityRef: approvalOptions.clockIdentityRef,
        maxUncertaintyMs: Math.min(approvalOptions.maxClockUncertaintyMs as number, evidenceOptions.maxClockUncertaintyMs as number,
          record(base.artifacts).maxClockUncertaintyMs as number), previousReading: actorReadings.get(actor) ?? null }).reading;
      if (reading.assurance !== 'local-reference' || reading.productionTimeAuthenticated !== false
        || last && (reading.sequence <= last.sequence || Date.parse(reading.observedAt) < Date.parse(last.observedAt))
        || clockChallenges.has(reading.requestNonce) || clockChallenges.size >= 10000) throw new Error();
      clockChallenges.add(reading.requestNonce); actorReadings.set(actor, reading); last = reading; lastMono = mono(); live(); return reading;
    } catch (error) { fault = error instanceof AuthorityAskRunnerError ? error : fail('clock-failed', false); throw fault; }
  }
  const clock = freeze({ ...profile, readTime });
  let evidence: ReturnType<typeof createReferenceProviderEvidenceVerifier>, approval: ReturnType<typeof createReferenceAuthorityApprovalVerifier>;
  let client: ReturnType<typeof createReferenceAskHttpsTransport>;
  let sampler: ReturnType<typeof createReferenceProductionAskRunner> | ReturnType<typeof createReferenceShadowSideEffectAskRunner>;
  async function checkpoint() {
    assertOpen(); if (checking) throw fail('busy'); phase = 'evidence'; checking = true;
    stagedSources = { conformanceObjects: [], runtimeObjects: [] };
    try {
      const result = await evidence.verifySelection({}); assertOpen();
      const budget = binding.bindingProof.resourceBudget;
      let compact: ReferenceAuthorityShadowCheckpoint | null = null, providerKey: string | null = null;
      let addedProviderBytes = 0, addedProviderNodes = 0;
      if (shadow) {
        // This is lossless representation, not successful-checkpoint caching:
        // every fresh decision keeps its own full hash and all changing fields.
        // Intern only byte-identical detached provider tables, retaining every
        // field needed to reconstruct and independently hash the full decision.
        const { providers, ...fields } = result;
        const key = canonicalJson(providers), found = providerSetIndices.get(key);
        compact = freeze({ ...fields, providerSetIndex: found ?? checkpointProviderSets.length });
        if (found === undefined) {
          providerKey = key; addedProviderBytes = Buffer.byteLength(JSON.stringify(providers)) + (checkpointProviderSets.length ? 1 : 0);
          addedProviderNodes = nodeCount(providers);
        }
      }
      // Each complete result is detached/frozen by the private verifier. Count
      // the exact array brackets, commas and value nodes once, without rescanning
      // every earlier checkpoint; the final whole-proof budget remains separate.
      const stored = compact ?? result;
      const bytes = checkpointBytes + Buffer.byteLength(JSON.stringify(stored)) + ((shadow ? shadowCheckpoints.length : checkpoints.length) ? 1 : 0) + addedProviderBytes;
      const nodes = checkpointNodes + nodeCount(stored) + addedProviderNodes;
      if (bytes > budget.maxJsonBytes || nodes > budget.maxNodes) throw fail('capacity-exhausted');
      if (compact) {
        if (providerKey !== null) { providerSetIndices.set(providerKey, checkpointProviderSets.length); checkpointProviderSets.push(result.providers); }
        shadowCheckpoints.push(compact);
      } else checkpoints.push(result);
      checkpointBytes = bytes; checkpointNodes = nodes; activeSources = stagedSources;
    } catch (error) {
      if (error instanceof AuthorityAskRunnerError) fault ??= error;
      if (!fault) fault = fail(error instanceof ProviderEvidenceError && error.pendingCompletionUnknown ? 'operation-timeout' : 'evidence-failed',
        unknown || error instanceof ProviderEvidenceError && error.pendingCompletionUnknown);
      throw fault;
    } finally { checking = false; }
  }
  function artifact(port: Port, method: string, input: unknown, write: boolean) {
    dispatchLive(); phase = 'artifact'; if (write) mutation = true;
    return dispatch(port, method, input);
  }
  try {
    evidence = createReferenceProviderEvidenceVerifier(evidenceOptions, { clock,
      registry: { ...profile, readExactPolicy: (input: unknown) => { phase = 'evidence'; return observe(raw.registry, 'readExactPolicy', input); } },
      evidence: { ...profile,
        async readExactConformance(input: unknown) { phase = 'evidence'; const value = await observe(raw.evidence, 'readExactConformance', input);
          stagedSources.conformanceObjects.push(record(value).object as ProviderEvidenceObject); return value; },
        async readRuntimeMeasurement(input: unknown) { phase = 'evidence'; const value = await observe(raw.evidence, 'readRuntimeMeasurement', input);
          stagedSources.runtimeObjects.push(record(value).object as ProviderEvidenceObject); return value; } } });
    approval = createReferenceAuthorityApprovalVerifier(approvalOptions, { clock, nonceStore: { ...profile,
      consumeAuthorizationNonce(input: unknown) { assertOpen(); phase = 'approval'; nonceOutcome = 'unknown'; mutation = true;
        return observe(raw.nonceStore, 'consumeAuthorizationNonce', input); },
      readExactNonceClaim(input: unknown) { phase = 'approval'; return observe(raw.nonceStore, 'readExactNonceClaim', input); } } });
    client = createReferenceAskHttpsTransport(base, actualDatasetJson, inputNetwork, { clock,
      secret: { ...profile, readAskCredential(input: unknown) { dispatchLive();
        // No authority await is inserted after native peerGate and before the
        // actual Secret dispatch. Fresh-clock crypto checks finish beforehand.
        return dispatch(raw.secret, 'readAskCredential', input); } },
      deployment: { ...profile, readDeployment: (input: unknown) => dispatch(raw.deployment, 'readDeployment', input) },
      measurement: { ...profile, readMeasurement(input: unknown) { dispatchLive(); return dispatch(raw.measurement, 'readMeasurement', input); } } });
    const samplerPorts = { clock,
      kms: { ...profile, encryptArtifact: (input: unknown) => artifact(raw.kms, 'encryptArtifact', input, true), decryptArtifact: (input: unknown) => artifact(raw.kms, 'decryptArtifact', input, false) },
      store: { ...profile, sealEncryptedArtifact: (input: unknown) => artifact(raw.store, 'sealEncryptedArtifact', input, true), readExact: (input: unknown) => artifact(raw.store, 'readExact', input, false) },
      transport: { ...profile, close() { client.close(); },
        readDeployment(input: Parameters<typeof client.readDeployment>[0]) { assertOpen(); if (!armed) throw fail('approval-failed'); phase = 'transport'; return client.readDeployment(input); },
        post(input: Parameters<typeof client.post>[0]) { assertOpen(); if (!armed) throw fail('approval-failed'); phase = 'transport'; posted = true; return client.post(input); } } };
    sampler = shadow ? createReferenceShadowSideEffectAskRunner(base, actualDatasetJson, { ...samplerPorts,
      readback: { ...profile, readShadowState(input: unknown) { dispatchLive(); phase = 'readback'; return dispatch(raw.readback, 'readShadowState', input, true); } } })
      : createReferenceProductionAskRunner(base, actualDatasetJson, samplerPorts);
  } catch { throw new AuthorityAskRunnerError('invalid-config', 'configuration'); }
  const closeOwned = () => { sampler.close(); client.close(); };
  return Object.freeze({ ...profile,
    close(): void { unknown ||= pending > 0 || checking || busy; closed = true; closeOwned(); stopReject?.(fail('halted')); },
    async run(input: unknown, ...extra: unknown[]): Promise<ReferenceAuthorityAskRunProof | ReferenceAuthorityShadowAskRunProof> {
      assertOpen(); if (busy) throw fail('busy'); if (used) throw fail('already-executed');
      try { if (extra.length) throw new Error(); exact(record(snapshot(input)), []); } catch { throw fail('invalid-request', false); }
      used = true; busy = true;
      const stop = new Promise<never>((_, reject) => { stopReject = reject; });
      const perform = async (): Promise<ReferenceAuthorityAskRunProof | ReferenceAuthorityShadowAskRunProof> => {
        await checkpoint(); phase = 'approval';
        let grant;
        try { grant = await approval.verifyAndConsume({ context: { executionProfile: 'local-reference', binding: binding.bindingProof.binding,
          actorId: expected.participants.executorId }, envelope, expectedPayload: expected }); }
        catch (error) { if (error instanceof AuthorityApprovalError) { nonceOutcome = error.nonceOutcome; unknown ||= error.pendingCompletionUnknown; }
          throw fault ?? fail('approval-failed'); }
        assertOpen(); nonceOutcome = 'reported-consumed'; armed = true; live(); phase = 'evaluation';
        const result = await sampler.run({}); assertOpen(); await checkpoint(); live();
        const shadowRun = result.schemaVersion === 'kg-reference-shadow-side-effect-ask-run/v1' ? result : null;
        const run = result.schemaVersion === 'kg-reference-shadow-side-effect-ask-run/v1' ? result.run : result;
        if (shadow !== (shadowRun !== null)) throw fail('execution-failed');
        const common = { classification: 'confidential', productionAccepted: false, stageAcceptanceComplete: false,
          executionAuthorized: false, registryAuthenticated: false, sourceAuthenticated: false, machineGateComputed: false,
          executionSignatureVerified: true, executionNonceConsumed: true, approvalDecisionHash: grant.decisionHash, nonceClaimRef: grant.nonceClaimRef, run } as const;
        const core = shadowRun === null ? { ...common, schemaVersion: 'kg-reference-authority-ask-run/v1' as const,
          validationLevel: 'local-reference-authority-native-paired-consumption' as const, checkpoints }
          : { ...common, schemaVersion: 'kg-reference-authority-shadow-ask-run/v1' as const,
            validationLevel: 'local-reference-authority-native-shadow-consumption' as const, sideEffectPolicyVerified: false as const,
            checkpoints: shadowCheckpoints, checkpointProviderSets, sideEffects: shadowRun.sideEffects };
        const budget = binding.bindingProof.resourceBudget;
        if (Buffer.byteLength(JSON.stringify({ ...core, proofHash: '0'.repeat(64) })) > budget.maxJsonBytes || nodeCount(core) + 1 > budget.maxNodes) throw fail('capacity-exhausted');
        return freeze({ ...core, proofHash: canonicalJsonSha256({ ...core, run: run.proofHash,
          checkpoints: canonicalJsonSha256(core.checkpoints.map(value => value.decisionHash)), ...(shadowRun === null ? {} : { sideEffects: shadowRun.sideEffects.reportHash }) }) });
      };
      try { return await Promise.race([perform(), stop]); }
      catch (error) {
        if (error instanceof ProductionAskRunnerError || error instanceof ProductionAskHttpsTransportError) {
          unknown ||= error.pendingCompletionUnknown; posted ||= error.requestMayHaveBeenDispatched;
          if (error instanceof ProductionAskRunnerError) mutation ||= error.mutationMayHaveOccurred;
        }
        if (error instanceof ShadowSideEffectError) {
          unknown ||= error.pendingCompletionUnknown; mutation ||= error.mutationMayHaveOccurred; posted ||= error.requestMayHaveBeenDispatched;
          const code = error.code === 'operation-timeout' ? 'operation-timeout' : error.code === 'capacity-exhausted' ? 'capacity-exhausted'
            : error.code === 'side-effect-mismatch' || error.code === 'invalid-readback' ? 'side-effect-failed' : 'execution-failed';
          const failedPhase = error.phase === 'readback' || error.phase === 'comparison' ? error.phase : phase;
          fault ??= new AuthorityAskRunnerError(code, failedPhase, nonceOutcome, unknown, mutation, posted);
        }
        closed = true;
        const owned = fault ?? (error instanceof AuthorityAskRunnerError ? error : null);
        // Immutable earlier faults cannot erase UNKNOWN or dispatch facts
        // learned during a synchronous close or later owned failure.
        if (owned) throw new AuthorityAskRunnerError(owned.code, owned.phase, nonceOutcome,
          unknown || owned.pendingCompletionUnknown, mutation || owned.mutationMayHaveOccurred, posted || owned.requestMayHaveBeenDispatched);
        throw fail('execution-failed');
      } finally { busy = false; armed = false; stopReject = null; closeOwned(); }
    },
  });
}
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, keys: readonly string[]) { if (Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new Error(); }
function same(left: unknown, right: unknown) { if (canonicalJson(left) !== canonicalJson(right)) throw new Error(); }
function descriptors(input: unknown, keys: readonly string[]): Fields {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
  const out: Fields = Object.create(null); for (const key of Reflect.ownKeys(input)) { if (typeof key !== 'string' || !keys.includes(key)) throw new Error();
    const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error(); out[key] = d.value; } return out;
}
function capture(input: unknown, methods: readonly string[], optional: readonly string[] = []): Port {
  const fields = descriptors(input, ['executionProfile', 'productionCapable', ...methods, ...optional]);
  if (fields.executionProfile !== 'local-reference' || fields.productionCapable !== false) throw new Error();
  for (const method of methods) if (typeof fields[method] !== 'function' || types.isProxy(fields[method])) throw new Error();
  return Object.freeze({ receiver: input as object, methods: Object.freeze(Object.fromEntries(methods.map(k => [k, fields[k] as Call]))) });
}
function nodeCount(input: unknown): number { return 1 + (input && typeof input === 'object' ? Object.values(input).reduce<number>((n, x) => n + nodeCount(x), 0) : 0); }
function freeze<T>(input: T): T { if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }
