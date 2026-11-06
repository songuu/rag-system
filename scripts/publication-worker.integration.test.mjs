import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
  throw error;
} } });
const exec = promisify(execFile);
function requireFreshSandbox(env) {
  if (env.PUBLICATION_SANDBOX_ID) throw new Error('Existing sandboxes are not permitted for this test.');
}

test('existing sandbox identities are rejected before any test environment is created', () => {
  assert.throws(() => requireFreshSandbox({ PUBLICATION_SANDBOX_ID: '0005f610ce60cd797b544931' }), /Existing sandboxes/);
  assert.doesNotThrow(() => requireFreshSandbox({}));
});

test('isolated worker processes exactly one owned fixture', { timeout: 360000,
  skip: process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS !== '1' }, async t => {
  const { default: pg } = await import('pg');
  const { readSandboxConfig } = await import('../deploy/publication-sandbox/sandbox.mjs');
  const { preparePublicationAsset } = await import('../src/lib/documents/publication-asset-store.ts');
  const { PublicationRequestQueue } = await import('../src/lib/documents/publication-request-queue.ts');
  const { runMigrationSession } = await import('./migrate-postgres.mjs');
  const { grantSandboxPublisher } = await import('../deploy/publication-sandbox/publisher-db.mjs');
  // Never consume a caller-supplied queue: create a fresh sandbox and keep its
  // randomly generated ID private for the duration of this process. This
  // assumes the local OS and Docker administrator are trusted.
  requireFreshSandbox(process.env);
  const created = await exec(process.execPath, ['deploy/publication-sandbox/cli.mjs', 'create'], { timeout: 180000 });
  const id = JSON.parse(created.stdout).id;
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid newly created sandbox identity.');
  t.diagnostic(`New isolated test sandbox: ${id}`);
  const config = readSandboxConfig(id);
  const db = (user, password) => new pg.Client({ host: '127.0.0.1', port: config.ports.postgres,
    database: 'publication_sandbox', user, password });
  const owner = db('pub_migration', config.credentials.dbMigration);
  await owner.connect();
  await runMigrationSession(owner);
  await grantSandboxPublisher(id);
  const app = db('pub_app', config.credentials.dbApp);
  await app.connect();
  try {
    const pending = await owner.query("select count(*)::int as count from public.publication_requests where state='queued'");
    if (pending.rows[0].count !== 0) { t.skip('Sandbox contains queued requests; refusing to claim an unrelated request.'); return; }
    const suffix = randomUUID().replaceAll('-', '');
    const scope = { tenantId: `t-${suffix}`, corpusId: `c-${suffix}`, documentId: `d-${suffix}` };
    const requestId = randomUUID();
    // Record ownership before any writes, including an uncertain enqueue.
    const fixtureFile = openSync(join(config.path, `worker-fixture-${suffix}.json`), 'wx', 0o600);
    try { writeFileSync(fixtureFile, JSON.stringify({ ...scope, requestId })); fsyncSync(fixtureFile); }
    finally { closeSync(fixtureFile); }
    await owner.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'Worker test']);
    await owner.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scope.tenantId, scope.corpusId, 'Worker test']);
    const asset = preparePublicationAsset({ ...scope, sourceBytes: Buffer.from('source'), sourceIdentityBytes: Buffer.from('body'),
      originalName: 'worker.txt', contentType: 'text/plain', sourceKind: 'text', embedding: { model: 'm', revision: 'r', dimension: 2, indexSchema: 'milvus-publication/v1' },
      splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
      chunks: [{ chunkIndex: 0, content: 'body', startOffset: 0, endOffset: 4, trustLevel: 'external', embedding: [0.25, -0.5], metadata: {} }] });
    await new PublicationRequestQueue(app).enqueue(requestId, asset);
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/publication-worker.mjs', config.id], { timeout: 150000 });
    assert.match(result.stdout, /attempt completed/i);
    const operationId = result.stdout.match(/Operation: ([0-9a-f-]{36})/i)?.[1];
    assert.ok(operationId, 'worker must expose its durable operation identity');
    const operation = JSON.parse(readFileSync(join(config.path, 'worker-operations', `${operationId}.json`), 'utf8'));
    assert.equal(operation.operationId, operationId);
    const observed = await new PublicationRequestQueue(app).result(requestId, scope);
    assert.equal(observed.operationId, operationId);
    assert.equal(observed.attemptState, 'published');
    assert.equal(observed.currentlyActive, true);
    // An empty claim is still unknown; retain the operation for reconciliation.
    let failure;
    try { await exec(process.execPath, ['--import', 'tsx', 'scripts/publication-worker.mjs', config.id], { timeout: 150000 }); }
    catch (error) { failure = error; }
    assert.ok(failure, 'an empty queue cannot be reported as a completed publication');
    assert.match(failure.stderr, /outcome may be unknown/i);
    const unknownId = failure.stdout.match(/Operation: ([0-9a-f-]{36})/i)?.[1];
    assert.ok(unknownId);
    assert.equal(JSON.parse(readFileSync(join(config.path, 'worker-operations', `${unknownId}.json`), 'utf8')).operationId, unknownId);
  } finally { await Promise.all([app.end(), owner.end()]); }
});
