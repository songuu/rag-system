import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(`${modulePath}.ts`)
        ? `${modulePath}.ts`
        : path.join(modulePath, 'index.ts');
      return nextResolve(pathToFileURL(target).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  isVectorBackendDisabled,
  resolveRagVectorBackend,
} = await import('./vector-backend.ts');

test('vector backend parser preserves disabled as an explicit maintenance state', () => {
  assert.equal(resolveRagVectorBackend('disabled'), 'disabled');
  assert.equal(resolveRagVectorBackend('off'), 'disabled');
  assert.equal(resolveRagVectorBackend('milvus'), 'milvus');
  assert.equal(resolveRagVectorBackend('memory'), 'milvus');
  assert.equal(resolveRagVectorBackend('unexpected'), 'milvus');
});

test('disabled state is sourced from the runtime environment', () => {
  assert.equal(isVectorBackendDisabled({ RAG_VECTOR_BACKEND: 'disabled' }), true);
  assert.equal(isVectorBackendDisabled({ RAG_VECTOR_BACKEND: 'milvus' }), false);
});
