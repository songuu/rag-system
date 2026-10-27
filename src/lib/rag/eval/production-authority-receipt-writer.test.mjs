import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJsonSha256 as hash } from './canonical-json.ts';

const subject = await import('./production-authority-receipts.ts');
import { fixture, clone, ref, roles, times } from './production-receipt-fixtures.test-support.mjs';
const failure = (code, phase) => error => error instanceof subject.AuthorityReceiptWriterError && error.code === code
  && (!phase || error.phase === phase) && error.productionAccepted === false && error.automaticRetryAllowed === false && !error.message.includes('SENSITIVE');

test('execution is consumed before the run; terminal sealing never consumes it again', async () => {
  assert.equal(typeof subject.createReferenceAuthorityReceiptWriter, 'function');
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = fixture(stage); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
    const begin = await writer.beginExecution(f.beginInput);
    assert.equal(begin.productionAccepted, false); assert.equal(begin.stageAcceptanceComplete, false);
    assert.equal(f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length, 1);
    assert.equal(f.calls.includes('kms.encryptArtifact'), false);
    f.recordRun(); f.clock.advanceTo(times.seal);
    const seal = await writer.sealCore({ coreDraft: f.coreDraft });
    assert.equal(seal.productionAccepted, false); assert.equal(seal.stageAcceptanceComplete, false);
    assert.equal(seal.core.sealedAt, times.seal); assert.equal(Object.isFrozen(seal.core.identities), true);
    assert.equal(f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length, 1);
    assert.equal(f.calls.filter(v => v === 'store.sealEncryptedArtifact').length, 1);
    const { decisionHash, ...observation } = seal.authorityObservation; assert.equal(decisionHash, hash(observation));
  }
});

test('no caller approval label can seal without the private execution session', async () => {
  const f = fixture(); f.recordRun(); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft, productionAuthorized: true }), failure('not-started'));
  assert.deepEqual(f.calls, []);
});

test('bad signatures and descriptor-controlled requests fail without provider calls', async () => {
  for (const mode of ['signature', 'extra', 'getter', 'proxy']) {
    const f = fixture(); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); let traps = 0; let input = f.beginInput;
    if (mode === 'signature') input.executionEnvelope.signature.value = Buffer.alloc(64).toString('base64url');
    if (mode === 'extra') input.approvalDecision = { productionAuthorized: true };
    if (mode === 'getter') Object.defineProperty(input, 'runtimeObjects', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'proxy') input = new Proxy(input, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    await assert.rejects(writer.beginExecution(input), failure('invalid-evidence', 'preflight')); assert.equal(traps, 0); assert.deepEqual(f.calls, []);
  }
});

test('a completed journal cannot be retrospectively authorized', async () => {
  const f = fixture(); f.recordRun(); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await assert.rejects(writer.beginExecution(f.beginInput), failure('invalid-evidence', 'journal'));
  assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false); assert.equal(f.calls.includes('kms.encryptArtifact'), false);
});

test('expired execution and tampered provider evidence never consume the nonce', async () => {
  for (const mode of ['expired', 'provider']) {
    const f = fixture(); if (mode === 'expired') f.clock.advanceTo(times.expired);
    else { f.beginInput.runtimeObjects[0].attestation.body.instanceId = 'other'; f.beginInput.runtimeObjects[0].ref.sha256 = hash(f.beginInput.runtimeObjects[0].attestation); }
    const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
    await assert.rejects(writer.beginExecution(f.beginInput), failure('invalid-evidence'));
    assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false);
  }
});

test('repeat start/seal cannot replay a nonce or a stored success', async () => {
  const f = fixture(); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput);
  const before = f.calls.length; await assert.rejects(writer.beginExecution(f.beginInput), failure('already-started')); assert.equal(f.calls.length, before);
  const other = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await assert.rejects(other.beginExecution(f.beginInput), failure('approval-failed'));
  f.recordRun(); f.clock.advanceTo(times.seal); await writer.sealCore({ coreDraft: f.coreDraft }); const after = f.calls.length;
  await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('already-sealed')); assert.equal(f.calls.length, after);
});

