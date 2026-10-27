import assert from 'node:assert/strict';
import test from 'node:test';

const { readGraphEvidencePaths, graphEvidencePathConnects, GRAPH_EVIDENCE_LIMITS } = await import('./graph-evidence.ts');
const relation = (id, from, to, passages = ['source']) => ({
  claimId: id, sourceEntityId: from, sourceEntityName: from,
  predicate: 'RELATES_TO', targetEntityId: to, targetEntityName: to, passageIds: passages,
});

test('validates connected one/two-hop paths without reversing the original claim', () => {
  const path = [relation('first', 'b', 'a'), relation('second', 'b', 'c')];
  assert.deepEqual(readGraphEvidencePaths([path]), [path]);
  assert.deepEqual(readGraphEvidencePaths(undefined), []);
  assert.equal(graphEvidencePathConnects(path, 'a', 'c'), true);
  assert.equal(graphEvidencePathConnects(path, 'b', 'c'), false);
});

test('rejects unsupported, disconnected, repeated and oversized paths', () => {
  for (const value of [
    [[relation('empty', 'a', 'b', [])]],
    [[relation('a', 'a', 'b'), relation('b', 'c', 'd')]],
    [[relation('same', 'a', 'b'), relation('same', 'b', 'c')]],
    [[relation('1', 'a', 'b'), relation('2', 'b', 'c'), relation('3', 'c', 'd')]],
    Array.from({ length: GRAPH_EVIDENCE_LIMITS.maxPathsPerEvidence + 1 }, () => [relation('a', 'a', 'b')]),
  ]) assert.deepEqual(readGraphEvidencePaths(value), []);
});

test('does not invoke accessors or return mutable provider arrays', () => {
  let calls = 0;
  const malicious = relation('a', 'a', 'b');
  Object.defineProperty(malicious, 'predicate', { get() { calls++; return 'LEAK'; } });
  assert.deepEqual(readGraphEvidencePaths([[malicious]]), []);
  assert.equal(calls, 0);
  const original = [[relation('a', 'a', 'b')]];
  const result = readGraphEvidencePaths(original);
  original[0][0].passageIds.push('later');
  assert.deepEqual(result[0][0].passageIds, ['source']);
});
