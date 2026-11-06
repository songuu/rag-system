import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { publishVerifiedGeneration } = await import('./publication-live-publisher.ts');

const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a',
  generation: '1', revision: '1', manifestDigest: `sha256:${'a'.repeat(64)}`,
  physicalCollection: 'rag_publication_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  leaseToken: 'de305d54-75b4-431b-adb2-eb6b9e546014' };

test('uses one server-side CAS and returns only an independently bound identity', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ publication: { ...scope, leaseToken: undefined, revision: '2', assetId: 'de305d54-75b4-431b-adb2-eb6b9e546014' } }], rowCount: 1 };
  } };
  const result = await publishVerifiedGeneration(db, scope);
  assert.equal(result.revision, '2');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /rag_publish_document_generation/);
  assert.deepEqual(calls[0].values, [scope.tenantId, scope.corpusId, scope.documentId, scope.generation,
    scope.revision, scope.leaseToken, scope.physicalCollection, scope.manifestDigest]);
});

test('rejects malformed inputs before database IO and an alien database response', async () => {
  let called = 0;
  const db = { query: async () => { called++; return { rows: [{ publication: { ...scope, tenantId: 'other', revision: '2', assetId: 'de305d54-75b4-431b-adb2-eb6b9e546014' } }], rowCount: 1 }; } };
  await assert.rejects(publishVerifiedGeneration(db, { ...scope, leaseToken: 'bad' }));
  assert.equal(called, 0);
  await assert.rejects(publishVerifiedGeneration(db, scope), /identity/i);
});
