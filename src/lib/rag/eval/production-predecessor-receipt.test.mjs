import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture, clone, times } from './production-receipt-fixtures.test-support.mjs';
import { manifest } from './production-manifest-fixtures.test-support.mjs';

const receipts = await import('./production-authority-receipts.ts');
const consumes = f => f.calls.filter(value => value === 'nonceStore.consumeAuthorizationNonce').length;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failure = (phase, code, pending = false) => error => {
  assert.equal(error.name, 'PredecessorReceiptError'); assert.equal(error.phase, phase); assert.equal(error.code, code);
  assert.equal(error.productionAccepted, false); assert.equal(error.executionAuthorized, false);
  assert.equal(error.nonceConsumedByThisVerifier, false); assert.equal(error.pendingCompletionUnknown, pending);
  assert.equal(error.message.includes('SENSITIVE'), false); return true;
};

async function predecessor(stage = 'T16', changes = {}) {
  const f = fixture(stage, { manifestBound: true, includeResultKey: true, ...changes });
  const { expectedCoreIdentities: _ids, ...writerOptions } = f.options; void _ids;
  const { artifactId: _id, retainUntil: _until, ...readerOptions } = writerOptions; void _id; void _until;
  const predecessorReceiptOptions = { ...readerOptions, manifest: clone(f.manifest) };
  let provenance;
  const consume = f.ports.nonceStore.consumeAuthorizationNonce;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const response = await consume(request);
    if (request.authorizationKind === 'result' && response.status === 'consumed') provenance = clone({
      nonceClaimRef: response.claimRef, claimedClockReading: request.clockReading });
    return response;
  };
  const writer = receipts.createReferenceManifestAuthorityReceiptWriter({ ...writerOptions, manifest: f.manifest }, f.ports);
  await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
  const seal = await writer.sealCore({ coreDraft: f.coreDraft }); const original = f.acceptanceInput(seal);
  f.clock.advanceTo('2026-10-09T04:01:00.000Z');
  await receipts.createReferenceManifestAuthorityReceiptVerifier(predecessorReceiptOptions, f.ports).verifyBundle(original);
  // Test-only fixture persistence through the real reference AEAD/store ports.
  // This is not an authority bundle writer or a production acceptance gate.
  const context = { executionProfile: 'local-reference', binding: f.binding, actorId: 'executor-a',
    authorizationDigest: f.executionRef.sha256, observedAt: original.bundle.createdAt };
  const aad = { ...f.binding, artifactType: 'acceptance-bundle', artifactId: `bundle-${stage.toLowerCase()}`,
    caseId: null, ordinal: 0, schemaVersion: 'kg-stage-acceptance-bundle/v1' };
  const envelope = await f.ports.kms.encryptArtifact({ context, aad,
    plaintextBase64url: Buffer.from(canonicalJson(original.bundle), 'utf8').toString('base64url') });
  const bundleStorageRef = await f.ports.store.sealEncryptedArtifact({ context, aad, envelope,
    retainUntil: changes.bundleRetainUntil ?? f.options.retainUntil });
  const acceptanceBundleRef = { ...bundleStorageRef, sha256: hash(original.bundle) };
  const successorManifest = manifest(stage === 'T16' ? 'T17' : 'R18');
  const policy = successorManifest[stage === 'T16' ? 't17' : 'retention'];
  Object.assign(policy.predecessor, { acceptanceBundleRef: clone(acceptanceBundleRef), manifestHash: f.binding.manifestHash });
  if (stage === 'T17') {
    policy.frozenRetention = clone(f.manifest.t17.frozenRetention);
    Object.assign(policy.predecessor, { retentionPolicyHash: policy.frozenRetention.policyHash,
      oldStoreManifestHash: policy.frozenRetention.oldStoreManifestHash });
  }
  const options = { executionProfile: 'local-reference', successorManifest, predecessorReceiptOptions };
  const input = { bundleStorageRef: clone(bundleStorageRef), bundle: clone(original.bundle),
    evidence: clone(original.evidence), conformanceObjects: clone(original.conformanceObjects),
    runtimeObjects: clone(original.runtimeObjects), resultApprovalProvenance: provenance };
  return { ...f, options, input, original, acceptanceBundleRef,
    create: ports => receipts.createReferencePredecessorReceiptVerifier(options, ports) };
}

