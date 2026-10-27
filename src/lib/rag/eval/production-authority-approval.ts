import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall } from './bounded-provider-call';
import { createReferenceAuthorizationSignatureVerifier, validateAuthorizationEnvelope } from './production-authorization';
import type { AuthorizationEnvelope, AuthorizationKind, AuthorizationPayload } from './production-authorization';
import { validateAuthorityClockReading, validateNonceClaimReadback, AUTHORIZATION_NONCE_CLAIM_SCHEMA } from './production-authority-ports';
import type { AuthorityOperationContext, AuthorityClockReading, AuthorizationNonceClaim,
  ConsumeAuthorizationNonceRequest } from './production-authority-ports';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { ArtifactRunBinding } from './production-controlled-artifacts';
import type { ArtifactReference, ProductionGateStage } from './production-gate-manifest';

export const AUTHORITY_APPROVAL_DECISION_SCHEMA = 'kg-reference-authority-approval-decision/v1' as const;
export type NonceOutcome = 'not-attempted' | 'reported-not-consumed' | 'reported-consumed' | 'unknown';
type Phase = 'configuration' | 'preflight' | 'initial-clock' | 'consume' | 'readback' | 'final-clock';
type ErrorCode = 'invalid-config' | 'invalid-request' | 'signature-invalid' | 'clock-invalid'
  | 'clock-operation-failed' | 'nonce-operation-failed' | 'nonce-read-failed' | 'operation-timeout'
  | 'nonce-response-invalid' | 'nonce-replayed' | 'nonce-capacity-exhausted' | 'nonce-read-invalid'
  | 'busy' | 'halted' | 'attempt-capacity' | 'provider-contract-invalid';

/** These diagnostics distinguish source reports from commit knowledge. They
 * expose neither provider exceptions nor approval/raw nonce/clock payloads. */
export class AuthorityApprovalError extends Error {
  readonly productionAuthorized = false;
  readonly code: ErrorCode;
  readonly phase: Phase;
  readonly nonceOutcome: NonceOutcome;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: ErrorCode, phase: Phase, nonceOutcome: NonceOutcome, pendingCompletionUnknown = false) {
    super(`[authority approval] ${phase}: ${code}`); this.name = 'AuthorityApprovalError';
    this.code = code; this.phase = phase; this.nonceOutcome = nonceOutcome;
    this.pendingCompletionUnknown = pendingCompletionUnknown; Object.freeze(this);
  }
}
export interface AuthorityApprovalRequest {
  readonly context: AuthorityOperationContext;
  readonly envelope: AuthorizationEnvelope;
  readonly expectedPayload: AuthorizationPayload;
}
export interface ReferenceAuthorityApprovalDecision {
  readonly schemaVersion: typeof AUTHORITY_APPROVAL_DECISION_SCHEMA;
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-authority-composition';
  readonly productionAuthorized: false;
  readonly signatureVerified: true;
  readonly nonceClaimMatched: true;
  readonly binding: ArtifactRunBinding;
  readonly kind: AuthorizationKind;
  readonly stage: ProductionGateStage;
  readonly envelopeDigest: string;
  readonly consumerId: string;
  readonly readOnlyId: string;
  readonly clockIdentityRef: ArtifactReference;
  readonly nonceStoreIdentityRef: ArtifactReference;
  readonly initialClockReadingHash: string;
  readonly finalClockReadingHash: string;
  readonly nonceClaimRef: ArtifactReference;
  readonly verifiedAt: string;
  readonly uncertaintyMs: number;
  readonly decisionHash: string;
}
/** A local observation is not an enterprise grant or a transferable capability. */
export interface ReferenceAuthorityApprovalVerifier {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  verifyAndConsume(request: AuthorityApprovalRequest): Promise<ReferenceAuthorityApprovalDecision>;
}
export interface AuthorityApprovalProvenanceRequest extends AuthorityApprovalRequest {
  readonly nonceClaimRef: ArtifactReference;
  readonly claimedClockReading: AuthorityClockReading;
}
export interface ReferenceAuthorityApprovalProvenanceDecision {
  readonly schemaVersion: 'kg-reference-approval-provenance/v1';
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-existing-approval-provenance';
  readonly productionAuthorized: false; readonly executionAuthorized: false;
  readonly nonceConsumedByThisVerifier: false; readonly signatureVerified: true; readonly nonceClaimMatched: true;
  readonly binding: ArtifactRunBinding; readonly kind: AuthorizationKind; readonly stage: ProductionGateStage;
  readonly envelopeDigest: string; readonly consumerId: string; readonly readOnlyId: string;
  readonly clockIdentityRef: ArtifactReference; readonly nonceStoreIdentityRef: ArtifactReference;
  readonly nonceClaimRef: ArtifactReference; readonly nonceReadbackHash: string;
  readonly claimedAt: string; readonly claimedClockReadingHash: string;
  readonly initialClockReadingHash: string; readonly finalClockReadingHash: string;
  readonly verifiedAt: string; readonly uncertaintyMs: number; readonly decisionHash: string;
}
export interface ReferenceAuthorityApprovalProvenanceVerifier {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  verifyExistingClaim(request: AuthorityApprovalProvenanceRequest): Promise<ReferenceAuthorityApprovalProvenanceDecision>;
}
type Fields = Record<string, unknown>;
type Operation = (request: unknown) => unknown;
interface CapturedPort {
  readonly receiver: object;
  readonly methods: Readonly<Record<string, Operation>>;
}
interface RecoveryPrincipal {
  readonly actorId: string;
  readonly roleId: string;
  readonly credentialRef: ArtifactReference;
}
const SCOPE_FIELDS = ['environment', 'tenantId', 'corpusId'];
const BINDING_FIELDS = [...SCOPE_FIELDS, 'runNonce', 'manifestHash'];
interface ClockProgress {
  lastSequence: number; lastTime: number; readonly challenges: Set<string>;
}
function clockProgress(): ClockProgress { return { lastSequence: 0, lastTime: -Infinity, challenges: new Set<string>() }; }

