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

const { RagKernel, RagKernelExecutionError } = await import('./kernel.ts');
const { createRagPolicy, resolveRagPolicyId } = await import('./policies.ts');
const { invokeRagKernelWorkflow, prepareRagWorkflowRun } = await import('./workflow.ts');
const { createDefaultRetrievalPlan } = await import('../retrieval/retrieval-plan.ts');
const { RagLaneExecutor } = await import('../retrieval/lane-executor.ts');

test('RAG policy resolver preserves legacy /api/ask mode selection', () => {
  assert.equal(resolveRagPolicyId(createRequest({})), 'memory');
  assert.equal(resolveRagPolicyId(createRequest({ storageBackend: 'milvus' })), 'milvus-2step');
  assert.equal(
    resolveRagPolicyId(createRequest({ storageBackend: 'milvus', useAgenticRAG: true })),
    'agentic'
  );
  assert.equal(
    resolveRagPolicyId(createRequest({ storageBackend: 'milvus', useAdaptiveEntityRAG: true })),
    'adaptive-entity'
  );
  assert.equal(
    resolveRagPolicyId(createRequest({
      storageBackend: 'milvus',
      serverPolicyId: 'mirofish-research',
    })),
    'mirofish-research'
  );
});

test('RAG kernel executes a policy and records an envelope without changing output', async () => {
  const output = { success: true, answer: 'ok' };
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'memory',
      description: 'unit memory policy',
      execute: async () => output,
    }),
  ]);

  const result = await kernel.execute(
    createRequest({}),
    'memory',
    { now: new Date('2026-05-14T00:00:00.000Z'), traceId: 'trace-test' }
  );

  assert.equal(result.output, output);
  assert.equal(result.envelope.trace_id, 'trace-test');
  assert.equal(result.envelope.policy_id, 'memory');
  assert.equal(result.envelope.status, 'completed');
  assert.equal(result.envelope.retrieval_plan.lanes[0].type, 'memory');
});

test('RAG kernel creates the retrieval plan before policy execution', async () => {
  let receivedPlan;
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'milvus-2step',
      description: 'plan-aware policy',
      execute: async context => {
        receivedPlan = context.retrievalPlan;
        return {
          output: { success: true },
          retrievalPlan: context.retrievalPlan,
          evidence: [
            {
              id: 'evidence-1',
              tenantId: 'local',
              corpusId: 'default',
              documentId: 'doc-1',
              documentVersion: 'v1',
              content: 'canonical evidence',
              trustLevel: 'reviewed',
              laneId: 'dense-vector-required',
            },
          ],
          laneExecutions: [
            {
              laneId: 'dense-vector-required',
              retriever: 'unit-dense',
              status: 'completed',
              retrievedEvidenceIds: ['evidence-1'],
              latencyMs: 3,
              stopReason: 'sufficient',
            },
          ],
          execution: {
            state: 'completed',
            transitions: [],
            budget: { maxLanes: 1, maxEvidence: 3, maxDurationMs: 1000 },
            stopReason: 'sufficient',
          },
        };
      },
    }),
  ]);

  const result = await kernel.execute(
    createRequest({ storageBackend: 'milvus' }),
    'milvus-2step',
    { now: new Date('2026-05-14T00:00:00.000Z'), traceId: 'trace-plan' }
  );

  assert.equal(receivedPlan.lanes[0].type, 'dense-vector');
  assert.equal(result.envelope.retrieval_plan, receivedPlan);
  assert.equal(result.envelope.evidence[0].id, 'evidence-1');
  assert.equal(result.envelope.lane_executions[0].retriever, 'unit-dense');
  assert.equal(result.envelope.execution.stop_reason, 'sufficient');
});

test('RAG workflow invokes the kernel through a LangChain runnable with trace metadata', async () => {
  const output = { success: true, answer: 'workflow ok' };
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'memory',
      description: 'unit memory workflow policy',
      execute: async () => output,
    }),
  ]);

  const result = await invokeRagKernelWorkflow(kernel, {
    request: createRequest({
      sessionId: 'session-123',
      userId: 'user-1',
      requestId: 'request-abc',
    }),
    policyId: 'memory',
    context: {
      name: 'Unit RAG Workflow',
      route: '/api/ask',
      traceId: 'trace-workflow',
      now: new Date('2026-06-11T00:00:00.000Z'),
      tags: ['unit'],
      metadata: {
        source: 'kernel-test',
      },
    },
  });

  assert.equal(result.output, output);
  assert.equal(result.envelope.trace_id, 'trace-workflow');
  assert.equal(result.workflow.threadId, 'session-123');
  assert.deepEqual(result.workflow.tags, ['rag', 'rag-kernel', 'memory', 'unit']);
  assert.equal(result.workflow.metadata.thread_id, 'session-123');
  assert.equal(result.workflow.metadata.route, '/api/ask');
  assert.equal(result.workflow.metadata.workflow_name, 'Unit RAG Workflow');
  assert.equal(result.workflow.metadata.source, 'kernel-test');
  assert.equal(result.workflow.metadata.rag_policy, 'memory');
});