test('T17 and R18 independently read/decrypt the exact frozen predecessor object and its actual historical receipt', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = await predecessor(stage); const before = f.calls.length; const count = consumes(f);
    const verifier = f.create(f.ports); const decision = await verifier.verifyPredecessor(f.input);
    assert.equal(decision.predecessorLinkVerified, true); assert.equal(decision.predecessorStage, stage);
    assert.equal(decision.successorStage, stage === 'T16' ? 'T17' : 'R18');
    assert.deepEqual(decision.acceptanceBundleRef, f.acceptanceBundleRef);
    assert.deepEqual(decision.bundleStorageRef, f.input.bundleStorageRef);
    assert.equal(decision.productionAccepted, false); assert.equal(decision.stageAcceptanceComplete, false);
    assert.equal(decision.executionAuthorized, false); assert.equal(decision.nonceConsumedByThisVerifier, false);
    assert.equal(decision.machineGateComputed, false); assert.equal(decision.predecessorChainComplete, false);
    assert.equal(Object.isFrozen(decision.acceptanceBundleRef), true);
    const { decisionHash, ...body } = decision; assert.equal(decisionHash, hash(body)); assert.equal(consumes(f), count);
    const dispatched = f.calls.slice(before);
    for (const method of ['store.readExact', 'kms.decryptArtifact', 'registry.readExactPolicy', 'journal.readHead',
      'journal.readEntries', 'nonceStore.readExactNonceClaim', 'clock.readTime']) assert.ok(dispatched.includes(method), method);
    for (const method of ['store.sealEncryptedArtifact', 'kms.encryptArtifact', 'nonceStore.consumeAuthorizationNonce']) assert.equal(dispatched.includes(method), false);
    await verifier.verifyPredecessor(f.input); assert.equal(consumes(f), count);
  }
});

test('bare bundles, skip flags and previous decisions cannot replace actual object IO', async () => {
  const f = await predecessor(); const verifier = f.create(f.ports);
  for (const input of [{ bundle: f.original.bundle }, { ...f.input, skipReadback: true }, { ...f.input, predecessorAccepted: true }]) {
    const before = f.calls.length;
    await assert.rejects(verifier.verifyPredecessor(input), failure('preflight', 'invalid-evidence'));
    assert.equal(f.calls.length, before);
  }
});

test('storage object ID and version must match the separately frozen logical reference before IO', async () => {
  const f = await predecessor(); const verifier = f.create(f.ports);
  for (const field of ['objectId', 'objectVersion']) {
    const input = clone(f.input); input.bundleStorageRef[field] = 'other'; const before = f.calls.length;
    await assert.rejects(verifier.verifyPredecessor(input), failure('preflight', 'invalid-evidence')); assert.equal(f.calls.length, before);
  }
});

test('independent predecessor manifest, stage and tenant scope cannot be substituted', async () => {
  for (const mode of ['manifest', 'scope', 'stage', 'caller-decision']) {
    const f = await predecessor();
    if (mode === 'manifest') f.options.successorManifest.t17.predecessor.manifestHash = hash('other');
    if (mode === 'scope') f.options.successorManifest.base.scope.tenantId = 'other';
    if (mode === 'stage') f.options.predecessorReceiptOptions.expectedExecutionPayload.stage = 'T17';
    if (mode === 'caller-decision') f.options.predecessorReceiptOptions.predecessorAccepted = true;
    const before = f.calls.length; assert.throws(() => f.create(f.ports), failure('configuration', 'invalid-config'));
    assert.equal(f.calls.length, before);
  }
});

