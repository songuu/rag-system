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

// === Sprint 2026-05-25: latest parity v2 — 上游 6522780/679130a/b29efe1 同步 ===

test('OpenMAIC notes include Gemini 3.5 Flash (upstream 6522780)', () => {
  const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
    item => item.provider === 'google' && item.model === 'gemini-3.5-flash'
  );
  assert.ok(entry, 'gemini-3.5-flash should be in OPENMAIC_LATEST_MODEL_NOTES');
  assert.equal(entry.category, 'reasoning');
  assert.equal(entry.supportsThinking, true);
  assert.equal(entry.thinkingControl, 'thinking.level');
  assert.equal(entry.status, 'supported');
});

test('Xiaomi MiMo full model lineup matches upstream Token Plan (679130a)', () => {
  const xiaomiEntries = OPENMAIC_LATEST_MODEL_NOTES.filter(item => item.provider === 'xiaomi');
  const ids = xiaomiEntries.map(item => item.model).sort();
  assert.deepEqual(ids, [
    'mimo-v2-flash',
    'mimo-v2-omni',
    'mimo-v2-pro',
    'mimo-v2.5',
    'mimo-v2.5-pro',
  ]);
  for (const entry of xiaomiEntries) {
    assert.equal(entry.status, 'supported', `${entry.model} should be supported, not documented`);
    assert.equal(entry.supportsThinking, true);
  }
});

test('Lemonade curated to Gemma-4 only (upstream b29efe1 removed weak models)', () => {
  const lemonadeEntries = OPENMAIC_LATEST_MODEL_NOTES.filter(item => item.provider === 'lemonade');
  assert.equal(lemonadeEntries.length, 1, 'exactly one curated lemonade model expected');
  assert.equal(lemonadeEntries[0].model, 'Gemma-4-26B-A4B-it-GGUF');
  assert.ok(
    !OPENMAIC_LATEST_MODEL_NOTES.some(item => item.model === 'Qwen3.5-4B-GGUF'),
    'weak Qwen3.5-4B-GGUF lemonade entry should be removed'
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
