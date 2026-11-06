import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { PostgresMiroFishRuntimeStore } = await import('./runtime-store.ts');
const { PostgresMiroFishProjectStore } = await import('./project-store.ts');
const { getPostgresRuntimeConfig } = await import('../postgres/env.ts');
const databaseUrl = process.env.TEST_DATABASE_URL || getPostgresRuntimeConfig().databaseUrl;

test('real PostgreSQL reloads every runtime kind and isolates history, with all fixtures rolled back', {
  skip: process.env.RAG_MIROFISH_LOCAL_TEST !== '1' || !databaseUrl ? 'Explicit local PostgreSQL integration configuration is required' : false,
}, async () => {
  const target = new URL(databaseUrl);
  assert(['127.0.0.1', 'localhost'].includes(target.hostname) && (target.port || '5432') === '5432');
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const suffix = randomUUID().replaceAll('-', '');
  const scope = { tenantId: `mirotest-${suffix}`, corpusId: `mirocorpus-${suffix}` };
  let began = false;
  try {
    await client.connect(); await client.query('begin'); began = true;
    await client.query("set local statement_timeout = '5s'");
    await client.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'MiroFish rollback fixture']);
    await client.query('insert into public.corpora (id,tenant_id,name,source_kind) values ($1,$2,$3,$4)',
      [scope.corpusId, scope.tenantId, 'MiroFish rollback fixture', 'isolated-test']);
    const store = new PostgresMiroFishRuntimeStore(client, scope);
    const projects = new PostgresMiroFishProjectStore(client, scope);
    const project = await projects.create({ name: 'Roundtrip', simulation_requirement: 'fixture' });
    for (const kind of ['simulation', 'report', 'interaction', 'prepare']) {
      await store.write(kind, `${kind}-a`, { status: 'completed', fixture: kind }, { projectId: project.id });
      assert.deepEqual(await new PostgresMiroFishRuntimeStore(client, scope).read(kind, `${kind}-a`), { status: 'completed', fixture: kind });
      assert.equal((await store.list(kind, { projectId: project.id })).length, 1);
      assert.equal((await store.list(kind, { projectId: 'foreign-project' })).length, 0);
      assert.equal(await new PostgresMiroFishRuntimeStore(client, { ...scope, corpusId: 'foreign-corpus' }).read(kind, `${kind}-a`), null);
    }
    await projects.update(project.id, { simulation_id: 'simulation-a', report_id: 'report-a', prepare_task_id: 'prepare-a' });
    assert.equal((await projects.get(project.id)).report_id, 'report-a');
    assert.equal(await store.delete('report', 'report-a'), true);
    assert.equal(await store.read('report', 'report-a'), null);
  } finally {
    try {
      if (began) {
        await client.query('rollback');
        assert.equal((await client.query('select count(*)::integer as count from public.tenants where id=$1', [scope.tenantId])).rows[0].count, 0);
      }
    } finally { await client.end(); }
  }
});
