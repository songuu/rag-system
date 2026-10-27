import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { ArtifactRunBinding } from './production-controlled-artifacts';
import type { ArtifactReference } from './production-gate-manifest';

export const AUTHORITY_CLOCK_READING_SCHEMA = 'kg-authority-clock-reading/v1' as const;
export const AUTHORIZATION_NONCE_CLAIM_SCHEMA = 'kg-authorization-nonce-claim/v1' as const;
type ExecutionProfile = 'enterprise' | 'local-reference';
type AuthorizationKind = 'execution' | 'result' | 'recovery';
type Scope = Pick<ArtifactRunBinding, 'environment' | 'tenantId' | 'corpusId'>;

/** Labels bind data; they are not authenticated principals or IAM capabilities.
 * Enterprise adapters must authenticate the caller and their time/store source. */
export interface AuthorityOperationContext {
  readonly executionProfile: ExecutionProfile;
  readonly binding: ArtifactRunBinding;
  readonly actorId: string;
}
export interface AuthorityClockRequest {
  readonly context: AuthorityOperationContext;
  readonly requestNonce: string;
}
export interface AuthorityClockReading {
  readonly schemaVersion: typeof AUTHORITY_CLOCK_READING_SCHEMA;
  readonly classification: 'confidential';
  readonly assurance: ExecutionProfile;
  readonly productionTimeAuthenticated: boolean;
  readonly binding: ArtifactRunBinding;
  readonly requestNonce: string;
  readonly sourceIdentityRef: ArtifactReference;
  readonly readerId: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly uncertaintyMs: number;
}
export interface AuthorityClockPort {
  readonly executionProfile: ExecutionProfile;
  readonly productionCapable: boolean;
  readTime(request: AuthorityClockRequest): Promise<AuthorityClockReading>;
}
export interface ReferenceAuthorityClock extends AuthorityClockPort {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  /** Isolated fixture controls, not a trusted enterprise clock API. */
  advanceTo(observedAt: string): void;
  setAvailability(available: boolean): void;
}
export interface ClockReadingExpectation {
  readonly request: AuthorityClockRequest;
  readonly sourceIdentityRef: ArtifactReference;
  readonly maxUncertaintyMs: number;
  readonly previousReading: AuthorityClockReading | null;
}
export interface ConsumeAuthorizationNonceRequest {
  readonly context: AuthorityOperationContext;
  readonly issuerId: string;
  readonly authorizationNonce: string;
  readonly authorizationId: string;
  readonly authorizationKind: AuthorizationKind;
  readonly envelopeDigest: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly clockRequestNonce: string;
  readonly clockReading: AuthorityClockReading;
}
export type AuthorizationNonceDecision = {
  readonly status: 'consumed'; readonly claimRef: ArtifactReference;
} | {
  readonly status: 'replayed' | 'capacity-exhausted'; readonly claimRef: null;
};
export interface AuthorizationNonceClaim {
  readonly schemaVersion: typeof AUTHORIZATION_NONCE_CLAIM_SCHEMA;
  readonly classification: 'confidential';
  readonly binding: ArtifactRunBinding;
  readonly issuerId: string;
  readonly nonceIdentityHash: string;
  readonly authorizationId: string;
  readonly authorizationKind: AuthorizationKind;
  readonly envelopeDigest: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly clockReadingHash: string;
  readonly claimedAt: string;
  readonly consumerId: string;
}
export interface NonceClaimReadRequest {
  readonly context: AuthorityOperationContext;
  readonly ref: ArtifactReference;
}
export interface NonceClaimReadback {
  readonly object: AuthorizationNonceClaim;
  readonly proof: {
    readonly assurance: ExecutionProfile;
    readonly productionDurable: boolean;
    readonly storeIdentityRef: ArtifactReference;
    readonly objectRef: ArtifactReference;
    readonly readerId: string;
  };
}
export interface AuthorizationNonceStorePort {
  readonly executionProfile: ExecutionProfile;
  readonly productionCapable: boolean;
  consumeAuthorizationNonce(request: ConsumeAuthorizationNonceRequest): Promise<AuthorizationNonceDecision>;
  readExactNonceClaim(request: NonceClaimReadRequest): Promise<NonceClaimReadback>;
}
export interface ReferenceAuthorizationNonceStore extends AuthorizationNonceStorePort {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
}
export interface NonceClaimReadbackExpectation {
  readonly request: NonceClaimReadRequest;
  readonly storeIdentityRef: ArtifactReference;
  readonly expectedClaim: AuthorizationNonceClaim;
}

