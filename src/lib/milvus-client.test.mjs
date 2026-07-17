import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  ConsistencyLevelEnum,
  DataType,
  FunctionType,
} from '@zilliz/milvus2-sdk-node';

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

const {
  MILVUS_HYBRID_SCHEMA_VERSION,
  MilvusHybridEvidenceIntegrityError,
  MilvusVectorStore,
  buildMilvusSearchParams,
  createMilvusHybridRuntimeManifest,
  getScopedSearchFields,
  normalizeMilvusConsistencyLevel,
  resolveMilvusSearchOptions,
} = await import('./milvus-client.ts');

test('buildMilvusSearchParams keeps index defaults and allows overrides', () => {
  assert.deepEqual(buildMilvusSearchParams('IVF_FLAT'), { nprobe: 16 });
  assert.deepEqual(buildMilvusSearchParams('HNSW', { ef: 96, radius: 0.3 }), { ef: 96, radius: 0.3 });
  assert.deepEqual(buildMilvusSearchParams('AUTOINDEX', { nprobe: undefined, hint: 'iterative_filter' }), {
    hint: 'iterative_filter',
  });
});

test('normalizeMilvusConsistencyLevel uses SDK enum values', () => {
  assert.equal(normalizeMilvusConsistencyLevel('Strong'), ConsistencyLevelEnum.Strong);
  assert.equal(normalizeMilvusConsistencyLevel('Bounded'), ConsistencyLevelEnum.Bounded);
  assert.equal(normalizeMilvusConsistencyLevel('Session'), ConsistencyLevelEnum.Session);
  assert.equal(normalizeMilvusConsistencyLevel('Eventually'), ConsistencyLevelEnum.Eventually);
});

test('resolveMilvusSearchOptions preserves legacy threshold and filter signature', () => {
  const resolved = resolveMilvusSearchOptions(createConfig(), 0.42, 'source == "guide"');

  assert.equal(resolved.threshold, 0.42);
  assert.equal(resolved.filter, 'source == "guide"');
  assert.equal(resolved.consistencyLevel, ConsistencyLevelEnum.Bounded);
  assert.deepEqual(resolved.searchParams, { ef: 80 });
});

test('resolveMilvusSearchOptions supports v2.6 search options', () => {
  const resolved = resolveMilvusSearchOptions(createConfig(), {
    threshold: 0.2,
    filter: 'source in {sources}',
    exprValues: { sources: ['a.md', 'b.md'] },
    consistencyLevel: 'Eventually',
    ignoreGrowing: true,
    groupByField: 'source',
    groupSize: 2,
    strictGroupSize: true,
    searchParams: { ef: 128, radius: 0.1 },
  });

  assert.equal(resolved.threshold, 0.2);
  assert.deepEqual(resolved.exprValues, { sources: ['a.md', 'b.md'] });
  assert.equal(resolved.consistencyLevel, ConsistencyLevelEnum.Eventually);
  assert.equal(resolved.ignoreGrowing, true);
  assert.equal(resolved.groupByField, 'source');
  assert.equal(resolved.groupSize, 2);
  assert.equal(resolved.strictGroupSize, true);
  assert.deepEqual(resolved.searchParams, { ef: 128, radius: 0.1 });
});

test('resolveMilvusSearchOptions keeps slim output fields configurable', () => {
  const resolved = resolveMilvusSearchOptions(
    { ...createConfig(), searchOutputFields: ['id', 'source'] },
    { outputFields: ['id'] }
  );

  assert.deepEqual(resolved.outputFields, ['id']);
});

test('tenant-scoped searches always request evidence provenance fields', () => {
  assert.deepEqual(
    getScopedSearchFields(['id', 'content', 'metadata_json']),
    [
      'id',
      'content',
      'metadata_json',
      'tenant_id',
      'corpus_id',
      'document_id',
      'trust_level',
    ]
  );
});

