import path from 'path';
import { getSupabaseRuntimeConfig, shouldUseSupabasePersistence, shouldDualWriteSupabase } from '../supabase/env';
import { LocalBlobStore, LocalUploadManifestStore } from './local-dev-store';
import { DualWriteBlobStore, SupabaseBlobStore } from './supabase-blob-store';
import { DualWriteUploadManifestStore, SupabaseUploadManifestStore } from './supabase-corpus-store';
import type { BlobStore, UploadManifestStore } from './ports';

export interface UploadPersistence {
  blobStore: BlobStore;
  manifestStore: UploadManifestStore;
}

export function createUploadPersistence(input: {
  uploadDir: string;
  manifestFile?: string;
}): UploadPersistence {
  const config = getSupabaseRuntimeConfig();
  const manifestFile = input.manifestFile ?? path.join(input.uploadDir, 'file-manifest.json');
  const localBlobStore = new LocalBlobStore(input.uploadDir);
  const localManifestStore = new LocalUploadManifestStore(manifestFile);

  if (!shouldUseSupabasePersistence(config)) {
    return {
      blobStore: localBlobStore,
      manifestStore: localManifestStore,
    };
  }

  const supabaseBlobStore = new SupabaseBlobStore(config);
  const supabaseManifestStore = new SupabaseUploadManifestStore(config);

  if (config.persistenceBackend === 'supabase' && supabaseManifestStore.isReady()) {
    return {
      blobStore: supabaseBlobStore,
      manifestStore: supabaseManifestStore,
    };
  }

  if (shouldDualWriteSupabase(config)) {
    return {
      blobStore: new DualWriteBlobStore(localBlobStore, supabaseBlobStore),
      manifestStore: new DualWriteUploadManifestStore(localManifestStore, supabaseManifestStore),
    };
  }

  return {
    blobStore: localBlobStore,
    manifestStore: localManifestStore,
  };
}