test('R18 cannot replace actual T17 retention policy or old-store manifest with self-consistent new labels', async () => {
  for (const mode of ['policy', 'old-store']) {
    const f = await predecessor('T17'); const retention = f.options.successorManifest.retention;
    if (mode === 'policy') { retention.frozenRetention.policy.minimumElapsedMs += 1;
      retention.predecessor.retentionPolicyHash = retention.frozenRetention.policyHash = hash(retention.frozenRetention.policy); }
    else { retention.frozenRetention.oldStoreManifest.contentHash = hash('other');
      retention.predecessor.oldStoreManifestHash = retention.frozenRetention.oldStoreManifestHash = hash(retention.frozenRetention.oldStoreManifest); }
    const before = f.calls.length; assert.throws(() => f.create(f.ports), failure('configuration', 'invalid-config'));
    assert.equal(f.calls.length, before);
  }
});

test('the logical digest binds the candidate content, not an encrypted storage hash or plausible bundle label', async () => {
  for (const digest of ['storage', 'other']) {
    const f = await predecessor(); f.options.successorManifest.t17.predecessor.acceptanceBundleRef.sha256 =
      digest === 'storage' ? f.input.bundleStorageRef.sha256 : hash('other');
    const before = f.calls.length; await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('preflight', 'invalid-evidence'));
    assert.deepEqual(f.calls.slice(before), []); assert.equal(consumes(f), 2);
  }
});

test('bundle readback proof, source, encryption, AAD, digest and retention are independently enforced', async () => {
  for (const mode of ['source', 'version', 'reader', 'observed', 'lock', 'retention', 'ciphertext', 'aad']) {
    const f = await predecessor(); const read = f.ports.store.readExact;
    f.ports.store.readExact = async request => {
      const raw = clone(await read(request));
      if (mode === 'source') raw.proof.storeIdentityRef.objectId = 'other';
      if (mode === 'version') raw.proof.objectRef.objectVersion = 'other';
      if (mode === 'reader') raw.proof.readerId = 'other';
      if (mode === 'observed') raw.proof.observedAt = times.expired;
      if (mode === 'lock') raw.proof.lockMode = 'compliance-worm';
      if (mode === 'retention') raw.proof.retainUntil = times.expired;
      if (mode === 'ciphertext') raw.object.envelope.tag = Buffer.alloc(16).toString('base64url');
      if (mode === 'aad') raw.object.aad.tenantId = 'other';
      return raw;
    };
    const before = f.calls.length; await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('bundle-store', 'invalid-evidence'));
    assert.deepEqual(f.calls.slice(before), ['store.readExact']); assert.equal(consumes(f), 2);
  }
});

test('storage ciphertext digest cannot be replaced even when logical bundle digest matches', async () => {
  const f = await predecessor(); f.input.bundleStorageRef.sha256 = hash('other');
  await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('bundle-store', 'operation-failed')); assert.equal(consumes(f), 2);
});

test('decrypted content must be bounded canonical JSON with the exact frozen bundle digest', async () => {
  for (const mode of ['malformed', 'noncanonical', 'other', 'oversize', 'encoding']) {
    const f = await predecessor();
    const text = mode === 'malformed' ? 'SENSITIVE' : mode === 'noncanonical' ? JSON.stringify(f.original.bundle, null, 2)
      : mode === 'other' ? canonicalJson({ ...f.original.bundle, runNonce: 'e'.repeat(32) }) : 'x'.repeat(262145);
    f.ports.kms.decryptArtifact = async () => { f.calls.push('kms.decryptArtifact');
      return mode === 'encoding' ? 'invalid=' : Buffer.from(text, 'utf8').toString('base64url'); };
    const before = f.calls.length; await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('decrypt', 'invalid-evidence'));
    assert.deepEqual(f.calls.slice(before), ['store.readExact', 'kms.decryptArtifact']); assert.equal(consumes(f), 2);
  }
});

