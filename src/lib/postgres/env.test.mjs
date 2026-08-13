import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  assertPostgresPersistenceConfigured,
  getPostgresConfigSummary,
  getPostgresRuntimeConfig,
  isPostgresConfigured,
  shouldDualWritePostgres,
  shouldUsePostgresPersistence,
} = await import('./env.ts');

test('local persistence remains an explicit development-only default', () => {
  const config = getPostgresRuntimeConfig({ NODE_ENV: 'development' });

  assert.equal(config.persistenceBackend, 'local');
  assert.equal(config.sslMode, 'disable');
  assert.equal(isPostgresConfigured(config), false);
  assert.equal(shouldUsePostgresPersistence(config), false);
});

test('production defaults to PostgreSQL and rejects local or dual-write persistence', () => {
  assert.equal(
    getPostgresRuntimeConfig({ NODE_ENV: 'production' }).persistenceBackend,
    'postgres'
  );
  for (const backend of ['local', 'dual-write']) {
    assert.throws(
      () => getPostgresRuntimeConfig({
        NODE_ENV: 'production',
        RAG_PERSISTENCE_BACKEND: backend,
      }),
      /production.*postgres/i
    );
  }
});

test('PostgreSQL runtime config reads a direct database URL and bounded pool settings', () => {
  const config = getPostgresRuntimeConfig({
    DATABASE_URL: 'postgresql://rag:secret@db.internal:5432/rag',
    RAG_DEFAULT_TENANT_ID: 'tenant-a',
    RAG_DEFAULT_CORPUS_ID: 'corpus-a',
    POSTGRES_SSL_MODE: 'verify-full',
    POSTGRES_MAX_CONNECTIONS: '12',
    POSTGRES_IDLE_TIMEOUT_MS: '45000',
    POSTGRES_CONNECTION_TIMEOUT_MS: '6000',
    RAG_PERSISTENCE_BACKEND: 'postgres',
    RAG_VECTOR_BACKEND: 'milvus',
  });

  assert.equal(config.databaseUrl, 'postgresql://rag:secret@db.internal:5432/rag');
  assert.equal(config.defaultTenantId, 'tenant-a');
  assert.equal(config.defaultCorpusId, 'corpus-a');
  assert.equal(config.sslMode, 'verify-full');
  assert.equal(config.maxConnections, 12);
  assert.equal(config.idleTimeoutMs, 45000);
  assert.equal(config.connectionTimeoutMs, 6000);
  assert.equal(config.persistenceBackend, 'postgres');
  assert.equal(config.vectorBackend, 'milvus');
  assert.equal(isPostgresConfigured(config), true);
  assert.equal(shouldUsePostgresPersistence(config), true);
});

test('vendor-neutral scope variables take precedence over compatibility aliases', () => {
  const config = getPostgresRuntimeConfig({
    RAG_DEFAULT_TENANT_ID: 'tenant-primary',
    RAG_DEFAULT_CORPUS_ID: 'corpus-primary',
    POSTGRES_DEFAULT_TENANT_ID: 'tenant-legacy',
    POSTGRES_DEFAULT_CORPUS_ID: 'corpus-legacy',
  });

  assert.equal(config.defaultTenantId, 'tenant-primary');
  assert.equal(config.defaultCorpusId, 'corpus-primary');
});

test('dual-write remains explicit during a controlled PostgreSQL cutover', () => {
  const config = getPostgresRuntimeConfig({
    DATABASE_URL: 'postgresql://rag:secret@db.internal:5432/rag',
    POSTGRES_DEFAULT_TENANT_ID: 'tenant-a',
    POSTGRES_DEFAULT_CORPUS_ID: 'corpus-a',
    RAG_PERSISTENCE_BACKEND: 'dual-write',
  });

  assert.equal(shouldUsePostgresPersistence(config), true);
  assert.equal(shouldDualWritePostgres(config), true);
});

test('configuration summary never exposes the database URL or password', () => {
  const config = getPostgresRuntimeConfig({
    DATABASE_URL: 'postgresql://rag:do-not-leak@db.internal:5432/rag',
    POSTGRES_DEFAULT_TENANT_ID: 'tenant-a',
    POSTGRES_DEFAULT_CORPUS_ID: 'corpus-a',
    RAG_PERSISTENCE_BACKEND: 'postgres',
  });

  const summary = getPostgresConfigSummary(config);
  assert.equal(summary.hasDatabaseUrl, true);
  assert.equal(JSON.stringify(summary).includes('do-not-leak'), false);
  assert.equal('databaseUrl' in summary, false);
});

test('unknown persistence backend values fail closed instead of silently using local storage', () => {
  assert.throws(
    () => getPostgresRuntimeConfig({ RAG_PERSISTENCE_BACKEND: 'managed-cloud' }),
    /RAG_PERSISTENCE_BACKEND.*managed-cloud.*not supported/i
  );
});

test('invalid PostgreSQL pool and SSL settings fail with their variable names', () => {
  assert.throws(
    () => getPostgresRuntimeConfig({ POSTGRES_MAX_CONNECTIONS: '0' }),
    /POSTGRES_MAX_CONNECTIONS/
  );
  assert.throws(
    () => getPostgresRuntimeConfig({ POSTGRES_SSL_MODE: 'prefer' }),
    /POSTGRES_SSL_MODE/
  );
  assert.throws(
    () => getPostgresRuntimeConfig({
      DATABASE_URL: 'postgresql://rag:secret@db.internal/rag?sslmode=require',
      POSTGRES_SSL_MODE: 'verify-full',
    }),
    /DATABASE_URL.*sslmode.*POSTGRES_SSL_MODE/i
  );
  assert.throws(
    () => getPostgresRuntimeConfig({
      DATABASE_URL: 'postgresql://rag:secret@old-db/rag',
      POSTGRES_URL: 'postgresql://rag:secret@new-db/rag',
    }),
    /DATABASE_URL and POSTGRES_URL.*different databases/i
  );
  assert.throws(
    () => getPostgresRuntimeConfig({ DATABASE_URL: 'not-a-database-url' }),
    /DATABASE_URL.*valid PostgreSQL connection URL/i
  );
  assert.throws(
    () => getPostgresRuntimeConfig({ DATABASE_URL: 'https://db.internal/rag' }),
    /DATABASE_URL.*valid PostgreSQL connection URL/i
  );
});

test('PostgreSQL persistence validates tenant and corpus scope identifiers', () => {
  const config = getPostgresRuntimeConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://rag:secret@db.internal/rag',
    RAG_DEFAULT_TENANT_ID: 'tenant with spaces',
    RAG_DEFAULT_CORPUS_ID: 'default',
  });

  assert.throws(
    () => assertPostgresPersistenceConfigured(config),
    /RAG_DEFAULT_TENANT_ID.*valid scope identifier/i
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