test('caller sealing time, manifest identities and pre-session run times are rejected before crypto', async () => {
  for (const mode of ['seal-time', 'identity', 'started-before', 'recovery']) {
    const f = fixture(); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    if (mode === 'seal-time') f.coreDraft.sealedAt = times.seal;
    if (mode === 'identity') f.coreDraft.identities.datasetHash = hash('other');
    if (mode === 'started-before') f.coreDraft.startedAt = '2026-10-09T04:00:09.000Z';
    if (mode === 'recovery') f.coreDraft.recoveryAuthorizationRefs.push(ref('recovery-authorization'));
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('invalid-evidence', 'preflight')); assert.equal(f.calls.includes('kms.encryptArtifact'), false);
  }
});

test('fully rehashed but unauthorized journals cannot be sealed', async () => {
  for (const mode of ['actor', 'digest', 'action', 'fence', 'time', 'truncated', 'unstable']) {
    const f = fixture(); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput);
    f.recordRun(bodies => { if (mode === 'actor') bodies[0].actorId = 'intruder'; if (mode === 'digest') bodies[0].authorizationDigest = hash('other');
      if (mode === 'action') bodies[0].action = bodies[1].action = 'activate'; if (mode === 'fence') bodies.forEach(v => { v.fencingGeneration = 2; });
      if (mode === 'time') bodies[0].trustedTime = '2026-10-09T04:00:09.000Z'; });
    if (mode === 'fence') { f.readback.head.fencingGeneration = 2; f.coreDraft.journal.fencingGeneration = 2; f.coreDraft.journal.headRef.sha256 = hash(f.readback.head); }
    if (mode === 'truncated') f.readback.entries.pop();
    if (mode === 'unstable') { let reads = 0; const original = f.ports.journal.readHead;
      // Factory captured methods: mutate the actual data source, not its callbacks.
      void original; Object.defineProperty(f.readback.head, 'rootDigest', { enumerable: true, get() { return ++reads === 1 ? hash('other') : f.coreDraft.journal.rootDigest; } }); }
    f.clock.advanceTo(times.seal);
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('invalid-evidence'));
    assert.equal(f.calls.includes('kms.encryptArtifact'), false);
  }
});

test('declared failed verdict stays failed and never becomes stage acceptance', async () => {
  const f = fixture('T16', { machineVerdict: 'failed' }); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
  const seal = await writer.sealCore({ coreDraft: f.coreDraft }); assert.equal(seal.core.machineVerdict, 'failed'); assert.equal(seal.stageAcceptanceComplete, false);
});

test('expiry during head readback must be checked before actual store dispatch', async () => {
  const f = fixture(); let expireHead = false; const encrypt = f.ports.kms.encryptArtifact; const readHead = f.ports.journal.readHead;
  f.ports.kms.encryptArtifact = request => encrypt(request).then(value => { expireHead = true; return value; });
  f.ports.journal.readHead = () => { if (expireHead) { expireHead = false; f.clock.advanceTo(times.expired); } return readHead(); };
  const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput);
  f.recordRun(); f.clock.advanceTo(times.seal);
  await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), error => failure('invalid-evidence')(error) && error.mutationMayHaveOccurred);
  assert.equal(f.calls.includes('store.sealEncryptedArtifact'), false);
  const before = f.calls.length; await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('halted')); assert.equal(f.calls.length, before);
});

test('expiry after real encryption prevents storage and after real storage preserves the committed object', async () => {
  for (const mode of ['encrypt', 'store']) {
    const f = fixture(); let committedRef;
    if (mode === 'encrypt') { const original = f.ports.kms.encryptArtifact;
      f.ports.kms.encryptArtifact = request => original(request).then(value => { f.clock.advanceTo(times.expired); return value; }); }
    else { const original = f.ports.store.sealEncryptedArtifact;
      f.ports.store.sealEncryptedArtifact = request => original(request).then(value => { committedRef = value; f.clock.advanceTo(times.expired); return value; }); }
    const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput);
    f.recordRun(); f.clock.advanceTo(times.seal);
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), error => failure('invalid-evidence')(error)
      && error.nonceOutcome === 'reported-consumed' && error.mutationMayHaveOccurred);
    assert.equal(f.calls.includes('store.sealEncryptedArtifact'), mode === 'store'); assert.equal(f.calls.includes('store.readExact'), false);
    if (committedRef) {
      const readback = await f.store.readExact({ context: { executionProfile: 'local-reference', binding: f.binding, actorId: roles.readOnlyId,
        authorizationDigest: f.executionRef.sha256, observedAt: times.seal }, ref: committedRef });
      assert.equal(hash(readback.object), committedRef.sha256);
    }
    const before = f.calls.length; await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('halted')); assert.equal(f.calls.length, before);
  }
});

