import { createHash } from 'node:crypto';
import type { PostgresQueryClient } from '../postgres/client';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import { getPostgresRuntimeConfig } from '../postgres/env';
import type { RagTrustLevel } from '../security/retrieval-scope';
import {
  assertElasticsearchConfigured,
  getElasticsearchRuntimeConfig,
  type ElasticsearchRolloutMode,
} from './config';
import type { ElasticsearchLexicalDocument } from './lexical-index';

export interface ElasticsearchProjectionChunk {
  id: string;
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  content: string;
  source?: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
  metadata?: Record<string, unknown>;
}

export interface ClaimedElasticsearchOutboxEvent {
  id: string;
  sequence: number;
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  eventType: 'upsert' | 'delete';
  projectionDigest: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export class ElasticsearchProjectionOutboxError extends Error {
  readonly code = 'ELASTICSEARCH_PROJECTION_OUTBOX_UNAVAILABLE';
  readonly mode: ElasticsearchRolloutMode;

  constructor(mode: ElasticsearchRolloutMode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ElasticsearchProjectionOutboxError';
    this.mode = mode;
  }
}

export class PostgresElasticsearchOutboxStore {
  private readonly client: PostgresQueryClient;

  constructor(client: PostgresQueryClient) {
    this.client = client;
  }

