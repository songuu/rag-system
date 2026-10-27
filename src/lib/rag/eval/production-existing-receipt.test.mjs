import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture, clone, times } from './production-receipt-fixtures.test-support.mjs';

const receipts = await import('./production-authority-receipts.ts');
const consumes = f => f.calls.filter(value => value === 'nonceStore.consumeAuthorizationNonce').length;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failure = (phase, code, pending = false) => error => {
  assert.equal(error.name, 'AuthorityReceiptError'); assert.equal(error.phase, phase); assert.equal(error.code, code);
  assert.equal(error.nonceOutcome, 'not-attempted'); assert.equal(error.pendingCompletionUnknown, pending);
  assert.equal(error.productionAccepted, false); assert.equal(error.message.includes('SENSITIVE'), false); return true;
};

async function previouslyApproved(stage = 'T16', manifestBound = true, changes = {}) {
  const f = fixture(stage, { manifestBound, includeResultKey: true, ...changes });
  const { expectedCoreIdentities: _identities, ...writerOptions } = f.options; void _identities;
  const { expectedCoreIdentities: _ids, artifactId: _id, retainUntil: _until, ...readerOptions } = f.options;
  void _ids; void _id; void _until;
  const options = manifestBound ? { ...readerOptions, manifest: f.manifest } : readerOptions;
  let resultApprovalProvenance;
  const clockReadings = []; let clockTransform = null; const readClock = f.ports.clock.readTime;
  f.ports.clock.readTime = async request => {
    const actual = await readClock(request); const reading = clockTransform ? clockTransform(clone(actual), request) : actual;
    clockReadings.push(clone(reading)); return reading;
  };
  const consume = f.ports.nonceStore.consumeAuthorizationNonce;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const response = await consume(request);
    if (request.authorizationKind === 'result' && response.status === 'consumed') {
      resultApprovalProvenance = clone({ nonceClaimRef: response.claimRef, claimedClockReading: request.clockReading });
      if (changes.resultFinalTime) f.clock.advanceTo(changes.resultFinalTime);
    }
    return response;
  };
  const writer = manifestBound
    ? receipts.createReferenceManifestAuthorityReceiptWriter({ ...writerOptions, manifest: f.manifest }, f.ports)
    : receipts.createReferenceAuthorityReceiptWriter(f.options, f.ports);
  await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
  const seal = await writer.sealCore({ coreDraft: f.coreDraft });
  const create = ports => manifestBound ? receipts.createReferenceManifestAuthorityReceiptVerifier(options, ports)
    : receipts.createReferenceAuthorityReceiptVerifier(options, ports);
  const verifier = create(f.ports); const originalInput = f.acceptanceInput(seal);
  f.clock.advanceTo('2026-10-09T04:01:00.000Z');
  const originalDecision = await verifier.verifyBundle(originalInput);
  assert.equal(consumes(f), 2);
  return { ...f, options, create, verifier, seal, originalInput, originalDecision,
    clockReadings, setClockTransform: transform => { clockTransform = transform; },
    input: { ...clone(originalInput), resultApprovalProvenance } };
}

test('both receipt readers expose a distinct existing-bundle observation entry point', () => {
  for (const manifestBound of [false, true]) {
    const f = fixture('T16', { manifestBound, includeResultKey: true });
    const { expectedCoreIdentities: _ids, artifactId: _id, retainUntil: _until, ...options } = f.options;
    void _ids; void _id; void _until;
    const verifier = manifestBound ? receipts.createReferenceManifestAuthorityReceiptVerifier({ ...options, manifest: f.manifest }, f.ports)
      : receipts.createReferenceAuthorityReceiptVerifier(options, f.ports);
    assert.equal(typeof verifier.verifyExistingBundle, 'function');
  }
});

