import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { runRagEvalMatrix } = await import('./matrix.ts');

test('matrix preserves target order and computes deterministic baseline deltas', async () => {
  const matrix = await runRagEvalMatrix(
    createDataset(),
    [createTarget('baseline', 1), createTarget('candidate', 0.5)],
    { matrixRunId: 'matrix-fixed', baselineTargetId: 'baseline' }
  );
  assert.equal(matrix.matrixRunId, 'matrix-fixed');
  assert.deepEqual(matrix.targets.map(item => item.targetId), [
    'baseline',
    'candidate',
  ]);
  assert.equal(matrix.targets[0].deltaFromBaseline.meanRecallAtK, 0);
  assert.equal(matrix.targets[1].deltaFromBaseline.meanRecallAtK, 0);
  assert.equal(matrix.targets[0].deltaFromBaseline.meanCitationCoverage, null);
});

test('matrix rejects duplicate target IDs and unknown baselines', async () => {
  await assert.rejects(
    () =>
      runRagEvalMatrix(
        createDataset(),
        [createTarget('same', 1), createTarget('same', 1)]
      ),
    /duplicate target id/
  );
  await assert.rejects(
    () =>
      runRagEvalMatrix(
        createDataset(),
        [createTarget('only', 1)],
        { baselineTargetId: 'missing' }
      ),
    /baseline target is not registered/
  );
});

test('one target failure remains isolated in its report', async () => {
  const broken = {
    id: 'broken',
    async run() {
      throw new Error('provider failed');
    },
  };
  const matrix = await runRagEvalMatrix(
    createDataset(),
    [broken, createTarget('healthy', 1)],
    { baselineTargetId: 'healthy' }
  );
  assert.equal(matrix.targets[0].report.summary.failedCases, 1);
  assert.equal(matrix.targets[1].report.summary.failedCases, 0);
});

function createTarget(id, score) {
  return {
    id,
    async run() {
      return {
        answer: 'alpha fact',
        abstained: false,
        evidence: [
          { evidenceId: 'alpha', score, content: 'alpha fact', source: 'alpha.md' },
        ],
        usage: {
          retrievalLatencyMs: 1,
          generationLatencyMs: 1,
          totalLatencyMs: 2,
          tokenMeasurement: 'unavailable',
          costMeasurement: 'unavailable',
          embeddingCalls: 1,
          generationCalls: 1,
        },
      };
    },
  };
}

function createDataset() {
  return {
    schemaVersion: 'rag-eval-dataset/v1',
    datasetId: 'matrix-fixture',
    datasetVersion: '1',
    corpus: [
      {
        evidenceId: 'alpha',
        documentId: 'doc',
        source: 'alpha.md',
        content: 'alpha fact',
      },
    ],
    cases: [
      {
        id: 'case',
        query: 'alpha?',
        tags: [],
        goldEvidence: [{ evidenceId: 'alpha', relevance: 3 }],
        expectedAnswer: { requiredFacts: [['alpha']] },
        expectedAbstain: false,
      },
    ],
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