test('every later mutation reads registry again; invalid refresh prevents store dispatch', async () => {
  const f = fixture(); let invalid = false; const encrypt = f.ports.kms.encryptArtifact; const readPolicy = f.ports.registry.readExactPolicy;
  f.ports.kms.encryptArtifact = request => encrypt(request).then(value => { invalid = true; return value; });
  f.ports.registry.readExactPolicy = request => readPolicy(request).then(value => {
    if (!invalid) return value; const copy = clone(value); copy.proof.sourceIdentityRef = ref('untrusted'); return copy;
  });
  const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput);
  f.recordRun(); f.clock.advanceTo(times.seal); await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('invalid-evidence', 'registry'));
  assert.equal(f.calls.includes('store.sealEncryptedArtifact'), false);
});

test('full clock uncertainty covers retention and live provider expiry, not only caller labels', async () => {
  for (const mode of ['retention', 'runtime', 'clock-regression']) {
    const f = fixture('T16', { uncertaintyMs: mode === 'retention' ? 1 : 0 });
    if (mode === 'retention') { f.clock.advanceTo('2026-10-09T04:00:10.002Z'); f.options.retainUntil = '2026-10-09T04:00:30.001Z'; }
    let stale = false; const readTime = f.ports.clock.readTime;
    if (mode === 'clock-regression') f.ports.clock.readTime = request => readTime(request).then(value => stale ? { ...value, sequence: 1 } : value);
    const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput); f.recordRun(); stale = true;
    f.clock.advanceTo(mode === 'runtime' ? '2026-10-09T04:03:00.000Z' : times.seal);
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('invalid-evidence')); assert.equal(f.calls.includes('kms.encryptArtifact'), false);
  }
});

test('KMS, object, proof and plaintext mismatches never return a successful seal', async () => {
  for (const mode of ['aad', 'object-ref', 'reader', 'plaintext', 'throw']) {
    const f = fixture();
    if (mode === 'aad') { const original = f.ports.kms.encryptArtifact; f.ports.kms.encryptArtifact = request => original(request).then(value => ({ ...value, aadSha256: hash('other') })); }
    if (mode === 'object-ref') { const original = f.ports.store.sealEncryptedArtifact; f.ports.store.sealEncryptedArtifact = request => original(request).then(value => ({ ...value, sha256: hash('other') })); }
    if (mode === 'reader') { const original = f.ports.store.readExact; f.ports.store.readExact = request => original(request).then(value => ({ ...value, proof: { ...value.proof, readerId: roles.executorId } })); }
    if (mode === 'plaintext') f.ports.kms.decryptArtifact = () => Promise.resolve('other');
    if (mode === 'throw') f.ports.kms.encryptArtifact = () => { throw Error('SENSITIVE provider diagnostic'); };
    const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), error => failure(mode === 'throw' ? 'operation-failed' : 'invalid-evidence')(error)
      && error.mutationMayHaveOccurred && error.nonceOutcome === 'reported-consumed');
    const before = f.calls.length; await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('halted')); assert.equal(f.calls.length, before);
  }
});

