import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import type { ArtifactReference } from './production-gate-manifest';

export const CONTROLLED_ARTIFACT_AEAD_SCHEMA = 'kg-controlled-artifact-aead/v1' as const;
export const CONTROLLED_ARTIFACT_OBJECT_SCHEMA = 'kg-controlled-artifact-object/v1' as const;
export const CONTROLLED_ARTIFACT_INDEX_SCHEMA = 'kg-controlled-artifact-index/v1' as const;
export const CONTROLLED_ARTIFACT_TYPES = Object.freeze(['request', 'gold', 'response', 'error',
  'telemetry', 'report', 'artifact-index', 'receipt-core', 'result-attestation', 'readback-proof', 'acceptance-bundle'] as const);

export interface ArtifactRunBinding {
  readonly environment: string;
  readonly tenantId: string;
  readonly corpusId: string;
  readonly runNonce: string;
  readonly manifestHash: string;
}
export interface ArtifactAad extends ArtifactRunBinding {
  readonly artifactType: typeof CONTROLLED_ARTIFACT_TYPES[number];
  readonly artifactId: string;
  readonly caseId: string | null;
  readonly ordinal: number;
  readonly schemaVersion: string;
}
/** Context is data, not an authorization capability. Enterprise adapters must
 * verify the referenced approval, principal and trusted time independently. */
export interface ArtifactOperationContext {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly binding: ArtifactRunBinding;
  readonly actorId: string;
  readonly authorizationDigest: string;
  readonly observedAt: string;
}
export interface EncryptedArtifact {
  readonly schemaVersion: typeof CONTROLLED_ARTIFACT_AEAD_SCHEMA;
  readonly algorithm: 'AES-256-GCM';
  readonly keyRef: ArtifactReference;
  readonly nonce: string;
  readonly aadSha256: string;
  readonly ciphertext: string;
  readonly tag: string;
}
export interface ArtifactEncryptRequest {
  readonly context: ArtifactOperationContext;
  readonly aad: ArtifactAad;
  readonly plaintextBase64url: string;
}
export interface ArtifactDecryptRequest {
  readonly context: ArtifactOperationContext;
  readonly aad: ArtifactAad;
  readonly envelope: EncryptedArtifact;
}
export interface KmsEnvelopePort {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly productionCapable: boolean;
  encryptArtifact(request: ArtifactEncryptRequest): Promise<EncryptedArtifact>;
  decryptArtifact(request: ArtifactDecryptRequest): Promise<string>;
  rotateKey(request: { readonly context: ArtifactOperationContext }): Promise<ArtifactReference>;
  revokeKey(request: { readonly context: ArtifactOperationContext; readonly keyRef: ArtifactReference }): Promise<void>;
}
export interface ControlledArtifactObject {
  readonly schemaVersion: typeof CONTROLLED_ARTIFACT_OBJECT_SCHEMA;
  readonly aad: ArtifactAad;
  readonly envelope: EncryptedArtifact;
  readonly retainUntil: string;
}
export interface ArtifactObjectProof {
  readonly assurance: 'enterprise' | 'local-reference';
  readonly productionTamperResistant: boolean;
  readonly storeIdentityRef: ArtifactReference;
  readonly objectRef: ArtifactReference;
  readonly lockMode: 'compliance-worm' | 'local-reference-immutable';
  readonly retainUntil: string;
  readonly readerId: string;
  readonly observedAt: string;
}
export interface ArtifactSealRequest {
  readonly context: ArtifactOperationContext;
  readonly aad: ArtifactAad;
  readonly envelope: EncryptedArtifact;
  readonly retainUntil: string;
}
export interface ArtifactExactReadback {
  readonly object: ControlledArtifactObject;
  readonly proof: ArtifactObjectProof;
}
/** A proof's booleans are never sufficient for acceptance. The receipt verifier
 * must authenticate the independent store reader and exact immutable object. */
