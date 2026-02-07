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

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { createLLM, createEmbedding, getModelFactory, getConfigSummary } from "./model-config";
import { getEmbeddingConfigSummary } from "./embedding-config";

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
  baseChunkTime: number;     // 单块基础处理时间（毫秒），默认 10 秒
  timeoutPerChar: number;    // 每字符额外时间（毫秒），默认 20ms
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
  ABSOLUTE_MAX_TIMEOUT: 30 * 60 * 1000,  // 绝对最大 30 分钟
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
    baseChunkTime: 10 * 1000,          // 基础 10 秒/块
    timeoutPerChar: 20,                // 每字符 20ms
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
  baseChunkTime: 10 * 1000,
  timeoutPerChar: 20,
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
请严格按照以下 JSON 格式输出，不要添加任何其他内容：
{{
  "entities": [
    {{"name": "实体名称", "type": "PERSON|ORGANIZATION|LOCATION|EVENT|CONCEPT|PRODUCT|DATE|OTHER", "description": "实体描述"}}
  ],
  "relations": [
    {{"source": "源实体名称", "target": "目标实体名称", "type": "关系类型", "description": "关系描述"}}
  ]
}}`;

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
  private llm: BaseChatModel;
  private embeddings: Embeddings;
  private progressCallback?: (progress: ExtractionProgress) => void;
  
  // 超时控制
  private startTime: number = 0;
  private estimatedTimeout: number = 0;
  private aborted: boolean = false;

  constructor(config: Partial<ExtractionConfig> = {}) {
    // 使用动态获取的默认配置，确保使用正确的模型名
    const defaultConfig = getDefaultExtractionConfig();
    this.config = { ...defaultConfig, ...config };
    
    // 使用统一模型配置系统
    // 如果没有指定模型，createLLM 会自动使用当前提供商的默认模型
    this.llm = createLLM(this.config.llmModel !== 'default' ? this.config.llmModel : undefined, {
      temperature: 0.1, // 低温度以获得更稳定的抽取结果
    });

    this.embeddings = createEmbedding(this.config.embeddingModel !== 'default' ? this.config.embeddingModel : undefined);
    
    const factory = getModelFactory();
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
    const perChunkTime = (
      this.config.baseChunkTime + 
      avgChunkSize * this.config.timeoutPerChar
    ) * modelFactor;
    
    // 总提取时间 (包括 gleaning)
    const extractionTime = chunkCount * perChunkTime * gleaningFactor;
    
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
   * 带超时的 Promise 包装器
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      )
    ]);
  }

  /**
   * 中止当前抽取任务
   */
  abort(): void {
    this.aborted = true;
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

    const chunks: TextChunk[] = [];
    const { chunkSize, chunkOverlap } = this.config;

    // 首先按段落分割
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    let currentChunk = '';
    let currentStart = 0;
    let charOffset = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i].trim();
      
      // 如果当前块加上新段落超过目标大小
      if (currentChunk.length + paragraph.length > chunkSize && currentChunk.length > 0) {
        // 保存当前块
        const chunkId = `${documentId}_chunk_${chunks.length}`;
        chunks.push({
          id: chunkId,
          content: currentChunk.trim(),
          index: chunks.length,
          startChar: currentStart,
          endChar: currentStart + currentChunk.length,
          overlap: {
            previous: chunks.length > 0 ? this.getOverlapText(chunks[chunks.length - 1].content, chunkOverlap, 'end') : null,
            next: null,  // 稍后填充
          },
        });

        // 开始新块，带重叠
        const overlapText = this.getOverlapText(currentChunk, chunkOverlap, 'end');
        currentChunk = overlapText + (overlapText ? '\n\n' : '') + paragraph;
        currentStart = charOffset - (overlapText ? overlapText.length : 0);
      } else {
        // 继续累积
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }

      charOffset += paragraph.length + 2; // 加上段落分隔符
    }

    // 保存最后一个块
    if (currentChunk.trim().length > 0) {
      const chunkId = `${documentId}_chunk_${chunks.length}`;
      chunks.push({
        id: chunkId,
        content: currentChunk.trim(),
        index: chunks.length,
        startChar: currentStart,
        endChar: currentStart + currentChunk.length,
        overlap: {
          previous: chunks.length > 0 ? this.getOverlapText(chunks[chunks.length - 1].content, chunkOverlap, 'end') : null,
          next: null,
        },
      });
    }

    // 填充 next overlap
    for (let i = 0; i < chunks.length - 1; i++) {
      chunks[i].overlap.next = this.getOverlapText(chunks[i + 1].content, chunkOverlap, 'start');
    }

    this.reportProgress({
      stage: 'chunking',
      current: 1,
      total: 1,
      message: `切分完成，共 ${chunks.length} 个文本块`,
      details: { chunkCount: chunks.length },
    });

    return chunks;
  }

  /** 获取重叠文本 */
  private getOverlapText(text: string, overlapSize: number, position: 'start' | 'end'): string {
    if (text.length <= overlapSize) return text;
    
    if (position === 'start') {
      // 从开头取，尽量在句子边界切
      const candidate = text.substring(0, overlapSize);
      const lastPeriod = Math.max(
        candidate.lastIndexOf('。'),
        candidate.lastIndexOf('！'),
        candidate.lastIndexOf('？'),
        candidate.lastIndexOf('.'),
        candidate.lastIndexOf('!'),
        candidate.lastIndexOf('?')
      );
      return lastPeriod > overlapSize * 0.5 ? text.substring(0, lastPeriod + 1) : candidate;
    } else {
      // 从末尾取
      const candidate = text.substring(text.length - overlapSize);
      const firstPeriod = Math.min(
        candidate.indexOf('。') >= 0 ? candidate.indexOf('。') : Infinity,
        candidate.indexOf('！') >= 0 ? candidate.indexOf('！') : Infinity,
        candidate.indexOf('？') >= 0 ? candidate.indexOf('？') : Infinity,
        candidate.indexOf('.') >= 0 ? candidate.indexOf('.') : Infinity,
        candidate.indexOf('!') >= 0 ? candidate.indexOf('!') : Infinity,
        candidate.indexOf('?') >= 0 ? candidate.indexOf('?') : Infinity
      );
      return firstPeriod < overlapSize * 0.5 && firstPeriod !== Infinity 
        ? text.substring(text.length - overlapSize + firstPeriod + 1) 
        : candidate;
    }
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
      const chunk = chunks[i];
      
      this.reportProgress({
        stage: 'extracting',
        current: i + 1,
        total: chunks.length,
        message: `正在抽取第 ${i + 1}/${chunks.length} 个文本块...`,
      });

      try {
        // 主抽取
        const extracted = await this.extractFromChunk(chunk);
        
        // 合并实体
        for (const entity of extracted.entities) {
          const existingId = this.findSimilarEntity(entity.name, entities);
          if (existingId) {
            // 更新已有实体
            const existing = entities.get(existingId)!;
            existing.mentions += 1;
            existing.sourceChunks.push(chunk.id);
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

      } catch (error) {
        console.error(`[EntityExtractor] 提取块 ${chunk.id} 失败:`, error);
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

  /** 从单个块中提取实体和关系 */
  private async extractFromChunk(chunk: TextChunk): Promise<{
    entities: Array<{ name: string; type: string; description: string }>;
    relations: Array<{ source: string; target: string; type: string; description: string }>;
  }> {
    // 检查是否已中止
    if (this.aborted) {
      return { entities: [], relations: [] };
    }

    const prompt = ENTITY_EXTRACTION_PROMPT.replace('{text}', chunk.content);
    const chunkTimeout = this.calculateChunkTimeout(chunk.content.length);
    
    try {
      // 使用超时包装 LLM 调用
      const response = await this.withTimeout(
        this.llm.invoke(prompt),
        chunkTimeout,
        `单块提取超时 (${Math.round(chunkTimeout / 1000)}秒)`
      );
      
      // 使用安全的 JSON 解析
      const result = this.safeParseJson(response);
      
      if (result) {
        // 过滤和验证实体
        const validEntities = (result.entities as Array<{ name?: string; type?: string; description?: string }>)
          .filter(e => e && typeof e === 'object' && e.name && typeof e.name === 'string')
          .map(e => ({
            name: String(e.name || '').trim(),
            type: String(e.type || 'OTHER').toUpperCase(),
            description: String(e.description || '').trim(),
          }))
          .filter(e => e.name.length > 0);

        // 过滤和验证关系
        const validRelations = (result.relations as Array<{ source?: string; target?: string; type?: string; description?: string }>)
          .filter(r => r && typeof r === 'object' && r.source && r.target)
          .map(r => ({
            source: String(r.source || '').trim(),
            target: String(r.target || '').trim(),
            type: String(r.type || '相关').trim(),
            description: String(r.description || '').trim(),
          }))
          .filter(r => r.source.length > 0 && r.target.length > 0);

        console.log(`[EntityExtractor] 块 ${chunk.id}: 提取 ${validEntities.length} 实体, ${validRelations.length} 关系`);
        
        return {
          entities: validEntities,
          relations: validRelations,
        };
      }
      
      console.warn(`[EntityExtractor] 块 ${chunk.id}: 无法解析 JSON，跳过`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('超时')) {
        console.warn(`[EntityExtractor] 块 ${chunk.id}: ${error.message}`);
      } else {
        console.error(`[EntityExtractor] 块 ${chunk.id} 提取失败:`, error instanceof Error ? error.message : error);
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
        .replace('{text}', chunk.content)
        .replace('{existingEntities}', existingEntities || '无')
        .replace('{existingRelations}', existingRelations || '无');

      try {
        const response = await this.llm.invoke(prompt);
        
        // 使用安全的 JSON 解析
        const parsed = this.safeParseJson(response);
        
        if (parsed) {
          // 合并新发现的实体
          if (Array.isArray(parsed.entities)) {
            for (const rawEntity of parsed.entities) {
              const entity = rawEntity as { name?: string; type?: string; description?: string };
              if (!entity || !entity.name) continue;
              
              const existingId = this.findSimilarEntity(entity.name, entities);
              if (!existingId) {
                const entityId = `entity_${entities.size}_${Date.now()}`;
                entities.set(entityId, {
                  id: entityId,
                  name: String(entity.name).trim(),
                  type: (String(entity.type || 'OTHER').toUpperCase()) as EntityType,
                  description: String(entity.description || '').trim(),
                  aliases: [String(entity.name).trim()],
                  mentions: 1,
                  sourceChunks: [chunk.id],
                });
                initialExtraction.entities.push(entity);
              }
            }
          }

          // 合并新发现的关系
          if (Array.isArray(parsed.relations)) {
            for (const relation of parsed.relations) {
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
                initialExtraction.relations.push(relation);
              }
            }
          }
        }
      } catch (error) {
        console.error('[EntityExtractor] Gleaning 失败:', error);
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

    // 计算实体嵌入
    const entityTexts = entityArray.map(e => `${e.name}: ${e.description}`);
    const entityEmbeddings = await this.embeddings.embedDocuments(entityTexts);
    
    for (let i = 0; i < entityArray.length; i++) {
      entityArray[i].embedding = entityEmbeddings[i];
    }

    // 找出潜在的重复实体对
    const candidates: Array<[Entity, Entity, number]> = [];
    
    for (let i = 0; i < entityArray.length; i++) {
      for (let j = i + 1; j < entityArray.length; j++) {
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

    // 使用 LLM 确认合并
    for (const [entity1, entity2, similarity] of candidates) {
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
        .replace('{entity1}', entity1.name)
        .replace('{type1}', entity1.type)
        .replace('{desc1}', entity1.description)
        .replace('{entity2}', entity2.name)
        .replace('{type2}', entity2.type)
        .replace('{desc2}', entity2.description)
        .replace('{context}', '无额外上下文');

      const response = await this.llm.invoke(prompt);
      const parsed = this.safeParseJsonGeneric(response);
      
      if (parsed && typeof parsed === 'object') {
        const result = parsed as { isSameEntity?: boolean; confidence?: number };
        return result.isSameEntity === true && (result.confidence || 0) > 0.7;
      }
    } catch (error) {
      console.error('[EntityExtractor] 实体消歧判断失败:', error);
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

    let summarized = 0;
    for (const [id, community] of communities) {
      try {
        const summary = await this.generateCommunitySummary(community, entities, relations);
        community.name = summary.name;
        community.summary = summary.summary;
        community.keywords = summary.keywords;

        // 生成社区摘要的嵌入
        const embedding = await this.embeddings.embedQuery(summary.summary);
        community.embedding = embedding;

      } catch (error) {
        console.error(`[EntityExtractor] 生成社区 ${id} 摘要失败:`, error);
        community.name = `社区 ${summarized + 1}`;
        community.summary = `包含 ${community.entities.length} 个实体的社区`;
        community.keywords = [];
      }

      summarized++;
      this.reportProgress({
        stage: 'summarizing',
        current: summarized,
        total: communities.size,
        message: `正在生成社区摘要 ${summarized}/${communities.size}...`,
      });
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
      .replace('{entities}', entityInfos || '无')
      .replace('{relations}', relationInfos || '无');

    try {
      const response = await this.llm.invoke(prompt);
      const parsed = this.safeParseJsonGeneric(response);
      
      if (parsed) {
        return {
          name: (parsed.name as string) || '未命名社区',
          summary: (parsed.summary as string) || '暂无摘要',
          keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as string[]) : [],
        };
      }
    } catch (error) {
      console.error('[EntityExtractor] 解析社区摘要失败:', error);
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
    
    // 预估切片数量用于计算超时
    const estimatedChunkCount = Math.ceil(text.length / this.config.chunkSize);
    this.estimatedTimeout = this.calculateTimeout(text.length, estimatedChunkCount);
    
    console.log(`[EntityExtractor] 开始抽取任务`, {
      documentId,
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
      console.error(`[EntityExtractor] 抽取失败 (运行 ${Math.round(duration / 1000)} 秒):`, error);
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

// ==================== 导出 ====================

export default EntityExtractor;
