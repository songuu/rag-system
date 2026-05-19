import { Client } from 'langsmith';
import { uuid7 } from 'langsmith';

export interface LangSmithRuntimeConfig {
  enabled: boolean;
  apiKey?: string;
  apiUrl?: string;
  workspaceId?: string;
  projectName: string;
  hideInputs: boolean;
  hideOutputs: boolean;
  hideMetadata: boolean;
  omitRuntimeInfo: boolean;
  tracingSamplingRate?: number;
}

let cachedClient: Client | null = null;
let cachedClientKey = '';

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getLangSmithRuntimeConfig(): LangSmithRuntimeConfig {
  const apiKey = process.env.LANGSMITH_API_KEY;
  const tracingEnabled =
    readBooleanEnv('LANGSMITH_TRACING') ||
    readBooleanEnv('LANGCHAIN_TRACING_V2') ||
    readBooleanEnv('LANGCHAIN_TRACING');

  return {
    enabled: tracingEnabled && Boolean(apiKey),
    apiKey,
    apiUrl: process.env.LANGSMITH_ENDPOINT || process.env.LANGCHAIN_ENDPOINT,
    workspaceId: process.env.LANGSMITH_WORKSPACE_ID || process.env.LANGCHAIN_WORKSPACE_ID,
    projectName:
      process.env.LANGSMITH_PROJECT ||
      process.env.LANGCHAIN_PROJECT ||
      'rag-system',
    hideInputs: readBooleanEnv('LANGSMITH_HIDE_INPUTS'),
    hideOutputs: readBooleanEnv('LANGSMITH_HIDE_OUTPUTS'),
    hideMetadata: readBooleanEnv('LANGSMITH_HIDE_METADATA'),
    omitRuntimeInfo: readBooleanEnv('LANGSMITH_OMIT_RUNTIME_INFO'),
    tracingSamplingRate: readNumberEnv('LANGSMITH_TRACING_SAMPLE_RATE'),
  };
}

export function getLangSmithClient(
  config: LangSmithRuntimeConfig = getLangSmithRuntimeConfig()
): Client | null {
  if (!config.enabled || !config.apiKey) return null;

  const cacheKey = JSON.stringify({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    workspaceId: config.workspaceId,
    hideInputs: config.hideInputs,
    hideOutputs: config.hideOutputs,
    hideMetadata: config.hideMetadata,
    omitRuntimeInfo: config.omitRuntimeInfo,
    tracingSamplingRate: config.tracingSamplingRate,
  });

  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;

  cachedClient = new Client({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    workspaceId: config.workspaceId,
    hideInputs: config.hideInputs,
    hideOutputs: config.hideOutputs,
    hideMetadata: config.hideMetadata,
    omitTracedRuntimeInfo: config.omitRuntimeInfo,
    tracingSamplingRate: config.tracingSamplingRate,
  });
  cachedClientKey = cacheKey;
  return cachedClient;
}

export function createLangSmithThreadId(input?: {
  sessionId?: string;
  conversationId?: string;
  fallback?: string;
}): string {
  return (
    normalizeExternalId(input?.sessionId) ||
    normalizeExternalId(input?.conversationId) ||
    normalizeExternalId(input?.fallback) ||
    uuid7()
  );
}

export function buildLangSmithMetadata(input: {
  threadId: string;
  sessionId?: string;
  conversationId?: string;
  userId?: string;
  route?: string;
  policyId?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.metadata ?? {}),
    thread_id: input.threadId,
    session_id: input.sessionId ?? input.threadId,
    conversation_id: input.conversationId ?? input.sessionId ?? input.threadId,
    user_id: input.userId,
    route: input.route,
    rag_policy: input.policyId,
    app: 'rag-system',
  };
}

export function toLangSmithRecord(value: unknown, fallbackKey = 'value'): Record<string, unknown> {
  const normalized = normalizeJsonLike(value);
  if (
    normalized &&
    typeof normalized === 'object' &&
    !Array.isArray(normalized)
  ) {
    return normalized as Record<string, unknown>;
  }
  return { [fallbackKey]: normalized };
}

function normalizeExternalId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeJsonLike(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MaxDepth]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => normalizeJsonLike(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 100)) {
    if (typeof item !== 'undefined') {
      output[key] = normalizeJsonLike(item, depth + 1);
    }
  }
  return output;
}
