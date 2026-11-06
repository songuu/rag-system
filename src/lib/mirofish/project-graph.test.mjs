import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { loadAuthorizedProjectGraph } = await import('./project-graph.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a' };
const identity = { ...scope, documentId: 'graph-a', documentVersion: 'version-1', trustLevel: 'external' };
function dependencies(authorities = ['rev-1', 'rev-1']) {
  const calls = [];
  return { calls, runtime: { backend: 'neo4j', store: {
    async list() { calls.push('list'); return [{ identity }]; },
    async get(value) { calls.push(value); return { graph: { graph_id: value.documentId, nodes: [], edges: [] } }; },
  } }, async readAuthority() { calls.push('authority'); return authorities.shift() ?? null; } };
}
test('project graph loader resolves legacy IDs but pins explicit immutable selectors', async () => {
  const legacy = dependencies();
  assert.equal((await loadAuthorizedProjectGraph({ graph_id: 'graph-a' }, scope, legacy)).authority, 'rev-1');
  const exact = dependencies();
  const result = await loadAuthorizedProjectGraph({ graph_id: 'graph-a', graph_identity: { ...identity, documentVersion: 'old-version' } }, scope, exact);
  assert.equal(result.identity.documentVersion, 'old-version');
  assert(!exact.calls.includes('list'));
});
test('revoked, foreign and quarantine sources cannot be recovered through project graph data', async () => {
  const revoked = dependencies([null]);
  assert.equal(await loadAuthorizedProjectGraph({ graph_id: 'graph-a', graph_data: { secret: true } }, scope, revoked), null);
  assert.equal(revoked.calls.filter(value => typeof value === 'object').length, 0);
  for (const override of [{ tenantId: 'foreign' }, { trustLevel: 'quarantined' }, { documentId: 'other' }, { documentVersion: '' }]) {
    assert.equal(await loadAuthorizedProjectGraph({ graph_id: 'graph-a', graph_identity: { ...identity, ...override } }, scope, dependencies()), null);
  }
});
test('project graph loader fails closed when authority changes during readback', async () => {
  await assert.rejects(loadAuthorizedProjectGraph({ graph_id: 'graph-a' }, scope, dependencies(['rev-1', 'rev-2'])), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
});
