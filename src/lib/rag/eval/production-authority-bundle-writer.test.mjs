import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture, clone, times } from './production-receipt-fixtures.test-support.mjs';
import { manifest } from './production-manifest-fixtures.test-support.mjs';

const subject = await import('./production-authority-receipts.ts');
const consumes = f => f.calls.filter(value => value === 'nonceStore.consumeAuthorizationNonce').length;
const stores = f => f.calls.filter(value => value === 'store.sealEncryptedArtifact').length;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failure = code => error => error instanceof subject.AuthorityReceiptWriterError && (!code || error.code === code)
  && error.productionAccepted === false && error.automaticRetryAllowed === false && !error.message.includes('SENSITIVE');

async function prepared(stage = 'T16', changes = {}, alter) {
  const f = fixture(stage, { manifestBound: true, includeResultKey: true, ...changes });
  if (alter) alter(f);
  const { expectedCoreIdentities: _ids, ...writerOptions } = f.options; void _ids;
  const { artifactId: _id, retainUntil: _until, ...readerOptions } = writerOptions; void _id; void _until;
  const writer = subject.createReferenceManifestAuthorityReceiptWriter({ ...writerOptions, manifest: f.manifest }, f.ports);
  await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
  const coreSeal = await writer.sealCore({ coreDraft: f.coreDraft });
  const input = { resultEnvelope: clone(f.acceptanceInput(coreSeal).evidence.resultEnvelope) };
  f.clock.advanceTo('2026-10-09T04:01:00.000Z');
  return { ...f, writer, coreSeal, input, readerOptions: { ...readerOptions, manifest: clone(f.manifest) } };
}

test('both private-session writers expose the authority bundle seal entry point', () => {
  const f = fixture('T16', { includeResultKey: true, manifestBound: true });
  assert.equal(typeof subject.createReferenceAuthorityReceiptWriter(f.options, f.ports).sealBundle, 'function');
  const { expectedCoreIdentities: _ids, ...options } = f.options; void _ids;
  assert.equal(typeof subject.createReferenceManifestAuthorityReceiptWriter({ ...options, manifest: f.manifest }, f.ports).sealBundle, 'function');
});

test('actual result/proof/bundle objects are individually encrypted, sealed and read back without modifying the core', async () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = await prepared(stage); const oldCore = canonicalJson(f.coreSeal.core); const bundle = await f.writer.sealBundle(f.input);
    assert.equal(bundle.productionAccepted, false); assert.equal(bundle.stageAcceptanceComplete, false); assert.equal(bundle.machineGateComputed, false);
    assert.equal(bundle.bundle.stage, stage); assert.equal(bundle.bundle.createdAt, '2026-10-09T04:01:00.000Z');
    assert.equal(bundle.acceptanceBundleRef.sha256, hash(bundle.bundle)); assert.equal(consumes(f), 2); assert.equal(stores(f), 4);
    assert.equal(canonicalJson(f.coreSeal.core), oldCore); assert.deepEqual(bundle.evidence.core, f.coreSeal.core);
    const expected = [
      ['result-attestation', bundle.resultAttestationStorageRef, bundle.bundle.resultAttestationRef, bundle.evidence.resultEnvelope],
      ['readback-proof', bundle.readbackProofStorageRef, bundle.bundle.readbackProofRef, bundle.evidence.readbackProof],
      ['acceptance-bundle', bundle.bundleStorageRef, bundle.acceptanceBundleRef, bundle.bundle],
    ];
    const context = { executionProfile: 'local-reference', binding: f.binding, actorId: 'reader-a',
      authorizationDigest: f.executionRef.sha256, observedAt: bundle.bundle.createdAt };
    for (const [type, storageRef, logicalRef, value] of expected) {
      assert.equal(storageRef.objectId, logicalRef.objectId); assert.equal(storageRef.objectVersion, logicalRef.objectVersion);
      assert.notEqual(storageRef.sha256, logicalRef.sha256); assert.equal(logicalRef.sha256, hash(value));
      const stored = await f.store.readExact({ context, ref: storageRef }); assert.equal(stored.object.aad.artifactType, type);
      assert.equal(hash(stored.object), storageRef.sha256);
      const plaintext = await f.kms.decryptArtifact({ context, aad: stored.object.aad, envelope: stored.object.envelope });
      assert.equal(plaintext, Buffer.from(canonicalJson(value), 'utf8').toString('base64url'));
    }
    assert.equal(new Set(expected.map(([, storageRef]) => storageRef.objectId)).size, 3);
    const { decisionHash, ...observation } = bundle.authorityObservation; assert.equal(decisionHash, hash(observation));
    assert.equal(Object.isFrozen(bundle.evidence.resultEnvelope.payload), true);
    const before = f.calls.length; await assert.rejects(f.writer.sealBundle(f.input), failure('already-bundle-sealed'));
    await assert.rejects(f.writer.sealCore({ coreDraft: f.coreDraft }), failure('already-sealed')); assert.equal(f.calls.length, before);
  }
});

