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

// Opt-in synthetic canary: never uses existing documents or index names.
test('local PostgreSQL, Milvus and Elasticsearch preserve disable/enable/delete isolation', {
  skip: process.env.DOCUMENT_LIFECYCLE_INTEGRATION !== '1', timeout: 90_000,
}, async () => {
  const { getPostgresRuntimeConfig } = await import('../postgres/env.ts');
  const config = getPostgresRuntimeConfig();
  for (const url of [config.databaseUrl, process.env.ELASTICSEARCH_URL]) {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), 'canary only accepts local services');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const collection = 'doc_lifecycle_canary_' + suffix;
  const indexName = 'doc-lifecycle-canary-' + suffix;
  const previous = { ELASTICSEARCH_INDEX: process.env.ELASTICSEARCH_INDEX, MILVUS_HYBRID_COLLECTION_NAME: process.env.MILVUS_HYBRID_COLLECTION_NAME };
  process.env.ELASTICSEARCH_INDEX = indexName;
  process.env.MILVUS_HYBRID_COLLECTION_NAME = collection + '_hybrid_v1';
  const { getPostgresClient, closePostgresPool } = await import('../postgres/client.ts');
  const { getMilvusInstance, createMilvusHybridRuntimeManifest } = await import('../milvus-client.ts');
  const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
  const { createRetrievalScope, stampDocumentScope, buildScopedMilvusSearchOptions } = await import('../security/retrieval-scope.ts');
  const { PostgresPipelineStore } = await import('../persistence/postgres-pipeline-store.ts');
  const { PostgresElasticsearchOutboxStore } = await import('../elasticsearch/postgres-outbox-store.ts');
  const { PostgresDocumentLifecycleStore } = await import('./postgres-document-lifecycle-store.ts');
  const { createDocumentDeletionPorts } = await import('./document-lifecycle-runtime.ts');
  const { deleteManagedDocument } = await import('./document-lifecycle.ts');
  const { listDocumentCatalog } = await import('./document-catalog.ts');
  const { getElasticsearchClient, closeElasticsearchClient } = await import('../elasticsearch/client.ts');
  const { bulkIndexElasticsearchDocuments, ensureElasticsearchLexicalIndex, searchElasticsearchLexical } = await import('../elasticsearch/lexical-index.ts');
  const pg = getPostgresClient();
  const native = new MilvusClient({ address: 'localhost:19530', timeout: 10_000 });
  const store = getMilvusInstance({ address: 'localhost:19530', collectionName: collection, embeddingDimension: 2, indexType: 'FLAT', metricType: 'IP', flushOnInsert: true, consistencyLevel: 'Strong' });
  const es = await getElasticsearchClient();
  const corpusIds = ['canary-a-' + suffix, 'canary-b-' + suffix];
  const scopes = corpusIds.map(corpusId => createRetrievalScope({ tenantId: config.defaultTenantId, corpusId, enforceIsolation: true }));
  const documentId = 'lifecycle-doc-' + suffix;
  const version = 'sha256:' + suffix;
  const manifest = createMilvusHybridRuntimeManifest({ sourceCollectionName: collection, embeddingModel: 'synthetic-test', embeddingDimension: 2 });
  const assets = [];
  const fixtures = [];
  try {
    assert.equal((await native.hasCollection({ collection_name: collection })).value, false);
    await store.connect();
    await store.initializeCollection(false);
    await store.initializeHybridCollection(manifest);
    await ensureElasticsearchLexicalIndex({ client: es, indexName });
    for (const [i, scope] of scopes.entries()) {
      await pg.query(`insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, 'Synthetic document lifecycle test', 'text')`, [scope.corpusId, scope.tenantId]);
      const metadata = stampDocumentScope({ source: 'synthetic-lifecycle.txt', documentId, documentVersion: version, chunkIndex: 0, totalChunks: 1 }, scope);
      const chunk = { id: 'canary-chunk-' + i + '-' + suffix, content: '生命周期测试文档 synthetic lifecycle', embedding: [1, 0], metadata };
      await store.insertDocuments([chunk]);
      await store.insertHybridDocuments(manifest, [chunk]);
      const pipelineInput = {
        tenantId: scope.tenantId, corpusId: scope.corpusId, actorId: 'synthetic-test', documentId,
        originalName: 'synthetic-lifecycle.txt', contentType: 'text/plain', sourceHash: version,
        sourceKind: 'text', source: 'synthetic source bytes', metadata: { chunks: 1, document: metadata },
      };
      fixtures.push({ chunk, pipelineInput });
      assets.push(await new PostgresPipelineStore({ ...config, defaultCorpusId: scope.corpusId }, pg).recordCompletedDocument(pipelineInput));
      await bulkIndexElasticsearchDocuments({ client: es, indexName, documents: [{ chunk_id: chunk.id,
        tenant_id: scope.tenantId, corpus_id: scope.corpusId, document_id: documentId, document_version: version,
        trust_level: 'external', content: chunk.content, metadata: {} }] });
    }
    // An old projection may outlive its catalog asset. It must remain invisible
    // without deleting test data or relying on a disable tombstone for its ID.
    const orphanId = 'orphan-' + suffix;
    const orphanMetadata = stampDocumentScope({ source: 'orphan.txt', documentId: orphanId,
      documentVersion: version, chunkIndex: 0, totalChunks: 1 }, scopes[0]);
    const orphan = { id: 'orphan-chunk-' + suffix, content: '生命周期测试文档 synthetic lifecycle', embedding: [1, 0], metadata: orphanMetadata };
    await store.insertDocuments([orphan]);
    await store.insertHybridDocuments(manifest, [orphan]);
    await bulkIndexElasticsearchDocuments({ client: es, indexName, documents: [{ chunk_id: orphan.id,
      tenant_id: scopes[0].tenantId, corpus_id: scopes[0].corpusId, document_id: orphanId,
      document_version: version, trust_level: 'external', content: orphan.content, metadata: {} }] });
    await es.indices.refresh({ index: indexName });
    const dense = scope => store.search([1, 0], 10, buildScopedMilvusSearchOptions(scope));
    const lexical = scope => searchElasticsearchLexical({ client: es, indexName, scope, query: '生命周期', topK: 10, laneId: 'lexical' });
    const hybrid = scope => store.searchHybridCollection({ collectionName: manifest.collectionName, query: 'synthetic lifecycle', denseEmbedding: [1, 0], scope, topK: 10, fusion: 'rrf', lane: 'fused' }, manifest);
    assert.equal((await dense(scopes[0])).length, 1);
    assert.equal((await lexical(scopes[0])).length, 1);
    assert.equal((await hybrid(scopes[0])).length, 1, 'unmanaged hybrid rows must be excluded');
    const lifecycle = new PostgresDocumentLifecycleStore(pg);
    const mutation = { id: assets[0], scope: scopes[0] };
    await lifecycle.setEnabled({ ...mutation, enabled: false });
    const pipelineStore = new PostgresPipelineStore({ ...config, defaultCorpusId: scopes[0].corpusId }, pg);
    await pipelineStore.recordCompletedDocument(fixtures[0].pipelineInput);
    assert.equal((await listDocumentCatalog({ scope: scopes[0] }))[0].enabled, false, 're-ingesting a disabled document preserves its state');
    assert.equal((await dense(scopes[0])).length, 0);
    assert.equal((await lexical(scopes[0])).length, 0);
    assert.equal((await hybrid(scopes[0])).length, 0);
    assert.equal((await store.queryOrderedCorpusRows(scopes[0])).length, 0);
    assert.equal((await store.queryDocumentRows(scopes[0], { tenantId: scopes[0].tenantId, corpusId: scopes[0].corpusId,
      documentId, documentVersion: version, trustLevel: 'external' }, 1, { readOnly: true })).length, 0);
    assert.equal((await dense(scopes[1])).length, 1, 'same document ID in another corpus remains available');
    assert.equal((await lexical(scopes[1])).length, 1);
    await lifecycle.setEnabled({ ...mutation, enabled: true });
    assert.equal((await dense(scopes[0])).length, 1);
    assert.equal((await lexical(scopes[0])).length, 1);
    const ports = createDocumentDeletionPorts();
    ports.deleteVectors = (document, scope) => store.deleteManagedDocument(document.documentId, scope);
    await deleteManagedDocument(mutation, ports);
    assert.equal((await listDocumentCatalog({ scope: scopes[0] })).length, 0);
    assert.equal((await dense(scopes[0])).length, 0);
    assert.equal((await lexical(scopes[0])).length, 0);
    for (const name of [collection, manifest.collectionName]) {
      const rows = await native.query({ collection_name: name, filter: 'document_id == {documentId}', exprValues: { documentId }, output_fields: ['corpus_id'], consistency_level: 'Strong' });
      assert.equal(rows.data.length, 1, 'physical deletion preserves only the other corpus');
      assert.equal(rows.data[0].corpus_id, scopes[1].corpusId);
    }
    assert.equal((await pg.query(`select count(*)::int as count from public.object_blobs where tenant_id = $1 and corpus_id = $2`, [scopes[0].tenantId, scopes[0].corpusId])).rows[0].count, 0);
    await deleteManagedDocument(mutation, ports);
    await assert.rejects(lifecycle.setEnabled({ ...mutation, enabled: true }));

    await pg.withTransaction('verify re-upload projection ordering', async tx => {
      const outbox = new PostgresElasticsearchOutboxStore(tx);
      const identity = { tenantId: scopes[0].tenantId, corpusId: scopes[0].corpusId, documentId };
      const chunk = { ...identity, id: fixtures[0].chunk.id, documentVersion: version, trustLevel: 'external', content: fixtures[0].chunk.content };
      const latest = async () => (await tx.query(`select event_type from public.elasticsearch_lexical_outbox where tenant_id = $1 and corpus_id = $2 and document_id = $3 order by sequence desc limit 1`, [identity.tenantId, identity.corpusId, documentId])).rows[0].event_type;
      const upsertId = await outbox.enqueueUpsert([chunk]);
      const leased = (await tx.query('select sequence, projection_digest from public.elasticsearch_lexical_outbox where id = $1', [upsertId])).rows[0];
      const leaseToken = randomUUID();
      await tx.query(`update public.elasticsearch_lexical_outbox set lease_token = $2, lease_expires_at = now() + interval '30 seconds' where id = $1`, [upsertId, leaseToken]);
      await outbox.enqueueDelete(identity);
      assert.equal(await latest(), 'delete');
      await outbox.enqueueUpsert([chunk]);
      assert.equal(await latest(), 'upsert', 'same-version re-upload follows the previous deletion');
      const oldClaim = { id: upsertId, sequence: Number(leased.sequence), projectionDigest: leased.projection_digest, leaseToken };
      assert.equal(await outbox.acknowledge(oldClaim), false, 'old claims cannot publish a restored generation');
      assert.equal(await outbox.retry(oldClaim, { error: new Error('old failure') }), 'lost-lease');
      assert.equal((await tx.query('select lease_token from public.elasticsearch_lexical_outbox where id = $1', [upsertId])).rows[0].lease_token, leaseToken);
      await outbox.enqueueDelete(identity);
      assert.equal(await latest(), 'delete', 'repeated deletion follows the restored upsert');
      // Keep canary events invisible to the running worker's production index.
      await tx.query(`update public.elasticsearch_lexical_outbox set published_at = now(), lease_token = null, lease_expires_at = null where tenant_id = $1 and corpus_id = $2 and document_id = $3`, [identity.tenantId, identity.corpusId, documentId]);
    });
    assert.equal(await pipelineStore.recordCompletedDocument(fixtures[0].pipelineInput), assets[0]);
    assert.equal((await listDocumentCatalog({ scope: scopes[0] }))[0].enabled, true, 'an explicit upload can restore a fully deleted document');
    await store.insertDocuments([fixtures[0].chunk]);
    await store.insertHybridDocuments(manifest, [fixtures[0].chunk]);
    assert.equal((await dense(scopes[0])).length, 1);
    await deleteManagedDocument(mutation, ports);
    assert.equal((await listDocumentCatalog({ scope: scopes[0] })).length, 0);
  } finally {
    const cleanups = await Promise.allSettled([
      ...[collection, manifest.collectionName].map(collection_name => native.dropCollection({ collection_name })),
      es.indices.delete({ index: indexName, ignore_unavailable: true }),
      pg.query('delete from public.corpora where tenant_id = $1 and id = any($2::text[])', [config.defaultTenantId, corpusIds]),
    ]);
    await Promise.all([store.disconnect(), native.closeConnection(), closeElasticsearchClient(), closePostgresPool()]);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.ok(cleanups.every(result => result.status === 'fulfilled'), 'synthetic canary resources must be cleaned up');
  }
});
