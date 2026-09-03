import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const POSTGRES_ROOT = path.join(REPOSITORY_ROOT, 'db', 'postgres');
const MIGRATIONS_ROOT = path.join(POSTGRES_ROOT, 'migrations');

const {
  applyMigrations,
  assertDatabaseUrlHasNoSslParameters,
  formatCliError,
  grantApplicationRole,
  grantDirectReadonlyRole,
  loadMigrations,
  resolveSeedScope,
  resolveDatabaseUrl,
  resolveDirectReadonlyRole,
  resolveMigrationDatabaseUrl,
  resolveApplicationRole,
  runMigrationSession,
  seedDefaultScope,
  withMigrationLock,
} = await import('./migrate-postgres.mjs');

test('migration runner rejects connection-string TLS parameters that override explicit policy', () => {
  assert.throws(
    () => assertDatabaseUrlHasNoSslParameters(
      'postgresql://rag:secret@db.internal/rag?sslmode=require'
    ),
    /must not contain sslmode.*POSTGRES_SSL_MODE/i
  );
  assert.doesNotThrow(() => assertDatabaseUrlHasNoSslParameters(
    'postgresql://rag:secret@db.internal/rag'
  ));
});

test('migration runner rejects conflicting database URL aliases', () => {
  assert.throws(
    () => resolveDatabaseUrl({
      DATABASE_URL: 'postgresql://rag:secret@old-db/rag',
      POSTGRES_URL: 'postgresql://rag:secret@new-db/rag',
    }),
    /DATABASE_URL and POSTGRES_URL.*different databases/i
  );
  assert.equal(resolveDatabaseUrl({
    DATABASE_URL: 'postgresql://rag:secret@db/rag',
    POSTGRES_URL: 'postgresql://rag:secret@db/rag',
  }), 'postgresql://rag:secret@db/rag');
});

test('migration runner supports a separate migration DSN and a validated app role', async () => {
  assert.equal(resolveMigrationDatabaseUrl({
    POSTGRES_MIGRATION_URL: 'postgresql://owner:secret@db/rag',
    POSTGRES_URL: 'postgresql://app:secret@db/rag',
  }), 'postgresql://owner:secret@db/rag');
  assert.equal(resolveApplicationRole({ POSTGRES_APP_ROLE: 'rag_app' }), 'rag_app');
  assert.throws(
    () => resolveApplicationRole({ POSTGRES_APP_ROLE: 'rag-app;drop role' }),
    /POSTGRES_APP_ROLE.*valid PostgreSQL identifier/i
  );

  const calls = [];
  await grantApplicationRole(fakeClient(async (text) => {
    calls.push(text);
    return { rows: [], rowCount: 0 };
  }), 'rag_app');
  assert.ok(calls
    .filter((text) => !/^(begin|commit)$/i.test(text))
    .every((text) => text.includes('"rag_app"')));
  assert.ok(calls.some((text) => /grant select on table public\.rag_schema_migrations/i.test(text)));
  assert.ok(calls.some((text) => /grant select on table[\s\S]*public\.tenants[\s\S]*public\.corpora/i.test(text)));
  assert.ok(calls.some((text) => /public\.maic_courses[\s\S]*public\.maic_classroom_sessions/i.test(text)));
  assert.equal(calls.some((text) => /insert.*rag_schema_migrations/i.test(text)), false);
  assert.equal(calls.some((text) => /grant select, insert, update, delete on table[\s\S]*public\.tenants/i.test(text)), false);
  assert.ok(calls.some((text) => /revoke insert, update, delete[\s\S]*public\.tenants[\s\S]*public\.corpora/i.test(text)));
  assert.ok(calls.some((text) => /alter default privileges[\s\S]*revoke[\s\S]*on tables/i.test(text)));
  assert.equal(calls.some((text) => /alter default privileges[\s\S]*grant/i.test(text)), false);
});

