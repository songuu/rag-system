/**
 * Embedding 缓存（统一 query + doc 两 namespace）
 *
 * 设计目标：
 * - query 命中跳过 provider 调用
 * - doc 命中跳过 provider 调用（重复上传同 chunk 不再消耗 API quota）
 * - namespace 隔离避免 contextualized chunk 与原始 chunk 投毒
 * - TTL + LRU，多 provider 共享同一 key 空间但通过 model 字段区分
 *
 * 与已有 vectorization-utils.queryEmbeddingCache 的关系：
 * - 旧的 queryEmbeddingCache 仍保留（向后兼容；为防止 hotpath 内部多一层调用）
 * - 本模块面向需要 namespace + content hash 的场景；vectorization-utils 的 generateEmbeddings/generateQueryEmbedding 后续可逐步迁过来
 */

import crypto from 'node:crypto';

export type EmbeddingNamespace = 'query' | 'doc' | 'doc-contextualized';

interface CacheEntry {
  embedding: number[];
  expiresAt: number;
}

export interface EmbeddingCacheConfig {
  ttlMs?: number;
  maxSize?: number;
  enabled?: boolean;
}

export interface EmbeddingCacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
}

const DEFAULT_CONFIG: Required<EmbeddingCacheConfig> = {
  ttlMs: 30 * 60 * 1000, // 30 min
  maxSize: 1024,
  enabled: true,
};

// Cache 版本：升级语义（如归一化算法变化）必须同步 bump
const CACHE_VERSION = 'v1';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildKey(namespace: EmbeddingNamespace, model: string, text: string): string {
  return `${CACHE_VERSION}:${namespace}:${model}:${sha256(text)}`;
}

export class EmbeddingCache {
  private store = new Map<string, CacheEntry>();
  private config: Required<EmbeddingCacheConfig>;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(config: EmbeddingCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get(namespace: EmbeddingNamespace, model: string, text: string): number[] | null {
    if (!this.config.enabled) return null;
    const key = buildKey(namespace, model, text);
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.evictions++;
      this.misses++;
      return null;
    }
    // refresh LRU ordering
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.embedding.slice();
  }

  set(namespace: EmbeddingNamespace, model: string, text: string, embedding: number[]): void {
    if (!this.config.enabled) return;
    const key = buildKey(namespace, model, text);
    const entry: CacheEntry = {
      embedding: embedding.slice(),
      expiresAt: Date.now() + this.config.ttlMs,
    };
    this.store.set(key, entry);

    while (this.store.size > this.config.maxSize) {
      const oldest = this.store.keys().next().value;
      if (!oldest) break;
      this.store.delete(oldest);
      this.evictions++;
    }
  }

  /** 批量 get，返回未命中的索引（供调用方批量 embed 后再写入） */
  getMany(
    namespace: EmbeddingNamespace,
    model: string,
    texts: string[]
  ): { cached: Array<number[] | null>; missIndices: number[] } {
    const cached: Array<number[] | null> = new Array(texts.length).fill(null);
    const missIndices: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const hit = this.get(namespace, model, texts[i]);
      if (hit) cached[i] = hit;
      else missIndices.push(i);
    }
    return { cached, missIndices };
  }

  /** 批量 set，配合 getMany 使用 */
  setMany(
    namespace: EmbeddingNamespace,
    model: string,
    texts: string[],
    embeddings: number[][]
  ): void {
    if (texts.length !== embeddings.length) {
      throw new Error(`setMany length mismatch: texts=${texts.length} embeddings=${embeddings.length}`);
    }
    for (let i = 0; i < texts.length; i++) {
      this.set(namespace, model, texts[i], embeddings[i]);
    }
  }

  getStats(): EmbeddingCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      maxSize: this.config.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
    };
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

// 进程级单例（同 query embedding cache 的内存模型）
let defaultCache: EmbeddingCache | null = null;

export function getEmbeddingCache(): EmbeddingCache {
  if (!defaultCache) {
    const ttlMs = Number(process.env.EMBEDDING_CACHE_TTL_MS) || undefined;
    const maxSize = Number(process.env.EMBEDDING_CACHE_MAX_SIZE) || undefined;
    const enabled = process.env.EMBEDDING_CACHE_ENABLED !== 'false';
    defaultCache = new EmbeddingCache({
      ...(Number.isFinite(ttlMs) ? { ttlMs } : {}),
      ...(Number.isFinite(maxSize) ? { maxSize } : {}),
      enabled,
    });
  }
  return defaultCache;
}

/**
 * Query 归一化：NFKC + trim + 多空白合并
 * 不做大小写折叠/不删标点 — 避免破坏业务语义
 */
export function normalizeQueryText(query: string): string {
  if (typeof query !== 'string') return '';
  return query.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
