import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { canonicalJson, canonicalJsonSha256: hash } = await import('../rag/eval/canonical-json.ts');
const { createReferenceAuthorityClock } = await import('../rag/eval/production-authority-ports.ts');
let subject;
try { subject = await import('./publication-identity.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const contentHash = value => createHash('sha256').update(value).digest('hex');
const chunkManifest = rows => hash([...rows].sort((a, b) => a.chunk_index - b.chunk_index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map(row => ({ chunkId: row.id, chunkIndex: row.chunk_index, contentSha256: contentHash(row.content) })));

function fixture() {
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
  const sources = Object.fromEntries(['postgres', 'neo4j', 'milvus'].map(name => [name, ref(`${name}-source`)]));
  const clockRef = ref('publication-clock');
  const sourceOptions = { executionProfile: 'local-reference', binding, readerId: 'publication-reader', readerAuthorizationDigest: hash('read-only-role'),
    selector: { scope, graphVersion: 'graph-a', collection: 'dense_a' }, sourceIdentityRefs: sources,
    validFrom: '2026-10-10T06:00:00.000Z', validUntil: '2026-10-10T06:05:00.000Z', maxReads: 128, pageSize: 2,
    data: { postgres, neo4j, milvus: { scope, collection: 'dense_a', schemaManifest, indexManifest, rows } } };
  const options = { executionProfile: 'local-reference', binding, expectedIdentity: identity, expectedIdentityRef: identityRef,
    readerId: sourceOptions.readerId, readerAuthorizationDigest: sourceOptions.readerAuthorizationDigest,
    sourceIdentityRefs: sources, clockIdentityRef: clockRef, maxClockUncertaintyMs: 1000,
    observationWindow: { startsAt: sourceOptions.validFrom, endsAt: sourceOptions.validUntil }, operationTimeoutMs: 1000, maxVerifications: 4, maxPages: 4, maxRows: 16 };
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [sourceOptions.readerId],
    sourceIdentityRef: clockRef, initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 512, maxAdvanceMs: 86400000 });
  return { scope, binding, identity, identityRef, rows, sourceOptions, options, clock, calls: [] };
}
function ports(f, edit) {
  const source = subject.createReferencePublicationSources(f.sourceOptions); f.source = source;
  const value = { sources: { executionProfile: 'local-reference', productionCapable: false }, clock: { executionProfile: 'local-reference', productionCapable: false,
    readTime(request) { f.calls.push({ kind: 'clock', request: clone(request) }); return f.clock.readTime(request); } } };
  for (const [method, kind] of [['readPostgres', 'postgres'], ['readNeo4j', 'neo4j'], ['readMilvusPage', 'milvus']]) value.sources[method] = request => {
    f.calls.push({ kind, request: clone(request) }); return source[method](request); };
  edit?.(value); return value;
}
const count = (f, kind) => f.calls.filter(call => call.kind === kind).length;
const reject = code => error => error instanceof subject.PublicationIdentityError && error.code === code && error.productionAuthorized === false
  && !/Synthetic passage|doc-a|tenant-a|secret-token/.test(error.message);
function alter(f, kind, change) { return ports(f, p => { const name = { postgres: 'readPostgres', neo4j: 'readNeo4j', milvus: 'readMilvusPage' }[kind]; const read = p.sources[name];
  p.sources[name] = async request => { const result = clone(await read(request)); change(result.data, request); result.proof.dataHash = hash(result.data); return result; }; }); }

// Generate pages instead of putting a >256KiB inventory into the deliberately
// small, immutable reference-fixture constructor. This tests the actual reader
// capacity, not enterprise source identity or server transport capability.
function capacityFixture(extraRow = false) {
  const f = fixture(); const total = 65536;
  const doc = { documentId: 'capacity-doc', documentVersion: 'v1', trustLevel: 'trusted', expectedChunkCount: total, contentManifestHash: null };
  f.identity.documents = [doc]; f.identityRef.sha256 = hash(f.identity);
  for (const [source, field] of [['postgres', 'buildJob'], ['neo4j', 'snapshot']]) f.sourceOptions.data[source][field].documents =
    [{ documentId: doc.documentId, documentVersion: doc.documentVersion, trustLevel: doc.trustLevel }];
  Object.assign(f.options, { maxPages: extraRow ? 513 : 512, maxRows: total, maxVerifications: 1 });
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: f.scope, allowedActorIds: [f.options.readerId],
    sourceIdentityRef: f.options.clockIdentityRef, initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 4096, maxAdvanceMs: 86400000 });
  const cursor = offset => hash({ offset, source: 'capacity-source' });
  const offsets = new Map(Array.from({ length: 513 }, (_, page) => [page === 0 ? null : cursor(page * 128), page * 128]));
  let pages = 0; let generated = 0;
  const proof = (source, data, request) => ({ data, proof: { schemaVersion: 'kg-publication-source-proof/v1', source, assurance: 'local-reference',
    productionSourceAuthenticated: false, sourceIdentityRef: f.options.sourceIdentityRefs[source], context: request.context,
    selector: request.selector, requestNonce: request.requestNonce, cursor: request.cursor, dataHash: hash(data) } });
  const sources = { executionProfile: 'local-reference', productionCapable: false,
    async readPostgres(request) { return proof('postgres', f.sourceOptions.data.postgres, request); },
    async readNeo4j(request) { return proof('neo4j', f.sourceOptions.data.neo4j, request); },
    async readMilvusPage(request) {
      pages++; const offset = offsets.get(request.cursor); assert.notEqual(offset, undefined);
      const end = Math.min(offset + 128, total + Number(extraRow));
      const rows = Array.from({ length: end - offset }, (_, index) => ({ id: `capacity-${offset + index}`, content: 'Synthetic capacity passage',
        tenant_id: f.scope.tenantId, corpus_id: f.scope.corpusId, document_id: doc.documentId, document_version: doc.documentVersion,
        trust_level: doc.trustLevel, chunk_index: offset + index, total_chunks: total }));
      generated += rows.length; const nextCursor = end < total + Number(extraRow) ? cursor(end) : null;
      return proof('milvus', { ...f.sourceOptions.data.milvus, rows, completion: nextCursor === null ? 'complete' : 'more', nextCursor }, request);
    } };
  return { f, total, ports: { sources, clock: { executionProfile: 'local-reference', productionCapable: false, readTime: request => clock.readTime(request) } },
    counts: () => ({ pages, generated }) };
}

