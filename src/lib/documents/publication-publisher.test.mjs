import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { preparePublicationAsset } = await import('./publication-asset-store.ts');
const { materializePublicationManifests } = await import('./publication-publisher.ts');

function fixture() {
  return { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a',
    sourceBytes: Buffer.from('raw'), sourceIdentityBytes: Buffer.from('parsed'),
    originalName: 'a.pdf', contentType: 'application/pdf', sourceKind: 'pdf',
    embedding: { model: 'model', revision: 'r1', dimension: 2, indexSchema: 'v1' },
    splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
    chunks: [{ chunkIndex: 0, content: 'first chunk', trustLevel: 'external', source: 'a.pdf', page: 2,
      metadata: { title: 'sample' }, startOffset: 0, endOffset: 11, embedding: [0.25, -0.5] }] };
}
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true, allowedTrustLevels: ['external'] };

test('materializes both provider manifests from a validated immutable staged asset', () => {
  const asset = preparePublicationAsset(fixture());
  const identity = { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: 'document-a',
    generation: '7', revision: '8', manifestDigest: asset.manifestDigest,
    physicalCollection: 'rag_publication_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', leaseToken: '00000000-0000-4000-8000-000000000001' };
  const output = materializePublicationManifests(scope, identity, asset);
  assert.equal(output.productionAuthorized, false);
  assert.equal(output.rows.length, 1);
  assert.equal(output.milvus[0].id, output.elasticsearch[0].chunkId);
  assert.equal(output.milvus[0].id, output.lexicalDocuments[0].chunk_id);
  assert.equal(output.milvus[0].descriptorDigest, JSON.parse(asset.manifestJson).chunks[0].descriptorDigest);
  assert.equal(output.elasticsearch[0].descriptorDigest, output.milvus[0].descriptorDigest);
  assert.equal(output.lexicalDocuments[0].source, 'a.pdf');
  assert.equal(output.lexicalDocuments[0].page, 2);
  assert.deepEqual(output.lexicalDocuments[0].metadata, { title: 'sample' });
  assert.deepEqual(JSON.parse(output.milvusManifestJson), output.milvus);
  assert.deepEqual(JSON.parse(output.elasticsearchManifestJson), output.elasticsearch);
  assert.equal(output.milvusManifestJson, materializePublicationManifests(scope, identity, asset).milvusManifestJson);
});

test('rejects forged scope, version, chunk payload or unsafe generation before constructing manifests', () => {
  const asset = preparePublicationAsset(fixture());
  const identity = { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: 'document-a',
    generation: '7', revision: '8', manifestDigest: asset.manifestDigest,
    physicalCollection: 'rag_publication_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', leaseToken: '00000000-0000-4000-8000-000000000001' };
  assert.throws(() => materializePublicationManifests({ ...scope, tenantId: 'other' }, identity, asset));
  assert.throws(() => materializePublicationManifests(scope, { ...identity, generation: '9007199254740992' }, asset));
  const chunks = JSON.parse(asset.chunksJson); chunks[0].content = 'forged';
  assert.throws(() => materializePublicationManifests(scope, identity, { ...asset, chunksJson: JSON.stringify(chunks) }));
});

test('loading uses the fenced attempt and rejects a staged asset with a different manifest', async () => {
  const { loadPublicationManifests } = await import('./publication-publisher.ts');
  const asset = preparePublicationAsset(fixture());
  const identity = { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: 'document-a',
    generation: '7', revision: '8', manifestDigest: asset.manifestDigest,
    physicalCollection: 'rag_publication_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', leaseToken: '00000000-0000-4000-8000-000000000001' };
  let seen;
  const result = await loadPublicationManifests(scope, identity, { async readStaged(value) { seen = value; return asset; } });
  assert.equal(seen, identity);
  assert.equal(result.rows.length, 1);
  await assert.rejects(loadPublicationManifests(scope, identity, { async readStaged() {
    return { ...asset, manifestDigest: `sha256:${'f'.repeat(64)}` };
  } }));
  let reads = 0;
  await assert.rejects(loadPublicationManifests({ ...scope, tenantId: 'other' }, identity, { async readStaged() {
    reads++; return asset;
  } }));
  assert.equal(reads, 0);
});
