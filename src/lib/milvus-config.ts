/**
 * Milvus 统一配置系统
 * 
 * 支持两种部署模式：
 * 1. 本地部署 (local) - 自建的 Milvus 服务
 * 2. Zilliz Cloud (zilliz) - 托管的云服务
 * 
 * 通过环境变量控制使用哪种模式
 * 
 * 注意：默认向量维度会自动从 embedding-config.ts 获取
 */

// 延迟导入 embedding-config 以避免循环依赖
let _getEmbeddingDimension: (() => number) | null = null;

function getEmbeddingDimensionLazy(): number {
  if (!_getEmbeddingDimension) {
    try {
      // 动态导入避免循环依赖
      const embeddingConfig = require('./embedding-config');
      _getEmbeddingDimension = embeddingConfig.getEmbeddingDimension;
    } catch (e) {
      console.warn('[MilvusConfig] 无法加载 embedding-config，使用默认维度 768');
      return 768;
    }
  }
  return _getEmbeddingDimension?.() || 768;
}

// ==================== 类型定义 ====================

/**
 * Milvus 提供商类型
 */
export type MilvusProvider = 'local' | 'zilliz';

/**
 * Milvus 连接配置
 */
export interface MilvusConnectionConfig {
  provider: MilvusProvider;
  
  // 通用配置
  address: string;
  username?: string;
  password?: string;
  ssl: boolean;
  database?: string;
  
  // Zilliz Cloud 特有配置
  token?: string;           // Zilliz Cloud API Token
  serverless?: boolean;     // 是否是 Serverless 实例
  
  // 集合默认配置
  defaultCollection: string;
  defaultDimension: number;
  defaultIndexType: 'IVF_FLAT' | 'IVF_SQ8' | 'IVF_PQ' | 'HNSW' | 'ANNOY' | 'FLAT';
  defaultMetricType: 'L2' | 'IP' | 'COSINE';
}

/**
 * 环境变量配置
 */
interface MilvusEnvConfig {
  // 提供商选择
  provider: MilvusProvider;
  
  // 本地 Milvus 配置
  localAddress: string;
  localUsername: string;
  localPassword: string;
  
  // Zilliz Cloud 配置
  zillizEndpoint: string;
  zillizToken: string;
  zillizServerless: boolean;
  
  // 通用默认配置
  defaultDatabase: string;
  defaultCollection: string;
  defaultDimension: number;
  defaultIndexType: string;
  defaultMetricType: string;
}

// ==================== 环境变量解析 ====================

/**
 * 从环境变量加载配置
 */
function loadEnvConfig(): MilvusEnvConfig {
  return {
    // 提供商选择：local | zilliz
    provider: (process.env.MILVUS_PROVIDER as MilvusProvider) || 'local',
    
    // 本地 Milvus 配置
    localAddress: process.env.MILVUS_LOCAL_ADDRESS || 'localhost:19530',
    localUsername: process.env.MILVUS_LOCAL_USERNAME || '',
    localPassword: process.env.MILVUS_LOCAL_PASSWORD || '',
    
    // Zilliz Cloud 配置
    zillizEndpoint: process.env.MILVUS_ZILLIZ_ENDPOINT || '',
    zillizToken: process.env.MILVUS_ZILLIZ_TOKEN || '',
    zillizServerless: process.env.MILVUS_ZILLIZ_SERVERLESS === 'true',
    
    // 通用默认配置
    defaultDatabase: process.env.MILVUS_DEFAULT_DATABASE || 'default',
    defaultCollection: process.env.MILVUS_DEFAULT_COLLECTION || 'rag_documents',
    // 如果没有设置 MILVUS_DEFAULT_DIMENSION，则从 embedding-config 自动获取
    defaultDimension: process.env.MILVUS_DEFAULT_DIMENSION 
      ? parseInt(process.env.MILVUS_DEFAULT_DIMENSION, 10) 
      : getEmbeddingDimensionLazy(),
    defaultIndexType: process.env.MILVUS_DEFAULT_INDEX_TYPE || 'IVF_FLAT',
    defaultMetricType: process.env.MILVUS_DEFAULT_METRIC_TYPE || 'COSINE',
  };
}

