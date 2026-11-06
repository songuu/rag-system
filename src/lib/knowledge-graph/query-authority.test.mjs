import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });

const { readGraphQueryAuthority, readGraphQueryAuthorities, withAuthorizedGraphQuery, withAuthorizedGraphSnapshots } = await import('./query-authority.ts');
const identity = { tenantId: 't', corpusId: 'c', documentId: 'd', documentVersion: 'v1', trustLevel: 'reviewed' };
const scope = { tenantId: 't', corpusId: 'c', allowedTrustLevels: ['reviewed'], enforceIsolation: true };
const row = { asset_id: 'asset', asset_revision: '41', graph_revision: '17', document_version: 'v1', trust_level: 'reviewed' };

test('authority binds the current document version, visibility, graph state and exact scope', async () => {
  let args;
  const client = { query: async (sql, values) => { args = { sql, values }; return { rows: [row] }; } };
  assert.ok(await readGraphQueryAuthority(client, scope, identity, 'graph-v1'));
  assert.deepEqual(args.values, ['t', 'c', 'd', 'v1', 'reviewed', 'graph-v1', false]);
  assert.match(args.sql, /retrieval_enabled/);
  assert.match(args.sql, /source_hash/);
  assert.match(args.sql, /lifecycle\.state = 'staged'/);
  assert.match(args.sql, /xmin/);
  assert.equal(await readGraphQueryAuthority(client, { ...scope, allowedTrustLevels: ['external'] }, identity, 'graph-v1'), null);
  assert.equal(await readGraphQueryAuthority({ query: async () => ({ rows: [] }) }, scope, identity, 'graph-v1'), null);
});

test('generated snapshots require a validated durable build in both authorization paths', async () => {
  const generated = { ...identity, graphGeneration: '19b0d243-b625-4eba-85aa-f42fda97355a' };
  const client = { query: async (sql, values) => {
    assert.match(sql, /job\.status in \('validated', 'published'\)/);
    if (sql.includes('jsonb_to_recordset')) {
      assert.equal(JSON.parse(values[2])[0].generated, true);
    } else assert.equal(values[6], true);
    return { rows: [] };
  } };
  assert.equal(await readGraphQueryAuthority(client, scope, generated, 'graph-v1'), null);
  assert.deepEqual(await readGraphQueryAuthorities(client, scope, [generated]), [null]);
});

test('checks current document and graph pointer both before and after reading', async () => {
  let pointer = { identity, revision: 2 };
  let authority = 'asset-row-1';
  const dependencies = { getActive: async () => pointer, readAuthority: async () => authority };
  const result = await withAuthorizedGraphQuery(scope, dependencies, async version => ({ version }));
  assert.ok(result.version);
  await assert.rejects(withAuthorizedGraphQuery(scope, dependencies, async () => { authority = null; return 'secret'; }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
  authority = 'asset-row-1';
  await assert.rejects(withAuthorizedGraphQuery(scope, dependencies, async () => { authority = 'asset-row-2'; return 'secret'; }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
  authority = 'asset-row-1';
  await assert.rejects(withAuthorizedGraphQuery(scope, dependencies, async () => { pointer = { identity, revision: 3 }; return 'secret'; }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
});

test('rejects missing authority before query and does not release data on authorization failure', async () => {
  let executed = false;
  await assert.rejects(withAuthorizedGraphQuery(scope, { getActive: async () => ({ identity, revision: 1 }), readAuthority: async () => null }, async () => { executed = true; }), error => error.code === 'KNOWLEDGE_GRAPH_NOT_FOUND');
  assert.equal(executed, false);
});

test('snapshot listings hide disabled sources and detect revocation during listing', async () => {
  const unavailable = { ...identity, documentId: 'removed' };
  let revision = 'r1';
  const dependencies = {
    getActive: async () => ({ identity: unavailable, revision: 1, scope: { tenantId: 't', corpusId: 'c' }, updatedAt: 'now' }),
    list: async () => [{ identity }, { identity: unavailable }],
    readAuthorities: async sources => sources.map(source => source.documentId === 'removed' ? null : revision),
  };
  const result = await withAuthorizedGraphSnapshots(scope, dependencies);
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.active.identity, null);
  let reads = 0;
  await assert.rejects(withAuthorizedGraphSnapshots(scope, { ...dependencies,
    readAuthorities: async sources => sources.map(source => source.documentId === 'removed' ? null : (++reads === 1 ? 'r1' : 'r2')),
  }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
});

test('snapshot source authority uses one scoped batch and rejects ambiguous identities', async () => {
  let calls = 0;
  const other = { ...identity, documentId: 'other' };
  const client = { query: async (sql, values) => {
    calls++;
    assert.match(sql, /jsonb_to_recordset/);
    assert.equal(values[0], 't'); assert.equal(values[1], 'c');
    return { rows: [ { ...row, source_index: 0 }, { ...row, source_index: 1 }, { ...row, source_index: 1 } ] };
  } };
  const result = await readGraphQueryAuthorities(client, scope, [identity, other]);
  assert.equal(calls, 1);
  assert.ok(result[0]);
  assert.equal(result[1], null);
});
