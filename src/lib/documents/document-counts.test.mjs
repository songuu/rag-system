import assert from 'node:assert/strict';
import test from 'node:test';

const { parseDocumentChunkCounts, formatDocumentChunkCounts } = await import('./document-counts.ts');

test('home counts distinguish searchable chunks from retained storage', () => {
  const counts = parseDocumentChunkCounts({ chunkCount: 1405, searchableChunkCount: 760, disabledChunkCount: 645, documentCount: 7 });
  assert.deepEqual(counts, { chunkCount: 1405, searchableChunkCount: 760, disabledChunkCount: 645 });
  assert.equal(formatDocumentChunkCounts(counts), '可检索 760 块 · 已存储 1,405 块 · 已停用 645 块');
});

test('all-disabled and empty knowledge bases preserve an explicit searchable zero', () => {
  for (const chunkCount of [0, 1405]) {
    const counts = parseDocumentChunkCounts({ chunkCount, searchableChunkCount: 0, disabledChunkCount: chunkCount });
    assert.ok(counts);
    assert.ok(formatDocumentChunkCounts(counts).startsWith('可检索 0 块'));
  }
});

test('missing or inconsistent statistics never fall back to stored row counts', () => {
  for (const value of [null, undefined, {}, { rowCount: 1405 },
    { chunkCount: 1405, searchableChunkCount: -1, disabledChunkCount: 1406 },
    { chunkCount: 1405, searchableChunkCount: 1405, disabledChunkCount: 645 },
    { chunkCount: 1405, searchableChunkCount: '760', disabledChunkCount: 645 }]) {
    assert.equal(parseDocumentChunkCounts(value), null);
  }
  assert.equal(formatDocumentChunkCounts(null), '文档块统计暂不可用');
});
