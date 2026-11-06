/**
 * 实体抽取系统 - GraphRAG 风格实现
 * 
 * 功能：
 * 1. 智能切分 (Semantic Chunking with Overlap)
 * 2. LLM 实体/关系提取 (Entity & Relation Extraction with Gleaning)
 * 3. 实体合并 (Entity Resolution)
 * 4. 社区发现与摘要 (Community Detection & Summarization)
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { createHash } from "node:crypto";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseMessage } from "@langchain/core/messages";
import { createLLM, createEmbedding, getModelFactory, getConfigSummary } from "./model-config";
import { getEmbeddingConfigSummary } from "./embedding-config";
import { createStableErrorLog } from "./security/error-redaction";
import { createSourceAlignedTextWindows } from "./source-aligned-chunking";

export class EntityExtractionProviderBusyError extends Error {
  readonly code = 'ENTITY_EXTRACTION_PROVIDER_BUSY';

  constructor() {
    super('Entity extraction provider still has timed-out work in flight.');
    this.name = 'EntityExtractionProviderBusyError';
  }
}

export class EntityExtractionProviderTimeoutError extends Error {
  readonly code = 'ENTITY_EXTRACTION_PROVIDER_TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'EntityExtractionProviderTimeoutError';
  }
}

export class EntityExtractionProviderBudgetError extends Error {
  readonly code = 'ENTITY_EXTRACTION_PROVIDER_BUDGET_EXCEEDED';

  constructor() {
    super('Entity extraction provider budget exceeded.');
    this.name = 'EntityExtractionProviderBudgetError';
  }
}

export class EntityExtractionOutputBudgetError extends Error {
  readonly code = 'ENTITY_EXTRACTION_OUTPUT_BUDGET_EXCEEDED';

  constructor() {
    super('Entity extraction output budget exceeded.');
    this.name = 'EntityExtractionOutputBudgetError';
  }
}

export class EntityExtractionTruncatedError extends Error {
  readonly code = 'ENTITY_EXTRACTION_TRUNCATED';

  constructor() {
    super('模型输出已截断，无法完整提取当前文本块。');
    this.name = 'EntityExtractionTruncatedError';
  }
}

export class EntityExtractionInvalidOutputError extends Error {
  readonly code = 'ENTITY_EXTRACTION_INVALID_OUTPUT';

  constructor() {
    super('模型输出无法解析为完整的实体和关系。');
    this.name = 'EntityExtractionInvalidOutputError';
  }
}

const TIMED_OUT_ENTITY_EXTRACTION_WORK = new Map<string, Set<Promise<void>>>();

function isEntityExtractionFatalError(
  error: unknown
): error is EntityExtractionProviderBusyError
  | EntityExtractionProviderTimeoutError
  | EntityExtractionProviderBudgetError
  | EntityExtractionOutputBudgetError
  | EntityExtractionTruncatedError
  | EntityExtractionInvalidOutputError {
  return error instanceof EntityExtractionProviderBusyError
    || error instanceof EntityExtractionProviderTimeoutError
    || error instanceof EntityExtractionProviderBudgetError
    || error instanceof EntityExtractionOutputBudgetError
    || error instanceof EntityExtractionTruncatedError
    || error instanceof EntityExtractionInvalidOutputError;
}

const ENTITY_EXTRACTION_FIELD_LIMITS = Object.freeze({
  identifierCharacters: 512,
  descriptionCharacters: 8_000,
});

// ==================== 类型定义 ====================

/** 实体类型 */
export type EntityType = 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'EVENT' | 'CONCEPT' | 'PRODUCT' | 'DATE' | 'OTHER';

/** 实体 */
export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string;
  aliases: string[];  // 别名列表
  mentions: number;   // 出现次数
  sourceChunks: string[];  // 来源文本块ID
  embedding?: number[];  // 实体嵌入向量
  metadata?: Record<string, unknown>;
}

/** 关系 */
export interface Relation {
  id: string;
  source: string;     // 源实体ID
  target: string;     // 目标实体ID
  type: string;       // 关系类型
  description: string;  // 关系描述
  weight: number;     // 关系权重 (0-1)
  sourceChunks: string[];  // 来源文本块ID
  metadata?: Record<string, unknown>;
}

/** 文本块 */
export interface TextChunk {
  id: string;
  content: string;
  index: number;
  startChar: number;
  endChar: number;
  overlap: {
    previous: string | null;
    next: string | null;
  };
  metadata?: Record<string, unknown>;
}

/** 社区 */
export interface Community {
  id: string;
  name: string;
  entities: string[];   // 社区成员实体ID
  relations: string[];  // 社区内关系ID
  summary: string;      // 社区摘要
  keywords: string[];   // 关键词
  level: number;        // 社区层级 (0为最底层)
  parentId?: string;    // 父社区ID
  embedding?: number[]; // 社区摘要嵌入
}

/** 知识图谱 */
export interface KnowledgeGraph {
  entities: Map<string, Entity>;
  relations: Map<string, Relation>;
  communities: Map<string, Community>;
  chunks: Map<string, TextChunk>;
  metadata: {
    documentId: string;
    createdAt: Date;
    entityCount: number;
    relationCount: number;
    communityCount: number;
  };
}

/** 抽取配置 */
export interface ExtractionConfig {
  chunkSize: number;       // 目标块大小
  chunkOverlap: number;    // 重叠大小
  enableGleaning: boolean; // 启用二次检查
  gleaningRounds: number;  // Gleaning 轮数
  minEntityMentions: number; // 最小实体出现次数
  similarityThreshold: number; // 实体合并相似度阈值
  communityResolution: number; // 社区发现分辨率
  llmModel: string;        // LLM 模型
  embeddingModel: string;  // 嵌入模型
  ollamaBaseUrl: string;   // Ollama 地址
  
  // 超时配置
  maxTotalTimeout: number;   // 总体最大超时（毫秒），默认 10 分钟
  maxChunkTimeout: number;   // 单块最大超时（毫秒），默认 60 秒
  /** Fixed operation budget when loading latency cannot be estimated from text length. */
  chunkTimeoutMs?: number;
  /** Graph stages can reload the LLM after embedding work; ordinary callers keep their stage defaults. */
  llmOperationTimeoutMs?: number;
  requireCompleteExtraction: boolean; // 任何文本块失败时拒绝部分结果
  adaptiveChunkSplitting?: boolean;
  minAdaptiveChunkCharacters?: number;
  embeddingBatchSize?: number;
  /** Complete community LLM work before switching to bounded embedding batches. */
  batchCommunityEmbeddings?: boolean;
  /** Separate cold-start budget for embeddings; omitted callers retain 30 seconds. */
  embeddingTimeoutMs?: number;
  baseChunkTime: number;     // 单块基础处理时间（毫秒），默认 10 秒
  timeoutPerChar: number;    // 每字符额外时间（毫秒），默认 20ms
  maxProviderCalls: number;  // 单次抽取允许的 LLM/embedding 调用数
  maxProviderInputCharacters: number; // 所有 provider 输入的累计字符上限
  maxProviderOutputCharacters: number; // 所有 LLM 文本输出的累计字符上限
  maxExtractedEntities: number; // provider 返回的原始实体观察数上限
  maxExtractedRelations: number; // provider 返回的原始关系观察数上限
  maxAggregationLookupComparisons: number; // 聚合阶段名称/端点查找比较上限
  maxEntityResolutionComparisons: number; // 实体消歧两两比较上限
  maxEntityResolutionVectorOperations: number; // 余弦相似度标量运算上限
  maxEmbeddingDimensions: number; // 单个实体向量维度上限
}

export interface EntityExtractionSegment {
  key: string;
  sourceDigest: string;
  progress: number;
}

export type EntityExtractionSegmentResult = {
  entities: Array<{ name: string; type: string; description: string }>;
  relations: Array<{ source: string; target: string; type: string; description: string }>;
};

export type EntityExtractionCheckpointValue =
  | { kind: 'split' }
  | { kind: 'complete'; result: EntityExtractionSegmentResult };

export interface EntityExtractionCheckpoint {
  load(segment: EntityExtractionSegment): Promise<EntityExtractionCheckpointValue | null>;
  save(segment: EntityExtractionSegment, value: EntityExtractionCheckpointValue): Promise<void>;
}

/** 超时配置常量 */
export const TIMEOUT_CONSTANTS = {
  // 模型速度系数（基于模型参数量）
  MODEL_SPEED_FACTORS: {
    '0.5b': 1.0,    // 最快
    '1b': 1.5,
    '3b': 2.0,
    '7b': 3.0,
    '8b': 3.5,
    '13b': 5.0,
    '14b': 5.5,
    '32b': 8.0,
    '70b': 15.0,
    'default': 2.5,  // 未知模型的默认系数
  } as Record<string, number>,
  
  // 处理阶段时间占比
  STAGE_TIME_RATIO: {
    chunking: 0.02,     // 切分占 2%
    extracting: 0.50,   // 提取占 50%
    gleaning: 0.20,     // Gleaning 占 20%
    resolving: 0.10,    // 消歧占 10%
    community: 0.08,    // 社区发现占 8%
    summarizing: 0.10,  // 摘要占 10%
  },
  
  // 绝对限制
  ABSOLUTE_MAX_TIMEOUT: 55 * 60 * 1000,  // 长文档构建仍受租约和显式任务预算约束
  ABSOLUTE_MIN_TIMEOUT: 30 * 1000,        // 绝对最小 30 秒
};

/** 抽取进度 */
export interface ExtractionProgress {
  stage: 'chunking' | 'extracting' | 'gleaning' | 'resolving' | 'community' | 'summarizing' | 'completed';
  current: number;
  total: number;
  message: string;
  details?: Record<string, unknown>;
}

// ==================== 默认配置 ====================

/**
 * 获取默认的抽取配置
 * 动态从统一配置系统获取当前配置的模型名
 */
