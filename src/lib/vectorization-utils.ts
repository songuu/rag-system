/**
 * 向量化工具模块
 * 提供文档向量化、分块、Embedding 生成等公共功能
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Embeddings } from '@langchain/core/embeddings';
import { v4 as uuidv4 } from 'uuid';
import { MilvusVectorStore, MilvusDocument, MilvusSearchResult, getMilvusInstance } from './milvus-client';
import { 
  createEmbedding, 
  getModelDimension as getModelDimensionFromConfig,
  getModelFactory,
  selectModelByDimension as selectModelByDimensionFromConfig,
  ModelConfig 
} from './model-config';
import { getEmbeddingConfigSummary } from './embedding-config';
import { loadContextualRetrievalConfig, contextualizeChunks } from './contextual-retrieval';
import { getEmbeddingCache, normalizeQueryText } from './embedding-cache';
import { applyPostProcess, type PostProcessPipelineOptions } from './rag/retrieval/post-process';

// ==================== 配置常量 ====================

// 使用独立的 Embedding 配置系统
const embeddingConfig = getEmbeddingConfigSummary();

// 保留这些导出以保持向后兼容性
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
// DEFAULT_EMBEDDING_MODEL 现在从 EMBEDDING_PROVIDER 获取
export const DEFAULT_EMBEDDING_MODEL = embeddingConfig.model;
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;
export const DEFAULT_BATCH_SIZE = 10;

const QUERY_EMBEDDING_CACHE_TTL_MS = parsePositiveInteger(
  process.env.MILVUS_QUERY_EMBEDDING_CACHE_TTL_MS,
  10 * 60 * 1000
);
const QUERY_EMBEDDING_CACHE_MAX = parsePositiveInteger(
  process.env.MILVUS_QUERY_EMBEDDING_CACHE_MAX,
  256
);

type QueryEmbeddingCacheEntry = {
  embedding: number[];
  expiresAt: number;
};

const queryEmbeddingCache = new Map<string, QueryEmbeddingCacheEntry>();

// 从新配置系统导出维度获取函数
export { getModelDimensionFromConfig as getModelDimension };

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getQueryEmbeddingCacheKey(query: string, embeddingModel?: string): string {
  return `${embeddingModel || DEFAULT_EMBEDDING_MODEL}\u0000${query}`;
}

function pruneQueryEmbeddingCache(now: number): void {
  for (const [key, entry] of queryEmbeddingCache) {
    if (entry.expiresAt <= now || queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_MAX) {
      queryEmbeddingCache.delete(key);
    }
  }
}

export function clearQueryEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}

export function getQueryEmbeddingCacheSize(): number {
  return queryEmbeddingCache.size;
}

// ==================== 类型定义 ====================

export interface DocumentInput {
  content: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkResult {
  text: string;
  metadata: Record<string, unknown>;
}

export interface VectorizeOptions {
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  batchSize?: number;
}

export interface VectorizeTimings {
  splitMs: number;
  contextualMs: number;
  initMs: number;
  embedMs: number;
  insertMs: number;
  totalMs: number;
}

export interface VectorizeResult {
  success: boolean;
  filesProcessed: number;
  chunksCreated: number;
  chunksInserted: number;
  embeddingModel: string;
  dimension: number;
  collectionName: string;
  error?: string;
  timings?: VectorizeTimings;
}

export interface InsertDocumentsOptions {
  embeddingModel?: string;
  generateEmbeddings?: boolean;
}

export interface InsertTimings {
  initMs: number;
  embedMs: number;
  insertMs: number;
  totalMs: number;
}

export interface InsertResult {
  success: boolean;
  insertedCount: number;
  ids: string[];
  embeddingModel: string;
  dimension: number;
  collectionDimension: number;
  error?: string;
  timings?: InsertTimings;
}

// ==================== Embedding 模型管理 ====================

/**
 * 获取 Embedding 模型实例
 * 使用统一模型配置系统，自动根据 MODEL_PROVIDER 环境变量选择提供商
 */
