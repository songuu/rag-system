import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { publishRuntimeGeneration } = await import('./publication-runtime-publisher.ts');
const digest = `sha256:${'a'.repeat(64)}`;
const evidence = `sha256:${'b'.repeat(64)}`;
const collection = `rag_publication_${'c'.repeat(32)}`;
const candidate = { tenantId: 'tenant', corpusId: 'corpus', documentId: 'doc', generation: '1', revision: '1', manifestDigest: digest, physicalCollection: collection };
const attempt = { ...candidate, leaseToken: 'e9a9ae67-32d2-4d4a-a238-e8d6890e8b8f' };
const asset = { tenantId: 'tenant', corpusId: 'corpus', documentId: 'doc', contentVersion: digest, manifestDigest: digest };
const index = { indexName: `codex-generation-seal-${'d'.repeat(32)}`, indexUuid: 'index-uuid', ownerMarker: 'e'.repeat(64) };

function fixture(overrides = {}) {
  const calls = [];
  const identity = { ...candidate, contentVersion: digest };
  const proof = (provider, name, id) => ({ ...identity, provider, resourceName: name, resourceId: id,
    manifestJson: '[{"chunkId":"pub:chunk"}]', configurationDigest: evidence, evidenceDigest: evidence });
  const ports = {
    async assertIsolation() { calls.push('isolation'); return { configurationDigest: evidence }; },
    async begin() { calls.push('begin'); return candidate; },
    async claim() { calls.push('claim'); return attempt; },
    async stage() { calls.push('stage'); },
    async materialize() { calls.push('materialize'); return { identity, ids: ['pub:chunk'],
      milvusManifestJson: '[{"chunkId":"pub:chunk"}]', elasticsearchManifestJson: '[{"chunkId":"pub:chunk"}]' }; },
    async createElasticsearch() { calls.push('create-es'); return index; },
    async writeElasticsearch() { calls.push('write-es'); },
    async writeMilvus() { calls.push('write-milvus'); },
    async verifyMilvus() { calls.push('verify-milvus'); return proof('milvus', collection, '123'); },
    async sealElasticsearch() { calls.push('seal-es'); return proof('elasticsearch', index.indexName, index.indexUuid); },
    async renew() { calls.push('renew'); },
    async recordSeal(_attempt, value) { calls.push(`record-${value.provider}`); },
    async publish() { calls.push('publish'); return { ...candidate, revision: '2', assetId: '7d98c3ac-0aa2-40fa-89cc-e6c90d4c785d' }; },
    async abandon() { calls.push('abandon'); },
    ...overrides,
  };
  return { calls, ports };
}

test('only publishes after isolation, both independent backend attestations and matching seals', async () => {
  const { calls, ports } = fixture();
  const result = await publishRuntimeGeneration(asset, ports, { timeoutMs: 100 });
  assert.equal(result.status, 'published');
  assert.equal(result.generation, '1');
  assert.ok(calls.indexOf('stage') < calls.indexOf('create-es'));
  assert.ok(calls.indexOf('verify-milvus') < calls.indexOf('record-milvus'));
  assert.ok(calls.indexOf('seal-es') < calls.indexOf('record-elasticsearch'));
  assert.ok(calls.lastIndexOf('isolation') < calls.indexOf('publish'));
  assert.ok(!calls.includes('abandon'));
});

test('rejects experimental observation as proof and abandons instead of publishing', async () => {
  const { calls, ports } = fixture({ async verifyMilvus() { return { productionAuthorized: false }; } });
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 100 }));
  assert.ok(calls.includes('abandon'));
  assert.ok(!calls.includes('publish'));
});

test('late backend completion after timeout cannot continue to a seal or publish', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { calls, ports } = fixture({ async writeMilvus() { calls.push('write-milvus'); return pending; } });
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 10 }), error => error.disposition === 'abandoned');
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(calls.includes('abandon'));
  assert.ok(!calls.includes('verify-milvus'));
  assert.ok(!calls.includes('publish'));
});

test('a lost commit response and failed abandon are reported as unknown', async () => {
  const { ports } = fixture({ async publish() { throw new Error('connection lost during commit'); },
    async abandon() { throw new Error('lease already consumed'); } });
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 100 }), error => error.disposition === 'unknown');
});

test('a lost claim response retains only the validated non-secret generation identity for reconciliation', async () => {
  const { ports } = fixture({ async claim() { throw new Error('claim response lost'); } });
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 100 }), error => {
    assert.equal(error.disposition, 'unknown');
    assert.deepEqual(error.candidate, candidate);
    assert.equal('leaseToken' in error.candidate, false);
    return true;
  });
});

test('a rejected candidate is not exposed as a reconciliation identity', async () => {
  const { ports } = fixture({ async begin() { return { ...candidate, tenantId: 'wrong' }; } });
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 100 }), error => {
    assert.equal(error.disposition, 'unknown');
    assert.equal(error.candidate, undefined);
    return true;
  });
});

test('an unavailable isolation verifier fails before starting a generation', async () => {
  const { calls, ports } = fixture({ async assertIsolation() { throw new Error('not isolated'); } });
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 100 }), error => error.disposition === 'not-started');
  assert.ok(!calls.includes('begin'));
});

test('backend identity mismatch and revoked isolation fail closed', async () => {
  const a = fixture({ async sealElasticsearch() { return { ...candidate, provider: 'elasticsearch', contentVersion: digest,
    resourceName: index.indexName, resourceId: 'other-index', manifestJson: '[]', configurationDigest: evidence, evidenceDigest: evidence }; } });
  await assert.rejects(publishRuntimeGeneration(asset, a.ports, { timeoutMs: 100 }));
  assert.ok(!a.calls.includes('publish'));
  let count = 0;
  const b = fixture({ async assertIsolation() { if (++count === 2) throw new Error('writer isolation revoked'); return { configurationDigest: evidence }; } });
  await assert.rejects(publishRuntimeGeneration(asset, b.ports, { timeoutMs: 100 }));
  assert.ok(b.calls.includes('abandon'));
  assert.ok(!b.calls.includes('publish'));
});