test('tenant isolation rejects unscoped search, insertion, and global mutations before I/O', async () => {
  const previousMode = process.env.RAG_ACCESS_MODE;
  process.env.RAG_ACCESS_MODE = 'supabase';
  try {
    const store = new MilvusVectorStore({ collectionName: 'security-test' });
    await assert.rejects(() => store.search([1], 1), /server-derived scope/);
    await assert.rejects(
      () => store.insertDocuments([
        { id: 'doc-1', content: 'x', embedding: [1], metadata: {} },
      ]),
      /server-derived document scope/
    );
    await assert.rejects(() => store.initializeCollection(true), /Automatic collection recreation/);
    await assert.rejects(() => store.recreateCollection(), /Global collection recreation/);
    await assert.rejects(() => store.deleteDocuments(['doc-1']), /Global document deletion/);
    await assert.rejects(() => store.clearCollection(), /Global collection clearing/);
  } finally {
    if (previousMode === undefined) delete process.env.RAG_ACCESS_MODE;
    else process.env.RAG_ACCESS_MODE = previousMode;
  }
});

test('scoped compensation deletes exact IDs from dense and hybrid collections', async () => {
  const store = createHybridTestStore();
  store.supportsTenantIsolation = true;
  const deletes = [];
  const flushes = [];
  attachNativeClient(store, {
    async hasCollection(input) {
      assert.equal(input.collection_name, 'rag_documents_hybrid_v1');
      return { value: true };
    },
    async delete(input) {
      deletes.push(structuredClone(input));
      return { status: { error_code: 'Success' } };
    },
    async flushSync(input) {
      flushes.push(structuredClone(input));
    },
  });
  const scope = createHybridSearchRequest().scope;
  const ids = ['chunk-a', 'chunk-b'];

  await store.deleteScopedDocuments(ids, scope);
  await store.deleteScopedHybridDocuments(createHybridManifest(), ids, scope);

  assert.deepEqual(deletes.map(item => item.collection_name), [
    'rag_documents',
    'rag_documents_hybrid_v1',
  ]);
  for (const request of deletes) {
    assert.equal(request.filter, [
      'tenant_id == {tenantId}',
      'corpus_id == {corpusId}',
      'trust_level in {allowedTrustLevels}',
      'id in {documentIds}',
    ].join(' && '));
    assert.deepEqual(request.exprValues, {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['trusted', 'reviewed'],
      documentIds: ids,
    });
  }
  assert.deepEqual(flushes, [
    { collection_names: ['rag_documents'] },
    { collection_names: ['rag_documents_hybrid_v1'] },
  ]);
});

test('scoped compensation rejects non-isolated scopes and invalid IDs before mutation I/O', async () => {
  const store = createHybridTestStore();
  store.supportsTenantIsolation = true;
  let deletes = 0;
  attachNativeClient(store, {
    async delete() {
      deletes += 1;
      return { status: { error_code: 'Success' } };
    },
  });

  await assert.rejects(
    () => store.deleteScopedDocuments(['chunk-a'], {
      ...createHybridSearchRequest().scope,
      enforceIsolation: false,
    }),
    /requires enforced tenant isolation/
  );
  await assert.rejects(
    () => store.deleteScopedDocuments(['chunk-a', 'chunk-a'], createHybridSearchRequest().scope),
    /requires unique document IDs/
  );
  assert.equal(deletes, 0);
});