test('complete historical readback verifies actual manifest/signatures/journal/ciphertext without consuming result approval again', async () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = await previouslyApproved(stage); const count = consumes(f); const before = f.calls.length;
    const decision = await f.verifier.verifyExistingBundle(f.input);
    assert.equal(decision.validationLevel, 'local-reference-existing-authority-readback');
    assert.equal(decision.productionAccepted, false); assert.equal(decision.stageAcceptanceComplete, false);
    assert.equal(decision.executionAuthorized, false); assert.equal(decision.nonceConsumedByThisVerifier, false);
    assert.equal(decision.approvalProvenanceVerified, true); assert.equal(decision.signatureVerified, true);
    assert.equal(decision.bundleDigest, hash(f.input.bundle)); assert.equal(decision.receiptCoreDigest, hash(f.seal.core));
    const { decisionHash, ...body } = decision; assert.equal(decisionHash, hash(body));
    assert.equal(Object.isFrozen(decision), true); assert.equal(consumes(f), count);
    for (const name of ['registry.readExactPolicy', 'journal.readHead', 'journal.readEntries', 'store.readExact', 'kms.decryptArtifact', 'nonceStore.readExactNonceClaim', 'clock.readTime']) {
      assert.ok(f.calls.slice(before).includes(name), name);
    }
    await f.verifier.verifyExistingBundle(f.input); assert.equal(consumes(f), count);
  }
});

test('normal entry points cannot accept a historical proof or caller skip/decision label', async () => {
  for (const manifestBound of [false, true]) {
    const f = await previouslyApproved('T16', manifestBound);
    for (const label of [{ resultApprovalProvenance: f.input.resultApprovalProvenance }, { skipNonce: true }, { approvalDecision: f.originalDecision }]) {
      const before = f.calls.length;
      await assert.rejects(f.verifier.verifyBundle({ ...f.originalInput, ...label })); assert.equal(f.calls.length, before);
    }
    const count = consumes(f); await f.verifier.verifyExistingBundle(f.input); assert.equal(consumes(f), count);
    await assert.rejects(f.verifier.verifyBundle(f.originalInput)); assert.equal(consumes(f), count + 1);
    await f.verifier.verifyExistingBundle(f.input); assert.equal(consumes(f), count + 1);
  }
});

test('manifest/core and signed bundle substitutions fail before historical provider IO', async () => {
  for (const mode of ['manifest', 'dataset', 'signature', 'storage-version', 'core-digest', 'execution-version']) {
    const f = await previouslyApproved(); const input = clone(f.input);
    if (mode === 'manifest') input.evidence.core.manifestHash = hash('substituted');
    if (mode === 'dataset') input.evidence.core.identities.datasetHash = hash('substituted');
    if (mode === 'signature') input.evidence.resultEnvelope.signature.value = Buffer.alloc(64).toString('base64url');
    if (mode === 'storage-version') input.bundle.receiptStorageRef.objectVersion = 'substituted';
    if (mode === 'core-digest') input.bundle.receiptCoreRef.sha256 = hash('substituted');
    if (mode === 'execution-version') input.evidence.core.executionAuthorizationRef.objectVersion = 'substituted';
    const before = f.calls.length; await assert.rejects(f.verifier.verifyExistingBundle(input));
    assert.equal(f.calls.length, before, mode);
  }
});

test('historical proof is closed and cannot be manufactured from a previous decision hash', async () => {
  for (const mode of ['missing', 'label', 'extra', 'malformed-ref']) {
    const f = await previouslyApproved(); const input = clone(f.input);
    if (mode === 'missing') delete input.resultApprovalProvenance;
    if (mode === 'label') input.resultApprovalProvenance = { decisionHash: f.originalDecision.approvalDecisionHash };
    if (mode === 'extra') input.resultApprovalProvenance.executionAuthorized = true;
    if (mode === 'malformed-ref') input.resultApprovalProvenance.nonceClaimRef.sha256 = 'not-a-digest';
    const before = f.calls.length; await assert.rejects(f.verifier.verifyExistingBundle(input)); assert.equal(f.calls.length, before);
  }
});

