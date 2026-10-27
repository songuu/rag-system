import assert from 'node:assert/strict';
import test from 'node:test';
import './production-provider-fixtures.test-support.mjs';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture, clone, ref, times } from './production-receipt-fixtures.test-support.mjs';

const manifest = await import('./production-gate-manifest.ts');
const receipts = await import('./production-authority-receipts.ts');

test('manifest-bound receipt composition exposes real binding and consumption entry points', () => {
  assert.equal(typeof manifest.validateManifestExecutionBinding, 'function');
  assert.equal(typeof receipts.createReferenceManifestAuthorityReceiptWriter, 'function');
  assert.equal(typeof receipts.createReferenceManifestAuthorityReceiptVerifier, 'function');
});

function configured(stage = 'T16', changes = {}) {
  const f = fixture(stage, { manifestBound: true, includeResultKey: true, ...changes });
  const { expectedCoreIdentities: _identities, ...writerOptions } = f.options; void _identities;
  const { expectedCoreIdentities: _ids, artifactId: _id, retainUntil: _until, ...readerOptions } = f.options;
  void _ids; void _id; void _until;
  return { ...f, writerOptions: { ...writerOptions, manifest: f.manifest }, readerOptions: { ...readerOptions, manifest: f.manifest },
    bindingInput: { manifest: f.manifest, expectedExecutionPayload: f.options.expectedExecutionPayload, executionAuthorizationRef: f.executionRef } };
}
const bindingFailure = phase => error => error instanceof receipts.ManifestReceiptBindingError
  && error.phase === phase && error.productionAccepted === false && !error.message.includes('SENSITIVE');

test('all stages bind signed execution to an independent full manifest projection', () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = configured(stage); const binding = manifest.validateManifestExecutionBinding(f.bindingInput);
    assert.equal(binding.validationLevel, 'structural-only'); assert.equal(binding.productionAuthorized, false);
    assert.equal(binding.manifestHash, f.binding.manifestHash); assert.deepEqual(binding.identities, f.coreDraft.identities);
    assert.equal(binding.thresholdsProfile, 'kg-stage-thresholds/v1'); assert.equal(Object.isFrozen(binding.identities), true);
    assert.equal(binding.executionAuthorizationRef.sha256, hash(f.beginInput.executionEnvelope));
  }
});

test('actual signature, execution nonce, AEAD, manifest-aware readback and result nonce compose without claiming acceptance', async () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = configured(stage); const writer = receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports);
    await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    const seal = await writer.sealCore({ coreDraft: f.coreDraft }); assert.equal(seal.stageAcceptanceComplete, false);
    const verifier = receipts.createReferenceManifestAuthorityReceiptVerifier(f.readerOptions, f.ports);
    f.clock.advanceTo('2026-10-09T04:01:00.000Z'); const input = f.acceptanceInput(seal);
    const decision = await verifier.verifyBundle(input); assert.equal(decision.productionAccepted, false); assert.equal(decision.stageAcceptanceComplete, false);
    assert.equal(decision.receiptCoreDigest, hash(seal.core)); assert.equal(decision.machinePassed, true);
    assert.equal(f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length, 2);
    await assert.rejects(verifier.verifyBundle(input)); assert.equal(f.calls.filter(v => v === 'nonceStore.consumeAuthorizationNonce').length, 3);
  }
});

test('wrong manifest, thresholds, registry, run, scope and exact execution ref reject construction before IO', () => {
  for (const mode of ['manifest', 'thresholds', 'registry', 'run', 'scope', 'execution-version', 'providers', 'identities-label']) {
    const f = configured();
    if (mode === 'manifest') f.writerOptions.expectedExecutionPayload.manifestHash = hash('other');
    if (mode === 'thresholds') f.writerOptions.expectedExecutionPayload.thresholdsHash = hash('other');
    if (mode === 'registry') f.writerOptions.expectedExecutionPayload.registryRef = ref('other');
    if (mode === 'run') f.writerOptions.expectedExecutionPayload.runNonce = 'a'.repeat(32);
    if (mode === 'scope') f.writerOptions.expectedExecutionPayload.scope.tenantId = 'other';
    if (mode === 'execution-version') f.writerOptions.executionAuthorizationRef.objectVersion = 'v2';
    if (mode === 'providers') f.writerOptions.providers.bindings[0].configHash = hash('other');
    if (mode === 'identities-label') f.writerOptions.expectedCoreIdentities = clone(f.coreDraft.identities);
    assert.throws(() => receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports), bindingFailure('configuration'));
    assert.deepEqual(f.calls, []);
  }
});

test('T17 signed window and approval/executor/read-only/recovery roles must match the frozen manifest', () => {
  for (const mode of ['window', 'approver', 'executor', 'read-only', 'recovery']) {
    const f = configured('T17'); const expected = f.writerOptions.expectedExecutionPayload;
    if (mode === 'window') expected.window.endsAt = '2026-10-09T05:01:00.000Z';
    else expected.participants[{ approver: 'executionApproverId', executor: 'executorId', 'read-only': 'readOnlyId', recovery: 'recoveryAuthorityId' }[mode]] = 'other-actor';
    assert.throws(() => receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports), bindingFailure('configuration')); assert.deepEqual(f.calls, []);
  }
});

