import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { canonicalJsonSha256 as hash } from './canonical-json.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const receipts = await import('./production-receipts.ts');
const journal = await import('./production-run-journal.ts');
const artifacts = await import('./production-controlled-artifacts.ts');
const clone = value => structuredClone(value);
const scope = { environment: 'local-test', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const binding = { ...scope, runNonce: '0123456789abcdef0123456789abcdef', manifestHash: hash('manifest') };
const ref = (id, digest = hash(id)) => ({ objectId: id, objectVersion: 'v1', sha256: digest });
const roles = { executionApproverId: 'approver-a', executorId: 'executor-a', readOnlyId: 'reader-a',
  resultAuthorityId: 'attestor-a', recoveryAuthorityId: null };
const times = { start: '2026-10-09T05:00:00.000Z', complete: '2026-10-09T05:00:01.000Z',
  seal: '2026-10-09T05:00:02.000Z', read: '2026-10-09T05:00:03.000Z', attest: '2026-10-09T05:00:04.000Z' };
const signature = { algorithm: 'Ed25519', keyId: 'synthetic-key', keyVersion: 'v1', value: Buffer.alloc(64).toString('base64url') };
function execution(stage = 'T16') {
  return { schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', signature,
    payload: { stage, scope: clone(scope), runNonce: binding.runNonce, manifestHash: binding.manifestHash,
      authorizationId: 'execution-a', nonce: '1'.repeat(32), issuerId: roles.executionApproverId,
      participants: { ...roles, recoveryAuthorityId: stage === 'T17' ? 'recovery-a' : null },
      issuedAt: times.start, notBefore: times.start, expiresAt: '2026-10-09T06:00:00.000Z',
      operation: stage === 'T16' ? 'execute-t16-shadow' : stage === 'T17' ? 'execute-t17-canary' : 'verify-retention',
      registryRef: ref('registry'), providersHash: hash('providers'), thresholdsHash: hash('thresholds'),
      window: { startsAt: times.start, endsAt: '2026-10-09T06:00:00.000Z' } } };
}
function coreInput(stage = 'T16') {
  const executionRef = ref('execution-a', hash(execution(stage)));
  return { schemaVersion: stage === 'T16' ? 'kg-t16-shadow-receipt-core/v1'
    : stage === 'T17' ? 'kg-t17-canary-receipt-core/v1' : 'kg-retention-receipt-core/v1',
    classification: 'confidential', stage, scope: clone(scope), runNonce: binding.runNonce,
    manifestHash: binding.manifestHash, executionAuthorizationRef: executionRef, recoveryAuthorizationRefs: [],
    predecessorAcceptanceRef: stage === 'T16' ? null : ref('previous-bundle'),
    identities: { datasetHash: hash('dataset'), rosterHash: hash('roster'), sharedConfigHash: hash('shared'),
      artifactsHash: hash('artifacts'), indexIdentityRef: ref('index-identity'), registryRef: ref('registry'),
      providersHash: hash('providers'), thresholdsHash: hash('thresholds'),
      armConfigHashes: stage === 'R18' ? null : { off: hash('off'), [stage === 'T16' ? 'shadow' : 'active']: hash('candidate') } },
    reportRef: ref('report'), artifactIndexRef: ref('artifact-index'), providerReadbackRefs: [ref('runtime-readback')],
    journal: { headRef: ref('journal-head'), rootDigest: hash('terminal'), entryCount: 3,
      fencingGeneration: 1, terminal: true },
    stageEvidence: stage === 'T16' ? { gateReportRef: ref('gate'), sideEffectReportRef: ref('effects'),
      offArmReadbackRef: ref('off-readback'), shadowArmReadbackRef: ref('shadow-readback') }
      : stage === 'T17' ? { preTrafficGateReportRef: ref('gate'), rampReportRef: ref('ramp'),
        faultReportRef: ref('fault'), recoveryReportRef: ref('recovery'), finalReadbackRef: ref('final'),
        finalPublicationIdentityRef: ref('stable-publication'), terminalMode: 'off', terminalTrafficWeightBps: 0 }
        : { retentionPolicyHash: hash('frozen-retention'), oldStoreManifestHash: hash('old-store'),
          elapsedEvidenceRef: ref('elapsed'), retentionReportRef: ref('retention-report') },
    executionIdentityId: roles.executorId, terminalActorId: roles.executorId,
    terminalAuthorizationDigest: executionRef.sha256, machineVerdict: 'passed', finalStateHash: hash('final-state'),
    startedAt: times.start, completedAt: times.complete, sealedAt: times.seal };
}
function journalReadback(core) {
  const b = { ...scope, scopeHash: hash(scope), runNonce: core.runNonce, manifestHash: core.manifestHash };
  const body = { schemaVersion: journal.JOURNAL_SCHEMA_VERSION, binding: b, kind: 'intent', seq: 1,
    prevDigest: journal.GENESIS_DIGEST, fencingGeneration: 1, idempotencyKey: 'read-a',
    actorId: core.executionIdentityId, authorizationDigest: core.executionAuthorizationRef.sha256,
    action: 'readback', parametersDigest: hash('params'), beforeDigest: hash('before'),
    afterDigest: null, intentDigest: null, outcome: null, trustedTime: times.start };
  const intent = journal.createJournalEntry(body);
  const result = journal.createJournalEntry({ ...body, kind: 'result', seq: 2, prevDigest: intent.digest,
    intentDigest: intent.digest, afterDigest: hash('readback'), outcome: 'completed' });
  const terminal = journal.createJournalEntry({ ...body, kind: 'terminal', seq: 3, prevDigest: result.digest,
    beforeDigest: result.digest,
    idempotencyKey: 'terminal-a', actorId: core.terminalActorId, authorizationDigest: core.terminalAuthorizationDigest,
    action: 'seal-run', afterDigest: core.finalStateHash, outcome: core.machineVerdict, trustedTime: core.completedAt });
  const head = { schemaVersion: journal.JOURNAL_SCHEMA_VERSION, kind: 'head', binding: b,
    entryCount: 3, rootDigest: terminal.digest, fencingGeneration: 1, terminal: true };
  core.journal.rootDigest = terminal.digest; core.journal.headRef.sha256 = hash(head);
  return { entries: [intent, result, terminal], head };
}
const context = (actorId, observedAt) => ({ executionProfile: 'local-reference', binding: clone(binding),
  actorId, authorizationDigest: hash(execution()), observedAt });
function ports() {
  const common = { executionProfile: 'local-reference', binding: clone(binding),
    actors: { executorId: roles.executorId, readOnlyId: roles.readOnlyId }, validFrom: times.start,
    validUntil: '2026-10-09T06:00:00.000Z', maxObjects: 10 };
  return { kms: artifacts.createReferenceKmsEnvelope({ ...common, keyPolicyRef: ref('key-policy'), maxPlaintextBytes: 65536 }),
    store: artifacts.createReferenceArtifactStore({ ...common, storeIdentityRef: ref('store'), maxObjectBytes: 262144 }) };
}
function prepared(stage = 'T16') {
  const core = coreInput(stage); const readback = journalReadback(core);
  return receipts.createReceiptCore(core, readback);
}
async function sealed(overrides = {}, dependencies = ports(), operationTimeoutMs) {
  const core = coreInput(); const readback = journalReadback(core);
  return receipts.sealReferenceReceiptCore({ executionProfile: 'local-reference', core, journalReadback: readback,
    executorContext: context(roles.executorId, times.seal), readerContext: context(roles.readOnlyId, times.read),
    artifactId: 'receipt-a', retainUntil: '2026-10-10T05:00:00.000Z', expectedStoreIdentityRef: ref('store'),
    ...overrides }, dependencies.kms, dependencies.store, operationTimeoutMs);
}
function attestation(seal) {
  return { schemaVersion: 'kg-result-attestation-envelope/v1', kind: 'result', signature,
    payload: { stage: 'T16', scope: clone(scope), runNonce: binding.runNonce, manifestHash: binding.manifestHash,
      authorizationId: 'result-a', nonce: '2'.repeat(32), issuerId: roles.resultAuthorityId, participants: clone(roles),
      issuedAt: times.attest, notBefore: times.attest, expiresAt: '2026-10-09T05:10:00.000Z',
      operation: 'attest-stage-result', executionAuthorizationRef: seal.core.executionAuthorizationRef,
      receiptCoreRef: seal.receiptCoreRef, reportHash: seal.core.reportRef.sha256,
      artifactIndexHash: seal.core.artifactIndexRef.sha256, machineVerdict: seal.core.machineVerdict,
      executionIdentityId: seal.core.executionIdentityId, finalStateHash: seal.core.finalStateHash,
      completedAt: seal.core.completedAt } };
}
async function bundleFixture(sealInput) {
  const seal = sealInput ?? await sealed(); const result = attestation(seal);
  const bundle = { schemaVersion: 'kg-stage-acceptance-bundle/v1', classification: 'confidential',
    stage: 'T16', scope: clone(scope), runNonce: binding.runNonce, manifestHash: binding.manifestHash,
    receiptCoreRef: seal.receiptCoreRef, receiptStorageRef: seal.storageObjectRef,
    resultAttestationRef: ref('result-a', hash(result)), readbackProofRef: ref('readback-proof', hash(seal.readbackProof)),
    createdAt: '2026-10-09T05:00:05.000Z' };
  return { bundle, evidence: { core: seal.core, executionEnvelope: execution(), resultEnvelope: result,
    readbackProof: seal.readbackProof } };
}

test('stage-specific immutable receipt cores are confidential structural views, not acceptance', () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const view = prepared(stage); assert.equal(view.core.stage, stage);
    assert.equal(view.coreDigest, hash(view.core)); assert.equal(view.productionAccepted, false);
    assert.equal(view.validationLevel, 'structural-only'); assert.equal(Object.isFrozen(view.core.identities), true);
  }
});
test('core disallows result/bundle/self references, inline content, missing or wrong-stage fields', () => {
  const base = coreInput(); const readback = journalReadback(base);
  for (const mutation of [value => { value.resultAttestationRef = ref('result'); },
    value => { value.receiptCoreRef = ref('self'); }, value => { value.answer = 'raw-content'; },
    value => { value.predecessorAcceptanceRef = ref('unexpected'); }, value => { value.recoveryAuthorizationRefs = [ref('recovery')]; },
    value => { value.stageEvidence.terminalMode = 'active'; }, value => { value.journal.terminal = false; }]) {
    const input = clone(base); mutation(input); assert.throws(() => receipts.createReceiptCore(input, readback), /receipt/);
  }
  const canary = coreInput('T17'); canary.stageEvidence.terminalMode = 'active';
  assert.throws(() => receipts.validateReceiptCore(canary), /receipt/);
});
test('core requires terminal full journal chain, exact head, final digest/outcome/time/actor/authorization', () => {
  const input = coreInput(); const readback = journalReadback(input);
  for (const field of ['rootDigest', 'entryCount', 'fencingGeneration']) {
    const changed = clone(input); changed.journal[field] = field === 'rootDigest' ? hash('wrong') : 2;
    assert.throws(() => receipts.createReceiptCore(changed, readback), /receipt/);
  }
  for (const mutation of [value => { value.finalStateHash = hash('wrong'); },
    value => { value.machineVerdict = 'failed'; }, value => { value.terminalActorId = 'wrong'; },
    value => { value.completedAt = times.seal; }, value => { value.journal.headRef.sha256 = hash('wrong'); }]) {
    const changed = clone(input); mutation(changed); assert.throws(() => receipts.createReceiptCore(changed, readback), /receipt/);
  }
  const truncated = clone(readback); truncated.entries.pop();
  assert.throws(() => receipts.createReceiptCore(input, truncated), /journal|receipt/);
});
test('core data is detached, bounded and does not execute getters/proxies or print content', () => {
  const input = coreInput(); const readback = journalReadback(input); const view = receipts.createReceiptCore(input, readback);
  input.scope.tenantId = 'changed'; assert.equal(view.core.scope.tenantId, 'tenant-a'); let count = 0;
  assert.throws(() => receipts.validateReceiptCore(new Proxy({}, { ownKeys() { count += 1; return []; } })));
  assert.throws(() => receipts.validateReceiptCore({ get stage() { count += 1; return 'T16'; } }));
  assert.equal(count, 0);
  assert.throws(() => receipts.validateReceiptCore({ ...view.core, answer: 'sensitive-marker' }), error => !error.message.includes('sensitive-marker'));
});
test('reference seal performs actual encryption, exclusive save, independent exact readback and decrypt', async () => {
  const seal = await sealed(); assert.equal(seal.productionAccepted, false);
  assert.equal(seal.validationLevel, 'local-reference-readback');
  assert.equal(seal.receiptCoreRef.sha256, hash(seal.core));
  assert.notEqual(seal.storageObjectRef.sha256, seal.receiptCoreRef.sha256);
  assert.equal(seal.receiptCoreRef.objectId, seal.storageObjectRef.objectId);
  assert.equal(seal.receiptCoreRef.objectVersion, seal.storageObjectRef.objectVersion);
  assert.deepEqual(seal.readbackProof.storageObjectRef, seal.storageObjectRef);
  assert.equal(seal.readbackProof.productionTamperResistant, false);
  assert.equal(Object.isFrozen(seal.readbackProof), true);
});
test('reference seal rejects profile/context/role/run mismatches before any operation', async () => {
  let count = 0; const base = ports(); const spy = { ...base.kms, async encryptArtifact() { count += 1; throw new Error('called'); } };
  for (const override of [{ executionProfile: 'enterprise' },
    { executorContext: context('other', times.seal) }, { readerContext: context(roles.executorId, times.read) },
    { readerContext: { ...context(roles.readOnlyId, times.read), binding: { ...binding, corpusId: 'other' } } },
    { executorContext: context(roles.executorId, times.start) }]) {
    await assert.rejects(sealed(override, { ...base, kms: spy }), /receipt/);
  }
  assert.equal(count, 0);
  await assert.rejects(sealed({}, { ...base, kms: { ...base.kms, executionProfile: 'enterprise', productionCapable: true } }), /receipt/);
});
test('tampered store object/version/digest/reader proof fails and never becomes a core readback', async () => {
  for (const mutate of [value => { value.object.aad.artifactId = 'swapped'; },
    value => { value.proof.objectRef.objectVersion = 'swapped'; }, value => { value.proof.readerId = 'executor-a'; },
    value => { value.proof.storeIdentityRef = ref('unapproved-store'); },
    value => { value.proof.productionTamperResistant = true; }]) {
    const base = ports(); const store = { ...base.store, async readExact(request) {
      const value = clone(await base.store.readExact(request)); mutate(value); return value;
    } };
    await assert.rejects(sealed({}, { ...base, store }), /receipt/);
  }
});
test('wrong decrypt output cannot be accepted even if all store metadata/digests match', async () => {
  const base = ports(); const kms = { ...base.kms, async decryptArtifact() { return Buffer.from('wrong-core').toString('base64url'); } };
  await assert.rejects(sealed({}, { ...base, kms }), /plaintext readback/);
});
test('acceptance bundle contains only forward exact refs and matches complete noncircular evidence', async () => {
  const { bundle, evidence } = await bundleFixture();
  const view = receipts.validateAcceptanceBundle(bundle, evidence);
  assert.equal(view.bundleDigest, hash(bundle)); assert.equal(view.productionAccepted, false);
  assert.equal(view.validationLevel, 'structural-only'); assert.equal(view.machinePassed, true);
  // Deliberately unsigned fixture: schema matching must never claim signature verification.
  assert.equal('signatureVerified' in view, false); assert.equal('stageAccepted' in view, false);
});
test('bundle rejects missing/foreign result, pre-run result substitute and exact ref/digest/version swaps', async () => {
  const { bundle, evidence } = await bundleFixture();
  for (const mutation of [value => { value.resultEnvelope = execution(); },
    value => { value.resultEnvelope.payload.reportHash = hash('wrong'); },
    value => { value.resultEnvelope.payload.receiptCoreRef.objectVersion = 'wrong'; },
    value => { value.resultEnvelope.payload.runNonce = '0'.repeat(32); },
    value => { value.resultEnvelope.payload.participants.executorId = 'wrong'; },
    value => { value.executionEnvelope.payload.providersHash = hash('wrong'); }]) {
    const changed = clone(evidence); mutation(changed);
    assert.throws(() => receipts.validateAcceptanceBundle(bundle, changed), /receipt|authorization/);
  }
  for (const mutation of [value => { value.receiptCoreRef.sha256 = value.receiptStorageRef.sha256; },
    value => { value.receiptStorageRef.objectVersion = 'wrong'; },
    value => { value.readbackProofRef.sha256 = hash('wrong'); }, value => { value.stage = 'T17'; },
    value => { value.core = evidence.core; }, value => { value.bundleRef = ref('self'); }]) {
    const changed = clone(bundle); mutation(changed);
    assert.throws(() => receipts.validateAcceptanceBundle(changed, evidence), /receipt/);
  }
});
test('result signing time cannot precede independent readback or completed/core sealing time', async () => {
  const { bundle, evidence } = await bundleFixture();
  const changed = clone(evidence); changed.resultEnvelope.payload.issuedAt = times.seal;
  changed.resultEnvelope.payload.notBefore = times.seal;
  const matching = { ...bundle, resultAttestationRef: ref('result-a', hash(changed.resultEnvelope)) };
  assert.throws(() => receipts.validateAcceptanceBundle(matching, changed), /readback/);
});

