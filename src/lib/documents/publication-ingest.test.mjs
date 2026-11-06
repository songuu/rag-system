import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const authorityUrl = 'data:text/javascript,' + encodeURIComponent(`
let document;
export function setAuthority(value) { document = value; }
export async function readPublicationView() { return { documents: document ? [document] : [] }; }
export async function assertPublicationViewCurrent() {}
`);
const postgresUrl = 'data:text/javascript,' + encodeURIComponent(`export function getPostgresClient() { return {}; }`);
const capabilityUrl = 'data:text/javascript,' + encodeURIComponent(`export async function assertPublicationPostgresCapability() {}`);

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/publication-ingest.ts') && specifier === './publication-view') return { url: authorityUrl, shortCircuit: true };
  if (context.parentURL?.endsWith('/publication-ingest.ts') && specifier === '../postgres/client') return { url: postgresUrl, shortCircuit: true };
  if (context.parentURL?.endsWith('/publication-ingest.ts') && specifier === './publication-postgres-capability') return { url: capabilityUrl, shortCircuit: true };
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return next(specifier + '.ts', context);
    throw error;
  }
} });

const { resolvePublicationIngestMode, preparePipelinePublication, commitPipelinePublication } = await import('./publication-ingest.ts');
const { createRetrievalScope, stampDocumentScope } = await import('../security/retrieval-scope.ts');
const { setAuthority } = await import(authorityUrl);

function fixture() {
  const metadata = stampDocumentScope({ createdBy: 'actor-a' }, createRetrievalScope({ tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true }), 'external');
  return {
    serverMetadata: metadata,
    documentId: 'doc-a', documentVersion: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    sourceBytes: Buffer.from('raw-file'), sourceIdentityBytes: Buffer.from('abc'),
    originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
    embedding: { model: 'model-a', revision: 'runtime-model-name/v1', dimension: 2, indexSchema: 'milvus-publication/v1' },
    splitter: { name: 'recursive-character', revision: 'pipeline/v1', chunkSize: 500, chunkOverlap: 50 },
    documents: [{ id: 'chunk-a', content: 'abc', embedding: [0.1, 0.2], metadata: { ...metadata, source: 'a.txt', type: 'text', chunkIndex: 0, startOffset: 0, endOffset: 3 } }],
  };
}

test('only explicit supported server modes are accepted', () => {
  assert.equal(resolvePublicationIngestMode({}), 'off');
  assert.equal(resolvePublicationIngestMode({ RAG_UNIFIED_PUBLICATION_MODE: 'active' }), 'active');
  assert.throws(() => resolvePublicationIngestMode({ RAG_UNIFIED_PUBLICATION_MODE: 'staging' }), /Invalid unified publication mode/);
  assert.throws(() => resolvePublicationIngestMode({ RAG_UNIFIED_PUBLICATION_MODE: '' }), /Invalid unified publication mode/);
});

test('preparation binds verified server scope, source identity, chunk payload and embedding', () => {
  const asset = preparePipelinePublication(fixture());
  assert.equal(asset.tenantId, 'tenant-a');
  assert.equal(asset.corpusId, 'corpus-a');
  assert.equal(asset.contentVersion, fixture().documentVersion);
  assert.deepEqual(asset.sourceBytes, Buffer.from('raw-file'));
  assert.equal(JSON.parse(asset.chunksJson)[0].content, 'abc');
});

test('rejects forged metadata or mismatched source version before publisher IO', () => {
  assert.throws(() => preparePipelinePublication({ ...fixture(), serverMetadata: { tenantId: 'tenant-a', corpusId: 'corpus-a', trustLevel: 'external' } }), /server-derived/);
  assert.throws(() => preparePipelinePublication({ ...fixture(), documentVersion: 'sha256:' + '0'.repeat(64) }), /source version/);
});

test('missing publisher is an explicit unavailable error and never invokes a legacy fallback', async () => {
  await assert.rejects(() => commitPipelinePublication(fixture(), undefined), error => error.code === 'PUBLICATION_INGEST_UNAVAILABLE' && error.status === 503);
});

test('requires independently published authority matching the prepared asset', async () => {
  const input = fixture();
  const asset = preparePipelinePublication(input);
  const receipt = { status: 'published', tenantId: asset.tenantId, corpusId: asset.corpusId, documentId: asset.documentId,
    contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest, generation: '1', revision: '1', ids: ['generation-chunk'] };
  const publisher = { async publish() { return receipt; } };
  setAuthority({ ...receipt, milvus: { chunks: receipt.ids.map(id => ({ id })) } });
  assert.deepEqual(await commitPipelinePublication(input, publisher), receipt);
  setAuthority(undefined);
  await assert.rejects(() => commitPipelinePublication(input, publisher), /verified/);
  setAuthority({ ...receipt, revision: '2', milvus: { chunks: receipt.ids.map(id => ({ id })) } });
  await assert.rejects(() => commitPipelinePublication(input, publisher), /verified/);
  setAuthority({ ...receipt, milvus: { chunks: [{ id: 'different' }] } });
  await assert.rejects(() => commitPipelinePublication(input, publisher), /verified/);
  setAuthority({ ...receipt, milvus: { chunks: receipt.ids.map(id => ({ id })) } });
  await assert.rejects(() => commitPipelinePublication(input, { ...publisher, async publish() { return { ...receipt, corpusId: 'other' }; } }), /identity/);
});