export function getEmbeddingModel(modelName?: string, options?: Partial<ModelConfig>): Embeddings {
  const actualModelName = modelName || DEFAULT_EMBEDDING_MODEL;
  const factory = getModelFactory();
  const provider = factory.getProvider();
  
  console.log(`[VectorizationUtils] Creating embedding model: ${actualModelName} (provider: ${provider})`);
  
  return createEmbedding(actualModelName, options);
}

/**
 * 根据集合维度选择合适的模型
 * 使用统一模型配置系统，自动根据当前提供商选择合适的模型
 */
export function selectModelForCollection(
  collectionDimension: number, 
  preferredModel?: string
): string {
  if (preferredModel) {
    const modelDim = getModelDimensionFromConfig(preferredModel);
    if (modelDim === collectionDimension) {
      return preferredModel;
    }
    console.warn(`[VectorizationUtils] 首选模型 ${preferredModel} 维度 ${modelDim} 与集合维度 ${collectionDimension} 不匹配`);
  }
  
  // 使用统一配置系统选择模型
  return selectModelByDimensionFromConfig(collectionDimension);
}

// ==================== 文本分块 ====================

/**
 * 创建文本分块器
 */
export function createTextSplitter(
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP
): RecursiveCharacterTextSplitter {
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
}

/**
 * 将文档分块
 */
export async function splitDocuments(
  documents: DocumentInput[],
  options?: { chunkSize?: number; chunkOverlap?: number }
): Promise<ChunkResult[]> {
  const splitter = createTextSplitter(
    options?.chunkSize || DEFAULT_CHUNK_SIZE,
    options?.chunkOverlap || DEFAULT_CHUNK_OVERLAP
  );

  const allChunks: ChunkResult[] = [];

  for (const doc of documents) {
    const chunks = await splitter.splitText(doc.content);
    chunks.forEach((chunk, idx) => {
      allChunks.push({
        text: chunk,
        metadata: {
          source: doc.filename || 'unknown',
          chunkIndex: idx,
          totalChunks: chunks.length,
          ...doc.metadata,
        },
      });
    });
  }

  console.log(`[VectorizationUtils] 共生成 ${allChunks.length} 个文本块 (来自 ${documents.length} 个文档)`);
  return allChunks;
}

// ==================== 向量化操作 ====================

/**
 * 为文本块生成向量
 * T3: 经过 doc-embedding cache，命中部分跳过 provider 调用
 */
export async function generateEmbeddings(
  texts: string[],
  embeddingModel?: string
): Promise<number[][]> {
  const model = embeddingModel || DEFAULT_EMBEDDING_MODEL;
  const cache = getEmbeddingCache();
  const { cached, missIndices } = cache.getMany('doc', model, texts);

  if (missIndices.length === 0) {
    return cached as number[][];
  }

  const missTexts = missIndices.map(i => texts[i]);
  const embeddings = getEmbeddingModel(embeddingModel);
  const missVectors = await embeddings.embedDocuments(missTexts);
  cache.setMany('doc', model, missTexts, missVectors);

  for (let i = 0; i < missIndices.length; i++) {
    cached[missIndices[i]] = missVectors[i];
  }
  return cached as number[][];
}

/**
 * 为单个查询生成向量
 * T3: query 前置 normalize；仍保留原 queryEmbeddingCache 作快路径，二级走 EmbeddingCache namespace
 */