test('provider exceptions are redacted at every seal operation boundary', async () => {
  for (const operation of ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact']) {
    const base = ports(); const target = ['encryptArtifact', 'decryptArtifact'].includes(operation) ? 'kms' : 'store';
    const dependencies = { ...base, [target]: { ...base[target], async [operation]() { throw new Error('sensitive-provider-marker'); } } };
    await assert.rejects(sealed({}, dependencies), error => {
      assert.match(error.message, /receipt/); assert.equal(error.message.includes('sensitive-provider-marker'), false); return true;
    });
  }
});

test('receipt seal bounded pending operations stop the pipeline and expose unknown completion', async t => {
  // Pin elapsed dispatch to isolate pending phase; real elapsed coverage lives
  // in bounded-provider-call.test.mjs. This does not lengthen the 20 ms timer.
  t.mock.method(performance, 'now', () => 0);
  const methods = ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact'];
  for (const [ordinal, method] of methods.entries()) {
    const base = ports(); const dependencies = { kms: { ...base.kms }, store: { ...base.store } };
    const calls = []; let lateCompleted; const lateDone = new Promise(resolve => { lateCompleted = resolve; });
    for (const name of methods) {
      const target = ['encryptArtifact', 'decryptArtifact'].includes(name) ? 'kms' : 'store';
      dependencies[target][name] = request => {
        calls.push(name);
        if (name !== method) return base[target][name](request);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            base[target][name](request).then(value => { resolve(value); lateCompleted(); }, error => {
              reject(error); lateCompleted();
            });
          }, 35);
        });
      };
    }
    await assert.rejects(sealed({}, dependencies, 20), error => {
      assert.equal(error.name, 'ReferenceReceiptSealError'); assert.equal(error.code, 'operation-timeout');
      assert.equal(error.operation, ['encrypt', 'store-seal', 'store-read', 'decrypt'][ordinal]);
      assert.equal(error.pendingCompletionUnknown, true); assert.equal(error.mutationMayHaveOccurred, true);
      assert.equal(error.automaticRetryAllowed, false); assert.equal('cause' in error, false); return true;
    });
    await lateDone;
    assert.deepEqual(calls, methods.slice(0, ordinal + 1));
  }
});