test('no caller core, bundle or approval label can replace the privately sealed core session', async () => {
  const f = fixture('T16', { includeResultKey: true }); const writer = subject.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await assert.rejects(writer.sealBundle({ resultEnvelope: null, approvalDecision: true }), failure('core-not-sealed')); assert.deepEqual(f.calls, []);
  await writer.beginExecution(f.beginInput); const before = f.calls.length;
  await assert.rejects(writer.sealBundle({ resultEnvelope: null }), failure('core-not-sealed')); assert.equal(f.calls.length, before);
  const ready = await prepared();
  for (const label of [{ bundle: {} }, { core: ready.coreSeal.core }, { createdAt: times.seal }, { approvalDecision: true }]) {
    const start = ready.calls.length; await assert.rejects(ready.writer.sealBundle({ ...ready.input, ...label }), failure('invalid-evidence'));
    assert.equal(ready.calls.length, start);
  }
  await ready.writer.sealBundle(ready.input); assert.equal(consumes(ready), 2);
});

test('kind, signatures and result/core correspondence reject before any later provider IO', async () => {
  for (const mode of ['kind', 'signature', 'stage', 'run', 'scope', 'core', 'verdict', 'report', 'execution']) {
    const f = await prepared(); const input = clone(f.input); const body = input.resultEnvelope.payload;
    if (mode === 'kind') input.resultEnvelope = clone(f.beginInput.executionEnvelope);
    if (mode === 'signature') input.resultEnvelope.signature.value = Buffer.alloc(64).toString('base64url');
    if (mode === 'stage') body.stage = 'T17'; if (mode === 'run') body.runNonce = 'e'.repeat(32);
    if (mode === 'scope') body.scope.tenantId = 'other'; if (mode === 'core') body.receiptCoreRef.objectVersion = 'other';
    if (mode === 'verdict') body.machineVerdict = 'failed'; if (mode === 'report') body.reportHash = hash('other');
    if (mode === 'execution') body.executionAuthorizationRef.objectVersion = 'other';
    const before = f.calls.length; await assert.rejects(f.writer.sealBundle(input), failure('invalid-evidence'));
    assert.equal(f.calls.length, before, mode); assert.equal(consumes(f), 1); assert.equal(stores(f), 1);
  }
});

test('returned original approval provenance supports actual historical readback with no new nonce consumption', async () => {
  const f = await prepared(); const sealed = await f.writer.sealBundle(f.input);
  const input = { bundle: sealed.bundle, evidence: sealed.evidence, conformanceObjects: f.beginInput.conformanceObjects,
    runtimeObjects: f.beginInput.runtimeObjects, resultApprovalProvenance: sealed.resultApprovalProvenance };
  const reader = subject.createReferenceManifestAuthorityReceiptVerifier(f.readerOptions, f.ports);
  const decision = await reader.verifyExistingBundle(input); assert.equal(decision.bundleDigest, sealed.acceptanceBundleRef.sha256);
  assert.equal(decision.stageAcceptanceComplete, false); assert.equal(consumes(f), 2);
});