export async function generateQueryEmbedding(
  query: string,
  embeddingModel?: string
): Promise<number[]> {
  const normalizedQuery = normalizeQueryText(query);
  const cacheKey = getQueryEmbeddingCacheKey(normalizedQuery, embeddingModel);
  const now = Date.now();

  if (QUERY_EMBEDDING_CACHE_TTL_MS > 0 && QUERY_EMBEDDING_CACHE_MAX > 0) {
    const cached = queryEmbeddingCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.embedding.slice();
    }
  }

  const embeddings = getEmbeddingModel(embeddingModel);
  const embedding = await embeddings.embedQuery(normalizedQuery);

  if (QUERY_EMBEDDING_CACHE_TTL_MS > 0 && QUERY_EMBEDDING_CACHE_MAX > 0) {
    queryEmbeddingCache.set(cacheKey, {
      embedding: embedding.slice(),
      expiresAt: now + QUERY_EMBEDDING_CACHE_TTL_MS,
    });
    pruneQueryEmbeddingCache(now);
  }

  return embedding;
}

/**
 * 批量向量化文档并插入 Milvus
 */
export async function vectorizeAndInsert(
  milvus: MilvusVectorStore,
  documents: DocumentInput[],
  options: VectorizeOptions = {}
): Promise<VectorizeResult> {
  const {
    embeddingModel = DEFAULT_EMBEDDING_MODEL,
    chunkSize = DEFAULT_CHUNK_SIZE,
    chunkOverlap = DEFAULT_CHUNK_OVERLAP,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  const collectionName = milvus.getConfig().collectionName;
  console.log(`[VectorizationUtils] 开始向量化, 模型: ${embeddingModel}, 集合: ${collectionName}`);

  const tStart = Date.now();
  let splitMs = 0;
  let contextualMs = 0;
  let initMs = 0;
  let embedMs = 0;
  let insertMs = 0;

  try {
    // 分块
    const tSplit = Date.now();
    const chunks = await splitDocuments(documents, { chunkSize, chunkOverlap });
    splitMs = Date.now() - tSplit;

    if (chunks.length === 0) {
      return {
        success: false,
        filesProcessed: documents.length,
        chunksCreated: 0,
        chunksInserted: 0,
        embeddingModel,
        dimension: 0,
        collectionName,
        error: '没有生成任何文本块',
        timings: { splitMs, contextualMs, initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
      };
    }

    // Contextual Retrieval: 为每个 chunk 生成上下文提要
    const tContextual = Date.now();
    const crConfig = loadContextualRetrievalConfig();
    if (crConfig.enabled && chunks.length > 0) {
      console.log(`[VectorizationUtils] Contextual Retrieval 已启用, 开始生成上下文提要...`);

      // 按 source 文档分组
      const chunksBySource = new Map<string, { indices: number[]; chunks: typeof chunks }>();
      for (let i = 0; i < chunks.length; i++) {
        const rawSource = chunks[i].metadata.source;
        const source = typeof rawSource === 'string' ? rawSource : 'unknown';
        if (!chunksBySource.has(source)) {
          chunksBySource.set(source, { indices: [], chunks: [] });
        }
        chunksBySource.get(source)!.indices.push(i);
        chunksBySource.get(source)!.chunks.push(chunks[i]);
      }

      // 对每组 chunks 调用 contextualizeChunks
      for (const [source, group] of chunksBySource) {
        // 从 documents 找到对应的全文
        const doc = documents.find(d => (d.filename || 'unknown') === source);
        const fullDocument = doc?.content || group.chunks.map(c => c.text).join('\n');

        const crResults = await contextualizeChunks({
          fullDocument,
          chunks: group.chunks.map(c => ({ text: c.text })),
          config: { enabled: true },
        });

        // 替换 chunk.text 为 contextualized 版本
        for (let j = 0; j < group.indices.length; j++) {
          const idx = group.indices[j];
          const cr = crResults[j];
          chunks[idx].metadata.originalContent = cr.originalText;
          chunks[idx].metadata.contextualPreamble = cr.contextualPreamble;
          chunks[idx].text = cr.contextualizedText;
        }
      }

      console.log(`[VectorizationUtils] Contextual Retrieval 处理完成`);
    }
    contextualMs = Date.now() - tContextual;

    // 初始化集合
    const tInit = Date.now();
    await milvus.initializeCollection();

    // 获取实际维度
    const stats = await milvus.getCollectionStats();
    const collectionDimension = stats?.embeddingDimension || 768;
    initMs = Date.now() - tInit;

    // 检查模型维度是否匹配
    const modelDimension = getModelDimensionFromConfig(embeddingModel);
    if (modelDimension !== collectionDimension) {
      return {
        success: false,
        filesProcessed: documents.length,
        chunksCreated: chunks.length,
        chunksInserted: 0,
        embeddingModel,
        dimension: modelDimension,
        collectionName,
        error: `向量维度不匹配！模型: ${modelDimension}D, 集合: ${collectionDimension}D`,
        timings: { splitMs, contextualMs, initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
      };
    }

    // 批量处理
    const embeddings = getEmbeddingModel(embeddingModel);
    let totalInserted = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.text);

      try {
        const tEmbed = Date.now();
        const vectors = await embeddings.embedDocuments(texts);
        embedMs += Date.now() - tEmbed;

        const milvusDocs: MilvusDocument[] = batch.map((chunk, idx) => ({
          id: `${Date.now()}_${i + idx}_${uuidv4().slice(0, 8)}`,
          content: chunk.text,
          embedding: vectors[idx],
          metadata: chunk.metadata,
        }));

        const tInsert = Date.now();
        await milvus.insertDocuments(milvusDocs);
        insertMs += Date.now() - tInsert;
        totalInserted += batch.length;

        console.log(`[VectorizationUtils] 已处理 ${totalInserted}/${chunks.length} 个文本块`);
      } catch (e) {
        console.error(`[VectorizationUtils] 批次处理失败 (${i}-${i + batch.length}):`, e);
      }
    }

    console.log(`[VectorizationUtils] ✅ 向量化完成: ${totalInserted}/${chunks.length} 个文本块已入库`);

    return {
      success: true,
      filesProcessed: documents.length,
      chunksCreated: chunks.length,
      chunksInserted: totalInserted,
      embeddingModel,
      dimension: modelDimension,
      collectionName,
      timings: { splitMs, contextualMs, initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
    };
  } catch (error) {
    console.error('[VectorizationUtils] 向量化失败:', error);
    return {
      success: false,
      filesProcessed: documents.length,
      chunksCreated: 0,
      chunksInserted: 0,
      embeddingModel,
      dimension: 0,
      collectionName,
      error: error instanceof Error ? error.message : '未知错误',
      timings: { splitMs, contextualMs, initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
    };
  }
}

/**
 * 插入已有向量的文档
 */
export async function insertDocumentsWithEmbeddings(
  milvus: MilvusVectorStore,
  documents: Array<{ content: string; metadata?: Record<string, unknown> }>,
  options: InsertDocumentsOptions = {}
): Promise<InsertResult> {
  const { embeddingModel = DEFAULT_EMBEDDING_MODEL } = options;

  console.log(`[VectorizationUtils] ========== 开始导入 ==========`);
  console.log(`[VectorizationUtils] Documents count: ${documents.length}`);
  console.log(`[VectorizationUtils] Embedding model: ${embeddingModel}`);

  const tStart = Date.now();
  let initMs = 0;
  let embedMs = 0;
  let insertMs = 0;

  try {
    const tInit = Date.now();
    await milvus.connect();
    await milvus.initializeCollection();

    // initializeCollection 已完成 schema 兼容检查，搜索热路径直接使用配置维度，避免每次查询 describe/stat/load。
    const collectionDimension = milvus.getConfig().embeddingDimension;
    console.log(`[VectorizationUtils] Collection dimension: ${collectionDimension}D`);

    // 检查模型维度
    const modelDimension = getModelDimensionFromConfig(embeddingModel);
    console.log(`[VectorizationUtils] Model dimension: ${modelDimension}D`);
    initMs = Date.now() - tInit;

    if (modelDimension !== collectionDimension) {
      console.error(`[VectorizationUtils] ❌ 维度不匹配! Model: ${modelDimension}D, Collection: ${collectionDimension}D`);
      return {
        success: false,
        insertedCount: 0,
        ids: [],
        embeddingModel,
        dimension: modelDimension,
        collectionDimension,
        error: `向量维度不匹配！模型: ${modelDimension}维, 集合: ${collectionDimension}维`,
        timings: { initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
      };
    }

    // 生成向量 (T2 修复: 改用 embedDocuments 批量调用，原 Promise.all(embedQuery) 是 N 次 HTTP)
    const embeddings = getEmbeddingModel(embeddingModel);
    console.log(`[VectorizationUtils] Generating embeddings for ${documents.length} documents...`);

    const tEmbed = Date.now();
    const texts = documents.map(doc => doc.content);
    const vectors = await embeddings.embedDocuments(texts);
    embedMs = Date.now() - tEmbed;

    if (vectors.length !== documents.length) {
      return {
        success: false,
        insertedCount: 0,
        ids: [],
        embeddingModel,
        dimension: 0,
        collectionDimension,
        error: `embedDocuments 返回数量不匹配: 期望 ${documents.length}, 实际 ${vectors.length}`,
        timings: { initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
      };
    }

    const milvusDocs: MilvusDocument[] = documents.map((doc, idx) => ({
      id: uuidv4(),
      content: doc.content,
      embedding: vectors[idx],
      metadata: doc.metadata || {},
    }));

    // 验证维度
    const actualDimension = milvusDocs[0]?.embedding?.length || 0;
    console.log(`[VectorizationUtils] Generated embedding dimension: ${actualDimension}D`);

    if (actualDimension !== collectionDimension) {
      return {
        success: false,
        insertedCount: 0,
        ids: [],
        embeddingModel,
        dimension: actualDimension,
        collectionDimension,
        error: `生成的向量维度不匹配！生成: ${actualDimension}维, 集合: ${collectionDimension}维`,
        timings: { initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
      };
    }

    // 插入
    console.log(`[VectorizationUtils] ✅ 维度匹配，开始插入...`);
    const tInsert = Date.now();
    const ids = await milvus.insertDocuments(milvusDocs);
    insertMs = Date.now() - tInsert;
    console.log(`[VectorizationUtils] ✅ 成功插入 ${ids.length} 个文档`);

    return {
      success: true,
      insertedCount: ids.length,
      ids,
      embeddingModel,
      dimension: actualDimension,
      collectionDimension,
      timings: { initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
    };
  } catch (error) {
    console.error('[VectorizationUtils] 插入失败:', error);
    return {
      success: false,
      insertedCount: 0,
      ids: [],
      embeddingModel,
      dimension: 0,
      collectionDimension: 0,
      error: error instanceof Error ? error.message : '未知错误',
      timings: { initMs, embedMs, insertMs, totalMs: Date.now() - tStart },
    };
  }
}

/**
 * 执行向量搜索
 */
export async function vectorSearch(
  milvus: MilvusVectorStore,
  query: string,
  options: {
    topK?: number;
    threshold?: number;
    filter?: string;
    embeddingModel?: string;
    /** T5: 后处理（MMR / source dedupe）。默认 undefined = 不动行为 */
    postProcess?: PostProcessPipelineOptions;
  } = {}
): Promise<{
  success: boolean;
  results: MilvusSearchResult[];
  query: string;
  embeddingModel: string;
  dimension: number;
  collectionDimension: number;
  error?: string;
  postProcessed?: boolean;
}> {
  const { topK = 5, threshold = 0.0, filter, embeddingModel, postProcess } = options;

  console.log(`[VectorizationUtils] ========== 开始搜索 ==========`);
  console.log(`[VectorizationUtils] Query: "${query.substring(0, 50)}..."`);

  try {
    await milvus.connect();
    await milvus.initializeCollection();

    // initializeCollection 已完成 schema 兼容检查，搜索热路径直接使用配置维度，避免每次查询 describe/stat/load。
    const collectionDimension = milvus.getConfig().embeddingDimension;
    console.log(`[VectorizationUtils] Collection dimension: ${collectionDimension}D`);

    // 自动选择匹配的模型
    const actualModel = selectModelForCollection(collectionDimension, embeddingModel);
    console.log(`[VectorizationUtils] Using model: ${actualModel}`);

    // 生成查询向量
    const queryEmbedding = await generateQueryEmbedding(query, actualModel);
    const queryDimension = queryEmbedding.length;
    console.log(`[VectorizationUtils] Query embedding dimension: ${queryDimension}D`);

    if (queryDimension !== collectionDimension) {
      return {
        success: false,
        results: [],
        query,
        embeddingModel: actualModel,
        dimension: queryDimension,
        collectionDimension,
        error: `向量维度不匹配！查询: ${queryDimension}D, 集合: ${collectionDimension}D`,
      };
    }

    // 搜索
    console.log(`[VectorizationUtils] ✅ 维度匹配，开始搜索...`);
    let results = await milvus.search(queryEmbedding, topK, threshold, filter);
    console.log(`[VectorizationUtils] ✅ 找到 ${results.length} 个结果`);

    // T5: 可选后处理（MMR / source dedupe）；默认 off，行为不变
    let postProcessed = false;
    if (postProcess) {
      const mappedInput = results.map(r => ({
        id: r.id,
        content: r.content,
        score: r.score,
        distance: r.distance,
        source: typeof r.metadata?.source === 'string' ? (r.metadata.source as string) : undefined,
        metadata: r.metadata,
      }));
      const mmrOptions = postProcess.mmr
        ? { ...postProcess.mmr, queryEmbedding: postProcess.mmr.queryEmbedding ?? queryEmbedding }
        : undefined;
      const processed = applyPostProcess(mappedInput, {
        ...postProcess,
        ...(mmrOptions ? { mmr: mmrOptions } : {}),
      });
      // 回填到 MilvusSearchResult 形状（沿用 id 顺序映射）
      const byId = new Map(results.map(r => [r.id, r]));
      results = processed
        .map(p => byId.get(p.id))
        .filter((r): r is typeof results[number] => Boolean(r));
      postProcessed = true;
    }

    return {
      success: true,
      results,
      query,
      embeddingModel: actualModel,
      dimension: queryDimension,
      collectionDimension,
      postProcessed,
    };
  } catch (error) {
    console.error('[VectorizationUtils] 搜索失败:', error);
    return {
      success: false,
      results: [],
      query,
      embeddingModel: embeddingModel || DEFAULT_EMBEDDING_MODEL,
      dimension: 0,
      collectionDimension: 0,
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}

// ==================== 便捷工厂函数 ====================

/**
 * 创建带有独立集合的向量化管理器
 */
export function createVectorizeManager(config: {
  collectionName: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}): {
  milvus: MilvusVectorStore;
  vectorize: (documents: DocumentInput[], options?: VectorizeOptions) => Promise<VectorizeResult>;
  search: (query: string, options?: { topK?: number; filter?: string }) => Promise<Awaited<ReturnType<typeof vectorSearch>>>;
  clear: () => Promise<void>;
} {
  const dimension = config.embeddingDimension || getModelDimensionFromConfig(config.embeddingModel || DEFAULT_EMBEDDING_MODEL);
  
  const milvus = getMilvusInstance({
    collectionName: config.collectionName,
    embeddingDimension: dimension,
  });

  return {
    milvus,
    vectorize: (documents, options) => vectorizeAndInsert(milvus, documents, {
      embeddingModel: config.embeddingModel,
      ...options,
    }),
    search: (query, options) => vectorSearch(milvus, query, {
      embeddingModel: config.embeddingModel,
      ...options,
    }),
    clear: () => milvus.clearCollection(),
  };
}
