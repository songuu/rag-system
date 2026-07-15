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

const {
  createLegacyRagRouteResponse,
  getLegacyRagRouteBlock,
} = await import('./legacy-route-policy.ts');

test('legacy routes remain available only in non-production local-dev', () => {
  assert.equal(getLegacyRagRouteBlock({ NODE_ENV: 'development' }), null);
  assert.equal(
    getLegacyRagRouteBlock({ NODE_ENV: 'test', RAG_ACCESS_MODE: ' LOCAL-DEV ' }),
    null
  );
});

test('legacy routes fail closed in production even with local-dev mode', () => {
  const block = getLegacyRagRouteBlock({
    NODE_ENV: 'production',
    RAG_ACCESS_MODE: 'local-dev',
  });
  assert.deepEqual(block, {
    status: 410,
    code: 'LEGACY_RAG_ROUTE_DISABLED',
    message: 'This legacy RAG route is disabled outside local development.',
  });
});

test('legacy routes fail closed for every explicit authenticated mode and alias', () => {
  for (const env of [
    { NODE_ENV: 'development', RAG_ACCESS_MODE: 'single-tenant-token' },
    { NODE_ENV: 'development', RAG_ACCESS_MODE: 'supabase' },
    { NODE_ENV: 'development', RAG_AUTH_MODE: 'supabase' },
    { NODE_ENV: 'development', RAG_ACCESS_MODE: 'invalid' },
  ]) {
    assert.equal(getLegacyRagRouteBlock(env)?.code, 'LEGACY_RAG_ROUTE_DISABLED');
  }
});

test('legacy route response exposes only a stable public 410 payload', async () => {
  const response = createLegacyRagRouteResponse({
    NODE_ENV: 'production',
    RAG_ACCESS_MODE: 'supabase',
  });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    success: false,
    error: 'This legacy RAG route is disabled outside local development.',
    code: 'LEGACY_RAG_ROUTE_DISABLED',
  });
});
