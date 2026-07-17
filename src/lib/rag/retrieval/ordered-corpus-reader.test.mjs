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

const { readBoundedOrderedCorpus, OrderedCorpusScopeError } = await import('./ordered-corpus-reader.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');
const { createDefaultRetrievalPlan, createRoutedMilvusRetrievalPlan } = await import('./retrieval-plan.ts');
const { routeRetrievalQuery } = await import('./retrieval-router.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['reviewed'],
  enforceIsolation: true,
});

test('bounded reader proves completeness, canonical scope, and deterministic source order', async () => {
  const store = fakeStore([
    row('b-0', 'doc-b', 0, 1),
    row('a-1', 'doc-a', 1, 2),
    row('a-0', 'doc-a', 0, 2),
  ]);
  const snapshot = await readBoundedOrderedCorpus({
    store,
    scope,
    laneId: 'ordered-context-required',
  });

  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.reason, 'complete');
  assert.deepEqual(snapshot.evidence.map(item => item.id), ['a-0', 'a-1', 'b-0']);
  assert.deepEqual(snapshot.evidence.map(item => item.content), ['raw-a-0', 'raw-a-1', 'raw-b-0']);
  assert.equal(snapshot.evidence[0].tenantId, 'tenant-a');
  assert.equal(snapshot.evidence[0].metadata.tenantId, 'tenant-a');
  assert.equal(snapshot.inventory.documentCount, 2);
  assert.equal(snapshot.inventory.complete, true);
  assert.equal(store.queryCalls, 1);
  assert.equal(store.maxChunks, 256);
});