test('a passed label cannot hide invalid signatures, lost claim history or a replaced actual journal', async () => {
  for (const mode of ['signature', 'claim', 'journal']) {
    const f = await predecessor();
    if (mode === 'signature') f.input.evidence.resultEnvelope.signature.value = Buffer.alloc(64).toString('base64url');
    if (mode === 'claim') f.input.resultApprovalProvenance.nonceClaimRef.objectVersion = 'other';
    if (mode === 'journal') f.ports.journal.readEntries = async () => [];
    await assert.rejects(f.create(f.ports).verifyPredecessor(f.input),
      failure(mode === 'signature' ? 'preflight' : 'receipt', mode === 'signature' ? 'invalid-evidence' : 'receipt-invalid'));
    assert.equal(consumes(f), 2);
  }
});

test('a signed failed verdict is not a usable predecessor, and bundle retention remains live at final clock readback', async () => {
  const failed = await predecessor('T16', { machineVerdict: 'failed' }); const before = failed.calls.length;
  await assert.rejects(failed.create(failed.ports).verifyPredecessor(failed.input), failure('preflight', 'invalid-evidence'));
  assert.equal(failed.calls.length, before);
  const f = await predecessor('T16', { bundleRetainUntil: '2026-10-09T04:01:01.000Z' });
  f.clock.advanceTo('2026-10-09T04:01:01.000Z');
  await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('final-validation', 'invalid-evidence')); assert.equal(consumes(f), 2);
});

test('predecessor contexts always use the frozen independent reader and no mutation callback is dispatched', async () => {
  const f = await predecessor(); const seen = [];
  for (const [port, method] of [['store', 'readExact'], ['kms', 'decryptArtifact'], ['nonceStore', 'readExactNonceClaim']]) {
    const read = f.ports[port][method]; f.ports[port][method] = request => { seen.push(clone(request.context)); return read(request); };
  }
  await f.create(f.ports).verifyPredecessor(f.input);
  for (const context of seen) { assert.equal(context.actorId, 'reader-a'); assert.deepEqual(context.binding, f.binding); }
  assert.equal(consumes(f), 2);
});

test('settled bundle IO failures are redacted and explicit retries always perform fresh readback', async () => {
  const f = await predecessor(); const read = f.ports.store.readExact; let unavailable = true;
  f.ports.store.readExact = request => { if (unavailable) throw Error('SENSITIVE store credential'); return read(request); };
  const verifier = f.create(f.ports);
  await assert.rejects(verifier.verifyPredecessor(f.input), failure('bundle-store', 'operation-failed'));
  unavailable = false; const before = f.calls.length; await verifier.verifyPredecessor(f.input);
  assert.ok(f.calls.slice(before).includes('store.readExact')); assert.equal(consumes(f), 2);
});

test('UNKNOWN bundle completion halts the observer and late completion cannot continue decrypt or receipt IO', async t => {
  const f = await predecessor(); const read = f.ports.store.readExact; const entered = deferred(); const release = deferred(); let raw;
  f.ports.store.readExact = request => { raw = read(request); entered.resolve(); return release.promise; };
  f.options.predecessorReceiptOptions.operationTimeoutMs = 100; const verifier = f.create(f.ports);
  const pending = verifier.verifyPredecessor(f.input);
  t.after(async () => { release.resolve(await raw); await pending.catch(() => {}); });
  const observed = assert.rejects(pending, failure('bundle-store', 'operation-timeout', true));
  await entered.promise; const before = f.calls.length; await observed;
  release.resolve(await raw); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before);
  await assert.rejects(verifier.verifyPredecessor(f.input), failure('preflight', 'halted')); assert.equal(consumes(f), 2);
});

