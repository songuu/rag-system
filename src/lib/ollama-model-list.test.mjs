import assert from 'node:assert/strict';
import test from 'node:test';
const { normalizeInstalledOllamaModels } = await import('./ollama-model-list.ts');
test('同名模型迁移重复只显示一次，内部 runner 不参与用户选择', () => {
  const models = normalizeInstalledOllamaModels([
    { name: 'glm:latest', digest: 'old', modified_at: '2026-01-01' },
    { name: 'glm:latest', digest: 'new', modified_at: '2026-02-01' },
    { name: 'llamacpp:' + 'a'.repeat(64), digest: 'new' },
    { name: 'glm', digest: 'new' },
    { name: 'glm:q4', digest: 'new' },
    { name: 'qwen:0.5b' },
    { name: 4 },
  ]);
  assert.deepEqual(models.map(m => m.name), ['glm:latest', 'glm:q4', 'qwen:0.5b']);
  assert.equal(models[0].digest, 'new');
});