test('publication identity validation, source adapter and actual readback entry points exist', () => {
  for (const name of ['validatePublicationIdentity', 'createReferencePublicationSources', 'createReferencePublicationReadback', 'publicationChunkManifestHash']) assert.equal(typeof subject[name], 'function');
});
test('identity freezes an already sorted exact document set, count-or-content manifests and independent graph/index hashes', () => {
  const f = fixture(); const result = subject.validatePublicationIdentity(f.identity); assert.equal(result.productionAuthorized, false);
  assert.equal(result.identityHash, hash(f.identity)); assert.ok(Object.isFrozen(result.identity.documents));
  f.identity.documents[0].expectedChunkCount = 999; assert.equal(result.identity.documents[0].expectedChunkCount, 2);
  for (const change of [i => { i.documents.reverse(); }, i => { i.documents.push(clone(i.documents[0])); }, i => { i.documents[0].expectedChunkCount = null; i.documents[0].contentManifestHash = null; },
    i => { i.graph.artifactDigest = hash('unprefixed'); }, i => { i.graph.pointerRevision = -1; }, i => { i.documents[0].trustLevel = 'unknown'; }, i => { i.milvus.collection = '../dense_a'; }, i => { i.extra = true; }]) {
    const input = fixture().identity; change(input); assert.throws(() => subject.validatePublicationIdentity(input), reject('invalid-identity')); }
});
test('actual three-store joins use two full Milvus scans and fresh barrier reads, not literal field equality', async () => {
  const f = fixture(); const reader = subject.createReferencePublicationReadback(f.options, ports(f)); const result = await reader.readPublication({});
  assert.equal(result.productionAuthorized, false); assert.equal(result.stageAcceptanceComplete, false); assert.equal(result.sourceAuthenticated, false);
  assert.equal(result.linearizableSnapshotProven, false); assert.equal(result.consistencyVerified, true); assert.deepEqual(result.identityRef, f.identityRef);
  assert.equal(result.rowCount, 3); assert.equal(count(f, 'postgres'), 2); assert.equal(count(f, 'neo4j'), 2); assert.equal(count(f, 'milvus'), 4); assert.equal(count(f, 'clock'), 9);
  assert.ok(Object.isFrozen(result.readbacks)); assert.equal(new Set(f.calls.map(call => call.request.requestNonce)).size, f.calls.length);
  const { observationHash, ...core } = result; assert.equal(observationHash, hash(core)); assert.ok(!canonicalJson(result).includes('Synthetic passage'));
});

