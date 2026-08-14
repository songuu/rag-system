import type { PostgresQueryClient } from '../postgres/client';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  isPostgresPersistenceReady,
  type PostgresRuntimeConfig,
} from '../postgres/env';
import type { FileManifestItem, UploadManifestStore } from './ports';
import { createStableErrorLog } from '../security/error-redaction';

interface DocumentAssetRow {
  id: string;
  external_document_id: string | null;
  original_name: string;
  content_type: string;
  byte_size: string | number;
  source_hash: string;
  raw_blob_filename: string;
  parsed_blob_filename: string | null;
  parse_method: string | null;
  metadata: unknown;
  created_at: string | Date;
}

function stableSourceHash(item: FileManifestItem): string {
  return `${item.id}:${item.originalName}:${item.size}:${item.contentLength}`;
}

function manifestMetadata(item: FileManifestItem) {
  return {
    manifest_id: item.id,
    original_extension: item.originalExtension,
    content_length: item.contentLength,
    uploaded_at: item.uploadedAt,
    pages: item.pages ?? null,
    ...(item.source ? { source: item.source } : {}),
    ...(item.sourceHash ? { source_hash: item.sourceHash } : {}),
  };
}

function rowToManifestItem(row: DocumentAssetRow): FileManifestItem {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};

  return {
    id: typeof metadata.manifest_id === 'string'
      ? metadata.manifest_id
      : row.external_document_id ?? row.id,
    originalName: row.original_name,
    originalExtension: typeof metadata.original_extension === 'string'
      ? metadata.original_extension
      : '',
    storedFilename: row.raw_blob_filename,
    parsedFilename: row.parsed_blob_filename ?? '',
    size: Number(row.byte_size || 0),
    contentLength: typeof metadata.content_length === 'number' ? metadata.content_length : 0,
    uploadedAt: typeof metadata.uploaded_at === 'string'
      ? metadata.uploaded_at
      : toIso(row.created_at),
    parseMethod: row.parse_method || 'unknown',
    pages: typeof metadata.pages === 'number' ? metadata.pages : undefined,
    source: metadata.source === 'maic' ? 'maic' : undefined,
    sourceHash: typeof metadata.source_hash === 'string' ? metadata.source_hash : undefined,
  };
}

function manifestRecord(item: FileManifestItem) {
  return {
    id: item.id,
    original_name: item.originalName,
    content_type: item.originalExtension || 'application/octet-stream',
    byte_size: item.size,
    source_hash: item.sourceHash ?? stableSourceHash(item),
    raw_blob_filename: item.storedFilename,
    parsed_blob_filename: item.parsedFilename || null,
    parse_method: item.parseMethod,
    metadata: manifestMetadata(item),
  };
}

export class PostgresUploadManifestStore implements UploadManifestStore {
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

  async loadManifest(): Promise<Record<string, FileManifestItem>> {
    const result = await queryPostgres<DocumentAssetRow>(
      this.client,
      `select id, external_document_id, original_name, content_type, byte_size, source_hash,
              raw_blob_filename, parsed_blob_filename, parse_method, metadata, created_at
       from document_assets
       where tenant_id = $1 and corpus_id = $2
         and metadata ? 'manifest_id'
       order by created_at desc`,
      [this.config.defaultTenantId, this.config.defaultCorpusId],
      'load upload manifest'
    );

    return Object.fromEntries(result.rows.map((row) => {
      const item = rowToManifestItem(row);
      return [item.id, item];
    }));
  }

