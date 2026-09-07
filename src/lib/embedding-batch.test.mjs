import assert from 'node:assert/strict';
import test from 'node:test';

const {
  EmbeddingOutputValidationError,
  embedTextsInBatches,
} = await import('./embedding-batch.ts');

test('embedding batches are bounded, sequential, and preserve input order', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const texts = Array.from({ length: 25 }, (_, index) => `text-${index}`);

  const vectors = await embedTextsInBatches({
    texts,
    batchSize: 10,
    expectedDimension: 2,
    async embedBatch(batch) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push([...batch]);
      await Promise.resolve();
      active -= 1;
      return batch.map(text => [Number(text.slice(5)), 1]);
    },
  });

  assert.deepEqual(calls.map(batch => batch.length), [10, 10, 5]);
  assert.equal(maxActive, 1);
  assert.deepEqual(vectors[24], [24, 1]);
});

test('embedding output validation rejects count, dimension, and non-finite values', async () => {
  for (const embedBatch of [
    async () => [],
    async () => [[1]],
    async () => [[1, Number.NaN]],
  ]) {
    await assert.rejects(
      embedTextsInBatches({
        texts: ['one'],
        batchSize: 1,
        expectedDimension: 2,
        embedBatch,
      }),
      error => error instanceof EmbeddingOutputValidationError
        && error.code === 'EMBEDDING_OUTPUT_INVALID'
        && error.status === 502
    );
  }
});

test('embedding batches honor cancellation before starting the next provider call', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    embedTextsInBatches({
      texts: ['one', 'two'],
      batchSize: 1,
      expectedDimension: 2,
      signal: controller.signal,
      async embedBatch() {
        calls += 1;
        controller.abort(new Error('stop after first batch'));
        return [[1, 2]];
      },
    }),
    /stop after first batch/
  );
  assert.equal(calls, 1);
});
