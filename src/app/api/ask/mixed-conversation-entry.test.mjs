import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const runtime = 'data:text/javascript,' + encodeURIComponent(`
export async function executePreparedAsk(_request, prepared) {
  globalThis.__mixedStub.runtimeCalls = (globalThis.__mixedStub.runtimeCalls ?? 0) + 1;
  globalThis.__mixedStub.prepared = prepared;
  return globalThis.__mixedStub.response();
}
`);
const classifier = 'data:text/javascript,' + encodeURIComponent(`
export async function replyToConversation() { return null; }
export async function classifyConversationIntent() {
  globalThis.__mixedStub.calls++;
  throw new Error('Production must not call the shadow classifier');
}
`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier === './runtime') return { url: runtime, shortCircuit: true };
  if (specifier === '@/lib/rag/conversation-chat') return { url: classifier, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2)) + '.ts').href, context);
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
Object.assign(process.env, { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'mixed-fixture-token',
  RAG_SINGLE_TENANT_ROLE: 'owner', RAG_SINGLE_TENANT_ACTOR_ID: 'actor-mixed',
  RAG_DEFAULT_TENANT_ID: 'tenant-mixed', RAG_DEFAULT_CORPUS_ID: 'corpus-mixed', EMBEDDING_PROVIDER: 'custom' });
const { NextRequest } = await import('next/server');
const { citationPartition } = await import('../../../lib/rag/citations/locator-codec.ts');
const partition = citationPartition({ actorId: 'actor-mixed', tenantId: 'tenant-mixed', corpusId: 'corpus-mixed' });
const { POST } = await import('./route.ts');
const history = [{ role: 'user', content: '我叫小明' }];
function request(question, { authorized = true, signal, identity = partition } = {}) {
  return new NextRequest('http://localhost/api/ask', { method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-rag-conversation-partition': identity,
      ...(authorized ? { authorization: 'Bearer mixed-fixture-token' } : {}) },
    body: JSON.stringify({ question, storageBackend: 'milvus', conversationHistory: history }),
  });
}
const response = () => Response.json({ success: true, answer: '文档内容。[1]', evidence: [{ id: 'e1' }] }, { headers: { 'x-request-id': 'test-id' } });
test('mixed intent preserves authorized RAG evidence while including the verified user statement', async () => {
  globalThis.__mixedStub = { calls: 0, response };
  const result = await POST(request('我是谁，以及总结文档'));
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(globalThis.__mixedStub.prepared.input.question, '总结文档');
  assert.equal(globalThis.__mixedStub.prepared.body.question, '总结文档');
  assert.equal(globalThis.__mixedStub.prepared.input.raw.question, '总结文档');
  assert.equal(body.question, '我是谁，以及总结文档');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(body.answer, /你在本次对话中说过.*我叫小明/);
  assert.match(body.answer, /文档内容。\[1\]/);
  assert.deepEqual(body.evidence, [{ id: 'e1' }]);
  assert.equal(globalThis.__mixedStub.calls, 0);
});

test('successful non-JSON or streaming RAG output fails explicitly rather than omitting a clause', async () => {
  for (const output of [
    () => new Response('event: message\ndata: partial\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    () => Response.json({ success: true, unexpected: 'missing answer' }),
  ]) {
    globalThis.__mixedStub = { calls: 0, response: output };
    const result = await POST(request('我是谁，以及总结文档'));
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).code, 'MIXED_RESPONSE_UNAVAILABLE');
  }
});

test('mixed identity and clock use direct executors even when knowledge retrieval is unavailable', async () => {
  const previous = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  const priorFetch = globalThis.fetch;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  globalThis.fetch = async () => { throw new Error('Direct capabilities must not call a provider'); };
  globalThis.__mixedStub = { calls: 0, runtimeCalls: 0, response };
  try {
    const result = await POST(request('我是谁，现在几点'));
    const body = await result.json();
    assert.equal(result.status, 200);
    assert.match(body.answer, /我叫小明/);
    assert.match(body.answer, /现在.*是/);
    assert.equal(body.processing.retrievalSkipped, true);
    assert.deepEqual(body.evidence, []);
    assert.equal(globalThis.__mixedStub.runtimeCalls, 0);
    assert.equal(globalThis.__mixedStub.calls, 0);
  } finally {
    globalThis.fetch = priorFetch;
    if (previous === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE;
    else process.env.RAG_UNIFIED_PUBLICATION_MODE = previous;
  }
});

test('document-only and failed RAG responses remain unchanged', async () => {
  globalThis.__mixedStub = { calls: 0, response };
  const original = await (await POST(request('总结文档'))).json();
  assert.equal(original.answer, '文档内容。[1]');
  assert.equal(globalThis.__mixedStub.prepared.input.question, '总结文档');
  globalThis.__mixedStub = { calls: 0, response };
  const misclassified = await (await POST(request('总结文档'))).json();
  assert.doesNotMatch(misclassified.answer, /你在本次对话中说过/);
  globalThis.__mixedStub = { calls: 0,
    response: () => Response.json({ success: false, error: 'unavailable' }, { status: 503 }) };
  const failed = await POST(request('我是谁，以及总结文档'));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { success: false, error: 'unavailable' });
});

test('authentication, partition validation and cancellation happen before classification', async () => {
  globalThis.__mixedStub = { calls: 0, response };
  assert.equal((await POST(request('我是谁，以及总结文档', { authorized: false }))).status, 401);
  assert.equal((await POST(request('我是谁，以及总结文档', { identity: 'a'.repeat(64) }))).status, 409);
  const controller = new AbortController(); controller.abort();
  assert.equal((await POST(request('我是谁，以及总结文档', { signal: controller.signal }))).status, 499);
  assert.equal(globalThis.__mixedStub.calls, 0);
});
