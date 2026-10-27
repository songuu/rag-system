import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { classifyGraphQueryIntent } = await import('./query-intent.ts');
const { createDefaultRetrievalPlan } = await import('../rag/retrieval/retrieval-plan.ts');
const { resolveRagPolicyId } = await import('../rag/core/policies.ts');
const identity = { documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' };
const request = (overrides = {}) => ({
  question: '张三负责哪些项目？', storageBackend: 'milvus', topK: 5,
  similarityThreshold: 0.5, graphArtifactIdentity: identity, ...overrides,
});

test('recognizes ordinary entity questions including quoted names and English', () => {
  for (const query of ['张三是谁？', '“张三”负责哪些项目？', 'Alice 的职位是什么？', '介绍一下 Acme', 'Who is Alice?', 'What projects does Alice manage?']) {
    assert.equal(classifyGraphQueryIntent(query), 'entity', query);
  }
});

test('distinguishes relationship and global intent without changing ordinary text retrieval', () => {
  for (const query of ['Alice 与 Acme 之间有什么关系？', 'A 和 B 有什么关系？', '张三通过哪些人联系项目甲？', '解释张三与李四的关系', '"Alice"与"Acme"之间的关系是什么？']) {
    assert.equal(classifyGraphQueryIntent(query), 'relationship', query);
  }
  assert.equal(classifyGraphQueryIntent('总结全部文档的主题'), 'global');
  for (const query of ['你好', '解释二分查找', '错误码 ERR-123 是什么意思？', '今天的天气']) {
    assert.equal(classifyGraphQueryIntent(query), 'none', query);
  }
});

test('normal Milvus policy composes an optional graph lane only with server-owned identity and intent', () => {
  const plan = createDefaultRetrievalPlan(request(), 'milvus-2step');
  assert.deepEqual(plan.lanes.map(lane => lane.type), ['dense-vector', 'graph-entity']);
  assert.equal(plan.lanes[1].required, false);
  assert.equal(plan.lanes[1].parameters.documentId, identity.documentId);
  assert.equal(plan.lanes[1].parameters.maxHops, 1);
  assert.equal(createDefaultRetrievalPlan(request({ graphArtifactIdentity: undefined }), 'milvus-2step').lanes.length, 1);
  assert.equal(createDefaultRetrievalPlan(request({ question: '解释二分查找' }), 'milvus-2step').lanes.length, 1);
});

test('graph capability preserves policy priority and relationship hop bounds', () => {
  const input = request({ question: 'A 和 B 有什么关系？', useAgenticRAG: true });
  assert.equal(resolveRagPolicyId(input), 'agentic');
  const plan = createDefaultRetrievalPlan(input, 'agentic');
  const graph = plan.lanes.find(lane => lane.type === 'graph-entity');
  assert.ok(graph);
  assert.equal(graph.parameters.maxHops, 2);
  assert.equal(createDefaultRetrievalPlan(request({ storageBackend: 'memory' }), 'memory').lanes.some(lane => lane.type === 'graph-entity'), false);
});
