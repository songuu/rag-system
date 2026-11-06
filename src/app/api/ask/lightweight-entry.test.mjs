import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ragRuntimeStub = 'data:text/javascript,' + encodeURIComponent(`
export async function executePreparedAsk(_request, prepared) {
  return Response.json({ delegated: true, question: prepared.input.question,
    actorId: prepared.securityContext.actorId, requestId: prepared.requestId });
}
`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier === './runtime') return { url: ragRuntimeStub, shortCircuit: true };
  if (specifier.startsWith('@langchain/') || [
    '@/lib/rag', '@/lib/rag-instance', '@/lib/model-config', '@/lib/milvus-client',
    '@/lib/agentic-rag', '@/lib/adaptive-entity-rag',
  ].includes(specifier)) throw new Error('Direct entry must not load provider runtime: ' + specifier);
  if (specifier.startsWith('@/')) {
    return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2)) + '.ts').href, context);
  }
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
} });

Object.assign(process.env, {
  RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'entry-fixture-token',
  RAG_SINGLE_TENANT_ROLE: 'owner', RAG_SINGLE_TENANT_ACTOR_ID: 'actor-entry',
  RAG_DEFAULT_TENANT_ID: 'tenant-entry', RAG_DEFAULT_CORPUS_ID: 'corpus-entry',
});
const { NextRequest } = await import('next/server');
const { citationPartition } = await import('../../../lib/rag/citations/locator-codec.ts');
const historyPartition = citationPartition({ actorId: 'actor-entry', tenantId: 'tenant-entry', corpusId: 'corpus-entry' });
const { POST } = await import('./route.ts');

function request(question, authorized = true, options = {}) {
  return new NextRequest('http://localhost/api/ask', { method: 'POST',
    signal: options.signal,
    headers: { 'content-type': 'application/json', 'x-request-id': 'lightweight-entry',
      ...(options.partition ? { 'x-rag-conversation-partition': options.partition } : {}),
      ...(authorized ? { authorization: 'Bearer entry-fixture-token' } : {}) },
    body: JSON.stringify({ question, storageBackend: 'milvus', ...options.body }),
  });
}

test('cold direct requests do not import any provider or RAG runtime', async () => {
  for (const question of ['现在几点', '3+2是多少', '你用的是什么模型', '今天上海天气怎么样']) {
    const response = await POST(request(question));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.conversationMode, 'direct');
    assert.deepEqual(body.modelUsage, { llm: false, embedding: false });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('chat follows the latest user statement and does not consult the knowledge base', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('The relation followup requires no provider'); };
  try {
    const first = await POST(request('我是你的爸爸'));
    const firstBody = await first.json();
    assert.equal(firstBody.conversationMode, 'direct');
    assert.match(firstBody.answer, /你说.*我是你的爸爸/);
    assert.deepEqual(firstBody.evidence, []);
    const next = await POST(request('我是你的谁', true, { partition: historyPartition, body: { conversationHistory: [
      { role: 'user', content: '我是你的爸爸' }, { role: 'assistant', content: firstBody.answer },
    ] } }));
    const body = await next.json();
    assert.equal(body.conversationMode, 'direct');
    assert.match(body.answer, /你.*说.*我是你的爸爸/);
    assert.equal(body.processing.retrievalSkipped, true);
    assert.deepEqual(body.evidence, []);
    assert.equal((await POST(request('我是你的爸爸', false))).status, 401);
  } finally { globalThis.fetch = originalFetch; }
});