/** Shared validated clock progression, not shared approval/grant state. The
 * receipt owner separately enforces its lock, total budget and UNKNOWN halt.
 * Keep this cursor private: callers cannot supply a reset or a success label. */
export function createReferenceAuthorityApprovalVerificationPair(input: unknown, inputPorts: unknown): Readonly<{
  approval: ReferenceAuthorityApprovalVerifier; provenance: ReferenceAuthorityApprovalProvenanceVerifier;
}> {
  let config: Fields;
  try { config = freeze(snapshot(input)); }
  catch { throw new AuthorityApprovalError('invalid-config', 'configuration', 'not-attempted'); }
  const progress = clockProgress();
  return Object.freeze({ approval: createApprovalVerifier(config, inputPorts, progress),
    provenance: createApprovalProvenanceVerifier(config, inputPorts, progress) });
}

/** Compose real Ed25519 checks under caller-provided local keys with neutral
 * clock/nonce ports. Labels/readbacks are NOT registry, IAM, time attestation,
 * revocation freshness or durability. Every result remains non-production.
 * After an uncertain operation or a post-consume failure, halt rather than
 * assume rollback, evict a nonce, retry silently or issue a cached approval. */
export function createReferenceAuthorityApprovalVerifier(input: unknown, inputPorts: unknown): ReferenceAuthorityApprovalVerifier {
  return createApprovalVerifier(input, inputPorts, clockProgress());
}
function createApprovalVerifier(input: unknown, inputPorts: unknown, progress: ClockProgress): ReferenceAuthorityApprovalVerifier {
  let config: Fields; let clock: CapturedPort; let nonceStore: CapturedPort;
  let scope: Fields; let verifierId: string; let readOnlyId: string;
  let clockIdentityRef: ArtifactReference; let nonceStoreIdentityRef: ArtifactReference;
  let timeoutMs: number; let maxVerifications: number; let maxUncertaintyMs: number;
  let recoveryPrincipal: RecoveryPrincipal | null = null;
  let signatureVerifier: ReturnType<typeof createReferenceAuthorizationSignatureVerifier>;
  try {
    config = snapshot(input);
    const required = ['executionProfile', 'scope', 'actors', 'clockIdentityRef',
      'nonceStoreIdentityRef', 'maxClockUncertaintyMs', 'operationTimeoutMs', 'maxVerifications', 'keys'];
    exact(config, Object.hasOwn(config, 'recoveryPrincipal') ? [...required, 'recoveryPrincipal'] : required);
    if (config.executionProfile !== 'local-reference') throw new Error();
    scope = record(config.scope); exact(scope, SCOPE_FIELDS); for (const field of SCOPE_FIELDS) identifier(scope[field]);
    const actors = record(config.actors); exact(actors, ['verifierId', 'readOnlyId']);
    verifierId = identifier(actors.verifierId); readOnlyId = identifier(actors.readOnlyId);
    if (verifierId === readOnlyId) throw new Error();
    if (Object.hasOwn(config, 'recoveryPrincipal') && config.recoveryPrincipal !== null) {
      const principal = record(config.recoveryPrincipal); exact(principal, ['actorId', 'roleId', 'credentialRef']);
      recoveryPrincipal = freeze({ actorId: identifier(principal.actorId), roleId: identifier(principal.roleId),
        credentialRef: reference(principal.credentialRef) });
      if (recoveryPrincipal.actorId !== verifierId) throw new Error();
    }
    clockIdentityRef = reference(config.clockIdentityRef); nonceStoreIdentityRef = reference(config.nonceStoreIdentityRef);
    timeoutMs = integer(config.operationTimeoutMs, 1, 60000); maxVerifications = integer(config.maxVerifications, 1, 10000);
    maxUncertaintyMs = integer(config.maxClockUncertaintyMs, 0, 60000);
    signatureVerifier = createReferenceAuthorizationSignatureVerifier({ executionProfile: 'local-reference', keys: config.keys });
    const surfaces = surface(inputPorts, ['clock', 'nonceStore']);
    clock = capture(surfaces.clock, ['readTime'], ['advanceTo', 'setAvailability']);
    nonceStore = capture(surfaces.nonceStore, ['consumeAuthorizationNonce', 'readExactNonceClaim'], []);
  } catch { throw new AuthorityApprovalError('invalid-config', 'configuration', 'not-attempted'); }
  let busy = false; let halted = false; let attempts = 0;
  const challenges = progress.challenges;
  const challenge = (): string => {
    for (let retry = 0; retry < 4; retry += 1) {
      const nonce = randomBytes(16).toString('hex');
      if (!challenges.has(nonce)) { challenges.add(nonce); return nonce; }
    }
    throw new Error();
  };
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    async verifyAndConsume(inputRequest: unknown): Promise<ReferenceAuthorityApprovalDecision> {
      if (halted) throw new AuthorityApprovalError('halted', 'preflight', 'not-attempted');
      if (busy) throw new AuthorityApprovalError('busy', 'preflight', 'not-attempted');
      if (attempts >= maxVerifications) throw new AuthorityApprovalError('attempt-capacity', 'preflight', 'not-attempted');
      let phase: Phase = 'preflight'; let nonceOutcome: NonceOutcome = 'not-attempted'; let active = false;
      try {
        let request: Fields; let context: AuthorityOperationContext;
        try {
          request = snapshot(inputRequest); exact(request, ['context', 'envelope', 'expectedPayload']);
          context = parseContext(request.context);
          if (context.executionProfile !== 'local-reference' || context.actorId !== verifierId
            || SCOPE_FIELDS.some(field => context.binding[field as keyof ArtifactRunBinding] !== scope[field])) throw new Error();
        } catch { throw new AuthorityApprovalError('invalid-request', phase, nonceOutcome); }
        let envelope: AuthorizationEnvelope;
        try {
          envelope = validateAuthorizationEnvelope(request.envelope).envelope;
          // Synthetic preflight time validates signature/key/payload without
          // spending clock/nonce capacity. It never becomes the verified time.
          signatureVerifier.verifySignature({ envelope, expectedPayload: request.expectedPayload, observedAt: envelope.payload.notBefore });
        } catch { throw new AuthorityApprovalError('signature-invalid', phase, nonceOutcome); }
        const expectedBinding = { ...envelope.payload.scope, runNonce: envelope.payload.runNonce, manifestHash: envelope.payload.manifestHash };
        // Ordinary grants belong to their signed executor. Recovery instead
        // requires the frozen rescue principal, independently assigned from
        // every signed participant; a role label is never an actor identity.
        const matchesConsumer = matchesApprovalConsumer(envelope, verifierId, recoveryPrincipal);
        if (!same(context.binding, expectedBinding) || readOnlyId !== envelope.payload.participants.readOnlyId
          || !matchesConsumer) {
          throw new AuthorityApprovalError('invalid-request', phase, nonceOutcome);
        }
        const expectedPayload = freeze(request.expectedPayload);
        busy = true; active = true; attempts += 1;
        const readClock = async (previousReading: AuthorityClockReading | null): Promise<AuthorityClockReading> => {
          const clockRequest = freeze({ context, requestNonce: challenge() });
          const raw = await observe(clock, 'readTime', clockRequest, timeoutMs, phase, nonceOutcome, 'clock-operation-failed');
          try {
            const reading = validateAuthorityClockReading(raw, { request: clockRequest, sourceIdentityRef: clockIdentityRef,
              maxUncertaintyMs, previousReading }).reading;
            const time = Date.parse(reading.observedAt);
            if (reading.sequence <= progress.lastSequence || time < progress.lastTime) throw new Error();
            for (const observed of [time - reading.uncertaintyMs, time + reading.uncertaintyMs]) {
              signatureVerifier.verifySignature({ envelope, expectedPayload, observedAt: new Date(observed).toISOString() });
            }
            progress.lastSequence = reading.sequence; progress.lastTime = time; return reading;
          } catch { throw new AuthorityApprovalError('clock-invalid', phase, nonceOutcome); }
        };
        phase = 'initial-clock'; const first = await readClock(null);
        const consumeRequest: ConsumeAuthorizationNonceRequest = freeze({ context,
          issuerId: envelope.payload.issuerId, authorizationNonce: envelope.payload.nonce,
          authorizationId: envelope.payload.authorizationId, authorizationKind: envelope.kind,
          envelopeDigest: canonicalJsonSha256(envelope), validFrom: envelope.payload.notBefore,
          expiresAt: envelope.payload.expiresAt, clockRequestNonce: first.requestNonce, clockReading: first });
        // Expected claim is derived exclusively from our frozen verified
        // request, not any field returned by the nonce store.
        const expectedClaim = claimFromRequest(consumeRequest);
        phase = 'consume'; nonceOutcome = 'unknown';
        const rawDecision = await observe(nonceStore, 'consumeAuthorizationNonce', consumeRequest,
          timeoutMs, phase, nonceOutcome, 'nonce-operation-failed');
        let claimRef: ArtifactReference;
        try {
          const decision = snapshot(rawDecision); exact(decision, ['status', 'claimRef']);
          if (decision.status === 'replayed' || decision.status === 'capacity-exhausted') {
            if (decision.claimRef !== null) throw new Error(); nonceOutcome = 'reported-not-consumed';
            throw new AuthorityApprovalError(decision.status === 'replayed' ? 'nonce-replayed' : 'nonce-capacity-exhausted', phase, nonceOutcome);
          }
          if (decision.status !== 'consumed') throw new Error(); nonceOutcome = 'reported-consumed';
          claimRef = reference(decision.claimRef);
          if (claimRef.sha256 !== canonicalJsonSha256(expectedClaim)) throw new Error();
        } catch (error) {
          if (error instanceof AuthorityApprovalError) throw error;
          throw new AuthorityApprovalError('nonce-response-invalid', phase, nonceOutcome);
        }
        phase = 'readback'; const readRequest = freeze({ context: { ...context, actorId: readOnlyId }, ref: claimRef });
        const rawReadback = await observe(nonceStore, 'readExactNonceClaim', readRequest,
          timeoutMs, phase, nonceOutcome, 'nonce-read-failed');
        try { validateNonceClaimReadback(rawReadback, { request: readRequest, storeIdentityRef: nonceStoreIdentityRef, expectedClaim }); }
        catch { throw new AuthorityApprovalError('nonce-read-invalid', phase, nonceOutcome); }
        // A slow consume/readback may outlive the authorization window. A
        // second independent time check is mandatory before returning success.
        phase = 'final-clock'; const final = await readClock(first);
        const core = freeze({ schemaVersion: AUTHORITY_APPROVAL_DECISION_SCHEMA, classification: 'confidential' as const,
          validationLevel: 'local-reference-authority-composition' as const, productionAuthorized: false as const,
          signatureVerified: true as const, nonceClaimMatched: true as const, binding: context.binding,
          kind: envelope.kind, stage: envelope.payload.stage, envelopeDigest: consumeRequest.envelopeDigest,
          consumerId: verifierId, readOnlyId, clockIdentityRef, nonceStoreIdentityRef,
          initialClockReadingHash: canonicalJsonSha256(first), finalClockReadingHash: canonicalJsonSha256(final),
          nonceClaimRef: claimRef, verifiedAt: final.observedAt, uncertaintyMs: final.uncertaintyMs });
        return freeze({ ...core, decisionHash: canonicalJsonSha256(core) });
      } catch (error) {
        const failure = error instanceof AuthorityApprovalError ? error : new AuthorityApprovalError('invalid-request', phase, nonceOutcome);
        if (failure.code === 'provider-contract-invalid' || failure.pendingCompletionUnknown
          || failure.nonceOutcome === 'unknown' || failure.nonceOutcome === 'reported-consumed') halted = true;
        throw failure;
      } finally { if (active) busy = false; }
    },
  });
}

