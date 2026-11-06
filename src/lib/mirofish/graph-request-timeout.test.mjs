import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { getModelFactory } = await import('../model-config.ts');
const { extractMiroFishGraphData } = await import('./graph-builder.ts');

test('checkpoint graph stages pass the full cold-start transport budget through the real model facade', async t => {
  const budgets = [];
  t.mock.method(getModelFactory(), 'createLLM', (_model, options) => {
    budgets.push(options.requestTimeoutMs);
    return { async invoke(_prompt, callOptions) {
      return { content: JSON.stringify(typeof callOptions?.format === 'object'
        ? { entities: [{ name: 'Alice', type: 'PERSON', description: 'Developer' }], relations: [] }
        : { name: 'Developers', summary: 'Developers build applications.', keywords: ['development'] }) };
    } };
  });
  const graph = await extractMiroFishGraphData({
    text: 'Alice builds software.', documentId: 'transport-fixture',
    modelOverride: { provider: 'ollama', modelName: 'transport-fixture' },
    checkpoint: { async load() { return null; }, async save() {} },
    embeddingInstance: { async embedDocuments(texts) { return texts.map(() => [1, 0]); }, async embedQuery() { return [1, 0]; } },
  });
  assert.equal(graph.nodes.length, 1);
  assert.ok(budgets.length >= 2, 'both extraction and post-processing must construct a model');
  assert.deepEqual(budgets, budgets.map(() => 300_000));
});
