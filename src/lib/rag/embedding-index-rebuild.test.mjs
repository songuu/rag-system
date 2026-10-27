import assert from 'node:assert/strict';
import test from 'node:test';
const { rebuildEmbeddingIndex } = await import('./embedding-index-rebuild.ts');
function fixture(overrides = {}) {
  const events = [];
  const deps = {
    async *readSource() { yield [{ id: 'a', content: 'one', metadata: { source: 'one.txt' } }, { id: 'b', content: 'two', metadata: { source: 'two.txt' } }]; },
    async embed(texts) { return texts.map(() => [1, 2, 3]); },
    async createTarget(dimension) { events.push(['create', dimension]); return 'ragidx_fixture'; },
    async insert(_collection, rows) { events.push(['insert', rows.map(r => r.id)]); },
    async count() { return 2; },
    async publish(index) { events.push(['publish', index]); },
    ...overrides,
  };
  return { deps, events };
}
test('重建使用实际维度，核对完整数量后才发布，旧集合不受修改', async () => {
  const { deps, events } = fixture();
  const result = await rebuildEmbeddingIndex('bge-m3', deps, AbortSignal.timeout(1000));
  assert.equal(result.dimension, 3);
  assert.equal(result.chunkCount, 2);
  assert.deepEqual(events.map(e => e[0]), ['create', 'insert', 'publish']);
});
for (const [name, overrides] of [
  ['数量不足', { count: async () => 1 }],
  ['向量维度不一致', { embed: async () => [[1, 2], [3]] }],
  ['模型失败', { embed: async () => { throw new Error('model failed'); } }],
  ['源文档变化', { verifySource: async () => { throw new Error('source changed'); } }],
]) test(name + '不得发布新索引', async () => {
  const { deps, events } = fixture(overrides);
  await assert.rejects(rebuildEmbeddingIndex('bge-m3', deps, AbortSignal.timeout(1000)));
  assert.equal(events.some(e => e[0] === 'publish'), false);
});
test('空知识库先探测实际维度并创建可用的空索引', async () => {
  const { deps, events } = fixture({ async *readSource() {}, count: async () => 0 });
  const result = await rebuildEmbeddingIndex('new', deps, AbortSignal.timeout(1000));
  assert.equal(result.chunkCount, 0);
  assert.deepEqual(events.map(e => e[0]), ['create', 'publish']);
});
test('取消请求不会发布半成品', async () => {
  const { deps, events } = fixture();
  await assert.rejects(rebuildEmbeddingIndex('new', deps, AbortSignal.abort()));
  assert.equal(events.length, 0);
});
