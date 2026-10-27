import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall } from './bounded-provider-call';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { ArtifactOperationContext, ArtifactRunBinding } from './production-controlled-artifacts';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import { createReferenceRegistryBoundTrustVerifier, validateProviderRegistryReadback } from './production-provider-registry';
import { createReferenceProviderTrustVerifier, PROVIDER_PURPOSES, PROVIDER_REQUIRED_PURPOSES_BY_STAGE } from './production-provider-trust';
import type { ProviderManifestBinding, ProviderPurpose, ProviderTrustPolicy, ReferenceProviderTrustDecision } from './production-provider-trust';
import type { ArtifactReference } from './production-gate-manifest';

export const PROVIDER_EVIDENCE_READBACK_SCHEMA = 'kg-provider-evidence-readback-proof/v1' as const;
type EvidenceKind = 'conformance' | 'runtime';
type Profile = 'enterprise' | 'local-reference';
type Fields = Record<string, unknown>;
type Phase = 'configuration' | 'preflight' | 'source' | 'clock' | 'registry' | EvidenceKind | 'final-validation';
type Code = 'invalid-config' | 'invalid-request' | 'invalid-evidence' | 'source-replay' | 'source-capacity'
  | 'source-unavailable' | 'operation-failed' | 'operation-timeout' | 'provider-contract-invalid' | 'busy' | 'halted' | 'attempt-capacity';
export class ProviderEvidenceError extends Error {
  readonly productionAuthorized = false; readonly automaticRetryAllowed = false;
  readonly code: Code; readonly phase: Phase; readonly pendingCompletionUnknown: boolean;
  constructor(code: Code, phase: Phase, pendingCompletionUnknown = false) {
    super(`[provider evidence] ${phase}: ${code}`); this.name = 'ProviderEvidenceError';
    this.code = code; this.phase = phase; this.pendingCompletionUnknown = pendingCompletionUnknown; Object.freeze(this);
  }
}
export interface ProviderEvidenceObject { readonly ref: ArtifactReference; readonly attestation: unknown }
export interface ConformanceEvidenceReadRequest {
  readonly context: ArtifactOperationContext; readonly ref: ArtifactReference; readonly requestNonce: string;
}
export interface RuntimeMeasurementReadRequest {
  readonly context: ArtifactOperationContext; readonly provider: ProviderManifestBinding; readonly requestNonce: string;
}
export interface ProviderEvidenceReadback {
  readonly object: ProviderEvidenceObject;
  readonly proof: { readonly schemaVersion: typeof PROVIDER_EVIDENCE_READBACK_SCHEMA; readonly kind: EvidenceKind;
    readonly assurance: Profile; readonly productionSourceAuthenticated: boolean; readonly sourceIdentityRef: ArtifactReference;
    readonly objectRef: ArtifactReference; readonly context: ArtifactOperationContext; readonly requestNonce: string;
    readonly selector: ArtifactReference | ProviderManifestBinding };
}
/** Exact certificate storage and independent runtime measurement are distinct
 * source responsibilities. Labels/proofs do not authenticate enterprise sources. */
