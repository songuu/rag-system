import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { buildGenerationLexicalMapping, writeGenerationDocuments, deleteGenerationDocuments,
  searchGenerationDocuments, observeGenerationDocuments, generationDocumentDigest, getPitCleanupDiagnostic } = await import('./generation-index.ts');
const scope = { tenantId: 'tenant', corpusId: 'corpus', allowedTrustLevels: ['reviewed'], enforceIsolation: true };
const identity = { tenantId: 'tenant', corpusId: 'corpus', documentId: 'doc', generation: '12', documentVersion: 'v1' };
const doc = { chunk_id: 'chunk', tenant_id: 'tenant', corpus_id: 'corpus', document_id: 'doc',
  document_version: 'v1', trust_level: 'reviewed', content: '测试关键字', metadata: {} };

test('dedicated mapping indexes generation without changing the legacy mapping', () => {
  assert.equal(buildGenerationLexicalMapping().mappings.properties.publication_generation.type, 'keyword');
});

test('writes use immutable scoped IDs and never delete an older generation', async () => {
  const calls = [];
  const client = { async bulk(input) { calls.push(input); return { errors: false, items: [{ create: { status: 201 } }] }; } };
  await writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] });
  await writeGenerationDocuments({ client, indexName: 'generation_index', identity: { ...identity, generation: '13' }, documents: [doc] });
  assert.equal(calls[0].operations[0].create._id.length, 64);
  assert.notEqual(calls[0].operations[0].create._id, calls[1].operations[0].create._id);
  assert.equal(calls[0].operations[1].publication_generation, '12');
  assert.equal(calls[0].refresh, false);
  await assert.rejects(writeGenerationDocuments({ client, indexName: 'generation_index', identity,
    documents: [{ ...doc, tenant_id: 'other' }] }));
});

test('a generation cannot contain chunks from different document versions', async () => {
  let calls = 0;
  const client = { async bulk() { calls++; return { errors: false, items: [] }; } };
  await assert.rejects(writeGenerationDocuments({ client, indexName: 'generation_index', identity,
    documents: [doc, { ...doc, chunk_id: 'chunk-2', document_version: 'v2' }] }));
  assert.equal(calls, 0);
});

test('generation deletion is scoped to the exact document generation', async () => {
  let request;
  await deleteGenerationDocuments({ client: { async deleteByQuery(value) { request = value; return { timed_out: false, version_conflicts: 0, failures: [] }; } },
    indexName: 'generation_index', identity });
  assert.deepEqual(request.query.bool.filter, [
    { term: { tenant_id: 'tenant' } }, { term: { corpus_id: 'corpus' } },
    { term: { document_id: 'doc' } }, { term: { publication_generation: '12' } },
  ]);
});

test('search filters matching pairs before topK and rejects cross-pair hits', async () => {
  let request;
  const client = { async search(value) { request = value; return { timed_out: false, _shards: { failed: 0 }, hits: { hits: [] } }; } };
  const pairs = [{ documentId: 'a', generation: '1', documentVersion: 'v1', chunks: [{ chunkId: 'ca', digest: '0'.repeat(64) }] },
    { documentId: 'b', generation: '2', documentVersion: 'v1', chunks: [{ chunkId: 'cb', digest: '0'.repeat(64) }] }];
  await searchGenerationDocuments({ client, indexName: 'generation_index', scope, pairs, query: '测试', topK: 2 });
  assert.equal(request.size, 2);
  assert.deepEqual(request.query.bool.filter.at(-1), { bool: { should: pairs.map(pair => ({ bool: { filter: [
    { term: { document_id: pair.documentId } }, { term: { publication_generation: pair.generation } },
    { term: { document_version: pair.documentVersion } }, { terms: { chunk_id: pair.chunks.map(chunk => chunk.chunkId) } },
  ] } })), minimum_should_match: 1 } });
  client.search = async () => ({ timed_out: false, _shards: { failed: 0 }, hits: { hits: [{ _id: 'x', _score: 1, _source: { ...doc,
    document_id: 'a', publication_generation: '2' } }] } });
  await assert.rejects(searchGenerationDocuments({ client, indexName: 'generation_index', scope, pairs, query: '测试', topK: 2 }));
});