type Fields = Record<string, unknown>;
const SCOPE_FIELDS = ['environment', 'tenantId', 'corpusId'];
const BINDING_FIELDS = [...SCOPE_FIELDS, 'runNonce', 'manifestHash'];
const CLOCK_FIELDS = ['schemaVersion', 'classification', 'assurance', 'productionTimeAuthenticated',
  'binding', 'requestNonce', 'sourceIdentityRef', 'readerId', 'sequence', 'observedAt', 'uncertaintyMs'];
const CLAIM_FIELDS = ['schemaVersion', 'classification', 'binding', 'issuerId', 'nonceIdentityHash',
  'authorizationId', 'authorizationKind', 'envelopeDigest', 'validFrom', 'expiresAt', 'clockReadingHash',
  'claimedAt', 'consumerId'];
const CONSUME_FIELDS = ['context', 'issuerId', 'authorizationNonce', 'authorizationId', 'authorizationKind',
  'envelopeDigest', 'validFrom', 'expiresAt', 'clockRequestNonce', 'clockReading'];
const MIN_TIME = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_TIME = Date.parse('9999-12-31T23:59:59.999Z');
const MAX_VALIDITY_MS = 86400000;
const MAX_UNCERTAINTY_MS = 60000;

/** Challenge correlation and monotonicity are structural checks, not source
 * authentication. Never turn provider booleans or caller expectations into an
 * approval. A production composer must verify the source out of band. */
export function validateAuthorityClockReading(input: unknown, inputExpectation: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAuthorized: false;
  readonly readingHash: string; readonly reading: AuthorityClockReading;
} {
  const expectation = snapshot(inputExpectation);
  exact(expectation, ['request', 'sourceIdentityRef', 'maxUncertaintyMs', 'previousReading']);
  const request = parseClockRequest(expectation.request);
  const source = reference(expectation.sourceIdentityRef);
  const maxUncertainty = integer(expectation.maxUncertaintyMs, 0, MAX_UNCERTAINTY_MS);
  const reading = parseReading(snapshot(input));
  checkReadingBinding(reading, request.context, source);
  if (reading.requestNonce !== request.requestNonce) fail('clock challenge mismatch');
  if (reading.uncertaintyMs > maxUncertainty) fail('clock uncertainty exceeds bound');
  if (expectation.previousReading !== null) {
    const previous = parseReading(record(expectation.previousReading));
    checkReadingBinding(previous, request.context, source);
    if (reading.sequence <= previous.sequence || timestamp(reading.observedAt) < timestamp(previous.observedAt)
      || reading.requestNonce === previous.requestNonce) fail('clock progress not monotonic');
  }
  return freeze({ validationLevel: 'structural-only', productionAuthorized: false,
    readingHash: canonicalJsonSha256(reading), reading });
}

/** Controlled local time plus volatile challenge history only. No wall-clock
 * trust, signed source attestation, durable sequence, restart continuity or IAM. */
