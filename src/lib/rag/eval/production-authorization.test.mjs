import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json.ts';

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

const approval = await import('./production-authorization.ts');
const hash = canonicalJsonSha256;
const clone = value => structuredClone(value);
const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const ref = label => ({ objectId: label, objectVersion: 'version-1', sha256: hash(label) });
const participants = { executionApproverId: 'approver', executorId: 'executor',
  readOnlyId: 'reader', resultAuthorityId: 'result-authority', recoveryAuthorityId: 'recovery-authority' };
const kinds = ['execution', 'result', 'recovery'];
const issuers = { execution: 'approver', result: 'result-authority', recovery: 'recovery-authority' };
const schemas = { execution: 'kg-execution-authorization-envelope/v1',
  result: 'kg-result-attestation-envelope/v1', recovery: 'kg-safety-recovery-authorization-envelope/v1' };
const pairs = Object.fromEntries(kinds.map(kind => [kind, generateKeyPairSync('ed25519')]));
const signedAt = '2026-10-09T03:20:00.000Z';
const observedAt = '2026-10-09T03:21:00.000Z';

function payload(kind = 'execution') {
  const common = { stage: 'T17', scope: clone(scope), manifestHash: hash('manifest'),
    runNonce: '0123456789abcdef0123456789abcdef', authorizationId: `${kind}-approval-1`,
    nonce: hash(`${kind}-nonce`).slice(0, 32), issuerId: issuers[kind], participants: clone(participants),
    issuedAt: signedAt, notBefore: signedAt, expiresAt: '2026-10-09T03:25:00.000Z' };
  if (kind === 'execution') return { ...common, operation: 'execute-t17-canary', registryRef: ref('registry'),
    providersHash: hash('providers'), thresholdsHash: hash('thresholds'),
    window: { startsAt: signedAt, endsAt: '2026-10-09T03:30:00.000Z' } };
  if (kind === 'result') return { ...common, operation: 'attest-stage-result',
    executionAuthorizationRef: ref('execution-envelope'), receiptCoreRef: ref('receipt-core'),
    reportHash: hash('report'), artifactIndexHash: hash('artifact-index'), machineVerdict: 'passed',
    executionIdentityId: 'executor', finalStateHash: hash('final-state'), completedAt: signedAt };
  return { ...common, operation: 'safety-recovery', frozenPolicyHash: hash('recovery-policy'),
    originalExecutionAuthorizationRef: ref('execution-envelope'), originalFencingGeneration: 7,
    fencingGeneration: 8, lineage: { predecessorRef: ref('predecessor'), targetRef: ref('target'), expectedPointerRevision: 12 },
    rollbackExpectedPointerRevision: 13,
    allowedActions: ['withdraw-traffic', 'revoke-existing-fault', 'set-off', 'rollback-to-predecessor'],
    credentialRef: ref('jit-credential'), roleId: 'recovery-duty-role', approvedMaxTtlMs: 300000 };
}

function signed(kind = 'execution', input = payload(kind), signatureOverrides = {}) {
  const unsigned = { schemaVersion: schemas[kind], kind, payload: clone(input),
    signer: { algorithm: 'Ed25519', keyId: `${kind}-key`, keyVersion: 'key-version-1', ...signatureOverrides } };
  const bytes = canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1', ...unsigned });
  return { schemaVersion: unsigned.schemaVersion, kind, payload: unsigned.payload,
    signature: { ...unsigned.signer, value: sign(null, Buffer.from(bytes), pairs[kind].privateKey).toString('base64url') } };
}

