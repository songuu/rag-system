import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { loadEnvConfig, ModelFactory } = await import('./model-config.ts');

const ENV_KEYS = [
  'MODEL_PROVIDER',
  'REASONING_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_LLM_MODEL',
  'OPENROUTER_REASONING_MODEL',
  'LEMONADE_API_KEY',
  'LEMONADE_BASE_URL',
  'LEMONADE_LLM_MODEL',
  'LEMONADE_REASONING_MODEL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_LLM_DEPLOYMENT',
];

test('loadEnvConfig supports OpenRouter as an OpenAI-compatible provider', () => {
  withEnv(
    {
      MODEL_PROVIDER: 'openrouter',
      REASONING_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_LLM_MODEL: 'deepseek/deepseek-v4-flash',
      OPENROUTER_REASONING_MODEL: 'deepseek/deepseek-v4-pro',
    },
    () => {
      const config = loadEnvConfig();
      assert.equal(config.MODEL_PROVIDER, 'openrouter');
      assert.equal(config.REASONING_PROVIDER, 'openrouter');
      assert.equal(config.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1');
      assert.equal(config.OPENROUTER_LLM_MODEL, 'deepseek/deepseek-v4-flash');
      assert.equal(config.OPENROUTER_REASONING_MODEL, 'deepseek/deepseek-v4-pro');
      assert.equal(config.OPENROUTER_API_KEY, 'sk-or-test');
    }
  );
});

test('loadEnvConfig supports Lemonade local provider without an API key', () => {
  withEnv(
    {
      MODEL_PROVIDER: 'lemonade',
      REASONING_PROVIDER: 'lemonade',
    },
    () => {
      const config = loadEnvConfig();
      assert.equal(config.MODEL_PROVIDER, 'lemonade');
      assert.equal(config.REASONING_PROVIDER, 'lemonade');
      assert.equal(config.LEMONADE_BASE_URL, 'http://localhost:13305/v1');
      assert.equal(config.LEMONADE_LLM_MODEL, 'Gemma-4-26B-A4B-it-GGUF');
      assert.equal(config.LEMONADE_REASONING_MODEL, 'Gemma-4-26B-A4B-it-GGUF');
      assert.equal(config.LEMONADE_API_KEY, undefined);
    }
  );
});

test('validateConfig requires Azure deployment for Azure OpenAI', () => {
  try {
    withEnv(
      {
        MODEL_PROVIDER: 'azure',
        AZURE_OPENAI_API_KEY: 'azure-test-key',
        AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
      },
      () => {
        const factory = ModelFactory.getInstance();
        factory.reloadConfig();

        const validation = factory.validateConfig();
        assert(validation.errors.includes('AZURE_OPENAI_LLM_DEPLOYMENT 环境变量未设置'));
      }
    );
  } finally {
    ModelFactory.getInstance().reloadConfig();
  }
});

function withEnv(vars, callback) {
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
