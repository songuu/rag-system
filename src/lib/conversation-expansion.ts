/**
 * 基于 RAG 上下文感知的对话延伸引擎
 * 
 * 设计目标：解决"多轮对话冷启动"问题
 * - 模拟人类对话逻辑（追问细节、横向对比、因果推演）
 * - 在当前文档范围内生成具有逻辑延续性的推荐问题
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Embeddings } from '@langchain/core/embeddings';

// 导入自适应实体 RAG 的实体提取工具
import { EntityPreprocessor } from './adaptive-entity-rag';

// 导入统一模型配置系统
import { 
  createLLM, 
  createEmbedding, 
  getModelFactory,
  isOllamaProvider 
} from './model-config';

// ==================== 类型定义 ====================

/** 实体信息 */
export interface ExtractedEntity {
  name: string;
  type: 'product' | 'person' | 'organization' | 'concept' | 'action' | 'attribute' | 'other';
  confidence: number;
}

/** 意图锚点 */
export interface IntentAnchor {
  /** 核心实体 */
  entities: ExtractedEntity[];
  /** 当前关注的属性/维度 */
  attributes: string[];
  /** 用户意图类型 */
  intentType: 'query' | 'compare' | 'how-to' | 'why' | 'what-if' | 'other';
  /** 对话阶段 */
  stage: 'initial' | 'exploring' | 'deep-diving' | 'concluding';
}

/** 延伸策略类型 */
export type ExpansionStrategy = 'drill-down' | 'lateral-move' | 'logical-flow';

/** 候选问题 */
export interface CandidateQuestion {
  /** 问题内容 */
  question: string;
  /** 采用的策略 */
  strategy: ExpansionStrategy;
  /** 策略描述 */
  strategyLabel: string;
  /** 关联的文档片段 ID */
  sourceChunkIds: string[];
  /** 相关度分数 */
  relevanceScore: number;
  /** 是否通过校验 */
  validated: boolean;
  /** 校验详情 */
  validationDetails?: {
    hasEvidence: boolean;
    isDuplicate: boolean;
    keywordsFound: string[];
    /** 实体覆盖率 */
    entityCoverage?: number;
    /** 关键词覆盖率 */
    keywordCoverage?: number;
    /** 是否检测到幻觉 */
    hallucination?: boolean;
    /** 在文档中找到的实体 */
    foundEntities?: string[];
  };
}

/** 对话延伸结果 */
export interface ExpansionResult {
  /** 推荐问题列表 */
  suggestions: CandidateQuestion[];
  /** 意图锚点分析 */
  anchor: IntentAnchor;
  /** 处理时间 (ms) */
  processingTime: number;
  /** 各阶段耗时 */
  timings: {
    anchorAnalysis: number;
    strategyRouting: number;
    questionGeneration: number;
    validation: number;
  };
}

/** 文档片段 */
export interface DocumentChunk {
  id: string;
  content: string;
  metadata?: Record<string, any>;
  score?: number;
}

/** 配置 */
export interface ExpansionConfig {
  llmModel: string;
  embeddingModel: string;
  maxSuggestions: number;
  minRelevanceScore: number;
  enableValidation: boolean;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: ExpansionConfig = {
  llmModel: 'qwen2.5:0.5b',
  embeddingModel: 'bge-m3:latest',
  maxSuggestions: 5,
  minRelevanceScore: 0.3,
  enableValidation: true,
};

// ==================== 意图锚点分析器 ====================

const ANCHOR_ANALYSIS_PROMPT = `你是一个意图分析专家。分析用户问题和AI回答，提取关键信息。

用户问题: {userQuery}
AI回答: {aiResponse}
相关文档片段:
{contextChunks}

请分析并返回JSON格式:
{{
  "entities": [
    {{"name": "实体名称", "type": "类型(product/person/organization/concept/action/attribute/other)", "confidence": 0.0-1.0}}
  ],
  "attributes": ["用户关注的属性/维度"],
  "intentType": "意图类型(query/compare/how-to/why/what-if/other)",
  "stage": "对话阶段(initial/exploring/deep-diving/concluding)"
}}

分析要点:
1. 实体是用户关注的核心对象（产品、人物、组织、概念等）
2. 属性是用户询问的具体维度（价格、功能、时间、方法等）
3. 意图类型反映用户的真实目的
4. 对话阶段帮助判断应该推荐什么类型的问题

只返回JSON，不要其他内容。`;

class IntentAnchorAnalyzer {
  private llm: BaseChatModel;
  private chain: any;

