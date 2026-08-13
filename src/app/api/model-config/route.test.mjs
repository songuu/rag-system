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
const { getModelFactory } = await import('@/lib/model-config');
const { reloadEmbeddingConfig } = await import('@/lib/embedding-config');

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

test('GET reports each missing Embedding setting only once in the overall summary', async () => {
  const keys = [
    'MODEL_PROVIDER',
    'CUSTOM_API_KEY',
    'CUSTOM_BASE_URL',
    'EMBEDDING_PROVIDER',
    'CUSTOM_EMBEDDING_API_KEY',
    'CUSTOM_EMBEDDING_BASE_URL',
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  try {
    Object.assign(process.env, {
      MODEL_PROVIDER: 'custom',
      CUSTOM_API_KEY: 'test-llm-key',
      CUSTOM_BASE_URL: 'https://llm.example.test/v1',
      EMBEDDING_PROVIDER: 'custom',
    });
    delete process.env.CUSTOM_EMBEDDING_API_KEY;
    delete process.env.CUSTOM_EMBEDDING_BASE_URL;
    getModelFactory().reloadConfig();
    reloadEmbeddingConfig();

    const response = await GET();
    const body = await response.json();
    const errors = body.validation.overall.errors;

    assert.equal(response.status, 200);
    assert.equal(errors.filter(error => error === 'CUSTOM_EMBEDDING_API_KEY 环境变量未设置').length, 1);
    assert.equal(errors.filter(error => error === 'CUSTOM_EMBEDDING_BASE_URL 环境变量未设置').length, 1);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    getModelFactory().reloadConfig();
    reloadEmbeddingConfig();
  }
});

test('GET reports active provider models that are absent from configured request allowlists', async () => {
  const keys = [
    'MODEL_PROVIDER',
    'CUSTOM_API_KEY',
    'CUSTOM_BASE_URL',
    'CUSTOM_LLM_MODEL',
    'EMBEDDING_PROVIDER',
    'CUSTOM_EMBEDDING_API_KEY',
    'CUSTOM_EMBEDDING_BASE_URL',
    'CUSTOM_EMBEDDING_MODEL',
    'RAG_ALLOWED_LLM_MODELS',
    'RAG_ALLOWED_EMBEDDING_MODELS',
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  try {
    Object.assign(process.env, {
      MODEL_PROVIDER: 'custom',
      CUSTOM_API_KEY: 'test-llm-key',
      CUSTOM_BASE_URL: 'https://llm.example.test/v1',
      CUSTOM_LLM_MODEL: 'active-llm',
      EMBEDDING_PROVIDER: 'custom',
      CUSTOM_EMBEDDING_API_KEY: 'test-embedding-key',
      CUSTOM_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
      CUSTOM_EMBEDDING_MODEL: 'active-embedding',
      RAG_ALLOWED_LLM_MODELS: 'other-llm',
      RAG_ALLOWED_EMBEDDING_MODELS: 'other-embedding',
    });
    getModelFactory().reloadConfig();
    reloadEmbeddingConfig();

    const response = await GET();
    const body = await response.json();
    const errors = body.validation.overall.errors;

    assert.equal(response.status, 200);
    assert.equal(body.validation.overall.valid, false);
    assert(errors.includes('Active LLM model "active-llm" is not in RAG_ALLOWED_LLM_MODELS.'));
    assert(errors.includes('Active Embedding model "active-embedding" is not in RAG_ALLOWED_EMBEDDING_MODELS.'));
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    getModelFactory().reloadConfig();
    reloadEmbeddingConfig();
  }
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
