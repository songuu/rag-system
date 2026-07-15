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

const { attachRagKernelHeaders, assertRagResponseTrace } = await import(
  './http-contract.ts'
);

test('HTTP contract keeps body and headers on the canonical kernel trace', async () => {
  const envelope = createEnvelope('completed');
  const response = new Response(
    JSON.stringify({ success: true, traceId: envelope.trace_id }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
  attachRagKernelHeaders(response.headers, envelope);
  const body = await response.json();

  assert.doesNotThrow(() => assertRagResponseTrace(body.traceId, envelope));
  assert.doesNotThrow(() =>
    assertRagResponseTrace(body.traceId, envelope.trace_id)
  );
  assert.equal(response.headers.get('x-rag-policy'), 'milvus-2step');
  assert.equal(response.headers.get('x-rag-trace-id'), envelope.trace_id);
  assert.equal(response.headers.get('x-rag-status'), 'completed');
});

test('HTTP contract exposes failed status and rejects a divergent body trace', () => {
  const envelope = createEnvelope('failed');
  const response = new Response('failed', { status: 503 });
  attachRagKernelHeaders(response.headers, envelope);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-rag-status'), 'failed');
  assert.throws(
    () => assertRagResponseTrace('legacy-trace', envelope),
    /must match/
  );
});

function createEnvelope(status) {
  return {
    trace_id: 'canonical-trace',
    policy_id: 'milvus-2step',
    status,
    question: 'question',
    storage_backend: 'milvus',
    retrieval_plan: {
      id: 'plan',
      policy_id: 'milvus-2step',
      query: 'question',
      lanes: [],
      top_k: 3,
      similarity_threshold: 0,
      created_at: '2026-07-15T00:00:00.000Z',
    },
    started_at: '2026-07-15T00:00:00.000Z',
    completed_at: '2026-07-15T00:00:01.000Z',
    duration_ms: 1000,
    evidence: [],
    lane_executions: [],
    execution: {
      state: status,
      transitions: [],
      stop_reason: status === 'failed' ? 'failed' : 'sufficient',
    },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
