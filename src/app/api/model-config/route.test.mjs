import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') {
      return nextResolve('next/server.js', context);
    }
    if (specifier.startsWith('@/')) {
      const target = path.resolve(process.cwd(), 'src', `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { GET } = await import('./route.ts');

test('GET exposes model roles and request budgets inside the llm contract', async () => {
  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(typeof body.config.llm.fastModel, 'string');
  assert.equal(typeof body.config.llm.rerankerModel, 'string');
  assert(body.config.llm.requestPolicy.timeoutMs > 0);
  assert(body.config.llm.reasoningRequestPolicy.timeoutMs > 0);
  assert.equal(body.config.fastModel, undefined);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
