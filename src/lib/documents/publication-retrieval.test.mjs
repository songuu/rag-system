import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { retrievePublicationDocument, retrievePublicationCorpus, openPublicationRetriever, rankPublicationCandidates } = await import('./publication-retrieval.ts');
const { preparePublicationAsset } = await import('./publication-asset-store.ts');
const { createPublicationChunk, publicationManifestEntry, buildPublicationCollectionSchema } = await import('./milvus-publication-generation.ts');
const { generationDocumentDigest } = await import('../elasticsearch/generation-index.ts');
const { canonicalJson } = await import('../rag/eval/canonical-json.ts');

const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true, allowedTrustLevels: ['external'] };
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const diagnostic = `sha256:${'a'.repeat(64)}`;
const marker = 'a'.repeat(64);

function fixture(documentId = 'doc-a', model = 'test') {
  const suffix = createHash('sha256').update(documentId).digest('hex').slice(0, 32);
  const indexName = `codex-generation-seal-${documentId === 'doc-a' ? 'a'.repeat(32) : documentId === 'doc-b' ? 'b'.repeat(32) : suffix}`;
  const collection = documentId === 'doc-a' ? 'rag_publication_a' : documentId === 'doc-b' ? 'rag_publication_b' : `rag_publication_${suffix}`;
  const collectionId = documentId === 'doc-a' ? '100' : documentId === 'doc-b' ? '101' : String(1000 + Number.parseInt(suffix.slice(0, 8), 16));
  const asset = preparePublicationAsset({ ...scope, documentId, sourceBytes: Buffer.from('source'),
    sourceIdentityBytes: Buffer.from('source'), originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
    embedding: { model, revision: '1', dimension: 2, indexSchema: 'milvus-publication/v1' },
    splitter: { name: 'test', revision: '1', chunkSize: 10, chunkOverlap: 0 },
    chunks: [{ chunkIndex: 0, content: 'source', trustLevel: 'external', source: 'a.txt',
      startOffset: 0, endOffset: 6, metadata: { source: 'a.txt' }, embedding: [0.25, 0.5] }] });
  const chunk = createPublicationChunk(scope, { documentId, generation: 1, documentVersion: asset.contentVersion,
    chunkIndex: 0, content: 'source', trustLevel: 'external', embedding: [0.25, 0.5] }, 2);
  const lexical = { chunk_id: chunk.id, tenant_id: scope.tenantId, corpus_id: scope.corpusId, document_id: documentId,
    document_version: asset.contentVersion, publication_generation: '1', trust_level: 'external', content: 'source',
    source: 'a.txt', start_offset: 0, end_offset: 6, metadata: { source: 'a.txt' } };
  const descriptorDigest = JSON.parse(asset.manifestJson).chunks[0].descriptorDigest;
  const entry = publicationManifestEntry(chunk);
  const milvusManifestJson = `[${canonicalJson({ ...entry, chunkId: entry.id, descriptorDigest })}]`;
  const elasticsearchManifestJson = `[${canonicalJson({ chunkIndex: 0, chunkId: chunk.id,
    digest: generationDocumentDigest(lexical), descriptorDigest })}]`;
  const view = { version: 1, tenantId: scope.tenantId, corpusId: scope.corpusId, documents: [{
    documentId, generation: '1', revision: '1', assetId: '00000000-0000-0000-0000-000000000001', assetRevision: '4',
    contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest, manifestJson: asset.manifestJson,
    descriptors: JSON.parse(asset.chunksJson).map(item => item.descriptorJson),
    milvusManifestJson, milvusManifestDigest: sha(milvusManifestJson), elasticsearchManifestJson, elasticsearchManifestDigest: sha(elasticsearchManifestJson),
    collection, collectionId, milvusConfigurationDigest: diagnostic, milvusEvidenceDigest: diagnostic,
    milvusVerifiedAt: '2026-01-01T00:00:00Z', indexName, indexUuid: 'uuid_1', ownerMarker: marker,
    elasticsearchConfigurationDigest: diagnostic, elasticsearchEvidenceDigest: diagnostic, elasticsearchVerifiedAt: '2026-01-01T00:00:00Z',
  }] };
  const esId = createHash('sha256').update(JSON.stringify([scope.tenantId, scope.corpusId, documentId, '1', chunk.id])).digest('hex');
  const state = { view, indexUuid: 'uuid_1', collectionId, blocked: true, calls: [], scope };
  const pg = { query: async () => ({ rows: [{ view: state.view }], rowCount: 1 }) };
  const elasticsearch = {
    indices: { get: async () => { state.calls.push('es-identity'); return { [indexName]: {
      aliases: {}, mappings: { _meta: { generation_owner: marker } }, settings: { index: { uuid: state.indexUuid, blocks: { write: state.blocked } } },
    } }; } },
    search: async request => { state.calls.push('es-search'); state.esRequest = request; return {
      timed_out: false, _shards: { failed: 0 }, hits: { hits: [{ _id: esId, _score: 1, _source: lexical }] },
    }; },
  };
  const milvus = {
    describeCollection: async () => { state.calls.push('milvus-identity'); return { status: { error_code: 'Success' },
      collection_name: collection, collectionID: state.collectionId,
      schema: { name: collection, enable_dynamic_field: false, fields: buildPublicationCollectionSchema(collection, 2).fields.map(field => ({
        name: field.name, data_type: ({ 21: 'VarChar', 5: 'Int64', 101: 'FloatVector' })[field.data_type],
        is_primary_key: field.is_primary_key ?? false, autoID: false,
        type_params: field.max_length ? [{ key: 'max_length', value: String(field.max_length) }]
          : field.dim ? [{ key: 'dim', value: String(field.dim) }] : [],
      })) },
    }; },
    describeIndex: async () => ({ status: { error_code: 'Success' }, index_descriptions: [{
      field_name: 'embedding', index_name: 'publication_vector_index', state: 'Finished',
      params: [{ key: 'index_type', value: 'FLAT' }, { key: 'metric_type', value: 'COSINE' }],
    }] }),
    search: async request => { state.calls.push('milvus-search'); state.milvusRequest = request; return {
      status: { error_code: 'Success' }, results: [{ ...chunk, score: 0.9 }],
    }; },
  };
  return { state, pg, elasticsearch, milvus, embedding: async config => { state.embedding = config; return [0.25, 0.5]; } };
}