  constructor(llmModel: string) {
    // 使用统一模型配置系统
    this.llm = createLLM(llmModel, { temperature: 0.1 });
    
    const prompt = ChatPromptTemplate.fromTemplate(ANCHOR_ANALYSIS_PROMPT);
    this.chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
  }

  async analyze(
    userQuery: string,
    aiResponse: string,
    contextChunks: DocumentChunk[]
  ): Promise<IntentAnchor> {
    const chunksText = contextChunks
      .slice(0, 5)
      .map((c, i) => `[${i + 1}] ${c.content.slice(0, 300)}...`)
      .join('\n\n');

    try {
      const result = await this.chain.invoke({
        userQuery,
        aiResponse: aiResponse.slice(0, 500),
        contextChunks: chunksText || '无相关文档',
      });

      const parsed = this.parseJSON(result);
      return {
        entities: parsed.entities || [],
        attributes: parsed.attributes || [],
        intentType: parsed.intentType || 'query',
        stage: parsed.stage || 'initial',
      };
    } catch (error) {
      console.error('[AnchorAnalyzer] Error:', error);
      return {
        entities: [],
        attributes: [],
        intentType: 'query',
        stage: 'initial',
      };
    }
  }

  private parseJSON(text: string): any {
    try {
      // 尝试直接解析
      return JSON.parse(text);
    } catch {
      // 尝试提取 JSON 块
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          return {};
        }
      }
      return {};
    }
  }
}

// ==================== 延伸策略路由器 ====================

const STRATEGY_PROMPTS: Record<ExpansionStrategy, string> = {
  'drill-down': `基于当前文档，找出关于"{entity}"的其他属性或细节。
当前用户已了解: {knownAttributes}
文档内容:
{chunks}

找出文档中还未被提及的、关于该实体的其他信息点。
返回JSON格式: {{"unexploredAttributes": ["属性1", "属性2", ...]}}`,

  'lateral-move': `基于当前文档，找出与"{entity}"相关或可对比的其他实体。
当前关注属性: {attribute}
文档内容:
{chunks}

找出文档中提到的、可以与当前实体进行对比的其他实体。
返回JSON格式: {{"relatedEntities": ["{{"name": "实体名", "relation": "关系类型"}}"]}}`,

  'logical-flow': `基于当前文档，分析"{topic}"可能引发的后续问题。
当前语境: {context}
文档内容:
{chunks}

找出文档中关于条件、后果、建议、趋势等逻辑延伸信息。
返回JSON格式: {{"logicalExtensions": ["{{"type": "condition/consequence/suggestion/trend", "content": "内容摘要"}}"]}}`,
};

class ExpansionStrategyRouter {
  private llm: BaseChatModel;

  constructor(llmModel: string) {
    // 使用统一模型配置系统
    this.llm = createLLM(llmModel, { temperature: 0.3 });
  }

  async route(
    anchor: IntentAnchor,
    contextChunks: DocumentChunk[]
  ): Promise<Map<ExpansionStrategy, any>> {
    const results = new Map<ExpansionStrategy, any>();
    const chunksText = contextChunks
      .map((c, i) => `[${i + 1}] ${c.content.slice(0, 400)}`)
      .join('\n\n');

    const mainEntity = anchor.entities[0]?.name || '当前话题';
    const mainAttribute = anchor.attributes[0] || '相关信息';

    // 并行执行三个策略
    const promises: Promise<void>[] = [];

    // 策略A: 纵向深挖
    if (anchor.entities.length > 0) {
      promises.push(
        this.executeStrategy('drill-down', {
          entity: mainEntity,
          knownAttributes: anchor.attributes.join(', ') || '无',
          chunks: chunksText,
        }).then(r => { results.set('drill-down', r); })
      );
    }

    // 策略B: 横向拓展
    if (anchor.entities.length > 0) {
      promises.push(
        this.executeStrategy('lateral-move', {
          entity: mainEntity,
          attribute: mainAttribute,
          chunks: chunksText,
        }).then(r => { results.set('lateral-move', r); })
      );
    }

    // 策略C: 逻辑推演
    promises.push(
      this.executeStrategy('logical-flow', {
        topic: mainEntity,
        context: `用户正在了解${mainAttribute}`,
        chunks: chunksText,
      }).then(r => { results.set('logical-flow', r); })
    );

    await Promise.all(promises);
    return results;
  }

