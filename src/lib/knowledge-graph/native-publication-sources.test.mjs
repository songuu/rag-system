import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Record as Neo4jRecord, int } from 'neo4j-driver';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { canonicalJson, canonicalJsonSha256: hash } = await import('../rag/eval/canonical-json.ts');
const { createReferenceAuthorityClock } = await import('../rag/eval/production-authority-ports.ts');
const { PublicationIdentityError, createReferencePublicationReadback } = await import('./publication-identity.ts');
const { PostgresKnowledgeGraphPublicationReadback } = await import('./postgres-publication-readback.ts');
const { Neo4jKnowledgeGraphPublicationReadback } = await import('./neo4j-publication-readback.ts');
const { MilvusKnowledgeGraphPublicationReadback } = await import('./milvus-publication-readback.ts');
let subject;
try { subject = await import('./native-publication-sources.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const success = () => ({ error_code: 'Success', code: 0, reason: '' });
function fixture(count = 3) {
  const scope = { environment: 'local-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const binding = { ...scope, runNonce: '1'.repeat(32), manifestHash: hash('manifest') };
  const document = { documentId: '课程/甲', documentVersion: '版本/一', trustLevel: 'trusted' };
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: 3 };
  const artifactDigest = `sha256:${hash('artifact')}`;
  const manifest = { schemaVersion: 'kg-build-publication-manifest/v1', tenantId: scope.tenantId, corpusId: scope.corpusId,
    graphVersion: pointer.graphVersion, artifactDigest, documents: [document] };
  const pg = { pointer, outbox: { ...pointer, eventType: 'graph.snapshot.activated', publishedAt: '2026-10-10T06:00:00.000Z', deadLetteredAt: null },
    buildJob: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: pointer.graphVersion, status: 'published', artifactDigest, publicationManifest: manifest } };
  const neo = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: pointer.graphVersion, status: 'active', artifactDigest,
    documentCount: 1, documents: [{ ...document, tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: pointer.graphVersion, status: 'staging' }] };
  const field = (name, data_type, fieldID, extra = {}) => ({ name, data_type, fieldID: String(fieldID), autoID: false, is_primary_key: name === 'id', description: '',
    dataType: { VarChar: 21, Int64: 5, FloatVector: 101 }[data_type], _placeholderType: { VarChar: 21, Int64: 5, FloatVector: 101 }[data_type], index_params: [],
    type_params: data_type === 'VarChar' ? [{ key: 'max_length', value: '65535' }] : [], ...(data_type === 'VarChar' ? { max_length: '65535' } : {}), ...extra });
  const schema = { status: success(), collection_name: 'dense_a', collectionID: '9007199254740993', consistency_level: 'Strong',
    schema: { name: 'dense_a', autoID: false, enable_dynamic_field: false, description: '', functions: [], fields: [
      ...['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level'].map((name, i) => field(name, 'VarChar', i + 1)),
      field('chunk_index', 'Int64', 8), field('total_chunks', 'Int64', 9), field('embedding', 'FloatVector', 10, { dim: '768', type_params: [{ key: 'dim', value: '768' }] }),
      field('metadata_json', 'VarChar', 11), field('source', 'VarChar', 12), field('created_at', 'Int64', 13)] } };
  const indexes = { status: success(), index_descriptions: [{ index_name: 'embedding_idx', indexID: '9007199254740994', field_name: 'embedding',
    params: [{ key: 'index_type', value: 'HNSW' }, { key: 'metric_type', value: 'COSINE' }], state: 'Finished', index_state_fail_reason: '',
    indexed_rows: String(count), total_rows: String(count), pending_index_rows: '0' }] };
  const rows = Array.from({ length: count }, (_, index) => ({ id: `chunk-${index}`, content: `passage ${index}`, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    document_id: document.documentId, document_version: document.documentVersion, trust_level: document.trustLevel, chunk_index: String(index), total_chunks: String(count) }));
  const calls = []; let scans = 0;
  const clients = { postgres: { query(sql, values) { calls.push('postgres'); assert.deepEqual(values, ['tenant-a', 'corpus-a']); assert.doesNotMatch(sql, /课程|graph-a/);
    return Promise.resolve({ rows: [{ publication: clone(pg) }], rowCount: 1 }); } },
    neo4j: { executeRead(operation, work) { return work({ run(text, params) { calls.push('neo4j'); assert.deepEqual(params, { tenantId: 'tenant-a', corpusId: 'corpus-a' });
      const p = clone(pointer); p.revision = int(3); const s = clone(neo); s.documentCount = int(s.documentCount);
      return Promise.resolve({ records: [new Neo4jRecord(['pointer', 'snapshot'], [p, s])], summary: {} }); } }); } },
    milvus: { describeCollection() { calls.push('milvus-schema'); return Promise.resolve(clone(schema)); }, describeIndex() { calls.push('milvus-index'); return Promise.resolve(clone(indexes)); },
      query(request) { request.expr = request.filter; request.expr_template_values = {}; calls.push('milvus-query');
        if (request.output_fields[0] === 'count(*)') return Promise.resolve({ status: success(), data: [{ 'count(*)': String(rows.length) }] });
        if (!request.exprValues.seenIds) scans++;
        const seen = new Set(request.exprValues.seenIds ?? []);
        // Model the SDK's requested limit without materializing an unrequested
        // full-table result on every page. Filtering/order/results stay exact.
        const data = [];
        for (const row of rows) {
          if (!seen.has(row.id)) data.push(row);
          if (data.length === request.limit) break;
        }
        return Promise.resolve({ status: success(), data }); } } };
  const sourceOptions = { executionProfile: 'local-reference', binding, readerId: 'publication-reader', readerAuthorizationDigest: hash('read-only-role'),
    selector: { scope, graphVersion: 'graph-a', collection: 'dense_a' }, sourceIdentityRefs: { postgres: ref('pg-source'), neo4j: ref('neo-source'), milvus: ref('mil-source') },
    validFrom: '2026-10-10T06:00:00.000Z', validUntil: '2026-10-10T06:05:00.000Z', maxReads: 4096, pageSize: 2,
    native: { operationTimeoutMs: 30000, maxReads: 128, milvus: { pageSize: 128, maxRows: 65536, maxTotalRowBytes: 64 * 1024 * 1024, maxQueryParameterBytes: 64 * 1024 * 1024 } } };
  let nonce = 0;
  const request = (cursor = null) => ({ context: { executionProfile: 'local-reference', binding: clone(binding), actorId: sourceOptions.readerId,
    authorizationDigest: sourceOptions.readerAuthorizationDigest, observedAt: '2026-10-10T06:01:00.000Z' }, selector: clone(sourceOptions.selector), requestNonce: (++nonce).toString(16).padStart(32, '0'), cursor });
  return { scope, document, binding, pg, neo, rows, schema, indexes, calls, clients, sourceOptions, request, scans: () => scans };
}
const rejects = code => error => error instanceof PublicationIdentityError && error.code === code && error.productionAuthorized === false
  && error.automaticRetryAllowed === false && !/secret-token|tenant-a|课程|passage/.test(error.message);
