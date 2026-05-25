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
  /** T4: 预归一化的向量副本，供 O(N·D) 查找用 dot product 直接得余弦相似度 */
  normalizedEmbedding?: number[];
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

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

const DEFAULT_CONFIG: Required<SemanticCacheConfig> = {
  // T4: maxSize 默认从 100 升到 256；可经 env 覆盖
  maxSize: envInt('SEMANTIC_CACHE_MAX_SIZE', 256),
  similarityThreshold: envFloat('SEMANTIC_CACHE_THRESHOLD', 0.95),
  enabled: process.env.SEMANTIC_CACHE_ENABLED !== 'false',
};

/** 余弦相似度（保留供单元测试与未归一化输入兜底） */
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

/** T4: 向量 L2 归一化（返回新数组，不改原向量） */
function normalizeVector(v: number[]): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return v.slice();
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** T4: 两个已归一化向量的余弦相似度 = 点积 */
function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export class SemanticCache {
  private cache: Map<string, CachedEntry> = new Map();
  private keysByOrder: string[] = [];
  private config: Required<SemanticCacheConfig>;
  private embeddings: Embeddings;

  // T1 telemetry
  private hits = 0;
  private misses = 0;
  private lastScanMs = 0;
  private lastScanEntries = 0;

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
      this.misses++;
      return { hit: false };
    }

    const embedding = queryEmbedding ?? (await this.embeddings.embedQuery(query));
    const normalizedQuery = normalizeVector(embedding);
    let bestMatch: { key: string; similarity: number; entry: CachedEntry } | null = null;

    const tScan = Date.now();
    let scanned = 0;
    for (const [key, entry] of this.cache) {
      scanned++;
      // T4: 优先使用预归一化向量做 dot product；旧 entry 无归一化字段时 fallback 到 cosine
      const sim = entry.normalizedEmbedding
        ? dotProduct(normalizedQuery, entry.normalizedEmbedding)
        : cosineSimilarity(embedding, entry.queryEmbedding);
      if (
        sim >= this.config.similarityThreshold &&
        (!bestMatch || sim > bestMatch.similarity)
      ) {
        bestMatch = { key, similarity: sim, entry };
      }
    }
    this.lastScanMs = Date.now() - tScan;
    this.lastScanEntries = scanned;

    if (bestMatch) {
      this.hits++;
      return { hit: true, entry: bestMatch.entry };
    }
    this.misses++;
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
      // T4: 入库时预归一化，get() 时只需一次归一化 + dot product
      normalizedEmbedding: normalizeVector(embedding),
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
    this.hits = 0;
    this.misses = 0;
    this.lastScanMs = 0;
    this.lastScanEntries = 0;
  }

  /** 获取缓存统计（T1 扩展：hits / misses / lastScanMs / lastScanEntries） */
  getStats(): {
    size: number;
    maxSize: number;
    hits: number;
    misses: number;
    hitRate: number;
    lastScanMs: number;
    lastScanEntries: number;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      lastScanMs: this.lastScanMs,
      lastScanEntries: this.lastScanEntries,
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