export interface TamperResistantArtifactStore {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly productionCapable: boolean;
  sealEncryptedArtifact(request: ArtifactSealRequest): Promise<ArtifactReference>;
  readExact(request: { readonly context: ArtifactOperationContext; readonly ref: ArtifactReference }): Promise<ArtifactExactReadback>;
}
export interface ReferenceKmsEnvelope extends KmsEnvelopePort {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
}
export interface ReferenceArtifactStore extends TamperResistantArtifactStore {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
}
export interface ControlledArtifactIndexEntry {
  readonly artifactId: string;
  readonly artifactType: ArtifactAad['artifactType'];
  readonly caseId: string | null;
  readonly ordinal: number;
  readonly schemaVersion: string;
  readonly objectRef: ArtifactReference;
  readonly keyRef: ArtifactReference;
  readonly aadSha256: string;
}
export interface ControlledArtifactIndex {
  readonly schemaVersion: typeof CONTROLLED_ARTIFACT_INDEX_SCHEMA;
  readonly classification: 'confidential';
  readonly binding: ArtifactRunBinding;
  readonly entries: readonly ControlledArtifactIndexEntry[];
}

type Fields = Record<string, unknown>;
interface ReferenceOptions {
  readonly binding: ArtifactRunBinding;
  readonly actors: { readonly executorId: string; readonly readOnlyId: string };
  readonly validFrom: number;
  readonly validUntil: number;
  readonly maxObjects: number;
}
const BINDING_FIELDS = ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash'];
const AAD_FIELDS = [...BINDING_FIELDS, 'artifactType', 'artifactId', 'caseId', 'ordinal', 'schemaVersion'];
const CONTEXT_FIELDS = ['executionProfile', 'binding', 'actorId', 'authorizationDigest', 'observedAt'];
const COMMON_OPTIONS = ['executionProfile', 'binding', 'actors', 'validFrom', 'validUntil', 'maxObjects'];
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_OBJECT_BYTES = 256 * 1024;
const MAX_KEYS = 32;

export function validateArtifactAad(input: unknown): ArtifactAad {
  const aad = snapshot(input);
  exact(aad, AAD_FIELDS, 'aad'); validateBinding(aad, false);
  if (typeof aad.artifactType !== 'string' || !CONTROLLED_ARTIFACT_TYPES.includes(aad.artifactType as ArtifactAad['artifactType'])) fail('aad.artifactType', 'outside closed artifact type set');
  identifier(aad.artifactId, 'aad.artifactId');
  if (aad.caseId !== null) hex(aad.caseId, 32, 'aad.caseId');
  if (['request', 'gold', 'response'].includes(aad.artifactType) && aad.caseId === null) fail('aad.caseId', 'case identity required for case-bound artifact');
  integer(aad.ordinal, 0, 1000000, 'aad.ordinal');
  if (typeof aad.schemaVersion !== 'string' || !/^[a-z][a-z0-9-]{0,63}\/v[1-9][0-9]{0,2}$/.test(aad.schemaVersion)) fail('aad.schemaVersion', 'bounded versioned artifact schema required');
  return freeze(aad) as unknown as ArtifactAad;
}

export function validateEncryptedArtifact(input: unknown): EncryptedArtifact {
  const envelope = snapshot(input);
  exact(envelope, ['schemaVersion', 'algorithm', 'keyRef', 'nonce', 'aadSha256', 'ciphertext', 'tag'], 'envelope');
  if (envelope.schemaVersion !== CONTROLLED_ARTIFACT_AEAD_SCHEMA || envelope.algorithm !== 'AES-256-GCM') fail('envelope', 'unsupported AEAD profile');
  reference(envelope.keyRef, 'envelope.keyRef'); hex(envelope.aadSha256, 64, 'envelope.aadSha256');
  const nonce = bytes(envelope.nonce, 12, 'envelope.nonce'); const tag = bytes(envelope.tag, 16, 'envelope.tag');
  try {
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) fail('envelope', 'invalid AEAD nonce/tag length');
    const ciphertext = bytes(envelope.ciphertext, MAX_PLAINTEXT_BYTES, 'envelope.ciphertext'); ciphertext.fill(0);
  } finally { nonce.fill(0); tag.fill(0); }
  return freeze(envelope) as unknown as EncryptedArtifact;
}

/** This is a bounded confidential index page, not proof of completeness,
 * encryption authenticity, retention lock, approval or stage acceptance. */
