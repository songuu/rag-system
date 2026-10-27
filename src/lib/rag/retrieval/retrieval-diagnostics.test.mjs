import assert from 'node:assert/strict';
import test from 'node:test';

const { createRetrievalDiagnostics } = await import('./retrieval-diagnostics.ts');
const evidence = id => ({ id, source: id + '.pdf', laneId: 'dense', retrievalScore: 0.8 });

test('diagnostics retain observed rerank positions and separate context inclusion from citation', () => {
  const result = createRetrievalDiagnostics({
    evidence: [evidence('a'), { ...evidence('b'), rerankScore: 0 }],
    laneExecutions: [{ laneId: 'rerank', status: 'completed', reranking: {
      beforeEvidenceIds: ['a', 'b'], afterEvidenceIds: ['b', 'a'],
    } }],
    includedEvidenceIds: ['b'], citedEvidenceIds: ['b'],
  });
  assert.equal(result.candidateCount, 2);
  assert.equal(result.contextCount, 1);
  assert.equal(result.citedCount, 1);
  assert.deepEqual(result.rows.map(row => [row.evidenceId, row.beforeRerankRank, row.afterRerankRank, row.inContext, row.cited]), [
    ['a', 1, 2, false, false], ['b', 2, 1, true, true],
  ]);
  assert.equal(result.rows[1].rerankScore, 0);
  assert.equal(result.qualityMeasurement, 'unmeasured');
});

test('absent traces and citation measurements stay unknown rather than implying an improvement', () => {
  const result = createRetrievalDiagnostics({ evidence: [evidence('a')], laneExecutions: [], includedEvidenceIds: [] });
  assert.equal(result.rows[0].beforeRerankRank, undefined);
  assert.equal(result.rows[0].afterRerankRank, undefined);
  assert.equal(result.rows[0].cited, null);
  assert.equal(result.citedCount, null);
});

test('failed rerank traces are ignored and repeated observations use the latest completed stage', () => {
  const result = createRetrievalDiagnostics({
    evidence: [evidence('a'), evidence('b')], includedEvidenceIds: ['a'], citedEvidenceIds: [],
    laneExecutions: [
      { laneId: 'first', status: 'completed', reranking: { beforeEvidenceIds: ['a', 'b'], afterEvidenceIds: ['b', 'a'] } },
      { laneId: 'next', status: 'completed', reranking: { beforeEvidenceIds: ['b', 'a'], afterEvidenceIds: ['a', 'b'] } },
      { laneId: 'failed', status: 'failed', reranking: { beforeEvidenceIds: ['a', 'b'], afterEvidenceIds: ['b', 'a'] } },
    ],
  });
  assert.equal(result.rows[0].beforeRerankRank, 2);
  assert.equal(result.rows[0].afterRerankRank, 1);
  assert.equal(result.rows[0].rerankLaneId, 'next');
  assert.equal(result.citedCount, 0);
});