function getDefaultExtractionConfig(): ExtractionConfig {
  // 从统一配置系统获取当前模型
  const llmConfig = getConfigSummary();
  const embeddingConfig = getEmbeddingConfigSummary();
  
  return {
    chunkSize: 500,
    chunkOverlap: 100,
    enableGleaning: true,
    gleaningRounds: 1,
    minEntityMentions: 1,
    similarityThreshold: 0.85,
    communityResolution: 1.0,
    // 使用统一配置系统的模型，而不是硬编码 Ollama 模型名
    llmModel: llmConfig.llmModel,
    embeddingModel: embeddingConfig.model,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    
    // 超时配置
    maxTotalTimeout: 10 * 60 * 1000,  // 默认最大 10 分钟
    maxChunkTimeout: 60 * 1000,        // 单块最大 60 秒
    requireCompleteExtraction: false,
    baseChunkTime: 10 * 1000,          // 基础 10 秒/块
    timeoutPerChar: 20,                // 每字符 20ms
    maxProviderCalls: 10_000,
    maxProviderInputCharacters: 100_000_000,
    maxProviderOutputCharacters: 2_000_000,
    maxExtractedEntities: 1_000,
    maxExtractedRelations: 5_000,
    maxAggregationLookupComparisons: 100_000,
    maxEntityResolutionComparisons: 50_000,
    maxEntityResolutionVectorOperations: 50_000_000,
    maxEmbeddingDimensions: 4_096,
  };
}

// 为了向后兼容，保留 DEFAULT_EXTRACTION_CONFIG 导出
// 但在运行时会使用动态配置
export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  chunkSize: 500,
  chunkOverlap: 100,
  enableGleaning: true,
  gleaningRounds: 1,
  minEntityMentions: 1,
  similarityThreshold: 0.85,
  communityResolution: 1.0,
  llmModel: 'default', // 占位符，实际使用时会被覆盖
  embeddingModel: 'default', // 占位符，实际使用时会被覆盖
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  
  // 超时配置
  maxTotalTimeout: 10 * 60 * 1000,
  maxChunkTimeout: 60 * 1000,
  requireCompleteExtraction: false,
  baseChunkTime: 10 * 1000,
  timeoutPerChar: 20,
  maxProviderCalls: 10_000,
  maxProviderInputCharacters: 100_000_000,
  maxProviderOutputCharacters: 2_000_000,
  maxExtractedEntities: 1_000,
  maxExtractedRelations: 5_000,
  maxAggregationLookupComparisons: 100_000,
  maxEntityResolutionComparisons: 50_000,
  maxEntityResolutionVectorOperations: 50_000_000,
  maxEmbeddingDimensions: 4_096,
};

// ==================== 提示词模板 ====================

const ENTITY_EXTRACTION_PROMPT = `你是一个专业的信息抽取专家。请从以下文本中提取所有重要的实体和关系。

## 任务要求

### 实体抽取
找出文本中所有重要的实体，包括：
- PERSON: 人名（包括真实人物、虚构角色）
- ORGANIZATION: 组织机构（公司、政府、学校等）
- LOCATION: 地点（国家、城市、地标等）
- EVENT: 事件（会议、比赛、历史事件等）
- CONCEPT: 概念（技术、理论、方法等）
- PRODUCT: 产品（软件、硬件、服务等）
- DATE: 日期时间
- OTHER: 其他重要实体

对每个实体，提供：
1. name: 实体的规范名称
2. type: 实体类型
3. description: 一句话描述这个实体是什么

### 关系抽取
找出实体之间的关系，包括：
- 谁做了什么
- 谁是什么的一部分
- 什么发生在哪里
- 什么时候发生
- 谁与谁有关联

对每个关系，提供：
1. source: 源实体名称
2. target: 目标实体名称  
3. type: 关系类型（如：创始人、位于、发生于、合作、竞争等）
4. description: 一句话描述这个关系

## 输入文本
"""
{text}
"""

## 输出格式
请完整提取重要信息，合并重复项，描述尽量简短。关系的源和目标必须在实体列表中。
请严格按照以下 JSON 格式输出，不要添加任何其他内容：
{
  "entities": [
    {"name": "实体名称", "type": "PERSON|ORGANIZATION|LOCATION|EVENT|CONCEPT|PRODUCT|DATE|OTHER", "description": "实体描述"}
  ],
  "relations": [
    {"source": "源实体名称", "target": "目标实体名称", "type": "关系类型", "description": "关系描述"}
  ]
}`;

const ENTITY_EXTRACTION_CONSISTENCY_INSTRUCTIONS = '\n\n重新抽取要求：上一轮结果未通过完整性检查。请重新返回完整 entities 和 relations 数组，不要返回补丁。每条关系的 source 和 target 都必须逐字匹配同一输出 entities 数组中某个实体的 name；关系涉及的有原文依据的实体必须同时完整列出，不得使用实体类型标签代替实体名称。只提取当前文本明确支持的事实，不得补造事实。没有可确认的实体或关系时请使用空数组。';

export function calculateEntityExtractionPromptCharacters(
  chunkContentLength: number
): number {
  if (!Number.isSafeInteger(chunkContentLength) || chunkContentLength < 0) {
    throw new Error('Invalid entity extraction prompt content length.');
  }
  return ENTITY_EXTRACTION_PROMPT.length
    - '{text}'.length
    + chunkContentLength;
}

const GLEANING_PROMPT = `你是一个信息抽取质检专家。请检查以下抽取结果，找出遗漏的重要实体和关系。

## 原始文本
"""
{text}
"""

## 已抽取的实体
{existingEntities}

## 已抽取的关系
{existingRelations}

## 任务
仔细重新阅读原文，检查：
1. 是否有重要实体被遗漏？
2. 是否有关系被遗漏？
3. 已抽取的信息是否准确？

只输出**新发现的**、**遗漏的**实体和关系。如果没有遗漏，输出空数组。

## 输出格式
{{
  "entities": [
    {{"name": "新发现的实体名称", "type": "类型", "description": "描述"}}
  ],
  "relations": [
    {{"source": "源实体", "target": "目标实体", "type": "关系类型", "description": "描述"}}
  ]
}}`;

const ENTITY_RESOLUTION_PROMPT = `你是一个实体消歧专家。请判断以下实体是否指向同一个对象。

## 待判断的实体对
实体1: {entity1}
- 类型: {type1}
- 描述: {desc1}

实体2: {entity2}
- 类型: {type2}
- 描述: {desc2}

## 上下文
{context}

## 任务
判断这两个实体是否指向同一个现实世界中的对象。考虑：
1. 名称是否是同一事物的不同称呼（如全名/简称/别名）
2. 类型是否兼容
3. 描述是否一致

## 输出格式
{{
  "isSameEntity": true或false,
  "confidence": 0.0到1.0,
  "reasoning": "判断理由"
}}`;

const COMMUNITY_SUMMARY_PROMPT = `你是一个知识图谱分析专家。请为以下社区生成一份简洁的摘要报告。

## 社区成员（实体）
{entities}

## 社区关系
{relations}

## 任务
1. 分析这个社区的主题和核心内容
2. 生成一份100-200字的摘要，描述这个社区讲述了什么
3. 提取3-5个关键词

## 输出格式
{{
  "name": "社区名称（2-5个字）",
  "summary": "社区摘要",
  "keywords": ["关键词1", "关键词2", "关键词3"]
}}`;

// ==================== 核心类 ====================

export class EntityExtractor {
  private config: ExtractionConfig;
  private llm: Pick<BaseChatModel, 'invoke'>;
  private extractionLlm: Pick<BaseChatModel, 'invoke'>;
  private embeddings: Embeddings;
  private readonly llmAdmissionKey: string;
  private readonly embeddingAdmissionKey: string;
  private readonly checkpoint?: EntityExtractionCheckpoint;
  private readonly activeProviderControllers = new Set<AbortController>();
  private providerCallCount = 0;
  private providerInputCharacterCount = 0;
  private providerOutputCharacterCount = 0;
  private extractedEntityObservationCount = 0;
  private extractedRelationObservationCount = 0;
  private aggregationLookupComparisonCount = 0;
  private progressCallback?: (progress: ExtractionProgress) => void;
  
  // 超时控制
  private startTime: number = 0;
  private estimatedTimeout: number = 0;
  private aborted: boolean = false;