/** Read an EXISTING claim without consuming its nonce or renewing its grant.
 * Historical signature validity and independently reconstructed claim equality
 * are distinct from current execution authority. Both results remain local.
 * Enterprise source authentication, revocation refresh and predecessor stage
 * acceptance must be composed separately; this observation cannot replace them. */
export function createReferenceAuthorityApprovalProvenanceVerifier(input: unknown, inputPorts: unknown): ReferenceAuthorityApprovalProvenanceVerifier {
  return createApprovalProvenanceVerifier(input, inputPorts, clockProgress());
}
function createApprovalProvenanceVerifier(input: unknown, inputPorts: unknown, progress: ClockProgress): ReferenceAuthorityApprovalProvenanceVerifier {
  let config: Fields; let clock: CapturedPort; let nonceStore: CapturedPort;
  let scope: Fields; let verifierId: string; let readOnlyId: string;
  let clockIdentityRef: ArtifactReference; let nonceStoreIdentityRef: ArtifactReference;
  let timeoutMs: number; let maxVerifications: number; let maxUncertaintyMs: number;
  let recoveryPrincipal: RecoveryPrincipal | null;
  let signatureVerifier: ReturnType<typeof createReferenceAuthorizationSignatureVerifier>;
  try {
    config = freeze(snapshot(input));
    // Reuse the existing closed configuration/capability validator. Construction
    // has no IO; do not duplicate or weaken its roles, keys, scope or budgets.
    createReferenceAuthorityApprovalVerifier(config, inputPorts);
    scope = record(config.scope); const actors = record(config.actors);
    verifierId = identifier(actors.verifierId); readOnlyId = identifier(actors.readOnlyId);
    clockIdentityRef = reference(config.clockIdentityRef); nonceStoreIdentityRef = reference(config.nonceStoreIdentityRef);
    timeoutMs = integer(config.operationTimeoutMs, 1, 60000); maxVerifications = integer(config.maxVerifications, 1, 10000);
    maxUncertaintyMs = integer(config.maxClockUncertaintyMs, 0, 60000);
    recoveryPrincipal = config.recoveryPrincipal == null ? null : config.recoveryPrincipal as unknown as RecoveryPrincipal;
    signatureVerifier = createReferenceAuthorizationSignatureVerifier({ executionProfile: 'local-reference', keys: config.keys });
    const surfaces = surface(inputPorts, ['clock', 'nonceStore']);
    clock = capture(surfaces.clock, ['readTime'], ['advanceTo', 'setAvailability']);
    nonceStore = capture(surfaces.nonceStore, ['readExactNonceClaim'], ['consumeAuthorizationNonce']);
  } catch { throw new AuthorityApprovalError('invalid-config', 'configuration', 'not-attempted'); }
  let busy = false; let halted = false; let attempts = 0;
  const challenges = progress.challenges;
  const challenge = (): string => {
    for (let retry = 0; retry < 4; retry++) {
      const nonce = randomBytes(16).toString('hex');
      if (!challenges.has(nonce)) { challenges.add(nonce); return nonce; }
    }
    throw new Error();
  };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    async verifyExistingClaim(inputRequest: unknown): Promise<ReferenceAuthorityApprovalProvenanceDecision> {
      if (halted) throw new AuthorityApprovalError('halted', 'preflight', 'not-attempted');
      if (busy) throw new AuthorityApprovalError('busy', 'preflight', 'not-attempted');
      if (attempts >= maxVerifications) throw new AuthorityApprovalError('attempt-capacity', 'preflight', 'not-attempted');
      let phase: Phase = 'preflight'; let active = false;
      try {
        const request = freeze(snapshot(inputRequest));
        exact(request, ['context', 'envelope', 'expectedPayload', 'nonceClaimRef', 'claimedClockReading']);
        const context = parseContext(request.context);
        if (context.actorId !== verifierId || SCOPE_FIELDS.some(field => context.binding[field as keyof ArtifactRunBinding] !== scope[field])) throw new Error();
        const envelope = validateAuthorizationEnvelope(request.envelope).envelope;
        const expectedPayload = request.expectedPayload;
        try { signatureVerifier.verifySignature({ envelope, expectedPayload, observedAt: envelope.payload.notBefore }); }
        catch { throw new AuthorityApprovalError('signature-invalid', phase, 'not-attempted'); }
        const expectedBinding = { ...envelope.payload.scope, runNonce: envelope.payload.runNonce, manifestHash: envelope.payload.manifestHash };
        if (!same(context.binding, expectedBinding) || readOnlyId !== envelope.payload.participants.readOnlyId
          || !matchesApprovalConsumer(envelope, verifierId, recoveryPrincipal)) throw new Error();
        const claimed = record(request.claimedClockReading);
        let original: AuthorityClockReading;
        try {
          original = validateAuthorityClockReading(claimed, { request: { context, requestNonce: claimed.requestNonce },
            sourceIdentityRef: clockIdentityRef, maxUncertaintyMs, previousReading: null }).reading;
          const time = Date.parse(original.observedAt);
          for (const observed of [time - original.uncertaintyMs, time + original.uncertaintyMs]) {
            signatureVerifier.verifySignature({ envelope, expectedPayload, observedAt: new Date(observed).toISOString() });
          }
        } catch { throw new AuthorityApprovalError('clock-invalid', phase, 'not-attempted'); }
        // Derive every expected claim field from signed expectation + the original
        // reading, never copy claimedAt/digest/consumer from nonce-store output.
        const consumeRequest: ConsumeAuthorizationNonceRequest = freeze({ context,
          issuerId: envelope.payload.issuerId, authorizationNonce: envelope.payload.nonce,
          authorizationId: envelope.payload.authorizationId, authorizationKind: envelope.kind,
          envelopeDigest: canonicalJsonSha256(envelope), validFrom: envelope.payload.notBefore,
          expiresAt: envelope.payload.expiresAt, clockRequestNonce: original.requestNonce, clockReading: original });
        const expectedClaim = claimFromRequest(consumeRequest); const claimRef = reference(request.nonceClaimRef);
        if (claimRef.sha256 !== canonicalJsonSha256(expectedClaim)) throw new Error();
        busy = true; active = true; attempts++;
        const readContext = freeze({ ...context, actorId: readOnlyId });
        const readClock = async (previousReading: AuthorityClockReading | null): Promise<AuthorityClockReading> => {
          const clockRequest = freeze({ context: readContext, requestNonce: challenge() });
          const raw = await observe(clock, 'readTime', clockRequest, timeoutMs, phase, 'not-attempted', 'clock-operation-failed');
          try {
            const reading = validateAuthorityClockReading(raw, { request: clockRequest, sourceIdentityRef: clockIdentityRef,
              maxUncertaintyMs, previousReading }).reading;
            const time = Date.parse(reading.observedAt);
            if (reading.sequence <= progress.lastSequence || reading.sequence <= original.sequence || time < progress.lastTime
              || time - reading.uncertaintyMs < Date.parse(original.observedAt) + original.uncertaintyMs
              || reading.requestNonce === original.requestNonce) throw new Error();
            // Current reads prove observation order, not an extension of the
            // signed approval window. An expired approval remains non-executable.
            progress.lastSequence = reading.sequence; progress.lastTime = time; return reading;
          } catch { throw new AuthorityApprovalError('clock-invalid', phase, 'not-attempted'); }
        };
        phase = 'initial-clock'; const first = await readClock(null);
        phase = 'readback'; const readRequest = freeze({ context: readContext, ref: claimRef });
        const raw = await observe(nonceStore, 'readExactNonceClaim', readRequest, timeoutMs, phase, 'not-attempted', 'nonce-read-failed');
        try { validateNonceClaimReadback(raw, { request: readRequest, storeIdentityRef: nonceStoreIdentityRef, expectedClaim }); }
        catch { throw new AuthorityApprovalError('nonce-read-invalid', phase, 'not-attempted'); }
        phase = 'final-clock'; const final = await readClock(first);
        const body = freeze({ schemaVersion: 'kg-reference-approval-provenance/v1' as const, classification: 'confidential' as const,
          validationLevel: 'local-reference-existing-approval-provenance' as const, productionAuthorized: false as const,
          executionAuthorized: false as const, nonceConsumedByThisVerifier: false as const,
          signatureVerified: true as const, nonceClaimMatched: true as const, binding: context.binding,
          kind: envelope.kind, stage: envelope.payload.stage, envelopeDigest: consumeRequest.envelopeDigest,
          consumerId: verifierId, readOnlyId, clockIdentityRef, nonceStoreIdentityRef, nonceClaimRef: claimRef,
          nonceReadbackHash: canonicalJsonSha256(raw), claimedAt: original.observedAt, claimedClockReadingHash: canonicalJsonSha256(original),
          initialClockReadingHash: canonicalJsonSha256(first), finalClockReadingHash: canonicalJsonSha256(final),
          verifiedAt: final.observedAt, uncertaintyMs: final.uncertaintyMs });
        return freeze({ ...body, decisionHash: canonicalJsonSha256(body) });
      } catch (error) {
        const failure = error instanceof AuthorityApprovalError ? error : new AuthorityApprovalError('invalid-request', phase, 'not-attempted');
        if (failure.pendingCompletionUnknown || failure.code === 'provider-contract-invalid') halted = true;
        throw failure;
      } finally { if (active) busy = false; }
    } });
}

