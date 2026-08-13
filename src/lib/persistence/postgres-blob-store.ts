import type { PostgresQueryClient } from '../postgres/client';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  type PostgresRuntimeConfig,
} from '../postgres/env';
import type { BlobStat, BlobStore, BlobWriteOptions } from './ports';

type BlobDataRow = { data: Buffer };
type BlobExistsRow = { exists: boolean };
type BlobFilenameRow = { filename: string };
type BlobStatRow = { size: string | number; modified: string | Date };

export class PostgresBlobStore implements BlobStore {
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

  async ensureRoot(): Promise<void> {
    // The SQL migration provisions object_blobs before the app starts.
  }

  async exists(filename: string): Promise<boolean> {
    const result = await queryPostgres<BlobExistsRow>(
      this.client,
      `select exists (
         select 1 from object_blobs
         where tenant_id = $1 and corpus_id = $2 and filename = $3
       ) as exists`,
      [this.config.defaultTenantId, this.config.defaultCorpusId, filename],
      'check blob existence'
    );
    return result.rows[0]?.exists === true;
  }

  async write(filename: string, data: string | Uint8Array, options: BlobWriteOptions): Promise<void> {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    await queryPostgres(
      this.client,
      `insert into object_blobs (
         tenant_id, corpus_id, kind, filename, data, content_type, metadata, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now())
       on conflict (tenant_id, corpus_id, filename)
       do update set
         kind = excluded.kind,
         data = excluded.data,
         content_type = excluded.content_type,
         metadata = excluded.metadata,
         updated_at = now()`,
      [
        this.config.defaultTenantId,
        this.config.defaultCorpusId,
        options.kind,
        filename,
        payload,
        options.contentType ?? 'application/octet-stream',
        JSON.stringify(options.metadata ?? {}),
      ],
      'write blob'
    );
  }

  async readText(filename: string): Promise<string> {
    const result = await queryPostgres<BlobDataRow>(
      this.client,
      `select data from object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3
       limit 1`,
      [this.config.defaultTenantId, this.config.defaultCorpusId, filename],
      'read blob'
    );
    const data = result.rows[0]?.data;
    if (!data) throw new Error(`Blob was not found: ${filename}`);
    return Buffer.from(data).toString('utf8');
  }

  async list(): Promise<string[]> {
    const result = await queryPostgres<BlobFilenameRow>(
      this.client,
      `select filename from object_blobs
       where tenant_id = $1 and corpus_id = $2
       order by filename asc`,
      [this.config.defaultTenantId, this.config.defaultCorpusId],
      'list blobs'
    );
    return result.rows.map((row) => row.filename);
  }

  async stat(filename: string): Promise<BlobStat> {
    const result = await queryPostgres<BlobStatRow>(
      this.client,
      `select octet_length(data) as size, updated_at as modified
       from object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3
       limit 1`,
      [this.config.defaultTenantId, this.config.defaultCorpusId, filename],
      'stat blob'
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Blob was not found: ${filename}`);
    return {
      size: Number(row.size),
      modified: row.modified instanceof Date ? row.modified.toISOString() : row.modified,
    };
  }

  async delete(filename: string): Promise<boolean> {
    const result = await queryPostgres<BlobFilenameRow>(
      this.client,
      `delete from object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3
       returning filename`,
      [this.config.defaultTenantId, this.config.defaultCorpusId, filename],
      'delete blob'
    );
    return result.rows.length > 0;
  }
}

export class DualWriteBlobStore implements BlobStore {
  private readonly primary: BlobStore;
  private readonly secondary: BlobStore;

  constructor(
    primary: BlobStore,
    secondary: BlobStore
  ) {
    this.primary = primary;
    this.secondary = secondary;
  }

  ensureRoot(): Promise<void> {
    return this.primary.ensureRoot();
  }

  exists(filename: string): Promise<boolean> {
    return this.primary.exists(filename);
  }

  async write(filename: string, data: string | Uint8Array, options: BlobWriteOptions): Promise<void> {
    await this.primary.write(filename, data, options);
    try {
      await this.secondary.write(filename, data, options);
    } catch (error) {
      console.warn('[DualWriteBlobStore] PostgreSQL blob mirror failed:', error);
    }
  }

  readText(filename: string): Promise<string> {
    return this.primary.readText(filename);
  }

  list(): Promise<string[]> {
    return this.primary.list();
  }

  stat(filename: string): Promise<BlobStat> {
    return this.primary.stat(filename);
  }

  async delete(filename: string): Promise<boolean> {
    const deleted = await this.primary.delete(filename);
    try {
      await this.secondary.delete(filename);
    } catch (error) {
      console.warn('[DualWriteBlobStore] PostgreSQL blob delete mirror failed:', error);
    }
    return deleted;
  }
}
