import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
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
const { createReferenceAuthorityClock } = await import('./production-authority-ports.ts');
const { createReferenceKmsEnvelope, createReferenceArtifactStore, validateControlledArtifactIndex } = await import('./production-controlled-artifacts.ts');
const { createReferencePublicationSources } = await import('../../knowledge-graph/publication-identity.ts');
let subject;
try { subject = await import('./production-publication-artifact.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const contentHash = value => createHash('sha256').update(value).digest('hex');
const chunkManifest = rows => hash([...rows].sort((a, b) => a.chunk_index - b.chunk_index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map(row => ({ chunkId: row.id, chunkIndex: row.chunk_index, contentSha256: contentHash(row.content) })));

async function fixture() {
  const scope = { environment: 'test-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const binding = { ...scope, runNonce: '1'.repeat(32), manifestHash: hash('manifest') };
  const documents = [{ documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'trusted', expectedChunkCount: 2, contentManifestHash: null },
    { documentId: 'doc-b', documentVersion: 'v2', trustLevel: 'reviewed', expectedChunkCount: 1, contentManifestHash: null }];
  const rows = documents.flatMap(doc => Array.from({ length: doc.expectedChunkCount }, (_, index) => ({ id: `${doc.documentId}-${index}`,
    content: `Synthetic passage ${doc.documentId} ${index}`, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    document_id: doc.documentId, document_version: doc.documentVersion, trust_level: doc.trustLevel, chunk_index: index, total_chunks: doc.expectedChunkCount })));
  documents[0].contentManifestHash = chunkManifest(rows.filter(row => row.document_id === 'doc-a'));
  const schemaManifest = { fields: ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks'] };
  const indexManifest = { name: 'dense-a', type: 'HNSW', metric: 'COSINE', dimension: 768, modelHash: hash('embedding') };
  const identity = { schemaVersion: 'kg-publication-identity/v1', scope, graph: { graphVersion: 'graph-a', artifactDigest: `sha256:${hash('artifact')}`, pointerRevision: 3 },
    documents, milvus: { collection: 'dense_a', schemaManifestHash: hash(schemaManifest), indexManifestHash: hash(indexManifest) } };
  const identityRef = { ...ref('publication-a'), sha256: hash(identity) };
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: 3 };
  const baseDocs = documents.map(({ documentId, documentVersion, trustLevel }) => ({ documentId, documentVersion, trustLevel }));
  const postgres = { scope, pointer, outbox: { ...pointer, eventType: 'graph.snapshot.activated', publishedAt: '2026-10-10T06:00:00.000Z', deadLetteredAt: null },
    buildJob: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'published', artifactDigest: identity.graph.artifactDigest, documents: baseDocs } };
  const neo4j = { scope, pointer: clone(pointer), snapshot: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a',
    status: 'active', artifactDigest: identity.graph.artifactDigest, documents: clone(baseDocs) } };
  const sourceIdentityRefs = Object.fromEntries(['postgres', 'neo4j', 'milvus'].map(name => [name, ref(`${name}-source`)]));
  const clockIdentityRef = ref('publication-clock');
  const sourceOptions = { executionProfile: 'local-reference', binding, readerId: 'publication-reader', readerAuthorizationDigest: hash('read-only-role'),
    selector: { scope, graphVersion: 'graph-a', collection: 'dense_a' }, sourceIdentityRefs,
    validFrom: '2026-10-10T06:00:00.000Z', validUntil: '2026-10-10T06:05:00.000Z', maxReads: 128, pageSize: 2,
    data: { postgres, neo4j, milvus: { scope, collection: 'dense_a', schemaManifest, indexManifest, rows } } };
  const readerOptions = { executionProfile: 'local-reference', binding, expectedIdentity: identity, expectedIdentityRef: identityRef,
    readerId: sourceOptions.readerId, readerAuthorizationDigest: sourceOptions.readerAuthorizationDigest,
    sourceIdentityRefs, clockIdentityRef, maxClockUncertaintyMs: 1000,
    observationWindow: { startsAt: sourceOptions.validFrom, endsAt: sourceOptions.validUntil }, operationTimeoutMs: 1000,
    maxVerifications: 1, maxPages: 4, maxRows: 16 };
  const writerId = 'publication-writer'; const writerAuthorizationDigest = hash('writer-role');
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [sourceOptions.readerId, writerId],
    sourceIdentityRef: clockIdentityRef, initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 512, maxAdvanceMs: 86400000 });
  const common = { executionProfile: 'local-reference', binding, actors: { executorId: writerId, readOnlyId: readerOptions.readerId },
    validFrom: sourceOptions.validFrom, validUntil: sourceOptions.validUntil, maxObjects: 16 };
  const kms = createReferenceKmsEnvelope({ ...common, keyPolicyRef: ref('publication-key-policy'), maxPlaintextBytes: 65536 });
  // The pinned key comes from the actual KMS, not a made-up envelope/reference.
  const expectedKeyRef = await kms.rotateKey({ context: { executionProfile: 'local-reference', binding, actorId: writerId,
    authorizationDigest: writerAuthorizationDigest, observedAt: '2026-10-10T06:01:00.000Z' } });
  const storeIdentityRef = ref('publication-store');
  const store = createReferenceArtifactStore({ ...common, storeIdentityRef, maxObjectBytes: 262144 });
  const options = { executionProfile: 'local-reference', readerOptions, artifactId: 'publication-artifact', writerId, writerAuthorizationDigest,
    expectedKeyRef, storeIdentityRef, retainUntil: '2026-10-11T06:01:00.000Z', operationTimeoutMs: 1000 };
  return { options, sourceOptions, clock, kms, store, calls: [], outputs: [] };
}
function makePorts(f, edit) {
  const sources = createReferencePublicationSources(f.sourceOptions);
  const p = Object.fromEntries(['sources', 'clock', 'kms', 'store'].map(name => [name, { executionProfile: 'local-reference', productionCapable: false }]));
  const calls = [['sources', sources, 'readPostgres'], ['sources', sources, 'readNeo4j'], ['sources', sources, 'readMilvusPage'],
    ['clock', f.clock, 'readTime'], ['kms', f.kms, 'encryptArtifact'], ['kms', f.kms, 'decryptArtifact'],
    ['kms', f.kms, 'rotateKey'], ['kms', f.kms, 'revokeKey'], ['store', f.store, 'sealEncryptedArtifact'], ['store', f.store, 'readExact']];
  for (const [group, port, method] of calls) p[group][method] = function(request) {
    f.calls.push({ group, method, request: clone(request) });
    // Keep the raw returned carrier: the writer, not an async wrapper, owns adoption.
    const result = port[method](request);
    result.then(value => { f.outputs.push({ method, value: clone(value) }); }, () => {});
    return result;
  };
  edit?.(p); return p;
}
const count = (f, method) => f.calls.filter(call => call.method === method).length;
const last = (f, method) => f.outputs.filter(value => value.method === method).at(-1)?.value;
const create = (f, ports = makePorts(f), writerModule = subject) => writerModule.createReferencePublicationArtifactWriter(f.options, ports);
const errorMatches = (code, extra = () => true, ErrorType = subject.PublicationArtifactError) => error => error instanceof ErrorType && error.code === code
  && error.automaticRetryAllowed === false && error.productionAccepted === false && Object.isFrozen(error)
  && !/Synthetic passage|secret-token|plaintextBase64url/.test(error.message) && extra(error);
