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

const { createMilvusHybridLaneHandler } = await import('./hybrid-lane-handler.ts');
const { RagLaneExecutor } = await import('./lane-executor.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('off handler is registrable and performs zero embedding or Milvus work', async () => {
  let calls = 0;
  const handler = createMilvusHybridLaneHandler({
    mode: 'off',
    collectionName: 'rag_shadow_v2',
    async embedQuery() {
      calls++;
      return [0.1];
    },
    port: port(() => { calls++; }),
  });
  assert.equal(handler.type, 'sparse-bm25');
  const result = await handler.execute(context());
  assert.equal(calls, 0);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.stopReason, 'capability_unavailable');
});

test('shadow handler records only IDs and scores and returns no evidence', async () => {
  const handler = createMilvusHybridLaneHandler({
    mode: 'shadow',
    collectionName: 'rag_shadow_v2',
    async embedQuery() { return [0.1, 0.2]; },
    port: port(),
  });
  const result = await handler.execute(context());
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.metadata.shadowHits, [{ id: 'hit-1', score: 0.91 }]);
  assert.equal(result.metadata.participatesInGeneration, false);
  assert.equal(JSON.stringify(result.metadata).includes('secret passage'), false);
});

test('shadow handler validates scope before exposing diagnostic identifiers', async () => {
  const handler = createMilvusHybridLaneHandler({
    mode: 'shadow',
    collectionName: 'rag_shadow_v2',
    async embedQuery() { return [0.1]; },
    port: port(undefined, { tenantId: 'tenant-b' }),
  });
  await assert.rejects(handler.execute(context()), /scope does not match/);
});

test('active handler maps scoped provenance to canonical evidence', async () => {
  const handler = createMilvusHybridLaneHandler({
    mode: 'active',
    collectionName: 'rag_shadow_v2',
    async embedQuery(input) {
      assert.equal(input.embeddingModel, 'embed-model');
      return [0.1, 0.2];
    },
    port: port(),
  });
  const result = await handler.execute(context());
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.evidence[0], {
    id: 'hit-1',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-1',
    documentVersion: 'v3',
    content: 'secret passage',
    source: 'guide.pdf',
    page: 2,
    startOffset: 10,
    endOffset: 24,
    retrievalScore: 0.91,
    trustLevel: 'reviewed',
    laneId: 'hybrid-shadow',
    metadata: {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      documentId: 'doc-1',
      documentVersion: 'v3',
      trustLevel: 'reviewed',
      page: 2,
      startOffset: 10,
      endOffset: 24,
      lexicalMatch: true,
      hybridPolicyVersion: 'milvus-hybrid/v1',
    },
  });
});

test('active handler registers directly in RagLaneExecutor', async () => {
  const handler = createMilvusHybridLaneHandler({
    mode: 'active',
    collectionName: 'rag_shadow_v2',
    async embedQuery() { return [0.1, 0.2]; },
    port: port(),
  });
  const fixture = context();
  const plan = { ...fixture.plan, lanes: [fixture.lane] };
  const result = await new RagLaneExecutor([handler]).execute({
    request: fixture.request,
    plan,
    budget: { maxLanes: 1, maxEvidence: 5, maxDurationMs: 1000 },
  });
  assert.deepEqual(result.evidence.map(item => item.id), ['hit-1']);
  assert.equal(result.laneExecutions[0].retriever, 'milvus-native-hybrid-v1');
  assert.equal(result.laneExecutions[0].status, 'completed');
});

test('active handler rejects cross-scope or incomplete provenance', async () => {
  const mismatched = createMilvusHybridLaneHandler({
    mode: 'active',
    collectionName: 'rag_shadow_v2',
    async embedQuery() { return [0.1]; },
    port: port(undefined, { tenantId: 'tenant-b' }),
  });
  await assert.rejects(mismatched.execute(context()), /scope does not match/);

  const incomplete = createMilvusHybridLaneHandler({
    mode: 'active',
    collectionName: 'rag_shadow_v2',
    async embedQuery() { return [0.1]; },
    port: port(undefined, { documentVersion: undefined }),
  });
  await assert.rejects(incomplete.execute(context()), /documentVersion is required/);

  const missingScopeProvenance = createMilvusHybridLaneHandler({
    mode: 'active',
    collectionName: 'rag_shadow_v2',
    async embedQuery() { return [0.1]; },
    port: port(undefined, { tenantId: undefined }),
  });
  await assert.rejects(missingScopeProvenance.execute(context()), /tenantId is required/);
});

test('handler fails closed before adapting conflicting canonical and alias provenance', async () => {
  for (const metadataOverrides of [
    { tenant_id: 'tenant-b' },
    { corpus_id: 'corpus-b' },
    { document_id: 'doc-2' },
    { document_version: 'v4' },
    { trust_level: 'external' },
    { start_offset: 11 },
    { end_offset: 25 },
  ]) {
    const handler = createMilvusHybridLaneHandler({
      mode: 'active',
      collectionName: 'rag_shadow_v2',
      async embedQuery() { return [0.1]; },
      port: port(undefined, metadataOverrides),
    });
    await assert.rejects(handler.execute(context()), /contains conflicting/);
  }
});

function port(onCall = () => {}, metadataOverrides = {}) {
  return {
    async probe() {
      onCall();
      return {
        nativeHybridSearch: true,
        bm25Function: true,
        schemaCompatible: true,
        provider: 'fixture',
      };
    },
    async search(request) {
      onCall();
      assert.equal(request.scope.tenantId, 'tenant-a');
      return [{
        id: 'hit-1',
        score: 0.91,
        content: 'secret passage',
        source: 'guide.pdf',
        metadata: {
          tenantId: 'tenant-a',
          corpusId: 'corpus-a',
          documentId: 'doc-1',
          documentVersion: 'v3',
          trustLevel: 'reviewed',
          page: 2,
          startOffset: 10,
          endOffset: 24,
          lexicalMatch: true,
          ...metadataOverrides,
        },
      }];
    },
  };
}

function context() {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['reviewed'],
    enforceIsolation: true,
  });
  return {
    request: {
      question: 'find ERR-42',
      topK: 5,
      similarityThreshold: 0.3,
      llmModel: 'llm-model',
      embeddingModel: 'embed-model',
      storageBackend: 'milvus',
      retrievalScope: scope,
    },
    plan: {
      id: 'plan',
      policy_id: 'reasoning',
      query: 'find ERR-42',
      lanes: [],
      top_k: 5,
      similarity_threshold: 0.3,
      created_at: new Date(0).toISOString(),
    },
    lane: {
      id: 'hybrid-shadow',
      type: 'sparse-bm25',
      required: false,
      description: 'fixture',
    },
    priorEvidence: [],
    signal: new AbortController().signal,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
