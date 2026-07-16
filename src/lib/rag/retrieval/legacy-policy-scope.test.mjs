import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { resolveLegacyMilvusSearchArguments } = await import('./legacy-policy-scope.ts');
const { createRetrievalScope, isServerDerivedScope } = await import('../../security/retrieval-scope.ts');

test('authenticated legacy search binds the server scope and drops an LLM filter', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    enforceIsolation: true,
  });
  const resolved = resolveLegacyMilvusSearchArguments({
    retrievalScope: scope,
    threshold: 0.42,
    legacyLocalFilter: 'content like "unsafe%"',
  });

  assert.equal(resolved.mode, 'server-scope');
  assert.equal(resolved.filter, undefined);
  assert.equal(typeof resolved.options, 'object');
  assert.equal(resolved.options.threshold, 0.42);
  assert.equal(isServerDerivedScope(resolved.options), true);
  assert.deepEqual(resolved.options.exprValues, {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  });
});

test('local legacy search preserves the compatibility filter', () => {
  const resolved = resolveLegacyMilvusSearchArguments({
    threshold: 0.3,
    legacyLocalFilter: 'content like "safe-local%"',
  });

  assert.deepEqual(resolved, {
    options: 0.3,
    filter: 'content like "safe-local%"',
    mode: 'legacy-local',
  });
});

test('explicit non-isolated local scope preserves the compatibility filter and mode', () => {
  const localScope = createRetrievalScope({
    tenantId: 'local-tenant',
    corpusId: 'local-corpus',
    enforceIsolation: false,
  });
  const resolved = resolveLegacyMilvusSearchArguments({
    retrievalScope: localScope,
    threshold: 0.3,
    legacyLocalFilter: 'content like "safe-local%"',
  });

  assert.deepEqual(resolved, {
    options: 0.3,
    filter: 'content like "safe-local%"',
    mode: 'legacy-local',
  });
});
