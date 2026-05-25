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

const { mmrRerank, dedupeBySource, applyPostProcess } = await import('./post-process.ts');

test('mmrRerank prefers diverse results when lambda is low', () => {
  // 3 docs: A 和 B 几乎相同, C 不同
  const query = [1, 0, 0];
  const docs = [
    { id: 'A', content: 'a', score: 0.9, embedding: [1, 0.01, 0] },
    { id: 'B', content: 'b', score: 0.89, embedding: [1, 0.02, 0] },
    { id: 'C', content: 'c', score: 0.7, embedding: [0, 1, 0] },
  ];

  // lambda=0.1 强调多样性
  const diverse = mmrRerank(query, docs, { lambda: 0.1, topK: 2 });
  const ids = diverse.map(d => d.id);
  assert.ok(ids[0] === 'A' || ids[0] === 'B', 'first should be top relevance');
  assert.equal(ids[1], 'C', 'second should be the diverse one, not the near-duplicate');
});

test('mmrRerank with lambda=1 collapses to pure relevance order', () => {
  const query = [1, 0, 0];
  const docs = [
    { id: 'A', content: 'a', score: 0.9, embedding: [1, 0, 0] },
    { id: 'B', content: 'b', score: 0.8, embedding: [0.9, 0, 0] },
    { id: 'C', content: 'c', score: 0.5, embedding: [0.5, 0, 0] },
  ];
  const ordered = mmrRerank(query, docs, { lambda: 1, topK: 3 });
  assert.deepEqual(ordered.map(d => d.id), ['A', 'B', 'C']);
});

test('mmrRerank tolerates missing embeddings (appends them at the end)', () => {
  const query = [1, 0, 0];
  const docs = [
    { id: 'A', content: 'a', score: 0.9, embedding: [1, 0, 0] },
    { id: 'B', content: 'b', score: 0.8 }, // no embedding
    { id: 'C', content: 'c', score: 0.6, embedding: [0, 1, 0] },
  ];
  const out = mmrRerank(query, docs, { lambda: 0.5 });
  const ids = out.map(d => d.id);
  // A 和 C 有 embedding 应在前；B 在末尾
  assert.equal(ids[ids.length - 1], 'B');
  assert.ok(ids.includes('A') && ids.includes('C'));
});

test('dedupeBySource limits per-source occurrences', () => {
  const docs = [
    { id: '1', content: '', score: 1, source: 'doc1' },
    { id: '2', content: '', score: 0.9, source: 'doc1' },
    { id: '3', content: '', score: 0.8, source: 'doc1' },
    { id: '4', content: '', score: 0.7, source: 'doc2' },
    { id: '5', content: '', score: 0.6, source: 'doc2' },
  ];
  const out = dedupeBySource(docs, 2);
  assert.equal(out.length, 4); // 2 from doc1 + 2 from doc2
  assert.deepEqual(out.map(d => d.id), ['1', '2', '4', '5']);
});

test('dedupeBySource buckets undefined sources together', () => {
  const docs = [
    { id: '1', content: '', score: 1 },
    { id: '2', content: '', score: 0.9 },
    { id: '3', content: '', score: 0.8, source: 'real' },
  ];
  const out = dedupeBySource(docs, 1);
  assert.deepEqual(out.map(d => d.id), ['1', '3']);
});

test('applyPostProcess composes dedupeBySource and mmr', () => {
  const docs = [
    { id: 'A1', content: '', score: 0.95, source: 'A', embedding: [1, 0] },
    { id: 'A2', content: '', score: 0.94, source: 'A', embedding: [1, 0.01] },
    { id: 'A3', content: '', score: 0.93, source: 'A', embedding: [1, 0.02] },
    { id: 'B1', content: '', score: 0.7, source: 'B', embedding: [0, 1] },
  ];
  const out = applyPostProcess(docs, {
    dedupeBySource: 2,
    mmr: { lambda: 0.5, topK: 3, queryEmbedding: [1, 0] },
  });
  const ids = out.map(d => d.id);
  // dedupe 把 A 限到 2 → A1, A2, B1；MMR 排序
  assert.ok(!ids.includes('A3'), 'A3 should be removed by dedupe');
  assert.equal(out.length, 3);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
