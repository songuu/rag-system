import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const artifacts = await import('./production-controlled-artifacts.ts');
const hash = canonicalJsonSha256;
const clone = value => structuredClone(value);
const binding = { environment: 'local-test', tenantId: 'tenant-a', corpusId: 'corpus-a',
  runNonce: '0123456789abcdef0123456789abcdef', manifestHash: hash('manifest') };
const now = '2026-10-09T05:00:00.000Z';
const ref = id => ({ objectId: id, objectVersion: 'v1', sha256: hash(id) });
const plaintext = Buffer.from('synthetic controlled payload').toString('base64url');
const opts = () => ({ executionProfile: 'local-reference', binding: clone(binding),
  actors: { executorId: 'executor-a', readOnlyId: 'reader-a' },
  validFrom: now, validUntil: '2026-10-09T06:00:00.000Z',
  maxObjects: 100, maxPlaintextBytes: 1024, keyPolicyRef: ref('artifact-key-policy') });
const ctx = (role = 'executor-a', time = now, overrides = {}) => ({
  executionProfile: 'local-reference', binding: clone(binding), actorId: role,
  authorizationDigest: hash('synthetic-authorization'), observedAt: time, ...overrides });
const aad = (id = 'artifact-a', overrides = {}) => ({ ...binding, artifactType: 'response',
  artifactId: id, caseId: 'fedcba9876543210fedcba9876543210', ordinal: 0,
  schemaVersion: 'kg-ask-response/v1', ...overrides });
const kms = (overrides = {}) => artifacts.createReferenceKmsEnvelope({ ...opts(), ...overrides });
const store = (overrides = {}) => {
  const options = opts(); delete options.maxPlaintextBytes; delete options.keyPolicyRef;
  return artifacts.createReferenceArtifactStore({ ...options, maxObjectBytes: 16384,
    storeIdentityRef: ref('reference-store'), ...overrides });
};
const encrypt = (port, id = 'artifact-a', extra = {}) => port.encryptArtifact({
  context: ctx(), aad: aad(id), plaintextBase64url: plaintext, ...extra });
const decrypt = (port, envelope, extra = {}) => port.decryptArtifact({
  context: ctx('reader-a'), aad: aad(), envelope, ...extra });

test('reference factories cannot claim enterprise capability or accept inline/unknown configuration', () => {
  for (const factory of [kms, store]) {
    const port = factory();
    assert.equal(port.executionProfile, 'local-reference');
    assert.equal(port.productionCapable, false);
    assert.equal(Object.isFrozen(port), true);
    assert.throws(() => factory({ executionProfile: 'enterprise' }), /controlled artifacts/);
    assert.throws(() => factory({ endpoint: 'https://evil.example' }), /controlled artifacts/);
    assert.throws(() => factory({ actors: { executorId: 'same', readOnlyId: 'same' } }), /controlled artifacts/);
  }
});

