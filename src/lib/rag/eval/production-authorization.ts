import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import type { ArtifactReference, ProductionGateStage } from './production-gate-manifest';

export const AUTHORIZATION_SIGNATURE_PROFILE = 'kg-production-authorization-signature/v1' as const;
export const AUTHORIZATION_SCHEMAS = Object.freeze({
  execution: 'kg-execution-authorization-envelope/v1',
  result: 'kg-result-attestation-envelope/v1',
  recovery: 'kg-safety-recovery-authorization-envelope/v1',
} as const);
export const RECOVERY_ALLOWED_ACTIONS = Object.freeze([
  'withdraw-traffic', 'revoke-existing-fault', 'set-off', 'rollback-to-predecessor',
] as const);

export type AuthorizationKind = keyof typeof AUTHORIZATION_SCHEMAS;
export type RecoveryAction = typeof RECOVERY_ALLOWED_ACTIONS[number];
export interface AuthorizationScope {
  readonly environment: string;
  readonly tenantId: string;
  readonly corpusId: string;
}
export interface AuthorizationParticipants {
  readonly executionApproverId: string;
  readonly executorId: string;
  readonly readOnlyId: string;
  readonly resultAuthorityId: string;
  readonly recoveryAuthorityId: string | null;
}
interface CommonPayload {
  readonly stage: ProductionGateStage;
  readonly scope: AuthorizationScope;
  readonly manifestHash: string;
  readonly runNonce: string;
  readonly authorizationId: string;
  readonly nonce: string;
  readonly issuerId: string;
  readonly participants: AuthorizationParticipants;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
}
export interface ExecutionAuthorizationPayload extends CommonPayload {
  readonly operation: 'execute-t16-shadow' | 'execute-t17-canary' | 'verify-retention';
  readonly registryRef: ArtifactReference;
  readonly providersHash: string;
  readonly thresholdsHash: string;
  readonly window: { readonly startsAt: string; readonly endsAt: string };
}
export interface ResultAttestationPayload extends CommonPayload {
  readonly operation: 'attest-stage-result';
  readonly executionAuthorizationRef: ArtifactReference;
  readonly receiptCoreRef: ArtifactReference;
  readonly reportHash: string;
  readonly artifactIndexHash: string;
  readonly machineVerdict: 'passed' | 'failed' | 'aborted';
  readonly executionIdentityId: string;
  readonly finalStateHash: string;
  readonly completedAt: string;
}
export interface SafetyRecoveryAuthorizationPayload extends CommonPayload {
  readonly stage: 'T17';
  readonly operation: 'safety-recovery';
  readonly frozenPolicyHash: string;
  readonly originalExecutionAuthorizationRef: ArtifactReference;
  readonly originalFencingGeneration: number;
  readonly fencingGeneration: number;
  readonly lineage: {
    readonly predecessorRef: ArtifactReference;
    readonly targetRef: ArtifactReference;
    readonly expectedPointerRevision: number;
  };
  readonly rollbackExpectedPointerRevision: number;
  readonly allowedActions: readonly RecoveryAction[];
  readonly credentialRef: ArtifactReference;
  readonly roleId: string;
  readonly approvedMaxTtlMs: number;
}
export type AuthorizationPayload = ExecutionAuthorizationPayload | ResultAttestationPayload | SafetyRecoveryAuthorizationPayload;
interface Signature {
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly keyVersion: string;
  readonly value: string;
}
export type AuthorizationEnvelope = {
  [K in AuthorizationKind]: {
    readonly schemaVersion: typeof AUTHORIZATION_SCHEMAS[K];
    readonly kind: K;
    readonly payload: K extends 'execution' ? ExecutionAuthorizationPayload
      : K extends 'result' ? ResultAttestationPayload : SafetyRecoveryAuthorizationPayload;
    readonly signature: Signature;
  }
}[AuthorizationKind];
export interface AuthorizationStructure {
  readonly validationLevel: 'structural-only';
  readonly productionAuthorized: false;
  readonly envelopeDigest: string;
  readonly envelope: AuthorizationEnvelope;
}
export interface ReferenceApprovalDecision {
  readonly validationLevel: 'local-reference-cryptographic';
  readonly productionAuthorized: false;
  readonly signatureVerified: true;
  readonly envelopeDigest: string;
  readonly envelope: AuthorizationEnvelope;
  readonly verifiedAt: string;
}
export interface ReferenceApprovalVerifier {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  verifyOnce(input: unknown): ReferenceApprovalDecision;
}
export interface ReferenceSignatureDecision extends ReferenceApprovalDecision {
  readonly nonceConsumed: false;
}
export interface ReferenceAuthorizationSignatureVerifier {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  verifySignature(input: unknown): ReferenceSignatureDecision;
}

