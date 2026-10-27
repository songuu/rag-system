import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
let subject;
try { subject = await import('./milvus-publication-readback.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }

test('native Milvus publication business readback entry point exists', () => {
  assert.equal(typeof subject.MilvusKnowledgeGraphPublicationReadback, 'function');
});

const clone = v => structuredClone(v);
const success = () => ({ error_code: 'Success', code: 0, reason: '' });
function fixture(count = 3) {
  const scope = { environment: 'local-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const scalar = (name, data_type, extra = {}) => ({ name, fieldID: '1', data_type, dataType: { VarChar: 21, Int64: 5, FloatVector: 101 }[data_type],
    _placeholderType: { VarChar: 21, Int64: 5, FloatVector: 101 }[data_type], is_primary_key: false, autoID: false,
    description: '', type_params: data_type === 'VarChar' ? [{ key: 'max_length', value: '65535' }] : [], index_params: [],
    ...(data_type === 'VarChar' ? { max_length: '65535' } : {}), ...extra });
  const names = ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level'];
  const schema = { status: success(), collection_name: 'rag_collection', collectionID: '9007199254740993', consistency_level: 'Strong',
    schema: { name: 'rag_collection', description: '', autoID: false, enable_dynamic_field: false, fields: [
      ...names.map((name, index) => scalar(name, 'VarChar', { fieldID: String(index + 1), is_primary_key: name === 'id' })),
      scalar('chunk_index', 'Int64', { fieldID: '8' }), scalar('total_chunks', 'Int64', { fieldID: '9' }),
      scalar('embedding', 'FloatVector', { fieldID: '10', dim: '768', type_params: [{ key: 'dim', value: '768' }] }),
      scalar('metadata_json', 'VarChar', { fieldID: '11' }), scalar('source', 'VarChar', { fieldID: '12' }),
      scalar('created_at', 'Int64', { fieldID: '13' })], functions: [] } };
  const indexes = { status: success(), index_descriptions: [{ index_name: 'embedding_idx', field_name: 'embedding', indexID: '9007199254740994',
    params: [{ key: 'index_type', value: 'HNSW' }, { key: 'metric_type', value: 'COSINE' }, { key: 'M', value: '16' }],
    state: 'Finished', indexed_rows: String(count), total_rows: String(count), pending_index_rows: '0', index_state_fail_reason: '' }] };
  const rows = Array.from({ length: count }, (_, index) => ({ id: `chunk-${index}`, content: `content ${index}`, tenant_id: scope.tenantId,
    corpus_id: scope.corpusId, document_id: '课程/甲', document_version: '版本/一', trust_level: 'reviewed', chunk_index: String(index), total_chunks: String(count) }));
  const calls = [];
  const client = {
    describeCollection(request) { calls.push({ method: 'describeCollection', request }); return Promise.resolve(clone(schema)); },
    describeIndex(request) { calls.push({ method: 'describeIndex', request }); return Promise.resolve(clone(indexes)); },
    query(request) { calls.push({ method: 'query', request });
      if (request.output_fields[0] === 'count(*)') return Promise.resolve({ status: success(), data: [{ 'count(*)': String(rows.length) }] });
      const seen = new Set(request.exprValues.seenIds ?? []);
      return Promise.resolve({ status: success(), data: clone(rows.filter(row => !seen.has(row.id)).slice().reverse().slice(0, request.limit)) });
    },
  };
  const options = { executionProfile: 'local-reference', scope, collection: 'rag_collection', operationTimeoutMs: 1000, maxReads: 4,
    pageSize: 2, maxRows: 65536, maxTotalRowBytes: 64 * 1024 * 1024, maxQueryParameterBytes: 8 * 1024 * 1024 };
  return { scope, schema, indexes, rows, calls, client, options };
}
const reject = code => e => e instanceof subject.MilvusPublicationReadbackError && e.code === code
  && e.productionAuthorized === false && e.automaticRetryAllowed === false && !/secret-token|tenant-a|课程|localhost/.test(e.message);

test('all existing RagTrustLevel values remain visible; invented untrusted is rejected', async () => {
  const f = fixture(4); for (const [index, trust] of ['trusted', 'reviewed', 'external', 'quarantined'].entries()) f.rows[index].trust_level = trust;
  const rows = (await new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({})).rows;
  assert.deepEqual(new Set(rows.map(row => row.trust_level)), new Set(['trusted', 'reviewed', 'external', 'quarantined']));
  const g = fixture(); g.rows[0].trust_level = 'untrusted';
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('invalid-readback'));
});