// ==================== 配置管理器 ====================

/**
 * Milvus 配置管理器
 * 单例模式，管理全局配置
 */
class MilvusConfigManager {
  private static instance: MilvusConfigManager;
  private envConfig: MilvusEnvConfig;
  private connectionConfig: MilvusConnectionConfig | null = null;

  private constructor() {
    this.envConfig = loadEnvConfig();
  }

  static getInstance(): MilvusConfigManager {
    if (!MilvusConfigManager.instance) {
      MilvusConfigManager.instance = new MilvusConfigManager();
    }
    return MilvusConfigManager.instance;
  }

  /**
   * 重新加载环境变量配置
   */
  reload(): void {
    this.envConfig = loadEnvConfig();
    this.connectionConfig = null;
    console.log('[MilvusConfig] Configuration reloaded');
  }

  /**
   * 获取当前提供商
   */
  getProvider(): MilvusProvider {
    return this.envConfig.provider;
  }

  /**
   * 获取连接配置
   */
  getConnectionConfig(): MilvusConnectionConfig {
    if (this.connectionConfig) {
      return this.connectionConfig;
    }

    const env = this.envConfig;

    if (env.provider === 'zilliz') {
      // Zilliz Cloud 配置
      if (!env.zillizEndpoint) {
        throw new Error('[MilvusConfig] MILVUS_ZILLIZ_ENDPOINT is required for Zilliz Cloud');
      }
      if (!env.zillizToken) {
        throw new Error('[MilvusConfig] MILVUS_ZILLIZ_TOKEN is required for Zilliz Cloud');
      }

      this.connectionConfig = {
        provider: 'zilliz',
        address: env.zillizEndpoint,
        token: env.zillizToken,
        ssl: true, // Zilliz Cloud 必须使用 SSL
        serverless: env.zillizServerless,
        database: env.defaultDatabase,
        defaultCollection: env.defaultCollection,
        defaultDimension: env.defaultDimension,
        defaultIndexType: env.defaultIndexType as any,
        defaultMetricType: env.defaultMetricType as any,
      };

      console.log('[MilvusConfig] Using Zilliz Cloud:', env.zillizEndpoint);
    } else {
      // 本地 Milvus 配置
      this.connectionConfig = {
        provider: 'local',
        address: env.localAddress,
        username: env.localUsername || undefined,
        password: env.localPassword || undefined,
        ssl: false,
        database: env.defaultDatabase,
        defaultCollection: env.defaultCollection,
        defaultDimension: env.defaultDimension,
        defaultIndexType: env.defaultIndexType as any,
        defaultMetricType: env.defaultMetricType as any,
      };

      console.log('[MilvusConfig] Using local Milvus:', env.localAddress);
    }

    return this.connectionConfig;
  }

  /**
   * 检查是否使用 Zilliz Cloud
   */
  isZillizCloud(): boolean {
    return this.envConfig.provider === 'zilliz';
  }

  /**
   * 检查是否使用本地 Milvus
   */
  isLocal(): boolean {
    return this.envConfig.provider === 'local';
  }

  /**
   * 获取环境变量配置摘要（用于调试）
   */
  getConfigSummary(): {
    provider: MilvusProvider;
    endpoint: string;
    hasCredentials: boolean;
    ssl: boolean;
    defaultCollection: string;
    defaultDimension: number;
  } {
    const config = this.getConnectionConfig();
    return {
      provider: config.provider,
      endpoint: config.address,
      hasCredentials: !!(config.token || (config.username && config.password)),
      ssl: config.ssl,
      defaultCollection: config.defaultCollection,
      defaultDimension: config.defaultDimension,
    };
  }
}

// ==================== 导出工具函数 ====================