  private async executeStrategy(
    strategy: ExpansionStrategy,
    variables: Record<string, string>
  ): Promise<any> {
    try {
      const promptTemplate = STRATEGY_PROMPTS[strategy];
      let prompt = promptTemplate;
      for (const [key, value] of Object.entries(variables)) {
        prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }

      const result = await this.llm.invoke(prompt);
      const content = typeof result.content === 'string' ? result.content : '';
      return this.parseJSON(content);
    } catch (error) {
      console.error(`[StrategyRouter] ${strategy} error:`, error);
      return {};
    }
  }

  private parseJSON(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          return {};
        }
      }
      return {};
    }
  }
}

// ==================== 候选问题生成器 ====================

const QUESTION_GENERATION_PROMPT = `你是一个智能问答助手，根据文档内容生成用户可能感兴趣的追问问题。

**重要约束**：
- 你只能基于【参考信息】中**明确提到**的内容生成问题
- 问题中涉及的实体、名称、数字等必须在参考信息中**原文出现**
- **严禁**编造、推测或延伸参考信息中没有的内容
- 如果参考信息中没有相关内容，返回空数组

策略类型: {strategyType}
策略描述: {strategyDesc}
当前话题: {topic}

参考信息（问题必须基于以下内容）:
{referenceInfo}

生成要求:
1. 问题中的关键词必须在参考信息中出现
2. 问题要简洁明了，像真人会问的那样
3. 最多生成2个问题，宁缺毋滥
4. 如果参考信息不足以生成有意义的问题，返回空数组

返回JSON格式:
{{"questions": ["问题1", "问题2"]}}

只返回JSON，不要其他内容。`;

class CandidateQuestionGenerator {
  private llm: BaseChatModel;
  private chain: any;

  constructor(llmModel: string) {
    // 使用统一模型配置系统
    this.llm = createLLM(llmModel, { temperature: 0.5 });
    
    const prompt = ChatPromptTemplate.fromTemplate(QUESTION_GENERATION_PROMPT);
    this.chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
  }

  async generate(
    strategyResults: Map<ExpansionStrategy, any>,
    anchor: IntentAnchor,
    contextChunks: DocumentChunk[]
  ): Promise<CandidateQuestion[]> {
    const candidates: CandidateQuestion[] = [];
    const mainTopic = anchor.entities[0]?.name || '当前话题';

    const strategyLabels: Record<ExpansionStrategy, string> = {
      'drill-down': '深入了解',
      'lateral-move': '对比参考',
      'logical-flow': '延伸思考',
    };

    const strategyDescs: Record<ExpansionStrategy, string> = {
      'drill-down': '挖掘更多细节和属性',
      'lateral-move': '与其他相似事物对比',
      'logical-flow': '探索条件、后果或建议',
    };

    // 准备原始文档内容（用于确保问题基于真实内容）
    const documentContent = contextChunks
      .slice(0, 5)
      .map((c, i) => `【文档${i + 1}】${c.content.slice(0, 500)}`)
      .join('\n\n');

    for (const [strategy, result] of strategyResults) {
      if (!result || Object.keys(result).length === 0) continue;

      let strategyHint = '';
      if (strategy === 'drill-down' && result.unexploredAttributes) {
        strategyHint = `建议探索的属性: ${result.unexploredAttributes.join(', ')}`;
      } else if (strategy === 'lateral-move' && result.relatedEntities) {
        strategyHint = `文档中提到的相关实体: ${result.relatedEntities.map((e: any) => e.name || e).join(', ')}`;
      } else if (strategy === 'logical-flow' && result.logicalExtensions) {
        strategyHint = `文档中的逻辑延伸点: ${result.logicalExtensions.map((e: any) => e.content || e).join('; ')}`;
      }

      // 将策略提示和原始文档内容结合
      const referenceInfo = `${strategyHint}\n\n原始文档内容:\n${documentContent}`;

      try {
        const response = await this.chain.invoke({
          strategyType: strategy,
          strategyDesc: strategyDescs[strategy],
          topic: mainTopic,
          referenceInfo,
        });

        const parsed = this.parseJSON(response);
        const questions = parsed.questions || [];

        for (const q of questions) {
          if (typeof q === 'string' && q.trim()) {
            candidates.push({
              question: q.trim(),
              strategy,
              strategyLabel: strategyLabels[strategy],
              sourceChunkIds: contextChunks.slice(0, 3).map(c => c.id),
              relevanceScore: 0.8,
              validated: false,
            });
          }
        }
      } catch (error) {
        console.error(`[QuestionGenerator] ${strategy} error:`, error);
      }
    }

    return candidates;
  }

