/**
 * 向量化工具模块
 * 提供文档向量化、分块、Embedding 生成等公共功能
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Embeddings } from '@langchain/core/embeddings';
import { v4 as uuidv4 } from 'uuid';
import { MilvusVectorStore, MilvusDocument, getMilvusInstance, MilvusConfig } from './milvus-client';
import { 
  createEmbedding, 
  getModelDimension as getModelDimensionFromConfig,
  getModelFactory,
  selectModelByDimension as selectModelByDimensionFromConfig,
  ModelConfig 
} from './model-config';
import { getEmbeddingConfigSummary, getEmbeddingDimension } from './embedding-config';

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

// 从新配置系统导出维度获取函数
export { getModelDimensionFromConfig as getModelDimension };

// ==================== 类型定义 ====================

export interface DocumentInput {
  content: string;
  filename?: string;
  metadata?: Record<string, any>;
}

export interface ChunkResult {
  text: string;
  metadata: Record<string, any>;
}

export interface VectorizeOptions {
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  batchSize?: number;
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
}

export interface InsertDocumentsOptions {
  embeddingModel?: string;
  generateEmbeddings?: boolean;
}

export interface InsertResult {
  success: boolean;
  insertedCount: number;
  ids: string[];
  embeddingModel: string;
  dimension: number;
  collectionDimension: number;
  error?: string;
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
 */
export async function generateEmbeddings(
  texts: string[],
  embeddingModel?: string
): Promise<number[][]> {
  const embeddings = getEmbeddingModel(embeddingModel);
  return await embeddings.embedDocuments(texts);
}

/**
 * 为单个查询生成向量
 */
export async function generateQueryEmbedding(
  query: string,
  embeddingModel?: string
): Promise<number[]> {
  const embeddings = getEmbeddingModel(embeddingModel);
  return await embeddings.embedQuery(query);
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

  try {
    // 分块
    const chunks = await splitDocuments(documents, { chunkSize, chunkOverlap });

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
      };
    }

    // 初始化集合
    await milvus.initializeCollection();

    // 获取实际维度
    const stats = await milvus.getCollectionStats();
    const collectionDimension = stats?.embeddingDimension || 768;

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
      };
    }

    // 批量处理
    const embeddings = getEmbeddingModel(embeddingModel);
    let totalInserted = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.text);

      try {
        const vectors = await embeddings.embedDocuments(texts);

        const milvusDocs: MilvusDocument[] = batch.map((chunk, idx) => ({
          id: `${Date.now()}_${i + idx}_${uuidv4().slice(0, 8)}`,
          content: chunk.text,
          embedding: vectors[idx],
          metadata: chunk.metadata,
        }));

        await milvus.insertDocuments(milvusDocs);
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
    };
  }
}

/**
 * 插入已有向量的文档
 */
export async function insertDocumentsWithEmbeddings(
  milvus: MilvusVectorStore,
  documents: Array<{ content: string; metadata?: Record<string, any> }>,
  options: InsertDocumentsOptions = {}
): Promise<InsertResult> {
  const { embeddingModel = DEFAULT_EMBEDDING_MODEL } = options;
  const collectionName = milvus.getConfig().collectionName;

  console.log(`[VectorizationUtils] ========== 开始导入 ==========`);
  console.log(`[VectorizationUtils] Documents count: ${documents.length}`);
  console.log(`[VectorizationUtils] Embedding model: ${embeddingModel}`);

  try {
    await milvus.connect();
    await milvus.initializeCollection();

    // 获取集合维度
    const stats = await milvus.getCollectionStats();
    const collectionDimension = stats?.embeddingDimension || 768;
    console.log(`[VectorizationUtils] Collection dimension: ${collectionDimension}D`);

    // 检查模型维度
    const modelDimension = getModelDimensionFromConfig(embeddingModel);
    console.log(`[VectorizationUtils] Model dimension: ${modelDimension}D`);

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
      };
    }

    // 生成向量
    const embeddings = getEmbeddingModel(embeddingModel);
    console.log(`[VectorizationUtils] Generating embeddings for ${documents.length} documents...`);

    const milvusDocs: MilvusDocument[] = await Promise.all(
      documents.map(async (doc) => {
        const embedding = await embeddings.embedQuery(doc.content);
        return {
          id: uuidv4(),
          content: doc.content,
          embedding,
          metadata: doc.metadata || {},
        };
      })
    );

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
      };
    }

    // 插入
    console.log(`[VectorizationUtils] ✅ 维度匹配，开始插入...`);
    const ids = await milvus.insertDocuments(milvusDocs);
    console.log(`[VectorizationUtils] ✅ 成功插入 ${ids.length} 个文档`);

    return {
      success: true,
      insertedCount: ids.length,
      ids,
      embeddingModel,
      dimension: actualDimension,
      collectionDimension,
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
  } = {}
): Promise<{
  success: boolean;
  results: any[];
  query: string;
  embeddingModel: string;
  dimension: number;
  collectionDimension: number;
  error?: string;
}> {
  const { topK = 5, threshold = 0.0, filter, embeddingModel } = options;

  console.log(`[VectorizationUtils] ========== 开始搜索 ==========`);
  console.log(`[VectorizationUtils] Query: "${query.substring(0, 50)}..."`);

  try {
    await milvus.connect();
    await milvus.initializeCollection();

    // 获取集合维度
    const stats = await milvus.getCollectionStats();
    const collectionDimension = stats?.embeddingDimension || 768;
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
    const results = await milvus.search(queryEmbedding, topK, threshold, filter);
    console.log(`[VectorizationUtils] ✅ 找到 ${results.length} 个结果`);

    return {
      success: true,
      results,
      query,
      embeddingModel: actualModel,
      dimension: queryDimension,
      collectionDimension,
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
  search: (query: string, options?: { topK?: number; filter?: string }) => Promise<any>;
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
