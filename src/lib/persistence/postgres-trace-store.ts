import { randomUUID } from 'node:crypto';
import type { PostgresQueryClient } from '../postgres/client';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  isPostgresPersistenceReady,
  type PostgresRuntimeConfig,
} from '../postgres/env';
import type { TraceListPayload, TraceStore } from './ports';
import type {
  JsonValue,
  ObservationLevel,
  ObservationType,
  TraceScoreSource,
  TraceStatus,
} from './types';

interface TraceRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  session_id: string | null;
  name: string;
  input: JsonValue;
  output: JsonValue;
  metadata: JsonValue;
  tags: string[];
  status: TraceStatus;
  started_at: string | Date;
  ended_at: string | Date | null;
}

interface ObservationRow {
  id: string;
  trace_id: string;
  parent_observation_id: string | null;
  type: ObservationType;
  name: string;
  input: JsonValue;
  output: JsonValue;
  model: string | null;
  usage: JsonValue;
  metadata: JsonValue;
  level: ObservationLevel;
  status_message: string | null;
  started_at: string | Date;
  ended_at: string | Date | null;
}

interface TraceScoreRow {
  id: string;
  trace_id: string;
  observation_id: string | null;
  name: string;
  value: JsonValue;
  source: TraceScoreSource;
  comment: string | null;
  created_at: string | Date;
}

interface TraceRecord {
  id: string;
  tenantId: string;
  userId: string | null;
  sessionId: string | null;
  name: string;
  input: JsonValue;
  output: JsonValue;
  metadata: JsonValue;
  tags: string[];
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
}

interface ObservationRecord {
  id: string;
  traceId: string;
  parentObservationId: string | null;
  type: ObservationType;
  name: string;
  input: JsonValue;
  output: JsonValue;
  model: string | null;
  usage: JsonValue;
  metadata: JsonValue;
  level: ObservationLevel;
  statusMessage: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface ScoreRecord {
  id: string;
  traceId: string;
  observationId: string | null;
  name: string;
  value: JsonValue;
  source: TraceScoreSource;
  comment: string | null;
  createdAt: string;
}

export class PostgresTraceStore implements TraceStore {
  private readonly config: PostgresRuntimeConfig;
  private readonly client: PostgresQueryClient;

  constructor(
    config: PostgresRuntimeConfig = getPostgresRuntimeConfig(),
    client: PostgresQueryClient | null = getPostgresClient(config)
  ) {
    assertPostgresPersistenceConfigured(config);
    if (!client) throw new Error('PostgreSQL persistence requires DATABASE_URL.');
    this.config = config;
    this.client = client;
  }

  isReady(): boolean {
    return isPostgresPersistenceReady(this.config);
  }

  async listTraces(): Promise<TraceListPayload> {
    const result = await queryPostgres<TraceRow>(
      this.client,
      `select id, tenant_id, user_id, session_id, name, input, output,
              metadata, tags, status, started_at, ended_at
       from traces
       where tenant_id = $1
       order by started_at desc
       limit 200`,
      [this.config.defaultTenantId],
      'list traces'
    );
    return {
      traces: result.rows.map((row) => rowToTrace(row)),
      stats: statsFromRows(result.rows),
    };
  }

  async getTrace(traceId: string): Promise<JsonValue | null> {
    const traces = await queryPostgres<TraceRow>(
      this.client,
      `select id, tenant_id, user_id, session_id, name, input, output,
              metadata, tags, status, started_at, ended_at
       from traces
       where id = $1 and tenant_id = $2
       limit 1`,
      [traceId, this.config.defaultTenantId],
      'get trace'
    );
    const trace = traces.rows[0];
    if (!trace) return null;

    const observations = await queryPostgres<ObservationRow>(
      this.client,
      `select id, trace_id, parent_observation_id, type, name, input, output,
              model, usage, metadata, level, status_message, started_at, ended_at
       from observations
       where trace_id = $1
       order by started_at asc`,
      [traceId],
      'list trace observations'
    );
    const scores = await queryPostgres<TraceScoreRow>(
      this.client,
      `select id, trace_id, observation_id, name, value, source, comment, created_at
       from trace_scores
       where trace_id = $1
       order by created_at asc`,
      [traceId],
      'list trace scores'
    );
    return rowToTrace(trace, observations.rows, scores.rows);
  }

