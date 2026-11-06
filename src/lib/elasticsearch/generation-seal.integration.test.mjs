import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const enabled = process.env.RAG_ES_GENERATION_TEST === '1' && Boolean(process.env.TEST_ELASTICSEARCH_URL);

test('isolated physical generation index blocks writes before PIT readback', { skip: !enabled, timeout: 120_000 }, async () => {
  const url = new URL(process.env.TEST_ELASTICSEARCH_URL);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('TEST_ELASTICSEARCH_URL must be a credential-free loopback URL.');
  const { Client } = await import('@elastic/elasticsearch');
  const { createOwnedGenerationIndex, sealOwnedGenerationIndex, prepareGenerationIndexOperation } = await import('./generation-seal.ts');
  const { writeGenerationDocuments } = await import('./generation-index.ts');
  const client = new Client({ node: url.toString(), requestTimeout: 30_000,
    ...(process.env.TEST_ELASTICSEARCH_API_KEY ? { auth: { apiKey: process.env.TEST_ELASTICSEARCH_API_KEY } } : {}) });
  const identity = { tenantId: 'test-tenant', corpusId: 'test-corpus', documentId: 'test-doc', generation: '1', documentVersion: 'v1' };
  const documents = [{ tenant_id: identity.tenantId, corpus_id: identity.corpusId, document_id: identity.documentId,
    document_version: identity.documentVersion, chunk_id: 'chunk-1', trust_level: 'external', content: 'alpha text', metadata: {} }];
  let handle;
  try {
    const operation = prepareGenerationIndexOperation(identity);
    handle = await createOwnedGenerationIndex({ client, operation });
    await writeGenerationDocuments({ client, indexName: handle.indexName, identity, documents });
    const observation = await sealOwnedGenerationIndex({ client, handle, documents });
    assert.equal(observation.indexUuid, handle.indexUuid);
    assert.equal(observation.observation.count, 1);
    assert.equal(observation.productionAuthorized, false);
    await assert.rejects(writeGenerationDocuments({ client, indexName: handle.indexName, identity,
      documents: [{ ...documents[0], chunk_id: 'later' }] }));
  } finally {
    try {
      if (handle && /^codex-generation-seal-[0-9a-f]{32}$/.test(handle.indexName)) {
        const current = await client.indices.get({ index: handle.indexName, allow_no_indices: false, ignore_unavailable: false });
        if (current[handle.indexName]?.settings?.index?.uuid !== handle.indexUuid) throw new Error('Temporary index identity changed; refusing cleanup.');
        await client.indices.delete({ index: handle.indexName });
      }
    } finally { await client.close(); }
  }
});

test('physical seal rejects an additional document from another generation', { skip: !enabled, timeout: 120_000 }, async () => {
  const url = new URL(process.env.TEST_ELASTICSEARCH_URL);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('TEST_ELASTICSEARCH_URL must be a credential-free loopback URL.');
  const { Client } = await import('@elastic/elasticsearch');
  const { createOwnedGenerationIndex, sealOwnedGenerationIndex, prepareGenerationIndexOperation } = await import('./generation-seal.ts');
  const { writeGenerationDocuments } = await import('./generation-index.ts');
  const client = new Client({ node: url.toString(), requestTimeout: 30_000,
    ...(process.env.TEST_ELASTICSEARCH_API_KEY ? { auth: { apiKey: process.env.TEST_ELASTICSEARCH_API_KEY } } : {}) });
  const identity = { tenantId: 'test-tenant', corpusId: 'test-corpus', documentId: 'test-doc', generation: '1', documentVersion: 'v1' };
  const documents = [{ tenant_id: identity.tenantId, corpus_id: identity.corpusId, document_id: identity.documentId,
    document_version: identity.documentVersion, chunk_id: 'chunk-1', trust_level: 'external', content: 'alpha text', metadata: {} }];
  let handle;
  try {
    handle = await createOwnedGenerationIndex({ client, operation: prepareGenerationIndexOperation(identity) });
    await writeGenerationDocuments({ client, indexName: handle.indexName, identity, documents });
    const foreign = { ...identity, documentId: 'other-doc', generation: '2' };
    await writeGenerationDocuments({ client, indexName: handle.indexName, identity: foreign,
      documents: [{ ...documents[0], document_id: foreign.documentId, chunk_id: 'foreign' }] });
    await assert.rejects(sealOwnedGenerationIndex({ client, handle, documents }), /contents/i);
  } finally {
    try {
      if (handle && /^codex-generation-seal-[0-9a-f]{32}$/.test(handle.indexName)) {
        const current = await client.indices.get({ index: handle.indexName, allow_no_indices: false, ignore_unavailable: false });
        if (current[handle.indexName]?.settings?.index?.uuid !== handle.indexUuid) throw new Error('Temporary index identity changed; refusing cleanup.');
        await client.indices.delete({ index: handle.indexName });
      }
    } finally { await client.close(); }
  }
});
