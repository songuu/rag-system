import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
import { grantSandboxPublisher } from '../../../deploy/publication-sandbox/publisher-db.mjs';
import { runMigrationSession } from '../../../scripts/migrate-postgres.mjs';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const sandboxId = process.env.PUBLICATION_INTENT_SANDBOX_ID;
test('isolated sandbox records intent before begin and reconciles claim without exposing lease',
  { skip: !sandboxId && 'Requires an explicitly selected publication sandbox.' }, async () => {
    const config = readSandboxConfig(sandboxId);
    const migration = new pg.Client({ host: '127.0.0.1', port: config.ports.postgres, database: 'publication_sandbox',
      user: 'pub_migration', password: config.credentials.dbMigration });
    const publisher = new pg.Client({ host: '127.0.0.1', port: config.ports.postgres, database: 'publication_sandbox',
      user: 'pub_publisher', password: config.credentials.dbPublisher });
    await migration.connect();
    try {
      assert.equal((await migration.query('select current_database() as name')).rows[0].name, 'publication_sandbox');
      await runMigrationSession(migration);
      await grantSandboxPublisher(sandboxId);
      await publisher.connect();
      const permissions = await migration.query(`select
        has_function_privilege('pub_app','public.rag_prepare_publication_intent(uuid,text,text,text,text,text,text)','EXECUTE') as app_prepare,
        has_function_privilege('pub_publisher','public.rag_read_publication_intent(uuid,text,text,text)','EXECUTE') as publisher_read,
        has_table_privilege('pub_publisher','public.publication_operation_intents','INSERT') as direct_insert`);
      assert.deepEqual(permissions.rows[0], { app_prepare: false, publisher_read: true, direct_insert: false });
      const suffix = randomUUID().replaceAll('-', '');
      const intent = { operationId: randomUUID(), tenantId: `intent-tenant-${suffix}`, corpusId: `intent-corpus-${suffix}`,
        documentId: `intent-doc-${suffix}`, contentVersion: `sha256:${'a'.repeat(64)}`,
        manifestDigest: `sha256:${'b'.repeat(64)}`, physicalCollection: `rag_publication_${suffix}` };
      await migration.query('insert into public.tenants (id,name) values ($1,$2)', [intent.tenantId, 'Intent test']);
      await migration.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'test')", [intent.tenantId, intent.corpusId, 'Intent test']);
      const { PostgresPublicationIntentStore } = await import('./publication-runtime-publisher-intent.ts');
      const { PostgresDocumentPublicationStore } = await import('./publication-control-cas.ts');
      const db = { query: (sql, values) => publisher.query(sql, values) };
      const store = new PostgresPublicationIntentStore(db);
      const control = new PostgresDocumentPublicationStore(db);
      await store.prepare(intent);
      await store.prepare(intent);
      assert.deepEqual(await store.list(intent, null, 1), [intent.operationId]);
      assert.deepEqual(await store.list(intent, intent.operationId, 1), []);
      assert.equal((await store.inspect(intent, intent.operationId)).manifestDigest, intent.manifestDigest);
      await assert.rejects(store.inspect({ ...intent, tenantId: 'other' }, intent.operationId));
      assert.equal((await store.read(intent)).state, 'not_observed');
      await assert.rejects(store.prepare({ ...intent, documentId: 'different' }));
      const candidate = await control.begin({ ...intent, idempotencyKey: intent.operationId, requiredProviders: ['milvus', 'elasticsearch'] });
      assert.equal((await store.read(intent)).state, 'queued');
      const attempt = await control.claim(candidate);
      const staging = await store.read(intent);
      assert.equal(staging.state, 'staging');
      assert.equal(staging.currentlyActive, false);
      assert.equal(staging.attemptRevision, attempt.revision);
      assert.equal('leaseToken' in staging, false);
      await control.abandon(attempt);
      assert.equal((await store.read(intent)).state, 'failed');
      // Synthetic control rows check historical status semantics only; they
      // do not attest real backend seals or a successful production publish.
      await migration.query("update public.document_publication_attempts set status='published' where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4",
        [intent.tenantId, intent.corpusId, intent.documentId, attempt.generation]);
      await migration.query('update public.document_publication_heads set active_generation=$4, revision=revision+1 where tenant_id=$1 and corpus_id=$2 and document_id=$3',
        [intent.tenantId, intent.corpusId, intent.documentId, attempt.generation]);
      const active = await store.read(intent);
      assert.equal(active.state, 'published');
      assert.equal(active.currentlyActive, true);
      assert.notEqual(active.headRevision, active.attemptRevision);
      await migration.query('update public.document_publication_heads set active_generation=null, revoked=true, revision=revision+1 where tenant_id=$1 and corpus_id=$2 and document_id=$3',
        [intent.tenantId, intent.corpusId, intent.documentId]);
      const revoked = await store.read(intent);
      assert.equal(revoked.state, 'published');
      assert.equal(revoked.currentlyActive, false);
      assert.equal(revoked.headRevoked, true);
    } finally { await publisher.end().catch(() => {}); await migration.end(); }
  });