export interface ProviderEvidenceReadbackPort {
  readonly executionProfile: Profile; readonly productionCapable: boolean;
  readExactConformance(request: ConformanceEvidenceReadRequest): Promise<ProviderEvidenceReadback>;
  readRuntimeMeasurement(request: RuntimeMeasurementReadRequest): Promise<ProviderEvidenceReadback>;
}
export interface ReferenceProviderEvidenceStore extends ProviderEvidenceReadbackPort {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  setAvailability(available: boolean): void;
}
export interface ProviderEvidenceReadbackDecision extends Omit<ReferenceProviderTrustDecision, 'validationLevel'> {
  readonly validationLevel: 'local-reference-provider-evidence-readback'; readonly stageAcceptanceComplete: false;
  readonly behavioralConformanceComplete: false; readonly conformanceSourceAuthenticated: false; readonly runtimeSourceAuthenticated: false;
  readonly registryRef: ArtifactReference; readonly registryReadbackProofHashes: readonly string[];
  readonly clockReadingHash: string; readonly uncertaintyMs: number;
  readonly providerEvidenceReadbacks: readonly { readonly kind: EvidenceKind; readonly purpose: ProviderPurpose;
    readonly objectRef: ArtifactReference; readonly readbackHash: string }[];
  readonly decisionHash: string;
}
export interface ReferenceProviderEvidenceVerifier {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  verifySelection(input: unknown): Promise<ProviderEvidenceReadbackDecision>;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields;
}
function exact(value: Fields, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error();
}
function same(left: unknown, right: unknown): void { if (canonicalJson(left) !== canonicalJson(right)) throw new Error(); }
function id(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) throw new Error(); return input;
}
function hex(input: unknown, length = 64): string {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) throw new Error(); return input;
}
function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); return input;
}
function time(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new Error(); return Date.parse(input);
}
function reference(input: unknown): ArtifactReference {
  const value = record(input); exact(value, ['objectId', 'objectVersion', 'sha256']);
  id(value.objectId); id(value.objectVersion); hex(value.sha256); return value as unknown as ArtifactReference;
}
function binding(input: unknown): ArtifactRunBinding {
  const value = record(input); exact(value, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash']);
  validateArtifactAad({ ...value, artifactType: 'report', artifactId: 'provider-evidence', caseId: null, ordinal: 0, schemaVersion: 'provider-evidence/v1' });
  return value as unknown as ArtifactRunBinding;
}
function operationContext(input: unknown): ArtifactOperationContext {
  const value = record(input); exact(value, ['executionProfile', 'binding', 'actorId', 'authorizationDigest', 'observedAt']);
  if (value.executionProfile !== 'enterprise' && value.executionProfile !== 'local-reference') throw new Error();
  binding(value.binding); id(value.actorId); hex(value.authorizationDigest); time(value.observedAt);
  return value as unknown as ArtifactOperationContext;
}
function providerBinding(input: unknown): ProviderManifestBinding {
  const value = record(input); exact(value, ['purpose', 'providerId', 'adapterDigest', 'version', 'configHash', 'conformanceRef']);
  if (!PROVIDER_PURPOSES.includes(value.purpose as ProviderPurpose)) throw new Error();
  id(value.providerId); id(value.version); hex(value.adapterDigest); hex(value.configHash); reference(value.conformanceRef);
  return value as unknown as ProviderManifestBinding;
}
function requestFields(input: unknown, kind: EvidenceKind): Fields {
  const value = record(snapshot(input)); exact(value, ['context', kind === 'conformance' ? 'ref' : 'provider', 'requestNonce']);
  operationContext(value.context); hex(value.requestNonce, 32);
  if (kind === 'conformance') reference(value.ref); else providerBinding(value.provider); return value;
}
function evidenceObject(input: unknown, kind: EvidenceKind): ProviderEvidenceObject {
  const value = record(input); exact(value, ['ref', 'attestation']); const ref = reference(value.ref);
  const attestation = record(value.attestation); exact(attestation, ['kind', 'body', 'signature']);
  if (attestation.kind !== kind || canonicalJsonSha256(attestation) !== ref.sha256) throw new Error();
  const body = record(attestation.body); const provider = record(body.provider);
  if (!PROVIDER_PURPOSES.includes(provider.purpose as ProviderPurpose)) throw new Error(); id(provider.providerId);
  const scope = record(body.scope); exact(scope, ['environment', 'tenantId', 'corpusId']);
  for (const field of Object.values(scope)) id(field); hex(body.runNonce, 32); reference(body.registryRef);
  const issued = time(body.issuedAt); if (time(body.expiresAt) <= issued) throw new Error();
  return value as unknown as ProviderEvidenceObject;
}
function providerMatches(attestation: unknown, selector: ProviderManifestBinding): void {
  const measured = record(record(attestation).body).provider;
  const identity = record(measured);
  for (const field of ['purpose', 'providerId', 'adapterDigest', 'version', 'configHash'] as const) same(identity[field], selector[field]);
}
function scopeFrom(run: ArtifactRunBinding) { return { environment: run.environment, tenantId: run.tenantId, corpusId: run.corpusId }; }
function roots(input: unknown): Readonly<Record<EvidenceKind, ArtifactReference>> {
  const value = record(input); exact(value, ['conformance', 'runtime']);
  const conformance = reference(value.conformance); const runtime = reference(value.runtime);
  if (conformance.objectId === runtime.objectId) throw new Error(); return { conformance, runtime };
}

/** Recomputes exact objects and request/source correlation, not signatures or
 * source authenticity. Enterprise booleans remain untrusted structural data. */
export function validateProviderEvidenceReadback(input: unknown, inputExpectation: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAuthorized: false;
  readonly object: ProviderEvidenceObject; readonly readbackHash: string;
} {
  try {
    const expected = record(snapshot(inputExpectation)); exact(expected, ['kind', 'request', 'sourceIdentityRef']);
    if (expected.kind !== 'conformance' && expected.kind !== 'runtime') throw new Error();
    const kind = expected.kind; const request = requestFields(expected.request, kind);
    const value = record(snapshot(input)); exact(value, ['object', 'proof']); const object = evidenceObject(value.object, kind);
    const proof = record(value.proof);
    exact(proof, ['schemaVersion', 'kind', 'assurance', 'productionSourceAuthenticated', 'sourceIdentityRef', 'objectRef', 'context', 'requestNonce', 'selector']);
    const context = operationContext(request.context);
    same(proof, { schemaVersion: PROVIDER_EVIDENCE_READBACK_SCHEMA, kind, assurance: context.executionProfile,
      productionSourceAuthenticated: context.executionProfile === 'enterprise', sourceIdentityRef: reference(expected.sourceIdentityRef),
      objectRef: object.ref, context, requestNonce: request.requestNonce, selector: kind === 'conformance' ? request.ref : request.provider });
    same(record(record(object.attestation).body).scope, scopeFrom(context.binding));
    if (kind === 'conformance') same(object.ref, request.ref);
    else { providerMatches(object.attestation, providerBinding(request.provider));
      const body = record(record(object.attestation).body); same(body.runNonce, context.binding.runNonce); same(body.manifestHash, context.binding.manifestHash); }
    return freeze({ validationLevel: 'structural-only' as const, productionAuthorized: false as const, object, readbackHash: canonicalJsonSha256(value) });
  } catch { throw new ProviderEvidenceError('invalid-evidence', 'source'); }
}

/** Volatile, immutable TEST certificate/runtime-object storage only. Runtime
 * objects were supplied by a fixture; this does not measure a real process,
 * authenticate an enterprise harness, persist evidence or enforce real IAM. */
export function createReferenceProviderEvidenceStore(input: unknown): ReferenceProviderEvidenceStore {
  let config: Fields; let run: ArtifactRunBinding; let sources: Readonly<Record<EvidenceKind, ArtifactReference>>;
  const certificates = new Map<string, ProviderEvidenceObject>(); const runtime = new Map<string, ProviderEvidenceObject>();
  let maxReads: number; let starts: number; let ends: number;
  try {
    config = record(snapshot(input)); exact(config, ['executionProfile', 'binding', 'readerId', 'authorizationDigest',
      'sourceIdentityRefs', 'validFrom', 'validUntil', 'maxReads', 'objects']);
    if (config.executionProfile !== 'local-reference') throw new Error(); run = binding(config.binding);
    id(config.readerId); hex(config.authorizationDigest); sources = roots(config.sourceIdentityRefs);
    starts = time(config.validFrom); ends = time(config.validUntil); if (ends <= starts || ends - starts > 86400000) throw new Error();
    maxReads = integer(config.maxReads, 1, 4096); const objects = record(config.objects); exact(objects, ['conformance', 'runtime']);
    const versions = new Set<string>();
    for (const kind of ['conformance', 'runtime'] as const) {
      const entries = objects[kind]; if (!Array.isArray(entries) || entries.length < 1 || entries.length > 14) throw new Error();
      for (const entry of entries) {
        const object = evidenceObject(entry, kind); const body = record(record(object.attestation).body);
        same(body.scope, scopeFrom(run)); const version = canonicalJson([object.ref.objectId, object.ref.objectVersion]);
        if (versions.has(version)) throw new Error(); versions.add(version);
        if (kind === 'conformance') certificates.set(canonicalJson(object.ref), object);
        else { same(body.runNonce, run.runNonce); same(body.manifestHash, run.manifestHash);
          const key = canonicalJson([record(body.provider).purpose, record(body.provider).providerId]);
          if (runtime.has(key)) throw new Error(); runtime.set(key, object); }
      }
    }
  } catch { throw new ProviderEvidenceError('invalid-config', 'configuration'); }
  const challenges = new Set<string>(); let available = true; let lastObserved = -Infinity;
  function read(inputRequest: unknown, kind: EvidenceKind): ProviderEvidenceReadback {
    if (!available) throw new ProviderEvidenceError('source-unavailable', 'source');
    let request: Fields; let object: ProviderEvidenceObject;
    try {
      request = requestFields(inputRequest, kind); const context = operationContext(request.context);
      if (context.executionProfile !== 'local-reference' || context.actorId !== config.readerId || context.authorizationDigest !== config.authorizationDigest) throw new Error();
      same(context.binding, run); const observed = time(context.observedAt);
      if (observed < starts || observed >= ends || observed < lastObserved) throw new Error();
      const selected = kind === 'conformance' ? certificates.get(canonicalJson(reference(request.ref)))
        : runtime.get(canonicalJson([providerBinding(request.provider).purpose, providerBinding(request.provider).providerId]));
      if (!selected) throw new Error(); object = selected;
      if (kind === 'runtime') providerMatches(object.attestation, providerBinding(request.provider));
    } catch { throw new ProviderEvidenceError('invalid-request', 'source'); }
    if (challenges.has(request.requestNonce as string)) throw new ProviderEvidenceError('source-replay', 'source');
    if (challenges.size >= maxReads) throw new ProviderEvidenceError('source-capacity', 'source');
    challenges.add(request.requestNonce as string); lastObserved = time(operationContext(request.context).observedAt);
    return freeze({ object, proof: { schemaVersion: PROVIDER_EVIDENCE_READBACK_SCHEMA, kind, assurance: 'local-reference' as const,
      productionSourceAuthenticated: false, sourceIdentityRef: sources[kind], objectRef: object.ref, context: request.context as ArtifactOperationContext,
      requestNonce: request.requestNonce as string, selector: (kind === 'conformance' ? request.ref : request.provider) as ArtifactReference | ProviderManifestBinding } });
  }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    async readExactConformance(request: ConformanceEvidenceReadRequest) { return read(request, 'conformance'); },
    async readRuntimeMeasurement(request: RuntimeMeasurementReadRequest) { return read(request, 'runtime'); },
    setAvailability(value: boolean) { if (typeof value !== 'boolean') throw new ProviderEvidenceError('invalid-request', 'source'); available = value; } });
}