function options() {
  return { executionProfile: 'local-reference', maxConsumedNonces: 100,
    keys: kinds.map(kind => ({ keyId: `${kind}-key`, keyVersion: 'key-version-1', issuerId: issuers[kind],
      role: kind, publicKeySpki: pairs[kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      validFrom: '2026-10-09T03:00:00.000Z', validUntil: '2026-10-09T04:00:00.000Z', revoked: false })) };
}

function request(envelope = signed()) { return { envelope, expectedPayload: clone(envelope.payload), observedAt }; }
function verify(input, config = options()) { return approval.createReferenceApprovalVerifier(config).verifyOnce(input); }

test('three authorization kinds have exact detached versioned contracts, never production approval', () => {
  for (const kind of kinds) {
    const envelope = signed(kind); const validated = approval.validateAuthorizationEnvelope(envelope);
    assert.equal(validated.envelopeDigest, hash(envelope));
    assert.equal(validated.validationLevel, 'structural-only');
    assert.equal(validated.productionAuthorized, false);
    assert.equal(Object.isFrozen(validated.envelope.payload.scope), true);
    envelope.payload.scope.tenantId = 'modified';
    assert.equal(validated.envelope.payload.scope.tenantId, 'tenant-a');
    const verified = verify(request(signed(kind)));
    assert.equal(verified.signatureVerified, true);
    assert.equal(verified.productionAuthorized, false);
    assert.equal(verified.validationLevel, 'local-reference-cryptographic');
    assert.equal(Object.isFrozen(verified), true);
  }
});

test('signature binds kind/schema/key version and every payload field without exposing private keys', () => {
  const original = signed();
  const changes = [value => { value.payload.manifestHash = hash('other'); },
    value => { value.signature.keyVersion = 'key-version-2'; },
    value => { value.signature.value = Buffer.alloc(64, 1).toString('base64url'); },
    value => { value.kind = 'result'; }, value => { value.schemaVersion = schemas.result; }];
  for (const change of changes) {
    const envelope = clone(original); change(envelope);
    assert.throws(() => verify(request(envelope)), /authorization/);
  }
  const signature = signed().signature;
  assert.equal(Buffer.from(signature.value, 'base64url').byteLength, 64);
  assert.throws(() => verify(request(signed('execution', payload(), { algorithm: 'none' }))), /authorization/);
});

test('execution/result/recovery keys and actors cannot substitute for each other', () => {
  for (const kind of kinds) {
    const wrongActor = payload(kind); wrongActor.issuerId = 'executor';
    assert.throws(() => verify(request(signed(kind, wrongActor))), /authorization/);
    const config = options(); config.keys.find(key => key.role === kind).role = kinds.find(other => other !== kind);
    assert.throws(() => verify(request(signed(kind)), config), /authorization/);
    const mergedRoles = payload(kind); mergedRoles.participants.resultAuthorityId = 'executor';
    assert.throws(() => verify(request(signed(kind, mergedRoles))), /authorization/);
  }
});

test('the complete trusted expectation binds scope/stage/run/result/provider/threshold/window identities', () => {
  for (const kind of kinds) {
    const input = request(signed(kind));
    for (const change of [value => { value.scope.corpusId = 'other-corpus'; },
      value => { value.stage = 'T16'; }, value => { value.runNonce = 'a'.repeat(32); },
      value => { value.manifestHash = hash('other-manifest'); }]) {
      const changed = clone(input); change(changed.expectedPayload);
      assert.throws(() => verify(changed), /authorization.*expectation/);
    }
  }
  for (const [kind, field] of [['execution', 'providersHash'], ['execution', 'thresholdsHash'],
    ['result', 'reportHash'], ['result', 'artifactIndexHash'], ['result', 'finalStateHash'],
    ['recovery', 'frozenPolicyHash']]) {
    const input = request(signed(kind)); input.expectedPayload[field] = hash('other');
    assert.throws(() => verify(input), /authorization.*expectation/);
  }
  for (const field of ['receiptCoreRef', 'executionAuthorizationRef']) {
    const input = request(signed('result')); input.expectedPayload[field].objectVersion = 'other-version';
    assert.throws(() => verify(input), /authorization.*expectation/);
  }
});

test('closed validity intervals reject future, expired, revoked, unknown and stale key versions', () => {
  for (const kind of kinds) {
    const input = request(signed(kind));
    for (const time of ['2026-10-09T03:19:59.999Z', '2026-10-09T03:25:00.000Z']) {
      assert.throws(() => verify({ ...input, observedAt: time }), /authorization.*time|authorization.*valid/);
    }
    for (const edit of [key => { key.revoked = true; }, key => { key.keyVersion = 'old-version'; },
      key => { key.validUntil = observedAt; }, key => { key.validFrom = '2026-10-09T03:20:01.000Z'; }]) {
      const config = options(); edit(config.keys.find(key => key.role === kind));
      assert.throws(() => verify(input, config), /authorization/);
    }
  }
});

test('nonce consumption is atomic within the reference instance, bounded and not a distributed authority', () => {
  const config = options(); config.maxConsumedNonces = 1;
  const verifier = approval.createReferenceApprovalVerifier(config); const input = request();
  assert.equal(verifier.executionProfile, 'local-reference');
  assert.equal(verifier.productionCapable, false);
  assert.equal(verifier.verifyOnce(input).signatureVerified, true);
  assert.throws(() => verifier.verifyOnce(input), /authorization.*replay/);
  const next = payload(); next.nonce = 'b'.repeat(32); next.authorizationId = 'execution-approval-2';
  assert.throws(() => verifier.verifyOnce(request(signed('execution', next))), /authorization.*capacity/);
  assert.throws(() => approval.createReferenceApprovalVerifier({ ...options(), executionProfile: 'production' }), /authorization/);
});

test('failed signature or expectation does not poison nonce state; clock rollback fails closed', () => {
  const verifier = approval.createReferenceApprovalVerifier(options()); const input = request();
  const tampered = clone(input); tampered.envelope.signature.value = Buffer.alloc(64).toString('base64url');
  assert.throws(() => verifier.verifyOnce(tampered), /authorization/);
  const wrong = clone(input); wrong.expectedPayload.manifestHash = hash('wrong');
  assert.throws(() => verifier.verifyOnce(wrong), /authorization.*expectation/);
  assert.equal(verifier.verifyOnce(input).signatureVerified, true);
  const next = payload(); next.nonce = 'c'.repeat(32); next.authorizationId = 'approval-2';
  const earlier = request(signed('execution', next)); earlier.observedAt = '2026-10-09T03:20:59.999Z';
  assert.throws(() => verifier.verifyOnce(earlier), /authorization.*clock/);
});

test('recovery is T17-only and permits only four risk-reducing actions at an actual new fence', () => {
  for (const change of [value => { value.stage = 'T16'; },
    value => { value.fencingGeneration = value.originalFencingGeneration; },
    value => { value.allowedActions.push('activate'); }, value => { value.allowedActions.push('increase-traffic'); },
    value => { value.allowedActions.push('inject-fault'); }, value => { value.allowedActions = []; },
    value => { value.allowedActions.push('set-off'); },
    value => { value.lineage.predecessorRef = clone(value.lineage.targetRef); },
    value => { value.approvedMaxTtlMs = 299999; },
    value => { value.expiresAt = '2026-10-09T03:25:00.001Z'; }]) {
    const value = payload('recovery'); change(value);
    assert.throws(() => verify(request(signed('recovery', value))), /authorization/);
  }
  const input = request(signed('recovery')); input.expectedPayload.fencingGeneration = 9;
  assert.throws(() => verify(input), /authorization.*expectation/);
  for (const field of ['predecessorRef', 'targetRef']) {
    const changed = request(signed('recovery')); changed.expectedPayload.lineage[field] = ref('different-lineage');
    assert.throws(() => verify(changed), /authorization.*expectation/);
  }
});

test('recovery signs frozen lineage revision and the unique post-publication rollback CAS revision', () => {
  const missing = payload('recovery');
  delete missing.lineage.expectedPointerRevision; delete missing.rollbackExpectedPointerRevision;
  assert.throws(() => approval.validateAuthorizationEnvelope(signed('recovery', missing)), /authorization/);
  const valid = payload('recovery'); valid.lineage.expectedPointerRevision = 12; valid.rollbackExpectedPointerRevision = 13;
  assert.equal(verify(request(signed('recovery', valid))).signatureVerified, true);
  for (const change of [value => { value.lineage.expectedPointerRevision = -1; },
    value => { value.lineage.expectedPointerRevision = Number.MAX_SAFE_INTEGER; },
    value => { value.rollbackExpectedPointerRevision = 12; },
    value => { value.rollbackExpectedPointerRevision = 15; }]) {
    const changed = clone(valid); change(changed);
    assert.throws(() => verify(request(signed('recovery', changed))), /authorization.*revision/i);
  }
  const input = request(signed('recovery', valid));
  input.expectedPayload.lineage.expectedPointerRevision = 14; input.expectedPayload.rollbackExpectedPointerRevision = 15;
  assert.throws(() => verify(input), /authorization.*expectation/);
  const firstPublication = clone(valid); firstPublication.lineage.expectedPointerRevision = 0;
  firstPublication.rollbackExpectedPointerRevision = 1;
  assert.equal(verify(request(signed('recovery', firstPublication))).signatureVerified, true);
});

test('recovery leaves a safe integer revision budget for both publication and rollback', () => {
  const exhausted = payload('recovery');
  exhausted.lineage.expectedPointerRevision = Number.MAX_SAFE_INTEGER - 1;
  exhausted.rollbackExpectedPointerRevision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => verify(request(signed('recovery', exhausted))), /authorization.*revision/i);
  const lastSafe = payload('recovery');
  lastSafe.lineage.expectedPointerRevision = Number.MAX_SAFE_INTEGER - 2;
  lastSafe.rollbackExpectedPointerRevision = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(verify(request(signed('recovery', lastSafe))).signatureVerified, true);
});