  private parseJSON(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          return {};
        }
      }
      return {};
    }
  }
}

// ==================== 证据闭环校验器 (强化版) ====================

class EvidenceValidator {
  private embeddings: Embeddings;
  private minRelevanceScore: number;

  constructor(embeddingModel: string, minRelevanceScore: number = 0.3) {
    // 使用统一模型配置系统
    this.embeddings = createEmbedding(embeddingModel);
    this.minRelevanceScore = minRelevanceScore;
  }

  async validate(
    candidates: CandidateQuestion[],
    contextChunks: DocumentChunk[],
    originalQuery: string
  ): Promise<CandidateQuestion[]> {
    const validatedCandidates: CandidateQuestion[] = [];

    // 预计算文档内容
    const contextText = contextChunks.map(c => c.content).join(' ');
    const contextKeywords = this.extractKeywords(contextText);
    const originalKeywords = this.extractKeywords(originalQuery);
    
    // 提取文档中的实体和关键名词（用于严格校验）
    const documentEntities = this.extractEntities(contextText);

    for (const candidate of candidates) {
      const questionKeywords = this.extractKeywords(candidate.question);
      const questionEntities = this.extractEntities(candidate.question);

      // 检查1: 实体证据 - 问题中的实体必须在文档中出现
      const foundEntities = questionEntities.filter(e => 
        documentEntities.some(de => 
          de.toLowerCase() === e.toLowerCase() ||
          de.toLowerCase().includes(e.toLowerCase()) ||
          e.toLowerCase().includes(de.toLowerCase())
        )
      );
      const entityCoverage = questionEntities.length > 0 
        ? foundEntities.length / questionEntities.length 
        : 0;
      
      // 检查2: 关键词覆盖 - 问题的关键词在文档中的覆盖率
      const foundKeywords = questionKeywords.filter(k => 
        contextKeywords.some(ck => ck.includes(k) || k.includes(ck))
      );
      const keywordCoverage = questionKeywords.length > 0
        ? foundKeywords.length / questionKeywords.length
        : 0;

      // 检查3: 去重 - 问题是否与原问题高度重复
      const duplicateKeywords = questionKeywords.filter(k =>
        originalKeywords.some(ok => ok === k)
      );
      const isDuplicate = questionKeywords.length > 0 
        ? duplicateKeywords.length / questionKeywords.length > 0.7
        : false;

      // 检查4: 问题中是否包含文档中不存在的专有名词（幻觉检测）
      const hallucination = this.detectHallucination(candidate.question, contextText);

      // 综合评分
      // 降低阈值要求，避免过度过滤
      // 只要有实体覆盖或关键词覆盖即可
      const evidenceScore = Math.max(entityCoverage, keywordCoverage);
      const hasEvidence = evidenceScore >= 0.3 || foundKeywords.length >= 2; // 降低阈值，更宽松

      // 更新校验结果
      candidate.validationDetails = {
        hasEvidence,
        isDuplicate,
        keywordsFound: foundKeywords,
        entityCoverage,
        keywordCoverage,
        hallucination,
        foundEntities,
      };

      // 判断是否通过校验（不过滤，只标记状态）
      // 通过条件: 有证据 && 不重复 && 无幻觉
      const isValid = hasEvidence && !isDuplicate && !hallucination;
      candidate.validated = isValid;
      candidate.relevanceScore = evidenceScore;
      
      // 所有候选问题都加入结果（不过滤），让前端自行决定是否显示
      validatedCandidates.push(candidate);
      
      if (!isValid) {
        console.log(`[EvidenceValidator] Marked invalid: "${candidate.question.slice(0, 50)}..." - evidence=${evidenceScore.toFixed(2)}, dup=${isDuplicate}, halluc=${hallucination}`);
      }
    }

    // 按相关度排序，通过校验的排在前面
    return validatedCandidates.sort((a, b) => {
      // 首先按 validated 排序（通过的在前）
      if (a.validated !== b.validated) {
        return a.validated ? -1 : 1;
      }
      // 其次按相关度排序
      return b.relevanceScore - a.relevanceScore;
    });
  }