export function validateControlledArtifactIndex(input: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAccepted: false;
  readonly indexHash: string; readonly index: ControlledArtifactIndex;
} {
  const index = snapshot(input); exact(index, ['schemaVersion', 'classification', 'binding', 'entries'], 'index');
  if (index.schemaVersion !== CONTROLLED_ARTIFACT_INDEX_SCHEMA || index.classification !== 'confidential') fail('index', 'versioned confidential index required');
  const binding = validateBinding(record(index.binding, 'index.binding'), true);
  if (!Array.isArray(index.entries) || index.entries.length < 1 || index.entries.length > 256) fail('index.entries', 'bounded nonempty index page required');
  const ids = new Set<string>(); const slots = new Set<string>();
  index.entries.forEach((inputEntry, ordinal) => {
    const path = `index.entries[${ordinal}]`; const entry = record(inputEntry, path);
    exact(entry, ['artifactId', 'artifactType', 'caseId', 'ordinal', 'schemaVersion', 'objectRef', 'keyRef', 'aadSha256'], path);
    const aad = validateArtifactAad({ ...binding, ...Object.fromEntries(['artifactId', 'artifactType', 'caseId',
      'ordinal', 'schemaVersion'].map(field => [field, entry[field]])) });
    const objectRef = reference(entry.objectRef, `${path}.objectRef`); reference(entry.keyRef, `${path}.keyRef`);
    hex(entry.aadSha256, 64, `${path}.aadSha256`);
    if (objectRef.objectId !== aad.artifactId || entry.aadSha256 !== canonicalJsonSha256(aad)) fail(path, 'object/AAD identity mismatch');
    const slot = canonicalJson([aad.artifactType, aad.caseId, aad.ordinal]);
    if (ids.has(aad.artifactId) || slots.has(slot)) fail(path, 'duplicate object or semantic artifact slot');
    ids.add(aad.artifactId); slots.add(slot);
  });
  return freeze({ validationLevel: 'structural-only', productionAccepted: false,
    indexHash: canonicalJsonSha256(index), index: index as unknown as ControlledArtifactIndex });
}

/** In-memory behavioral reference only: no durable key escrow, enterprise KMS,
 * approval authority, revocation registry, trusted clock or restart continuity. */
