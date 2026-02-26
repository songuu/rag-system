/**
 * Contextual Retrieval 模块
 *
 * 在 Embedding 前，让 LLM 阅读全文并为每个 Chunk 生成一段"背景提要"，
 * 将 "提要 + 原始切片" 拼接后再做 Embedding，显著提升检索相关性。
 *
 * 参考: Anthropic Contextual Retrieval 方案
 *
 * 流程:
 *   Document → Split → [chunks] → Contextualize(LLM) → Embed → Store
 */

import { createLLM } from './model-config';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import crypto from 'crypto';

// ==================== 类型定义 ====================

export interface ContextualRetrievalConfig {
  /** 是否启用 Contextual Retrieval */
  enabled: boolean;
  /** 使用的 LLM 模型名称（留空使用默认 LLM） */
  model?: string;
  /** 全文最大字符数（超出则截断） */
  maxDocLength: number;
  /** 并行 LLM 调用数 */
  batchConcurrency: number;
  /** LLM temperature */
  temperature: number;
  /** 是否启用缓存 */
  cacheEnabled: boolean;
  /** 缓存最大条目数 */
  cacheMaxSize: number;
}

export interface ContextualizeChunksOptions {
  /** 完整文档文本 */
  fullDocument: string;
  /** 待处理的 chunks（包含 text 字段的对象数组） */
  chunks: Array<{ text: string; metadata?: Record<string, any> }>;
  /** 可选的 LLM 实例（不传则自动创建） */
  llm?: BaseChatModel;
  /** 可选的配置覆盖 */
  config?: Partial<ContextualRetrievalConfig>;
  /** 进度回调 */
  onProgress?: (current: number, total: number) => void;
}

export interface ContextualizedChunk {
  /** 上下文前缀（LLM 生成） */
  contextualPreamble: string;
  /** 原始文本 */
  originalText: string;
  /** 最终文本（preamble + original） */
  contextualizedText: string;
}

// ==================== 配置加载 ====================

const DEFAULT_CONFIG: ContextualRetrievalConfig = {
  enabled: false,
  model: undefined,
  maxDocLength: 25000,
  batchConcurrency: 3,
  temperature: 0,
  cacheEnabled: true,
  cacheMaxSize: 500,
};

/**
 * 从环境变量加载 Contextual Retrieval 配置
 */
export function loadContextualRetrievalConfig(): ContextualRetrievalConfig {
  return {
    enabled: process.env.CONTEXTUAL_RETRIEVAL_ENABLED === 'true',
    model: process.env.CONTEXTUAL_RETRIEVAL_MODEL || undefined,
    maxDocLength: parseInt(process.env.CONTEXTUAL_RETRIEVAL_MAX_DOC_LENGTH || '') || DEFAULT_CONFIG.maxDocLength,
    batchConcurrency: parseInt(process.env.CONTEXTUAL_RETRIEVAL_BATCH_CONCURRENCY || '') || DEFAULT_CONFIG.batchConcurrency,
    temperature: parseFloat(process.env.CONTEXTUAL_RETRIEVAL_TEMPERATURE || '') ?? DEFAULT_CONFIG.temperature,
    cacheEnabled: process.env.CONTEXTUAL_RETRIEVAL_CACHE_ENABLED !== 'false',
    cacheMaxSize: parseInt(process.env.CONTEXTUAL_RETRIEVAL_CACHE_MAX_SIZE || '') || DEFAULT_CONFIG.cacheMaxSize,
  };
}

// ==================== LRU 缓存 ====================

class ContextualCache {
  private cache: Map<string, string> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  private makeKey(docPrefix: string, chunkText: string): string {
    const docHash = crypto.createHash('md5').update(docPrefix).digest('hex').slice(0, 12);
    const chunkHash = crypto.createHash('md5').update(chunkText).digest('hex').slice(0, 12);
    return `${docHash}:${chunkHash}`;
  }