test('actual full-scope pages remain order-independent, immutable and business-only', async () => {
  const f = fixture(); f.rows[0].id = '片段/\'"😀';
  const reader = new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options);
  const observed = await reader.readPublication({});
  assert.deepEqual(observed.scope, f.scope); assert.equal(observed.collection, 'rag_collection');
  assert.equal(observed.rows.length, 3); assert.deepEqual(new Set(observed.rows.map(v => v.id)), new Set(f.rows.map(v => v.id)));
  assert.equal(typeof observed.rows[0].chunk_index, 'number'); assert.ok(Object.isFrozen(observed.rows)); assert.ok(Object.isFrozen(observed.rows[0]));
  assert.equal(reader.productionCapable, false); assert.equal(reader.executionProfile, 'local-reference');
  assert.ok(!Object.hasOwn(observed, 'productionAuthorized')); assert.ok(!Object.hasOwn(observed, 'consistencyVerified'));
  const rowCalls = f.calls.filter(v => v.method === 'query' && v.request.output_fields[0] !== 'count(*)');
  assert.equal(rowCalls.length, 3); assert.deepEqual(rowCalls.at(-1).request.exprValues.seenIds.length, 3);
  for (const { request } of f.calls) {
    assert.equal(request.collection_name, 'rag_collection'); assert.ok(!Object.hasOwn(request, 'offset'));
    assert.ok(!Object.hasOwn(request, 'order_by')); assert.ok(!Object.hasOwn(request, 'index_name'));
    if (Object.hasOwn(request, 'output_fields')) {
      assert.equal(request.consistency_level, 'Strong'); assert.equal(request.exprValues.tenantId, 'tenant-a'); assert.equal(request.exprValues.corpusId, 'corpus-a');
      assert.doesNotMatch(request.filter, /document|version|trust|tenant-a|片段/); assert.ok(request.timeout > 0);
    } else if (f.calls.find(v => v.request === request)?.method === 'describeCollection') assert.equal(request.cache, false);
  }
  assert.equal(f.calls.filter(v => v.method === 'describeCollection').length, 2);
  assert.equal(f.calls.filter(v => v.method === 'describeIndex').length, 2);
});

test('complete 65536 short rows are enumerated; a 65537-row superset is never a completed subwindow', async () => {
  const f = fixture(65536); f.options.pageSize = 128; f.options.operationTimeoutMs = 30000;
  // Deliberately return unstable ordering while keeping the exclusion semantics exact.
  f.client.query = request => {
    f.calls.push({ method: 'query', request: { filter: request.filter, seenCount: request.exprValues.seenIds?.length ?? 0 } });
    if (request.output_fields[0] === 'count(*)') return Promise.resolve({ status: success(), data: [{ 'count(*)': '65536' }] });
    const seen = new Set(request.exprValues.seenIds ?? []);
    return Promise.resolve({ status: success(), data: f.rows.filter(row => !seen.has(row.id)).slice(0, request.limit) });
  };
  const result = await new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  assert.equal(result.rows.length, 65536); assert.equal(result.rows.at(-1).chunk_index, 65535);
  assert.equal(f.calls.filter(v => v.method === 'query').at(-2).request.seenCount, 65536);
  const g = fixture(); g.client.query = () => Promise.resolve({ status: success(), data: [{ 'count(*)': '65537' }] });
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('row-capacity'));
});

test('count agreement requires a real empty terminal page and checks both fresh counts', async () => {
  for (const scenario of ['early-empty', 'count-after-drift', 'repeat-after-count', 'empty-scope']) {
    const f = fixture(); let counts = 0; const query = f.client.query;
    f.client.query = request => {
      if (request.output_fields[0] === 'count(*)') {
        counts++; return Promise.resolve({ status: success(), data: [{ 'count(*)': scenario === 'empty-scope' ? '0' : scenario === 'count-after-drift' && counts === 2 ? '4' : '3' }] });
      }
      if (scenario === 'early-empty' || scenario === 'empty-scope') return Promise.resolve({ status: success(), data: [] });
      if (scenario === 'repeat-after-count' && request.exprValues.seenIds?.length === 3) return Promise.resolve({ status: success(), data: [clone(f.rows[0])] });
      return query(request);
    };
    await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
  }
});

