import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { listRetrievableDocumentIds, withDocumentVisibility } = await import('./document-visibility.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a' };

test('visibility authorizes only enabled canonical assets in the exact scope without caching', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ document_id: 'doc-enabled' }], rowCount: 1 }; } };
  assert.deepEqual(await listRetrievableDocumentIds(scope, db), ['doc-enabled']);
  assert.deepEqual(await listRetrievableDocumentIds(scope, db), ['doc-enabled']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['tenant-a', 'corpus-a']);
  assert.match(calls[0].sql, /metadata \? 'source_kind'/);
  assert.match(calls[0].sql, /metadata->>'retrieval_enabled' is distinct from 'false'/);
  assert.match(calls[0].sql, /metadata->>'lifecycle', 'active'\) = 'active'/);
});

test('Milvus visibility composes parenthesized filters with parameterized document IDs', async () => {
  const dangerousId = 'doc" || true || "';
  const marker = Symbol('server-scope');
  const options = { filter: 'trust_level == {trust} || id == {id}', exprValues: { trust: 'external', id: 'safe' }, [marker]: true };
  const db = { query: async () => ({ rows: [{ document_id: dangerousId }], rowCount: 1 }) };
  const result = await withDocumentVisibility(options, scope, db);
  assert.ok(result.filter.startsWith('(' + options.filter + ') && '));
  assert.match(result.filter, /document_id in \{retrievableDocumentIds\}/);
  assert.equal(result.filter.includes(dangerousId), false);
  assert.deepEqual(result.exprValues.retrievableDocumentIds, [dangerousId]);
  assert.equal(result.exprValues.visibilityTenant, scope.tenantId);
  assert.equal(result.exprValues.id, 'safe');
  assert.equal(result[marker], true);
  assert.equal(options.exprValues.retrievableDocumentIds, undefined);
});

test('an empty authoritative catalog remains closed and database errors propagate', async () => {
  const options = { filter: 'original' };
  const result = await withDocumentVisibility(options, scope, { query: async () => ({ rows: [], rowCount: 0 }) });
  assert.match(result.filter, /document_id in \[\]/);
  await assert.rejects(listRetrievableDocumentIds(scope, { query: async () => { throw new Error('offline'); } }), /PostgreSQL operation failed/);
});
