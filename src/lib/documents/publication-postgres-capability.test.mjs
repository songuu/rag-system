import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { assertPublicationPostgresCapability } = await import('./publication-postgres-capability.ts');

test('accepts only an explicitly verified least-privilege service role', async () => {
  let sql;
  await assertPublicationPostgresCapability({ query: async text => { sql = text; return { rows: [{ ready: true }], rowCount: 1 }; } });
  assert.match(sql, /rolsuper/);
  assert.match(sql, /rolbypassrls/);
  assert.match(sql, /has_schema_privilege/);
  assert.match(sql, /pg_has_role/);
  assert.match(sql, /has_table_privilege/);
  assert.match(sql, /has_function_privilege/);
  assert.match(sql, /rag_stage_publication_asset/);
  assert.match(sql, /rag_elasticsearch_publication_operation/);
  assert.match(sql, /document_publication_provider_seals/);
  assert.match(sql, /document_publication_prior_assets/);
  assert.match(sql, /document_publication_receipts/);
  assert.match(sql, /rag_read_publication_view/);
  assert.match(sql, /rag_read_publication_source/);
  assert.match(sql, /rag_record_publication_seal/);
  assert.match(sql, /rag_publish_document_generation/);
});

test('fails closed for high privilege roles, missing objects and malformed responses', async () => {
  for (const rows of [[{ ready: false }], [], [{ ready: 'true' }], [{ ready: null }]]) {
    await assert.rejects(assertPublicationPostgresCapability({ query: async () => ({ rows, rowCount: rows.length }) }),
      error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE');
  }
});

test('does not expose database failures', async () => {
  await assert.rejects(assertPublicationPostgresCapability({ query: async () => { throw new Error('sensitive connection details'); } }),
    error => error.code === 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE' && !error.message.includes('sensitive'));
});
