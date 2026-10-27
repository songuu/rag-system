import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { canonicalJson, canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { createReferenceAuthorityClock } = await import('./production-authority-ports.ts');
const { createReferencePublicationReadback, PublicationIdentityError } = await import('../../knowledge-graph/publication-identity.ts');
let subject;
try { subject = await import('./production-publication-state-observer.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const contentHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const chunkManifest = rows => hash([...rows].sort((a, b) => a.chunk_index - b.chunk_index || compare(a.id, b.id))
  .map(row => ({ chunkId: row.id, chunkIndex: row.chunk_index, contentSha256: contentHash(row.content) })));

function fixture() {
  const scope = { environment: 'disposable-lab', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const binding = { ...scope, runNonce: 'a'.repeat(32), manifestHash: hash('publication-lab') };
  const doc = { documentId: '课程/😀', documentVersion: '版本/一', trustLevel: 'trusted' };
  const rows = [0, 1].map(index => ({ id: `chunk/${index}`, content: `Synthetic secret passage ${index}`, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    document_id: doc.documentId, document_version: doc.documentVersion, trust_level: doc.trustLevel, chunk_index: index, total_chunks: 2 }));
  const schemaManifest = { fields: ['id', 'content', 'tenant_id', 'corpus_id'] }; const indexManifest = { type: 'FLAT', metric: 'COSINE' };
  const identity = { schemaVersion: 'kg-publication-identity/v1', scope, graph: { graphVersion: 'graph-a', artifactDigest: `sha256:${hash('artifact')}`, pointerRevision: 1 },
    documents: [{ ...doc, expectedChunkCount: 2, contentManifestHash: chunkManifest(rows) }],
    milvus: { collection: 'lab_collection', schemaManifestHash: hash(schemaManifest), indexManifestHash: hash(indexManifest) } };
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: 1 };
  const data = { postgres: { scope, pointer, outbox: { ...pointer, eventType: 'graph.snapshot.activated', publishedAt: '2026-10-10T06:00:00.000Z', deadLetteredAt: null },
    buildJob: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'published', artifactDigest: identity.graph.artifactDigest, documents: [doc] } },
    neo4j: { scope, pointer, snapshot: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'active', artifactDigest: identity.graph.artifactDigest, documents: [doc] } },
    milvus: { scope, collection: identity.milvus.collection, schemaManifest, indexManifest, rows } };
  const refs = Object.fromEntries(['postgres', 'neo4j', 'milvus'].map(source => [source, ref(`${source}-source`)]));
  const clockRef = ref('publication-clock'); const calls = []; let pageSize = 1; let edit;
  const readerOptions = { executionProfile: 'local-reference', binding, expectedIdentity: identity, expectedIdentityRef: { ...ref('identity'), sha256: hash(identity) },
    readerId: 'publication-reader', readerAuthorizationDigest: hash('read-only-role'), sourceIdentityRefs: refs, clockIdentityRef: clockRef,
    maxClockUncertaintyMs: 0, observationWindow: { startsAt: '2026-10-10T06:00:00.000Z', endsAt: '2026-10-10T06:05:00.000Z' },
    operationTimeoutMs: 1000, maxVerifications: 4, maxPages: 8, maxRows: 16 };
  const proof = (source, value, request) => ({ data: value, proof: { schemaVersion: 'kg-publication-source-proof/v1', source, assurance: 'local-reference',
    productionSourceAuthenticated: false, sourceIdentityRef: refs[source], context: request.context, selector: request.selector,
    requestNonce: request.requestNonce, cursor: request.cursor, dataHash: hash(value) } });
  const sources = { executionProfile: 'local-reference', productionCapable: false };
  for (const [method, source] of [['readPostgres', 'postgres'], ['readNeo4j', 'neo4j'], ['readMilvusPage', 'milvus']]) sources[method] = async request => {
    calls.push({ source, request: clone(request) }); let value;
    if (source !== 'milvus') value = clone(data[source]);
    else { const offset = request.cursor === null ? 0 : Number.parseInt(request.cursor, 16); const end = Math.min(offset + pageSize, data.milvus.rows.length);
      const nextCursor = end < data.milvus.rows.length ? end.toString(16).padStart(64, '0') : null;
      value = { ...clone(data.milvus), rows: clone(data.milvus.rows.slice(offset, end)), completion: nextCursor === null ? 'complete' : 'more', nextCursor }; }
    const result = proof(source, value, request); edit?.(result, source, request); return result;
  };
  const localClock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [readerOptions.readerId], sourceIdentityRef: clockRef,
    initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 10000, maxAdvanceMs: 86400000 });
  const clock = { executionProfile: 'local-reference', productionCapable: false, readTime(request) { calls.push({ source: 'clock', request: clone(request) }); return localClock.readTime(request); } };
  const options = { readerOptions, challengeNonce: 'b'.repeat(32), maxObservations: 32, operationTimeoutMs: 1000 };
  return { data, rows, identity, options, readerOptions, calls, ports: { sources, clock }, proof, setPageSize(size) { pageSize = size; }, edit(value) { edit = value; } };
}
const create = f => subject.createIsolatedPublicationStateObserver(f.options, f.ports);
const count = (f, source) => f.calls.filter(call => call.source === source).length;
const rejected = code => error => error instanceof subject.PublicationStateObserverError && error.code === code && Object.isFrozen(error)
  && !/Synthetic|secret-token|tenant-a|课程/.test(error.message);