test('reader rejects chunk, character, document, and inventory overflow without evidence', async () => {
  const tooManyChunks = await readBoundedOrderedCorpus({
    store: fakeStore(Array.from({ length: 257 }, (_, index) => row('x-' + index, 'doc-x', index, 257))),
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(tooManyChunks.reason, 'chunk_limit_exceeded');
  assert.deepEqual(tooManyChunks.evidence, []);

  const tooManyDocuments = await readBoundedOrderedCorpus({
    store: fakeStore(Array.from({ length: 7 }, (_, index) => row('d-' + index, 'doc-' + index, 0, 1))),
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(tooManyDocuments.reason, 'document_limit_exceeded');

  const tooManyCharacters = await readBoundedOrderedCorpus({
    store: fakeStore([{
      ...row('large', 'doc-a', 0, 1),
      content: 'x'.repeat(20),
      metadata_json: JSON.stringify({ originalContent: 'x'.repeat(20) }),
    }]),
    scope,
    laneId: 'ordered-context-required',
    limits: { maxCharacters: 10 },
  });
  assert.equal(tooManyCharacters.reason, 'character_limit_exceeded');

  const missingChunk = await readBoundedOrderedCorpus({
    store: fakeStore([row('a-1', 'doc-a', 1, 2)]),
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(missingChunk.reason, 'invalid_chunk_inventory');

  const missingVersion = await readBoundedOrderedCorpus({
    store: fakeStore([{ ...row('a-0', 'doc-a', 0, 1), document_version: 'unversioned' }]),
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(missingVersion.reason, 'invalid_chunk_inventory');
});

test('direct scalar provenance is authoritative and scope violations fail closed', async () => {
  const forged = row('forged', 'doc-a', 0, 1);
  forged.metadata_json = JSON.stringify({
    tenantId: 'tenant-b',
    tenant_id: 'tenant-b',
    corpusId: 'corpus-b',
    corpus_id: 'corpus-b',
    trustLevel: 'trusted',
    trust_level: 'trusted',
    originalContent: 'raw-forged',
  });
  const accepted = await readBoundedOrderedCorpus({
    store: fakeStore([forged]),
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(accepted.evidence[0].tenantId, 'tenant-a');
  assert.equal(accepted.evidence[0].trustLevel, 'reviewed');

  await assert.rejects(
    readBoundedOrderedCorpus({
      store: fakeStore([{ ...row('foreign', 'doc-a', 0, 1), tenant_id: 'tenant-b' }]),
      scope,
      laneId: 'ordered-context-required',
    }),
    error => error instanceof OrderedCorpusScopeError
  );
});

test('schema absence and cancellation stop before corpus query', async () => {
  const unavailable = fakeStore([], false);
  const result = await readBoundedOrderedCorpus({
    store: unavailable,
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(result.reason, 'schema_unavailable');
  assert.equal(unavailable.queryCalls, 0);

  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const cancelledStore = fakeStore([]);
  await assert.rejects(
    readBoundedOrderedCorpus({
      store: cancelledStore,
      scope,
      laneId: 'ordered-context-required',
      signal: controller.signal,
    }),
    /cancelled/
  );
  assert.equal(cancelledStore.connectCalls, 0);
});

test('provider failures become unavailable snapshots while provider scope errors remain fail closed', async () => {
  const providerFailure = fakeStore([]);
  providerFailure.queryOrderedCorpusRows = async function () {
    this.queryCalls += 1;
    throw new Error('provider connection reset');
  };
  const unavailable = await readBoundedOrderedCorpus({
    store: providerFailure,
    scope,
    laneId: 'ordered-context-required',
  });
  assert.equal(unavailable.usable, false);
  assert.equal(unavailable.reason, 'provider_unavailable');
  assert.deepEqual(unavailable.evidence, []);
  assert.equal(providerFailure.queryCalls, 1);

  const scopeFailure = fakeStore([]);
  scopeFailure.queryOrderedCorpusRows = async function () {
    this.queryCalls += 1;
    throw new OrderedCorpusScopeError('scope mismatch');
  };
  await assert.rejects(
    readBoundedOrderedCorpus({
      store: scopeFailure,
      scope,
      laneId: 'ordered-context-required',
    }),
    error => error instanceof OrderedCorpusScopeError
  );
});
test('ordered provider deadline fences one stable key across changing scopes until work settles', async () => {
  let queryCalls = 0;
  let releaseTimedOutRead;
  const store = fakeStore([]);
  store.queryOrderedCorpusRows = async function () {
    queryCalls++;
    return new Promise(resolve => {
      releaseTimedOutRead = () => resolve([row('late-a', 'doc-a', 0, 1)]);
    });
  };
  const providerKey = 'milvus-ordered-context:shared-collection';
  const first = await readBoundedOrderedCorpus({
    store,
    scope,
    laneId: 'ordered-context-tenant-a',
    deadlineMs: 10,
    providerKey,
  });
  assert.equal(first.reason, 'provider_unavailable');
  assert.equal(queryCalls, 1);

  const otherScope = createRetrievalScope({
    tenantId: 'tenant-b',
    corpusId: 'corpus-b',
    allowedTrustLevels: ['reviewed'],
    enforceIsolation: true,
  });
  const blocked = await readBoundedOrderedCorpus({
    store,
    scope: otherScope,
    laneId: 'ordered-context-tenant-b-' + Date.now(),
    deadlineMs: 100,
    providerKey,
  });
  assert.equal(blocked.reason, 'provider_unavailable');
  assert.equal(queryCalls, 1);

  releaseTimedOutRead();
  await new Promise(resolve => setImmediate(resolve));
  store.queryOrderedCorpusRows = async function () {
    queryCalls++;
    return [];
  };
  const recovered = await readBoundedOrderedCorpus({
    store,
    scope: otherScope,
    laneId: 'ordered-context-tenant-b-recovered',
    deadlineMs: 100,
    providerKey,
  });
  assert.equal(recovered.reason, 'empty_corpus');
  assert.equal(queryCalls, 2);
});

test('ordered provider external abort stays cancellation and fences non-cooperative work', async () => {
  let releaseCancelledRead;
  const store = fakeStore([]);
  store.queryOrderedCorpusRows = async function () {
    this.queryCalls += 1;
    return new Promise(resolve => {
      releaseCancelledRead = () => resolve([]);
    });
  };
  const controller = new AbortController();
  const pending = readBoundedOrderedCorpus({
    store,
    scope,
    laneId: 'ordered-context-cancelled',
    deadlineMs: 1_000,
    providerKey: 'milvus-ordered-context:cancelled-collection',
    signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('private cancellation reason'));
  await assert.rejects(pending, error => error?.code === 'RAG_REQUEST_ABORTED');

  const blocked = await readBoundedOrderedCorpus({
    store,
    scope,
    laneId: 'ordered-context-after-cancel',
    deadlineMs: 100,
    providerKey: 'milvus-ordered-context:cancelled-collection',
  });
  assert.equal(blocked.reason, 'provider_unavailable');
  assert.equal(store.queryCalls, 1);

  releaseCancelledRead();
  await new Promise(resolve => setImmediate(resolve));
});

test('routed plan replaces only dense control lane and preserves graph lane', () => {
  const request = {
    question: '总结全部文档',
    topK: 3,
    similarityThreshold: 0,
    llmModel: 'test',
    embeddingModel: 'test',
    storageBackend: 'milvus',
    graphArtifactIdentity: {
      documentId: 'graph-a',
      documentVersion: 'v1',
      trustLevel: 'reviewed',
    },
  };
  const base = createDefaultRetrievalPlan(request, 'mirofish-research', new Date(0));
  const decision = routeRetrievalQuery({
    query: request.question,
    capabilities: { hybridActive: false, orderedContextActive: true },
    corpus: { documentCount: 2, characterCount: 100, complete: true },
  });
  const routed = createRoutedMilvusRetrievalPlan(base, decision);
  assert.deepEqual(routed.lanes.map(lane => lane.type), ['ordered-context', 'graph-entity']);
  assert.equal(routed.lanes[0].required, true);
});

test('active and shadow hybrid plans prepend an optional lane and preserve required dense rollback', () => {
  const request = createPlanRequest();
  const base = createDefaultRetrievalPlan(request, 'mirofish-research', new Date(0));
  const decision = routeRetrievalQuery({
    query: request.question,
    capabilities: { hybridActive: true, orderedContextActive: true },
    corpus: { documentCount: 2, characterCount: 100, complete: true },
  });

  for (const mode of ['active', 'shadow']) {
    const routed = createRoutedMilvusRetrievalPlan(base, decision, {
      hybridMode: mode,
      hybridUsable: true,
    });
    assert.equal(routed.id, base.id + ':hybrid-' + mode);
    assert.deepEqual(routed.lanes.map(lane => lane.type), ['sparse-bm25', 'dense-vector']);
    assert.equal(routed.lanes[0].id, mode === 'active' ? 'hybrid-primary' : 'hybrid-shadow');
    assert.equal(routed.lanes[0].required, false);
    assert.equal(routed.lanes[0].parameters.mode, mode);
    assert.equal(routed.lanes[1].required, true);
    assert.equal(routed.lanes[1], base.lanes[0]);
  }

  assert.deepEqual(base.lanes.map(lane => lane.type), ['dense-vector']);
});

test('hybrid routing stays on the dense plan when capability is unusable and rejects plans without rollback', () => {
  const base = createDefaultRetrievalPlan(createPlanRequest(), 'mirofish-research', new Date(0));
  const decision = routeRetrievalQuery({
    query: base.query,
    capabilities: { hybridActive: true, orderedContextActive: true },
    corpus: { documentCount: 2, characterCount: 100, complete: true },
  });

  assert.equal(createRoutedMilvusRetrievalPlan(base, decision, {
    hybridMode: 'active',
    hybridUsable: false,
  }), base);

  assert.throws(
    () => createRoutedMilvusRetrievalPlan({ ...base, lanes: [] }, decision, {
      hybridMode: 'active',
      hybridUsable: true,
    }),
    /dense rollback lane/
  );
});

test('ordered context routing takes precedence over active hybrid options', () => {
  const request = createPlanRequest('总结全部文档');
  const base = createDefaultRetrievalPlan(request, 'mirofish-research', new Date(0));
  const decision = routeRetrievalQuery({
    query: request.question,
    capabilities: { hybridActive: true, orderedContextActive: true },
    corpus: { documentCount: 2, characterCount: 100, complete: true },
  });
  const routed = createRoutedMilvusRetrievalPlan(base, decision, {
    hybridMode: 'active',
    hybridUsable: true,
  });

  assert.equal(routed.id, base.id + ':ordered-context');
  assert.deepEqual(routed.lanes.map(lane => lane.type), ['ordered-context', 'graph-entity']);
  assert.equal(routed.lanes.some(lane => lane.type === 'sparse-bm25'), false);
  assert.equal(routed.lanes[0].required, true);
});

test('PDF visual plans append an optional lane after every text rollback route', () => {
  const identifier = createPlanRequest('查看错误码 ERR-42 的图表');
  const identifierBase = createDefaultRetrievalPlan(
    identifier,
    'mirofish-research',
    new Date(0)
  );
  const hybridDecision = routeRetrievalQuery({
    query: identifier.question,
    capabilities: { hybridActive: true, orderedContextActive: false },
  });
  const hybrid = createRoutedMilvusRetrievalPlan(identifierBase, hybridDecision, {
    hybridMode: 'active',
    hybridUsable: true,
    pdfVisualMode: 'active',
    pdfVisualUsable: true,
    pdfVisualIntent: true,
  });
  assert.deepEqual(
    hybrid.lanes.map(lane => lane.type),
    ['sparse-bm25', 'dense-vector', 'visual-page']
  );
  assert.equal(hybrid.lanes.at(-1).id, 'pdf-visual-active');
  assert.equal(hybrid.lanes.at(-1).required, false);

  const global = createPlanRequest('总结整篇文档中的图表');
  const globalBase = createDefaultRetrievalPlan(global, 'mirofish-research', new Date(0));
  const orderedDecision = routeRetrievalQuery({
    query: global.question,
    capabilities: { hybridActive: false, orderedContextActive: true },
    corpus: { documentCount: 2, characterCount: 100, complete: true },
  });
  const ordered = createRoutedMilvusRetrievalPlan(globalBase, orderedDecision, {
    pdfVisualMode: 'shadow',
    pdfVisualUsable: true,
    pdfVisualIntent: true,
  });
  assert.deepEqual(
    ordered.lanes.map(lane => lane.type),
    ['ordered-context', 'graph-entity', 'visual-page']
  );
  assert.equal(ordered.lanes.at(-1).id, 'pdf-visual-shadow');
});

test('PDF visual planning stays inert without intent/capability and requires text rollback', () => {
  const base = createDefaultRetrievalPlan(createPlanRequest(), 'mirofish-research', new Date(0));
  const decision = routeRetrievalQuery({
    query: base.query,
    capabilities: { hybridActive: false, orderedContextActive: false },
  });

  assert.equal(createRoutedMilvusRetrievalPlan(base, decision, {
    pdfVisualMode: 'active',
    pdfVisualUsable: false,
    pdfVisualIntent: true,
  }), base);
  assert.equal(createRoutedMilvusRetrievalPlan(base, decision, {
    pdfVisualMode: 'active',
    pdfVisualUsable: true,
    pdfVisualIntent: false,
  }), base);
  assert.throws(
    () => createRoutedMilvusRetrievalPlan({ ...base, lanes: [] }, decision, {
      pdfVisualMode: 'active',
      pdfVisualUsable: true,
      pdfVisualIntent: true,
    }),
    /text retrieval rollback lane/
  );
});

function createPlanRequest(question = '查找标识符 RAG-HYBRID-42') {
  return {
    question,
    topK: 3,
    similarityThreshold: 0,
    llmModel: 'test',
    embeddingModel: 'test',
    storageBackend: 'milvus',
    graphArtifactIdentity: {
      documentId: 'graph-a',
      documentVersion: 'v1',
      trustLevel: 'reviewed',
    },
  };
}

function fakeStore(rows, schema = true) {
  return {
    rows,
    schema,
    connectCalls: 0,
    queryCalls: 0,
    maxChunks: undefined,
    async connect() { this.connectCalls += 1; },
    async initializeCollection() {},
    hasOrderedContextSchema() { return this.schema; },
    async queryOrderedCorpusRows(_scope, maxChunks) {
      this.queryCalls += 1;
      this.maxChunks = maxChunks;
      return structuredClone(this.rows);
    },
  };
}

function row(id, documentId, chunkIndex, totalChunks) {
  return {
    id,
    content: 'contextual-' + id,
    source: documentId + '.md',
    metadata_json: JSON.stringify({
      originalContent: 'raw-' + id,
      page: chunkIndex + 1,
      startOffset: chunkIndex * 10,
      endOffset: chunkIndex * 10 + 8,
      tenantId: 'forged-tenant',
    }),
    tenant_id: 'tenant-a',
    corpus_id: 'corpus-a',
    document_id: documentId,
    trust_level: 'reviewed',
    document_version: 'sha256:' + documentId,
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
