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

test('timed-out non-cooperative providers are admission-blocked until work settles', async () => {
  let calls = 0;
  let releaseTimedOutCall;
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'non-cooperative-dense',
      async execute({ lane }) {
        calls++;
        if (calls === 1) {
          return new Promise(resolve => {
            releaseTimedOutCall = () => resolve({
              evidence: [createEvidence('late', lane.id)],
            });
          });
        }
        return { evidence: [createEvidence('fresh', lane.id)] };
      },
    },
  ]);
  const input = {
    request: createRequest(),
    plan: createPlan([createLane('dense', 'dense-vector', true)]),
    budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 5 },
  };

  await assert.rejects(() => executor.execute(input), error => {
    assert.equal(error.code, 'RAG_LANE_TIMEOUT');
    return true;
  });
  await assert.rejects(
    () => executor.execute({ ...input, budget: { ...input.budget, maxDurationMs: 1000 } }),
    error => {
      assert.equal(error.code, 'RAG_LANE_PROVIDER_BUSY');
      return true;
    }
  );
  assert.equal(calls, 1);

  releaseTimedOutCall();
  await new Promise(resolve => setImmediate(resolve));
  const result = await executor.execute({
    ...input,
    budget: { ...input.budget, maxDurationMs: 1000 },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.evidence.map(item => item.id), ['fresh']);
});

test('optional lane timeout preserves required fallback budget and fences detached work', async () => {
  let hybridCalls = 0;
  let denseCalls = 0;
  let releaseTimedOutHybrid;
  const retriever = `optional-hybrid-${Date.now()}`;
  const executor = new RagLaneExecutor([
    {
      type: 'sparse-bm25',
      retriever,
      async execute() {
        hybridCalls++;
        if (hybridCalls === 1) {
          return new Promise(resolve => {
            releaseTimedOutHybrid = () => resolve({ evidence: [] });
          });
        }
        return { evidence: [] };
      },
    },
    {
      type: 'dense-vector',
      retriever: 'required-dense-after-optional-timeout',
      async execute({ lane }) {
        denseCalls++;
        return { evidence: [createEvidence(`dense-${denseCalls}`, lane.id)] };
      },
    },
  ]);
  const plan = createPlan([
    {
      ...createLane('hybrid', 'sparse-bm25', false),
      executionBudget: {
        maxDurationMs: 10,
        reserveForRequiredMs: 100,
      },
    },
    createLane('dense', 'dense-vector', true),
  ]);
  const input = {
    request: createRequest(),
    plan,
    budget: { maxLanes: 2, maxEvidence: 2, maxDurationMs: 200 },
  };

  const timedOut = await executor.execute(input);
  assert.deepEqual(timedOut.evidence.map(item => item.id), ['dense-1']);
  assert.deepEqual(
    timedOut.laneExecutions.map(item => [item.retriever, item.status, item.errorCode]),
    [
      [retriever, 'failed', 'RAG_LANE_TIMEOUT'],
      ['required-dense-after-optional-timeout', 'completed', undefined],
    ]
  );
  assert.equal(timedOut.stopReason, 'sufficient');

  const admissionBlocked = await executor.execute(input);
  assert.deepEqual(admissionBlocked.evidence.map(item => item.id), ['dense-2']);
  assert.equal(admissionBlocked.laneExecutions[0].errorCode, 'RAG_LANE_PROVIDER_BUSY');
  assert.equal(hybridCalls, 1);
  assert.equal(denseCalls, 2);

  releaseTimedOutHybrid();
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await executor.execute(input);
  assert.deepEqual(recovered.evidence.map(item => item.id), ['dense-3']);
  assert.equal(hybridCalls, 2);
  assert.equal(denseCalls, 3);
});
test('provider admission remains blocked until every concurrent timed-out call settles', async () => {
  const releases = [];
  let calls = 0;
  const retriever = `concurrent-non-cooperative-${Date.now()}`;
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever,
      async execute({ lane }) {
        calls++;
        if (calls <= 2) {
          return new Promise(resolve => {
            releases.push(() => resolve({
              evidence: [createEvidence(`late-${calls}`, lane.id)],
            }));
          });
        }
        return { evidence: [createEvidence('fresh', lane.id)] };
      },
    },
  ]);
  const input = {
    request: createRequest(),
    plan: createPlan([createLane('dense', 'dense-vector', true)]),
    budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 10 },
  };

  const timedOutCalls = await Promise.allSettled([
    executor.execute(input),
    executor.execute(input),
  ]);
  assert.deepEqual(
    timedOutCalls.map(result => result.status === 'rejected' ? result.reason.code : 'fulfilled'),
    ['RAG_LANE_TIMEOUT', 'RAG_LANE_TIMEOUT']
  );
  assert.equal(calls, 2);
  assert.equal(releases.length, 2);

  releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    () => executor.execute({ ...input, budget: { ...input.budget, maxDurationMs: 1000 } }),
    error => error?.code === 'RAG_LANE_PROVIDER_BUSY'
  );
  assert.equal(calls, 2);

  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await executor.execute({
    ...input,
    budget: { ...input.budget, maxDurationMs: 1000 },
  });
  assert.equal(calls, 3);
  assert.deepEqual(recovered.evidence.map(item => item.id), ['fresh']);
});