test('observer exports a local frozen full-state API, exact independent manifest, and no content text', async () => {
  const f = fixture(); const observer = create(f); const result = await observer.observeActualState({});
  assert.deepEqual(Object.keys(observer).sort(), ['close', 'executionProfile', 'observeActualState', 'productionCapable']);
  assert.ok(Object.isFrozen(observer)); assert.equal(observer.executionProfile, 'local-reference'); assert.equal(observer.productionCapable, false);
  assert.deepEqual(Object.keys(result).sort(), ['projection', 'rowCount', 'rowsManifestHash', 'stateHash']);
  assert.equal(result.stateHash, hash(result.projection)); assert.equal(result.rowCount, 2);
  assert.equal(result.rowsManifestHash, hash([{ documentId: f.identity.documents[0].documentId, documentVersion: '版本/一', trustLevel: 'trusted', chunkCount: 2,
    contentManifestHash: chunkManifest(f.rows) }]));
  assert.deepEqual(Object.keys(result.projection).sort(), ['milvus', 'neo4j', 'postgres']);
  assert.deepEqual(Object.keys(result.projection.milvus.rows[0]).sort(), ['chunkId', 'chunkIndex', 'contentSha256', 'corpusId', 'documentId', 'documentVersion', 'tenantId', 'totalChunks', 'trustLevel']);
  assert.ok(Object.isFrozen(result.projection.milvus.rows[0])); assert.doesNotMatch(JSON.stringify(result), /Synthetic secret passage/);
  assert.equal(count(f, 'postgres'), 1); assert.equal(count(f, 'neo4j'), 1); assert.equal(count(f, 'milvus'), 2); assert.equal(count(f, 'clock'), 4);
  const decision = await createReferencePublicationReadback(f.readerOptions, f.ports).readPublication({});
  assert.equal(result.rowsManifestHash, decision.rowsManifestHash); assert.equal(result.rowCount, decision.rowCount);
});

test('full superset, incomplete subset, duplicate multiset, deactivated and empty observations do not claim legality or hide state', async () => {
  const f = fixture(); const observer = create(f); const baseline = await observer.observeActualState({});
  f.rows.push({ ...f.rows[0], id: 'extra/version', document_version: '版本/二', total_chunks: 1 });
  const extra = await observer.observeActualState({}); assert.equal(extra.rowCount, 3); assert.notEqual(extra.stateHash, baseline.stateHash);
  assert.ok(extra.projection.milvus.rows.some(row => row.documentVersion === '版本/二'));
  f.rows.pop(); f.rows.pop(); const missing = await observer.observeActualState({}); assert.equal(missing.rowCount, 1); assert.notEqual(missing.rowsManifestHash, baseline.rowsManifestHash);
  f.rows.push(clone(f.rows[0])); const duplicate = await observer.observeActualState({}); assert.equal(duplicate.rowCount, 2);
  assert.deepEqual(duplicate.projection.milvus.rows[0], duplicate.projection.milvus.rows[1]); assert.notEqual(duplicate.stateHash, baseline.stateHash);
  f.data.neo4j.snapshot.status = 'inactive'; const inactive = await observer.observeActualState({}); assert.equal(inactive.projection.neo4j.snapshot.status, 'inactive');
  f.rows.splice(0); const empty = await observer.observeActualState({}); assert.equal(empty.rowCount, 0); assert.equal(empty.rowsManifestHash, hash([]));
});

