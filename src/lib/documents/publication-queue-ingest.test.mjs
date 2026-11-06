import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return next(specifier + '.ts', context);
    throw error;
  }
} });

const { enqueuePipelinePublication, PublicationEnqueueUnknownError } = await import('./publication-queue-ingest.ts');
const { createRetrievalScope, stampDocumentScope } = await import('../security/retrieval-scope.ts');
const requestId = '9d3c8b78-2778-49f1-8e72-4c833930f111';
function fixture() {
  const metadata = stampDocumentScope({ createdBy: 'actor-a' }, createRetrievalScope({ tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true }), 'external');
  return { serverMetadata: metadata, documentId: 'doc-a', documentVersion: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    sourceBytes: Buffer.from('raw-file'), sourceIdentityBytes: Buffer.from('abc'), originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
    embedding: { model: 'model-a', revision: 'runtime-model-name/v1', dimension: 2, indexSchema: 'milvus-publication/v1' },
    splitter: { name: 'recursive-character', revision: 'pipeline/v1', chunkSize: 500, chunkOverlap: 50 },
    documents: [{ id: 'chunk-a', content: 'abc', embedding: [0.1, 0.2], metadata: { ...metadata, source: 'a.txt', chunkIndex: 0 } }] };
}

test('queues the authorized immutable snapshot and reports accepted rather than published', async () => {
  const input = fixture(); let call;
  const client = { async query(sql, values) { call = { sql, values }; return { rows: [] }; } };
  const receipt = await enqueuePipelinePublication(requestId, input, client);
  assert.deepEqual(receipt, { status: 'accepted', requestId, tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', contentVersion: input.documentVersion });
  assert.match(call.sql, /rag_enqueue_publication_request/);
  assert.deepEqual(call.values.slice(0, 4), [requestId, 'tenant-a', 'corpus-a', 'doc-a']);
  input.sourceBytes[0] = 0;
  assert.equal(call.values[5].toString(), 'raw-file');
});

test('rejects forged scope, source mismatch and pre-cancelled requests before database IO', async () => {
  let calls = 0; const client = { async query() { calls++; return { rows: [] }; } };
  const input = fixture();
  await assert.rejects(enqueuePipelinePublication(requestId, { ...input, serverMetadata: { tenantId: 'tenant-a', corpusId: 'corpus-a', trustLevel: 'external' } }, client), /server-derived/);
  await assert.rejects(enqueuePipelinePublication(requestId, { ...input, documentVersion: 'sha256:' + '0'.repeat(64) }, client), /source version/);
  await assert.rejects(enqueuePipelinePublication(requestId, input, client, AbortSignal.abort()), /cancel/i);
  assert.equal(calls, 0);
});

test('database failure or cancellation after starting reports unknown with the original request identity', async () => {
  const client = { async query() { throw new Error('connection lost'); } };
  await assert.rejects(enqueuePipelinePublication(requestId, fixture(), client), e => e instanceof PublicationEnqueueUnknownError && e.requestId === requestId);
  const controller = new AbortController();
  const cancelledClient = { async query() { controller.abort(); return { rows: [] }; } };
  await assert.rejects(enqueuePipelinePublication(requestId, fixture(), cancelledClient, controller.signal), e => e instanceof PublicationEnqueueUnknownError && e.requestId === requestId);
});

test('a hung query returns unknown on timeout or cancellation without assuming the write stopped', async () => {
  let finish;
  const client = { query() { return new Promise(resolve => { finish = resolve; }); } };
  await assert.rejects(enqueuePipelinePublication(requestId, fixture(), client, undefined, 5), e => e instanceof PublicationEnqueueUnknownError && e.requestId === requestId);
  finish({ rows: [] });
  const controller = new AbortController();
  const pending = enqueuePipelinePublication(requestId, fixture(), client, controller.signal);
  controller.abort();
  await assert.rejects(pending, e => e instanceof PublicationEnqueueUnknownError && e.requestId === requestId);
  finish({ rows: [] });
});
