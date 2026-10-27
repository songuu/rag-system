import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import { canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture, clone, times } from './production-receipt-fixtures.test-support.mjs';

const authority = await import('./production-authority-approval.ts');
const ports = await import('./production-authority-ports.ts');
const failure = (code, phase, pending = false) => error => {
  assert.equal(error.name, 'AuthorityApprovalError'); assert.equal(error.code, code); assert.equal(error.phase, phase);
  assert.equal(error.nonceOutcome, 'not-attempted'); assert.equal(error.pendingCompletionUnknown, pending);
  assert.equal(error.productionAuthorized, false); assert.equal(error.message.includes('SENSITIVE'), false); return true;
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const create = (f, config = f.options.approvalOptions) => authority.createReferenceAuthorityApprovalProvenanceVerifier(config, f.deps);
const consumes = f => f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length;

test('approval provenance exposes an actual read-only verification entry point', () => {
  assert.equal(typeof authority.createReferenceAuthorityApprovalProvenanceVerifier, 'function');
});

test('bad signature, expectation, run/scope/actor and original reading/ref fail before IO', async () => {
  for (const mode of ['signature', 'expectation', 'actor', 'tenant', 'run', 'time', 'challenge', 'sequence', 'clock-source', 'clock-reader', 'uncertainty', 'claim-digest']) {
    const f = await approved(); const proof = clone(f.proof);
    if (mode === 'signature') proof.envelope.signature.value = Buffer.alloc(64).toString('base64url');
    if (mode === 'expectation') proof.expectedPayload.thresholdsHash = hash('other');
    if (mode === 'actor') proof.context.actorId = 'other';
    if (mode === 'tenant') proof.context.binding.tenantId = 'other';
    if (mode === 'run') proof.context.binding.runNonce = 'a'.repeat(32);
    if (mode === 'time') proof.claimedClockReading.observedAt = '2026-10-09T06:00:00.000Z';
    if (mode === 'challenge') proof.claimedClockReading.requestNonce = 'b'.repeat(32);
    if (mode === 'sequence') proof.claimedClockReading.sequence++;
    if (mode === 'clock-source') proof.claimedClockReading.sourceIdentityRef.objectVersion = 'v2';
    if (mode === 'clock-reader') proof.claimedClockReading.readerId = 'other';
    if (mode === 'uncertainty') proof.claimedClockReading.uncertaintyMs = 1001;
    if (mode === 'claim-digest') proof.nonceClaimRef.sha256 = hash('other');
    const before = f.calls.length;
    await assert.rejects(create(f).verifyExistingClaim(proof), error => error.productionAuthorized === false && error.nonceOutcome === 'not-attempted');
    assert.equal(f.calls.length, before, mode);
  }
});

test('absent exact object/version or an empty nonce store is not historical approval', async () => {
  for (const mode of ['object-id', 'version', 'empty-store']) {
    const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z');
    if (mode === 'object-id') f.proof.nonceClaimRef.objectId = 'other';
    if (mode === 'version') f.proof.nonceClaimRef.objectVersion = 'v2';
    if (mode === 'empty-store') {
      const empty = ports.createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope: f.proof.envelope.payload.scope,
        actors: { writerId: f.proof.context.actorId, readOnlyId: f.proof.envelope.payload.participants.readOnlyId },
        storeIdentityRef: f.options.approvalOptions.nonceStoreIdentityRef, clockIdentityRef: f.options.approvalOptions.clockIdentityRef,
        maxClaims: 100, maxClockUncertaintyMs: 1000 });
      f.deps.nonceStore.readExactNonceClaim = input => empty.readExactNonceClaim(input);
    }
    const count = consumes(f); await assert.rejects(create(f).verifyExistingClaim(f.proof), failure('nonce-read-failed', 'readback'));
    assert.equal(consumes(f), count);
  }
});

test('every actual claim/store/ref/reader substitution rejects instead of trusting a response label', async () => {
  for (const mode of ['digest', 'claimed-time', 'consumer', 'source', 'ref', 'reader', 'assurance']) {
    const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z'); const read = f.deps.nonceStore.readExactNonceClaim;
    f.deps.nonceStore.readExactNonceClaim = async input => {
      const raw = clone(await read(input));
      if (mode === 'digest') raw.object.envelopeDigest = hash('other');
      if (mode === 'claimed-time') raw.object.claimedAt = '2026-10-09T04:00:11.000Z';
      if (mode === 'consumer') raw.object.consumerId = 'other';
      if (mode === 'source') raw.proof.storeIdentityRef.objectVersion = 'v2';
      if (mode === 'ref') raw.proof.objectRef.objectVersion = 'v2';
      if (mode === 'reader') raw.proof.readerId = 'other';
      if (mode === 'assurance') raw.proof.productionDurable = true;
      return raw;
    };
    const count = consumes(f); await assert.rejects(create(f).verifyExistingClaim(f.proof), failure('nonce-read-invalid', 'readback'));
    assert.equal(consumes(f), count);
  }
});