test('receipt seal bounded settled deadline overrun cannot proceed to store', async t => {
  let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  const base = ports(); let stores = 0;
  const kms = { ...base.kms, encryptArtifact(request) {
    const pending = base.kms.encryptArtifact(request); elapsed = 20; return pending;
  } };
  const store = { ...base.store, sealEncryptedArtifact(request) { stores += 1; return base.store.sealEncryptedArtifact(request); } };
  await assert.rejects(sealed({}, { kms, store }, 20), error => {
    assert.equal(error.code, 'operation-timeout'); assert.equal(error.pendingCompletionUnknown, false);
    assert.equal(error.mutationMayHaveOccurred, true); return true;
  });
  assert.equal(stores, 0);
});

test('receipt seal bounded thenable carriers are never adopted or retried', async () => {
  const base = ports(); let thenCalls = 0; let stores = 0;
  const kms = { ...base.kms, encryptArtifact(request) {
    return { then(resolve, reject) { thenCalls += 1; base.kms.encryptArtifact(request).then(resolve, reject); } };
  } };
  const store = { ...base.store, sealEncryptedArtifact(request) { stores += 1; return base.store.sealEncryptedArtifact(request); } };
  await assert.rejects(sealed({}, { kms, store }, 1000), error => {
    assert.equal(error.code, 'provider-contract-invalid'); assert.equal(error.pendingCompletionUnknown, true);
    assert.equal(error.automaticRetryAllowed, false); return true;
  });
  assert.equal(thenCalls, 0); assert.equal(stores, 0);
});