type Call = (request: unknown) => unknown;
function descriptors(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || types.isProxy(input)) throw new Error();
  const proto = Object.getPrototypeOf(input); if (proto !== Object.prototype && proto !== null) throw new Error();
  const names = Reflect.ownKeys(input); if (names.length > 16) throw new Error(); const value: Fields = Object.create(null);
  for (const name of names) { if (typeof name !== 'string') throw new Error(); const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error(); value[name] = descriptor.value; }
  return value;
}
function capture(input: unknown, methods: readonly string[]): Record<string, Call> {
  const value = descriptors(input); if (value.executionProfile !== 'local-reference' || value.productionCapable !== false) throw new Error();
  return Object.freeze(Object.fromEntries(methods.map(name => { const method = value[name];
    if (typeof method !== 'function' || types.isProxy(method)) throw new Error(); return [name, (request: unknown) => Reflect.apply(method, input, [request])]; })));
}
function selectionFields(input: unknown, config: Fields): Fields {
  const value = record(input); exact(value, ['stage', 'scope', 'runNonce', 'manifestHash', 'providers', 'executionProvidersHash']);
  if (value.stage !== 'T16' && value.stage !== 'T17' && value.stage !== 'R18') throw new Error(); same(value.scope, config.scope);
  binding({ ...record(value.scope), runNonce: value.runNonce, manifestHash: value.manifestHash });
  const providers = record(value.providers); exact(providers, ['registryRef', 'bindings']); same(reference(providers.registryRef), config.registryRef);
  if (hex(value.executionProvidersHash) !== canonicalJsonSha256(providers)) throw new Error();
  if (!Array.isArray(providers.bindings) || providers.bindings.length < 1 || providers.bindings.length > 14) throw new Error();
  const purposes = new Set<ProviderPurpose>(); const references = new Set<string>();
  for (const inputBinding of providers.bindings) { const selected = providerBinding(inputBinding); const version = canonicalJson([selected.conformanceRef.objectId, selected.conformanceRef.objectVersion]);
    if (purposes.has(selected.purpose) || references.has(version)) throw new Error(); purposes.add(selected.purpose); references.add(version); }
  if (PROVIDER_REQUIRED_PURPOSES_BY_STAGE[value.stage].some(purpose => !purposes.has(purpose))) throw new Error(); return value;
}