test('external cancellation is distinct from timeout and admission-blocks orphaned provider work', async () => {
  const controller = new AbortController();
  let releaseCancelledCall;
  let observedSignal;
  let calls = 0;
  const retriever = `cancelled-non-cooperative-${Date.now()}`;
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever,
      async execute({ lane, signal }) {
        calls++;
        observedSignal = signal;
        if (calls === 1) {
          return new Promise(resolve => {
            releaseCancelledCall = () => resolve({
              evidence: [createEvidence('cancelled-late', lane.id)],
            });
          });
        }
        return { evidence: [createEvidence('fresh-after-cancel', lane.id)] };
      },
    },
  ]);
  const input = {
    request: createRequest(),
    plan: createPlan([createLane('dense', 'dense-vector', true)]),
    budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 1000 },
  };

  const cancelled = executor.execute({ ...input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('private disconnect reason'));
  await assert.rejects(cancelled, error => {
    assert.ok(error instanceof RagLaneExecutionError);
    assert.equal(error.code, 'RAG_REQUEST_ABORTED');
    assert.equal(error.partialResult.stopReason, 'failed');
    assert.equal(error.partialResult.laneExecutions[0].errorCode, 'RAG_REQUEST_ABORTED');
    assert.equal(error.message.includes('private disconnect reason'), false);
    return true;
  });
  assert.equal(observedSignal.aborted, true);

  await assert.rejects(
    () => executor.execute(input),
    error => error?.code === 'RAG_LANE_PROVIDER_BUSY'
  );
  assert.equal(calls, 1);

  releaseCancelledCall();
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await executor.execute(input);
  assert.equal(calls, 2);
  assert.deepEqual(recovered.evidence.map(item => item.id), ['fresh-after-cancel']);
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

test('optional lanes fail closed when evidence violates scope or quarantine invariants', async () => {
  for (const unsafeEvidence of [
    { tenantId: 'tenant-b' },
    { corpusId: 'corpus-b' },
    { trustLevel: 'quarantined' },
  ]) {
    const executor = new RagLaneExecutor([
      {
        type: 'graph-entity',
        retriever: 'unsafe-optional-graph',
        async execute({ lane }) {
          return {
            evidence: [{ ...createEvidence('unsafe', lane.id), ...unsafeEvidence }],
          };
        },
      },
    ]);

    await assert.rejects(
      () => executor.execute({
        request: createRequest(),
        plan: createPlan([createLane('graph', 'graph-entity', false)]),
        budget: { maxLanes: 1, maxEvidence: 2, maxDurationMs: 1000 },
      }),
      error => {
        assert.ok(error instanceof RagLaneExecutionError);
        assert.equal(error.code, 'RAG_EVIDENCE_SCOPE_VIOLATION');
        assert.equal(error.partialResult.transitions.at(-1).reason, 'evidence_scope_validation_failed');
        return true;
      }
    );
  }
});

test('fusion and rerank lanes can transform evidence order without losing provenance', async () => {
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'unit-dense',
      async execute({ lane }) {
        return {
          evidence: [
            { ...createEvidence('ev-1', lane.id), retrievalScore: 0.9 },
            { ...createEvidence('ev-2', lane.id), retrievalScore: 0.8 },
          ],
        };
      },
    },
    {
      type: 'fusion',
      retriever: 'unit-fusion',
      async execute({ priorEvidence }) {
        return {
          evidence: [],
          transform: {
            orderedEvidenceIds: [...priorEvidence].reverse().map(item => item.id),
            rerankScores: { 'ev-2': 1, 'ev-1': 0.9 },
          },
        };
      },
    },
  ]);

  const result = await executor.execute({
    request: createRequest(),
    plan: createPlan([
      createLane('dense', 'dense-vector', true),
      createLane('fusion', 'fusion', true),
    ]),
    budget: { maxLanes: 2, maxEvidence: 3, maxDurationMs: 1000 },
  });

  assert.deepEqual(result.evidence.map(item => item.id), ['ev-2', 'ev-1']);
  assert.deepEqual(result.evidence.map(item => item.laneId), ['dense', 'dense']);
  assert.deepEqual(result.evidence.map(item => item.rerankScore), [1, 0.9]);
  assert.deepEqual(result.laneExecutions[1].retrievedEvidenceIds, ['ev-2', 'ev-1']);
});

test('evidence transforms reject unknown, duplicate, incomplete, and non-finite updates', async () => {
  for (const transform of [
    { orderedEvidenceIds: ['missing'] },
    { orderedEvidenceIds: ['ev-1', 'ev-1'] },
    { orderedEvidenceIds: [] },
    { orderedEvidenceIds: ['ev-1'], rerankScores: { 'ev-1': Number.NaN } },
  ]) {
    const executor = new RagLaneExecutor([
      {
        type: 'dense-vector',
        retriever: 'unit-dense',
        async execute({ lane }) {
          return { evidence: [createEvidence('ev-1', lane.id)] };
        },
      },
      {
        type: 'fusion',
        retriever: 'unsafe-transform',
        async execute() {
          return { evidence: [], transform };
        },
      },
    ]);
    await assert.rejects(
      () => executor.execute({
        request: createRequest(),
        plan: createPlan([
          createLane('dense', 'dense-vector', true),
          createLane('fusion', 'fusion', true),
        ]),
        budget: { maxLanes: 2, maxEvidence: 3, maxDurationMs: 1000 },
      }),
      error => {
        assert.ok(error instanceof RagLaneExecutionError);
        assert.equal(error.laneId, 'fusion');
        return true;
      }
    );
  }
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
