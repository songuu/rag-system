/**
 * 统一模型配置系统
 * 
 * 支持通过环境变量控制使用本地 Ollama 或生产 API (OpenAI/Azure/其他)
 * 
 * 架构设计：
 * 1. ModelProvider: 模型提供商枚举 (ollama, openai, azure, custom)
 * 2. ModelType: 模型类型枚举 (llm, embedding, reasoning)
 * 3. ModelConfig: 模型配置接口
 * 4. ModelFactory: 模型工厂类，统一创建模型实例
 * 5. ModelRegistry: 模型注册表，支持动态添加模型
 * 
 * 注意：Embedding 已独立到 embedding-config.ts
 * - LLM 提供商由 MODEL_PROVIDER 控制
 * - Embedding 提供商由 EMBEDDING_PROVIDER 控制
 * - 两者完全解耦，可独立配置
 */

import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Embeddings } from '@langchain/core/embeddings';

// 导入独立的 Embedding 配置系统
import {
  EmbeddingFactory,
  getEmbeddingFactory,
  createEmbeddingModel,
  getEmbeddingDimension,
  getEmbeddingProvider,
  selectEmbeddingModelByDimension,
  getEmbeddingConfigSummary,
  validateEmbeddingConfig,
  EmbeddingProvider,
  EmbeddingModelConfig,
  ALL_EMBEDDING_DIMENSIONS,
} from './embedding-config';

// ==================== 类型定义 ====================

/** 模型提供商 */
export type ModelProvider = 'ollama' | 'openai' | 'azure' | 'custom';

/** 模型类型 */
export type ModelType = 'llm' | 'embedding' | 'reasoning';

/** 模型配置接口 */
export interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** 模型维度 (仅 embedding 模型) */
  dimension?: number;
  /** 额外配置 */
  options?: Record<string, any>;
}

/** 环境变量配置 */
export interface EnvConfig {
  // 主开关：控制使用本地还是生产模型
  MODEL_PROVIDER: ModelProvider;

  // 推理模型提供商（独立于 LLM）
  REASONING_PROVIDER: ModelProvider;

  // Ollama 配置
  OLLAMA_BASE_URL: string;
  OLLAMA_LLM_MODEL: string;
  OLLAMA_EMBEDDING_MODEL: string;
  OLLAMA_REASONING_MODEL: string;

  // OpenAI 配置
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_LLM_MODEL: string;
  OPENAI_EMBEDDING_MODEL: string;
  OPENAI_REASONING_MODEL: string;

  // Azure OpenAI 配置
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_LLM_DEPLOYMENT?: string;
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT?: string;

  // 自定义 LLM API 配置
  CUSTOM_API_KEY?: string;
  CUSTOM_BASE_URL?: string;
  CUSTOM_LLM_MODEL?: string;
  CUSTOM_EMBEDDING_MODEL?: string;

  // 自定义推理模型 API 配置（独立于 LLM）
  CUSTOM_REASONING_API_KEY?: string;
  CUSTOM_REASONING_BASE_URL?: string;
  CUSTOM_REASONING_MODEL?: string;
}

/** 模型实例缓存 */
interface ModelCache {
  llm: Map<string, BaseChatModel>;
  embedding: Map<string, Embeddings>;
  reasoning: Map<string, BaseChatModel>;
}

/** 动态模型注册项 */
export interface DynamicModelEntry {
  id: string;
  type: ModelType;
  config: ModelConfig;
  description?: string;
  createdAt: number;
}

// ==================== 常量定义 ====================

/** 
 * 默认模型维度映射 
 * @deprecated 请使用 embedding-config.ts 中的 ALL_EMBEDDING_DIMENSIONS
 */
export const MODEL_DIMENSIONS: Record<string, number> = ALL_EMBEDDING_DIMENSIONS;