/**
 * 获取配置管理器实例
 */
export function getMilvusConfigManager(): MilvusConfigManager {
  return MilvusConfigManager.getInstance();
}

/**
 * 获取当前 Milvus 提供商
 */
export function getMilvusProvider(): MilvusProvider {
  return getMilvusConfigManager().getProvider();
}

/**
 * 获取 Milvus 连接配置
 */
export function getMilvusConnectionConfig(): MilvusConnectionConfig {
  return getMilvusConfigManager().getConnectionConfig();
}

/**
 * 检查是否使用 Zilliz Cloud
 */
export function isZillizCloud(): boolean {
  return getMilvusConfigManager().isZillizCloud();
}

/**
 * 检查是否使用本地 Milvus
 */
export function isLocalMilvus(): boolean {
  return getMilvusConfigManager().isLocal();
}

/**
 * 重新加载 Milvus 配置
 */
export function reloadMilvusConfig(): void {
  getMilvusConfigManager().reload();
}

/**
 * 获取配置摘要（用于 API 返回）
 */
export function getMilvusConfigSummary() {
  return getMilvusConfigManager().getConfigSummary();
}

// ==================== 客户端创建辅助 ====================

import { MilvusClient } from '@zilliz/milvus2-sdk-node';

/**
 * 根据配置创建 MilvusClient 实例
 * 这是一个工厂函数，统一处理本地和 Zilliz Cloud 的连接差异
 */
export async function createMilvusClient(): Promise<MilvusClient> {
  const config = getMilvusConnectionConfig();

  console.log(`[MilvusConfig] Creating client for provider: ${config.provider}`);

  let client: MilvusClient;

  if (config.provider === 'zilliz') {
    // Zilliz Cloud 连接
    // Zilliz Cloud 使用 token 认证
    client = new MilvusClient({
      address: config.address,
      token: config.token,
      ssl: true,
      // Zilliz Cloud Serverless 可能需要额外配置
      ...(config.serverless && {
        channelOptions: {
          // Serverless 实例可能需要更长的超时
          'grpc.max_receive_message_length': 64 * 1024 * 1024,
          'grpc.max_send_message_length': 64 * 1024 * 1024,
        }
      }),
    });

    console.log('[MilvusConfig] Connected to Zilliz Cloud');
  } else {
    // 本地 Milvus 连接
    client = new MilvusClient({
      address: config.address,
      username: config.username || undefined,
      password: config.password || undefined,
      ssl: config.ssl,
    });

    console.log('[MilvusConfig] Connected to local Milvus');
  }

  // 验证连接
  try {
    const health = await client.checkHealth();
    if (!health.isHealthy) {
      throw new Error('Milvus service is not healthy');
    }
    console.log('[MilvusConfig] Connection verified successfully');
  } catch (error) {
    throw new Error(`Failed to connect to Milvus (${config.provider}): ${error instanceof Error ? error.message : String(error)}`);
  }

  // 使用指定数据库（如果不是默认）
  if (config.database && config.database !== 'default') {
    try {
      await client.useDatabase({ db_name: config.database });
      console.log(`[MilvusConfig] Using database: ${config.database}`);
    } catch (error) {
      console.warn(`[MilvusConfig] Could not switch to database ${config.database}:`, error);
    }
  }

  return client;
}

/**
 * 获取默认集合配置
 */
export function getDefaultCollectionConfig() {
  const config = getMilvusConnectionConfig();
  return {
    collectionName: config.defaultCollection,
    embeddingDimension: config.defaultDimension,
    indexType: config.defaultIndexType,
    metricType: config.defaultMetricType,
  };
}

// ==================== Reasoning RAG 专用配置 ====================

/**
 * Reasoning RAG 独立配置
 * 支持与主应用分离的集合和维度设置
 */
export interface ReasoningRAGConfig {
  // 集合配置
  collection: string;
  dimension: number;
  
  // 上传目录
  uploadDir: string;
  