async function completeScan(source, f) {
  let cursor = null; const pages = []; do { const page = await source.readMilvusPage(f.request(cursor)); pages.push(page); cursor = page.data.nextCursor; } while (cursor !== null); return pages;
}
function identity(f, page) { return { schemaVersion: 'kg-publication-identity/v1', scope: f.scope,
  graph: { graphVersion: 'graph-a', artifactDigest: f.pg.buildJob.artifactDigest, pointerRevision: 3 },
  documents: [{ ...f.document, expectedChunkCount: f.rows.length, contentManifestHash: null }],
  milvus: { collection: 'dense_a', schemaManifestHash: hash(page.data.schemaManifest), indexManifestHash: hash(page.data.indexManifest) } }; }
function reader(f, source, expected) {
  const clockRef = ref('publication-clock');
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: f.scope, allowedActorIds: [f.sourceOptions.readerId], sourceIdentityRef: clockRef,
    initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 4096, maxAdvanceMs: 86400000 });
  return createReferencePublicationReadback({ executionProfile: 'local-reference', binding: f.binding, expectedIdentity: expected,
    expectedIdentityRef: { ...ref('identity-a'), sha256: hash(expected) }, readerId: f.sourceOptions.readerId, readerAuthorizationDigest: f.sourceOptions.readerAuthorizationDigest,
    sourceIdentityRefs: f.sourceOptions.sourceIdentityRefs, clockIdentityRef: clockRef, maxClockUncertaintyMs: 0,
    observationWindow: { startsAt: f.sourceOptions.validFrom, endsAt: f.sourceOptions.validUntil }, operationTimeoutMs: 30000, maxVerifications: 2, maxPages: 1024, maxRows: 65536 },
  { sources: source, clock });
}

