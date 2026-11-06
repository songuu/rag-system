import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsistencyLevelEnum, DataType } from '@zilliz/milvus2-sdk-node';

const api = await import('./milvus-publication-generation.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['trusted'], enforceIsolation: true };
const chunk = { documentId: 'doc', generation: 1, documentVersion: 'v1', trustLevel: 'trusted', chunkIndex: 0, content: 'data', embedding: [1, 0] };
function viewFor(input = chunk) {
  const row = api.createPublicationChunk(scope, input, 2);
  return api.createPublicationViewItem(scope, { documentId: input.documentId, generation: input.generation,
    documentVersion: input.documentVersion, chunks: [api.publicationManifestEntry(row)] });
}

test('append-only IDs bind the scope, generation and immutable payload including vectors', () => {
  const first = api.createPublicationChunk(scope, chunk, 2);
  const same = api.createPublicationChunk(scope, chunk, 2);
  const changedGeneration = api.createPublicationChunk(scope, { ...chunk, generation: 2 }, 2);
  const changedVector = api.createPublicationChunk(scope, { ...chunk, embedding: [0, 1] }, 2);
  assert.equal(first.id, same.id);
  assert.notEqual(first.id, changedGeneration.id);
  assert.notEqual(first.id, changedVector.id);
  assert.equal(first.publication_generation, 1);
});

test('insert uses append-only insert, never upsert, and ack is not verification', async () => {
  const calls = [];
  const client = { insert: async request => { calls.push(request); return { status: { error_code: 'Success' }, insert_cnt: 1 }; } };
  const adapter = new api.MilvusPublicationGenerationAdapter(client, 'publication_test', 2);
  const result = await adapter.insert(scope, [chunk]);
  assert.equal(calls.length, 1);
  assert.equal(result.verified, false);
  assert.equal(adapter.productionCapable, false);
});

test('frozen view uses paired identity filter before search limit without interpolation', async () => {
  let call;
  const client = { search: async request => { call = request; return { status: { error_code: 'Success' }, results: [] }; } };
  const adapter = new api.MilvusPublicationGenerationAdapter(client, 'publication_test', 2);
  await adapter.search(scope, [viewFor({ ...chunk, documentId: 'doc" || true' }), viewFor({ ...chunk, documentId: 'doc-2', generation: 2 })], [1, 0], 5);
  assert.match(call.filter, /\(document_id == \{document0\} && publication_generation == \{generation0\} && document_version == \{version0\} && id in \{chunkIds0\}\)/);
  assert.match(call.filter, /\(document_id == \{document1\} && publication_generation == \{generation1\} && document_version == \{version1\} && id in \{chunkIds1\}\)/);
  assert.equal(call.filter.includes('doc" || true'), false);
  assert.equal(call.exprValues.document0, 'doc" || true');
  assert.equal(call.exprValues.version0, 'v1');
  assert.deepEqual(call.exprValues.chunkIds0, [viewFor({ ...chunk, documentId: 'doc" || true' }).chunks[0].id]);
  assert.equal(call.limit, 5);
  assert.equal(call.consistency_level, ConsistencyLevelEnum.Strong);
});

test('view filter binds each version and trusted chunk list to its own document and generation', async () => {
  let call;
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async request => {
    call = request;
    return { status: { error_code: 'Success' }, results: [] };
  } }, 'publication_test', 2);
  const first = viewFor({ ...chunk, documentId: 'first', documentVersion: 'v1' });
  const second = viewFor({ ...chunk, documentId: 'second', generation: 2, documentVersion: 'v2' });
  await adapter.search(scope, [first, second], [1, 0], 1);
  assert.equal(call.exprValues.version0, 'v1');
  assert.equal(call.exprValues.version1, 'v2');
  assert.deepEqual(call.exprValues.chunkIds0, [first.chunks[0].id]);
  assert.deepEqual(call.exprValues.chunkIds1, [second.chunks[0].id]);
  assert.match(call.filter, /document_version == \{version0\} && id in \{chunkIds0\}/);
  assert.match(call.filter, /document_version == \{version1\} && id in \{chunkIds1\}/);
});

test('dedicated collection schema has generation and immutable primary key fields', () => {
  const schema = api.buildPublicationCollectionSchema('isolated_test', 2);
  assert.equal(schema.enable_dynamic_field, false);
  assert.ok(schema.fields.some(field => field.name === 'id' && field.is_primary_key && !field.autoID));
  assert.ok(schema.fields.some(field => field.name === 'publication_generation' && field.data_type === DataType.Int64));
  assert.ok(schema.fields.some(field => field.name === 'embedding' && field.dim === 2));
});

