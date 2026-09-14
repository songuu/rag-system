import { createHash } from 'node:crypto';
import neo4j, {
  type Driver,
  type ManagedTransaction,
  type Session,
} from 'neo4j-driver';
import {
  assertNeo4jConfigured,
  getNeo4jRuntimeConfig,
  isNeo4jConfigured,
  type Neo4jRuntimeConfig,
} from './config';

export interface Neo4jDriverLike {
  verifyConnectivity(): Promise<unknown>;
  session(config: { database: string }): Pick<
    Session,
    'executeRead' | 'executeWrite' | 'close'
  >;
  close(): Promise<void>;
}

export type Neo4jDriverFactory = (config: Neo4jRuntimeConfig) => Neo4jDriverLike;

export interface Neo4jClient {
  verifyConnectivity(): Promise<void>;
  executeRead<T>(
    operation: string,
    work: (transaction: ManagedTransaction) => Promise<T>
  ): Promise<T>;
  executeWrite<T>(
    operation: string,
    work: (transaction: ManagedTransaction) => Promise<T>
  ): Promise<T>;
  close(): Promise<void>;
}

interface CachedNeo4jClient {
  signature: string;
  client: Neo4jClient;
}

let cachedClient: CachedNeo4jClient | null = null;

export class Neo4jOperationError extends Error {
  readonly operation: string;
  readonly code?: string;

  constructor(operation: string, cause: unknown) {
    const safeOperation = sanitizeOperation(operation);
    super(`Neo4j operation failed: ${safeOperation}`, { cause });
    this.name = 'Neo4jOperationError';
    this.operation = safeOperation;
    this.code = readErrorCode(cause);
  }
}

export function createNeo4jClient(
  config: Neo4jRuntimeConfig,
  driverFactory: Neo4jDriverFactory = createOfficialDriver
): Neo4jClient {
  assertNeo4jConfigured(config);

  let driver: Neo4jDriverLike;
  try {
    driver = driverFactory(config);
  } catch (error) {
    throw new Neo4jOperationError('create driver', error);
  }

  return {
    async verifyConnectivity(): Promise<void> {
      try {
        await driver.verifyConnectivity();
      } catch (error) {
        throw asNeo4jOperationError('verify connectivity', error);
      }
    },
    executeRead<T>(operation: string, work: (transaction: ManagedTransaction) => Promise<T>) {
      return executeInSession(driver, config, 'read', operation, work);
    },
    executeWrite<T>(operation: string, work: (transaction: ManagedTransaction) => Promise<T>) {
      return executeInSession(driver, config, 'write', operation, work);
    },
    async close(): Promise<void> {
      try {
        await driver.close();
      } catch (error) {
        throw asNeo4jOperationError('close driver', error);
      }
    },
  };
}

export function getNeo4jClient(
  config: Neo4jRuntimeConfig = getNeo4jRuntimeConfig(),
  driverFactory: Neo4jDriverFactory = createOfficialDriver
): Neo4jClient | null {
  if (!isNeo4jConfigured(config)) return null;

  const signature = configSignature(config);
  if (!cachedClient || cachedClient.signature !== signature) {
    const previous = cachedClient;
    cachedClient = {
      signature,
      client: createNeo4jClient(config, driverFactory),
    };
    if (previous) {
      previous.client.close().catch((error) => {
        console.warn('[neo4j] failed to close replaced driver:', safeErrorCode(error));
      });
    }
  }
  return cachedClient.client;
}

export async function closeNeo4jDriver(): Promise<void> {
  const current = cachedClient;
  cachedClient = null;
  if (current) await current.client.close();
}

export async function checkNeo4jHealth(
  config: Neo4jRuntimeConfig = getNeo4jRuntimeConfig(),
  client: Neo4jClient | null = getNeo4jClient(config)
): Promise<{
  configured: boolean;
  connected: boolean;
  database: string;
  errorCode?: string;
}> {
  if (!isNeo4jConfigured(config) || !client) {
    return {
      configured: false,
      connected: false,
      database: config.database,
    };
  }
  try {
    await client.verifyConnectivity();
    return {
      configured: true,
      connected: true,
      database: config.database,
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      database: config.database,
      errorCode: safeErrorCode(error),
    };
  }
}

async function executeInSession<T>(
  driver: Neo4jDriverLike,
  config: Neo4jRuntimeConfig,
  mode: 'read' | 'write',
  operation: string,
  work: (transaction: ManagedTransaction) => Promise<T>
): Promise<T> {
  let session: ReturnType<Neo4jDriverLike['session']>;
  try {
    session = driver.session({ database: config.database });
  } catch (error) {
    throw asNeo4jOperationError(operation, error);
  }

  let result: T | undefined;
  let failure: unknown;
  try {
    result = mode === 'read'
      ? await session.executeRead(work, { timeout: config.queryTimeoutMs })
      : await session.executeWrite(work, { timeout: config.writeTimeoutMs });
  } catch (error) {
    failure = error;
  }

  try {
    await session.close();
  } catch (error) {
    failure ??= error;
  }

  if (failure) throw asNeo4jOperationError(operation, failure);
  return result as T;
}

function createOfficialDriver(config: Neo4jRuntimeConfig): Driver {
  return neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.username, config.password),
    {
      connectionTimeout: config.connectionTimeoutMs,
      maxTransactionRetryTime: config.maxTransactionRetryTimeMs,
      maxConnectionPoolSize: config.maxConnectionPoolSize,
      userAgent: 'rag-system',
    }
  );
}

function configSignature(config: Neo4jRuntimeConfig): string {
  return createHash('sha256')
    .update([
      config.uri,
      config.username,
      config.password,
      config.database,
      config.connectionTimeoutMs,
      config.queryTimeoutMs,
      config.writeTimeoutMs,
      config.maxTransactionRetryTimeMs,
      config.maxConnectionPoolSize,
    ].join('\0'))
    .digest('hex');
}

function asNeo4jOperationError(operation: string, error: unknown): Neo4jOperationError {
  return error instanceof Neo4jOperationError
    ? error
    : new Neo4jOperationError(operation, error);
}

function sanitizeOperation(operation: string): string {
  const trimmed = operation.trim();
  return /^[A-Za-z0-9 _.:/-]{1,128}$/.test(trimmed)
    ? trimmed
    : 'database operation';
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(code)
    ? code
    : undefined;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Neo4jOperationError) return error.code || 'unknown';
  return readErrorCode(error) || 'unknown';
}
