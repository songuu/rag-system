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

const {
  createHybridIndexDocument,
  createMilvusHybridCollectionManifest,
  milvusHybridSearch,
  reciprocalRankFusion,
  resolveMilvusHybridRolloutMode,
  weightedScoreFusion,
} = await import('./hybrid-policy.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('hybrid rollout defaults off and legacy boolean can only enable shadow', () => {
  assert.equal(resolveMilvusHybridRolloutMode({}), 'off');
  assert.equal(resolveMilvusHybridRolloutMode({ MILVUS_HYBRID_ENABLED: 'true' }), 'shadow');
  assert.equal(resolveMilvusHybridRolloutMode({ MILVUS_HYBRID_MODE: 'active' }), 'active');
  assert.throws(
    () => resolveMilvusHybridRolloutMode({ MILVUS_HYBRID_MODE: 'yes' }),
    /Unsupported/
  );
});

test('explicit hybrid runtime mode rejects invalid JavaScript input', async () => {
  await assert.rejects(
    milvusHybridSearch(createRequest(), {
      mode: 'invalid',
      port: { async probe() { return usableCapability(); }, async search() { return []; } },
    }),
    /Unsupported Milvus hybrid rollout mode/
  );
});

test('off mode does not probe or search', async () => {
  let calls = 0;
  const response = await milvusHybridSearch(createRequest(), {
    mode: 'off',
    port: {
      async probe() {
        calls++;
        return usableCapability();
      },
      async search() {
        calls++;
        return [];
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(response.participatesInGeneration, false);
  assert.equal(response.stopReason, 'disabled');
});

test('shadow results never participate while active results require capability', async () => {
  let searchCalls = 0;
  const port = {
    async probe() {
      return usableCapability();
    },
    async search() {
      searchCalls++;
      return [{ id: 'a', score: 0.9, content: 'A' }];
    },
  };
  const shadow = await milvusHybridSearch(createRequest(), { mode: 'shadow', port });
  assert.deepEqual(shadow.hits, []);
  assert.deepEqual(shadow.shadowHits.map(hit => hit.id), ['a']);
  assert.equal(shadow.participatesInGeneration, false);

  const active = await milvusHybridSearch(createRequest(), { mode: 'active', port });
  assert.deepEqual(active.hits.map(hit => hit.id), ['a']);
  assert.equal(active.participatesInGeneration, true);
  assert.equal(searchCalls, 2);
});

test('active empty hybrid results report no gain', async () => {
  const response = await milvusHybridSearch(createRequest(), {
    mode: 'active',
    port: {
      async probe() { return usableCapability(); },
      async search() { return []; },
    },
  });

  assert.deepEqual(response.hits, []);
  assert.equal(response.participatesInGeneration, true);
  assert.equal(response.stopReason, 'no_gain');
});

test('unsupported active capability fails closed before search', async () => {
  let searched = false;
  await assert.rejects(
    milvusHybridSearch(createRequest(), {
      mode: 'active',
      port: {
        async probe() {
          return { ...usableCapability(), schemaCompatible: false };
        },
        async search() {
          searched = true;
          return [];
        },
      },
    }),
    /requires native hybrid, BM25, and a compatible shadow schema/
  );
  assert.equal(searched, false);
});

test('capability and vector inputs are validated at the injected boundary', async () => {
  await assert.rejects(
    milvusHybridSearch(createRequest(), {
      mode: 'shadow',
      port: {
        async probe() {
          return { ...usableCapability(), nativeHybridSearch: 'yes' };
        },
        async search() { return []; },
      },
    }),
    /flags must be explicit booleans/
  );
  await assert.rejects(
    milvusHybridSearch({ ...createRequest(), sparseVector: { 1: Number.NaN } }, {
      mode: 'shadow',
      port: { async probe() { return usableCapability(); }, async search() { return []; } },
    }),
    /sparseVector values must be finite/
  );
});

test('RRF merges independent lane ranks deterministically', () => {
  const fused = reciprocalRankFusion(
    {
      dense: [hit('a', 0.9), hit('b', 0.8)],
      lexical: [hit('b', 12), hit('c', 8)],
    },
    { rankConstant: 60 }
  );
  assert.equal(fused[0].id, 'b');
  assert.deepEqual(fused[0].matchedLanes, ['dense', 'lexical']);
  assert.deepEqual(fused[0].laneRanks, { dense: 2, lexical: 1 });
  assert.ok(fused[0].fusionScore > fused[1].fusionScore);
});

test('weighted fusion normalizes per lane before applying weights', () => {
  const fused = weightedScoreFusion(
    {
      dense: [hit('a', 0.9), hit('b', 0.8)],
      lexical: [hit('b', 20), hit('c', 2)],
    },
    { laneWeights: { dense: 0.3, lexical: 0.7 } }
  );
  assert.equal(fused[0].id, 'b');
  assert.equal(fused[0].fusionScore, 0.7);
  assert.throws(
    () => weightedScoreFusion({ dense: [hit('a', 1)] }, { laneWeights: { dense: 0 } }),
    /positive lane weight/
  );
});

test('zero-weight lanes cannot contribute unique candidates to fusion', () => {
  const lanes = {
    dense: [hit('kept', 0.9)],
    disabled: [hit('zero-weight-only', 100)],
  };

  const rrf = reciprocalRankFusion(lanes, {
    laneWeights: { dense: 1, disabled: 0 },
  });
  const weighted = weightedScoreFusion(lanes, {
    laneWeights: { dense: 1, disabled: 0 },
  });

  assert.deepEqual(rrf.map(candidate => candidate.id), ['kept']);
  assert.deepEqual(weighted.map(candidate => candidate.id), ['kept']);
  assert.deepEqual(rrf[0].matchedLanes, ['dense']);
  assert.deepEqual(weighted[0].matchedLanes, ['dense']);
});

test('fusion rejects an ID collision with conflicting source content', () => {
  assert.throws(
    () => reciprocalRankFusion({
      dense: [{ id: 'same', score: 0.9, content: 'first' }],
      lexical: [{ id: 'same', score: 12, content: 'second' }],
    }),
    /conflicting content/
  );
  assert.throws(
    () => reciprocalRankFusion({
      dense: [{
        id: 'same', score: 0.9, content: 'same', source: 'a.pdf',
        metadata: { tenantId: 'tenant-a', corpusId: 'corpus-a', documentVersion: 'v1' },
      }],
      lexical: [{
        id: 'same', score: 12, content: 'same', source: 'a.pdf',
        metadata: { tenantId: 'tenant-b', corpusId: 'corpus-a', documentVersion: 'v1' },
      }],
    }),
    /conflicting content or provenance/
  );
});

test('hybrid hits fail closed when canonical and alias provenance conflict', async () => {
  for (const metadata of [
    { tenantId: 'tenant-a', tenant_id: 'tenant-b' },
    { corpusId: 'corpus-a', corpus_id: 'corpus-b' },
    { documentId: 'doc-a', document_id: 'doc-b' },
    { documentVersion: 'v1', document_version: 'v2' },
    { trustLevel: 'reviewed', trust_level: 'external' },
    { startOffset: 1, start_offset: 2 },
    { endOffset: 3, end_offset: 4 },
  ]) {
    await assert.rejects(
      milvusHybridSearch(createRequest(), {
        mode: 'active',
        port: {
          async probe() { return usableCapability(); },
          async search() {
            return [{ id: 'conflict', score: 0.9, content: 'conflict', metadata }];
          },
        },
      }),
      /contains conflicting/
    );
  }
});

test('hybrid index keeps generated context out of raw and sparse fields', () => {
  const document = createHybridIndexDocument({
    id: 'chunk_1',
    rawContent: '  original passage  ',
    contextualPreamble: 'generated background',
    sourceHash: 'sha256:abc',
    documentVersion: 'v1',
    contextualIdentity: 'contextual:v2:abc',
  });
  assert.equal(document.rawContent, '  original passage  ');
  assert.equal(document.sparseText, '  original passage  ');
  assert.equal(document.denseText, 'generated background\n\n  original passage  ');
});

test('manifest builder accepts only safe, distinct schema identifiers', () => {
  const manifest = createMilvusHybridCollectionManifest({
    collectionName: 'rag_shadow_v2',
    sourceCollectionName: 'rag_documents',
    corpusVersion: 'corpus-v1',
    embeddingModel: 'embed-v1',
    embeddingDimension: 768,
    rawTextField: 'content',
    denseVectorField: 'dense_embedding',
    sparseVectorField: 'sparse_embedding',
    bm25OutputField: 'bm25_sparse',
    fusionVersion: 'rrf-v1',
  });
  assert.equal(manifest.collectionName, 'rag_shadow_v2');
  assert.throws(
    () => createMilvusHybridCollectionManifest({ ...manifest, collectionName: 'bad;drop' }),
    /safe Milvus identifier/
  );
  assert.throws(
    () => createMilvusHybridCollectionManifest({ ...manifest, sparseVectorField: 'dense_embedding' }),
    /must be distinct/
  );
});

function createRequest() {
  return {
    collectionName: 'rag_shadow_v2',
    query: 'find ERR-42',
    denseEmbedding: [0.1, 0.2],
    topK: 5,
    scope: createRetrievalScope({ tenantId: 'tenant-a', corpusId: 'corpus-a' }),
  };
}

function usableCapability() {
  return {
    nativeHybridSearch: true,
    bm25Function: true,
    schemaCompatible: true,
    provider: 'fixture',
    serverVersion: 'fixture-only',
  };
}

function hit(id, score) {
  return { id, score, content: id.toUpperCase() };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