test('receipt seal bounded fulfilled payloads are detached before async return adoption', async () => {
  for (const method of ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact']) {
    const samplePorts = ports(); const sample = await sealed({}, samplePorts);
    const stored = await samplePorts.store.readExact({ context: context(roles.readOnlyId, times.read), ref: sample.storageObjectRef });
    // A completed sample has advanced its monotonic port clock to read time;
    // the separate attempt must not reuse it with an earlier executor label.
    const base = ports();
    const payload = method === 'encryptArtifact' ? clone(stored.object.envelope)
      : method === 'sealEncryptedArtifact' ? clone(sample.storageObjectRef)
      : method === 'readExact' ? clone(stored) : new String('synthetic-plaintext');
    // The native promise is already fulfilled before the hostile field exists.
    const pending = Promise.resolve(payload); let getters = 0;
    Object.defineProperty(payload, 'then', { enumerable: true, get() {
      getters += 1; throw new Error('sensitive-payload-adoption-marker');
    } });
    const target = ['encryptArtifact', 'decryptArtifact'].includes(method) ? 'kms' : 'store';
    const dependencies = { ...base, [target]: { ...base[target], [method]() { return pending; } } };
    await assert.rejects(sealed({ artifactId: 'receipt-b' }, dependencies, 1000), error => {
      assert.equal(error.code, 'provider-payload-invalid'); assert.equal(error.pendingCompletionUnknown, false);
      assert.equal(error.message.includes('sensitive-payload-adoption-marker'), false);
      assert.equal('cause' in error, false); return true;
    });
    assert.equal(getters, 0);
  }
});

