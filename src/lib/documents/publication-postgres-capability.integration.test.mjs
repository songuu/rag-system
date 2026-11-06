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
const url = process.env.PUBLICATION_TEST_DATABASE_URL?.trim();
const enabled = Boolean(url && process.env.PUBLICATION_TEST_ALLOW_MUTATIONS === '1');

test('migration-granted application role meets the capability contract', {
  skip: enabled && process.env.PUBLICATION_TEST_APP_ROLE ? false : 'Requires the migration test application role.',
}, async () => {
  const role = process.env.PUBLICATION_TEST_APP_ROLE;
  assert.match(role, /^publication_test_[a-z0-9_]+$/);
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const database = await client.query('select current_database() as name');
    assert.match(database.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/);
    const { assertPublicationPostgresCapability } = await import('./publication-postgres-capability.ts');
    await client.query('begin');
    try {
      await client.query(`set local role "${role}"`);
      await assertPublicationPostgresCapability({ query: (text, values) => client.query(text, values) });
      if (process.env.PUBLICATION_TEST_READINESS_SCOPE === '1') {
        const { checkPostgresReadiness } = await import('../postgres/client.ts');
        assert.deepEqual(await checkPostgresReadiness({ defaultTenantId: 'cap_test_tenant', defaultCorpusId: 'cap_test_corpus' },
          { query: (text, values) => client.query(text, values) }), { connected: true, schemaReady: true });
      }
      await assert.rejects(client.query('select * from public.document_publication_heads limit 1'), error => error.code === '42501');
    } finally { await client.query('rollback'); }
  } finally { client.release(); await pool.end(); }
});

test('actual application role is rejected if it owns or can modify publication objects', {
  skip: enabled ? false : 'Requires an explicitly enabled isolated publication test database.',
}, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  const role = `publication_cap_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    const database = await client.query('select current_database() as name');
    assert.match(database.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/);
    await client.query(`create role "${role}" nologin`);
    created = true;
    await client.query(`grant usage on schema public to "${role}"`);
    for (const signature of [
      'public.rag_publication_control(text,text,text,text,jsonb)',
      'public.rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb)',
      'public.rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text)',
      'public.rag_elasticsearch_publication_operation(text,text,text,text,jsonb)',
      'public.rag_read_publication_view(text,text,text[])',
      'public.rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text)',
    ]) await client.query(`grant execute on function ${signature} to "${role}"`);
    const { assertPublicationPostgresCapability } = await import('./publication-postgres-capability.ts');
    const checkAsRole = async () => {
      await client.query('begin');
      try {
        await client.query(`set local role "${role}"`);
        return await assertPublicationPostgresCapability({ query: (text, values) => client.query(text, values) });
      } finally { await client.query('rollback'); }
    };
    await checkAsRole();
    await client.query(`grant select on public.document_publication_heads to "${role}"`);
    await assert.rejects(checkAsRole(), error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
    await client.query(`revoke select on public.document_publication_heads from "${role}"`);
    for (const table of ['document_publication_prior_assets', 'document_publication_receipts']) {
      await client.query(`grant select on public.${table} to "${role}"`);
      await assert.rejects(checkAsRole(), error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
      await client.query(`revoke select on public.${table} from "${role}"`);
    }
    await client.query(`grant create on schema public to "${role}"`);
    await assert.rejects(checkAsRole(), error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
    await client.query(`revoke create on schema public from "${role}"`);
    await client.query(`grant execute on function public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text) to "${role}"`);
    await assert.rejects(checkAsRole(), error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
    await client.query(`revoke execute on function public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text) from "${role}"`);
    await client.query(`grant execute on function public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text) to "${role}"`);
    await assert.rejects(checkAsRole(), error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
    await client.query(`revoke execute on function public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text) from "${role}"`);
    await client.query(`grant postgres to "${role}"`);
    await assert.rejects(checkAsRole(), error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
  } finally {
    if (created) {
      await client.query(`drop owned by "${role}"`);
      await client.query(`drop role "${role}"`);
    }
    client.release();
    await pool.end();
  }
});
