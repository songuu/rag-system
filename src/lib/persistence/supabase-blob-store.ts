import type { BlobStat, BlobStore, BlobWriteOptions } from './ports';
import type { SupabaseRuntimeConfig } from '../supabase/env';
import { getSupabaseRuntimeConfig } from '../supabase/env';
import { getSupabaseAdminClient } from '../supabase/admin-client';

export class SupabaseBlobStore implements BlobStore {
  private readonly config: SupabaseRuntimeConfig;
  private readonly prefix: string;

  constructor(
    config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig(),
    prefix?: string
  ) {
    this.config = config;
    this.prefix = prefix ?? this.defaultPrefix();
  }

  async ensureRoot(): Promise<void> {
    // Storage buckets are provisioned outside the request path.
  }

  async exists(filename: string): Promise<boolean> {
    const client = getSupabaseAdminClient(this.config);
    if (!client) return false;

    return (
      await client.objectExists(this.config.parsedBucket, this.objectPath(filename, 'parsed')) ||
      await client.objectExists(this.config.rawBucket, this.objectPath(filename, 'raw'))
    );
  }

  async write(filename: string, data: string | Uint8Array, options: BlobWriteOptions): Promise<void> {
    const client = getSupabaseAdminClient(this.config);
    if (!client) return;

    const bucket = options.kind === 'parsed' ? this.config.parsedBucket : this.config.rawBucket;
    await client.uploadObject({
      bucket,
      path: this.objectPath(filename, options.kind),
      body: data,
      contentType: options.contentType,
      upsert: true,
    });
  }

  async readText(filename: string): Promise<string> {
    const client = getSupabaseAdminClient(this.config);
    if (!client) {
      throw new Error('Supabase storage is not configured');
    }
    return await client.downloadText(this.config.parsedBucket, this.objectPath(filename, 'parsed'));
  }

  async list(): Promise<string[]> {
    return [];
  }

  async stat(filename: string): Promise<BlobStat> {
    throw new Error(`SupabaseBlobStore.stat is not implemented for ${filename}`);
  }

  async delete(filename: string): Promise<boolean> {
    const client = getSupabaseAdminClient(this.config);
    if (!client) return false;

    await client.removeObjects(this.config.rawBucket, [this.objectPath(filename, 'raw')]);
    await client.removeObjects(this.config.parsedBucket, [this.objectPath(filename, 'parsed')]);
    return true;
  }

  objectPath(filename: string, kind: string): string {
    return `${this.prefix}/${kind}/${encodeURIComponent(filename)}`;
  }

  private defaultPrefix(): string {
    const tenant = this.config.defaultTenantId || 'unscoped';
    const corpus = this.config.defaultCorpusId || 'default';
    return `tenant/${tenant}/corpus/${corpus}`;
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
      console.warn('[DualWriteBlobStore] Supabase blob mirror failed:', error);
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
      console.warn('[DualWriteBlobStore] Supabase blob delete mirror failed:', error);
    }
    return deleted;
  }
}
