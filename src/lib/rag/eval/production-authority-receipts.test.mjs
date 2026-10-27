import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture as providerFixture } from './production-provider-fixtures.test-support.mjs';

const subject = await import('./production-authority-receipts.ts');
const receipts = await import('./production-receipts.ts');
const artifacts = await import('./production-controlled-artifacts.ts');
const journal = await import('./production-run-journal.ts');
const registry = await import('./production-provider-registry.ts');
const authority = await import('./production-authority-ports.ts');
const clone = value => structuredClone(value);
const ref = (name, digest = hash(name)) => ({ objectId: name, objectVersion: 'v1', sha256: digest });
const pairs = Object.fromEntries(['execution', 'result'].map(kind => [kind, generateKeyPairSync('ed25519')]));
const roles = { executionApproverId: 'approver-a', executorId: 'executor-a', readOnlyId: 'reader-a',
  resultAuthorityId: 'attestor-a', recoveryAuthorityId: null };
const times = { start: '2026-10-09T04:00:10.000Z', complete: '2026-10-09T04:00:20.000Z',
  seal: '2026-10-09T04:00:30.000Z', read: '2026-10-09T04:00:40.000Z',
  attest: '2026-10-09T04:00:45.000Z', created: '2026-10-09T04:00:50.000Z', now: '2026-10-09T04:01:00.000Z' };