test('revoked keys and a substituted consumer reject before reads while config stays detached', async () => {
  for (const mode of ['revoked', 'consumer']) {
    const f = await approved(); const config = clone(f.options.approvalOptions);
    if (mode === 'revoked') config.keys.find(key => key.keyId === f.proof.envelope.signature.keyId).revoked = true;
    else config.actors.verifierId = 'other';
    const before = f.calls.length; await assert.rejects(create(f, config).verifyExistingClaim(f.proof)); assert.equal(f.calls.length, before);
  }
  const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z'); const config = clone(f.options.approvalOptions); const verifier = create(f, config);
  config.keys.forEach(key => { key.revoked = true; }); config.scope.tenantId = 'other';
  assert.equal((await verifier.verifyExistingClaim(f.proof)).executionAuthorized, false);
});

test('fresh clock challenge/source/sequence/uncertainty and final progress are independently checked', async () => {
  for (const mode of ['challenge', 'source', 'original-sequence', 'uncertainty', 'future-history', 'final-sequence', 'final-time']) {
    const f = await approved(); if (mode !== 'future-history') f.clock.advanceTo('2026-10-09T06:00:00.000Z');
    const read = f.deps.clock.readTime; let count = 0;
    f.deps.clock.readTime = async input => {
      const reading = clone(await read(input)); count++;
      if (mode === 'challenge') reading.requestNonce = 'e'.repeat(32);
      if (mode === 'source') reading.sourceIdentityRef.objectVersion = 'v2';
      if (mode === 'original-sequence') reading.sequence = f.proof.claimedClockReading.sequence;
      if (mode === 'uncertainty') reading.uncertaintyMs = 1001;
      if (mode === 'future-history') reading.uncertaintyMs = 100;
      if (count === 2 && mode === 'final-sequence') reading.sequence--;
      if (count === 2 && mode === 'final-time') reading.observedAt = '2026-10-09T05:59:59.000Z';
      return reading;
    };
    const consumed = consumes(f); await assert.rejects(create(f).verifyExistingClaim(f.proof), failure('clock-invalid', mode.startsWith('final') ? 'final-clock' : 'initial-clock'));
    assert.equal(consumes(f), consumed);
  }
});

test('failed read diagnostics are redacted and a settled unavailable read may be retried explicitly', async () => {
  const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z'); const read = f.deps.nonceStore.readExactNonceClaim; let fail = true;
  f.deps.nonceStore.readExactNonceClaim = input => { if (fail) throw Error('SENSITIVE provider-secret'); return read(input); };
  const verifier = create(f); const count = consumes(f);
  await assert.rejects(verifier.verifyExistingClaim(f.proof), failure('nonce-read-failed', 'readback'));
  fail = false; assert.equal((await verifier.verifyExistingClaim(f.proof)).nonceConsumedByThisVerifier, false); assert.equal(consumes(f), count);
});

test('unknown read completion halts this observer and late fulfillment never triggers a final clock or consume', async () => {
  const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z'); const read = f.deps.nonceStore.readExactNonceClaim;
  const entered = deferred(); const release = deferred(); let raw;
  f.deps.nonceStore.readExactNonceClaim = input => { raw = read(input); entered.resolve(); return release.promise; };
  const config = clone(f.options.approvalOptions); config.operationTimeoutMs = 100; const verifier = create(f, config);
  const pending = verifier.verifyExistingClaim(f.proof); const observed = assert.rejects(pending, failure('operation-timeout', 'readback', true));
  await entered.promise; const before = f.calls.length; await observed;
  release.resolve(await raw); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, before); await assert.rejects(verifier.verifyExistingClaim(f.proof), failure('halted', 'preflight'));
});