test('ordering normalizes documents and all row keys without dropping exact business fields', async () => {
  const f = fixture(); const extraDoc = { documentId: '另一课程', documentVersion: 'v2', trustLevel: 'external' };
  f.data.postgres.buildJob.documents.push(extraDoc); f.data.neo4j.snapshot.documents.push(extraDoc); f.rows.reverse();
  const observer = create(f); const first = await observer.observeActualState({});
  f.data.postgres.buildJob.documents.reverse(); f.data.neo4j.snapshot.documents.reverse(); f.rows.reverse();
  assert.equal((await observer.observeActualState({})).stateHash, first.stateHash);
  f.data.postgres.outbox.publishedAt = '2026-10-10T06:00:01.000Z';
  assert.notEqual((await observer.observeActualState({})).stateHash, first.stateHash);
});

test('proof exact context, selector, challenge, cursor, source, identity and data hash mismatch fail before later IO', async () => {
  for (const edit of [r => { r.proof.context.binding.runNonce = 'd'.repeat(32); }, r => { r.proof.context.authorizationDigest = hash('wrong'); },
    r => { r.proof.context.actorId = 'other'; }, r => { r.proof.context.observedAt = '2026-10-10T06:02:00.000Z'; },
    r => { r.proof.selector.collection = 'other'; }, r => { r.proof.requestNonce = 'c'.repeat(32); }, r => { r.proof.cursor = '0'.repeat(64); },
    r => { r.proof.source = 'neo4j'; }, r => { r.proof.sourceIdentityRef = ref('other'); }, r => { r.proof.dataHash = hash('wrong'); },
    r => { r.proof.extra = true; }]) {
    const f = fixture(); f.edit((r, source) => { if (source === 'postgres') { r.proof = clone(r.proof); edit(r); } });
    await assert.rejects(create(f).observeActualState({}), rejected('invalid-proof')); assert.equal(count(f, 'neo4j'), 0); assert.equal(count(f, 'milvus'), 0);
  }
});

test('cross-scope rows, graph scope and unexpected shape are not silently filtered', async () => {
  for (const change of [f => { f.data.postgres.scope = { ...f.data.postgres.scope, tenantId: 'foreign' }; }, f => { f.rows[0].tenant_id = 'foreign'; },
    f => { f.rows[0].extra = true; }, f => { f.rows[0].document_version = ' 版本/一'; }, f => { f.data.neo4j.snapshot.extra = 'secret-token'; }]) {
    const f = fixture(); change(f); await assert.rejects(create(f).observeActualState({}), rejected('invalid-state'));
  }
});

test('only complete empty pages terminate; loop, empty-middle, inconsistent manifests and exhausted page/row budgets reject a prefix', async () => {
  for (const [edit, expected] of [
    [r => { r.data.rows = []; r.data.completion = 'more'; }, 'invalid-state'],
    [(r, request) => { if (request.cursor !== null) { r.data.nextCursor = request.cursor; r.data.completion = 'more'; } }, 'invalid-state'],
    [(r, request) => { if (request.cursor !== null) r.data.indexManifest.type = 'HNSW'; }, 'invalid-state'],
    [r => { r.data.rows = Array.from({ length: 129 }, () => clone(r.data.rows[0])); }, 'read-limit'],
  ]) {
    const f = fixture(); f.edit((r, source, request) => { if (source === 'milvus') { edit(r, request); r.proof.dataHash = hash(r.data); } });
    await assert.rejects(create(f).observeActualState({}), rejected(expected));
  }
  for (const field of ['maxPages', 'maxRows']) { const f = fixture(); f.readerOptions[field] = 1;
    await assert.rejects(create(f).observeActualState({}), rejected('read-limit')); assert.equal(count(f, 'milvus'), field === 'maxPages' ? 1 : 2); }
});

