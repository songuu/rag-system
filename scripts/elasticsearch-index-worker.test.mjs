import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { projectElasticsearchOutboxBatch } = await import('./elasticsearch-index-worker.ts');

test('worker replaces one document projection then acknowledges the lease', async () => {
  const calls = [];
  const event = {
    id: 'event-1', sequence: 1, tenantId: 'tenant-a', corpusId: 'corpus-a',
    documentId: 'doc-1', documentVersion: 'v1', eventType: 'upsert', attempt: 1,
    projectionDigest: 'sha256:projection-1',
    leaseToken: 'lease-1', leaseExpiresAt: '2026-09-14T01:00:00Z',
  };
  const store = {
    async claim() { return [event]; },
    async loadDocuments() { calls.push('load'); return [{ chunk_id: 'chunk-1' }]; },
    async acknowledge(received) { calls.push(`ack:${received.id}`); return true; },
    async retry() { throw new Error('retry not expected'); },
  };
  const summary = await projectElasticsearchOutboxBatch({
    store, client: {}, indexName: 'rag_chunks_v1', limit: 10,
    async ensureIndex() { calls.push('ensure'); },
    async replaceDocument(input) {
      calls.push(`replace:${input.event.documentVersion}:${input.documents.length}`);
    },
  });
  assert.deepEqual(calls, ['ensure', 'load', 'replace:v1:1', 'ack:event-1']);
  assert.deepEqual(summary, { claimed: 1, projected: 1, retried: 0, deadLettered: 0, lostLease: 0 });
});

test('worker retries provider failures without acknowledging', async () => {
  const event = {
    id: 'event-1', sequence: 1, tenantId: 'tenant-a', corpusId: 'corpus-a',
    documentId: 'doc-1', documentVersion: '*', eventType: 'delete', attempt: 1,
    projectionDigest: 'delete',
    leaseToken: 'lease-1', leaseExpiresAt: '2026-09-14T01:00:00Z',
  };
  let acknowledged = false;
  const summary = await projectElasticsearchOutboxBatch({
    store: {
      async claim() { return [event]; },
      async loadDocuments() { return []; },
      async acknowledge() { acknowledged = true; return true; },
      async retry() { return 'retry'; },
    },
    client: {}, indexName: 'rag_chunks_v1', limit: 10,
    async ensureIndex() {},
    async replaceDocument() { throw new Error('ES unavailable'); },
  });
  assert.equal(acknowledged, false);
  assert.equal(summary.retried, 1);
});