/** 默认模型配置 */
const DEFAULT_OLLAMA_CONFIG = {
  llm: 'llama3.1',
  embedding: 'nomic-embed-text',
  reasoning: 'deepseek-r1',
};

const DEFAULT_OPENAI_CONFIG = {
  llm: 'gpt-4o-mini',
  embedding: 'text-embedding-3-small',
  reasoning: 'gpt-4o',
};

// ==================== 环境变量解析 ====================

/**
 * 从环境变量读取配置
 */
export function loadEnvConfig(): EnvConfig {
  // 获取主 LLM 提供商
  const llmProvider = (process.env.MODEL_PROVIDER as ModelProvider) || 'ollama';

  // 推理模型提供商：独立配置，默认跟随 LLM 提供商
  const reasoningProvider = (process.env.REASONING_PROVIDER as ModelProvider) || llmProvider;

  return {
    // 主开关
    MODEL_PROVIDER: llmProvider,

    // 推理模型提供商（独立）
    REASONING_PROVIDER: reasoningProvider,

    // Ollama
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    OLLAMA_LLM_MODEL: process.env.OLLAMA_LLM_MODEL || DEFAULT_OLLAMA_CONFIG.llm,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_CONFIG.embedding,
    OLLAMA_REASONING_MODEL: process.env.OLLAMA_REASONING_MODEL || DEFAULT_OLLAMA_CONFIG.reasoning,

    // OpenAI
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_LLM_MODEL: process.env.OPENAI_LLM_MODEL || DEFAULT_OPENAI_CONFIG.llm,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_OPENAI_CONFIG.embedding,
    OPENAI_REASONING_MODEL: process.env.OPENAI_REASONING_MODEL || DEFAULT_OPENAI_CONFIG.reasoning,

    // Azure
    AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_LLM_DEPLOYMENT: process.env.AZURE_OPENAI_LLM_DEPLOYMENT,
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,

    // Custom LLM
    CUSTOM_API_KEY: process.env.CUSTOM_API_KEY,
    CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL,
    CUSTOM_LLM_MODEL: process.env.CUSTOM_LLM_MODEL,
    CUSTOM_EMBEDDING_MODEL: process.env.CUSTOM_EMBEDDING_MODEL,

    // Custom Reasoning（独立配置，默认复用 Custom LLM 配置）
    CUSTOM_REASONING_API_KEY: process.env.CUSTOM_REASONING_API_KEY || process.env.CUSTOM_API_KEY,
    CUSTOM_REASONING_BASE_URL: process.env.CUSTOM_REASONING_BASE_URL || process.env.CUSTOM_BASE_URL,
    CUSTOM_REASONING_MODEL: process.env.CUSTOM_REASONING_MODEL || 'deepseek-reasoner',
  };
}

// ==================== 模型注册表 ====================

/**
 * 模型注册表 - 管理动态添加的模型
 */
class ModelRegistry {
  private static instance: ModelRegistry;
  private models: Map<string, DynamicModelEntry> = new Map();

  private constructor() { }

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  /**
   * 注册新模型
   */
  register(entry: Omit<DynamicModelEntry, 'createdAt'>): void {
    const fullEntry: DynamicModelEntry = {
      ...entry,
      createdAt: Date.now(),
    };
    this.models.set(entry.id, fullEntry);
    console.log(`[ModelRegistry] 已注册模型: ${entry.id} (${entry.type})`);
  }

  /**
   * 注销模型
   */
  unregister(id: string): boolean {
    const deleted = this.models.delete(id);
    if (deleted) {
      console.log(`[ModelRegistry] 已注销模型: ${id}`);
    }
    return deleted;
  }

  /**
   * 获取模型配置
   */
  get(id: string): DynamicModelEntry | undefined {
    return this.models.get(id);
  }

  /**
   * 获取所有模型
   */
  getAll(): DynamicModelEntry[] {
    return Array.from(this.models.values());
  }

