/**
 * BFF 层语义缓存
 *
 * 使用查询 embedding 与已缓存查询的相似度进行命中判断。
 * 当相似度超过阈值时直接返回缓存结果，跳过后续检索和生成。
 */

import { Embeddings } from '@langchain/core/embeddings';
import { createEmbedding } from './model-config';

export interface CachedEntry {
  query: string;
  queryEmbedding: number[];
  answer: string;
  context: string;
  timestamp: number;
}

export interface SemanticCacheConfig {
  /** 缓存最大条目数 */
  maxSize?: number;
  /** 语义相似度阈值 (0-1)，超过则命中 */
  similarityThreshold?: number;
  /** 启用/禁用缓存 */
  enabled?: boolean;
}

const DEFAULT_CONFIG: Required<SemanticCacheConfig> = {
  maxSize: 100,
  similarityThreshold: 0.95,
  enabled: true,
};

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class SemanticCache {
  private cache: Map<string, CachedEntry> = new Map();
  private keysByOrder: string[] = [];
  private config: Required<SemanticCacheConfig>;
  private embeddings: Embeddings;

  constructor(embeddings?: Embeddings, config: SemanticCacheConfig = {}) {
    this.embeddings = embeddings ?? createEmbedding();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 检查缓存是否命中 */
  async get(
    query: string,
    queryEmbedding?: number[]
  ): Promise<{ hit: true; entry: CachedEntry } | { hit: false }> {
    if (!this.config.enabled || this.cache.size === 0) {
      return { hit: false };
    }

    const embedding = queryEmbedding ?? (await this.embeddings.embedQuery(query));
    let bestMatch: { key: string; similarity: number; entry: CachedEntry } | null = null;

    for (const [key, entry] of this.cache) {
      const sim = cosineSimilarity(embedding, entry.queryEmbedding);
      if (
        sim >= this.config.similarityThreshold &&
        (!bestMatch || sim > bestMatch.similarity)
      ) {
        bestMatch = { key, similarity: sim, entry };
      }
    }

    if (bestMatch) {
      return { hit: true, entry: bestMatch.entry };
    }
    return { hit: false };
  }

  /** 存入缓存 */
  async set(
    query: string,
    answer: string,
    context: string = '',
    queryEmbedding?: number[]
  ): Promise<void> {
    if (!this.config.enabled) return;

    const embedding = queryEmbedding ?? (await this.embeddings.embedQuery(query));
    const key = `q:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const entry: CachedEntry = {
      query,
      queryEmbedding: embedding,
      answer,
      context,
      timestamp: Date.now(),
    };

    // LRU 淘汰
    while (this.keysByOrder.length >= this.config.maxSize && this.keysByOrder.length > 0) {
      const oldest = this.keysByOrder.shift()!;
      this.cache.delete(oldest);
    }

    this.cache.set(key, entry);
    this.keysByOrder.push(key);
  }

  /** 清空缓存 */
  clear(): void {
    this.cache.clear();
    this.keysByOrder = [];
  }

  /** 获取缓存统计 */
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
    };
  }
}

let defaultCache: SemanticCache | null = null;

/** 获取默认语义缓存实例 */
export function getSemanticCache(config?: SemanticCacheConfig): SemanticCache {
  if (!defaultCache) {
    defaultCache = new SemanticCache(undefined, config);
  }
  return defaultCache;
}