function corpusFixture(documents = [fixture(), fixture('doc-b')]) {
  const view = { ...documents[0].state.view, documents: documents.flatMap(item => item.state.view.documents) };
  const calls = [];
  const elasticsearch = { indices: { get: async request => {
    calls.push(['es-get', request]);
    const names = Array.isArray(request.index) ? request.index : [request.index];
    const entries = await Promise.all(names.map(index => {
      const document = documents.find(item => item.state.view.documents[0].indexName === index);
      assert.ok(document, 'metadata reads only use explicitly issued indices');
      return document.elasticsearch.indices.get({ ...request, index });
    }));
    return Object.assign({}, ...entries);
  } }, search: async request => {
    calls.push(['es-search', request]);
    const hits = await Promise.all(documents.map(async item => {
      const response = await item.elasticsearch.search(request);
      response.hits.hits[0]._index = item.state.view.documents[0].indexName;
      return response.hits.hits[0];
    }));
    return { timed_out: false, _shards: { failed: 0 }, hits: { hits: hits.slice(0, request.size) } };
  } };
  const milvus = Object.fromEntries(['describeCollection', 'describeIndex', 'search'].map(method => [method, async request => {
    calls.push([`milvus-${method}`, request]);
    const document = documents.find(item => item.state.view.documents[0].collection === request.collection_name);
    assert.ok(document);
    return document.milvus[method](request);
  }]));
  return { documents, calls, input: { scope, query: 'source', topK: 2, strategy: 'hybrid',
    pg: { query: async () => ({ rows: [{ view }], rowCount: 1 }) }, elasticsearch, milvus,
    embedding: async () => [0.25, 0.5] } };
}

async function readFixtureMetadata(documents, request) {
  const names = Array.isArray(request.index) ? request.index : [request.index];
  return Object.assign({}, ...await Promise.all(names.map(index => {
    const document = documents.find(item => item.state.view.documents[0].indexName === index);
    assert.ok(document);
    return document.elasticsearch.indices.get({ ...request, index });
  })));
}

test('corpus retrieval exposes only its own issued view and preserves final freshness checks', async () => {
  const fixtureInput = fixture();
  let issued;
  let notifications = 0;
  let reads = 0;
  const originalQuery = fixtureInput.pg.query;
  fixtureInput.pg.query = async (...args) => { reads++; return originalQuery(...args); };
  const result = await retrievePublicationCorpus({ ...fixtureInput, scope, query: 'query', topK: 5,
    view: { tenantId: 'other-tenant', digest: 'forged' } }, view => {
    notifications++;
    issued = view;
    return { digest: 'forged-replacement' };
  });
  assert.equal(notifications, 1);
  assert.equal(issued.tenantId, scope.tenantId);
  assert.equal(Object.isFrozen(issued), true);
  assert.equal(result.viewDigest, issued.digest);
  assert.equal(reads, 2, 'read once before search and again for the final freshness fence');
});

test('corpus index fences batch explicit names and reduce hybrid RPCs from 7N+3 to 5N+3', async () => {
  const f = corpusFixture();
  const result = await retrievePublicationCorpus(f.input);
  assert.equal(result.ranking.length, 2);
  assert.equal(f.calls.length, 5 * f.documents.length + 3);
  const metadata = f.calls.filter(([method]) => method === 'es-get');
  const batches = metadata.filter(([, request]) => Array.isArray(request.index));
  assert.equal(batches.length, 2);
  assert.equal(metadata.length, 2);
  for (const [, request] of batches) assert.deepEqual(request, {
    index: f.documents.map(item => item.state.view.documents[0].indexName),
    allow_no_indices: false, ignore_unavailable: false, expand_wildcards: 'none',
  });
  const globalSearch = f.calls.findIndex(([method]) => method === 'es-search');
  assert.ok(f.calls.indexOf(batches[0]) < globalSearch);
  assert.ok(f.calls.indexOf(batches[1]) > globalSearch);
  assert.equal(f.calls[0], batches[0]);
  assert.equal(f.calls.at(-1), batches[1]);
});

function largeCorpusFixture() {
  const f = corpusFixture(Array.from({ length: 128 }, (_, index) => fixture(`doc-${String(index).padStart(3, '0')}`)));
  f.input.strategy = 'semantic';
  return f;
}

test('128-document semantic retrieval bounds encoded metadata URIs and fences every document', async () => {
  const f = largeCorpusFixture(), original = f.input.elasticsearch.indices.get;
  f.input.elasticsearch.indices.get = async request => {
    const uri = `/${encodeURIComponent(request.index.toString())}?allow_no_indices=false&ignore_unavailable=false&expand_wildcards=none`;
    assert.ok(Buffer.byteLength(uri) <= 3 * 1024, `metadata URI exceeds budget: ${Buffer.byteLength(uri)}`);
    return original(request);
  };
  const result = await retrievePublicationCorpus(f.input);
  assert.equal(result.documents.length, 128);
  const checks = f.calls.filter(([method]) => method === 'es-get');
  const half = checks.length / 2;
  assert.ok(half >= 3 && Number.isInteger(half));
  const expected = f.documents.map(document => document.state.view.documents[0].indexName);
  for (const pass of [checks.slice(0, half), checks.slice(half)]) {
    assert.deepEqual(pass.flatMap(([, request]) => request.index), expected);
  }
  const firstWork = f.calls.findIndex(([method]) => method.startsWith('milvus-'));
  const lastWork = f.calls.findLastIndex(([method]) => method.startsWith('milvus-'));
  assert.ok(f.calls.indexOf(checks[half - 1]) < firstWork);
  assert.ok(f.calls.indexOf(checks[half]) > lastWork);
  assert.equal(f.calls.some(([method]) => method === 'es-search'), false);
});