test('hybrid runtime manifest uses isolated defaults and validates server configuration', () => {
  const manifest = createMilvusHybridRuntimeManifest({
    sourceCollectionName: 'rag_documents',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 768,
    env: {},
  });

  assert.deepEqual(manifest, {
    version: MILVUS_HYBRID_SCHEMA_VERSION,
    collectionName: 'rag_documents_hybrid_v1',
    sourceCollectionName: 'rag_documents',
    corpusVersion: 'live-corpus-v1',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 768,
    rawTextField: 'content',
    denseVectorField: 'embedding',
    bm25OutputField: 'bm25_sparse',
    fusion: 'rrf',
  });

  assert.deepEqual(
    createMilvusHybridRuntimeManifest({
      sourceCollectionName: 'rag_documents',
      embeddingModel: 'embedding-v2',
      embeddingDimension: 1536,
      env: {
        MILVUS_HYBRID_COLLECTION_NAME: 'rag_hybrid_shadow',
        MILVUS_HYBRID_FUSION: 'WEIGHTED',
        RAG_CORPUS_VERSION: 'corpus-2026-07',
      },
    }),
    {
      version: MILVUS_HYBRID_SCHEMA_VERSION,
      collectionName: 'rag_hybrid_shadow',
      sourceCollectionName: 'rag_documents',
      corpusVersion: 'corpus-2026-07',
      embeddingModel: 'embedding-v2',
      embeddingDimension: 1536,
      rawTextField: 'content',
      denseVectorField: 'embedding',
      bm25OutputField: 'bm25_sparse',
      fusion: 'weighted',
    }
  );

  assert.throws(
    () => createMilvusHybridRuntimeManifest({
      sourceCollectionName: 'rag-documents',
      embeddingModel: 'embedding-v2',
      embeddingDimension: 768,
      env: {},
    }),
    /safe identifier/
  );
  assert.throws(
    () => createMilvusHybridRuntimeManifest({
      sourceCollectionName: 'rag_documents',
      embeddingModel: 'embedding-v2',
      embeddingDimension: 768,
      env: { MILVUS_HYBRID_COLLECTION_NAME: 'shadow;drop' },
    }),
    /safe identifier/
  );
  assert.throws(
    () => createMilvusHybridRuntimeManifest({
      sourceCollectionName: 'rag_documents',
      embeddingModel: ' ',
      embeddingDimension: 768,
      env: {},
    }),
    /embeddingModel is required/
  );
  assert.throws(
    () => createMilvusHybridRuntimeManifest({
      sourceCollectionName: 'rag_documents',
      embeddingModel: 'embedding-v2',
      embeddingDimension: 0,
      env: {},
    }),
    /positive integer/
  );
  assert.throws(
    () => createMilvusHybridRuntimeManifest({
      sourceCollectionName: 'rag_documents',
      embeddingModel: 'embedding-v2',
      embeddingDimension: 768,
      env: { MILVUS_HYBRID_FUSION: 'client-side' },
    }),
    /must be rrf or weighted/
  );
});

test('tenant isolation rejects hybrid dual-write before any Milvus I/O', async () => {
  const previousMode = process.env.RAG_ACCESS_MODE;
  process.env.RAG_ACCESS_MODE = 'supabase';
  try {
    const store = new MilvusVectorStore({
      ...createConfig(),
      collectionName: 'security_test',
      embeddingDimension: 2,
    });
    const manifest = createHybridManifest({
      sourceCollectionName: 'security_test',
      embeddingDimension: 2,
    });
    let ioCalls = 0;
    attachNativeClient(store, {
      async hasCollection() {
        ioCalls += 1;
        return { value: true };
      },
    });

    await assert.rejects(
      () => store.insertHybridDocuments(manifest, [{
        id: 'unscoped',
        content: 'raw passage',
        embedding: [0.1, 0.2],
        metadata: {},
      }]),
      /authenticated server-derived scope/
    );
    assert.equal(ioCalls, 0);
  } finally {
    if (previousMode === undefined) delete process.env.RAG_ACCESS_MODE;
    else process.env.RAG_ACCESS_MODE = previousMode;
  }
});