test('scalar rows fail closed on missing independent identities, scope drift and unsafe integers', async () => {
  const edits = [r => { delete r.document_version; r.metadata_json = '{"document_version":"v1"}'; }, r => { r.tenant_id = 'other'; },
    r => { r.corpus_id = 'other'; }, r => { r.id = '\u0000'; }, r => { r.document_id = ' x'; }, r => { r.content = ''; },
    r => { r.content = 'x'.repeat(65537); }, r => { r.trust_level = 'unknown'; }, r => { r.chunk_index = '01'; },
    r => { r.chunk_index = '-1'; }, r => { r.total_chunks = '9007199254740993'; }, r => { r.total_chunks = 0; }];
  for (const edit of edits) { const f = fixture(); edit(f.rows[0]);
    await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback')); }
  const f = fixture(); f.rows[1].id = f.rows[0].id;
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
});

test('RPC status, schema/index evidence and before/after manifests cannot be fabricated', async () => {
  const edits = [f => { f.schema.status.error_code = 'UnexpectedError'; }, f => { f.indexes.status.code = 2; },
    f => { f.schema.collection_name = 'other'; }, f => { f.schema.schema.fields = []; },
    f => { f.schema.schema.fields[0].is_primary_key = false; }, f => { f.schema.schema.fields[8].data_type = 'VarChar'; },
    f => { f.schema.schema.fields[9].type_params = []; }, f => { f.schema.schema.fields[1].name = 'id'; },
    f => { f.schema.schema.functions = [{}]; }, f => { f.indexes.index_descriptions = []; },
    f => { f.indexes.index_descriptions[0].state = 'InProgress'; }, f => { f.indexes.index_descriptions[0].params = []; },
    f => { f.indexes.index_descriptions[0].field_name = 'missing'; }, f => { f.indexes.index_descriptions.push(clone(f.indexes.index_descriptions[0])); }];
  for (const edit of edits) { const f = fixture(); edit(f);
    await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback')); }
  const f = fixture(); let calls = 0; f.client.describeCollection = () => { calls++; const data = clone(f.schema); if (calls === 2) data.schema.description = 'changed'; return Promise.resolve(data); };
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
  const g = fixture(); g.client.query = () => Promise.resolve({ status: { error_code: 'Success', code: 0, reason: 'unexpected' }, data: [{ 'count(*)': '3' }] });
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('invalid-readback'));
});

test('captured prototype methods and frozen scope cannot be replaced; hooks do not run', async () => {
  const f = fixture(); const original = f.client; const client = Object.create(original);
  const reader = new subject.MilvusKnowledgeGraphPublicationReadback(client, f.options); let hooks = 0;
  f.options.scope.tenantId = 'other'; Object.defineProperty(original, 'query', { get() { hooks++; throw new Error('secret-token'); } });
  for (const request of [{ scope: f.scope }, { success: true }, { get input() { hooks++; return 1; } }, new Proxy({}, { ownKeys() { hooks++; return []; } })]) {
    await assert.rejects(reader.readPublication(request), reject('invalid-request'));
  }
  assert.equal((await reader.readPublication({})).scope.tenantId, 'tenant-a'); assert.equal(hooks, 0);
  for (const bad of [new Proxy(original, {}), { describeCollection: f.client.describeCollection, describeIndex: f.client.describeIndex,
    get query() { hooks++; return () => {}; } }]) {
    assert.throws(() => new subject.MilvusKnowledgeGraphPublicationReadback(bad, f.options), reject('invalid-config'));
  }
  assert.equal(hooks, 0);
});

test('row and seenIds byte capacities explicitly reject rather than truncate or interpolate', async () => {
  const f = fixture(); f.options.maxTotalRowBytes = 1;
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('row-capacity'));
  const g = fixture(); g.options.maxQueryParameterBytes = 100; g.rows[0].id = '汉'.repeat(100);
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('parameter-capacity'));
});