  async saveManifest(manifest: Record<string, FileManifestItem>): Promise<void> {
    const records = Object.values(manifest).map(manifestRecord);
    await queryPostgres(
      this.client,
      `with incoming as (
         select value as item
         from jsonb_array_elements($3::jsonb)
       ), removed as (
         delete from document_assets existing
         where existing.tenant_id = $1
           and existing.corpus_id = $2
           and existing.metadata ? 'manifest_id'
           and not exists (
             select 1 from incoming
             where incoming.item->>'id' = existing.external_document_id
           )
         returning existing.id
       )
       insert into document_assets (
         tenant_id, corpus_id, external_document_id, original_name, content_type, byte_size, source_hash,
         raw_blob_filename, parsed_blob_filename, parse_method, metadata
       )
       select
         $1, $2, item->>'id', item->>'original_name', item->>'content_type',
         (item->>'byte_size')::bigint, item->>'source_hash',
         item->>'raw_blob_filename', item->>'parsed_blob_filename',
         item->>'parse_method', item->'metadata'
       from incoming
       cross join (select count(*) as removed_count from removed) dependency
       where dependency.removed_count >= 0
       on conflict (tenant_id, corpus_id, external_document_id)
       do update set
         original_name = excluded.original_name,
         content_type = excluded.content_type,
         byte_size = excluded.byte_size,
         source_hash = excluded.source_hash,
         raw_blob_filename = excluded.raw_blob_filename,
         parsed_blob_filename = excluded.parsed_blob_filename,
         parse_method = excluded.parse_method,
         metadata = excluded.metadata`,
      [this.config.defaultTenantId, this.config.defaultCorpusId, JSON.stringify(records)],
      'replace upload manifest'
    );
  }

  async recordUpload(item: FileManifestItem): Promise<void> {
    const record = manifestRecord(item);
    await queryPostgres(
      this.client,
      `insert into document_assets (
         tenant_id, corpus_id, external_document_id, original_name, content_type, byte_size, source_hash,
         raw_blob_filename, parsed_blob_filename, parse_method, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       on conflict (tenant_id, corpus_id, external_document_id)
       do update set
         original_name = excluded.original_name,
         content_type = excluded.content_type,
         byte_size = excluded.byte_size,
         source_hash = excluded.source_hash,
         raw_blob_filename = excluded.raw_blob_filename,
         parsed_blob_filename = excluded.parsed_blob_filename,
         parse_method = excluded.parse_method,
         metadata = excluded.metadata`,
      [
        this.config.defaultTenantId,
        this.config.defaultCorpusId,
        record.id,
        record.original_name,
        record.content_type,
        record.byte_size,
        record.source_hash,
        record.raw_blob_filename,
        record.parsed_blob_filename,
        record.parse_method,
        JSON.stringify(record.metadata),
      ],
      'record upload manifest item'
    );
  }

  async removeUpload(match: string): Promise<FileManifestItem | null> {
    const result = await queryPostgres<DocumentAssetRow>(
      this.client,
      `delete from document_assets
       where id = (
         select id from document_assets
         where tenant_id = $1 and corpus_id = $2
           and metadata ? 'manifest_id'
           and (
             metadata->>'manifest_id' = $3
             or original_name = $3
             or raw_blob_filename = $3
             or parsed_blob_filename = $3
           )
         limit 1
       )
       returning id, external_document_id, original_name, content_type, byte_size, source_hash,
                 raw_blob_filename, parsed_blob_filename, parse_method, metadata, created_at`,
      [this.config.defaultTenantId, this.config.defaultCorpusId, match],
      'remove upload manifest item'
    );
    const row = result.rows[0];
    return row ? rowToManifestItem(row) : null;
  }
}

export class DualWriteUploadManifestStore implements UploadManifestStore {
  private readonly primary: UploadManifestStore;
  private readonly secondary: UploadManifestStore;

  constructor(primary: UploadManifestStore, secondary: UploadManifestStore) {
    this.primary = primary;
    this.secondary = secondary;
  }

  loadManifest(): Promise<Record<string, FileManifestItem>> {
    return this.primary.loadManifest();
  }

  async saveManifest(manifest: Record<string, FileManifestItem>): Promise<void> {
    await this.primary.saveManifest(manifest);
    try {
      await this.secondary.saveManifest(manifest);
    } catch (error) {
      console.warn('[DualWriteUploadManifestStore] PostgreSQL manifest mirror failed:', createStableErrorLog(error));
    }
  }

  async recordUpload(item: FileManifestItem): Promise<void> {
    await this.primary.recordUpload(item);
    try {
      await this.secondary.recordUpload(item);
    } catch (error) {
      console.warn('[DualWriteUploadManifestStore] PostgreSQL manifest record failed:', createStableErrorLog(error));
    }
  }

  async removeUpload(match: string): Promise<FileManifestItem | null> {
    const removed = await this.primary.removeUpload(match);
    try {
      await this.secondary.removeUpload(match);
    } catch (error) {
      console.warn('[DualWriteUploadManifestStore] PostgreSQL manifest remove failed:', createStableErrorLog(error));
    }
    return removed;
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
