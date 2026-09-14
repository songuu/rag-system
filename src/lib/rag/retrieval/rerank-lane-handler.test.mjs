import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context); throw error; } } });
const { createRerankLaneHandler } = await import('./rerank-lane-handler.ts');
const { RagLaneExecutor, RagLaneEvidenceValidationError } = await import('./lane-executor.ts');
function evidence(id) { return { id, content: `content ${id}`, tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc', documentVersion: 'v1', trustLevel: 'reviewed', laneId: 'dense', retrievalScore: 0.4, metadata: { source: 'original' } }; }
function context(priorEvidence = [evidence('a'), evidence('b')]) {
  const lane = { id: 'rerank', type: 'rerank', required: false, description: 'rerank', executionBudget: { maxDurationMs: 10 } };
  return { request: { question: 'query', topK: 2, retrievalScope: { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['reviewed'], enforceIsolation: true } }, plan: { id: 'plan', query: 'query', policy_id: 'milvus-2step', top_k: 2, similarity_threshold: 0, created_at: '2026-09-07T00:00:00Z', lanes: [{ id: 'dense', type: 'dense-vector', required: true, description: 'dense' }, lane] }, lane, priorEvidence, signal: new AbortController().signal };
}
function provider(rerank = async (_query, docs) => [...docs].reverse().map((doc, index) => ({ ...doc, originalIndex: docs.length - 1 - index, relevanceScore: 2 - index })), model = 'test-model') { return { name: 'unit', model, rerank }; }
test('rerank lane transforms the complete order and preserves all evidence provenance', async () => {
  const ctx = context();
  const original = structuredClone(ctx.priorEvidence);
  const reranker = provider(async (query, docs, topK, options) => {
    assert.equal(query, ctx.plan.query); assert.equal(topK, 2); assert.equal(options.signal.aborted, false); assert.deepEqual(Object.keys(docs[0]), ['id', 'content']);
    return [{ ...docs[1], originalIndex: 1, relevanceScore: 2.3 }, { ...docs[0], originalIndex: 0, relevanceScore: -0.5 }];
  });
  const handler = createRerankLaneHandler({ provider: reranker });
  assert.equal(handler.type, 'rerank'); assert.equal(handler.retriever, 'rerank:unit:test-model');
  const result = await new RagLaneExecutor([{ type: 'dense-vector', retriever: 'unit-dense', execute: async () => ({ evidence: ctx.priorEvidence }) }, handler]).execute({ request: ctx.request, plan: ctx.plan, budget: { maxLanes: 2, maxEvidence: 10, maxDurationMs: 1000 } });
  assert.deepEqual(result.evidence, [{ ...original[1], rerankScore: 2.3 }, { ...original[0], rerankScore: -0.5 }]); assert.deepEqual(ctx.priorEvidence, original); assert.equal(result.laneExecutions[1].retrievalQuality, undefined); assert.equal(result.laneExecutions[1].uncertainty, undefined);
});
test('rerank without configured provider or candidates makes no network call', async t => {
  const keys = ['RERANK_PROVIDER', 'SILICONFLOW_API_KEY', 'COHERE_API_KEY', 'VOYAGE_API_KEY']; const saved = keys.map(key => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const unavailable = await createRerankLaneHandler().execute(context());
  assert.equal(unavailable.stopReason, 'capability_unavailable'); assert.equal(unavailable.metadata.reason, 'reranker_not_configured'); assert.equal(unavailable.transform, undefined); assert.deepEqual(unavailable.evidence, []);
  let calls = 0; const empty = await createRerankLaneHandler({ provider: provider(async () => { calls++; return []; }) }).execute(context([]));
  assert.equal(empty.stopReason, 'no_gain'); assert.equal(calls, 0); assert.equal(fetchMock.mock.callCount(), 0);
});
test('rerank validates scope and evidence identities before any provider call', async () => {
  const invalidContexts = [{ ...context(), request: { ...context().request, retrievalScope: undefined } }, ...[{ tenantId: 'other' }, { corpusId: 'other' }, { trustLevel: 'quarantined' }, { trustLevel: 'external' }, { id: '' }, { content: '' }, { documentId: '' }, { documentVersion: '' }, { laneId: '' }].map(patch => context([{ ...evidence('a'), ...patch }])), context([evidence('a'), evidence('a')])];
  let calls = 0;
  for (const ctx of invalidContexts) await assert.rejects(createRerankLaneHandler({ provider: provider(async () => { calls++; return []; }) }).execute(ctx), error => error instanceof RagLaneEvidenceValidationError);
  assert.equal(calls, 0);
});
test('rerank rejects forged, partial, mutated, conflicting and non-finite provider output', async () => {
  const valid = [{ id: 'b', content: 'content b', originalIndex: 1, relevanceScore: 0.8 }, { id: 'a', content: 'content a', originalIndex: 0, relevanceScore: 0.7 }];
  for (const outputs of [null, [], valid.slice(0, 1), [valid[0], valid[0]], [{ ...valid[0], id: 'unknown' }, valid[1]], [{ ...valid[0], content: 'private replacement' }, valid[1]], [{ ...valid[0], originalIndex: 0 }, valid[1]], [{ ...valid[0], originalIndex: 0.5 }, valid[1]], [{ ...valid[0], relevanceScore: Number.NaN }, valid[1]], [{ ...valid[0], relevanceScore: Infinity }, valid[1]]]) await assert.rejects(createRerankLaneHandler({ provider: provider(async () => outputs) }).execute(context()), /invalid response/);
  const ctx = context();
  await assert.rejects(createRerankLaneHandler({ provider: provider(async (_query, docs) => { docs[0].content = 'private poisoned content'; return docs.map((doc, index) => ({ ...doc, originalIndex: index, relevanceScore: 1 })); }) }).execute(ctx), /invalid response/);
  assert.equal(ctx.priorEvidence[0].content, 'content a');
});
test('optional rerank failure preserves original evidence and excludes private diagnostics', async () => {
  const ctx = context(); const handler = createRerankLaneHandler({ provider: provider(async () => { throw new Error('private provider body'); }) });
  const result = await new RagLaneExecutor([{ type: 'dense-vector', retriever: 'dense-on-failure', execute: async () => ({ evidence: ctx.priorEvidence }) }, handler]).execute({ request: ctx.request, plan: ctx.plan, budget: { maxLanes: 2, maxEvidence: 10, maxDurationMs: 1000 } });
  assert.deepEqual(result.evidence, ctx.priorEvidence); assert.equal(result.laneExecutions[1].errorCode, 'RAG_LANE_FAILED'); assert.doesNotMatch(JSON.stringify(result), /private/);
});
test('timed-out non-cooperative rerank is fenced across fresh handler instances until settlement', async () => {
  let calls = 0; let release;
  const reranker = provider(async (_query, docs) => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return docs.map((doc, index) => ({ ...doc, originalIndex: index, relevanceScore: 1 })); }, 'non-cooperative');
  const ctx = context();
  const execute = () => new RagLaneExecutor([{ type: 'dense-vector', retriever: 'dense-before-rerank-timeout', execute: async () => ({ evidence: ctx.priorEvidence }) }, createRerankLaneHandler({ provider: reranker })]).execute({ request: ctx.request, plan: ctx.plan, budget: { maxLanes: 2, maxEvidence: 10, maxDurationMs: 1000 } });
  const first = await execute(); assert.equal(first.laneExecutions[1].errorCode, 'RAG_LANE_TIMEOUT'); assert.deepEqual(first.evidence, ctx.priorEvidence);
  const second = await execute(); assert.equal(second.laneExecutions[1].errorCode, 'RAG_LANE_PROVIDER_BUSY'); assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  const third = await execute(); assert.equal(third.laneExecutions[1].status, 'completed'); assert.equal(calls, 2);
});