  get(docPrefix: string, chunkText: string): string | undefined {
    const key = this.makeKey(docPrefix, chunkText);
    const value = this.cache.get(key);
    if (value !== undefined) {
      // LRU: move to end
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(docPrefix: string, chunkText: string, preamble: string): void {
    const key = this.makeKey(docPrefix, chunkText);
    // 如果已存在，先删除（确保移到末尾）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // 如果超出容量，删除最旧的（Map 迭代顺序为插入顺序）
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, preamble);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// 全局缓存实例
let globalCache: ContextualCache | null = null;

function getCache(maxSize: number): ContextualCache {
  if (!globalCache || globalCache['maxSize'] !== maxSize) {
    globalCache = new ContextualCache(maxSize);
  }
  return globalCache;
}

// ==================== 核心功能 ====================

/**
 * 为单个 Chunk 生成上下文提要
 */
export async function generateContextForChunk(
  fullDoc: string,
  chunkText: string,
  llm: BaseChatModel,
  maxDocLength: number = 25000,
): Promise<string> {
  // 截断文档
  let docText = fullDoc;
  if (docText.length > maxDocLength) {
    console.log(`[ContextualRetrieval] 文档过长 (${docText.length} 字符), 截断至 ${maxDocLength} 字符`);
    docText = docText.slice(0, maxDocLength);
  }

  const prompt = `<document>
${docText}
</document>

Here is the chunk we want to situate within the whole document:

<chunk>
${chunkText}
</chunk>

Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk.
Answer only with the succinct context and nothing else.`;

  const response = await llm.invoke([new HumanMessage(prompt)]);

  // 提取文本内容
  const content = typeof response.content === 'string'
    ? response.content
    : Array.isArray(response.content)
      ? response.content.map((c: any) => (typeof c === 'string' ? c : c.text || '')).join('')
      : String(response.content);

  return content.trim();
}

/**
 * 批量处理 chunks 的 Contextual Retrieval
 *
 * 特性:
 * - 并发控制（默认 3 个并行 LLM 调用）
 * - 内存 LRU 缓存
 * - 单个 chunk 失败降级（使用原始文本）
 */
export async function contextualizeChunks(
  options: ContextualizeChunksOptions
): Promise<ContextualizedChunk[]> {
  const config = {
    ...loadContextualRetrievalConfig(),
    ...options.config,
  };

  const { fullDocument, chunks, onProgress } = options;

  // 如果未启用，返回原始文本
  if (!config.enabled) {
    console.log('[ContextualRetrieval] 未启用，跳过上下文生成');
    return chunks.map(chunk => ({
      contextualPreamble: '',
      originalText: chunk.text,
      contextualizedText: chunk.text,
    }));
  }

  console.log(`[ContextualRetrieval] 开始处理 ${chunks.length} 个 chunks`);
  console.log(`[ContextualRetrieval] 配置: model=${config.model || 'default'}, concurrency=${config.batchConcurrency}, maxDocLength=${config.maxDocLength}`);

  // 创建 LLM 实例
  const llm = options.llm || createLLM(config.model, {
    temperature: config.temperature,
  });

  // 获取缓存
  const cache = config.cacheEnabled ? getCache(config.cacheMaxSize) : null;
  const docPrefix = fullDocument.slice(0, Math.min(fullDocument.length, 2000));

  const results: ContextualizedChunk[] = new Array(chunks.length);
  let completed = 0;

  // 处理单个 chunk 的函数
  async function processChunk(index: number): Promise<void> {
    const chunk = chunks[index];

    // 检查缓存
    if (cache) {
      const cached = cache.get(docPrefix, chunk.text);
      if (cached !== undefined) {
        results[index] = {
          contextualPreamble: cached,
          originalText: chunk.text,
          contextualizedText: cached + '\n\n' + chunk.text,
        };
        completed++;
        onProgress?.(completed, chunks.length);
        return;
      }
    }

    try {
      const preamble = await generateContextForChunk(
        fullDocument,
        chunk.text,
        llm,
        config.maxDocLength,
      );

      // 写入缓存
      if (cache && preamble) {
        cache.set(docPrefix, chunk.text, preamble);
      }

      results[index] = {
        contextualPreamble: preamble,
        originalText: chunk.text,
        contextualizedText: preamble ? preamble + '\n\n' + chunk.text : chunk.text,
      };
    } catch (error) {
      // 降级：使用原始文本
      console.warn(
        `[ContextualRetrieval] chunk ${index} 上下文生成失败, 降级使用原始文本:`,
        error instanceof Error ? error.message : String(error)
      );
      results[index] = {
        contextualPreamble: '',
        originalText: chunk.text,
        contextualizedText: chunk.text,
      };
    }

    completed++;
    onProgress?.(completed, chunks.length);
  }

  // 并发控制：按 batchConcurrency 分批执行
  const concurrency = config.batchConcurrency;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = [];
    for (let j = i; j < Math.min(i + concurrency, chunks.length); j++) {
      batch.push(processChunk(j));
    }
    await Promise.all(batch);
    console.log(`[ContextualRetrieval] 已处理 ${Math.min(i + concurrency, chunks.length)}/${chunks.length} 个 chunks`);
  }

  const cachedCount = results.filter(r => r.contextualPreamble && cache?.get(docPrefix, r.originalText)).length;
  const failedCount = results.filter(r => !r.contextualPreamble).length;
  console.log(`[ContextualRetrieval] 处理完成: ${chunks.length} 个 chunks, ${failedCount} 个降级, 缓存命中约 ${cachedCount} 次`);

  return results;
}
