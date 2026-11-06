import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@langchain/') || specifier.includes('milvus-client')
    || specifier.includes('rag-instance') || specifier.includes('citations/runtime')) {
    throw new Error('Identity endpoint must not load model or knowledge runtime.');
  }
  if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2)) + '.ts').href, context);
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { GET } = await import('./route.ts');

test('identity authenticates independently of the unified publication read guard', async () => {
  const values = { NODE_ENV: 'test', RAG_ACCESS_MODE: 'single-tenant-token',
    RAG_SINGLE_TENANT_TOKEN: 'synthetic-identity-token', RAG_DEFAULT_TENANT_ID: 'tenant-a',
    RAG_DEFAULT_CORPUS_ID: 'corpus-a', RAG_SINGLE_TENANT_ROLE: 'viewer',
    RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a', RAG_UNIFIED_PUBLICATION_MODE: 'active' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const request = (headers = {}) => new Request('http://localhost/api/ask/conversation-identity', { headers });
  try {
    const unauthenticated = await GET(request());
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, 'RAG_AUTH_REQUIRED');
    const headers = { authorization: 'Bearer synthetic-identity-token' };
    const forbidden = await GET(request({ ...headers, 'x-rag-corpus-id': 'other-corpus' }));
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'RAG_CORPUS_FORBIDDEN');
    const first = await GET(request(headers));
    assert.equal(first.status, 200);
    assert.match(first.headers.get('cache-control'), /no-store/);
    const body = await first.json();
    assert.equal(body.success, true);
    assert.match(body.partition, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(body.now));
    assert.deepEqual(Object.keys(body).sort(), ['now', 'partition', 'success']);
    process.env.RAG_SINGLE_TENANT_ACTOR_ID = 'actor-b';
    assert.notEqual((await (await GET(request(headers))).json()).partition, body.partition);
  } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
