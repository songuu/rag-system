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
const { POST } = await import('./route.ts');

function request(question, authorized = true, options = {}) {
  return new NextRequest('http://localhost/api/ask', { method: 'POST',
    signal: options.signal,
    headers: { 'content-type': 'application/json', 'x-request-id': 'lightweight-entry',
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

test('semantic capability routing preserves verified clock execution and reports classifier model usage', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify({ complete: true,
    actions: [{ intent: 'current-time', timeZone: 'Asia/Shanghai', dayOffset: 0 }] }) } });
  try {
    const response = await POST(request('请告知当前的钟点'));
    const body = await response.json();
    assert.equal(body.conversationMode, 'direct');
    assert.equal(body.routing.reason, 'semantic-capabilities');
    assert.deepEqual(body.answerSources, ['system-clock']);
    assert.deepEqual(body.modelUsage, { llm: true, embedding: false });
    assert.equal(body.routingModel, 'qwen2.5:0.5b');
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
