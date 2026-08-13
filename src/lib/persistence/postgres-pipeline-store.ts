import { createHash } from 'node:crypto';
import type { PostgresQueryClient } from '../postgres/client';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
  type PostgresRuntimeConfig,
} from '../postgres/env';
import type { JsonValue } from './types';

export interface CompletedPipelineDocument {
  tenantId: string;
  corpusId: string;
  actorId: string;
  documentId: string;
  originalName: string;
  contentType: string;
  sourceHash: string;
  sourceKind: string;
  source?: string | Buffer;
  metadata: Record<string, JsonValue>;
}

interface AssetIdRow {
  id: string;
}

export class PostgresPipelineStore {
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

  async recordCompletedDocument(input: CompletedPipelineDocument): Promise<string> {
    this.assertScope(input);
    const source = input.source === undefined
      ? null
      : typeof input.source === 'string'
        ? Buffer.from(input.source, 'utf8')
        : input.source;
    const blobKind = typeof input.source === 'string' ? 'parsed' : 'raw';
    const blobFilename = source ? this.blobFilename(input.documentId, blobKind) : null;
    const metadata = {
      ...input.metadata,
      source_kind: input.sourceKind,
      persistence_status: 'ready',
    };

    const result = await queryPostgres<AssetIdRow>(
      this.client,
      `with deduplicated as (
         delete from document_assets
         where tenant_id = $1 and corpus_id = $2 and source_hash = $7
           and external_document_id <> $3
         returning id
       ), stored_blob as (
         insert into object_blobs (
           tenant_id, corpus_id, kind, filename, data, content_type, metadata
         )
         select $1, $2, $10, $9, $8::bytea, $5, $11::jsonb
         where $8::bytea is not null
         on conflict (tenant_id, corpus_id, filename)
         do update set
           kind = excluded.kind,
           data = excluded.data,
           content_type = excluded.content_type,
           metadata = excluded.metadata,
           updated_at = now()
         returning filename
       )
       insert into document_assets (
         tenant_id, corpus_id, external_document_id, original_name, content_type,
         byte_size, source_hash, raw_blob_filename, parsed_blob_filename,
         parse_method, metadata, created_by, updated_at
       )
       select
         $1, $2, $3, $4, $5, $6, $7,
         case when $10 = 'raw' then $9 else null end,
         case when $10 = 'parsed' then $9 else null end,
         $13, $11::jsonb, $12, now()
       from (select count(*) as removed_count from deduplicated) dependency
       cross join (select count(*) as stored_count from stored_blob) blob_dependency
       where dependency.removed_count >= 0 and blob_dependency.stored_count >= 0
       on conflict (tenant_id, corpus_id, external_document_id)
       do update set
         original_name = excluded.original_name,
         content_type = excluded.content_type,
         byte_size = excluded.byte_size,
         source_hash = excluded.source_hash,
         raw_blob_filename = coalesce(excluded.raw_blob_filename, document_assets.raw_blob_filename),
         parsed_blob_filename = coalesce(excluded.parsed_blob_filename, document_assets.parsed_blob_filename),
         parse_method = excluded.parse_method,
         metadata = excluded.metadata,
         created_by = excluded.created_by,
         updated_at = now()
       returning id`,
      [
        input.tenantId,
        input.corpusId,
        input.documentId,
        input.originalName,
        input.contentType,
        source?.byteLength ?? 0,
        input.sourceHash,
        source,
        blobFilename,
        blobKind,
        JSON.stringify(metadata),
        input.actorId,
        input.sourceKind,
      ],
      'persist completed pipeline document'
    );
    const assetId = result.rows[0]?.id;
    if (!assetId) throw new Error('PostgreSQL did not return the persisted document asset.');
    return assetId;
  }

  private assertScope(input: CompletedPipelineDocument): void {
    if (
      input.tenantId !== this.config.defaultTenantId
      || input.corpusId !== this.config.defaultCorpusId
    ) {
      throw new Error('Pipeline document is outside the configured PostgreSQL scope.');
    }
  }

  private blobFilename(documentId: string, kind: 'raw' | 'parsed'): string {
    const digest = createHash('sha256')
      .update(`${this.config.defaultTenantId}\0${this.config.defaultCorpusId}\0${documentId}`)
      .digest('hex');
    return `pipeline-${digest}.${kind}`;
  }
}

export async function recordPipelineDocumentIfConfigured(
  input: CompletedPipelineDocument
): Promise<string | null> {
  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) return null;
  return await new PostgresPipelineStore(config).recordCompletedDocument(input);
}
