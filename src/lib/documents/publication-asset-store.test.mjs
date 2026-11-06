import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { preparePublicationAsset, PostgresPublicationAssetStore } = await import('./publication-asset-store.ts');

function fixture() {
  return {
    tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a',
    sourceBytes: Buffer.from('raw source'), sourceIdentityBytes: Buffer.from('parsed text'),
    originalName: 'a.pdf', contentType: 'application/pdf', sourceKind: 'pdf',
    embedding: { model: 'model-a', revision: 'r1', dimension: 2, indexSchema: 'index-v1' },
    splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
    chunks: [{ chunkIndex: 0, content: 'sample content', trustLevel: 'external',
      startOffset: 0, endOffset: 14, embedding: [0.25, -0.5] }],
  };
}

test('preparation is deterministic and binds source identity, original bytes and index parameters', () => {
  const input = fixture();
  const prepared = preparePublicationAsset(input);
  assert.match(prepared.contentVersion, /^sha256:[a-f0-9]{64}$/);
  assert.match(prepared.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(prepared.manifestDigest, preparePublicationAsset(fixture()).manifestDigest);
  for (const mutate of [
    value => { value.sourceBytes = Buffer.from('different'); },
    value => { value.sourceIdentityBytes = Buffer.from('different'); },
    value => { value.embedding.model = 'model-b'; },
    value => { value.embedding.revision = 'r2'; },
    value => { value.embedding.indexSchema = 'index-v2'; },
    value => { value.splitter.chunkOverlap = 10; },
    value => { value.chunks[0].content = 'other'; },
    value => { value.chunks[0].embedding[0] = 0.75; },
    value => { value.chunks[0].source = 'another-source.pdf'; },
    value => { value.chunks[0].page = 2; },
    value => { value.chunks[0].metadata = { title: 'other' }; },
  ]) {
    const changed = fixture(); mutate(changed);
    assert.notEqual(preparePublicationAsset(changed).manifestDigest, prepared.manifestDigest);
  }
});

test('source buffers are copied and invalid vector or chunk identity fails before database I/O', async () => {
  const input = fixture();
  const prepared = preparePublicationAsset(input);
  input.sourceBytes[0] = 0;
  assert.notEqual(prepared.sourceBytes[0], 0);
  for (const invalid of [
    value => { value.chunks[0].embedding = Array(2); },
    value => { value.chunks[0].embedding = [Number.NaN, 0]; },
    value => { value.chunks.push({ ...value.chunks[0] }); },
    value => { value.chunks[0].trustLevel = 'invalid'; },
    value => { value.chunks[0].endOffset = -1; },
  ]) {
    const value = fixture(); invalid(value);
    assert.throws(() => preparePublicationAsset(value));
  }
  let calls = 0;
  const store = new PostgresPublicationAssetStore({ query: async () => { calls++; return { rows: [{ stored: true }], rowCount: 1 }; } });
  await assert.rejects(store.stage({ tenantId: 'tenant-b', corpusId: 'corpus-a', documentId: 'document-a', generation: '1', revision: '1',
    manifestDigest: prepared.manifestDigest, physicalCollection: 'rag_publication_a', leaseToken: '00000000-0000-4000-8000-000000000001' }, prepared));
  assert.equal(calls, 0);
});

test('manifest accommodates 1000 chunks with repeated long sources within explicit byte bounds', () => {
  const input = fixture();
  input.chunks = Array.from({ length: 1000 }, (_, chunkIndex) => ({
    chunkIndex, content: `chunk ${chunkIndex}`, trustLevel: 'external',
    source: `https://example.test/${'a'.repeat(4800)}`, embedding: [0.25, -0.5],
  }));
  const asset = preparePublicationAsset(input);
  assert.equal(JSON.parse(asset.manifestJson).chunks.length, 1000);
  assert.ok(Buffer.byteLength(asset.manifestJson, 'utf8') < 256 * 1024);
  assert.ok(Buffer.byteLength(asset.chunksJson, 'utf8') < 12 * 1024 * 1024);
  const tooMany = fixture();
  tooMany.chunks = Array.from({ length: 1001 }, (_, chunkIndex) => ({
    chunkIndex, content: 'chunk', trustLevel: 'external', embedding: [0.25, -0.5],
  }));
  assert.throws(() => preparePublicationAsset(tooMany), /manifest capacity exceeded/i);
});

test('staging uses parameterized CAS and rejects changed manifest or unaccepted database result', async () => {
  const prepared = preparePublicationAsset(fixture());
  const attempt = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a', generation: '1', revision: '1',
    manifestDigest: prepared.manifestDigest, physicalCollection: 'rag_publication_a', leaseToken: '00000000-0000-4000-8000-000000000001' };
  const calls = [];
  const store = new PostgresPublicationAssetStore({ query: async (sql, values) => {
    calls.push({ sql, values }); return { rows: [{ stored: true }], rowCount: 1 };
  } });
  await store.stage(attempt, prepared);
  assert.match(calls[0].sql, /rag_stage_publication_asset/);
  assert.deepEqual(calls[0].values.slice(0, 3), ['tenant-a', 'corpus-a', 'document-a']);
  assert.doesNotMatch(calls[0].sql, /tenant-a/);
  await assert.rejects(store.stage({ ...attempt, manifestDigest: 'sha256:' + 'f'.repeat(64) }, prepared));
  const failing = new PostgresPublicationAssetStore({ query: async () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(failing.stage(attempt, prepared));
});

test('staged read requires the fenced attempt and checks retained chunk payloads against the root manifest', async () => {
  const prepared = preparePublicationAsset(fixture());
  const attempt = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a', generation: '1', revision: '1',
    manifestDigest: prepared.manifestDigest, physicalCollection: 'rag_publication_a', leaseToken: '00000000-0000-4000-8000-000000000001' };
  const calls = [];
  const row = { content_version: prepared.contentVersion, manifest_digest: prepared.manifestDigest,
    manifest_json: prepared.manifestJson, source_bytes: prepared.sourceBytes, source_identity_bytes: prepared.sourceIdentityBytes,
    chunks_json: JSON.parse(prepared.chunksJson) };
  const store = new PostgresPublicationAssetStore({ query: async (sql, values) => {
    calls.push({ sql, values }); return { rows: [row], rowCount: 1 };
  } });
  const loaded = await store.readStaged(attempt);
  assert.equal(loaded.manifestDigest, prepared.manifestDigest);
  assert.match(calls[0].sql, /rag_read_staged_publication_asset/);
  const changed = JSON.parse(prepared.chunksJson);
  changed[0].content = 'forged';
  const corrupted = new PostgresPublicationAssetStore({ query: async () => ({ rows: [{ ...row, chunks_json: changed }], rowCount: 1 }) });
  await assert.rejects(corrupted.readStaged(attempt));
});