test('native hybrid capability probe requires the exact BM25 shadow schema', async () => {
  const store = new MilvusVectorStore({
    ...createConfig(),
    collectionName: 'rag_documents',
    embeddingDimension: 2,
  });
  const calls = [];
  attachNativeClient(store, {
    async hasCollection(input) {
      calls.push(['hasCollection', input]);
      return { value: true };
    },
    async describeCollection(input) {
      calls.push(['describeCollection', input]);
      return createCompatibleHybridDescription(2);
    },
    async getVersion() {
      calls.push(['getVersion']);
      return { version: '2.6.2' };
    },
    async hybridSearch() {
      throw new Error('probe must not execute a search');
    },
  });

  const [capability, concurrentCapability] = await Promise.all([
    store.probeHybridCollection({
      collectionName: 'rag_documents_hybrid_v1',
    }),
    store.probeHybridCollection({
      collectionName: 'rag_documents_hybrid_v1',
    }),
  ]);
  const cachedCapability = await store.probeHybridCollection({
    collectionName: 'rag_documents_hybrid_v1',
  });

  assert.equal(capability.nativeHybridSearch, true);
  assert.equal(capability.bm25Function, true);
  assert.equal(capability.schemaCompatible, true);
  assert.equal(capability.serverVersion, '2.6.2');
  assert.equal(capability.reason, undefined);
  assert.deepEqual(concurrentCapability, capability);
  assert.deepEqual(cachedCapability, capability);
  assert.deepEqual(calls, [
    ['hasCollection', { collection_name: 'rag_documents_hybrid_v1' }],
    ['describeCollection', { collection_name: 'rag_documents_hybrid_v1' }],
    ['getVersion'],
  ]);
});

test('native hybrid search shares server scope and retains only BM25 members', async () => {
  const store = new MilvusVectorStore({
    ...createConfig(),
    collectionName: 'rag_documents',
    embeddingDimension: 2,
  });
  const manifest = createHybridManifest({ embeddingDimension: 2 });
  let hybridRequest;
  let lexicalRequest;
  attachNativeClient(store, {
    async hybridSearch(input) {
      hybridRequest = input;
      return {
        status: { error_code: 'Success' },
        results: [[
          createNativeHybridHit({ id: 'lexical-member', score: 0.71 }),
          createNativeHybridHit({ id: 'dense-only', score: 0.99 }),
        ]],
      };
    },
    async search(input) {
      lexicalRequest = input;
      return {
        status: { error_code: 'Success' },
        results: [[{ id: 'lexical-member', score: 1.1 }]],
      };
    },
  });

  const hits = await store.searchHybridCollection(
    createHybridSearchRequest(),
    manifest
  );

  const expectedFilter = [
    'tenant_id == {tenantId}',
    'corpus_id == {corpusId}',
    'trust_level in {allowedTrustLevels}',
  ].join(' && ');
  const expectedExprValues = {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed'],
  };
  assert.equal(hybridRequest.collection_name, manifest.collectionName);
  assert.equal(hybridRequest.data.length, 2);
  assert.equal(hybridRequest.data[0].anns_field, 'embedding');
  assert.equal(hybridRequest.data[1].anns_field, 'bm25_sparse');
  assert.deepEqual(hybridRequest.data[0].data, [0.1, 0.2]);
  assert.equal(hybridRequest.data[1].data, 'invoice 12345');
  assert.equal(hybridRequest.data[0].expr, expectedFilter);
  assert.equal(hybridRequest.data[1].expr, expectedFilter);
  assert.deepEqual(hybridRequest.data[0].exprValues, expectedExprValues);
  assert.deepEqual(hybridRequest.data[1].exprValues, expectedExprValues);
  assert.equal(lexicalRequest.filter, expectedFilter);
  assert.deepEqual(lexicalRequest.exprValues, expectedExprValues);
  assert.equal(lexicalRequest.anns_field, 'bm25_sparse');
  assert.deepEqual(lexicalRequest.data, ['invoice 12345']);
  assert.equal(lexicalRequest.limit, 6);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'lexical-member');
  assert.equal(hits[0].score, 0.71);
  assert.equal(hits[0].metadata.tenantId, 'tenant-a');
  assert.equal(hits[0].metadata.corpusId, 'corpus-a');
  assert.equal(hits[0].metadata.documentId, 'document-a');
  assert.equal(hits[0].metadata.documentVersion, 'version-a');
  assert.equal(hits[0].metadata.trustLevel, 'trusted');
  assert.equal(hits[0].metadata.lexicalMatch, true);
  assert.equal(hits[0].metadata.startOffset, 10);
  assert.equal(hits[0].metadata.endOffset, 42);
});

