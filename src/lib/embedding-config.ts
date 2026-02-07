/**
 * Embedding 模型独立配置系统
 * 
 * 架构设计：将 Embedding 与 LLM 完全解耦
 * 
 * 支持的提供商：
 * 1. ollama - 本地 Ollama 模型
 * 2. siliconflow - 硅基流动云服务 (https://cloud.siliconflow.cn)
 * 3. openai - OpenAI API
 * 4. custom - 自定义 OpenAI 兼容 API
 * 
 * 使用方式：
 * - 通过 EMBEDDING_PROVIDER 环境变量独立控制 Embedding 提供商
 * - 与 MODEL_PROVIDER (LLM) 完全独立
 * - 例如：LLM 用 ollama，Embedding 用 siliconflow
 */

import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';

// ==================== SiliconFlow 自定义 Embedding 类 ====================

/**
 * SiliconFlow Embedding 实现
 * 直接调用 SiliconFlow API，避免 LangChain OpenAIEmbeddings 的兼容性问题
 */
class SiliconFlowEmbeddings extends Embeddings {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private batchSize: number;
  private dimensions?: number;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    batchSize?: number;
    dimensions?: number;
  }) {
    super({});
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.siliconflow.cn/v1';
    this.model = config.model || 'BAAI/bge-m3';
    this.batchSize = config.batchSize || 32;
    this.dimensions = config.dimensions;
  }

  /**
   * 嵌入文档列表
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    
    // 分批处理
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await this.callApi(batch);
      results.push(...batchResults);
    }
    
    return results;
  }

  /**
   * 嵌入单个查询
   */
  async embedQuery(text: string): Promise<number[]> {
    const results = await this.callApi([text]);
    return results[0];
  }

  /**
   * 调用 SiliconFlow API
   */
  private async callApi(inputs: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    
    // 构建请求体 - 仅包含 SiliconFlow 支持的参数
    const body: any = {
      model: this.model,
      input: inputs,
      encoding_format: 'float',
    };
    
    // 仅 Qwen3 系列支持 dimensions 参数
    if (this.dimensions && this.model.includes('Qwen3-Embedding')) {
      body.dimensions = this.dimensions;
    }

    console.log(`[SiliconFlow] 请求 ${inputs.length} 个文本, 模型: ${this.model}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SiliconFlow] API 错误: ${response.status}`, errorText);
      throw new Error(`SiliconFlow API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    // 提取 embedding 向量
    const embeddings = data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((item: any) => item.embedding);
    
    console.log(`[SiliconFlow] 成功获取 ${embeddings.length} 个向量, 维度: ${embeddings[0]?.length}`);
    
    return embeddings;
  }
}

// ==================== 类型定义 ====================

/** Embedding 提供商类型 */
export type EmbeddingProvider = 'ollama' | 'siliconflow' | 'openai' | 'custom';

/** Embedding 模型配置 */
export interface EmbeddingModelConfig {
  provider: EmbeddingProvider;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  dimension: number;
  maxTokens?: number;
  batchSize?: number;
  options?: Record<string, any>;
}

/** Embedding 环境配置 */
export interface EmbeddingEnvConfig {
  // 主开关：控制使用哪个 Embedding 提供商
  EMBEDDING_PROVIDER: EmbeddingProvider;
  
  // Ollama Embedding 配置
  OLLAMA_BASE_URL: string;
  OLLAMA_EMBEDDING_MODEL: string;
  
  // SiliconFlow Embedding 配置
  SILICONFLOW_API_KEY?: string;
  SILICONFLOW_BASE_URL: string;
  SILICONFLOW_EMBEDDING_MODEL: string;
  
  // OpenAI Embedding 配置
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_EMBEDDING_MODEL: string;
  
  // 自定义 API 配置
  CUSTOM_EMBEDDING_API_KEY?: string;
  CUSTOM_EMBEDDING_BASE_URL?: string;
  CUSTOM_EMBEDDING_MODEL?: string;
  CUSTOM_EMBEDDING_DIMENSION?: number;  // 自定义模型的维度（仅 custom 提供商使用）
}

// ==================== 常量定义 ====================

/**
 * SiliconFlow 支持的 Embedding 模型
 * 参考: https://docs.siliconflow.cn/cn/api-reference/embeddings/create-embeddings
 */
export const SILICONFLOW_MODELS = {
  // BGE 系列
  'BAAI/bge-large-zh-v1.5': { dimension: 1024, maxTokens: 512 },
  'BAAI/bge-large-en-v1.5': { dimension: 1024, maxTokens: 512 },
  'BAAI/bge-m3': { dimension: 1024, maxTokens: 8192 },
  'Pro/BAAI/bge-m3': { dimension: 1024, maxTokens: 8192 },
  
  // Qwen3 Embedding 系列 (支持可变维度)
  'Qwen/Qwen3-Embedding-8B': { dimension: 4096, maxTokens: 32768, supportsDimension: true },
  'Qwen/Qwen3-Embedding-4B': { dimension: 2560, maxTokens: 32768, supportsDimension: true },
  'Qwen/Qwen3-Embedding-0.6B': { dimension: 1024, maxTokens: 32768, supportsDimension: true },
  
  // 网易有道
  'netease-youdao/bce-embedding-base_v1': { dimension: 768, maxTokens: 512 },
} as const;

/** Ollama Embedding 模型维度映射 */
export const OLLAMA_EMBEDDING_MODELS = {
  'nomic-embed-text': { dimension: 768 },
  'nomic-embed-text-v2-moe': { dimension: 768 },
  'bge-m3': { dimension: 1024 },
  'bge-large': { dimension: 1024 },
  'all-minilm': { dimension: 384 },
  'mxbai-embed-large': { dimension: 1024 },
  'snowflake-arctic-embed': { dimension: 1024 },
  'qwen3-embedding': { dimension: 1024 },
} as const;

/** OpenAI Embedding 模型维度映射 */
export const OPENAI_EMBEDDING_MODELS = {
  'text-embedding-3-small': { dimension: 1536 },
  'text-embedding-3-large': { dimension: 3072 },
  'text-embedding-ada-002': { dimension: 1536 },
} as const;

/** 所有模型维度映射 (合并) */
export const ALL_EMBEDDING_DIMENSIONS: Record<string, number> = {
  // Ollama
  ...Object.fromEntries(Object.entries(OLLAMA_EMBEDDING_MODELS).map(([k, v]) => [k, v.dimension])),
  // SiliconFlow
  ...Object.fromEntries(Object.entries(SILICONFLOW_MODELS).map(([k, v]) => [k, v.dimension])),
  // OpenAI
  ...Object.fromEntries(Object.entries(OPENAI_EMBEDDING_MODELS).map(([k, v]) => [k, v.dimension])),
};

/** 默认配置 */
const DEFAULT_CONFIG = {
  ollama: {
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434',
  },
  siliconflow: {
    model: 'BAAI/bge-m3',
    baseUrl: 'https://api.siliconflow.cn/v1',
  },
  openai: {
    model: 'text-embedding-3-small',
  },
};

// ==================== 环境变量加载 ====================

/**
 * 从环境变量加载 Embedding 配置
 */
export function loadEmbeddingEnvConfig(): EmbeddingEnvConfig {
  return {
    // 主开关 - 默认使用 ollama，如果设置了 SILICONFLOW_API_KEY 则自动切换
    EMBEDDING_PROVIDER: (process.env.EMBEDDING_PROVIDER as EmbeddingProvider) || 
                        (process.env.SILICONFLOW_API_KEY ? 'siliconflow' : 'ollama'),
    
    // Ollama
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || DEFAULT_CONFIG.ollama.baseUrl,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL || DEFAULT_CONFIG.ollama.model,
    
    // SiliconFlow
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    SILICONFLOW_BASE_URL: process.env.SILICONFLOW_BASE_URL || DEFAULT_CONFIG.siliconflow.baseUrl,
    SILICONFLOW_EMBEDDING_MODEL: process.env.SILICONFLOW_EMBEDDING_MODEL || DEFAULT_CONFIG.siliconflow.model,
    
    // OpenAI
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_CONFIG.openai.model,
    
    // Custom
    CUSTOM_EMBEDDING_API_KEY: process.env.CUSTOM_EMBEDDING_API_KEY,
    CUSTOM_EMBEDDING_BASE_URL: process.env.CUSTOM_EMBEDDING_BASE_URL,
    CUSTOM_EMBEDDING_MODEL: process.env.CUSTOM_EMBEDDING_MODEL,
    CUSTOM_EMBEDDING_DIMENSION: process.env.CUSTOM_EMBEDDING_DIMENSION 
      ? parseInt(process.env.CUSTOM_EMBEDDING_DIMENSION, 10) 
      : undefined,
  };
}

// ==================== Embedding 工厂类 ====================

/**
 * Embedding 工厂类 - 统一创建和管理 Embedding 模型实例
 */
export class EmbeddingFactory {
  private static instance: EmbeddingFactory;
  private envConfig: EmbeddingEnvConfig;
  private cache: Map<string, Embeddings> = new Map();
  
  private constructor() {
    this.envConfig = loadEmbeddingEnvConfig();
    console.log(`[EmbeddingFactory] 初始化完成, 当前提供商: ${this.envConfig.EMBEDDING_PROVIDER}`);
  }
  
  static getInstance(): EmbeddingFactory {
    if (!EmbeddingFactory.instance) {
      EmbeddingFactory.instance = new EmbeddingFactory();
    }
    return EmbeddingFactory.instance;
  }
  
  /**
   * 重新加载配置
   */
  reloadConfig(): void {
    this.envConfig = loadEmbeddingEnvConfig();
    this.clearCache();
    console.log(`[EmbeddingFactory] 配置已重新加载, 当前提供商: ${this.envConfig.EMBEDDING_PROVIDER}`);
  }
  
  /**
   * 获取当前 Embedding 提供商
   */
  getProvider(): EmbeddingProvider {
    return this.envConfig.EMBEDDING_PROVIDER;
  }
  
  /**
   * 获取当前环境配置
   */
  getEnvConfig(): EmbeddingEnvConfig {
    return { ...this.envConfig };
  }
  
  /**
   * 创建 Embedding 实例
   * @param modelName 可选的模型名称
   * @param options 额外配置
   */
  createEmbedding(modelName?: string, options: Partial<EmbeddingModelConfig> = {}): Embeddings {
    const provider = options.provider || this.envConfig.EMBEDDING_PROVIDER;
    const cacheKey = `${provider}:${modelName || 'default'}:${JSON.stringify(options)}`;
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    
    let embedding: Embeddings;
    
    switch (provider) {
      case 'ollama':
        embedding = this.createOllamaEmbedding(modelName, options);
        break;
      case 'siliconflow':
        embedding = this.createSiliconFlowEmbedding(modelName, options);
        break;
      case 'openai':
        embedding = this.createOpenAIEmbedding(modelName, options);
        break;
      case 'custom':
        embedding = this.createCustomEmbedding(modelName, options);
        break;
      default:
        throw new Error(`不支持的 Embedding 提供商: ${provider}`);
    }
    
    this.cache.set(cacheKey, embedding);
    return embedding;
  }
  
  /**
   * 创建 Ollama Embedding
   */
  private createOllamaEmbedding(modelName?: string, options: Partial<EmbeddingModelConfig> = {}): OllamaEmbeddings {
    const actualModel = modelName || this.envConfig.OLLAMA_EMBEDDING_MODEL;
    console.log(`[EmbeddingFactory] 创建 Ollama Embedding: ${actualModel}`);
    
    return new OllamaEmbeddings({
      baseUrl: options.baseUrl || this.envConfig.OLLAMA_BASE_URL,
      model: actualModel,
      ...options.options,
    });
  }
  
  /**
   * 创建 SiliconFlow Embedding
   * 使用自定义的 SiliconFlowEmbeddings 类，避免 LangChain 兼容性问题
   * 
   * SiliconFlow API 仅支持以下参数：
   * - model (必填)
   * - input (必填)
   * - encoding_format (可选: float | base64)
   * - dimensions (可选, 仅 Qwen3 系列支持)
   */
  private createSiliconFlowEmbedding(modelName?: string, options: Partial<EmbeddingModelConfig> = {}): Embeddings {
    const actualModel = modelName || this.envConfig.SILICONFLOW_EMBEDDING_MODEL;
    const apiKey = options.apiKey || this.envConfig.SILICONFLOW_API_KEY;
    const baseUrl = options.baseUrl || this.envConfig.SILICONFLOW_BASE_URL;
    
    if (!apiKey) {
      throw new Error(
        'SiliconFlow API Key 未配置。\n' +
        '请设置 SILICONFLOW_API_KEY 环境变量。\n' +
        '获取 API Key: https://cloud.siliconflow.cn/account/ak'
      );
    }
    
    console.log(`[EmbeddingFactory] 创建 SiliconFlow Embedding: ${actualModel}`);
    console.log(`[EmbeddingFactory] Base URL: ${baseUrl}`);
    
    // 使用自定义的 SiliconFlowEmbeddings 类
    return new SiliconFlowEmbeddings({
      apiKey,
      baseUrl,
      model: actualModel,
      batchSize: Math.min(options.batchSize || 32, 32),
      dimensions: options.dimension,
    });
  }
  
  /**
   * 创建 OpenAI Embedding
   */
  private createOpenAIEmbedding(modelName?: string, options: Partial<EmbeddingModelConfig> = {}): OpenAIEmbeddings {
    const actualModel = modelName || this.envConfig.OPENAI_EMBEDDING_MODEL;
    const apiKey = options.apiKey || this.envConfig.OPENAI_API_KEY;
    const baseUrl = options.baseUrl || this.envConfig.OPENAI_BASE_URL;
    
    if (!apiKey) {
      throw new Error(
        'OpenAI API Key 未配置。\n' +
        '请设置 OPENAI_API_KEY 环境变量。'
      );
    }
    
    console.log(`[EmbeddingFactory] 创建 OpenAI Embedding: ${actualModel}`);
    
    return new OpenAIEmbeddings({
      openAIApiKey: apiKey,
      modelName: actualModel,
      configuration: baseUrl ? { baseURL: baseUrl } : undefined,
      ...options.options,
    });
  }
  
  /**
   * 创建自定义 Embedding (OpenAI 兼容 API)
   */
  private createCustomEmbedding(modelName?: string, options: Partial<EmbeddingModelConfig> = {}): OpenAIEmbeddings {
    const actualModel = modelName || this.envConfig.CUSTOM_EMBEDDING_MODEL || 'default';
    const apiKey = options.apiKey || this.envConfig.CUSTOM_EMBEDDING_API_KEY;
    const baseUrl = options.baseUrl || this.envConfig.CUSTOM_EMBEDDING_BASE_URL;
    
    if (!apiKey || !baseUrl) {
      throw new Error(
        '自定义 Embedding API 配置不完整。\n' +
        '请设置 CUSTOM_EMBEDDING_API_KEY 和 CUSTOM_EMBEDDING_BASE_URL 环境变量。'
      );
    }
    
    console.log(`[EmbeddingFactory] 创建自定义 Embedding: ${actualModel} @ ${baseUrl}`);
    
    return new OpenAIEmbeddings({
      openAIApiKey: apiKey,
      modelName: actualModel,
      configuration: {
        baseURL: baseUrl,
      },
      ...options.options,
    });
  }
  
  // ==================== 辅助方法 ====================
  
  /**
   * 获取当前模型的维度
   * - ollama/siliconflow/openai: 从预定义映射表获取
   * - custom: 优先使用 CUSTOM_EMBEDDING_DIMENSION 环境变量
   */
  getModelDimension(modelName?: string): number {
    const provider = this.envConfig.EMBEDDING_PROVIDER;
    let actualModel: string;
    
    if (modelName) {
      actualModel = modelName;
    } else {
      switch (provider) {
        case 'ollama':
          actualModel = this.envConfig.OLLAMA_EMBEDDING_MODEL;
          break;
        case 'siliconflow':
          actualModel = this.envConfig.SILICONFLOW_EMBEDDING_MODEL;
          break;
        case 'openai':
          actualModel = this.envConfig.OPENAI_EMBEDDING_MODEL;
          break;
        case 'custom':
          // 自定义提供商：优先使用环境变量配置的维度
          if (this.envConfig.CUSTOM_EMBEDDING_DIMENSION) {
            return this.envConfig.CUSTOM_EMBEDDING_DIMENSION;
          }
          actualModel = this.envConfig.CUSTOM_EMBEDDING_MODEL || 'default';
          break;
        default:
          actualModel = 'nomic-embed-text';
      }
    }
    
    // 查找维度
    return ALL_EMBEDDING_DIMENSIONS[actualModel] || 768;
  }
  
  /**
   * 根据维度选择合适的模型
   */
  selectModelByDimension(targetDimension: number): string {
    const provider = this.envConfig.EMBEDDING_PROVIDER;
    
    let models: Record<string, { dimension: number }>;
    switch (provider) {
      case 'ollama':
        models = OLLAMA_EMBEDDING_MODELS;
        break;
      case 'siliconflow':
        models = SILICONFLOW_MODELS;
        break;
      case 'openai':
        models = OPENAI_EMBEDDING_MODELS;
        break;
      default:
        models = OLLAMA_EMBEDDING_MODELS;
    }
    
    // 查找完全匹配
    for (const [model, info] of Object.entries(models)) {
      if (info.dimension === targetDimension) {
        return model;
      }
    }
    
    // 返回默认模型
    switch (provider) {
      case 'ollama':
        return 'nomic-embed-text';
      case 'siliconflow':
        return 'BAAI/bge-m3';
      case 'openai':
        return 'text-embedding-3-small';
      default:
        return 'nomic-embed-text';
    }
  }
  
  /**
   * 获取可用模型列表
   */
  getAvailableModels(): { model: string; dimension: number; maxTokens?: number }[] {
    const provider = this.envConfig.EMBEDDING_PROVIDER;
    
    switch (provider) {
      case 'ollama':
        return Object.entries(OLLAMA_EMBEDDING_MODELS).map(([model, info]) => ({
          model,
          dimension: info.dimension,
        }));
      case 'siliconflow':
        return Object.entries(SILICONFLOW_MODELS).map(([model, info]) => ({
          model,
          dimension: info.dimension,
          maxTokens: info.maxTokens,
        }));
      case 'openai':
        return Object.entries(OPENAI_EMBEDDING_MODELS).map(([model, info]) => ({
          model,
          dimension: info.dimension,
        }));
      default:
        return [];
    }
  }
  
  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
    console.log('[EmbeddingFactory] 缓存已清空');
  }
  
  /**
   * 获取配置摘要
   */
  getConfigSummary(): {
    provider: EmbeddingProvider;
    model: string;
    dimension: number;
    baseUrl: string;
    hasApiKey: boolean;
  } {
    const provider = this.envConfig.EMBEDDING_PROVIDER;
    let model: string;
    let baseUrl: string;
    let hasApiKey: boolean;
    
    switch (provider) {
      case 'ollama':
        model = this.envConfig.OLLAMA_EMBEDDING_MODEL;
        baseUrl = this.envConfig.OLLAMA_BASE_URL;
        hasApiKey = true; // Ollama 不需要 API Key
        break;
      case 'siliconflow':
        model = this.envConfig.SILICONFLOW_EMBEDDING_MODEL;
        baseUrl = this.envConfig.SILICONFLOW_BASE_URL;
        hasApiKey = !!this.envConfig.SILICONFLOW_API_KEY;
        break;
      case 'openai':
        model = this.envConfig.OPENAI_EMBEDDING_MODEL;
        baseUrl = this.envConfig.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        hasApiKey = !!this.envConfig.OPENAI_API_KEY;
        break;
      case 'custom':
        model = this.envConfig.CUSTOM_EMBEDDING_MODEL || 'default';
        baseUrl = this.envConfig.CUSTOM_EMBEDDING_BASE_URL || '';
        hasApiKey = !!this.envConfig.CUSTOM_EMBEDDING_API_KEY;
        break;
      default:
        model = 'unknown';
        baseUrl = '';
        hasApiKey = false;
    }
    
    return {
      provider,
      model,
      dimension: this.getModelDimension(model),
      baseUrl,
      hasApiKey,
    };
  }
  
  /**
   * 验证配置是否有效
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const provider = this.envConfig.EMBEDDING_PROVIDER;
    
    switch (provider) {
      case 'siliconflow':
        if (!this.envConfig.SILICONFLOW_API_KEY) {
          errors.push('SILICONFLOW_API_KEY 环境变量未设置');
        }
        break;
      case 'openai':
        if (!this.envConfig.OPENAI_API_KEY) {
          errors.push('OPENAI_API_KEY 环境变量未设置');
        }
        break;
      case 'custom':
        if (!this.envConfig.CUSTOM_EMBEDDING_API_KEY) {
          errors.push('CUSTOM_EMBEDDING_API_KEY 环境变量未设置');
        }
        if (!this.envConfig.CUSTOM_EMBEDDING_BASE_URL) {
          errors.push('CUSTOM_EMBEDDING_BASE_URL 环境变量未设置');
        }
        break;
      case 'ollama':
        // Ollama 本地服务，不需要 API Key
        break;
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// ==================== 便捷导出函数 ====================

/**
 * 获取全局 Embedding 工厂实例
 */
export function getEmbeddingFactory(): EmbeddingFactory {
  return EmbeddingFactory.getInstance();
}

/**
 * 快捷创建 Embedding 实例
 */
export function createEmbeddingModel(modelName?: string, options?: Partial<EmbeddingModelConfig>): Embeddings {
  return getEmbeddingFactory().createEmbedding(modelName, options);
}

/**
 * 获取当前 Embedding 模型维度
 */
export function getEmbeddingDimension(modelName?: string): number {
  return getEmbeddingFactory().getModelDimension(modelName);
}

/**
 * 获取当前 Embedding 提供商
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  return getEmbeddingFactory().getProvider();
}

/**
 * 根据维度选择 Embedding 模型
 */
export function selectEmbeddingModelByDimension(dimension: number): string {
  return getEmbeddingFactory().selectModelByDimension(dimension);
}

/**
 * 获取 Embedding 配置摘要
 */
export function getEmbeddingConfigSummary() {
  return getEmbeddingFactory().getConfigSummary();
}

/**
 * 验证 Embedding 配置
 */
export function validateEmbeddingConfig() {
  return getEmbeddingFactory().validateConfig();
}

/**
 * 重新加载 Embedding 配置
 */
export function reloadEmbeddingConfig(): void {
  getEmbeddingFactory().reloadConfig();
}

// ==================== 类型守卫 ====================

/**
 * 检查是否使用 SiliconFlow
 */
export function isSiliconFlowProvider(): boolean {
  return getEmbeddingFactory().getProvider() === 'siliconflow';
}

/**
 * 检查是否使用本地 Ollama
 */
export function isOllamaEmbeddingProvider(): boolean {
  return getEmbeddingFactory().getProvider() === 'ollama';
}

/**
 * 检查是否使用 OpenAI
 */
export function isOpenAIEmbeddingProvider(): boolean {
  return getEmbeddingFactory().getProvider() === 'openai';
}
