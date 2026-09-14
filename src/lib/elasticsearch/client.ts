import { createHash } from 'node:crypto';
import {
  assertElasticsearchConfigured,
  getElasticsearchRuntimeConfig,
  type ElasticsearchRuntimeConfig,
} from './config';

export interface ElasticsearchClientPort {
  search(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  bulk(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  deleteByQuery(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  ping(options?: Record<string, unknown>): Promise<unknown>;
  indices: {
    exists(input: { index: string }): Promise<boolean>;
    create(input: Record<string, unknown>): Promise<unknown>;
  };
  close(): Promise<void>;
}

let cached: {
  signature: string;
  client: ElasticsearchClientPort;
} | null = null;

export async function getElasticsearchClient(
  config: ElasticsearchRuntimeConfig = getElasticsearchRuntimeConfig()
): Promise<ElasticsearchClientPort | null> {
  if (config.mode === 'off') return null;
  assertElasticsearchConfigured(config);
  const signature = createHash('sha256').update(JSON.stringify([
    config.node,
    config.indexName,
    config.apiKey,
    config.username,
    config.password,
    config.caFingerprint,
    config.requestTimeoutMs,
  ])).digest('hex');
  if (cached?.signature === signature) return cached.client;

  // Keep the optional backend out of disabled deployments and client bundles.
  const { Client } = await import('@elastic/elasticsearch');
  const client = new Client({
    node: config.node,
    requestTimeout: config.requestTimeoutMs,
    ...(config.apiKey
      ? { auth: { apiKey: config.apiKey } }
      : config.username
        ? { auth: { username: config.username, password: config.password } }
        : {}),
    ...(config.caFingerprint
      ? { caFingerprint: config.caFingerprint }
      : {}),
  }) as unknown as ElasticsearchClientPort;
  const previous = cached;
  cached = { signature, client };
  if (previous) void previous.client.close().catch(() => undefined);
  return client;
}

export async function closeElasticsearchClient(): Promise<void> {
  const current = cached;
  cached = null;
  if (current) await current.client.close();
}

export async function checkElasticsearchReadiness(
  config: ElasticsearchRuntimeConfig = getElasticsearchRuntimeConfig()
): Promise<{
  mode: ElasticsearchRuntimeConfig['mode'];
  connected: boolean | null;
  indexReady: boolean | null;
  indexName: string;
}> {
  if (config.mode === 'off') {
    return { mode: 'off', connected: null, indexReady: null, indexName: config.indexName };
  }
  assertElasticsearchConfigured(config);
  try {
    const client = await getElasticsearchClient(config);
    if (!client) return { mode: config.mode, connected: false, indexReady: false, indexName: config.indexName };
    await client.ping();
    const indexReady = await client.indices.exists({ index: config.indexName });
    return { mode: config.mode, connected: true, indexReady, indexName: config.indexName };
  } catch {
    return { mode: config.mode, connected: false, indexReady: false, indexName: config.indexName };
  }
}
