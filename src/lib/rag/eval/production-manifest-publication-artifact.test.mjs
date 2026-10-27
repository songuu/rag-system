import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { waitForProviderEntry } from './production-provider-entry.test-support.mjs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });
const { canonicalJson, canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { manifest: manifestFixture, arm } = await import('./production-manifest-fixtures.test-support.mjs');
const { createReferenceAuthorityClock } = await import('./production-authority-ports.ts');
const { createReferenceKmsEnvelope, createReferenceArtifactStore, validateControlledArtifactIndex } = await import('./production-controlled-artifacts.ts');
const { createReferencePublicationSources, createReferencePublicationReadback } = await import('../../knowledge-graph/publication-identity.ts');
const { createReferencePublicationArtifactWriter, PublicationArtifactError } = await import('./production-publication-artifact.ts');
const { validateManifestExecutionBinding } = await import('./production-gate-manifest.ts');
let subject;
try { subject = await import('./production-manifest-publication-artifact.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = (name, digest = hash(name)) => ({ objectId: name, objectVersion: 'v1', sha256: digest });
const pair = generateKeyPairSync('ed25519');
const contentHash = value => createHash('sha256').update(value).digest('hex');
const chunkManifest = rows => hash([...rows].sort((a, b) => a.chunk_index - b.chunk_index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map(row => ({ chunkId: row.id, chunkIndex: row.chunk_index, contentSha256: contentHash(row.content) })));
const policyName = stage => ({ T16: 't16', T17: 't17', R18: 'retention' })[stage];
const commonConfig = base => ({ artifacts: base.artifacts, models: base.models, indexIdentity: base.indexIdentity, parameters: base.parameters });

// This fixture derives hashes from the complete raw manifest, independently of
// either writer or the binding validator. Its Ed25519 signature is synthetic.
function refreshCorrespondence(f) {
  const manifest = f.options.manifest; const base = manifest.base; const policy = manifest[policyName(f.stage)];
  base.sharedConfigHash = hash(commonConfig(base));
  if (policy.arms) policy.arms = Object.fromEntries(Object.keys(policy.arms).map(mode => [mode, arm(base, mode)]));
  if (f.stage === 'T17') {
    const { policyHash: _old, ...unsigned } = policy.recoveryPolicy; void _old;
    policy.recoveryPolicy.policyHash = hash(unsigned);
  }
  const thresholds = { schemaVersion: 'kg-stage-thresholds/v1', stage: f.stage, hardGates: base.hardGates,
    quality: policy.quality ?? null, sampling: policy.sampling ?? null, sideEffectPolicy: policy.sideEffectPolicy ?? null,
    rampAbort: policy.rampPlan?.abort ?? null, retentionPolicy: f.stage === 'R18' ? policy.frozenRetention.policy : null };
  const unsignedPolicy = Object.fromEntries(Object.entries(policy).filter(([name]) => name !== 'executionAuthorizationRef'));
  const manifestHash = hash({ schemaVersion: manifest.schemaVersion, stage: f.stage, base, policy: unsignedPolicy });
  const payload = f.options.expectedExecutionPayload;
  Object.assign(payload, { manifestHash, registryRef: clone(base.providers.registryRef),
    providersHash: hash(base.providers), thresholdsHash: hash(thresholds) });
  const signer = { algorithm: 'Ed25519', keyId: 'synthetic-execution-key', keyVersion: 'v1' };
  f.signingText = canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1',
    schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload, signer });
  f.executionEnvelope = { schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload: clone(payload),
    signature: { ...signer, value: sign(null, Buffer.from(f.signingText), pair.privateKey).toString('base64url') } };
  const executionAuthorizationRef = ref(`execution-${f.stage.toLowerCase()}`, hash(f.executionEnvelope));
  policy.executionAuthorizationRef = clone(executionAuthorizationRef); f.options.executionAuthorizationRef = executionAuthorizationRef;
  const writerOptions = f.options.writerOptions;
  writerOptions.readerOptions.binding.manifestHash = manifestHash;
  writerOptions.writerAuthorizationDigest = executionAuthorizationRef.sha256;
  writerOptions.readerOptions.readerAuthorizationDigest = executionAuthorizationRef.sha256;
  const identities = { datasetHash: base.dataset.normalizedSha256, rosterHash: base.dataset.rosterSha256,
    sharedConfigHash: base.sharedConfigHash, artifactsHash: hash(base.artifacts), indexIdentityRef: clone(base.indexIdentity.publicationIdentityRef),
    registryRef: clone(base.providers.registryRef), providersHash: hash(base.providers), thresholdsHash: hash(thresholds),
    armConfigHashes: policy.arms ? Object.fromEntries(Object.entries(policy.arms).map(([mode, value]) => [mode, value.armConfigHash])) : null };
  f.expectedCorrespondence = { validationLevel: 'structural-only', productionAuthorized: false, stage: f.stage,
    scope: clone(payload.scope), runNonce: payload.runNonce, manifestHash, executionAuthorizationRef: clone(executionAuthorizationRef),
    providers: clone(base.providers), identities, thresholdsProfile: 'kg-stage-thresholds/v1', thresholds: clone(thresholds),
    predecessor: clone(policy.predecessor ?? null), frozenRetention: clone(policy.frozenRetention ?? null),
    elapsedEvidenceRef: clone(f.stage === 'R18' ? policy.elapsedEvidenceRef : null) };
}

async function fixture(stage = 'T16', changes = {}) {
  const manifest = manifestFixture(stage);
  const scope = Object.fromEntries(['environment', 'tenantId', 'corpusId'].map(name => [name, manifest.base.scope[name]]));
  const binding = { ...scope, runNonce: manifest.base.runNonce, manifestHash: hash('draft') };
  const documents = [{ documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'trusted', expectedChunkCount: 2, contentManifestHash: null },
    { documentId: 'doc-b', documentVersion: 'v2', trustLevel: 'reviewed', expectedChunkCount: 1, contentManifestHash: null }];
  const rows = documents.flatMap(doc => Array.from({ length: doc.expectedChunkCount }, (_, index) => ({ id: `${doc.documentId}-${index}`,
    content: `Synthetic manifest publication passage ${doc.documentId} ${index}`, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    document_id: doc.documentId, document_version: doc.documentVersion, trust_level: doc.trustLevel, chunk_index: index, total_chunks: doc.expectedChunkCount })));
  documents[0].contentManifestHash = chunkManifest(rows.filter(row => row.document_id === 'doc-a'));
  const schemaManifest = { fields: ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks'] };
  const indexManifest = { name: 'dense-a', type: 'HNSW', metric: 'COSINE', dimension: 768, modelHash: hash('embedding') };
  const pointerRevision = changes.pointerRevision ?? (stage === 'T17' ? manifest.t17.lineage.expectedPointerRevision + 1 : 3);
  const identity = { schemaVersion: 'kg-publication-identity/v1', scope, graph: { graphVersion: 'graph-a', artifactDigest: `sha256:${hash('graph-artifact')}`, pointerRevision },
    documents, milvus: { collection: 'dense_a', schemaManifestHash: hash(schemaManifest), indexManifestHash: hash(indexManifest) } };
  const identityRef = ref('publication-target', hash(identity));
  manifest.base.indexIdentity = { publicationIdentityRef: clone(identityRef), schemaManifestHash: hash(schemaManifest), indexManifestHash: hash(indexManifest) };
  const participants = { executionApproverId: 'execution-approver', executorId: 'executor', readOnlyId: 'independent-reader',
    resultAuthorityId: 'synthetic-result-authority', recoveryAuthorityId: stage === 'T17' ? 'independent-recovery-authority' : null };
  const window = { startsAt: '2026-10-10T06:00:00.000Z', endsAt: '2026-10-10T06:05:00.000Z' };
  if (stage === 'T17') {
    Object.assign(manifest.t17.window, window, { approverId: participants.executionApproverId, executorId: participants.executorId, readOnlyId: participants.readOnlyId });
    manifest.t17.lineage.targetRef = clone(identityRef); manifest.t17.recoveryPolicy.lineage = clone(manifest.t17.lineage);
  }
  const effectiveWindow = { startsAt: '2026-10-10T06:00:10.000Z', endsAt: '2026-10-10T06:04:50.000Z' };
  const payload = { stage, scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash,
    authorizationId: `execution-${stage.toLowerCase()}`, nonce: '2'.repeat(32), issuerId: participants.executionApproverId, participants,
    issuedAt: '2026-10-10T06:00:05.000Z', notBefore: effectiveWindow.startsAt, expiresAt: effectiveWindow.endsAt,
    operation: stage === 'T16' ? 'execute-t16-shadow' : stage === 'T17' ? 'execute-t17-canary' : 'verify-retention',
    registryRef: clone(manifest.base.providers.registryRef), providersHash: hash(manifest.base.providers), thresholdsHash: hash('draft-thresholds'), window };
  const sourceIdentityRefs = Object.fromEntries(['postgres', 'neo4j', 'milvus'].map(name => [name, ref(`${name}-source`)]));
  const clockIdentityRef = ref('manifest-publication-clock');
  const readerOptions = { executionProfile: 'local-reference', binding, expectedIdentity: identity, expectedIdentityRef: clone(identityRef),
    readerId: participants.readOnlyId, readerAuthorizationDigest: hash('draft-authorization'), sourceIdentityRefs, clockIdentityRef,
    maxClockUncertaintyMs: 1000, observationWindow: effectiveWindow, operationTimeoutMs: 1000, maxVerifications: 1, maxPages: 4, maxRows: 16 };
  const writerOptions = { executionProfile: 'local-reference', readerOptions, artifactId: `manifest-publication-${stage.toLowerCase()}`,
    writerId: participants.executorId, writerAuthorizationDigest: hash('draft-authorization'), expectedKeyRef: ref('draft-key'),
    storeIdentityRef: ref('manifest-publication-store'), retainUntil: '2026-10-11T06:01:00.000Z', operationTimeoutMs: 1000 };
  const options = { executionProfile: 'local-reference', manifest, expectedExecutionPayload: payload, executionAuthorizationRef: ref('draft-authorization'), writerOptions };
  const f = { stage, options, binding, identity, identityRef, calls: [], outputs: [] };
  refreshCorrespondence(f);
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: pointerRevision };
  const baseDocs = documents.map(({ documentId, documentVersion, trustLevel }) => ({ documentId, documentVersion, trustLevel }));
  const postgres = { scope, pointer, outbox: { ...pointer, eventType: 'graph.snapshot.activated', publishedAt: window.startsAt, deadLetteredAt: null },
    buildJob: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'published', artifactDigest: identity.graph.artifactDigest, documents: baseDocs } };
  const neo4j = { scope, pointer: clone(pointer), snapshot: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a',
    status: 'active', artifactDigest: identity.graph.artifactDigest, documents: clone(baseDocs) } };
  f.sourceOptions = { executionProfile: 'local-reference', binding, readerId: participants.readOnlyId, readerAuthorizationDigest: options.executionAuthorizationRef.sha256,
    selector: { scope, graphVersion: 'graph-a', collection: 'dense_a' }, sourceIdentityRefs,
    validFrom: effectiveWindow.startsAt, validUntil: effectiveWindow.endsAt, maxReads: 128, pageSize: 2,
    data: { postgres, neo4j, milvus: { scope, collection: 'dense_a', schemaManifest, indexManifest, rows } } };
  f.clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [participants.readOnlyId, participants.executorId],
    sourceIdentityRef: clockIdentityRef, initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 512, maxAdvanceMs: 86400000 });
  const common = { executionProfile: 'local-reference', binding, actors: { executorId: participants.executorId, readOnlyId: participants.readOnlyId },
    validFrom: effectiveWindow.startsAt, validUntil: effectiveWindow.endsAt, maxObjects: 16 };
  f.kms = createReferenceKmsEnvelope({ ...common, keyPolicyRef: clone(manifest.base.artifactPolicy.keyPolicyRef), maxPlaintextBytes: 65536 });
  writerOptions.expectedKeyRef = await f.kms.rotateKey({ context: { executionProfile: 'local-reference', binding,
    actorId: participants.executorId, authorizationDigest: options.executionAuthorizationRef.sha256, observedAt: '2026-10-10T06:01:00.000Z' } });
  f.store = createReferenceArtifactStore({ ...common, storeIdentityRef: writerOptions.storeIdentityRef, maxObjectBytes: 262144 });
  return f;
}
function makePorts(f, edit) {
  const sources = createReferencePublicationSources(f.sourceOptions);
  const ports = Object.fromEntries(['sources', 'clock', 'kms', 'store'].map(name => [name, { executionProfile: 'local-reference', productionCapable: false }]));
  for (const [group, port, method] of [['sources', sources, 'readPostgres'], ['sources', sources, 'readNeo4j'], ['sources', sources, 'readMilvusPage'],
    ['clock', f.clock, 'readTime'], ['kms', f.kms, 'encryptArtifact'], ['kms', f.kms, 'decryptArtifact'], ['kms', f.kms, 'rotateKey'],
    ['kms', f.kms, 'revokeKey'], ['store', f.store, 'sealEncryptedArtifact'], ['store', f.store, 'readExact']]) {
    ports[group][method] = function(request) {
      f.calls.push({ group, method, request: clone(request) }); const result = port[method](request);
      result.then(value => { f.outputs.push({ method, value: clone(value) }); }, () => {}); return result;
    };
  }
  edit?.(ports); return ports;
}
const count = (f, method) => f.calls.filter(value => value.method === method).length;
const last = (f, method) => f.outputs.filter(value => value.method === method).at(-1)?.value;
const create = (f, ports = makePorts(f), implementation = subject) => implementation.createReferenceManifestPublicationArtifactWriter(f.options, ports);
const bindingInput = f => ({ manifest: f.options.manifest, expectedExecutionPayload: f.options.expectedExecutionPayload,
  executionAuthorizationRef: f.options.executionAuthorizationRef });
