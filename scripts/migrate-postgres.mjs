import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const POSTGRES_ROOT = path.resolve(SCRIPT_DIR, '..', 'db', 'postgres');

export const DEFAULT_MIGRATIONS_DIRECTORY = path.join(POSTGRES_ROOT, 'migrations');
export const DEFAULT_BOOTSTRAP_PATH = path.join(POSTGRES_ROOT, 'bootstrap.sql');

const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/i;
const SAFE_SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ROLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LOCK_SQL = "select pg_advisory_lock(hashtext('rag-system'), hashtext('schema-migrations'))";
const UNLOCK_SQL = "select pg_advisory_unlock(hashtext('rag-system'), hashtext('schema-migrations'))";

export class MigrationRunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationRunnerError';
  }
}

export async function loadMigrations(directory = DEFAULT_MIGRATIONS_DIRECTORY) {
  const entries = await readdir(directory, { withFileTypes: true });
  const descriptors = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ filename: entry.name, match: MIGRATION_FILENAME.exec(entry.name) }))
    .filter((entry) => entry.match)
    .map(({ filename, match }) => ({
      filename,
      version: match[1],
      name: match[2],
    }))
    .sort((left, right) => left.version.localeCompare(right.version)
      || left.filename.localeCompare(right.filename));

  const seenVersions = new Set();
  for (const descriptor of descriptors) {
    if (seenVersions.has(descriptor.version)) {
      throw new MigrationRunnerError(
        `Duplicate migration version ${descriptor.version} was found.`
      );
    }
    seenVersions.add(descriptor.version);
  }

  if (descriptors.length === 0) {
    throw new MigrationRunnerError('No PostgreSQL migrations were found.');
  }

  return await Promise.all(descriptors.map(async (descriptor) => {
    const sql = await readFile(path.join(directory, descriptor.filename), 'utf8');
    return {
      ...descriptor,
      sql,
      checksum: createHash('sha256').update(normalizeSqlForChecksum(sql)).digest('hex'),
    };
  }));
}

