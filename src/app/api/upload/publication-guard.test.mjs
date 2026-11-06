import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', `${specifier.slice(2)}.ts`)).href, context);
  try { return next(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const upload = await import('./route.ts');
const files = await import('../files/route.ts');
const maic = await import('../maic/upload/route.ts');

test('legacy upload and file routes fail closed before touching files', async () => {
  const keys = ['NODE_ENV', 'RAG_ACCESS_MODE', 'RAG_UNIFIED_PUBLICATION_MODE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const request = () => new Request('http://localhost/api/upload', { method: 'POST' });
  try {
    process.env.NODE_ENV = 'development'; process.env.RAG_ACCESS_MODE = 'local-dev';
    for (const mode of ['active', 'invalid']) {
      process.env.RAG_UNIFIED_PUBLICATION_MODE = mode;
      for (const response of [await upload.POST(request()), await files.GET(), await maic.POST(request())]) {
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE');
      }
      assert.equal((await upload.GET()).status, 200);
    }
    process.env.RAG_ACCESS_MODE = 'single-tenant-token';
    assert.equal((await upload.POST(request())).status, 410);
    assert.equal((await files.GET()).status, 410);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