test('the declared 65536-row capacity is reachable through two complete bounded scans', async () => {
  const c = capacityFixture(); const result = await subject.createReferencePublicationReadback(c.f.options, c.ports).readPublication({});
  assert.equal(result.rowCount, 65536); assert.equal(result.consistencyVerified, true); assert.equal(result.productionAuthorized, false);
  assert.deepEqual(c.counts(), { pages: 1024, generated: 131072 }); assert.equal(result.readbacks.length, 1028);
  assert.ok(Buffer.byteLength(canonicalJson(result)) < 256 * 1024);
  const digest = createHash('sha256').update('[');
  for (let index = 0; index < c.total; index++) {
    if (index) digest.update(','); digest.update(canonicalJson({ chunkId: `capacity-${index}`, chunkIndex: index, contentSha256: contentHash('Synthetic capacity passage') }));
  }
  const expected = hash([{ documentId: 'capacity-doc', documentVersion: 'v1', trustLevel: 'trusted', chunkCount: c.total, contentManifestHash: digest.update(']').digest('hex') }]);
  assert.equal(result.rowsManifestHash, expected);
});
test('a 65537th row or exhausted page budget fails closed instead of completing a prefix', async () => {
  const c = capacityFixture(true);
  await assert.rejects(subject.createReferencePublicationReadback(c.f.options, c.ports).readPublication({}), reject('read-limit'));
  assert.deepEqual(c.counts(), { pages: 513, generated: 65537 });
  const d = capacityFixture(); d.f.options.maxPages = 1;
  await assert.rejects(subject.createReferencePublicationReadback(d.f.options, d.ports).readPublication({}), reject('read-limit'));
  assert.deepEqual(d.counts(), { pages: 1, generated: 128 });
  const f = fixture(); f.options.maxPages = 1025;
  assert.throws(() => subject.createReferencePublicationReadback(f.options, ports(f)), reject('invalid-config')); assert.equal(f.calls.length, 0);
});

test('opaque document identities from existing KG contracts survive the full three-store verifier', async () => {
  for (const [documentId, documentVersion] of [['课程甲', 'v1'], ['doc/a', 'v1'], ['doc-a', '版本/一']]) {
    const f = fixture(); const doc = { documentId, documentVersion, trustLevel: 'trusted', expectedChunkCount: 1, contentManifestHash: null };
    f.identity.documents = [doc]; f.identityRef.sha256 = hash(f.identity);
    f.rows.splice(0, f.rows.length, { id: 'chunk/课程甲', content: 'Synthetic opaque passage', tenant_id: f.scope.tenantId, corpus_id: f.scope.corpusId,
      document_id: documentId, document_version: documentVersion, trust_level: 'trusted', chunk_index: 0, total_chunks: 1 });
    const base = [{ documentId, documentVersion, trustLevel: 'trusted' }];
    f.sourceOptions.data.postgres.buildJob.documents = base; f.sourceOptions.data.neo4j.snapshot.documents = clone(base);
    const result = await subject.createReferencePublicationReadback(f.options, ports(f)).readPublication({});
    assert.equal(result.rowCount, 1); assert.equal(result.consistencyVerified, true); assert.equal(result.productionAuthorized, false);
    assert.equal(subject.publicationChunkManifestHash(f.rows), chunkManifest(f.rows));
  }
});

