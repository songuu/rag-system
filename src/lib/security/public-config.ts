export interface PublicMilvusConfig {
  provider?: string;
  isZillizCloud?: boolean;
  configured: boolean;
  hasCredentials: boolean;
  ssl?: boolean;
  database?: string;
  collectionName?: string;
  embeddingDimension?: number;
  indexType?: string;
  metricType?: string;
  consistencyLevel?: string | number;
  ignoreGrowing?: boolean;
  groupByField?: string;
  groupSize?: number;
  strictGroupSize?: boolean;
  flushOnInsert?: boolean;
  reloadAfterInsert?: boolean;
  debugLogs?: boolean;
}

export interface PublicServiceHealth {
  healthy: boolean;
  message: string;
}

/**
 * Creates an explicit public DTO. Connection endpoints and credentials are
 * deliberately consumed only to booleans and can never spread into API output.
 */
export function toPublicMilvusConfig(
  config: Record<string, unknown>,
  overrides: Pick<PublicMilvusConfig, 'provider' | 'isZillizCloud'> = {}
): PublicMilvusConfig {
  return {
    ...overrides,
    configured: Boolean(config.address || config.endpoint),
    hasCredentials: Boolean(
      config.hasCredentials
      || config.token
      || config.password
      || (config.username && config.password)
    ),
    ...optionalBoolean(config.ssl, 'ssl'),
    ...optionalString(config.database, 'database'),
    ...optionalString(config.collectionName ?? config.defaultCollection, 'collectionName'),
    ...optionalNumber(config.embeddingDimension ?? config.defaultDimension, 'embeddingDimension'),
    ...optionalString(config.indexType, 'indexType'),
    ...optionalString(config.metricType, 'metricType'),
    ...optionalConsistency(config.consistencyLevel ?? config.defaultConsistencyLevel),
    ...optionalBoolean(config.ignoreGrowing, 'ignoreGrowing'),
    ...optionalString(config.groupByField, 'groupByField'),
    ...optionalNumber(config.groupSize, 'groupSize'),
    ...optionalBoolean(config.strictGroupSize, 'strictGroupSize'),
    ...optionalBoolean(config.flushOnInsert, 'flushOnInsert'),
    ...optionalBoolean(config.reloadAfterInsert, 'reloadAfterInsert'),
    ...optionalBoolean(config.debugLogs, 'debugLogs'),
  };
}

export function toPublicServiceHealth(health: { healthy: boolean }): PublicServiceHealth {
  return {
    healthy: health.healthy,
    message: health.healthy ? 'Service is healthy.' : 'Service is unavailable.',
  };
}

function optionalString(value: unknown, key: string): Record<string, string> {
  return typeof value === 'string' && value ? { [key]: value } : {};
}

function optionalNumber(value: unknown, key: string): Record<string, number> {
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

function optionalBoolean(value: unknown, key: string): Record<string, boolean> {
  return typeof value === 'boolean' ? { [key]: value } : {};
}

function optionalConsistency(value: unknown): { consistencyLevel?: string | number } {
  return typeof value === 'string' || typeof value === 'number'
    ? { consistencyLevel: value }
    : {};
}
