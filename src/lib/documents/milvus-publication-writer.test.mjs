import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { MilvusPublicationWriter } = await import('./milvus-publication-writer.ts');
const scope = { tenantId: 'tenant', corpusId: 'corpus', enforceIsolation: true, allowedTrustLevels: ['trusted'] };
const collection = 'rag_publication_0123456789abcdef0123456789abcdef';
const chunks = [
  { documentId: 'doc', documentVersion: 'v1', generation: 1, trustLevel: 'trusted', chunkIndex: 0, content: 'first', embedding: [1, 0] },
  { documentId: 'doc', documentVersion: 'v1', generation: 1, trustLevel: 'trusted', chunkIndex: 1, content: 'second', embedding: [0, 1] },
];
function fake() {
  let data = [];
  const calls = [];
  const client = {
    async hasCollection() { calls.push('exists'); return { status: { error_code: 'Success' }, value: false }; },
    async createCollection() { calls.push('create'); return { error_code: 'Success' }; },
    async createIndex() { calls.push('index'); return { error_code: 'Success' }; },
    async insert(request) { calls.push('insert'); data = request.data; return { status: { error_code: 'Success' }, insert_cnt: data.length }; },
    async flushSync() { calls.push('flush'); return { status: { error_code: 'Success' } }; },
    async loadCollectionSync() { calls.push('load'); return { error_code: 'Success' }; },
    async query(request) {
      calls.push(request.output_fields[0] === 'count(*)' ? 'count' : 'query');
      if (request.output_fields[0] === 'count(*)') return { status: { error_code: 'Success' }, data: [{ 'count(*)': data.length }] };
      return { status: { error_code: 'Success' }, data: data.filter(row => !(request.exprValues?.seenIds ?? []).includes(row.id)).slice(0, request.limit) };
    },
  };
  return { client, calls, mutate(fn) { data = fn(data); } };
}
function writer(client, checkLease = async () => true) {
  return new MilvusPublicationWriter({ client, collection, scope, dimension: 2, chunks, checkLease, timeoutMs: 5000 });
}
test('runs one write, reads back all stored vectors and content, and only emits a non-production observation', async () => {
  const f = fake(); const subject = writer(f.client);
  const value = await subject.observe();
  assert.equal(subject.productionCapable, false); assert.equal(value.productionAuthorized, false);
  assert.equal(value.kind, 'multi-read-observation'); assert.equal(value.count, 2);
  assert.equal(f.calls.filter(call => call === 'insert').length, 1);
  await assert.rejects(subject.observe(), /already consumed/i);
});
test('rejects tampered actual stored vector instead of trusting returned digest', async () => {
  const f = fake(); const original = f.client.insert;
  f.client.insert = async request => { const result = await original(request); f.mutate(rows => rows.map((row, i) => i ? row : { ...row, embedding: [0, 1] })); return result; };
  await assert.rejects(writer(f.client).observe(), /manifest/i);
});
for (const [field, malformed] of [
  ['publication_generation', true], ['publication_generation', ''], ['publication_generation', '01'],
  ['chunk_index', null], ['chunk_index', false], ['chunk_index', ''],
]) {
  test(`rejects malformed ${field} ${String(malformed)}`, async () => {
    const f = fake(); const original = f.client.query;
    f.client.query = async request => {
      const result = await original(request);
      if (request.output_fields[0] !== 'count(*)') result.data = result.data.map((row, index) => index ? row : { ...row, [field]: malformed });
      return result;
    };
    await assert.rejects(writer(f.client).observe(), /manifest/i);
  });
}
test('rejects sparse returned vectors instead of skipping missing elements', async () => {
  const f = fake(); const original = f.client.query;
  f.client.query = async request => {
    const result = await original(request);
    if (request.output_fields[0] !== 'count(*)') {
      const sparse = Array(2); sparse[1] = 0;
      result.data = result.data.map((row, index) => index ? row : { ...row, embedding: sparse });
    }
    return result;
  };
  await assert.rejects(writer(f.client).observe(), /manifest/i);
});
test('accepts canonical SDK integer strings and rejects malformed returned counts', async () => {
  const f = fake(); const query = f.client.query; const insert = f.client.insert;
  f.client.insert = async request => ({ ...await insert(request), insert_cnt: '2' });
  f.client.query = async request => {
    const result = await query(request);
    if (request.output_fields[0] === 'count(*)') return { ...result, data: [{ 'count(*)': '2' }] };
    return { ...result, data: result.data.map(row => ({ ...row, publication_generation: String(row.publication_generation), chunk_index: String(row.chunk_index) })) };
  };
  assert.equal((await writer(f.client).observe()).count, 2);

  const bad = fake(); const badQuery = bad.client.query;
  bad.client.query = async request => {
    const result = await badQuery(request);
    return request.output_fields[0] === 'count(*)' ? { ...result, data: [{ 'count(*)': '02' }] } : result;
  };
  await assert.rejects(writer(bad.client).observe(), /count mismatch/i);
});
test('rejects duplicate rows despite an identical primary key', async () => {
  const f = fake(); const original = f.client.insert;
  f.client.insert = async request => { const result = await original(request); f.mutate(rows => [...rows, rows[0]]); return result; };
  await assert.rejects(writer(f.client).observe(), /count|duplicate/i);
});
test('does not create or write a collection if its reserved name already exists', async () => {
  const f = fake(); f.client.hasCollection = async () => ({ status: { error_code: 'Success' }, value: true });
  await assert.rejects(writer(f.client).observe(), /already exists/i);
  assert.equal(f.calls.includes('insert'), false);
});
test('losing the lease after a write permanently abandons the attempt', async () => {
  const f = fake(); let checks = 0; const subject = writer(f.client, async () => ++checks < 8);
  await assert.rejects(subject.observe(), /lease/i);
  assert.equal(f.calls.includes('insert'), true);
  assert.equal(f.calls.includes('flush'), false);
  await assert.rejects(subject.observe(), /already consumed/i);
});
test('timeout abandons the writer even if the remote write later resolves', async () => {
  const f = fake(); let complete;
  f.client.insert = async () => new Promise(resolve => { complete = resolve; });
  const subject = new MilvusPublicationWriter({ client: f.client, collection, scope, dimension: 2, chunks, checkLease: async () => true, timeoutMs: 10 });
  await assert.rejects(subject.observe(), /timeout/i);
  complete({ status: { error_code: 'Success' }, insert_cnt: 2 });
  await assert.rejects(subject.observe(), /already consumed/i);
  assert.equal(f.calls.includes('flush'), false);
});