test('original claim/ref/clock substitution and lost store history reject without new consumption', async () => {
  for (const mode of ['object', 'version', 'digest', 'original-clock', 'lost-store']) {
    const f = await previouslyApproved(); const input = clone(f.input);
    if (mode === 'object') input.resultApprovalProvenance.nonceClaimRef.objectId = 'other';
    if (mode === 'version') input.resultApprovalProvenance.nonceClaimRef.objectVersion = 'other';
    if (mode === 'digest') input.resultApprovalProvenance.nonceClaimRef.sha256 = hash('other');
    if (mode === 'original-clock') input.resultApprovalProvenance.claimedClockReading.readerId = 'other';
    if (mode === 'lost-store') f.ports.nonceStore.readExactNonceClaim = fixture().ports.nonceStore.readExactNonceClaim;
    const verifier = f.create(f.ports); const count = consumes(f);
    await assert.rejects(verifier.verifyExistingBundle(input), failure('result-approval', 'approval-failed'));
    assert.equal(consumes(f), count, mode);
  }
});

test('actual registry, stable journal, encrypted store, plaintext and nonce readback are all independently enforced', async () => {
  for (const mode of ['registry', 'certificate', 'journal-head', 'journal-entries', 'store-ref', 'store-reader', 'ciphertext', 'plaintext', 'nonce-claim', 'nonce-reader']) {
    const f = await previouslyApproved(); let phase;
    if (mode === 'registry') {
      const read = f.ports.registry.readExactPolicy; phase = 'registry';
      f.ports.registry.readExactPolicy = async request => { const raw = clone(await read(request)); raw.policy.policyId = 'other'; return raw; };
    }
    if (mode === 'certificate') { phase = 'registry'; f.input.runtimeObjects[0].attestation.signature.value = Buffer.alloc(64).toString('base64url'); }
    if (mode.startsWith('journal')) {
      phase = 'journal';
      if (mode === 'journal-head') { const read = f.ports.journal.readHead; let count = 0;
        f.ports.journal.readHead = async () => { const head = clone(await read()); if (++count === 2) head.rootDigest = hash('other'); return head; }; }
      else { const read = f.ports.journal.readEntries; f.ports.journal.readEntries = async () => (await read()).slice(0, -1); }
    }
    if (mode.startsWith('store') || mode === 'ciphertext') {
      phase = 'store'; const read = f.ports.store.readExact;
      f.ports.store.readExact = async request => {
        const raw = clone(await read(request));
        if (mode === 'store-ref') raw.proof.objectRef.objectVersion = 'other';
        if (mode === 'store-reader') raw.proof.readerId = 'other';
        if (mode === 'ciphertext') raw.object.envelope.tag = Buffer.alloc(16).toString('base64url');
        return raw;
      };
    }
    if (mode === 'plaintext') { phase = 'decrypt'; f.ports.kms.decryptArtifact = async () => Buffer.from('SENSITIVE other core').toString('base64url'); }
    if (mode.startsWith('nonce')) {
      phase = 'result-approval'; const read = f.ports.nonceStore.readExactNonceClaim;
      f.ports.nonceStore.readExactNonceClaim = async request => { const raw = clone(await read(request));
        if (mode === 'nonce-claim') raw.object.consumerId = 'other'; else raw.proof.readerId = 'other'; return raw; };
    }
    const count = consumes(f); await assert.rejects(f.create(f.ports).verifyExistingBundle(f.input),
      failure(phase, phase === 'result-approval' ? 'approval-failed' : 'invalid-evidence'));
    assert.equal(consumes(f), count, mode);
  }
});

test('historical observations use read-only roles and do not call encryption, sealing or nonce consumption', async () => {
  const f = await previouslyApproved(); const seen = [];
  for (const [port, method] of [['registry', 'readExactPolicy'], ['store', 'readExact'], ['kms', 'decryptArtifact'], ['clock', 'readTime'], ['nonceStore', 'readExactNonceClaim']]) {
    const read = f.ports[port][method]; f.ports[port][method] = request => { seen.push({ port, context: clone(request.context) }); return read(request); };
  }
  const before = f.calls.length; await f.create(f.ports).verifyExistingBundle(f.input);
  for (const { port, context } of seen) assert.equal(context.actorId, port === 'registry' ? 'registry-reader' : 'reader-a');
  const dispatched = f.calls.slice(before); for (const method of ['kms.encryptArtifact', 'store.sealEncryptedArtifact', 'nonceStore.consumeAuthorizationNonce']) {
    assert.equal(dispatched.includes(method), false, method);
  }
});