export function createReferenceAuthorityClock(input: unknown): ReferenceAuthorityClock {
  const options = snapshot(input);
  exact(options, ['executionProfile', 'scope', 'allowedActorIds', 'sourceIdentityRef', 'initialObservedAt',
    'uncertaintyMs', 'maxReadings', 'maxAdvanceMs']);
  localProfile(options.executionProfile);
  const scope = parseScope(options.scope); const sourceIdentityRef = reference(options.sourceIdentityRef);
  if (!Array.isArray(options.allowedActorIds) || options.allowedActorIds.length < 1
    || options.allowedActorIds.length > 64) fail('bounded clock actor set required');
  const actors = new Set<string>();
  for (const actor of options.allowedActorIds) {
    const actorId = identifier(actor); if (actors.has(actorId)) fail('ambiguous clock actor set'); actors.add(actorId);
  }
  const uncertaintyMs = integer(options.uncertaintyMs, 0, MAX_UNCERTAINTY_MS);
  const maxReadings = integer(options.maxReadings, 1, 10000);
  const maxAdvanceMs = integer(options.maxAdvanceMs, 1, MAX_VALIDITY_MS);
  let observedTime = timestamp(options.initialObservedAt); timeInterval(observedTime, uncertaintyMs);
  let available = true; const challenges = new Set<string>();
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    async readTime(inputRequest: unknown): Promise<AuthorityClockReading> {
      const request = parseClockRequest(snapshot(inputRequest));
      checkLocalContext(request.context, scope);
      if (!actors.has(request.context.actorId)) fail('clock actor outside local fixture roles');
      if (!available) fail('clock unavailable');
      if (challenges.has(request.requestNonce)) fail('clock challenge already used');
      if (challenges.size >= maxReadings) fail('clock capacity exhausted');
      const reading: AuthorityClockReading = freeze({ schemaVersion: AUTHORITY_CLOCK_READING_SCHEMA,
        classification: 'confidential', assurance: 'local-reference', productionTimeAuthenticated: false,
        binding: request.context.binding, requestNonce: request.requestNonce, sourceIdentityRef,
        readerId: request.context.actorId, sequence: challenges.size + 1,
        observedAt: new Date(observedTime).toISOString(), uncertaintyMs });
      // No await between capacity/challenge checks and the local exclusive use.
      challenges.add(request.requestNonce); return reading;
    },
    advanceTo(inputTime: unknown): void {
      const next = timestamp(inputTime); timeInterval(next, uncertaintyMs);
      if (next < observedTime || next - observedTime > maxAdvanceMs) fail('clock advance outside monotonic bound');
      observedTime = next;
    },
    setAvailability(inputAvailable: unknown): void {
      if (typeof inputAvailable !== 'boolean') fail('clock availability must be boolean'); available = inputAvailable;
    },
  });
}

/** Atomic in-memory behavioral reference, NOT durable replay prevention or an
 * approval verifier. A composer must verify signatures before consuming and
 * reconcile uncertain commits against exact claims before taking any action.
 * Tombstones survive expiry, but not process restart or another instance. */