test('configuration and read budgets stay closed; invalid SDK promise carriers halt without hooks', async () => {
  for (const edit of [o => { o.extra = true; }, o => { o.executionProfile = 'enterprise'; }, o => { o.maxRows = 65537; },
    o => { o.pageSize = 129; }, o => { o.operationTimeoutMs = 0; }, o => { o.collection = 'bad/name'; }]) {
    const f = fixture(); edit(f.options); assert.throws(() => new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options), reject('invalid-config'));
  }
  for (const kind of ['thenable', 'proxy']) { const f = fixture(); let hooks = 0;
    f.client.describeCollection = () => kind === 'thenable' ? { get then() { hooks++; return () => {}; } } : new Proxy(Promise.resolve(f.schema), { get() { hooks++; throw new Error('secret-token'); } });
    const reader = new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options);
    await assert.rejects(reader.readPublication({}), reject('provider-contract-invalid')); await assert.rejects(reader.readPublication({}), reject('halted')); assert.equal(hooks, 0);
  }
  const f = fixture(); f.options.maxReads = 1; const reader = new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options);
  await reader.readPublication({}); await assert.rejects(reader.readPublication({}), reject('read-limit'));
});

test('whole-operation UNKNOWN timeout halts and late fulfillment cannot dispatch more SDK IO', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 30; let release; let started; const entered = new Promise(resolve => { started = resolve; });
  f.client.describeCollection = () => { started(); return new Promise(resolve => { release = () => resolve(clone(f.schema)); }); }; t.after(() => release?.());
  const reader = new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options); const pending = reader.readPublication({}); await entered;
  await assert.rejects(reader.readPublication({}), reject('busy'));
  await assert.rejects(pending, e => reject('query-timeout')(e) && e.pendingCompletionUnknown); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0); await assert.rejects(reader.readPublication({}), reject('halted'));
});

test('all extra schema/index identity participates while volatile progress is only validated', async () => {
  const f = fixture(); f.schema.schema.storage_format = 'columnar'; f.schema.schema.fields.push({ ...clone(f.schema.schema.fields[1]), name: 'business_extra', fieldID: '14' });
  f.indexes.index_descriptions[0].user_field = 'actual-index-extra'; let calls = 0;
  f.client.describeIndex = () => { calls++; const result = clone(f.indexes); if (calls === 2) result.index_descriptions[0].indexed_rows = '2'; return Promise.resolve(result); };
  const data = await new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  assert.equal(data.schemaManifest.schema.storage_format, 'columnar'); assert.equal(data.schemaManifest.schema.fields.at(-1).name, 'business_extra');
  assert.equal(data.indexManifest.indexes[0].user_field, 'actual-index-extra'); assert.ok(!Object.hasOwn(data.indexManifest.indexes[0], 'indexed_rows'));
  const g = fixture(); let indexes = 0; g.client.describeIndex = () => { const result = clone(g.indexes); if (++indexes === 2) result.index_descriptions[0].params[0].value = 'AUTOINDEX'; return Promise.resolve(result); };
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('invalid-readback'));
});

test('unsafe response descriptors and sparse arrays are rejected without executing hooks', async () => {
  for (const kind of ['row-getter', 'row-proxy', 'sparse-page', 'extra-array-field', 'schema-proxy']) {
    const f = fixture(); let hooks = 0;
    if (kind === 'schema-proxy') f.client.describeCollection = () => Promise.resolve(new Proxy(f.schema, { ownKeys() { hooks++; return []; } }));
    else {
      const query = f.client.query; f.client.query = request => {
        if (request.output_fields[0] === 'count(*)') return query(request);
        const row = clone(f.rows[0]); let data;
        if (kind === 'row-getter') { Object.defineProperty(row, 'id', { get() { hooks++; return 'x'; }, enumerable: true }); data = [row]; }
        else if (kind === 'row-proxy') data = [new Proxy(row, { ownKeys() { hooks++; return []; } })];
        else if (kind === 'sparse-page') data = new Array(1);
        else { data = [row]; data.extra = true; }
        return Promise.resolve({ status: success(), data });
      };
    }
    await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback')); assert.equal(hooks, 0);
  }
});