test('fresh deterministic domain-separated challenges bind the challenge and ordinal across observations', async () => {
  const f = fixture(); const observer = create(f); await observer.observeActualState({}); await observer.observeActualState({});
  const nonces = f.calls.map(call => call.request.requestNonce); assert.equal(new Set(nonces).size, nonces.length);
  assert.ok(nonces.every(value => /^[a-f0-9]{32}$/.test(value)));
  const g = fixture(); g.options.challengeNonce = 'c'.repeat(32); await create(g).observeActualState({}); assert.notEqual(g.calls[0].request.requestNonce, nonces[0]);
});

test('configuration and captured methods reject getter or Proxy hooks without executing them', () => {
  for (const field of ['sources', 'clock']) { const f = fixture(); let hooks = 0; const key = field === 'sources' ? 'readPostgres' : 'readTime';
    Object.defineProperty(f.ports[field], key, { get() { hooks++; throw new Error('secret-token'); }, enumerable: true });
    assert.throws(() => create(f), rejected('invalid-config')); assert.equal(hooks, 0); assert.equal(f.calls.length, 0); }
  const f = fixture(); let hooks = 0; f.ports.sources = new Proxy(f.ports.sources, { ownKeys() { hooks++; throw new Error('secret-token'); } });
  assert.throws(() => create(f), rejected('invalid-config')); assert.equal(hooks, 0);
  for (const edit of [o => { o.challengeNonce = 'x'; }, o => { o.maxObservations = 65; }, o => { o.operationTimeoutMs = 0; }, o => { o.extra = true; },
    o => { o.readerOptions.expectedIdentityRef.sha256 = hash('wrong'); }, o => { o.readerOptions.binding.tenantId = 'foreign'; }]) {
    const g = fixture(); edit(g.options); assert.throws(() => create(g), rejected('invalid-config')); assert.equal(g.calls.length, 0);
  }
});

test('captures exact methods and detached options, and enforces observation capacity with no extra IO', async () => {
  const f = fixture(); f.options.maxObservations = 1; const observer = create(f);
  f.ports.sources.readPostgres = () => { throw new Error('secret-token mutated method'); }; f.readerOptions.readerId = 'mutated';
  await observer.observeActualState({}); const calls = f.calls.length;
  await assert.rejects(observer.observeActualState({}), rejected('observation-capacity')); assert.equal(f.calls.length, calls);
});

test('late source completion after whole deadline permanently halts without another clock/source dispatch', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 20; let release; let released = false; const read = f.ports.sources.readPostgres;
  f.ports.sources.readPostgres = request => new Promise(resolve => { release = () => { if (!released) { released = true; read(request).then(resolve); } }; });
  t.after(() => release?.()); const observer = create(f);
  await assert.rejects(observer.observeActualState({}), error => rejected('operation-timeout')(error) && error.pendingCompletionUnknown);
  const calls = f.calls.length; release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(count(f, 'neo4j'), 0); assert.equal(count(f, 'milvus'), 0); assert.equal(count(f, 'clock'), 1);
  assert.equal(f.calls.length, calls + 1); await assert.rejects(observer.observeActualState({}), rejected('halted'));
});

test('external close fences an already pending PG and every later observation without claiming cancellation', async t => {
  const f = fixture(); let release; let released = false; let entered; const entering = new Promise(resolve => { entered = resolve; }); const read = f.ports.sources.readPostgres;
  f.ports.sources.readPostgres = request => new Promise(resolve => { entered(); release = () => { if (!released) { released = true; read(request).then(resolve); } }; });
  t.after(() => release?.()); const observer = create(f); const pending = observer.observeActualState({}); await entering; observer.close(); release();
  await assert.rejects(pending, rejected('halted')); const calls = f.calls.length;
  await assert.rejects(observer.observeActualState({}), rejected('halted')); assert.equal(f.calls.length, calls); assert.equal(count(f, 'clock'), 1); assert.equal(count(f, 'neo4j'), 0);
});

test('late clock and synchronous starvation cannot dispatch even the first or next business source', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 20; let release; let released = false; const readClock = f.ports.clock.readTime;
  f.ports.clock.readTime = request => new Promise(resolve => { release = () => { if (!released) { released = true; readClock(request).then(resolve); } }; }); t.after(() => release?.());
  const observer = create(f); await assert.rejects(observer.observeActualState({}), rejected('operation-timeout')); release();
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(count(f, 'postgres'), 0);
  const g = fixture(); g.options.operationTimeoutMs = 20; const readPg = g.ports.sources.readPostgres;
  g.ports.sources.readPostgres = request => { const start = performance.now(); while (performance.now() - start < 80) { /* Deliberate local CPU starvation. */ } return readPg(request); };
  await assert.rejects(create(g).observeActualState({}), rejected('operation-timeout')); assert.equal(count(g, 'postgres'), 1); assert.equal(count(g, 'clock'), 1); assert.equal(count(g, 'neo4j'), 0);
});

