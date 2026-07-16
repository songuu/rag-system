import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  createLegacyEvidenceTransform,
  normalizeLegacyPolicyDocuments,
} = await import('./legacy-policy-adapter.ts');

test('legacy document normalization produces stable canonical search inputs', () => {
  const input = [{
    content: 'alpha',
    metadata: { document_id: 'doc-1' },
    score: 0.8,
  }];
  const first = normalizeLegacyPolicyDocuments(input);
  const second = normalizeLegacyPolicyDocuments(input);
  assert.deepEqual(first, second);
  assert.match(first[0].id, /^legacy-policy-/);
  assert.ok(Math.abs(first[0].distance - 0.2) < Number.EPSILON);
});

test('legacy normalization never collapses different chunks from one document', () => {
  const normalized = normalizeLegacyPolicyDocuments([
    { content: 'first chunk', metadata: { document_id: 'doc-1' }, score: 0.9 },
    { content: 'second chunk', metadata: { document_id: 'doc-1' }, score: 0.8 },
  ]);

  assert.equal(new Set(normalized.map(item => item.id)).size, 2);
  assert.ok(normalized.every(item => item.id !== 'doc-1'));
});

test('legacy fallback IDs do not change when global result order changes', () => {
  const documents = [
    {
      content: 'first chunk',
      metadata: { document_id: 'doc-1', page: 1, start_offset: 0, end_offset: 11 },
    },
    {
      content: 'second chunk',
      metadata: { document_id: 'doc-1', page: 2, start_offset: 20, end_offset: 32 },
    },
  ];
  const forward = normalizeLegacyPolicyDocuments(documents);
  const reversed = normalizeLegacyPolicyDocuments([...documents].reverse());

  assert.deepEqual(
    Object.fromEntries(forward.map(item => [item.content, item.id])),
    Object.fromEntries(reversed.map(item => [item.content, item.id]))
  );
});

test('legacy fallback position aliases produce the same stable ID', () => {
  const [snakeCase] = normalizeLegacyPolicyDocuments([{
    content: 'chunk',
    metadata: { document_id: 'doc-1', chunk_index: 3, start_offset: 7, end_offset: 12 },
  }]);
  const [camelCase] = normalizeLegacyPolicyDocuments([{
    content: 'chunk',
    metadata: { documentId: 'doc-1', chunkIndex: 3, startOffset: 7, endOffset: 12 },
  }]);

  assert.equal(snakeCase.id, camelCase.id);
});

test('legacy fallback gives exact duplicate chunks deterministic local suffixes', () => {
  const normalized = normalizeLegacyPolicyDocuments([
    { content: 'same', metadata: { document_id: 'doc-1' } },
    { content: 'same', metadata: { document_id: 'doc-1' } },
  ]);

  assert.match(normalized[0].id, /^legacy-policy-[a-f0-9]{8}$/);
  assert.equal(normalized[1].id, normalized[0].id + '-duplicate-2');
});

test('legacy transform only reorders existing evidence and accepts finite scores', () => {
  const prior = [createEvidence('a'), createEvidence('b'), createEvidence('c')];
  const transform = createLegacyEvidenceTransform(
    prior,
    ['c', 'unknown', 'a', 'c'],
    { c: 0.9, a: Number.NaN, unknown: 1 }
  );
  assert.deepEqual(transform, {
    orderedEvidenceIds: ['c', 'a', 'b'],
    rerankScores: { c: 0.9 },
  });
});

function createEvidence(id) {
  return {
    id,
    tenantId: 'tenant',
    corpusId: 'corpus',
    documentId: 'doc-' + id,
    documentVersion: 'v1',
    content: id,
    trustLevel: 'external',
    laneId: 'dense',
  };
}
