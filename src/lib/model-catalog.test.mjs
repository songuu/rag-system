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

const {
  OPENMAIC_LATEST_MODEL_NOTES,
  categorizeModelName,
  getModelCapabilityProfile,
} = await import('./model-catalog.ts');

test('categorizeModelName recognizes OpenMAIC latest reasoning model families', () => {
  assert.equal(categorizeModelName('deepseek/deepseek-v4-pro'), 'reasoning');
  assert.equal(categorizeModelName('Qwen3.5-4B-GGUF'), 'reasoning');
  assert.equal(categorizeModelName('gpt-oss:20b'), 'reasoning');
  assert.equal(categorizeModelName('text-embedding-3-small'), 'embedding');
  assert.equal(categorizeModelName('llama3.1:latest'), 'llm');
});

test('getModelCapabilityProfile exposes OpenRouter and Lemonade thinking hints', () => {
  assert.deepEqual(getModelCapabilityProfile('openrouter', 'deepseek/deepseek-v4-pro'), {
    supportsThinking: true,
    thinkingControl: 'reasoning.effort',
    openMaicLatest: true,
  });

  assert.deepEqual(getModelCapabilityProfile('lemonade', 'custom-gpt-oss-20b-q4'), {
    supportsThinking: true,
    thinkingControl: 'chat_template_kwargs.enable_thinking',
    openMaicLatest: false,
  });
});

test('OpenMAIC latest notes keep provider-only increments documented', () => {
  assert.ok(OPENMAIC_LATEST_MODEL_NOTES.some(item => item.provider === 'bocha'));
  assert.ok(OPENMAIC_LATEST_MODEL_NOTES.some(item => item.provider === 'happyhorse'));
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
