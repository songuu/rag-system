import { getElasticsearchRuntimeConfig, type ElasticsearchRolloutMode } from '../elasticsearch/config';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
} from '../postgres/env';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';

export type DocumentIndexStatus = 'ready' | 'pending' | 'failed' | 'disabled' | 'unknown';

export interface DocumentCatalogItem {
  id: string;
  documentId: string;
  name: string;
  contentType: string;
  sourceKind: string;
  byteSize: number;
  chunkCount: number;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  createdAt: string;
  updatedAt: string;
  milvusStatus: DocumentIndexStatus;
  elasticsearchStatus: DocumentIndexStatus;
}

export interface DocumentCatalogRow {
  id: string;
  external_document_id: string | null;
  original_name: string;
  content_type: string;
  byte_size: string | number;
  metadata: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  lexical_chunk_count: string | number;
  lexical_event_status: 'published' | 'pending' | 'failed' | null;
}

export class DocumentCatalogUnavailableError extends Error {
  readonly code = 'DOCUMENT_CATALOG_REQUIRES_POSTGRES';
  readonly status = 503;

  constructor(message = 'Document catalog requires PostgreSQL persistence.') {
    super(message);
    this.name = 'DocumentCatalogUnavailableError';
  }
}

export async function listDocumentCatalog(input: {
  scope: RagRetrievalScope;
  limit?: number;
}): Promise<DocumentCatalogItem[]> {
  const limit = input.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Document catalog limit must be between 1 and 1000.');
  }
  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) throw new DocumentCatalogUnavailableError();
  assertPostgresPersistenceConfigured(config);
  const client = getPostgresClient(config);
  if (!client) throw new DocumentCatalogUnavailableError('PostgreSQL document catalog is not configured.');

  const result = await queryPostgres<DocumentCatalogRow>(
    client,
    `select asset.id::text, asset.external_document_id, asset.original_name,
            asset.content_type, asset.byte_size, asset.metadata,
            asset.created_at, asset.updated_at,
            coalesce(lexical.chunk_count, 0)::bigint as lexical_chunk_count,
            case
              when latest_event.dead_lettered_at is not null then 'failed'
              when latest_event.published_at is not null then 'published'
              when latest_event.id is not null then 'pending'
              else null
            end as lexical_event_status
     from public.document_assets asset
     left join lateral (
       select count(*)::bigint as chunk_count
       from public.elasticsearch_lexical_chunks chunk
       where chunk.tenant_id = asset.tenant_id
         and chunk.corpus_id = asset.corpus_id
         and chunk.document_id = asset.external_document_id
     ) lexical on true
     left join lateral (
       select event.id, event.published_at, event.dead_lettered_at
       from public.elasticsearch_lexical_outbox event
       where event.tenant_id = asset.tenant_id
         and event.corpus_id = asset.corpus_id
         and event.document_id = asset.external_document_id
       order by event.sequence desc
       limit 1
     ) latest_event on true
     where asset.tenant_id = $1 and asset.corpus_id = $2
       and asset.external_document_id is not null
       and asset.metadata ? 'source_kind'
       and coalesce(
         nullif(asset.metadata #>> '{document,trustLevel}', ''),
         nullif(asset.metadata #>> '{document,trust_level}', ''),
         'external'
       ) = any($3::text[])
     order by asset.updated_at desc
     limit $4`,
    [
      input.scope.tenantId,
      input.scope.corpusId,
      [...input.scope.allowedTrustLevels],
      limit,
    ],
    'list canonical document catalog'
  );
  const elasticsearchMode = getElasticsearchRuntimeConfig().mode;
  return result.rows.map(row => toDocumentCatalogItem(row, elasticsearchMode));
}

export function toDocumentCatalogItem(
  row: DocumentCatalogRow,
  elasticsearchMode: ElasticsearchRolloutMode
): DocumentCatalogItem {
  const metadata = record(row.metadata);
  const document = record(metadata.document);
  const documentId = safeString(row.external_document_id) || row.id;
  const sourceKind = safeString(metadata.source_kind) || contentTypeKind(row.content_type);
  const documentVersion = firstString(
    document.documentVersion,
    document.document_version,
    document.sourceHash,
    document.source_hash
  ) || 'unknown';
  const trustLevel = normalizeTrustLevel(
    firstString(document.trustLevel, document.trust_level) || 'external'
  );
  const milvusStatus = metadata.persistence_status === 'ready' || Number(metadata.chunks) > 0
    ? 'ready'
    : 'unknown';
  const lexicalChunkCount = safeNonNegativeInteger(row.lexical_chunk_count);

  return {
    id: row.id,
    documentId,
    name: row.original_name,
    contentType: row.content_type,
    sourceKind,
    byteSize: safeNonNegativeInteger(row.byte_size),
    chunkCount: safeNonNegativeInteger(metadata.chunks),
    documentVersion,
    trustLevel,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    milvusStatus,
    elasticsearchStatus: elasticsearchStatus(
      elasticsearchMode,
      row.lexical_event_status,
      lexicalChunkCount
    ),
  };
}

function elasticsearchStatus(
  mode: ElasticsearchRolloutMode,
  eventStatus: DocumentCatalogRow['lexical_event_status'],
  lexicalChunkCount: number
): DocumentIndexStatus {
  if (mode === 'off') return 'disabled';
  if (eventStatus === 'failed') return 'failed';
  if (eventStatus === 'published' && lexicalChunkCount > 0) return 'ready';
  return 'pending';
}

function contentTypeKind(contentType: string): string {
  const value = contentType.toLowerCase();
  if (value.includes('pdf')) return 'pdf';
  if (value.includes('word')) return 'docx';
  if (value.includes('sheet') || value.includes('excel')) return 'xlsx';
  if (value.includes('json')) return 'json';
  if (value.includes('markdown')) return 'markdown';
  if (value.includes('uri')) return 'url';
  return 'text';
}

function normalizeTrustLevel(value: string): RagTrustLevel {
  return value === 'trusted' || value === 'reviewed' || value === 'quarantined'
    ? value
    : 'external';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.map(safeString).find(Boolean);
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
