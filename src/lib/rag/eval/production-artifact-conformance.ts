import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall } from './bounded-provider-call';
import { CONTROLLED_ARTIFACT_OBJECT_SCHEMA, validateArtifactAad, validateEncryptedArtifact,
  type ArtifactAad, type ArtifactOperationContext, type EncryptedArtifact } from './production-controlled-artifacts';
import { PROVIDER_CONFORMANCE_REQUIREMENTS, PROVIDER_CONFORMANCE_REQUIREMENTS_HASH } from './production-provider-trust';
import type { ArtifactReference } from './production-gate-manifest';

export const ARTIFACT_CONFORMANCE_SCHEMA = 'kg-isolated-artifact-conformance/v1' as const;
export const ARTIFACT_CONFORMANCE_PROBES = Object.freeze(['kms-roundtrip', 'kms-nonce-object-separation',
  'kms-duplicate-object-rejection', 'kms-aad-all-fields', 'kms-aad-digest-forgery', 'kms-ciphertext-authentication',
  'kms-key-reference-integrity', 'kms-role-and-scope', 'kms-plaintext-bound', 'store-exclusive-create',
  'store-exact-readback', 'store-exact-reference-rejection', 'store-immutable-retry', 'store-role-and-scope',
  'store-aad-binding', 'store-retention-bound', 'kms-key-rotation', 'kms-key-revocation'] as const);

type Fields = Record<string, unknown>;
type Profile = 'enterprise' | 'local-reference';
type ProbeId = typeof ARTIFACT_CONFORMANCE_PROBES[number];
type AdapterCall = (input: unknown) => Promise<unknown>;
interface ProbeObservation {
  readonly probeId: ProbeId;
  readonly outcome: 'passed' | 'failed' | 'not-run';
  readonly failureCode: string | null;
}
export interface ArtifactConformanceCore {
  readonly schemaVersion: 'kg-isolated-conformance-observations/v1';
  readonly validationLevel: 'isolated-behavioral-observations';
  readonly classification: 'confidential';
  readonly productionAccepted: false;
  readonly requirementVerdict: 'incomplete';
  readonly verdict: 'passed' | 'failed';
  readonly pendingCompletionUnknown: boolean;
  readonly probes: readonly ProbeObservation[];
  readonly configHash: string;
  readonly challengeNonce: string;
  readonly requirementsHash: string;
  readonly unimplementedRequirements: { readonly kms: readonly string[]; readonly 'tamper-store': readonly string[] };
}
export interface ArtifactConformanceObservations extends ArtifactConformanceCore {
  readonly observations: ArtifactConformanceCore;
  readonly observationsHash: string;
}
class ProbeFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(`[artifact conformance] ${code}`); this.code = code; }
}

/**
 * Independent black-box probes, never adapter-supplied tests/verdicts. Use ONLY
 * a disposable, separately authorized test scope: this rotates/revokes KMS keys
 * and creates immutable test objects. The isolation label is caller intent,
 * not authenticated permission. Enterprise lab identity/permissions, process
 * isolation, artifact measurement and signing remain the external harness's
 * responsibility. No request is made to a real service by this module itself.
 * These observations do not satisfy the complete provider conformance suite.
 */
