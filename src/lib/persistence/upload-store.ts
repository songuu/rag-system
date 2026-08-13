import path from 'path';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldDualWritePostgres,
  shouldUsePostgresPersistence,
} from '../postgres/env';
import { LocalBlobStore, LocalUploadManifestStore } from './local-dev-store';
import { DualWriteBlobStore, PostgresBlobStore } from './postgres-blob-store';
import {
  DualWriteUploadManifestStore,
  PostgresUploadManifestStore,
} from './postgres-corpus-store';
import type { BlobStore, UploadManifestStore } from './ports';

export interface UploadPersistence {
  blobStore: BlobStore;
  manifestStore: UploadManifestStore;
}

export function createUploadPersistence(input: {
  uploadDir: string;
  manifestFile?: string;
}): UploadPersistence {
  const config = getPostgresRuntimeConfig();
  const manifestFile = input.manifestFile ?? path.join(input.uploadDir, 'file-manifest.json');
  const localBlobStore = new LocalBlobStore(input.uploadDir);
  const localManifestStore = new LocalUploadManifestStore(manifestFile);

  if (!shouldUsePostgresPersistence(config)) {
    return {
      blobStore: localBlobStore,
      manifestStore: localManifestStore,
    };
  }

  assertPostgresPersistenceConfigured(config);
  const postgresBlobStore = new PostgresBlobStore(config);
  const postgresManifestStore = new PostgresUploadManifestStore(config);

  if (config.persistenceBackend === 'postgres' && postgresManifestStore.isReady()) {
    return {
      blobStore: postgresBlobStore,
      manifestStore: postgresManifestStore,
    };
  }

  if (shouldDualWritePostgres(config)) {
    return {
      blobStore: new DualWriteBlobStore(localBlobStore, postgresBlobStore),
      manifestStore: new DualWriteUploadManifestStore(localManifestStore, postgresManifestStore),
    };
  }

  return {
    blobStore: localBlobStore,
    manifestStore: localManifestStore,
  };
}