test('SDK rejection is redacted and not automatically retried; inherited accessor and overdeep prototypes reject', async () => {
  const f = fixture(); let calls = 0; f.client.describeCollection = () => { calls++; return Promise.reject(new Error('localhost secret-token')); };
  await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('query-failed')); assert.equal(calls, 1);
  const g = fixture(); let hooks = 0; const proto = { describeCollection: g.client.describeCollection, describeIndex: g.client.describeIndex,
    get query() { hooks++; return g.client.query; } };
  assert.throws(() => new subject.MilvusKnowledgeGraphPublicationReadback(Object.create(proto), g.options), reject('invalid-config')); assert.equal(hooks, 0);
  let client = g.client; for (let i = 0; i < 16; i++) client = Object.create(client);
  assert.throws(() => new subject.MilvusKnowledgeGraphPublicationReadback(client, g.options), reject('invalid-config'));
});

test('SDK-described schema helpers are verified but cannot masquerade as raw schema identity', async () => {
  const f = fixture(); const result = await new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({});
  for (const field of result.schemaManifest.schema.fields) {
    assert.ok(!Object.hasOwn(field, 'dataType')); assert.ok(!Object.hasOwn(field, '_placeholderType'));
    assert.ok(!Object.hasOwn(field, 'max_length')); assert.ok(!Object.hasOwn(field, 'dim'));
  }
  assert.deepEqual(result.schemaManifest.schema.fields.find(field => field.name === 'embedding').type_params, [{ key: 'dim', value: '768' }]);
  for (const edit of [s => { s.fields[0].dataType = 5; }, s => { s.fields[0]._placeholderType = 5; },
    s => { s.fields[0].max_length = '7'; }, s => { s.fields[0].type_params.push({ key: 'name', value: 'id' }); },
    s => { s.struct_array_fields = [{ name: 'irreversible-sdk-struct' }]; }]) {
    const g = fixture(); edit(g.schema.schema);
    await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(g.client, g.options).readPublication({}), reject('invalid-readback'));
  }
});

test('real SDK-style request mutation receives a detached mutable request, never internal scope/state', async () => {
  const f = fixture(); const query = f.client.query;
  f.client.query = request => {
    request.expr = request.filter; request.expr_template_values = { actual: true };
    if (request.exprValues.seenIds) request.exprValues.seenIds = [...request.exprValues.seenIds];
    return query(request).then(result => { request.exprValues.tenantId = 'mutated'; request.output_fields.push('mutated'); return result; });
  };
  const reader = new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options);
  assert.equal((await reader.readPublication({})).rows.length, 3); assert.equal((await reader.readPublication({})).rows.length, 3);
  assert.equal(f.options.scope.tenantId, 'tenant-a'); assert.equal(f.options.collection, 'rag_collection');
});

test('a slow transport clone crossing the whole deadline cannot dispatch fresh SDK IO', async t => {
  const f = fixture(); f.options.operationTimeoutMs = 10; const nativeClone = globalThis.structuredClone; let sdkCalls = 0;
  globalThis.structuredClone = value => {
    if (value?.collection_name) { const deadline = Date.now() + 30; while (Date.now() < deadline) { /* Model an uninterruptible large parameter copy. */ } }
    return nativeClone(value);
  };
  t.after(() => { globalThis.structuredClone = nativeClone; });
  f.client.describeCollection = () => { sdkCalls++; return Promise.resolve(nativeClone(f.schema)); };
  const reader = new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options);
  await assert.rejects(reader.readPublication({}), reject('query-timeout')); assert.equal(sdkCalls, 0);
  await assert.rejects(reader.readPublication({}), reject('halted'));
});

test('raw SDK payload is never async-adopted before descriptor-safe validation', async () => {
  for (const stage of ['schema', 'index', 'count', 'page']) {
    const f = fixture(); let hooks = 0; let calls = 0;
    const payload = {}; const carrier = Promise.resolve(payload);
    // The already-settled native carrier is safe; its fulfilled value is not.
    Object.defineProperty(payload, 'then', { enumerable: true, get() { hooks++; return undefined; } });
    if (stage === 'schema') f.client.describeCollection = () => { calls++; return carrier; };
    else if (stage === 'index') f.client.describeIndex = () => { calls++; return carrier; };
    else { const query = f.client.query; f.client.query = request => {
      if (stage === 'count' || request.output_fields[0] !== 'count(*)') { calls++; return carrier; } return query(request);
    }; }
    await assert.rejects(new subject.MilvusKnowledgeGraphPublicationReadback(f.client, f.options).readPublication({}), reject('invalid-readback'));
    assert.equal(calls, 1); assert.equal(hooks, 0);
  }
});
