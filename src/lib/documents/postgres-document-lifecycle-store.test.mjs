import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { PostgresDocumentLifecycleStore } = await import('./postgres-document-lifecycle-store.ts');
const input = { id: 'asset-1', scope: { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['reviewed'], enforceIsolation: true } };
function fixture(rows = [], rowCount = rows.length) {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows, rowCount }; } };
  client.withTransaction = async (_operation, work) => { calls.push({ transaction: true }); return work(client); };
  return { client, calls, store: new PostgresDocumentLifecycleStore(client) };
}

test('blocking a deletion checks asset ID, canonical provenance and allowed trust scope', async () => {
  const { store, calls } = fixture([{ id: input.id, document_id: 'doc-1', metadata: { lifecycle: 'deleting' } }]);
  assert.equal((await store.beginDelete(input)).lifecycle, 'deleting');
  assert.deepEqual(calls[0].values, ['tenant-a', 'corpus-a', 'asset-1', ['reviewed']]);
  assert.match(calls[0].sql, /tenant_id = \$1 and corpus_id = \$2 and id::text = \$3/);
  assert.match(calls[0].sql, /metadata \? 'source_kind'/);
  assert.match(calls[0].sql, /= any\(\$4::text\[\]\)/);
});

test('enable cannot reactivate deleting/deleted sources and never mutates another scope', async () => {
  const { store, calls } = fixture();
  await assert.rejects(store.setEnabled({ ...input, enabled: true }), error => error.code === 'DOCUMENT_NOT_MUTABLE');
  assert.match(calls[0].sql, /metadata->>'lifecycle', 'active'\) = 'active'/);
  assert.deepEqual(calls[0].values, ['tenant-a', 'corpus-a', 'asset-1', ['reviewed'], true]);
  await assert.rejects(store.beginDelete(input), error => error.status === 404);
});

test('final cleanup locks the asset, retains a tombstone and only removes scoped unreferenced blobs', async () => {
  const { store, calls } = fixture([{ raw_blob_filename: 'raw-1', parsed_blob_filename: 'parsed-1' }]);
  await store.completeDelete(input);
  assert.equal(calls[0].transaction, true);
  assert.match(calls[1].sql, /for update/);
  assert.match(calls[2].sql, /raw_blob_filename = null, parsed_blob_filename = null, byte_size = 0/);
  assert.match(calls[2].sql, /'lifecycle', 'deleted'/);
  assert.match(calls[3].sql, /not exists/);
  assert.deepEqual(calls[3].values, ['tenant-a', 'corpus-a', ['raw-1', 'parsed-1']]);
});
