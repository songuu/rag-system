import { getCurrentRagSystem, getRagSystem } from '../rag-instance';
import type { JsonValue } from '../supabase/database.types';
import { getSupabaseRuntimeConfig, shouldUseSupabasePersistence } from '../supabase/env';
import { SupabaseTraceStore } from './supabase-trace-store';
import type { TraceListPayload } from './ports';

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

  const config = getSupabaseRuntimeConfig();
  if (!shouldUseSupabasePersistence(config)) {
    return {
      traces: traces as unknown as JsonValue[],
      stats: stats as JsonValue,
    };
  }

  try {
    const supabaseData = await new SupabaseTraceStore(config).listTraces();
    const byId = new Map<string, JsonValue>();
    for (const trace of supabaseData.traces) {
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
      stats: traces.length > 0 ? stats as JsonValue : supabaseData.stats,
    };
  } catch (error) {
    console.warn('[trace-store] Supabase trace list failed, falling back to local traces:', error);
    return {
      traces: traces as unknown as JsonValue[],
      stats: stats as JsonValue,
    };
  }
}

export async function getTraceFromPersistence(traceId: string): Promise<JsonValue | null> {
  const local = getCurrentRagSystem() ?? await getRagSystem();
  const localTrace = local.getTrace(traceId);
  if (localTrace) return localTrace as unknown as JsonValue;

  const config = getSupabaseRuntimeConfig();
  if (!shouldUseSupabasePersistence(config)) return null;

  try {
    return await new SupabaseTraceStore(config).getTrace(traceId);
  } catch (error) {
    console.warn('[trace-store] Supabase trace lookup failed:', error);
    return null;
  }
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

  const config = getSupabaseRuntimeConfig();
  if (shouldUseSupabasePersistence(config)) {
    try {
      const remoteScoreId = await new SupabaseTraceStore(config).addScore({
        traceId,
        name: 'user_feedback',
        value: score,
        source: 'USER',
        comment,
      });
      scoreId = scoreId || remoteScoreId;
    } catch (error) {
      console.warn('[trace-store] Supabase trace feedback failed:', error);
    }
  }

  return scoreId;
}

export async function clearTracePersistence(): Promise<void> {
  const local = getCurrentRagSystem() ?? await getRagSystem();
  local.clearObservabilityData();

  const config = getSupabaseRuntimeConfig();
  if (!shouldUseSupabasePersistence(config)) return;

  try {
    await new SupabaseTraceStore(config).clear();
  } catch (error) {
    console.warn('[trace-store] Supabase trace clear failed:', error);
  }
}