  async upsertTrace(trace: JsonValue): Promise<void> {
    const record = toRecord(trace);
    const traceRecord = traceToRecord(trace, this.config.defaultTenantId);
    if (!traceRecord.id || traceRecord.id === 'undefined') return;
    const observations = Array.isArray(record.observations)
      ? record.observations.map(observationToRecord).filter(isPresent)
      : [];
    const scores = Array.isArray(record.scores)
      ? record.scores.map(scoreToRecord).filter(isPresent)
      : [];
    await queryPostgres(
      this.client,
      `with upserted_trace as (
         insert into traces (
           id, tenant_id, user_id, session_id, name, input, output, metadata,
           tags, status, started_at, ended_at
         ) values (
           $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
           $9::text[], $10, $11, $12
         )
         on conflict (id) do update set
           tenant_id = excluded.tenant_id,
           user_id = excluded.user_id,
           session_id = excluded.session_id,
           name = excluded.name,
           input = excluded.input,
           output = excluded.output,
           metadata = excluded.metadata,
           tags = excluded.tags,
           status = excluded.status,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at
         returning id
       ), upserted_observations as (
         insert into observations (
           id, trace_id, parent_observation_id, type, name, input, output, model,
           usage, metadata, level, status_message, started_at, ended_at
         )
         select
           (item->>'id')::uuid, upserted_trace.id,
           nullif(item->>'parent_observation_id', '')::uuid,
           item->>'type', item->>'name', item->'input', item->'output',
           nullif(item->>'model', ''), item->'usage', item->'metadata', item->>'level',
           nullif(item->>'status_message', ''), (item->>'started_at')::timestamptz,
           nullif(item->>'ended_at', '')::timestamptz
         from jsonb_array_elements($13::jsonb) as item
         cross join upserted_trace
         on conflict (id) do update set
           trace_id = excluded.trace_id,
           parent_observation_id = excluded.parent_observation_id,
           type = excluded.type,
           name = excluded.name,
           input = excluded.input,
           output = excluded.output,
           model = excluded.model,
           usage = excluded.usage,
           metadata = excluded.metadata,
           level = excluded.level,
           status_message = excluded.status_message,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at
         returning id
       )
       insert into trace_scores (
         id, trace_id, observation_id, name, value, source, comment, created_at
       )
       select
         (item->>'id')::uuid, upserted_trace.id,
         nullif(item->>'observation_id', '')::uuid,
         item->>'name', item->'value', item->>'source', nullif(item->>'comment', ''),
         (item->>'created_at')::timestamptz
       from jsonb_array_elements($14::jsonb) as item
       cross join upserted_trace
       where (select count(*) from upserted_observations) >= 0
       on conflict (id) do update set
         trace_id = excluded.trace_id,
         observation_id = excluded.observation_id,
         name = excluded.name,
         value = excluded.value,
         source = excluded.source,
         comment = excluded.comment,
         created_at = excluded.created_at`,
      [
        traceRecord.id,
        traceRecord.tenantId,
        traceRecord.userId,
        traceRecord.sessionId,
        traceRecord.name,
        JSON.stringify(traceRecord.input),
        JSON.stringify(traceRecord.output),
        JSON.stringify(traceRecord.metadata),
        traceRecord.tags,
        traceRecord.status,
        traceRecord.startedAt,
        traceRecord.endedAt,
        JSON.stringify(observations.map(observationForSql)),
        JSON.stringify(scores.map(scoreForSql)),
      ],
      'upsert trace graph'
    );
  }

  async addScore(input: {
    traceId: string;
    observationId?: string;
    name: string;
    value: JsonValue;
    source: TraceScoreSource;
    comment?: string;
  }): Promise<string> {
    const scoreId = randomUUID();
    const result = await queryPostgres(
      this.client,
      `insert into trace_scores (
         id, trace_id, observation_id, name, value, source, comment
       )
       select $1, traces.id, $3, $4, $5::jsonb, $6, $7
       from traces
       where traces.id = $2 and traces.tenant_id = $8`,
      [
        scoreId,
        input.traceId,
        input.observationId ?? null,
        input.name,
        JSON.stringify(input.value),
        input.source,
        input.comment ?? null,
        this.config.defaultTenantId,
      ],
      'add trace score'
    );
    if (result.rowCount !== 1) {
      throw new Error('Trace score target is outside the configured tenant scope.');
    }
    return scoreId;
  }