  async enqueueUpsert(chunks: ElasticsearchProjectionChunk[]): Promise<string> {
    const identity = validateProjectionChunks(chunks);
    const payload = JSON.stringify(chunks.map(chunk => ({
      chunk_id: chunk.id,
      trust_level: chunk.trustLevel,
      content: chunk.content,
      source: chunk.source ?? null,
      page: chunk.page ?? null,
      start_offset: chunk.startOffset ?? null,
      end_offset: chunk.endOffset ?? null,
      metadata: chunk.metadata ?? {},
    })));
    const projectionDigest = 'sha256:' + createHash('sha256').update(payload).digest('hex');
    const result = await queryPostgres<{ id: string }>(
      this.client,
      `with input_chunks as (
         select *
         from jsonb_to_recordset($1::jsonb) as value(
           chunk_id text,
           trust_level text,
           content text,
           source text,
           page integer,
           start_offset integer,
           end_offset integer,
           metadata jsonb
         )
       ), removed as (
         delete from public.elasticsearch_lexical_chunks existing
         where existing.tenant_id = $2
           and existing.corpus_id = $3
           and existing.document_id = $4
           and existing.document_version = $5
           and not exists (
             select 1 from input_chunks incoming
             where incoming.chunk_id = existing.chunk_id
           )
         returning existing.chunk_id
       ), staged as (
         insert into public.elasticsearch_lexical_chunks (
           tenant_id, corpus_id, document_id, document_version, chunk_id,
           trust_level, content, source, page, start_offset, end_offset, metadata
         )
         select $2, $3, $4, $5, chunk_id, trust_level, content, source,
                page, start_offset, end_offset, coalesce(metadata, '{}'::jsonb)
         from input_chunks
         where (select count(*) from removed) >= 0
         on conflict (tenant_id, corpus_id, document_id, document_version, chunk_id)
         do update set
           trust_level = excluded.trust_level,
           content = excluded.content,
           source = excluded.source,
           page = excluded.page,
           start_offset = excluded.start_offset,
           end_offset = excluded.end_offset,
           metadata = excluded.metadata,
           updated_at = now()
         returning chunk_id
       ), event as (
         insert into public.elasticsearch_lexical_outbox (
           tenant_id, corpus_id, document_id, document_version, event_type,
           projection_digest
         )
         select $2, $3, $4, $5, 'upsert', $6
         where (select count(*) from staged) = jsonb_array_length($1::jsonb)
         on conflict (tenant_id, corpus_id, document_id, document_version, event_type)
         do update set
           projection_digest = excluded.projection_digest,
           published_at = null,
           dead_lettered_at = null,
           attempts = case
             when public.elasticsearch_lexical_outbox.published_at is not null
               or public.elasticsearch_lexical_outbox.dead_lettered_at is not null
             then 0 else public.elasticsearch_lexical_outbox.attempts
           end,
           available_at = case
             when public.elasticsearch_lexical_outbox.lease_token is null then now()
             else public.elasticsearch_lexical_outbox.available_at
           end,
           last_error = case
             when public.elasticsearch_lexical_outbox.lease_token is null then null
             else public.elasticsearch_lexical_outbox.last_error
           end
         returning id
       )
       select id from event`,
      [
        payload,
        identity.tenantId,
        identity.corpusId,
        identity.documentId,
        identity.documentVersion,
        projectionDigest,
      ],
      'enqueue Elasticsearch lexical projection'
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Elasticsearch lexical projection was not enqueued.');
    return id;
  }

  async enqueueDelete(input: {
    tenantId: string;
    corpusId: string;
    documentId: string;
  }): Promise<string> {
    const values = [
      required(input.tenantId, 'tenantId', 128),
      required(input.corpusId, 'corpusId', 128),
      required(input.documentId, 'documentId', 256),
    ];
    const result = await queryPostgres<{ id: string }>(
      this.client,
      `with removed as (
         delete from public.elasticsearch_lexical_chunks
         where tenant_id = $1 and corpus_id = $2 and document_id = $3
         returning chunk_id
       ), event as (
         insert into public.elasticsearch_lexical_outbox (
           tenant_id, corpus_id, document_id, document_version, event_type, projection_digest
         ) values ($1, $2, $3, '*', 'delete', 'delete')
         on conflict (tenant_id, corpus_id, document_id, document_version, event_type)
         do update set
           published_at = null,
           dead_lettered_at = null,
           attempts = case
             when public.elasticsearch_lexical_outbox.published_at is not null
               or public.elasticsearch_lexical_outbox.dead_lettered_at is not null
             then 0 else public.elasticsearch_lexical_outbox.attempts
           end,
           available_at = case
             when public.elasticsearch_lexical_outbox.lease_token is null then now()
             else public.elasticsearch_lexical_outbox.available_at
           end,
           last_error = case
             when public.elasticsearch_lexical_outbox.lease_token is null then null
             else public.elasticsearch_lexical_outbox.last_error
           end
         returning id
       )
       select id from event`,
      values,
      'enqueue Elasticsearch lexical deletion'
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Elasticsearch lexical deletion was not enqueued.');
    return id;
  }

  async claim(options: { limit?: number; leaseMs?: number } = {}): Promise<ClaimedElasticsearchOutboxEvent[]> {
    const limit = boundedInteger(options.limit ?? 50, 1, 1_000, 'claim limit');
    const leaseMs = boundedInteger(options.leaseMs ?? 30_000, 1_000, 600_000, 'lease');
    const result = await queryPostgres<OutboxRow>(
      this.client,
      `with candidates as (
         select candidate.id
         from public.elasticsearch_lexical_outbox candidate
         where candidate.published_at is null
           and candidate.dead_lettered_at is null
           and candidate.available_at <= now()
           and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())
           and not exists (
             select 1
             from public.elasticsearch_lexical_outbox earlier
             where earlier.tenant_id = candidate.tenant_id
               and earlier.corpus_id = candidate.corpus_id
               and earlier.document_id = candidate.document_id
               and earlier.sequence < candidate.sequence
               and earlier.published_at is null
               and earlier.dead_lettered_at is null
           )
         order by candidate.sequence asc
         for update skip locked
         limit $1
       )
       update public.elasticsearch_lexical_outbox event
       set lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
           attempts = attempts + 1
       from candidates
       where event.id = candidates.id
       returning event.id, event.sequence, event.tenant_id, event.corpus_id,
                 event.document_id, event.document_version, event.event_type,
                 event.projection_digest, event.attempts, event.lease_token,
                 event.lease_expires_at`,
      [limit, leaseMs],
      'claim Elasticsearch lexical outbox events'
    );
    return result.rows.map(toClaimedEvent);
  }

  async loadDocuments(event: ClaimedElasticsearchOutboxEvent): Promise<ElasticsearchLexicalDocument[]> {
    if (event.eventType === 'delete') return [];
    const result = await queryPostgres<LexicalChunkRow>(
      this.client,
      `select chunk_id, tenant_id, corpus_id, document_id, document_version,
              trust_level, content, source, page, start_offset, end_offset, metadata
       from public.elasticsearch_lexical_chunks
       where tenant_id = $1 and corpus_id = $2 and document_id = $3
         and document_version = $4
       order by start_offset nulls last, chunk_id`,
      [event.tenantId, event.corpusId, event.documentId, event.documentVersion],
      'load Elasticsearch lexical projection chunks'
    );
    return result.rows.map(toLexicalDocument);
  }

  async acknowledge(event: ClaimedElasticsearchOutboxEvent): Promise<boolean> {
    const result = await queryPostgres<{ id: string }>(
      this.client,
      `update public.elasticsearch_lexical_outbox
       set published_at = now(), lease_token = null, lease_expires_at = null, last_error = null
       where id = $1 and lease_token = $2 and projection_digest = $3
         and published_at is null
       returning id`,
      [event.id, event.leaseToken, event.projectionDigest],
      'acknowledge Elasticsearch lexical outbox event'
    );
    return result.rowCount === 1;
  }

  async retry(event: ClaimedElasticsearchOutboxEvent, input: {
    error: unknown;
    maxAttempts?: number;
    retryDelayMs?: number;
  }): Promise<'retry' | 'dead-letter' | 'lost-lease'> {
    const maxAttempts = boundedInteger(input.maxAttempts ?? 8, 1, 100, 'max attempts');
    const retryDelayMs = boundedInteger(input.retryDelayMs ?? 5_000, 100, 3_600_000, 'retry delay');
    const result = await queryPostgres<{ dead_lettered: boolean }>(
      this.client,
      `update public.elasticsearch_lexical_outbox
       set lease_token = null,
           lease_expires_at = null,
           last_error = $4,
           dead_lettered_at = case when attempts >= $5 then now() else null end,
           available_at = case
             when attempts >= $5 then available_at
             else now() + ($6::integer * interval '1 millisecond')
           end
       where id = $1 and lease_token = $2 and projection_digest = $3
         and published_at is null
       returning dead_lettered_at is not null as dead_lettered`,
      [
        event.id,
        event.leaseToken,
        event.projectionDigest,
        boundedError(input.error),
        maxAttempts,
        retryDelayMs,
      ],
      'retry Elasticsearch lexical outbox event'
    );
    const row = result.rows[0];
    if (!row) return 'lost-lease';
    return row.dead_lettered ? 'dead-letter' : 'retry';
  }
}

export async function enqueueElasticsearchProjection(
  chunks: ElasticsearchProjectionChunk[]
): Promise<{ mode: ElasticsearchRolloutMode; eventId?: string }> {
  const elasticsearchConfig = getElasticsearchRuntimeConfig();
  if (elasticsearchConfig.mode === 'off') return { mode: 'off' };
  assertElasticsearchConfigured(elasticsearchConfig);
  const postgresClient = getPostgresClient(getPostgresRuntimeConfig());
  if (!postgresClient) {
    throw new ElasticsearchProjectionOutboxError(
      elasticsearchConfig.mode,
      'Elasticsearch projection requires PostgreSQL outbox persistence.'
    );
  }
  try {
    return {
      mode: elasticsearchConfig.mode,
      eventId: await new PostgresElasticsearchOutboxStore(postgresClient).enqueueUpsert(chunks),
    };
  } catch (error) {
    if (error instanceof ElasticsearchProjectionOutboxError) throw error;
    throw new ElasticsearchProjectionOutboxError(
      elasticsearchConfig.mode,
      'Milvus write succeeded but Elasticsearch projection could not be durably enqueued.',
      error
    );
  }
}

interface ProjectionIdentity {
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
}

function validateProjectionChunks(chunks: ElasticsearchProjectionChunk[]): ProjectionIdentity {
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > 1_000) {
    throw new Error('Elasticsearch projection requires between 1 and 1000 chunks.');
  }
  const first = chunks[0];
  const identity = {
    tenantId: required(first.tenantId, 'tenantId', 128),
    corpusId: required(first.corpusId, 'corpusId', 128),
    documentId: required(first.documentId, 'documentId', 256),
    documentVersion: required(first.documentVersion, 'documentVersion', 256),
  };
  const ids = new Set<string>();
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.tenantId !== identity.tenantId
      || chunk.corpusId !== identity.corpusId
      || chunk.documentId !== identity.documentId
      || chunk.documentVersion !== identity.documentVersion
    ) throw new Error('Elasticsearch projection chunks must share one tenant, corpus, document, and version.');
    const id = required(chunk.id, `chunks[${index}].id`, 256);
    if (ids.has(id)) throw new Error('Elasticsearch projection chunk IDs must be unique.');
    ids.add(id);
    requiredContent(chunk.content, `chunks[${index}].content`, 65_000);
    if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(chunk.trustLevel)) {
      throw new Error('Elasticsearch projection trust level is invalid.');
    }
  }
  return identity;
}