const bindingFailure = error => error instanceof subject.ManifestPublicationArtifactError && error.code === 'invalid-manifest-correspondence'
  && error.phase === 'configuration' && error.productionAccepted === false && error.automaticRetryAllowed === false && Object.isFrozen(error)
  && !/Synthetic manifest publication|secret-token/.test(error.message);
const publicationFailure = (code, check = () => true, ErrorClass = PublicationArtifactError) => error => error instanceof ErrorClass && error.code === code
  && error.productionAccepted === false && error.automaticRetryAllowed === false && check(error);

test('manifest publication artifact wrapper and static correspondence error entry points exist', () => {
  assert.equal(typeof subject.createReferenceManifestPublicationArtifactWriter, 'function');
  assert.equal(typeof subject.ManifestPublicationArtifactError, 'function');
});
test('T16 T17 and R18 use actual complete publication, AES-GCM store/decrypt and exact independent full-manifest correspondence', async () => {
  for (const stage of ['T16', 'T17', 'R18']) {
    const f = await fixture(stage); const configurationHash = hash(f.options); const writer = create(f); const result = await writer.sealReadback({});
    assert.ok(Object.isFrozen(writer)); assert.ok(Object.isFrozen(result)); assert.equal(writer.executionProfile, 'local-reference'); assert.equal(writer.productionCapable, false);
    assert.equal(result.schemaVersion, 'kg-manifest-publication-artifact-observation/v1');
    assert.equal(result.validationLevel, 'local-reference-manifest-publication-artifact-readback'); assert.equal(result.stage, stage);
    assert.equal(result.configurationHash, configurationHash); assert.equal(result.optionsHash, hash(f.options.writerOptions));
    assert.deepEqual(result.executionAuthorizationRef, f.options.executionAuthorizationRef);
    assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedCorrespondence);
    assert.equal(result.manifestCorrespondenceHash, hash(f.expectedCorrespondence));
    for (const flag of ['productionAccepted', 'stageAcceptanceComplete', 'sourceAuthenticated', 'storeAuthenticated', 'linearizableSnapshotProven',
      'executionAuthorized', 'signatureVerified', 'providerEvidenceVerified', 'machineGateComputed']) assert.equal(result[flag], false);
    assert.equal(verify(null, Buffer.from(f.signingText), pair.publicKey, Buffer.from(f.executionEnvelope.signature.value, 'base64url')), true);
    assert.equal(count(f, 'readPostgres'), 2); assert.equal(count(f, 'readNeo4j'), 2); assert.equal(count(f, 'readMilvusPage'), 4);
    for (const method of ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact']) assert.equal(count(f, method), 1);
    assert.equal(count(f, 'rotateKey'), 0); assert.equal(count(f, 'revokeKey'), 0);
    const plaintext = f.calls.find(value => value.method === 'encryptArtifact').request.plaintextBase64url;
    const decision = JSON.parse(Buffer.from(plaintext, 'base64url').toString()); const { observationHash: publicationHash, ...publicationBody } = decision;
    assert.equal(publicationHash, hash(publicationBody)); assert.equal(decision.rowCount, 3);
    assert.equal(result.publicationObservationHash, publicationHash); assert.equal(result.decryptedDecisionHash, hash(decision));
    assert.equal(last(f, 'decryptArtifact'), plaintext); assert.equal(result.storeReadbackHash, hash(last(f, 'readExact')));
    assert.deepEqual(result.objectRef, last(f, 'sealEncryptedArtifact')); assert.deepEqual(result.keyRef, f.options.writerOptions.expectedKeyRef);
    assert.equal(result.artifactIndex.entries.length, 1); assert.equal(result.artifactIndex.entries[0].artifactType, 'report');
    assert.equal(result.artifactIndex.entries[0].schemaVersion, 'kg-publication-observation/v1');
    assert.equal(validateControlledArtifactIndex(result.artifactIndex).productionAccepted, false);
    for (const method of ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact']) {
      const context = f.calls.find(value => value.method === method).request.context;
      assert.equal(context.authorizationDigest, f.options.executionAuthorizationRef.sha256);
      assert.equal(context.actorId, ['encryptArtifact', 'sealEncryptedArtifact'].includes(method) ? f.options.expectedExecutionPayload.participants.executorId
        : f.options.expectedExecutionPayload.participants.readOnlyId);
    }
    const { observationHash, ...core } = result; assert.equal(observationHash, hash(core));
    const { stage: _stage, executionAuthorizationRef: _ref, manifestCorrespondenceHash: _correspondence, configurationHash: _configuration,
      artifactObservationHash, executionAuthorized: _execution, signatureVerified: _signature, providerEvidenceVerified: _providers,
      machineGateComputed: _machine, schemaVersion: _schema, validationLevel: _level, ...artifactBody } = core;
    void _stage; void _ref; void _correspondence; void _configuration; void _execution; void _signature; void _providers; void _machine; void _schema; void _level;
    assert.equal(artifactObservationHash, hash({ ...artifactBody, schemaVersion: 'kg-publication-artifact-observation/v1',
      validationLevel: 'local-reference-publication-artifact-readback' }));
    assert.equal(/Synthetic manifest publication|plaintextBase64url|ciphertext|"decision"|"readbacks"/.test(canonicalJson(result)), false);
  }
});
test('raw manifest, run, scope, thresholds and provider registry mismatches fail before every IO', async () => {
  for (const change of [o => { o.manifest.base.dataset.normalizedSha256 = hash('other'); }, o => { o.manifest.base.runNonce = '3'.repeat(32); },
    o => { o.manifest.base.scope.tenantId = 'other'; }, o => { o.expectedExecutionPayload.manifestHash = hash('other'); },
    o => { o.expectedExecutionPayload.thresholdsHash = hash('other'); }, o => { o.expectedExecutionPayload.providersHash = hash('other'); },
    o => { o.expectedExecutionPayload.registryRef = ref('other'); }, o => { o.manifest.base.providers.bindings[0].configHash = hash('other'); }]) {
    const f = await fixture(); const ports = makePorts(f); change(f.options);
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('publication ref physical object version and digest must exactly match the raw manifest identity ref', async () => {
  for (const field of ['objectId', 'objectVersion', 'sha256']) {
    const f = await fixture(); const ports = makePorts(f);
    f.options.writerOptions.readerOptions.expectedIdentityRef[field] = field === 'sha256' ? hash('different') : 'other';
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(); f.options.executionAuthorizationRef.objectVersion = 'other';
  assert.throws(() => create(f), bindingFailure); assert.equal(f.calls.length, 0);
});
test('well-formed freshly rebound manifest schema and index hashes cannot substitute the actual publication identity manifests', async () => {
  for (const field of ['schemaManifestHash', 'indexManifestHash']) {
    const f = await fixture(); f.options.manifest.base.indexIdentity[field] = hash(`different-${field}`); refreshCorrespondence(f);
    assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedCorrespondence);
    const ports = makePorts(f); assert.doesNotThrow(() => createReferencePublicationArtifactWriter(f.options.writerOptions, ports));
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('writer executor, independent reader and both authorization digests are tied to the frozen execution ref', async () => {
  for (const change of [o => { o.writerOptions.writerId = 'other-executor'; }, o => { o.writerOptions.readerOptions.readerId = 'other-reader'; },
    o => { o.writerOptions.writerAuthorizationDigest = hash('other'); }, o => { o.writerOptions.readerOptions.readerAuthorizationDigest = hash('other'); }]) {
    const f = await fixture(); const ports = makePorts(f); change(f.options);
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('approved window intersection must match exactly; narrower or wider windows do not redefine correspondence', async () => {
  const windows = [ { startsAt: '2026-10-10T06:00:11.000Z', endsAt: '2026-10-10T06:04:50.000Z' },
    { startsAt: '2026-10-10T06:00:10.000Z', endsAt: '2026-10-10T06:04:49.000Z' },
    { startsAt: '2026-10-10T06:00:00.000Z', endsAt: '2026-10-10T06:05:00.000Z' },
    { startsAt: '2026-10-10T06:00:05.000Z', endsAt: '2026-10-10T06:04:50.000Z' } ];
  for (const window of windows) {
    const f = await fixture(); const ports = makePorts(f); f.options.writerOptions.readerOptions.observationWindow = window;
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('scope, run and raw manifest digest correspondence also bind the private reader operation context', async () => {
  for (const field of ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash']) {
    const f = await fixture(); const ports = makePorts(f);
    f.options.writerOptions.readerOptions.binding[field] = field === 'runNonce' ? '3'.repeat(32) : field === 'manifestHash' ? hash('other') : 'other';
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('T17 rejects N and N+2 even when all three actual sources and publication identity agree with that revision', async () => {
  for (const pointerRevision of [3, 5]) {
    const positive = await fixture('T17', { pointerRevision }); const proofPorts = makePorts(positive);
    assert.deepEqual(validateManifestExecutionBinding(bindingInput(positive)), positive.expectedCorrespondence);
    const read = await createReferencePublicationReadback(positive.options.writerOptions.readerOptions,
      { sources: proofPorts.sources, clock: proofPorts.clock }).readPublication({});
    assert.equal(read.consistencyVerified, true); assert.equal(read.rowCount, 3); assert.equal(read.productionAuthorized, false);
    const f = await fixture('T17', { pointerRevision }); const ports = makePorts(f);
    assert.equal(f.identity.graph.pointerRevision, pointerRevision); assert.equal(f.options.manifest.t17.lineage.expectedPointerRevision, 3);
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('stage substitution or structurally claimed manifest views cannot replace a raw bound stage', async () => {
  for (const change of [o => { o.expectedExecutionPayload.stage = 'T18'; }, o => { o.expectedExecutionPayload.stage = 'T17'; },
    o => { o.manifest = { validationLevel: 'structural-only', productionAuthorized: false, manifestHash: o.expectedExecutionPayload.manifestHash }; },
    o => { o.manifest.t16 = null; }, o => { o.expectedExecutionPayload.operation = 'execute-t17-canary'; }]) {
    const f = await fixture(); const ports = makePorts(f); change(f.options);
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
});
test('closed exact options and ports reject caller factories, decisions, reports, unknown labels or missing keys without IO', async () => {
  for (const change of [o => { o.factory = () => ({ passed: true }); }, o => { o.decision = { passed: true }; },
    o => { o.report = { machinePassed: true }; }, o => { o.executionAuthorized = true; }, o => { delete o.executionAuthorizationRef; },
    o => { o.writerOptions.readbackFactory = () => ({ passed: true }); }, o => { o.executionProfile = 'enterprise'; }]) {
    const f = await fixture(); const ports = makePorts(f); change(f.options);
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(); const ports = makePorts(f); ports.readerFactory = () => ({ passed: true });
  assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
});
test('configuration getters and Proxy hooks never execute for manifest, payload, writer options, ref or provider descriptors', async () => {
  let hooks = 0; const hook = () => { hooks++; throw Error('secret-token'); };
  for (const field of ['manifest', 'expectedExecutionPayload', 'writerOptions', 'executionAuthorizationRef']) for (const kind of ['getter', 'proxy']) {
    const f = await fixture(); const ports = makePorts(f);
    if (kind === 'getter') Object.defineProperty(f.options, field, { enumerable: true, get: hook });
    else f.options[field] = new Proxy(f.options[field], { ownKeys: hook, get: hook, getPrototypeOf: hook });
    assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(); const ports = makePorts(f); Object.defineProperty(ports.clock, 'readTime', { enumerable: true, get: hook });
  assert.throws(() => create(f, ports), bindingFailure); assert.equal(f.calls.length, 0); assert.equal(hooks, 0);
});
test('a valid manifest correspondence still invokes the actual reader and rejects source identity mismatch before encryption', async () => {
  const f = await fixture(); f.sourceOptions.data.neo4j.snapshot.status = 'inactive'; const writer = create(f);
  await assert.rejects(writer.sealReadback({}), publicationFailure('publication-mismatch', error => !error.mutationMayHaveOccurred));
  assert.equal(count(f, 'readNeo4j'), 1); assert.equal(count(f, 'readMilvusPage'), 0); assert.equal(count(f, 'encryptArtifact'), 0);
});
test('request injection cannot replace the private decision and invalid requests leave a valid seal available', async () => {
  const f = await fixture(); const writer = create(f); let hooks = 0;
  for (const request of [{ decision: { passed: true } }, { report: {} }, { configurationHash: hash('claimed') },
    { get passed() { hooks++; return true; } }, new Proxy({}, { ownKeys() { hooks++; return []; } })]) {
    await assert.rejects(writer.sealReadback(request), publicationFailure('invalid-request'));
  }
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0); assert.equal((await writer.sealReadback({})).executionAuthorized, false);
});
test('original manifest, payload, ref and writer configuration drift cannot replace captured expectations during actual IO', async t => {
  const f = await fixture(); const originalHash = hash(f.options); const originalManifestHash = f.binding.manifestHash;
  let release; let entered; const hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const ports = makePorts(f); const actual = ports.sources.readPostgres; let first = true;
  ports.sources.readPostgres = function(request) { const result = actual.call(this, request); if (!first) return result;
    first = false; entered(); return hold.then(() => result); };
  t.after(() => release()); const writer = create(f, ports); const pending = writer.sealReadback({}); await started;
  f.options.manifest.base.dataset.normalizedSha256 = hash('mutated'); f.options.expectedExecutionPayload.manifestHash = hash('mutated');
  f.options.executionAuthorizationRef.objectVersion = 'changed'; f.options.writerOptions.readerOptions.expectedIdentity.graph.pointerRevision = 99;
  release(); const result = await pending; assert.equal(result.configurationHash, originalHash);
  assert.equal(result.manifestCorrespondenceHash, hash(f.expectedCorrespondence)); assert.equal(result.artifactIndex.binding.manifestHash, originalManifestHash);
});
test('busy remains local to the private writer and a successful seal remains one-shot without extra IO', async t => {
  const f = await fixture(); let release; let entered; const hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const ports = makePorts(f); const actual = ports.kms.encryptArtifact;
  ports.kms.encryptArtifact = function(request) { const result = actual.call(this, request); entered(); return hold.then(() => result); };
  t.after(() => release()); const writer = create(f, ports); const pending = writer.sealReadback({}); await started;
  await assert.rejects(writer.sealReadback({}), publicationFailure('busy')); release(); assert.equal((await pending).stageAcceptanceComplete, false);
  const before = f.calls.length; await assert.rejects(writer.sealReadback({}), publicationFailure('already-sealed')); assert.equal(f.calls.length, before);
  assert.equal(count(f, 'sealEncryptedArtifact'), 1);
});
test('synchronous close preserves private terminal fencing during an inflight actual publication read', async t => {
  const f = await fixture(); let release; let entered; const hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const ports = makePorts(f); const actual = ports.sources.readPostgres;
  ports.sources.readPostgres = function(request) { const result = actual.call(this, request); entered(); return hold.then(() => result); };
  t.after(() => release()); const writer = create(f, ports); const pending = writer.sealReadback({}); await started;
  assert.equal(writer.close(), undefined); await assert.rejects(writer.sealReadback({}), publicationFailure('halted'));
  const before = f.calls.length; release(); await assert.rejects(pending, error => error instanceof PublicationArtifactError);
  assert.equal(f.calls.length, before); assert.equal(count(f, 'readNeo4j'), 0); assert.equal(count(f, 'encryptArtifact'), 0);
});
test('controlled manifest deadline subjects own the same wrapper writer and error class without changing native clocks', async () => {
  const nativeNow = performance.now;
  const { createManifestPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  const first = createManifestPublicationDeadlineSubject(), second = createManifestPublicationDeadlineSubject();
  assert.notEqual(first.subject.PublicationArtifactError, second.subject.PublicationArtifactError);
  assert.notEqual(first.subject.PublicationArtifactError, PublicationArtifactError);
  assert.notEqual(first.subject.ManifestPublicationArtifactError, subject.ManifestPublicationArtifactError);
  first.advanceTo(20); assert.equal(first.elapsedMilliseconds(), 20); assert.equal(second.elapsedMilliseconds(), 0);
  const f = await fixture();
  const result = await second.subject.createReferenceManifestPublicationArtifactWriter(f.options, makePorts(f)).sealReadback({});
  assert.equal(result.manifestCorrespondenceHash, hash(f.expectedCorrespondence));
  assert.equal(result.productionAccepted, false); assert.equal(result.stageAcceptanceComplete, false);
  assert.equal(performance.now, nativeNow);
});

test('controlled manifest deadline reaches a held KMS after slow preparation while preserving native CPU coverage', async t => {
  const { createManifestPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  const isolated = createManifestPublicationDeadlineSubject(), f = await fixture(); f.options.writerOptions.operationTimeoutMs = 20;
  assert.equal(f.options.writerOptions.readerOptions.operationTimeoutMs, 1000);
  const ports = makePorts(f), read = ports.sources.readPostgres;
  ports.sources.readPostgres = function(request) { const result = read.call(this, request), until = performance.now() + 80;
    while (performance.now() < until) { /* Slow preparation must not select which held stage gets tested. */ }
    return result;
  };
  let release, enter, entries = 0; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const encrypt = ports.kms.encryptArtifact;
  ports.kms.encryptArtifact = function(request) { entries++; const result = encrypt.call(this, request); enter(); return held.then(() => result); };
  const writer = isolated.subject.createReferenceManifestPublicationArtifactWriter(f.options, ports), pending = writer.sealReadback({});
  t.after(async () => { release(); await pending.catch(() => {}); });
  await waitForProviderEntry(started, pending); assert.equal(entries, 1); isolated.advanceTo(20);
  await assert.rejects(pending, error => error instanceof isolated.subject.PublicationArtifactError && error.code === 'operation-timeout'
    && error.productionAccepted === false && error.automaticRetryAllowed === false && error.pendingCompletionUnknown && error.mutationMayHaveOccurred);
  const before = f.calls.length; release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(writer.sealReadback({}), error => error instanceof isolated.subject.PublicationArtifactError && error.code === 'halted');
  assert.equal(f.calls.length, before); assert.equal(count(f, 'encryptArtifact'), 1); assert.equal(count(f, 'sealEncryptedArtifact'), 0);
});

test('20ms whole operation versus 1000ms inner reader preserves UNKNOWN and mutation through every delayed provider stage', async t => {
  const { createManifestPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  for (const [group, method, mutation] of [['sources', 'readPostgres', false], ['clock', 'readTime', false], ['kms', 'encryptArtifact', true],
    ['store', 'sealEncryptedArtifact', true], ['store', 'readExact', true], ['kms', 'decryptArtifact', true]]) {
    const isolated = createManifestPublicationDeadlineSubject();
    const f = await fixture(); f.options.writerOptions.operationTimeoutMs = 20;
    assert.equal(f.options.writerOptions.readerOptions.operationTimeoutMs, 1000);
    let release; let entered; let held = false, entries = 0; const hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
    const ports = makePorts(f); const actual = ports[group][method];
    ports[group][method] = function(request) { const result = actual.call(this, request); if (held) return result;
      held = true; entries++; entered(); return hold.then(() => result); };
    const writer = create(f, ports, isolated.subject); const pending = writer.sealReadback({});
    t.after(async () => { release(); await pending.catch(() => {}); });
    await waitForProviderEntry(started, pending); assert.equal(entries, 1); isolated.advanceTo(20);
    await assert.rejects(pending, publicationFailure('operation-timeout', error => error.pendingCompletionUnknown === true && error.mutationMayHaveOccurred === mutation,
      isolated.subject.PublicationArtifactError));
    const before = f.calls.length; release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(writer.sealReadback({}), publicationFailure('halted', undefined, isolated.subject.PublicationArtifactError)); assert.equal(f.calls.length, before);
    if (!mutation) assert.equal(count(f, 'encryptArtifact'), 0);
  }
});
test('synchronous 80ms provider work cannot bypass the same 20ms whole-operation deadline', async () => {
  const f = await fixture(); f.options.writerOptions.operationTimeoutMs = 20; const ports = makePorts(f); const actual = ports.sources.readPostgres;
  ports.sources.readPostgres = function(request) { const result = actual.call(this, request); const until = performance.now() + 80;
    while (performance.now() < until) { /* Whole-operation monotonic budget applies while timers cannot run. */ }
    return result;
  };
  const writer = create(f, ports);
  await assert.rejects(writer.sealReadback({}), publicationFailure('operation-timeout', error => !error.mutationMayHaveOccurred));
  assert.equal(count(f, 'readNeo4j'), 0); assert.equal(count(f, 'encryptArtifact'), 0);
  const before = f.calls.length; await assert.rejects(writer.sealReadback({}), publicationFailure('halted')); assert.equal(f.calls.length, before);
});
test('hostile provider carrier and payload hooks remain unexecuted instead of being adopted by the manifest wrapper', async () => {
  let hooks = 0;
  for (const callback of [() => ({ get then() { hooks++; throw Error('secret-token'); } }),
    () => Promise.resolve({ get payload() { hooks++; throw Error('secret-token'); } })]) {
    const f = await fixture(); const ports = makePorts(f); let entries = 0;
    ports.kms.encryptArtifact = () => { entries++; return callback(); }; const writer = create(f, ports);
    await assert.rejects(writer.sealReadback({}), error => error instanceof PublicationArtifactError && error.mutationMayHaveOccurred === true);
    const before = f.calls.length; await assert.rejects(writer.sealReadback({}), publicationFailure('halted')); assert.equal(f.calls.length, before);
    assert.equal(entries, 1); assert.equal(count(f, 'sealEncryptedArtifact'), 0);
  }
  assert.equal(hooks, 0);
});