test('settled provider failures are redacted and require an explicit retry rather than a cached receipt', async () => {
  const f = await previouslyApproved(); const read = f.ports.registry.readExactPolicy; let unavailable = true;
  f.ports.registry.readExactPolicy = request => { if (unavailable) throw Error('SENSITIVE registry credential'); return read(request); };
  const verifier = f.create(f.ports); const count = consumes(f);
  await assert.rejects(verifier.verifyExistingBundle(f.input), failure('registry', 'operation-failed'));
  unavailable = false; const before = f.calls.length; await verifier.verifyExistingBundle(f.input);
  assert.ok(f.calls.slice(before).includes('registry.readExactPolicy')); assert.equal(consumes(f), count);
});

test('unknown store or claim completion halts the shared observer and late fulfillment cannot continue IO', async t => {
  for (const mode of ['store', 'nonce']) {
    const f = await previouslyApproved(); const entered = deferred(); const release = deferred(); let raw;
    const port = mode === 'store' ? 'store' : 'nonceStore'; const method = mode === 'store' ? 'readExact' : 'readExactNonceClaim';
    const read = f.ports[port][method];
    f.ports[port][method] = request => { raw = read(request); entered.resolve(); return release.promise; };
    f.options.operationTimeoutMs = 100; f.options.approvalOptions.operationTimeoutMs = 100;
    const verifier = f.create(f.ports); const pending = verifier.verifyExistingBundle(f.input);
    t.after(async () => { release.resolve(await raw); await pending.catch(() => {}); });
    const observed = assert.rejects(pending, failure(mode === 'store' ? 'store' : 'result-approval', mode === 'store' ? 'operation-timeout' : 'approval-failed', true));
    await entered.promise; const before = f.calls.length; await observed;
    release.resolve(await raw); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before);
    await assert.rejects(verifier.verifyExistingBundle(f.input), failure('preflight', 'halted'));
    await assert.rejects(verifier.verifyBundle(f.originalInput), failure('preflight', 'halted')); assert.equal(consumes(f), 2);
  }
});

test('both entry points share one busy lock and attempt budget, not separate bypass capacities', async t => {
  const f = await previouslyApproved(); const read = f.ports.registry.readExactPolicy; const entered = deferred(); const release = deferred();
  f.ports.registry.readExactPolicy = async request => { entered.resolve(); await release.promise; return read(request); };
  f.options.maxVerifications = 1; const verifier = f.create(f.ports); const pending = verifier.verifyExistingBundle(f.input);
  t.after(async () => { release.resolve(); await pending.catch(() => {}); }); await entered.promise; const before = f.calls.length;
  await assert.rejects(verifier.verifyExistingBundle(f.input), failure('preflight', 'busy'));
  await assert.rejects(verifier.verifyBundle(f.originalInput), failure('preflight', 'busy')); assert.equal(f.calls.length, before);
  release.resolve(); await pending;
  await assert.rejects(verifier.verifyExistingBundle(f.input), failure('preflight', 'attempt-capacity'));
  await assert.rejects(verifier.verifyBundle(f.originalInput), failure('preflight', 'attempt-capacity')); assert.equal(consumes(f), 2);
});