test('migration runner grants an optional direct role read-only access to the explicit business-table allowlist', async () => {
  assert.equal(resolveDirectReadonlyRole({}), null);
  assert.equal(
    resolveDirectReadonlyRole({ POSTGRES_DIRECT_READONLY_ROLE: 'rag_direct_readonly' }),
    'rag_direct_readonly'
  );
  assert.throws(
    () => resolveDirectReadonlyRole({ POSTGRES_DIRECT_READONLY_ROLE: 'rag-direct;drop role' }),
    /POSTGRES_DIRECT_READONLY_ROLE.*valid PostgreSQL identifier/i
  );

  const calls = [];
  await grantDirectReadonlyRole(fakeClient(async (text) => {
    calls.push(text);
    return { rows: [], rowCount: 0 };
  }), 'rag_direct_readonly');

  const statements = calls.filter((text) => !/^(begin|commit)$/i.test(text));
  assert.ok(statements.every((text) => text.includes('"rag_direct_readonly"')));
  assert.ok(statements.some((text) => /grant usage on schema public/i.test(text)));
  const selectGrant = statements.find((text) => /grant select on table/i.test(text));
  assert.ok(selectGrant);
  for (const table of [
    'public.rag_schema_migrations',
    'public.tenants',
    'public.corpora',
    'public.document_assets',
    'public.object_blobs',
    'public.index_jobs',
    'public.traces',
    'public.observations',
    'public.trace_scores',
    'public.maic_courses',
    'public.maic_classroom_sessions',
    'public.prompt_optimizer_model_profiles',
    'public.prompt_optimizer_workspaces',
    'public.prompt_optimizer_versions',
  ]) {
    assert.match(selectGrant, new RegExp(table.replace('.', '\\.')));
  }
  assert.equal(statements.some((text) => /grant[\s\S]*(all tables|all sequences)/i.test(text)), false);
  assert.equal(statements.some((text) => /alter default privileges[\s\S]*grant/i.test(text)), false);
  assert.equal(statements.some((text) => /alter default privileges/i.test(text)), false);
  assert.equal(statements.some((text) => /grant[\s\S]*(insert|update|delete|truncate|references|trigger)/i.test(text)), false);
  assert.equal(statements.some((text) => /grant[\s\S]*(usage|select|update)[\s\S]*sequence/i.test(text)), false);
  assert.ok(statements.some((text) => /revoke[\s\S]*all sequences/i.test(text)));
});

test('migration session leaves grants unchanged until a direct read-only role is configured', async () => {
  const noRoleCalls = [];
  const noRoleSummary = await runMigrationSession(fakeClient(async (text) => {
    noRoleCalls.push(text);
    return { rows: [], rowCount: 0 };
  }), {
    migrations: [],
    bootstrapSql: 'create table if not exists public.rag_schema_migrations ();',
  });
  assert.deepEqual(noRoleSummary, {
    applied: [],
    skipped: [],
    seeded: false,
    appRoleGranted: false,
  });
  assert.equal(noRoleCalls.some((text) => /rag_direct_readonly/i.test(text)), false);

  const directRoleCalls = [];
  await runMigrationSession(fakeClient(async (text) => {
    directRoleCalls.push(text);
    return { rows: [], rowCount: 0 };
  }), {
    migrations: [],
    bootstrapSql: 'create table if not exists public.rag_schema_migrations ();',
    directReadonlyRole: 'rag_direct_readonly',
  });
  assert.ok(directRoleCalls.some((text) => /grant select on table[\s\S]*rag_direct_readonly/i.test(text)));
});

