import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcilePublicationScope } from './publication-reconcile.mjs';

const input = { sandboxId: 'a'.repeat(24), tenantId: 'tenant', corpusId: 'corpus' };
const document = { documentId: 'doc', generation: '1', manifestDigest: `sha256:${'b'.repeat(64)}` };
function fixture() {
  const calls = [];
  return { calls, dependencies: {
    readAuthority: async () => { calls.push('authority'); return { digest: 'view', documents: [document] }; },
    assertCurrent: async () => { calls.push('current'); },
    elasticsearch: async () => { calls.push('elasticsearch'); return { count: 2 }; },
    milvus: async () => { calls.push('milvus'); return { count: 2 }; },
    neo4j: async () => { calls.push('neo4j'); return { passages: 2 }; },
  } };
}
test('requires an explicit bounded sandbox and scope before any IO', async () => {
  const f = fixture();
  for (const invalid of [{ ...input, sandboxId: '../other' }, { ...input, tenantId: '' }, { ...input, corpusId: ' x' }])
    await assert.rejects(reconcilePublicationScope(invalid, f.dependencies), /Invalid reconciliation/);
  assert.equal(f.calls.length, 0);
});
test('verifies every backend and rechecks the current authority after observations', async () => {
  const f = fixture(); const report = await reconcilePublicationScope(input, f.dependencies);
  assert.equal(report.ok, true); assert.equal(report.outcome, 'verified');
  assert.deepEqual(f.calls, ['authority', 'elasticsearch', 'milvus', 'neo4j', 'current']);
  assert.equal(report.documents[0].backends.neo4j.status, 'verified');
  assert.equal(report.readOnly, true);
});
test('PG status alone never implies backend verification, and backend errors do not leak secrets', async () => {
  const f = fixture(); f.dependencies.milvus = async () => { throw new Error('password=secret-value'); };
  const report = await reconcilePublicationScope(input, f.dependencies);
  assert.equal(report.ok, false); assert.equal(report.outcome, 'mismatch-or-unavailable');
  assert.equal(report.documents[0].backends.milvus.status, 'mismatch-or-unavailable');
  assert.equal(report.documents[0].backends.neo4j.status, 'verified');
  assert.ok(!JSON.stringify(report).includes('secret-value'));
});
test('a concurrent head change invalidates the overall result', async () => {
  const f = fixture(); f.dependencies.assertCurrent = async () => { throw new Error('changed'); };
  const report = await reconcilePublicationScope(input, f.dependencies);
  assert.equal(report.ok, false); assert.equal(report.currentHeads, 'changed-or-unavailable');
});
test('an empty scope reports no publications instead of backend verification', async () => {
  const f = fixture(); f.dependencies.readAuthority = async () => ({ digest: 'empty', documents: [] });
  const report = await reconcilePublicationScope(input, f.dependencies);
  assert.equal(report.outcome, 'no-active-publications'); assert.deepEqual(report.documents, []);
  assert.deepEqual(f.calls, ['current']);
});
