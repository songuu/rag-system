import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture as providerFixture } from './production-provider-fixtures.test-support.mjs';
import { manifest as manifestFixture } from './production-manifest-fixtures.test-support.mjs';

const receipts = await import('./production-receipts.ts');
const artifacts = await import('./production-controlled-artifacts.ts');
const journal = await import('./production-run-journal.ts');
const registry = await import('./production-provider-registry.ts');
const authority = await import('./production-authority-ports.ts');
const gate = await import('./production-gate-manifest.ts');
const pair = generateKeyPairSync('ed25519');
const resultPair = generateKeyPairSync('ed25519');
const clone = value => structuredClone(value);
const ref = (name, digest = hash(name)) => ({ objectId: name, objectVersion: 'v1', sha256: digest });
const roles = { executionApproverId: 'approver-a', executorId: 'executor-a', readOnlyId: 'reader-a',
  resultAuthorityId: 'attestor-a', recoveryAuthorityId: null };
const times = { begin: '2026-10-09T04:00:10.000Z', start: '2026-10-09T04:00:11.000Z',
  complete: '2026-10-09T04:00:20.000Z', seal: '2026-10-09T04:00:30.000Z', expired: '2026-10-09T05:00:00.000Z' };
function fixture(stage = 'T16', changes = {}) {
  let p = providerFixture(stage); const scope = p.request.scope;
  const participants = { ...roles, recoveryAuthorityId: stage === 'T17' ? 'rescuer-a' : null };
  const manifest = changes.manifestBound ? manifestFixture(stage) : null;
  const policy = manifest ? manifest[stage === 'T16' ? 't16' : stage === 'T17' ? 't17' : 'retention'] : null;
  let view;
  if (manifest) {
    manifest.base.providers = clone(p.request.providers);
    if (stage === 'T17') {
      Object.assign(policy.window, { startsAt: times.begin, endsAt: times.expired, approverId: participants.executionApproverId,
        executorId: participants.executorId, readOnlyId: participants.readOnlyId });
      policy.recoveryPolicy.authorityId = participants.recoveryAuthorityId;
      const { policyHash: _hash, ...unsigned } = policy.recoveryPolicy; void _hash;
      policy.recoveryPolicy.policyHash = hash(unsigned);
    }
    view = (stage === 'T16' ? gate.validateForT16 : stage === 'T17' ? gate.validateForT17 : gate.validateForRetention)(manifest);
    p = providerFixture(stage, { manifestHash: view.manifestHash });
  }
  const binding = { ...scope, runNonce: p.request.runNonce, manifestHash: p.request.manifestHash };
  // Independent fixture oracle: do not ask the binding implementation under
  // test to calculate the expected authorization/core projection.
  const thresholds = manifest ? { schemaVersion: 'kg-stage-thresholds/v1', stage, hardGates: manifest.base.hardGates,
    quality: policy.quality ?? null, sampling: policy.sampling ?? null,
    sideEffectPolicy: policy.sideEffectPolicy ?? null, rampAbort: policy.rampPlan?.abort ?? null,
    retentionPolicy: stage === 'R18' ? policy.frozenRetention.policy : null } : null;
  const payload = { stage, scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash,
    authorizationId: 'execution-a', nonce: '1'.repeat(32), issuerId: roles.executionApproverId, participants,
    issuedAt: times.begin, notBefore: times.begin, expiresAt: times.expired,
    operation: stage === 'T16' ? 'execute-t16-shadow' : stage === 'T17' ? 'execute-t17-canary' : 'verify-retention',
    registryRef: p.policyRef, providersHash: p.request.executionProvidersHash, thresholdsHash: thresholds ? hash(thresholds) : hash('thresholds'),
    window: { startsAt: times.begin, endsAt: times.expired } };
  const signer = { algorithm: 'Ed25519', keyId: 'execution-key', keyVersion: 'v1' };
  const executionEnvelope = { schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload: clone(payload),
    signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1',
      schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload, signer })), pair.privateKey).toString('base64url') } };
  const executionRef = ref('execution-a', hash(executionEnvelope));
  if (policy) policy.executionAuthorizationRef = clone(executionRef);
  const identities = manifest ? { datasetHash: manifest.base.dataset.normalizedSha256, rosterHash: manifest.base.dataset.rosterSha256,
    sharedConfigHash: manifest.base.sharedConfigHash, artifactsHash: hash(manifest.base.artifacts), indexIdentityRef: clone(manifest.base.indexIdentity.publicationIdentityRef),
    registryRef: p.policyRef, providersHash: payload.providersHash, thresholdsHash: payload.thresholdsHash,
    armConfigHashes: stage === 'R18' ? null : Object.fromEntries(Object.entries(policy.arms).map(([name, arm]) => [name, arm.armConfigHash])) }
    : { datasetHash: hash('dataset'), rosterHash: hash('roster'), sharedConfigHash: hash('shared'),
    artifactsHash: hash('artifacts'), indexIdentityRef: ref('index-identity'), registryRef: p.policyRef,
    providersHash: payload.providersHash, thresholdsHash: payload.thresholdsHash,
    armConfigHashes: stage === 'R18' ? null : { off: hash('off'), [stage === 'T16' ? 'shadow' : 'active']: hash('candidate') } };
  const coreDraft = { schemaVersion: receipts.RECEIPT_CORE_SCHEMAS[stage], classification: 'confidential', stage, scope,
    runNonce: binding.runNonce, manifestHash: binding.manifestHash, executionAuthorizationRef: executionRef,
    recoveryAuthorizationRefs: [], predecessorAcceptanceRef: stage === 'T16' ? null : policy ? clone(policy.predecessor.acceptanceBundleRef) : ref('previous'), identities,
    reportRef: ref('report'), artifactIndexRef: ref('artifact-index'), providerReadbackRefs: p.request.runtimeObjects.map(v => v.ref),
    journal: { headRef: ref('journal-head'), rootDigest: hash('placeholder'), entryCount: 3, fencingGeneration: 1, terminal: true },
    stageEvidence: stage === 'T16' ? { gateReportRef: ref('gate'), sideEffectReportRef: ref('effects'), offArmReadbackRef: ref('off'), shadowArmReadbackRef: ref('shadow') }
      : stage === 'T17' ? { preTrafficGateReportRef: ref('gate'), rampReportRef: ref('ramp'), faultReportRef: ref('fault'),
        recoveryReportRef: ref('recovery'), finalReadbackRef: ref('final'), finalPublicationIdentityRef: ref('publication'), terminalMode: 'off', terminalTrafficWeightBps: 0 }
        : { retentionPolicyHash: hash('retention'), oldStoreManifestHash: hash('old-store'), elapsedEvidenceRef: ref('elapsed'), retentionReportRef: ref('retention-report') },
    executionIdentityId: roles.executorId, terminalActorId: roles.executorId, terminalAuthorizationDigest: executionRef.sha256,
    machineVerdict: changes.machineVerdict ?? 'passed', finalStateHash: hash('final-state'), startedAt: times.start, completedAt: times.complete };
  if (manifest && stage === 'R18') Object.assign(coreDraft.stageEvidence, { retentionPolicyHash: policy.frozenRetention.policyHash,
    oldStoreManifestHash: policy.frozenRetention.oldStoreManifestHash, elapsedEvidenceRef: clone(policy.elapsedEvidenceRef) });
  const journalBinding = { ...binding, scopeHash: hash(scope) };
  const readback = { head: { schemaVersion: journal.JOURNAL_SCHEMA_VERSION, kind: 'head', binding: journalBinding,
    entryCount: 0, rootDigest: journal.GENESIS_DIGEST, fencingGeneration: 1, terminal: false }, entries: [] };
  function recordRun(edit) {
    const base = { schemaVersion: journal.JOURNAL_SCHEMA_VERSION, binding: journalBinding, kind: 'intent', seq: 1,
      prevDigest: journal.GENESIS_DIGEST, fencingGeneration: 1, idempotencyKey: 'read-a', actorId: roles.executorId,
      authorizationDigest: executionRef.sha256, action: 'readback', parametersDigest: hash('params'), beforeDigest: hash('before'),
      afterDigest: null, intentDigest: null, outcome: null, trustedTime: times.start };
    const bodies = [base, { ...base, kind: 'result', seq: 2, intentDigest: hash('placeholder'), afterDigest: hash('read'), outcome: 'completed' },
      { ...base, kind: 'terminal', seq: 3, idempotencyKey: 'terminal-a', action: 'seal-run', afterDigest: coreDraft.finalStateHash,
        outcome: coreDraft.machineVerdict, trustedTime: times.complete }];
    if (edit) edit(bodies);
    readback.entries = bodies.map((body, index) => {
      body.prevDigest = index ? readback.entries[index - 1].digest : journal.GENESIS_DIGEST;
      if (body.kind === 'result') body.intentDigest = readback.entries[index - 1].digest;
      if (body.kind === 'terminal') body.beforeDigest = body.prevDigest;
      const entry = journal.createJournalEntry(body); readback.entries[index] = entry; return entry;
    });
    readback.head = { ...readback.head, entryCount: readback.entries.length, rootDigest: readback.entries.at(-1).digest, terminal: true };
    coreDraft.journal = { ...coreDraft.journal, rootDigest: readback.head.rootDigest, entryCount: readback.head.entryCount, headRef: ref('journal-head', hash(readback.head)) };
  }
  const common = { executionProfile: 'local-reference', binding, actors: { executorId: roles.executorId, readOnlyId: roles.readOnlyId },
    validFrom: times.begin, validUntil: times.expired, maxObjects: 20 };
  const kms = artifacts.createReferenceKmsEnvelope({ ...common, keyPolicyRef: ref('key-policy'), maxPlaintextBytes: 65536 });
  const store = artifacts.createReferenceArtifactStore({ ...common, storeIdentityRef: ref('store'), maxObjectBytes: 262144 });
  const clock = authority.createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [roles.executorId, roles.readOnlyId],
    sourceIdentityRef: ref('clock'), initialObservedAt: times.begin, uncertaintyMs: changes.uncertaintyMs ?? 0, maxReadings: 1000, maxAdvanceMs: 86400000 });
  const nonceStore = authority.createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope,
    actors: { writerId: roles.executorId, readOnlyId: roles.readOnlyId }, storeIdentityRef: ref('nonce-store'), clockIdentityRef: ref('clock'), maxClaims: 100, maxClockUncertaintyMs: 1000 });
  const approvalOptions = { executionProfile: 'local-reference', scope, actors: { verifierId: roles.executorId, readOnlyId: roles.readOnlyId },
    clockIdentityRef: ref('clock'), nonceStoreIdentityRef: ref('nonce-store'), maxClockUncertaintyMs: 1000,
    operationTimeoutMs: 1000, maxVerifications: 32, keys: [{ ...signer, issuerId: roles.executionApproverId, role: 'execution',
      publicKeySpki: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      validFrom: '2026-10-09T03:00:00.000Z', validUntil: '2026-10-10T03:00:00.000Z', revoked: false }] };
  delete approvalOptions.keys[0].algorithm;
  if (changes.includeResultKey) approvalOptions.keys.push({ keyId: 'result-key', keyVersion: 'v1', issuerId: roles.resultAuthorityId, role: 'result',
    publicKeySpki: resultPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom: '2026-10-09T03:00:00.000Z', validUntil: '2026-10-10T03:00:00.000Z', revoked: false });
  const calls = []; const ports = { registry: registry.createReferenceProviderRegistry({ ...p.registryConfig, maxReads: 256 }),
    journal: { executionProfile: 'local-reference', productionCapable: false, readHead: async () => clone(readback.head), readEntries: async () => clone(readback.entries) }, kms, store, clock, nonceStore };
  for (const [name, methods] of [['registry', ['readExactPolicy']], ['journal', ['readHead', 'readEntries']], ['kms', ['encryptArtifact', 'decryptArtifact']],
    ['store', ['sealEncryptedArtifact', 'readExact']], ['clock', ['readTime']], ['nonceStore', ['consumeAuthorizationNonce', 'readExactNonceClaim']]]) {
    const original = ports[name]; ports[name] = { ...original };
    for (const method of methods) ports[name][method] = request => { calls.push(`${name}.${method}`); return original[method](request); };
  }
  const options = { executionProfile: 'local-reference', expectedExecutionPayload: payload, executionAuthorizationRef: executionRef,
    providers: p.request.providers, expectedFencingGeneration: 1, registryOptions: { sourceIdentityRef: p.sourceIdentityRef, readerId: 'registry-reader', authorityKeys: p.options.authorityKeys },
    storeIdentityRef: ref('store'), approvalOptions, operationTimeoutMs: 1000, maxVerifications: 32,
    expectedCoreIdentities: clone(identities), artifactId: 'receipt-a', retainUntil: '2026-10-10T04:00:00.000Z' };
  const beginInput = { executionEnvelope, conformanceObjects: p.request.conformanceObjects, runtimeObjects: p.request.runtimeObjects };
  function acceptanceInput(seal) {
    const payload = { stage, scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash,
      authorizationId: 'result-a', nonce: '2'.repeat(32), issuerId: roles.resultAuthorityId, participants,
      issuedAt: '2026-10-09T04:00:40.000Z', notBefore: '2026-10-09T04:00:40.000Z', expiresAt: times.expired,
      operation: 'attest-stage-result', executionAuthorizationRef: executionRef, receiptCoreRef: seal.receiptCoreRef,
      reportHash: seal.core.reportRef.sha256, artifactIndexHash: seal.core.artifactIndexRef.sha256,
      machineVerdict: seal.core.machineVerdict, executionIdentityId: roles.executorId, finalStateHash: seal.core.finalStateHash, completedAt: seal.core.completedAt };
    const signer = { algorithm: 'Ed25519', keyId: 'result-key', keyVersion: 'v1' };
    const resultEnvelope = { schemaVersion: 'kg-result-attestation-envelope/v1', kind: 'result', payload,
      signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1',
        schemaVersion: 'kg-result-attestation-envelope/v1', kind: 'result', payload, signer })), resultPair.privateKey).toString('base64url') } };
    return { bundle: { schemaVersion: receipts.ACCEPTANCE_BUNDLE_SCHEMA, classification: 'confidential', stage, scope,
      runNonce: binding.runNonce, manifestHash: binding.manifestHash, receiptCoreRef: seal.receiptCoreRef, receiptStorageRef: seal.storageObjectRef,
      resultAttestationRef: ref('result-a', hash(resultEnvelope)), readbackProofRef: ref('readback-proof', hash(seal.readbackProof)), createdAt: '2026-10-09T04:00:50.000Z' },
    evidence: { core: clone(seal.core), executionEnvelope: clone(executionEnvelope), resultEnvelope, readbackProof: seal.readbackProof },
    conformanceObjects: clone(beginInput.conformanceObjects), runtimeObjects: clone(beginInput.runtimeObjects) };
  }
  return { options, ports, calls, clock, nonceStore, coreDraft, readback, recordRun, beginInput, store, kms, binding, executionRef, manifest, acceptanceInput };
}
export { fixture, clone, ref, roles, times };
