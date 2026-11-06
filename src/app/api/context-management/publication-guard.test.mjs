import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/context-management') throw new Error('legacy retrieval runtime must not load');
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', `${specifier.slice(2)}.ts`)).href, context);
  return next(specifier, context);
} });
const { GET, POST } = await import('./route.ts');

test('legacy queries reject unified mode before loading retrieval and keep policy first', async () => {
  const keys = ['NODE_ENV', 'RAG_ACCESS_MODE', 'RAG_UNIFIED_PUBLICATION_MODE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const request = action => new Request('http://localhost/api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, sessionId: 'session' }),
  });
  try {
    process.env.NODE_ENV = 'development'; process.env.RAG_ACCESS_MODE = 'local-dev'; process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
    for (const action of ['query', 'stream-query', 'compress']) {
      const response = await POST(request(action));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE');
    }
    assert.equal((await GET(new Request('http://localhost/api/context-management?action=session&sessionId=test'))).status, 503);
    process.env.RAG_ACCESS_MODE = 'single-tenant-token';
    assert.equal((await POST(request('query'))).status, 410);
    assert.equal((await GET(new Request('http://localhost/api/context-management?action=session&sessionId=test'))).status, 410);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