test('metadata batch failures retain a pending sibling in both fence passes', async () => {
  for (const failedPass of ['pre', 'post']) {
    const f = largeCorpusFixture(), original = f.input.elasticsearch.indices.get;
    const failure = new Error(`fixture ${failedPass} batch failure`);
    let release, entered, failingBatch = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    f.input.elasticsearch.indices.get = async request => {
      const uri = `/${encodeURIComponent(request.index.toString())}`;
      // Fail immediately instead of hanging when exercising the old one-batch implementation.
      assert.ok(Buffer.byteLength(uri) < 3 * 1024, 'metadata must be split into bounded batches');
      const response = await original(request);
      const pass = f.calls.some(([method]) => method === 'milvus-search') ? 'post' : 'pre';
      if (pass === failedPass) {
        const position = ++failingBatch;
        if (position === 1) throw failure;
        if (position === 2) { entered(); await gate; }
      }
      return response;
    };
    const pending = retrievePublicationCorpus(f.input);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await Promise.race([started, pending]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, failedPass);
      if (failedPass === 'pre') assert.equal(f.calls.some(([method]) => method.startsWith('milvus-')), false);
      release(); await assert.rejects(pending, error => error === failure);
    } finally { release(); await pending.catch(() => {}); }
  }
});

test('large lexical retrieval uses one SDK NDJSON DFS query with exact targets and bounded URIs', async () => {
  const { Client, BaseConnection } = await import('@elastic/elasticsearch');
  const f = largeCorpusFixture(), original = f.input.elasticsearch;
  const captured = [];
  class OfflineConnection extends BaseConnection {
    async close() {}
    async request(params) {
      const target = params.path + (params.querystring ? `?${params.querystring}` : '');
      assert.ok(Buffer.byteLength(target) <= 3 * 1024, `SDK URI exceeds budget: ${Buffer.byteLength(target)}`);
      captured.push(params);
      let response;
      if (params.path === '/_msearch') {
        assert.equal(params.method, 'POST');
        assert.equal(typeof params.body, 'string');
        assert.ok(params.body.endsWith('\n'));
        const lines = params.body.trimEnd().split('\n').map(line => JSON.parse(line));
        assert.equal(lines.length, 2, 'one global query, never one query per index');
        assert.deepEqual(lines[0], { index: f.documents.map(document => document.state.view.documents[0].indexName),
          allow_no_indices: false, ignore_unavailable: false, expand_wildcards: 'none',
          search_type: 'dfs_query_then_fetch', allow_partial_search_results: false });
        assert.equal('index' in lines[1], false);
        assert.equal(lines[1].query.bool.filter[0].bool.should.length, 128);
        response = { took: 1, responses: [{ status: 200, ...await original.search(lines[1]) }] };
      } else {
        assert.equal(params.method, 'GET');
        response = await original.indices.get({ index: decodeURIComponent(params.path.slice(1)).split(',') });
      }
      return { statusCode: 200, headers: { 'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch' },
        body: JSON.stringify(response) };
    }
  }
  const client = new Client({ node: 'http://offline.invalid:9200', Connection: OfflineConnection, maxRetries: 0 });
  try {
    const result = await retrievePublicationCorpus({ ...f.input, elasticsearch: client, strategy: 'hybrid' });
    assert.equal(captured.filter(request => request.path === '/_msearch').length, 1);
    assert.equal(captured.some(request => request.path.endsWith('/_search')), false);
    assert.deepEqual(result.ranking.map(hit => hit.documentId), ['doc-000', 'doc-001']);
    assert.deepEqual(result.ranking.map(hit => [hit.denseRank, hit.lexicalRank]), [[1, 1], [2, 2]]);
    assert.deepEqual(result.ranking.map(hit => hit.score), [2 / 61, 2 / 62]);
  } finally { await client.close(); }
});

test('large msearch rejects missing, extra, failed and partial subresponses', async () => {
  for (const malformed of [
    { responses: [] }, { responses: [{}, {}] }, { responses: [{ error: { type: 'fixture' }, status: 400 }] },
    { responses: [{ status: 503, hits: { hits: [] } }] },
    { responses: [{ status: 200, timed_out: false, _shards: { failed: 1 }, hits: { hits: [] } }] },
    { responses: [{ status: 200, timed_out: true, _shards: { failed: 0 }, hits: { hits: [] } }] },
  ]) {
    const f = largeCorpusFixture();
    f.input.elasticsearch.msearch = async () => malformed;
    f.input.elasticsearch.search = async () => { throw new Error('oversized direct search must not run'); };
    await assert.rejects(retrievePublicationCorpus({ ...f.input, strategy: 'keyword' }), /multi-search|incomplete|shard|timed out/i);
  }
  const f = largeCorpusFixture();
  await assert.rejects(retrievePublicationCorpus({ ...f.input, strategy: 'keyword' }), /multi-search/i);
});

test('the shared pre-fence settles before any document work or embedding starts', async () => {
  const f = corpusFixture(), original = f.input.elasticsearch.indices.get;
  let release, entered, embeddings = 0, intercepted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.input.elasticsearch.indices.get = async request => {
    const response = await original(request);
    if (Array.isArray(request.index) && !intercepted) {
      intercepted = true;
      entered(); await gate;
    }
    return response;
  };
  f.input.embedding = async () => { embeddings++; return [0.25, 0.5]; };
  const pending = retrievePublicationCorpus(f.input);
  try {
    await started; await new Promise(resolve => setImmediate(resolve));
    assert.equal(embeddings, 0);
    assert.deepEqual(f.calls.map(([method]) => method), ['es-get']);
  } finally { release(); await pending; }
});