test('opaque identity support retains bounds, controls, exact matching and safe scope selectors', async () => {
  for (const value of ['', ' ', ' doc-a', 'doc-a ', 'doc\u0000a', 'doc\na', 'x'.repeat(513)]) {
    const f = fixture(); f.identity.documents[0].documentId = value;
    assert.throws(() => subject.validatePublicationIdentity(f.identity), reject('invalid-identity'));
    const rows = clone(f.rows.slice(0, 2)); rows[0].id = value;
    assert.throws(() => subject.publicationChunkManifestHash(rows), reject('identity-mismatch'));
  }
  const f = fixture(); f.identity.scope.tenantId = 'tenant/a';
  assert.throws(() => subject.validatePublicationIdentity(f.identity), reject('invalid-identity'));
  const g = fixture(); const p = alter(g, 'milvus', d => { d.rows[0].document_version = '版本/other'; });
  await assert.rejects(subject.createReferencePublicationReadback(g.options, p).readPublication({}), reject('identity-mismatch'));
});
test('content-only document manifests and count-only documents are both actually verified', async () => {
  const f = fixture(); f.identity.documents[0].expectedChunkCount = null; f.options.expectedIdentityRef.sha256 = hash(f.identity);
  const result = await subject.createReferencePublicationReadback(f.options, ports(f)).readPublication({}); assert.equal(result.rowCount, 3);
  assert.equal(subject.publicationChunkManifestHash(f.rows.slice(0, 2)), chunkManifest(f.rows.slice(0, 2)));
});
test('reference source detaches data, requires exact reader/scope/run/selector/window and rejects challenge replay', async () => {
  const f = fixture(); const source = subject.createReferencePublicationSources(f.sourceOptions); f.sourceOptions.data.postgres.pointer.revision = 99;
  const request = { context: { executionProfile: 'local-reference', binding: f.binding, actorId: f.options.readerId, authorizationDigest: f.options.readerAuthorizationDigest,
    observedAt: '2026-10-10T06:01:00.000Z' }, selector: f.sourceOptions.selector, requestNonce: '2'.repeat(32), cursor: null };
  const result = await source.readPostgres(request); assert.equal(result.data.pointer.revision, 3); assert.ok(Object.isFrozen(result));
  await assert.rejects(source.readNeo4j(request), reject('source-replay'));
  for (const edit of [r => { r.context.binding.tenantId = 'other'; }, r => { r.context.actorId = 'writer'; }, r => { r.context.authorizationDigest = hash('wrong'); },
    r => { r.context.executionProfile = 'enterprise'; }, r => { r.selector.graphVersion = 'other'; }, r => { r.context.observedAt = '2026-10-10T06:05:00.000Z'; }, r => { r.cursor = 'invented'; }]) {
    const bad = clone(request); bad.requestNonce = '3'.repeat(32); edit(bad); await assert.rejects(source.readPostgres(bad), reject('invalid-request')); }
  source.setAvailability(false); await assert.rejects(source.readNeo4j({ ...request, requestNonce: '4'.repeat(32) }), reject('source-unavailable'));
});
test('all PostgreSQL pointer, acknowledged Outbox and BuildJob relations are independently enforced before Neo4j IO', async () => {
  for (const edit of [d => { d.scope.environment = 'other'; }, d => { d.pointer.tenantId = 'other'; }, d => { d.pointer.graphVersion = 'other'; }, d => { d.pointer.revision++; },
    d => { d.outbox.revision--; }, d => { d.outbox.graphVersion = 'other'; }, d => { d.outbox.eventType = 'graph.snapshot.deactivated'; }, d => { d.outbox.publishedAt = null; },
    d => { d.outbox.deadLetteredAt = '2026-10-10T06:00:00.000Z'; }, d => { d.buildJob.status = 'validated'; }, d => { d.buildJob.artifactDigest = `sha256:${hash('other')}`; },
    d => { d.buildJob.documents.pop(); }, d => { d.buildJob.documents.push(clone(d.buildJob.documents[0])); }, d => { d.buildJob.documents[0].trustLevel = 'reviewed'; }]) {
    const f = fixture(); await assert.rejects(subject.createReferencePublicationReadback(f.options, alter(f, 'postgres', edit)).readPublication({}), reject('identity-mismatch'));
    assert.equal(count(f, 'postgres'), 1); assert.equal(count(f, 'neo4j'), 0); }
});
test('Neo4j pointer and full Snapshot document identity reject scope, digest, version and superset/subset substitutions', async () => {
  for (const edit of [d => { d.pointer.corpusId = 'other'; }, d => { d.pointer.revision++; }, d => { d.snapshot.artifactDigest = `sha256:${hash('other')}`; },
    d => { d.snapshot.graphVersion = 'other'; }, d => { d.snapshot.status = 'failed'; }, d => { d.snapshot.documents.pop(); },
    d => { d.snapshot.documents.push({ documentId: 'extra', documentVersion: 'v1', trustLevel: 'trusted' }); }, d => { d.snapshot.documents[0].documentVersion = 'v2'; }]) {
    const f = fixture(); await assert.rejects(subject.createReferencePublicationReadback(f.options, alter(f, 'neo4j', edit)).readPublication({}), reject('identity-mismatch'));
    assert.equal(count(f, 'neo4j'), 1); assert.equal(count(f, 'milvus'), 0); }
});
test('source proofs must match actual source, context, challenge, selector, cursor and canonical data', async () => {
  for (const edit of [r => { r.proof.sourceIdentityRef = ref('other'); }, r => { r.proof.requestNonce = '0'.repeat(32); }, r => { r.proof.context.actorId = 'other'; },
    r => { r.proof.selector.collection = 'other'; }, r => { r.proof.dataHash = hash('declared'); }, r => { r.proof.assurance = 'enterprise'; }, r => { r.proof.cursor = 'other'; }, r => { r.extra = true; }]) {
    const f = fixture(); const p = ports(f, p => { const read = p.sources.readPostgres; p.sources.readPostgres = async request => { const result = clone(await read(request)); edit(result); return result; }; });
    await assert.rejects(subject.createReferencePublicationReadback(f.options, p).readPublication({}), reject('invalid-readback')); assert.equal(count(f, 'neo4j'), 0); }
});
test('Milvus recomputes schema/index manifests and exact collection identity instead of accepting declared hashes', async () => {
  for (const edit of [d => { d.collection = 'other'; }, d => { d.scope.tenantId = 'other'; }, d => { d.schemaManifest.fields.pop(); },
    d => { d.indexManifest.dimension++; }, d => { d.indexManifestHash = hash(d.indexManifest); }]) {
    const f = fixture(); await assert.rejects(subject.createReferencePublicationReadback(f.options, alter(f, 'milvus', edit)).readPublication({}), reject('identity-mismatch')); }
});
test('Milvus missing or non-record manifests fail even when their frozen expected hashes match', async () => {
  for (const field of ['schemaManifest', 'indexManifest']) for (const value of [null, {}, 'text', [], 0, false]) {
    const f = fixture(); f.sourceOptions.data.milvus[field] = value;
    f.identity.milvus[`${field}Hash`] = hash(value); f.options.expectedIdentityRef.sha256 = hash(f.identity);
    await assert.rejects(subject.createReferencePublicationReadback(f.options, ports(f)).readPublication({}), reject('identity-mismatch'));
    assert.equal(count(f, 'milvus'), 1); assert.equal(count(f, 'postgres'), 1); assert.equal(count(f, 'neo4j'), 1);
  }
});
test('Milvus full rows reject unexpected or missing versions, trust levels, scope and chunks', async () => {
  for (const edit of [d => { d.rows[0].document_id = 'extra'; }, d => { d.rows[0].document_version = 'old'; }, d => { d.rows[0].trust_level = 'external'; },
    d => { d.rows[0].tenant_id = 'other'; }, d => { d.rows[0].corpus_id = 'other'; }, d => { d.rows[0].chunk_index = 9; }, d => { d.rows[0].total_chunks = 99; },
    d => { d.rows[0].content += ' modified'; }, d => { d.rows.pop(); }, d => { d.rows.push(clone(d.rows[0])); }, d => { d.rows[0].id = 'doc-b-0'; }]) {
    const f = fixture(); await assert.rejects(subject.createReferencePublicationReadback(f.options, alter(f, 'milvus', edit)).readPublication({}), reject('identity-mismatch')); }
});
test('unordered source documents and rows still match the frozen sorted identity, duplicates never do', async () => {
  const f = fixture(); f.sourceOptions.data.postgres.buildJob.documents.reverse(); f.sourceOptions.data.neo4j.snapshot.documents.reverse(); f.sourceOptions.data.milvus.rows.reverse();
  assert.equal((await subject.createReferencePublicationReadback(f.options, ports(f)).readPublication({})).rowCount, 3);
});
test('pagination is complete, cursor-bound and finite; cycles, truncation and row/page limits fail closed', async () => {
  for (const edit of [d => { d.nextCursor = 'cycle'; d.completion = 'more'; }, d => { d.nextCursor = null; d.completion = 'more'; }, d => { d.completion = 'complete'; },
    d => { d.rows = []; }, d => { d.nextCursor = 'invented'; }]) {
    const f = fixture(); await assert.rejects(subject.createReferencePublicationReadback(f.options, alter(f, 'milvus', edit)).readPublication({}), error => error.productionAuthorized === false); }
  for (const setting of [{ maxPages: 1 }, { maxRows: 2 }]) { const f = fixture(); Object.assign(f.options, setting);
    await assert.rejects(subject.createReferencePublicationReadback(f.options, ports(f)).readPublication({}), reject('read-limit')); }
});
test('metadata may not drift between Milvus pages, even if each page has a valid correlation proof', async () => {
  const f = fixture(); const p = alter(f, 'milvus', (d, request) => { if (request.cursor !== null) d.indexManifest.metric = 'L2'; });
  await assert.rejects(subject.createReferencePublicationReadback(f.options, p).readPublication({}), reject('identity-mismatch'));
});
test('second full scan catches content drift even for a count-only document', async () => {
  const f = fixture(); let pages = 0; const p = alter(f, 'milvus', d => { pages++; if (pages > 2) for (const row of d.rows) if (row.document_id === 'doc-b') row.content += ' changed'; });
  await assert.rejects(subject.createReferencePublicationReadback(f.options, p).readPublication({}), reject('unstable-publication'));
});
test('fresh Neo4j and PostgreSQL barriers reject changes during the joined read', async () => {
  for (const kind of ['neo4j', 'postgres']) { const f = fixture(); let reads = 0; const p = alter(f, kind, d => { if (++reads > 1) d.pointer.revision++; });
    await assert.rejects(subject.createReferencePublicationReadback(f.options, p).readPublication({}), reject('identity-mismatch')); }
});
test('Outbox acknowledgement cannot originate after the actual completion uncertainty lower bound', async () => {
  for (const [publishedAt, uncertaintyMs] of [['2026-10-10T06:02:00.000Z', 0], ['2026-10-10T06:01:00.000Z', 1000]]) {
    const f = fixture(); const p = alter(f, 'postgres', d => { d.outbox.publishedAt = publishedAt; });
    const read = p.clock.readTime; p.clock.readTime = async request => { const value = clone(await read(request)); value.uncertaintyMs = uncertaintyMs; return value; };
    await assert.rejects(subject.createReferencePublicationReadback(f.options, p).readPublication({}), reject('identity-mismatch'));
  }
});
test('success is not cached and the minimum one-attempt budget covers the complete read', async () => {
  const f = fixture(); f.options.maxVerifications = 1; f.options.maxPages = 2;
  const reader = subject.createReferencePublicationReadback(f.options, ports(f)); await reader.readPublication({});
  const calls = f.calls.length; await assert.rejects(reader.readPublication({}), reject('attempt-capacity')); assert.equal(f.calls.length, calls);
  const g = fixture(); const second = subject.createReferencePublicationReadback(g.options, ports(g));
  const a = await second.readPublication({}); const b = await second.readPublication({}); assert.notEqual(a.observationHash, b.observationHash);
  assert.equal(count(g, 'postgres'), 4); assert.equal(count(g, 'milvus'), 8); assert.equal(count(g, 'clock'), 18);
});
test('caller success, identity replacement, time and config invalidity reject before IO', async () => {
  const f = fixture(); const reader = subject.createReferencePublicationReadback(f.options, ports(f));
  for (const input of [{ passed: true }, { identity: f.identity }, { observedAt: '2026-10-10T06:01:00.000Z' }]) await assert.rejects(reader.readPublication(input), reject('invalid-request'));
  assert.equal(f.calls.length, 0);
  for (const edit of [o => { o.executionProfile = 'enterprise'; }, o => { o.expectedIdentityRef.sha256 = hash('other'); }, o => { o.binding.corpusId = 'other'; },
    o => { o.readerId = '*'; }, o => { o.maxPages = 0; }, o => { o.maxRows = 0; }, o => { o.maxVerifications = 0; }, o => { o.sourceIdentityRefs.neo4j = clone(o.sourceIdentityRefs.postgres); }]) {
    const g = fixture(); edit(g.options); assert.throws(() => subject.createReferencePublicationReadback(g.options, ports(g)), reject('invalid-config')); assert.equal(g.calls.length, 0); }
});
test('captured callbacks and config cannot be replaced during await; shared busy rejects concurrent reads', async t => {
  const f = fixture(); let release; const hold = new Promise(resolve => { release = resolve; }); t.after(() => release()); let started;
  const entered = new Promise(resolve => { started = resolve; }); const p = ports(f, p => { const read = p.clock.readTime; let first = true;
    p.clock.readTime = async request => { if (first) { first = false; started(); await hold; } return read(request); }; });
  const reader = subject.createReferencePublicationReadback(f.options, p); const pending = reader.readPublication({}); await entered;
  await assert.rejects(reader.readPublication({}), reject('busy')); f.options.expectedIdentity.graph.pointerRevision = 99;
  let hooks = 0; Object.defineProperty(p.sources, 'readNeo4j', { get() { hooks++; throw new Error('secret-token'); } }); release();
  await pending; assert.equal(hooks, 0);
});
test('expiry during actual IO prevents the next source read and final uncertainty stays inside the bound', async () => {
  const f = fixture(); const p = ports(f, p => { const read = p.sources.readPostgres; p.sources.readPostgres = async request => {
    const result = await read(request); f.clock.advanceTo(f.options.observationWindow.endsAt); return result; }; });
  await assert.rejects(subject.createReferencePublicationReadback(f.options, p).readPublication({}), reject('invalid-clock')); assert.equal(count(f, 'neo4j'), 0);
  const g = fixture(); const q = ports(g, p => { const read = p.clock.readTime; p.clock.readTime = async request => { const result = clone(await read(request)); result.uncertaintyMs = 60001; return result; }; });
  await assert.rejects(subject.createReferencePublicationReadback(g.options, q).readPublication({}), reject('invalid-clock')); assert.equal(count(g, 'postgres'), 0);
});
test('actual clock sequence cannot regress after a successful invocation', async () => {
  const f = fixture(); let regress = false; const p = ports(f, p => { const read = p.clock.readTime; p.clock.readTime = async request => {
    const value = clone(await read(request)); if (regress) value.sequence = 1; return value; }; });
  const reader = subject.createReferencePublicationReadback(f.options, p); await reader.readPublication({}); regress = true;
  await assert.rejects(reader.readPublication({}), reject('invalid-clock')); assert.equal(count(f, 'postgres'), 2);
});
test('UNKNOWN timeout is terminal and late actual fulfillment cannot resume further reads', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 50; let release; let started; const entered = new Promise(resolve => { started = resolve; });
  const p = ports(f, p => { const read = p.sources.readPostgres; p.sources.readPostgres = request => { started(); return new Promise(resolve => {
    let released = false; release = async () => { if (released) return; released = true; resolve(await read(request)); }; }); }; });
  t.after(() => release?.()); const reader = subject.createReferencePublicationReadback(f.options, p); const pending = reader.readPublication({}); await entered;
  await assert.rejects(pending, error => reject('operation-timeout')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); await release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(count(f, 'neo4j'), 0);
});
test('getter/Proxy requests and hostile carrier/payload hooks are never executed or promoted', async () => {
  const f = fixture(); let hooks = 0; const reader = subject.createReferencePublicationReadback(f.options, ports(f));
  await assert.rejects(reader.readPublication({ get label() { hooks++; return true; } }), reject('invalid-request'));
  await assert.rejects(reader.readPublication(new Proxy({}, { ownKeys() { hooks++; return []; } })), reject('invalid-request'));
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
  for (const callback of [() => ({ get then() { hooks++; return () => {}; } }), () => Promise.resolve({ get data() { hooks++; return {}; } })]) {
    const g = fixture(); const p = ports(g, p => { p.sources.readPostgres = callback; }); const r = subject.createReferencePublicationReadback(g.options, p);
    await assert.rejects(r.readPublication({}), error => error.productionAuthorized === false); assert.equal(count(g, 'neo4j'), 0); assert.equal(hooks, 0); }
});