interface OutboxRow {
  id: string;
  sequence: string | number;
  tenant_id: string;
  corpus_id: string;
  document_id: string;
  document_version: string;
  event_type: 'upsert' | 'delete';
  projection_digest: string;
  attempts: string | number;
  lease_token: string;
  lease_expires_at: string | Date;
}

interface LexicalChunkRow {
  chunk_id: string;
  tenant_id: string;
  corpus_id: string;
  document_id: string;
  document_version: string;
  trust_level: RagTrustLevel;
  content: string;
  source: string | null;
  page: number | null;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown>;
}

function toClaimedEvent(row: OutboxRow): ClaimedElasticsearchOutboxEvent {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    tenantId: row.tenant_id,
    corpusId: row.corpus_id,
    documentId: row.document_id,
    documentVersion: row.document_version,
    eventType: row.event_type,
    projectionDigest: row.projection_digest,
    attempt: Number(row.attempts),
    leaseToken: row.lease_token,
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
  };
}

function toLexicalDocument(row: LexicalChunkRow): ElasticsearchLexicalDocument {
  return {
    chunk_id: row.chunk_id,
    tenant_id: row.tenant_id,
    corpus_id: row.corpus_id,
    document_id: row.document_id,
    document_version: row.document_version,
    trust_level: row.trust_level,
    content: row.content,
    ...(row.source ? { source: row.source } : {}),
    ...(row.page === null ? {} : { page: row.page }),
    ...(row.start_offset === null ? {} : { start_offset: row.start_offset }),
    ...(row.end_offset === null ? {} : { end_offset: row.end_offset }),
    metadata: row.metadata ?? {},
  };
}

function required(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Elasticsearch projection ${field} is invalid.`);
  }
  return value.trim();
}

function requiredContent(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Elasticsearch projection ${field} is invalid.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Elasticsearch outbox ${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Elasticsearch projection failed.';
  return message.slice(0, 2_000) || 'Elasticsearch projection failed.';
}