test('unsafe provider carriers are not adopted and halt without later storage', async () => {
  for (const mode of ['then-getter', 'proxy', 'array-payload']) {
    const f = fixture(); let traps = 0;
    const carrier = mode === 'proxy' ? new Proxy({}, { get() { traps++; throw Error('SENSITIVE'); } })
      : Object.defineProperty({}, 'then', { get() { traps++; throw Error('SENSITIVE'); } });
    f.ports.kms.encryptArtifact = () => mode === 'array-payload' ? Promise.resolve([]) : carrier;
    const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), error => error instanceof subject.AuthorityReceiptWriterError && error.mutationMayHaveOccurred);
    assert.equal(traps, 0); assert.equal(f.calls.includes('store.sealEncryptedArtifact'), false);
    await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('halted'));
  }
});

test('unknown encryption completion halts; a late real fulfillment cannot continue storage', async () => {
  const f = fixture(); let resolveEncryption; let entered; const entry = new Promise(resolve => { entered = resolve; }); let request;
  const pending = new Promise(resolve => { resolveEncryption = resolve; });
  f.ports.kms.encryptArtifact = input => { request = input; entered(); return pending; };
  const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports); await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
  const sealing = writer.sealCore({ coreDraft: f.coreDraft }); await entry;
  await assert.rejects(sealing, error => failure('operation-timeout')(error) && error.pendingCompletionUnknown && error.mutationMayHaveOccurred);
  const before = f.calls.length; resolveEncryption(await f.kms.encryptArtifact(request));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before); assert.equal(f.calls.includes('store.sealEncryptedArtifact'), false);
  await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('halted'));
});

test('actual nonce commit followed by an unknown claim read halts before any run or seal', async () => {
  const f = fixture(); f.ports.nonceStore.readExactNonceClaim = () => new Promise(() => {});
  const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await assert.rejects(writer.beginExecution(f.beginInput), error => failure('approval-failed')(error) && error.pendingCompletionUnknown && error.nonceOutcome === 'reported-consumed');
  assert.equal(f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length, 1); assert.equal(f.calls.includes('kms.encryptArtifact'), false);
  const before = f.calls.length; await assert.rejects(writer.beginExecution(f.beginInput), failure('halted')); assert.equal(f.calls.length, before);
});

test('busy calls do no IO; options, methods and request data are captured before awaits', async () => {
  const f = fixture(); let release; let entered; let pause = true; const barrier = new Promise(resolve => { release = resolve; });
  const entry = new Promise(resolve => { entered = resolve; }); const readHead = f.ports.journal.readHead;
  f.ports.journal.readHead = async () => { if (pause) { pause = false; entered(); await barrier; } return readHead(); };
  const expectedDataset = f.options.expectedCoreIdentities.datasetHash; const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  const beginning = writer.beginExecution(f.beginInput); await entry; const before = f.calls.length;
  await assert.rejects(writer.beginExecution(f.beginInput), failure('busy')); assert.equal(f.calls.length, before);
  await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), failure('busy')); assert.equal(f.calls.length, before);
  f.beginInput.runtimeObjects[0].attestation.body.instanceId = 'mutated-after-call';
  f.options.expectedCoreIdentities.datasetHash = hash('mutated-config'); f.options.operationTimeoutMs = 1;
  f.ports.kms.encryptArtifact = () => { throw Error('SENSITIVE replaced method'); };
  release(); await beginning; f.recordRun(); f.clock.advanceTo(times.seal);
  const seal = await writer.sealCore({ coreDraft: f.coreDraft }); assert.equal(seal.core.identities.datasetHash, expectedDataset);
});

test('configuration accessors/proxies and unsafe port methods are rejected with zero traps', () => {
  for (const mode of ['options-getter', 'options-proxy', 'port-getter', 'method-proxy']) {
    const f = fixture(); let traps = 0; let options = f.options;
    if (mode === 'options-getter') Object.defineProperty(options, 'artifactId', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'options-proxy') options = new Proxy(options, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'port-getter') Object.defineProperty(f.ports.kms, 'encryptArtifact', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'method-proxy') f.ports.kms.encryptArtifact = new Proxy(() => {}, { apply() { traps++; throw Error('SENSITIVE'); } });
    assert.throws(() => subject.createReferenceAuthorityReceiptWriter(options, f.ports), failure('invalid-config', 'configuration'));
    assert.equal(traps, 0); assert.deepEqual(f.calls, []);
  }
});
