import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

let sourceRuntimeLoads = 0;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './document-runtime') { sourceRuntimeLoads++; throw new Error('Document stores must not load before subject validation.'); }
  if (specifier.includes('graph-artifact-runtime')) { sourceRuntimeLoads++; throw new Error('Sources must not load before locator validation.'); }
  if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2)) + '.ts').href, context);
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { GET, POST } = await import('./route.ts');

async function withConfiguration(work) {
  const values = { NODE_ENV: 'test', RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'synthetic-preview-token', RAG_DEFAULT_TENANT_ID: 'tenant-a', RAG_DEFAULT_CORPUS_ID: 'corpus-a', RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a', RAG_CITATION_KEYS: JSON.stringify({ test: Buffer.alloc(32, 7).toString('base64') }), RAG_CITATION_ACTIVE_KEY_ID: 'test', RAG_CITATION_ISSUER: 'test', RAG_CITATION_ENVIRONMENT: 'test' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await work(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('real citation route re-authenticates GET and changes opaque partition when current actor changes', async () => withConfiguration(async () => {
  const request = () => new Request('http://localhost/api/ask/citations/preview', { headers: { authorization: 'Bearer synthetic-preview-token' } });
  assert.equal((await GET(new Request('http://localhost/api/ask/citations/preview'))).status, 401);
  const first = await GET(request()); const body = await first.json();
  assert.equal(body.success, true); assert.match(body.partition, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(body.now)); assert.match(first.headers.get('cache-control'), /no-store/);
  process.env.RAG_SINGLE_TENANT_ACTOR_ID = 'actor-b';
  assert.notEqual((await (await GET(request())).json()).partition, body.partition);
  assert.equal(sourceRuntimeLoads, 0);
}));

test('real citation route refuses invalid locator before loading graph sources and gives explicit unavailable without keys', async () => withConfiguration(async () => {
  const request = () => new Request('http://localhost/api/ask/citations/preview', { method: 'POST', headers: { authorization: 'Bearer synthetic-preview-token' }, body: JSON.stringify({ locator: 'opaque' }) });
  const invalid = await POST(request()); assert.equal(invalid.status, 404); assert.equal((await invalid.json()).error.code, 'RAG_CITATION_INVALID');
  delete process.env.RAG_CITATION_KEYS;
  const absent = await POST(request()); assert.equal(absent.status, 503); assert.equal((await absent.json()).error.code, 'RAG_CITATION_UNAVAILABLE');
  assert.equal(sourceRuntimeLoads, 0);
}));

test('real citation route rejects document locators from another actor before loading document stores', async () => withConfiguration(async () => {
  const { createCitationLocatorCodec } = await import('../../../../../lib/rag/citations/locator-codec.ts');
  const { locator } = createCitationLocatorCodec().encodeDocument({ actorId: 'another-actor', tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'external', chunkId: 'chunk-a', chunkIndex: 0, startOffset: 0, endOffset: 1, chunkHash: 'a'.repeat(64), contentHash: 'a'.repeat(64) });
  const response = await POST(new Request('http://localhost/api/ask/citations/preview', { method: 'POST', headers: { authorization: 'Bearer synthetic-preview-token' }, body: JSON.stringify({ locator }) }));
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, 'RAG_CITATION_INVALID');
  assert.equal(sourceRuntimeLoads, 0);
}));