test('receipt seal bounded budgets reject invalid values before provider dispatch', async () => {
  const base = ports(); let calls = 0;
  const kms = { ...base.kms, encryptArtifact(request) { calls += 1; return base.kms.encryptArtifact(request); } };
  for (const budget of [null, 0, -1, 60001, 1.5, Infinity, NaN, '20', {}, Symbol('invalid')]) {
    await assert.rejects(sealed({}, { ...base, kms }, budget), /operationTimeoutMs/);
  }
  assert.equal(calls, 0);
});

test('receipt seal bounded malformed native promise metadata is unknown without getter execution', async () => {
  const base = ports(); let getters = 0; let stores = 0;
  const kms = { ...base.kms, encryptArtifact(request) {
    const pending = base.kms.encryptArtifact(request);
    Object.defineProperty(pending, 'constructor', { get() { getters += 1; throw new Error('sensitive-constructor-marker'); } });
    return pending;
  } };
  const store = { ...base.store, sealEncryptedArtifact(request) { stores += 1; return base.store.sealEncryptedArtifact(request); } };
  await assert.rejects(sealed({}, { kms, store }, 1000), error => {
    assert.equal(error.code, 'provider-contract-invalid'); assert.equal(error.pendingCompletionUnknown, true);
    assert.equal(error.message.includes('sensitive-constructor-marker'), false); return true;
  });
  assert.equal(getters, 0); assert.equal(stores, 0);
});

test('receipt seal bounded explicit budgets preserve exact local encryption and independent readback', async () => {
  const seal = await sealed({}, ports(), 1000);
  assert.equal(seal.productionAccepted, false); assert.equal(seal.receiptCoreRef.sha256, hash(seal.core));
  assert.equal(seal.readbackProof.storeProof.readerId, roles.readOnlyId);
});

test('receipt seal bounded dispatch starvation performs no mutation and reports known non-dispatch', async t => {
  let readings = 0; t.mock.method(performance, 'now', () => ++readings === 1 ? 0 : 20);
  const base = ports(); let calls = 0;
  const kms = { ...base.kms, encryptArtifact(request) { calls += 1; return base.kms.encryptArtifact(request); } };
  await assert.rejects(sealed({}, { ...base, kms }, 20), error => {
    assert.equal(error.code, 'operation-timeout'); assert.equal(error.pendingCompletionUnknown, false);
    assert.equal(error.mutationMayHaveOccurred, false); assert.equal(error.automaticRetryAllowed, false); return true;
  });
  assert.equal(calls, 0);
});

