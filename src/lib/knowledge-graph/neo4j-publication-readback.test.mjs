import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Integer, Record as Neo4jRecord, Result, int } from 'neo4j-driver';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
let subject;
try { subject = await import('./neo4j-publication-readback.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
function fixture() {
  const scope = { environment: 'test-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: 3 };
  const snapshot = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'active',
    artifactDigest: `sha256:${'a'.repeat(64)}`, documentCount: 2, documents: [
      { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', documentId: 'doc-b', documentVersion: 'v2', trustLevel: 'trusted', status: 'staging' },
      { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed', status: 'staging' },
    ] };
  const expected = [snapshot.documents[1], snapshot.documents[0]].map(({ documentId, documentVersion, trustLevel }) => ({ documentId, documentVersion, trustLevel }));
  const response = () => { const p = clone(pointer); const s = clone(snapshot); p.revision = int(pointer.revision); s.documentCount = int(snapshot.documentCount);
    return { records: [new Neo4jRecord(['pointer', 'snapshot'], [p, s])], summary: {} }; };
  const calls = []; const dispatches = [];
  const transaction = { run(text, params) { calls.push({ text, params }); return Promise.resolve(response()); } };
  const client = { executeRead(operation, work) { dispatches.push(operation); return work(transaction); } };
  const options = { executionProfile: 'local-reference', scope, operationTimeoutMs: 1000, maxReads: 4 };
  return { scope, pointer, snapshot, expected, response, calls, dispatches, transaction, client, options };
}
const reject = code => error => error instanceof subject.Neo4jPublicationReadbackError && error.code === code
  && error.productionAuthorized === false && error.automaticRetryAllowed === false && !/secret-token|tenant-a|doc-a|bolt:\/\//.test(error.message);

test('native Neo4j publication business readback entry point exists', () => {
  assert.equal(typeof subject.Neo4jKnowledgeGraphPublicationReadback, 'function');
});
test('one captured executeRead runs a complete parameterized query using the actual active pointer', async () => {
  const f = fixture(); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  const result = await reader.readPublication({}); assert.deepEqual(result.scope, f.scope); assert.deepEqual(result.pointer, f.pointer);
  assert.deepEqual(result.snapshot, { tenantId: f.scope.tenantId, corpusId: f.scope.corpusId, graphVersion: 'graph-a', status: 'active',
    artifactDigest: f.snapshot.artifactDigest, documents: f.expected });
  assert.ok(Object.isFrozen(result.snapshot.documents)); assert.ok(Object.isFrozen(result.snapshot.documents[0]));
  assert.equal(f.calls.length, 1); assert.equal(f.dispatches.length, 1); assert.deepEqual(f.calls[0].params, { tenantId: 'tenant-a', corpusId: 'corpus-a' });
  assert.match(f.calls[0].text, /OPTIONAL MATCH \(pointer:GraphPointer/); assert.match(f.calls[0].text, /pointer\.activeGraphVersion/);
  assert.match(f.calls[0].text, /OPTIONAL MATCH \(snapshot:GraphSnapshot/); assert.match(f.calls[0].text, /OPTIONAL MATCH \(snapshot\)-\[:CONTAINS\]->\(document:DocumentVersion\)/);
  assert.match(f.calls[0].text, /WITH pointer, snapshot, collect\(/); assert.match(f.calls[0].text, /document\.tenantId/);
  assert.doesNotMatch(f.calls[0].text, /\b(LIMIT|DISTINCT|WHERE|CREATE|MERGE|SET|DELETE)\b|\$graphVersion|\$document|tenant-a|doc-a|graph-a/i);
  assert.equal(reader.productionCapable, false); assert.equal(reader.executionProfile, 'local-reference');
  assert.deepEqual(Object.keys(result).sort(), ['pointer', 'scope', 'snapshot']);
});
test('native Cypher dispatch receives only an immutable tenant and corpus parameter map', async () => {
  const f = fixture(); f.transaction.run = (text, parameters) => {
    assert.equal(Object.isFrozen(parameters), true); assert.equal(Reflect.set(parameters, 'tenantId', 'other'), false);
    f.calls.push({ text, parameters }); return Promise.resolve(f.response());
  };
  assert.deepEqual((await new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({})).snapshot.documents, f.expected);
  assert.deepEqual(f.calls[0].parameters, { tenantId: 'tenant-a', corpusId: 'corpus-a' });
});
test('empty and ambiguous pointer/snapshot result rows cannot produce an active publication', async () => {
  for (const edit of [r => { r.records = []; }, r => { r.records.push(r.records[0]); },
    r => { r.records = [new Neo4jRecord(['pointer', 'snapshot'], [null, r.records[0].get('snapshot')])]; },
    r => { r.records = [new Neo4jRecord(['pointer', 'snapshot'], [r.records[0].get('pointer'), null])]; }]) {
    const f = fixture(); f.transaction.run = () => { const r = f.response(); edit(r); return Promise.resolve(r); };
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
  }
});
test('all raw scope, graph, status, count and digest fields are independently checked', async () => {
  for (const edit of [f => { f.pointer.tenantId = 'other'; }, f => { f.pointer.corpusId = 'other'; }, f => { f.pointer.graphVersion = 'other'; },
    f => { f.snapshot.tenantId = 'other'; }, f => { f.snapshot.corpusId = 'other'; }, f => { f.snapshot.status = 'staging'; },
    f => { f.snapshot.artifactDigest = `sha256:${'A'.repeat(64)}`; }, f => { f.snapshot.documentCount = 1; },
    f => { f.snapshot.documents[0].tenantId = 'other'; }, f => { f.snapshot.documents[0].corpusId = 'other'; },
    f => { f.snapshot.documents[0].graphVersion = 'other'; }, f => { f.snapshot.documents[0].trustLevel = 'unknown'; },
    f => { f.snapshot.documents[0].status = 'failed'; }, f => { f.snapshot.documents[0].status = null; },
    f => { f.snapshot.documents[0].documentVersion = ''; }, f => { f.snapshot.documents[0].extra = true; }]) {
    const f = fixture(); edit(f); await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
    assert.equal(f.calls.length, 1);
  }
});
test('the full inventory is nonempty, at most 512 and rejects duplicate versions even when trust differs', async () => {
  for (const edit of [f => { f.snapshot.documents = []; f.snapshot.documentCount = 0; },
    f => { f.snapshot.documents.push({ ...f.snapshot.documents[0], trustLevel: 'external' }); f.snapshot.documentCount = 3; },
    f => { f.snapshot.documents = Array.from({ length: 513 }, (_, i) => ({ ...f.snapshot.documents[0], documentId: `doc-${i}` })); f.snapshot.documentCount = 513; }]) {
    const f = fixture(); edit(f); await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
  }
});
test('opaque Unicode and slash IDs survive exactly while invalid identities and surrogate payloads reject', async () => {
  const f = fixture(); f.snapshot.documents = [{ ...f.snapshot.documents[0], documentId: '课程甲/doc', documentVersion: '版本/一' }]; f.snapshot.documentCount = 1;
  const result = await new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  assert.deepEqual(result.snapshot.documents, [{ documentId: '课程甲/doc', documentVersion: '版本/一', trustLevel: 'trusted' }]);
  assert.doesNotMatch(f.calls[0].text, /课程甲|版本/);
  for (const value of ['', ' ', ' leading', 'trailing ', 'bad\u0000id', 'bad\nid', 'x'.repeat(513), '\ud800']) {
    const g = fixture(); g.snapshot.documents[0].documentId = value;
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('invalid-readback'));
  }
});
test('native Integer is safely converted without duck coercion, marker-only brands or mutable methods', async () => {
  for (const invalid of [null, '3', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, int('9223372036854775807'),
    { __isInteger__: true, low: 3, high: 0 }, Object.assign(Object.create(Integer.prototype), { low: 3.5, high: 0 })]) {
    const f = fixture(); f.transaction.run = () => { const r = f.response(); r.records[0].get('pointer').revision = invalid; return Promise.resolve(r); };
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
  }
  const f = fixture(); f.pointer.revision = Number.MAX_SAFE_INTEGER;
  assert.equal((await new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({})).pointer.revision, Number.MAX_SAFE_INTEGER);
  let hooks = 0; const g = fixture(); g.transaction.run = () => { const r = g.response(); const value = r.records[0].get('pointer').revision;
    Object.defineProperty(value, 'toNumber', { value() { hooks++; throw new Error('secret-token'); } }); return Promise.resolve(r); };
  await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('invalid-readback')); assert.equal(hooks, 0);
  const h = fixture(); h.transaction.run = () => { const r = h.response(); r.records[0].get('pointer').revision = 3; r.records[0].get('snapshot').documentCount = 2; return Promise.resolve(r); };
  assert.equal((await new subject.Neo4jKnowledgeGraphPublicationReadback(h.client, h.options).readPublication({})).pointer.revision, 3);
});
test('client/config/request getters, Proxy selectors and later mutations never change frozen dispatch', async () => {
  let hooks = 0;
  for (const client of [{ get executeRead() { hooks++; throw new Error('secret-token'); } }, new Proxy({}, { getOwnPropertyDescriptor() { hooks++; throw new Error(); } }),
    Object.create({ executeRead() { hooks++; return Promise.resolve(); } })]) {
    assert.throws(() => new subject.Neo4jKnowledgeGraphPublicationReadback(client, fixture().options), reject('invalid-config'));
  }
  const f = fixture(); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  Object.defineProperty(f.client, 'executeRead', { get() { hooks++; throw new Error('secret-token'); } }); f.options.scope.tenantId = 'other';
  for (const request of [{ passed: true }, { scope: f.scope }, { get selector() { hooks++; return 'secret-token'; } }, new Proxy({}, { ownKeys() { hooks++; throw new Error(); } })]) {
    await assert.rejects(reader.readPublication(request), reject('invalid-request'));
  }
  assert.equal((await reader.readPublication({})).scope.tenantId, 'tenant-a'); assert.equal(hooks, 0); assert.equal(f.calls.length, 1);
});
test('resolved Record, data and integer unsafe hooks reject before invocation', async () => {
  for (const kind of ['result-getter', 'result-proxy', 'record-getter', 'record-proxy', 'record-duck', 'pointer-getter', 'document-proxy', 'integer-getter']) {
    const f = fixture(); let hooks = 0; f.transaction.run = () => { const r = f.response(); let response = r;
      if (kind === 'result-getter') Object.defineProperty(r, 'records', { get() { hooks++; throw new Error(); } });
      if (kind === 'result-proxy') response = new Proxy(r, { ownKeys() { hooks++; throw new Error(); } });
      if (kind === 'record-getter') Object.defineProperty(r.records[0], 'get', { get() { hooks++; throw new Error(); } });
      if (kind === 'record-proxy') r.records[0] = new Proxy(r.records[0], { getPrototypeOf() { hooks++; throw new Error(); } });
      if (kind === 'record-duck') r.records[0] = { get() { hooks++; throw new Error(); } };
      if (kind === 'pointer-getter') Object.defineProperty(r.records[0].get('pointer'), 'revision', { get() { hooks++; throw new Error(); } });
      if (kind === 'document-proxy') r.records[0].get('snapshot').documents[0] = new Proxy({}, { ownKeys() { hooks++; throw new Error(); } });
      if (kind === 'integer-getter') Object.defineProperty(r.records[0].get('pointer').revision, 'low', { get() { hooks++; throw new Error(); } });
      return Promise.resolve(response); };
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback')); assert.equal(hooks, 0);
  }
});
test('managed callback retries reject before a second Cypher, including a swallowed retry refusal', async () => {
  for (const swallow of [false, true]) {
    const f = fixture(); f.client.executeRead = async (_operation, work) => { const first = await work(f.transaction);
      try { await work(f.transaction); } catch (error) { if (!swallow) throw error; } return first; };
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('automatic-retry-refused'));
    assert.equal(f.calls.length, 1);
  }
});
test('a retry refusal while the first business query is pending halts with UNKNOWN completion', async t => {
  const f = fixture(); let release; let entered; const started = new Promise(resolve => { entered = resolve; });
  f.transaction.run = () => { f.calls.push({ pending: true }); entered(); return new Promise(resolve => { release = () => resolve(f.response()); }); };
  let business; f.client.executeRead = (_operation, work) => { business = work(f.transaction); return work(f.transaction); };
  t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  const pending = reader.readPublication({}); await started;
  await assert.rejects(pending, error => reject('automatic-retry-refused')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(f.calls.length, 1); release(); await business;
});
test('a successful-looking provider cannot skip callback execution or return different data', async () => {
  const f = fixture(); f.client.executeRead = () => Promise.resolve(f.response());
  await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('provider-contract-invalid')); assert.equal(f.calls.length, 0);
  const g = fixture(); g.client.executeRead = async (_operation, work) => { await work(g.transaction); return g.response(); };
  await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('provider-contract-invalid')); assert.equal(g.calls.length, 1);
});
test('premature provider success while Cypher is still pending is UNKNOWN terminal', async t => {
  const f = fixture(); let release; let entered; const started = new Promise(resolve => { entered = resolve; });
  f.transaction.run = () => { f.calls.push({ pending: true }); entered(); return new Promise(resolve => { release = () => resolve(f.response()); }); };
  let business;
  f.client.executeRead = (_operation, work) => { business = work(f.transaction); return Promise.resolve({}); };
  t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  const pending = reader.readPublication({}); await started;
  await assert.rejects(pending, error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(f.calls.length, 1);
  release(); await business; await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(f.calls.length, 1);
});
test('outer rejection with an unsettled business callback halts with UNKNOWN completion', async t => {
  const f = fixture(); let release; let business; let dispatches = 0;
  f.transaction.run = () => { f.calls.push({ pending: true }); return new Promise(resolve => { release = () => resolve(f.response()); }); };
  f.client.executeRead = (_operation, work) => {
    if (++dispatches === 1) { business = work(f.transaction); return Promise.reject(new Error('premature secret-token')); }
    return work({ run() { f.calls.push({ second: true }); return Promise.resolve(f.response()); } });
  };
  t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('query-failed')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(f.calls.length, 1); assert.equal(dispatches, 1);
  release(); await business; await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(f.calls.length, 1);
});
test('an outer rejection before callback entry closes the operation and refuses a later business dispatch', async () => {
  const f = fixture(); let captured;
  f.client.executeRead = (_operation, work) => { captured = work; return Promise.reject(new Error('known rejection')); };
  const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('query-failed')(error) && !error.pendingCompletionUnknown);
  await assert.rejects(captured(f.transaction), reject('automatic-retry-refused')); assert.equal(f.calls.length, 0);
});
test('an observed settled Cypher rejection is not misreported as UNKNOWN', async () => {
  const f = fixture(); let calls = 0; f.transaction.run = () => ++calls === 1 ? Promise.reject(new Error('known query failure')) : Promise.resolve(f.response());
  const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('query-failed')(error) && !error.pendingCompletionUnknown);
  assert.equal((await reader.readPublication({})).pointer.revision, 3); assert.equal(calls, 2);
});
test('closed configuration and capacity preserve explicit non-authorizing error context', async () => {
  for (const edit of [o => { o.executionProfile = 'enterprise'; }, o => { o.scope.environment = '*'; }, o => { o.scope.tenantId = 'tenant/a'; },
    o => { o.maxReads = 0; }, o => { o.maxReads = 129; }, o => { o.operationTimeoutMs = 0; }, o => { o.operationTimeoutMs = 30001; }, o => { o.extra = true; }]) {
    const f = fixture(); edit(f.options); assert.throws(() => new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options), reject('invalid-config')); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.options.maxReads = 1; const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await reader.readPublication({}); await assert.rejects(reader.readPublication({}), reject('read-limit')); assert.equal(f.calls.length, 1);
  const g = fixture(); g.transaction.run = () => Promise.reject(new Error('bolt://secret-token@invalid'));
  await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('query-failed'));
});
test('UNKNOWN timeout halts forever and late callback fulfillment never publishes or caches a result', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 40; let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); f.transaction.run = () => { entered(); return new Promise(resolve => { release = () => resolve(f.response()); }); };
  t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await started;
  await assert.rejects(pending, error => reject('query-timeout')(error) && error.pendingCompletionUnknown);
  release(); await new Promise(resolve => setImmediate(resolve)); await assert.rejects(reader.readPublication({}), reject('halted'));
});
test('concurrent reads reject without consuming the one-read capacity', async t => {
  const f = fixture(); f.options.maxReads = 1; let release; let entered; const started = new Promise(resolve => { entered = resolve; });
  f.transaction.run = () => { f.calls.push({ pending: true }); entered(); return new Promise(resolve => { release = () => resolve(f.response()); }); };
  t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await started;
  await assert.rejects(reader.readPublication({}), reject('busy')); assert.equal(f.calls.length, 1); release(); await pending;
  await assert.rejects(reader.readPublication({}), reject('read-limit')); assert.equal(f.calls.length, 1);
});
test('non-native outer promise carriers are UNKNOWN terminal without invoking then/getter/Proxy hooks', async () => {
  for (const kind of ['thenable', 'proxy']) {
    const f = fixture(); let hooks = 0; const carrier = kind === 'thenable' ? { get then() { hooks++; throw new Error('secret-token'); } }
      : new Proxy(Promise.resolve(f.response()), { get() { hooks++; throw new Error('secret-token'); } });
    f.client.executeRead = () => carrier; const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
  }
});
test('unsafe transaction run accessors and Proxy transactions reject without dispatching hooks', async () => {
  for (const kind of ['getter', 'proxy']) {
    const f = fixture(); let hooks = 0;
    const transaction = kind === 'getter' ? { get run() { hooks++; throw new Error('secret-token'); } }
      : new Proxy(f.transaction, { getOwnPropertyDescriptor() { hooks++; throw new Error('secret-token'); } });
    f.client.executeRead = (_operation, work) => work(transaction);
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('query-failed'));
    assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
  }
});
test('unsafe inner Cypher carriers are UNKNOWN terminal without then or constructor hooks', async () => {
  for (const kind of ['thenable', 'proxy', 'promise-constructor', 'result-getter']) {
    const f = fixture(); let hooks = 0; let carrier;
    if (kind === 'thenable') carrier = { get then() { hooks++; throw new Error('secret-token'); } };
    if (kind === 'proxy') carrier = new Proxy(Promise.resolve(f.response()), { get() { hooks++; throw new Error('secret-token'); } });
    if (kind === 'promise-constructor') { carrier = Promise.resolve(f.response()); Object.defineProperty(carrier, 'constructor', { get() { hooks++; throw new Error(); } }); }
    if (kind === 'result-getter') { carrier = Object.create(Result.prototype); Object.defineProperty(carrier, 'then', { get() { hooks++; throw new Error(); } }); }
    f.transaction.run = () => carrier; const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  }
});
test('Result own indirect-method shadows reject without invoking captured then dispatch hooks', async () => {
  const f = fixture(); let hooks = 0; const carrier = Object.create(Result.prototype);
  Object.defineProperty(carrier, '_getOrCreatePromise', { enumerable: true, value() { hooks++; return Promise.resolve(f.response()); } });
  f.transaction.run = () => carrier; const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
});
test('official fresh Result accepts native async_hooks numeric symbol metadata without altering business verification', async () => {
  const f = fixture(); let deliveries = 0; let symbols; const hook = createHook({ init() {} }); hook.enable();
  try {
    f.transaction.run = (text, parameters) => {
      f.calls.push({ text, parameters });
      const stream = Promise.resolve({ subscribe(observer) {
        deliveries++; observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' });
      } });
      symbols = Reflect.ownKeys(stream); assert.ok(symbols.some(key => typeof key === 'symbol'));
      for (const key of symbols) { const descriptor = Object.getOwnPropertyDescriptor(stream, key); assert.ok(Object.hasOwn(descriptor, 'value')); assert.equal(typeof descriptor.value, 'number'); }
      return new Result(stream, text, parameters);
    };
    const result = await new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
    assert.deepEqual(result.snapshot.documents, f.expected); assert.equal(result.pointer.revision, 3); assert.equal(deliveries, 1); assert.equal(f.calls.length, 1);
  } finally { hook.disable(); }
});
test('async SDK observer subscribe accessors reject before invoking a data hook', async () => {
  const f = fixture(); let hooks = 0;
  f.transaction.run = (text, parameters) => new Result(Promise.resolve({ get subscribe() {
    hooks++; return observer => { observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' }); };
  } }), text, parameters);
  const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
});
test('async SDK Proxy observers reject before invoking any trap', async () => {
  const f = fixture(); let hooks = 0;
  f.transaction.run = (text, parameters) => {
    const stream = Promise.resolve(new Proxy({ subscribe(observer) {
      observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' });
    } }, { get(target, key) { hooks++; return Reflect.get(target, key); } }));
    // Native Promise creation inspects payload.then inside the fixture. Count
    // only adapter/SDK accesses after the already-created promise is returned.
    hooks = 0; return new Result(stream, text, parameters);
  };
  const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
});
test('SDK connection holder accessors reject before captured then can dispatch indirectly', async () => {
  const f = fixture(); let hooks = 0;
  f.transaction.run = (text, parameters) => {
    const carrier = new Result(Promise.resolve({ subscribe(observer) { observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' }); } }), text, parameters);
    carrier._connectionHolder = { get getConnection() { hooks++; return () => Promise.resolve(null); }, releaseConnection() { return Promise.resolve(); } };
    return carrier;
  };
  const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
});
test('Result control changes across the async stream wait reject before SDK indirect dispatch', async t => {
  const f = fixture(); let carrier; let release; let entered; let hooks = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const stream = new Promise(resolve => { release = () => resolve({ subscribe(observer) {
    observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' });
  } }); });
  f.transaction.run = (text, parameters) => { carrier = new Result(stream, text, parameters); entered(); return carrier; };
  t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
  const pending = reader.readPublication({}); await started;
  Object.defineProperty(carrier, '_getOrCreatePromise', { enumerable: true, value() { hooks++; return Promise.resolve(f.response()); } });
  release(); await assert.rejects(pending, error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
  await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
});
test('captured SDK holder methods cannot return unsafe carriers or async connection controls', async () => {
  for (const kind of ['get-thenable', 'get-proxy-promise', 'release-thenable', 'connection-getter', 'connection-proxy', 'protocol-then-getter']) {
    const f = fixture(); let hooks = 0; let constructions = 0;
    const unsafe = { get then() { hooks++; throw new Error('secret-token'); } };
    const connection = kind === 'connection-getter' ? { get getProtocolVersion() { hooks++; throw new Error(); } }
      : kind === 'connection-proxy' ? new Proxy({ getProtocolVersion() { return 5; } }, { get(target, key) { hooks++; return Reflect.get(target, key); } })
      : { getProtocolVersion() { return kind === 'protocol-then-getter' ? unsafe : 5; } };
    const connectionPromise = Promise.resolve(connection);
    // Promise construction itself reads a Proxy payload's then; zero-hook
    // assertions cover the adapter/SDK boundary after that provider action.
    constructions = hooks; hooks = 0;
    f.transaction.run = (text, parameters) => {
      const carrier = new Result(Promise.resolve({ subscribe(observer) { observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' }); } }), text, parameters);
      carrier._connectionHolder = {
        getConnection() { return kind === 'get-thenable' ? unsafe : kind === 'get-proxy-promise' ? new Proxy(connectionPromise, { get() { hooks++; throw new Error(); } }) : connectionPromise; },
        releaseConnection() { return kind === 'release-thenable' ? unsafe : Promise.resolve(); },
      }; return carrier;
    };
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
    assert.equal(constructions, kind === 'connection-proxy' ? 1 : 0);
  }
});
test('SDK facades retain real completion, connection release and safe protocol dispatch', async () => {
  const f = fixture(); const calls = []; let carrier;
  f.transaction.run = (text, parameters) => {
    carrier = new Result(Promise.resolve({ subscribe(observer) {
      calls.push('subscribe'); observer.onNext(f.response().records[0]); observer.onCompleted({ type: 'r' });
    } }), text, parameters);
    carrier._connectionHolder = {
      getConnection() { calls.push('get'); return Promise.resolve({ getProtocolVersion() { calls.push('protocol'); return 5; } }); },
      releaseConnection() { calls.push('release'); return Promise.resolve(); },
    }; return carrier;
  };
  const result = await new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  assert.deepEqual(result.snapshot.documents, f.expected); assert.deepEqual(calls, ['subscribe', 'get', 'release', 'protocol']);
  assert.equal(carrier._ownedObservers.length, 1); assert.equal(carrier._summary.server.protocolVersion, 5);
});
test('SDK completion metadata accessors and Proxy payloads reject before ResultSummary reads them', async () => {
  for (const kind of ['getter', 'proxy']) {
    const f = fixture(); let hooks = 0;
    const metadata = kind === 'getter' ? { get type() { hooks++; return 'r'; } }
      : new Proxy({ type: 'r' }, { get(target, key) { hooks++; return Reflect.get(target, key); } });
    f.transaction.run = (text, parameters) => new Result(Promise.resolve({ subscribe(observer) {
      observer.onNext(f.response().records[0]); observer.onCompleted(metadata);
    } }), text, parameters);
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  }
});
test('SDK completion metadata rejects nested hooks, cycles and control data without executing them', async () => {
  for (const kind of ['nested-getter', 'nested-proxy', 'array-getter', 'cycle', 'function', 'control', 'integer-getter', 'integer-method', 'integer-overflow']) {
    const f = fixture(); let hooks = 0; const metadata = { type: 'r', stats: { 'nodes-created': int(0) } };
    if (kind === 'nested-getter') Object.defineProperty(metadata.stats, 'nodes-created', { enumerable: true, get() { hooks++; return int(0); } });
    if (kind === 'nested-proxy') metadata.stats = new Proxy(metadata.stats, { ownKeys() { hooks++; throw new Error(); } });
    if (kind === 'array-getter') { metadata.notifications = [null]; Object.defineProperty(metadata.notifications, '0', { enumerable: true, get() { hooks++; throw new Error(); } }); }
    if (kind === 'cycle') metadata.stats.extra = metadata;
    if (kind === 'function') metadata.stats.extra = () => { hooks++; };
    if (kind === 'control') metadata.stats.then = null;
    if (kind === 'integer-getter') Object.defineProperty(metadata.stats['nodes-created'], 'low', { enumerable: true, get() { hooks++; return 0; } });
    if (kind === 'integer-method') Object.defineProperty(metadata.stats['nodes-created'], 'toNumber', { enumerable: true, value() { hooks++; return 0; } });
    if (kind === 'integer-overflow') metadata.stats['nodes-created'] = int('9223372036854775807');
    f.transaction.run = (text, parameters) => new Result(Promise.resolve({ subscribe(observer) {
      observer.onNext(f.response().records[0]); observer.onCompleted(metadata);
    } }), text, parameters);
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  }
});
test('ordinary completion data and native Integer words are detached before asynchronous SDK summary creation', async () => {
  const f = fixture(); let carrier; let release; let waiting;
  const started = new Promise(resolve => { waiting = resolve; });
  const connection = new Promise(resolve => { release = () => resolve(null); });
  const metadata = { type: 'r', stats: { 'nodes-created': int(0) }, result_available_after: int(3), result_consumed_after: int(4),
    server: { address: 'test:7687', version: 'test-driver' }, db: 'neo4j', notifications: [],
    plan: { operatorType: 'ProduceResults', identifiers: ['pointer', 'snapshot'], args: { EstimatedRows: int(1) }, children: [] } };
  f.transaction.run = (text, parameters) => {
    carrier = new Result(Promise.resolve({ subscribe(observer) { observer.onNext(f.response().records[0]); observer.onCompleted(metadata); } }), text, parameters);
    carrier._connectionHolder = { getConnection() { waiting(); return connection; }, releaseConnection() { return Promise.resolve(); } }; return carrier;
  };
  const pending = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}); await started;
  metadata.type = 'w'; metadata.result_available_after.low = 900; metadata.plan.identifiers[0] = 'changed'; release();
  assert.deepEqual((await pending).snapshot.documents, f.expected); assert.equal(carrier._summary.queryType, 'r');
  assert.equal(carrier._summary.resultAvailableAfter, 3); assert.equal(carrier._summary.resultConsumedAfter, 4);
  assert.equal(carrier._summary.counters.updates().nodesCreated, 0); assert.deepEqual(carrier._summary.plan.identifiers, ['pointer', 'snapshot']);
});
test('raw SDK stream errors are redacted before SDK code and diagnosticRecord reads', async () => {
  for (const kind of ['getter', 'proxy']) {
    const f = fixture(); let hooks = 0; const raw = kind === 'getter' ? { get code() { hooks++; return 'bad'; }, get diagnosticRecord() { hooks++; return {}; } }
      : new Proxy(new Error('secret-token'), { get() { hooks++; throw new Error(); } });
    f.transaction.run = (text, parameters) => new Result(Promise.resolve({ subscribe(observer) { observer.onError(raw); } }), text, parameters);
    await assert.rejects(new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}),
      error => reject('query-failed')(error) && !error.pendingCompletionUnknown);
    assert.equal(hooks, 0);
  }
});
test('owned SDK holder and stream receivers cannot become accessors after subscription', async () => {
  for (const key of ['_connectionHolder', '_streamObserverPromise']) {
    const f = fixture(); let carrier; let handler; let subscribed; let hooks = 0;
    const started = new Promise(resolve => { subscribed = resolve; });
    f.transaction.run = (text, parameters) => {
      carrier = new Result(Promise.resolve({ subscribe(observer) { handler = observer; subscribed(); } }), text, parameters); return carrier;
    };
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    const pending = reader.readPublication({}); await started; const owned = Object.getOwnPropertyDescriptor(carrier, key).value;
    let mutationRefused = false;
    try { Object.defineProperty(carrier, key, { enumerable: true, configurable: true, get() { hooks++; return owned; } }); }
    catch (error) { mutationRefused = error instanceof TypeError; }
    handler.onNext(f.response().records[0]); handler.onCompleted({ type: 'r' });
    assert.deepEqual((await pending).snapshot.documents, f.expected); assert.ok(mutationRefused); assert.equal(hooks, 0);
    const descriptor = Object.getOwnPropertyDescriptor(carrier, key); assert.equal(descriptor.value, owned);
    assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
  }
});
test('SDK callback receiver method shadows after subscription reject without invoking the override', async () => {
  const f = fixture(); let carrier; let handler; let subscribed; let hooks = 0;
  const started = new Promise(resolve => { subscribed = resolve; });
  f.transaction.run = (text, parameters) => { carrier = new Result(Promise.resolve({ subscribe(observer) { handler = observer; subscribed(); } }), text, parameters); return carrier; };
  const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await started;
  let mutationRefused = false;
  try { Object.defineProperty(carrier, '_releaseConnectionAndGetSummary', { enumerable: true, value() { hooks++; return Promise.resolve({}); } }); }
  catch (error) { mutationRefused = error instanceof TypeError; }
  handler.onNext(f.response().records[0]); handler.onCompleted({ type: 'r' });
  if (mutationRefused) assert.deepEqual((await pending).snapshot.documents, f.expected);
  else { await assert.rejects(pending, error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown); await assert.rejects(reader.readPublication({}), reject('halted')); }
  assert.equal(hooks, 0);
});
test('known constructor inputs and mutable SDK state cannot drift into accessor controls after subscription', async () => {
  for (const key of ['_parameters', '_query', '_watermarks', '_stack', '_retry', '_mapper', '_p', '_keys', '_summary', '_error', '_ownedObservers']) {
    const f = fixture(); let carrier; let handler; let subscribed; let hooks = 0; let mutationRefused = false;
    const started = new Promise(resolve => { subscribed = resolve; });
    f.transaction.run = (text, parameters) => { carrier = new Result(Promise.resolve({ subscribe(observer) { handler = observer; subscribed(); } }), text, parameters); return carrier; };
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await started;
    const value = Object.getOwnPropertyDescriptor(carrier, key).value;
    try { Object.defineProperty(carrier, key, { enumerable: true, configurable: true, get() { hooks++; return value; } }); }
    catch (error) { mutationRefused = error instanceof TypeError; }
    handler.onNext(f.response().records[0]); handler.onCompleted({ type: 'r' });
    if (mutationRefused) assert.deepEqual((await pending).snapshot.documents, f.expected);
    else { await assert.rejects(pending, error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown); await assert.rejects(reader.readPublication({}), reject('halted')); }
    assert.equal(hooks, 0);
  }
});
test('private SDK rejection keeps pending completion UNKNOWN and closes all later event dispatch', async () => {
  for (const kind of ['metadata', 'state-proxy', 'mutable-descriptor', 'prototype']) {
    const f = fixture(); let carrier; let handler; let subscribed; let hooks = 0; let holderCalls = 0; let originalSettled = false;
    const started = new Promise(resolve => { subscribed = resolve; });
    f.transaction.run = (text, parameters) => {
      carrier = new Result(Promise.resolve({ subscribe(observer) { handler = observer; subscribed(); } }), text, parameters);
      carrier._connectionHolder = { getConnection() { holderCalls++; return Promise.resolve(null); }, releaseConnection() { holderCalls++; return Promise.resolve(); } }; return carrier;
    };
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await started;
    const original = carrier._p; original.then(() => { originalSettled = true; }, () => { originalSettled = true; });
    const prototype = Object.getPrototypeOf(Result.prototype); const descriptor = Object.getOwnPropertyDescriptor(prototype, '_releaseConnectionAndGetSummary');
    try {
      if (kind === 'state-proxy') carrier._p = new Proxy(original, { get() { hooks++; throw new Error(); } });
      if (kind === 'mutable-descriptor') Object.defineProperty(carrier, '_p', { writable: false });
      if (kind === 'prototype') Object.defineProperty(prototype, '_releaseConnectionAndGetSummary', {
        configurable: descriptor.configurable, enumerable: descriptor.enumerable, get() { hooks++; return () => Promise.resolve({}); }
      });
      handler.onNext(f.response().records[0]); handler.onCompleted(kind === 'metadata' ? { get type() { hooks++; return 'r'; } } : { type: 'r' });
      await assert.rejects(pending, error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
      await assert.rejects(reader.readPublication({}), reject('halted'));
      handler.onNext(f.response().records[0]); handler.onCompleted({ type: 'r' }); handler.onError(new Error('late'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(originalSettled, false); assert.equal(holderCalls, 0); assert.equal(hooks, 0); assert.equal(carrier._summary, null);
    } finally { Object.defineProperty(prototype, '_releaseConnectionAndGetSummary', descriptor); }
  }
});
test('late SDK stream and connection fulfillment cannot dispatch after the shared operation deadline', async t => {
  for (const phase of ['stream', 'connection']) {
    const f = fixture(); f.options.operationTimeoutMs = 40; let release; let entered; let business; let subscriptions = 0; let releases = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const observer = { subscribe(handler) { subscriptions++; handler.onNext(f.response().records[0]); handler.onCompleted({ type: 'r' }); } };
    const delayed = new Promise(resolve => { release = () => resolve(phase === 'stream' ? observer : { getProtocolVersion() { throw new Error('late protocol dispatch'); } }); });
    f.transaction.run = (text, parameters) => {
      const carrier = new Result(phase === 'stream' ? delayed : Promise.resolve(observer), text, parameters);
      if (phase === 'connection') carrier._connectionHolder = { getConnection() { entered(); return delayed; }, releaseConnection() { releases++; return Promise.resolve(); } };
      else entered(); return carrier;
    };
    f.client.executeRead = (_operation, work) => { business = work(f.transaction); return business; };
    t.after(() => release?.()); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    const pending = reader.readPublication({}); await started;
    await assert.rejects(pending, error => reject('query-timeout')(error) && error.pendingCompletionUnknown);
    release(); await assert.rejects(business); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(subscriptions, phase === 'stream' ? 0 : 1); assert.equal(releases, 0);
  }
});
test('stream symbol metadata cannot introduce Promise controls, accessors, functions or nonnumeric data', async () => {
  const sample = fixture(); await new subject.Neo4jKnowledgeGraphPublicationReadback(sample.client, sample.options).readPublication({});
  for (const kind of ['species', 'to-primitive', 'getter', 'function', 'object', 'overflow', 'infinite', 'negative', 'string-field']) {
    const f = fixture(); let hooks = 0; const stream = Promise.resolve({ subscribe() { hooks++; } });
    const symbol = kind === 'species' ? Symbol.species : kind === 'to-primitive' ? Symbol.toPrimitive : Symbol('context');
    if (kind === 'getter') Object.defineProperty(stream, symbol, { get() { hooks++; throw new Error(); } });
    else Object.defineProperty(stream, kind === 'string-field' ? 'metadata' : symbol, { value: kind === 'function' ? () => { hooks++; }
      : kind === 'object' ? {} : kind === 'overflow' ? Number.MAX_SAFE_INTEGER + 1 : kind === 'infinite' ? Infinity : kind === 'negative' ? -1 : 1 });
    f.transaction.run = () => new Result(stream, sample.calls[0].text, clone(sample.calls[0].params));
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  }
});
test('fresh Result receivers reject shadow methods, cached payloads, mappers and unsafe stream promises', async () => {
  const sample = fixture(); await new subject.Neo4jKnowledgeGraphPublicationReadback(sample.client, sample.options).readPublication({});
  for (const kind of ['_getOrCreatePromise', '_subscribe', '_decorateObserver', '_releaseConnectionAndGetSummary', 'mapper', 'cached-promise',
    'stream-getter', 'stream-proxy', 'stream-constructor', 'parameters-proxy', 'missing-field']) {
    const f = fixture(); let hooks = 0;
    const carrier = new Result(Promise.resolve({ subscribe() { hooks++; } }), sample.calls[0].text, clone(sample.calls[0].params));
    if (kind.startsWith('_')) Object.defineProperty(carrier, kind, { enumerable: true, value() { hooks++; return Promise.resolve(f.response()); } });
    if (kind === 'mapper') carrier._mapper = () => { hooks++; return f.response(); };
    if (kind === 'cached-promise') carrier._p = Promise.resolve(f.response());
    if (kind === 'stream-getter') Object.defineProperty(carrier._streamObserverPromise, 'then', { get() { hooks++; throw new Error(); } });
    if (kind === 'stream-proxy') carrier._streamObserverPromise = new Proxy(carrier._streamObserverPromise, { get() { hooks++; throw new Error(); } });
    if (kind === 'stream-constructor') Object.defineProperty(carrier._streamObserverPromise, 'constructor', { get() { hooks++; throw new Error(); } });
    if (kind === 'parameters-proxy') carrier._parameters = new Proxy({}, { ownKeys() { hooks++; throw new Error(); } });
    if (kind === 'missing-field') delete carrier._retry;
    f.transaction.run = () => carrier; const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  }
});
test('SDK indirect behavior prototype overrides reject before invoking replaced methods', async () => {
  const f = fixture(); let hooks = 0; const prototype = Object.getPrototypeOf(Result.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, '_getOrCreatePromise');
  Object.defineProperty(prototype, '_getOrCreatePromise', { ...descriptor, value() { hooks++; return Promise.resolve(f.response()); } });
  try {
    f.transaction.run = () => Object.create(Result.prototype); const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), error => reject('provider-contract-invalid')(error) && error.pendingCompletionUnknown);
    await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  } finally { Object.defineProperty(prototype, '_getOrCreatePromise', descriptor); }
});
test('detached outputs do not expose provider-owned maps or retain mutated documents', async () => {
  const f = fixture(); let raw; f.transaction.run = () => { raw = f.response(); return Promise.resolve(raw); };
  const result = await new subject.Neo4jKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  const before = createHash('sha256').update(JSON.stringify(result)).digest('hex'); raw.records[0].get('snapshot').documents[0].documentId = 'changed';
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), before);
});