/** Reads actual sources; does not accept caller certificates, clocks, policies
 * or cached success. The observation window is a bound, NOT an execution grant.
 * Real measurement/harness authentication, network/IAM and complete behavioral
 * certification remain external; no local output authorizes an operation. */
export function createReferenceProviderEvidenceVerifier(inputOptions: unknown, inputPorts: unknown): ReferenceProviderEvidenceVerifier {
  let config: Fields; let selection: Fields; let run: ArtifactRunBinding; let sources: Readonly<Record<EvidenceKind, ArtifactReference>>;
  let registry: Record<string, Call>; let clock: Record<string, Call>; let evidence: Record<string, Call>;
  let timeoutMs: number; let maxAttempts: number; let windowStart: number; let windowEnd: number; let bindings: readonly ProviderManifestBinding[];
  try {
    config = record(snapshot(inputOptions));
    const { expectedSelection, clockIdentityRef, maxClockUncertaintyMs, evidenceIdentityRefs, observationWindow, ...registryOptions } = config;
    exact(config, ['executionProfile', 'scope', 'registryRef', 'registryIdentityRef', 'readerId', 'readerAuthorizationDigest',
      'authorityKeys', 'operationTimeoutMs', 'maxVerifications', 'expectedSelection', 'clockIdentityRef', 'maxClockUncertaintyMs',
      'evidenceIdentityRefs', 'observationWindow']);
    const ports = descriptors(inputPorts); exact(ports, ['registry', 'clock', 'evidence']);
    createReferenceRegistryBoundTrustVerifier(registryOptions, { registry: ports.registry });
    selection = selectionFields(expectedSelection, config); run = binding({ ...record(selection.scope), runNonce: selection.runNonce, manifestHash: selection.manifestHash });
    reference(clockIdentityRef); integer(maxClockUncertaintyMs, 0, 60000); sources = roots(evidenceIdentityRefs);
    const window = record(observationWindow); exact(window, ['startsAt', 'endsAt']); windowStart = time(window.startsAt); windowEnd = time(window.endsAt);
    if (windowEnd <= windowStart || windowEnd - windowStart > 86400000) throw new Error();
    bindings = record(selection.providers).bindings as readonly ProviderManifestBinding[];
    registry = capture(ports.registry, ['readExactPolicy']); clock = capture(ports.clock, ['readTime']); evidence = capture(ports.evidence, ['readExactConformance', 'readRuntimeMeasurement']);
    timeoutMs = config.operationTimeoutMs as number; maxAttempts = config.maxVerifications as number;
  } catch { throw new ProviderEvidenceError('invalid-config', 'configuration'); }
  let phase: Phase = 'preflight'; let busy = false; let halted = false; let attempts = 0;
  let previous: AuthorityClockReading | null = null; const challenges = new Set<string>();
  const fail = (code: Code, pending = false) => new ProviderEvidenceError(code, phase, pending);
  function challenge(): string {
    // First clock/registry, two challenged reads per purpose with their clocks,
    // and final clock/registry/clock: 4*N + 5, separate from attempt count.
    if (challenges.size >= maxAttempts * (4 * bindings.length + 5)) throw fail('attempt-capacity');
    for (let retry = 0; retry < 4; retry++) { const value = randomBytes(16).toString('hex'); if (!challenges.has(value)) { challenges.add(value); return value; } }
    throw fail('attempt-capacity');
  }
  const observe = async (operation: () => unknown): Promise<unknown> => {
    if (halted) throw fail('halted'); const result = await boundedProviderCall(operation, timeoutMs);
    if (halted) throw fail('halted');
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      halted = true; throw fail(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid', result.pendingCompletionUnknown);
    }
    if (result.status === 'rejected') throw fail('operation-failed');
    try { return snapshot(result.value); } catch { throw fail('invalid-evidence'); }
  };
  const clockContext = freeze({ executionProfile: 'local-reference' as const, binding: run, actorId: config.readerId });
  const interval = (reading: AuthorityClockReading): readonly number[] => [time(reading.observedAt) - reading.uncertaintyMs, time(reading.observedAt) + reading.uncertaintyMs];
  const checkTime = (reading: AuthorityClockReading, policy?: ProviderTrustPolicy) => {
    for (const observed of interval(reading)) {
      if (observed < windowStart || observed >= windowEnd || policy && (observed < time(policy.validFrom) || observed >= time(policy.validUntil))) throw fail('invalid-evidence');
    }
  };
  const readClock = async (policy?: ProviderTrustPolicy): Promise<AuthorityClockReading> => {
    phase = 'clock'; const request = freeze({ context: clockContext, requestNonce: challenge() });
    const reading = validateAuthorityClockReading(await observe(() => clock.readTime(request)), { request,
      sourceIdentityRef: config.clockIdentityRef, maxUncertaintyMs: config.maxClockUncertaintyMs, previousReading: previous }).reading;
    if (reading.assurance !== 'local-reference' || reading.productionTimeAuthenticated !== false) throw fail('invalid-evidence');
    previous = reading; checkTime(reading, policy); return reading;
  };
  const context = (reading: AuthorityClockReading) => freeze({ executionProfile: 'local-reference', binding: run,
    actorId: config.readerId, authorizationDigest: config.readerAuthorizationDigest, observedAt: reading.observedAt });
  const readRegistry = async (reading: AuthorityClockReading) => {
    phase = 'registry'; const request = freeze({ context: context(reading), policyRef: config.registryRef, requestNonce: challenge() });
    const checked = validateProviderRegistryReadback(await observe(() => registry.readExactPolicy(request)), { request, sourceIdentityRef: config.registryIdentityRef });
    checkTime(reading, checked.policy); return checked;
  };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    async verifySelection(input: unknown): Promise<ProviderEvidenceReadbackDecision> {
      if (halted) throw new ProviderEvidenceError('halted', 'preflight'); if (busy) throw new ProviderEvidenceError('busy', 'preflight');
      try { exact(record(snapshot(input)), []); } catch { throw new ProviderEvidenceError('invalid-request', 'preflight'); }
      if (attempts >= maxAttempts) throw new ProviderEvidenceError('attempt-capacity', 'preflight');
      attempts++; busy = true;
      try {
        const firstClock = await readClock(); const initial = await readRegistry(firstClock);
        // Establish the real registered selection before any evidence callback.
        for (const selected of bindings) {
          const registered = initial.policy.registrations.find(value => value.purpose === selected.purpose && value.providerId === selected.providerId);
          if (!registered) throw fail('invalid-evidence');
          for (const field of ['adapterDigest', 'version', 'configHash'] as const) same(registered[field], selected[field]);
        }
        const trustOptions = { executionProfile: 'local-reference', policy: initial.policy, policyRef: config.registryRef, authorityKeys: config.authorityKeys };
        createReferenceProviderTrustVerifier(trustOptions);
        const objects: Record<EvidenceKind, ProviderEvidenceObject[]> = { conformance: [], runtime: [] };
        const readbacks: { kind: EvidenceKind; purpose: ProviderPurpose; objectRef: ArtifactReference; readbackHash: string }[] = [];
        // Reserve all frozen certificates before reading runtime objects, so a
        // runtime result cannot impersonate a certificate that is read later.
        const evidenceVersions = new Set(bindings.map(selected => canonicalJson([selected.conformanceRef.objectId, selected.conformanceRef.objectVersion])));
        for (const selected of bindings) for (const kind of ['conformance', 'runtime'] as const) {
          const reading = await readClock(initial.policy); phase = kind;
          const request = freeze({ context: context(reading), ...(kind === 'conformance' ? { ref: selected.conformanceRef } : { provider: selected }), requestNonce: challenge() });
          const actual = await observe(() => evidence[kind === 'conformance' ? 'readExactConformance' : 'readRuntimeMeasurement'](request));
          const checked = validateProviderEvidenceReadback(actual, { kind, request, sourceIdentityRef: sources[kind] });
          providerMatches(checked.object.attestation, selected);
          if (kind === 'runtime') {
            const version = canonicalJson([checked.object.ref.objectId, checked.object.ref.objectVersion]);
            if (evidenceVersions.has(version)) throw fail('invalid-evidence'); evidenceVersions.add(version);
          }
          objects[kind].push(checked.object); readbacks.push({ kind, purpose: selected.purpose, objectRef: checked.object.ref, readbackHash: checked.readbackHash });
        }
        const beforeFinal = await readClock(initial.policy); const finalRegistry = await readRegistry(beforeFinal);
        same(finalRegistry.policy, initial.policy); const finalClock = await readClock(finalRegistry.policy); phase = 'final-validation';
        let decision: ReferenceProviderTrustDecision | undefined;
        // Overlapping uncertainty intervals are not real clock regression.
        // Both edges use fresh stateless signature/trust instances; the actual
        // challenged clock progress remains shared across every invocation.
        for (const observed of interval(finalClock)) decision = createReferenceProviderTrustVerifier(trustOptions).verifySelection({ ...selection,
          observedAt: new Date(observed).toISOString(), conformanceObjects: objects.conformance, runtimeObjects: objects.runtime });
        if (!decision) throw fail('invalid-evidence');
        const result = freeze({ ...decision, validationLevel: 'local-reference-provider-evidence-readback' as const,
          stageAcceptanceComplete: false as const, behavioralConformanceComplete: false as const,
          conformanceSourceAuthenticated: false as const, runtimeSourceAuthenticated: false as const,
          registryRef: config.registryRef as ArtifactReference, registryReadbackProofHashes: [initial.proofHash, finalRegistry.proofHash],
          providerEvidenceReadbacks: readbacks, clockReadingHash: canonicalJsonSha256(finalClock),
          verifiedAt: finalClock.observedAt, uncertaintyMs: finalClock.uncertaintyMs });
        return freeze({ ...result, decisionHash: canonicalJsonSha256(result) });
      } catch (error) { throw error instanceof ProviderEvidenceError ? error : fail('invalid-evidence'); }
      finally { busy = false; }
    } });
}