export function createReferenceAuthorizationNonceStore(input: unknown): ReferenceAuthorizationNonceStore {
  const options = snapshot(input);
  exact(options, ['executionProfile', 'scope', 'actors', 'storeIdentityRef', 'clockIdentityRef', 'maxClaims', 'maxClockUncertaintyMs']);
  localProfile(options.executionProfile);
  const scope = parseScope(options.scope); const actors = record(options.actors);
  exact(actors, ['writerId', 'readOnlyId']);
  const writerId = identifier(actors.writerId); const readOnlyId = identifier(actors.readOnlyId);
  if (writerId === readOnlyId) fail('writer and independent reader must differ');
  const storeIdentityRef = reference(options.storeIdentityRef); const clockIdentityRef = reference(options.clockIdentityRef);
  const maxClaims = integer(options.maxClaims, 1, 10000);
  const maxUncertaintyMs = integer(options.maxClockUncertaintyMs, 0, MAX_UNCERTAINTY_MS);
  const claims = new Map<string, { ref: ArtifactReference; object: AuthorizationNonceClaim }>();
  const nonceKeys = new Set<string>(); const consumedClockChallenges = new Set<string>();
  let lastClockSequence = 0; let lastClockTime = -Infinity;
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    async consumeAuthorizationNonce(inputRequest: unknown): Promise<AuthorizationNonceDecision> {
      const request = snapshot(inputRequest); exact(request, CONSUME_FIELDS);
      const context = parseContext(request.context); checkLocalContext(context, scope);
      if (context.actorId !== writerId) fail('nonce consumer outside local writer role');
      const issuerId = identifier(request.issuerId); const nonce = hex(request.authorizationNonce, 32);
      const authorizationId = identifier(request.authorizationId); const kind = authorizationKind(request.authorizationKind);
      const envelopeDigest = hex(request.envelopeDigest, 64);
      const clockRequestNonce = hex(request.clockRequestNonce, 32);
      const clock = validateAuthorityClockReading(request.clockReading, { request: { context, requestNonce: clockRequestNonce },
        sourceIdentityRef: clockIdentityRef, maxUncertaintyMs, previousReading: null }).reading;
      const time = timestamp(clock.observedAt); const [earliest, latest] = timeInterval(time, clock.uncertaintyMs);
      const [validFrom, expiresAt] = validity(request.validFrom, request.expiresAt);
      if (earliest < validFrom || latest >= expiresAt) fail('authorization validity does not contain full clock interval');
      // Deliberately exclude run/kind/envelope/approval ID from replay identity.
      // An issuer cannot refresh a consumed nonce by re-signing or relabeling it.
      const nonceKey = canonicalJson([issuerId, nonce]);
      if (nonceKeys.has(nonceKey)) return freeze({ status: 'replayed', claimRef: null });
      if (clock.sequence <= lastClockSequence || time < lastClockTime
        || consumedClockChallenges.has(clockRequestNonce)) fail('nonce clock progress not monotonic');
      if (claims.size >= maxClaims) return freeze({ status: 'capacity-exhausted', claimRef: null });
      const object: AuthorizationNonceClaim = freeze({ schemaVersion: AUTHORIZATION_NONCE_CLAIM_SCHEMA,
        classification: 'confidential', binding: context.binding, issuerId,
        nonceIdentityHash: canonicalJsonSha256([issuerId, nonce]), authorizationId, authorizationKind: kind,
        envelopeDigest, validFrom: request.validFrom as string, expiresAt: request.expiresAt as string,
        clockReadingHash: canonicalJsonSha256(clock), claimedAt: clock.observedAt, consumerId: writerId });
      const ref = freeze({ objectId: `nonce-${object.nonceIdentityHash}`, objectVersion: 'v1', sha256: canonicalJsonSha256(object) });
      // Every validation and hash is complete before this single synchronous
      // commit. Rejection never consumes capacity, nonce or clock progress.
      claims.set(ref.objectId, { ref, object }); nonceKeys.add(nonceKey); consumedClockChallenges.add(clockRequestNonce);
      lastClockSequence = clock.sequence; lastClockTime = time;
      return freeze({ status: 'consumed', claimRef: ref });
    },
    async readExactNonceClaim(inputRequest: unknown): Promise<NonceClaimReadback> {
      const request = parseReadRequest(snapshot(inputRequest)); checkLocalContext(request.context, scope);
      if (request.context.actorId !== readOnlyId) fail('nonce read outside independent local reader role');
      const stored = claims.get(request.ref.objectId);
      if (!stored || !same(stored.ref, request.ref) || canonicalJsonSha256(stored.object) !== request.ref.sha256) fail('exact nonce claim absent');
      if (!same(stored.object.binding, request.context.binding)) fail('nonce read run binding mismatch');
      return freeze({ object: snapshot(stored.object) as unknown as AuthorizationNonceClaim,
        proof: { assurance: 'local-reference', productionDurable: false, storeIdentityRef,
          objectRef: request.ref, readerId: readOnlyId } });
    },
  });
}

/** Exact readback equality alone proves no durability, independent principal,
 * source identity or signature. expectedClaim must be derived independently
 * from the approved request, never copied from this provider's response. */