test('RAG workflow propagates runtime cancellation and never invokes a pre-aborted policy', async () => {
  const controller = new AbortController();
  let policyCalls = 0;
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'memory',
      description: 'must not execute after disconnect',
      execute: async () => {
        policyCalls++;
        return { success: true };
      },
    }),
  ]);
  controller.abort(new Error('private disconnect reason'));

  await assert.rejects(
    () => invokeRagKernelWorkflow(kernel, {
      request: createRequest({ requestId: 'request-cancelled' }),
      policyId: 'memory',
      signal: controller.signal,
      context: { traceId: 'trace-cancelled' },
    }),
    error => {
      assert.ok(error instanceof RagKernelExecutionError);
      assert.equal(error.envelope.status, 'failed');
      assert.equal(error.envelope.error.code, 'RAG_REQUEST_ABORTED');
      assert.equal(error.envelope.error.message.includes('private disconnect reason'), false);
      return true;
    }
  );
  assert.equal(policyCalls, 0);
});

test('RAG workflow preparation creates deterministic fallback trace ids', () => {
  const prepared = prepareRagWorkflowRun({
    request: createRequest({ requestId: 'request-xyz' }),
    policyId: 'memory',
    context: {
      now: new Date('2026-06-11T00:00:00.000Z'),
    },
  });

  assert.equal(prepared.threadId, 'request-xyz');
  assert.equal(prepared.traceId, 'rag-memory-1781136000000-requestxyz');
  assert.equal(prepared.runnableConfig.configurable.thread_id, 'request-xyz');
  assert.equal(prepared.runnableConfig.configurable.rag_policy, 'memory');
});

test('RAG kernel wraps policy failures with traceable execution context', async () => {
  const originalError = new TypeError('policy exploded');
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'memory',
      description: 'failing memory policy',
      execute: async () => {
        throw originalError;
      },
    }),
  ]);

  await assert.rejects(
    () =>
      kernel.execute(
        createRequest({}),
        'memory',
        { now: new Date('2026-05-14T00:00:00.000Z'), traceId: 'trace-failed' }
      ),
    error => {
      assert.ok(error instanceof RagKernelExecutionError);
      assert.equal(error.originalError, originalError);
      assert.equal(error.envelope.trace_id, 'trace-failed');
      assert.equal(error.envelope.policy_id, 'memory');
      assert.equal(error.envelope.status, 'failed');
      assert.equal(error.envelope.error.name, 'TypeError');
      assert.equal(error.envelope.error.message, 'policy exploded');
      assert.equal(error.envelope.metadata.policy_description, 'failing memory policy');
      assert.equal(error.envelope.retrieval_plan.lanes[0].type, 'memory');
      return true;
    }
  );
});

test('RAG kernel maps non-2xx Response output to a failed envelope without losing the response', async () => {
  const failedResponse = new Response(
    JSON.stringify({ success: false, code: 'UPSTREAM_FAILED' }),
    {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }
  );
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'memory',
      description: 'response failure policy',
      execute: async () => failedResponse,
    }),
  ]);

  const result = await kernel.execute(
    createRequest({}),
    'memory',
    { now: new Date('2026-05-14T00:00:00.000Z'), traceId: 'trace-response-failed' }
  );

  assert.equal(result.output, failedResponse);
  assert.equal(result.envelope.status, 'failed');
  assert.equal(result.envelope.error.name, 'RagPolicyHttpError');
  assert.equal(result.envelope.error.code, 'RAG_POLICY_HTTP_ERROR');
  assert.equal(result.envelope.error.http_status, 503);
  assert.match(result.envelope.error.message, /HTTP 503/);
});

test('RAG kernel respects an explicit failed policy execution even when output resolves', async () => {
  const output = { success: false, error: 'agent failed' };
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'agentic',
      description: 'explicit failed-state policy',
      execute: async () => ({
        output,
        execution: {
          state: 'failed',
          transitions: [],
          stopReason: 'failed',
        },
      }),
    }),
  ]);

  const result = await kernel.execute(
    createRequest({ storageBackend: 'milvus', useAgenticRAG: true }),
    'agentic',
    { traceId: 'trace-explicit-failure' }
  );
  assert.equal(result.output, output);
  assert.equal(result.envelope.status, 'failed');
  assert.equal(result.envelope.execution.state, 'failed');
  assert.equal(result.envelope.execution.stop_reason, 'failed');
  assert.equal(result.envelope.error.code, 'RAG_POLICY_STATE_FAILED');
});

