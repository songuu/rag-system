import {
  resolveRagVectorBackend,
  type RagVectorBackend,
} from '../rag/vector-backend';

export type RagPersistenceBackend = 'local' | 'postgres' | 'dual-write';
export type PostgresSslMode = 'disable' | 'require' | 'verify-full';
export type { RagVectorBackend } from '../rag/vector-backend';

export interface PostgresRuntimeConfig {
  databaseUrl: string;
  defaultTenantId: string;
  defaultCorpusId: string;
  sslMode: PostgresSslMode;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  persistenceBackend: RagPersistenceBackend;
  vectorBackend: RagVectorBackend;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() || '';
}

function parsePersistenceBackend(value: string): RagPersistenceBackend {
  switch (value.toLowerCase()) {
    case 'postgres':
    case 'postgresql':
    case 'pgsql':
      return 'postgres';
    case 'dual-write':
    case 'dual_write':
    case 'dualwrite':
      return 'dual-write';
    case '':
    case 'local':
      return 'local';
    case 'supabase':
      throw new Error(
        'RAG_PERSISTENCE_BACKEND=supabase is not supported; configure postgres or dual-write.'
      );
    default:
      throw new Error(
        `RAG_PERSISTENCE_BACKEND=${value} is not supported; expected local, postgres, or dual-write.`
      );
  }
}

function parseSslMode(value: string): PostgresSslMode {
  const normalized = value.toLowerCase();
  if (!normalized || normalized === 'disable') return 'disable';
  if (normalized === 'require' || normalized === 'verify-full') return normalized;
  throw new Error(
    `POSTGRES_SSL_MODE=${value} is invalid; expected disable, require, or verify-full.`
  );
}

function parseBoundedInteger(input: {
  env: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = readEnv(input.env, input.name);
  if (!raw) return input.fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${input.name} must be an integer between ${input.min} and ${input.max}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < input.min || value > input.max) {
    throw new Error(`${input.name} must be between ${input.min} and ${input.max}.`);
  }
  return value;
}

export function getPostgresRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): PostgresRuntimeConfig {
  return {
    databaseUrl: readEnv(env, 'DATABASE_URL') || readEnv(env, 'POSTGRES_URL'),
    defaultTenantId: readEnv(env, 'POSTGRES_DEFAULT_TENANT_ID'),
    defaultCorpusId: readEnv(env, 'POSTGRES_DEFAULT_CORPUS_ID'),
    sslMode: parseSslMode(readEnv(env, 'POSTGRES_SSL_MODE')),
    maxConnections: parseBoundedInteger({
      env,
      name: 'POSTGRES_MAX_CONNECTIONS',
      fallback: 10,
      min: 1,
      max: 100,
    }),
    idleTimeoutMs: parseBoundedInteger({
      env,
      name: 'POSTGRES_IDLE_TIMEOUT_MS',
      fallback: 30_000,
      min: 1_000,
      max: 600_000,
    }),
    connectionTimeoutMs: parseBoundedInteger({
      env,
      name: 'POSTGRES_CONNECTION_TIMEOUT_MS',
      fallback: 5_000,
      min: 250,
      max: 30_000,
    }),
    persistenceBackend: parsePersistenceBackend(readEnv(env, 'RAG_PERSISTENCE_BACKEND')),
    vectorBackend: resolveRagVectorBackend(readEnv(env, 'RAG_VECTOR_BACKEND')),
  };
}

export function isPostgresConfigured(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
): boolean {
  return Boolean(config.databaseUrl);
}

export function isPostgresPersistenceReady(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
): boolean {
  return Boolean(config.databaseUrl && config.defaultTenantId && config.defaultCorpusId);
}

export function shouldUsePostgresPersistence(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
): boolean {
  return config.persistenceBackend === 'postgres' || config.persistenceBackend === 'dual-write';
}

export function shouldDualWritePostgres(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
): boolean {
  return config.persistenceBackend === 'dual-write';
}

export function assertPostgresPersistenceConfigured(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
): void {
  if (!shouldUsePostgresPersistence(config)) return;
  const missing = [
    !config.databaseUrl ? 'DATABASE_URL' : '',
    !config.defaultTenantId ? 'POSTGRES_DEFAULT_TENANT_ID' : '',
    !config.defaultCorpusId ? 'POSTGRES_DEFAULT_CORPUS_ID' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`PostgreSQL persistence requires ${missing.join(', ')}.`);
  }
}

export function getPostgresConfigSummary(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
) {
  return {
    configured: isPostgresConfigured(config),
    persistenceReady: isPostgresPersistenceReady(config),
    persistenceBackend: config.persistenceBackend,
    vectorBackend: config.vectorBackend,
    hasDatabaseUrl: Boolean(config.databaseUrl),
    hasDefaultTenantId: Boolean(config.defaultTenantId),
    hasDefaultCorpusId: Boolean(config.defaultCorpusId),
    sslMode: config.sslMode,
    maxConnections: config.maxConnections,
    idleTimeoutMs: config.idleTimeoutMs,
    connectionTimeoutMs: config.connectionTimeoutMs,
  };
}
