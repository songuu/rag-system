import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const {
  assertElasticsearchConfigured,
  getElasticsearchRuntimeConfig,
  resolveElasticsearchRolloutMode,
} = await import('./config.ts');

test('Elasticsearch rollout defaults off and accepts only off, shadow, active', () => {
  assert.equal(resolveElasticsearchRolloutMode({}), 'off');
  assert.equal(resolveElasticsearchRolloutMode({ RAG_ELASTICSEARCH_MODE: 'shadow' }), 'shadow');
  assert.equal(resolveElasticsearchRolloutMode({ RAG_ELASTICSEARCH_MODE: 'active' }), 'active');
  assert.throws(
    () => resolveElasticsearchRolloutMode({ RAG_ELASTICSEARCH_MODE: 'true' }),
    /off, shadow, or active/
  );
});

test('active Elasticsearch validates endpoint, index, and production transport', () => {
  const config = getElasticsearchRuntimeConfig({
    NODE_ENV: 'production',
    RAG_ELASTICSEARCH_MODE: 'active',
    ELASTICSEARCH_URL: 'https://search.example.test:9243',
    ELASTICSEARCH_INDEX: 'rag_chunks_v1',
    ELASTICSEARCH_API_KEY: 'secret-key',
  });
  assert.doesNotThrow(() => assertElasticsearchConfigured(config));
  assert.equal(config.indexName, 'rag_chunks_v1');

  assert.throws(() => assertElasticsearchConfigured(getElasticsearchRuntimeConfig({
    NODE_ENV: 'production',
    RAG_ELASTICSEARCH_MODE: 'active',
    ELASTICSEARCH_URL: 'http://search.example.test:9200',
    ELASTICSEARCH_INDEX: 'rag_chunks_v1',
    ELASTICSEARCH_API_KEY: 'secret-key',
  })), /HTTPS/);
});

test('local container HTTP and unauthenticated access require explicit opt-ins', () => {
  const config = getElasticsearchRuntimeConfig({
    NODE_ENV: 'production',
    RAG_ELASTICSEARCH_MODE: 'shadow',
    ELASTICSEARCH_URL: 'http://elasticsearch:9200',
    ELASTICSEARCH_INDEX: 'rag_chunks_v1',
    ELASTICSEARCH_ALLOW_INSECURE: 'true',
    ELASTICSEARCH_ALLOW_UNAUTHENTICATED: 'true',
  });
  assert.doesNotThrow(() => assertElasticsearchConfigured(config));
});

