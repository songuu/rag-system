import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const modelStub = 'data:text/javascript,' + encodeURIComponent(`
export function createEmbedding() { return { async embedDocuments(values) { return values.map(() => [0.1, 0.2]); } }; }
export function getConfigSummary() { return { llmModel: 'test-model' }; }
`);
const milvusStub = 'data:text/javascript,' + encodeURIComponent(`
export function createMilvusHybridRuntimeManifest() { throw new Error('legacy path must not run'); }
export function getMilvusInstance() { throw new Error('legacy path must not run'); }
`);
const authorityStub = 'data:text/javascript,' + encodeURIComponent(`
let document;
export function setAuthority(value) { document = value; }
export async function readPublicationView() { return { documents: document ? [document] : [] }; }
export async function assertPublicationViewCurrent() {}
`);
const postgresStub = 'data:text/javascript,' + encodeURIComponent(`export function getPostgresClient() { return {}; }`);
const capabilityStub = 'data:text/javascript,' + encodeURIComponent(`export async function assertPublicationPostgresCapability() {}`);
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/document-pipeline.ts') && specifier === './model-config') return { url: modelStub, shortCircuit: true };
  if (context.parentURL?.endsWith('/document-pipeline.ts') && specifier === './milvus-client') return { url: milvusStub, shortCircuit: true };
  if (context.parentURL?.endsWith('/publication-ingest.ts') && specifier === './publication-view') return { url: authorityStub, shortCircuit: true };
  if (context.parentURL?.endsWith('/publication-ingest.ts') && specifier === '../postgres/client') return { url: postgresStub, shortCircuit: true };
  if (context.parentURL?.endsWith('/publication-ingest.ts') && specifier === './publication-postgres-capability') return { url: capabilityStub, shortCircuit: true };
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
    throw error;
  }
} });

const { DocumentPipeline, storeToMilvus } = await import('./document-pipeline.ts');
const { createRetrievalScope, stampDocumentScope } = await import('./security/retrieval-scope.ts');
const { setAuthority } = await import(authorityStub);
const scope = stampDocumentScope({ createdBy: 'actor-a' }, createRetrievalScope({ tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true }), 'external');

test('active unified mode never falls back to legacy storage when publisher is unavailable', async t => {
  const previous = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  t.after(() => { if (previous === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE; else process.env.RAG_UNIFIED_PUBLICATION_MODE = previous; });
  const pipeline = new DocumentPipeline({ contextualRetrievalMode: 'off', pdfVisualMode: 'off' });
  await assert.rejects(() => pipeline.processDocument('test input', { filename: 'test.txt', metadata: scope }), error => error.code === 'PUBLICATION_INGEST_UNAVAILABLE');
  await assert.rejects(() => storeToMilvus([]), error => error.code === 'PUBLICATION_INGEST_UNAVAILABLE');
});

test('unified mode passes actual source bytes, trusted scope and generated vectors through publisher verification', async t => {
  const previous = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  t.after(() => { if (previous === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE; else process.env.RAG_UNIFIED_PUBLICATION_MODE = previous; });
  let captured;
  const publisher = {
    async publish(asset) {
      captured = asset;
      const result = { status: 'published', tenantId: asset.tenantId, corpusId: asset.corpusId, documentId: asset.documentId,
        contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest, generation: '1', revision: '1', ids: ['generation-chunk'] };
      setAuthority({ ...result, milvus: { chunks: result.ids.map(id => ({ id })) } });
      return result;
    },
  };
  const pipeline = new DocumentPipeline({ contextualRetrievalMode: 'off', pdfVisualMode: 'off', publicationPublisher: publisher });
  const result = await pipeline.processDocument(Buffer.from('test input'), { type: 'text', filename: 'test.txt', metadata: scope });
  assert.equal(result.publication.status, 'published');
  assert.deepEqual(result.ids, ['generation-chunk']);
  assert.deepEqual(captured.sourceBytes, Buffer.from('test input'));
  assert.equal(captured.tenantId, 'tenant-a');
  assert.equal(JSON.parse(captured.chunksJson).length, 1);
});

test('unified mode rejects forged scope before attempting publication', async t => {
  const previous = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  t.after(() => { if (previous === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE; else process.env.RAG_UNIFIED_PUBLICATION_MODE = previous; });
  let called = false;
  const pipeline = new DocumentPipeline({ contextualRetrievalMode: 'off', pdfVisualMode: 'off', publicationPublisher: {
    async publish() { called = true; throw new Error('unexpected publisher'); },
  } });
  await assert.rejects(() => pipeline.processDocument('text', { metadata: { tenantId: 'tenant-a', corpusId: 'corpus-a', trustLevel: 'external' } }), /server-derived/);
  assert.equal(called, false);
});
