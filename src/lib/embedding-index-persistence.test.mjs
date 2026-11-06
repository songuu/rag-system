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
const { hydrateEmbeddingIndex, publishEmbeddingIndex, readEmbeddingIndexForScope } = await import('./embedding-index-persistence.ts');
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

test('后台工作进程刷新时读取其他进程发布的新索引，读取失败保留旧指针', async () => {
  reset(); let saved = JSON.stringify(record('nomic-embed-text'));
  const store = { async exists() { return true; }, async readText() { return saved; } };
  try {
    await hydrateEmbeddingIndex(store);
    saved = JSON.stringify({ ...record('bge-m3'), collection: 'ragidx_' + 'b'.repeat(32) });
    await hydrateEmbeddingIndex(store, { refresh: true });
    assert.equal(getActiveEmbeddingIndex().collection, 'ragidx_' + 'b'.repeat(32));
    saved = '{invalid';
    await assert.rejects(hydrateEmbeddingIndex(store, { refresh: true }));
    assert.equal(getActiveEmbeddingIndex().collection, 'ragidx_' + 'b'.repeat(32));
  } finally { reset(); }
});

test('显式索引身份地址允许跨网络连接并保持其他基线严格隔离', async () => {
  const original = { ...process.env };
  reset();
  try {
    process.env.MILVUS_LOCAL_ADDRESS = '127.0.0.1:19530';
    delete process.env.RAG_EMBEDDING_INDEX_IDENTITY_ADDRESS;
    const saved = JSON.stringify(record('nomic-embed-text'));
    process.env.MILVUS_LOCAL_ADDRESS = 'milvus:19530';
    const store = { async exists() { return true; }, async readText() { return saved; } };
    const scope = { tenantId: process.env.RAG_DEFAULT_TENANT_ID || 'local-dev-tenant', corpusId: process.env.RAG_DEFAULT_CORPUS_ID || 'local-dev-corpus' };
    await assert.rejects(readEmbeddingIndexForScope(scope, store), /索引身份不匹配/);
    process.env.RAG_EMBEDDING_INDEX_IDENTITY_ADDRESS = '127.0.0.1:19530';
    await hydrateEmbeddingIndex(store, { refresh: true });
    assert.equal(getActiveEmbeddingIndex().collection, 'ragidx_' + 'a'.repeat(32));
    process.env.MILVUS_DEFAULT_COLLECTION = 'other_collection';
    await assert.rejects(readEmbeddingIndexForScope(scope, store), /索引身份不匹配/);
  } finally { process.env = original; reset(); }
});

test('worker 使用任务租户和知识库读取索引，不使用进程默认范围', async () => {
  const env = { ...process.env, RAG_DEFAULT_TENANT_ID: 'other-tenant', RAG_DEFAULT_CORPUS_ID: 'other-corpus' };
  const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const saved = { ...record('nomic-embed-text'), baseKey: embeddingIndexBaseKey({ ...env, RAG_DEFAULT_TENANT_ID: scope.tenantId, RAG_DEFAULT_CORPUS_ID: scope.corpusId }) };
  const store = { async exists() { return true; }, async readText() { return JSON.stringify(saved); } };
  assert.equal((await readEmbeddingIndexForScope(scope, store, env)).collection, saved.collection);
  await assert.rejects(readEmbeddingIndexForScope({ ...scope, corpusId: 'other' }, store, env), /索引身份不匹配/);
  assert.equal(env.RAG_DEFAULT_TENANT_ID, 'other-tenant');
});