export function validateNonceClaimReadback(input: unknown, inputExpectation: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAuthorized: false;
  readonly claimHash: string; readonly readback: NonceClaimReadback;
} {
  const expectation = snapshot(inputExpectation); exact(expectation, ['request', 'storeIdentityRef', 'expectedClaim']);
  const request = parseReadRequest(expectation.request); const storeIdentityRef = reference(expectation.storeIdentityRef);
  const expectedClaim = parseClaim(record(expectation.expectedClaim));
  if (!same(expectedClaim.binding, request.context.binding) || expectedClaim.consumerId === request.context.actorId
    || canonicalJsonSha256(expectedClaim) !== request.ref.sha256) fail('nonce read expectation mismatch');
  const readback = snapshot(input); exact(readback, ['object', 'proof']); const object = parseClaim(record(readback.object));
  const proof = record(readback.proof); exact(proof, ['assurance', 'productionDurable', 'storeIdentityRef', 'objectRef', 'readerId']);
  assurance(proof.assurance, proof.productionDurable, request.context.executionProfile);
  const proofStore = reference(proof.storeIdentityRef); const objectRef = reference(proof.objectRef);
  const readerId = identifier(proof.readerId);
  if (!same(object, expectedClaim) || !same(proofStore, storeIdentityRef) || !same(objectRef, request.ref)
    || readerId !== request.context.actorId || canonicalJsonSha256(object) !== request.ref.sha256) fail('exact nonce readback mismatch');
  return freeze({ validationLevel: 'structural-only', productionAuthorized: false,
    claimHash: canonicalJsonSha256(object), readback: { object, proof } as unknown as NonceClaimReadback });
}