test('global batch metadata rejects missing, extra, alias, UUID, owner and seal changes', async () => {
  for (const mutation of ['missing', 'extra', 'alias', 'uuid', 'owner', 'seal']) {
    const f = corpusFixture(), original = f.input.elasticsearch.indices.get;
    f.input.elasticsearch.indices.get = async request => {
      const response = await original(request);
      if (Array.isArray(request.index)) {
        const name = request.index[0], entry = response[name];
        if (mutation === 'missing') delete response[name];
        if (mutation === 'extra') response.unexpected = structuredClone(entry);
        if (mutation === 'alias') entry.aliases.alias = {};
        if (mutation === 'uuid') entry.settings.index.uuid = 'replaced';
        if (mutation === 'owner') entry.mappings._meta.generation_owner = 'foreign';
        if (mutation === 'seal') entry.settings.index.blocks.write = false;
      }
      return { body: response };
    };
    await assert.rejects(retrievePublicationCorpus(f.input), /identity|concrete|sealed/i, mutation);
    assert.equal(f.calls.some(([method]) => method === 'es-search'), false, mutation);
  }
});

test('cancelled global metadata read retains in-flight work and never starts global search', async () => {
  const f = corpusFixture(), controller = new AbortController(), original = f.input.elasticsearch.indices.get;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.input.elasticsearch.indices.get = async request => {
    if (Array.isArray(request.index)) { entered(); await gate; }
    return original(request);
  };
  const pending = retrievePublicationCorpus({ ...f.input, signal: controller.signal });
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release(); await assert.rejects(pending, /cancelled/i);
    assert.equal(f.calls.some(([method]) => method === 'es-search'), false);
  } finally { release(); await pending.catch(() => {}); }
});

test('a synchronous global search failure waits for dense siblings before the shared post-fence', async () => {
  const f = corpusFixture(), failure = new Error('fixture search failure');
  const originalSearch = f.input.milvus.search;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.input.elasticsearch.search = () => { throw failure; };
  f.input.milvus.search = async request => { entered(); await gate; return originalSearch(request); };
  const pending = retrievePublicationCorpus(f.input);
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    assert.equal(f.calls.filter(([method]) => method === 'es-get').length, 1);
    release(); await assert.rejects(pending, error => error === failure);
    assert.equal(f.calls.filter(([method]) => method === 'es-get').length, 2);
  } finally { release(); await pending.catch(() => {}); }
});

test('the shared post-fence detects index replacement, aliases, ownership and seal changes after dense work', async () => {
  for (const mutation of ['uuid', 'alias', 'owner', 'seal', 'missing', 'extra']) {
    const f = corpusFixture(), originalGet = f.input.elasticsearch.indices.get;
    let rounds = 0;
    f.input.elasticsearch.indices.get = async request => {
      const response = await originalGet(request);
      if (Array.isArray(request.index) && ++rounds === 2) {
        const name = request.index[0], entry = response[name];
        if (mutation === 'uuid') entry.settings.index.uuid = 'replaced';
        if (mutation === 'alias') entry.aliases.foreign = {};
        if (mutation === 'owner') entry.mappings._meta.generation_owner = 'foreign';
        if (mutation === 'seal') entry.settings.index.blocks.write = false;
        if (mutation === 'missing') delete response[name];
        if (mutation === 'extra') response.unexpected = structuredClone(entry);
      }
      return response;
    };
    await assert.rejects(retrievePublicationCorpus(f.input), /identity|concrete|sealed/i, mutation);
    assert.equal(rounds, 2);
    assert.equal(f.calls.some(([method]) => method === 'milvus-search'), true);
  }
});

test('cancellation retains a delayed dense sibling and completes the post-fence before returning', async () => {
  const f = corpusFixture(), controller = new AbortController(), original = f.input.milvus.search;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.input.milvus.search = async request => { entered(); await gate; return original(request); };
  const pending = retrievePublicationCorpus({ ...f.input, signal: controller.signal });
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.calls.filter(([method]) => method === 'es-get').length, 1);
    release(); await assert.rejects(pending, /cancelled/i);
    assert.equal(f.calls.filter(([method]) => method === 'es-get').length, 2);
  } finally { release(); await pending.catch(() => {}); }
});

test('a pending post-fence retains the request through cancellation and avoids a later view read', async () => {
  const f = corpusFixture(), controller = new AbortController(), original = f.input.elasticsearch.indices.get;
  const query = f.input.pg.query;
  let release, entered, reads = 0, rounds = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.input.pg.query = async (...args) => { reads++; return query(...args); };
  f.input.elasticsearch.indices.get = async request => {
    const result = await original(request);
    if (++rounds === 2) { entered(); await gate; }
    return result;
  };
  const pending = retrievePublicationCorpus({ ...f.input, signal: controller.signal });
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(reads, 1);
    release(); await assert.rejects(pending, /cancelled/i);
    assert.equal(reads, 1, 'cancelled requests must not start another publication read');
  } finally { release(); await pending.catch(() => {}); }
});

test('shared physical fences do not replace the final authorized publication view', async () => {
  const f = corpusFixture(), query = f.input.pg.query;
  let reads = 0;
  f.input.pg.query = async (...args) => {
    const result = await query(...args);
    if (++reads === 1) return result;
    const changed = structuredClone(result);
    changed.rows[0].view.documents[0].revision = '2';
    return changed;
  };
  await assert.rejects(retrievePublicationCorpus(f.input), /view changed/i);
  assert.equal(f.calls.filter(([method]) => method === 'es-get').length, 2);
  assert.equal(reads, 2);
});

test('single-document and empty corpus reads do not add physical RPCs', async () => {
  const f = fixture();
  let count = 0;
  for (const [client, method] of [[f.elasticsearch.indices, 'get'], [f.elasticsearch, 'search'],
    [f.milvus, 'describeCollection'], [f.milvus, 'describeIndex'], [f.milvus, 'search']]) {
    const original = client[method];
    client[method] = async (...args) => { count++; return original(...args); };
  }
  await retrievePublicationCorpus({ ...f, scope, query: 'source', topK: 2 });
  assert.equal(count, 8);
  count = 0;
  const empty = await retrievePublicationCorpus({ ...f, scope, query: 'source', topK: 2, documentId: 'unselected' });
  assert.deepEqual(empty.ranking, []);
  assert.equal(count, 0);
});

