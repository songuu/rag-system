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

const { EmbeddingCache, normalizeQueryText } = await import('./embedding-cache.ts');

test('EmbeddingCache stores and returns embeddings keyed by namespace', () => {
  const cache = new EmbeddingCache({ maxSize: 8, ttlMs: 60000 });
  cache.set('query', 'bge-m3', 'hello', [0.1, 0.2, 0.3]);

  const hit = cache.get('query', 'bge-m3', 'hello');
  assert.ok(hit, 'should hit');
  assert.deepEqual(hit, [0.1, 0.2, 0.3]);

  // Namespace isolation: 'doc' should miss even with same model+text
  const miss = cache.get('doc', 'bge-m3', 'hello');
  assert.equal(miss, null, 'namespace isolation: doc miss');
});

test('EmbeddingCache model isolation: different model gives miss', () => {
  const cache = new EmbeddingCache();
  cache.set('query', 'bge-m3', 'foo', [1, 0]);
  assert.equal(cache.get('query', 'bge-large', 'foo'), null);
});

test('EmbeddingCache TTL expires entries', async () => {
  const cache = new EmbeddingCache({ ttlMs: 1, maxSize: 8 });
  cache.set('doc', 'm', 'x', [1]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(cache.get('doc', 'm', 'x'), null);
  const stats = cache.getStats();
  assert.ok(stats.evictions >= 1, 'TTL eviction counted');
});

test('EmbeddingCache LRU evicts oldest when full', () => {
  const cache = new EmbeddingCache({ maxSize: 2, ttlMs: 60000 });
  cache.set('doc', 'm', 'a', [1]);
  cache.set('doc', 'm', 'b', [2]);
  cache.set('doc', 'm', 'c', [3]); // evicts 'a'
  assert.equal(cache.get('doc', 'm', 'a'), null, 'a should be evicted');
  assert.deepEqual(cache.get('doc', 'm', 'b'), [2]);
  assert.deepEqual(cache.get('doc', 'm', 'c'), [3]);
});

test('EmbeddingCache getMany / setMany returns miss indices', () => {
  const cache = new EmbeddingCache();
  cache.set('doc', 'm', 'a', [1]);
  cache.set('doc', 'm', 'c', [3]);
  const { cached, missIndices } = cache.getMany('doc', 'm', ['a', 'b', 'c', 'd']);
  assert.deepEqual(missIndices, [1, 3]);
  assert.deepEqual(cached[0], [1]);
  assert.equal(cached[1], null);
  assert.deepEqual(cached[2], [3]);
  assert.equal(cached[3], null);

  cache.setMany('doc', 'm', ['b', 'd'], [[2], [4]]);
  assert.deepEqual(cache.get('doc', 'm', 'b'), [2]);
  assert.deepEqual(cache.get('doc', 'm', 'd'), [4]);
});

test('EmbeddingCache stats tracks hits/misses', () => {
  const cache = new EmbeddingCache();
  cache.set('doc', 'm', 'a', [1]);
  cache.get('doc', 'm', 'a'); // hit
  cache.get('doc', 'm', 'a'); // hit
  cache.get('doc', 'm', 'missing'); // miss
  const stats = cache.getStats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
  assert.ok(stats.hitRate > 0.6 && stats.hitRate < 0.7, `hitRate=${stats.hitRate}`);
});

test('EmbeddingCache disabled returns null without storing', () => {
  const cache = new EmbeddingCache({ enabled: false });
  cache.set('doc', 'm', 'a', [1]);
  assert.equal(cache.get('doc', 'm', 'a'), null);
  assert.equal(cache.getStats().size, 0);
});

test('normalizeQueryText collapses whitespace and applies NFKC', () => {
  assert.equal(normalizeQueryText('  hello   world  '), 'hello world');
  // Full-width space + full-width digit → NFKC half-width
  assert.equal(normalizeQueryText('ＡＢＣ　１２'), 'ABC 12');
  assert.equal(normalizeQueryText(''), '');
  // Newlines treated as whitespace
  assert.equal(normalizeQueryText('foo\nbar\tbaz'), 'foo bar baz');
});

test('normalizeQueryText preserves case but NFKC folds full-width punctuation', () => {
  assert.equal(normalizeQueryText('What is RAG?'), 'What is RAG?');
  // NFKC 是有意选择：'？' (U+FF1F) 会折叠为 '?'，'１２' → '12'，把宽度变体
  // 都规一化到 ASCII 以提升 cache 命中（注：业务语义未损失，只是 width 形变）
  assert.equal(normalizeQueryText('什么是 RAG？'), '什么是 RAG?');
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
