import {
  resolveRagVectorBackend,
  type RagVectorBackend,
} from '../rag/vector-backend';

export type RagPersistenceBackend = 'local' | 'postgres' | 'dual-write';
export type PostgresSslMode = 'disable' | 'require' | 'verify-full';
export type { RagVectorBackend } from '../rag/vector-backend';

const SAFE_SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

function parsePersistenceBackend(value: string, nodeEnv: string): RagPersistenceBackend {
  const normalized = value.toLowerCase();
  if (nodeEnv.toLowerCase() === 'production') {
    if (!normalized || normalized === 'postgres' || normalized === 'postgresql' || normalized === 'pgsql') {
      return 'postgres';
    }
    throw new Error('Production RAG persistence must use postgres.');
  }
  switch (normalized) {
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
    default:
      throw new Error(
        `RAG_PERSISTENCE_BACKEND=${value} is not supported; expected local, postgres, or dual-write in development.`
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
  const databaseUrlAlias = readEnv(env, 'DATABASE_URL');
  const postgresUrl = readEnv(env, 'POSTGRES_URL');
  if (databaseUrlAlias && postgresUrl && databaseUrlAlias !== postgresUrl) {
    throw new Error('DATABASE_URL and POSTGRES_URL must not point to different databases.');
  }
  const databaseUrl = postgresUrl || databaseUrlAlias;
  assertDatabaseUrlHasNoSslParameters(
    databaseUrl,
    postgresUrl ? 'POSTGRES_URL' : 'DATABASE_URL'
  );
  return {
    databaseUrl,
    defaultTenantId: readEnv(env, 'RAG_DEFAULT_TENANT_ID') || readEnv(env, 'POSTGRES_DEFAULT_TENANT_ID'),
    defaultCorpusId: readEnv(env, 'RAG_DEFAULT_CORPUS_ID') || readEnv(env, 'POSTGRES_DEFAULT_CORPUS_ID'),
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
    persistenceBackend: parsePersistenceBackend(
      readEnv(env, 'RAG_PERSISTENCE_BACKEND'),
      readEnv(env, 'NODE_ENV')
    ),
    vectorBackend: resolveRagVectorBackend(readEnv(env, 'RAG_VECTOR_BACKEND')),
  };
}

function assertDatabaseUrlHasNoSslParameters(
  databaseUrl: string,
  variableName: 'DATABASE_URL' | 'POSTGRES_URL'
): void {
  if (!databaseUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL connection URL.`);
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    || !parsed.hostname
  ) {
    throw new Error(`${variableName} must be a valid PostgreSQL connection URL.`);
  }
  const conflictingParameter = [
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
  ].find(name => parsed.searchParams.has(name));
  if (conflictingParameter) {
    throw new Error(
      `${variableName} must not contain ${conflictingParameter}; configure TLS with POSTGRES_SSL_MODE and NODE_EXTRA_CA_CERTS.`
    );
  }
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
    !config.defaultTenantId ? 'RAG_DEFAULT_TENANT_ID' : '',
    !config.defaultCorpusId ? 'RAG_DEFAULT_CORPUS_ID' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`PostgreSQL persistence requires ${missing.join(', ')}.`);
  }
  for (const [name, value] of [
    ['RAG_DEFAULT_TENANT_ID', config.defaultTenantId],
    ['RAG_DEFAULT_CORPUS_ID', config.defaultCorpusId],
  ] as const) {
    if (!SAFE_SCOPE_IDENTIFIER.test(value)) {
      throw new Error(`${name} must be a valid scope identifier.`);
    }
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