test('RAG kernel preserves a required-lane partial failure snapshot', async () => {
  const budget = { maxLanes: 1, maxEvidence: 3, maxDurationMs: 1000 };
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'milvus-2step',
      description: 'lane failure policy',
      execute: async context => {
        const executor = new RagLaneExecutor([
          {
            type: 'dense-vector',
            retriever: 'broken-dense',
            async execute() {
              throw new Error('milvus unavailable');
            },
          },
        ]);
        await executor.execute({
          request: context.request,
          plan: context.retrievalPlan,
          budget,
        });
        return { success: true };
      },
    }),
  ]);

  await assert.rejects(
    () =>
      kernel.execute(
        createRequest({ storageBackend: 'milvus' }),
        'milvus-2step',
        { traceId: 'trace-lane-failure' }
      ),
    error => {
      assert.ok(error instanceof RagKernelExecutionError);
      assert.equal(error.envelope.status, 'failed');
      assert.equal(error.envelope.lane_executions[0].status, 'failed');
      assert.equal(error.envelope.lane_executions[0].errorCode, 'RAG_LANE_FAILED');
      assert.equal(error.envelope.execution.transitions.at(-1).to, 'failed');
      assert.deepEqual(error.envelope.execution.budget, budget);
      assert.equal(error.envelope.execution.stop_reason, 'failed');
      assert.equal(error.envelope.error.code, 'RAG_LANE_FAILED');
      return true;
    }
  );
});

test('RAG workflow preserves RagKernelExecutionError for thrown policy failures', async () => {
  const originalError = new TypeError('workflow policy exploded');
  const kernel = new RagKernel([
    createRagPolicy({
      id: 'memory',
      description: 'workflow response failure policy',
      execute: async () => {
        throw originalError;
      },
    }),
  ]);

  await assert.rejects(
    () =>
      invokeRagKernelWorkflow(kernel, {
        request: createRequest({ requestId: 'request-failed' }),
        policyId: 'memory',
        context: {
          traceId: 'trace-workflow-failed',
          now: new Date('2026-06-11T00:00:00.000Z'),
        },
      }),
    error => {
      assert.ok(error instanceof RagKernelExecutionError);
      assert.equal(error.envelope.trace_id, 'trace-workflow-failed');
      assert.equal(error.envelope.status, 'failed');
      assert.equal(error.originalError, originalError);
      return true;
    }
  );
});

test('default adaptive plan does not declare a synthetic fusion lane', () => {
  const plan = createDefaultRetrievalPlan(
    createRequest({ storageBackend: 'milvus', enableReranking: true }),
    'adaptive-entity',
    new Date('2026-05-14T00:00:00.000Z')
  );

  assert.deepEqual(
    plan.lanes.map(lane => lane.type),
    ['metadata-filter', 'dense-vector', 'rerank', 'generation-only']
  );
  assert.equal(plan.policy_id, 'adaptive-entity');
});

test('MiroFish graph lane is optional and only planned for global or multi-hop queries', () => {
  const ordinary = createDefaultRetrievalPlan(
    createRequest({ question: 'Alice 的职位是什么？', storageBackend: 'milvus' }),
    'mirofish-research'
  );
  const multiHop = createDefaultRetrievalPlan(
    createRequest({
      question: 'Alice 与 Acme 之间有什么关系？',
      storageBackend: 'milvus',
      graphArtifactIdentity: {
        documentId: 'graph-doc',
        documentVersion: 'sha256:v1',
        trustLevel: 'reviewed',
      },
    }),
    'mirofish-research'
  );

  assert.deepEqual(ordinary.lanes.map(lane => lane.type), ['dense-vector']);
  assert.deepEqual(multiHop.lanes.map(lane => lane.type), ['dense-vector', 'graph-entity']);
  assert.equal(multiHop.lanes[1].required, false);
  assert.equal(multiHop.lanes[1].parameters.queryKind, 'multi-hop');
  assert.equal(multiHop.lanes[1].parameters.documentId, 'graph-doc');
  assert.equal(multiHop.lanes[1].parameters.documentVersion, 'sha256:v1');
});

function createRequest(overrides) {
  return {
    question: '测试问题',
    topK: 3,
    similarityThreshold: 0,
    llmModel: 'llama3.1',
    embeddingModel: 'nomic-embed-text',
    storageBackend: 'memory',
    ...overrides,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