test('empty and oversized views fail closed without issuing provider calls', async () => {
  let calls = 0;
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async () => { calls++; } }, 'publication_test', 2);
  assert.deepEqual(await adapter.search(scope, [], [1, 0], 5), []);
  await assert.rejects(adapter.search(scope, Array.from({length: 257}, (_, i) => ({ documentId: `d${i}`, generation: 1 })), [1, 0], 5), /capacity/);
  assert.equal(calls, 0);
});

test('oversized filter parameters fail before contacting Milvus', async () => {
  let calls = 0;
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async () => { calls++; } }, 'publication_test', 2);
  const views = Array.from({ length: 200 }, (_, documentIndex) => {
    const documentId = `${String(documentIndex).padStart(4, '0')}${'d'.repeat(220)}`;
    const chunks = Array.from({ length: 20 }, (_, chunkIndex) => {
      const digest = (documentIndex * 20 + chunkIndex).toString(16).padStart(64, '0');
      return { id: `pub:${digest}`, payloadDigest: digest, contentDigest: 'a'.repeat(64), chunkIndex, trustLevel: 'trusted' };
    });
    return api.createPublicationViewItem(scope, { documentId, generation: 1, documentVersion: 'v'.repeat(240), chunks });
  });
  await assert.rejects(adapter.search(scope, views, [1, 0], 5), /capacity/);
  assert.equal(calls, 0);
});

test('search rejects returned hits from another scope or unselected generation', async () => {
  const row = api.createPublicationChunk(scope, chunk, 2);
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async () => ({ status: { error_code: 'Success' }, results: [{ ...row, publication_generation: 2, score: 1 }] }) }, 'publication_test', 2);
  await assert.rejects(adapter.search(scope, [viewFor()], [1, 0], 5), /outside/);
});

test('duplicate results and conflicting payloads at a chunk slot fail closed', async () => {
  const row = api.createPublicationChunk(scope, chunk, 2);
  const other = api.createPublicationChunk(scope, { ...chunk, embedding: [0, 1] }, 2);
  let results = [row, row];
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async () => ({ status: { error_code: 'Success' }, results }) }, 'publication_test', 2);
  await assert.rejects(adapter.search(scope, [viewFor()], [1, 0], 5), /duplicate/);
  results = [row, other];
  await assert.rejects(adapter.search(scope, [viewFor()], [1, 0], 5), /manifest|duplicate/);
  await assert.rejects(adapter.insert(scope, [chunk, chunk]), /Duplicate/);
});

test('rejects changed content, version, trust and an unknown chunk even if provider repeats its own digest', async () => {
  const row = api.createPublicationChunk(scope, chunk, 2);
  let hit = row;
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async () => ({ status: { error_code: 'Success' }, results: [hit] }) }, 'publication_test', 2);
  const view = viewFor();
  for (const altered of [{ content: 'tampered' }, { document_version: 'v2' }, { trust_level: 'external' }, { publication_generation: true },
    { publication_generation: '01' }, { chunk_index: 1 },
    { chunk_index: null }, { chunk_index: '' }]) {
    hit = { ...row, ...altered };
    await assert.rejects(adapter.search(scope, [view], [1, 0], 5));
  }
  const other = api.createPublicationChunk(scope, { ...chunk, content: 'different', chunkIndex: 1 }, 2);
  hit = other;
  await assert.rejects(adapter.search(scope, [view], [1, 0], 5), /manifest/);
});

test('rejects a changed manifest and mixed document versions within a write batch', async () => {
  let calls = 0;
  const adapter = new api.MilvusPublicationGenerationAdapter({ search: async () => { calls++; }, insert: async () => { calls++; } }, 'publication_test', 2);
  const view = viewFor();
  await assert.rejects(adapter.search(scope, [{ ...view, documentVersion: 'v2' }], [1, 0], 5), /manifest/);
  await assert.rejects(adapter.search(scope, [{ ...view, chunks: [{ ...view.chunks[0], contentDigest: '0'.repeat(64) }] }], [1, 0], 5), /manifest/);
  await assert.rejects(adapter.insert(scope, [chunk, { ...chunk, chunkIndex: 1, documentVersion: 'v2' }]), /version/);
  assert.equal(calls, 0);
});

test('rejects sparse, inherited or accessor vector elements before backend IO', async () => {
  let calls = 0;
  const adapter = new api.MilvusPublicationGenerationAdapter({
    insert: async () => { calls++; }, search: async () => { calls++; },
  }, 'publication_test', 2);
  const sparse = Array(2);
  const inherited = [1, 0];
  delete inherited[1];
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 1: 0 }));
  const accessor = [1, 0];
  Object.defineProperty(accessor, '1', { get: () => 0 });
  for (const vector of [sparse, inherited, accessor]) {
    await assert.rejects(adapter.insert(scope, [{ ...chunk, embedding: vector }]), /vector/);
    await assert.rejects(adapter.search(scope, [viewFor()], vector, 5), /vector/);
  }
  assert.equal(calls, 0);
});