function signed(kind, payload) {
  const schemaVersion = kind === 'execution' ? 'kg-execution-authorization-envelope/v1' : 'kg-result-attestation-envelope/v1';
  const signer = { algorithm: 'Ed25519', keyId: `${kind}-key`, keyVersion: 'v1' };
  return { schemaVersion, kind, payload: clone(payload), signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({
    signatureProfile: 'kg-production-authorization-signature/v1', schemaVersion, kind, payload, signer })), pairs[kind].privateKey).toString('base64url') } };
}
async function fixture(stage = 'T16', changes = {}) {
  const p = providerFixture(stage, changes.provider); const scope = p.request.scope;
  const binding = { ...scope, runNonce: p.request.runNonce, manifestHash: p.request.manifestHash };
  const participants = { ...roles, recoveryAuthorityId: stage === 'T17' ? 'rescuer-authority' : null };
  const executionPayload = { stage, scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash,
    authorizationId: 'execution-a', nonce: '1'.repeat(32), issuerId: roles.executionApproverId, participants,
    issuedAt: times.start, notBefore: times.start, expiresAt: changes.executionExpiresAt ?? '2026-10-09T05:00:00.000Z',
    operation: stage === 'T16' ? 'execute-t16-shadow' : stage === 'T17' ? 'execute-t17-canary' : 'verify-retention',
    registryRef: p.policyRef, providersHash: p.request.executionProvidersHash, thresholdsHash: hash('thresholds'),
    window: { startsAt: times.start, endsAt: changes.executionWindowEndsAt ?? changes.executionExpiresAt ?? '2026-10-09T05:00:00.000Z' } };
  const executionEnvelope = signed('execution', executionPayload); const executionRef = ref('execution-a', hash(executionEnvelope));
  const core = { schemaVersion: receipts.RECEIPT_CORE_SCHEMAS[stage], classification: 'confidential', stage, scope,
    runNonce: binding.runNonce, manifestHash: binding.manifestHash, executionAuthorizationRef: executionRef,
    recoveryAuthorizationRefs: [], predecessorAcceptanceRef: stage === 'T16' ? null : ref('previous-bundle'),
    identities: { datasetHash: hash('dataset'), rosterHash: hash('roster'), sharedConfigHash: hash('shared'),
      artifactsHash: hash('artifacts'), indexIdentityRef: ref('index-identity'), registryRef: p.policyRef,
      providersHash: p.request.executionProvidersHash, thresholdsHash: hash('thresholds'),
      armConfigHashes: stage === 'R18' ? null : { off: hash('off'), [stage === 'T16' ? 'shadow' : 'active']: hash('candidate') } },
    reportRef: ref('report'), artifactIndexRef: ref('artifact-index'), providerReadbackRefs: p.request.runtimeObjects.map(v => v.ref),
    journal: { headRef: ref('journal-head'), rootDigest: hash('placeholder'), entryCount: 3, fencingGeneration: 1, terminal: true },
    stageEvidence: stage === 'T16' ? { gateReportRef: ref('gate'), sideEffectReportRef: ref('effects'),
      offArmReadbackRef: ref('off-readback'), shadowArmReadbackRef: ref('shadow-readback') }
      : stage === 'T17' ? { preTrafficGateReportRef: ref('gate'), rampReportRef: ref('ramp'), faultReportRef: ref('fault'),
        recoveryReportRef: ref('recovery'), finalReadbackRef: ref('final'), finalPublicationIdentityRef: ref('publication'),
        terminalMode: 'off', terminalTrafficWeightBps: 0 } : { retentionPolicyHash: hash('retention-policy'), oldStoreManifestHash: hash('old-store'),
        elapsedEvidenceRef: ref('elapsed'), retentionReportRef: ref('retention-report') },
    executionIdentityId: roles.executorId, terminalActorId: roles.executorId, terminalAuthorizationDigest: executionRef.sha256,
    machineVerdict: changes.machineVerdict ?? 'passed', finalStateHash: hash('final-state'), startedAt: times.start, completedAt: times.complete, sealedAt: times.seal };
  const b = { ...binding, scopeHash: hash(scope) };
  const base = { schemaVersion: journal.JOURNAL_SCHEMA_VERSION, binding: b, kind: 'intent', seq: 1,
    prevDigest: journal.GENESIS_DIGEST, fencingGeneration: 1, idempotencyKey: 'read-a', actorId: roles.executorId,
    authorizationDigest: executionRef.sha256, action: 'readback', parametersDigest: hash('params'), beforeDigest: hash('before'),
    afterDigest: null, intentDigest: null, outcome: null, trustedTime: times.start };
  const intent = journal.createJournalEntry(base);
  const result = journal.createJournalEntry({ ...base, kind: 'result', seq: 2, prevDigest: intent.digest, intentDigest: intent.digest,
    afterDigest: hash('readback'), outcome: 'completed' });
  const terminal = journal.createJournalEntry({ ...base, kind: 'terminal', seq: 3, prevDigest: result.digest, beforeDigest: result.digest,
    idempotencyKey: 'terminal-a', action: 'seal-run', afterDigest: core.finalStateHash, outcome: core.machineVerdict, trustedTime: times.complete });
  const head = { schemaVersion: journal.JOURNAL_SCHEMA_VERSION, kind: 'head', binding: b, entryCount: 3,
    rootDigest: terminal.digest, fencingGeneration: 1, terminal: true };
  const readback = { head, entries: clone([intent, result, terminal]) };
  if (changes.journalMutator) changes.journalMutator(readback);
  // Recompute a completely consistent chain and seal/sign it, so negative
  // actor/action/digest tests exercise semantic authorization, not broken hash.
  for (let index = 0; index < readback.entries.length; index++) {
    const { digest: _digest, ...body } = readback.entries[index]; void _digest;
    body.seq = index + 1; body.prevDigest = index ? readback.entries[index - 1].digest : journal.GENESIS_DIGEST;
    if (body.kind === 'result') body.intentDigest = readback.entries[index - 1].digest;
    if (body.kind === 'terminal') body.beforeDigest = body.prevDigest;
    readback.entries[index] = journal.createJournalEntry(body);
  }
  head.entryCount = readback.entries.length; head.rootDigest = readback.entries.at(-1).digest;
  core.journal.rootDigest = head.rootDigest; core.journal.entryCount = head.entryCount; core.journal.headRef.sha256 = hash(head);
  const common = { executionProfile: 'local-reference', binding, actors: { executorId: roles.executorId, readOnlyId: roles.readOnlyId },
    validFrom: times.start, validUntil: '2026-10-09T05:00:00.000Z', maxObjects: 20 };
  const kms = artifacts.createReferenceKmsEnvelope({ ...common, keyPolicyRef: ref('key-policy'), maxPlaintextBytes: 65536 });
  const store = artifacts.createReferenceArtifactStore({ ...common, storeIdentityRef: ref('store'), maxObjectBytes: 262144 });
  const context = (actorId, observedAt) => ({ executionProfile: 'local-reference', binding, actorId, authorizationDigest: executionRef.sha256, observedAt });
  const seal = await receipts.sealReferenceReceiptCore({ executionProfile: 'local-reference', core, journalReadback: readback,
    executorContext: context(roles.executorId, times.seal), readerContext: context(roles.readOnlyId, times.read),
    artifactId: 'receipt-a', retainUntil: changes.retainUntil ?? '2026-10-10T04:00:00.000Z', expectedStoreIdentityRef: ref('store') }, kms, store);
  const resultEnvelope = signed('result', { stage, scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash,
    authorizationId: 'result-a', nonce: '2'.repeat(32), issuerId: roles.resultAuthorityId, participants,
    issuedAt: times.attest, notBefore: times.attest, expiresAt: '2026-10-09T04:10:00.000Z', operation: 'attest-stage-result',
    executionAuthorizationRef: executionRef, receiptCoreRef: seal.receiptCoreRef, reportHash: core.reportRef.sha256,
    artifactIndexHash: core.artifactIndexRef.sha256, machineVerdict: core.machineVerdict, executionIdentityId: roles.executorId,
    finalStateHash: core.finalStateHash, completedAt: core.completedAt });
  const bundle = { schemaVersion: receipts.ACCEPTANCE_BUNDLE_SCHEMA, classification: 'confidential', stage, scope,
    runNonce: binding.runNonce, manifestHash: binding.manifestHash, receiptCoreRef: seal.receiptCoreRef,
    receiptStorageRef: seal.storageObjectRef, resultAttestationRef: ref('result-a', hash(resultEnvelope)),
    readbackProofRef: ref('readback-proof', hash(seal.readbackProof)), createdAt: times.created };
  const approvalOptions = { executionProfile: 'local-reference', scope, actors: { verifierId: roles.executorId, readOnlyId: roles.readOnlyId },
    clockIdentityRef: ref('clock'), nonceStoreIdentityRef: ref('nonce-store'), maxClockUncertaintyMs: 1000,
    operationTimeoutMs: 1000, maxVerifications: 32, keys: ['execution', 'result'].map(kind => ({ keyId: `${kind}-key`, keyVersion: 'v1',
      issuerId: kind === 'execution' ? roles.executionApproverId : roles.resultAuthorityId, role: kind,
      publicKeySpki: pairs[kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      validFrom: '2026-10-09T03:00:00.000Z', validUntil: '2026-10-10T03:00:00.000Z', revoked: false })) };
  const clock = authority.createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [roles.executorId, roles.readOnlyId],
    sourceIdentityRef: ref('clock'), initialObservedAt: times.now, uncertaintyMs: changes.uncertaintyMs ?? 0, maxReadings: 1000, maxAdvanceMs: 86400000 });
  const nonceStore = authority.createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope,
    actors: { writerId: roles.executorId, readOnlyId: roles.readOnlyId }, storeIdentityRef: ref('nonce-store'), clockIdentityRef: ref('clock'),
    maxClaims: 100, maxClockUncertaintyMs: 1000 });
  const calls = []; const ports = { registry: registry.createReferenceProviderRegistry(p.registryConfig),
    journal: { executionProfile: 'local-reference', productionCapable: false, readHead: async () => clone(readback.head), readEntries: async () => clone(readback.entries) },
    kms, store, clock, nonceStore };
  for (const [name, methods] of [['registry', ['readExactPolicy']], ['journal', ['readHead', 'readEntries']],
    ['kms', ['decryptArtifact']], ['store', ['readExact']], ['clock', ['readTime']], ['nonceStore', ['consumeAuthorizationNonce', 'readExactNonceClaim']]]) {
    const original = ports[name]; ports[name] = { ...original };
    for (const method of methods) ports[name][method] = function(request) { calls.push(`${name}.${method}`); return original[method](request); };
  }
  const options = { executionProfile: 'local-reference', expectedExecutionPayload: executionPayload, executionAuthorizationRef: executionRef,
    providers: p.request.providers, expectedFencingGeneration: 1, registryOptions: { sourceIdentityRef: p.sourceIdentityRef,
      readerId: 'registry-reader', authorityKeys: p.options.authorityKeys }, storeIdentityRef: ref('store'), approvalOptions,
    operationTimeoutMs: 1000, maxVerifications: 32 };
  const input = { bundle, evidence: { core: clone(seal.core), executionEnvelope, resultEnvelope, readbackProof: seal.readbackProof },
    conformanceObjects: p.request.conformanceObjects, runtimeObjects: p.request.runtimeObjects };
  return { options, ports, input, calls, clock, readback, binding, core, seal };
}
const failure = (code, phase) => error => error instanceof subject.AuthorityReceiptError && error.code === code
  && (!phase || error.phase === phase) && error.productionAccepted === false && !error.message.includes('SENSITIVE');

