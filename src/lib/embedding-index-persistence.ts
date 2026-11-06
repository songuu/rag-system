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
/** Read a worker job's index without relying on the process-wide default scope. */
export async function readEmbeddingIndexForScope(
  scope: { tenantId: string; corpusId: string },
  pointerStore?: Pick<BlobStore, 'exists' | 'readText'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActiveEmbeddingIndex | undefined> {
  const scopedEnv = { ...env, RAG_DEFAULT_TENANT_ID: scope.tenantId, RAG_DEFAULT_CORPUS_ID: scope.corpusId };
  const config = getPostgresRuntimeConfig(env);
  const store = pointerStore || new PostgresBlobStore({ ...config, defaultTenantId: scope.tenantId, defaultCorpusId: scope.corpusId });
  if (!await store.exists(POINTER_FILE)) return undefined;
  const record = JSON.parse(await store.readText(POINTER_FILE));
  if (record.baseKey !== embeddingIndexBaseKey(scopedEnv)) {
    throw new Error('活动嵌入索引身份不匹配，请检查图谱服务的索引身份配置。');
  }
  return validateActiveEmbeddingIndex(record, scopedEnv);
}
export async function hydrateEmbeddingIndex(pointerStore?: Pick<BlobStore, 'exists' | 'readText'>, options?: { refresh?: boolean }): Promise<void> {
  const state = getEmbeddingIndexState();
  const key = embeddingIndexBaseKey();
  if (options?.refresh && state.loading) await state.loading;
  if (!options?.refresh && state.loaded === key) return;
  if (!state.loading) state.loading = (async () => {
    let active: ActiveEmbeddingIndex | undefined;
    if (pointerStore || getPostgresRuntimeConfig().databaseUrl) {
      const store = pointerStore || embeddingIndexPointerStore();
      if (await store.exists(POINTER_FILE)) {
        const record = JSON.parse(await store.readText(POINTER_FILE));
        // An explicit operator change to the baseline configuration supersedes
        // an older pointer; never bind an index from another runtime scope.
        if (record.baseKey === key) active = validateActiveEmbeddingIndex(record);
      }
    }
    state.active = active;
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
