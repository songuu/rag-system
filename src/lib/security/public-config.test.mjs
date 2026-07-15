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

const { toPublicMilvusConfig, toPublicServiceHealth } = await import('./public-config.ts');

test('toPublicMilvusConfig never serializes credentials or internal endpoints', () => {
  const output = toPublicMilvusConfig(
    {
      address: 'internal.milvus.local:19530',
      endpoint: 'https://private.example',
      username: 'admin',
      password: 'hunter2',
      token: 'zilliz-secret',
      defaultCollection: 'rag_documents',
      defaultDimension: 768,
      ssl: true,
    },
    { provider: 'zilliz', isZillizCloud: true }
  );
  assert.deepEqual(output, {
    provider: 'zilliz',
    isZillizCloud: true,
    configured: true,
    hasCredentials: true,
    ssl: true,
    collectionName: 'rag_documents',
    embeddingDimension: 768,
  });
  const serialized = JSON.stringify(output);
  for (const secret of ['internal.milvus.local', 'private.example', 'admin', 'hunter2', 'zilliz-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('toPublicMilvusConfig exposes only explicitly selected operational fields', () => {
  const output = toPublicMilvusConfig({
    address: 'localhost:19530',
    collectionName: 'docs',
    embeddingDimension: 1024,
    indexType: 'HNSW',
    metricType: 'COSINE',
    consistencyLevel: 'Bounded',
    ignoreGrowing: true,
    debugLogs: false,
    searchParams: { password: 'must-not-leak' },
  });
  assert.equal(output.collectionName, 'docs');
  assert.equal(output.embeddingDimension, 1024);
  assert.equal('searchParams' in output, false);
});

test('toPublicServiceHealth never reflects connection errors', () => {
  const output = toPublicServiceHealth({
    healthy: false,
    message: 'dial token=secret@internal.milvus.local:19530 failed',
  });
  assert.deepEqual(output, {
    healthy: false,
    message: 'Service is unavailable.',
  });
});