  /**
   * 按类型获取模型
   */
  getByType(type: ModelType): DynamicModelEntry[] {
    return this.getAll().filter(m => m.type === type);
  }

  /**
   * 检查模型是否存在
   */
  has(id: string): boolean {
    return this.models.has(id);
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.models.clear();
    console.log('[ModelRegistry] 已清空所有注册模型');
  }
}

// ==================== 模型工厂 ====================

/**
 * 模型工厂类 - 统一创建和管理模型实例
 */
export class ModelFactory {
  private static instance: ModelFactory;
  private envConfig: EnvConfig;
  private cache: ModelCache = {
    llm: new Map(),
    embedding: new Map(),
    reasoning: new Map(),
  };
  private registry: ModelRegistry;

  private constructor() {
    this.envConfig = loadEnvConfig();
    this.registry = ModelRegistry.getInstance();
    console.log(`[ModelFactory] 初始化完成, 当前提供商: ${this.envConfig.MODEL_PROVIDER}`);
  }

  static getInstance(): ModelFactory {
    if (!ModelFactory.instance) {
      ModelFactory.instance = new ModelFactory();
    }
    return ModelFactory.instance;
  }

  /**
   * 重新加载环境配置
   */
  reloadConfig(): void {
    this.envConfig = loadEnvConfig();
    this.clearCache();
    console.log(`[ModelFactory] 配置已重新加载, 当前提供商: ${this.envConfig.MODEL_PROVIDER}`);
  }

  /**
   * 获取当前提供商
   */
  getProvider(): ModelProvider {
    return this.envConfig.MODEL_PROVIDER;
  }

  /**
   * 获取当前环境配置
   */
  getEnvConfig(): EnvConfig {
    return { ...this.envConfig };
  }

  /**
   * 动态注册模型
   */
  registerModel(entry: Omit<DynamicModelEntry, 'createdAt'>): void {
    this.registry.register(entry);
  }

  /**
   * 获取已注册的模型列表
   */
  getRegisteredModels(): DynamicModelEntry[] {
    return this.registry.getAll();
  }

  // ==================== LLM 模型 ====================

  /**
   * 创建 LLM 模型实例
   * @param modelName 可选的模型名称，不提供则使用环境变量配置
   * @param options 额外配置选项
   */
  createLLM(modelName?: string, options: Partial<ModelConfig> = {}): BaseChatModel {
    const provider = this.envConfig.MODEL_PROVIDER;
    const cacheKey = `${provider}:${modelName || 'default'}:${JSON.stringify(options)}`;

    // 检查缓存
    if (this.cache.llm.has(cacheKey)) {
      return this.cache.llm.get(cacheKey)!;
    }

    let llm: BaseChatModel;

    switch (provider) {
      case 'ollama':
        llm = this.createOllamaLLM(modelName, options);
        break;
      case 'openai':
        llm = this.createOpenAILLM(modelName, options);
        break;
      case 'azure':
        llm = this.createAzureLLM(modelName, options);
        break;
      case 'custom':
        llm = this.createCustomLLM(modelName, options);
        break;
      default:
        throw new Error(`不支持的模型提供商: ${provider}`);
    }

    this.cache.llm.set(cacheKey, llm);
    return llm;
  }

  private createOllamaLLM(modelName?: string, options: Partial<ModelConfig> = {}): ChatOllama {
    const actualModel = modelName || this.envConfig.OLLAMA_LLM_MODEL;
    console.log(`[ModelFactory] 创建 Ollama LLM: ${actualModel}`);

    return new ChatOllama({
      baseUrl: options.baseUrl || this.envConfig.OLLAMA_BASE_URL,
      model: actualModel,
      temperature: options.temperature ?? 0.7,
      ...options.options,
    });
  }

  private createOpenAILLM(modelName?: string, options: Partial<ModelConfig> = {}): ChatOpenAI {
    const actualModel = modelName || this.envConfig.OPENAI_LLM_MODEL;
    const apiKey = options.apiKey || this.envConfig.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error('OpenAI API Key 未配置。请设置 OPENAI_API_KEY 环境变量。');
    }

