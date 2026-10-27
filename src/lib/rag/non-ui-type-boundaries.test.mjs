import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { PreTrainedTokenizer } from '@xenova/transformers';
import ts from 'typescript';

const plain = value => JSON.parse(JSON.stringify(value));
function load(relative, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const testModule = { exports: {} };
  vm.runInNewContext(compiled.outputText, { module: testModule, exports: testModule.exports,
    Date, Map, TextEncoder, queueMicrotask, Response,
    console: { log() {}, warn() {}, error() {} },
    indexedDB: { open() { assert.fail('Live IndexedDB must not be used'); } },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected runtime dependency: ${name}`);
      return dependencies[name];
    }, ...globals });
  return testModule.exports;
}

function localTokenizer() {
  return new PreTrainedTokenizer({ model: { type: 'WordLevel',
    vocab: { '[UNK]': 0, alpha: 1, beta: 2 }, unk_token: '[UNK]' },
  normalizer: null, pre_tokenizer: { type: 'Whitespace' }, post_processor: null,
  decoder: null, added_tokens: [] }, { unk_token: '[UNK]' });
}
function captureFixture(tokenizer) {
  let loads = 0;
  const { DecisionCaptureEngine } = load('../analysis-middleware/decision-capture-engine.ts', {
    '@xenova/transformers': { AutoTokenizer: { async from_pretrained(model) {
      assert.equal(model, 'offline-tokenizer'); loads++; return tokenizer;
    } } },
  });
  return { engine: new DecisionCaptureEngine('offline-tokenizer'), loads: () => loads };
}

test('decision capture uses the installed tokenizer single-text signature without model download', async () => {
  const { engine, loads } = captureFixture(localTokenizer());
  const result = await engine.captureDecisions('alpha beta');
  assert.deepEqual(plain(result.tokenDecisions.map(token => token.token)), ['alpha', 'beta']);
  assert.deepEqual(plain(result.waterfall.stages.map(stage => stage.level)), ['bytes', 'characters', 'subwords', 'fullwords']);
  assert.equal(result.waterfall.finalTokenCount, 2);
  await engine.captureDecisions('beta');
  assert.equal(loads(), 1);
});

test('decision capture reads the installed tokenizer canonical token-to-id vocabulary', async () => {
  const tokenizer = localTokenizer();
  assert.ok(Array.isArray(tokenizer.model.vocab));
  const { engine } = captureFixture(tokenizer);
  await engine.initialize();
  assert.equal(engine.getVocabSize(), 3);
});

for (const [name, fields] of [
  ['model-map', { model: { vocab: new Map([['alpha', 1], ['beta', 2], [false, 'invalid']]) } }],
  ['model-encoder', { model: { encoder: { alpha: 1, beta: 2, invalid: 'ignored' } } }],
  ['root-vocab', { vocab: { alpha: 1, beta: 2 } }],
  ['nested-vocab', { tokenizer_: { model: { vocab: { alpha: 1, beta: 2 } } } }],
]) test(`decision capture retains legacy vocabulary layout ${name} and decode fallback`, async () => {
  const { engine } = captureFixture({ ...fields,
    encode(text, pair, options) {
      assert.equal(text, 'alpha beta'); assert.equal(pair, null);
      assert.equal(options.add_special_tokens, false); return [1, 2];
    },
    batch_decode() { throw new Error('synthetic decoder unavailable'); },
  });
  const result = await engine.captureDecisions('alpha beta');
  assert.equal(engine.getVocabSize(), 2);
  assert.deepEqual(plain(result.tokenDecisions.map(token => token.token)), ['alpha', 'beta']);
});

function milvusFixture(storageBackend = 'milvus') {
  const calls = { connect: 0, initialize: 0, queries: [], inserted: [], searches: [], clears: 0 };
  const metadata = { source: 'offline', nested: { level: 1 }, tags: ['sample'] };
  const client = {
    async connect() { calls.connect++; }, async initializeCollection() { calls.initialize++; },
    async insertDocuments(documents) { calls.inserted.push(...documents); },
    async search(...args) { calls.searches.push(args); return [{ id: 'source-1', content: 'sample', score: 0.87, metadata }]; },
    async getCollectionStats() { return { rowCount: 2 }; }, isReady() { return true; },
    async clearCollection() { calls.clears++; },
  };
  let ids = 0;
  const { MilvusRAGSystem } = load('../rag-milvus.ts', {
    '@langchain/core/prompts': { ChatPromptTemplate: {} },
    '@langchain/core/output_parsers': { StringOutputParser: class {} },
    './milvus-client': { getMilvusInstance: () => client },
    './observability': { ObservabilityEngine: class {} },
    uuid: { v4: () => `offline-${++ids}` },
    './model-config': { getModelFactory: () => ({ getEnvConfig: () => ({
      OLLAMA_BASE_URL: 'http://offline.invalid', OPENAI_LLM_MODEL: 'offline-llm',
    }), getProvider: () => 'offline' }), isOllamaProvider: () => false,
    createLLM: () => ({}), createEmbedding: () => ({ async embedQuery(text) { calls.queries.push(text); return [0.1, 0.2]; } }) },
    './embedding-config': { getEmbeddingConfigSummary: () => ({ model: 'offline-embedding' }), getEmbeddingProvider: () => 'offline' },
  });
  return { system: new MilvusRAGSystem({ storageBackend }), calls, metadata };
}
test('Milvus RAG preserves metadata and forwards original search arguments to the offline adapter', async () => {
  const { system, calls, metadata } = milvusFixture();
  const results = await system.search('query', 7, 0.42);
  assert.deepEqual(plain(results), [{ content: 'sample', similarity: 0.87, metadata, id: 'source-1' }]);
  assert.deepEqual(plain(calls.searches), [[[0.1, 0.2], 7, 0.42]]);
  await system.initialize(); assert.equal(calls.connect, 1); assert.equal(calls.initialize, 1);
});
test('Milvus RAG preserves document metadata and status without contacting a real database', async () => {
  const { system, calls, metadata } = milvusFixture();
  assert.deepEqual(plain(await system.addDocuments([{ content: 'first', metadata }, { content: 'second' }])), ['offline-1', 'offline-2']);
  assert.deepEqual(plain(calls.inserted.map(doc => doc.metadata)), [metadata, {}]);
  assert.deepEqual(plain(await system.getStatus()), { initialized: true, backend: 'milvus', documentCount: 2, milvusConnected: true });
  await system.clear(); assert.equal(calls.clears, 1);
});
test('Milvus RAG memory mode does not dispatch to the Milvus adapter', async () => {
  const { system, calls } = milvusFixture('memory');
  assert.deepEqual(plain(await system.search('query')), []);
  await system.clear();
  assert.equal(calls.connect, 0); assert.equal(calls.searches.length, 0); assert.equal(calls.clears, 0);
});

function reasoningFixture() {
  const { reasoningDB } = load('../reasoning-indexeddb.ts');
  const rows = new Map();
  const request = work => {
    const result = {};
    queueMicrotask(() => { result.result = work(); result.onsuccess?.(); });
    return result;
  };
  reasoningDB.db = { transaction(names) {
    assert.deepEqual(plain(names), ['conversations']);
    return { objectStore: () => ({
      get: id => request(() => rows.get(id)),
      put: row => request(() => { rows.set(row.id, structuredClone(row)); return row.id; }),
      count: () => request(() => rows.size),
      openCursor() {
        const pending = {}, values = [...rows.values()]; let index = 0;
        const step = () => pending.onsuccess({ target: { result: index < values.length ? {
          value: values[index], continue() { index++; queueMicrotask(step); },
        } : null } });
        queueMicrotask(step); return pending;
      },
    }) };
  } };
  return { db: reasoningDB, rows };
}
test('reasoning persistence normalizes dates, sorts conversations and retains opaque thinking metadata', async () => {
  const { db, rows } = reasoningFixture();
  for (const [id, date] of [['old', '2020-01-01'], ['new', '2021-01-01']]) rows.set(id, {
    id, title: id, createdAt: date, updatedAt: date,
    messages: [{ id: 'm', timestamp: date, thinkingProcess: [{ metadata: { nested: { value: 2 }, tags: ['local'] } }] }],
  });
  const result = await db.getAllConversations();
  assert.deepEqual(plain(result.map(row => row.id)), ['new', 'old']);
  assert.ok(result[0].updatedAt instanceof Date); assert.ok(result[0].messages[0].timestamp instanceof Date);
  assert.deepEqual(plain(result[0].messages[0].thinkingProcess[0].metadata), { nested: { value: 2 }, tags: ['local'] });
  assert.equal(await db.getConversation('missing'), null); assert.equal(await db.getConversationCount(), 2);
});
test('reasoning persistence keeps message update behavior in an owned in-memory adapter', async () => {
  const { db } = reasoningFixture();
  const conversation = await db.createConversation('local');
  await db.addMessage(conversation.id, { id: 'message', type: 'assistant', content: 'answer', timestamp: new Date(0) });
  await db.updateMessage(conversation.id, 'message', { thinkingProcess: [{ id: 'step', type: 'reasoning', timestamp: 1, content: 'local', metadata: { opaque: [1, true] } }] });
  const restored = await db.getConversation(conversation.id);
  assert.equal(restored.messages[0].content, 'answer');
  assert.deepEqual(plain(restored.messages[0].thinkingProcess[0].metadata), { opaque: [1, true] });
  await assert.rejects(db.addMessage('missing', {}));
});

function expansionFixture() {
  const calls = []; const config = { maxSuggestions: 3 };
  const engine = { updateConfig(value) { Object.assign(config, value); }, getConfig: () => ({ ...config }),
    async expand(...args) { calls.push(args); return { suggestions: [], anchor: {}, processingTime: 1, timings: {} }; } };
  const route = load('../../app/api/conversation-expansion/route.ts', {
    'next/server': { NextResponse: { json: (value, options) => Response.json(value, options) } },
    '@/lib/conversation-expansion': { createExpansionEngine: () => engine },
  });
  return { ...route, calls, engine };
}
const post = (fixture, body) => fixture.POST(new Request('http://offline.invalid', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
test('conversation expansion retains legacy chunk defaults, pageContent fallback and metadata', async () => {
  const f = expansionFixture();
  const response = await post(f, { userQuery: 'query', aiResponse: 'answer', contextChunks: [
    { id: 'explicit', content: 'body', score: 0.8, metadata: { tags: ['offline'] } }, { pageContent: 'page' }, {},
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual(plain(f.calls[0]), ['query', 'answer', [
    { id: 'explicit', content: 'body', score: 0.8, metadata: { tags: ['offline'] } },
    { id: 'chunk-1', content: 'page', metadata: {} }, { id: 'chunk-2', content: '', metadata: {} },
  ]]);
});
test('conversation expansion keeps configuration updates and GET behavior', async () => {
  const f = expansionFixture();
  assert.equal((await f.GET()).status, 200);
  assert.equal((await post(f, { action: 'update-config', config: { enableValidation: false } })).status, 200);
  assert.equal((await (await f.GET()).json()).config.enableValidation, false);
});
test('conversation expansion preserves invalid-request statuses without dispatch', async () => {
  const f = expansionFixture();
  for (const body of [{}, { action: 'update-config' }, { action: 'unknown' }]) assert.equal((await post(f, body)).status, 400);
  assert.equal(f.calls.length, 0);
});
test('conversation expansion preserves error handling for a failed offline engine', async () => {
  const f = expansionFixture();
  f.engine.expand = async () => { throw new Error('synthetic unavailable'); };
  assert.equal((await post(f, { userQuery: 'query', aiResponse: 'answer' })).status, 500);
});