test('history, manifest, roots and captured methods cannot be replaced across the first await', async t => {
  const f = await previouslyApproved(); const read = f.ports.registry.readExactPolicy; const entered = deferred(); const release = deferred();
  f.ports.registry.readExactPolicy = async request => { entered.resolve(); await release.promise; return read(request); };
  const verifier = f.create(f.ports); const pending = verifier.verifyExistingBundle(f.input);
  t.after(async () => { release.resolve(); await pending.catch(() => {}); }); await entered.promise;
  f.input.resultApprovalProvenance.nonceClaimRef.objectVersion = 'other';
  f.input.resultApprovalProvenance.claimedClockReading.observedAt = times.expired;
  f.input.evidence.resultEnvelope.payload.nonce = 'e'.repeat(32); f.options.manifest.base.dataset.normalizedSha256 = hash('other');
  f.options.approvalOptions.keys.forEach(key => { key.revoked = true; }); let traps = 0;
  for (const [port, method] of [['nonceStore', 'readExactNonceClaim'], ['clock', 'readTime'], ['store', 'readExact']]) {
    Object.defineProperty(f.ports[port], method, { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
  }
  release.resolve(); const decision = await pending; assert.equal(decision.bundleDigest, hash(f.originalInput.bundle));
  assert.equal(traps, 0); assert.equal(consumes(f), 2);
});

test('getter/Proxy inputs and hostile readback thenables do not execute hooks or consume a nonce', async () => {
  for (const mode of ['input-getter', 'input-proxy', 'thenable', 'payload-getter', 'payload-proxy']) {
    const f = await previouslyApproved(); let input = f.input; let traps = 0;
    if (mode === 'input-getter') Object.defineProperty(input.resultApprovalProvenance, 'claimedClockReading', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'input-proxy') input = new Proxy(input, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'thenable') f.ports.nonceStore.readExactNonceClaim = () => ({ then() { traps++; } });
    if (mode.startsWith('payload')) {
      const read = f.ports.store.readExact;
      f.ports.store.readExact = async request => {
        const raw = clone(await read(request));
        if (mode === 'payload-getter') Object.defineProperty(raw, 'object', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
        return mode === 'payload-proxy' ? new Proxy(raw, { ownKeys() { traps++; throw Error('SENSITIVE'); } }) : raw;
      };
    }
    await assert.rejects(f.create(f.ports).verifyExistingBundle(input), error => error.productionAccepted === false && !error.message.includes('SENSITIVE'));
    assert.equal(traps, 0); assert.equal(consumes(f), 2);
  }
});

test('historical approval cannot extend current provider certificates, retention or turn a signed failed verdict into passed', async () => {
  for (const time of ['2026-10-09T04:03:00.000Z', '2026-10-10T04:00:00.000Z']) {
    const f = await previouslyApproved(); f.clock.advanceTo(time); const verifier = f.create(f.ports);
    await assert.rejects(verifier.verifyExistingBundle(f.input), failure('final-validation', 'invalid-evidence')); assert.equal(consumes(f), 2);
  }
  const f = await previouslyApproved('T16', true, { machineVerdict: 'failed' });
  const decision = await f.verifier.verifyExistingBundle(f.input);
  assert.equal(decision.machinePassed, false); assert.equal(decision.stageAcceptanceComplete, false); assert.equal(consumes(f), 2);
});

for (const mode of ['repeated-sequence', 'regressed-time']) {
  test(`switching from normal to historical cannot accept ${mode} across private approval cursors`, async () => {
    const f = await previouslyApproved('T16', true, { resultFinalTime: '2026-10-09T04:01:10.000Z' });
    const normalFinal = f.clockReadings.at(-1); let count = 0;
    f.setClockTransform(reading => ({ ...reading, sequence: normalFinal.sequence + ++count - (mode === 'repeated-sequence' ? 1 : 0),
      observedAt: mode === 'regressed-time' ? `2026-10-09T04:01:0${count + 4}.000Z` : normalFinal.observedAt }));
    await assert.rejects(f.verifier.verifyExistingBundle(f.input), failure('result-approval', 'approval-failed'));
    assert.equal(count, 1); assert.equal(consumes(f), 2);
  });
}

test('historical to normal clock regression is rejected before any result nonce consume attempt', async () => {
  const f = await previouslyApproved('T16', true, { resultFinalTime: '2026-10-09T04:01:10.000Z' });
  f.clock.advanceTo('2026-10-09T04:01:20.000Z'); await f.verifier.verifyExistingBundle(f.input);
  const historicalFinal = f.clockReadings.at(-1); let count = 0;
  f.setClockTransform(reading => ({ ...reading, sequence: historicalFinal.sequence + ++count, observedAt: '2026-10-09T04:01:15.000Z' }));
  await assert.rejects(f.verifier.verifyBundle(f.originalInput), failure('result-approval', 'approval-failed'));
  assert.equal(count, 1); assert.equal(consumes(f), 2);
});