export async function runIsolatedArtifactConformance(input: unknown, portsInput: unknown): Promise<ArtifactConformanceObservations> {
  const config = configFor(input); const profile = config.executionProfile as Profile;
  const ports = dataDescriptors(portsInput, 'ports'); exact(ports, ['kms', 'store'], 'ports');
  const kms = capture(ports.kms, profile, ['encryptArtifact', 'decryptArtifact', 'rotateKey', 'revokeKey']);
  const store = capture(ports.store, profile, ['sealEncryptedArtifact', 'readExact']);
  const binding = config.binding as ArtifactOperationContext['binding'];
  const context = (actorId: string, authorizationDigest: string): ArtifactOperationContext => freeze({
    executionProfile: profile, binding, actorId, authorizationDigest, observedAt: config.observedAt as string });
  const writer = context(config.writerId as string, config.writerAuthorizationDigest as string);
  const reader = context(config.readerId as string, config.readerAuthorizationDigest as string);
  const unauthorizedContexts = (ctx: ArtifactOperationContext): ArtifactOperationContext[] => [
    { ...ctx, executionProfile: profile === 'enterprise' ? 'local-reference' : 'enterprise' },
    ...Object.entries({ environment: differentId(binding.environment), tenantId: differentId(binding.tenantId),
      corpusId: differentId(binding.corpusId), runNonce: alternate(binding.runNonce, 32), manifestHash: alternate(binding.manifestHash, 64) })
      .map(([field, value]) => ({ ...ctx, binding: { ...binding, [field]: value } })),
  ];
  const challengeNonce = randomBytes(16).toString('hex');
  const plaintext = randomBytes(32).toString('base64url');
  const aad = (ordinal: number): ArtifactAad => validateArtifactAad({ ...binding,
    artifactType: 'response', artifactId: `probe-${challengeNonce}-${ordinal}`, caseId: challengeNonce,
    ordinal, schemaVersion: 'kg-conformance-challenge/v1' });
  const a = aad(0); const b = aad(1); const collision = aad(2);
  let nextOrdinal = 10;
  const freshAad = (): ArtifactAad => aad(nextOrdinal++);
  let envelopeA: EncryptedArtifact; let envelopeB: EncryptedArtifact; let collisionEnvelope: EncryptedArtifact;
  let sealed: ArtifactReference; let expectedObject: unknown; let rotated: ArtifactReference; let rotatedEnvelope: EncryptedArtifact;
  let pendingCompletionUnknown = false;
  const nonces = new Set<string>();
  const samples: Array<{ aad: ArtifactAad; envelope: EncryptedArtifact }> = [];
  let expectedActiveKey: ArtifactReference | null = null;
  const timeoutMs = config.operationTimeoutMs as number;
  const invoke = async (call: AdapterCall, request: unknown): Promise<unknown> => {
    // Detach/freeze before invoking. Never inspect bind/name/length on adapter
    // functions, and never let a callback rewrite the oracle's expected data.
    const detached = freeze(snapshot(request));
    const result = await boundedProviderCall(() => call(detached), timeoutMs);
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      pendingCompletionUnknown ||= result.pendingCompletionUnknown;
      throw new ProbeFailure(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid');
    }
    if (result.status === 'rejected') throw new ProbeFailure('provider-rejection');
    // An async raw return would adopt a then added AFTER the carrier resolved.
    try { return result.value === undefined ? undefined : freeze(JSON.parse(canonicalJson(result.value))); }
    catch { throw new ProbeFailure('invalid-data'); }
  };
  const rejectOperation = async (call: AdapterCall, request: unknown) => {
    try { await invoke(call, request); }
    catch (error) { if (error instanceof ProbeFailure && error.code === 'provider-rejection') return; throw error; }
    throw new ProbeFailure('invalid-operation-accepted');
  };
  const encrypt = async (value: ArtifactAad, text = plaintext, ctx = writer) => {
    const envelope = validateEncryptedArtifact(await invoke(kms.encryptArtifact, { context: ctx, aad: value, plaintextBase64url: text }));
    equal(envelope.aadSha256, canonicalJsonSha256(value), 'aad-digest');
    expectedActiveKey ??= envelope.keyRef;
    equal(envelope.keyRef, expectedActiveKey, 'unapproved-key-change');
    if (nonces.has(envelope.nonce)) throw new ProbeFailure('nonce-reused');
    nonces.add(envelope.nonce); samples.push({ aad: value, envelope }); return envelope;
  };
  const decrypt = (value: ArtifactAad, envelope: EncryptedArtifact, ctx = reader) =>
    invoke(kms.decryptArtifact, { context: ctx, aad: value, envelope });
  const positive = async (value: ArtifactAad, envelope: EncryptedArtifact) => {
    equal(await decrypt(value, envelope), plaintext, 'plaintext-roundtrip');
  };
  const seal = (value: ArtifactAad, envelope: EncryptedArtifact, ctx = writer, until = config.retainUntil) =>
    invoke(store.sealEncryptedArtifact, { context: ctx, aad: value, envelope, retainUntil: until });
  const read = (ref: ArtifactReference, ctx = reader) => invoke(store.readExact, { context: ctx, ref });
  const readExact = async (exactRef = sealed, exactObject = expectedObject) => {
    const result = snapshot(await read(exactRef)); exact(result, ['object', 'proof'], 'readback');
    equal(result.object, exactObject, 'immutable-object');
    const proof = record(result.proof, 'proof');
    exact(proof, ['assurance', 'productionTamperResistant', 'storeIdentityRef', 'objectRef',
      'lockMode', 'retainUntil', 'readerId', 'observedAt'], 'proof');
    const proofTime = timestamp(proof.observedAt);
    if (proofTime < timestamp(config.observedAt) || proofTime >= timestamp(config.retainUntil)) throw new ProbeFailure('readback-time-outside-run');
    equal(proof, { assurance: profile, productionTamperResistant: profile === 'enterprise',
      storeIdentityRef: config.storeIdentityRef, objectRef: exactRef,
      lockMode: profile === 'enterprise' ? 'compliance-worm' : 'local-reference-immutable',
      retainUntil: config.retainUntil, readerId: reader.actorId, observedAt: proof.observedAt }, 'exact-proof');
  };
  const verifyLegalEncryption = async (value: ArtifactAad) => {
    const envelope = await encrypt(value); await positive(value, envelope); return envelope;
  };
  const verifyLegalSeal = async (value: ArtifactAad, envelope: EncryptedArtifact) => {
    const ref = reference(await seal(value, envelope));
    const object = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA, aad: value,
      envelope, retainUntil: config.retainUntil });
    equal(ref.objectId, value.artifactId, 'sealed-id'); equal(ref.sha256, canonicalJsonSha256(object), 'sealed-digest');
    await readExact(ref, object);
  };
  const rejectEncryptionWithoutMutation = async (ctx: ArtifactOperationContext) => {
    const value = freshAad();
    await rejectOperation(kms.encryptArtifact, { context: ctx, aad: value, plaintextBase64url: plaintext });
    // A thrown error is insufficient: prove the exact object ID is still free.
    await verifyLegalEncryption(value);
  };
  const rejectRotationWithoutMutation = async (ctx: ArtifactOperationContext) => {
    await rejectOperation(kms.rotateKey, { context: ctx });
    // Old ciphertext surviving does not prove the active key stayed unchanged.
    await verifyLegalEncryption(freshAad());
  };
  const rejectSealWithoutMutation = async (ctx: ArtifactOperationContext) => {
    const value = freshAad(); const envelope = await verifyLegalEncryption(value);
    await rejectOperation(store.sealEncryptedArtifact, { context: ctx, aad: value, envelope, retainUntil: config.retainUntil });
    await verifyLegalSeal(value, envelope);
  };
  const plans: Record<ProbeId, () => Promise<void>> = {
    async 'kms-roundtrip'() {
      envelopeA = await encrypt(a); equal(envelopeA.aadSha256, canonicalJsonSha256(a), 'aad-digest');
      await positive(a, envelopeA);
    },
    async 'kms-nonce-object-separation'() {
      envelopeB = await encrypt(b); equal(envelopeB.aadSha256, canonicalJsonSha256(b), 'aad-digest');
      differs(envelopeA.nonce, envelopeB.nonce, 'nonce-reused'); await positive(b, envelopeB);
    },
    async 'kms-duplicate-object-rejection'() {
      await rejectOperation(kms.encryptArtifact, { context: writer, aad: a, plaintextBase64url: plaintext });
      await positive(a, envelopeA);
      for (const changed of [{ ...a, ordinal: a.ordinal + 1 }, { ...a, schemaVersion: 'kg-other-challenge/v1' }]) {
        await rejectOperation(kms.encryptArtifact, { context: writer, aad: changed, plaintextBase64url: plaintext });
        await positive(a, envelopeA);
      }
      const changedPlaintext = Buffer.from(plaintext, 'base64url'); changedPlaintext[0] ^= 1;
      try {
        await rejectOperation(kms.encryptArtifact, { context: writer, aad: a, plaintextBase64url: changedPlaintext.toString('base64url') });
      } finally { changedPlaintext.fill(0); }
      await positive(a, envelopeA);
    },
    async 'kms-aad-all-fields'() {
      const replacements = { environment: differentId(binding.environment), tenantId: differentId(binding.tenantId), corpusId: differentId(binding.corpusId),
        runNonce: alternate(binding.runNonce, 32), manifestHash: alternate(binding.manifestHash, 64),
        artifactType: 'request', artifactId: `other-${challengeNonce}`, caseId: alternate(challengeNonce, 32),
        ordinal: 1, schemaVersion: 'kg-other-challenge/v1' };
      for (const [field, value] of Object.entries(replacements)) {
        const swapped = { ...a, [field]: value };
        await rejectOperation(kms.decryptArtifact, { context: reader, aad: swapped, envelope: envelopeA });
        await positive(a, envelopeA);
        await rejectOperation(kms.decryptArtifact, { context: reader, aad: swapped,
          envelope: { ...envelopeA, aadSha256: canonicalJsonSha256(swapped) } });
        await positive(a, envelopeA);
      }
    },
    async 'kms-aad-digest-forgery'() {
      const swapped = { ...a, artifactId: `forged-${challengeNonce}` };
      await rejectOperation(kms.decryptArtifact, { context: reader, aad: swapped,
        envelope: { ...envelopeA, aadSha256: canonicalJsonSha256(swapped) } }); await positive(a, envelopeA);
    },
    async 'kms-ciphertext-authentication'() {
      for (const field of ['ciphertext', 'tag', 'nonce'] as const) {
        const bytes = Buffer.from(envelopeA[field], 'base64url'); bytes[0] ^= 1;
        await rejectOperation(kms.decryptArtifact, { context: reader, aad: a,
          envelope: { ...envelopeA, [field]: bytes.toString('base64url') } }); bytes.fill(0);
        await positive(a, envelopeA);
      }
    },
    async 'kms-key-reference-integrity'() {
      for (const field of ['objectId', 'objectVersion', 'sha256'] as const) {
        const keyRef = { ...envelopeA.keyRef, [field]: field === 'sha256'
          ? alternate(envelopeA.keyRef.sha256, 64) : `other-${challengeNonce}` };
        await rejectOperation(kms.decryptArtifact, { context: reader, aad: a, envelope: { ...envelopeA, keyRef } });
        await positive(a, envelopeA);
      }
    },
    async 'kms-role-and-scope'() {
      await rejectEncryptionWithoutMutation(reader);
      await rejectOperation(kms.decryptArtifact, { context: writer, aad: a, envelope: envelopeA });
      await rejectRotationWithoutMutation(reader);
      await rejectOperation(kms.revokeKey, { context: reader, keyRef: envelopeA.keyRef }); await positive(a, envelopeA);
      for (const foreign of unauthorizedContexts(writer)) {
        await rejectEncryptionWithoutMutation(foreign);
        await positive(a, envelopeA);
        await rejectRotationWithoutMutation(foreign); await positive(a, envelopeA);
        await rejectOperation(kms.revokeKey, { context: foreign, keyRef: envelopeA.keyRef }); await positive(a, envelopeA);
      }
      for (const foreign of unauthorizedContexts(reader)) {
        await rejectOperation(kms.decryptArtifact, { context: foreign, aad: a, envelope: envelopeA }); await positive(a, envelopeA);
      }
      await positive(a, envelopeA);
    },
    async 'kms-plaintext-bound'() {
      const oversized = Buffer.alloc((config.maxPlaintextBytes as number) + 1, 65).toString('base64url');
      const value = freshAad();
      await rejectOperation(kms.encryptArtifact, { context: writer, aad: value, plaintextBase64url: oversized });
      await verifyLegalEncryption(value);
      await positive(a, envelopeA);
    },
    async 'store-exclusive-create'() {
      collisionEnvelope = await encrypt(collision);
      await positive(collision, collisionEnvelope);
      const results = await Promise.allSettled([seal(collision, collisionEnvelope), seal(collision, collisionEnvelope)]);
      const fulfilled = results.filter(result => result.status === 'fulfilled');
      const rejected = results.filter(result => result.status === 'rejected');
      if (rejected.some(result => !(result.reason instanceof ProbeFailure) || result.reason.code !== 'provider-rejection')) {
        throw new ProbeFailure('concurrent-operation-incomplete');
      }
      if (fulfilled.length !== 1 || rejected.length !== 1) throw new ProbeFailure('exclusive-create-violation');
      sealed = reference(fulfilled[0].value);
      expectedObject = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA,
        aad: collision, envelope: collisionEnvelope, retainUntil: config.retainUntil });
      equal(sealed.objectId, collision.artifactId, 'sealed-id');
      equal(sealed.sha256, canonicalJsonSha256(expectedObject), 'sealed-digest');
    },
    async 'store-exact-readback'() { await readExact(); },
    async 'store-exact-reference-rejection'() {
      for (const field of ['objectId', 'objectVersion', 'sha256'] as const) {
        const wrong = { ...sealed, [field]: field === 'sha256' ? alternate(sealed.sha256, 64) : `other-${challengeNonce}` };
        await rejectOperation(store.readExact, { context: reader, ref: wrong }); await readExact();
      }
    },
    async 'store-immutable-retry'() {
      await rejectOperation(store.sealEncryptedArtifact, { context: writer, aad: collision,
        envelope: collisionEnvelope, retainUntil: config.retainUntil }); await readExact();
      const now = timestamp(config.observedAt); const until = timestamp(config.retainUntil);
      const differentRetention = new Date(until - now > 1 ? until - 1 : until + 1).toISOString();
      await rejectOperation(store.sealEncryptedArtifact, { context: writer, aad: collision,
        envelope: collisionEnvelope, retainUntil: differentRetention }); await readExact();
    },
    async 'store-role-and-scope'() {
      await rejectSealWithoutMutation(reader);
      await rejectOperation(store.readExact, { context: writer, ref: sealed });
      for (const foreign of unauthorizedContexts(writer)) {
        await rejectSealWithoutMutation(foreign); await readExact();
      }
      for (const foreign of unauthorizedContexts(reader)) {
        await rejectOperation(store.readExact, { context: foreign, ref: sealed }); await readExact();
      }
    },
    async 'store-aad-binding'() {
      const value = freshAad(); const envelope = await verifyLegalEncryption(value);
      await rejectOperation(store.sealEncryptedArtifact, { context: writer, aad: value, envelope: envelopeB,
        retainUntil: config.retainUntil }); await verifyLegalSeal(value, envelope); await readExact();
    },
    async 'store-retention-bound'() {
      const value = freshAad(); const envelope = await verifyLegalEncryption(value);
      await rejectOperation(store.sealEncryptedArtifact, { context: writer, aad: value, envelope,
        retainUntil: config.observedAt }); await verifyLegalSeal(value, envelope); await readExact();
    },
    async 'kms-key-rotation'() {
      rotated = reference(await invoke(kms.rotateKey, { context: writer }));
      differs(rotated, envelopeA.keyRef, 'rotation-reused-key'); await positive(a, envelopeA);
      expectedActiveKey = rotated;
      rotatedEnvelope = await encrypt(aad(4)); equal(rotatedEnvelope.keyRef, rotated, 'rotation-key-identity');
      differs(rotatedEnvelope.nonce, envelopeA.nonce, 'rotation-reused-nonce');
      differs(rotatedEnvelope.nonce, envelopeB.nonce, 'rotation-reused-nonce');
      differs(rotatedEnvelope.nonce, collisionEnvelope.nonce, 'rotation-reused-nonce'); await positive(aad(4), rotatedEnvelope);
      await rejectOperation(kms.decryptArtifact, { context: reader, aad: a, envelope: { ...envelopeA, keyRef: rotated } });
      await positive(a, envelopeA);
      await rejectOperation(kms.decryptArtifact, { context: reader, aad: aad(4),
        envelope: { ...rotatedEnvelope, keyRef: envelopeA.keyRef } }); await positive(aad(4), rotatedEnvelope);
    },
    async 'kms-key-revocation'() {
      await invoke(kms.revokeKey, { context: writer, keyRef: envelopeA.keyRef });
      for (const sample of samples) {
        if (canonicalJson(sample.envelope.keyRef) === canonicalJson(envelopeA.keyRef)) {
          await rejectOperation(kms.decryptArtifact, { context: reader, aad: sample.aad, envelope: sample.envelope });
        } else { await positive(sample.aad, sample.envelope); }
      }
      await invoke(kms.revokeKey, { context: writer, keyRef: rotated });
      for (const sample of samples.filter(value => canonicalJson(value.envelope.keyRef) === canonicalJson(rotated))) {
        await rejectOperation(kms.decryptArtifact, { context: reader, aad: sample.aad, envelope: sample.envelope });
      }
      await rejectOperation(kms.encryptArtifact, { context: writer, aad: aad(5), plaintextBase64url: plaintext });
    },
  };
  const probes: ProbeObservation[] = []; let stopped = false;
  for (const probeId of ARTIFACT_CONFORMANCE_PROBES) {
    if (stopped) { probes.push({ probeId, outcome: 'not-run', failureCode: null }); continue; }
    try { await plans[probeId](); probes.push({ probeId, outcome: 'passed', failureCode: null }); }
    catch (error) {
      probes.push({ probeId, outcome: 'failed', failureCode: error instanceof ProbeFailure ? error.code : 'invalid-response' });
      stopped = true;
    }
  }
  // No entire requirement is certified by a subset of probes, particularly
  // durability/IAM/identity/no-fallback/transport/redaction/lifecycle semantics.
  const observations: ArtifactConformanceCore = freeze({ schemaVersion: 'kg-isolated-conformance-observations/v1',
    validationLevel: 'isolated-behavioral-observations', classification: 'confidential', productionAccepted: false, requirementVerdict: 'incomplete',
    verdict: stopped ? 'failed' : 'passed', pendingCompletionUnknown, probes,
    configHash: canonicalJsonSha256(config), challengeNonce, requirementsHash: PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    unimplementedRequirements: {
      kms: [...PROVIDER_CONFORMANCE_REQUIREMENTS.kms], 'tamper-store': [...PROVIDER_CONFORMANCE_REQUIREMENTS['tamper-store']],
    } });
  return freeze({ ...observations, observations, observationsHash: canonicalJsonSha256(observations) });
}