test('AES-GCM roundtrip exposes no raw key, authenticates AAD, and detaches all readback', async () => {
  const port = kms(); const request = { context: ctx(), aad: aad(), plaintextBase64url: plaintext };
  const envelope = await port.encryptArtifact(request);
  request.aad.artifactId = 'mutated';
  assert.equal(envelope.schemaVersion, 'kg-controlled-artifact-aead/v1');
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.equal(Buffer.from(envelope.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64url').length, 16);
  assert.equal(envelope.aadSha256, hash(aad()));
  assert.equal(Object.isFrozen(envelope.keyRef), true);
  assert.deepEqual(Object.keys(envelope).sort(), ['aadSha256', 'algorithm', 'ciphertext',
    'keyRef', 'nonce', 'schemaVersion', 'tag'].sort());
  assert.equal(await decrypt(port, envelope), plaintext);
  assert.equal(JSON.stringify(envelope).includes('synthetic controlled payload'), false);
});

test('all ten AAD fields bind object/run/scope and cannot be changed or silently added', async () => {
  const port = kms(); const envelope = await encrypt(port);
  const replacements = { environment: 'other', tenantId: 'other', corpusId: 'other',
    runNonce: '0'.repeat(32), manifestHash: hash('other'), artifactType: 'request',
    artifactId: 'other', caseId: '0'.repeat(32), ordinal: 1, schemaVersion: 'kg-other/v1' };
  for (const [field, value] of Object.entries(replacements)) {
    await assert.rejects(decrypt(port, envelope, { aad: aad('artifact-a', { [field]: value }) }), /controlled artifacts/);
  }
  await assert.rejects(decrypt(port, envelope, { aad: { ...aad(), extra: 'raw-query' } }), /controlled artifacts/);
  for (const value of ['raw-case', '../source']) {
    await assert.rejects(encrypt(port, 'other', { aad: aad('other', { caseId: value }) }), /controlled artifacts/);
  }
});

test('nonce is unique for every object, repeated AAD cannot encrypt twice, keys are per-run', async () => {
  const port = kms(); const seen = new Set();
  for (let index = 0; index < 32; index += 1) {
    const envelope = await encrypt(port, `artifact-${index}`);
    assert.equal(seen.has(envelope.nonce), false); seen.add(envelope.nonce);
  }
  await assert.rejects(encrypt(port, 'artifact-0'), /already encrypted/);
  const other = kms(); const envelope = await encrypt(port);
  const second = await encrypt(other);
  assert.notDeepEqual(envelope.keyRef, second.keyRef);
  await assert.rejects(decrypt(other, envelope), /unknown or revoked key/);
});

test('rotation never reuses an object identity; revocation removes old decrypt and never falls back', async () => {
  const port = kms(); const first = await encrypt(port);
  const nextKey = await port.rotateKey({ context: ctx() });
  assert.notDeepEqual(nextKey, first.keyRef);
  await assert.rejects(encrypt(port), /already encrypted/);
  const second = await encrypt(port, 'artifact-b');
  assert.deepEqual(second.keyRef, nextKey);
  assert.notEqual(second.nonce, first.nonce);
  assert.equal(await decrypt(port, first), plaintext);
  await port.revokeKey({ context: ctx(), keyRef: first.keyRef });
  await assert.rejects(decrypt(port, first), /unknown or revoked key/);
  await port.revokeKey({ context: ctx(), keyRef: nextKey });
  await assert.rejects(encrypt(port, 'artifact-c'), /unknown or revoked key/);
});

test('ciphertext, tag, nonce, digest and exact key object version substitutions fail closed', async () => {
  const port = kms(); const envelope = await encrypt(port);
  for (const field of ['ciphertext', 'nonce', 'tag']) {
    const altered = clone(envelope); const bytes = Buffer.from(altered[field], 'base64url');
    bytes[0] ^= 1; altered[field] = bytes.toString('base64url');
    await assert.rejects(decrypt(port, altered), /controlled artifacts/);
  }
  await assert.rejects(decrypt(port, { ...envelope, aadSha256: hash('other') }), /AAD/);
  await assert.rejects(decrypt(port, { ...envelope, keyRef: { ...envelope.keyRef, objectVersion: 'v99' } }), /unknown or revoked key/);
  const another = await encrypt(port, 'artifact-b');
  await assert.rejects(decrypt(port, another), /AAD/);
});

test('exact local roles/run/profile/time are mandatory for every operation', async () => {
  const port = kms(); const envelope = await encrypt(port);
  for (const context of [ctx('reader-a'), ctx('unknown'), ctx('executor-a', now, { executionProfile: 'enterprise' }),
    ctx('executor-a', now, { binding: { ...binding, corpusId: 'other' } }),
    ctx('executor-a', '2026-10-09T06:00:00.000Z'), ctx('executor-a', '2026-10-09T04:59:59.999Z')]) {
    await assert.rejects(encrypt(port, 'denied', { context }), /controlled artifacts/);
  }
  await assert.rejects(decrypt(port, envelope, { context: ctx() }), /controlled artifacts/);
  await port.rotateKey({ context: ctx('executor-a', '2026-10-09T05:00:01.000Z') });
  await assert.rejects(decrypt(port, envelope), /clock moved backwards/);
});

test('canonical bounds reject malformed plaintext/envelopes, input code never executes, errors omit content', async () => {
  const port = kms(); const envelope = await encrypt(port); let called = 0;
  const getter = { context: ctx(), aad: aad('getter'),
    get plaintextBase64url() { called += 1; return plaintext; } };
  await assert.rejects(port.encryptArtifact(getter));
  const proxy = new Proxy({}, { ownKeys() { called += 1; return []; } });
  await assert.rejects(port.encryptArtifact(proxy)); assert.equal(called, 0);
  for (const value of [plaintext + '=', '%%%sensitive-marker%%%', Buffer.alloc(1025).toString('base64url')]) {
    await assert.rejects(encrypt(port, 'bounded', { plaintextBase64url: value }), error => {
      assert.equal(error.message.includes(value), false); return true;
    });
  }
  await assert.rejects(decrypt(port, { ...envelope, rawResponse: 'sensitive-marker' }), /controlled artifacts/);
  assert.throws(() => artifacts.validateArtifactAad(aad('bad', { ordinal: -1 })), /controlled artifacts/);
  assert.throws(() => artifacts.validateArtifactAad(aad('bad', { artifactId: '../bad' })), /controlled artifacts/);
});

test('capacity is hard bounded and never evicts nonce/object history to accept retries', async () => {
  const port = kms({ maxObjects: 1 }); await encrypt(port);
  await assert.rejects(encrypt(port, 'artifact-b'), /capacity/);
  await port.rotateKey({ context: ctx() });
  await assert.rejects(encrypt(port), /already encrypted/);
  await assert.rejects(encrypt(port, 'artifact-b'), /capacity/);
});

test('store seals encrypted objects exclusively and independent reader gets exact immutable proof', async () => {
  const port = store(); const envelope = await encrypt(kms());
  const request = { context: ctx(), aad: aad(), envelope, retainUntil: '2026-10-10T05:00:00.000Z' };
  const identity = await port.sealEncryptedArtifact(request);
  request.envelope = { ...envelope, tag: 'changed' }; request.aad.artifactId = 'changed';
  const readback = await port.readExact({ context: ctx('reader-a'), ref: identity });
  assert.equal(identity.sha256, hash(readback.object));
  assert.deepEqual(readback.object.aad, aad()); assert.deepEqual(readback.object.envelope, envelope);
  assert.deepEqual(readback.proof.objectRef, identity);
  assert.equal(readback.proof.assurance, 'local-reference');
  assert.equal(readback.proof.productionTamperResistant, false);
  assert.equal(readback.proof.lockMode, 'local-reference-immutable');
  assert.equal(readback.proof.readerId, 'reader-a'); assert.equal(Object.isFrozen(readback.object.envelope), true);
  assert.equal(Object.isFrozen(readback.proof), true);
  assert.equal('delete' in port, false); assert.equal('overwrite' in port, false);
});

test('store rejects overwrite, concurrent duplicate, object/version/digest swaps and writer readback', async () => {
  const port = store(); const envelope = await encrypt(kms());
  const request = { context: ctx(), aad: aad(), envelope, retainUntil: '2026-10-10T05:00:00.000Z' };
  const outcomes = await Promise.allSettled([port.sealEncryptedArtifact(request), port.sealEncryptedArtifact(request)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
  const identity = outcomes.find(value => value.status === 'fulfilled').value;
  for (const altered of [{ ...identity, objectVersion: 'other' }, { ...identity, sha256: hash('other') },
    { ...identity, objectId: 'other' }]) {
    await assert.rejects(port.readExact({ context: ctx('reader-a'), ref: altered }), /exact object version/);
  }
  await assert.rejects(port.readExact({ context: ctx(), ref: identity }), /role/);
  await assert.rejects(port.sealEncryptedArtifact({ ...request, context: ctx('reader-a') }), /role/);
});

test('store binds AAD/ciphertext scope, retention and size; it cannot turn plaintext into an artifact', async () => {
  const port = store(); const envelope = await encrypt(kms());
  const request = { context: ctx(), aad: aad(), envelope, retainUntil: '2026-10-10T05:00:00.000Z' };
  for (const change of [{ aad: aad('other') }, { aad: aad('artifact-a', { corpusId: 'other' }) },
    { envelope: { raw: plaintext } }, { retainUntil: now }, { plaintextBase64url: plaintext }]) {
    await assert.rejects(port.sealEncryptedArtifact({ ...request, ...change }), /controlled artifacts/);
  }
  const bounded = store({ maxObjectBytes: 64 });
  await assert.rejects(bounded.sealEncryptedArtifact(request), /size/);
  const full = store({ maxObjects: 1 }); await full.sealEncryptedArtifact(request);
  const second = await encrypt(kms(), 'artifact-b');
  await assert.rejects(full.sealEncryptedArtifact({ ...request, aad: aad('artifact-b'), envelope: second }), /capacity/);
});

test('store validates profile/scope/time on read and failed attempts do not poison valid local time', async () => {
  const port = store(); const envelope = await encrypt(kms());
  const identity = await port.sealEncryptedArtifact({ context: ctx(), aad: aad(), envelope,
    retainUntil: '2026-10-10T05:00:00.000Z' });
  await assert.rejects(port.readExact({ context: ctx('reader-a', '2026-10-09T06:00:00.000Z'), ref: identity }), /controlled artifacts/);
  assert.equal((await port.readExact({ context: ctx('reader-a'), ref: identity })).proof.observedAt, now);
  await assert.rejects(port.readExact({ context: ctx('reader-a', now,
    { binding: { ...binding, runNonce: '0'.repeat(32) } }), ref: identity }), /scope\/run/);
});

async function indexFixture() {
  const envelope = await encrypt(kms()); const objectRef = await store().sealEncryptedArtifact({
    context: ctx(), aad: aad(), envelope, retainUntil: '2026-10-10T05:00:00.000Z' });
  return { schemaVersion: 'kg-controlled-artifact-index/v1', classification: 'confidential',
    binding: clone(binding), entries: [{ artifactId: 'artifact-a', artifactType: 'response',
      caseId: aad().caseId, ordinal: 0, schemaVersion: 'kg-ask-response/v1',
      objectRef, keyRef: envelope.keyRef, aadSha256: envelope.aadSha256 }] };
}

test('controlled index is a detached confidential structural object, never production acceptance', async () => {
  const input = await indexFixture(); const result = artifacts.validateControlledArtifactIndex(input);
  assert.equal(result.indexHash, hash(input));
  assert.equal(result.validationLevel, 'structural-only');
  assert.equal(result.productionAccepted, false); assert.equal(Object.isFrozen(result.index.entries[0]), true);
  input.entries[0].artifactId = 'changed'; assert.equal(result.index.entries[0].artifactId, 'artifact-a');
  assert.deepEqual(Object.keys(result.index.entries[0]).sort(), ['artifactId', 'artifactType', 'caseId',
    'ordinal', 'schemaVersion', 'objectRef', 'keyRef', 'aadSha256'].sort());
});

test('index rejects duplicate object/semantic slots, plaintext metadata, scope/AAD drift and count overflow', async () => {
  const input = await indexFixture(); const rejects = change => {
    const value = clone(input); change(value);
    assert.throws(() => artifacts.validateControlledArtifactIndex(value), /controlled artifacts/);
  };
  rejects(value => { value.entries.push(clone(value.entries[0])); });
  rejects(value => { const entry = clone(value.entries[0]); entry.artifactId = 'artifact-b';
    entry.objectRef.objectId = 'artifact-b'; entry.aadSha256 = hash(aad('artifact-b')); value.entries.push(entry); });
  rejects(value => { value.entries[0].objectRef.objectId = 'swapped'; });
  rejects(value => { value.entries[0].caseId = 'original-user-query'; });
  rejects(value => { value.entries[0].response = 'sensitive-marker'; });
  rejects(value => { value.classification = 'public'; });
  rejects(value => { value.binding.corpusId = 'other'; });
  rejects(value => { value.entries[0].aadSha256 = hash('different-aad'); });
  rejects(value => { value.entries = []; });
  rejects(value => { value.entries = Array(257).fill(value.entries[0]); });
});

test('case-bound request/gold/response AAD cannot omit its pseudonymous case identity', () => {
  for (const artifactType of ['request', 'gold', 'response']) {
    assert.throws(() => artifacts.validateArtifactAad(aad('case-a', { artifactType, caseId: null })), /case identity/);
  }
  assert.equal(artifacts.validateArtifactAad(aad('report-a', {
    artifactType: 'report', caseId: null, schemaVersion: 'kg-stage-report/v1' })).caseId, null);
});
