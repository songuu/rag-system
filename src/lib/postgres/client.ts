import { createHash } from 'node:crypto';
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import {
  getPostgresRuntimeConfig,
  isPostgresConfigured,
  type PostgresRuntimeConfig,
} from './env';

export interface PostgresQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresQueryClient {
  query<T>(text: string, values?: unknown[]): Promise<PostgresQueryResult<T>>;
}

interface PostgresPoolLike {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

interface PostgresTransactionPoolLike extends PostgresPoolLike {
  connect(): Promise<PoolClient>;
}

type PostgresPoolFactory = (config: PoolConfig) => PostgresPoolLike;

interface CachedPool {
  signature: string;
  pool: PostgresPoolLike;
  client: PostgresQueryClient;
}

let cachedPool: CachedPool | null = null;

export class PostgresQueryError extends Error {
  readonly operation: string;
  readonly code?: string;

  constructor(operation: string, cause: unknown) {
    super(`PostgreSQL operation failed: ${operation}`, { cause });
    this.name = 'PostgresQueryError';
    this.operation = operation;
    this.code = readErrorCode(cause);
  }
}

export function buildPostgresPoolConfig(config: PostgresRuntimeConfig): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    application_name: 'rag-system',
    ssl: resolveSsl(config),
  };
}

export function createPostgresQueryClient(
  config: PostgresRuntimeConfig,
  poolFactory: PostgresPoolFactory = (poolConfig) => new Pool(poolConfig)
): PostgresQueryClient {
  const pool = poolFactory(buildPostgresPoolConfig(config));
  return wrapPool(pool);
}

export function getPostgresClient(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig()
): PostgresQueryClient | null {
  if (!isPostgresConfigured(config)) return null;

  const signature = poolSignature(config);
  if (!cachedPool || cachedPool.signature !== signature) {
    const previous = cachedPool;
    const pool = new Pool(buildPostgresPoolConfig(config));
    cachedPool = {
      signature,
      pool,
      client: wrapPool(pool),
    };
    if (previous) {
      previous.pool.end().catch((error) => {
        console.warn('[postgres] failed to close replaced connection pool:', safeErrorCode(error));
      });
    }
  }

  return cachedPool.client;
}

export async function closePostgresPool(): Promise<void> {
  const current = cachedPool;
  cachedPool = null;
  if (current) await current.pool.end();
}

export async function queryPostgres<T>(
  client: PostgresQueryClient,
  text: string,
  values: unknown[] = [],
  operation: string
): Promise<PostgresQueryResult<T>> {
  try {
    return await client.query<T>(text, values);
  } catch (error) {
    if (error instanceof PostgresQueryError) throw error;
    throw new PostgresQueryError(operation, error);
  }
}

export async function withPostgresTransaction<T>(
  pool: PostgresTransactionPoolLike,
  operation: string,
  work: (client: PostgresQueryClient) => Promise<T>
): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    const result = await work(wrapPool(connection));
    await connection.query('commit');
    return result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch {
      // Preserve the original operation failure; pool eviction handles a broken connection.
    }
    throw error instanceof PostgresQueryError
      ? error
      : new PostgresQueryError(operation, error);
  } finally {
    connection.release();
  }
}

export async function checkPostgresReadiness(
  config: PostgresRuntimeConfig = getPostgresRuntimeConfig(),
  client: PostgresQueryClient | null = getPostgresClient(config)
): Promise<{ connected: boolean; schemaReady: boolean }> {
  if (!client) return { connected: false, schemaReady: false };
  const result = await queryPostgres<{
    connected: boolean;
    schema_ready: boolean;
  }>(
    client,
    `select
       true as connected,
       to_regclass('public.rag_schema_migrations') is not null
         and to_regclass('public.tenants') is not null
         and to_regclass('public.object_blobs') is not null as schema_ready`,
    [],
    'check database readiness'
  );
  const row = result.rows[0];
  return {
    connected: row?.connected === true,
    schemaReady: row?.schema_ready === true,
  };
}

function wrapPool(pool: PostgresPoolLike): PostgresQueryClient {
  return {
    async query<T>(text: string, values: unknown[] = []): Promise<PostgresQueryResult<T>> {
      const result = await pool.query(text, values);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount,
      };
    },
  };
}

function resolveSsl(config: PostgresRuntimeConfig): PoolConfig['ssl'] {
  switch (config.sslMode) {
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
    case 'disable':
      return false;
  }
}

function poolSignature(config: PostgresRuntimeConfig): string {
  const urlDigest = createHash('sha256').update(config.databaseUrl).digest('hex');
  return [
    urlDigest,
    config.sslMode,
    config.maxConnections,
    config.idleTimeoutMs,
    config.connectionTimeoutMs,
  ].join('|');
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function safeErrorCode(error: unknown): string {
  return readErrorCode(error) || 'unknown';
}