  /**
   * 提取文本中的实体（复用 EntityPreprocessor 的规则提取逻辑）
   */
  private extractEntities(text: string): string[] {
    const entities: string[] = [];
    
    // 1. 使用 EntityPreprocessor 的规则提取（包含已知地名、组织、人名、产品等）
    try {
      const ruleBasedEntities = EntityPreprocessor.extractEntitiesByRules(text);
      for (const entity of ruleBasedEntities) {
        if (entity.name) {
          entities.push(entity.name);
        }
        if (entity.value && entity.value !== entity.name) {
          entities.push(entity.value);
        }
      }
    } catch (error) {
      console.warn('[EvidenceValidator] EntityPreprocessor.extractEntitiesByRules failed:', error);
    }
    
    // 2. 补充：提取带引号或书名号的内容
    const quotedPattern = /["'"「『《]([^"'"」』》]+)["'"」』》]/g;
    let match;
    while ((match = quotedPattern.exec(text)) !== null) {
      if (match[1] && match[1].length > 1) {
        entities.push(match[1]);
      }
    }
    
    // 3. 补充：提取数字+单位组合（如价格、数量等）
    const numberPattern = /\d+(?:\.\d+)?(?:元|万|亿|%|个|件|台|套|年|月|日|号)/g;
    const numberMatches = text.match(numberPattern) || [];
    entities.push(...numberMatches);
    
    // 4. 补充：提取英文实体模式（大写开头的词或缩写）
    const englishEntityPattern = /[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*/g;
    const englishMatches = text.match(englishEntityPattern) || [];
    entities.push(...englishMatches.filter(e => e.length > 2));
    
    // 5. 补充：提取中文实体模式（公司、产品等后缀）
    const chineseProductPattern = /[\u4e00-\u9fa5]{2,8}(?:公司|集团|银行|企业|机构|中心|系统|平台|服务|产品|型号|版本|系列|协议|标准)/g;
    const chineseMatches = text.match(chineseProductPattern) || [];
    entities.push(...chineseMatches);
    
    // 去重
    return [...new Set(entities)];
  }

  /**
   * 检测问题中是否存在幻觉（文档中不存在的内容）
   */
  private detectHallucination(question: string, contextText: string): boolean {
    // 提取问题中的专有名词
    const questionEntities = this.extractEntities(question);
    
    if (questionEntities.length === 0) {
      return false; // 没有专有名词，不算幻觉
    }
    
    // 检查每个专有名词是否在文档中出现
    const contextLower = contextText.toLowerCase();
    const missingEntities = questionEntities.filter(entity => {
      const entityLower = entity.toLowerCase();
      // 精确匹配或部分匹配
      return !contextLower.includes(entityLower) && 
             !contextLower.split(/\s+/).some(word => 
               word.includes(entityLower) || entityLower.includes(word)
             );
    });
    
    // 如果超过 30% 的专有名词在文档中找不到，认为是幻觉
    const missingRatio = missingEntities.length / questionEntities.length;
    if (missingRatio > 0.3) {
      console.log(`[EvidenceValidator] Hallucination detected: missing entities = ${missingEntities.join(', ')}`);
      return true;
    }
    
    return false;
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
      '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
      '自己', '这', '那', '什么', '怎么', '吗', '呢', '啊', '哪', '为什么', '如何',
      '能', '可以', '应该', '需要', '请问', '告诉', '知道', '想', '觉得', '认为',
      '关于', '对于', '通过', '根据', '按照', '由于', '因为', '所以', '但是', '然而',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
      'through', 'during', 'before', 'after', 'above', 'below', 'between',
      'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whose',
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));
  }
}