test('constructor-owned source or clock UNKNOWN is preserved and terminal before any second IO', async () => {
  for (const phase of ['clock', 'postgres', 'neo4j', 'milvus']) {
    const f = fixture(); let failedCalls = 0;
    const p = ports(f, p => { const callback = async () => { failedCalls++; throw new subject.PublicationIdentityError('operation-timeout', 'configuration', true); };
      if (phase === 'clock') p.clock.readTime = callback;
      else p.sources[{ postgres: 'readPostgres', neo4j: 'readNeo4j', milvus: 'readMilvusPage' }[phase]] = callback; });
    const reader = subject.createReferencePublicationReadback(f.options, p);
    await assert.rejects(reader.readPublication({}), error => reject('operation-timeout')(error) && error.phase === phase && error.pendingCompletionUnknown === true);
    const calls = f.calls.length;
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(failedCalls, 1); assert.equal(f.calls.length, calls);
  }
});
test('owned UNKNOWN with an invalid caller-supplied code is rebuilt with a static code and current phase', async () => {
  const f = fixture(); const p = ports(f, p => { p.sources.readPostgres = async () => {
    throw new subject.PublicationIdentityError('secret-token', 'secret-token', true); }; });
  const reader = subject.createReferencePublicationReadback(f.options, p);
  await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.phase === 'postgres' && error.pendingCompletionUnknown === true);
  await assert.rejects(reader.readPublication({}), reject('halted'));
});
test('ordinary or forged UNKNOWN rejections stay redacted without reading raw reason getters or Proxy traps', async () => {
  let hooks = 0; const hook = () => { hooks++; throw Error('secret-token'); };
  const owned = new subject.PublicationIdentityError('operation-timeout', 'postgres', true);
  const forged = Object.create(subject.PublicationIdentityError.prototype, { code: { get: hook }, pendingCompletionUnknown: { get: hook }, message: { get: hook } });
  for (const reason of [new Error('secret-token'), new subject.PublicationIdentityError('source-unavailable', 'postgres'), forged,
    new Proxy(owned, { get: hook, getPrototypeOf: hook, ownKeys: hook })]) {
    const f = fixture(); let calls = 0; const p = ports(f, p => { p.sources.readPostgres = async () => { calls++; throw reason; }; });
    const reader = subject.createReferencePublicationReadback(f.options, p);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(reader.readPublication({}), error => reject('operation-failed')(error) && !error.pendingCompletionUnknown);
    assert.equal(calls, 2); assert.equal(count(f, 'neo4j'), 0);
  }
  assert.equal(hooks, 0);
});
test('native factory invalid SDK carrier preserves first UNKNOWN through the reader and forbids every later native IO', async () => {
  const { createNativePublicationSources } = await import('./native-publication-sources.ts');
  const f = fixture(); let calls = 0; let hooks = 0;
  const unused = () => { calls++; throw Error('unexpected-native-IO'); };
  const clients = { postgres: { query() { calls++; return { get then() { hooks++; throw Error('secret-token'); } }; } },
    neo4j: { executeRead: unused }, milvus: { describeCollection: unused, describeIndex: unused, query: unused } };
  const options = clone(f.sourceOptions); delete options.data;
  const sources = createNativePublicationSources({ ...options, native: { operationTimeoutMs: 1000, maxReads: 16,
    milvus: { pageSize: 128, maxRows: 16, maxTotalRowBytes: 65536, maxQueryParameterBytes: 65536 } } }, clients);
  const reader = subject.createReferencePublicationReadback(f.options, { sources, clock: f.clock });
  await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown === true);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(calls, 1); assert.equal(hooks, 0);
});