test('actual registry, journal, encrypted store and result approval form a detached nonproduction observation', async () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = await fixture(stage); const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports);
    const decision = await verifier.verifyBundle(f.input);
    assert.equal(decision.validationLevel, 'local-reference-authority-readback'); assert.equal(decision.productionAccepted, false);
    assert.equal(decision.stageAcceptanceComplete, false); assert.equal(decision.signatureVerified, true); assert.equal(decision.machinePassed, true);
    assert.equal(decision.bundleDigest, hash(f.input.bundle)); assert.equal(decision.verifiedAt, times.now);
    const { decisionHash, ...preimage } = decision; assert.equal(decisionHash, hash(preimage));
    assert.equal(Object.isFrozen(decision), true);
    assert.deepEqual(f.calls, ['registry.readExactPolicy', 'journal.readHead', 'journal.readEntries', 'journal.readHead',
      'store.readExact', 'kms.decryptArtifact', 'clock.readTime', 'nonceStore.consumeAuthorizationNonce', 'nonceStore.readExactNonceClaim', 'clock.readTime']);
  }
});

test('unsigned, replaced or business-mismatched envelopes fail before any provider call', async () => {
  for (const edit of [f => { f.input.evidence.resultEnvelope.signature.value = Buffer.alloc(64).toString('base64url');
    f.input.bundle.resultAttestationRef.sha256 = hash(f.input.evidence.resultEnvelope); },
  f => { f.options.expectedExecutionPayload.thresholdsHash = hash('different'); },
  f => { f.input.evidence.core.scope.tenantId = 'other'; }, f => { f.input.extra = true; }]) {
    const f = await fixture(); edit(f);
    const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports);
    await assert.rejects(verifier.verifyBundle(f.input), failure('invalid-evidence', 'preflight')); assert.deepEqual(f.calls, []);
  }
});