  async clear(): Promise<void> {
    await queryPostgres(
      this.client,
      'delete from traces where tenant_id = $1',
      [this.config.defaultTenantId],
      'clear traces'
    );
  }
}

let mirrorStore: PostgresTraceStore | null = null;
let mirrorSignature = '';
const pendingTraceMirrors = new Map<string, Promise<void>>();

export function enqueueTraceMirror(
  store: Pick<PostgresTraceStore, 'upsertTrace'>,
  trace: JsonValue
): Promise<void> {
  const traceId = String(toRecord(trace).id ?? '');
  if (!traceId) return Promise.resolve();
  const previous = pendingTraceMirrors.get(traceId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => store.upsertTrace(trace));
  pendingTraceMirrors.set(traceId, next);
  void next.finally(() => {
    if (pendingTraceMirrors.get(traceId) === next) pendingTraceMirrors.delete(traceId);
  }).catch(() => undefined);
  return next;
}

export function mirrorTraceToPostgres(trace: unknown): Promise<void> {
  const config = getPostgresRuntimeConfig();
  if (config.persistenceBackend === 'local') return Promise.resolve();
  assertPostgresPersistenceConfigured(config);

  const signature = [config.databaseUrl, config.defaultTenantId].join('|');
  if (!mirrorStore || mirrorSignature !== signature) {
    mirrorStore = new PostgresTraceStore(config);
    mirrorSignature = signature;
  }
  return enqueueTraceMirror(mirrorStore, asJson(trace));
}

function observationForSql(row: ObservationRecord) {
  return {
    id: row.id,
    trace_id: row.traceId,
    parent_observation_id: row.parentObservationId ?? '',
    type: row.type,
    name: row.name,
    input: row.input,
    output: row.output,
    model: row.model ?? '',
    usage: row.usage,
    metadata: row.metadata,
    level: row.level,
    status_message: row.statusMessage ?? '',
    started_at: row.startedAt,
    ended_at: row.endedAt ?? '',
  };
}

function scoreForSql(row: ScoreRecord) {
  return {
    id: row.id,
    trace_id: row.traceId,
    observation_id: row.observationId ?? '',
    name: row.name,
    value: row.value,
    source: row.source,
    comment: row.comment ?? '',
    created_at: row.createdAt,
  };
}

function traceToRecord(trace: JsonValue, tenantId: string): TraceRecord {
  const record = toRecord(trace);
  const metadata = toRecord(record.metadata);
  const userId = typeof record.userId === 'string' && record.userId.trim()
    ? record.userId
    : null;
  return {
    id: String(record.id),
    tenantId,
    userId,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    name: typeof record.name === 'string' ? record.name : 'trace',
    input: asJson(record.input),
    output: asJson(record.output),
    metadata: asJson(metadata),
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    status: isTraceStatus(record.status) ? record.status : 'PENDING',
    startedAt: asIso(record.startTime ?? record.started_at),
    endedAt: optionalIso(record.endTime ?? record.ended_at),
  };
}

function observationToRecord(observation: unknown): ObservationRecord | null {
  const record = toRecord(observation);
  if (!record.id || !record.traceId || !record.type || !record.name) return null;
  return {
    id: String(record.id),
    traceId: String(record.traceId),
    parentObservationId: typeof record.parentObservationId === 'string'
      ? record.parentObservationId
      : null,
    type: record.type as ObservationType,
    name: String(record.name),
    input: asJson(record.input),
    output: asJson(record.output),
    model: typeof record.model === 'string' ? record.model : null,
    usage: asJson(record.usage),
    metadata: asJson(record.metadata),
    level: typeof record.level === 'string' ? record.level as ObservationLevel : 'DEFAULT',
    statusMessage: typeof record.statusMessage === 'string' ? record.statusMessage : null,
    startedAt: asIso(record.startTime ?? record.started_at),
    endedAt: optionalIso(record.endTime ?? record.ended_at),
  };
}

function scoreToRecord(score: unknown): ScoreRecord | null {
  const record = toRecord(score);
  if (!record.id || !record.traceId || !record.name) return null;
  return {
    id: String(record.id),
    traceId: String(record.traceId),
    observationId: typeof record.observationId === 'string' ? record.observationId : null,
    name: String(record.name),
    value: asJson(record.value),
    source: typeof record.source === 'string' ? record.source as TraceScoreSource : 'SYSTEM',
    comment: typeof record.comment === 'string' ? record.comment : null,
    createdAt: asIso(record.timestamp ?? record.created_at),
  };
}

function rowToTrace(
  row: TraceRow,
  observations: ObservationRow[] = [],
  scores: TraceScoreRow[] = []
): JsonValue {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    name: row.name,
    startTime: toIso(row.started_at),
    endTime: row.ended_at ? toIso(row.ended_at) : null,
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
      startTime: toIso(observation.started_at),
      endTime: observation.ended_at ? toIso(observation.ended_at) : null,
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
      timestamp: toIso(score.created_at),
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
  return value ? asIso(value) : null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isTraceStatus(value: unknown): value is TraceStatus {
  return value === 'PENDING' || value === 'SUCCESS' || value === 'ERROR';
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