test('native UNKNOWN settling after the outer deadline cannot become a known-completed timeout', async t => {
  const { createNativePublicationSources } = await import('./native-publication-sources.ts');
  const f = fixture(); f.options.operationTimeoutMs = 20; let calls = 0; let hooks = 0; let completed = false; let release;
  const background = new Promise(resolve => { release = resolve; }).then(() => { completed = true; }); t.after(() => release());
  const unused = () => { calls++; throw Error('unexpected-native-IO'); };
  const clients = { postgres: { query() { calls++; const until = performance.now() + 80;
    while (performance.now() < until) { /* Synchronous SDK work outruns timers, while concealed work stays pending. */ }
    return { get then() { hooks++; throw Error('secret-token'); } }; } },
    neo4j: { executeRead: unused }, milvus: { describeCollection: unused, describeIndex: unused, query: unused } };
  const options = clone(f.sourceOptions); delete options.data;
  const sources = createNativePublicationSources({ ...options, native: { operationTimeoutMs: 1000, maxReads: 16,
    milvus: { pageSize: 128, maxRows: 16, maxTotalRowBytes: 65536, maxQueryParameterBytes: 65536 } } }, clients);
  const reader = subject.createReferencePublicationReadback(f.options, { sources, clock: f.clock });
  await assert.rejects(reader.readPublication({}), error => reject('operation-timeout')(error) && error.pendingCompletionUnknown === true);
  assert.equal(completed, false); await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(calls, 1); assert.equal(hooks, 0);
  release(); await background; assert.equal(completed, true); await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(calls, 1);
});