function configFor(input: unknown): Fields {
  const config = snapshot(input);
  exact(config, ['schemaVersion', 'isolation', 'executionProfile', 'binding', 'writerId', 'readerId',
    'writerAuthorizationDigest', 'readerAuthorizationDigest', 'observedAt', 'retainUntil', 'storeIdentityRef',
    'maxPlaintextBytes', 'operationTimeoutMs'], 'config');
  if (config.schemaVersion !== ARTIFACT_CONFORMANCE_SCHEMA || config.isolation !== 'disposable-test-scope'
    || !['enterprise', 'local-reference'].includes(config.executionProfile as string)) fail('config', 'explicit isolated profile required');
  const binding = record(config.binding, 'binding'); exact(binding, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash'], 'binding');
  validateArtifactAad({ ...binding, artifactType: 'report', artifactId: 'probe-shape', caseId: null, ordinal: 0, schemaVersion: 'kg-probe/v1' });
  for (const field of ['writerId', 'readerId']) identifier(config[field], field);
  if (config.writerId === config.readerId) fail('config', 'independent writer and reader required');
  for (const field of ['writerAuthorizationDigest', 'readerAuthorizationDigest']) hex(config[field], 64, field);
  const now = timestamp(config.observedAt); const until = timestamp(config.retainUntil);
  if (until <= now || until - now > 3650 * 86400000) fail('config', 'bounded future retention required');
  reference(config.storeIdentityRef); integer(config.maxPlaintextBytes, 32, 65536, 'maxPlaintextBytes');
  integer(config.operationTimeoutMs, 1, 30000, 'operationTimeoutMs'); return freeze(config);
}
function capture(input: unknown, profile: Profile, methods: readonly string[]): Record<string, AdapterCall> {
  const descriptors = dataDescriptors(input, 'adapter');
  if (descriptors.executionProfile !== profile || descriptors.productionCapable !== (profile === 'enterprise')) fail('adapter', 'profile/capability mismatch');
  const captured: Record<string, AdapterCall> = Object.create(null);
  for (const method of methods) {
    const fn = descriptors[method];
    if (typeof fn !== 'function' || types.isProxy(fn)) fail('adapter', 'plain own method required');
    captured[method] = request => Reflect.apply(fn, input, [request]);
  }
  return Object.freeze(captured);
}
function dataDescriptors(input: unknown, path: string): Fields {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) fail(path, 'plain non-Proxy object required');
  // Adapter property names are untrusted; __proto__ must remain ordinary data.
  const descriptors = Object.getOwnPropertyDescriptors(input); const data: Fields = Object.create(null);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) fail(path, 'accessors forbidden'); data[name] = descriptor.value;
  }
  return data;
}
function snapshot(input: unknown): Fields {
  try { return record(JSON.parse(canonicalJson(input)), 'data'); } catch { throw new ProbeFailure('invalid-data'); }
}
function record(input: unknown, path: string): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'object required'); return input as Fields;
}
function exact(value: Fields, fields: readonly string[], path: string): void {
  if (fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) fail(path, 'exact fields required');
}
function reference(input: unknown): ArtifactReference {
  const value = snapshot(input); exact(value, ['objectId', 'objectVersion', 'sha256'], 'reference');
  identifier(value.objectId, 'objectId'); identifier(value.objectVersion, 'objectVersion'); hex(value.sha256, 64, 'sha256');
  return freeze(value) as unknown as ArtifactReference;
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'bounded opaque ID required');
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'exact lowercase hexadecimal required');
}
function integer(input: unknown, min: number, max: number, path: string): void {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) fail(path, 'bounded integer required');
}
function timestamp(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail('time', 'canonical UTC required'); return Date.parse(input);
}
function alternate(value: string, length: number): string { return value === '0'.repeat(length) ? '1'.repeat(length) : '0'.repeat(length); }
function differentId(value: string): string { return value === 'conformance-other' ? 'conformance-other-2' : 'conformance-other'; }
function equal(actual: unknown, expected: unknown, code: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new ProbeFailure(code);
}
function differs(actual: unknown, expected: unknown, code: string): void {
  if (canonicalJson(actual) === canonicalJson(expected)) throw new ProbeFailure(code);
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input;
}
function fail(path: string, reason: string): never { throw new Error(`[artifact conformance] ${path}: ${reason}`); }
