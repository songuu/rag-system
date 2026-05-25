/**
 * Sprint 2026-05-25 v2 perf bench harness
 *
 * 这些不是断言式的"必须比 X 快"测试（CI 环境抖动会乱裁判），
 * 而是把基线数据打到 stdout，便于后续 sprint 对比 / human review。
 *
 * 跑法: node src/lib/perf-bench.test.mjs
 */
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

const { SemanticCache } = await import('./semantic-cache.ts');
const { EmbeddingCache } = await import('./embedding-cache.ts');
const { mmrRerank, dedupeBySource } = await import('./rag/retrieval/post-process.ts');

class StubEmbeddings {
  async embedQuery(text) {
    // 384 维伪向量
    const v = new Array(384).fill(0);
    for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i);
    return v;
  }
  async embedDocuments(texts) {
    return Promise.all(texts.map(t => this.embedQuery(t)));
  }
}

test('[bench] SemanticCache.get 1000 entries scan latency', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { maxSize: 1000, similarityThreshold: 0.999 });
  for (let i = 0; i < 1000; i++) {
    await cache.set(`entry-${i}-${Math.random()}`, `ans-${i}`);
  }
  // warm
  await cache.get('warmup');

  const N = 20;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await cache.get(`probe-${i}`);
  }
  const wall = Date.now() - t0;
  const stats = cache.getStats();
  console.log(
    `[bench] SemanticCache.get N=${N} avg=${(wall / N).toFixed(2)}ms; ` +
      `lastScanMs=${stats.lastScanMs}ms scanned=${stats.lastScanEntries}; ` +
      `hits=${stats.hits} misses=${stats.misses}`
  );
  assert.ok(wall >= 0);
});

test('[bench] EmbeddingCache namespace + sha256 key isolation overhead', () => {
  const cache = new EmbeddingCache({ maxSize: 2048, ttlMs: 60000 });

  const N = 1000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    cache.set('doc', 'bge-m3', `text-${i}`, new Array(384).fill(i / 1000));
  }
  const setMs = Date.now() - t0;

  const t1 = Date.now();
  let hits = 0;
  for (let i = 0; i < N; i++) {
    if (cache.get('doc', 'bge-m3', `text-${i}`)) hits++;
  }
  const getMs = Date.now() - t1;
  console.log(
    `[bench] EmbeddingCache N=${N} set=${setMs}ms get=${getMs}ms hits=${hits}/${N} ` +
      `(per-op set=${(setMs / N).toFixed(3)}ms get=${(getMs / N).toFixed(3)}ms)`
  );
  assert.equal(hits, N);
});

test('[bench] mmrRerank 100 docs lambda=0.7 diversity vs pure relevance', () => {
  const query = new Array(64).fill(0).map((_, i) => Math.sin(i));
  const docs = [];
  for (let i = 0; i < 100; i++) {
    const emb = new Array(64).fill(0).map((_, j) => Math.sin(i * 0.1 + j));
    docs.push({ id: `d${i}`, content: '', score: 1 - i / 100, embedding: emb });
  }
  const t0 = Date.now();
  const pure = mmrRerank(query, docs, { lambda: 1, topK: 10 });
  const tPure = Date.now() - t0;

  const t1 = Date.now();
  const diverse = mmrRerank(query, docs, { lambda: 0.5, topK: 10 });
  const tDiverse = Date.now() - t1;

  // 多样性应改变前 10 个的至少 1 个 id
  const pureIds = new Set(pure.map(d => d.id));
  const diverseIds = new Set(diverse.map(d => d.id));
  let overlap = 0;
  for (const id of pureIds) if (diverseIds.has(id)) overlap++;

  console.log(
    `[bench] mmrRerank lambda=1.0 ${tPure}ms; lambda=0.5 ${tDiverse}ms; ` +
      `top10 overlap=${overlap}/10`
  );
  assert.ok(overlap < 10 || pure.length < 10, 'diversity should change the top-K when possible');
});

test('[bench] dedupeBySource 500 docs grouping latency', () => {
  const docs = [];
  for (let i = 0; i < 500; i++) {
    docs.push({ id: `d${i}`, content: '', score: 1 - i / 500, source: `s${i % 50}` });
  }
  const t0 = Date.now();
  const out = dedupeBySource(docs, 3);
  const ms = Date.now() - t0;
  console.log(`[bench] dedupeBySource 500→${out.length} in ${ms}ms (perSource=3, 50 sources)`);
  assert.equal(out.length, 150); // 50 sources * 3
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
