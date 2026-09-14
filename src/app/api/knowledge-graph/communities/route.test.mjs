import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const target = path.resolve(process.cwd(), 'src', specifier.slice(2)) + '.ts';
      return nextResolve(pathToFileURL(target).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { GET } = await import('./route.ts');

test('rejects an empty community query before security or graph queries run', async () => {
  const response = await GET(new Request('http://localhost/rag-api/knowledge-graph/communities?q=%20'));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_Q');
});