test('result issuance cannot precede actual core readback completion or its full uncertainty upper bound', async () => {
  for (const [completedAt, uncertaintyMs] of [['2026-10-09T04:00:50.000Z', 0], ['2026-10-09T04:00:40.000Z', 500]]) {
    const f = await prepared('T16', { uncertaintyMs }, f => {
      // Keep the initial uncertainty interval inside the execution grant so
      // this case reaches the intended post-core completion boundary.
      if (uncertaintyMs) f.clock.advanceTo(new Date(Date.parse(times.begin) + uncertaintyMs).toISOString());
      const decrypt = f.ports.kms.decryptArtifact;
      f.ports.kms.decryptArtifact = async request => { const plaintext = await decrypt(request);
        if (request.aad.artifactType === 'receipt-core') f.clock.advanceTo(completedAt); return plaintext; }; });
    assert.equal(f.coreSeal.readbackProof.observedAt, times.seal);
    assert.equal(f.coreSeal.authorityObservation.verifiedAt, completedAt);
    assert.ok(Date.parse(f.input.resultEnvelope.payload.issuedAt) < Date.parse(completedAt) + uncertaintyMs);
    const before = f.calls.length;
    await assert.rejects(f.writer.sealBundle(f.input), failure('invalid-evidence'));
    assert.equal(f.calls.length, before); assert.equal(consumes(f), 1); assert.equal(stores(f), 1);
  }
});

test('one configured execution session has a bounded challenge budget for its complete core and bundle path', async () => {
  const f = await prepared('T16', {}, f => { f.options.maxVerifications = 1; });
  const sealed = await f.writer.sealBundle(f.input);
  assert.equal(sealed.stageAcceptanceComplete, false); assert.equal(consumes(f), 2); assert.equal(stores(f), 4);
});

test('bundle approval still obeys the original nonce verifier budget without constructing a replacement', async () => {
  const f = await prepared('T16', {}, f => { f.options.approvalOptions.maxVerifications = 1; });
  await assert.rejects(f.writer.sealBundle(f.input), failure('approval-failed'));
  assert.equal(consumes(f), 1); assert.equal(stores(f), 1);
  const before = f.calls.length; await assert.rejects(f.writer.sealBundle(f.input), failure('halted')); assert.equal(f.calls.length, before);
});

test('the real authority-sealed bundle is consumable by frozen successor object readback, without fixture persistence', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = await prepared(stage); const sealed = await f.writer.sealBundle(f.input);
    const successor = manifest(stage === 'T16' ? 'T17' : 'R18'); const policy = successor[stage === 'T16' ? 't17' : 'retention'];
    Object.assign(policy.predecessor, { acceptanceBundleRef: sealed.acceptanceBundleRef, manifestHash: f.binding.manifestHash });
    if (stage === 'T17') { policy.frozenRetention = clone(f.manifest.t17.frozenRetention);
      Object.assign(policy.predecessor, { retentionPolicyHash: policy.frozenRetention.policyHash,
        oldStoreManifestHash: policy.frozenRetention.oldStoreManifestHash }); }
    const verifier = subject.createReferencePredecessorReceiptVerifier({ executionProfile: 'local-reference',
      successorManifest: successor, predecessorReceiptOptions: f.readerOptions }, f.ports);
    const decision = await verifier.verifyPredecessor({ bundleStorageRef: sealed.bundleStorageRef, bundle: sealed.bundle,
      evidence: sealed.evidence, conformanceObjects: f.beginInput.conformanceObjects, runtimeObjects: f.beginInput.runtimeObjects,
      resultApprovalProvenance: sealed.resultApprovalProvenance });
    assert.equal(decision.predecessorLinkVerified, true); assert.equal(decision.predecessorChainComplete, false); assert.equal(consumes(f), 2);
  }
});

test('signed failed verdict remains failed in the immutable audit bundle, never stage acceptance', async () => {
  const f = await prepared('T16', { machineVerdict: 'failed' }); const sealed = await f.writer.sealBundle(f.input);
  assert.equal(sealed.evidence.core.machineVerdict, 'failed'); assert.equal(sealed.evidence.resultEnvelope.payload.machineVerdict, 'failed');
  assert.equal(sealed.stageAcceptanceComplete, false); assert.equal(sealed.machineGateComputed, false); assert.equal(consumes(f), 2);
});

test('expiry after core seal prevents result consumption and every later ciphertext mutation', async () => {
  const f = await prepared(); f.clock.advanceTo(times.expired);
  await assert.rejects(f.writer.sealBundle(f.input), failure()); assert.equal(consumes(f), 1); assert.equal(stores(f), 1);
  const before = f.calls.length; await assert.rejects(f.writer.sealBundle(f.input), failure('halted')); assert.equal(f.calls.length, before);
});

