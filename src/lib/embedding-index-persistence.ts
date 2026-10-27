import { PostgresBlobStore } from './persistence/postgres-blob-store';
import { getPostgresRuntimeConfig } from './postgres/env';
import { embeddingIndexBaseKey, getEmbeddingIndexState, validateActiveEmbeddingIndex } from './embedding-index-state';
import type { ActiveEmbeddingIndex } from './embedding-index-state';
import type { BlobStore } from './persistence/ports';

const POINTER_FILE = 'embedding-active-index-v1.json';
export function embeddingIndexPointerStore() {
  const config = getPostgresRuntimeConfig();
  return new PostgresBlobStore({ ...config,
    defaultTenantId: config.defaultTenantId || 'local-dev-tenant',
    defaultCorpusId: config.defaultCorpusId || 'local-dev-corpus' });
}
export async function hydrateEmbeddingIndex(pointerStore?: Pick<BlobStore, 'exists' | 'readText'>): Promise<void> {
  const state = getEmbeddingIndexState();
  const key = embeddingIndexBaseKey();
  if (state.loaded === key) return;
  if (!state.loading) state.loading = (async () => {
    if (pointerStore || getPostgresRuntimeConfig().databaseUrl) {
      const store = pointerStore || embeddingIndexPointerStore();
      if (await store.exists(POINTER_FILE)) {
        const record = JSON.parse(await store.readText(POINTER_FILE));
        // An explicit operator change to the baseline configuration supersedes
        // an older pointer; never bind an index from another runtime scope.
        if (record.baseKey === key) state.active = validateActiveEmbeddingIndex(record);
      }
    }
    state.loaded = key;
  })().finally(() => { state.loading = undefined; });
  await state.loading;
}
export async function publishEmbeddingIndex(record: ActiveEmbeddingIndex, pointerStore?: Pick<BlobStore, 'write'>): Promise<void> {
  validateActiveEmbeddingIndex(record);
  await (pointerStore || embeddingIndexPointerStore()).write(POINTER_FILE, JSON.stringify(record), {
    kind: 'artifact', contentType: 'application/json',
  });
  getEmbeddingIndexState().active = record;
  getEmbeddingIndexState().loaded = record.baseKey;
}