test('fake SDK limit does not inspect an unrequested row suffix', async () => {
  const f = fixture(); let suffixReads = 0;
  Object.defineProperty(f.rows[1], 'id', { get() { suffixReads++; throw Error('Unrequested synthetic row was inspected'); } });
  const result = await f.clients.milvus.query({ filter: 'synthetic', exprValues: {}, output_fields: ['id'], limit: 1 });
  assert.deepEqual(result.data, [f.rows[0]]); assert.equal(suffixReads, 0);
});

test('fake SDK bounded pages retain filter and slice results for nonprefix seen sets', async () => {
  const f = fixture(7);
  for (const limit of [1, 2, 7, 128]) for (const ids of [undefined, [], ['chunk-0'], ['chunk-1'], ['chunk-5', 'chunk-2'], ['missing']]) {
    const seen = new Set(ids ?? []), expected = f.rows.filter(row => !seen.has(row.id)).slice(0, limit);
    const result = await f.clients.milvus.query({ filter: 'synthetic', exprValues: ids === undefined ? {} : { seenIds: ids }, output_fields: ['id'], limit });
    assert.deepEqual(result.data, expected);
  }
});

test('native source factory entry point exists', () => { assert.equal(typeof subject.createNativePublicationSources, 'function'); });

test('direct native data is privately paged with exact local proof and a fresh bulk for each null cursor', async () => {
  const f = fixture(); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients);
  const pg = await source.readPostgres(f.request()); assert.equal(pg.data.buildJob.documents[0].documentId, '课程/甲');
  const neo = await source.readNeo4j(f.request()); assert.equal(neo.data.snapshot.documents.length, 1);
  const first = await completeScan(source, f); const second = await completeScan(source, f);
  assert.equal(f.scans(), 2); assert.equal(first.length, 2); assert.equal(second.length, 2);
  for (const page of [...first, ...second, pg, neo]) {
    assert.equal(page.proof.productionSourceAuthenticated, false); assert.equal(page.proof.assurance, 'local-reference'); assert.equal(page.proof.dataHash, hash(page.data));
    assert.ok(Object.isFrozen(page)); assert.ok(Buffer.byteLength(canonicalJson(page)) < 128 * 1024);
  }
  assert.notEqual(first[0].data.nextCursor, second[0].data.nextCursor); assert.equal(source.productionCapable, false);
});

test('native sources execute the existing whole reader order and observe drift on a new scan', async () => {
  const f = fixture(); const warm = subject.createNativePublicationSources(f.sourceOptions, f.clients); const seed = (await completeScan(warm, f))[0];
  const expected = identity(f, seed); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); f.calls.length = 0;
  const result = await reader(f, source, expected).readPublication({}); assert.equal(result.rowCount, 3); assert.equal(result.productionAuthorized, false);
  assert.deepEqual(f.calls.filter(call => call === 'postgres' || call === 'neo4j' || call === 'milvus-schema'),
    ['postgres', 'neo4j', 'milvus-schema', 'milvus-schema', 'milvus-schema', 'milvus-schema', 'neo4j', 'postgres']);
  const g = fixture(); const ready = subject.createNativePublicationSources(g.sourceOptions, g.clients); const before = (await completeScan(ready, g))[0];
  const query = g.clients.milvus.query; let fresh = 0;
  g.clients.milvus.query = request => { if (request.output_fields[0] !== 'count(*)' && !request.exprValues.seenIds && ++fresh === 2) g.rows[0].content = 'changed'; return query(request); };
  await assert.rejects(reader(g, subject.createNativePublicationSources(g.sourceOptions, g.clients), identity(g, before)).readPublication({}), rejects('unstable-publication'));
});

test('65536 actual native fake-SDK rows complete two full scans through the existing reader', async () => {
  const f = fixture(65536); f.sourceOptions.pageSize = 128;
  const seedSource = subject.createNativePublicationSources(f.sourceOptions, f.clients); const seed = (await completeScan(seedSource, f))[0];
  const expected = identity(f, seed); const before = f.scans(); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients);
  const result = await reader(f, source, expected).readPublication({}); assert.equal(result.rowCount, 65536); assert.equal(f.scans() - before, 2);
  assert.equal(result.readbacks.length, 1028); assert.equal(result.consistencyVerified, true); assert.equal(result.sourceAuthenticated, false);
});

