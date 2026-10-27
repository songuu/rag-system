import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const security = { actorId: 'actor-a', tenantId: 'tenant-a', corpusId: 'corpus-a', role: 'viewer', accessMode: 'single-tenant-token', requestId: 'request-a', enforceIsolation: true };

test('GET re-authenticates and returns only an opaque current partition and clock without loading sources', async () => {
  const { createCitationPreviewHandlers } = await import('./http.ts');
  let authorizations = 0; let previews = 0;
  const handlers = createCitationPreviewHandlers({ async resolveSecurity() { authorizations++; return security; }, async preview() { previews++; throw new Error(); }, clock: () => 1_800_000_000_000 });
  const response = await handlers.GET(new Request('http://localhost/api/ask/citations/preview?actorId=other'));
  const body = await response.json(); assert.equal(body.success, true); assert.match(body.partition, /^[a-f0-9]{64}$/); assert.equal(body.now, 1_800_000_000_000);
  assert.equal(authorizations, 1); assert.equal(previews, 0); assert.ok(!JSON.stringify(body).includes('actor-a')); assert.match(response.headers.get('cache-control'), /no-store/);
});

test('POST accepts only the opaque locator and uses newly resolved security context', async () => {
  const { createCitationPreviewHandlers } = await import('./http.ts');
  let observed;
  const handlers = createCitationPreviewHandlers({ async resolveSecurity() { return security; }, async preview(input) { observed = input; return { success: true, content: '原文', contentTruncated: false, relations: [] }; } });
  const response = await handlers.POST(new Request('http://localhost/api/ask/citations/preview', { method: 'POST', body: JSON.stringify({ locator: 'opaque' }) }));
  assert.equal(response.status, 200); assert.equal(observed.security, security); assert.equal(observed.locator, 'opaque'); assert.equal((await response.json()).content, '原文');
  for (const body of [{ locator: 'opaque', url: 'http://other' }, { documentId: 'doc-a' }, { locator: 'a'.repeat(8193) }]) {
    assert.equal((await handlers.POST(new Request('http://localhost/api/ask/citations/preview', { method: 'POST', body: JSON.stringify(body) }))).status, 400);
  }
});

test('denies authentication failures before reading request or returning any preview content', async () => {
  const { createCitationPreviewHandlers } = await import('./http.ts');
  const { RagSecurityError } = await import('../../security/request-context.ts');
  const handlers = createCitationPreviewHandlers({ async resolveSecurity() { throw new RagSecurityError({ code: 'RAG_AUTH_INVALID', status: 401, message: 'Authentication failed.', requestId: 'auth-failure' }); }, async preview() { throw new Error('must not run'); } });
  for (const response of [await handlers.GET(new Request('http://localhost')), await handlers.POST(new Request('http://localhost', { method: 'POST', body: '{}' }))]) {
    assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'RAG_AUTH_INVALID'); assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('keeps storage errors content-free and rejects oversized preview requests', async () => {
  const { createCitationPreviewHandlers } = await import('./http.ts');
  const handlers = createCitationPreviewHandlers({ async resolveSecurity() { return security; }, async preview() { throw new Error('private source text and database password'); } });
  const response = await handlers.POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ locator: 'opaque' }) }));
  assert.equal(response.status, 503); const text = await response.text(); assert.ok(!text.includes('private')); assert.ok(!text.includes('password'));
  const large = await handlers.POST(new Request('http://localhost', { method: 'POST', body: '{}', headers: { 'content-length': '20000' } }));
  assert.equal(large.status, 413);
});