const mutateResult = (p, group, method, edit) => {
  const read = p[group][method]; p[group][method] = function(request) { return read.call(this, request).then(value => {
    const changed = clone(value); edit(changed, request); return changed;
  }); };
};

test('provider-entry wait surfaces a rejected execution before a provider ever enters', async () => {
  const cause = new subject.PublicationArtifactError('operation-timeout', 'clock', true, false);
  const entered = new Promise(() => {}), pending = Promise.reject(cause);
  // Keep the RED itself bounded and observed; an unresolved Promise has no IO
  // handle. The helper must still report the exact terminal cause, not hang.
  pending.catch(() => {});
  const observed = waitForProviderEntry(entered, pending).then(() => ({ status: 'entered' }), error => ({ status: 'rejected', error }));
  const result = await Promise.race([observed, nextTurn().then(() => ({ status: 'waiting' }))]);
  assert.equal(result.status, 'rejected'); assert.equal(result.error.cause, cause);
  assert.equal(result.error.message, 'Provider execution failed before expected entry [code=operation-timeout, phase=clock, pending=true, mutation=false]');
});
test('provider-entry wait reports only closed context without invoking rejection getters or Proxy hooks', async () => {
  let hooks = 0; const trap = () => { hooks++; throw new Error('secret-token'); };
  const getterCause = Object.defineProperties({}, Object.fromEntries(['code', 'phase', 'pendingCompletionUnknown', 'mutationMayHaveOccurred']
    .map(key => [key, { enumerable: true, get: trap }])));
  const proxyCause = new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
  for (const cause of [getterCause, proxyCause]) {
    await assert.rejects(waitForProviderEntry(new Promise(() => {}), Promise.reject(cause)), error => {
      assert.equal(error.cause, cause);
      assert.equal(error.message, 'Provider execution failed before expected entry [code=unknown, phase=unknown, pending=unknown, mutation=unknown]');
      return true;
    });
  }
  assert.equal(hooks, 0);
});
test('provider-entry wait rejects unexpected completion before an entry instead of hanging', async () => {
  const observed = waitForProviderEntry(new Promise(() => {}), Promise.resolve()).then(() => ({ status: 'entered' }), error => ({ status: 'rejected', error }));
  const result = await Promise.race([observed, nextTurn().then(() => ({ status: 'waiting' }))]);
  assert.equal(result.status, 'rejected'); assert.equal(Object.hasOwn(result.error, 'cause'), false);
});
test('provider-entry wait observes terminal rejection even after the entry wins the race', async () => {
  const cause = new subject.PublicationArtifactError('operation-timeout', 'seal', true, true);
  let reject; const pending = new Promise((_resolve, fail) => { reject = fail; });
  await waitForProviderEntry(Promise.resolve(), pending); reject(cause);
  await assert.rejects(pending, error => error === cause); await nextTurn();
});
test('provider-entry wait retains actual upstream deadline rejection when delayed KMS never enters', async t => {
  const f = await fixture(); f.options.operationTimeoutMs = 20;
  let enter; let delayed = false; let terminalCause;
  const entered = new Promise(resolve => { enter = resolve; }), ports = makePorts(f), readTime = ports.clock.readTime;
  ports.clock.readTime = function (request) {
    const result = Reflect.apply(readTime, this, [request]);
    if (!delayed) {
      delayed = true; const until = performance.now() + 80;
      while (performance.now() < until) { /* Original deadline applies before KMS entry. */ }
    }
    return result;
  };
  const encrypt = ports.kms.encryptArtifact;
  ports.kms.encryptArtifact = function (request) { enter(); return Reflect.apply(encrypt, this, [request]); };
  const writer = create(f, ports), pending = writer.sealReadback({});
  pending.catch(error => { terminalCause = error; });
  t.after(async () => { writer.close(); await pending.catch(() => {}); });
  const observed = waitForProviderEntry(entered, pending).then(() => ({ status: 'entered' }), error => ({ status: 'rejected', error }));
  const result = await Promise.race([observed, nextTurn().then(() => ({ status: 'waiting' }))]);
  assert.equal(delayed, true); assert.equal(count(f, 'encryptArtifact'), 0);
  assert.equal(terminalCause instanceof subject.PublicationArtifactError, true);
  assert.equal(terminalCause.code, 'operation-timeout'); assert.equal(terminalCause.mutationMayHaveOccurred, false);
  assert.equal(result.status, 'rejected'); assert.equal(result.error.cause, terminalCause);
  const before = f.calls.length; await nextTurn(); assert.equal(f.calls.length, before);
});
test('publication artifact writer and owned static error constructor exist', () => {
  assert.equal(typeof subject.createReferencePublicationArtifactWriter, 'function');
  assert.equal(typeof subject.PublicationArtifactError, 'function');
});
test('actual full publication read, AES-GCM seal, independent exact readback and decrypt produce only a bounded confidential observation', async () => {
  const f = await fixture(); const writer = create(f); const result = await writer.sealReadback({});
  assert.ok(Object.isFrozen(writer)); assert.ok(Object.isFrozen(result));
  assert.equal(writer.executionProfile, 'local-reference'); assert.equal(writer.productionCapable, false);
  assert.equal(result.schemaVersion, 'kg-publication-artifact-observation/v1');
  assert.equal(result.validationLevel, 'local-reference-publication-artifact-readback'); assert.equal(result.classification, 'confidential');
  for (const flag of ['productionAccepted', 'stageAcceptanceComplete', 'sourceAuthenticated', 'storeAuthenticated', 'linearizableSnapshotProven']) assert.equal(result[flag], false);
  assert.equal(count(f, 'readPostgres'), 2); assert.equal(count(f, 'readNeo4j'), 2); assert.equal(count(f, 'readMilvusPage'), 4);
  for (const method of ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact']) assert.equal(count(f, method), 1);
  assert.equal(count(f, 'rotateKey'), 0); assert.equal(count(f, 'revokeKey'), 0);
  const encryptCall = f.calls.find(call => call.method === 'encryptArtifact').request;
  const decisionText = Buffer.from(encryptCall.plaintextBase64url, 'base64url').toString();
  const decision = JSON.parse(decisionText); const { observationHash: publicationHash, ...publicationCore } = decision;
  assert.equal(publicationHash, hash(publicationCore)); assert.equal(decisionText, canonicalJson(decision)); assert.equal(decision.rowCount, 3);
  const actualAad = { ...f.options.readerOptions.binding, artifactType: 'report', artifactId: f.options.artifactId,
    caseId: null, ordinal: 0, schemaVersion: 'kg-publication-observation/v1' };
  assert.deepEqual(encryptCall.aad, actualAad); assert.deepEqual(last(f, 'encryptArtifact').keyRef, f.options.expectedKeyRef);
  assert.equal(result.publicationObservationHash, publicationHash); assert.equal(result.decryptedDecisionHash, hash(decision));
  assert.notEqual(result.decryptedDecisionHash, publicationHash); assert.deepEqual(result.identityRef, f.options.readerOptions.expectedIdentityRef);
  assert.equal(result.identityHash, hash(f.options.readerOptions.expectedIdentity)); assert.equal(result.optionsHash, hash(f.options));
  assert.deepEqual(result.objectRef, last(f, 'sealEncryptedArtifact')); assert.deepEqual(result.keyRef, f.options.expectedKeyRef);
  assert.equal(result.storeReadbackHash, hash(last(f, 'readExact')));
  const expectedIndex = { schemaVersion: 'kg-controlled-artifact-index/v1', classification: 'confidential', binding: f.options.readerOptions.binding,
    entries: [{ artifactId: f.options.artifactId, artifactType: 'report', caseId: null, ordinal: 0,
      schemaVersion: 'kg-publication-observation/v1', objectRef: result.objectRef, keyRef: result.keyRef, aadSha256: hash(actualAad) }] };
  assert.deepEqual(result.artifactIndex, expectedIndex); assert.equal(validateControlledArtifactIndex(result.artifactIndex).productionAccepted, false);
  const completionReading = last(f, 'readTime'); assert.equal(result.completionClockHash, hash(completionReading));
  assert.equal(result.completedAt, completionReading.observedAt); assert.equal(result.uncertaintyMs, completionReading.uncertaintyMs);
  for (const method of ['encryptArtifact', 'sealEncryptedArtifact']) {
    const { context } = f.calls.find(call => call.method === method).request;
    assert.equal(context.actorId, f.options.writerId); assert.equal(context.authorizationDigest, f.options.writerAuthorizationDigest);
  }
  for (const method of ['readExact', 'decryptArtifact']) {
    const { context } = f.calls.find(call => call.method === method).request;
    assert.equal(context.actorId, f.options.readerOptions.readerId); assert.equal(context.authorizationDigest, f.options.readerOptions.readerAuthorizationDigest);
  }
  const { observationHash, ...core } = result; assert.equal(observationHash, hash(core));
  assert.equal(/Synthetic passage|plaintextBase64url|ciphertext|"decision"|"readbacks"/.test(canonicalJson(result)), false);
  assert.ok(Buffer.byteLength(canonicalJson(result)) < 65536);
});
test('actual complete-scope source superset fails publication identity before any KMS or store IO', async () => {
  const f = await fixture(); f.sourceOptions.data.milvus.rows.push({ ...f.sourceOptions.data.milvus.rows[0], id: 'unexpected-version',
    document_version: 'old', trust_level: 'external', chunk_index: 0, total_chunks: 1 });
  const writer = create(f);
  await assert.rejects(writer.sealReadback({}), errorMatches('publication-mismatch', error => !error.mutationMayHaveOccurred));
  // The unexpected row is on page two; accepting only the first page would hide it.
  assert.equal(count(f, 'readMilvusPage'), 2); assert.equal(count(f, 'encryptArtifact'), 0); assert.equal(count(f, 'sealEncryptedArtifact'), 0);
});
test('expected exact KMS key object identity remains pinned after actual encryption', async () => {
  const f = await fixture(); f.options.expectedKeyRef = ref('other-key'); const writer = create(f);
  await assert.rejects(writer.sealReadback({}), errorMatches('invalid-key', error => error.mutationMayHaveOccurred));
  assert.equal(count(f, 'encryptArtifact'), 1); assert.equal(count(f, 'sealEncryptedArtifact'), 0);
  await assert.rejects(writer.sealReadback({}), errorMatches('halted')); assert.equal(count(f, 'encryptArtifact'), 1);
});
test('physical seal reference identity and whole immutable object are independently verified', async () => {
  for (const change of [r => { r.objectId = 'other-artifact'; }, r => { r.sha256 = hash('fabricated-object'); }, r => { r.extra = true; }]) {
    const f = await fixture(); const p = makePorts(f, p => mutateResult(p, 'store', 'sealEncryptedArtifact', change)); const writer = create(f, p);
    await assert.rejects(writer.sealReadback({}), errorMatches('invalid-readback', error => error.mutationMayHaveOccurred));
    assert.equal(count(f, 'decryptArtifact'), 0);
  }
  for (const change of [r => { r.object.retainUntil = '2026-10-12T06:01:00.000Z'; }, r => { r.object.aad.artifactId = 'other'; },
    r => { r.object.envelope.tag = Buffer.alloc(16).toString('base64url'); }, r => { r.object.raw = 'secret-token'; }]) {
    const f = await fixture(); const p = makePorts(f, p => mutateResult(p, 'store', 'readExact', change)); const writer = create(f, p);
    await assert.rejects(writer.sealReadback({}), errorMatches('invalid-readback', error => error.mutationMayHaveOccurred));
    assert.equal(count(f, 'decryptArtifact'), 0);
  }
});
test('readback proof role, store identity, lock, object version/digest, retention and actual context time all fail closed', async () => {
  const changes = [r => { r.proof.readerId = 'publication-writer'; }, r => { r.proof.storeIdentityRef = ref('other-store'); },
    r => { r.proof.objectRef.objectVersion = 'v99'; }, r => { r.proof.objectRef.sha256 = hash('different'); },
    r => { r.proof.retainUntil = '2026-10-12T06:01:00.000Z'; }, r => { r.proof.observedAt = '2026-10-10T06:02:00.000Z'; },
    r => { r.proof.assurance = 'enterprise'; }, r => { r.proof.productionTamperResistant = true; },
    r => { r.proof.lockMode = 'compliance-worm'; }, r => { r.proof.extra = true; }, r => { r.extra = true; }];
  for (const change of changes) {
    const f = await fixture(); const p = makePorts(f, p => mutateResult(p, 'store', 'readExact', change));
    await assert.rejects(create(f, p).sealReadback({}), errorMatches('invalid-readback', error => error.mutationMayHaveOccurred));
    assert.equal(count(f, 'decryptArtifact'), 0);
  }
});
test('decrypt must recover the full exact actual publication decision, not a caller hash or success label', async () => {
  for (const changedPlaintext of [Buffer.from('{}').toString('base64url'), '%%%secret-token%%%', Buffer.from('{"passed":true}').toString('base64url')]) {
    const f = await fixture(); const p = makePorts(f, p => { const read = p.kms.decryptArtifact; p.kms.decryptArtifact = request => read(request).then(() => changedPlaintext); });
    await assert.rejects(create(f, p).sealReadback({}), errorMatches('invalid-readback', error => error.mutationMayHaveOccurred));
    assert.equal(count(f, 'decryptArtifact'), 1);
  }
});
test('closed own-data configuration rejects forged reader, enterprise and scope/options substitutions without IO', async () => {
  for (const change of [o => { o.executionProfile = 'enterprise'; }, o => { o.writerId = o.readerOptions.readerId; },
    o => { o.readerOptions.maxVerifications = 2; }, o => { o.readerOptions.executionProfile = 'enterprise'; },
    o => { o.readerOptions.expectedIdentityRef.sha256 = hash('other'); }, o => { o.writerAuthorizationDigest = 'bad'; },
    o => { o.artifactId = '../object'; }, o => { o.retainUntil = o.readerOptions.observationWindow.startsAt; },
    o => { o.operationTimeoutMs = 0; }, o => { o.reader = () => ({ passed: true }); }, o => { o.extra = true; }]) {
    const f = await fixture(); const p = makePorts(f); change(f.options);
    assert.throws(() => create(f, p), errorMatches('invalid-config')); assert.equal(f.calls.length, 0);
  }
});
test('configuration and provider descriptor getters or Proxy traps never execute during zero-IO preflight', async () => {
  let hooks = 0; const hook = () => { hooks++; throw Error('secret-token'); };
  for (const target of ['options', 'readerOptions', 'sources', 'clock', 'kms', 'store']) for (const kind of ['getter', 'proxy']) {
    const f = await fixture(); const p = makePorts(f); let options = f.options;
    const existing = target === 'options' ? options : target === 'readerOptions' ? options.readerOptions : p[target];
    const bad = kind === 'proxy' ? new Proxy(existing, { get: hook, getPrototypeOf: hook, ownKeys: hook })
      : Object.defineProperty({ ...existing }, target === 'options' ? 'writerId' : target === 'readerOptions' ? 'readerId'
        : ({ sources: 'readPostgres', clock: 'readTime', kms: 'encryptArtifact', store: 'readExact' })[target], { get: hook });
    if (target === 'options') options = bad;
    else if (target === 'readerOptions') options.readerOptions = bad;
    else p[target] = bad;
    assert.throws(() => subject.createReferencePublicationArtifactWriter(options, p), errorMatches('invalid-config')); assert.equal(f.calls.length, 0);
  }
  assert.equal(hooks, 0);
});
test('enterprise capability and unapproved top-level port expansion are not accepted', async () => {
  for (const target of ['sources', 'clock', 'kms', 'store']) for (const field of ['executionProfile', 'productionCapable']) {
    const f = await fixture(); const p = makePorts(f); p[target][field] = field === 'executionProfile' ? 'enterprise' : true;
    assert.throws(() => create(f, p), errorMatches('invalid-config')); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(); const p = makePorts(f); p.decision = { passed: true };
  assert.throws(() => create(f, p), errorMatches('invalid-config')); assert.equal(f.calls.length, 0);
});
test('artifact object identity cannot alias pinned key, store, clock, publication or source references', async () => {
  const ids = f => [f.options.expectedKeyRef.objectId, f.options.storeIdentityRef.objectId,
    f.options.readerOptions.clockIdentityRef.objectId, f.options.readerOptions.expectedIdentityRef.objectId,
    ...Object.values(f.options.readerOptions.sourceIdentityRefs).map(value => value.objectId)];
  const sample = await fixture();
  for (const objectId of ids(sample)) {
    const f = await fixture(); const p = makePorts(f);
    // Real key ids are per-fixture; choose the actual current pinned key for that case.
    f.options.artifactId = objectId === sample.options.expectedKeyRef.objectId ? f.options.expectedKeyRef.objectId : objectId;
    assert.throws(() => create(f, p), errorMatches('invalid-config')); assert.equal(f.calls.length, 0);
  }
});
test('seal request closed set cannot inject decision, report, identity, observed time, getters or Proxy hooks', async () => {
  const f = await fixture(); const writer = create(f); let hooks = 0;
  for (const input of [{ decision: { passed: true } }, { report: {} }, { identity: f.options.readerOptions.expectedIdentity },
    { observedAt: '2026-10-10T06:01:00.000Z' }, { get passed() { hooks++; return true; } },
    new Proxy({}, { ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return null; } })]) {
    await assert.rejects(writer.sealReadback(input), errorMatches('invalid-request'));
  }
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
  assert.equal((await writer.sealReadback({})).productionAccepted, false);
});
test('captured source, clock, KMS and store methods survive later getter replacement with original receiver binding', async t => {
  const f = await fixture(); let release; let entered; let hooks = 0;
  const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
  const p = makePorts(f); const expectedThis = new Map();
  for (const [group, method] of [['sources', 'readNeo4j'], ['clock', 'readTime'], ['kms', 'encryptArtifact'], ['store', 'readExact']]) {
    const actual = p[group][method]; const receiver = p[group]; expectedThis.set(`${group}.${method}`, 0);
    p[group][method] = function(request) { assert.equal(this, receiver); expectedThis.set(`${group}.${method}`, expectedThis.get(`${group}.${method}`) + 1); return actual.call(this, request); };
  }
  const actual = p.sources.readPostgres; let first = true;
  p.sources.readPostgres = function(request) { const result = actual.call(this, request); if (!first) return result;
    first = false; entered(); return hold.then(() => result); };
  t.after(() => release()); const writer = create(f, p); const pending = writer.sealReadback({}); await started;
  for (const [group, method] of [['sources', 'readNeo4j'], ['clock', 'readTime'], ['kms', 'encryptArtifact'], ['store', 'readExact']]) {
    Object.defineProperty(p[group], method, { get() { hooks++; throw Error('secret-token'); } });
  }
  f.options.readerOptions.expectedIdentity.graph.pointerRevision = 999; release();
  const result = await pending; assert.equal(result.productionAccepted, false); assert.equal(hooks, 0);
  for (const calls of expectedThis.values()) assert.ok(calls > 0);
});
test('concurrent busy rejection does not close or poison the first actual seal', async t => {
  const f = await fixture(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
  const p = makePorts(f); const actual = p.kms.encryptArtifact;
  p.kms.encryptArtifact = function(request) { const result = actual.call(this, request); entered(); return hold.then(() => result); };
  t.after(() => release()); const writer = create(f, p); const pending = writer.sealReadback({}); await started;
  await assert.rejects(writer.sealReadback({}), errorMatches('busy')); release(); assert.equal((await pending).productionAccepted, false);
  assert.equal(count(f, 'encryptArtifact'), 1); assert.equal(count(f, 'sealEncryptedArtifact'), 1);
});
test('successful writer seals exactly once; a second call performs zero IO', async () => {
  const f = await fixture(); const writer = create(f); await writer.sealReadback({}); const before = f.calls.length;
  await assert.rejects(writer.sealReadback({}), errorMatches('already-sealed')); assert.equal(f.calls.length, before);
});
test('explicit synchronous close permanently rejects future calls without claiming cancellation of pending IO', async t => {
  const f = await fixture(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
  const p = makePorts(f); const actual = p.sources.readPostgres;
  p.sources.readPostgres = function(request) { const result = actual.call(this, request); entered(); return hold.then(() => result); };
  t.after(() => release()); const writer = create(f, p); const pending = writer.sealReadback({}); await started;
  assert.equal(writer.close(), undefined); assert.equal(writer.close(), undefined);
  await assert.rejects(writer.sealReadback({}), errorMatches('halted')); const before = f.calls.length; release();
  await assert.rejects(pending, error => error instanceof subject.PublicationArtifactError);
  assert.equal(f.calls.length, before); assert.equal(count(f, 'encryptArtifact'), 0);
});
test('controlled publication deadline subjects keep private clocks and native Promise proof boundaries', async () => {
  const originalNow = performance.now;
  const { createPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  const first = createPublicationDeadlineSubject(); const second = createPublicationDeadlineSubject();
  assert.notEqual(first.subject.PublicationArtifactError, second.subject.PublicationArtifactError);
  assert.notEqual(first.subject.PublicationArtifactError, subject.PublicationArtifactError);
  assert.equal(first.elapsedMilliseconds(), 0); first.advanceTo(20);
  assert.equal(first.elapsedMilliseconds(), 20); assert.equal(second.elapsedMilliseconds(), 0);
  assert.throws(() => first.advanceTo(19), TypeError); assert.throws(() => first.advanceTo(NaN), TypeError);
  assert.equal(performance.now, originalNow);
  const f = await fixture();
  const decision = await second.subject.createReferencePublicationArtifactWriter(f.options, makePorts(f)).sealReadback({});
  assert.equal(decision.productionAccepted, false); assert.equal(decision.stageAcceptanceComplete, false);
  assert.equal(performance.now, originalNow);
});

test('controlled publication deadline reaches a held mutation after slow preparation without relaxing the real CPU case', async t => {
  const { createPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  const isolated = createPublicationDeadlineSubject(); const f = await fixture(); f.options.operationTimeoutMs = 20;
  assert.equal(f.options.readerOptions.operationTimeoutMs, 1000);
  const p = makePorts(f); const read = p.sources.readPostgres;
  p.sources.readPostgres = function(request) { const result = read.call(this, request); const until = performance.now() + 80;
    while (performance.now() < until) { /* Deliberately stall preparation, not the controlled deadline clock. */ }
    return result;
  };
  let release; let entered; const hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const encrypt = p.kms.encryptArtifact;
  p.kms.encryptArtifact = function(request) { const result = encrypt.call(this, request); entered(); return hold.then(() => result); };
  const writer = isolated.subject.createReferencePublicationArtifactWriter(f.options, p); const pending = writer.sealReadback({});
  t.after(async () => { release(); await pending.catch(() => {}); });
  await waitForProviderEntry(started, pending); isolated.advanceTo(20);
  await assert.rejects(pending, errorMatches('operation-timeout', error => error.pendingCompletionUnknown === true && error.mutationMayHaveOccurred === true,
    isolated.subject.PublicationArtifactError));
  const before = f.calls.length; release(); await nextTurn(); await nextTurn();
  assert.equal(f.calls.length, before); assert.equal(count(f, 'sealEncryptedArtifact'), 0);
});

test('whole-seal deadline fences late PG, clock, encryption, seal, readback and decrypt settlement without follow-up dispatch', async t => {
  const { createPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  for (const [group, method, mutation] of [['sources', 'readPostgres', false], ['clock', 'readTime', false],
    ['kms', 'encryptArtifact', true], ['store', 'sealEncryptedArtifact', true], ['store', 'readExact', true], ['kms', 'decryptArtifact', true]]) {
    const isolated = createPublicationDeadlineSubject();
    const f = await fixture(); f.options.operationTimeoutMs = 20; let release; let entered; let held = false;
    const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
    const p = makePorts(f); const actual = p[group][method];
    p[group][method] = function(request) { const result = actual.call(this, request); if (held) return result;
      held = true; entered(); return hold.then(() => result); };
    const writer = create(f, p, isolated.subject); const pending = writer.sealReadback({});
    t.after(async () => { release(); await pending.catch(() => {}); });
    await waitForProviderEntry(started, pending); isolated.advanceTo(20);
    await assert.rejects(pending, errorMatches('operation-timeout', error => error.pendingCompletionUnknown === true && error.mutationMayHaveOccurred === mutation,
      isolated.subject.PublicationArtifactError));
    const before = f.calls.length; await assert.rejects(writer.sealReadback({}), errorMatches('halted', undefined, isolated.subject.PublicationArtifactError)); assert.equal(f.calls.length, before);
    release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, before, `${method} must not resume IO after terminal UNKNOWN`);
    if (!mutation) assert.equal(count(f, 'encryptArtifact'), 0);
  }
});
async function nativeCpuDeadlineScenario(group, method, mutationTarget, prepare = () => {}) {
  const f = await fixture(); f.options.operationTimeoutMs = 20;
  const p = makePorts(f); prepare(p); const actual = p[group][method]; let cpuEntries = 0;
  p[group][method] = function(request) { cpuEntries++; const result = actual.call(this, request); const until = performance.now() + 80;
    while (performance.now() < until) { /* Timers cannot fire during synchronous work; elapsed time is still binding. */ }
    return result;
  };
  const writer = create(f, p);
  await assert.rejects(writer.sealReadback({}), errorMatches('operation-timeout', error => {
    // Preparation can exhaust the SAME real deadline before the late KMS call.
    // Compare to independent actual dispatch, never the error or scenario tag.
    const encryptDispatches = count(f, 'encryptArtifact');
    assert.ok(encryptDispatches === 0 || encryptDispatches === 1);
    return error.mutationMayHaveOccurred === (encryptDispatches === 1);
  }));
  const before = f.calls.length; await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(writer.sealReadback({}), errorMatches('halted')); assert.equal(f.calls.length, before);
  assert.equal(count(f, mutationTarget ? 'sealEncryptedArtifact' : 'readNeo4j'), 0);
  return { cpuEntries, encryptDispatches: count(f, 'encryptArtifact') };
}

test('synchronous CPU overrun cannot bypass the whole-seal deadline or dispatch the next operation', async () => {
  for (const [group, method, mutation] of [['sources', 'readPostgres', false], ['kms', 'encryptArtifact', true]]) {
    await nativeCpuDeadlineScenario(group, method, mutation);
  }
});

test('native whole-seal timeout before actual KMS entry does not fabricate a mutation', async () => {
  let delayed = false;
  const result = await nativeCpuDeadlineScenario('kms', 'encryptArtifact', true, ports => {
    const read = ports.clock.readTime;
    ports.clock.readTime = function(request) { const result = read.call(this, request);
      if (!delayed) { delayed = true; const until = performance.now() + 80;
        while (performance.now() < until) { /* The original whole-seal deadline includes this preparation. */ }
      }
      return result;
    };
  });
  assert.equal(delayed, true); assert.equal(result.cpuEntries, 0); assert.equal(result.encryptDispatches, 0);
});

test('controlled publication deadline can follow native elapsed once without changing other instances', async () => {
  const originalNow = performance.now;
  const { createPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  const first = createPublicationDeadlineSubject(), second = createPublicationDeadlineSubject(); first.advanceTo(7);
  first.followNativeElapsed(); const until = performance.now() + 80;
  while (performance.now() < until) { /* Only the first private clock follows this actual elapsed time. */ }
  assert.ok(first.elapsedMilliseconds() >= 87); assert.equal(second.elapsedMilliseconds(), 0);
  assert.throws(() => first.followNativeElapsed(), TypeError); assert.throws(() => first.advanceTo(1000), TypeError);
  assert.equal(performance.now, originalNow);
});

test('native CPU overrun after actual KMS entry fences seal even after slow controlled preparation', async () => {
  const { createPublicationDeadlineSubject } = await import('./publication-deadline.test-support.mjs');
  const isolated = createPublicationDeadlineSubject(), f = await fixture(); f.options.operationTimeoutMs = 20;
  const p = makePorts(f), read = p.sources.readPostgres; let prepared = false;
  p.sources.readPostgres = function(request) { const result = read.call(this, request);
    if (!prepared) { prepared = true; const until = performance.now() + 80;
      while (performance.now() < until) { /* No claim that this preparation fits a real 20ms budget. */ }
    }
    return result;
  };
  const encrypt = p.kms.encryptArtifact; let entries = 0, nativeElapsed = 0;
  p.kms.encryptArtifact = function(request) {
    isolated.followNativeElapsed(); entries++; const started = performance.now(), result = encrypt.call(this, request);
    while (performance.now() - started < 80) { /* Native elapsed, not a manually advanced timeout. */ }
    nativeElapsed = performance.now() - started; return result;
  };
  const writer = create(f, p, isolated.subject);
  await assert.rejects(writer.sealReadback({}), errorMatches('operation-timeout', error => error.mutationMayHaveOccurred === true,
    isolated.subject.PublicationArtifactError));
  assert.equal(prepared, true); assert.equal(entries, 1); assert.equal(count(f, 'encryptArtifact'), 1);
  assert.ok(nativeElapsed >= 80); assert.ok(isolated.elapsedMilliseconds() >= 80); assert.equal(count(f, 'sealEncryptedArtifact'), 0);
  const before = f.calls.length; await nextTurn(); await nextTurn();
  await assert.rejects(writer.sealReadback({}), errorMatches('halted', undefined, isolated.subject.PublicationArtifactError));
  assert.equal(f.calls.length, before);
});
test('clock role transitions cannot regress the global observed time even when per-actor proofs are individually valid', async () => {
  const f = await fixture(); const p = makePorts(f, p => mutateResult(p, 'clock', 'readTime', (reading, request) => {
    if (request.context.actorId === f.options.writerId) reading.observedAt = '2026-10-10T06:00:59.000Z';
  }));
  await assert.rejects(create(f, p).sealReadback({}), errorMatches('invalid-clock', error => !error.mutationMayHaveOccurred));
  assert.equal(count(f, 'readPostgres'), 2); assert.equal(count(f, 'encryptArtifact'), 0);
});
test('fresh clock after actual store read rejects expiry rather than continuing with the cached publication completion time', async () => {
  const f = await fixture(); const p = makePorts(f); const actual = p.store.readExact;
  p.store.readExact = request => actual(request).then(value => { f.clock.advanceTo(f.options.readerOptions.observationWindow.endsAt); return value; });
  await assert.rejects(create(f, p).sealReadback({}), errorMatches('invalid-clock', error => error.mutationMayHaveOccurred));
  assert.equal(count(f, 'readExact'), 1); assert.equal(count(f, 'decryptArtifact'), 0);
});
test('last completion clock pending after decrypt preserves terminal UNKNOWN and mutation uncertainty', async t => {
  const f = await fixture(); f.options.operationTimeoutMs = 20; let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
  const p = makePorts(f); const actual = p.clock.readTime;
  p.clock.readTime = function(request) { const result = actual.call(this, request);
    if (!last(f, 'decryptArtifact')) return result;
    entered(); return hold.then(() => result);
  };
  const writer = create(f, p); const pending = writer.sealReadback({});
  t.after(async () => { release(); await pending.catch(() => {}); });
  await waitForProviderEntry(started, pending);
  await assert.rejects(pending, errorMatches('operation-timeout', error => error.pendingCompletionUnknown && error.mutationMayHaveOccurred));
  const before = f.calls.length; release(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(writer.sealReadback({}), errorMatches('halted')); assert.equal(f.calls.length, before);
  assert.equal(count(f, 'decryptArtifact'), 1);
});
test('hostile raw carrier then getters and fulfilled payload getters remain unexecuted and terminal', async () => {
  let hooks = 0;
  for (const [group, method, mutation] of [['sources', 'readPostgres', false], ['clock', 'readTime', false],
    ['kms', 'encryptArtifact', true], ['store', 'sealEncryptedArtifact', true], ['store', 'readExact', true], ['kms', 'decryptArtifact', true]]) {
    for (const kind of ['carrier', 'payload']) {
      const f = await fixture(); const p = makePorts(f); let attempts = 0;
      p[group][method] = () => { attempts++; return kind === 'carrier'
        ? { get then() { hooks++; throw Error('secret-token'); } }
        : Promise.resolve({ get value() { hooks++; throw Error('secret-token'); } }); };
      const writer = create(f, p);
      await assert.rejects(writer.sealReadback({}), error => error instanceof subject.PublicationArtifactError
        && error.mutationMayHaveOccurred === mutation && !/secret-token/.test(error.message));
      const before = f.calls.length; await assert.rejects(writer.sealReadback({}), errorMatches('halted'));
      assert.equal(attempts, 1); assert.equal(f.calls.length, before);
    }
  }
  assert.equal(hooks, 0);
});

test('external owned error after actual encrypt cannot downgrade this writer mutation or replace its encrypt phase', async () => {
  for (const pending of [true, false]) {
    const f = await fixture(); const p = makePorts(f); const actual = p.kms.encryptArtifact;
    const external = new subject.PublicationArtifactError('operation-timeout', 'preflight', pending, false);
    p.kms.encryptArtifact = function(request) { return actual.call(this, request).then(() => { throw external; }); };
    const writer = create(f, p);
    await assert.rejects(writer.sealReadback({}), errorMatches('operation-timeout', error => error.mutationMayHaveOccurred === true
      && error.pendingCompletionUnknown === pending && error.phase === 'encrypt'));
    assert.equal(count(f, 'encryptArtifact'), 1); assert.ok(last(f, 'encryptArtifact'));
    assert.equal(count(f, 'sealEncryptedArtifact'), 0);
    const before = f.calls.length;
    await assert.rejects(writer.sealReadback({}), errorMatches('halted', error => error.mutationMayHaveOccurred === true));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before);
  }
});
test('external owned error after actual seal cannot downgrade this writer mutation or replace its seal phase', async () => {
  for (const pending of [true, false]) {
    const f = await fixture(); const p = makePorts(f); const actual = p.store.sealEncryptedArtifact;
    const external = new subject.PublicationArtifactError('operation-timeout', 'preflight', pending, false);
    p.store.sealEncryptedArtifact = function(request) { return actual.call(this, request).then(() => { throw external; }); };
    const writer = create(f, p);
    await assert.rejects(writer.sealReadback({}), errorMatches('operation-timeout', error => error.mutationMayHaveOccurred === true
      && error.pendingCompletionUnknown === pending && error.phase === 'seal'));
    assert.equal(count(f, 'encryptArtifact'), 1); assert.equal(count(f, 'sealEncryptedArtifact'), 1);
    assert.ok(last(f, 'sealEncryptedArtifact')); assert.equal(count(f, 'readExact'), 0);
    const before = f.calls.length;
    await assert.rejects(writer.sealReadback({}), errorMatches('halted', error => error.mutationMayHaveOccurred === true));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before);
  }
});
test('external owned error after actual readback cannot downgrade prior mutation or replace this writer readback phase', async () => {
  for (const pending of [true, false]) {
    const f = await fixture(); const p = makePorts(f); const actual = p.store.readExact;
    const external = new subject.PublicationArtifactError('operation-timeout', 'preflight', pending, false);
    p.store.readExact = function(request) { return actual.call(this, request).then(() => { throw external; }); };
    const writer = create(f, p);
    await assert.rejects(writer.sealReadback({}), errorMatches('operation-timeout', error => error.mutationMayHaveOccurred === true
      && error.pendingCompletionUnknown === pending && error.phase === 'readback'));
    assert.equal(count(f, 'encryptArtifact'), 1); assert.equal(count(f, 'sealEncryptedArtifact'), 1); assert.equal(count(f, 'readExact'), 1);
    assert.ok(last(f, 'readExact')); assert.equal(count(f, 'decryptArtifact'), 0);
    const before = f.calls.length;
    await assert.rejects(writer.sealReadback({}), errorMatches('halted', error => error.mutationMayHaveOccurred === true));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before);
  }
});

test('actual encryption completing after window expiry must be re-timed before any immutable seal dispatch', async () => {
  const f = await fixture(); const p = makePorts(f); const actual = p.kms.encryptArtifact;
  p.kms.encryptArtifact = function(request) { return actual.call(this, request).then(envelope => {
    f.clock.advanceTo(f.options.readerOptions.observationWindow.endsAt); return envelope;
  }); };
  const writer = create(f, p);
  await assert.rejects(writer.sealReadback({}), errorMatches('invalid-clock', error => error.phase === 'clock'
    && error.mutationMayHaveOccurred === true && error.pendingCompletionUnknown === false));
  assert.equal(count(f, 'encryptArtifact'), 1); assert.ok(last(f, 'encryptArtifact'));
  // A post-seal expiry rejection is too late: the immutable object already exists.
  assert.equal(count(f, 'sealEncryptedArtifact'), 0); assert.equal(count(f, 'readExact'), 0);
  const before = f.calls.length;
  await assert.rejects(writer.sealReadback({}), errorMatches('halted', error => error.mutationMayHaveOccurred === true));
  assert.equal(f.calls.length, before);
});
test('actual clock sequence history survives both publication-to-writer and writer-to-reader role transitions', async () => {
  const outcomes = [];
  for (const transition of ['writer', 'read-only']) {
    const f = await fixture(); const p = makePorts(f); const actual = p.clock.readTime; let writerObserved = false;
    const changedSequences = [];
    p.clock.readTime = function(request) { return actual.call(this, request).then(value => {
      const reading = clone(value);
      if (request.context.actorId === f.options.writerId) {
        writerObserved = true;
        if (transition === 'writer' && reading.sequence === 10) {
          changedSequences.push({ actual: reading.sequence, returned: 1 }); reading.sequence = 1;
        }
      } else if (transition === 'read-only' && writerObserved) {
        // Preserve real proof/nonce/ref/time; only regress the actual shared clock sequence.
        changedSequences.push({ actual: reading.sequence, returned: reading.sequence - 9 }); reading.sequence -= 9;
      }
      return reading;
    }); };
    const writer = create(f, p);
    const reason = await writer.sealReadback({}).then(() => null, error => error);
    assert.ok(changedSequences.length > 0); assert.ok(changedSequences.every(({ actual }) => actual >= 10));
    outcomes.push({ transition, code: reason?.code ?? null, phase: reason?.phase ?? null,
      mutation: reason?.mutationMayHaveOccurred ?? null, pending: reason?.pendingCompletionUnknown ?? null,
      encryptCalls: count(f, 'encryptArtifact'), sealCalls: count(f, 'sealEncryptedArtifact'),
      readCalls: count(f, 'readExact'), decryptCalls: count(f, 'decryptArtifact') });
    if (reason !== null) {
      assert.ok(reason instanceof subject.PublicationArtifactError); const before = f.calls.length;
      await assert.rejects(writer.sealReadback({}), errorMatches('halted')); assert.equal(f.calls.length, before);
    }
  }
  // Collect both transitions before asserting so both real regressions execute in RED.
  assert.deepEqual(outcomes, [
    { transition: 'writer', code: 'invalid-clock', phase: 'clock', mutation: false, pending: false,
      encryptCalls: 0, sealCalls: 0, readCalls: 0, decryptCalls: 0 },
    { transition: 'read-only', code: 'invalid-clock', phase: 'clock', mutation: true, pending: false,
      encryptCalls: 1, sealCalls: 1, readCalls: 0, decryptCalls: 0 },
  ]);
});