    console.log(`[ModelFactory] 创建 OpenAI LLM: ${actualModel}`);

    return new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: actualModel,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      configuration: this.envConfig.OPENAI_BASE_URL ? {
        baseURL: options.baseUrl || this.envConfig.OPENAI_BASE_URL,
      } : undefined,
      ...options.options,
    });
  }

  private createAzureLLM(modelName?: string, options: Partial<ModelConfig> = {}): ChatOpenAI {
    const deployment = modelName || this.envConfig.AZURE_OPENAI_LLM_DEPLOYMENT;
    const apiKey = options.apiKey || this.envConfig.AZURE_OPENAI_API_KEY;
    const endpoint = options.baseUrl || this.envConfig.AZURE_OPENAI_ENDPOINT;

    if (!apiKey || !endpoint) {
      throw new Error('Azure OpenAI 配置不完整。请设置 AZURE_OPENAI_API_KEY 和 AZURE_OPENAI_ENDPOINT。');
    }

    console.log(`[ModelFactory] 创建 Azure OpenAI LLM: ${deployment}`);

    return new ChatOpenAI({
      azureOpenAIApiKey: apiKey,
      azureOpenAIApiDeploymentName: deployment,
      azureOpenAIApiInstanceName: endpoint.replace('https://', '').replace('.openai.azure.com', ''),
      azureOpenAIApiVersion: '2024-02-15-preview',
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      ...options.options,
    });
  }

  private createCustomLLM(modelName?: string, options: Partial<ModelConfig> = {}): ChatOpenAI {
    const actualModel = modelName || this.envConfig.CUSTOM_LLM_MODEL || 'default';
    const apiKey = options.apiKey || this.envConfig.CUSTOM_API_KEY;
    const baseUrl = options.baseUrl || this.envConfig.CUSTOM_BASE_URL;

    if (!apiKey || !baseUrl) {
      throw new Error('自定义 API 配置不完整。请设置 CUSTOM_API_KEY 和 CUSTOM_BASE_URL。');
    }

    console.log(`[ModelFactory] 创建自定义 LLM: ${actualModel} @ ${baseUrl}`);

    // 使用 OpenAI 兼容 API
    return new ChatOpenAI({
      apiKey: apiKey,
      model: actualModel,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      configuration: {
        baseURL: baseUrl,
      },
      ...options.options,
    });
  }

  // ==================== Embedding 模型 ====================

  /**
   * 创建 Embedding 模型实例
   * 
   * 注意：Embedding 现在使用独立配置系统 (embedding-config.ts)
   * - Embedding 提供商由 EMBEDDING_PROVIDER 环境变量控制
   * - 与 LLM 提供商 (MODEL_PROVIDER) 完全解耦
   * 
   * @param modelName 可选的模型名称
   * @param options 额外配置选项
   */
  createEmbedding(modelName?: string, options: Partial<ModelConfig> = {}): Embeddings {
    // 委托给独立的 Embedding 配置系统
    const embeddingFactory = getEmbeddingFactory();

    // 转换配置格式
    const embeddingOptions: Partial<EmbeddingModelConfig> = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      dimension: options.dimension,
      options: options.options,
    };

    return embeddingFactory.createEmbedding(modelName, embeddingOptions);
  }

  // ==================== Reasoning 模型 ====================

  /**
   * 获取推理模型提供商
   */
  getReasoningProvider(): ModelProvider {
    return this.envConfig.REASONING_PROVIDER;
  }

  /**
   * 创建推理模型实例 (用于复杂推理任务)
   * 使用独立的 REASONING_PROVIDER 配置
   * @param modelName 可选的模型名称
   * @param options 额外配置选项
   */
  createReasoningModel(modelName?: string, options: Partial<ModelConfig> = {}): BaseChatModel {
    // 使用独立的推理模型提供商
    const provider = this.envConfig.REASONING_PROVIDER;
    const cacheKey = `reasoning:${provider}:${modelName || 'default'}:${JSON.stringify(options)}`;

    if (this.cache.reasoning.has(cacheKey)) {
      return this.cache.reasoning.get(cacheKey)!;
    }

    // 推理模型通常需要更低的 temperature
    const reasoningOptions = {
      ...options,
      temperature: options.temperature ?? 0,
    };

    let model: BaseChatModel;

    switch (provider) {
      case 'ollama':
        const ollamaModel = modelName || this.envConfig.OLLAMA_REASONING_MODEL;
        console.log(`[ModelFactory] 创建 Ollama 推理模型: ${ollamaModel}`);
        model = new ChatOllama({
          baseUrl: reasoningOptions.baseUrl || this.envConfig.OLLAMA_BASE_URL,
          model: ollamaModel,
          temperature: reasoningOptions.temperature,
          ...reasoningOptions.options,
        });
        break;

      case 'openai':
        const openaiModel = modelName || this.envConfig.OPENAI_REASONING_MODEL;
        console.log(`[ModelFactory] 创建 OpenAI 推理模型: ${openaiModel}`);
        model = this.createOpenAILLM(openaiModel, reasoningOptions);
        break;

      case 'azure':
        // Azure 使用 LLM 部署
        console.log(`[ModelFactory] 创建 Azure 推理模型`);
        model = this.createAzureLLM(modelName, reasoningOptions);
        break;

      case 'custom':
        // 使用独立的 Custom Reasoning 配置
        const customModel = modelName || this.envConfig.CUSTOM_REASONING_MODEL;
        const apiKey = this.envConfig.CUSTOM_REASONING_API_KEY;
        const baseUrl = this.envConfig.CUSTOM_REASONING_BASE_URL;
        
        if (!apiKey || !baseUrl) {
          throw new Error('[ModelFactory] Custom Reasoning 需要配置 CUSTOM_REASONING_API_KEY 和 CUSTOM_REASONING_BASE_URL');
        }

        console.log(`[ModelFactory] 创建 Custom 推理模型: ${customModel} @ ${baseUrl}`);
        model = new ChatOpenAI({
          ...reasoningOptions.options,
          apiKey: apiKey,
          model: customModel,
          temperature: reasoningOptions.temperature,
          maxTokens: reasoningOptions.maxTokens,
          configuration: {
            baseURL: baseUrl,
          },
        });
        break;

      default:
        throw new Error(`不支持的推理模型提供商: ${provider}`);
    }

    this.cache.reasoning.set(cacheKey, model);
    return model;
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取模型维度
   * 使用独立的 Embedding 配置系统
   */
  getModelDimension(modelName?: string): number {
    return getEmbeddingDimension(modelName);
  }

  /**
   * 根据维度选择合适的模型
   * 使用独立的 Embedding 配置系统
   */
  selectModelByDimension(dimension: number): string {
    return selectEmbeddingModelByDimension(dimension);
  }

  /**
   * 清空模型缓存
   */
  clearCache(): void {
    this.cache.llm.clear();
    this.cache.embedding.clear();
    this.cache.reasoning.clear();
    console.log('[ModelFactory] 模型缓存已清空');
  }

  /**
   * 获取当前配置摘要
   */
  getConfigSummary(): {
    provider: ModelProvider;
    llmModel: string;
    embeddingModel: string;
    embeddingProvider: EmbeddingProvider;
    reasoningModel: string;
    reasoningProvider: ModelProvider;
    reasoningBaseUrl: string;
    hasReasoningApiKey: boolean;
    baseUrl: string;
    hasApiKey: boolean;
    embeddingConfig: ReturnType<typeof getEmbeddingConfigSummary>;
  } {
    const provider = this.envConfig.MODEL_PROVIDER;
    const reasoningProvider = this.envConfig.REASONING_PROVIDER;
    const embeddingConfig = getEmbeddingConfigSummary();

    let llmModel = '';
    let baseUrl = '';
    let hasApiKey = false;

    switch (provider) {
      case 'openai':
        llmModel = this.envConfig.OPENAI_LLM_MODEL;
        baseUrl = this.envConfig.OPENAI_BASE_URL || 'https://api.openai.com';
        hasApiKey = !!this.envConfig.OPENAI_API_KEY;
        break;
      case 'custom':
        llmModel = this.envConfig.CUSTOM_LLM_MODEL || '';
        baseUrl = this.envConfig.CUSTOM_BASE_URL || '';
        hasApiKey = !!this.envConfig.CUSTOM_API_KEY;
        break;
      case 'azure':
      case 'ollama':
      default:
        llmModel = this.envConfig.OLLAMA_LLM_MODEL;
        baseUrl = this.envConfig.OLLAMA_BASE_URL;
        hasApiKey = true;
        break;
    }

    // 获取推理模型配置
    let reasoningModel = '';
    let reasoningBaseUrl = '';
    let hasReasoningApiKey = false;

    switch (reasoningProvider) {
      case 'ollama':
        reasoningModel = this.envConfig.OLLAMA_REASONING_MODEL;
        reasoningBaseUrl = this.envConfig.OLLAMA_BASE_URL;
        hasReasoningApiKey = true;
        break;
      case 'openai':
        reasoningModel = this.envConfig.OPENAI_REASONING_MODEL;
        reasoningBaseUrl = this.envConfig.OPENAI_BASE_URL || 'https://api.openai.com';
        hasReasoningApiKey = !!this.envConfig.OPENAI_API_KEY;
        break;
      case 'custom':
        reasoningModel = this.envConfig.CUSTOM_REASONING_MODEL || '';
        reasoningBaseUrl = this.envConfig.CUSTOM_REASONING_BASE_URL || '';
        hasReasoningApiKey = !!this.envConfig.CUSTOM_REASONING_API_KEY;
        break;
      case 'azure':
        reasoningModel = this.envConfig.AZURE_OPENAI_LLM_DEPLOYMENT || '';
        reasoningBaseUrl = this.envConfig.AZURE_OPENAI_ENDPOINT || '';
        hasReasoningApiKey = !!this.envConfig.AZURE_OPENAI_API_KEY;
        break;
    }

    return {
      provider,
      llmModel,
      baseUrl,
      hasApiKey,
      embeddingModel: embeddingConfig.model,
      embeddingProvider: embeddingConfig.provider,
      reasoningModel,
      reasoningProvider,
      reasoningBaseUrl,
      hasReasoningApiKey,
      embeddingConfig,
    };
  }

  /**
   * 验证配置是否有效
   */
  validateConfig(): { valid: boolean; errors: string[]; embeddingValidation: ReturnType<typeof validateEmbeddingConfig> } {
    const errors: string[] = [];
    const provider = this.envConfig.MODEL_PROVIDER;

    switch (provider) {
      case 'openai':
        if (!this.envConfig.OPENAI_API_KEY) {
          errors.push('OPENAI_API_KEY 环境变量未设置');
        }
        break;

      case 'azure':
        if (!this.envConfig.AZURE_OPENAI_API_KEY) {
          errors.push('AZURE_OPENAI_API_KEY 环境变量未设置');
        }
        if (!this.envConfig.AZURE_OPENAI_ENDPOINT) {
          errors.push('AZURE_OPENAI_ENDPOINT 环境变量未设置');
        }
        break;

      case 'custom':
        if (!this.envConfig.CUSTOM_API_KEY) {
          errors.push('CUSTOM_API_KEY 环境变量未设置');
        }
        if (!this.envConfig.CUSTOM_BASE_URL) {
          errors.push('CUSTOM_BASE_URL 环境变量未设置');
        }
        break;

      case 'ollama':
        // Ollama 不需要 API Key，但需要确保服务可用
        break;
    }

    // 同时验证 Embedding 配置
    const embeddingValidation = validateEmbeddingConfig();

    return {
      valid: errors.length === 0 && embeddingValidation.valid,
      errors: [...errors, ...embeddingValidation.errors],
      embeddingValidation,
    };
  }
}

