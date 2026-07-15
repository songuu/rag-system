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

const { RagLaneExecutionError, RagLaneExecutor } = await import('./lane-executor.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('lane executor follows plan order and records optional capability skips', async () => {
  const calls = [];
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'unit-dense',
      async execute({ lane }) {
        calls.push(lane.id);
        return { evidence: [createEvidence('ev-1', lane.id)] };
      },
    },
  ], { now: monotonicClock() });

  const result = await executor.execute({
    request: createRequest(),
    plan: createPlan([
      createLane('dense', 'dense-vector', true),
      createLane('sparse', 'sparse-bm25', false),
    ]),
    budget: { maxLanes: 2, maxEvidence: 5, maxDurationMs: 1000 },
  });

  assert.deepEqual(calls, ['dense']);
  assert.deepEqual(result.evidence.map(item => item.id), ['ev-1']);
  assert.deepEqual(result.laneExecutions.map(item => [item.laneId, item.status]), [
    ['dense', 'completed'],
    ['sparse', 'skipped'],
  ]);
  assert.equal(result.laneExecutions[1].stopReason, 'capability_unavailable');
  assert.equal(result.stopReason, 'sufficient');
  assert.deepEqual(result.transitions.map(item => item.to), [
    'retrieving',
    'evidence_ready',
    'completed',
  ]);
});

test('lane executor fails closed when a required lane is not registered', async () => {
  const executor = new RagLaneExecutor([]);
  await assert.rejects(
    () =>
      executor.execute({
        request: createRequest(),
        plan: createPlan([createLane('dense', 'dense-vector', true)]),
        budget: { maxLanes: 1, maxEvidence: 5, maxDurationMs: 1000 },
      }),
    error => {
      assert.ok(error instanceof RagLaneExecutionError);
      assert.match(error.message, /Required retrieval lane is unavailable/);
      assert.equal(error.code, 'RAG_LANE_UNAVAILABLE');
      assert.deepEqual(
        error.partialResult.laneExecutions.map(item => [item.laneId, item.status]),
        [['dense', 'failed']]
      );
      assert.equal(error.partialResult.transitions.at(-1).to, 'failed');
      return true;
    }
  );
});

test('lane executor enforces maxDurationMs across a slow required lane', async () => {
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'slow-dense',
      async execute({ lane, signal }) {
        assert.equal(signal.aborted, false);
        await new Promise(resolve => setTimeout(resolve, 30));
        return { evidence: [createEvidence('late', lane.id)] };
      },
    },
  ]);

  await assert.rejects(
    () =>
      executor.execute({
        request: createRequest(),
        plan: createPlan([createLane('dense', 'dense-vector', true)]),
        budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 5 },
      }),
    error => {
      assert.ok(error instanceof RagLaneExecutionError);
      assert.equal(error.code, 'RAG_LANE_TIMEOUT');
      assert.equal(error.partialResult.stopReason, 'budget');
      assert.equal(error.partialResult.laneExecutions[0].errorCode, 'RAG_LANE_TIMEOUT');
      return true;
    }
  );
});

test('abort-aware handlers are still classified as lane timeouts', async () => {
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'abort-aware-dense',
      async execute({ signal }) {
        await new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('provider observed abort')),
            { once: true }
          );
        });
        return { evidence: [] };
      },
    },
  ]);

  await assert.rejects(
    () =>
      executor.execute({
        request: createRequest(),
        plan: createPlan([createLane('dense', 'dense-vector', true)]),
        budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 5 },
      }),
    error => {
      assert.ok(error instanceof RagLaneExecutionError);
      assert.equal(error.code, 'RAG_LANE_TIMEOUT');
      assert.equal(error.partialResult.stopReason, 'budget');
      return true;
    }
  );
});

test('lane executor enforces evidence and trust budgets', async () => {
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'unit-dense',
      async execute({ lane }) {
        return {
          evidence: [
            createEvidence('ev-1', lane.id),
            createEvidence('ev-2', lane.id),
          ],
        };
      },
    },
  ]);
  const result = await executor.execute({
    request: createRequest(),
    plan: createPlan([createLane('dense', 'dense-vector', true)]),
    budget: { maxLanes: 1, maxEvidence: 1, maxDurationMs: 1000 },
  });
  assert.deepEqual(result.evidence.map(item => item.id), ['ev-1']);
  assert.equal(result.stopReason, 'budget');

  const quarantinedExecutor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'unsafe-dense',
      async execute({ lane }) {
        return {
          evidence: [{ ...createEvidence('poison', lane.id), trustLevel: 'quarantined' }],
        };
      },
    },
  ]);
  await assert.rejects(
    () =>
      quarantinedExecutor.execute({
        request: createRequest(),
        plan: createPlan([createLane('dense', 'dense-vector', true)]),
        budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 1000 },
      }),
    /quarantined/
  );
});

function createRequest() {
  return {
    question: 'question',
    topK: 3,
    similarityThreshold: 0,
    llmModel: 'llm',
    embeddingModel: 'embedding',
    storageBackend: 'milvus',
    retrievalScope: createRetrievalScope({
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['reviewed'],
      enforceIsolation: true,
    }),
  };
}

function createPlan(lanes) {
  return {
    id: 'plan-1',
    policy_id: 'milvus-2step',
    query: 'question',
    lanes,
    top_k: 3,
    similarity_threshold: 0,
    created_at: '2026-07-15T00:00:00.000Z',
  };
}

function createLane(id, type, required) {
  return { id, type, required, description: id };
}

function createEvidence(id, laneId) {
  return {
    id,
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-1',
    documentVersion: 'v1',
    content: id,
    trustLevel: 'reviewed',
    laneId,
  };
}

function monotonicClock() {
  let value = Date.parse('2026-07-15T00:00:00.000Z');
  return () => value++;
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