test('receipt seal bounded semantic payload failures preserve actually committed mutation diagnostics', async () => {
  const methods = ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact'];
  for (const target of ['sealed-ref', 'aad', 'read-object', 'read-proof', 'plaintext']) {
    const base = ports(); const dependencies = { kms: { ...base.kms }, store: { ...base.store } };
    const calls = []; let actualStorageRef;
    const failedOperation = target === 'aad' ? 'encrypt' : target === 'sealed-ref' ? 'store-seal'
      : target === 'plaintext' ? 'decrypt' : 'store-read';
    for (const method of methods) {
      const owner = ['encryptArtifact', 'decryptArtifact'].includes(method) ? 'kms' : 'store';
      dependencies[owner][method] = async request => {
        calls.push(method); const returned = await base[owner][method](request);
        if (method === 'sealEncryptedArtifact') {
          actualStorageRef = returned;
          const actual = await base.store.readExact({ context: context(roles.readOnlyId, times.read), ref: returned });
          assert.equal(hash(actual.object), returned.sha256);
        }
        if (target === 'aad' && method === 'encryptArtifact') return { ...returned, aadSha256: hash('another-aad') };
        if (target === 'sealed-ref' && method === 'sealEncryptedArtifact') return { ...returned, sha256: hash('another-object') };
        if (method === 'readExact' && ['read-object', 'read-proof'].includes(target)) {
          const changed = clone(returned);
          if (target === 'read-object') changed.object.aad.ordinal = 1;
          else changed.proof.readerId = 'unapproved-reader';
          return changed;
        }
        if (target === 'plaintext' && method === 'decryptArtifact') return Buffer.from('another-core').toString('base64url');
        return returned;
      };
    }
    await assert.rejects(sealed({}, dependencies, 1000), error => {
      assert.equal(error.name, 'ReferenceReceiptSealError'); assert.equal(error.code, 'provider-payload-invalid');
      assert.equal(error.operation, failedOperation); assert.equal(error.pendingCompletionUnknown, false);
      assert.equal(error.mutationMayHaveOccurred, true); assert.equal(error.automaticRetryAllowed, false);
      assert.equal('cause' in error, false); return true;
    });
    const last = target === 'aad' ? 0 : target === 'sealed-ref' ? 1 : target === 'plaintext' ? 3 : 2;
    assert.deepEqual(calls, methods.slice(0, last + 1));
    if (actualStorageRef) {
      const actual = await base.store.readExact({ context: context(roles.readOnlyId, times.read), ref: actualStorageRef });
      assert.equal(hash(actual.object), actualStorageRef.sha256);
      // Failure never overwrites/deletes a real committed object or retries it.
      assert.deepEqual(calls, methods.slice(0, last + 1));
    }
  }
});

test('seal cannot bypass full journal validation by passing a merely schema-valid core', async () => {
  const core = clone(prepared().core); core.journal.rootDigest = hash('forged-terminal');
  core.journal.headRef.sha256 = hash('forged-head'); let calls = 0; const base = ports();
  const kms = { ...base.kms, async encryptArtifact(request) { calls += 1; return base.kms.encryptArtifact(request); } };
  await assert.rejects(sealed({ core }, { ...base, kms }), /receipt|journal/);
  assert.equal(calls, 0);
});

test('full journal over 256 KiB is validated and sealed without using small-object JSON limit', async () => {
  const core = coreInput(); const original = journalReadback(core); const template = clone(original.entries[0]);
  delete template.digest; const entries = []; let previous = journal.GENESIS_DIGEST;
  for (let index = 0; index < 180; index += 1) {
    const intent = journal.createJournalEntry({ ...template, seq: entries.length + 1, prevDigest: previous,
      idempotencyKey: `read-${index}`, trustedTime: new Date(Date.parse(times.start) + index * 2).toISOString() });
    const result = journal.createJournalEntry({ ...template, kind: 'result', seq: entries.length + 2,
      prevDigest: intent.digest, idempotencyKey: `read-${index}`, intentDigest: intent.digest,
      afterDigest: hash('readback'), outcome: 'completed',
      trustedTime: new Date(Date.parse(times.start) + index * 2 + 1).toISOString() });
    entries.push(intent, result); previous = result.digest;
  }
  const terminal = journal.createJournalEntry({ ...template, kind: 'terminal', seq: entries.length + 1,
    prevDigest: previous, beforeDigest: previous, idempotencyKey: 'terminal-a', action: 'seal-run',
    afterDigest: core.finalStateHash, outcome: core.machineVerdict, trustedTime: core.completedAt });
  entries.push(terminal); const head = { ...original.head, entryCount: entries.length, rootDigest: terminal.digest };
  core.journal.entryCount = entries.length; core.journal.rootDigest = terminal.digest; core.journal.headRef.sha256 = hash(head);
  const readback = { entries, head }; assert.ok(Buffer.byteLength(JSON.stringify(readback)) > 256 * 1024);
  const seal = await sealed({ core, journalReadback: readback }); assert.equal(seal.core.journal.entryCount, 361);
});

