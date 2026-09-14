import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
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

const enabled = process.env.RAG_AGENTIC_MILVUS_INTEGRATION === '1';
const COLLECTION_PREFIX = 'rag_agentic_canary_';
const scope = {
  tenantId: 'canary-tenant', corpusId: 'canary-corpus',
  allowedTrustLevels: ['reviewed'], enforceIsolation: true,
};
const vectors = { initial: [1, 0, 0, 0], followup: [0, 1, 0, 0] };
const question = '当前项目的验收日期是什么？';

// This opt-in canary uses a real local Milvus server and a fake tool-calling
// model. Fixed vectors make filtering and evidence provenance independently
// testable without conflating them with embedding or model quality.
test('real Milvus scope filters and bounded createAgent preserve final evidence citations', {
  skip: !enabled && 'Set RAG_AGENTIC_MILVUS_INTEGRATION=1 to use local Milvus at localhost:19530.',
  timeout: 90_000,
}, async t => {
  const [
    { MilvusClient, DataType },
    { buildScopedMilvusFilter },
    { adaptMilvusSearchResultsToEvidence },
    { RagLaneExecutor },
    { createDefaultRetrievalPlan },
    { createScopedFollowupRetriever },
    { composeEvidenceContextV2 },
    { invokeScopedRetrievalAgent },
    { createScopedFixtureModel },
  ] = await Promise.all([
    import('@zilliz/milvus2-sdk-node'),
    import('../../security/retrieval-scope.ts'),
    import('./legacy-evidence-adapter.ts'),
    import('./lane-executor.ts'),
    import('./retrieval-plan.ts'),
    import('./scoped-followup-retrieval.ts'),
    import('../core/context-composer.ts'),
    import('../agents/scoped-retrieval-agent.ts'),
    import('../eval/scoped-agent-fixture-provider.ts'),
  ]);
  // Deliberately fixed localhost: an ambient deployment URL must never redirect
  // this synthetic write test to a shared or production Milvus instance.
  const client = new MilvusClient({ address: 'localhost:19530', timeout: 10_000 });
  const collectionName = COLLECTION_PREFIX + randomUUID().replaceAll('-', '');
  const fixtureRows = [
    row('initial-reference', '项目当前资料需要关联检索：CANARY-ACCEPTANCE', vectors.initial),
    row('followup-fact', 'CANARY-ACCEPTANCE 的验收日期为 2030-06-18。', vectors.followup),
    row('other-tenant', 'FORBIDDEN_TENANT_CONTENT', vectors.initial, { tenant_id: 'other-tenant' }),
    row('other-corpus', 'FORBIDDEN_CORPUS_CONTENT', vectors.followup, { corpus_id: 'other-corpus' }),
    row('external-trust', 'FORBIDDEN_EXTERNAL_CONTENT', vectors.initial, { trust_level: 'external' }),
    row('quarantined', 'FORBIDDEN_QUARANTINED_CONTENT', vectors.followup, { trust_level: 'quarantined' }),
  ];
  let created = false;
  let retrievalCallCount = 0;
  let searchRequestCount = 0;
  let scopeFilterChecksPassed = false;
  let report;
  try {
    const existing = await client.hasCollection({ collection_name: collectionName });
    assertStatus(existing, 'check isolated collection does not exist');
    assert.equal(existing.value, false);
    assertStatus(await client.createCollection({
      collection_name: collectionName,
      enable_dynamic_field: false,
      fields: [
        { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 128 },
        { name: 'content', data_type: DataType.VarChar, max_length: 4096 },
        { name: 'embedding', data_type: DataType.FloatVector, dim: 4 },
        ...['tenant_id', 'corpus_id', 'trust_level', 'document_id', 'document_version']
          .map(name => ({ name, data_type: DataType.VarChar, max_length: 128 })),
      ],
    }), 'create isolated collection');
    created = true;
    assertStatus(await client.insert({ collection_name: collectionName, data: fixtureRows }), 'insert synthetic evidence');
    assertStatus(await client.createIndex({
      collection_name: collectionName, field_name: 'embedding',
      index_name: 'canary_vector_index', index_type: 'FLAT', metric_type: 'IP',
    }), 'create exact vector index');
    assertStatus(await client.loadCollectionSync({ collection_name: collectionName }), 'load isolated collection');

    async function search(vector, activeScope, limit = fixtureRows.length) {
      const filter = activeScope ? buildScopedMilvusFilter(activeScope) : {};
      searchRequestCount++;
      const response = await client.search({
        collection_name: collectionName, data: [vector], anns_field: 'embedding',
        limit, metric_type: 'IP', consistency_level: 'Strong',
        output_fields: ['id', 'content', 'tenant_id', 'corpus_id', 'trust_level', 'document_id', 'document_version'],
        ...filter,
      });
      assertStatus(response, 'search synthetic evidence');
      const hits = Array.isArray(response.results[0]) ? response.results[0] : response.results;
      return hits.map(hit => ({
        id: String(hit.id), content: hit.content, score: hit.score,
        metadata: Object.fromEntries(
          ['tenant_id', 'corpus_id', 'trust_level', 'document_id', 'document_version']
            .map(key => [key, hit[key]])
        ),
      }));
    }

    await t.test('real database filters exclude wrong tenant, corpus, trust and quarantine', async () => {
      const unfiltered = await search(vectors.initial);
      assert.deepEqual(new Set(unfiltered.map(item => item.id)), new Set(fixtureRows.map(item => item.id)));
      for (const vector of Object.values(vectors)) {
        const scoped = await search(vector, scope);
        assert.deepEqual(new Set(scoped.map(item => item.id)), new Set(['initial-reference', 'followup-fact']));
        assert.ok(scoped.every(item => item.metadata.tenant_id === scope.tenantId
          && item.metadata.corpus_id === scope.corpusId && item.metadata.trust_level === 'reviewed'));
      }
      scopeFilterChecksPassed = true;
    });

    await t.test('initial lane and agent follow-up use the same server scope and append stable citations', async () => {
      const request = {
        question, topK: 1, similarityThreshold: 0, storageBackend: 'milvus',
        llmModel: 'fixture-fake-tool-calling', embeddingModel: 'fixture-fixed-vector',
        retrievalScope: structuredClone(scope),
      };
      const retrieve = async ({ query, laneId, scope: activeScope, signal }) => {
        signal.throwIfAborted();
        assert.deepEqual(activeScope, scope);
        retrievalCallCount++;
        const vector = query === question ? vectors.initial
          : query === 'CANARY-ACCEPTANCE' ? vectors.followup : null;
        assert.ok(vector, 'the model must search the visible cross-reference');
        const results = await search(vector, activeScope, 1);
        signal.throwIfAborted();
        return adaptMilvusSearchResultsToEvidence(results, { laneId, scope: activeScope });
      };
      const plan = createDefaultRetrievalPlan(request, 'agentic');
      plan.lanes = [{
        id: 'canary-initial-dense', type: 'dense-vector', required: true,
        description: 'Real Milvus scoped synthetic evidence.', executionBudget: { maxDurationMs: 5_000 },
      }];
      const signal = AbortSignal.timeout(20_000);
      const initial = await new RagLaneExecutor([{
        type: 'dense-vector', retriever: 'milvus-dense-v1',
        execute: async ({ lane, signal: laneSignal }) => ({
          evidence: await retrieve({ query: question, laneId: lane.id, scope, signal: laneSignal }),
        }),
      }]).execute({
        request, plan, signal, budget: { maxLanes: 1, maxEvidence: 1, maxDurationMs: 5_000 },
      });
      assert.deepEqual(initial.evidence.map(item => item.id), ['initial-reference']);
      const originalPack = composeEvidenceContextV2(initial.evidence, { scope, maxTokens: 4000 });
      const followupExecutions = [];
      const searchFollowup = createScopedFollowupRetriever({
        request, retrieve,
        onExecution: (execution, followupPlan) => followupExecutions.push({ execution, plan: followupPlan }),
      });
      // Mutation after construction must not redirect the captured search scope.
      request.retrievalScope.tenantId = 'other-tenant';
      const result = await invokeScopedRetrievalAgent({
        model: createScopedFixtureModel(), question, contextPack: originalPack, scope,
        traceId: 'milvus-canary-' + randomUUID(), signal,
        retrieval: { decisionMode: 'structured', search: searchFollowup, maxSearches: 2, maxContextTokens: 4000, maxEvidence: 4 },
      });
      assert.equal(retrievalCallCount, 2);
      assert.equal(result.searchCallCount, 1);
      assert.equal(result.toolCallCount, 2);
      assert.equal(result.diagnostics.modelResponseCount, 3);
      assert.equal(result.diagnostics.usage.measurement, 'unavailable');
      assert.deepEqual(result.servedEvidenceIds, ['initial-reference', 'followup-fact']);
      assert.deepEqual(result.contextPack.includedEvidenceIds, result.servedEvidenceIds);
      assert.ok(result.contextPack.context.startsWith(originalPack.context), 'initial evidence numbering/content remain stable');
      assert.match(result.answer, /2030-06-18/u);
      assert.match(result.answer, /\[2\]/u);
      assert.doesNotMatch(JSON.stringify(result), /FORBIDDEN_/u);
      assert.equal(result.diagnostics.citations.status, 'valid');
      assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, ['initial-reference', 'followup-fact']);
      assert.equal(followupExecutions.length, 1);
      assert.equal(followupExecutions[0].execution.laneExecutions[0].status, 'completed');
      assert.equal(followupExecutions[0].plan.lanes[0].id, 'agentic-followup-1');
      assert.equal(result.contextPack.includedEvidence[1].laneId, 'agentic-followup-1');
      report = {
        schemaVersion: 'scoped-agent-milvus-canary-v1', completedAt: new Date().toISOString(),
        backend: 'real-local-milvus', model: 'fake-tool-calling', embedding: 'fixed-four-dimensional-vectors',
        realModelMeasured: false, productionQualityMeasured: false,
        scopeFilterVerified: ['tenant', 'corpus', 'allowed-trust', 'quarantined'],
        syntheticRowCount: fixtureRows.length, retrievalCallCount,
        toolCallCount: result.toolCallCount, searchCallCount: result.searchCallCount,
        modelResponseCount: result.diagnostics.modelResponseCount,
        servedEvidenceIds: result.servedEvidenceIds, citationValidation: 'reference-only',
        citationStatus: result.diagnostics.citations.status,
      };
    });
  } finally {
    try {
      if (created) {
        assert.match(collectionName, /^rag_agentic_canary_[a-f0-9]{32}$/u);
        assert.equal(collectionName.slice(0, COLLECTION_PREFIX.length), COLLECTION_PREFIX);
        assertStatus(await client.dropCollection({ collection_name: collectionName }), 'drop only this isolated collection');
        const remaining = await client.hasCollection({ collection_name: collectionName });
        assertStatus(remaining, 'verify isolated collection cleanup');
        assert.equal(remaining.value, false);
      }
    } finally {
      await client.closeConnection();
    }
  }
  if (report && scopeFilterChecksPassed) {
    report.searchRequestCount = searchRequestCount;
    report.collectionCleanedUp = true;
    const reportDirectory = resolve('.codex-tmp/rag-eval/scoped-agent');
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = resolve(reportDirectory, 'milvus-canary.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    t.diagnostic(JSON.stringify(report));
  }
});

function row(id, content, embedding, overrides = {}) {
  return {
    id, content, embedding, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    trust_level: 'reviewed', document_id: 'doc-' + id, document_version: 'fixture-v1',
    ...overrides,
  };
}

function assertStatus(response, operation) {
  const status = response.status ?? response;
  assert.equal(status.error_code, 'Success', operation + ': ' + (status.reason ?? 'unknown Milvus status'));
}
