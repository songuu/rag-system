import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { assertMiroFishProjectIdle, withMiroFishProjectLock } = await import('./project-lifecycle.ts');
const { createPostgresQueryClient } = await import('../postgres/client.ts');
const scope = { tenantId: 'lifecycle-test', corpusId: 'corpus-a' };
test('project reset/delete guard checks historical consumers rather than only the current pointer', async () => {
  const records = { simulation: [{ info: { status: 'paused' } }], report: [], prepare: [] };
  const store = { async list(kind, options) { assert.equal(options.projectId, 'project-a'); return records[kind]; } };
  await assert.rejects(assertMiroFishProjectIdle({ id: 'project-a' }, scope, { store }), error => error.code === 'MIROFISH_PROJECT_IN_USE');
  records.simulation[0].info.status = 'completed';
  await assertMiroFishProjectIdle({ id: 'project-a' }, scope, { store });
  records.report.push({ status: 'generating' });
  await assert.rejects(assertMiroFishProjectIdle({ id: 'project-a' }, scope, { store }));
  records.report.length = 0;
  await assertMiroFishProjectIdle({ id: 'project-a', graph_task_id: 'lost-task' }, scope, { store, graphTaskStatus: async () => undefined });
  await assert.rejects(assertMiroFishProjectIdle({ id: 'project-a', graph_task_id: 'live-task' }, scope, { store, graphTaskStatus: async () => 'processing' }));
});
test('project lifecycle lock serializes mutations and recovers after a rejected claim', async () => {
  const events = [];
  const first = withMiroFishProjectLock(scope, 'project-a', async () => { events.push('first'); throw new Error('rejected'); });
  const second = withMiroFishProjectLock(scope, 'project-a', async () => { events.push('second'); return 'saved'; });
  await assert.rejects(first);
  assert.equal(await second, 'saved');
  assert.deepEqual(events, ['first', 'second']);
});

test('a durable graph still protects reset when a restart lost the project task pointer', async () => {
  const store = { async list() { return []; } };
  await assert.rejects(assertMiroFishProjectIdle({ id: 'project-a' }, scope,
    { store, graphBuildActive: async () => true }), error => error.code === 'MIROFISH_PROJECT_IN_USE');
  await assertMiroFishProjectIdle({ id: 'project-a' }, scope, { store, graphBuildActive: async () => false });
});

test('project mutation locks its scoped identity and rolls back source, job and pointer together', async () => {
  const calls = [];
  const client = createPostgresQueryClient({ databaseUrl: 'postgres://unused', sslMode: 'disable', maxConnections: 1 }, () => ({
    async connect() { return { async query(sql, values) { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; }, release() {} }; },
    async query() { throw new Error('captured stores must use the project transaction'); }, async end() {},
  }));
  const rejected = new Error('queue capacity');
  await assert.rejects(withMiroFishProjectLock(scope, 'project-a', async () => {
    await client.query('save source');
    await client.withTransaction('enqueue', async tx => { await tx.query('save job'); });
    throw rejected;
  }, { client }), error => error === rejected);
  assert.deepEqual(calls.map(call => call.sql), ['begin', 'select pg_advisory_xact_lock(hashtextextended($1, 0))', 'save source', 'save job', 'rollback']);
  const firstKey = calls[1].values[0];
  calls.length = 0;
  await withMiroFishProjectLock({ ...scope, corpusId: 'other' }, 'project-a', async () => client.query('save pointer'), { client });
  assert.notEqual(calls[1].values[0], firstKey);
  assert.deepEqual(calls.map(call => call.sql).slice(-2), ['save pointer', 'commit']);
});

test('PostgreSQL project lock excludes another connection and rolls back all captured stores', {
  skip: process.env.RUN_MIROFISH_PROJECT_TRANSACTION_TESTS !== '1',
}, async () => {
  const { default: pg } = await import('pg');
  const { randomUUID } = await import('node:crypto');
  const { getPostgresRuntimeConfig } = await import('../postgres/env.ts');
  const config = getPostgresRuntimeConfig();
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(config.databaseUrl).hostname));
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const probe = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const client = createPostgresQueryClient({ ...config, maxConnections: 1 }, () => pool);
  const projectId = `proj_${randomUUID()}`;
  const key = `mirofish-project:${JSON.stringify([scope.tenantId, scope.corpusId, projectId])}`;
  try {
    await probe.connect();
    await client.query('create temporary table mirofish_project_transaction_fixture (kind text)');
    const rejected = new Error('pointer save failed');
    await assert.rejects(withMiroFishProjectLock(scope, projectId, async () => {
      const held = await probe.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [key]);
      assert.equal(held.rows[0].acquired, false);
      await client.query('insert into mirofish_project_transaction_fixture values ($1)', ['source']);
      await client.withTransaction('enqueue fixture', tx => tx.query('insert into mirofish_project_transaction_fixture values ($1)', ['job']));
      throw rejected;
    }, { client }), error => error === rejected);
    assert.deepEqual((await client.query('select * from mirofish_project_transaction_fixture')).rows, []);
    const released = await probe.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [key]);
    assert.equal(released.rows[0].acquired, true);
    await probe.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
  } finally {
    await probe.end();
    await pool.end();
  }
});