test('execution stage operation/window and result ordering/identity are mandatory', () => {
  for (const change of [value => { value.operation = 'execute-t16-shadow'; },
    value => { value.expiresAt = '2026-10-09T03:30:00.001Z'; },
    value => { value.window.startsAt = '2026-10-09T03:20:00.001Z'; },
    value => { value.window.endsAt = signedAt; },
    value => { value.participants.recoveryAuthorityId = null; }]) {
    const value = payload(); change(value);
    assert.throws(() => verify(request(signed('execution', value))), /authorization/);
  }
  for (const change of [value => { value.completedAt = '2026-10-09T03:20:00.001Z'; },
    value => { value.executionIdentityId = 'other-executor'; }, value => { value.machineVerdict = 'unknown'; }]) {
    const value = payload('result'); change(value);
    assert.throws(() => verify(request(signed('result', value))), /authorization/);
  }
  for (const stage of ['T16', 'R18']) {
    const value = payload(); value.stage = stage; value.participants.recoveryAuthorityId = null;
    value.operation = stage === 'T16' ? 'execute-t16-shadow' : 'verify-retention';
    assert.equal(verify(request(signed('execution', value))).signatureVerified, true);
  }
});

test('signed contracts reject hidden data, arbitrary commands/URLs, unsafe references and secret diagnostics', () => {
  const secret = 'secret-must-not-appear'; let calls = 0;
  const trap = () => { calls += 1; throw new Error(secret); };
  const cases = [new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap }),
    Object.defineProperty({}, 'payload', { enumerable: true, get: trap }),
    { ...signed(), [secret]: true },
    signed('recovery', { ...payload('recovery'), command: secret }),
    signed('execution', { ...payload(), registryRef: { ...ref('registry'), objectId: '../outside' } }),
    signed('execution', { ...payload(), issuerId: `https://${secret}` })];
  for (const value of cases) {
    assert.throws(() => approval.validateAuthorizationEnvelope(value), error => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /authorization|canonical JSON/); return true;
    });
  }
  assert.equal(calls, 0);
});