test('queries both actual provider ports under the same issued view and checks resources twice', async () => {
  const f = fixture();
  const result = await retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 2, ...f });
  assert.equal(result.dense.length, 1);
  assert.equal(result.lexical.length, 1);
  assert.deepEqual(f.state.embedding, { model: 'test', revision: '1', dimension: 2, indexSchema: 'milvus-publication/v1' });
  assert.equal(f.state.calls.filter(item => item === 'es-identity').length, 2);
  assert.equal(f.state.calls.filter(item => item === 'milvus-identity').length, 2);
  assert.match(f.state.milvusRequest.filter, /document_version/);
  assert.match(JSON.stringify(f.state.esRequest), /publication_generation/);
  assert.equal(result.productionAuthorized, false);
});

test('rejects changed backend identity and an unsealed ES index before searching', async () => {
  for (const alter of [s => { s.indexUuid = 'other'; }, s => { s.collectionId = '101'; }, s => { s.blocked = false; }]) {
    const f = fixture(); alter(f.state);
    await assert.rejects(retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 2, ...f }), /identity|sealed/i);
    assert.equal(f.state.calls.includes('es-search'), false);
    assert.equal(f.state.calls.includes('milvus-search'), false);
  }
});

test('discards retrieved evidence if the authorized view changes during retrieval', async () => {
  const f = fixture();
  const search = f.elasticsearch.search;
  f.elasticsearch.search = async request => { const response = await search(request); f.state.view = structuredClone(f.state.view);
    f.state.view.documents[0].revision = '2'; return response; };
  await assert.rejects(retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 2, ...f }), /changed/);
});

test('fails closed for a missing document and an incompatible query vector', async () => {
  const f = fixture();
  await assert.rejects(retrievePublicationDocument({ scope, documentId: 'missing', query: 'source', topK: 2, ...f }), /unavailable/i);
  assert.deepEqual(f.state.calls, []);
  await assert.rejects(retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 2,
    ...f, embedding: async () => [1] }), /vector|dimension/i);
});

test('multi-document retrieval rejects incompatible model spaces before provider IO', async () => {
  const a = fixture();
  const b = fixture('doc-b', 'other-model');
  const combined = { ...a.state.view, documents: [...a.state.view.documents, ...b.state.view.documents] };
  let reads = 0;
  const pg = { query: async () => { reads++; return { rows: [{ view: combined }], rowCount: 1 }; } };
  const elasticsearch = {
    indices: { get: request => request.index.endsWith('a'.repeat(32)) ? a.elasticsearch.indices.get(request) : b.elasticsearch.indices.get(request) },
    search: request => request.index.endsWith('a'.repeat(32)) ? a.elasticsearch.search(request) : b.elasticsearch.search(request),
  };
  const milvus = {
    describeCollection: request => request.collection_name.endsWith('_a') ? a.milvus.describeCollection(request) : b.milvus.describeCollection(request),
    search: request => request.collection_name.endsWith('_a') ? a.milvus.search(request) : b.milvus.search(request),
  };
  await assert.rejects(retrievePublicationCorpus({ scope, query: 'source', topK: 2, strategy: 'semantic', pg, elasticsearch, milvus,
    embedding: async () => [0.25, 0.5] }), /incomparable/i);
  assert.equal(reads, 1);
  assert.deepEqual(a.state.calls, []);
  assert.deepEqual(b.state.calls, []);
});

test('semantic corpus ranks comparable cosine scores globally before top K', () => {
  const rows = [{ documentId: 'a', generation: '1', dense: [{ id: 'low', score: 0.01 }], lexical: [] },
    { documentId: 'b', generation: '1', dense: [{ id: 'high', score: 0.99 }], lexical: [] }];
  assert.equal(rankPublicationCandidates(rows, 1, 'semantic')[0].chunkId, 'high');
  assert.equal(rankPublicationCandidates(rows, 1, 'hybrid')[0].chunkId, 'high');
});

test('same-model documents use global semantic scores', async () => {
  const a = fixture();
  const b = fixture('doc-b');
  const view = { ...a.state.view, documents: [...a.state.view.documents, ...b.state.view.documents] };
  const pg = { query: async () => ({ rows: [{ view }], rowCount: 1 }) };
  const elasticsearch = { indices: { get: request => readFixtureMetadata([a, b], request) },
  search: request => request.index.endsWith('a'.repeat(32)) ? a.elasticsearch.search(request) : b.elasticsearch.search(request) };
  const milvus = {
    describeCollection: request => request.collection_name.endsWith('_a') ? a.milvus.describeCollection(request) : b.milvus.describeCollection(request),
    describeIndex: request => request.collection_name.endsWith('_a') ? a.milvus.describeIndex(request) : b.milvus.describeIndex(request),
    search: async request => { const response = await (request.collection_name.endsWith('_a') ? a.milvus.search(request) : b.milvus.search(request));
      response.results[0].score = request.collection_name.endsWith('_a') ? 0.01 : 0.99; return response; },
  };
  const request = { scope, query: 'source', topK: 1, pg, elasticsearch, milvus, embedding: async () => [0.25, 0.5] };
  const result = await retrievePublicationCorpus({ ...request, strategy: 'semantic' });
  assert.equal(result.ranking[0].documentId, 'doc-b');
});

test('identity failure before or after search waits for every sibling physical check', async () => {
  for (const failedRound of [1, 2]) {
    const f = fixture(), failure = new Error('fixture identity failure');
    const originalEs = f.elasticsearch.indices.get, originalMilvus = f.milvus.describeCollection;
    let esRounds = 0, milvusRounds = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    f.elasticsearch.indices.get = async (...args) => {
      if (++esRounds === failedRound) throw failure;
      return originalEs(...args);
    };
    f.milvus.describeCollection = async (...args) => {
      if (++milvusRounds === failedRound) await gate;
      return originalMilvus(...args);
    };
    const pending = retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 2, ...f });
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, `identity round ${failedRound} must retain its lease`);
      release(); await assert.rejects(pending, error => error === failure);
    } finally { release(); await pending.catch(() => {}); }
  }
});