type Fields = Record<string, unknown>;
interface ReferenceKey {
  readonly keyId: string;
  readonly keyVersion: string;
  readonly issuerId: string;
  readonly role: AuthorizationKind;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly revoked: boolean;
  readonly publicKey: KeyObject;
}
const COMMON_FIELDS = ['stage', 'scope', 'manifestHash', 'runNonce', 'authorizationId', 'nonce',
  'issuerId', 'participants', 'issuedAt', 'notBefore', 'expiresAt'];
const KIND_FIELDS = {
  execution: ['operation', 'registryRef', 'providersHash', 'thresholdsHash', 'window'],
  result: ['operation', 'executionAuthorizationRef', 'receiptCoreRef', 'reportHash', 'artifactIndexHash',
    'machineVerdict', 'executionIdentityId', 'finalStateHash', 'completedAt'],
  recovery: ['operation', 'frozenPolicyHash', 'originalExecutionAuthorizationRef', 'originalFencingGeneration',
    'fencingGeneration', 'lineage', 'rollbackExpectedPointerRevision', 'allowedActions', 'credentialRef', 'roleId', 'approvedMaxTtlMs'],
};
const MAX_TTL_MS = { execution: 86400000, result: 3600000, recovery: 300000 };
const ROLE_FIELDS = ['executionApproverId', 'executorId', 'readOnlyId', 'resultAuthorityId', 'recoveryAuthorityId'];

/** A schema check is not an approval. No input can promote this view to production. */
export function validateAuthorizationEnvelope(input: unknown): AuthorizationStructure {
  const root = snapshot(input, '$');
  exactKeys(root, ['schemaVersion', 'kind', 'payload', 'signature'], '$');
  const kind = select(root.kind, ['execution', 'result', 'recovery'], '$.kind') as AuthorizationKind;
  if (root.schemaVersion !== AUTHORIZATION_SCHEMAS[kind]) fail('$.schemaVersion', 'kind/schema mismatch');
  validatePayload(record(root.payload, '$.payload'), kind);
  const signature = record(root.signature, '$.signature');
  exactKeys(signature, ['algorithm', 'keyId', 'keyVersion', 'value'], '$.signature');
  if (signature.algorithm !== 'Ed25519') fail('$.signature.algorithm', 'unsupported signature profile');
  identifier(signature.keyId, '$.signature.keyId'); identifier(signature.keyVersion, '$.signature.keyVersion');
  base64url(signature.value, '$.signature.value', 64);
  return freeze({ validationLevel: 'structural-only', productionAuthorized: false,
    envelopeDigest: canonicalJsonSha256(root), envelope: root as unknown as AuthorizationEnvelope });
}

/**
 * This in-memory verifier tests the approval contract only. Caller-supplied keys,
 * time and expected payload are NOT deployment trust roots, a trusted clock or a
 * durable nonce authority. Keep a separate factory/profile for enterprise ports.
 */
export function createReferenceApprovalVerifier(options: unknown): ReferenceApprovalVerifier {
  const config = snapshot(options, '$.reference');
  exactKeys(config, ['executionProfile', 'maxConsumedNonces', 'keys'], '$.reference');
  if (config.executionProfile !== 'local-reference') fail('$.reference.executionProfile', 'reference adapter cannot serve production');
  const capacity = positiveInteger(config.maxConsumedNonces, '$.reference.maxConsumedNonces', 10000);
  const keys = parseReferenceKeys(config.keys);
  const consumed = new Set<string>();
  let lastObservedTime = -Infinity;
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    verifyOnce(input: unknown): ReferenceApprovalDecision {
      const decision = verifyReferenceSignature(input, keys, lastObservedTime);
      const { payload } = decision.envelope;
      const nonceIdentity = canonicalJson([payload.issuerId, payload.nonce]);
      if (consumed.has(nonceIdentity)) fail('$.verification.nonce', 'authorization replay is forbidden');
      if (consumed.size >= capacity) fail('$.verification.nonce', 'reference nonce capacity exhausted');
      // There is no await between checking and consuming. This is atomic only
      // inside this process, not across instances, restarts or a distributed run.
      consumed.add(nonceIdentity); lastObservedTime = Date.parse(decision.verifiedAt);
      return decision;
    },
  });
}

/** Stateless crypto-only seam for a clock/nonce composer. Repeated checks do
 * NOT approve execution, consume a nonce, refresh keys or authenticate time. */