test('one observer serializes reads, captures methods/data before awaits and enforces its attempt budget', async t => {
  const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z'); const read = f.deps.nonceStore.readExactNonceClaim;
  const entered = deferred(); const release = deferred(); let pause = true;
  f.deps.nonceStore.readExactNonceClaim = async input => { if (pause) { pause = false; entered.resolve(); await release.promise; } return read(input); };
  const config = clone(f.options.approvalOptions); config.maxVerifications = 1; const verifier = create(f, config);
  const pending = verifier.verifyExistingClaim(f.proof);
  t.after(async () => { release.resolve(); await pending.catch(() => {}); });
  await entered.promise; const before = f.calls.length;
  await assert.rejects(verifier.verifyExistingClaim(f.proof), failure('busy', 'preflight')); assert.equal(f.calls.length, before);
  f.proof.envelope.payload.scope.tenantId = 'changed'; f.proof.nonceClaimRef.objectVersion = 'v2';
  let traps = 0; Object.defineProperty(f.deps.nonceStore, 'readExactNonceClaim', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
  release.resolve(); const decision = await pending; assert.notEqual(decision.binding.tenantId, 'changed'); assert.equal(traps, 0);
  await assert.rejects(verifier.verifyExistingClaim(f.proof), failure('attempt-capacity', 'preflight')); assert.equal(consumes(f), 1);
});

test('getter/Proxy inputs and unsafe provider carriers never execute hooks or fabricate history', async () => {
  for (const mode of ['input-getter', 'input-proxy', 'payload-getter', 'payload-proxy', 'thenable']) {
    const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z'); let traps = 0; let proof = f.proof;
    if (mode === 'input-getter') Object.defineProperty(proof, 'claimedClockReading', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'input-proxy') proof = new Proxy(proof, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    if (mode.startsWith('payload')) {
      const raw = clone(await f.nonceStore.readExactNonceClaim({ context: { ...f.proof.context, actorId: f.proof.envelope.payload.participants.readOnlyId }, ref: f.proof.nonceClaimRef }));
      if (mode === 'payload-getter') Object.defineProperty(raw, 'object', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
      f.deps.nonceStore.readExactNonceClaim = () => mode === 'payload-proxy' ? new Proxy(raw, { ownKeys() { traps++; throw Error('SENSITIVE'); } }) : raw;
    }
    if (mode === 'thenable') f.deps.nonceStore.readExactNonceClaim = () => ({ then() { traps++; } });
    const count = consumes(f); await assert.rejects(create(f).verifyExistingClaim(proof), error => error.productionAuthorized === false && !error.message.includes('SENSITIVE'));
    assert.equal(traps, 0); assert.equal(consumes(f), count);
  }
});

test('reference restart with lost claims cannot recover approval from a signed envelope and labels alone', async () => {
  const f = await approved(); f.clock.advanceTo('2026-10-09T06:00:00.000Z');
  const restarted = fixture('T16', { includeResultKey: true }); restarted.clock.advanceTo('2026-10-09T06:00:00.000Z');
  await assert.rejects(authority.createReferenceAuthorityApprovalProvenanceVerifier(f.options.approvalOptions,
    { clock: restarted.ports.clock, nonceStore: restarted.ports.nonceStore }).verifyExistingClaim(f.proof));
  assert.equal(consumes(restarted), 0);
});

test('recovery provenance requires the same separately frozen rescue principal and never renews rescue authority', async () => {
  const f = fixture('T17'); const pair = generateKeyPairSync('ed25519'); const config = clone(f.options.approvalOptions);
  const scope = f.options.expectedExecutionPayload.scope; const participants = f.options.expectedExecutionPayload.participants;
  const credentialRef = { objectId: 'rescue-credential', objectVersion: 'v1', sha256: hash('rescue-credential') };
  config.actors.verifierId = 'rescue-worker'; config.recoveryPrincipal = { actorId: 'rescue-worker', roleId: 'rescue-role', credentialRef };
  config.keys.push({ keyId: 'recovery-key', keyVersion: 'v1', issuerId: participants.recoveryAuthorityId, role: 'recovery',
    publicKeySpki: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom: '2026-10-09T00:00:00.000Z', validUntil: '2026-10-10T00:00:00.000Z', revoked: false });
  const payload = { authorizationId: 'recovery-approval', nonce: '4'.repeat(32), issuerId: participants.recoveryAuthorityId,
    issuedAt: '2026-10-09T04:00:00.000Z', notBefore: '2026-10-09T04:00:00.000Z', expiresAt: '2026-10-09T04:01:00.000Z',
    operation: 'safety-recovery', stage: 'T17', scope, runNonce: f.binding.runNonce, manifestHash: f.binding.manifestHash, participants,
    frozenPolicyHash: hash('recovery-policy'), originalExecutionAuthorizationRef: f.executionRef, originalFencingGeneration: 7, fencingGeneration: 8,
    lineage: { predecessorRef: { objectId: 'prior', objectVersion: 'v1', sha256: hash('prior') },
      targetRef: { objectId: 'target', objectVersion: 'v1', sha256: hash('target') }, expectedPointerRevision: 2 },
    rollbackExpectedPointerRevision: 3, allowedActions: ['set-off'], credentialRef, roleId: 'rescue-role', approvedMaxTtlMs: 60000 };
  const signer = { algorithm: 'Ed25519', keyId: 'recovery-key', keyVersion: 'v1' }; const schemaVersion = 'kg-safety-recovery-authorization-envelope/v1';
  const envelope = { schemaVersion, kind: 'recovery', payload, signature: { ...signer,
    value: sign(null, Buffer.from(canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1', schemaVersion, kind: 'recovery', payload, signer })), pair.privateKey).toString('base64url') } };
  const clock = ports.createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: ['rescue-worker', participants.readOnlyId],
    sourceIdentityRef: config.clockIdentityRef, initialObservedAt: '2026-10-09T04:00:10.000Z', uncertaintyMs: 0, maxReadings: 100, maxAdvanceMs: 86400000 });
  const store = ports.createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope,
    actors: { writerId: 'rescue-worker', readOnlyId: participants.readOnlyId }, storeIdentityRef: config.nonceStoreIdentityRef,
    clockIdentityRef: config.clockIdentityRef, maxClaims: 100, maxClockUncertaintyMs: 1000 });
  let consumed; let count = 0; const deps = { clock, nonceStore: { ...store, consumeAuthorizationNonce(input) { count++; consumed = clone(input); return store.consumeAuthorizationNonce(input); } } };
  const input = { context: { executionProfile: 'local-reference', binding: f.binding, actorId: 'rescue-worker' }, envelope, expectedPayload: clone(payload) };
  const approval = await authority.createReferenceAuthorityApprovalVerifier(config, deps).verifyAndConsume(input);
  clock.advanceTo('2026-10-09T06:00:00.000Z'); const proof = { ...input, nonceClaimRef: approval.nonceClaimRef, claimedClockReading: consumed.clockReading };
  const decision = await authority.createReferenceAuthorityApprovalProvenanceVerifier(config, deps).verifyExistingClaim(proof);
  assert.equal(decision.kind, 'recovery'); assert.equal(decision.consumerId, 'rescue-worker'); assert.equal(decision.executionAuthorized, false); assert.equal(count, 1);
  const wrong = clone(config); wrong.recoveryPrincipal.roleId = 'other';
  await assert.rejects(authority.createReferenceAuthorityApprovalProvenanceVerifier(wrong, deps).verifyExistingClaim(proof), failure('invalid-request', 'preflight'));
});

async function approved(kind = 'execution') {
  const f = fixture('T16', { includeResultKey: true });
  let envelope = f.beginInput.executionEnvelope;
  if (kind === 'result') {
    const writer = (await import('./production-authority-receipts.ts')).createReferenceAuthorityReceiptWriter(f.options, f.ports);
    await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    const seal = await writer.sealCore({ coreDraft: f.coreDraft }); envelope = f.acceptanceInput(seal).evidence.resultEnvelope;
    f.clock.advanceTo('2026-10-09T04:01:00.000Z');
  }
  let consumed; const consume = f.ports.nonceStore.consumeAuthorizationNonce;
  f.ports.nonceStore.consumeAuthorizationNonce = input => { consumed = clone(input); return consume(input); };
  const input = { context: { executionProfile: 'local-reference', binding: clone(f.binding), actorId: envelope.payload.participants.executorId },
    envelope: clone(envelope), expectedPayload: clone(envelope.payload) };
  const decision = await authority.createReferenceAuthorityApprovalVerifier(f.options.approvalOptions,
    { clock: f.ports.clock, nonceStore: f.ports.nonceStore }).verifyAndConsume(input);
  const proof = { ...input, nonceClaimRef: clone(decision.nonceClaimRef), claimedClockReading: consumed.clockReading };
  return { ...f, proof, approval: decision, deps: { clock: f.ports.clock, nonceStore: f.ports.nonceStore } };
}

test('previously consumed execution and result approvals remain readable after expiry without consuming again', async () => {
  for (const kind of ['execution', 'result']) {
    const f = await approved(kind); f.clock.advanceTo('2026-10-09T06:00:00.000Z');
    const verifier = authority.createReferenceAuthorityApprovalProvenanceVerifier(f.options.approvalOptions, f.deps);
    const count = f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length;
    const result = await verifier.verifyExistingClaim(f.proof);
    assert.equal(result.productionAuthorized, false); assert.equal(result.executionAuthorized, false);
    assert.equal(result.nonceConsumedByThisVerifier, false); assert.equal(result.nonceClaimMatched, true);
    assert.equal(result.signatureVerified, true); assert.equal(result.kind, kind);
    assert.equal(result.claimedAt, f.proof.claimedClockReading.observedAt); assert.equal(result.verifiedAt, '2026-10-09T06:00:00.000Z');
    assert.deepEqual(result.nonceClaimRef, f.approval.nonceClaimRef);
    assert.equal(result.claimedClockReadingHash, hash(f.proof.claimedClockReading));
    const { decisionHash, ...body } = result; assert.equal(decisionHash, hash(body));
    assert.equal(Object.isFrozen(result.binding), true);
    assert.equal(JSON.stringify(result).includes(f.proof.envelope.payload.nonce), false);
    await verifier.verifyExistingClaim(f.proof);
    assert.equal(f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length, count);
  }
});
