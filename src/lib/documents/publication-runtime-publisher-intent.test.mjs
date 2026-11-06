import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { PostgresPublicationIntentStore } = await import('./publication-runtime-publisher-intent.ts');
const intent = { operationId: 'a727a5a6-644c-40d9-9ed5-7631781f4da1', tenantId: 'tenant', corpusId: 'corpus',
  documentId: 'doc', contentVersion: `sha256:${'a'.repeat(64)}`, manifestDigest: `sha256:${'b'.repeat(64)}`,
  physicalCollection: `rag_publication_${'c'.repeat(32)}` };

test('intent is persisted before begin and unknown is not treated as failure', async () => {
  const queries = [];
  const client = { async query(sql, values) { queries.push({ sql, values });
    return sql.includes('read_publication_intent') ? { rows: [{ result: { ...intent, state: 'not_observed', generation: null, attemptRevision: null, headRevision: null, headRevoked: null, currentlyActive: false } }], rowCount: 1 }
      : { rows: [{}], rowCount: 1 }; } };
  const store = new PostgresPublicationIntentStore(client);
  await store.prepare(intent);
  const result = await store.read(intent);
  assert.equal(result.state, 'not_observed');
  assert.match(queries[0].sql, /rag_prepare_publication_intent/);
  assert.equal(queries[0].values[0], intent.operationId);
  assert.ok(!JSON.stringify(result).includes('leaseToken'));
});

test('rejects mismatched scope, identity and secret-bearing results', async () => {
  const valid = { ...intent, state: 'staging', generation: '1', attemptRevision: '1', headRevision: '1', headRevoked: false, currentlyActive: false };
  for (const result of [{ ...valid, tenantId: 'wrong' }, { ...valid, leaseToken: 'secret' },
    { ...valid, state: 'not_observed' }, { ...valid, currentlyActive: true }]) {
    const store = new PostgresPublicationIntentStore({ async query() { return { rows: [{ result }], rowCount: 1 }; } });
    await assert.rejects(store.read(intent));
  }
});

test('recovery lists a bounded ordered page within the authenticated scope', async () => {
  const ids = ['0e3c0a67-5c78-4a04-85bd-69204b6b1542', 'b80bdc54-ccbe-4610-9594-20931b083430'];
  let args;
  const store = new PostgresPublicationIntentStore({ async query(_sql, values) {
    args = values; return { rows: ids.map(operation_id => ({ operation_id })), rowCount: 2 };
  } });
  assert.deepEqual(await store.list(intent, null, 2), ids);
  assert.deepEqual(args, ['tenant', 'corpus', 'doc', null, 2]);
  await assert.rejects(store.list(intent, null, 0));
  const bad = new PostgresPublicationIntentStore({ async query() { return { rows: [{ operation_id: ids[1] }, { operation_id: ids[0] }], rowCount: 2 }; } });
  await assert.rejects(bad.list(intent, null, 2));
});