export function createReferenceAuthorizationSignatureVerifier(options: unknown): ReferenceAuthorizationSignatureVerifier {
  const config = snapshot(options, '$.reference');
  exactKeys(config, ['executionProfile', 'keys'], '$.reference');
  if (config.executionProfile !== 'local-reference') fail('$.reference.executionProfile', 'reference adapter cannot serve production');
  const keys = parseReferenceKeys(config.keys);
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    verifySignature(input: unknown): ReferenceSignatureDecision {
      return freeze({ ...verifyReferenceSignature(input, keys, -Infinity), nonceConsumed: false });
    },
  });
}

function parseReferenceKeys(input: unknown): Map<string, ReferenceKey> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) fail('$.reference.keys', 'requires 1..64 local public keys');
  const keys = new Map<string, ReferenceKey>();
  const publicKeyIdentities = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const path = `$.reference.keys[${index}]`;
    const value = record(input[index], path);
    exactKeys(value, ['keyId', 'keyVersion', 'issuerId', 'role', 'publicKeySpki', 'validFrom', 'validUntil', 'revoked'], path);
    for (const field of ['keyId', 'keyVersion', 'issuerId']) identifier(value[field], `${path}.${field}`);
    const role = select(value.role, ['execution', 'result', 'recovery'], `${path}.role`) as AuthorizationKind;
    const validFrom = timestamp(value.validFrom, `${path}.validFrom`);
    const validUntil = timestamp(value.validUntil, `${path}.validUntil`);
    if (validUntil <= validFrom) fail(path, 'key validity interval is empty');
    if (typeof value.revoked !== 'boolean') fail(`${path}.revoked`, 'must be an explicit boolean');
    const keyBytes = base64url(value.publicKeySpki, `${path}.publicKeySpki`, 44);
    let publicKey: KeyObject;
    try { publicKey = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' }); }
    catch { fail(`${path}.publicKeySpki`, 'invalid Ed25519 public key'); }
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
      || publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') !== value.publicKeySpki) {
      fail(`${path}.publicKeySpki`, 'invalid canonical Ed25519 public key');
    }
    const keyIdentity = canonicalJson([value.keyId, value.keyVersion]);
    // Separate principal labels do not establish separation if the same private
    // key can sign both roles. Reject aliases even across key versions.
    if (keys.has(keyIdentity) || publicKeyIdentities.has(value.publicKeySpki as string)) fail(path, 'duplicate or reused signer key');
    publicKeyIdentities.add(value.publicKeySpki as string);
    keys.set(keyIdentity, { keyId: value.keyId as string, keyVersion: value.keyVersion as string,
      issuerId: value.issuerId as string, role, validFrom, validUntil, revoked: value.revoked, publicKey });
  }

  return keys;
}

function verifyReferenceSignature(input: unknown, keys: ReadonlyMap<string, ReferenceKey>, lastObservedTime: number): ReferenceApprovalDecision {
  const request = snapshot(input, '$.verification');
  exactKeys(request, ['envelope', 'expectedPayload', 'observedAt'], '$.verification');
  const structured = validateAuthorizationEnvelope(request.envelope);
  const { envelope } = structured;
  const expected = record(request.expectedPayload, '$.verification.expectedPayload');
  // The caller must derive this from frozen manifest/core/policy and actual
  // fence readback; extracting it from the envelope itself proves nothing.
  if (canonicalJson(expected) !== canonicalJson(envelope.payload)) fail('$.verification.expectedPayload', 'trusted expectation does not match');
  const now = timestamp(request.observedAt, '$.verification.observedAt');
  if (now < lastObservedTime) fail('$.verification.observedAt', 'local clock moved backwards');
  const { signature, payload } = envelope;
  const key = keys.get(canonicalJson([signature.keyId, signature.keyVersion]));
  if (!key || key.revoked || key.role !== envelope.kind || key.issuerId !== payload.issuerId) {
    fail('$.verification.key', 'unknown, revoked, stale-version or wrong-role signer');
  }
  const issued = Date.parse(payload.issuedAt); const expiry = Date.parse(payload.expiresAt);
  if (now < Date.parse(payload.notBefore) || now >= expiry || issued < key.validFrom
    || expiry > key.validUntil || now < key.validFrom || now >= key.validUntil) {
    fail('$.verification.time', 'authorization/key is outside its valid interval');
  }
  const signer = { algorithm: signature.algorithm, keyId: signature.keyId, keyVersion: signature.keyVersion };
  const signedBytes = canonicalJson({ signatureProfile: AUTHORIZATION_SIGNATURE_PROFILE,
    schemaVersion: envelope.schemaVersion, kind: envelope.kind, payload, signer });
  let validSignature = false;
  try { validSignature = verify(null, Buffer.from(signedBytes, 'utf8'), key.publicKey, Buffer.from(signature.value, 'base64url')); }
  catch { fail('$.verification.signature', 'signature verification failed'); }
  if (!validSignature) fail('$.verification.signature', 'signature verification failed');
  return freeze({ validationLevel: 'local-reference-cryptographic', productionAuthorized: false,
    signatureVerified: true, envelopeDigest: structured.envelopeDigest, envelope, verifiedAt: request.observedAt as string });
}

