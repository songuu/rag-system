import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });

const enabled = process.env.RAG_ES_GENERATION_TEST === '1' && Boolean(process.env.TEST_ELASTICSEARCH_URL);

test('isolated Elasticsearch generation write, search and PIT readback', { skip: !enabled, timeout: 120_000 }, async () => {
  // Explicit opt-in AND loopback avoid writing to an accidentally configured
  // production service. No pre-existing index may ever be removed by this test.
  const url = new URL(process.env.TEST_ELASTICSEARCH_URL);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('TEST_ELASTICSEARCH_URL must be a credential-free loopback URL.');
  const index = `codex-generation-test-${randomUUID().replaceAll('-', '')}`;
  if (!/^codex-generation-test-[0-9a-f]{32}$/.test(index)) throw new Error('Unexpected temporary index identity.');
  const { Client } = await import('@elastic/elasticsearch');
  const { buildGenerationLexicalMapping, writeGenerationDocuments, observeGenerationDocuments,
    searchGenerationDocuments, deleteGenerationDocuments, generationDocumentDigest } = await import('./generation-index.ts');
  const client = new Client({ node: url.toString(), requestTimeout: 30_000,
    ...(process.env.TEST_ELASTICSEARCH_API_KEY ? { auth: { apiKey: process.env.TEST_ELASTICSEARCH_API_KEY } } : {}) });
  let created = false;
  try {
    await client.indices.create({ index, ...buildGenerationLexicalMapping() });
    created = true;
    const identity = { tenantId: 'test-tenant', corpusId: 'test-corpus', documentId: 'test-doc', generation: '1', documentVersion: 'v1' };
    const scope = { tenantId: 'test-tenant', corpusId: 'test-corpus', allowedTrustLevels: ['reviewed'], enforceIsolation: true };
    const documents = Array.from({ length: 17 }, (_, i) => ({ chunk_id: `chunk-${String(i).padStart(2, '0')}`,
      tenant_id: 'test-tenant', corpus_id: 'test-corpus', document_id: 'test-doc', document_version: 'v1',
      trust_level: 'reviewed', content: `alpha test sentence ${i}`, metadata: {} }));
    const newerIdentity = { ...identity, generation: '2', documentVersion: 'v2' };
    const newer = [{ ...documents[0], chunk_id: 'newer', document_version: 'v2' }];
    assert.equal((await writeGenerationDocuments({ client, indexName: index, identity, documents })).attempted, 17);
    assert.equal((await writeGenerationDocuments({ client, indexName: index, identity: newerIdentity, documents: newer })).attempted, 1);
    const observed = await observeGenerationDocuments({ client, indexName: index, identity, documents });
    assert.equal(observed.count, 17);
    assert.equal(observed.productionAuthorized, false);
    const pairs = [{ documentId: identity.documentId, generation: identity.generation, documentVersion: identity.documentVersion,
      chunks: documents.map(document => ({ chunkId: document.chunk_id,
        digest: generationDocumentDigest({ ...document, publication_generation: identity.generation }) })) }];
    const results = await searchGenerationDocuments({ client, indexName: index, scope, pairs, query: 'alpha', topK: 16 });
    assert.equal(results.length, 16);
    assert.ok(results.every(result => result.document.publication_generation === '1' && result.document.document_version === 'v1'));
    await deleteGenerationDocuments({ client, indexName: index, identity: newerIdentity });
    assert.equal((await observeGenerationDocuments({ client, indexName: index, identity, documents })).count, 17);
  } finally {
    try {
      if (created && /^codex-generation-test-[0-9a-f]{32}$/.test(index)) await client.indices.delete({ index });
    } finally {
      await client.close();
    }
  }
});