function parseClockRequest(input: unknown): AuthorityClockRequest {
  const request = record(input); exact(request, ['context', 'requestNonce']);
  return freeze({ context: parseContext(request.context), requestNonce: hex(request.requestNonce, 32) });
}
function parseReadRequest(input: unknown): NonceClaimReadRequest {
  const request = record(input); exact(request, ['context', 'ref']);
  return freeze({ context: parseContext(request.context), ref: reference(request.ref) });
}
function parseContext(input: unknown): AuthorityOperationContext {
  const context = record(input); exact(context, ['executionProfile', 'binding', 'actorId']);
  const executionProfile = profile(context.executionProfile); const binding = parseBinding(context.binding);
  return freeze({ executionProfile, binding, actorId: identifier(context.actorId) });
}
function parseScope(input: unknown): Scope {
  const scope = record(input); exact(scope, SCOPE_FIELDS);
  for (const field of SCOPE_FIELDS) identifier(scope[field]); return freeze(scope) as unknown as Scope;
}
function parseBinding(input: unknown): ArtifactRunBinding {
  const binding = record(input); exact(binding, BINDING_FIELDS);
  try { validateArtifactAad({ ...binding, artifactType: 'report', artifactId: 'authority-binding', caseId: null,
    ordinal: 0, schemaVersion: 'kg-authority-binding/v1' }); } catch { fail('invalid run binding'); }
  return freeze(binding) as unknown as ArtifactRunBinding;
}
function parseReading(input: Fields): AuthorityClockReading {
  exact(input, CLOCK_FIELDS);
  if (input.schemaVersion !== AUTHORITY_CLOCK_READING_SCHEMA || input.classification !== 'confidential') fail('invalid clock reading schema');
  const executionProfile = profile(input.assurance); assurance(input.assurance, input.productionTimeAuthenticated, executionProfile);
  parseBinding(input.binding); hex(input.requestNonce, 32); reference(input.sourceIdentityRef); identifier(input.readerId);
  integer(input.sequence, 1, Number.MAX_SAFE_INTEGER); const time = timestamp(input.observedAt);
  const uncertaintyMs = integer(input.uncertaintyMs, 0, MAX_UNCERTAINTY_MS); timeInterval(time, uncertaintyMs);
  return freeze(input) as unknown as AuthorityClockReading;
}
function parseClaim(input: Fields): AuthorizationNonceClaim {
  exact(input, CLAIM_FIELDS);
  if (input.schemaVersion !== AUTHORIZATION_NONCE_CLAIM_SCHEMA || input.classification !== 'confidential') fail('invalid nonce claim schema');
  parseBinding(input.binding); identifier(input.issuerId); hex(input.nonceIdentityHash, 64); identifier(input.authorizationId);
  authorizationKind(input.authorizationKind); hex(input.envelopeDigest, 64); hex(input.clockReadingHash, 64); identifier(input.consumerId);
  const [validFrom, expiresAt] = validity(input.validFrom, input.expiresAt); const claimedAt = timestamp(input.claimedAt);
  if (claimedAt < validFrom || claimedAt >= expiresAt) fail('claim outside authorization validity');
  return freeze(input) as unknown as AuthorizationNonceClaim;
}
function checkReadingBinding(reading: AuthorityClockReading, context: AuthorityOperationContext, source: ArtifactReference): void {
  assurance(reading.assurance, reading.productionTimeAuthenticated, context.executionProfile);
  if (!same(reading.binding, context.binding) || !same(reading.sourceIdentityRef, source)
    || reading.readerId !== context.actorId) fail('clock source/reader/run binding mismatch');
}
function checkLocalContext(context: AuthorityOperationContext, scope: Scope): void {
  localProfile(context.executionProfile);
  if (SCOPE_FIELDS.some(field => context.binding[field as keyof Scope] !== scope[field as keyof Scope])) fail('local scope mismatch');
}
function profile(input: unknown): ExecutionProfile {
  if (input !== 'enterprise' && input !== 'local-reference') fail('invalid execution profile'); return input;
}
function localProfile(input: unknown): void {
  if (input !== 'local-reference') fail('reference adapter forbids enterprise execution');
}
function assurance(input: unknown, claim: unknown, expected: ExecutionProfile): void {
  if (input !== expected || typeof claim !== 'boolean' || (expected === 'local-reference' && claim)) fail('assurance profile mismatch');
}
function authorizationKind(input: unknown): AuthorizationKind {
  if (input !== 'execution' && input !== 'result' && input !== 'recovery') fail('invalid authorization kind'); return input;
}
function reference(input: unknown): ArtifactReference {
  const ref = record(input); exact(ref, ['objectId', 'objectVersion', 'sha256']);
  identifier(ref.objectId); identifier(ref.objectVersion); hex(ref.sha256, 64); return freeze(ref) as unknown as ArtifactReference;
}
function validity(from: unknown, until: unknown): readonly [number, number] {
  const start = timestamp(from); const end = timestamp(until);
  if (end <= start || end - start > MAX_VALIDITY_MS) fail('authorization validity outside bounded interval'); return [start, end];
}
function timeInterval(time: number, uncertainty: number): readonly [number, number] {
  const earliest = time - uncertainty; const latest = time + uncertainty;
  if (earliest < MIN_TIME || latest > MAX_TIME) fail('clock interval outside UTC domain'); return [earliest, latest];
}
function timestamp(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail('canonical UTC timestamp required');
  return Date.parse(input);
}
function identifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail('bounded opaque identifier required'); return input;
}
function hex(input: unknown, length: number): string {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail('exact hexadecimal identity required'); return input;
}
function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) fail('integer outside bounded profile'); return input;
}
function snapshot(input: unknown): Fields {
  let encoded: string; try { encoded = canonicalJson(input); } catch { fail('invalid canonical bounded data'); }
  return record(JSON.parse(encoded));
}
function record(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('required data object absent'); return input as Fields;
}
function exact(input: Fields, expected: readonly string[]): void {
  if (expected.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !expected.includes(field))) fail('required fields absent or unsupported fields present');
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input;
}
function fail(reason: string): never { throw new Error(`[authority ports] ${reason}`); }