test('native hybrid search stops at the failed or aborted RPC stage', async () => {
  const manifest = createHybridManifest({ embeddingDimension: 2 });

  const hybridFailureStore = createHybridTestStore();
  const hybridFailureCalls = { hybrid: 0, lexical: 0 };
  attachNativeClient(hybridFailureStore, {
    async hybridSearch() {
      hybridFailureCalls.hybrid += 1;
      return {
        status: { error_code: 'UnexpectedError', reason: 'hybrid failed' },
        results: [],
      };
    },
    async search() {
      hybridFailureCalls.lexical += 1;
      throw new Error('lexical search must not run after hybrid failure');
    },
  });
  await assert.rejects(
    hybridFailureStore.searchHybridCollection(
      createHybridSearchRequest(),
      manifest
    ),
    error => error?.code === 'MILVUS_HYBRID_PROVIDER_UNAVAILABLE'
  );
  assert.deepEqual(hybridFailureCalls, { hybrid: 1, lexical: 0 });

  const lexicalFailureStore = createHybridTestStore();
  const lexicalFailureCalls = { hybrid: 0, lexical: 0 };
  attachNativeClient(lexicalFailureStore, {
    async hybridSearch() {
      lexicalFailureCalls.hybrid += 1;
      return {
        status: { error_code: 'Success' },
        results: [[createNativeHybridHit({ id: 'candidate' })]],
      };
    },
    async search() {
      lexicalFailureCalls.lexical += 1;
      return {
        status: { error_code: 'UnexpectedError', reason: 'lexical failed' },
        results: [],
      };
    },
  });
  await assert.rejects(
    lexicalFailureStore.searchHybridCollection(
      createHybridSearchRequest(),
      manifest
    ),
    error => error?.code === 'MILVUS_HYBRID_PROVIDER_UNAVAILABLE'
  );
  assert.deepEqual(lexicalFailureCalls, { hybrid: 1, lexical: 1 });

  const abortedStore = createHybridTestStore();
  const controller = new AbortController();
  const abortedCalls = { hybrid: 0, lexical: 0 };
  attachNativeClient(abortedStore, {
    async hybridSearch() {
      abortedCalls.hybrid += 1;
      controller.abort(new Error('caller cancelled'));
      return {
        status: { error_code: 'Success' },
        results: [[createNativeHybridHit({ id: 'candidate' })]],
      };
    },
    async search() {
      abortedCalls.lexical += 1;
      throw new Error('lexical search must not run after abort');
    },
  });
  await assert.rejects(
    abortedStore.searchHybridCollection(
      {
        ...createHybridSearchRequest(),
        signal: controller.signal,
      },
      manifest
    ),
    error => error?.name === 'AbortError'
  );
  assert.deepEqual(abortedCalls, { hybrid: 1, lexical: 0 });
});

test('native hybrid search fails closed on metadata provenance aliases', async () => {
  const store = createHybridTestStore();
  const manifest = createHybridManifest({ embeddingDimension: 2 });
  attachHybridSearchResults(store, [createNativeHybridHit({
    metadata: { tenantId: 'tenant-b' },
  })]);

  await assert.rejects(
    () => store.searchHybridCollection(createHybridSearchRequest(), manifest),
    error => {
      assert.ok(error instanceof MilvusHybridEvidenceIntegrityError);
      assert.match(error.message, /conflicting tenantId/);
      return true;
    }
  );
});

test('native hybrid search fails closed on authoritative scalar scope conflicts', async () => {
  const store = createHybridTestStore();
  const manifest = createHybridManifest({ embeddingDimension: 2 });
  attachHybridSearchResults(store, [createNativeHybridHit({ tenantId: 'tenant-b' })]);

  await assert.rejects(
    () => store.searchHybridCollection(createHybridSearchRequest(), manifest),
    error => {
      assert.ok(error instanceof MilvusHybridEvidenceIntegrityError);
      assert.match(error.message, /scope does not match/);
      return true;
    }
  );
});