test('registry is detached and rejects ambiguous/reused signer keys and non-Ed25519 material', () => {
  const config = options(); const verifier = approval.createReferenceApprovalVerifier(config);
  config.keys[0].revoked = true;
  assert.equal(verifier.verifyOnce(request()).signatureVerified, true);
  const duplicate = options(); duplicate.keys.push(clone(duplicate.keys[0]));
  assert.throws(() => approval.createReferenceApprovalVerifier(duplicate), /authorization/);
  const reused = options(); reused.keys[1].publicKeySpki = reused.keys[0].publicKeySpki;
  assert.throws(() => approval.createReferenceApprovalVerifier(reused), /authorization/);
  const wrongKey = options(); wrongKey.keys[0].publicKeySpki = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  assert.throws(() => approval.createReferenceApprovalVerifier(wrongKey), /authorization/);
  const malformed = options(); malformed.keys[0].publicKeySpki = 'AAAA';
  assert.throws(() => approval.createReferenceApprovalVerifier(malformed), error => {
    assert.match(error.message, /authorization.*public key/); assert.equal(error.cause, undefined); return true;
  });
});

test('non-consuming signature verifier shares exact crypto checks but never spends a nonce', () => {
  const config = options(); delete config.maxConsumedNonces;
  const verifier = approval.createReferenceAuthorizationSignatureVerifier(config);
  config.keys[0].revoked = true;
  for (const kind of kinds) {
    const input = request(signed(kind));
    const first = verifier.verifySignature(input); const second = verifier.verifySignature(input);
    assert.equal(first.signatureVerified, true); assert.equal(first.nonceConsumed, false);
    assert.equal(first.productionAuthorized, false); assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first.envelope.payload), true);
    assert.equal(verify(input).envelopeDigest, first.envelopeDigest);
  }
  assert.equal(verifier.productionCapable, false);
});

test('stateless signature checks still reject invalid signature, full expectation, expired time and revoked keys', () => {
  const config = options(); delete config.maxConsumedNonces;
  const verifier = approval.createReferenceAuthorizationSignatureVerifier(config); const original = request();
  for (const edit of [value => { value.envelope.signature.value = Buffer.alloc(64, 1).toString('base64url'); },
    value => { value.expectedPayload.manifestHash = hash('different'); },
    value => { value.observedAt = original.envelope.payload.expiresAt; }]) {
    const input = clone(original); edit(input); assert.throws(() => verifier.verifySignature(input), /authorization/);
  }
  const revoked = clone(config); revoked.keys[0].revoked = true;
  assert.throws(() => approval.createReferenceAuthorizationSignatureVerifier(revoked).verifySignature(original), /authorization/);
  assert.equal(verifier.verifySignature(original).nonceConsumed, false);
});