// ==================== 对话延伸引擎主类 ====================

export class ConversationExpansionEngine {
  private config: ExpansionConfig;
  private anchorAnalyzer: IntentAnchorAnalyzer;
  private strategyRouter: ExpansionStrategyRouter;
  private questionGenerator: CandidateQuestionGenerator;
  private validator: EvidenceValidator;

  constructor(config: Partial<ExpansionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    this.anchorAnalyzer = new IntentAnchorAnalyzer(this.config.llmModel);
    this.strategyRouter = new ExpansionStrategyRouter(this.config.llmModel);
    this.questionGenerator = new CandidateQuestionGenerator(this.config.llmModel);
    this.validator = new EvidenceValidator(
      this.config.embeddingModel,
      this.config.minRelevanceScore
    );
  }

  /**
   * 生成推荐问题
   */
  async expand(
    userQuery: string,
    aiResponse: string,
    contextChunks: DocumentChunk[]
  ): Promise<ExpansionResult> {
    const startTime = Date.now();
    const timings = {
      anchorAnalysis: 0,
      strategyRouting: 0,
      questionGeneration: 0,
      validation: 0,
    };

    // 1. 意图锚点分析
    let anchorStart = Date.now();
    const anchor = await this.anchorAnalyzer.analyze(userQuery, aiResponse, contextChunks);
    timings.anchorAnalysis = Date.now() - anchorStart;
    console.log('[ExpansionEngine] Anchor:', anchor);

    // 2. 策略路由
    let routeStart = Date.now();
    const strategyResults = await this.strategyRouter.route(anchor, contextChunks);
    timings.strategyRouting = Date.now() - routeStart;
    console.log('[ExpansionEngine] Strategy results:', Object.fromEntries(strategyResults));

    // 3. 候选问题生成
    let genStart = Date.now();
    const candidates = await this.questionGenerator.generate(
      strategyResults,
      anchor,
      contextChunks
    );
    timings.questionGeneration = Date.now() - genStart;
    console.log('[ExpansionEngine] Candidates:', candidates.length);

    // 4. 证据校验
    let suggestions: CandidateQuestion[] = candidates;
    if (this.config.enableValidation && candidates.length > 0) {
      let valStart = Date.now();
      suggestions = await this.validator.validate(candidates, contextChunks, userQuery);
      timings.validation = Date.now() - valStart;
    }

    // 限制数量
    suggestions = suggestions.slice(0, this.config.maxSuggestions);

    return {
      suggestions,
      anchor,
      processingTime: Date.now() - startTime,
      timings,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ExpansionConfig>) {
    this.config = { ...this.config, ...newConfig };
    
    if (newConfig.llmModel) {
      this.anchorAnalyzer = new IntentAnchorAnalyzer(this.config.llmModel);
      this.strategyRouter = new ExpansionStrategyRouter(this.config.llmModel);
      this.questionGenerator = new CandidateQuestionGenerator(this.config.llmModel);
    }
    
    if (newConfig.embeddingModel || newConfig.minRelevanceScore !== undefined) {
      this.validator = new EvidenceValidator(
        this.config.embeddingModel,
        this.config.minRelevanceScore
      );
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): ExpansionConfig {
    return { ...this.config };
  }
}

// ==================== 工厂函数 ====================

let expansionEngine: ConversationExpansionEngine | null = null;

export function createExpansionEngine(config?: Partial<ExpansionConfig>): ConversationExpansionEngine {
  if (!expansionEngine || config) {
    expansionEngine = new ConversationExpansionEngine(config);
  }
  return expansionEngine;
}

export function getExpansionEngine(): ConversationExpansionEngine | null {
  return expansionEngine;
}