test('provider certificate tampering fails before result nonce consumption', async () => {
  const f = await fixture(); f.input.runtimeObjects[0].attestation.body.instanceId = 'other';
  f.input.runtimeObjects[0].ref.sha256 = hash(f.input.runtimeObjects[0].attestation);
  const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports);
  await assert.rejects(verifier.verifyBundle(f.input), failure('invalid-evidence', 'registry')); assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false);
});

test('journal reads must have a stable independent head and a complete terminal chain', async () => {
  for (const mode of ['truncated', 'changed-head']) {
    const f = await fixture(); let heads = 0;
    if (mode === 'truncated') f.ports.journal.readEntries = async () => f.readback.entries.slice(0, -1);
    else f.ports.journal.readHead = async () => { const head = clone(f.readback.head); if (++heads > 1) head.fencingGeneration++; return head; };
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', 'journal'));
    assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false);
  }
});

test('actual encrypted object/proof and plaintext must match the exact sealed receipt', async () => {
  for (const mode of ['proof', 'object', 'plaintext']) {
    const f = await fixture(); const read = f.ports.store.readExact;
    if (mode === 'plaintext') f.ports.kms.decryptArtifact = async () => Buffer.from('SENSITIVE').toString('base64url');
    else f.ports.store.readExact = async request => { const result = clone(await read(request));
      if (mode === 'proof') result.proof.storeIdentityRef.objectVersion = 'other'; else result.object.aad.artifactId = 'other'; return result; };
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', mode === 'plaintext' ? 'decrypt' : 'store'));
    assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false);
  }
});

test('fresh final time revalidates signed provider certificates and halts after a consumed nonce on expiry', async () => {
  const f = await fixture(); f.clock.advanceTo('2026-10-09T04:04:00.000Z');
  const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports);
  await assert.rejects(verifier.verifyBundle(f.input), error => failure('invalid-evidence', 'final-validation')(error) && error.nonceOutcome === 'reported-consumed');
  await assert.rejects(verifier.verifyBundle(f.input), failure('halted'));
});