function createHybridManifest(overrides = {}) {
  return createMilvusHybridRuntimeManifest({
    sourceCollectionName: overrides.sourceCollectionName ?? 'rag_documents',
    embeddingModel: 'embedding-v2',
    embeddingDimension: overrides.embeddingDimension ?? 2,
    env: {},
  });
}

function createHybridTestStore() {
  return new MilvusVectorStore({
    ...createConfig(),
    collectionName: 'rag_documents',
    embeddingDimension: 2,
  });
}

function createHybridSearchRequest() {
  return {
    collectionName: 'rag_documents_hybrid_v1',
    query: 'invoice 12345',
    denseEmbedding: [0.1, 0.2],
    topK: 3,
    fusion: 'rrf',
    scope: {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['trusted', 'reviewed'],
      enforceIsolation: true,
    },
  };
}

function createCompatibleHybridDescription(embeddingDimension) {
  return {
    schema: {
      fields: [
        { name: 'id', data_type: DataType.VarChar },
        { name: 'content', data_type: DataType.VarChar, enable_analyzer: true },
        { name: 'embedding', data_type: DataType.FloatVector, dim: embeddingDimension },
        {
          name: 'bm25_sparse',
          data_type: DataType.SparseFloatVector,
          is_function_output: true,
        },
        { name: 'source', data_type: DataType.VarChar },
        { name: 'metadata_json', data_type: DataType.VarChar },
        { name: 'tenant_id', data_type: DataType.VarChar },
        { name: 'corpus_id', data_type: DataType.VarChar },
        { name: 'document_id', data_type: DataType.VarChar },
        { name: 'document_version', data_type: DataType.VarChar },
        { name: 'trust_level', data_type: DataType.VarChar },
        { name: 'chunk_index', data_type: DataType.Int64 },
        { name: 'total_chunks', data_type: DataType.Int64 },
      ],
      functions: [{
        type: FunctionType.BM25,
        input_field_names: ['content'],
        output_field_names: ['bm25_sparse'],
      }],
    },
  };
}

function createNativeHybridHit(overrides = {}) {
  const tenantId = overrides.tenantId ?? 'tenant-a';
  return {
    id: overrides.id ?? 'lexical-member',
    score: overrides.score ?? 0.8,
    content: 'Invoice 12345 is due on Friday.',
    source: 'invoice.md',
    metadata_json: JSON.stringify(overrides.metadata ?? {}),
    tenant_id: tenantId,
    corpus_id: 'corpus-a',
    document_id: 'document-a',
    document_version: 'version-a',
    trust_level: 'trusted',
    chunk_index: 1,
    total_chunks: 4,
    start_offset: 10,
    end_offset: 42,
  };
}

function attachHybridSearchResults(store, hits) {
  attachNativeClient(store, {
    async hybridSearch() {
      return {
        status: { error_code: 'Success' },
        results: [hits],
      };
    },
    async search() {
      return {
        status: { error_code: 'Success' },
        results: [[...hits.map(hit => ({ id: hit.id }))]],
      };
    },
  });
}

function attachNativeClient(store, client) {
  store.client = client;
  store.isConnected = true;
}

function createConfig() {
  return {
    address: 'localhost:19530',
    username: '',
    password: '',
    ssl: false,
    database: 'default',
    collectionName: 'rag_documents',
    embeddingDimension: 768,
    indexType: 'HNSW',
    metricType: 'COSINE',
    token: '',
    consistencyLevel: 'Bounded',
    ignoreGrowing: false,
    groupByField: '',
    groupSize: 0,
    strictGroupSize: false,
    flushOnInsert: true,
    reloadAfterInsert: true,
    searchParams: { ef: 80 },
    searchOutputFields: ['id', 'content', 'source', 'metadata_json'],
    debugLogs: false,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