// ==================== 便捷导出函数 ====================

/**
 * 获取全局模型工厂实例
 */
export function getModelFactory(): ModelFactory {
  return ModelFactory.getInstance();
}

/**
 * 快捷创建 LLM
 */
export function createLLM(modelName?: string, options?: Partial<ModelConfig>): BaseChatModel {
  return getModelFactory().createLLM(modelName, options);
}

/**
 * 快捷创建 Embedding
 */
export function createEmbedding(modelName?: string, options?: Partial<ModelConfig>): Embeddings {
  return getModelFactory().createEmbedding(modelName, options);
}

/**
 * 快捷创建推理模型
 */
export function createReasoningModel(modelName?: string, options?: Partial<ModelConfig>): BaseChatModel {
  return getModelFactory().createReasoningModel(modelName, options);
}

/**
 * 获取模型维度
 */
export function getModelDimension(modelName?: string): number {
  return getModelFactory().getModelDimension(modelName);
}

/**
 * 根据维度选择模型
 */
export function selectModelByDimension(dimension: number): string {
  return getModelFactory().selectModelByDimension(dimension);
}

/**
 * 获取当前 LLM 提供商
 */
export function getCurrentProvider(): ModelProvider {
  return getModelFactory().getProvider();
}

/**
 * 获取推理模型提供商
 */
