import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { verifyRuntimeMilvusReadback } = await import('./publication-runtime-publisher-milvus.ts');
const { createPublicationChunk } = await import('./milvus-publication-generation.ts');
const collection = `rag_publication_${'a'.repeat(32)}`;
const scope = { tenantId: 'tenant', corpusId: 'corpus', enforceIsolation: true, allowedTrustLevels: ['trusted'] };
const row = createPublicationChunk(scope, { documentId: 'doc', documentVersion: 'v1', generation: 1,
  trustLevel: 'trusted', chunkIndex: 0, content: 'original', embedding: [0.5, 1] }, 2);

function fixture(overrides = {}) {
  let calls = 0;
  const client = { config: { maxRetries: 0 }, channelOptions: { 'grpc.enable_retries': 0 }, isGlobal: false, channelPool: {},
    async describeCollection() { return { status: { error_code: 'Success', code: 0 }, collection_name: collection,
      collectionID: '123', schema: { name: collection, fields: [] } }; },
    async query(request) { calls++; if (request.output_fields[0] === 'count(*)') return { status: { error_code: 'Success', code: 0 }, data: [{ 'count(*)': 1 }] };
      return { status: { error_code: 'Success', code: 0 }, data: calls === 2 ? [row] : [] }; }, ...overrides };
  return { client, get calls() { return calls; } };
}

test('strong readback verifies identity, actual vectors and all stored chunks', async () => {
  const f = fixture();
  const result = await verifyRuntimeMilvusReadback({ client: f.client, collection, expectedRows: [row],
    async assertLease() {}, timeoutMs: 100 });
  assert.equal(result.collectionId, '123');
  assert.match(result.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.kind, 'strong-multiread');
  assert.equal(result.productionAuthorized, false);
});

test('rejects any retry-capable client before querying the backend', async () => {
  for (const override of [{ config: { maxRetries: 1 } }, { isGlobal: true },
    { channelOptions: { 'grpc.enable_retries': 1 } }, { channelPool: { __failoverHandler() {} } }]) {
    const f = fixture(override);
    await assert.rejects(verifyRuntimeMilvusReadback({ client: f.client, collection, expectedRows: [row],
      async assertLease() {}, timeoutMs: 100 }));
    assert.equal(f.calls, 0);
  }
});

test('rejects tampered vectors, duplicate data and collection replacement', async () => {
  for (const altered of [{ ...row, embedding: [0.4, 1] }, { ...row, document_version: 'v2' },
    { ...row, embedding: Array(2) }]) {
    let count = 0;
    const f = fixture({ async query(request) { if (request.output_fields[0] === 'count(*)') return { status: { error_code: 'Success', code: 0 }, data: [{ 'count(*)': 1 }] };
      return { status: { error_code: 'Success', code: 0 }, data: count++ ? [] : [altered] }; } });
    await assert.rejects(verifyRuntimeMilvusReadback({ client: f.client, collection, expectedRows: [row],
      async assertLease() {}, timeoutMs: 100 }));
  }
  let descriptions = 0;
  const f = fixture({ async describeCollection() { return { status: { error_code: 'Success', code: 0 }, collection_name: collection,
    collectionID: ++descriptions === 1 ? '123' : '456', schema: { name: collection, fields: [] } }; } });
  await assert.rejects(verifyRuntimeMilvusReadback({ client: f.client, collection, expectedRows: [row],
    async assertLease() {}, timeoutMs: 100 }));
});