function validatePayload(payload: Fields, kind: AuthorizationKind): void {
  const path = '$.payload';
  exactKeys(payload, [...COMMON_FIELDS, ...KIND_FIELDS[kind]], path);
  const stage = select(payload.stage, ['T16', 'T17', 'R18'], `${path}.stage`);
  const scope = record(payload.scope, `${path}.scope`);
  exactKeys(scope, ['environment', 'tenantId', 'corpusId'], `${path}.scope`);
  for (const key of ['environment', 'tenantId', 'corpusId']) identifier(scope[key], `${path}.scope.${key}`);
  digest(payload.manifestHash, `${path}.manifestHash`); hex(payload.runNonce, 32, `${path}.runNonce`);
  hex(payload.nonce, 32, `${path}.nonce`);
  identifier(payload.authorizationId, `${path}.authorizationId`); identifier(payload.issuerId, `${path}.issuerId`);
  const participants = record(payload.participants, `${path}.participants`);
  exactKeys(participants, ROLE_FIELDS, `${path}.participants`);
  for (const field of ROLE_FIELDS) {
    if (field === 'recoveryAuthorityId' && stage !== 'T17') {
      if (participants[field] !== null) fail(`${path}.participants`, 'non-canary stage cannot assign recovery authority');
    } else identifier(participants[field], `${path}.participants.${field}`);
  }
  const identities = Object.values(participants).filter(value => value !== null);
  if (new Set(identities).size !== identities.length) fail(`${path}.participants`, 'approver/executor/readback/result/recovery duties must be separate');
  const authorityField = kind === 'execution' ? 'executionApproverId' : kind === 'result' ? 'resultAuthorityId' : 'recoveryAuthorityId';
  if (payload.issuerId !== participants[authorityField]) fail(`${path}.issuerId`, 'issuer is not the authority for this envelope kind');
  const issued = timestamp(payload.issuedAt, `${path}.issuedAt`);
  const notBefore = timestamp(payload.notBefore, `${path}.notBefore`);
  const expiry = timestamp(payload.expiresAt, `${path}.expiresAt`);
  if (notBefore < issued || expiry <= notBefore || expiry - issued > MAX_TTL_MS[kind]) fail(path, 'authorization validity/TTL outside profile bounds');

  if (kind === 'execution') {
    const operation = stage === 'T16' ? 'execute-t16-shadow' : stage === 'T17' ? 'execute-t17-canary' : 'verify-retention';
    if (payload.operation !== operation) fail(`${path}.operation`, 'stage/operation mismatch');
    reference(payload.registryRef, `${path}.registryRef`);
    digest(payload.providersHash, `${path}.providersHash`); digest(payload.thresholdsHash, `${path}.thresholdsHash`);
    const window = record(payload.window, `${path}.window`);
    exactKeys(window, ['startsAt', 'endsAt'], `${path}.window`);
    const start = timestamp(window.startsAt, `${path}.window.startsAt`);
    const end = timestamp(window.endsAt, `${path}.window.endsAt`);
    if (end <= start || end - start > MAX_TTL_MS.execution || notBefore < start || expiry > end) fail(`${path}.window`, 'authorization must fit the approved bounded window');
  } else if (kind === 'result') {
    if (payload.operation !== 'attest-stage-result') fail(`${path}.operation`, 'not a result attestation');
    reference(payload.executionAuthorizationRef, `${path}.executionAuthorizationRef`);
    reference(payload.receiptCoreRef, `${path}.receiptCoreRef`);
    for (const field of ['reportHash', 'artifactIndexHash', 'finalStateHash']) digest(payload[field], `${path}.${field}`);
    select(payload.machineVerdict, ['passed', 'failed', 'aborted'], `${path}.machineVerdict`);
    if (payload.executionIdentityId !== participants.executorId) fail(`${path}.executionIdentityId`, 'execution identity mismatch');
    if (timestamp(payload.completedAt, `${path}.completedAt`) > issued) fail(`${path}.completedAt`, 'result attestation precedes completion');
  } else {
    if (stage !== 'T17' || payload.operation !== 'safety-recovery') fail(`${path}.operation`, 'only T17 safety recovery is supported');
    digest(payload.frozenPolicyHash, `${path}.frozenPolicyHash`);
    reference(payload.originalExecutionAuthorizationRef, `${path}.originalExecutionAuthorizationRef`);
    const originalFence = positiveInteger(payload.originalFencingGeneration, `${path}.originalFencingGeneration`);
    const actualFence = positiveInteger(payload.fencingGeneration, `${path}.fencingGeneration`);
    if (actualFence <= originalFence) fail(`${path}.fencingGeneration`, 'recovery requires an actual new fencing generation');
    const lineage = record(payload.lineage, `${path}.lineage`);
    exactKeys(lineage, ['predecessorRef', 'targetRef', 'expectedPointerRevision'], `${path}.lineage`);
    reference(lineage.predecessorRef, `${path}.lineage.predecessorRef`); reference(lineage.targetRef, `${path}.lineage.targetRef`);
    if (canonicalJson(lineage.predecessorRef) === canonicalJson(lineage.targetRef)) fail(`${path}.lineage`, 'predecessor and target must be distinct');
    const frozenRevision = lineage.expectedPointerRevision;
    if (typeof frozenRevision !== 'number' || !Number.isSafeInteger(frozenRevision)
      || frozenRevision < 0 || frozenRevision > Number.MAX_SAFE_INTEGER - 2) fail(`${path}.lineage.expectedPointerRevision`, 'no safe Pointer revision budget for publication and rollback');
    // This run publishes target exactly once at N+1. Seeing the same target at
    // N+3 is an ABA/foreign publication, not permission to refresh and roll back.
    if (payload.rollbackExpectedPointerRevision !== frozenRevision + 1) fail(`${path}.rollbackExpectedPointerRevision`, 'rollback CAS revision must be the unique successor of frozen lineage');
    if (!Array.isArray(payload.allowedActions) || payload.allowedActions.length < 1
      || payload.allowedActions.length > RECOVERY_ALLOWED_ACTIONS.length) fail(`${path}.allowedActions`, 'requires a bounded risk-reducing action set');
    payload.allowedActions.forEach(action => select(action, RECOVERY_ALLOWED_ACTIONS, `${path}.allowedActions`));
    if (new Set(payload.allowedActions).size !== payload.allowedActions.length) fail(`${path}.allowedActions`, 'duplicate recovery action');
    reference(payload.credentialRef, `${path}.credentialRef`); identifier(payload.roleId, `${path}.roleId`);
    const ttl = positiveInteger(payload.approvedMaxTtlMs, `${path}.approvedMaxTtlMs`, MAX_TTL_MS.recovery);
    if (expiry - issued > ttl) fail(`${path}.expiresAt`, 'recovery exceeds the frozen policy TTL');
  }
}