  // 向量化配置
  chunkSize: number;
  chunkOverlap: number;
  
  // 检索配置
  topK: number;
  rerankTopK: number;
  similarityThreshold: number;
  enableBM25: boolean;
  enableRerank: boolean;
  
  // 推理配置
  maxIterations: number;
  temperature: number;
}

/**
 * 从环境变量加载 Reasoning RAG 配置
 * 环境变量前缀: REASONING_RAG_
 */
function loadReasoningRAGEnvConfig(): ReasoningRAGConfig {
  // 如果没有设置 REASONING_RAG_DIMENSION，则从 embedding-config 自动获取
  const dimension = process.env.REASONING_RAG_DIMENSION
    ? parseInt(process.env.REASONING_RAG_DIMENSION, 10)
    : getEmbeddingDimensionLazy();
  
  return {
    // 集合配置 - 独立于主应用
    collection: process.env.REASONING_RAG_COLLECTION || 'reasoning_rag_documents',
    dimension,
    
    // 上传目录
    uploadDir: process.env.REASONING_RAG_UPLOAD_DIR || 'reasoning-uploads',
    
    // 向量化配置
    chunkSize: parseInt(process.env.REASONING_RAG_CHUNK_SIZE || '500', 10),
    chunkOverlap: parseInt(process.env.REASONING_RAG_CHUNK_OVERLAP || '50', 10),
    
    // 检索配置
    topK: parseInt(process.env.REASONING_RAG_TOP_K || '50', 10),
    rerankTopK: parseInt(process.env.REASONING_RAG_RERANK_TOP_K || '5', 10),
    similarityThreshold: parseFloat(process.env.REASONING_RAG_SIMILARITY_THRESHOLD || '0.3'),
    enableBM25: process.env.REASONING_RAG_ENABLE_BM25 !== 'false', // 默认启用
    enableRerank: process.env.REASONING_RAG_ENABLE_RERANK !== 'false', // 默认启用
    
    // 推理配置
    maxIterations: parseInt(process.env.REASONING_RAG_MAX_ITERATIONS || '3', 10),
    temperature: parseFloat(process.env.REASONING_RAG_TEMPERATURE || '0.7'),
  };
}

// Reasoning RAG 配置缓存
let _reasoningRAGConfig: ReasoningRAGConfig | null = null;

/**
 * 获取 Reasoning RAG 配置
 */
export function getReasoningRAGConfig(): ReasoningRAGConfig {
  if (!_reasoningRAGConfig) {
    _reasoningRAGConfig = loadReasoningRAGEnvConfig();
    console.log('[MilvusConfig] Reasoning RAG 配置已加载:', {
      collection: _reasoningRAGConfig.collection,
      dimension: _reasoningRAGConfig.dimension,
      uploadDir: _reasoningRAGConfig.uploadDir,
    });
  }
  return _reasoningRAGConfig;
}

/**
 * 重新加载 Reasoning RAG 配置
 */
export function reloadReasoningRAGConfig(): void {
  _reasoningRAGConfig = null;
  console.log('[MilvusConfig] Reasoning RAG 配置已重置');
}

/**
 * 获取 Reasoning RAG 配置摘要（用于 API 返回）
 */
export function getReasoningRAGConfigSummary() {
  const config = getReasoningRAGConfig();
  const milvusConfig = getMilvusConnectionConfig();
  
  return {
    // 集合配置
    collection: config.collection,
    dimension: config.dimension,
    uploadDir: config.uploadDir,
    
    // Milvus 连接信息
    milvusProvider: milvusConfig.provider,
    milvusEndpoint: milvusConfig.address,
    
    // 向量化配置
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    
    // 检索配置
    topK: config.topK,
    rerankTopK: config.rerankTopK,
    similarityThreshold: config.similarityThreshold,
    enableBM25: config.enableBM25,
    enableRerank: config.enableRerank,
    
    // 推理配置
    maxIterations: config.maxIterations,
    temperature: config.temperature,
  };
}