test('a failed dense search waits for the already-started lexical request', async () => {
  const f = fixture(), failure = new Error('fixture dense failure'), original = f.elasticsearch.search;
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.milvus.search = async () => { throw failure; };
  f.elasticsearch.search = async (...args) => { await gate; return original(...args); };
  const pending = retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 2, ...f });
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));assert.equal(settled, false);
    release(); await assert.rejects(pending, error => error === failure);
  } finally { release(); await pending.catch(() => {}); }
});

test('a failed document worker waits for another document search to settle', async () => {
  const a = fixture(), b = fixture('doc-b'), failure = new Error('fixture document failure');
  const view = { ...a.state.view, documents: [...a.state.view.documents, ...b.state.view.documents] };
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pg = { query: async () => ({ rows: [{ view }], rowCount: 1 }) };
  const elasticsearch = { indices: { get: request => readFixtureMetadata([a, b], request) }, search: async () => { throw new Error('semantic only'); } };
  const milvus = {
    describeCollection: request => request.collection_name.endsWith('_a') ? a.milvus.describeCollection(request) : b.milvus.describeCollection(request),
    describeIndex: request => request.collection_name.endsWith('_a') ? a.milvus.describeIndex(request) : b.milvus.describeIndex(request),
    search: async request => { if (request.collection_name.endsWith('_a')) throw failure; await gate; return b.milvus.search(request); },
  };
  const pending = retrievePublicationCorpus({ scope, query: 'source', topK: 1, strategy: 'semantic', pg, elasticsearch, milvus,
    embedding: async () => [0.25, 0.5] });
  let settled = false;void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));assert.equal(settled, false);
    release();await assert.rejects(pending, error => error === failure);
  } finally { release();await pending.catch(() => {}); }
});

test('follow-up limits query bytes and number of searches before any IO', async () => {
  const f = fixture();
  let reads = 0;
  const pg = { query: async (...args) => { reads++; return f.pg.query(...args); } };
  const retriever = await openPublicationRetriever({ scope, ...f, pg });
  const before = reads;
  await assert.rejects(retriever.search({ query: 'x'.repeat(2049), topK: 1 }), /request|budget/i);
  assert.equal(reads, before);
  for (let i = 0; i < 3; i++) await retriever.search({ query: 'source', topK: 1 });
  const exhausted = reads;
  await assert.rejects(retriever.search({ query: 'source', topK: 1 }), /budget/i);
  assert.equal(reads, exhausted);
});

test('follow-up expiration is checked before IO', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const f = fixture();
  let reads = 0;
  const pg = { query: async (...args) => { reads++; return f.pg.query(...args); } };
  const retriever = await openPublicationRetriever({ scope, ...f, pg });
  now += 30_001;
  const before = reads;
  await assert.rejects(retriever.search({ query: 'source', topK: 1 }), /budget/i);
  assert.equal(reads, before);
});

test('rejects a changed Milvus vector index metric before retrieval', async () => {
  const f = fixture();
  f.milvus.describeIndex = async () => ({ status: { error_code: 'Success' }, index_descriptions: [{
    field_name: 'embedding', index_name: 'publication_vector_index', state: 'Finished',
    params: [{ key: 'index_type', value: 'FLAT' }, { key: 'metric_type', value: 'L2' }],
  }] });
  await assert.rejects(retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 1, ...f }), /index|metric/i);
  assert.equal(f.state.calls.includes('milvus-search'), false);
});

test('rejects schema or index changes after retrieval', async () => {
  for (const target of ['schema', 'index']) {
    const f = fixture();
    const describe = target === 'schema' ? f.milvus.describeCollection : f.milvus.describeIndex;
    let calls = 0;
    if (target === 'schema') f.milvus.describeCollection = async (...args) => {
      const result = await describe(...args);
      if (++calls === 2) result.schema.fields[0].data_type = 'Int64';
      return result;
    };
    else f.milvus.describeIndex = async (...args) => {
      const result = await describe(...args);
      if (++calls === 2) result.index_descriptions[0].params[1].value = 'L2';
      return result;
    };
    await assert.rejects(retrievePublicationDocument({ scope, documentId: 'doc-a', query: 'source', topK: 1, ...f }), /schema|metric/i);
  }
});

test('keyword and semantic modes skip the unrequested retrieval work', async () => {
  const keyword = fixture();
  await retrievePublicationCorpus({ scope, query: 'source', topK: 1, strategy: 'keyword', ...keyword,
    embedding: async () => { throw new Error('embedding must not run'); } });
  assert.equal(keyword.state.calls.includes('milvus-search'), false);
  assert.equal(keyword.state.calls.includes('es-search'), true);
  const semantic = fixture();
  await retrievePublicationCorpus({ scope, query: 'source', topK: 1, strategy: 'semantic', ...semantic });
  assert.equal(semantic.state.calls.includes('milvus-search'), true);
  assert.equal(semantic.state.calls.includes('es-search'), false);
});

test('document and file type filters select authorized chunks before provider top K', async () => {
  const f = fixture();
  const empty = await retrievePublicationCorpus({ scope, query: 'source', topK: 1, fileType: 'pdf', ...f });
  assert.deepEqual(empty.ranking, []);
  assert.deepEqual(f.state.calls, []);
  const selected = await retrievePublicationCorpus({ scope, query: 'source', topK: 1, fileType: 'text', documentId: 'doc-a', ...f });
  assert.equal(selected.ranking.length, 1);
  assert.match(f.state.milvusRequest.filter, /id in/);
  const missing = await retrievePublicationCorpus({ scope, query: 'source', topK: 1, documentId: 'other', ...f });
  assert.deepEqual(missing.ranking, []);
});

