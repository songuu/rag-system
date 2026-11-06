import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
import { grantSandboxPublisher } from '../../../deploy/publication-sandbox/publisher-db.mjs';
import { provisionSandboxObserver } from '../../../deploy/publication-sandbox/observer-db.mjs';
import { runMigrationSession } from '../../../scripts/migrate-postgres.mjs';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(`${s}.ts`, c); throw e;
} } });
const sandboxId = process.env.PUBLICATION_INTENT_SANDBOX_ID;
test('durable recovery inventory and suffix uniqueness on isolated PostgreSQL', { skip: !sandboxId }, async () => {
  const c = readSandboxConfig(sandboxId);
  const connection = user => new pg.Client({ host: '127.0.0.1', port: c.ports.postgres, database: 'publication_sandbox',
    user, password: user === 'pub_migration' ? c.credentials.dbMigration : c.credentials.dbPublisher });
  const migration = connection('pub_migration');
  const publisher = connection('pub_publisher');
  const delayed = connection('pub_publisher');
  let observer;
  await migration.connect();
  try {
    await runMigrationSession(migration);
    await grantSandboxPublisher(sandboxId);
    const observerConfig = await provisionSandboxObserver(sandboxId);
    observer = new pg.Client(observerConfig);
    await observer.connect();
    const probeSchema = `observer_probe_${randomUUID().replaceAll('-', '')}`;
    const observerRole = observerConfig.user;
    assert.match(observerRole, /^pub_obs_[a-f0-9]{16}$/);
    await migration.query(`create schema "${probeSchema}"`);
    try {
      await migration.query(`create table "${probeSchema}".probe (id integer)`);
      await migration.query(`create sequence "${probeSchema}".probe_seq`);
      await migration.query(`grant update on "${probeSchema}".probe to "${observerRole}"`);
      await assert.rejects(provisionSandboxObserver(sandboxId), /ownership or access privileges/i);
      await migration.query(`revoke update on "${probeSchema}".probe from "${observerRole}"`);
      await migration.query(`grant update(id) on "${probeSchema}".probe to "${observerRole}"`);
      await assert.rejects(provisionSandboxObserver(sandboxId), /ownership or access privileges/i);
      await migration.query(`revoke update(id) on "${probeSchema}".probe from "${observerRole}"`);
      await migration.query(`grant select on "${probeSchema}".probe to public`);
      await assert.rejects(provisionSandboxObserver(sandboxId), /ownership or access privileges/i);
      await migration.query(`revoke select on "${probeSchema}".probe from public`);
      await migration.query(`grant usage on sequence "${probeSchema}".probe_seq to public`);
      await assert.rejects(provisionSandboxObserver(sandboxId), /ownership or access privileges/i);
      await migration.query(`revoke usage on sequence "${probeSchema}".probe_seq from public`);
      await migration.query(`grant create on schema "${probeSchema}" to public`);
      await assert.rejects(provisionSandboxObserver(sandboxId), /ownership or access privileges/i);
      await migration.query(`revoke create on schema "${probeSchema}" from public`);
      const admin = new pg.Client({ host: '127.0.0.1', port: c.ports.postgres, database: 'publication_sandbox',
        user: 'sandbox_admin', password: c.credentials.postgresAdmin });
      await admin.connect();
      try {
        await admin.query(`alter table "${probeSchema}".probe owner to "${observerRole}"`);
        await assert.rejects(provisionSandboxObserver(sandboxId), /ownership or access privileges/i);
        await admin.query(`alter table "${probeSchema}".probe owner to pub_migration`);
        await admin.query(`grant pub_publisher to "${observerRole}"`);
        await assert.rejects(provisionSandboxObserver(sandboxId), /not isolated/i);
        await admin.query(`revoke pub_publisher from "${observerRole}"`);
      } finally {
        // Both are scoped to the exact test role and table, even on failure.
        await admin.query(`revoke pub_publisher from "${observerRole}"`).catch(() => {});
        await admin.query(`alter table "${probeSchema}".probe owner to pub_migration`).catch(() => {});
        await admin.end();
      }
      await provisionSandboxObserver(sandboxId);
    } finally { await migration.query(`drop schema "${probeSchema}" cascade`); }
    await publisher.connect();
    await delayed.connect();
    const privileges = await migration.query(`select
      has_function_privilege('pub_app','public.rag_list_all_publication_intents(uuid,integer)','EXECUTE') app_list,
      has_function_privilege('pub_app','public.rag_list_publication_grant_events(uuid,bigint,integer)','EXECUTE') app_events,
      has_table_privilege('pub_publisher','public.publication_grant_events','INSERT') direct_write`);
    assert.deepEqual(privileges.rows[0], { app_list: false, app_events: false, direct_write: false });
    const operation = randomUUID();
    const suffix = randomUUID().replaceAll('-', '').slice(-24);
    const prepare = (id, collection) => publisher.query('select public.rag_prepare_publication_intent($1,$2,$3,$4,$5,$6,$7)',
      [id, `recovery-${operation}`, 'corpus', 'document', `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, collection]);
    await prepare(operation, `rag_publication_00000000${suffix}`);
    await assert.rejects(prepare(randomUUID(), `rag_publication_11111111${suffix}`), e => e.code === '23505');
    const { PublicationGrantJournal } = await import('./publication-grant-journal.ts');
    const journal = new PublicationGrantJournal({ query: (sql, values) => publisher.query(sql, values) });
    const observerJournal = new PublicationGrantJournal({ query: (sql, values) => observer.query(sql, values) });
    await assert.rejects(observer.query('select public.rag_record_publication_grant_event($1::uuid,$2)', [operation, 'started']), e => e.code === '42501');
    await assert.rejects(observer.query('select public.rag_prepare_publication_intent($1,$2,$3,$4,$5,$6,$7)',
      [operation, 'x', 'x', 'x', `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, `rag_publication_${'a'.repeat(32)}`]), e => e.code === '42501');
    await assert.rejects(observer.query('insert into public.publication_grant_events(operation_id,phase) values ($1,$2)', [operation, 'unknown']), e => e.code === '42501');
    const identity = await journal.readIntent(operation);
    await journal.recordEvent({ operationId: operation, identity, phase: 'started' });
    await journal.recordEvent({ operationId: operation, identity, phase: 'unknown' });
    assert.deepEqual((await journal.listEvents(operation)).map(row => row.phase), ['started', 'unknown']);
    await delayed.query('begin');
    await delayed.query('select public.rag_record_publication_grant_event($1::uuid,$2)', [operation, 'revoke:Load']);
    await journal.recordEvent({ operationId: operation, identity, phase: 'revoked:Load' });
    const beforeCommit = await journal.listEvents(operation);
    assert.equal(beforeCommit.some(row => row.phase === 'revoke:Load'), false);
    await delayed.query('commit');
    // A late commit can have an ID below the previous cursor, so recovery
    // begins every scan at zero rather than treating that cursor as a watermark.
    assert.equal((await journal.listEvents(operation, beforeCommit.at(-1).id)).some(row => row.phase === 'revoke:Load'), false);
    assert.equal((await journal.listEvents(operation, '0')).some(row => row.phase === 'revoke:Load'), true);
    let cursor = null; let found = false;
    do {
      const page = await journal.listAll(cursor, 10);
      if (page.some(row => row.operationId === operation)) found = true;
      cursor = page.length === 10 ? page.at(-1).operationId : null;
    } while (cursor);
    assert.equal(found, true);
    const { PublicationGrantRecoveryWorker } = await import('./publication-grant-recovery-worker.ts');
    const controller = new AbortController();
    let observedLate = false;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const worker = new PublicationGrantRecoveryWorker({ journal: observerJournal, signal: controller.signal,
        operationDelayMs: 100, cycleDelayMs: 1000, maxPages: 100, onUnknown: async () => {},
        onError: async () => {}, onEvent: async (id, event) => {
          if (id === operation && event.phase === 'revoke:Load') { observedLate = true; controller.abort(); }
        } });
      await worker.run();
      assert.equal(observedLate, true);
    } finally { clearTimeout(timeout); }
  } finally { await observer?.end().catch(() => {}); await delayed.end().catch(() => {}); await publisher.end().catch(() => {}); await migration.end(); }
});