test('expiry during journal IO before result encryption prevents the actual encryption callback', async () => {
  let laterEncrypts = 0; let expired = false;
  const f = await prepared('T16', {}, f => {
    const read = f.ports.journal.readHead; const consume = f.ports.nonceStore.consumeAuthorizationNonce; const encrypt = f.ports.kms.encryptArtifact;
    f.ports.nonceStore.consumeAuthorizationNonce = async request => { const raw = await consume(request);
      if (request.authorizationKind === 'result') expired = true; return raw; };
    f.ports.journal.readHead = async () => { const raw = await read(); if (expired) f.clock.advanceTo(times.expired); return raw; };
    f.ports.kms.encryptArtifact = request => { if (request.aad.artifactType !== 'receipt-core') laterEncrypts++; return encrypt(request); };
  });
  await assert.rejects(f.writer.sealBundle(f.input), failure()); assert.equal(laterEncrypts, 0); assert.equal(stores(f), 1);
});

test('post-core clock regression is denied before result consumption across the shared private cursor', async () => {
  for (const mode of ['sequence', 'time']) {
    let last; let regress = false; let observed = 0;
    const f = await prepared('T16', {}, f => { const read = f.ports.clock.readTime;
      f.ports.clock.readTime = async request => { const raw = clone(await read(request));
        if (regress) { observed++; return { ...raw, sequence: mode === 'sequence' ? last.sequence : raw.sequence,
          observedAt: mode === 'time' ? times.complete : raw.observedAt }; }
        last = raw; return raw; }; });
    regress = true; await assert.rejects(f.writer.sealBundle(f.input), failure());
    assert.equal(observed, 1); assert.equal(consumes(f), 1); assert.equal(stores(f), 1);
  }
});

test('wrong store proof, object/AAD and decrypted plaintext reject without silently continuing to the bundle', async () => {
  for (const mode of ['proof', 'object', 'aad', 'plaintext']) {
    let later = false;
    const f = await prepared('T16', {}, f => {
      const store = f.ports.store.readExact; const encrypt = f.ports.kms.encryptArtifact; const decrypt = f.ports.kms.decryptArtifact;
      f.ports.kms.encryptArtifact = async request => { if (request.aad.artifactType !== 'receipt-core') later = true; return encrypt(request); };
      f.ports.store.readExact = async request => { const raw = clone(await store(request));
        if (later && mode === 'proof') raw.proof.readerId = 'other';
        if (later && mode === 'object') raw.object.envelope.tag = Buffer.alloc(16).toString('base64url');
        if (later && mode === 'aad') raw.object.aad.tenantId = 'other'; return raw; };
      f.ports.kms.decryptArtifact = async request => later && mode === 'plaintext' ? Buffer.from('SENSITIVE').toString('base64url') : decrypt(request);
    });
    await assert.rejects(f.writer.sealBundle(f.input), failure('invalid-evidence')); assert.equal(stores(f), 2); assert.equal(consumes(f), 2);
    const before = f.calls.length; await assert.rejects(f.writer.sealBundle(f.input), failure('halted')); assert.equal(f.calls.length, before);
  }
});

test('after real result storage commits, expiry preserves that object and prevents the next object', async () => {
  let committed; let later = false;
  const f = await prepared('T16', {}, f => { const encrypt = f.ports.kms.encryptArtifact; const store = f.ports.store.sealEncryptedArtifact;
    f.ports.kms.encryptArtifact = async request => { if (request.aad.artifactType !== 'receipt-core') later = true; return encrypt(request); };
    f.ports.store.sealEncryptedArtifact = async request => { const ref = await store(request);
      if (later) { committed = ref; f.clock.advanceTo(times.expired); } return ref; }; });
  await assert.rejects(f.writer.sealBundle(f.input), error => failure()(error) && error.mutationMayHaveOccurred);
  assert.equal(stores(f), 2); assert.ok(committed);
  const read = await f.store.readExact({ context: { executionProfile: 'local-reference', binding: f.binding, actorId: 'reader-a',
    authorizationDigest: f.executionRef.sha256, observedAt: '2026-10-09T04:01:00.000Z' }, ref: committed });
  assert.equal(read.object.aad.artifactType, 'result-attestation'); assert.equal(consumes(f), 2);
});