test('request binding, selector, actor, nonce and windows reject before any business IO', async () => {
  const f = fixture(); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); let hooks = 0;
  const edits = [r => { r.context.binding.tenantId = 'other'; }, r => { r.context.actorId = 'other'; }, r => { r.context.authorizationDigest = 'b'.repeat(64); },
    r => { r.context.executionProfile = 'enterprise'; }, r => { r.selector.scope.corpusId = 'other'; }, r => { r.selector.graphVersion = 'other'; },
    r => { r.selector.collection = 'other'; }, r => { r.context.observedAt = f.sourceOptions.validUntil; }, r => { r.context.observedAt = '2026-10-10T05:59:59.999Z'; },
    r => { r.requestNonce = 'x'; }, r => { r.extra = true; }, r => { r.cursor = 'a'.repeat(64); }];
  for (const edit of edits) { const r = f.request(); edit(r); await assert.rejects(source.readPostgres(r), rejects('invalid-request')); }
  for (const r of [{ get context() { hooks++; return {}; } }, new Proxy({}, { ownKeys() { hooks++; return []; } })]) await assert.rejects(source.readPostgres(r), rejects('invalid-request'));
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
  const r = f.request(); await source.readPostgres(r); const calls = f.calls.length;
  await assert.rejects(source.readNeo4j(r), rejects('source-replay')); assert.equal(f.calls.length, calls);
  const old = f.request(); old.context.observedAt = '2026-10-10T06:00:59.999Z'; await assert.rejects(source.readNeo4j(old), rejects('invalid-request'));
});

test('cursors are consumed once, cannot cross factories, and unfinished null never mixes scans', async () => {
  const f = fixture(); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients);
  const first = await source.readMilvusPage(f.request()); const token = first.data.nextCursor; const calls = f.calls.length;
  await assert.rejects(source.readMilvusPage(f.request()), rejects('invalid-request')); assert.equal(f.calls.length, calls);
  const other = subject.createNativePublicationSources(f.sourceOptions, f.clients);
  await assert.rejects(other.readMilvusPage(f.request(token)), rejects('invalid-request')); assert.equal(f.calls.length, calls);
  const second = await source.readMilvusPage(f.request(token)); assert.equal(second.data.completion, 'complete');
  await assert.rejects(source.readMilvusPage(f.request(token)), rejects('invalid-request')); assert.equal(f.calls.length, calls);
});

test('adaptive byte pages never snapshot the whole bulk and a single oversized encoded row fails explicitly', async () => {
  const f = fixture(4); f.sourceOptions.pageSize = 128; f.rows.forEach(row => { row.content = 'x'.repeat(60000); });
  const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); const pages = await completeScan(source, f);
  assert.equal(pages.reduce((sum, page) => sum + page.data.rows.length, 0), 4); assert.equal(pages.length, 2);
  assert.ok(pages.every(page => Buffer.byteLength(canonicalJson(page)) < 128 * 1024));
  const g = fixture(); g.rows[0].content = '\u0000'.repeat(65536);
  await assert.rejects(subject.createNativePublicationSources(g.sourceOptions, g.clients).readMilvusPage(g.request()), rejects('source-capacity'));
});

test('frozen options and captured native/client methods survive replacement without invoking getters', async t => {
  const f = fixture(); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); let hooks = 0;
  for (const native of [PostgresKnowledgeGraphPublicationReadback, Neo4jKnowledgeGraphPublicationReadback, MilvusKnowledgeGraphPublicationReadback]) {
    const descriptor = Object.getOwnPropertyDescriptor(native.prototype, 'readPublication');
    t.after(() => Object.defineProperty(native.prototype, 'readPublication', descriptor));
    Object.defineProperty(native.prototype, 'readPublication', { configurable: true, get() { hooks++; throw new Error('secret-token'); } });
  }
  f.sourceOptions.binding.tenantId = 'other'; f.sourceOptions.selector.collection = 'other';
  Object.defineProperty(f.clients.postgres, 'query', { get() { hooks++; throw new Error('secret-token'); } });
  const r = f.request(); r.context.binding.tenantId = 'tenant-a'; r.selector.scope.tenantId = 'tenant-a'; r.selector.collection = 'dense_a';
  const data = await source.readPostgres(r); assert.equal(data.data.scope.tenantId, 'tenant-a'); assert.equal(hooks, 0);
});