test('fully rehashed result cannot substitute core report/verdict/scope/duties claims', async () => {
  const { bundle, evidence } = await bundleFixture();
  for (const mutation of [value => { value.reportHash = hash('wrong-report'); },
    value => { value.machineVerdict = 'failed'; }, value => { value.scope.corpusId = 'other'; },
    value => { value.participants.executorId = 'other-executor'; value.executionIdentityId = 'other-executor'; }]) {
    const altered = clone(evidence); mutation(altered.resultEnvelope.payload);
    const rebound = { ...bundle, resultAttestationRef: ref('result-a', hash(altered.resultEnvelope)) };
    assert.throws(() => receipts.validateAcceptanceBundle(rebound, altered), /claims|scope|duties/);
  }
});

test('failed and aborted receipt bundles preserve machine failure and never claim stage acceptance', async () => {
  for (const machineVerdict of ['failed', 'aborted']) {
    const core = coreInput(); core.machineVerdict = machineVerdict; const readback = journalReadback(core);
    const seal = await sealed({ core, journalReadback: readback }); const { bundle, evidence } = await bundleFixture(seal);
    const view = receipts.validateAcceptanceBundle(bundle, evidence);
    assert.equal(view.machinePassed, false); assert.equal(view.productionAccepted, false);
    assert.equal('stageAccepted' in view, false);
  }
});

test('seal dependency and request proxies/getters cannot execute before validation', async () => {
  const core = coreInput(); const readback = journalReadback(core); const base = ports(); let executed = 0;
  const input = { executionProfile: 'local-reference', core, journalReadback: readback,
    executorContext: context(roles.executorId, times.seal), readerContext: context(roles.readOnlyId, times.read),
    artifactId: 'receipt-a', retainUntil: '2026-10-10T05:00:00.000Z', expectedStoreIdentityRef: ref('store') };
  const proxy = new Proxy(input, { ownKeys() { executed += 1; return []; } });
  await assert.rejects(receipts.sealReferenceReceiptCore(proxy, base.kms, base.store), /receipt/);
  const getter = { ...input, get journalReadback() { executed += 1; return readback; } };
  await assert.rejects(receipts.sealReferenceReceiptCore(getter, base.kms, base.store), /receipt/);
  const kms = { ...base.kms, get executionProfile() { executed += 1; return 'local-reference'; } };
  await assert.rejects(receipts.sealReferenceReceiptCore(input, kms, base.store), /receipt/);
  assert.equal(executed, 0);
});

test('provider cannot rebase expected AAD through an encrypt callback mutation', async () => {
  const base = ports(); const kms = { ...base.kms, async encryptArtifact(request) {
    request.aad.ordinal = 1; return base.kms.encryptArtifact(request);
  } };
  await assert.rejects(sealed({}, { ...base, kms }), /receipt/);
});

test('provider cannot move executor/readback context beyond prechecked retention', async () => {
  for (const actor of ['executor', 'reader']) {
    const base = ports();
    const kms = { ...base.kms, async encryptArtifact(request) {
      request.context.observedAt = times.read; return base.kms.encryptArtifact(request);
    } };
    const store = { ...base.store, async readExact(request) {
      request.context.observedAt = '2026-10-09T05:30:00.000Z'; return base.store.readExact(request);
    } };
    await assert.rejects(sealed({ retainUntil: '2026-10-09T05:00:04.000Z' },
      actor === 'executor' ? { ...base, kms } : { ...base, store }), /receipt/);
  }
});

test('encrypt callback cannot replace the already validated decrypt capability with an echo', async () => {
  const base = ports(); const kms = { ...base.kms, async encryptArtifact(request) {
    const envelope = clone(await base.kms.encryptArtifact(request));
    const tag = Buffer.from(envelope.tag, 'base64url'); tag[0] ^= 1; envelope.tag = tag.toString('base64url');
    kms.decryptArtifact = async () => request.plaintextBase64url;
    return envelope;
  } };
  await assert.rejects(sealed({}, { ...base, kms }), /receipt/);
});

test('incompatible core object roles cannot alias even after all digests are rehashed', () => {
  for (const mutation of [core => { core.artifactIndexRef = clone(core.reportRef); },
    core => { core.reportRef = clone(core.executionAuthorizationRef); },
    core => { core.providerReadbackRefs[0] = clone(core.stageEvidence.gateReportRef); },
    core => { core.stageEvidence.offArmReadbackRef = clone(core.stageEvidence.shadowArmReadbackRef); },
    core => { core.artifactIndexRef = { ...core.reportRef, sha256: hash('different-content') }; }]) {
    const core = coreInput(); mutation(core);
    assert.throws(() => receipts.validateReceiptCore(core), /role|alias/);
  }
});

