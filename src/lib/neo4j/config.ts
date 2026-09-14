export interface Neo4jRuntimeConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
  connectionTimeoutMs: number;
  queryTimeoutMs: number;
  writeTimeoutMs: number;
  maxTransactionRetryTimeMs: number;
  maxConnectionPoolSize: number;
}

const SUPPORTED_PROTOCOLS = new Set([
  'neo4j:',
  'neo4j+s:',
  'neo4j+ssc:',
  'bolt:',
  'bolt+s:',
  'bolt+ssc:',
]);
const SAFE_DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const VERIFIED_TLS_PROTOCOLS = new Set(['neo4j+s:', 'bolt+s:']);

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() || '';
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

function validateNeo4jUri(uri: string): URL | null {
  if (!uri) return null;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('NEO4J_URI must be a valid Neo4j connection URI.');
  }

  if (
    !SUPPORTED_PROTOCOLS.has(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new Error(
      'NEO4J_URI must use neo4j/bolt, contain a host, and must not embed credentials, parameters, fragments, or a database path.'
    );
  }
  return parsed;
}

export function getNeo4jRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): Neo4jRuntimeConfig {
  const uri = readEnv(env, 'NEO4J_URI');
  const database = readEnv(env, 'NEO4J_DATABASE') || 'neo4j';
  const parsedUri = validateNeo4jUri(uri);
  const allowInsecure = readBooleanFlag(env, 'NEO4J_ALLOW_INSECURE');
  const requireTls = env.NODE_ENV === 'production'
    || readBooleanFlag(env, 'RAG_NEO4J_REQUIRE_TLS');
  if (
    parsedUri
    && requireTls
    && !VERIFIED_TLS_PROTOCOLS.has(parsedUri.protocol)
    && !allowInsecure
  ) {
    throw new Error(
      'Production Neo4j requires neo4j+s:// or bolt+s://. '
      + 'Set NEO4J_ALLOW_INSECURE=true only for an explicitly accepted exception.'
    );
  }
  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error(
      'NEO4J_DATABASE must start with a letter or digit and contain at most 63 letters, digits, dots, underscores, or hyphens.'
    );
  }

  return {
    uri,
    username: readEnv(env, 'NEO4J_USERNAME'),
    password: readEnv(env, 'NEO4J_PASSWORD'),
    database,
    connectionTimeoutMs: parseBoundedInteger({
      env,
      name: 'NEO4J_CONNECTION_TIMEOUT_MS',
      fallback: 5_000,
      min: 100,
      max: 30_000,
    }),
    queryTimeoutMs: parseBoundedInteger({
      env,
      name: 'RAG_GRAPH_QUERY_TIMEOUT_MS',
      fallback: 3_000,
      min: 50,
      max: 600_000,
    }),
    writeTimeoutMs: parseBoundedInteger({
      env,
      name: 'RAG_GRAPH_WRITE_TIMEOUT_MS',
      fallback: 120_000,
      min: 1_000,
      max: 600_000,
    }),
    maxTransactionRetryTimeMs: parseBoundedInteger({
      env,
      name: 'NEO4J_MAX_TRANSACTION_RETRY_MS',
      fallback: 1_000,
      min: 0,
      max: 30_000,
    }),
    maxConnectionPoolSize: parseBoundedInteger({
      env,
      name: 'NEO4J_MAX_CONNECTION_POOL_SIZE',
      fallback: 25,
      min: 1,
      max: 500,
    }),
  };
}

function readBooleanFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = readEnv(env, name).toLowerCase();
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

export function isNeo4jConfigured(config: Neo4jRuntimeConfig): boolean {
  return Boolean(config.uri && config.username && config.password);
}

export function assertNeo4jConfigured(config: Neo4jRuntimeConfig): void {
  const missing = [
    !config.uri ? 'NEO4J_URI' : '',
    !config.username ? 'NEO4J_USERNAME' : '',
    !config.password ? 'NEO4J_PASSWORD' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Neo4j requires ${missing.join(', ')}.`);
  }
}

export function getNeo4jConfigSummary(config: Neo4jRuntimeConfig) {
  return {
    configured: isNeo4jConfigured(config),
    database: config.database,
    hasUri: Boolean(config.uri),
    hasUsername: Boolean(config.username),
    hasPassword: Boolean(config.password),
    connectionTimeoutMs: config.connectionTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    writeTimeoutMs: config.writeTimeoutMs,
    maxTransactionRetryTimeMs: config.maxTransactionRetryTimeMs,
    maxConnectionPoolSize: config.maxConnectionPoolSize,
  };
}