test('wrong derived core identities and predecessor/retention refs reject before sealing IO', async () => {
  for (const mode of ['dataset', 'roster', 'build', 'index-version', 'thresholds', 'arm', 'predecessor', 'retention-policy', 'old-store', 'elapsed']) {
    const stage = ['retention-policy', 'old-store', 'elapsed'].includes(mode) ? 'R18' : mode === 'predecessor' ? 'T17' : 'T16';
    const f = configured(stage); const writer = receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports);
    await writer.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    if (mode === 'dataset') f.coreDraft.identities.datasetHash = hash('other');
    if (mode === 'roster') f.coreDraft.identities.rosterHash = hash('other');
    if (mode === 'build') f.coreDraft.identities.artifactsHash = hash('other');
    if (mode === 'index-version') f.coreDraft.identities.indexIdentityRef.objectVersion = 'v2';
    if (mode === 'thresholds') f.coreDraft.identities.thresholdsHash = hash('other');
    if (mode === 'arm') f.coreDraft.identities.armConfigHashes.shadow = hash('other');
    if (mode === 'predecessor') f.coreDraft.predecessorAcceptanceRef.objectVersion = 'v2';
    if (mode === 'retention-policy') f.coreDraft.stageEvidence.retentionPolicyHash = hash('other');
    if (mode === 'old-store') f.coreDraft.stageEvidence.oldStoreManifestHash = hash('other');
    if (mode === 'elapsed') f.coreDraft.stageEvidence.elapsedEvidenceRef.objectVersion = 'v2';
    const before = f.calls.length; await assert.rejects(writer.sealCore({ coreDraft: f.coreDraft }), bindingFailure('seal-preflight'));
    assert.equal(f.calls.length, before);
  }
});

test('a genuinely encrypted, fully signed but manifest-mismatched core fails before result approval IO', async () => {
  for (const mode of ['dataset', 'predecessor', 'retention']) {
    const f = configured(mode === 'predecessor' ? 'T17' : mode === 'retention' ? 'R18' : 'T16');
    if (mode === 'dataset') { f.coreDraft.identities.datasetHash = hash('substituted-dataset'); f.options.expectedCoreIdentities = clone(f.coreDraft.identities); }
    if (mode === 'predecessor') f.coreDraft.predecessorAcceptanceRef = ref('substituted-predecessor');
    if (mode === 'retention') f.coreDraft.stageEvidence.retentionPolicyHash = hash('substituted-policy');
    const lowLevelWriter = receipts.createReferenceAuthorityReceiptWriter(f.options, f.ports);
    await lowLevelWriter.beginExecution(f.beginInput); f.recordRun(); f.clock.advanceTo(times.seal);
    const seal = await lowLevelWriter.sealCore({ coreDraft: f.coreDraft }); const input = f.acceptanceInput(seal);
    const verifier = receipts.createReferenceManifestAuthorityReceiptVerifier(f.readerOptions, f.ports); f.clock.advanceTo('2026-10-09T04:01:00.000Z');
    const before = f.calls.length; await assert.rejects(verifier.verifyBundle(input), bindingFailure('verify-preflight')); assert.equal(f.calls.length, before);
  }
});

test('malformed/fake views and getter/Proxy labels never replace a raw full manifest', () => {
  for (const mode of ['view', 'getter', 'proxy', 'missing', 'extra']) {
    const f = configured(); let traps = 0;
    if (mode === 'view') f.writerOptions.manifest = { validationLevel: 'structural-only', productionAuthorized: true, manifestHash: f.binding.manifestHash };
    if (mode === 'getter') Object.defineProperty(f.writerOptions, 'manifest', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'proxy') f.writerOptions.manifest = new Proxy(f.manifest, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'missing') delete f.writerOptions.manifest;
    if (mode === 'extra') f.writerOptions.productionAuthorized = true;
    assert.throws(() => receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports), bindingFailure('configuration'));
    assert.equal(traps, 0); assert.deepEqual(f.calls, []);
  }
});

test('stage-independent fields remain bound while deferred T17/Retention fields cannot block T16', async () => {
  const f = configured(); f.manifest.t17 = { deliberately: 'not-yet-planned' }; f.manifest.retention = null;
  const writer = receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports); await writer.beginExecution(f.beginInput);
  f.recordRun(); f.clock.advanceTo(times.seal); const seal = await writer.sealCore({ coreDraft: f.coreDraft }); assert.equal(seal.productionAccepted, false);
  const projection = manifest.validateManifestExecutionBinding(f.bindingInput);
  assert.equal(hash(projection.thresholds), f.options.expectedExecutionPayload.thresholdsHash);
  assert.equal(canonicalJson(projection.scope), canonicalJson(f.binding.environment ? { environment: f.binding.environment, tenantId: f.binding.tenantId, corpusId: f.binding.corpusId } : null));
});

test('manifest and request aliases cannot change frozen expectations across a provider await', async () => {
  const f = configured(); let entered; let release; let pause = true; const entry = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; }); const readHead = f.ports.journal.readHead;
  f.ports.journal.readHead = async () => { if (pause) { pause = false; entered(); await barrier; } return readHead(); };
  const writer = receipts.createReferenceManifestAuthorityReceiptWriter(f.writerOptions, f.ports); const begin = writer.beginExecution(f.beginInput); await entry;
  f.manifest.base.dataset.normalizedSha256 = hash('after-call'); f.writerOptions.manifest = {};
  release(); await begin; f.recordRun(); f.clock.advanceTo(times.seal); const seal = await writer.sealCore({ coreDraft: f.coreDraft });
  assert.equal(seal.core.identities.datasetHash, f.options.expectedCoreIdentities.datasetHash);
});
