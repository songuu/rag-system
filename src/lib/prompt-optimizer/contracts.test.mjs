import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });

const { extractVariableNames, interpolateVariables, parseOptimizerOutput, validateOptimizeInput } =
  await import('./contracts.ts');

test('extractVariableNames returns stable unique valid variables', () => {
  assert.deepEqual(extractVariableNames('写一篇关于 {{topic}} 的 {{tone}} 文案，主题仍是 {{topic}}。'), ['topic', 'tone']);
  assert.deepEqual(extractVariableNames('{{not-valid}} {{9bad}}'), []);
});

test('interpolateVariables requires every value and rejects oversized values', () => {
  assert.equal(interpolateVariables('Hello {{name}}', { name: 'Ada' }), 'Hello Ada');
  assert.throws(() => interpolateVariables('{{missing}}', {}), /missing variable.*missing/i);
  assert.throws(() => interpolateVariables('{{value}}', { value: 'x'.repeat(4001) }), /4000/);
});

test('parseOptimizerOutput supports fenced JSON and a safe plain-text fallback', () => {
  assert.deepEqual(parseOptimizerOutput('```json\n{"prompt":"更好的提示词","analysis":{"summary":"更清晰","improvements":["补充角色"]}}\n```'), {
    prompt: '更好的提示词',
    analysis: { summary: '更清晰', improvements: ['补充角色'] },
  });
  assert.deepEqual(parseOptimizerOutput('直接输出的提示词'), {
    prompt: '直接输出的提示词',
    analysis: { summary: '', improvements: [] },
  });
});

test('validateOptimizeInput applies bounds and rejects unknown fields', () => {
  assert.deepEqual(validateOptimizeInput({ prompt: '写一首诗', mode: 'general', variables: {} }), {
    prompt: '写一首诗', mode: 'general', variables: {}, instruction: '', workspaceId: null,
    modelProfileId: null, templateId: 'general-v1', parentVersion: null, expectedCurrentVersion: null,
  });
  assert.throws(() => validateOptimizeInput({ prompt: 'x', surprise: true }), /unknown field/i);
  assert.throws(() => validateOptimizeInput({ prompt: 'x'.repeat(20001) }), /20000/);
});