test('readback refreshes and compares complete actual generation against the expected manifest', async () => {
  const writes = [];
  const client = {
    async bulk(value) { writes.push(value); return { errors: false, items: [{ create: { status: 201 } }] }; },
    indices: { async refresh() { writes.push('refresh'); return { _shards: { failed: 0 } }; } },
    async openPointInTime() { return { id: 'pit-initial' }; },
    async closePointInTime() { return { succeeded: true }; },
    async search() { return { pit_id: 'pit-rotated', timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 1, relation: 'eq' }, hits: [{
      _id: writes[0].operations[0].create._id, _source: writes[0].operations[1], sort: ['chunk', 0],
    }] } }; },
  };
  await writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] });
  const result = await observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] });
  assert.equal(result.count, 1);
  assert.equal(result.kind, 'point-in-time-observation');
  assert.equal(writes[1], 'refresh');
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity,
    documents: [{ ...doc, content: '不一致' }] }));
});

test('readback pages through the entire generation using only required source fields', async () => {
  let operations;
  const calls = [];
  const documents = Array.from({ length: 17 }, (_, i) => ({ ...doc, chunk_id: `chunk-${String(i).padStart(2, '0')}` }));
  const client = {
    async bulk(value) { operations = value.operations; return { errors: false, items: documents.map(() => ({ create: { status: 201 } })) }; },
    indices: { async refresh() { return { _shards: { failed: 0 } }; } },
    async openPointInTime() { return { id: 'pit-initial' }; },
    async closePointInTime() { return { succeeded: true }; },
    async search(value) {
      calls.push(value);
      const start = value.search_after ? 16 : 0;
      const hits = documents.slice(start, start + 16).map((item, offset) => ({
        _id: operations[(start + offset) * 2].create._id,
        _source: operations[(start + offset) * 2 + 1], sort: [item.chunk_id, start + offset],
      }));
      return { pit_id: 'pit-rotated', timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 17, relation: 'eq' }, hits } };
    },
  };
  await writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents });
  const result = await observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents });
  assert.equal(result.count, 17);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].size, 16);
  assert.deepEqual(calls[1].search_after, ['chunk-15', 15]);
  assert.ok(calls[0]._source.includes('publication_generation'));
});

test('existing IDs are conflicts, never proof that stored content matches', async () => {
  const client = { async bulk() { return { errors: true, items: [{ create: { status: 409 } }] }; } };
  assert.deepEqual(await writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] }),
    { attempted: 1, conflicts: 1 });
  client.bulk = async () => ({ errors: true, items: [{ create: { status: 429 } }] });
  await assert.rejects(writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] }));
});

test('rejects incomplete searches and ambiguous or over-capacity views before IO', async () => {
  let calls = 0;
  const client = { async search() { calls++; return { timed_out: true, _shards: { failed: 0 }, hits: { hits: [] } }; } };
  const base = { client, indexName: 'generation_index', scope, query: '测试', topK: 2 };
  const pair = (documentId, generation = '1') => ({ documentId, generation, documentVersion: 'v1', chunks: [{ chunkId: 'c', digest: '0'.repeat(64) }] });
  await assert.rejects(searchGenerationDocuments({ ...base, pairs: [pair('a')] }));
  await assert.rejects(searchGenerationDocuments({ ...base, pairs: [pair('a'), pair('a', '2')] }));
  await assert.rejects(searchGenerationDocuments({ ...base, pairs: Array.from({ length: 129 }, (_, i) => pair(`d${i}`)) }));
  assert.equal(calls, 1);
});

test('the bounded 128-document view is accepted without truncation', async () => {
  let request;
  const client = { async search(value) { request = value; return { timed_out: false, _shards: { failed: 0 }, hits: { hits: [] } }; } };
  const pairs = Array.from({ length: 128 }, (_, i) => ({ documentId: `d${i}`, generation: '1', documentVersion: 'v1',
    chunks: [{ chunkId: 'c', digest: '0'.repeat(64) }] }));
  await searchGenerationDocuments({ client, indexName: 'generation_index', scope, query: '测试', topK: 2, pairs });
  assert.equal(request.query.bool.filter.at(-1).bool.should.length, pairs.length);
});

test('generation writes reject excess serialized UTF-8 bytes before any IO', async () => {
  let calls = 0;
  const client = { async bulk() { calls++; return {}; } };
  const documents = Array.from({ length: 50 }, (_, i) => ({ ...doc, chunk_id: `chunk-${i}`, content: '好'.repeat(30_000) }));
  await assert.rejects(writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents }),
    /serialized byte budget/);
  assert.equal(calls, 0);
});

test('bulk operation metadata is included in the write byte budget', async () => {
  let calls = 0;
  const client = { async bulk() { calls++; return {}; } };
  const documents = Array.from({ length: 1_000 }, (_, i) => ({ ...doc, chunk_id: `chunk-${i}`, content: 'a'.repeat(3_950) }));
  await assert.rejects(writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents }),
    /bulk serialized byte budget/);
  assert.equal(calls, 0);
});