test('UNKNOWN result storage completion halts every entry point; late commits cannot trigger remaining IO', async t => {
  const entered = deferred(); const release = deferred(); let raw;
  const f = await prepared('T16', {}, f => {
    f.options.operationTimeoutMs = 100; f.options.approvalOptions.operationTimeoutMs = 100;
    const store = f.ports.store.sealEncryptedArtifact;
    f.ports.store.sealEncryptedArtifact = request => {
      if (request.aad.artifactType === 'receipt-core') return store(request);
      raw = store(request); entered.resolve(); return release.promise;
    };
  });
  const pending = f.writer.sealBundle(f.input); t.after(async () => { release.resolve(await raw); await pending.catch(() => {}); });
  const observed = assert.rejects(pending, error => failure('operation-timeout')(error) && error.pendingCompletionUnknown && error.mutationMayHaveOccurred);
  await entered.promise; const before = f.calls.length; await observed;
  release.resolve(await raw); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before);
  await assert.rejects(f.writer.sealBundle(f.input), failure('halted'));
  await assert.rejects(f.writer.sealCore({ coreDraft: f.coreDraft }), failure('halted'));
  await assert.rejects(f.writer.beginExecution(f.beginInput), failure('halted')); assert.equal(consumes(f), 2);
});

test('bundle phase shares the same busy lock and cannot be reset by any public entry point', async t => {
  const entered = deferred(); const release = deferred();
  const f = await prepared('T16', {}, f => { const encrypt = f.ports.kms.encryptArtifact;
    f.ports.kms.encryptArtifact = async request => { if (request.aad.artifactType !== 'receipt-core') { entered.resolve(); await release.promise; }
      return encrypt(request); }; });
  const pending = f.writer.sealBundle(f.input); t.after(async () => { release.resolve(); await pending.catch(() => {}); });
  await entered.promise; const before = f.calls.length;
  await assert.rejects(f.writer.sealBundle(f.input), failure('busy'));
  await assert.rejects(f.writer.sealCore({ coreDraft: f.coreDraft }), failure('busy'));
  await assert.rejects(f.writer.beginExecution(f.beginInput), failure('busy')); assert.equal(f.calls.length, before);
  release.resolve(); await pending; assert.equal(consumes(f), 2);
});

test('result input, key roots and captured callbacks cannot drift across first await', async t => {
  const entered = deferred(); const release = deferred(); let afterCore = false;
  const f = await prepared('T16', {}, f => { const read = f.ports.clock.readTime;
    f.ports.clock.readTime = async request => { if (afterCore) { entered.resolve(); await release.promise; } return read(request); }; });
  afterCore = true; const originalEnvelope = clone(f.input.resultEnvelope); const pending = f.writer.sealBundle(f.input);
  t.after(async () => { release.resolve(); await pending.catch(() => {}); }); await entered.promise;
  f.input.resultEnvelope.payload.machineVerdict = 'failed'; f.options.approvalOptions.keys.forEach(key => { key.revoked = true; }); let traps = 0;
  for (const [port, method] of [['kms', 'encryptArtifact'], ['store', 'sealEncryptedArtifact']]) {
    Object.defineProperty(f.ports[port], method, { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
  }
  release.resolve(); const sealed = await pending;
  assert.deepEqual(sealed.evidence.resultEnvelope, originalEnvelope); assert.equal(traps, 0); assert.equal(consumes(f), 2);
});

test('getters, Proxy requests and hostile provider thenables execute no hooks and grant no later write', async () => {
  for (const mode of ['getter', 'proxy', 'thenable']) {
    let hostile = false; let traps = 0;
    const f = await prepared('T16', {}, f => {
      const encrypt = f.ports.kms.encryptArtifact;
      f.ports.kms.encryptArtifact = request => hostile ? { then() { traps++; } } : encrypt(request);
    });
    let input = f.input;
    if (mode === 'getter') Object.defineProperty(input, 'resultEnvelope', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'proxy') input = new Proxy(input, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'thenable') hostile = true;
    await assert.rejects(f.writer.sealBundle(input), failure(mode === 'thenable' ? 'provider-contract-invalid' : 'invalid-evidence'));
    assert.equal(traps, 0); assert.equal(stores(f), 1); assert.equal(consumes(f), mode === 'thenable' ? 2 : 1);
  }
});
