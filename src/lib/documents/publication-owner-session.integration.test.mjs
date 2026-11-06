import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';

registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(`${s}.ts`, c);
  throw error;
} } });
const sandboxId = process.env.PUBLICATION_INTENT_SANDBOX_ID;

test('exclusive owner uses one dedicated session and closes work after ownership loss', { skip: !sandboxId }, async () => {
  const { PublicationOwnerSession } = await import('./publication-owner-session.ts');
  const sandbox = readSandboxConfig(sandboxId);
  const config = { host: '127.0.0.1', port: sandbox.ports.postgres, database: 'publication_sandbox',
    user: 'pub_publisher', password: sandbox.credentials.dbPublisher };
  const first = new PublicationOwnerSession(config);
  const other = new PublicationOwnerSession(config);
  try {
    await first.start();
    await assert.rejects(other.start(), /already active/);
    assert.equal(await first.execute(async signal => { assert.equal(signal.aborted, false); return 42; }), 42);
    await first.close();
    assert.equal(first.signal.aborted, true);
    await assert.rejects(first.execute(async () => 1), /ownership was lost/);
    const successor = new PublicationOwnerSession(config);
    try { await successor.start(); await successor.assertOwner(); } finally { await successor.close(); }
  } finally { await first.close().catch(() => {}); await other.close().catch(() => {}); }
});

test('lost owner session cannot issue a late claim after preflight', { skip: !sandboxId }, async () => {
  const { PublicationOwnerSession } = await import('./publication-owner-session.ts');
  const { PublicationRequestQueue } = await import('./publication-request-queue.ts');
  const sandbox = readSandboxConfig(sandboxId);
  const config = { host: '127.0.0.1', port: sandbox.ports.postgres, database: 'publication_sandbox',
    user: 'pub_publisher', password: sandbox.credentials.dbPublisher };
  const owner = new PublicationOwnerSession(config);
  const inspector = new pg.Client({ ...config, user: 'sandbox_admin', password: sandbox.credentials.postgresAdmin });
  const publisher = new pg.Client(config);
  let release;
  try {
    await inspector.connect(); await publisher.connect(); await owner.start();
    await assert.rejects(owner.query('select 1'), /only its fenced claim/);
    let began; const started = new Promise(resolve => { began = resolve; });
    const waiting = new Promise(resolve => { release = resolve; }); const operationId = randomUUID();
    let lateFinished; const late = new Promise(resolve => { lateFinished = resolve; });
    const pending = owner.execute(async () => { began(); await waiting;
      try { await new PublicationRequestQueue(owner).claim(operationId); }
      catch { /* Lost-owner claim is always unknown, never a success. */ }
      finally { lateFinished(); }
    });
    await started;
    const sessions = await inspector.query("select pid from pg_stat_activity where application_name='rag-publication-owner' and datname=current_database()");
    assert.equal(sessions.rowCount, 1);
    assert.equal((await inspector.query('select pg_terminate_backend($1) as terminated', [sessions.rows[0].pid])).rows[0].terminated, true);
    await assert.rejects(pending, /ownership was lost/);
    release(); await late;
    assert.equal(await new PublicationRequestQueue(publisher).inspectClaim(operationId), undefined);
  } finally { if (release) release(); await Promise.all([owner.close().catch(() => {}), inspector.end(), publisher.end()]); }
});

test('unexpected owner session loss aborts the owner and prevents new work', { skip: !sandboxId }, async () => {
  const { PublicationOwnerSession } = await import('./publication-owner-session.ts');
  const sandbox = readSandboxConfig(sandboxId);
  const owner = new PublicationOwnerSession({ host: '127.0.0.1', port: sandbox.ports.postgres,
    database: 'publication_sandbox', user: 'pub_publisher', password: sandbox.credentials.dbPublisher });
  const inspector = new pg.Client({ host: '127.0.0.1', port: sandbox.ports.postgres,
    database: 'publication_sandbox', user: 'sandbox_admin', password: sandbox.credentials.postgresAdmin });
  try {
    await inspector.connect();
    await owner.start();
    let finishWork;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const work = new Promise(resolve => { finishWork = resolve; });
    const executing = owner.execute(async signal => { began(); await work; assert.equal(signal.aborted, true); });
    await started;
    const sessions = await inspector.query("select pid from pg_stat_activity where application_name = 'rag-publication-owner' and datname = current_database()");
    assert.equal(sessions.rowCount, 1, 'only terminate the unique test owner');
    const ended = new Promise(resolve => owner.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal((await inspector.query('select pg_terminate_backend($1) as terminated', [sessions.rows[0].pid])).rows[0].terminated, true);
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('owner did not stop')), 5000))]);
    await assert.rejects(executing, /ownership was lost/);
    await assert.rejects(owner.execute(async () => { throw new Error('must not run'); }), /ownership was lost/);
    finishWork();
  } finally { await owner.close().catch(() => {}); await inspector.end(); }
});

test('failed work releases its owner session and a later owner can acquire it', { skip: !sandboxId }, async () => {
  const { PublicationOwnerSession } = await import('./publication-owner-session.ts');
  const sandbox = readSandboxConfig(sandboxId);
  const config = { host: '127.0.0.1', port: sandbox.ports.postgres, database: 'publication_sandbox',
    user: 'pub_publisher', password: sandbox.credentials.dbPublisher };
  const first = new PublicationOwnerSession(config);
  const successor = new PublicationOwnerSession(config);
  try {
    await first.start();
    await assert.rejects(first.execute(async () => { throw new Error('failed'); }), /failed/);
    await successor.start();
    await successor.assertOwner();
  } finally { await first.close().catch(() => {}); await successor.close().catch(() => {}); }
});

test('timed-out work cannot restart and retains the lock until the old work settles', { skip: !sandboxId }, async () => {
  const { PublicationOwnerSession } = await import('./publication-owner-session.ts');
  const sandbox = readSandboxConfig(sandboxId);
  const config = { host: '127.0.0.1', port: sandbox.ports.postgres, database: 'publication_sandbox',
    user: 'pub_publisher', password: sandbox.credentials.dbPublisher };
  const first = new PublicationOwnerSession(config, 100);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  try {
    await first.start();
    await assert.rejects(first.execute(() => pending), /timed out/);
    assert.equal(first.signal.aborted, true);
    await assert.rejects(first.execute(async () => 1), /ownership was lost/);
    const contender = new PublicationOwnerSession(config);
    await assert.rejects(contender.start(), /already active/);
    await contender.close().catch(() => {});
    finish();
    await first.close();
    const successor = new PublicationOwnerSession(config);
    try { await successor.start(); } finally { await successor.close(); }
  } finally { finish(); await first.close().catch(() => {}); }
});
