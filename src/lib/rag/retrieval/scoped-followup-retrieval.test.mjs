import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});
const { createScopedFollowupRetriever, resolveScopedRetrievalMode, resolveScopedDecisionMode } =
  await import('./scoped-followup-retrieval.ts');
const scope = {
  tenantId: 'a', corpusId: 'corpus', allowedTrustLevels: ['reviewed'], enforceIsolation: true,
};
function request() {
  return {
    question: 'Original', topK: 2, similarityThreshold: 0.1, storageBackend: 'milvus',
    llmModel: 'local', embeddingModel: 'local', retrievalScope: structuredClone(scope),
  };
}
function evidence(laneId, overrides = {}) {
  return {
    id: 'a1', content: 'scoped fact', tenantId: 'a', corpusId: 'corpus',
    documentId: 'doc', documentVersion: 'v1', laneId, trustLevel: 'reviewed',
    retrievalScore: 0.9, ...overrides,
  };
}
test('bounded retrieval mode is server-owned and rejects unknown configuration', () => {
  assert.equal(resolveScopedRetrievalMode({}), 'snapshot');
  assert.equal(resolveScopedRetrievalMode({ RAG_AGENTIC_RETRIEVAL_MODE: ' BOUNDED ' }), 'bounded');
  assert.throws(() => resolveScopedRetrievalMode({ RAG_AGENTIC_RETRIEVAL_MODE: 'unlimited' }), /mode/i);
});
test('bounded decision mode defaults to structured and rejects unknown server configuration', () => {
  assert.equal(resolveScopedDecisionMode({}), 'structured');
  assert.equal(resolveScopedDecisionMode({ RAG_AGENTIC_DECISION_MODE: ' NATIVE-TOOLS ' }), 'native-tools');
  assert.throws(() => resolveScopedDecisionMode({ RAG_AGENTIC_DECISION_MODE: 'freeform' }), /decision mode/i);
});

test('follow-up retrieval freezes scope and executes through canonical lane validation', async () => {
  const original = request();
  const executions = [];
  const search = createScopedFollowupRetriever({
    request: original,
    async retrieve({ query, laneId, scope: activeScope, signal }) {
      assert.equal(query, 'Expanded');
      assert.deepEqual(activeScope, scope);
      assert.equal(signal.aborted, false);
      return [evidence(laneId)];
    },
    onExecution: (result, plan) => executions.push({ result, plan }),
  });
  original.retrievalScope.tenantId = 'other';
  original.retrievalScope.allowedTrustLevels.push('quarantined');
  const result = await search({ query: 'Expanded', signal: new AbortController().signal });
  assert.equal(result[0].tenantId, 'a');
  assert.equal(result[0].laneId, 'agentic-followup-1');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].result.laneExecutions[0].status, 'completed');
  assert.equal(executions[0].plan.lanes[0].required, true);
});
test('follow-up security failures carry partial lane evidence and never become fallback success', async () => {
  let partial;
  const search = createScopedFollowupRetriever({
    request: request(),
    retrieve: async ({ laneId }) => [evidence(laneId, { tenantId: 'forbidden' })],
    onExecution: result => { partial = result; },
  });
  await assert.rejects(
    search({ query: 'scope attack', signal: new AbortController().signal }),
    error => error.code === 'RAG_EVIDENCE_SCOPE_VIOLATION'
  );
  assert.equal(partial.laneExecutions[0].status, 'failed');
  assert.equal(partial.evidence.length, 0);
});
test('follow-up hard limits prevent an extra provider call or oversized query', async () => {
  let calls = 0;
  const search = createScopedFollowupRetriever({
    request: request(),
    retrieve: async ({ laneId }) => { calls++; return [evidence(laneId)]; },
  });
  await assert.rejects(search({ query: 'x'.repeat(1025), signal: new AbortController().signal }));
  for (const query of ['one', 'two']) {
    await search({ query, signal: new AbortController().signal });
  }
  await assert.rejects(search({ query: 'three', signal: new AbortController().signal }), /budget/i);
  assert.equal(calls, 2);
});
test('follow-up abort before retrieval never calls provider', async () => {
  let calls = 0;
  const search = createScopedFollowupRetriever({
    request: request(), retrieve: async () => { calls++; return []; },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(search({ query: 'cancelled', signal: controller.signal }));
  assert.equal(calls, 0);
});
test('follow-up timeout retains the dense provider reservation until actual settlement', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const search = createScopedFollowupRetriever({
    request: request(), timeoutMs: 5, retrieve: () => pending,
  });
  try {
    await assert.rejects(
      search({ query: 'slow', signal: new AbortController().signal }),
      error => error.code === 'RAG_LANE_TIMEOUT'
    );
    await assert.rejects(
      search({ query: 'busy', signal: new AbortController().signal }),
      error => error.code === 'RAG_LANE_PROVIDER_BUSY'
    );
  } finally {
    release([]);
    await new Promise(resolve => setImmediate(resolve));
  }
});