export function createReferenceKmsEnvelope(input: unknown): ReferenceKmsEnvelope {
  const options = snapshot(input); exact(options, [...COMMON_OPTIONS, 'keyPolicyRef', 'maxPlaintextBytes'], 'kms.options');
  const common = parseOptions(options); const policyRef = reference(options.keyPolicyRef, 'kms.options.keyPolicyRef');
  const maxPlaintextBytes = integer(options.maxPlaintextBytes, 1, MAX_PLAINTEXT_BYTES, 'kms.options.maxPlaintextBytes');
  const guard = referenceGuard(common);
  const keys = new Map<string, { ref: ArtifactReference; material: Buffer; revoked: boolean }>();
  const encryptedIds = new Set<string>();
  // One counter survives key rotation; a key never sees a repeated nonce and
  // object/nonce history is never evicted to make capacity available.
  const noncePrefix = randomBytes(4); let nonceCounter = BigInt(0);
  const generateKey = (): ArtifactReference => {
    if (keys.size >= MAX_KEYS) fail('kms', 'key capacity exhausted');
    const objectId = `reference-key-${randomBytes(16).toString('hex')}`;
    const ref = freeze({ objectId, objectVersion: `key-${keys.size + 1}`,
      sha256: canonicalJsonSha256({ schemaVersion: 'kg-reference-key-identity/v1', objectId,
        generation: keys.size + 1, binding: common.binding, policyRef }) });
    keys.set(canonicalJson(ref), { ref, material: randomBytes(32), revoked: false }); return ref;
  };
  let activeKey = generateKey();
  const resolveKey = (ref: ArtifactReference) => {
    const key = keys.get(canonicalJson(ref));
    if (!key || key.revoked) fail('kms.keyRef', 'unknown or revoked key'); return key;
  };
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    async encryptArtifact(inputRequest: unknown): Promise<EncryptedArtifact> {
      const request = snapshot(inputRequest); exact(request, ['context', 'aad', 'plaintextBase64url'], 'kms.encrypt');
      const now = guard.check(request.context, 'executorId');
      const aad = validateArtifactAad(request.aad); matchBinding(aad, common.binding);
      if (encryptedIds.has(aad.artifactId)) fail('kms.encrypt', 'object identity already encrypted');
      if (encryptedIds.size >= common.maxObjects) fail('kms.encrypt', 'object capacity exhausted');
      const key = resolveKey(activeKey);
      const plaintext = bytes(request.plaintextBase64url, maxPlaintextBytes, 'kms.encrypt.plaintext');
      const nonce = Buffer.alloc(12); noncePrefix.copy(nonce); nonce.writeBigUInt64BE(nonceCounter, 4); nonceCounter += BigInt(1);
      let ciphertext: Buffer | undefined; let authenticatedData: Buffer | undefined;
      try {
        authenticatedData = Buffer.from(canonicalJson(aad));
        const cipher = createCipheriv('aes-256-gcm', key.material, nonce, { authTagLength: 16 });
        cipher.setAAD(authenticatedData);
        ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const result = freeze({ schemaVersion: CONTROLLED_ARTIFACT_AEAD_SCHEMA, algorithm: 'AES-256-GCM' as const,
          keyRef: key.ref, nonce: nonce.toString('base64url'), aadSha256: canonicalJsonSha256(aad),
          ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
        encryptedIds.add(aad.artifactId); guard.commit(now); return result;
      } catch { fail('kms.encrypt', 'AEAD encryption failed'); }
      finally { plaintext.fill(0); nonce.fill(0); ciphertext?.fill(0); authenticatedData?.fill(0); }
    },
    async decryptArtifact(inputRequest: unknown): Promise<string> {
      const request = snapshot(inputRequest); exact(request, ['context', 'aad', 'envelope'], 'kms.decrypt');
      const now = guard.check(request.context, 'readOnlyId');
      const aad = validateArtifactAad(request.aad); matchBinding(aad, common.binding);
      const envelope = validateEncryptedArtifact(request.envelope);
      if (envelope.aadSha256 !== canonicalJsonSha256(aad)) fail('kms.decrypt', 'AAD identity mismatch');
      const key = resolveKey(envelope.keyRef);
      const ciphertext = bytes(envelope.ciphertext, maxPlaintextBytes, 'kms.decrypt.ciphertext');
      const nonce = bytes(envelope.nonce, 12, 'kms.decrypt.nonce'); const tag = bytes(envelope.tag, 16, 'kms.decrypt.tag');
      let plaintext: Buffer | undefined; let pending: Buffer | undefined; let authenticatedData: Buffer | undefined;
      try {
        authenticatedData = Buffer.from(canonicalJson(aad));
        const decipher = createDecipheriv('aes-256-gcm', key.material, nonce, { authTagLength: 16 });
        decipher.setAAD(authenticatedData); decipher.setAuthTag(tag);
        // Do not release update() plaintext until final() authenticates the tag.
        pending = decipher.update(ciphertext);
        plaintext = Buffer.concat([pending, decipher.final()]);
        const result = plaintext.toString('base64url'); guard.commit(now); return result;
      } catch { fail('kms.decrypt', 'AEAD authentication failed'); }
      finally { plaintext?.fill(0); pending?.fill(0); ciphertext.fill(0); nonce.fill(0); tag.fill(0); authenticatedData?.fill(0); }
    },
    async rotateKey(inputRequest: unknown): Promise<ArtifactReference> {
      const request = snapshot(inputRequest); exact(request, ['context'], 'kms.rotate');
      const now = guard.check(request.context, 'executorId');
      activeKey = generateKey(); guard.commit(now); return activeKey;
    },
    async revokeKey(inputRequest: unknown): Promise<void> {
      const request = snapshot(inputRequest); exact(request, ['context', 'keyRef'], 'kms.revoke');
      const now = guard.check(request.context, 'executorId'); const ref = reference(request.keyRef, 'kms.revoke.keyRef');
      const key = keys.get(canonicalJson(ref));
      if (!key) fail('kms.revoke.keyRef', 'unknown or revoked key');
      key.material.fill(0); key.revoked = true; guard.commit(now);
    },
  });
}

