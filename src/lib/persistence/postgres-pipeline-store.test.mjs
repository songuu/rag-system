import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { PostgresPipelineStore } = await import('./postgres-pipeline-store.ts');

const CONFIG = {
  databaseUrl: 'postgresql://rag:secret@db/rag',
  defaultTenantId: 'tenant-a',
  defaultCorpusId: 'corpus-a',
  sslMode: 'disable',
  maxConnections: 5,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  persistenceBackend: 'postgres',
  vectorBackend: 'milvus',
};

test('completed pipeline documents atomically persist an optional blob and metadata', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ id: 'asset-1' }], rowCount: 1 };
    },
  };
  const store = new PostgresPipelineStore(CONFIG, client);
  const result = await store.recordCompletedDocument({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    actorId: 'operator-a',
    documentId: 'document-a',
    originalName: '知识库.txt',
    contentType: 'text/plain; charset=utf-8',
    sourceHash: 'sha256:abcdef',
    source: '知识正文',
    sourceKind: 'text',
    metadata: { chunks: 2, ids: ['chunk-a', 'chunk-b'] },
  });

  assert.equal(result, 'asset-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /insert into object_blobs/i);
  assert.match(calls[0].text, /insert into document_assets/i);
  assert.match(calls[0].text, /count\(\*\) as removed_count from deduplicated/i);
  assert.match(calls[0].text, /count\(\*\) as stored_count from stored_blob/i);
  assert.match(calls[0].text, /on conflict \(tenant_id, corpus_id, external_document_id\)/i);
  assert.deepEqual(calls[0].values.slice(0, 4), [
    'tenant-a',
    'corpus-a',
    'document-a',
    '知识库.txt',
  ]);
  assert.ok(Buffer.isBuffer(calls[0].values[7]));
  assert.equal(calls[0].text.includes('知识正文'), false);
});

test('pipeline persistence rejects request scope different from configured PostgreSQL scope', async () => {
  const store = new PostgresPipelineStore(CONFIG, {
    async query() {
      throw new Error('query must not run');
    },
  });

  await assert.rejects(
    () => store.recordCompletedDocument({
      tenantId: 'tenant-b',
      corpusId: 'corpus-a',
      actorId: 'operator-a',
      documentId: 'document-a',
      originalName: 'file.txt',
      contentType: 'text/plain',
      sourceHash: 'sha256:abcdef',
      sourceKind: 'text',
      metadata: {},
    }),
    /outside the configured PostgreSQL scope/
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
