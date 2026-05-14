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

const { RagKernel } = await import('./kernel.ts');
const { createRagPolicy, resolveRagPolicyId } = await import('./policies.ts');
const { createDefaultRetrievalPlan } = await import('../retrieval/retrieval-plan.ts');

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
  assert.equal(result.envelope.retrieval_plan.lanes[0].type, 'memory');
});

test('default retrieval plan models adaptive entity as filter plus fusion plus rerank', () => {
  const plan = createDefaultRetrievalPlan(
    createRequest({ storageBackend: 'milvus', enableReranking: true }),
    'adaptive-entity',
    new Date('2026-05-14T00:00:00.000Z')
  );

  assert.deepEqual(
    plan.lanes.map(lane => lane.type),
    ['metadata-filter', 'dense-vector', 'fusion', 'rerank']
  );
  assert.equal(plan.policy_id, 'adaptive-entity');
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