/** Atomic JS exclusive create only; NOT durable/WORM storage. It deliberately
 * has no path/URL, plaintext upload, delete or overwrite operation. */
export function createReferenceArtifactStore(input: unknown): ReferenceArtifactStore {
  const options = snapshot(input); exact(options, [...COMMON_OPTIONS, 'storeIdentityRef', 'maxObjectBytes'], 'store.options');
  const common = parseOptions(options); const storeIdentityRef = reference(options.storeIdentityRef, 'store.options.storeIdentityRef');
  const maxObjectBytes = integer(options.maxObjectBytes, 1, MAX_OBJECT_BYTES, 'store.options.maxObjectBytes');
  const guard = referenceGuard(common);
  const objects = new Map<string, { ref: ArtifactReference; object: ControlledArtifactObject }>();
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    async sealEncryptedArtifact(inputRequest: unknown): Promise<ArtifactReference> {
      const request = snapshot(inputRequest); exact(request, ['context', 'aad', 'envelope', 'retainUntil'], 'store.seal');
      const now = guard.check(request.context, 'executorId');
      const aad = validateArtifactAad(request.aad); matchBinding(aad, common.binding);
      const envelope = validateEncryptedArtifact(request.envelope);
      if (envelope.aadSha256 !== canonicalJsonSha256(aad)) fail('store.seal', 'AAD/ciphertext identity mismatch');
      const retainUntil = timestamp(request.retainUntil, 'store.seal.retainUntil');
      if (retainUntil <= now || retainUntil - now > 3650 * 86400000) fail('store.seal.retainUntil', 'retention outside local bounds');
      if (objects.has(aad.artifactId)) fail('store.seal', 'immutable object already exists');
      if (objects.size >= common.maxObjects) fail('store.seal', 'object capacity exhausted');
      const object = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA, aad, envelope,
        retainUntil: request.retainUntil as string });
      const encoded = canonicalJson(object);
      if (Buffer.byteLength(encoded) > maxObjectBytes) fail('store.seal', 'object size exceeds configured bound');
      const ref = freeze({ objectId: aad.artifactId, objectVersion: randomBytes(16).toString('hex'),
        sha256: canonicalJsonSha256(object) });
      // No await before/inside exclusive create. This is local atomicity, not
      // an assertion about a distributed store's transaction or durability.
      objects.set(aad.artifactId, { ref, object }); guard.commit(now); return ref;
    },
    async readExact(inputRequest: unknown): Promise<ArtifactExactReadback> {
      const request = snapshot(inputRequest); exact(request, ['context', 'ref'], 'store.read');
      const now = guard.check(request.context, 'readOnlyId'); const ref = reference(request.ref, 'store.read.ref');
      const stored = objects.get(ref.objectId);
      if (!stored || canonicalJson(stored.ref) !== canonicalJson(ref)
        || canonicalJsonSha256(stored.object) !== ref.sha256) fail('store.read', 'exact object version/digest absent');
      const object = snapshot(stored.object) as unknown as ControlledArtifactObject;
      const proof: ArtifactObjectProof = { assurance: 'local-reference', productionTamperResistant: false,
        storeIdentityRef, objectRef: ref, lockMode: 'local-reference-immutable', retainUntil: object.retainUntil,
        readerId: common.actors.readOnlyId, observedAt: new Date(now).toISOString() };
      guard.commit(now); return freeze({ object, proof });
    },
  });
}

