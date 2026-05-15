import { randomUUID } from 'crypto';
import type {
  JsonValue,
  ObservationLevel,
  ObservationType,
  TableInsert,
  TableRow,
  TraceScoreSource,
  TraceStatus,
} from '../supabase/database.types';
import { getSupabaseAdminClient } from '../supabase/admin-client';
import {
  getSupabaseRuntimeConfig,
  isSupabaseAdminConfigured,
  type SupabaseRuntimeConfig,
} from '../supabase/env';
import type { TraceListPayload, TraceStore } from './ports';

type TraceRow = TableRow<'traces'>;
type ObservationRow = TableRow<'observations'>;
type TraceScoreRow = TableRow<'trace_scores'>;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return new Date(value).toISOString();
  return new Date().toISOString();
}

function optionalIso(value: unknown): string | null {
  if (!value) return null;
  return asIso(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function traceToRow(trace: JsonValue, tenantId: string): TableInsert<'traces'> {
  const record = toRecord(trace);
  const metadata = toRecord(record.metadata);
  const userId = isUuid(record.userId) ? record.userId : null;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null;

  return {
    id: String(record.id),
    tenant_id: tenantId,
    user_id: userId,
    session_id: sessionId,
    name: typeof record.name === 'string' ? record.name : 'trace',
    input: asJson(record.input),
    output: asJson(record.output),
    metadata: asJson({
      ...metadata,
      external_user_id: userId ? undefined : record.userId,
    }),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    status: typeof record.status === 'string' ? record.status as TraceStatus : 'PENDING',
    started_at: asIso(record.startTime ?? record.started_at),
    ended_at: optionalIso(record.endTime ?? record.ended_at),
  };
}

function observationToRow(observation: unknown): TableInsert<'observations'> | null {
  const record = toRecord(observation);
  if (!record.id || !record.traceId || !record.type || !record.name) return null;

  return {
    id: String(record.id),
    trace_id: String(record.traceId),
    parent_observation_id: typeof record.parentObservationId === 'string' ? record.parentObservationId : null,
    type: record.type as ObservationType,
    name: String(record.name),
    input: asJson(record.input),
    output: asJson(record.output),
    model: typeof record.model === 'string' ? record.model : null,
    usage: asJson(record.usage),
    metadata: asJson(record.metadata),
    level: typeof record.level === 'string' ? record.level as ObservationLevel : 'DEFAULT',
    status_message: typeof record.statusMessage === 'string' ? record.statusMessage : null,
    started_at: asIso(record.startTime ?? record.started_at),
    ended_at: optionalIso(record.endTime ?? record.ended_at),
  };
}

function scoreToRow(score: unknown): TableInsert<'trace_scores'> | null {
  const record = toRecord(score);
  if (!record.id || !record.traceId || !record.name) return null;

  return {
    id: String(record.id),
    trace_id: String(record.traceId),
    observation_id: typeof record.observationId === 'string' ? record.observationId : null,
    name: String(record.name),
    value: asJson(record.value),
    source: typeof record.source === 'string' ? record.source as TraceScoreSource : 'SYSTEM',
    comment: typeof record.comment === 'string' ? record.comment : null,
    created_at: asIso(record.timestamp ?? record.created_at),
  };
}

function rowToTrace(row: TraceRow, observations: ObservationRow[] = [], scores: TraceScoreRow[] = []): JsonValue {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    name: row.name,
    startTime: row.started_at,
    endTime: row.ended_at,
    input: row.input,
    output: row.output,
    metadata: row.metadata,
    tags: row.tags,
    status: row.status,
    observations: observations.map((observation) => ({
      id: observation.id,
      traceId: observation.trace_id,
      parentObservationId: observation.parent_observation_id,
      type: observation.type,
      name: observation.name,
      startTime: observation.started_at,
      endTime: observation.ended_at,
      input: observation.input,
      output: observation.output,
      model: observation.model,
      usage: observation.usage,
      metadata: observation.metadata,
      level: observation.level,
      statusMessage: observation.status_message,
    })),
    scores: scores.map((score) => ({
      id: score.id,
      traceId: score.trace_id,
      observationId: score.observation_id,
      name: score.name,
      value: score.value,
      source: score.source,
      comment: score.comment,
      timestamp: score.created_at,
    })),
  };
}

function statsFromRows(rows: TraceRow[]): JsonValue {
  const completed = rows.filter((trace) => trace.ended_at);
  const success = rows.filter((trace) => trace.status === 'SUCCESS').length;
  const totalDuration = completed.reduce((sum, trace) => {
    if (!trace.ended_at) return sum;
    return sum + (new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime());
  }, 0);

  return {
    totalTraces: rows.length,
    successRate: rows.length > 0 ? success / rows.length : 0,
    avgDuration: completed.length > 0 ? totalDuration / completed.length : 0,
    totalTokens: 0,
    avgTokensPerTrace: 0,
  };
}

export class SupabaseTraceStore implements TraceStore {
  private readonly config: SupabaseRuntimeConfig;

  constructor(config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()) {
    this.config = config;
  }

  isReady(): boolean {
    return isSupabaseAdminConfigured(this.config);
  }

  async listTraces(): Promise<TraceListPayload> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) {
      return { traces: [], stats: statsFromRows([]) };
    }

    const rows = await client.selectRows<TraceRow>('traces', {
      filters: { tenant_id: this.config.defaultTenantId },
      order: { column: 'started_at', ascending: false },
      limit: 200,
    });

    return {
      traces: rows.map((row) => rowToTrace(row)),
      stats: statsFromRows(rows),
    };
  }

  async getTrace(traceId: string): Promise<JsonValue | null> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return null;

    const trace = await client.selectSingle<TraceRow>('traces', {
      filters: {
        id: traceId,
        tenant_id: this.config.defaultTenantId,
      },
    });
    if (!trace) return null;

    const observations = await client.selectRows<ObservationRow>('observations', {
      filters: { trace_id: traceId },
      order: { column: 'started_at', ascending: true },
    });
    const scores = await client.selectRows<TraceScoreRow>('trace_scores', {
      filters: { trace_id: traceId },
      order: { column: 'created_at', ascending: true },
    });

    return rowToTrace(trace, observations, scores);
  }

  async upsertTrace(trace: JsonValue): Promise<void> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return;

    const record = toRecord(trace);
    const row = traceToRow(trace, this.config.defaultTenantId);
    if (!row.id) return;

    await client.upsertRows('traces', row, { onConflict: 'id' });

    if (Array.isArray(record.observations)) {
      const observations = record.observations
        .map(observationToRow)
        .filter((row): row is TableInsert<'observations'> => Boolean(row));
      if (observations.length > 0) {
        await client.upsertRows('observations', observations, { onConflict: 'id' });
      }
    }

    if (Array.isArray(record.scores)) {
      const scores = record.scores
        .map(scoreToRow)
        .filter((row): row is TableInsert<'trace_scores'> => Boolean(row));
      if (scores.length > 0) {
        await client.upsertRows('trace_scores', scores, { onConflict: 'id' });
      }
    }
  }

  async addScore(input: {
    traceId: string;
    observationId?: string;
    name: string;
    value: JsonValue;
    source: TraceScoreSource;
    comment?: string;
  }): Promise<string> {
    const client = getSupabaseAdminClient(this.config);
    const scoreId = randomUUID();
    if (!client || !this.isReady()) return scoreId;

    const row: TableInsert<'trace_scores'> = {
      id: scoreId,
      trace_id: input.traceId,
      observation_id: input.observationId ?? null,
      name: input.name,
      value: input.value,
      source: input.source,
      comment: input.comment ?? null,
    };

    await client.insertRows('trace_scores', row);
    return scoreId;
  }

  async clear(): Promise<void> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return;
    await client.deleteRows('traces', { tenant_id: this.config.defaultTenantId });
  }
}

let mirrorStore: SupabaseTraceStore | null = null;

export function mirrorTraceToSupabase(trace: unknown): void {
  const config = getSupabaseRuntimeConfig();
  if (!isSupabaseAdminConfigured(config)) return;

  if (!mirrorStore) {
    mirrorStore = new SupabaseTraceStore(config);
  }

  mirrorStore.upsertTrace(asJson(trace)).catch((error) => {
    console.warn('[SupabaseTraceStore] trace mirror failed:', error);
  });
}
