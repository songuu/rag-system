import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { createGraphExtractionCheckpoint } = await import('./graph-extraction-checkpoint.ts');

const job = () => ({ id: '5bc631c8-4c86-4b87-af1f-055321563402', tenantId: 'tenant-a',
  corpusId: 'corpus-a', graphVersion: 'graph-v1', leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87', metadata: {} });
const segment = { key: '0:0:10', sourceDigest: `sha256:${'a'.repeat(64)}`, progress: 0.1 };

test('checkpoint saves through the owning lease and reads its completed result', async () => {
  const calls = [];
  const checkpoint = createGraphExtractionCheckpoint(job(), {
    async saveExtractionCheckpoint(input) { calls.push(input); },
  }, 'profile-v1', 60_000);
  const value = { kind: 'complete', result: { entities: [], relations: [] } };
  assert.equal(await checkpoint.load(segment), null);
  await checkpoint.save(segment, value);
  assert.deepEqual(await checkpoint.load(segment), value);
  assert.equal(calls[0].leaseToken, job().leaseToken);
  assert.equal(calls[0].tenantId, 'tenant-a');
  assert.equal(calls[0].segmentKey, segment.key);
  assert.equal(calls[0].record.sourceDigest, segment.sourceDigest);
});

test('checkpoint rejects changed source, changed profile, and malformed entries', async () => {
  const metadata = { graphExtractionCheckpoint: { profile: 'profile-v1', segments: {
    [segment.key]: { sourceDigest: segment.sourceDigest, value: { kind: 'split' } },
  } } };
  const checkpoint = createGraphExtractionCheckpoint({ ...job(), metadata }, {}, 'profile-v1', 60_000);
  await assert.rejects(checkpoint.load({ ...segment, sourceDigest: `sha256:${'b'.repeat(64)}` }), /source|来源/i);
  assert.throws(() => createGraphExtractionCheckpoint({ ...job(), metadata }, {}, 'different-profile', 60_000), /profile|配置/i);
  metadata.graphExtractionCheckpoint.segments[segment.key].value = { kind: 'unknown' };
  const malformed = createGraphExtractionCheckpoint({ ...job(), metadata }, {}, 'profile-v1', 60_000);
  await assert.rejects(malformed.load(segment), /checkpoint|断点/i);
});

test('a failed persistent write never becomes a locally reusable checkpoint', async () => {
  const checkpoint = createGraphExtractionCheckpoint(job(), {
    async saveExtractionCheckpoint() { throw new Error('lease lost'); },
  }, 'profile-v1', 60_000);
  await assert.rejects(checkpoint.save(segment, { kind: 'split' }), /lease lost/);
  assert.equal(await checkpoint.load(segment), null);
});