function matchesApprovalConsumer(envelope: AuthorizationEnvelope, verifierId: string, recoveryPrincipal: RecoveryPrincipal | null): boolean {
  return envelope.kind === 'recovery'
    ? recoveryPrincipal !== null && recoveryPrincipal.actorId === verifierId
      && !Object.values(envelope.payload.participants).includes(verifierId)
      && envelope.payload.roleId === recoveryPrincipal.roleId
      && same(envelope.payload.credentialRef, recoveryPrincipal.credentialRef)
    : verifierId === envelope.payload.participants.executorId;
}

async function observe(port: CapturedPort, method: string, request: unknown, timeoutMs: number,
  phase: Phase, nonceOutcome: NonceOutcome, code: ErrorCode): Promise<unknown> {
  const result = await boundedProviderCall(() => Reflect.apply(port.methods[method], port.receiver, [request]), timeoutMs);
  if (result.status === 'timeout') throw new AuthorityApprovalError('operation-timeout', phase, nonceOutcome, result.pendingCompletionUnknown);
  if (result.status === 'invalid-return') throw new AuthorityApprovalError('provider-contract-invalid', phase, nonceOutcome, result.pendingCompletionUnknown);
  if (result.status === 'rejected') throw new AuthorityApprovalError(code, phase, nonceOutcome);
  // Return only detached JSON/void, never a provider object with a late then.
  try { return result.value === undefined ? undefined : freeze(JSON.parse(canonicalJson(result.value))); }
  catch { throw new AuthorityApprovalError(phase === 'consume' ? 'nonce-response-invalid'
    : phase === 'readback' ? 'nonce-read-invalid' : 'clock-invalid', phase, nonceOutcome); }
}
function claimFromRequest(request: ConsumeAuthorizationNonceRequest): AuthorizationNonceClaim {
  return freeze({ schemaVersion: AUTHORIZATION_NONCE_CLAIM_SCHEMA, classification: 'confidential',
    binding: request.context.binding, issuerId: request.issuerId,
    nonceIdentityHash: canonicalJsonSha256([request.issuerId, request.authorizationNonce]),
    authorizationId: request.authorizationId, authorizationKind: request.authorizationKind,
    envelopeDigest: request.envelopeDigest, validFrom: request.validFrom, expiresAt: request.expiresAt,
    clockReadingHash: canonicalJsonSha256(request.clockReading), claimedAt: request.clockReading.observedAt,
    consumerId: request.context.actorId });
}
function surface(input: unknown, allowed: readonly string[]): Fields {
  if (input === null || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input); const fields: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(); fields[key] = descriptor.value;
  }
  return fields;
}
function capture(input: unknown, methods: readonly string[], optionalControls: readonly string[]): CapturedPort {
  const fields = surface(input, ['executionProfile', 'productionCapable', ...methods, ...optionalControls]);
  if (fields.executionProfile !== 'local-reference' || fields.productionCapable !== false) throw new Error();
  const captured: Record<string, Operation> = Object.create(null);
  for (const name of [...methods, ...optionalControls]) {
    if (!Object.hasOwn(fields, name) && optionalControls.includes(name)) continue;
    if (!Object.hasOwn(fields, name) || typeof fields[name] !== 'function' || types.isProxy(fields[name])) throw new Error();
    captured[name] = fields[name] as Operation;
  }
  return Object.freeze({ receiver: input as object, methods: Object.freeze(captured) });
}
function parseContext(input: unknown): AuthorityOperationContext {
  const context = record(input); exact(context, ['executionProfile', 'binding', 'actorId']);
  if (context.executionProfile !== 'local-reference') throw new Error();
  const binding = record(context.binding); exact(binding, BINDING_FIELDS);
  validateArtifactAad({ ...binding, artifactType: 'report', artifactId: 'authority-binding', caseId: null,
    ordinal: 0, schemaVersion: 'kg-authority-binding/v1' });
  return freeze({ executionProfile: 'local-reference', binding: binding as unknown as ArtifactRunBinding, actorId: identifier(context.actorId) });
}
function reference(input: unknown): ArtifactReference {
  const value = record(input); exact(value, ['objectId', 'objectVersion', 'sha256']);
  identifier(value.objectId); identifier(value.objectVersion);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error(); return freeze(value) as unknown as ArtifactReference;
}
function identifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) throw new Error(); return input;
}
function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); return input;
}
function snapshot(input: unknown): Fields { return record(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields;
}
function exact(input: Fields, expected: readonly string[]): void {
  if (expected.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !expected.includes(field))) throw new Error();
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input;
}