function snapshot(input: unknown, path: string): Fields { return record(JSON.parse(canonicalJson(input)), path); }
function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'required object is absent');
  return input as Fields;
}
function exactKeys(input: Fields, expected: readonly string[], path: string): void {
  if (expected.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !expected.includes(key))) {
    fail(path, 'required fields are absent or unsupported fields are present');
  }
}
function reference(input: unknown, path: string): void {
  const ref = record(input, path); exactKeys(ref, ['objectId', 'objectVersion', 'sha256'], path);
  identifier(ref.objectId, `${path}.objectId`); identifier(ref.objectVersion, `${path}.objectVersion`); digest(ref.sha256, `${path}.sha256`);
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'must be a bounded opaque identifier');
}
function positiveInteger(input: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > maximum) fail(path, 'integer outside profile bounds');
  return input;
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'must be an exact lowercase hexadecimal identity');
}
function digest(input: unknown, path: string): void { hex(input, 64, path); }
function select(input: unknown, allowed: readonly string[], path: string): string {
  if (typeof input !== 'string' || !allowed.includes(input)) fail(path, 'outside the closed set');
  return input;
}
function timestamp(input: unknown, path: string): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(path, 'must be a canonical UTC timestamp');
  return Date.parse(input);
}
function base64url(input: unknown, path: string, bytes: number): Buffer {
  if (typeof input !== 'string' || input.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input)) fail(path, 'invalid public key/signature encoding');
  const decoded = Buffer.from(input, 'base64url');
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== input) fail(path, 'invalid public key/signature encoding or length');
  return decoded;
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input)) freeze(value);
    Object.freeze(input);
  }
  return input;
}
function fail(path: string, reason: string): never { throw new Error(`[production authorization] ${path}: ${reason}`); }
