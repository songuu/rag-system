import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { recordVerifiedPublicationSeal } = await import('./publication-seal-store.ts');
const attempt = { tenantId: 't', corpusId: 'c', documentId: 'd', generation: '1', revision: '2',
  physicalCollection: `rag_publication_${'a'.repeat(32)}`, manifestDigest: `sha256:${'b'.repeat(64)}`,
  leaseToken: 'de305d54-75b4-431b-adb2-eb6b9e546014' };
const identity = { ...attempt, contentVersion: `sha256:${'c'.repeat(64)}` };
const materialized = { identity, ids: ['chunk'], milvusManifestJson: '[1]', elasticsearchManifestJson: '[2]' };
const seal = { ...identity, provider: 'milvus', resourceName: attempt.physicalCollection, resourceId: '123', manifestJson: '[1]',
  configurationDigest: `sha256:${'d'.repeat(64)}`, evidenceDigest: `sha256:${'e'.repeat(64)}` };

test('records only the verified matching provider manifest through the fenced database function', async () => {
  const calls = [];
  const client = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{ recorded: true }] }; } };
  await recordVerifiedPublicationSeal(client, attempt, materialized, seal);
  assert.match(calls[0].sql, /rag_record_publication_seal/);
  assert.deepEqual(calls[0].args, [attempt.tenantId, attempt.corpusId, attempt.documentId, '1', '2', attempt.leaseToken,
    attempt.physicalCollection, 'milvus', attempt.physicalCollection, '123', 'milvus-exclusive-strong-v1',
    seal.configurationDigest, seal.evidenceDigest, '[1]']);
});

test('rejects observations and mismatched identities before database IO', async () => {
  let calls = 0;
  const client = { query: async () => { calls++; return { rows: [{ recorded: true }] }; } };
  for (const bad of [{ ...seal, productionAuthorized: false }, { ...seal, manifestJson: '[3]' },
    { ...seal, generation: '2' }, { ...seal, resourceName: 'other' }]) {
    await assert.rejects(recordVerifiedPublicationSeal(client, attempt, materialized, bad), /inconsistent/);
  }
  assert.equal(calls, 0);
});

test('rejects a database response that did not record the seal', async () => {
  await assert.rejects(recordVerifiedPublicationSeal({ query: async () => ({ rows: [{ recorded: false }] }) },
    attempt, materialized, seal), /not recorded/);
});