export async function applyMigrations(client, migrations) {
  const ledger = await safeQuery(
    client,
    `select version, name, checksum
     from public.rag_schema_migrations
     order by version asc`,
    [],
    'PostgreSQL migration ledger could not be read.'
  );
  const appliedByVersion = new Map();

  for (const [index, row] of ledger.rows.entries()) {
    const version = typeof row.version === 'string' ? row.version : '';
    const local = migrations[index];
    if (!local || local.version !== version) {
      throw new MigrationRunnerError(
        `Database migration ${safeVersion(version)} is not an ordered prefix of this checkout.`
      );
    }
    if (row.name !== local.name) {
      throw new MigrationRunnerError(`Migration ${local.version} name mismatch.`);
    }
    if (row.checksum !== local.checksum) {
      throw new MigrationRunnerError(`Migration ${local.version} checksum mismatch.`);
    }
    appliedByVersion.set(version, row);
  }

  const summary = { applied: [], skipped: [] };
  for (const migration of migrations) {
    if (appliedByVersion.has(migration.version)) {
      summary.skipped.push(migration.version);
      continue;
    }

    await withTransaction(
      client,
      `PostgreSQL migration ${migration.version} failed.`,
      async () => {
        await safeQuery(
          client,
          migration.sql,
          [],
          `PostgreSQL migration ${migration.version} failed.`
        );
        await safeQuery(
          client,
          `insert into public.rag_schema_migrations (version, name, checksum)
           values ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
          `PostgreSQL migration ${migration.version} ledger write failed.`
        );
      }
    );
    summary.applied.push(migration.version);
  }

  return summary;
}

export async function withMigrationLock(client, work) {
  await safeQuery(
    client,
    LOCK_SQL,
    [],
    'PostgreSQL migration advisory lock could not be acquired.'
  );

  let result;
  let failure;
  try {
    result = await work();
  } catch (error) {
    failure = error;
  }

  try {
    await safeQuery(
      client,
      UNLOCK_SQL,
      [],
      'PostgreSQL migration advisory lock could not be released.'
    );
  } catch (error) {
    if (!failure) failure = error;
  }

  if (failure) throw failure;
  return result;
}

export async function ensureMigrationLedger(client, bootstrapSql) {
  await withTransaction(
    client,
    'PostgreSQL migration ledger bootstrap failed.',
    async () => {
      await safeQuery(
        client,
        bootstrapSql,
        [],
        'PostgreSQL migration ledger bootstrap failed.'
      );
    }
  );
}

export async function seedDefaultScope(client, scope) {
  assertScope(scope);
  await withTransaction(
    client,
    'PostgreSQL default scope seed failed.',
    async () => {
      await safeQuery(
        client,
        `insert into public.tenants (id, name, metadata)
         values ($1, $2, '{}'::jsonb)
         on conflict (id) do nothing`,
        [scope.tenantId, 'RAG default tenant'],
        'PostgreSQL default tenant seed failed.'
      );
      await safeQuery(
        client,
        `insert into public.corpora (id, tenant_id, name, source_kind, metadata)
         select $1, $2, $3, $4, '{}'::jsonb
         from public.tenants
         where id = $2
         on conflict (id) do nothing`,
        [scope.corpusId, scope.tenantId, 'RAG default corpus', 'application'],
        'PostgreSQL default corpus seed failed.'
      );
      const verification = await safeQuery(
        client,
        `select
           t.id as tenant_id,
           c.id as corpus_id,
           c.tenant_id as corpus_tenant_id
         from public.tenants t
         left join public.corpora c on c.id = $2
         where t.id = $1`,
        [scope.tenantId, scope.corpusId],
        'PostgreSQL default scope seed verification failed.'
      );
      const row = verification.rows[0];
      if (
        row?.tenant_id !== scope.tenantId
        || row?.corpus_id !== scope.corpusId
        || row?.corpus_tenant_id !== scope.tenantId
      ) {
        throw new MigrationRunnerError(
          'PostgreSQL default scope conflicts with an existing tenant or corpus.'
        );
      }
    }
  );
}

export function resolveSeedScope(env = process.env) {
  const tenantId = readEnv(env, 'RAG_DEFAULT_TENANT_ID')
    || readEnv(env, 'POSTGRES_DEFAULT_TENANT_ID');
  const corpusId = readEnv(env, 'RAG_DEFAULT_CORPUS_ID')
    || readEnv(env, 'POSTGRES_DEFAULT_CORPUS_ID');

  if (!tenantId && !corpusId) return null;
  if (!tenantId || !corpusId) {
    throw new MigrationRunnerError(
      'RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID must be configured together.'
    );
  }
  const scope = { tenantId, corpusId };
  assertScope(scope);
  return scope;
}

export async function runMigrationSession(client, options = {}) {
  const migrations = options.migrations ?? await loadMigrations(
    options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY
  );
  const bootstrapSql = options.bootstrapSql ?? await readFile(
    options.bootstrapPath ?? DEFAULT_BOOTSTRAP_PATH,
    'utf8'
  );
  const seedScope = options.seedScope ?? null;
  const appRole = options.appRole ?? null;

  return await withMigrationLock(client, async () => {
    await ensureMigrationLedger(client, bootstrapSql);
    const summary = await applyMigrations(client, migrations);
    if (seedScope) await seedDefaultScope(client, seedScope);
    if (appRole) await grantApplicationRole(client, appRole);
    return { ...summary, seeded: Boolean(seedScope), appRoleGranted: Boolean(appRole) };
  });
}

export function formatCliError(error) {
  if (error instanceof MigrationRunnerError) return error.message;
  return 'PostgreSQL migration failed.';
}

export function assertDatabaseUrlHasNoSslParameters(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return;
  }
  const conflictingParameter = [
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
  ].find((name) => parsed.searchParams.has(name));
  if (conflictingParameter) {
    throw new MigrationRunnerError(
      `PostgreSQL database URL must not contain ${conflictingParameter}; configure TLS with POSTGRES_SSL_MODE and NODE_EXTRA_CA_CERTS.`
    );
  }
}

export function resolveDatabaseUrl(env = process.env) {
  const databaseUrl = readEnv(env, 'DATABASE_URL');
  const postgresUrl = readEnv(env, 'POSTGRES_URL');
  if (databaseUrl && postgresUrl && databaseUrl !== postgresUrl) {
    throw new MigrationRunnerError(
      'DATABASE_URL and POSTGRES_URL must not point to different databases.'
    );
  }
  return postgresUrl || databaseUrl;
}

export function resolveMigrationDatabaseUrl(env = process.env) {
  return readEnv(env, 'POSTGRES_MIGRATION_URL') || resolveDatabaseUrl(env);
}

export function resolveApplicationRole(env = process.env) {
  const role = readEnv(env, 'POSTGRES_APP_ROLE');
  if (!role) return null;
  if (!SAFE_ROLE_IDENTIFIER.test(role)) {
    throw new MigrationRunnerError(
      'POSTGRES_APP_ROLE must be a valid PostgreSQL identifier.'
    );
  }
  return role;
}

export async function grantApplicationRole(client, role) {
  if (!SAFE_ROLE_IDENTIFIER.test(role || '')) {
    throw new MigrationRunnerError(
      'POSTGRES_APP_ROLE must be a valid PostgreSQL identifier.'
    );
  }
  const quotedRole = `"${role}"`;
  await withTransaction(
    client,
    'PostgreSQL application role grants failed.',
    async () => {
      for (const statement of [
        `grant usage on schema public to ${quotedRole}`,
        `grant select on table public.rag_schema_migrations to ${quotedRole}`,
        `grant select, insert, update, delete on table
           public.tenants, public.corpora, public.document_assets,
           public.object_blobs, public.index_jobs, public.traces,
           public.observations, public.trace_scores
         to ${quotedRole}`,
        `grant usage, select on all sequences in schema public to ${quotedRole}`,
        `alter default privileges in schema public
         grant select, insert, update, delete on tables to ${quotedRole}`,
        `alter default privileges in schema public
         grant usage, select on sequences to ${quotedRole}`,
      ]) {
        await safeQuery(
          client,
          statement,
          [],
          'PostgreSQL application role grants failed.'
        );
      }
    }
  );
}

async function withTransaction(client, failureMessage, work) {
  await safeQuery(client, 'begin', [], failureMessage);
  try {
    const result = await work();
    await safeQuery(client, 'commit', [], failureMessage);
    return result;
  } catch (error) {
    try {
      await safeQuery(client, 'rollback', [], failureMessage);
    } catch {
      // Preserve the original failure; a broken connection will be discarded by the caller.
    }
    throw error instanceof MigrationRunnerError
      ? error
      : new MigrationRunnerError(failureMessage);
  }
}

async function safeQuery(client, text, values, failureMessage) {
  try {
    return await client.query(text, values);
  } catch {
    // Driver messages can contain connection details or SQL values, so never expose the cause.
    throw new MigrationRunnerError(failureMessage);
  }
}

function assertScope(scope) {
  if (
    !SAFE_SCOPE_IDENTIFIER.test(scope?.tenantId || '')
    || !SAFE_SCOPE_IDENTIFIER.test(scope?.corpusId || '')
  ) {
    throw new MigrationRunnerError(
      'RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID must each be a valid scope identifier.'
    );
  }
}

function readEnv(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function safeVersion(version) {
  return /^\d{4}$/.test(version) ? version : 'unknown';
}

function normalizeSqlForChecksum(sql) {
  return sql.replace(/\r\n?/g, '\n');
}

function resolveSsl(env) {
  const mode = readEnv(env, 'POSTGRES_SSL_MODE').toLowerCase();
  if (!mode || mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  throw new MigrationRunnerError(
    'POSTGRES_SSL_MODE must be disable, require, or verify-full.'
  );
}

async function main() {
  const databaseUrl = resolveMigrationDatabaseUrl(process.env);
  if (!databaseUrl) {
    throw new MigrationRunnerError('PostgreSQL migration requires DATABASE_URL or POSTGRES_URL.');
  }
  assertDatabaseUrlHasNoSslParameters(databaseUrl);
  const seedScope = resolveSeedScope(process.env);
  const appRole = resolveApplicationRole(process.env);
  const pgModule = await import('pg');
  const Client = pgModule.Client ?? pgModule.default?.Client;
  if (!Client) throw new MigrationRunnerError('PostgreSQL driver is unavailable.');

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'rag-system-migrations',
    ssl: resolveSsl(process.env),
  });
  try {
    await client.connect();
    const summary = await runMigrationSession(client, { seedScope, appRole });
    console.log(
      `[migrate:postgres] applied=${summary.applied.length} skipped=${summary.skipped.length} seeded=${summary.seeded}`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`[migrate:postgres] ${formatCliError(error)}`);
    process.exitCode = 1;
  });
}