test('follow-up search pins the issued view and refuses a later revision before provider IO', async () => {
  const f = fixture();
  const queries = [];
  const retriever = await openPublicationRetriever({ scope, ...f, embedding: async (_config, query) => {
    queries.push(query); return [0.25, 0.5];
  } });
  const first = await retriever.search({ query: 'source', topK: 1 });
  assert.equal(first.viewDigest, retriever.viewDigest);
  await retriever.search({ query: 'follow-up', topK: 1 });
  assert.deepEqual(queries, ['source', 'follow-up']);
  f.state.view = structuredClone(f.state.view);
  f.state.view.documents[0].revision = '2';
  const before = f.state.calls.length;
  await assert.rejects(retriever.search({ query: 'changed', topK: 1 }), /changed/);
  assert.equal(f.state.calls.length, before);
});

test('follow-up inputs cannot replace the server-owned scope, clients, or embedding provider', async () => {
  const f = fixture();
  const retriever = await openPublicationRetriever({ scope, ...f });
  const result = await retriever.search({ query: 'source', topK: 1,
    scope: { ...scope, tenantId: 'foreign' },
    pg: { query: async () => { throw new Error('forged database'); } },
    embedding: async () => { throw new Error('forged embedding'); },
  });
  assert.equal(result.documents[0].documentId, 'doc-a');
  assert.equal(result.productionAuthorized, false);
});


test('multi-index search uses global DFS ranks and rejects wrong index provenance', async () => {
  const a = fixture(); const b = fixture('doc-b');
  const view = { ...a.state.view, documents: [...a.state.view.documents, ...b.state.view.documents] };
  const pg = { query: async () => ({ rows: [{ view }], rowCount: 1 }) };
  let captured; let forged = false;
  const elasticsearch = { indices: { get: async req => {
    const names = Array.isArray(req.index) ? req.index : [req.index];
    return Object.assign({}, ...await Promise.all(names.map(index => index.endsWith('a'.repeat(32))
      ? a.elasticsearch.indices.get({ ...req, index }) : b.elasticsearch.indices.get({ ...req, index }))));
  } },
    search: async req => { captured = req; const ar = await a.elasticsearch.search(req); const br = await b.elasticsearch.search(req);
      const ah = ar.hits.hits[0]; const bh = br.hits.hits[0]; ah._index = a.state.view.documents[0].indexName;
      bh._index = forged ? ah._index : b.state.view.documents[0].indexName; bh._score = 2;
      return { timed_out: false, _shards: { failed: 0 }, hits: { hits: [bh, ah].slice(0, req.size) } }; } };
  const milvus = { describeCollection: req => req.collection_name.endsWith('_a') ? a.milvus.describeCollection(req) : b.milvus.describeCollection(req),
    describeIndex: req => req.collection_name.endsWith('_a') ? a.milvus.describeIndex(req) : b.milvus.describeIndex(req),
    search: req => req.collection_name.endsWith('_a') ? a.milvus.search(req) : b.milvus.search(req) };
  const options = { scope, query: 'source', topK: 1, strategy: 'keyword', pg, elasticsearch, milvus, embedding: async () => [0.25, 0.5] };
  const result = await retrievePublicationCorpus(options);
  assert.equal(result.ranking[0].documentId, 'doc-b');
  assert.equal(captured.search_type, 'dfs_query_then_fetch');
  assert.equal(captured.index.length, 2);
  assert.match(JSON.stringify(captured.query), /_index/);
  forged = true; await assert.rejects(retrievePublicationCorpus(options), /provenance|index/i);
});


test('hybrid fusion uses corpus-wide lexical and cosine ranks', () => {
  const rows = [
    { documentId: 'a', generation: '1', dense: [{ id: 'a1', score: 0.8 }], lexical: [{ document: { chunk_id: 'a1' } }] },
    { documentId: 'b', generation: '1', dense: [{ id: 'b1', score: 0.9 }], lexical: [{ document: { chunk_id: 'b1' } }] },
  ];
  const lexical = [ { document: { document_id: 'b', publication_generation: '1', chunk_id: 'b1' } },
    { document: { document_id: 'a', publication_generation: '1', chunk_id: 'a1' } } ];
  const result = rankPublicationCandidates(rows, 2, 'hybrid', lexical);
  assert.equal(result[0].chunkId, 'b1');
  assert.equal(result[0].denseRank, 1);
  assert.equal(result[0].lexicalRank, 1);
  assert.equal(result[1].denseRank, 2);
  assert.equal(result[1].lexicalRank, 2);
});