test('PostgreSQL schema is vanilla PG 17 SQL and covers the persistence contract', async () => {
  const migrationFiles = (await readdir(MIGRATIONS_ROOT))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const sqlParts = [
    await readFile(path.join(POSTGRES_ROOT, 'bootstrap.sql'), 'utf8'),
    ...await Promise.all(
      migrationFiles.map((filename) => readFile(path.join(MIGRATIONS_ROOT, filename), 'utf8'))
    ),
  ];
  const sql = sqlParts.join('\n');

  assert.match(migrationFiles[0] ?? '', /^0001_/);
  assert.match(
    sql,
    /rag_schema_migrations[\s\S]*?version\s+text\s+primary key[\s\S]*?checksum\s+char\(64\)\s+not null/i
  );

  for (const forbidden of [
    /\bauth\s*\./i,
    /\bauthenticated\b/i,
    /\bstorage\s*\./i,
    /\bextensions\s*\./i,
    /\bcreate\s+extension\b/i,
    /\bvector\s*\(/i,
  ]) {
    assert.doesNotMatch(sql, forbidden);
  }

  for (const table of [
    'rag_schema_migrations',
    'tenants',
    'corpora',
    'document_assets',
    'object_blobs',
    'index_jobs',
    'traces',
    'observations',
    'trace_scores',
    'maic_courses',
    'maic_classroom_sessions',
    'prompt_optimizer_model_profiles',
    'prompt_optimizer_workspaces',
    'prompt_optimizer_versions',
  ]) {
    assert.match(sql, new RegExp(`create table(?: if not exists)? public\\.${table}\\b`, 'i'));
  }

  assert.match(sql, /document_assets[\s\S]*?external_document_id\s+text/i);
  assert.match(sql, /create table public\.tenants\s*\(\s*id\s+text\s+primary key/i);
  assert.match(sql, /create table public\.corpora\s*\(\s*id\s+text\s+primary key\s*,\s*tenant_id\s+text/i);
  assert.match(sql, /unique\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*external_document_id\s*\)/i);
  assert.match(sql, /unique\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*source_hash\s*\)/i);
  assert.match(sql, /object_blobs[\s\S]*?kind\s+text[\s\S]*?kind\s+in\s*\(\s*'raw'\s*,\s*'parsed'\s*,\s*'artifact'\s*\)/i);
  assert.match(sql, /unique\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*filename\s*\)/i);

  // Scope is part of each FK, so a globally valid child id cannot be attached to another tenant.
  assert.match(sql, /foreign key\s*\(\s*tenant_id\s*,\s*corpus_id\s*\)\s+references\s+public\.corpora\s*\(\s*tenant_id\s*,\s*id\s*\)/i);
  assert.match(sql, /foreign key\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*document_id\s*\)\s+references\s+public\.document_assets\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*id\s*\)/i);

  // A parent observation and a scored observation must belong to the same trace.
  assert.match(sql, /foreign key\s*\(\s*trace_id\s*,\s*parent_observation_id\s*\)\s+references\s+public\.observations\s*\(\s*trace_id\s*,\s*id\s*\)/i);
  assert.match(sql, /foreign key\s*\(\s*trace_id\s*,\s*observation_id\s*\)\s+references\s+public\.observations\s*\(\s*trace_id\s*,\s*id\s*\)/i);
  assert.match(sql, /create trigger[\s\S]*?updated_at/i);
  assert.match(
    sql,
    /foreign key\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*course_id\s*\)\s+references\s+public\.maic_courses\s*\(\s*tenant_id\s*,\s*corpus_id\s*,\s*course_id\s*\)\s+on delete cascade/i
  );
  assert.match(sql, /maic_courses[\s\S]*?payload\s+jsonb[\s\S]*?version\s+bigint/i);
  assert.match(sql, /maic_classroom_sessions[\s\S]*?payload\s+jsonb[\s\S]*?version\s+bigint/i);
  assert.match(sql, /prompt_optimizer_model_profiles[\s\S]*?provider\s+text[\s\S]*?settings\s+jsonb/i);
  assert.match(sql, /prompt_optimizer_workspaces[\s\S]*?variables\s+jsonb[\s\S]*?current_version\s+integer/i);
  assert.match(sql, /prompt_optimizer_versions[\s\S]*?version_number\s+integer[\s\S]*?prompt\s+text/i);
  assert.match(sql, /unique index prompt_optimizer_one_default_profile_idx/i);
});