test('result approval replay cannot be treated as a cached successful acceptance', async () => {
  const f = await fixture(); const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports);
  await verifier.verifyBundle(f.input);
  await assert.rejects(verifier.verifyBundle(f.input), error => failure('approval-failed', 'result-approval')(error) && error.nonceOutcome === 'reported-not-consumed');
  assert.equal(f.calls.filter(value => value === 'registry.readExactPolicy').length, 2);
});

test('unknown provider completion is redacted and halts without later nonce consumption', async context => {
  const f = await fixture(); context.mock.method(performance, 'now', () => 0); f.options.operationTimeoutMs = 10;
  f.ports.store.readExact = () => new Promise(() => {});
  const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports);
  await assert.rejects(verifier.verifyBundle(f.input), error => failure('operation-timeout', 'store')(error) && error.pendingCompletionUnknown);
  await assert.rejects(verifier.verifyBundle(f.input), failure('halted')); assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false);
});

test('hostile fulfilled payload then accessors are not adopted by the receipt consumer', async () => {
  for (const phase of ['registry', 'journal', 'store', 'decrypt']) {
    const f = await fixture(); let traps = 0;
    const method = phase === 'registry' ? 'readExactPolicy' : phase === 'journal' ? 'readHead' : phase === 'store' ? 'readExact' : 'decryptArtifact';
    const port = phase === 'decrypt' ? 'kms' : phase;
    f.ports[port][method] = () => new Promise(resolve => { const value = {}; resolve(value);
      Object.defineProperty(value, 'then', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } }); });
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', phase));
    assert.equal(traps, 0);
  }
});

test('configuration and dependency getters/proxies cannot execute or claim enterprise capability', async () => {
  const f = await fixture(); let traps = 0;
  const hostile = new Proxy({}, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
  assert.throws(() => subject.createReferenceAuthorityReceiptVerifier(f.options, hostile), failure('invalid-config'));
  const options = clone(f.options); Object.defineProperty(options, 'providers', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
  assert.throws(() => subject.createReferenceAuthorityReceiptVerifier(options, f.ports), failure('invalid-config'));
  f.ports.store.productionCapable = true;
  assert.throws(() => subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports), failure('invalid-config'));
  assert.equal(traps, 0);
});

test('overlapping attempts are denied and complete valid attempts are capacity bounded', async () => {
  const f = await fixture(); f.options.maxVerifications = 1; const original = f.ports.registry.readExactPolicy;
  let release; const barrier = new Promise(resolve => { release = resolve; });
  f.ports.registry.readExactPolicy = request => barrier.then(() => original(request));
  const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports); const pending = verifier.verifyBundle(f.input);
  await assert.rejects(verifier.verifyBundle(f.input), failure('busy')); release(); await pending;
  await assert.rejects(verifier.verifyBundle(f.input), failure('attempt-capacity'));
});

test('request, roots and executable methods are captured before the first provider wait', async () => {
  const f = await fixture(); const original = f.ports.registry.readExactPolicy;
  let release; const barrier = new Promise(resolve => { release = resolve; }); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.ports.registry.readExactPolicy = request => { entered(); return barrier.then(() => original(request)); };
  const verifier = subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports); const pending = verifier.verifyBundle(f.input);
  await started; f.input.bundle.scope.tenantId = 'changed'; f.options.approvalOptions.keys[0].revoked = true;
  f.ports.kms.decryptArtifact = () => { throw Error('replacement'); }; release();
  const result = await pending; assert.equal(result.productionAccepted, false);
});

test('even a rehashed, sealed and signed journal cannot expand actor, authority digest or stage action', async () => {
  for (const [stage, edit] of [['T16', entries => { entries[0].actorId = 'intruder'; }],
    ['T16', entries => { entries[0].authorizationDigest = hash('unapproved'); }],
    ['T16', entries => { entries[0].action = entries[1].action = 'inject-fault'; }],
    ['R18', entries => { entries[0].action = entries[1].action = 'ask-off'; }]]) {
    const f = await fixture(stage, { journalMutator: readback => edit(readback.entries) });
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', 'journal'));
    assert.equal(f.calls.includes('nonceStore.consumeAuthorizationNonce'), false);
  }
});