test('isolated ES and Milvus execute multi-index retrieval with reader identities',
  { skip: process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS !== '1' || !/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_SANDBOX_ID ?? ''), timeout: 180_000 }, async () => {
  const { randomUUID } = await import('node:crypto');
  const { writeFile, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { Client } = await import('@elastic/elasticsearch');
  const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
  const { readSandboxConfig } = await import('../../../deploy/publication-sandbox/sandbox.mjs');
  const { createGenerationAccess } = await import('./publication-generation-access.ts');
  const { buildGenerationLexicalMapping } = await import('../elasticsearch/generation-index.ts');
  const cfg = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const esConfig = { node: `https://127.0.0.1:${cfg.ports.elasticsearch}`, tls: { ca: cfg.ca }, maxRetries: 0 };
  const esAdmin = new Client({ ...esConfig, auth: { username: 'elastic', password: cfg.credentials.elasticAdmin } });
  const esReader = new Client({ ...esConfig, auth: { username: 'pub_reader', password: cfg.credentials.esReader } });
  const milvusConfig = { address: `127.0.0.1:${cfg.ports.milvus}`, maxRetries: 0, isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } };
  const admin = new MilvusClient({ ...milvusConfig, username: 'root', password: cfg.credentials.milvusAdmin });
  const reader = new MilvusClient({ ...milvusConfig, username: 'pub_reader', password: cfg.credentials.milvusReader });
  const assets = []; const suffix = randomUUID().replaceAll('-', '');
  const intent = join(cfg.path, `retrieval-test-${suffix}.json`);
  let complete = false;
  try {
    // Durable ownership is recorded before the first resource creation.
    await writeFile(intent, JSON.stringify({ indexes: [0, 1].map(n => `codex-generation-seal-${suffix.slice(0, 31)}${n}`),
      collections: [0, 1].map(n => `rag_publication_${suffix.slice(0, 31)}${n}`) }), { flag: 'wx', mode: 0o600 });
    for (const [n, f] of [fixture(), fixture('doc-b')].entries()) {
      const index = `codex-generation-seal-${suffix.slice(0, 31)}${n}`;
      const collection = `rag_publication_${suffix.slice(0, 31)}${n}`;
      const access = await createGenerationAccess({ collection, dimension: 2, address: milvusConfig.address,
        admin, checkLease: async () => true, persistIntent: async identity => {
          await writeFile(join(cfg.path, `retrieval-acl-${suffix}-${n}.json`), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
        } });
      const entry = { index, collection, access, acl: join(cfg.path, `retrieval-acl-${suffix}-${n}.json`), identity: undefined };
      assets.push(entry);
      const mapping = buildGenerationLexicalMapping();
      await esAdmin.indices.create({ index, ...mapping, mappings: { ...mapping.mappings, _meta: { generation_owner: marker } } });
      const esHit = (await f.elasticsearch.search({})).hits.hits[0];
      await esAdmin.index({ index, id: esHit._id, document: esHit._source, refresh: true });
      await esAdmin.indices.addBlock({ index, block: 'write' });
      const indexData = await esAdmin.indices.get({ index });
      const doc = f.state.view.documents[0];
      doc.indexName = index; doc.indexUuid = indexData[index].settings.index.uuid;
      const vector = (await f.milvus.search({})).results[0]; delete vector.score;
      await access.createIndex(); await access.insert([vector]); await access.flush(); await access.load(); await access.revoke();
      const desc = await admin.describeCollection({ collection_name: collection, cache: false });
      assert.equal(desc.status.error_code, 'Success');
      doc.collection = collection; doc.collectionId = String(desc.collectionID);
      entry.identity = { collection, username: `pgu_${collection.slice(-24)}`, role: `pgr_${collection.slice(-24)}` };
      entry.fixture = f;
    }
    const [a,b] = assets;
    const view = { ...a.fixture.state.view, documents: [a.fixture.state.view.documents[0], b.fixture.state.view.documents[0]] };
    const pg = { query: async () => ({ rows: [{ view }], rowCount: 1 }) };
    const options = { scope, query: 'source', topK: 2, pg, elasticsearch: esReader, milvus: reader, embedding: async () => [0.25, 0.5] };
    for (const strategy of ['keyword', 'semantic', 'hybrid']) {
      const result = await retrievePublicationCorpus({ ...options, strategy });
      assert.equal(result.ranking.length, 2);
      assert.equal(new Set(result.ranking.map(item => item.documentId)).size, 2);
      assert.equal(result.productionAuthorized, false);
    }
    const filtered = await retrievePublicationCorpus({ ...options, strategy: 'hybrid', fileType: 'pdf' });
    assert.equal(filtered.ranking.length, 0);
    await assert.rejects(esReader.index({ index: a.index, document: { content: 'not allowed' } }));
    const before = await esAdmin.indices.get({ index: a.index });
    assert.equal(before[a.index].settings.index.blocks.write, 'true');
    complete = true;
  } finally {
    if (complete) {
      for (const item of assets) {
        await esAdmin.indices.delete({ index: item.index });
        for (const result of [await admin.dropCollection({ collection_name: item.collection }),
          await admin.removeUserFromRole({ username: item.identity.username, roleName: item.identity.role }),
          await admin.deleteUser({ username: item.identity.username }), await admin.dropRole({ roleName: item.identity.role })]) {
          assert.equal((result.status ?? result).error_code, 'Success');
        }
        await unlink(item.acl);
      }
      await unlink(intent);
    }
    await Promise.all([esAdmin.close(), esReader.close(), admin.closeConnection(), reader.closeConnection()]);
  }
});


test('global search is bracketed by physical index checks when a query is delayed', async () => {
  const a = fixture(); const b = fixture('doc-b');
  const view = { ...a.state.view, documents: [...a.state.view.documents, ...b.state.view.documents] };
  const pg = { query: async () => ({ rows: [{ view }], rowCount: 1 }) };
  let start; const started = new Promise(resolve => { start = resolve; });
  let release; const delayed = new Promise(resolve => { release = resolve; });
  let checked; const checkedBeforeMutation = new Promise(resolve => { checked = resolve; });
  const counts = { a: 0, b: 0 };
  const elasticsearch = { indices: { get: async req => {
    const names = Array.isArray(req.index) ? req.index : [req.index];
    const results = await Promise.all(names.map(async index => {
      const key = index.endsWith('a'.repeat(32)) ? 'a' : 'b';
      const result = await (key === 'a' ? a.elasticsearch.indices.get({ ...req, index }) : b.elasticsearch.indices.get({ ...req, index }));
      counts[key]++; if (counts.a >= 1 && counts.b >= 1) checked(); return result;
    }));
    return Object.assign({}, ...results);
  } },
    search: async req => { assert.ok(a.state.calls.includes('es-identity')); assert.ok(b.state.calls.includes('es-identity'));
      start(); await delayed;
      const result = await a.elasticsearch.search(req); result.hits.hits[0]._index = a.state.view.documents[0].indexName; return result; } };
  const milvus = { describeCollection: req => req.collection_name.endsWith('_a') ? a.milvus.describeCollection(req) : b.milvus.describeCollection(req),
    describeIndex: req => req.collection_name.endsWith('_a') ? a.milvus.describeIndex(req) : b.milvus.describeIndex(req),
    search: req => req.collection_name.endsWith('_a') ? a.milvus.search(req) : b.milvus.search(req) };
  const pending = retrievePublicationCorpus({ scope, query: 'source', topK: 1, strategy: 'keyword', pg, elasticsearch, milvus, embedding: async () => [0.25, 0.5] });
  await started; await checkedBeforeMutation; b.state.indexUuid = 'replaced'; release();
  await assert.rejects(pending, /identity/i);
  assert.deepEqual(counts, { a: 2, b: 2 });
});