  constructor(
    config: Partial<ExtractionConfig> = {},
    options: {
      llmInstance?: Pick<BaseChatModel, 'invoke'>;
      extractionLlmInstance?: Pick<BaseChatModel, 'invoke'>;
      embeddingInstance?: Embeddings;
      providerKey?: string;
      embeddingProviderKey?: string;
      checkpoint?: EntityExtractionCheckpoint;
    } = {}
  ) {
    // 使用动态获取的默认配置，确保使用正确的模型名
    const defaultConfig = getDefaultExtractionConfig();
    this.config = { ...defaultConfig, ...config };
    this.checkpoint = options.checkpoint;
    if (this.config.chunkTimeoutMs !== undefined
      && (!Number.isSafeInteger(this.config.chunkTimeoutMs) || this.config.chunkTimeoutMs < 1)) {
      throw new Error('Entity extraction chunk timeout must be a positive safe integer.');
    }
    if (this.config.llmOperationTimeoutMs !== undefined
      && (!Number.isSafeInteger(this.config.llmOperationTimeoutMs)
        || this.config.llmOperationTimeoutMs < 1000 || this.config.llmOperationTimeoutMs > 300_000)) {
      throw new Error('Entity LLM operation timeout must be an integer between 1000 and 300000 ms.');
    }
    if (this.config.minAdaptiveChunkCharacters !== undefined
      && (!Number.isSafeInteger(this.config.minAdaptiveChunkCharacters)
        || this.config.minAdaptiveChunkCharacters < 1)) {
      throw new Error('Adaptive extraction minimum chunk size must be a positive integer.');
    }
    if (this.config.embeddingBatchSize !== undefined
      && (!Number.isSafeInteger(this.config.embeddingBatchSize)
        || this.config.embeddingBatchSize < 1 || this.config.embeddingBatchSize > 128)) {
      throw new Error('Entity embedding batch size must be between 1 and 128.');
    }
    if (this.config.embeddingTimeoutMs !== undefined
      && (!Number.isSafeInteger(this.config.embeddingTimeoutMs)
        || this.config.embeddingTimeoutMs < 1000 || this.config.embeddingTimeoutMs > 300_000)) {
      throw new Error('Entity embedding timeout must be an integer between 1000 and 300000 ms.');
    }
    const resourceLimits = [
      this.config.maxProviderCalls,
      this.config.maxProviderInputCharacters,
      this.config.maxProviderOutputCharacters,
      this.config.maxExtractedEntities,
      this.config.maxExtractedRelations,
      this.config.maxAggregationLookupComparisons,
      this.config.maxEntityResolutionComparisons,
      this.config.maxEntityResolutionVectorOperations,
      this.config.maxEmbeddingDimensions,
    ];
    if (resourceLimits.some(limit => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Entity extraction resource budgets must use positive safe integers.');
    }

    // 允许调用方注入已构造好的 LLM 实例（用于运行时模型覆盖）
    if (options.llmInstance) {
      this.llm = options.llmInstance;
    } else {
      this.llm = createLLM(this.config.llmModel !== 'default' ? this.config.llmModel : undefined, {
        temperature: 0.1,
      });
    }
    this.extractionLlm = options.extractionLlmInstance ?? this.llm;

    const factory = getModelFactory();
    this.embeddings = options.embeddingInstance
      ?? createEmbedding(this.config.embeddingModel !== 'default' ? this.config.embeddingModel : undefined,
        this.config.embeddingTimeoutMs === undefined ? undefined : { requestTimeoutMs: this.config.embeddingTimeoutMs });
    this.llmAdmissionKey = options.providerKey?.trim()
      || `${factory.getProvider()}:${this.config.llmModel.trim() || 'default'}`;
    const embeddingConfig = getEmbeddingConfigSummary();
    this.embeddingAdmissionKey = options.embeddingProviderKey?.trim()
      || createEmbeddingAdmissionKey(
        embeddingConfig.provider,
        this.config.embeddingModel.trim() || embeddingConfig.model,
        embeddingConfig.baseUrl
      );
    console.log(`[EntityExtractor] 初始化完成, 提供商: ${factory.getProvider()}, LLM: ${this.config.llmModel}, Embedding: ${this.config.embeddingModel}`);
  }

  /** 设置进度回调 */
  onProgress(callback: (progress: ExtractionProgress) => void): void {
    this.progressCallback = callback;
  }

  /** 报告进度 */
  private reportProgress(progress: ExtractionProgress): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  /**
   * 获取模型速度系数
   * 根据模型名称中的参数量标识返回速度系数
   */
  private getModelSpeedFactor(): number {
    const modelName = this.config.llmModel.toLowerCase();
    
    // 从模型名称中提取参数量标识
    for (const [size, factor] of Object.entries(TIMEOUT_CONSTANTS.MODEL_SPEED_FACTORS)) {
      if (size !== 'default' && modelName.includes(size)) {
        console.log(`[EntityExtractor] 模型 ${this.config.llmModel} 速度系数: ${factor} (${size})`);
        return factor;
      }
    }
    
    // 特殊模型处理
    if (modelName.includes('deepseek-r1')) {
      return TIMEOUT_CONSTANTS.MODEL_SPEED_FACTORS['7b'] || 3.0;
    }
    if (modelName.includes('qwen3')) {
      return TIMEOUT_CONSTANTS.MODEL_SPEED_FACTORS['8b'] || 3.5;
    }
    
    console.log(`[EntityExtractor] 模型 ${this.config.llmModel} 使用默认速度系数`);
    return TIMEOUT_CONSTANTS.MODEL_SPEED_FACTORS['default'] || 2.5;
  }

  /**
   * 计算预估超时时间
   * 基于文本长度、切片数量、模型类型动态计算
   */
  calculateTimeout(textLength: number, chunkCount: number): number {
    const modelFactor = this.getModelSpeedFactor();
    const gleaningFactor = this.config.enableGleaning ? (1 + this.config.gleaningRounds * 0.3) : 1;
    
    // 基础时间计算
    // 每个 chunk 的处理时间 = 基础时间 + (字符数 * 每字符时间) * 模型系数
    const avgChunkSize = textLength / Math.max(1, chunkCount);
    const perChunkTime = this.config.chunkTimeoutMs === undefined ? (
      this.config.baseChunkTime + 
      avgChunkSize * this.config.timeoutPerChar
    ) * modelFactor : this.calculateChunkTimeout(avgChunkSize);
    
    // 总提取时间 (包括 gleaning)
    // Reserve one parent and two child attempts per chunk. Without this
    // allowance adaptive recovery can run out of its task deadline just after
    // a parent times out, despite successful smaller requests being possible.
    // Deeper splits still share the configured total/provider resource limits.
    const adaptiveCallFactor = this.config.adaptiveChunkSplitting ? 3 : 1;
    const extractionTime = chunkCount * perChunkTime * gleaningFactor * adaptiveCallFactor;
    
    // 其他阶段的时间估算
    const resolutionTime = Math.min(30000, chunkCount * 2000); // 消歧最多 30 秒
    const communityTime = Math.min(30000, chunkCount * 3000);  // 社区发现最多 30 秒
    const summaryTime = Math.min(60000, chunkCount * 5000);    // 摘要最多 60 秒
    
    // 总时间
    let totalTimeout = extractionTime + resolutionTime + communityTime + summaryTime;
    
    // 添加 20% 的安全余量
    totalTimeout *= 1.2;
    
    // 应用配置的最大限制
    totalTimeout = Math.min(totalTimeout, this.config.maxTotalTimeout);
    
    // 应用绝对限制
    totalTimeout = Math.max(
      TIMEOUT_CONSTANTS.ABSOLUTE_MIN_TIMEOUT,
      Math.min(totalTimeout, TIMEOUT_CONSTANTS.ABSOLUTE_MAX_TIMEOUT)
    );
    
    console.log(`[EntityExtractor] 超时计算:`, {
      textLength,
      chunkCount,
      modelFactor,
      gleaningFactor,
      perChunkTime: Math.round(perChunkTime),
      extractionTime: Math.round(extractionTime),
      totalTimeout: Math.round(totalTimeout),
      totalTimeoutMinutes: (totalTimeout / 60000).toFixed(1),
    });
    
    return Math.round(totalTimeout);
  }

  /**
   * 计算单个 chunk 的超时时间
   */
  calculateChunkTimeout(chunkLength: number): number {
    if (this.config.chunkTimeoutMs !== undefined) {
      return Math.min(this.config.chunkTimeoutMs, this.config.maxChunkTimeout);
    }
    const modelFactor = this.getModelSpeedFactor();
    
    const timeout = (
      this.config.baseChunkTime + 
      chunkLength * this.config.timeoutPerChar
    ) * modelFactor;
    
    // 应用单块最大限制
    return Math.min(timeout, this.config.maxChunkTimeout);
  }

  /**
   * 检查是否已超时
   */
  private checkTimeout(): void {
    if (this.aborted) {
      throw new Error('抽取任务已被中止');
    }
    
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.estimatedTimeout) {
      this.aborted = true;
      throw new Error(`抽取超时：已运行 ${Math.round(elapsed / 1000)} 秒，超过预估时间 ${Math.round(this.estimatedTimeout / 1000)} 秒`);
    }
  }

