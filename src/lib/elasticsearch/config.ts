export type ElasticsearchRolloutMode = 'off' | 'shadow' | 'active';

export interface ElasticsearchRuntimeConfig {
  mode: ElasticsearchRolloutMode;
  node: string;
  indexName: string;
  apiKey: string;
  username: string;
  password: string;
  caFingerprint: string;
  allowInsecure: boolean;
  allowUnauthenticated: boolean;
  requestTimeoutMs: number;
  rrfRankConstant: number;
  nodeEnv: string;
}

const SAFE_INDEX_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;

export function resolveElasticsearchRolloutMode(
  env: Record<string, string | undefined> = process.env
): ElasticsearchRolloutMode {
  const value = env.RAG_ELASTICSEARCH_MODE?.trim().toLowerCase() || 'off';
  if (value === 'off' || value === 'shadow' || value === 'active') return value;
  throw new Error('RAG_ELASTICSEARCH_MODE must be off, shadow, or active.');
}

export function getElasticsearchRuntimeConfig(
  env: Record<string, string | undefined> = process.env
): ElasticsearchRuntimeConfig {
  return {
    mode: resolveElasticsearchRolloutMode(env),
    node: env.ELASTICSEARCH_URL?.trim() || '',
    indexName: env.ELASTICSEARCH_INDEX?.trim() || 'rag_chunks_v1',
    apiKey: env.ELASTICSEARCH_API_KEY?.trim() || '',
    username: env.ELASTICSEARCH_USERNAME?.trim() || '',
    password: env.ELASTICSEARCH_PASSWORD || '',
    caFingerprint: env.ELASTICSEARCH_CA_FINGERPRINT?.trim() || '',
    allowInsecure: env.ELASTICSEARCH_ALLOW_INSECURE?.trim().toLowerCase() === 'true',
    allowUnauthenticated:
      env.ELASTICSEARCH_ALLOW_UNAUTHENTICATED?.trim().toLowerCase() === 'true',
    requestTimeoutMs: boundedInteger(
      env.ELASTICSEARCH_REQUEST_TIMEOUT_MS,
      3_000,
      250,
      60_000,
      'ELASTICSEARCH_REQUEST_TIMEOUT_MS'
    ),
    rrfRankConstant: boundedInteger(
      env.ELASTICSEARCH_RRF_RANK_CONSTANT,
      60,
      1,
      10_000,
      'ELASTICSEARCH_RRF_RANK_CONSTANT'
    ),
    nodeEnv: env.NODE_ENV?.trim().toLowerCase() || 'development',
  };
}

export function assertElasticsearchConfigured(config: ElasticsearchRuntimeConfig): void {
  if (config.mode === 'off') return;
  if (!config.node) {
    throw new Error('Elasticsearch shadow/active mode requires ELASTICSEARCH_URL.');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.node);
  } catch {
    throw new Error('ELASTICSEARCH_URL must be a valid HTTP(S) URL.');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('ELASTICSEARCH_URL must not embed credentials.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('ELASTICSEARCH_URL must use HTTP or HTTPS.');
  }
  if (endpoint.protocol !== 'https:' && config.nodeEnv === 'production' && !config.allowInsecure) {
    throw new Error(
      'Production Elasticsearch must use HTTPS unless ELASTICSEARCH_ALLOW_INSECURE=true is explicitly set for an isolated local network.'
    );
  }
  if (!SAFE_INDEX_NAME.test(config.indexName)) {
    throw new Error('ELASTICSEARCH_INDEX must be a safe lowercase index name.');
  }
  const hasBasicAuth = Boolean(config.username && config.password);
  if (Boolean(config.username) !== Boolean(config.password)) {
    throw new Error('ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD must be configured together.');
  }
  if (config.apiKey && hasBasicAuth) {
    throw new Error('Configure either ELASTICSEARCH_API_KEY or basic authentication, not both.');
  }
  if (!config.apiKey && !hasBasicAuth && !config.allowUnauthenticated) {
    throw new Error(
      'Elasticsearch shadow/active mode requires authentication unless ELASTICSEARCH_ALLOW_UNAUTHENTICATED=true is explicitly set.'
    );
  }
}

export function getElasticsearchConfigSummary(
  config: ElasticsearchRuntimeConfig = getElasticsearchRuntimeConfig()
) {
  return {
    mode: config.mode,
    configured: config.mode === 'off' || Boolean(config.node),
    indexName: config.indexName,
    secureTransport: config.node.startsWith('https://'),
    authenticated: Boolean(config.apiKey || (config.username && config.password)),
    requestTimeoutMs: config.requestTimeoutMs,
    rrfRankConstant: config.rrfRankConstant,
  };
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const normalized = raw?.trim();
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