test('history without the current identity partition is rejected before calling a provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unauthorized history must not reach a provider'); };
  try {
    const body = { conversationHistory: [{ role: 'user', content: '我是你的爸爸' }] };
    for (const partition of [undefined, 'a'.repeat(64)]) {
      const response = await POST(request('我是你的谁', true, { partition, body }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'CONVERSATION_PARTITION_MISMATCH');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('cancelling model-backed chat reports cancellation, not a successful fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.MODEL_PROVIDER;
  const originalEnabled = process.env.RAG_SEMANTIC_ROUTER;
  process.env.MODEL_PROVIDER = 'ollama';
  process.env.RAG_SEMANTIC_ROUTER = 'on';
  let started;
  const modelStarted = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, options) => {
    started();
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const controller = new AbortController();
  try {
    const pending = POST(request('我今天很开心', true, { signal: controller.signal }));
    await modelStarted;
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal((await response.json()).code, 'RAG_REQUEST_ABORTED');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.MODEL_PROVIDER; else process.env.MODEL_PROVIDER = originalProvider;
    if (originalEnabled === undefined) delete process.env.RAG_SEMANTIC_ROUTER; else process.env.RAG_SEMANTIC_ROUTER = originalEnabled;
  }
});

test('ambiguous person followups clarify in Chinese without model or retrieval even with Agent enabled', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Clarification must not call a provider'); };
  try {
    for (const question of ['他是谁', '它有哪些事迹', '它死在哪里']) {
      const response = await POST(request(question, true, { body: { useAgenticRAG: true } }));
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.conversationIntent, 'clarification');
      assert.deepEqual(body.modelUsage, { llm: false, embedding: false });
      assert.deepEqual(body.evidence, []);
      assert.match(body.answer, /具体指|指的是/);
      assert.match(body.answer, /姓名|名称/);
      assert.doesNotMatch(body.answer, /阴山|匈奴|Based on|tool output/);
      assert.equal(body.processing.retrievalSkipped, true);
      assert.doesNotMatch(body.processing.summary, /日常对话/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('knowledge routing delegates already validated identity and input once', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.ok(url.endsWith('/api/embed'));
    return Response.json({ embeddings: [] });
  };
  try {
    const response = await POST(request('请总结文档中的主要结论'));
    assert.deepEqual(await response.json(), { delegated: true,
      question: '请总结文档中的主要结论', actorId: 'actor-entry', requestId: 'lightweight-entry' });
  } finally { globalThis.fetch = originalFetch; }
});

test('unverified semantic inputs do not call a classifier or bypass knowledge routing', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    assert.ok(String(url).endsWith('/api/embed'));
    return Response.json({ embeddings: [] });
  };
  try {
    for (const question of ['介绍一下方案甲', '现在几点帮我写首诗']) {
      const response = await POST(request(question));
      const body = await response.json();
      assert.equal(body.delegated, true, question);
    }
    assert.ok(calls.every(url => url.endsWith('/api/embed')));
  } finally { globalThis.fetch = previousFetch; }
});

test('polite clock paraphrases use the verified system clock without a model or retrieval', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Direct clock must not call a provider'); };
  try {
    const response = await POST(request('请告知当前的钟点'));
    const body = await response.json();
    assert.equal(body.conversationMode, 'direct');
    assert.deepEqual(body.answerSources, ['system-clock']);
    assert.deepEqual(body.modelUsage, { llm: false, embedding: false });
  } finally { globalThis.fetch = previousFetch; }
});

test('lightweight entry still rejects unauthorized requests before any runtime loading', async () => {
  const response = await POST(request('你用的是什么模型', false));
  assert.equal(response.status, 401);
});

test('knowledge requests wait for embedding before retrieval while clock questions remain available', async () => {
  const originalFetch = globalThis.fetch;
  let finish;
  globalThis.fetch = async url => {
    assert.ok(url.endsWith('/api/embed'));
    await new Promise(resolve => { finish = resolve; });
    return Response.json({ embeddings: [] });
  };
  let delegated = false;
  const knowledge = POST(request('请总结文档中的主要结论')).then(response => { delegated = true; return response; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finish, 'function');
    assert.equal(delegated, false, 'cold loading must finish before the retrieval runtime starts');
    assert.equal((await POST(request('现在几点'))).status, 200);
    finish();
    assert.equal((await knowledge).status, 200);
  } finally { finish?.(); globalThis.fetch = originalFetch; await knowledge; }
});

test('failed embedding warmup reports a bounded preparation error without entering retrieval', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'private model path' }, { status: 500 });
  try {
    const response = await POST(request('请总结文档中的主要结论'));
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'EMBEDDING_PRELOAD_FAILED');
    assert.equal(body.delegated, undefined);
    assert.doesNotMatch(body.error, /private model path/);
  } finally { globalThis.fetch = originalFetch; }
});

test('stale embedding selection fails before any model preload', async t => {
  const keys = ['EMBEDDING_PROVIDER', 'OLLAMA_EMBEDDING_MODEL', 'RAG_ALLOWED_EMBEDDING_MODELS'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.EMBEDDING_PROVIDER = 'ollama';
  process.env.OLLAMA_EMBEDDING_MODEL = 'qwen3-embedding';
  process.env.RAG_ALLOWED_EMBEDDING_MODELS = 'nomic-embed-text,qwen3-embedding';
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Stale model must not load.'); };
  const response = await POST(request('请总结文档中的主要结论', true, { body: { embeddingModel: 'nomic-embed-text' } }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'EMBEDDING_INDEX_CHANGED');
  assert.equal(calls, 0);
});

test('cancelling a cold request stops waiting before retrieval', async () => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async () => {
    await new Promise(resolve => { release = resolve; });
    return Response.json({ embeddings: [] });
  };
  const controller = new AbortController();
  const pending = POST(request('请总结文档中的主要结论', true, { signal: controller.signal }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal((await response.json()).code, 'RAG_REQUEST_ABORTED');
  } finally { release?.(); globalThis.fetch = originalFetch; await new Promise(resolve => setImmediate(resolve)); }
});

test('remote embeddings and durable requests do not run synchronous Ollama preparation', async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.EMBEDDING_PROVIDER;
  globalThis.fetch = async () => { throw new Error('Unexpected synchronous model preparation'); };
  try {
    process.env.EMBEDDING_PROVIDER = 'openai';
    assert.equal((await POST(request('请总结文档中的主要结论'))).status, 200);
    process.env.EMBEDDING_PROVIDER = 'ollama';
    assert.equal((await POST(request('请总结文档中的主要结论', true, { body: { executionMode: 'durable' } }))).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = originalProvider;
  }
});