  /**
   * 获取剩余时间
   */
  private getRemainingTime(): number {
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.estimatedTimeout - elapsed);
  }

  /**
   * Provider deadline with orphan admission control.
   *
   * AbortSignal is advisory: a provider may ignore it. When that happens, the
   * real settlement remains reserved for this provider/model key so later
   * extraction work cannot multiply detached requests.
   */
  private async withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    errorMessage: string,
    providerInputCharacters: number,
    admissionKey = this.llmAdmissionKey
  ): Promise<T> {
    const timedOutWork = TIMED_OUT_ENTITY_EXTRACTION_WORK.get(admissionKey);
    if (timedOutWork && timedOutWork.size > 0) {
      throw new EntityExtractionProviderBusyError();
    }
    const nextProviderCallCount = this.providerCallCount + 1;
    const nextProviderInputCharacterCount =
      this.providerInputCharacterCount + providerInputCharacters;
    if (
      !Number.isSafeInteger(providerInputCharacters)
      || providerInputCharacters < 0
      || nextProviderCallCount > this.config.maxProviderCalls
      || nextProviderInputCharacterCount > this.config.maxProviderInputCharacters
    ) {
      throw new EntityExtractionProviderBudgetError();
    }
    this.providerCallCount = nextProviderCallCount;
    this.providerInputCharacterCount = nextProviderInputCharacterCount;

    const controller = new AbortController();
    this.activeProviderControllers.add(controller);
    let operationSettled = false;
    let timeoutError: EntityExtractionProviderTimeoutError | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const operationPromise = Promise.resolve()
      .then(() => operation(controller.signal));
    const settlement = operationPromise
      .then(
        () => undefined,
        () => undefined
      );
    void settlement.then(() => {
      operationSettled = true;
      this.activeProviderControllers.delete(controller);
      const reservations = TIMED_OUT_ENTITY_EXTRACTION_WORK.get(admissionKey);
      reservations?.delete(settlement);
      if (reservations?.size === 0) {
        TIMED_OUT_ENTITY_EXTRACTION_WORK.delete(admissionKey);
      }
    });

    try {
      return await Promise.race([
        operationPromise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            timeoutError = new EntityExtractionProviderTimeoutError(errorMessage);
            if (!operationSettled) {
              const reservations = TIMED_OUT_ENTITY_EXTRACTION_WORK.get(admissionKey)
                ?? new Set<Promise<void>>();
              reservations.add(settlement);
              TIMED_OUT_ENTITY_EXTRACTION_WORK.set(admissionKey, reservations);
            }
            reject(timeoutError);
            controller.abort(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timeoutError) {
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private getOperationTimeout(preferredMs: number): number {
    const remainingTime = this.getRemainingTime();
    if (remainingTime < 1000) {
      this.checkTimeout();
      throw new Error('抽取超时：剩余时间不足以继续调用模型');
    }
    return Math.min(preferredMs, remainingTime);
  }

  private async waitForTimedOutProviderSettlement(): Promise<boolean> {
    const pending = TIMED_OUT_ENTITY_EXTRACTION_WORK.get(this.llmAdmissionKey);
    if (!pending?.size) return true;
    const remaining = this.getRemainingTime();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Aborting fetch may need another event-loop turn to close its body.
      // Give cooperative cancellation a bounded drain window; an orphan that
      // ignores cancellation still owns admission and must never be overlapped.
      await Promise.race([
        Promise.all([...pending]),
        new Promise(resolve => { timer = setTimeout(resolve, Math.min(250, remaining)); }),
      ]);
      return !TIMED_OUT_ENTITY_EXTRACTION_WORK.has(this.llmAdmissionKey);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 中止当前抽取任务
   */
  abort(): void {
    this.aborted = true;
    for (const controller of this.activeProviderControllers) {
      controller.abort(new Error('Entity extraction aborted.'));
    }
  }

  /**
   * 获取超时统计信息
   */
  getTimeoutInfo(): {
    startTime: number;
    estimatedTimeout: number;
    elapsed: number;
    remaining: number;
    aborted: boolean;
  } {
    const elapsed = Date.now() - this.startTime;
    return {
      startTime: this.startTime,
      estimatedTimeout: this.estimatedTimeout,
      elapsed,
      remaining: Math.max(0, this.estimatedTimeout - elapsed),
      aborted: this.aborted,
    };
  }

  /**
   * 步骤1: 智能语义切分
   */
  async chunkDocument(text: string, documentId: string): Promise<TextChunk[]> {
    this.reportProgress({
      stage: 'chunking',
      current: 0,
      total: 1,
      message: '正在进行智能语义切分...',
    });

    const { chunkSize, chunkOverlap } = this.config;
    const chunks = createSourceAlignedTextWindows(text, chunkSize, chunkOverlap)
      .map((window, index): TextChunk => ({
        id: `${documentId}_chunk_${index}`,
        content: window.content,
        index,
        startChar: window.startChar,
        endChar: window.endChar,
        overlap: {
          previous: window.previousOverlap,
          next: window.nextOverlap,
        },
      }));

    this.reportProgress({
      stage: 'chunking',
      current: 1,
      total: 1,
      message: `切分完成，共 ${chunks.length} 个文本块`,
      details: { chunkCount: chunks.length },
    });

    return chunks;
  }

  /**
   * 步骤2: LLM 实体/关系提取
   */
  async extractEntitiesAndRelations(chunks: TextChunk[]): Promise<{
    entities: Map<string, Entity>;
    relations: Map<string, Relation>;
  }> {
    const entities = new Map<string, Entity>();
    const relations = new Map<string, Relation>();

    for (let i = 0; i < chunks.length; i++) {
      this.checkTimeout();

      const chunk = chunks[i];
      
      this.reportProgress({
        stage: 'extracting',
        current: i,
        total: chunks.length,
        message: `正在抽取第 ${i + 1}/${chunks.length} 个文本块...`,
      });

      try {
        // 主抽取
        const extracted = await this.extractFromChunk(chunk, chunks.length);
        this.reserveAggregationLookupBudget(
          extracted.entities.length,
          extracted.relations.length,
          entities.size
        );
        
        // 合并实体
        for (const entity of extracted.entities) {
          const existingId = this.findSimilarEntity(entity.name, entities);
          if (existingId) {
            // 更新已有实体
            const existing = entities.get(existingId)!;
            existing.mentions += 1;
            // Multiple mentions in one chunk share the same evidence reference.
            if (!existing.sourceChunks.includes(chunk.id)) {
              existing.sourceChunks.push(chunk.id);
            }
            if (entity.description.length > existing.description.length) {
              existing.description = entity.description;
            }
          } else {
            // 新实体
            const entityId = `entity_${entities.size}_${Date.now()}`;
            entities.set(entityId, {
              id: entityId,
              name: entity.name,
              type: entity.type as EntityType,
              description: entity.description,
              aliases: [entity.name],
              mentions: 1,
              sourceChunks: [chunk.id],
            });
          }
        }

        // 合并关系
        for (const relation of extracted.relations) {
          const sourceId = this.findEntityByName(relation.source, entities);
          const targetId = this.findEntityByName(relation.target, entities);
          
          if (sourceId && targetId) {
            const relationId = `relation_${relations.size}_${Date.now()}`;
            relations.set(relationId, {
              id: relationId,
              source: sourceId,
              target: targetId,
              type: relation.type,
              description: relation.description,
              weight: 1.0,
              sourceChunks: [chunk.id],
            });
          }
        }

        // Gleaning（二次检查）
        if (this.config.enableGleaning) {
          await this.performGleaning(chunk, extracted, entities, relations);
        }

        this.checkTimeout();

        this.reportProgress({
          stage: 'extracting',
          current: i + 1,
          total: chunks.length,
          message: `已完成第 ${i + 1}/${chunks.length} 个文本块抽取`,
        });

      } catch (error) {
        if (isEntityExtractionFatalError(error)) {
          throw error;
        }
        if (this.config.requireCompleteExtraction) throw error;
        console.error(
          '[EntityExtractor] chunk extraction failed',
          createStableErrorLog(error)
        );
      }
    }

    return { entities, relations };
  }

  /**
   * 清理和修复 LLM 返回的 JSON 字符串
   */
  private cleanJsonString(jsonStr: string): string {
    let cleaned = jsonStr;
    
    // 1. 移除 JSON 代码块标记
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    
    // 2. 移除注释
    cleaned = cleaned.replace(/\/\/.*$/gm, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // 3. 修复尾随逗号 (在 ] 或 } 之前的逗号)
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    
    // 4. 修复缺少逗号的情况 (} 或 ] 后面直接跟 { 或 ")
    cleaned = cleaned.replace(/}(\s*){/g, '},$1{');
    cleaned = cleaned.replace(/](\s*)\[/g, '],$1[');
    cleaned = cleaned.replace(/"(\s*)"/g, '",$1"');
    
    // 5. 修复属性名没有引号的情况
    cleaned = cleaned.replace(/(\{|\,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    
    // 6. 修复单引号为双引号
    cleaned = cleaned.replace(/'/g, '"');
    
    // 7. 移除控制字符
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ');
    
    // 8. 修复中文冒号
    cleaned = cleaned.replace(/：/g, ':');
    
    return cleaned.trim();
  }

  /**
   * 从 LLM 响应中提取文本内容
   */
  private extractContent(response: string | BaseMessage): string {
    if (typeof response === 'string') {
      return response;
    }
    if (response && typeof response === 'object' && 'content' in response) {
      return typeof response.content === 'string' ? response.content : '';
    }
    return '';
  }

  /**
   * Charge every textual LLM response before parsing it. Providers can ignore
   * requested structured-output limits, so downstream JSON repair must never
   * process an unbounded response.
   */
  private reserveProviderOutput(response: string | BaseMessage): void {
    const outputCharacters = this.extractContent(response).length;
    const nextOutputCharacterCount =
      this.providerOutputCharacterCount + outputCharacters;
    if (
      !Number.isSafeInteger(nextOutputCharacterCount)
      || nextOutputCharacterCount > this.config.maxProviderOutputCharacters
    ) {
      throw new EntityExtractionOutputBudgetError();
    }
    this.providerOutputCharacterCount = nextOutputCharacterCount;
  }

  /**
   * Validate and normalize the untrusted entity/relation arrays once. Raw
   * observations count against the task budget even when individual records
   * are malformed, preventing invalid-entry floods from bypassing admission.
   */
  private normalizeExtractionOutput(result: {
    entities: unknown[];
    relations: unknown[];
  }): {
    entities: Array<{ name: string; type: string; description: string }>;
    relations: Array<{ source: string; target: string; type: string; description: string }>;
  } {
    const nextEntityCount =
      this.extractedEntityObservationCount + result.entities.length;
    const nextRelationCount =
      this.extractedRelationObservationCount + result.relations.length;
    if (
      !Number.isSafeInteger(nextEntityCount)
      || !Number.isSafeInteger(nextRelationCount)
      || nextEntityCount > this.config.maxExtractedEntities
      || nextRelationCount > this.config.maxExtractedRelations
    ) {
      throw new EntityExtractionOutputBudgetError();
    }
    this.extractedEntityObservationCount = nextEntityCount;
    this.extractedRelationObservationCount = nextRelationCount;

    const entities: Array<{ name: string; type: string; description: string }> = [];
    for (const rawEntity of result.entities) {
      if (!isExtractionRecord(rawEntity)) continue;
      const name = this.normalizeExtractionString(
        rawEntity.name,
        ENTITY_EXTRACTION_FIELD_LIMITS.identifierCharacters,
        true
      );
      if (!name) continue;
      const type = this.normalizeExtractionString(
        rawEntity.type,
        ENTITY_EXTRACTION_FIELD_LIMITS.identifierCharacters,
        false
      ) || 'OTHER';
      const description = this.normalizeExtractionString(
        rawEntity.description,
        ENTITY_EXTRACTION_FIELD_LIMITS.descriptionCharacters,
        false
      ) || '';
      entities.push({
        name,
        type: type.toUpperCase(),
        description,
      });
    }

    const relations: Array<{
      source: string;
      target: string;
      type: string;
      description: string;
    }> = [];
    for (const rawRelation of result.relations) {
      if (!isExtractionRecord(rawRelation)) continue;
      const source = this.normalizeExtractionString(
        rawRelation.source,
        ENTITY_EXTRACTION_FIELD_LIMITS.identifierCharacters,
        true
      );
      const target = this.normalizeExtractionString(
        rawRelation.target,
        ENTITY_EXTRACTION_FIELD_LIMITS.identifierCharacters,
        true
      );
      if (!source || !target) continue;
      const type = this.normalizeExtractionString(
        rawRelation.type,
        ENTITY_EXTRACTION_FIELD_LIMITS.identifierCharacters,
        false
      ) || '相关';
      const description = this.normalizeExtractionString(
        rawRelation.description,
        ENTITY_EXTRACTION_FIELD_LIMITS.descriptionCharacters,
        false
      ) || '';
      relations.push({ source, target, type, description });
    }

    return { entities, relations };
  }

  private normalizeExtractionString(
    value: unknown,
    maxCharacters: number,
    required: boolean
  ): string | null {
    if (typeof value !== 'string') {
      return required ? null : '';
    }
    if (value.length > maxCharacters) {
      throw new EntityExtractionOutputBudgetError();
    }
    const normalized = value.trim();
    return normalized || (required ? null : '');
  }

  /**
   * Reserve the worst-case synchronous name/endpoint scans before aggregation.
   * This covers entity insertion against the current + preceding new entities,
   * then both endpoint lookups for every new relation.
   */
  private reserveAggregationLookupBudget(
    newEntityCount: number,
    newRelationCount: number,
    currentEntityCount: number
  ): void {
    const entityLookupComparisons =
      (newEntityCount * currentEntityCount)
      + ((newEntityCount * (newEntityCount - 1)) / 2);
    const relationLookupComparisons =
      2 * newRelationCount * (currentEntityCount + newEntityCount);
    const requestedComparisons =
      entityLookupComparisons + relationLookupComparisons;
    const nextComparisonCount =
      this.aggregationLookupComparisonCount + requestedComparisons;
    if (
      !Number.isSafeInteger(entityLookupComparisons)
      || !Number.isSafeInteger(relationLookupComparisons)
      || !Number.isSafeInteger(requestedComparisons)
      || !Number.isSafeInteger(nextComparisonCount)
      || nextComparisonCount > this.config.maxAggregationLookupComparisons
    ) {
      throw new EntityExtractionOutputBudgetError();
    }
    this.aggregationLookupComparisonCount = nextComparisonCount;
  }

  /**
   * 安全解析 JSON，带有多重回退策略
   */
  private safeParseJson(response: string | BaseMessage): { entities: unknown[]; relations: unknown[] } | null {
    const text = this.extractContent(response);
    // 尝试提取 JSON 对象
    const jsonMatches = text.match(/\{[\s\S]*\}/g);
    if (!jsonMatches) return null;

    // 尝试从最后一个匹配开始（通常是完整的 JSON）
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      const jsonStr = jsonMatches[i];
      
      // 策略 1: 直接解析
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object') {
          return {
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
            relations: Array.isArray(parsed.relations) ? parsed.relations : [],
          };
        }
      } catch {
        // 继续下一个策略
      }

      // 策略 2: 清理后解析
      try {
        const cleaned = this.cleanJsonString(jsonStr);
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object') {
          return {
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
            relations: Array.isArray(parsed.relations) ? parsed.relations : [],
          };
        }
      } catch {
        // 继续下一个策略
      }

      // 策略 3: 尝试修复截断的 JSON
      try {
        let fixedJson = this.cleanJsonString(jsonStr);
        
        // 计算括号平衡
        const openBraces = (fixedJson.match(/\{/g) || []).length;
        const closeBraces = (fixedJson.match(/\}/g) || []).length;
        const openBrackets = (fixedJson.match(/\[/g) || []).length;
        const closeBrackets = (fixedJson.match(/\]/g) || []).length;
        
        // 添加缺失的结束括号
        fixedJson += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
        fixedJson += '}'.repeat(Math.max(0, openBraces - closeBraces));
        
        const parsed = JSON.parse(fixedJson);
        if (parsed && typeof parsed === 'object') {
          return {
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
            relations: Array.isArray(parsed.relations) ? parsed.relations : [],
          };
        }
      } catch {
        // 继续尝试下一个匹配
      }
    }

    // 策略 4: 尝试分别提取 entities 和 relations 数组
    try {
      const entitiesMatch = text.match(/"entities"\s*:\s*\[([\s\S]*?)\]/);
      const relationsMatch = text.match(/"relations"\s*:\s*\[([\s\S]*?)\]/);
      
      let entities: unknown[] = [];
      let relations: unknown[] = [];
      
      if (entitiesMatch) {
        try {
          entities = JSON.parse(`[${this.cleanJsonString(entitiesMatch[1])}]`);
        } catch {
          entities = [];
        }
      }
      
      if (relationsMatch) {
        try {
          relations = JSON.parse(`[${this.cleanJsonString(relationsMatch[1])}]`);
        } catch {
          relations = [];
        }
      }
      
      if (entities.length > 0 || relations.length > 0) {
        return { entities, relations };
      }
    } catch {
      // 所有策略都失败
    }

    return null;
  }

  private parseCompleteExtraction(response: string | BaseMessage): { entities: unknown[]; relations: unknown[] } | null {
    const text = this.extractContent(response).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (!isExtractionRecord(parsed) || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) return null;
    const validFields = (item: unknown, required: readonly string[]) =>
      isExtractionRecord(item)
      && required.every(key => typeof item[key] === 'string' && (key === 'description' || Boolean((item[key] as string).trim())));
    if (!parsed.entities.every(item => validFields(item, ['name', 'type', 'description']))
      || !parsed.relations.every(item => validFields(item, ['source', 'target', 'type', 'description']))) return null;
    const names = new Set(parsed.entities.map(item => (item as { name: string }).name.trim().toLowerCase()));
    if (parsed.relations.some(item => {
      const relation = item as { source: string; target: string };
      return !names.has(relation.source.trim().toLowerCase()) || !names.has(relation.target.trim().toLowerCase());
    })) return null;
    return { entities: parsed.entities, relations: parsed.relations };
  }

  /** Split only incomplete outputs; every successful leaf retains its parent evidence. */
  private async extractFromChunk(chunk: TextChunk, totalChunks: number): Promise<EntityExtractionSegmentResult> {
    if (!this.config.adaptiveChunkSplitting) return this.extractOneSegment(chunk);
    const minimum = this.config.minAdaptiveChunkCharacters ?? 256;
    const visit = async (start: number, end: number): Promise<EntityExtractionSegmentResult> => {
      this.checkTimeout();
      const content = chunk.content.slice(start, end);
      const segment: EntityExtractionSegment = {
        key: `${chunk.index}:${start}:${end}`,
        sourceDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        progress: Math.min(0.75, 0.75 * (chunk.index + end / chunk.content.length) / totalChunks),
      };
      const cached = await this.checkpoint?.load(segment);
      this.checkTimeout();
      if (cached?.kind === 'complete') {
        const encoded = JSON.stringify(cached.result);
        this.reserveProviderOutput(encoded);
        const parsed = this.parseCompleteExtraction(encoded);
        if (!parsed) throw new Error('已保存的图谱抽取结果无效。');
        return this.normalizeExtractionOutput(parsed);
      }

      const split = async (): Promise<EntityExtractionSegmentResult> => {
        if (content.length < minimum * 2) throw new EntityExtractionTruncatedError();
        let middle = start + Math.floor(content.length / 2);
        // Never separate a UTF-16 surrogate pair across model requests.
        const previous = chunk.content.charCodeAt(middle - 1);
        const next = chunk.content.charCodeAt(middle);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) middle += 1;
        if (middle <= start || middle >= end) throw new EntityExtractionTruncatedError();
        // Small overlaps retain relationships that cross the split boundary.
        const overlap = Math.min(150, Math.floor(content.length / 16));
        let leftEnd = Math.min(end, middle + overlap);
        let rightStart = Math.max(start, middle - overlap);
        const splitsSurrogate = (position: number) => {
          const before = chunk.content.charCodeAt(position - 1);
          const after = chunk.content.charCodeAt(position);
          return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
        };
        if (splitsSurrogate(leftEnd)) leftEnd += 1;
        if (splitsSurrogate(rightStart)) rightStart -= 1;
        const left = await visit(start, leftEnd);
        const right = await visit(rightStart, end);
        return { entities: [...left.entities, ...right.entities], relations: [...left.relations, ...right.relations] };
      };

      if (cached?.kind === 'split') return split();
      try {
        const result = await this.extractOneSegment({ ...chunk, content });
        this.checkTimeout();
        await this.checkpoint?.save(segment, { kind: 'complete', result });
        return result;
      } catch (error) {
        if (error instanceof EntityExtractionInvalidOutputError && content.length < minimum * 2) {
          // A small fragment can still contain several related entities. Ask
          // for one complete consistency pass instead of dropping dangling
          // relations or weakening the same strict output validator.
          const result = await this.extractOneSegment({ ...chunk, content }, true);
          this.checkTimeout();
          await this.checkpoint?.save(segment, { kind: 'complete', result });
          return result;
        }
        const maySplit = error instanceof EntityExtractionTruncatedError
          || error instanceof EntityExtractionInvalidOutputError
          || error instanceof EntityExtractionProviderTimeoutError;
        if (!maySplit || content.length < minimum * 2) throw error;
        this.reportProgress({
          stage: 'extracting',
          current: chunk.index + start / chunk.content.length,
          total: totalChunks,
          message: `第 ${chunk.index + 1}/${totalChunks} 个文本块输出不完整，正在拆分为更小片段重试...`,
        });
        // Persist the decision before its children so a retry does not repeat the failed parent.
        await this.checkpoint?.save({
          ...segment,
          progress: Math.min(0.75, 0.75 * (chunk.index + start / chunk.content.length) / totalChunks),
        }, { kind: 'split' });
        // A provider may ignore abort; preserve the split but never overlap its orphaned request.
        if (!await this.waitForTimedOutProviderSettlement()) throw error;
        this.checkTimeout();
        return split();
      }
    };
    return visit(0, chunk.content.length);
  }

  /** 从单个片段中提取实体和关系 */
  private async extractOneSegment(chunk: TextChunk, recheckConsistency = false): Promise<EntityExtractionSegmentResult> {
    // 检查是否已中止
    if (this.aborted) {
      throw new Error('抽取任务已被中止');
    }

    const prompt = ENTITY_EXTRACTION_PROMPT.replace('{text}', () => chunk.content)
      + (recheckConsistency ? ENTITY_EXTRACTION_CONSISTENCY_INSTRUCTIONS : '');
    const chunkTimeout = this.getOperationTimeout(this.calculateChunkTimeout(chunk.content.length));
    
    try {
      // 使用超时包装 LLM 调用
      const response = await this.withTimeout(
        signal => this.extractionLlm.invoke(prompt, { signal }),
        chunkTimeout,
        `单块提取超时 (${Math.round(chunkTimeout / 1000)}秒)`,
        prompt.length
      );
      this.reserveProviderOutput(response);
      if (this.config.adaptiveChunkSplitting && typeof response !== 'string'
        && response.response_metadata?.done_reason === 'length') {
        throw new EntityExtractionTruncatedError();
      }
      
      // 使用安全的 JSON 解析
      const result = this.config.requireCompleteExtraction
        ? this.parseCompleteExtraction(response)
        : this.safeParseJson(response);
      
      if (result) {
        const {
          entities: validEntities,
          relations: validRelations,
        } = this.normalizeExtractionOutput(result);

        console.log(`[EntityExtractor] 提取 ${validEntities.length} 实体, ${validRelations.length} 关系`);
        
        return {
          entities: validEntities,
          relations: validRelations,
        };
      }
      
      if (this.config.requireCompleteExtraction && this.config.adaptiveChunkSplitting) {
        throw new EntityExtractionInvalidOutputError();
      }
      if (this.config.requireCompleteExtraction) throw new Error('模型输出无法解析。');
      console.warn('[EntityExtractor] 无法解析 JSON，跳过当前块');
    } catch (error) {
      if (isEntityExtractionFatalError(error)) {
        throw error;
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        // Some providers enforce their own request deadline before our wrapper
        // fires. Normalize that native timeout so callers retry instead of
        // accepting a silently empty graph as a successful extraction.
        throw new EntityExtractionProviderTimeoutError(
          'Entity extraction provider request timed out.'
        );
      }
      if (this.config.requireCompleteExtraction) {
        throw new Error('文本块抽取失败，请检查模型服务和输出。', { cause: error });
      }
      if (error instanceof Error && error.message.includes('超时')) {
        console.warn(
          '[EntityExtractor] chunk extraction timed out',
          createStableErrorLog(error)
        );
      } else {
        console.error(
          '[EntityExtractor] chunk extraction failed',
          createStableErrorLog(error)
        );
      }
    }

    return { entities: [], relations: [] };
  }

  /** Gleaning: 二次检查遗漏 */
  private async performGleaning(
    chunk: TextChunk,
    initialExtraction: { entities: Array<{ name: string; type: string; description: string }>; relations: Array<{ source: string; target: string; type: string; description: string }> },
    entities: Map<string, Entity>,
    relations: Map<string, Relation>
  ): Promise<void> {
    this.reportProgress({
      stage: 'gleaning',
      current: 0,
      total: this.config.gleaningRounds,
      message: '正在进行二次检查 (Gleaning)...',
    });

    for (let round = 0; round < this.config.gleaningRounds; round++) {
      const existingEntities = initialExtraction.entities
        .map(e => `- ${e.name} (${e.type}): ${e.description}`)
        .join('\n');
      const existingRelations = initialExtraction.relations
        .map(r => `- ${r.source} --[${r.type}]--> ${r.target}: ${r.description}`)
        .join('\n');

      const prompt = GLEANING_PROMPT
        .replace('{text}', () => chunk.content)
        .replace('{existingEntities}', () => existingEntities || '无')
        .replace('{existingRelations}', () => existingRelations || '无');

      try {
        const gleaningTimeout = this.getOperationTimeout(this.calculateChunkTimeout(chunk.content.length));
        const response = await this.withTimeout(
          signal => this.llm.invoke(prompt, { signal }),
          gleaningTimeout,
          `Gleaning 超时 (${Math.round(gleaningTimeout / 1000)}秒)`,
          prompt.length
        );
        this.reserveProviderOutput(response);
        
        // 使用安全的 JSON 解析
        const parsed = this.safeParseJson(response);
        
        if (parsed) {
          const gleaned = this.normalizeExtractionOutput(parsed);
          this.reserveAggregationLookupBudget(
            gleaned.entities.length,
            gleaned.relations.length,
            entities.size
          );
          // 合并新发现的实体
          for (const entity of gleaned.entities) {
              const existingId = this.findSimilarEntity(entity.name, entities);
              if (!existingId) {
                const entityId = `entity_${entities.size}_${Date.now()}`;
                entities.set(entityId, {
                  id: entityId,
                  name: entity.name,
                  type: entity.type as EntityType,
                  description: entity.description,
                  aliases: [entity.name],
                  mentions: 1,
                  sourceChunks: [chunk.id],
                });
                initialExtraction.entities.push(entity);
              }
            }

          // 合并新发现的关系
          for (const relation of gleaned.relations) {
              const sourceId = this.findEntityByName(relation.source, entities);
              const targetId = this.findEntityByName(relation.target, entities);
              
              if (sourceId && targetId) {
                const relationId = `relation_${relations.size}_${Date.now()}`;
                relations.set(relationId, {
                  id: relationId,
                  source: sourceId,
                  target: targetId,
                  type: relation.type,
                  description: relation.description,
                  weight: 0.8, // Gleaning 发现的关系权重稍低
                  sourceChunks: [chunk.id],
                });
                initialExtraction.relations.push({
                  source: relation.source,
                  target: relation.target,
                  type: relation.type,
                  description: relation.description,
                });
              }
            }
        }
      } catch (error) {
        if (isEntityExtractionFatalError(error)) {
          throw error;
        }
        console.error('[EntityExtractor] gleaning failed', createStableErrorLog(error));
      }
    }
  }

  /** 查找相似实体（通过名称） */
  private findSimilarEntity(name: string, entities: Map<string, Entity>): string | null {
    const normalizedName = name.toLowerCase().trim();
    
    for (const [id, entity] of entities) {
      // 精确匹配
      if (entity.name.toLowerCase().trim() === normalizedName) {
        return id;
      }
      // 别名匹配
      for (const alias of entity.aliases) {
        if (alias.toLowerCase().trim() === normalizedName) {
          return id;
        }
      }
      // 包含关系（处理简称）
      if (entity.name.toLowerCase().includes(normalizedName) || 
          normalizedName.includes(entity.name.toLowerCase())) {
        if (Math.abs(entity.name.length - name.length) < 5) {
          return id;
        }
      }
    }
    return null;
  }

  /** 通过名称查找实体ID */
  private findEntityByName(name: string, entities: Map<string, Entity>): string | null {
    return this.findSimilarEntity(name, entities);
  }

  /**
   * 步骤3: 实体合并（解决别名问题）
   */
  async resolveEntities(
    entities: Map<string, Entity>,
    relations: Map<string, Relation>
  ): Promise<void> {
    this.reportProgress({
      stage: 'resolving',
      current: 0,
      total: 1,
      message: '正在进行实体消歧与合并...',
    });

    const entityArray = Array.from(entities.values());
    const mergeMap = new Map<string, string>(); // oldId -> newId
    if (entityArray.length === 0) return;
    if (entityArray.length > this.config.maxExtractedEntities) {
      throw new EntityExtractionOutputBudgetError();
    }
    const comparisonCount =
      (entityArray.length * (entityArray.length - 1)) / 2;
    if (
      !Number.isSafeInteger(comparisonCount)
      || comparisonCount > this.config.maxEntityResolutionComparisons
    ) {
      throw new EntityExtractionOutputBudgetError();
    }

    // 计算实体嵌入
    const entityTexts = entityArray.map(e => `${e.name}: ${e.description}`);
    const embeddingTimeout = this.getOperationTimeout(
      Math.min(this.config.embeddingTimeoutMs ?? 30_000, this.config.maxChunkTimeout)
    );
    const entityEmbeddings: number[][] = [];
    const batchSize = this.config.embeddingBatchSize ?? entityTexts.length;
    for (let offset = 0; offset < entityTexts.length; offset += batchSize) {
      const batch = entityTexts.slice(offset, offset + batchSize);
      const vectors = await this.withTimeout(
        () => this.embeddings.embedDocuments(batch),
        this.getOperationTimeout(embeddingTimeout),
        `实体嵌入超时 (${Math.round(embeddingTimeout / 1000)}秒)`,
        countProviderInputCharacters(batch),
        this.embeddingAdmissionKey
      );
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new EntityExtractionOutputBudgetError();
      }
      entityEmbeddings.push(...vectors);
      this.checkTimeout();
    }
    this.checkTimeout();

    if (
      !Array.isArray(entityEmbeddings)
      || entityEmbeddings.length !== entityArray.length
    ) {
      throw new EntityExtractionOutputBudgetError();
    }
    let embeddingDimensions: number | undefined;
    for (const rawEmbedding of entityEmbeddings) {
      const embedding = this.validateEmbeddingVector(
        rawEmbedding,
        embeddingDimensions
      );
      if (embeddingDimensions === undefined) {
        embeddingDimensions = embedding.length;
      }
    }
    const vectorOperations = comparisonCount * (embeddingDimensions ?? 0);
    if (
      !Number.isSafeInteger(vectorOperations)
      || vectorOperations > this.config.maxEntityResolutionVectorOperations
    ) {
      throw new EntityExtractionOutputBudgetError();
    }

    for (let i = 0; i < entityArray.length; i++) {
      entityArray[i].embedding = entityEmbeddings[i];
    }

    // 找出潜在的重复实体对
    const candidates: Array<[Entity, Entity, number]> = [];
    let processedComparisons = 0;

    for (let i = 0; i < entityArray.length; i++) {
      for (let j = i + 1; j < entityArray.length; j++) {
        processedComparisons += 1;
        if (processedComparisons % 1_024 === 0) {
          this.checkTimeout();
          await new Promise<void>(resolve => setImmediate(resolve));
          this.checkTimeout();
        }
        const entity1 = entityArray[i];
        const entity2 = entityArray[j];
        
        // 类型兼容性检查
        if (entity1.type !== entity2.type && entity1.type !== 'OTHER' && entity2.type !== 'OTHER') {
          continue;
        }

        // 计算相似度
        const similarity = this.cosineSimilarity(
          entity1.embedding!,
          entity2.embedding!
        );

        if (similarity > this.config.similarityThreshold) {
          candidates.push([entity1, entity2, similarity]);
        }
      }
    }
    this.checkTimeout();

    // 使用 LLM 确认合并
    for (const [entity1, entity2] of candidates) {
      this.checkTimeout();

      if (mergeMap.has(entity1.id) || mergeMap.has(entity2.id)) {
        continue; // 已经被合并过
      }

      const shouldMerge = await this.confirmMerge(entity1, entity2);
      
      if (shouldMerge) {
        // 将 entity2 合并到 entity1
        entity1.aliases.push(entity2.name, ...entity2.aliases);
        entity1.aliases = [...new Set(entity1.aliases)];
        entity1.mentions += entity2.mentions;
        entity1.sourceChunks.push(...entity2.sourceChunks);
        entity1.sourceChunks = [...new Set(entity1.sourceChunks)];
        
        if (entity2.description.length > entity1.description.length) {
          entity1.description = entity2.description;
        }

        mergeMap.set(entity2.id, entity1.id);
      }
    }

    // 更新关系引用
    for (const [, relation] of relations) {
      if (mergeMap.has(relation.source)) {
        relation.source = mergeMap.get(relation.source)!;
      }
      if (mergeMap.has(relation.target)) {
        relation.target = mergeMap.get(relation.target)!;
      }
    }

    // 删除已合并的实体
    for (const oldId of mergeMap.keys()) {
      entities.delete(oldId);
    }

    // 删除自引用关系
    for (const [id, relation] of relations) {
      if (relation.source === relation.target) {
        relations.delete(id);
      }
    }

    this.reportProgress({
      stage: 'resolving',
      current: 1,
      total: 1,
      message: `实体消歧完成，合并了 ${mergeMap.size} 个重复实体`,
      details: { mergedCount: mergeMap.size },
    });
  }

  /** 使用 LLM 确认是否合并 */
  private async confirmMerge(entity1: Entity, entity2: Entity): Promise<boolean> {
    // 快速规则判断
    const name1 = entity1.name.toLowerCase();
    const name2 = entity2.name.toLowerCase();
    
    // 明显的包含关系
    if (name1.includes(name2) || name2.includes(name1)) {
      return true;
    }

    // 首字母缩写检查
    const initials1 = name1.split(/\s+/).map(w => w[0]).join('');
    const initials2 = name2.split(/\s+/).map(w => w[0]).join('');
    if (initials1 === name2 || initials2 === name1) {
      return true;
    }

    // 使用 LLM 判断复杂情况
    try {
      const prompt = ENTITY_RESOLUTION_PROMPT
        .replace('{entity1}', () => entity1.name)
        .replace('{type1}', () => entity1.type)
        .replace('{desc1}', () => entity1.description)
        .replace('{entity2}', () => entity2.name)
        .replace('{type2}', () => entity2.type)
        .replace('{desc2}', () => entity2.description)
        .replace('{context}', '无额外上下文');

      const mergeTimeout = this.getOperationTimeout(Math.min(this.config.llmOperationTimeoutMs ?? 15_000, this.config.maxChunkTimeout));
      const response = await this.withTimeout(
        signal => this.llm.invoke(prompt, { signal }),
        mergeTimeout,
        `实体消歧超时 (${Math.round(mergeTimeout / 1000)}秒)`,
        prompt.length
      );
      this.reserveProviderOutput(response);
      const parsed = this.safeParseJsonGeneric(response);
      
      if (parsed && typeof parsed === 'object') {
        const result = parsed as { isSameEntity?: boolean; confidence?: number };
        return result.isSameEntity === true && (result.confidence || 0) > 0.7;
      }
    } catch (error) {
      if (isEntityExtractionFatalError(error)) {
        throw error;
      }
      console.error('[EntityExtractor] entity resolution failed', createStableErrorLog(error));
    }

    return false;
  }

  /**
   * 通用的安全 JSON 解析，带有多重回退策略
   */
  private safeParseJsonGeneric(response: string | BaseMessage): Record<string, unknown> | null {
    const text = this.extractContent(response);
    // 尝试提取 JSON 对象
    const jsonMatches = text.match(/\{[\s\S]*\}/g);
    if (!jsonMatches) return null;

    // 尝试从最后一个匹配开始（通常是完整的 JSON）
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      const jsonStr = jsonMatches[i];
      
      // 策略 1: 直接解析
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // 继续下一个策略
      }

      // 策略 2: 清理后解析
      try {
        const cleaned = this.cleanJsonString(jsonStr);
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // 继续下一个策略
      }

      // 策略 3: 尝试修复截断的 JSON
      try {
        let fixedJson = this.cleanJsonString(jsonStr);
        
        // 计算括号平衡
        const openBraces = (fixedJson.match(/\{/g) || []).length;
        const closeBraces = (fixedJson.match(/\}/g) || []).length;
        const openBrackets = (fixedJson.match(/\[/g) || []).length;
        const closeBrackets = (fixedJson.match(/\]/g) || []).length;
        
        // 添加缺失的结束括号
        fixedJson += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
        fixedJson += '}'.repeat(Math.max(0, openBraces - closeBraces));
        
        const parsed = JSON.parse(fixedJson);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // 继续尝试下一个匹配
      }
    }

    // 策略 4: 尝试提取特定字段
    try {
      const result: Record<string, unknown> = {};
      
      // 提取 isSameEntity 字段
      const sameEntityMatch = text.match(/["']?isSameEntity["']?\s*:\s*(true|false)/i);
      if (sameEntityMatch) {
        result.isSameEntity = sameEntityMatch[1].toLowerCase() === 'true';
      }
      
      // 提取 confidence 字段
      const confidenceMatch = text.match(/["']?confidence["']?\s*:\s*([\d.]+)/);
      if (confidenceMatch) {
        result.confidence = parseFloat(confidenceMatch[1]);
      }
      
      // 提取 name 字段
      const nameMatch = text.match(/["']?name["']?\s*:\s*["']([^"']+)["']/);
      if (nameMatch) {
        result.name = nameMatch[1];
      }
      
      // 提取 summary 字段
      const summaryMatch = text.match(/["']?summary["']?\s*:\s*["']([^"']+)["']/);
      if (summaryMatch) {
        result.summary = summaryMatch[1];
      }
      
      // 提取 keywords 字段
      const keywordsMatch = text.match(/["']?keywords["']?\s*:\s*\[([^\]]*)\]/);
      if (keywordsMatch) {
        try {
          result.keywords = JSON.parse(`[${keywordsMatch[1]}]`);
        } catch {
          // 尝试手动提取
          const keywords = keywordsMatch[1].match(/["']([^"']+)["']/g);
          if (keywords) {
            result.keywords = keywords.map(k => k.replace(/["']/g, ''));
          }
        }
      }
      
      if (Object.keys(result).length > 0) {
        return result;
      }
    } catch {
      // 所有策略都失败
    }

    return null;
  }

  /** 计算余弦相似度 */
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) return 0;
    
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }
    
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  private validateEmbeddingVector(
    value: unknown,
    expectedDimensions?: number
  ): number[] {
    if (
      !Array.isArray(value)
      || value.length < 1
      || value.length > this.config.maxEmbeddingDimensions
      || (expectedDimensions !== undefined && value.length !== expectedDimensions)
      || value.some(item => typeof item !== 'number' || !Number.isFinite(item))
    ) {
      throw new EntityExtractionOutputBudgetError();
    }
    return value;
  }

  /**
   * 步骤4: 社区发现与摘要
   */
  async buildCommunities(
    entities: Map<string, Entity>,
    relations: Map<string, Relation>
  ): Promise<Map<string, Community>> {
    this.reportProgress({
      stage: 'community',
      current: 0,
      total: 1,
      message: '正在进行社区发现...',
    });

    const communities = new Map<string, Community>();
    
    // 构建邻接表
    const adjacency = new Map<string, Set<string>>();
    for (const entity of entities.keys()) {
      adjacency.set(entity, new Set());
    }
    
    for (const relation of relations.values()) {
      adjacency.get(relation.source)?.add(relation.target);
      adjacency.get(relation.target)?.add(relation.source);
    }

    // 简单的连通分量社区发现
    const visited = new Set<string>();
    let communityIndex = 0;

    for (const entityId of entities.keys()) {
      if (visited.has(entityId)) continue;

      // BFS 找连通分量
      const queue = [entityId];
      const communityMembers: string[] = [];
      
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        
        visited.add(current);
        communityMembers.push(current);
        
        const neighbors = adjacency.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }

      if (communityMembers.length > 0) {
        // 找出社区内的关系
        const communityRelations: string[] = [];
        for (const [relId, relation] of relations) {
          if (communityMembers.includes(relation.source) && 
              communityMembers.includes(relation.target)) {
            communityRelations.push(relId);
          }
        }

        const communityId = `community_${communityIndex++}`;
        communities.set(communityId, {
          id: communityId,
          name: '', // 稍后填充
          entities: communityMembers,
          relations: communityRelations,
          summary: '', // 稍后填充
          keywords: [],
          level: 0,
        });
      }
    }

    // 生成社区摘要
    this.reportProgress({
      stage: 'summarizing',
      current: 0,
      total: communities.size,
      message: '正在生成社区摘要...',
    });

    const batchEmbeddings = this.config.batchCommunityEmbeddings === true;
    const pendingEmbeddings: Array<{ community: Community; index: number }> = [];
    const applyFallbackSummary = (community: Community, index: number) => {
      community.name = `社区 ${index + 1}`;
      community.summary = `包含 ${community.entities.length} 个实体的社区`;
      community.keywords = [];
    };
    let summarized = 0;
    for (const community of communities.values()) {
      this.checkTimeout();

      try {
        const summary = await this.generateCommunitySummary(community, entities, relations);
        community.name = summary.name;
        community.summary = summary.summary;
        community.keywords = summary.keywords;

        if (batchEmbeddings) {
          pendingEmbeddings.push({ community, index: summarized });
        } else {
          const embeddingTimeout = this.getOperationTimeout(
            Math.min(this.config.embeddingTimeoutMs ?? 30_000, this.config.maxChunkTimeout)
          );
          const embedding = await this.withTimeout(
            () => this.embeddings.embedQuery(summary.summary),
            embeddingTimeout,
            `社区嵌入超时 (${Math.round(embeddingTimeout / 1000)}秒)`,
            countProviderInputCharacters([summary.summary]),
            this.embeddingAdmissionKey
          );
          community.embedding = this.validateEmbeddingVector(embedding);
        }

      } catch (error) {
        if (isEntityExtractionFatalError(error)) {
          throw error;
        }
        console.error(
          '[EntityExtractor] community summary generation failed',
          createStableErrorLog(error)
        );
        applyFallbackSummary(community, summarized);
      }

      summarized++;
      this.reportProgress({
        stage: 'summarizing',
        current: summarized,
        total: communities.size,
        message: `正在生成社区摘要 ${summarized}/${communities.size}...`,
      });
      this.checkTimeout();
    }

    // On a shared GPU, alternating these providers for every community can
    // repeatedly evict the model. Preserve summary order while switching once.
    const batchSize = this.config.embeddingBatchSize ?? 32;
    let dimensions: number | undefined;
    for (let offset = 0; offset < pendingEmbeddings.length; offset += batchSize) {
      this.checkTimeout();
      const batch = pendingEmbeddings.slice(offset, offset + batchSize);
      const texts = batch.map(({ community }) => community.summary);
      this.reportProgress({ stage: 'summarizing', current: communities.size, total: communities.size,
        message: `正在生成社区摘要嵌入 ${offset}/${pendingEmbeddings.length}...` });
      try {
        const embeddingTimeout = this.getOperationTimeout(
          Math.min(this.config.embeddingTimeoutMs ?? 30_000, this.config.maxChunkTimeout)
        );
        const embeddings = await this.withTimeout(
          () => this.embeddings.embedDocuments(texts), embeddingTimeout,
          `社区嵌入超时 (${Math.round(embeddingTimeout / 1000)}秒)`,
          countProviderInputCharacters(texts), this.embeddingAdmissionKey
        );
        if (!Array.isArray(embeddings) || embeddings.length !== batch.length) throw new EntityExtractionOutputBudgetError();
        const validated = embeddings.map(value => {
          const vector = this.validateEmbeddingVector(value, dimensions);
          dimensions ??= vector.length;
          return vector;
        });
        batch.forEach(({ community }, index) => { community.embedding = validated[index]; });
      } catch (error) {
        if (isEntityExtractionFatalError(error)) throw error;
        console.error('[EntityExtractor] community embedding batch failed', createStableErrorLog(error));
        batch.forEach(({ community, index }) => applyFallbackSummary(community, index));
      }
      this.checkTimeout();
    }

    return communities;
  }

  /** 生成社区摘要 */
  private async generateCommunitySummary(
    community: Community,
    entities: Map<string, Entity>,
    relations: Map<string, Relation>
  ): Promise<{ name: string; summary: string; keywords: string[] }> {
    // 准备实体信息
    const entityInfos = community.entities
      .map(id => {
        const entity = entities.get(id);
        return entity ? `- ${entity.name} (${entity.type}): ${entity.description}` : null;
      })
      .filter(Boolean)
      .join('\n');

    // 准备关系信息
    const relationInfos = community.relations
      .map(id => {
        const relation = relations.get(id);
        if (!relation) return null;
        const source = entities.get(relation.source);
        const target = entities.get(relation.target);
        return source && target 
          ? `- ${source.name} --[${relation.type}]--> ${target.name}: ${relation.description}`
          : null;
      })
      .filter(Boolean)
      .join('\n');

    const prompt = COMMUNITY_SUMMARY_PROMPT
      .replace('{entities}', () => entityInfos || '无')
      .replace('{relations}', () => relationInfos || '无');

    try {
      const summaryTimeout = this.getOperationTimeout(Math.min(this.config.llmOperationTimeoutMs ?? 20_000, this.config.maxChunkTimeout));
      const response = await this.withTimeout(
        signal => this.llm.invoke(prompt, { signal }),
        summaryTimeout,
        `社区摘要超时 (${Math.round(summaryTimeout / 1000)}秒)`,
        prompt.length
      );
      this.reserveProviderOutput(response);
      const parsed = this.safeParseJsonGeneric(response);
      
      if (parsed) {
        return {
          name: (parsed.name as string) || '未命名社区',
          summary: (parsed.summary as string) || '暂无摘要',
          keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as string[]) : [],
        };
      }
    } catch (error) {
      if (isEntityExtractionFatalError(error)) {
        throw error;
      }
      console.error(
        '[EntityExtractor] community summary parsing failed',
        createStableErrorLog(error)
      );
    }

    return {
      name: '未命名社区',
      summary: '暂无摘要',
      keywords: [],
    };
  }

  /**
   * 完整抽取流程
   */
  async extract(text: string, documentId: string): Promise<KnowledgeGraph> {
    // 初始化超时控制
    this.startTime = Date.now();
    this.aborted = false;
    this.providerCallCount = 0;
    this.providerInputCharacterCount = 0;
    this.providerOutputCharacterCount = 0;
    this.extractedEntityObservationCount = 0;
    this.extractedRelationObservationCount = 0;
    this.aggregationLookupComparisonCount = 0;
    
    // 预估切片数量用于计算超时
    const estimatedChunkCount = Math.ceil(text.length / this.config.chunkSize);
    this.estimatedTimeout = this.calculateTimeout(text.length, estimatedChunkCount);
    
    console.log(`[EntityExtractor] 开始抽取任务`, {
      textLength: text.length,
      estimatedChunks: estimatedChunkCount,
      estimatedTimeoutSeconds: Math.round(this.estimatedTimeout / 1000),
      estimatedTimeoutMinutes: (this.estimatedTimeout / 60000).toFixed(1),
      model: this.config.llmModel,
    });

    this.reportProgress({
      stage: 'chunking',
      current: 0,
      total: 1,
      message: `正在初始化... (预计最长 ${Math.round(this.estimatedTimeout / 60000)} 分钟)`,
      details: {
        estimatedTimeout: this.estimatedTimeout,
        textLength: text.length,
      },
    });

    try {
      // 1. 智能切分 (快速操作，不需要超时)
      const chunks = await this.chunkDocument(text, documentId);
      const chunksMap = new Map(chunks.map(c => [c.id, c]));
      
      // 根据实际切片数量重新计算超时
      if (chunks.length !== estimatedChunkCount) {
        this.estimatedTimeout = this.calculateTimeout(text.length, chunks.length);
        console.log(`[EntityExtractor] 根据实际切片数重新计算超时: ${Math.round(this.estimatedTimeout / 1000)} 秒`);
      }
      
      this.checkTimeout();

      // 2. 实体/关系提取 (最耗时的操作)
      const { entities, relations } = await this.extractEntitiesAndRelations(chunks);
      
      this.checkTimeout();

      // 3. 实体合并
      await this.resolveEntities(entities, relations);
      
      this.checkTimeout();

      // 4. 社区发现与摘要
      const communities = await this.buildCommunities(entities, relations);

      const duration = Date.now() - this.startTime;
      
      this.reportProgress({
        stage: 'completed',
        current: 1,
        total: 1,
        message: `抽取完成！用时 ${Math.round(duration / 1000)} 秒`,
        details: {
          entityCount: entities.size,
          relationCount: relations.size,
          communityCount: communities.size,
          duration,
          estimatedTimeout: this.estimatedTimeout,
          timeUsedPercent: Math.round((duration / this.estimatedTimeout) * 100),
        },
      });

      console.log(`[EntityExtractor] 抽取完成`, {
        duration: `${Math.round(duration / 1000)} 秒`,
        entityCount: entities.size,
        relationCount: relations.size,
        communityCount: communities.size,
        timeUsedPercent: `${Math.round((duration / this.estimatedTimeout) * 100)}%`,
      });

      return {
        entities,
        relations,
        communities,
        chunks: chunksMap,
        metadata: {
          documentId,
          createdAt: new Date(),
          entityCount: entities.size,
          relationCount: relations.size,
          communityCount: communities.size,
        },
      };
    } catch (error) {
      const duration = Date.now() - this.startTime;
      console.error(
        `[EntityExtractor] extraction failed after ${Math.round(duration / 1000)} seconds`,
        createStableErrorLog(error)
      );
      throw error;
    }
  }

  /**
   * 将知识图谱转换为可序列化格式
   */
  static serializeGraph(graph: KnowledgeGraph): {
    entities: Entity[];
    relations: Relation[];
    communities: Community[];
    chunks: TextChunk[];
    metadata: KnowledgeGraph['metadata'];
  } {
    return {
      entities: Array.from(graph.entities.values()),
      relations: Array.from(graph.relations.values()),
      communities: Array.from(graph.communities.values()),
      chunks: Array.from(graph.chunks.values()),
      metadata: graph.metadata,
    };
  }

  /**
   * 从序列化格式恢复知识图谱
   */
  static deserializeGraph(data: {
    entities: Entity[];
    relations: Relation[];
    communities: Community[];
    chunks: TextChunk[];
    metadata: KnowledgeGraph['metadata'];
  }): KnowledgeGraph {
    return {
      entities: new Map(data.entities.map(e => [e.id, e])),
      relations: new Map(data.relations.map(r => [r.id, r])),
      communities: new Map(data.communities.map(c => [c.id, c])),
      chunks: new Map(data.chunks.map(c => [c.id, c])),
      metadata: data.metadata,
    };
  }
}

function countProviderInputCharacters(values: readonly string[]): number {
  let total = 0;
  for (const value of values) {
    total += value.length;
    if (!Number.isSafeInteger(total)) {
      throw new EntityExtractionProviderBudgetError();
    }
  }
  return total;
}

function isExtractionRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createEmbeddingAdmissionKey(
  provider: string,
  model: string,
  baseUrl: string
): string {
  const digest = createHash('sha256')
    .update(provider)
    .update('\0')
    .update(model)
    .update('\0')
    .update(baseUrl)
    .digest('hex');
  return `entity-extraction:embedding:${digest}`;
}

// ==================== 导出 ====================

export default EntityExtractor;
