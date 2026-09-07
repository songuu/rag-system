import assert from 'node:assert/strict';
import test from 'node:test';

const {
  VectorIngestBusyError,
  assertVectorSearchReady,
  beginVectorIngest,
  getVectorIngestSnapshot,
  resetVectorIngestStateForTests,
} = await import('./vector-ingest-state.ts');

test('vector search is rejected while an ingest operation is active', () => {
  resetVectorIngestStateForTests();
  const lease = beginVectorIngest({
    operationId: 'ingest-a',
    collectionName: 'rag_documents',
    stage: 'embedding',
  });

  const snapshot = getVectorIngestSnapshot();
  assert.equal(snapshot.status, 'building');
  assert.equal(snapshot.activeOperations, 1);
  assert.deepEqual(snapshot.stages, { embedding: 1 });
  assert.throws(
    () => assertVectorSearchReady(),
    error => error?.code === 'RAG_INDEX_BUILDING' && error?.status === 503
  );

  lease.release();
  assert.equal(getVectorIngestSnapshot().status, 'ready');
  assert.doesNotThrow(() => assertVectorSearchReady());
});

test('ingest admission rejects excess concurrent work and releases idempotently', () => {
  resetVectorIngestStateForTests();
  const previousLimit = process.env.RAG_MAX_CONCURRENT_VECTOR_INGEST;
  process.env.RAG_MAX_CONCURRENT_VECTOR_INGEST = '1';

  try {
    const lease = beginVectorIngest({
      operationId: 'ingest-a',
      collectionName: 'rag_documents',
    });
    assert.throws(
      () => beginVectorIngest({
        operationId: 'ingest-b',
        collectionName: 'rag_documents',
      }),
      error => error instanceof VectorIngestBusyError
        && error.code === 'VECTOR_INGEST_BUSY'
        && error.status === 429
    );

    lease.updateStage('storing');
    assert.deepEqual(getVectorIngestSnapshot().stages, { storing: 1 });
    lease.release();
    lease.release();
    assert.equal(getVectorIngestSnapshot().activeOperations, 0);
  } finally {
    if (previousLimit === undefined) delete process.env.RAG_MAX_CONCURRENT_VECTOR_INGEST;
    else process.env.RAG_MAX_CONCURRENT_VECTOR_INGEST = previousLimit;
    resetVectorIngestStateForTests();
  }
});

test('public snapshot never exposes operation identifiers or failure messages', () => {
  resetVectorIngestStateForTests();
  const lease = beginVectorIngest({
    operationId: 'private-request-id',
    collectionName: 'rag_documents',
  });
  lease.fail(Object.assign(new Error('private provider detail'), {
    code: 'EMBEDDING_PROVIDER_TIMEOUT',
  }));

  const serialized = JSON.stringify(getVectorIngestSnapshot());
  assert.match(serialized, /EMBEDDING_PROVIDER_TIMEOUT/);
  assert.equal(serialized.includes('private-request-id'), false);
  assert.equal(serialized.includes('private provider detail'), false);
});
