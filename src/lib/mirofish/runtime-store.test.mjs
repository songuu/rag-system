import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { MemoryMiroFishRuntimeStore, PostgresMiroFishRuntimeStore } = await import('./runtime-store.ts');
const scope = { tenantId: 'runtime-test', corpusId: 'corpus-a' };

test('runtime records survive a new store instance, clone values, and isolate tenant/corpus/kind', async () => {
  const first = new MemoryMiroFishRuntimeStore(scope);
  const value = { simulation_id: 'sim-a', posts: ['accepted'] };
  await first.write('simulation', 'sim-a', value, { projectId: 'project-a' });
  value.posts.push('not committed');
  const reloaded = new MemoryMiroFishRuntimeStore(scope);
  assert.deepEqual(await reloaded.read('simulation', 'sim-a'), { simulation_id: 'sim-a', posts: ['accepted'] });
  assert.equal(await new MemoryMiroFishRuntimeStore({ ...scope, corpusId: 'foreign' }).read('simulation', 'sim-a'), null);
  assert.equal(await reloaded.read('report', 'sim-a'), null);
  assert.equal((await reloaded.list('simulation', { projectId: 'project-a' })).length, 1);
  assert.equal((await reloaded.list('simulation', { projectId: 'other' })).length, 0);
  assert.equal(await reloaded.delete('simulation', 'sim-a'), true);
  assert.equal(await reloaded.read('simulation', 'sim-a'), null);
});

test('runtime accepts the shared PostgreSQL scope grammar including colon-separated scopes', async () => {
  const scope = { tenantId: 'tenant:prod', corpusId: 'corpus:main' };
  const store = new MemoryMiroFishRuntimeStore(scope);
  await store.write('report', 'colon-scope-report', { title: 'Scoped' });
  assert.equal((await new MemoryMiroFishRuntimeStore(scope).read('report', 'colon-scope-report')).title, 'Scoped');
  assert.equal(await new MemoryMiroFishRuntimeStore({ ...scope, corpusId: 'corpus:foreign' }).read('report', 'colon-scope-report'), null);
  assert.doesNotThrow(() => new PostgresMiroFishRuntimeStore({ query: async () => ({ rows: [] }) }, scope));
  await store.delete('report', 'colon-scope-report');
});

test('runtime boundaries reject unsafe identifiers and non-serializable payloads without private content', async () => {
  const store = new MemoryMiroFishRuntimeStore({ ...scope, corpusId: 'validation' });
  for (const id of ['../secret', 'x/y', '', 'a'.repeat(129)]) await assert.rejects(store.read('report', id), error => error.code === 'MIROFISH_RUNTIME_INVALID_ID');
  const circular = { private: 'do-not-print' }; circular.self = circular;
  await assert.rejects(store.write('report', 'report-a', circular), error => {
    assert.doesNotMatch(error.message, /do-not-print/);
    return error.code === 'MIROFISH_RUNTIME_INVALID_RECORD';
  });
});

test('PostgreSQL runtime uses existing scoped artifact blobs and bounded project-filtered history', async () => {
  const queries = [];
  let stored;
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('insert into')) { stored = values[3]; return { rows: [], rowCount: 1 }; }
    if (sql.includes('delete from')) return { rows: [], rowCount: 1 };
    return { rows: stored ? [{ filename: 'mirofish-runtime/report/report-a.json', data: stored }] : [], rowCount: stored ? 1 : 0 };
  } };
  const store = new PostgresMiroFishRuntimeStore(client, scope);
  await store.write('report', 'report-a', { title: 'Report' }, { projectId: 'project-a' });
  assert.deepEqual(await store.read('report', 'report-a'), { title: 'Report' });
  assert.equal((await store.list('report', { projectId: 'project-a', limit: 20 })).length, 1);
  assert.equal(await store.delete('report', 'report-a'), true);
  for (const query of queries) assert.deepEqual(query.values.slice(0, 2), ['runtime-test', 'corpus-a']);
  assert.match(queries[0].sql, /object_blobs/);
  assert.match(queries[0].sql, /'artifact'/);
  assert.match(queries[2].sql, /limit/i);
  assert(queries[2].values.includes('project-a'));
});