export function getReasoningProvider(): ModelProvider {
  return getModelFactory().getReasoningProvider();
}

/**
 * 获取配置摘要
 */
export function getConfigSummary() {
  return getModelFactory().getConfigSummary();
}

// ==================== 类型守卫 ====================

/**
 * 检查是否为 Ollama 提供商
 */
export function isOllamaProvider(): boolean {
  return getModelFactory().getProvider() === 'ollama';
}

/**
 * 检查是否为 OpenAI 提供商
 */
export function isOpenAIProvider(): boolean {
  return getModelFactory().getProvider() === 'openai';
}

/**
 * 检查是否为 Azure OpenAI 提供商
 */
export function isAzureOpenAIProvider(): boolean {
  return getModelFactory().getProvider() === 'azure';
}

/**
 * 检查是否为 Custom API 提供商
 */
export function isCustomAPIProvider(): boolean {
  return getModelFactory().getProvider() === 'custom';
}

/**
 * 检查是否为 Ollama 提供商
 */
export function isCustomProvider(): boolean {
  return getModelFactory().getProvider() === 'custom';
}

// ==================== 原有兼容层 ====================

/**
 * 兼容旧版 OllamaEmbeddings 导出
 * @deprecated 请使用 createEmbedding()
 */
export function getOllamaEmbeddings(modelName?: string): OllamaEmbeddings {
  const factory = getModelFactory();
  if (factory.getProvider() !== 'ollama') {
    console.warn('[ModelFactory] 当前提供商不是 Ollama，但请求了 OllamaEmbeddings');
  }
  return factory.createEmbedding(modelName) as OllamaEmbeddings;
}

/**
 * 兼容旧版 ChatOllama 导出
 * @deprecated 请使用 createLLM()
 */
export function getChatOllama(modelName?: string): ChatOllama {
  const factory = getModelFactory();
  if (factory.getProvider() !== 'ollama') {
    console.warn('[ModelFactory] 当前提供商不是 Ollama，但请求了 ChatOllama');
  }
  return factory.createLLM(modelName) as ChatOllama;
}
