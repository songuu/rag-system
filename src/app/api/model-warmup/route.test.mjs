import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@langchain/') || specifier === '@/lib/model-config') throw new Error('Warmup must remain SDK-free.');
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2)) + '.ts').href, context);
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(url) && existsSync(new URL(url.href + '.ts'))) return nextResolve(url.href + '.ts', context);
  }
  return nextResolve(specifier, context);
} });
const { POST, GET } = await import('./route.ts');

test('warmup enforces authentication and model allowlists before touching Ollama', async () => {
  const env = { MODEL_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://localhost:11434',
    RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'fixture-warmup-token',
    RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_SINGLE_TENANT_ACTOR_ID: 'warmup-fixture',
    RAG_DEFAULT_TENANT_ID: 'warmup-tenant', RAG_DEFAULT_CORPUS_ID: 'warmup-corpus', RAG_ALLOWED_LLM_MODELS: 'fixture-model', RAG_SEMANTIC_ROUTER: 'off',
    EMBEDDING_PROVIDER: 'ollama', OLLAMA_EMBEDDING_MODEL: 'fixture-embedding', RAG_ALLOWED_EMBEDDING_MODELS: 'fixture-embedding' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.endsWith('/api/embed') ? { embeddings: [] } : { done: true });
  };
  const request = (model, token = true, embeddingModel) => new Request('http://localhost/api/model-warmup', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer fixture-warmup-token' } : {}) },
    body: JSON.stringify({ llmModel: model, embeddingModel, baseUrl: 'http://attacker.invalid' }),
  });
  try {
    assert.equal((await POST(request('fixture-model', false))).status, 401);
    assert.equal((await POST(request('unapproved'))).status, 403);
    assert.equal((await POST(request('fixture-model', true, 'unapproved-embedding'))).status, 403);
    assert.equal(calls.length, 0);
    const result = await POST(request('fixture-model'));
    assert.equal(result.status, 202);
    assert.equal((await result.json()).readiness.phase, 'loading');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await GET(new Request('http://localhost/api/model-warmup?model=fixture-model', { headers: { authorization: 'Bearer fixture-warmup-token' } }))).status, 200);
    assert.equal((await GET(new Request('http://localhost/api/model-warmup?model=fixture-model'))).status, 401);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls.map(call => call.url), ['http://localhost:11434/api/embed', 'http://localhost:11434/api/generate']);
    assert.equal(calls[0].body.model, 'fixture-embedding');
    assert.equal(calls[0].body.options.num_ctx, 8192);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
