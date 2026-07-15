import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node';

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
  MilvusVectorStore,
  buildMilvusSearchParams,
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
