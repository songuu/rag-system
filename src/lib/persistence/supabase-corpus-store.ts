import type { TableInsert, TableRow } from '../supabase/database.types';
import { getSupabaseAdminClient } from '../supabase/admin-client';
import {
  getSupabaseRuntimeConfig,
  isSupabaseAdminConfigured,
  type SupabaseRuntimeConfig,
} from '../supabase/env';
import type { FileManifestItem, UploadManifestStore } from './ports';

type DocumentAssetRow = TableRow<'document_assets'>;
type DocumentAssetInsert = TableInsert<'document_assets'>;

function stableSourceHash(item: FileManifestItem): string {
  return `${item.id}:${item.originalName}:${item.size}:${item.contentLength}`;
}

function manifestMetadata(item: FileManifestItem) {
  return {
    manifest_id: item.id,
    original_extension: item.originalExtension,
    stored_filename: item.storedFilename,
    parsed_filename: item.parsedFilename,
    content_length: item.contentLength,
    uploaded_at: item.uploadedAt,
    pages: item.pages ?? null,
  };
}

function rowToManifestItem(row: DocumentAssetRow): FileManifestItem {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};

  return {
    id: typeof metadata.manifest_id === 'string' ? metadata.manifest_id : row.id,
    originalName: row.original_name,
    originalExtension: typeof metadata.original_extension === 'string' ? metadata.original_extension : '',
    storedFilename: typeof metadata.stored_filename === 'string' ? metadata.stored_filename : row.storage_path.split('/').pop() ?? row.original_name,
    parsedFilename: typeof metadata.parsed_filename === 'string' ? metadata.parsed_filename : row.parsed_path?.split('/').pop() ?? '',
    size: Number(row.byte_size || 0),
    contentLength: typeof metadata.content_length === 'number' ? metadata.content_length : 0,
    uploadedAt: typeof metadata.uploaded_at === 'string' ? metadata.uploaded_at : row.created_at,
    parseMethod: row.parse_method || 'unknown',
    pages: typeof metadata.pages === 'number' ? metadata.pages : undefined,
  };
}

export class SupabaseUploadManifestStore implements UploadManifestStore {
  private readonly config: SupabaseRuntimeConfig;

  constructor(config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()) {
    this.config = config;
  }

  isReady(): boolean {
    return isSupabaseAdminConfigured(this.config) && Boolean(this.config.defaultCorpusId);
  }

  async loadManifest(): Promise<Record<string, FileManifestItem>> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return {};

    const rows = await client.selectRows<DocumentAssetRow>('document_assets', {
      filters: {
        tenant_id: this.config.defaultTenantId,
        corpus_id: this.config.defaultCorpusId,
      },
      order: { column: 'created_at', ascending: false },
    });

    return Object.fromEntries(rows.map((row) => {
      const item = rowToManifestItem(row);
      return [item.id, item];
    }));
  }

  async saveManifest(manifest: Record<string, FileManifestItem>): Promise<void> {
    for (const item of Object.values(manifest)) {
      await this.recordUpload(item);
    }
  }

  async recordUpload(item: FileManifestItem): Promise<void> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return;

    const row: DocumentAssetInsert = {
      tenant_id: this.config.defaultTenantId,
      corpus_id: this.config.defaultCorpusId,
      original_name: item.originalName,
      content_type: item.originalExtension || 'application/octet-stream',
      byte_size: item.size,
      source_hash: stableSourceHash(item),
      storage_bucket: this.config.rawBucket,
      storage_path: `tenant/${this.config.defaultTenantId}/corpus/${this.config.defaultCorpusId}/raw/${encodeURIComponent(item.storedFilename)}`,
      parsed_bucket: this.config.parsedBucket,
      parsed_path: `tenant/${this.config.defaultTenantId}/corpus/${this.config.defaultCorpusId}/parsed/${encodeURIComponent(item.parsedFilename)}`,
      parse_method: item.parseMethod,
      metadata: manifestMetadata(item),
    };

    await client.upsertRows('document_assets', row, { onConflict: 'corpus_id,source_hash' });
  }

  async removeUpload(match: string): Promise<FileManifestItem | null> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return null;

    const manifest = await this.loadManifest();
    const item = Object.values(manifest).find((candidate) =>
      candidate.id === match ||
      candidate.originalName === match ||
      candidate.storedFilename === match ||
      candidate.parsedFilename === match
    );

    if (!item) return null;

    await client.deleteRows('document_assets', {
      tenant_id: this.config.defaultTenantId,
      corpus_id: this.config.defaultCorpusId,
      source_hash: stableSourceHash(item),
    });
    return item;
  }
}

export class DualWriteUploadManifestStore implements UploadManifestStore {
  private readonly primary: UploadManifestStore;
  private readonly secondary: UploadManifestStore;

  constructor(
    primary: UploadManifestStore,
    secondary: UploadManifestStore
  ) {
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
      console.warn('[DualWriteUploadManifestStore] Supabase manifest mirror failed:', error);
    }
  }

  async recordUpload(item: FileManifestItem): Promise<void> {
    await this.primary.recordUpload(item);
    try {
      await this.secondary.recordUpload(item);
    } catch (error) {
      console.warn('[DualWriteUploadManifestStore] Supabase manifest record failed:', error);
    }
  }

  async removeUpload(match: string): Promise<FileManifestItem | null> {
    const removed = await this.primary.removeUpload(match);
    try {
      await this.secondary.removeUpload(match);
    } catch (error) {
      console.warn('[DualWriteUploadManifestStore] Supabase manifest remove failed:', error);
    }
    return removed;
  }
}
