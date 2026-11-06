import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationQueryVectorCache } from './publication-query-vector-cache.ts';

test('completed vector cache uses defensive copies, fixed TTL and LRU eviction', () => {
  let now = 0;
  const cache = createPublicationQueryVectorCache({ maxEntries: 2, maxBytes: 128, ttlMs: 10, now: () => now });
  const vector = [1, 2]; cache.set('a', vector); vector[0] = 99;
  cache.set('b', [3]); const hit = cache.get('a'); hit[0] = 77;
  assert.deepEqual(cache.get('a'), [1, 2]);
  cache.set('c', [4]); assert.equal(cache.get('b'), undefined);
  now = 10; assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);
});

test('byte capacity bounds vector payload and oversized/invalid values are never retained', () => {
  const cache = createPublicationQueryVectorCache({ maxEntries: 100, maxBytes: 24, ttlMs: 10 });
  cache.set('a', [1, 2]); cache.set('b', [3, 4]);
  assert.equal(cache.get('a'), undefined); assert.deepEqual(cache.get('b'), [3, 4]);
  cache.set('large', [1, 2, 3, 4]); assert.equal(cache.get('large'), undefined);
  cache.set('invalid', [NaN]); assert.equal(cache.get('invalid'), undefined);
  cache.delete('b'); assert.equal(cache.get('b'), undefined);
  cache.set('b', [5, 6]); assert.deepEqual(cache.get('b'), [5, 6]);
});

test('cache policy rejects non-finite or unbounded capacity inputs', () => {
  for (const options of [{ maxEntries: 0 }, { maxEntries: Infinity }, { maxBytes: -1 }, { ttlMs: NaN }]) {
    assert.throws(() => createPublicationQueryVectorCache(options), /cache policy/);
  }
});