test('migration discovery is ordered, checksummed, and rejects duplicate versions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-pg-migrations-'));
  try {
    const firstSql = 'select 1 as first;\r\n';
    const secondSql = 'select 2 as second;\n';
    await Promise.all([
      writeFile(path.join(directory, '0002_second.sql'), secondSql),
      writeFile(path.join(directory, '0001_first.sql'), firstSql),
      writeFile(path.join(directory, 'README.md'), 'ignored'),
    ]);

    const migrations = await loadMigrations(directory);
    assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
      { version: '0001', name: 'first' },
      { version: '0002', name: 'second' },
    ]);
    assert.equal(migrations[0].checksum, sha256(firstSql.replace(/\r\n?/g, '\n')));
    assert.equal(migrations[1].checksum, sha256(secondSql));

    await writeFile(path.join(directory, '0001_duplicate.sql'), 'select 3;\n');
    await assert.rejects(() => loadMigrations(directory), /duplicate migration version 0001/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('already applied migrations are skipped and new migrations use one transaction each', async () => {
  const migrations = migrationFixtures();
  const calls = [];
  const client = fakeClient(async (text, values) => {
    calls.push({ text, values });
    if (/select\s+version\s*,\s*name\s*,\s*checksum/i.test(text)) {
      return {
        rows: [{
          version: migrations[0].version,
          name: migrations[0].name,
          checksum: migrations[0].checksum,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });

  const summary = await applyMigrations(client, migrations);

  assert.deepEqual(summary, { applied: ['0002'], skipped: ['0001'] });
  assert.equal(calls.some(({ text }) => text === migrations[0].sql), false);
  assert.equal(calls.filter(({ text }) => /^begin$/i.test(text)).length, 1);
  assert.equal(calls.filter(({ text }) => /^commit$/i.test(text)).length, 1);
  assert.equal(calls.filter(({ text }) => /^rollback$/i.test(text)).length, 0);
  assert.equal(calls.filter(({ text }) => text === migrations[1].sql).length, 1);
  const ledgerWrite = calls.find(({ text }) => /insert into public\.rag_schema_migrations/i.test(text));
  assert.deepEqual(ledgerWrite?.values, [
    migrations[1].version,
    migrations[1].name,
    migrations[1].checksum,
  ]);
});

test('checksum drift fails before migration SQL executes', async () => {
  const [migration] = migrationFixtures();
  const calls = [];
  const client = fakeClient(async (text) => {
    calls.push(text);
    if (/select\s+version\s*,\s*name\s*,\s*checksum/i.test(text)) {
      return {
        rows: [{ version: migration.version, name: migration.name, checksum: '0'.repeat(64) }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    () => applyMigrations(client, [migration]),
    /migration 0001 checksum mismatch/i
  );
  assert.equal(calls.includes(migration.sql), false);
  assert.equal(calls.some((text) => /^begin$/i.test(text)), false);
});

test('an applied migration cannot appear ahead of an unapplied predecessor', async () => {
  const migrations = migrationFixtures();
  const calls = [];
  const client = fakeClient(async (text) => {
    calls.push(text);
    if (/select\s+version\s*,\s*name\s*,\s*checksum/i.test(text)) {
      return { rows: [migrations[1]], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    () => applyMigrations(client, migrations),
    /migration 0002 is not an ordered prefix/i
  );
  assert.equal(calls.some((text) => /^begin$/i.test(text)), false);
});

test('a failed migration rolls back and redacts driver and DSN details', async () => {
  const dsn = 'postgresql://rag:super-secret@db.internal:5432/rag';
  const [migration] = migrationFixtures();
  const calls = [];
  const client = fakeClient(async (text) => {
    calls.push(text);
    if (/select\s+version\s*,\s*name\s*,\s*checksum/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    if (text === migration.sql) {
      const error = new Error(`connection failed for ${dsn}`);
      error.code = 'ECONNRESET';
      throw error;
    }
    return { rows: [], rowCount: 1 };
  });

  await assert.rejects(
    () => applyMigrations(client, [migration]),
    (error) => {
      assert.match(error.message, /migration 0001 failed/i);
      assert.doesNotMatch(error.message, /super-secret|db\.internal/i);
      assert.doesNotMatch(formatCliError(error), /super-secret|db\.internal/i);
      return true;
    }
  );
  assert.deepEqual(calls.slice(-2), [migration.sql, 'rollback']);
  assert.equal(calls.some((text) => /^commit$/i.test(text)), false);
  assert.equal(formatCliError(new Error(`cannot connect to ${dsn}`)), 'PostgreSQL migration failed.');
});

test('migration advisory lock is always released', async () => {
  const calls = [];
  const client = fakeClient(async (text) => {
    calls.push(text);
    return { rows: [], rowCount: 1 };
  });

  await assert.rejects(
    () => withMigrationLock(client, async () => {
      throw new Error('expected work failure');
    }),
    /expected work failure/
  );

  assert.match(calls[0], /pg_advisory_lock/i);
  assert.match(calls.at(-1), /pg_advisory_unlock/i);
});

test('default text scope seed is parameterized, idempotent, and requires paired safe identifiers', async () => {
  const scope = {
    tenantId: 'songuu-production',
    corpusId: 'default',
  };
  const calls = [];
  const client = fakeClient(async (text, values) => {
    calls.push({ text, values });
    if (/select\s+t\.id\s+as\s+tenant_id/i.test(text)) {
      return {
        rows: [{
          tenant_id: scope.tenantId,
          corpus_id: scope.corpusId,
          corpus_tenant_id: scope.tenantId,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });

  await seedDefaultScope(client, scope);
  await seedDefaultScope(client, scope);

  const tenantInserts = calls.filter(({ text }) => /insert into public\.tenants/i.test(text));
  const corpusInserts = calls.filter(({ text }) => /insert into public\.corpora/i.test(text));
  assert.equal(tenantInserts.length, 2);
  assert.equal(corpusInserts.length, 2);
  assert.ok([...tenantInserts, ...corpusInserts].every(({ text }) => /on conflict \(id\) do nothing/i.test(text)));
  assert.ok(calls.every(({ text }) => !text.includes(scope.tenantId) && !text.includes(scope.corpusId)));
  assert.deepEqual(resolveSeedScope({
    RAG_DEFAULT_TENANT_ID: scope.tenantId,
    RAG_DEFAULT_CORPUS_ID: scope.corpusId,
  }), scope);
  assert.throws(
    () => resolveSeedScope({ RAG_DEFAULT_TENANT_ID: scope.tenantId }),
    /must be configured together/i
  );
  assert.throws(
    () => resolveSeedScope({
      RAG_DEFAULT_TENANT_ID: 'tenant-a',
      RAG_DEFAULT_CORPUS_ID: 'unsafe corpus',
    }),
    /valid scope identifier/i
  );
});

function migrationFixtures() {
  return [
    fixture('0001', 'first', 'select 1 as first;'),
    fixture('0002', 'second', 'select 2 as second;'),
  ];
}

function fixture(version, name, sql) {
  return { version, name, filename: `${version}_${name}.sql`, sql, checksum: sha256(sql) };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fakeClient(query) {
  return { query };
}
