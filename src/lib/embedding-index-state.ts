export interface ActiveEmbeddingIndex {
  version: 1;
  baseKey: string;
  provider: string;
  model: string;
  collection: string;
  dimension: number;
  chunkCount: number;
  updatedAt: string;
}
type IndexState = { active?: ActiveEmbeddingIndex; loaded?: string; loading?: Promise<void> };
const stateRoot = globalThis as typeof globalThis & { __ragEmbeddingIndexStateV1?: IndexState };
export function getEmbeddingIndexState(): IndexState {
  return stateRoot.__ragEmbeddingIndexStateV1 ??= {};
}
export function embeddingIndexBaseKey(env: NodeJS.ProcessEnv = process.env): string {
  return JSON.stringify([env.EMBEDDING_PROVIDER || (env.SILICONFLOW_API_KEY ? 'siliconflow' : 'ollama'), env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
    env.MILVUS_DEFAULT_COLLECTION || 'rag_documents', env.MILVUS_DEFAULT_DIMENSION || '768',
    env.RAG_DEFAULT_TENANT_ID || 'local-dev-tenant', env.RAG_DEFAULT_CORPUS_ID || 'local-dev-corpus',
    env.MILVUS_PROVIDER || 'local', env.MILVUS_LOCAL_ADDRESS || 'localhost:19530',
    env.MILVUS_ZILLIZ_ENDPOINT || '', env.MILVUS_DEFAULT_DATABASE || 'default']);
}
export function getActiveEmbeddingIndex(): ActiveEmbeddingIndex | undefined {
  const active = getEmbeddingIndexState().active;
  return active?.baseKey === embeddingIndexBaseKey() ? active : undefined;
}
export function validateActiveEmbeddingIndex(value: unknown): ActiveEmbeddingIndex {
  const record = value as ActiveEmbeddingIndex;
  if (!record || record.version !== 1 || record.baseKey !== embeddingIndexBaseKey()
    || record.provider !== 'ollama' || typeof record.model !== 'string' || !/^[\w./:-]{1,256}$/u.test(record.model)
    || typeof record.collection !== 'string' || !/^ragidx_[a-f\d]{32}$/u.test(record.collection)
    || !Number.isSafeInteger(record.dimension) || record.dimension < 1 || record.dimension > 32768
    || !Number.isSafeInteger(record.chunkCount) || record.chunkCount < 0 || typeof record.updatedAt !== 'string') {
    throw new Error('持久化的嵌入索引配置无效，拒绝使用不匹配的向量索引。');
  }
  return record;
}