test('a recovery ref alone cannot extend an expired execution terminal or claim rescue acceptance', async () => {
  const core = coreInput('T17'); core.recoveryAuthorizationRefs = [ref('unverified-recovery')];
  core.startedAt = '2026-10-09T05:59:00.000Z'; core.completedAt = '2026-10-09T06:10:00.000Z';
  core.sealedAt = '2026-10-09T06:10:01.000Z';
  const coreRef = ref('canary-core', hash(core)); const storageRef = ref('canary-core', hash('ciphertext'));
  const proof = { schemaVersion: 'kg-receipt-readback-proof/v1', assurance: 'local-reference',
    productionTamperResistant: false, receiptCoreRef: coreRef, storageObjectRef: storageRef,
    observedAt: '2026-10-09T06:10:02.000Z', storeProof: { assurance: 'local-reference',
      productionTamperResistant: false, storeIdentityRef: ref('store'), objectRef: storageRef,
      lockMode: 'local-reference-immutable', retainUntil: '2026-10-10T05:00:00.000Z',
      readerId: roles.readOnlyId, observedAt: '2026-10-09T06:10:02.000Z' } };
  const result = attestation({ core, receiptCoreRef: coreRef }); result.payload.stage = 'T17';
  result.payload.participants = clone(execution('T17').payload.participants);
  result.payload.issuedAt = result.payload.notBefore = '2026-10-09T06:10:03.000Z';
  result.payload.expiresAt = '2026-10-09T06:20:00.000Z';
  const bundle = { schemaVersion: 'kg-stage-acceptance-bundle/v1', classification: 'confidential', stage: 'T17',
    scope: clone(scope), runNonce: binding.runNonce, manifestHash: binding.manifestHash,
    receiptCoreRef: coreRef, receiptStorageRef: storageRef, resultAttestationRef: ref('result-a', hash(result)),
    readbackProofRef: ref('readback-proof', hash(proof)), createdAt: '2026-10-09T06:10:04.000Z' };
  const evidence = { core, executionEnvelope: execution('T17'), resultEnvelope: result, readbackProof: proof };
  assert.throws(() => receipts.validateAcceptanceBundle(bundle, evidence), /recovery|window/);
  // Even a terminal actor claiming the ref is not an authenticated recovery chain.
  core.terminalActorId = 'rescuer-a'; core.terminalAuthorizationDigest = core.recoveryAuthorizationRefs[0].sha256;
  bundle.receiptCoreRef.sha256 = hash(core); proof.receiptCoreRef.sha256 = hash(core);
  result.payload.receiptCoreRef.sha256 = hash(core); bundle.resultAttestationRef.sha256 = hash(result);
  bundle.readbackProofRef.sha256 = hash(proof);
  assert.throws(() => receipts.validateAcceptanceBundle(bundle, evidence), /recovery/);
});

test('rehashed result notBefore must be effective when constructing the bundle', async () => {
  const { bundle, evidence } = await bundleFixture();
  evidence.resultEnvelope.payload.notBefore = '2026-10-09T05:06:00.000Z';
  bundle.resultAttestationRef.sha256 = hash(evidence.resultEnvelope);
  assert.throws(() => receipts.validateAcceptanceBundle(bundle, evidence), /result/);
});

test('only exact same-role PublicationIdentity reuse is allowed inside a canary core', () => {
  const core = coreInput('T17'); core.stageEvidence.finalPublicationIdentityRef = clone(core.identities.indexIdentityRef);
  assert.equal(receipts.validateReceiptCore(core).productionAccepted, false);
  core.stageEvidence.finalPublicationIdentityRef.sha256 = hash('other-publication');
  assert.throws(() => receipts.validateReceiptCore(core), /alias/);
});

test('all callback request contexts and authenticated objects stay deeply frozen', async () => {
  const base = ports(); const operations = [];
  const inspect = (operation, request) => {
    operations.push(operation);
    for (const value of [request, request.context, request.context.binding, request.aad, request.envelope, request.ref]) {
      if (value !== undefined) assert.equal(Object.isFrozen(value), true, operation);
    }
  };
  const kms = { ...base.kms,
    async encryptArtifact(request) { inspect('encrypt', request); return base.kms.encryptArtifact(request); },
    async decryptArtifact(request) { inspect('decrypt', request); return base.kms.decryptArtifact(request); } };
  const store = { ...base.store,
    async sealEncryptedArtifact(request) { inspect('seal', request); return base.store.sealEncryptedArtifact(request); },
    async readExact(request) { inspect('read', request); return base.store.readExact(request); } };
  assert.equal((await sealed({}, { kms, store })).productionAccepted, false);
  assert.deepEqual(operations, ['encrypt', 'seal', 'read', 'decrypt']);
});

test('capability capture never reads function bind/length/name getters', async () => {
  const base = ports(); let getters = 0;
  const encryptArtifact = async request => base.kms.encryptArtifact(request);
  for (const field of ['bind', 'length', 'name']) Object.defineProperty(encryptArtifact, field, {
    configurable: true, get() { getters += 1; throw new Error('sensitive-function-getter-marker'); },
  });
  const seal = await sealed({}, { ...base, kms: { ...base.kms, encryptArtifact } });
  assert.equal(seal.productionAccepted, false); assert.equal(getters, 0);
});

test('callable Proxy methods are rejected without executing any trap', async () => {
  const base = ports(); let traps = 0;
  const encryptArtifact = new Proxy(async request => base.kms.encryptArtifact(request), {
    get() { traps += 1; throw new Error('sensitive-function-proxy-marker'); },
    apply() { traps += 1; throw new Error('sensitive-function-proxy-marker'); },
  });
  await assert.rejects(sealed({}, { ...base, kms: { ...base.kms, encryptArtifact } }), error => {
    assert.match(error.message, /receipt/); assert.equal(error.message.includes('sensitive-function-proxy-marker'), false); return true;
  });
  assert.equal(traps, 0);
});
