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
const { readPublicationView, assertPublicationViewCurrent } = await import('./publication-view.ts');
const { preparePublicationAsset } = await import('./publication-asset-store.ts');
const { createPublicationChunk, publicationManifestEntry } = await import('./milvus-publication-generation.ts');
const { generationDocumentDigest } = await import('../elasticsearch/generation-index.ts');
const { canonicalJson } = await import('../rag/eval/canonical-json.ts');

const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true, allowedTrustLevels: ['external'] };
const client = result => ({ query: async () => ({ rows: [{ view: result }], rowCount: 1 }) });
const digest = `sha256:${'a'.repeat(64)}`;
function fixture() {
  const prepared = preparePublicationAsset({ tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a',
    sourceBytes: Buffer.from('source'), sourceIdentityBytes: Buffer.from('source'),
    originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
    embedding: { model: 'test', revision: '1', dimension: 2, indexSchema: 'v1' },
    splitter: { name: 'test', revision: '1', chunkSize: 10, chunkOverlap: 0 },
    chunks: [{ chunkIndex: 0, content: 'source', trustLevel: 'external', source: 'a.txt',
      startOffset: 0, endOffset: 6, metadata: { source: 'a.txt' }, embedding: [0.25, 0.5] }] });
  const chunk = createPublicationChunk(scope, { documentId: 'doc-a', generation: 1, documentVersion: prepared.contentVersion,
    chunkIndex: 0, content: 'source', trustLevel: 'external', embedding: [0.25, 0.5] }, 2);
  const entry = publicationManifestEntry(chunk);
  const lexical = { chunk_id: chunk.id, tenant_id: 'tenant-a', corpus_id: 'corpus-a', document_id: 'doc-a',
    document_version: prepared.contentVersion, publication_generation: '1', trust_level: 'external', content: 'source',
    source: 'a.txt', start_offset: 0, end_offset: 6, metadata: { source: 'a.txt' } };
  const descriptorDigest = JSON.parse(prepared.manifestJson).chunks[0].descriptorDigest;
  const milvusManifestJson = `[${canonicalJson({ ...entry, chunkId: entry.id, descriptorDigest })}]`;
  const elasticsearchManifestJson = `[${canonicalJson({ chunkIndex: 0, chunkId: chunk.id, digest: generationDocumentDigest(lexical), descriptorDigest })}]`;
  const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const doc = { documentId: 'doc-a', generation: '1', revision: '1', assetId: '00000000-0000-0000-0000-000000000001', assetRevision: '4',
    contentVersion: prepared.contentVersion, manifestDigest: prepared.manifestDigest,
    manifestJson: prepared.manifestJson, descriptors: JSON.parse(prepared.chunksJson).map(chunk => chunk.descriptorJson),
    milvusManifestJson, milvusManifestDigest: hash(milvusManifestJson),
    elasticsearchManifestJson, elasticsearchManifestDigest: hash(elasticsearchManifestJson),
    collection: 'rag_publication_a', collectionId: '100', milvusConfigurationDigest: digest, milvusEvidenceDigest: digest, milvusVerifiedAt: '2026-01-01T00:00:00Z',
    indexName: `codex-generation-seal-${'a'.repeat(32)}`, indexUuid: 'uuid_1', ownerMarker: 'a'.repeat(64),
    elasticsearchConfigurationDigest: digest, elasticsearchEvidenceDigest: digest, elasticsearchVerifiedAt: '2026-01-01T00:00:00Z' };
  return { version: 1, tenantId: 'tenant-a', corpusId: 'corpus-a', documents: [doc] };
}

test('an empty, authoritatively published snapshot is immutable and can be revalidated', async () => {
  const db = client({ version: 1, tenantId: 'tenant-a', corpusId: 'corpus-a', documents: [] });
  const view = await readPublicationView(scope, db);
  assert.ok(Object.isFrozen(view));
  assert.deepEqual(view.documents, []);
  await assertPublicationViewCurrent(view, scope, db);
});

test('rejects forged views, wrong scope, and malformed or oversized snapshots', async () => {
  const empty = { version: 1, tenantId: 'tenant-a', corpusId: 'corpus-a', documents: [] };
  const view = await readPublicationView(scope, client(empty));
  await assert.rejects(assertPublicationViewCurrent({ ...view }, scope, client(empty)));
  await assert.rejects(readPublicationView({ ...scope, enforceIsolation: false }, client(empty)));
  await assert.rejects(readPublicationView(scope, client({ ...empty, tenantId: 'foreign' })));
  await assert.rejects(readPublicationView(scope, client({ ...empty, documents: Array(129).fill({}) })));
});

test('revocation or a new snapshot invalidates a previously issued view', async () => {
  const first = { version: 1, tenantId: 'tenant-a', corpusId: 'corpus-a', documents: [] };
  const view = await readPublicationView(scope, client(first));
  await assert.rejects(assertPublicationViewCurrent(view, { ...scope, allowedTrustLevels: ['trusted'] }, client(first)));
});

test('published snapshot creates real provider manifests and detects revision changes', async () => {
  const result = fixture();
  const view = await readPublicationView(scope, client(result));
  assert.equal(view.documents[0].milvus.chunks.length, 1);
  assert.equal(view.documents[0].elasticsearch.chunks[0].chunkId, view.documents[0].milvus.chunks[0].id);
  assert.deepEqual(view.documents[0].embedding, { model: 'test', revision: '1', dimension: 2, indexSchema: 'v1' });
  assert.ok(Object.isFrozen(view.documents[0].milvus.chunks));
  const next = structuredClone(result);
  next.documents[0].revision = '2';
  await assert.rejects(assertPublicationViewCurrent(view, scope, client(next)), /changed during retrieval/);
});

test('rejects unsupported embedding configuration even when the manifest is correctly signed', async () => {
  const raw = fixture();
  const manifest = JSON.parse(raw.documents[0].manifestJson);
  manifest.embedding.dimension = 0;
  raw.documents[0].manifestJson = canonicalJson(manifest);
  raw.documents[0].manifestDigest = `sha256:${createHash('sha256').update(raw.documents[0].manifestJson).digest('hex')}`;
  await assert.rejects(readPublicationView(scope, client(raw)), /embedding/i);
});

test('refuses tampered chunks and invalid resource identity before returning a view', async () => {
  const raw = fixture();
  raw.documents[0].descriptors[0] = raw.documents[0].descriptors[0].replace('external', 'trusted');
  await assert.rejects(readPublicationView(scope, client(raw)), /manifest/);
  const wrongIndex = fixture();
  wrongIndex.documents[0].indexUuid = '';
  await assert.rejects(readPublicationView(scope, client(wrongIndex)));
  const largeGeneration = fixture();
  largeGeneration.documents[0].generation = '9007199254740992';
  await assert.rejects(readPublicationView(scope, client(largeGeneration)), /capacity/);
});