test('closed config, descriptor-safe clients and source/native read budgets remain independent', async () => {
  for (const edit of [o => { o.executionProfile = 'enterprise'; }, o => { o.extra = true; }, o => { o.data = {}; }, o => { o.selector.scope.tenantId = 'other'; },
    o => { o.sourceIdentityRefs.neo4j = clone(o.sourceIdentityRefs.postgres); }, o => { o.maxReads = 4097; }, o => { o.native.maxReads = 129; }, o => { o.native.extra = true; }]) {
    const f = fixture(); edit(f.sourceOptions); assert.throws(() => subject.createNativePublicationSources(f.sourceOptions, f.clients), rejects('invalid-config')); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); let hooks = 0; assert.throws(() => subject.createNativePublicationSources(f.sourceOptions, { ...f.clients, get postgres() { hooks++; return f.clients.postgres; } }), rejects('invalid-config')); assert.equal(hooks, 0);
  const g = fixture(); g.sourceOptions.maxReads = 1; const limited = subject.createNativePublicationSources(g.sourceOptions, g.clients);
  await limited.readPostgres(g.request()); await assert.rejects(limited.readNeo4j(g.request()), rejects('source-capacity')); assert.deepEqual(g.calls, ['postgres']);
  const h = fixture(); h.sourceOptions.native.maxReads = 1; const nativeLimited = subject.createNativePublicationSources(h.sourceOptions, h.clients);
  await nativeLimited.readPostgres(h.request()); await assert.rejects(nativeLimited.readPostgres(h.request()), rejects('read-limit')); assert.deepEqual(h.calls, ['postgres']);
});

test('a direct native UNKNOWN propagates safely and halts every source, late completion does not restore state', async t => {
  const f = fixture(); f.sourceOptions.native.operationTimeoutMs = 30; let release; let entered; let calls = 0;
  const dispatched = new Promise(resolve => { entered = resolve; });
  f.clients.postgres.query = () => { calls++; entered(); return new Promise(resolve => { release = () => resolve({ rows: [{ publication: clone(f.pg) }], rowCount: 1 }); }); };
  t.after(() => release?.()); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); const pending = source.readPostgres(f.request()); await dispatched;
  await assert.rejects(source.readNeo4j(f.request()), rejects('busy'));
  await assert.rejects(pending, error => rejects('operation-timeout')(error) && error.pendingCompletionUnknown); release(); await new Promise(resolve => setImmediate(resolve));
  for (const method of ['readPostgres', 'readNeo4j', 'readMilvusPage']) await assert.rejects(source[method](f.request()), rejects('halted'));
  assert.equal(calls, 1); assert.equal(f.calls.length, 0);
});

test('SDK rejection stays redacted and request challenge is burned without automatic retry', async () => {
  const f = fixture(); let calls = 0; f.clients.postgres.query = () => { calls++; return Promise.reject(new Error('secret-token')); };
  const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); const r = f.request();
  await assert.rejects(source.readPostgres(r), rejects('operation-failed')); await assert.rejects(source.readPostgres(r), rejects('source-replay')); assert.equal(calls, 1);
});

test('all exposed proof bindings remain deeply immutable across subsequent native reads', async () => {
  const f = fixture(); const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); const first = await source.readPostgres(f.request());
  for (const value of [first.proof, first.proof.sourceIdentityRef, first.proof.context, first.proof.context.binding, first.proof.selector, first.proof.selector.scope]) assert.ok(Object.isFrozen(value));
  assert.equal(Reflect.set(first.proof.sourceIdentityRef, 'objectId', 'mutated'), false);
  const second = await source.readPostgres(f.request()); assert.equal(canonicalJson(second.proof.sourceIdentityRef), canonicalJson(f.sourceOptions.sourceIdentityRefs.postgres));
});

test('native business superset versions and trust are returned rather than hidden by source selectors', async () => {
  const f = fixture(); f.rows[1].document_version = 'unexpected/版本'; f.rows[2].trust_level = 'quarantined';
  const source = subject.createNativePublicationSources(f.sourceOptions, f.clients); const pages = await completeScan(source, f);
  const rows = pages.flatMap(page => page.data.rows); assert.equal(rows.length, 3);
  assert.ok(rows.some(row => row.document_version === 'unexpected/版本')); assert.ok(rows.some(row => row.trust_level === 'quarantined'));
  const expected = identity(f, pages[0]); await assert.rejects(reader(f, subject.createNativePublicationSources(f.sourceOptions, f.clients), expected).readPublication({}), rejects('identity-mismatch'));
});

test('malformed native promise UNKNOWN halts all source methods without invoking carrier hooks', async () => {
  const f = fixture(); let hooks = 0; let calls = 0;
  f.clients.postgres.query = () => { calls++; return { get then() { hooks++; throw new Error('secret-token'); } }; };
  const source = subject.createNativePublicationSources(f.sourceOptions, f.clients);
  await assert.rejects(source.readPostgres(f.request()), error => rejects('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  for (const method of ['readPostgres', 'readNeo4j', 'readMilvusPage']) await assert.rejects(source[method](f.request()), rejects('halted'));
  assert.equal(calls, 1); assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
});