test('one private lock and attempt budget cover bundle and historical receipt IO', async t => {
  const f = await predecessor(); const read = f.ports.store.readExact; const entered = deferred(); const release = deferred();
  f.ports.store.readExact = async request => { entered.resolve(); await release.promise; return read(request); };
  f.options.predecessorReceiptOptions.maxVerifications = 1; const verifier = f.create(f.ports); const pending = verifier.verifyPredecessor(f.input);
  t.after(async () => { release.resolve(); await pending.catch(() => {}); }); await entered.promise; const before = f.calls.length;
  await assert.rejects(verifier.verifyPredecessor(f.input), failure('preflight', 'busy')); assert.equal(f.calls.length, before);
  release.resolve(); await pending;
  await assert.rejects(verifier.verifyPredecessor(f.input), failure('preflight', 'attempt-capacity')); assert.equal(consumes(f), 2);
});

test('input, frozen roots and captured read methods cannot drift after the first await', async t => {
  const f = await predecessor(); const read = f.ports.store.readExact; const entered = deferred(); const release = deferred();
  f.ports.store.readExact = async request => { entered.resolve(); await release.promise; return read(request); };
  const verifier = f.create(f.ports); const pending = verifier.verifyPredecessor(f.input);
  t.after(async () => { release.resolve(); await pending.catch(() => {}); }); await entered.promise;
  f.input.bundleStorageRef.objectVersion = 'other'; f.input.evidence.core.identities.datasetHash = hash('other');
  f.options.successorManifest.t17.predecessor.acceptanceBundleRef.sha256 = hash('other');
  f.options.predecessorReceiptOptions.approvalOptions.keys.forEach(key => { key.revoked = true; }); let traps = 0;
  for (const [port, method] of [['kms', 'decryptArtifact'], ['store', 'readExact']]) {
    Object.defineProperty(f.ports[port], method, { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
  }
  release.resolve(); const decision = await pending;
  assert.deepEqual(decision.acceptanceBundleRef, f.acceptanceBundleRef); assert.equal(traps, 0); assert.equal(consumes(f), 2);
});

test('getters, Proxy carriers and thenables cannot execute hooks during configuration, preflight or readback', async () => {
  for (const mode of ['config-getter', 'port-getter', 'input-proxy', 'input-getter', 'thenable', 'payload-proxy']) {
    const f = await predecessor(); let input = f.input; let traps = 0;
    if (mode === 'config-getter') Object.defineProperty(f.options, 'successorManifest', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'port-getter') Object.defineProperty(f.ports.store, 'readExact', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'input-proxy') input = new Proxy(input, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'input-getter') Object.defineProperty(input, 'evidence', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'thenable') f.ports.store.readExact = () => ({ then() { traps++; } });
    if (mode === 'payload-proxy') { const read = f.ports.store.readExact;
      f.ports.store.readExact = async request => new Proxy(await read(request), { ownKeys() { traps++; throw Error('SENSITIVE'); } }); }
    if (mode.startsWith('config') || mode.startsWith('port')) assert.throws(() => f.create(f.ports), failure('configuration', 'invalid-config'));
    else await assert.rejects(f.create(f.ports).verifyPredecessor(input), error => error.productionAccepted === false && !error.message.includes('SENSITIVE'));
    assert.equal(traps, 0); assert.equal(consumes(f), 2);
  }
});

test('a T17 window cannot precede the actual original predecessor approval even if it follows the bundle timestamp', async () => {
  const f = await predecessor(); Object.assign(f.options.successorManifest.t17.window,
    { startsAt: '2026-10-09T04:00:55.000Z', endsAt: times.expired });
  await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('final-validation', 'invalid-evidence'));
  assert.equal(consumes(f), 2);
});

test('a caller timestamp substitution is rejected by the frozen content hash before actual store IO', async () => {
  const f = await predecessor(); f.input.bundle.createdAt = '2026-10-09T04:01:00.000Z'; const before = f.calls.length;
  await assert.rejects(f.create(f.ports).verifyPredecessor(f.input), failure('preflight', 'invalid-evidence'));
  assert.equal(f.calls.length, before); assert.equal(consumes(f), 2);
});