test('invalid native carrier metadata, then getter and Proxy contract violations execute zero hooks and permanently halt UNKNOWN', async () => {
  for (const kind of ['plain-then', 'promise-constructor', 'proxy']) {
    const f = fixture(); let hooks = 0;
    f.ports.sources.readPostgres = () => { const pending = Promise.resolve({});
      if (kind === 'plain-then') return Object.defineProperty({}, 'then', { get() { hooks++; throw new Error('secret-token'); } });
      if (kind === 'promise-constructor') return Object.defineProperty(pending, 'constructor', { get() { hooks++; throw new Error('secret-token'); } });
      return new Proxy(pending, { get() { hooks++; throw new Error('secret-token'); }, getPrototypeOf() { hooks++; throw new Error('secret-token'); } }); };
    const observer = create(f); await assert.rejects(observer.observeActualState({}), error => rejected('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(observer.observeActualState({}), rejected('halted')); assert.equal(hooks, 0); assert.equal(count(f, 'neo4j'), 0); assert.equal(count(f, 'clock'), 1);
  }
});

test('owned source UNKNOWN is conserved; arbitrary rejection reason getters are not adopted or exposed', async () => {
  const f = fixture(); f.ports.sources.readPostgres = () => Promise.reject(new PublicationIdentityError('operation-timeout', 'postgres', true));
  const observer = create(f); await assert.rejects(observer.observeActualState({}), error => rejected('operation-timeout')(error) && error.pendingCompletionUnknown);
  await assert.rejects(observer.observeActualState({}), rejected('halted')); assert.equal(count(f, 'clock'), 1);
  const g = fixture(); let hooks = 0; const reason = new Proxy({}, { get() { hooks++; throw new Error('secret-token'); }, getPrototypeOf() { hooks++; throw new Error('secret-token'); }, ownKeys() { hooks++; throw new Error('secret-token'); } });
  g.ports.sources.readPostgres = () => Promise.reject(reason);
  await assert.rejects(create(g).observeActualState({}), error => rejected('operation-failed')(error) && error.pendingCompletionUnknown === false); assert.equal(hooks, 0);
});

test('a late settled owned UNKNOWN is not downgraded by the shorter outer deadline', async () => {
  const f = fixture(); f.options.operationTimeoutMs = 20;
  f.ports.sources.readPostgres = () => { const start = performance.now(); while (performance.now() - start < 80) { /* Preserve the real 20 ms / 80 ms deadline counterexample. */ }
    return Promise.reject(new PublicationIdentityError('provider-contract-invalid', 'postgres', true)); };
  const observer = create(f); await assert.rejects(observer.observeActualState({}), error => rejected('operation-timeout')(error) && error.pendingCompletionUnknown);
  await assert.rejects(observer.observeActualState({}), rejected('halted')); assert.equal(count(f, 'clock'), 1); assert.equal(count(f, 'neo4j'), 0);
});

test('fulfilled data getters fail without hooks, while own native then getters are never invoked', async () => {
  const f = fixture(); let hooks = 0; f.ports.sources.readPostgres = () => Promise.resolve(Object.defineProperty({ proof: {} }, 'data', {
    enumerable: true, get() { hooks++; throw new Error('secret-token raw data'); } }));
  await assert.rejects(create(f).observeActualState({}), rejected('invalid-state')); assert.equal(hooks, 0); assert.equal(count(f, 'neo4j'), 0);
  const g = fixture(); const read = g.ports.sources.readPostgres;
  g.ports.sources.readPostgres = request => Object.defineProperty(read(request), 'then', { get() { hooks++; throw new Error('secret-token then'); } });
  assert.equal((await create(g).observeActualState({})).rowCount, 2); assert.equal(hooks, 0);
});

test('invalid requests and concurrent observations cannot bypass the dispatch gate', async t => {
  const f = fixture(); let release; let released = false; let enter; const entered = new Promise(resolve => { enter = resolve; }); const read = f.ports.sources.readPostgres;
  f.ports.sources.readPostgres = request => new Promise(resolve => { enter(); release = () => { if (!released) { released = true; read(request).then(resolve); } }; });
  t.after(() => release?.()); const observer = create(f);
  await assert.rejects(observer.observeActualState({ unknown: 'secret-token' }), rejected('invalid-request')); assert.equal(f.calls.length, 0);
  const pending = observer.observeActualState({}); await entered; const before = f.calls.length;
  await assert.rejects(observer.observeActualState({}), rejected('busy')); assert.equal(f.calls.length, before); release(); assert.equal((await pending).rowCount, 2);
});

test('malformed clock correlation rejects before any business read and errors never include provider text', async () => {
  const f = fixture(); const read = f.ports.clock.readTime; f.ports.clock.readTime = async request => { const value = clone(await read(request)); value.requestNonce = 'c'.repeat(32); return value; };
  await assert.rejects(create(f).observeActualState({}), rejected('invalid-clock')); assert.equal(count(f, 'postgres'), 0);
  const g = fixture(); g.ports.sources.readPostgres = () => Promise.reject(new Error('secret-token Synthetic secret passage'));
  await assert.rejects(create(g).observeActualState({}), rejected('operation-failed'));
});

test('streaming state and manifest bind a complete >256 KiB normalized inventory, never a successful prefix', async () => {
  const f = fixture(); const total = 2048; f.readerOptions.maxRows = total; f.readerOptions.maxPages = 16; f.setPageSize(128);
  f.rows.splice(0, f.rows.length, ...Array.from({ length: total }, (_, index) => ({ id: `large/${index}`, content: 'Synthetic capacity content', tenant_id: 'tenant-a', corpus_id: 'corpus-a',
    document_id: '课程/😀', document_version: '版本/一', trust_level: 'trusted', chunk_index: index, total_chunks: total })));
  const observer = create(f); const result = await observer.observeActualState({}); assert.equal(result.rowCount, total); assert.equal(result.projection.milvus.rows.length, total);
  assert.throws(() => canonicalJson(result.projection)); assert.equal(count(f, 'milvus'), 16);
  assert.equal(result.rowsManifestHash, hash([{ documentId: '课程/😀', documentVersion: '版本/一', trustLevel: 'trusted', chunkCount: total, contentManifestHash: chunkManifest(f.rows) }]));
  f.rows[total - 1].content = 'Synthetic last-row change'; const changed = await observer.observeActualState({}); assert.notEqual(changed.stateHash, result.stateHash); assert.notEqual(changed.rowsManifestHash, result.rowsManifestHash);
});

test('the finite normalized-byte ceiling rejects the whole observed inventory rather than hashing a prefix', async () => {
  const f = fixture(); const total = 65536; f.options.operationTimeoutMs = 30000; f.readerOptions.operationTimeoutMs = 30000;
  f.readerOptions.maxRows = total; f.readerOptions.maxPages = 1024; let pages = 0; let generated = 0;
  const documentId = '文'.repeat(512); const documentVersion = '版'.repeat(512);
  f.ports.sources.readMilvusPage = async request => {
    pages++; const offset = request.cursor === null ? 0 : Number.parseInt(request.cursor, 16); const end = Math.min(offset + 64, total);
    const rows = Array.from({ length: end - offset }, (_, index) => ({ id: `capacity/${offset + index}`, content: 'x', tenant_id: 'tenant-a', corpus_id: 'corpus-a',
      document_id: documentId, document_version: documentVersion, trust_level: 'trusted', chunk_index: offset + index, total_chunks: total }));
    generated += rows.length; const nextCursor = end < total ? end.toString(16).padStart(64, '0') : null;
    return f.proof('milvus', { ...f.data.milvus, rows, completion: nextCursor === null ? 'complete' : 'more', nextCursor }, request);
  };
  // 64 rows keep each actual source response under its canonical/proof bound;
  // all 1024 transport pages are consumed before the full-state byte refusal.
  await assert.rejects(create(f).observeActualState({}), rejected('read-limit'));
  assert.equal(generated, total); assert.equal(pages, 1024); assert.equal(count(f, 'clock'), 1026);
});
