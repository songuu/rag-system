import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { vectorizeAndInsert, insertDocumentsWithEmbeddings } = await import('./vectorization-utils.ts');

test('direct legacy vector insertion refuses active publication before touching provider', async () => {
  const old = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  const provider = new Proxy({}, { get() { throw new Error('provider was touched'); } });
  try {
    for (const call of [() => vectorizeAndInsert(provider, []), () => insertDocumentsWithEmbeddings(provider, [])]) {
      await assert.rejects(call, error => error.code === 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE' && error.status === 503);
    }
  } finally {
    if (old === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE;
    else process.env.RAG_UNIFIED_PUBLICATION_MODE = old;
  }
});
