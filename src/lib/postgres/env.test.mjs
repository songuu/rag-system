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
  getPostgresConfigSummary,
  getPostgresRuntimeConfig,
  isPostgresConfigured,
  shouldDualWritePostgres,
  shouldUsePostgresPersistence,
} = await import('./env.ts');

test('PostgreSQL persistence is opt-in and local remains the safe default', () => {
  const config = getPostgresRuntimeConfig({});

  assert.equal(config.persistenceBackend, 'local');
  assert.equal(config.sslMode, 'disable');
  assert.equal(isPostgresConfigured(config), false);
  assert.equal(shouldUsePostgresPersistence(config), false);
});

test('PostgreSQL runtime config reads a direct database URL and bounded pool settings', () => {
  const config = getPostgresRuntimeConfig({
    DATABASE_URL: 'postgresql://rag:secret@db.internal:5432/rag',
    POSTGRES_DEFAULT_TENANT_ID: 'tenant-a',
    POSTGRES_DEFAULT_CORPUS_ID: 'corpus-a',
    POSTGRES_SSL_MODE: 'verify-full',
    POSTGRES_MAX_CONNECTIONS: '12',
    POSTGRES_IDLE_TIMEOUT_MS: '45000',
    POSTGRES_CONNECTION_TIMEOUT_MS: '6000',
    RAG_PERSISTENCE_BACKEND: 'postgres',
    RAG_VECTOR_BACKEND: 'postgres_pgvector',
  });

  assert.equal(config.databaseUrl, 'postgresql://rag:secret@db.internal:5432/rag');
  assert.equal(config.defaultTenantId, 'tenant-a');
  assert.equal(config.defaultCorpusId, 'corpus-a');
  assert.equal(config.sslMode, 'verify-full');
  assert.equal(config.maxConnections, 12);
  assert.equal(config.idleTimeoutMs, 45000);
  assert.equal(config.connectionTimeoutMs, 6000);
  assert.equal(config.persistenceBackend, 'postgres');
  assert.equal(config.vectorBackend, 'postgres_pgvector');
  assert.equal(isPostgresConfigured(config), true);
  assert.equal(shouldUsePostgresPersistence(config), true);
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

test('legacy Supabase backend values fail closed instead of silently using local storage', () => {
  assert.throws(
    () => getPostgresRuntimeConfig({ RAG_PERSISTENCE_BACKEND: 'supabase' }),
    /RAG_PERSISTENCE_BACKEND.*supabase.*not supported/i
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
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
