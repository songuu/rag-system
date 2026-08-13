import { getCurrentRagSystem, getRagSystem } from '../rag-instance';
import { recordLangSmithFeedback } from '../langsmith/tracing';
import { getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';
import { PostgresTraceStore } from './postgres-trace-store';
import type { TraceListPayload } from './ports';
import type { JsonValue } from './types';

function localStatsFallback(): JsonValue {
  return {
    totalTraces: 0,
    successRate: 0,
    avgDuration: 0,
    totalTokens: 0,
    avgTokensPerTrace: 0,
  };
}

export async function listTracesFromPersistence(): Promise<TraceListPayload> {
  const local = getCurrentRagSystem();
  const localData = local?.getObservabilityData();
  const traces = localData?.traces ?? [];
  const stats = localData?.stats ?? localStatsFallback();

  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) {
    return {
      traces: traces as unknown as JsonValue[],
      stats: stats as JsonValue,
    };
  }

  const postgresData = await new PostgresTraceStore(config).listTraces();
  const byId = new Map<string, JsonValue>();
  for (const trace of postgresData.traces) {
    if (trace && typeof trace === 'object' && !Array.isArray(trace) && 'id' in trace) {
      byId.set(String(trace.id), trace);
    }
  }
  for (const trace of traces as unknown as JsonValue[]) {
    if (trace && typeof trace === 'object' && !Array.isArray(trace) && 'id' in trace) {
      byId.set(String(trace.id), trace);
    }
  }

  return {
    traces: Array.from(byId.values()),
    stats: traces.length > 0 ? stats as JsonValue : postgresData.stats,
  };
}

export async function getTraceFromPersistence(traceId: string): Promise<JsonValue | null> {
  const local = getCurrentRagSystem() ?? await getRagSystem();
  const localTrace = local.getTrace(traceId);
  if (localTrace) return localTrace as unknown as JsonValue;

  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) return null;

  return await new PostgresTraceStore(config).getTrace(traceId);
}

export async function addTraceFeedbackToPersistence(
  traceId: string,
  score: JsonValue,
  comment?: string
): Promise<string> {
  let scoreId = '';

  try {
    const local = getCurrentRagSystem() ?? await getRagSystem();
    if (
      local.getTrace(traceId) &&
      (typeof score === 'number' || typeof score === 'boolean' || typeof score === 'string')
    ) {
      scoreId = local.addUserFeedback(traceId, score, comment);
    }
  } catch (error) {
    console.warn('[trace-store] local trace feedback failed:', error);
  }

  const config = getPostgresRuntimeConfig();
  if (shouldUsePostgresPersistence(config)) {
    const remoteScoreId = await new PostgresTraceStore(config).addScore({
      traceId,
      name: 'user_feedback',
      value: score,
      source: 'USER',
      comment,
    });
    scoreId = remoteScoreId;
  }

  if (typeof score === 'number' || typeof score === 'boolean' || typeof score === 'string') {
    const langSmithFeedbackId = await recordLangSmithFeedback({
      runId: traceId,
      key: 'user_feedback',
      value: score,
      comment,
      sourceInfo: {
        source: 'api',
        route: '/api/traces/[traceId]/feedback',
      },
    });
    scoreId = scoreId || langSmithFeedbackId || '';
  }

  return scoreId;
}

export async function clearTracePersistence(): Promise<void> {
  const local = getCurrentRagSystem() ?? await getRagSystem();
  local.clearObservabilityData();

  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) return;

  await new PostgresTraceStore(config).clear();
}