test('complete journal readback above 256 KiB retains the bounded chain profile, not the object profile', async () => {
  const f = await fixture('T16', { journalMutator(readback) {
    const intent = readback.entries[0], result = readback.entries[1]; const extra = [];
    for (let index = 0; index < 200; index++) {
      extra.push({ ...intent, idempotencyKey: `extra-${index}` }, { ...result, idempotencyKey: `extra-${index}` });
    }
    readback.entries.splice(2, 0, ...extra);
  } });
  assert.ok(Buffer.byteLength(JSON.stringify(f.readback.entries)) > 262144);
  const decision = await subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input);
  assert.equal(decision.journalHeadHash, hash(f.readback.head)); assert.equal(decision.productionAccepted, false);
});

test('journal array and element accessors are rejected without traps or async adoption', async () => {
  for (const mode of ['then', 'element']) {
    const f = await fixture(); let traps = 0;
    f.ports.journal.readEntries = () => new Promise(resolve => { const entries = clone(f.readback.entries); resolve(entries);
      Object.defineProperty(entries, mode === 'then' ? 'then' : '0', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } }); });
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', 'journal'));
    assert.equal(traps, 0);
  }
});

test('full clock uncertainty, not nominal time, bounds provider and retention validity', async () => {
  const providerExpiry = await fixture('T16', { uncertaintyMs: 1000 }); providerExpiry.clock.advanceTo('2026-10-09T04:02:59.500Z');
  const retentionExpiry = await fixture('T16', { uncertaintyMs: 1000, retainUntil: '2026-10-09T04:01:00.500Z' });
  for (const f of [providerExpiry, retentionExpiry]) {
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input),
      error => failure('invalid-evidence', 'final-validation')(error) && error.nonceOutcome === 'reported-consumed');
  }
});

test('a signed failed verdict remains failed and never complete stage acceptance', async () => {
  const f = await fixture('T16', { machineVerdict: 'failed' });
  const decision = await subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input);
  assert.equal(decision.machinePassed, false); assert.equal(decision.stageAcceptanceComplete, false); assert.equal(decision.productionAccepted, false);
});

test('missing frozen recovery composition fails before source reads or nonce consumption', async () => {
  const f = await fixture('T17'); f.input.evidence.core.recoveryAuthorizationRefs.push(ref('recovery'));
  await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', 'preflight'));
  assert.deepEqual(f.calls, []);
});

test('sealed receipt mutations must remain inside live execution validity, not merely terminal validity', async () => {
  for (const changes of [{ executionExpiresAt: '2026-10-09T04:00:25.000Z', executionWindowEndsAt: '2026-10-09T05:00:00.000Z' },
    { executionExpiresAt: '2026-10-09T04:00:25.000Z', executionWindowEndsAt: '2026-10-09T04:00:25.000Z' },
    { executionExpiresAt: times.seal, executionWindowEndsAt: times.seal },
    { executionExpiresAt: times.seal, executionWindowEndsAt: '2026-10-09T05:00:00.000Z' }]) {
    // The fixture really signs, encrypts and seals the expired-label core;
    // independent acceptance must reject it rather than trust that writer.
    const f = await fixture('T16', changes);
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', 'preflight'));
    assert.deepEqual(f.calls, []);
  }
});

test('later-issued provider trust cannot retroactively qualify a run that already started or completed', async () => {
  for (const provider of [{ validFrom: '2026-10-09T04:00:25.000Z', issuedAt: '2026-10-09T04:00:25.000Z' },
    { issuedAt: '2026-10-09T04:00:25.000Z' }, { issuedAt: '2026-10-09T04:00:35.000Z' }]) {
    // Re-sign policy-bound certificates and execution, then really seal and
    // sign the dependent core/result: hashes and signatures all remain valid.
    const f = await fixture('T16', { provider });
    await assert.rejects(subject.createReferenceAuthorityReceiptVerifier(f.options, f.ports).verifyBundle(f.input), failure('invalid-evidence', 'registry'));
    assert.deepEqual(f.calls, ['registry.readExactPolicy']);
  }
});