test('readback rejects excess serialized UTF-8 bytes in the actual response', async () => {
  const documents = Array.from({ length: 50 }, (_, i) => ({ ...doc, chunk_id: `chunk-${i}` }));
  const client = {
    indices: { async refresh() { return { _shards: { failed: 0 } }; } },
    async openPointInTime() { return { id: 'pit-initial' }; },
    async closePointInTime() { return { succeeded: true }; },
    async search(query) { const start = query.search_after ? Number(query.search_after[0].split('-')[1]) + 1 : 0;
      return { pit_id: 'pit-rotated', timed_out: false, _shards: { failed: 0 }, hits: {
      total: { value: 50, relation: 'eq' }, hits: documents.slice(start, start + 16).map((item, offset) => ({
        _id: `id-${start + offset}`, sort: [item.chunk_id, start + offset], _source: { ...item, content: '好'.repeat(30_000), publication_generation: '12' },
      })),
    } }; },
  };
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents }),
    /result byte budget/);
});

test('PIT snapshots the pages, tracks rotated IDs and is closed after success or failure', async () => {
  const documents = Array.from({ length: 17 }, (_, i) => ({ ...doc, chunk_id: `chunk-${String(i).padStart(2, '0')}` }));
  let operations;
  let current = [];
  let snapshot = [];
  const calls = [];
  const client = {
    async bulk(input) { operations = input.operations; current = documents.map((item, i) => ({
      _id: operations[i * 2].create._id, _source: operations[i * 2 + 1], sort: [item.chunk_id, i],
    })); return { errors: false, items: documents.map(() => ({ create: { status: 201 } })) }; },
    indices: { async refresh() { return { _shards: { failed: 0 } }; } },
    async openPointInTime(value) { calls.push(['open', value]); snapshot = [...current]; return { id: 'pit-0' }; },
    async closePointInTime(value) { calls.push(['close', value]); return { succeeded: true }; },
    async search(value) { calls.push(['search', value]);
      const start = value.search_after ? 16 : 0;
      if (!start) current = []; // mutation after PIT opening cannot change its view
      return { pit_id: start ? 'pit-2' : 'pit-1', timed_out: false, _shards: { failed: 0 },
        hits: { total: { value: snapshot.length, relation: 'eq' }, hits: snapshot.slice(start, start + 16) } };
    },
  };
  await writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents });
  assert.equal((await observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents })).count, 17);
  assert.equal(calls[1][1].pit.id, 'pit-0');
  assert.equal(calls[2][1].pit.id, 'pit-1');
  assert.deepEqual(calls[3], ['close', { id: 'pit-2' }]);
  current = snapshot;
  client.search = async () => { throw new Error('PIT expired'); };
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents }), /PIT expired/);
  assert.deepEqual(calls.at(-1), ['close', { id: 'pit-0' }]);
});

test('PIT open and close failures cannot authorize observation', async () => {
  const client = {
    indices: { async refresh() { return { _shards: { failed: 0 } }; } },
    async openPointInTime() { throw new Error('PIT unavailable'); },
    async closePointInTime() { throw new Error('unexpected close'); },
    async search() { throw new Error('unexpected search'); },
  };
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] }), /PIT unavailable/);
  let operations;
  client.bulk = async value => { operations = value.operations; return { errors: false, items: [{ create: { status: 201 } }] }; };
  await writeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] });
  client.openPointInTime = async () => ({ id: 'pit-open' });
  client.closePointInTime = async () => ({ succeeded: false });
  client.search = async () => ({ pit_id: 'pit-rotated', timed_out: false, _shards: { failed: 0 },
    hits: { total: { value: 1, relation: 'eq' }, hits: [{ _id: operations[0].create._id,
      _source: operations[1], sort: ['chunk', 0] }] } });
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] }), /close failed/);
});

test('PIT cleanup failure preserves a primary abort and attaches a redacted diagnostic', async () => {
  const abort = Object.assign(new Error('query aborted'), { name: 'AbortError' });
  const client = {
    indices: { async refresh() { return { _shards: { failed: 0 } }; } },
    async openPointInTime() { return { id: 'pit-open' }; },
    async closePointInTime() { throw new Error('sensitive cleanup details'); },
    async search() { throw abort; },
  };
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity, documents: [doc] }),
    error => error === abort && error.name === 'AbortError'
      && error.pitCleanupDiagnostic === 'Generation point-in-time close failed.');
  assert.equal(JSON.stringify(abort).includes('sensitive'), false);
});

