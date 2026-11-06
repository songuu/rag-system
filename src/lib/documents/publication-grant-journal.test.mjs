import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.')) return next(`${s}.ts`, c); throw e;
} } });
const { PublicationGrantJournal } = await import('./publication-grant-journal.ts');
const operationId = '17fb66c0-22a7-48da-9aa3-3356a0210469';
const collection = `rag_publication_${'a'.repeat(32)}`;
const identity = { collection, username: `pgu_${collection.slice(-24)}`, role: `pgr_${collection.slice(-24)}` };
test('journal loads deterministic identity and records only validated events', async () => {
  const calls = [];
  const journal = new PublicationGrantJournal({ query: async (sql, params) => {
    calls.push([sql, params]); return { rows: sql.includes('rag_read_') ? [{ identity }] : [] };
  } });
  assert.deepEqual(await journal.readIntent(operationId), identity);
  await journal.recordEvent({ operationId, identity, phase: 'revoke:Load' });
  assert.equal(calls.at(-1)[1][1], 'revoke:Load');
  await assert.rejects(journal.recordEvent({ operationId, identity: { ...identity, role: 'pgr_wrong' }, phase: 'started' }), /identity/i);
  await assert.rejects(journal.recordEvent({ operationId, identity, phase: 'unsafe' }), /invalid/i);
});
