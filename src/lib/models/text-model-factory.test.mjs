import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//u.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { getModelFactory, createTextModelClient } = await import('../model-config.ts');
const { createTextModelClientFromOverride } = await import('../mirofish/model-override.ts');

test('text client uses the existing factory and its request policy', async () => {
  const factory = getModelFactory();
  const original = factory.createLLM;
  const options = { temperature: 0.2, requestTimeoutMs: 12345 };
  factory.createLLM = (name, actual) => {
    assert.equal(name, 'selected-model');
    assert.deepEqual(actual, options);
    return { async invoke() { return { content: 'Answer' }; } };
  };
  try {
    const client = createTextModelClient('selected-model', options);
    assert.equal((await client.complete({ operation: 'factory.test', messages: [] })).text, 'Answer');
  } finally { factory.createLLM = original; }
});

test('MiroFish text client preserves trusted override resolution', async () => {
  const factory = getModelFactory();
  const original = factory.createLLM;
  factory.createLLM = (name, actual) => {
    assert.equal(name, 'project-model');
    assert.equal(actual.provider, 'custom');
    assert.equal(actual.temperature, 0.4);
    assert.equal(actual.baseUrl, 'https://model.example/v1');
    assert.equal(actual.apiKey, 'fixture-key');
    assert.equal(actual.requestTimeoutMs, 9000);
    return { async invoke() { return { content: 'Project answer' }; } };
  };
  try {
    const client = createTextModelClientFromOverride({ provider: 'custom', modelName: 'project-model',
      temperature: 0.4, baseUrl: 'https://model.example/v1', apiKey: 'fixture-key' },
    { temperature: 0.3, requestTimeoutMs: 9000 });
    assert.equal((await client.complete({ operation: 'override.test', messages: [] })).text, 'Project answer');
  } finally { factory.createLLM = original; }
});
