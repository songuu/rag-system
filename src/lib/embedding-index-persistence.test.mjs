import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { getEmbeddingIndexState, getActiveEmbeddingIndex, embeddingIndexBaseKey } = await import('./embedding-index-state.ts');
const { hydrateEmbeddingIndex, publishEmbeddingIndex } = await import('./embedding-index-persistence.ts');
const { resolveRuntimeEmbeddingModel } = await import('./security/request-validation.ts');
const record = model => ({ version: 1, baseKey: embeddingIndexBaseKey(), provider: 'ollama', model,
  collection: 'ragidx_' + 'a'.repeat(32), dimension: 1024, chunkCount: 42, updatedAt: new Date().toISOString() });
function reset() { const state = getEmbeddingIndexState(); state.active = undefined; state.loaded = undefined; state.loading = undefined; return state; }
test('写入持久化失败时保留旧活动指针', async () => {
  const state = reset(); const old = record('nomic-embed-text'); state.active = old;
  try {
    await assert.rejects(publishEmbeddingIndex(record('bge-m3'), { async write() { throw new Error('database unavailable'); } }));
    assert.equal(state.active, old);
  } finally { reset(); }
});
test('重启后读取完整指针，验证模型和向量维度一起恢复', async () => {
  reset(); let saved;
  try {
    await publishEmbeddingIndex(record('bge-m3'), { async write(_filename, data) { saved = data; } });
    reset();
    await hydrateEmbeddingIndex({ async exists() { return true; }, async readText() { return saved; } });
    assert.equal(getActiveEmbeddingIndex().dimension, 1024);
    assert.equal(resolveRuntimeEmbeddingModel(), 'bge-m3');
  } finally { reset(); }
});
test('配置范围变化不恢复旧索引，损坏的同范围指针拒绝加载', async () => {
  reset();
  try {
    await hydrateEmbeddingIndex({ async exists() { return true; }, async readText() { return JSON.stringify({ ...record('bge-m3'), baseKey: 'other-runtime' }); } });
    assert.equal(getActiveEmbeddingIndex(), undefined);
    reset();
    await assert.rejects(hydrateEmbeddingIndex({ async exists() { return true; }, async readText() {
      return JSON.stringify({ ...record('bge-m3'), collection: '../../outside' });
    } }), /索引配置无效/);
    assert.equal(getActiveEmbeddingIndex(), undefined);
  } finally { reset(); }
});