test('PIT cleanup diagnostic can be reported even when the primary error is frozen', async () => {
  const primary = Object.freeze(new Error('query timed out'));
  const client = {
    indices: { async refresh() { return { _shards: { failed: 0 } }; } },
    async openPointInTime() { return { id: 'pit-open' }; },
    async closePointInTime() { return { succeeded: false }; },
    async search() { throw primary; },
  };
  await assert.rejects(observeGenerationDocuments({ client, indexName: 'generation_index', identity,
    documents: [doc] }), error => error === primary);
  assert.equal(getPitCleanupDiagnostic(primary), 'Generation point-in-time close failed.');
});

test('generation search rejects limits above 100 before requesting a buffered ES response', async () => {
  let called = false;
  const client = { async search() { called = true; return {}; } };
  const pairs = [{ documentId: 'doc', generation: '12', documentVersion: 'v1',
    chunks: [{ chunkId: 'chunk', digest: '0'.repeat(64) }] }];
  await assert.rejects(searchGenerationDocuments({ client, indexName: 'generation_index', scope, query: '测试', topK: 101, pairs }));
  assert.equal(called, false);
});

test('cross-batch generation collisions cannot pass the authorized version and manifest', async () => {
  const operations = [];
  const writer = { async bulk(input) { operations.push(input.operations); return { errors: false, items: [{ create: { status: 201 } }] }; } };
  await writeGenerationDocuments({ client: writer, indexName: 'generation_index', identity, documents: [doc] });
  await writeGenerationDocuments({ client: writer, indexName: 'generation_index', identity: { ...identity, documentVersion: 'v2' },
    documents: [{ ...doc, chunk_id: 'late', document_version: 'v2' }] });
  const pair = { documentId: 'doc', generation: '12', documentVersion: 'v1',
    chunks: [{ chunkId: 'chunk', digest: generationDocumentDigest(operations[0][1]) }] };
  const client = { async search() { return { timed_out: false, _shards: { failed: 0 }, hits: { hits: [{
    _id: operations[1][0].create._id, _score: 1, _source: operations[1][1],
  }] } }; } };
  await assert.rejects(searchGenerationDocuments({ client, indexName: 'generation_index', scope, pairs: [pair], query: '测试', topK: 2 }));
  client.search = async () => ({ timed_out: false, _shards: { failed: 0 }, hits: { hits: [{
    _id: operations[0][0].create._id, _score: 1, _source: { ...operations[0][1], content: 'tampered' },
  }] } });
  await assert.rejects(searchGenerationDocuments({ client, indexName: 'generation_index', scope, pairs: [pair], query: '测试', topK: 2 }));
  client.search = async () => ({ timed_out: false, _shards: { failed: 0 }, hits: { hits: [{
    _id: operations[0][0].create._id, _score: 1, _source: operations[0][1],
  }] } });
  assert.equal((await searchGenerationDocuments({ client, indexName: 'generation_index', scope, pairs: [pair], query: '测试', topK: 2 })).length, 1);
});


test('search accepts the 4096-chunk view but rejects larger or oversized generations before IO', async () => {
  let calls = 0; let request;
  const client = { async search(input) { calls++; request = input; return { timed_out: false, _shards: { failed: 0 }, hits: { hits: [] } }; } };
  const pairs = Array.from({ length: 5 }, (_, d) => ({ documentId: `doc-${d}`, generation: '1', documentVersion: 'v1',
    chunks: Array.from({ length: d === 4 ? 96 : 1000 }, (_, i) => ({ chunkId: `chunk-${i}`, digest: '0'.repeat(64) })) }));
  const base = { client, indexName: 'generation_index', scope, query: 'search', topK: 1 };
  await searchGenerationDocuments({ ...base, pairs });
  assert.equal(calls, 1);
  assert.equal(request.query.bool.filter.at(-1).bool.should.reduce((n, item) => n + item.bool.filter.at(-1).terms.chunk_id.length, 0), 4096);
  const tooMany = structuredClone(pairs); tooMany[4].chunks.push({ chunkId: 'overflow', digest: '0'.repeat(64) });
  await assert.rejects(searchGenerationDocuments({ ...base, pairs: tooMany }), /capacity/i);
  const tooLarge = structuredClone(pairs.slice(0, 1)); tooLarge[0].chunks.push({ chunkId: 'overflow', digest: '0'.repeat(64) });
  await assert.rejects(searchGenerationDocuments({ ...base, pairs: tooLarge }), /chunk|capacity/i);
  assert.equal(calls, 1);
});