function parseOptions(options: Fields): ReferenceOptions {
  if (options.executionProfile !== 'local-reference') fail('options.executionProfile', 'reference adapter cannot serve enterprise profile');
  const binding = validateBinding(record(options.binding, 'options.binding'), true);
  const actors = record(options.actors, 'options.actors'); exact(actors, ['executorId', 'readOnlyId'], 'options.actors');
  identifier(actors.executorId, 'options.actors.executorId'); identifier(actors.readOnlyId, 'options.actors.readOnlyId');
  if (actors.executorId === actors.readOnlyId) fail('options.actors', 'writer and read-only duties must be independent');
  const validFrom = timestamp(options.validFrom, 'options.validFrom'); const validUntil = timestamp(options.validUntil, 'options.validUntil');
  if (validUntil <= validFrom || validUntil - validFrom > 86400000) fail('options', 'local run validity outside 24-hour bound');
  const maxObjects = integer(options.maxObjects, 1, 10000, 'options.maxObjects');
  return freeze({ binding, actors: actors as unknown as ReferenceOptions['actors'], validFrom, validUntil, maxObjects });
}
function referenceGuard(options: ReferenceOptions) {
  let lastSuccessfulTime = -Infinity;
  return {
    check(input: unknown, role: keyof ReferenceOptions['actors']): number {
      const context = record(input, 'context'); exact(context, CONTEXT_FIELDS, 'context');
      if (context.executionProfile !== 'local-reference') fail('context.executionProfile', 'enterprise execution is forbidden');
      const binding = validateBinding(record(context.binding, 'context.binding'), true); matchBinding(binding, options.binding);
      identifier(context.actorId, 'context.actorId'); hex(context.authorizationDigest, 64, 'context.authorizationDigest');
      if (context.actorId !== options.actors[role]) fail('context.actorId', 'local role not authorized');
      const now = timestamp(context.observedAt, 'context.observedAt');
      if (now < options.validFrom || now >= options.validUntil) fail('context.observedAt', 'local run expired or not yet valid');
      if (now < lastSuccessfulTime) fail('context.observedAt', 'local clock moved backwards'); return now;
    },
    commit(time: number): void { lastSuccessfulTime = time; },
  };
}
function validateBinding(input: Fields, isExact: boolean): ArtifactRunBinding {
  if (isExact) exact(input, BINDING_FIELDS, 'binding');
  for (const field of BINDING_FIELDS.slice(0, 3)) identifier(input[field], `binding.${field}`);
  hex(input.runNonce, 32, 'binding.runNonce'); hex(input.manifestHash, 64, 'binding.manifestHash');
  return freeze(Object.fromEntries(BINDING_FIELDS.map(field => [field, input[field]]))) as unknown as ArtifactRunBinding;
}
function matchBinding(input: ArtifactRunBinding, expected: ArtifactRunBinding): void {
  if (BINDING_FIELDS.some(field => input[field as keyof ArtifactRunBinding] !== expected[field as keyof ArtifactRunBinding])) fail('binding', 'scope/run/manifest differs from reference run');
}
function reference(input: unknown, path: string): ArtifactReference {
  const ref = record(input, path); exact(ref, ['objectId', 'objectVersion', 'sha256'], path);
  identifier(ref.objectId, `${path}.objectId`); identifier(ref.objectVersion, `${path}.objectVersion`); hex(ref.sha256, 64, `${path}.sha256`);
  return freeze(ref) as unknown as ArtifactReference;
}
function bytes(input: unknown, maxBytes: number, path: string): Buffer {
  if (typeof input !== 'string' || input.length > Math.ceil(maxBytes * 4 / 3)
    || !/^[A-Za-z0-9_-]*$/.test(input)) fail(path, 'bounded canonical base64url required');
  const decoded = Buffer.from(input, 'base64url');
  if (decoded.byteLength > maxBytes || decoded.toString('base64url') !== input) {
    decoded.fill(0); fail(path, 'bounded canonical base64url required');
  }
  return decoded;
}
function snapshot(input: unknown): Fields {
  let encoded: string;
  try { encoded = canonicalJson(input); } catch { fail('input', 'invalid canonical bounded data'); }
  return record(JSON.parse(encoded), 'input');
}
function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'required object absent'); return input as Fields;
}
function exact(input: Fields, expected: readonly string[], path: string): void {
  if (expected.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !expected.includes(field))) fail(path, 'required fields absent or unsupported fields present');
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'bounded opaque identifier required');
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'exact lowercase hexadecimal identity required');
}
function integer(input: unknown, min: number, max: number, path: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) fail(path, 'integer outside profile bounds'); return input;
}
function timestamp(input: unknown, path: string): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(path, 'canonical UTC timestamp required'); return Date.parse(input);
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input;
}
function fail(path: string, reason: string): never { throw new Error(`[controlled artifacts] ${path}: ${reason}`); }
