'use strict';

/**
 * 自适应实体路由 RAG (Adaptive Entity-Routing RAG)
 * 
 * 基于 LangGraph 的四层架构设计：
 * 1. 认知解析层 (Cognitive Parsing Layer) - 实体提取与意图分类
 * 2. 策略控制层 (Strategic Control Layer) - 实体校验、自适应路由、约束松弛
 * 3. 执行检索层 (Execution Layer) - 结构化/语义检索、混合重排序
 * 4. 数据基础设施层 (Data Infrastructure Layer) - 向量数据库、实体元数据存储
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Embeddings } from '@langchain/core/embeddings';
import { getMilvusInstance, MilvusVectorStore, MilvusSearchResult } from './milvus-client';
import {
  createLLM,
  createEmbedding,
  getModelDimension,
  selectModelByDimension,
  getModelFactory,
  isOllamaProvider,
} from './model-config';

// ==================== 类型定义 ====================

/** 实体类型 */
export type EntityType = 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'PRODUCT' | 'DATE' | 'EVENT' | 'CONCEPT' | 'OTHER';

/** 逻辑操作符 */
export type LogicalOperator = 'AND' | 'OR' | 'NOT';

/** 意图类型 */
export type IntentType = 'factual' | 'conceptual' | 'comparison' | 'procedural' | 'exploratory';

/** 提取的实体 */
export interface ExtractedEntity {
  name: string;
  type: EntityType;
  value: string;
  confidence: number;
  normalized?: string;  // 归一化后的名称
  aliases?: string[];   // 同义词
}

/** 逻辑关系 */
export interface LogicalRelation {
  operator: LogicalOperator;
  entities: string[];
  description: string;
}

/** 解析结果 */
export interface ParsedQuery {
  originalQuery: string;
  entities: ExtractedEntity[];
  logicalRelations: LogicalRelation[];
  intent: IntentType;
  complexity: 'simple' | 'moderate' | 'complex';
  confidence: number;
  keywords: string[];
}

/** 校验后的实体 */
export interface ValidatedEntity extends ExtractedEntity {
  isValid: boolean;
  normalizedName: string;
  matchScore: number;
  suggestions?: string[];
}

/** 检索条件 */
export interface SearchConstraint {
  field: string;
  operator: 'eq' | 'contains' | 'in' | 'range' | 'not';
  value: string | string[] | { min?: any; max?: any };
  priority: number;  // 优先级，越高越重要
}

/** 路由决策 */
export interface RoutingDecision {
  action: 'structured_search' | 'semantic_search' | 'hybrid_search' | 'relax_constraints' | 'generate_response';
  constraints: SearchConstraint[];
  relaxedConstraints?: string[];  // 已松弛的约束
  retryCount: number;
  maxRetries: number;
  reason: string;
}

/** 检索结果 */
export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
  matchType: 'structured' | 'semantic' | 'hybrid';
}

/** 重排序后的结果 */
export interface RankedResult extends SearchResult {
  rerankedScore: number;
  relevanceExplanation: string;
}

/** 工作流状态 */
export interface WorkflowState {
  query: ParsedQuery;
  validatedEntities: ValidatedEntity[];
  currentDecision: RoutingDecision;
  searchResults: SearchResult[];
  rankedResults: RankedResult[];
  finalResponse: string;
  steps: WorkflowStep[];
  totalDuration: number;
}

/** 工作流步骤 */
export interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  duration?: number;
  details?: any;
  error?: string;
}

/** 实体元数据 */
export interface EntityMetadata {
  standardName: string;
  type: EntityType;
  aliases: string[];
  hierarchy?: string[];  // 层级关系，如 ['中国', '北京', '朝阳']
  relatedEntities?: string[];
  embedding?: number[];
}

/** 配置选项 */
export interface AdaptiveRAGConfig {
  llmModel: string;
  embeddingModel: string;
  maxRetries: number;
  constraintPriority: EntityType[];  // 约束松弛优先级（后面的先松弛）
  minResultCount: number;
  similarityThreshold: number;
  enableReranking: boolean;
  milvusCollection: string;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: AdaptiveRAGConfig = {
  llmModel: 'qwen2.5:7b',
  embeddingModel: 'nomic-embed-text',
  maxRetries: 3,
  constraintPriority: ['PERSON', 'ORGANIZATION', 'PRODUCT', 'EVENT', 'LOCATION', 'DATE', 'CONCEPT', 'OTHER'],
  minResultCount: 3,
  similarityThreshold: 0.3,  // 降低阈值，避免过度过滤
  enableReranking: true,
  milvusCollection: 'rag_documents',
};

// ==================== Prompts ====================

const ENTITY_EXTRACTION_PROMPT = `你是一个专业的认知解析引擎，负责将用户的自然语言查询转换为结构化的数据对象。

用户查询: {query}

## 重要规则
1. **只提取查询中实际出现的实体**，不要凭空捏造或添加不存在的实体
2. **如果查询是问候语、闲聊或不包含任何实体，entities数组必须为空[]**
3. **实体必须是查询中明确提到的名词或专有名词**

## 任务说明
请深入分析用户查询，提取以下结构化信息：

1. **实体提取**：只识别查询中实际存在的命名实体
2. **逻辑关系**：如果有多个实体，识别它们之间的逻辑关系
3. **意图分类**：判断用户查询的根本目的
4. **复杂度评估**：评估查询的处理难度

## 返回格式（严格JSON）
{
  "entities": [],
  "logicalRelations": [],
  "intent": "factual|conceptual|comparison|procedural|exploratory",
  "complexity": "simple|moderate|complex",
  "confidence": 0.85,
  "keywords": []
}

## 实体类型定义
- **PERSON**: 人名、角色名称
- **ORGANIZATION**: 组织名、公司名、机构名
- **LOCATION**: 地名、地点名称
- **PRODUCT**: 产品名、品牌名
- **DATE**: 具体时间、日期
- **EVENT**: 事件名称
- **CONCEPT**: 专业术语、技术概念
- **OTHER**: 其他实体

## 意图类型定义
- **factual**: 寻求具体事实或数据
- **conceptual**: 理解概念或原理
- **comparison**: 对比分析
- **procedural**: 寻求方法步骤
- **exploratory**: 开放式探索

## 特殊情况处理
- 问候语（如"你好"、"早上好"）：entities=[], intent="exploratory", complexity="simple"
- 简单疑问（如"什么是AI"）：提取"AI"作为CONCEPT实体
- 无实体查询：entities=[], 只提取keywords

## 复杂度评估
- **simple**: 无实体或单一实体
- **moderate**: 2-3个实体
- **complex**: 多实体、复杂关系

请只返回严格的JSON格式，不要添加任何其他解释文字。不要输出示例中的内容，只提取用户查询中实际出现的实体。`;

const ENTITY_RESOLUTION_PROMPT = `你是一个实体校验专家。请判断用户输入的实体是否与标准实体库中的实体匹配。

用户输入实体: {userEntity}
用户输入类型: {userType}

候选标准实体列表:
{candidates}

请判断用户输入最可能对应哪个标准实体，或者是否是一个新实体。

返回JSON格式：
{
  "isMatch": true/false,
  "matchedEntity": "匹配的标准实体名称（如果匹配）",
  "confidence": 0.0-1.0,
  "normalizedName": "归一化后的名称",
  "suggestions": ["可能的其他匹配"]
}

只返回JSON。`;

const RERANKING_PROMPT = `你是一个文档相关性评估专家。请评估以下文档与用户查询的相关性。

用户查询: {query}
查询意图: {intent}
提取的实体: {entities}

文档内容:
{document}

请评估这个文档与查询的相关性，返回JSON格式：
{
  "relevanceScore": 0.0-1.0,
  "explanation": "相关性解释",
  "matchedEntities": ["匹配的实体"],
  "keyInformation": "文档中的关键信息"
}

只返回JSON。`;

const RESPONSE_GENERATION_PROMPT = `你是一个专业的问答助手。请基于检索到的上下文回答用户的问题。

用户问题: {query}
查询意图: {intent}
提取的实体: {entities}

检索到的上下文:
{context}

请给出准确、完整的回答。如果上下文信息不足以回答问题，请诚实说明。

回答要求：
1. 准确引用上下文中的信息
2. 根据查询意图调整回答风格
3. 如果是事实性问题，给出明确答案
4. 如果是概念性问题，给出清晰解释
5. 如果信息不足，说明已知信息和未知部分`;

// ==================== 预处理器 ====================

/**
 * 实体预处理器
 * 在 LLM 调用前使用规则和词典进行预识别，提高小模型的准确率
 */
export class EntityPreprocessor {
  // 常见中文地名别称映射（作为预处理词典）
  private static readonly LOCATION_ALIASES: Record<string, string> = {
    '魔都': '上海', '帝都': '北京', '妖都': '广州', '羊城': '广州',
    '蓉城': '成都', '鹏城': '深圳', '江城': '武汉', '山城': '重庆',
    '泉城': '济南', '冰城': '哈尔滨', '春城': '昆明', '榕城': '福州',
    '石城': '南京', '星城': '长沙', '花城': '广州', '雾都': '重庆',
  };

  // 常见地名列表（用于规则识别）
  private static readonly KNOWN_LOCATIONS: string[] = [
    // 直辖市
    '北京', '上海', '天津', '重庆',
    // 省会城市
    '广州', '深圳', '杭州', '南京', '成都', '武汉', '西安', '苏州',
    '长沙', '郑州', '青岛', '大连', '宁波', '厦门', '济南', '福州',
    '合肥', '昆明', '贵阳', '南宁', '南昌', '太原', '石家庄', '长春',
    '哈尔滨', '沈阳', '兰州', '西宁', '银川', '呼和浩特', '乌鲁木齐',
    '拉萨', '海口', '三亚',
    // 国家
    '中国', '美国', '日本', '韩国', '英国', '法国', '德国', '俄罗斯',
    '印度', '巴西', '加拿大', '澳大利亚', '新加坡', '香港', '台湾', '澳门',
    // 国际城市
    '纽约', '伦敦', '巴黎', '东京', '首尔', '新加坡', '悉尼', '多伦多',
    '洛杉矶', '旧金山', '硅谷', '西雅图', '芝加哥', '波士顿',
  ];

  // 常见组织/公司名称
  private static readonly KNOWN_ORGANIZATIONS: string[] = [
    '苹果', 'Apple', '谷歌', 'Google', '微软', 'Microsoft', '亚马逊', 'Amazon',
    '特斯拉', 'Tesla', '华为', '阿里巴巴', '腾讯', '百度', '字节跳动', '京东',
    '小米', 'OpenAI', 'Meta', 'Facebook', 'Twitter', 'X', 'SpaceX',
    'Netflix', '英伟达', 'NVIDIA', 'AMD', 'Intel', '三星', 'Samsung',
  ];

  // 常见人名
  private static readonly KNOWN_PERSONS: string[] = [
    '马斯克', 'Elon Musk', '库克', 'Tim Cook', '马云', '马化腾', '李彦宏',
    '雷军', '任正非', '刘强东', '张一鸣', '黄仁勋', '比尔盖茨', 'Bill Gates',
    '扎克伯格', 'Mark Zuckerberg', '贝索斯', 'Jeff Bezos', '乔布斯', 'Steve Jobs',
  ];

  // 常见产品/概念
  private static readonly KNOWN_PRODUCTS: string[] = [
    'iPhone', 'iPad', 'MacBook', 'Apple Watch', 'AirPods',
    'ChatGPT', 'GPT-4', 'GPT-4o', 'Claude', 'Gemini', 'Llama',
    'Model Y', 'Model 3', 'Model S', 'Model X', 'Cybertruck',
    '微信', 'WeChat', '支付宝', '淘宝', '抖音', 'TikTok',
  ];

  // 常见技术概念/术语
  private static readonly KNOWN_CONCEPTS: string[] = [
    // 网络技术
    'VPN', 'DNS', 'IP', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'SSL', 'TLS',
    'WiFi', 'WLAN', '路由器', '交换机', '防火墙', '代理', 'Proxy',
    'L2TP', 'PPTP', 'IPSec', 'OpenVPN', 'WireGuard', 'IKEv2',
    // 编程技术
    'API', 'SDK', 'REST', 'GraphQL', 'JSON', 'XML', 'SQL', 'NoSQL',
    'Docker', 'Kubernetes', 'K8s', 'Git', 'CI/CD', 'DevOps',
    'Python', 'Java', 'JavaScript', 'TypeScript', 'React', 'Vue', 'Angular',
    // AI/ML
    'AI', '人工智能', 'ML', '机器学习', 'DL', '深度学习', 'NLP', '自然语言处理',
    'LLM', '大模型', 'RAG', 'Embedding', '向量数据库', 'Transformer',
    // 系统
    'Windows', 'Linux', 'MacOS', 'Android', 'iOS',
    '驱动', '补丁', '更新', '重启', '安装', '卸载', '配置',
  ];

  /**
   * 使用规则识别实体（不依赖 LLM）
   */
  static extractEntitiesByRules(query: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const processedNames = new Set<string>();
    const queryLower = query.toLowerCase();

    // 1. 检查地名别称
    for (const [alias, standard] of Object.entries(this.LOCATION_ALIASES)) {
      if (query.includes(alias)) {
        entities.push({
          name: standard,
          type: 'LOCATION',
          value: alias,
          confidence: 0.95,
        });
        processedNames.add(alias);
        processedNames.add(standard);
      }
    }

    // 2. 检查已知地名
    for (const location of this.KNOWN_LOCATIONS) {
      if (query.includes(location) && !processedNames.has(location)) {
        entities.push({
          name: location,
          type: 'LOCATION',
          value: location,
          confidence: 0.9,
        });
        processedNames.add(location);
      }
    }

    // 3. 检查已知组织
    for (const org of this.KNOWN_ORGANIZATIONS) {
      if (query.includes(org) || queryLower.includes(org.toLowerCase())) {
        if (!processedNames.has(org)) {
          entities.push({
            name: org,
            type: 'ORGANIZATION',
            value: org,
            confidence: 0.9,
          });
          processedNames.add(org);
        }
      }
    }

    // 4. 检查已知人名
    for (const person of this.KNOWN_PERSONS) {
      if (query.includes(person) || queryLower.includes(person.toLowerCase())) {
        if (!processedNames.has(person)) {
          entities.push({
            name: person,
            type: 'PERSON',
            value: person,
            confidence: 0.9,
          });
          processedNames.add(person);
        }
      }
    }

    // 5. 检查已知产品
    for (const product of this.KNOWN_PRODUCTS) {
      if (query.includes(product) || queryLower.includes(product.toLowerCase())) {
        if (!processedNames.has(product)) {
          entities.push({
            name: product,
            type: 'PRODUCT',
            value: product,
            confidence: 0.85,
          });
          processedNames.add(product);
        }
      }
    }

    // 6. 检查已知技术概念
    for (const concept of this.KNOWN_CONCEPTS) {
      if (query.includes(concept) || queryLower.includes(concept.toLowerCase())) {
        if (!processedNames.has(concept) && !processedNames.has(concept.toLowerCase())) {
          entities.push({
            name: concept,
            type: 'CONCEPT',
            value: concept,
            confidence: 0.85,
          });
          processedNames.add(concept);
          processedNames.add(concept.toLowerCase());
        }
      }
    }

    // 7. 识别错误代码模式（如"报错 809"、"错误代码 500"、"error 404"）
    const errorPatterns = [
      /(?:报错|错误|错误代码|error|code|故障码|异常)[:\s]?(\d{2,5})/gi,
      /(\d{3,5})(?:错误|报错|异常|故障)/gi,
    ];
    
    for (const pattern of errorPatterns) {
      let match;
      while ((match = pattern.exec(query)) !== null) {
        const errorCode = match[1];
        if (!processedNames.has(errorCode)) {
          entities.push({
            name: `错误代码 ${errorCode}`,
            type: 'CONCEPT',
            value: errorCode,
            confidence: 0.9,
          });
          processedNames.add(errorCode);
        }
      }
    }

    return entities;
  }

  // 预处理结果
  static preprocess(query: string): {
    normalizedQuery: string;
    preMappedEntities: { original: string; normalized: string; type: EntityType }[];
  } {
    let normalizedQuery = query;
    const preMappedEntities: { original: string; normalized: string; type: EntityType }[] = [];

    // 检测并标记地名别称
    for (const [alias, standard] of Object.entries(this.LOCATION_ALIASES)) {
      if (query.includes(alias)) {
        preMappedEntities.push({
          original: alias,
          normalized: standard,
          type: 'LOCATION',
        });
        // 在查询中添加标注，帮助 LLM 理解
        normalizedQuery = normalizedQuery.replace(alias, `${alias}(即${standard})`);
      }
    }

    return { normalizedQuery, preMappedEntities };
  }

  // 后处理：校验和修正 LLM 输出
  static postprocess(
    entities: ExtractedEntity[], 
    preMappedEntities: { original: string; normalized: string; type: EntityType }[]
  ): ExtractedEntity[] {
    const correctedEntities: ExtractedEntity[] = [];
    const processedNames = new Set<string>();

    // 首先添加预映射的实体
    for (const preEntity of preMappedEntities) {
      correctedEntities.push({
        name: preEntity.normalized,
        type: preEntity.type,
        value: preEntity.original,
        confidence: 0.95, // 预映射的高置信度
      });
      processedNames.add(preEntity.original);
      processedNames.add(preEntity.normalized);
    }

    // 处理 LLM 返回的实体
    for (const entity of entities) {
      // 检查是否已经处理过（通过预映射）
      if (processedNames.has(entity.name) || processedNames.has(entity.value)) {
        continue;
      }

      // 检查是否是别称被错误分类
      const aliasCheck = this.LOCATION_ALIASES[entity.name] || this.LOCATION_ALIASES[entity.value];
      if (aliasCheck) {
        correctedEntities.push({
          name: aliasCheck,
          type: 'LOCATION',
          value: entity.value || entity.name,
          confidence: 0.9,
        });
        processedNames.add(entity.name);
        continue;
      }

      // 保留原实体
      correctedEntities.push(entity);
      processedNames.add(entity.name);
    }

    return correctedEntities;
  }
}

// ==================== 核心类实现 ====================

/**
 * 第一层：认知解析层
 * 负责实体提取和意图分类
 */
export class CognitiveParser {
  private llm: BaseChatModel;
  private modelName: string;

  constructor(model: string) {
    this.modelName = model;
    // 使用统一模型配置系统
    this.llm = createLLM(model, { 
      temperature: 0.1,
      options: { format: 'json' }
    });
  }

  /**
   * 检测模型能力等级
   */
  private getModelCapabilityLevel(): 'low' | 'medium' | 'high' {
    const modelLower = this.modelName.toLowerCase();
    
    // 小模型（参数量 < 3B）
    if (modelLower.includes('0.5b') || modelLower.includes('1b') || modelLower.includes('2b')) {
      return 'low';
    }
    // 中等模型（3B-13B）
    if (modelLower.includes('3b') || modelLower.includes('7b') || modelLower.includes('8b')) {
      return 'medium';
    }
    // 大模型（> 13B）
    return 'high';
  }

  /**
   * 解析用户查询，提取实体和逻辑关系
   */
  async parse(query: string): Promise<ParsedQuery> {
    // 快速路径：检测问候语/闲聊，直接返回空实体
    if (this.isGreetingOrSmallTalk(query)) {
      console.log(`[CognitiveParser] 检测到问候语/闲聊: "${query}"`);
      return {
        originalQuery: query,
        entities: [],
        logicalRelations: [],
        intent: 'exploratory',
        complexity: 'simple',
        confidence: 0.95,
        keywords: [],
      };
    }

    const capability = this.getModelCapabilityLevel();
    
    // 1. 首先使用规则提取实体（作为基础）
    const ruleBasedEntities = EntityPreprocessor.extractEntitiesByRules(query);
    if (ruleBasedEntities.length > 0) {
      console.log(`[CognitiveParser] 规则识别到 ${ruleBasedEntities.length} 个实体:`, 
        ruleBasedEntities.map(e => `${e.name}(${e.type})`).join(', '));
    }
    
    // 2. 对于低能力模型，使用预处理增强
    const { normalizedQuery, preMappedEntities } = capability === 'low' 
      ? EntityPreprocessor.preprocess(query)
      : { normalizedQuery: query, preMappedEntities: [] };
    
    if (preMappedEntities.length > 0) {
      console.log(`[CognitiveParser] 预处理识别到 ${preMappedEntities.length} 个实体:`, 
        preMappedEntities.map(e => `${e.original}→${e.normalized}`).join(', '));
    }

    try {
      const prompt = ENTITY_EXTRACTION_PROMPT.replace('{query}', normalizedQuery);
      const response = await this.llm.invoke(prompt);
      const content = typeof response.content === 'string' 
        ? response.content 
        : JSON.stringify(response.content);
      
      const parsed = this.safeParseJson(content);
      
      // 提取 LLM 返回的实体
      let llmEntities = (parsed.entities || []).map((e: any) => ({
        name: e.name || '',
        type: this.normalizeEntityType(e.type),
        value: e.value || e.name || '',
        confidence: parseFloat(e.confidence) || 0.8,
      }));

      // 验证实体：确保实体名称确实出现在原始查询中
      llmEntities = this.validateEntitiesAgainstQuery(llmEntities, query, normalizedQuery);

      // 对于低能力模型，应用后处理校验
      if (capability === 'low') {
        llmEntities = EntityPreprocessor.postprocess(llmEntities, preMappedEntities);
      }

      // 3. 合并规则提取和 LLM 提取的实体（规则提取优先）
      const entities = this.mergeEntities(ruleBasedEntities, llmEntities);
      
      console.log(`[CognitiveParser] 最终实体数: ${entities.length} (规则: ${ruleBasedEntities.length}, LLM: ${llmEntities.length})`);

      return {
        originalQuery: query,
        entities,
        logicalRelations: parsed.logicalRelations || [],
        intent: this.normalizeIntent(parsed.intent),
        complexity: entities.length > 2 ? 'complex' : entities.length > 0 ? 'moderate' : 'simple',
        confidence: parseFloat(parsed.confidence) || 0.8,
        keywords: parsed.keywords || [],
      };
    } catch (error) {
      console.error('[CognitiveParser] LLM 解析失败，使用规则提取:', error);
      // 降级处理：使用规则提取的实体
      return this.fallbackParse(query, preMappedEntities, ruleBasedEntities);
    }
  }

  /**
   * 检测是否为问候语或闲聊
   */
  private isGreetingOrSmallTalk(query: string): boolean {
    const greetings = [
      // 问候语
      '你好', '您好', 'hello', 'hi', '嗨', '哈喽', '早上好', '下午好', '晚上好',
      '早安', '午安', '晚安', 'good morning', 'good afternoon', 'good evening',
      // 闲聊
      '在吗', '在不在', '有人吗', '请问在吗',
      // 感谢
      '谢谢', '感谢', '多谢', 'thanks', 'thank you',
      // 告别
      '再见', '拜拜', 'bye', 'goodbye',
    ];
    
    const normalized = query.toLowerCase().trim();
    
    // 完全匹配
    if (greetings.some(g => normalized === g.toLowerCase())) {
      return true;
    }
    
    // 短查询且包含问候词
    if (normalized.length <= 10 && greetings.some(g => normalized.includes(g.toLowerCase()))) {
      return true;
    }
    
    return false;
  }

  /**
   * 验证实体是否确实出现在查询中，过滤掉幻觉实体
   */
  private validateEntitiesAgainstQuery(
    entities: ExtractedEntity[], 
    originalQuery: string,
    normalizedQuery: string
  ): ExtractedEntity[] {
    const queryLower = originalQuery.toLowerCase();
    const normalizedLower = normalizedQuery.toLowerCase();
    
    return entities.filter(entity => {
      const nameLower = entity.name.toLowerCase();
      const valueLower = (entity.value || '').toLowerCase();
      
      // 检查实体名称或值是否出现在查询中
      const inOriginal = queryLower.includes(nameLower) || queryLower.includes(valueLower);
      const inNormalized = normalizedLower.includes(nameLower) || normalizedLower.includes(valueLower);
      
      if (!inOriginal && !inNormalized) {
        console.log(`[CognitiveParser] 过滤幻觉实体: "${entity.name}" (不在查询中)`);
        return false;
      }
      
      return true;
    });
  }

  private normalizeEntityType(type: string): EntityType {
    const normalized = (type || '').toUpperCase();
    const validTypes: EntityType[] = ['PERSON', 'ORGANIZATION', 'LOCATION', 'PRODUCT', 'DATE', 'EVENT', 'CONCEPT', 'OTHER'];
    return validTypes.includes(normalized as EntityType) ? normalized as EntityType : 'OTHER';
  }

  private normalizeIntent(intent: string): IntentType {
    const normalized = (intent || '').toLowerCase();
    const validIntents: IntentType[] = ['factual', 'conceptual', 'comparison', 'procedural', 'exploratory'];
    return validIntents.includes(normalized as IntentType) ? normalized as IntentType : 'factual';
  }

  private fallbackParse(
    query: string, 
    preMappedEntities: { original: string; normalized: string; type: EntityType }[] = [],
    ruleBasedEntities: ExtractedEntity[] = []
  ): ParsedQuery {
    // 基于规则的简单提取
    const entities: ExtractedEntity[] = [];
    const keywords: string[] = [];
    const processedNames = new Set<string>();

    // 首先添加规则提取的实体（最高优先级）
    for (const ruleEntity of ruleBasedEntities) {
      entities.push(ruleEntity);
      processedNames.add(ruleEntity.name);
      processedNames.add(ruleEntity.value);
    }

    // 然后添加预映射的实体
    for (const preEntity of preMappedEntities) {
      if (!processedNames.has(preEntity.normalized)) {
        entities.push({
          name: preEntity.normalized,
          type: preEntity.type,
          value: preEntity.original,
          confidence: 0.95,
        });
        processedNames.add(preEntity.original);
        processedNames.add(preEntity.normalized);
      }
    }

    // 提取引号中的内容作为实体
    const quotedMatches = query.match(/["'"](.*?)["'"]/g);
    if (quotedMatches) {
      quotedMatches.forEach(match => {
        const value = match.replace(/["'"]/g, '');
        if (!processedNames.has(value)) {
          entities.push({
            name: value,
            type: 'OTHER',
            value,
            confidence: 0.7,
          });
          processedNames.add(value);
        }
      });
    }

    // 提取可能的产品名称（连续的英文+数字）
    const productMatches = query.match(/[A-Za-z]+\s*\d+(\s*[A-Za-z]*)?/g);
    if (productMatches) {
      productMatches.forEach(match => {
        const trimmed = match.trim();
        if (!processedNames.has(trimmed)) {
          entities.push({
            name: trimmed,
            type: 'PRODUCT',
            value: trimmed,
            confidence: 0.6,
          });
          processedNames.add(trimmed);
        }
      });
    }

    // 提取年份
    const yearMatches = query.match(/\d{4}年?/g);
    if (yearMatches) {
      yearMatches.forEach(match => {
        if (!processedNames.has(match)) {
          entities.push({
            name: match,
            type: 'DATE',
            value: match,
            confidence: 0.9,
          });
          processedNames.add(match);
        }
      });
    }

    // 提取关键词（去除停用词）
    const stopWords = ['的', '是', '在', '和', '与', '或', '了', '吗', '呢', '啊', '什么', '哪', '如何', '怎么', '怎样'];
    const words = query.split(/[\s,，。？！\?!]+/).filter(w => w.length > 1 && !stopWords.includes(w));
    keywords.push(...words.slice(0, 5));

    // 判断意图
    let intent: IntentType = 'factual';
    if (query.includes('是') && query.includes('么') || query.includes('是否') || query.includes('是不是')) {
      intent = 'comparison'; // "X是Y么" 类型的确认问题
    } else if (query.includes('比较') || query.includes('对比') || query.includes('区别')) {
      intent = 'comparison';
    } else if (query.includes('如何') || query.includes('怎么') || query.includes('步骤')) {
      intent = 'procedural';
    } else if (query.includes('什么是') || query.includes('解释') || query.includes('含义')) {
      intent = 'conceptual';
    }

    return {
      originalQuery: query,
      entities,
      logicalRelations: [],
      intent,
      complexity: entities.length > 2 ? 'complex' : entities.length > 0 ? 'moderate' : 'simple',
      confidence: 0.6,
      keywords,
    };
  }

  private safeParseJson(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      // 尝试提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
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

  /**
   * 合并规则提取和 LLM 提取的实体
   * 规则提取的实体优先级更高
   */
  private mergeEntities(ruleEntities: ExtractedEntity[], llmEntities: ExtractedEntity[]): ExtractedEntity[] {
    const merged: ExtractedEntity[] = [...ruleEntities];
    const existingNames = new Set(ruleEntities.map(e => e.name.toLowerCase()));

    for (const llmEntity of llmEntities) {
      const nameLower = llmEntity.name.toLowerCase();
      if (!existingNames.has(nameLower)) {
        merged.push(llmEntity);
        existingNames.add(nameLower);
      }
    }

    return merged;
  }
}

/**
 * 第二层：策略控制层
 * 维护状态，执行校验、路由和约束松弛
 */
export class StrategyController {
  private llm: BaseChatModel;
  private entityMetadataStore: EntityMetadataStore;
  private config: AdaptiveRAGConfig;

  constructor(config: AdaptiveRAGConfig, entityMetadataStore: EntityMetadataStore) {
    this.config = config;
    this.entityMetadataStore = entityMetadataStore;
    // 使用统一模型配置系统
    this.llm = createLLM(config.llmModel, {
      temperature: 0.1,
      options: { format: 'json' }
    });
  }

  /**
   * 校验实体
   */
  async validateEntities(entities: ExtractedEntity[]): Promise<ValidatedEntity[]> {
    const validated: ValidatedEntity[] = [];

    for (const entity of entities) {
      console.log(`[StrategyController] 校验实体: "${entity.name}", 类型: ${entity.type}`);
      
      // 获取候选实体
      const candidates = await this.entityMetadataStore.findSimilar(entity.name, entity.type, 5);
      
      if (candidates.length === 0) {
        // 没有候选，直接使用原始实体
        console.log(`[StrategyController] 无候选实体，使用原始值`);
        validated.push({
          ...entity,
          isValid: true,
          normalizedName: entity.name,
          matchScore: 1.0,
        });
        continue;
      }

      console.log(`[StrategyController] 找到 ${candidates.length} 个候选: ${candidates.map(c => c.standardName).join(', ')}`);

      // 优先查找别名匹配（用户输入的名称是某个实体的别名）
      const aliasMatch = candidates.find(c => 
        c.aliases.some(a => a.toLowerCase() === entity.name.toLowerCase())
      );

      if (aliasMatch) {
        console.log(`[StrategyController] 别名匹配: "${entity.name}" -> "${aliasMatch.standardName}"`);
        validated.push({
          ...entity,
          isValid: true,
          normalizedName: aliasMatch.standardName,
          matchScore: 1.0,
          normalized: aliasMatch.standardName,
          aliases: aliasMatch.aliases,
        });
        continue;
      }

      // 其次查找标准名称匹配
      const exactMatch = candidates.find(c => 
        c.standardName.toLowerCase() === entity.name.toLowerCase()
      );

      if (exactMatch) {
        console.log(`[StrategyController] 标准名称匹配: "${entity.name}" -> "${exactMatch.standardName}"`);
        validated.push({
          ...entity,
          isValid: true,
          normalizedName: exactMatch.standardName,
          matchScore: 1.0,
          normalized: exactMatch.standardName,
          aliases: exactMatch.aliases,
        });
        continue;
      }

      // 使用 LLM 进行模糊匹配
      try {
        const candidatesList = candidates.map(c => 
          `- ${c.standardName} (别名: ${c.aliases.join(', ')})`
        ).join('\n');

        const prompt = ENTITY_RESOLUTION_PROMPT
          .replace('{userEntity}', entity.name)
          .replace('{userType}', entity.type)
          .replace('{candidates}', candidatesList);

        const response = await this.llm.invoke(prompt);
        const content = typeof response.content === 'string' 
          ? response.content 
          : JSON.stringify(response.content);
        const result = this.safeParseJson(content);

        validated.push({
          ...entity,
          isValid: result.isMatch !== false,
          normalizedName: result.normalizedName || result.matchedEntity || entity.name,
          matchScore: parseFloat(result.confidence) || 0.7,
          suggestions: result.suggestions || [],
        });
      } catch (error) {
        console.error('[StrategyController] 实体校验失败:', error);
        validated.push({
          ...entity,
          isValid: true,
          normalizedName: entity.name,
          matchScore: 0.5,
        });
      }
    }

    return validated;
  }

  /**
   * 路由决策
   */
  makeRoutingDecision(
    query: ParsedQuery,
    validatedEntities: ValidatedEntity[],
    previousDecision?: RoutingDecision,
    resultCount: number = 0
  ): RoutingDecision {
    const retryCount = previousDecision?.retryCount || 0;
    const relaxedConstraints = previousDecision?.relaxedConstraints || [];

    // 如果有结果，直接生成响应
    if (resultCount >= this.config.minResultCount) {
      return {
        action: 'generate_response',
        constraints: previousDecision?.constraints || [],
        relaxedConstraints,
        retryCount,
        maxRetries: this.config.maxRetries,
        reason: `找到 ${resultCount} 个相关结果，准备生成回答`,
      };
    }

    // 如果已达到最大重试次数，降级为纯语义检索
    if (retryCount >= this.config.maxRetries) {
      return {
        action: 'semantic_search',
        constraints: [],
        relaxedConstraints,
        retryCount,
        maxRetries: this.config.maxRetries,
        reason: '多次尝试后仍无结果，降级为纯语义检索',
      };
    }

    // 如果是概念性问题，直接使用语义检索
    if (query.intent === 'conceptual' || query.intent === 'exploratory') {
      return {
        action: 'semantic_search',
        constraints: [],
        relaxedConstraints: [],
        retryCount: 0,
        maxRetries: this.config.maxRetries,
        reason: '概念性/探索性问题，使用语义检索',
      };
    }

    // 构建约束条件
    const constraints: SearchConstraint[] = validatedEntities
      .filter(e => e.isValid && !relaxedConstraints.includes(e.type))
      .map((entity, index) => ({
        field: this.getFieldNameForType(entity.type),
        operator: 'contains' as const,
        value: entity.normalizedName,
        priority: this.config.constraintPriority.indexOf(entity.type),
      }))
      .sort((a, b) => a.priority - b.priority);

    // 如果没有约束或者之前检索无结果，进行约束松弛
    if (constraints.length === 0 || (previousDecision && resultCount === 0)) {
      // 找到优先级最低的约束进行松弛
      const typeToRelax = this.findLowestPriorityType(validatedEntities, relaxedConstraints);
      
      if (typeToRelax && retryCount < this.config.maxRetries) {
        return {
          action: 'relax_constraints',
          constraints: constraints.filter(c => c.field !== this.getFieldNameForType(typeToRelax)),
          relaxedConstraints: [...relaxedConstraints, typeToRelax],
          retryCount: retryCount + 1,
          maxRetries: this.config.maxRetries,
          reason: `移除 ${typeToRelax} 约束，进行更宽泛的检索`,
        };
      }
    }

    // 有约束条件，使用结构化检索
    if (constraints.length > 0) {
      return {
        action: 'structured_search',
        constraints,
        relaxedConstraints,
        retryCount,
        maxRetries: this.config.maxRetries,
        reason: `使用 ${constraints.length} 个过滤条件进行结构化检索`,
      };
    }

    // 默认使用混合检索
    return {
      action: 'hybrid_search',
      constraints: [],
      relaxedConstraints,
      retryCount,
      maxRetries: this.config.maxRetries,
      reason: '无有效约束，使用混合检索',
    };
  }

  private findLowestPriorityType(entities: ValidatedEntity[], relaxed: string[]): EntityType | null {
    const unreleaxedTypes = entities
      .filter(e => e.isValid && !relaxed.includes(e.type))
      .map(e => e.type);

    if (unreleaxedTypes.length === 0) return null;

    // 按优先级排序（低优先级在前）
    const sorted = [...unreleaxedTypes].sort((a, b) => 
      this.config.constraintPriority.indexOf(b) - this.config.constraintPriority.indexOf(a)
    );

    return sorted[0];
  }

  private getFieldNameForType(type: EntityType): string {
    const mapping: Record<EntityType, string> = {
      PERSON: 'person',
      ORGANIZATION: 'organization',
      LOCATION: 'location',
      PRODUCT: 'product',
      DATE: 'date',
      EVENT: 'event',
      CONCEPT: 'concept',
      OTHER: 'content',
    };
    return mapping[type] || 'content';
  }

  private safeParseJson(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
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

/**
 * 第三层：执行检索层
 * 执行具体的检索操作
 */
export class SearchExecutor {
  private embeddings: Embeddings;
  private config: AdaptiveRAGConfig;
  private llm: BaseChatModel;
  private milvus: MilvusVectorStore | null = null;

  constructor(config: AdaptiveRAGConfig) {
    this.config = config;
    // 使用统一模型配置系统
    this.embeddings = createEmbedding(config.embeddingModel);
    this.llm = createLLM(config.llmModel, { temperature: 0.1 });
  }

  /**
   * 获取或初始化 Milvus 实例
   * 注意：前端已确保选择的 embedding 模型与集合维度兼容
   */
  private async getMilvusClient(): Promise<MilvusVectorStore> {
    if (!this.milvus) {
      // 使用配置的 embedding 模型维度
      const dimension = getModelDimension(this.config.embeddingModel) || 768;
      
      this.milvus = getMilvusInstance({
        collectionName: this.config.milvusCollection,
        embeddingDimension: dimension,
      });
      
      // 连接并验证维度
      try {
        await this.milvus.connect();
        const stats = await this.milvus.getCollectionStats();
        const collectionDimension = stats?.embeddingDimension;
        
        if (collectionDimension && collectionDimension !== dimension) {
          console.error(`[SearchExecutor] ⚠️ 维度不匹配: 模型 ${this.config.embeddingModel} (${dimension}D) vs 集合 (${collectionDimension}D)`);
          console.error(`[SearchExecutor] 请在前端选择与知识库兼容的 embedding 模型`);
        }
      } catch (error) {
        console.log('[SearchExecutor] 无法验证集合维度，继续使用配置的维度');
      }
    }
    return this.milvus;
  }

  /**
   * 结构化检索（带过滤条件）
   */
  async structuredSearch(
    query: string,
    constraints: SearchConstraint[],
    topK: number = 10
  ): Promise<SearchResult[]> {
    try {
      // 构建 Milvus 过滤表达式
      const filterExpr = this.buildFilterExpression(constraints);
      
      // 将实体名称加入查询文本以增强语义搜索
      // 这样向量搜索能更好地找到包含这些实体的文档
      const entityValues = constraints
        .filter(c => c.operator === 'contains' && c.value)
        .map(c => String(c.value));
      
      const enhancedQuery = entityValues.length > 0
        ? `${query} ${entityValues.join(' ')}`
        : query;
      
      console.log(`[SearchExecutor] 增强查询: "${enhancedQuery.substring(0, 100)}..."`);
      
      // 生成查询向量
      const queryVector = await this.embeddings.embedQuery(enhancedQuery);

      // 获取 Milvus 客户端并执行搜索
      const milvus = await this.getMilvusClient();
      const results = await milvus.search(
        queryVector,
        topK,
        this.config.similarityThreshold,
        filterExpr || undefined
      );

      // 对结果进行实体匹配后处理（提升包含实体的文档得分）
      return results.map((r: MilvusSearchResult) => {
        let boostedScore = r.score;
        
        // 检查内容中是否包含目标实体
        if (entityValues.length > 0) {
          const contentLower = r.content.toLowerCase();
          const matchedEntities = entityValues.filter(e => 
            contentLower.includes(e.toLowerCase())
          );
          
          // 每匹配一个实体，提升 10% 的得分
          if (matchedEntities.length > 0) {
            boostedScore = Math.min(1.0, r.score * (1 + 0.1 * matchedEntities.length));
          }
        }
        
        return {
          id: r.id,
          content: r.content,
          score: boostedScore,
          metadata: r.metadata || {},
          matchType: 'structured' as const,
        };
      });
    } catch (error) {
      console.error('[SearchExecutor] 结构化检索失败:', error);
      return [];
    }
  }

  /**
   * 语义检索（纯向量搜索）
   */
  async semanticSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    try {
      console.log(`[SearchExecutor] 语义检索: "${query.substring(0, 50)}...", topK=${topK}, threshold=${this.config.similarityThreshold}`);
      const queryVector = await this.embeddings.embedQuery(query);
      console.log(`[SearchExecutor] 生成查询向量完成, 维度: ${queryVector.length}`);

      // 获取 Milvus 客户端并执行搜索
      const milvus = await this.getMilvusClient();
      const results = await milvus.search(
        queryVector,
        topK,
        this.config.similarityThreshold
      );
      
      console.log(`[SearchExecutor] Milvus 返回 ${results.length} 个结果`);
      if (results.length > 0) {
        console.log(`[SearchExecutor] 第一个结果: score=${results[0].score}, contentLength=${results[0].content?.length}`);
      }

      return results.map((r: MilvusSearchResult) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        metadata: r.metadata || {},
        matchType: 'semantic' as const,
      }));
    } catch (error) {
      console.error('[SearchExecutor] 语义检索失败:', error);
      return [];
    }
  }

  /**
   * 混合检索
   */
  async hybridSearch(
    query: string,
    constraints: SearchConstraint[],
    topK: number = 10
  ): Promise<SearchResult[]> {
    // 并行执行结构化和语义检索
    const [structuredResults, semanticResults] = await Promise.all([
      this.structuredSearch(query, constraints, topK),
      this.semanticSearch(query, topK),
    ]);

    // 合并去重
    const resultMap = new Map<string, SearchResult>();
    
    structuredResults.forEach(r => {
      resultMap.set(r.id, { ...r, matchType: 'hybrid' });
    });
    
    semanticResults.forEach(r => {
      if (resultMap.has(r.id)) {
        // 已存在，取更高分数
        const existing = resultMap.get(r.id)!;
        if (r.score > existing.score) {
          resultMap.set(r.id, { ...r, matchType: 'hybrid' });
        }
      } else {
        resultMap.set(r.id, { ...r, matchType: 'hybrid' });
      }
    });

    // 按分数排序
    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * 重排序
   */
  async rerank(
    results: SearchResult[],
    query: ParsedQuery,
    topK: number = 5
  ): Promise<RankedResult[]> {
    if (!this.config.enableReranking || results.length === 0) {
      return results.map(r => ({
        ...r,
        rerankedScore: r.score,
        relevanceExplanation: '未启用重排序',
      }));
    }

    const rankedResults: RankedResult[] = [];

    for (const result of results.slice(0, Math.min(results.length, 10))) {
      try {
        const prompt = RERANKING_PROMPT
          .replace('{query}', query.originalQuery)
          .replace('{intent}', query.intent)
          .replace('{entities}', query.entities.map(e => e.name).join(', '))
          .replace('{document}', result.content.substring(0, 1500));

        const response = await this.llm.invoke(prompt);
        const content = typeof response.content === 'string' 
          ? response.content 
          : JSON.stringify(response.content);
        
        const parsed = this.safeParseJson(content);
        
        rankedResults.push({
          ...result,
          rerankedScore: parseFloat(parsed.relevanceScore) || result.score,
          relevanceExplanation: parsed.explanation || '',
        });
      } catch (error) {
        console.error('[SearchExecutor] 重排序失败:', error);
        rankedResults.push({
          ...result,
          rerankedScore: result.score,
          relevanceExplanation: '重排序失败',
        });
      }
    }

    return rankedResults
      .sort((a, b) => b.rerankedScore - a.rerankedScore)
      .slice(0, topK);
  }

  private buildFilterExpression(constraints: SearchConstraint[]): string {
    if (constraints.length === 0) return '';

    const expressions = constraints.map(c => {
      switch (c.operator) {
        case 'eq':
          return `${c.field} == "${c.value}"`;
        case 'contains':
          // Milvus 不支持 LIKE '%xxx%' 模式，只支持前缀匹配 'xxx%' 或精确匹配
          // 对于 content 字段使用前缀匹配，其他字段跳过（依赖向量语义搜索）
          if (c.field === 'content') {
            // 使用前缀匹配（Milvus 支持）
            return `${c.field} like "${c.value}%"`;
          }
          // 对于实体字段（person, organization 等），跳过 filter
          // 因为这些字段可能不存在于 Milvus schema 中
          // 依赖向量搜索的语义相似度来召回相关文档
          console.log(`[SearchExecutor] 跳过 contains 约束: ${c.field}="${c.value}" (依赖语义搜索)`);
          return '';
        case 'in':
          return `${c.field} in [${(c.value as string[]).map(v => `"${v}"`).join(', ')}]`;
        case 'not':
          return `${c.field} != "${c.value}"`;
        default:
          return '';
      }
    }).filter(e => e);

    return expressions.join(' && ');
  }

  private safeParseJson(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
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

/**
 * 第四层：数据基础设施层 - 实体元数据存储
 * 支持持久化到文件系统
 */
export class EntityMetadataStore {
  private entities: Map<string, EntityMetadata> = new Map();
  private embeddings: Embeddings;
  private persistPath: string;
  private isInitialized: boolean = false;

  constructor(embeddingModel: string, persistPath?: string) {
    // 使用统一模型配置系统
    this.embeddings = createEmbedding(embeddingModel);
    this.persistPath = persistPath || './data/entity-metadata.json';
  }

  /**
   * 初始化：加载持久化数据或使用默认映射
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    const loaded = await this.loadFromFile();
    if (!loaded) {
      // 如果没有持久化数据，使用默认映射
      this.initializeDefaultMappings();
      await this.saveToFile();
    }
    this.isInitialized = true;
  }

  /**
   * 从文件加载实体数据
   */
  private async loadFromFile(): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const fullPath = path.resolve(process.cwd(), this.persistPath);
      const data = await fs.readFile(fullPath, 'utf-8');
      const parsed = JSON.parse(data);
      
      if (parsed.entities && Array.isArray(parsed.entities)) {
        this.entities.clear();
        for (const entity of parsed.entities) {
          this.entities.set(entity.standardName.toLowerCase(), entity);
        }
        console.log(`[EntityMetadataStore] 从文件加载了 ${this.entities.size} 个实体`);
        return true;
      }
      return false;
    } catch (error) {
      console.log('[EntityMetadataStore] 无持久化文件，将使用默认映射');
      return false;
    }
  }

  /**
   * 保存实体数据到文件
   */
  async saveToFile(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const fullPath = path.resolve(process.cwd(), this.persistPath);
      const dir = path.dirname(fullPath);
      
      // 确保目录存在
      await fs.mkdir(dir, { recursive: true });
      
      const data = {
        version: '1.0',
        updatedAt: new Date().toISOString(),
        entities: Array.from(this.entities.values()),
      };
      
      await fs.writeFile(fullPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[EntityMetadataStore] 保存了 ${this.entities.size} 个实体到文件`);
    } catch (error) {
      console.error('[EntityMetadataStore] 保存失败:', error);
    }
  }

  private initializeDefaultMappings() {
    // 地点同义词
    this.addEntity({
      standardName: '上海',
      type: 'LOCATION',
      aliases: ['魔都', 'Shanghai', '沪'],
      hierarchy: ['中国', '上海'],
    });
    this.addEntity({
      standardName: '北京',
      type: 'LOCATION',
      aliases: ['帝都', 'Beijing', '京'],
      hierarchy: ['中国', '北京'],
    });
    this.addEntity({
      standardName: '深圳',
      type: 'LOCATION',
      aliases: ['鹏城', 'Shenzhen'],
      hierarchy: ['中国', '广东', '深圳'],
    });

    // 公司同义词
    this.addEntity({
      standardName: 'Apple',
      type: 'ORGANIZATION',
      aliases: ['苹果', '苹果公司', 'Apple Inc.', 'AAPL'],
    });
    this.addEntity({
      standardName: 'Google',
      type: 'ORGANIZATION',
      aliases: ['谷歌', 'Alphabet', 'GOOG'],
    });
    this.addEntity({
      standardName: 'Microsoft',
      type: 'ORGANIZATION',
      aliases: ['微软', 'MS', 'MSFT'],
    });
    this.addEntity({
      standardName: 'Tesla',
      type: 'ORGANIZATION',
      aliases: ['特斯拉', 'TSLA'],
    });
    this.addEntity({
      standardName: 'SpaceX',
      type: 'ORGANIZATION',
      aliases: ['太空探索技术公司', 'Space Exploration Technologies Corp.'],
    });

    // 人物同义词
    this.addEntity({
      standardName: 'Elon Musk',
      type: 'PERSON',
      aliases: ['马斯克', '埃隆·马斯克', '老马', 'Musk'],
    });
    this.addEntity({
      standardName: 'Tim Cook',
      type: 'PERSON',
      aliases: ['库克', '蒂姆·库克'],
    });

    // 产品同义词
    this.addEntity({
      standardName: 'iPhone 15',
      type: 'PRODUCT',
      aliases: ['iPhone15', 'iPhone 15 Pro', 'iPhone 15 Pro Max'],
    });
    this.addEntity({
      standardName: 'ChatGPT',
      type: 'PRODUCT',
      aliases: ['GPT', 'GPT-4', 'GPT-4o', 'OpenAI GPT'],
    });
  }

  addEntity(metadata: EntityMetadata, persist: boolean = false): void {
    // 使用标准名称作为主键存储
    this.entities.set(metadata.standardName.toLowerCase(), metadata);
    
    console.log(`[EntityMetadataStore] 添加实体: ${metadata.standardName}, 类型: ${metadata.type}, 别名: ${metadata.aliases.join(', ')}`);
    
    // 如果需要持久化，保存到文件
    if (persist) {
      this.saveToFile().catch(err => console.error('[EntityMetadataStore] 持久化失败:', err));
    }
  }

  /**
   * 删除实体
   */
  removeEntity(standardName: string, persist: boolean = false): boolean {
    const key = standardName.toLowerCase();
    const deleted = this.entities.delete(key);
    
    if (deleted) {
      console.log(`[EntityMetadataStore] 删除实体: ${standardName}`);
      if (persist) {
        this.saveToFile().catch(err => console.error('[EntityMetadataStore] 持久化失败:', err));
      }
    }
    return deleted;
  }

  /**
   * 更新实体
   */
  updateEntity(standardName: string, updates: Partial<EntityMetadata>, persist: boolean = false): boolean {
    const key = standardName.toLowerCase();
    const existing = this.entities.get(key);
    
    if (existing) {
      const updated = { ...existing, ...updates };
      this.entities.set(key, updated);
      console.log(`[EntityMetadataStore] 更新实体: ${standardName}`);
      if (persist) {
        this.saveToFile().catch(err => console.error('[EntityMetadataStore] 持久化失败:', err));
      }
      return true;
    }
    return false;
  }

  /**
   * 清空所有实体（保留默认映射）
   */
  async reset(): Promise<void> {
    this.entities.clear();
    this.initializeDefaultMappings();
    await this.saveToFile();
    console.log('[EntityMetadataStore] 已重置为默认映射');
  }

  async findSimilar(name: string, type: EntityType, topK: number = 5): Promise<EntityMetadata[]> {
    const exactTypeMatches: EntityMetadata[] = [];  // 类型完全匹配的
    const aliasMatches: EntityMetadata[] = [];      // 别名匹配的（优先级高）
    const fuzzyMatches: EntityMetadata[] = [];      // 模糊匹配的
    const lowerName = name.toLowerCase();

    console.log(`[EntityMetadataStore] 查找实体: "${name}", 类型: ${type}`);

    // 遍历所有实体
    for (const [key, metadata] of this.entities) {
      // 1. 别名精确匹配（优先级最高）
      if (metadata.aliases.some(a => a.toLowerCase() === lowerName)) {
        console.log(`[EntityMetadataStore] 找到别名匹配: "${name}" -> "${metadata.standardName}"`);
        // 类型匹配的优先
        if (metadata.type === type || metadata.type === 'PERSON' && type === 'OTHER' || type === 'PERSON' && metadata.type === 'OTHER') {
          if (!exactTypeMatches.find(c => c.standardName === metadata.standardName)) {
            exactTypeMatches.unshift(metadata); // 添加到最前面
          }
        } else {
          if (!aliasMatches.find(c => c.standardName === metadata.standardName)) {
            aliasMatches.push(metadata);
          }
        }
        continue;
      }

      // 2. 标准名称精确匹配
      if (key === lowerName) {
        // 如果类型匹配，高优先级
        if (metadata.type === type) {
          if (!exactTypeMatches.find(c => c.standardName === metadata.standardName)) {
            exactTypeMatches.push(metadata);
          }
        } else {
          // 类型不匹配，低优先级
          if (!fuzzyMatches.find(c => c.standardName === metadata.standardName)) {
            fuzzyMatches.push(metadata);
          }
        }
        continue;
      }

      // 3. 模糊匹配
      const typeCompatible = metadata.type === type || type === 'OTHER' || metadata.type === 'OTHER';
      if (typeCompatible) {
        const similarity = this.calculateSimilarity(lowerName, key);
        if (similarity > 0.5 && !fuzzyMatches.find(c => c.standardName === metadata.standardName)) {
          fuzzyMatches.push(metadata);
        }
        
        // 检查与别名的相似度
        for (const alias of metadata.aliases) {
          const aliasSimilarity = this.calculateSimilarity(lowerName, alias.toLowerCase());
          if (aliasSimilarity > 0.6 && !fuzzyMatches.find(c => c.standardName === metadata.standardName)) {
            fuzzyMatches.push(metadata);
            break;
          }
        }
      }
    }

    // 合并结果：别名精确匹配 > 类型匹配 > 模糊匹配
    const candidates = [...exactTypeMatches, ...aliasMatches, ...fuzzyMatches];
    
    // 去重
    const uniqueCandidates: EntityMetadata[] = [];
    for (const c of candidates) {
      if (!uniqueCandidates.find(u => u.standardName === c.standardName)) {
        uniqueCandidates.push(c);
      }
    }

    console.log(`[EntityMetadataStore] 返回 ${Math.min(uniqueCandidates.length, topK)} 个候选实体`);
    return uniqueCandidates.slice(0, topK);
  }

  private calculateSimilarity(a: string, b: string): number {
    // 简单的 Jaccard 相似度
    const setA = new Set(a.split(''));
    const setB = new Set(b.split(''));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
  }

  getAllEntities(): EntityMetadata[] {
    return Array.from(this.entities.values());
  }

  getEntitiesByType(type: EntityType): EntityMetadata[] {
    return Array.from(this.entities.values()).filter(e => e.type === type);
  }
}

/**
 * 响应生成器
 */
export class ResponseGenerator {
  private llm: BaseChatModel;

  constructor(model: string) {
    // 使用统一模型配置系统
    this.llm = createLLM(model, { temperature: 0.7 });
  }

  async generate(
    query: ParsedQuery,
    results: RankedResult[]
  ): Promise<string> {
    console.log(`[ResponseGenerator] 收到 ${results.length} 个结果进行生成`);
    if (results.length === 0) {
      console.log('[ResponseGenerator] 无结果，返回默认消息');
      return '抱歉，未能找到与您问题相关的信息。请尝试使用不同的关键词或更简洁的表述。';
    }

    const context = results
      .slice(0, 5)
      .map((r, i) => `[文档${i + 1}] (相关度: ${(r.rerankedScore * 100).toFixed(1)}%)\n${r.content}`)
      .join('\n\n---\n\n');

    const prompt = RESPONSE_GENERATION_PROMPT
      .replace('{query}', query.originalQuery)
      .replace('{intent}', query.intent)
      .replace('{entities}', query.entities.map(e => `${e.name}(${e.type})`).join(', '))
      .replace('{context}', context);

    try {
      const response = await this.llm.invoke(prompt);
      return typeof response.content === 'string' 
        ? response.content 
        : JSON.stringify(response.content);
    } catch (error) {
      console.error('[ResponseGenerator] 生成失败:', error);
      return '抱歉，生成回答时出现错误。请稍后重试。';
    }
  }
}

/**
 * 主控制器 - 自适应实体路由 RAG
 */
export class AdaptiveEntityRAG {
  private config: AdaptiveRAGConfig;
  private cognitiveParser: CognitiveParser;
  private strategyController: StrategyController;
  private searchExecutor: SearchExecutor;
  private entityMetadataStore: EntityMetadataStore;
  private responseGenerator: ResponseGenerator;
  private initialized: boolean = false;

  constructor(config: Partial<AdaptiveRAGConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 使用持久化路径
    const persistPath = './data/adaptive-entity-metadata.json';
    this.entityMetadataStore = new EntityMetadataStore(this.config.embeddingModel, persistPath);
    this.cognitiveParser = new CognitiveParser(this.config.llmModel);
    this.strategyController = new StrategyController(this.config, this.entityMetadataStore);
    this.searchExecutor = new SearchExecutor(this.config);
    this.responseGenerator = new ResponseGenerator(this.config.llmModel);
  }

  /**
   * 初始化（加载持久化数据）
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.entityMetadataStore.initialize();
    this.initialized = true;
    console.log('[AdaptiveEntityRAG] 系统已初始化');
  }

  /**
   * 确保已初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * 执行完整的 RAG 流程
   */
  async query(question: string, topK: number = 5): Promise<WorkflowState> {
    // 确保已初始化（加载持久化数据）
    await this.ensureInitialized();
    
    const startTime = Date.now();
    const steps: WorkflowStep[] = [];

    // 初始化时提供有意义的默认值，即使后续出错也能返回
    let state: WorkflowState = {
      query: {
        originalQuery: question,
        entities: [],
        logicalRelations: [],
        intent: 'factual',
        complexity: 'simple',
        confidence: 0.5,
        keywords: [],
      },
      validatedEntities: [],
      currentDecision: {
        action: 'semantic_search',
        constraints: [],
        retryCount: 0,
        maxRetries: this.config.maxRetries,
        reason: '初始化',
      },
      searchResults: [],
      rankedResults: [],
      finalResponse: '',
      steps: [],
      totalDuration: 0,
    };

    try {
      // Step 1: 认知解析
      const parseStep = this.createStep('认知解析 (实体提取)');
      steps.push(parseStep);
      parseStep.status = 'running';
      
      const parseStart = Date.now();
      state.query = await this.cognitiveParser.parse(question);
      parseStep.duration = Date.now() - parseStart;
      parseStep.status = 'completed';
      parseStep.details = {
        // 基础统计
        entityCount: state.query.entities.length,
        intent: state.query.intent,
        complexity: state.query.complexity,
        confidence: state.query.confidence,
        keywordCount: state.query.keywords.length,
        // 详细操作
        operations: [
          `输入查询: "${question}"`,
          `使用 LLM 模型: ${this.config.llmModel}`,
          state.query.entities.length > 0 
            ? `提取实体: ${state.query.entities.map(e => `${e.name}(${e.type})`).join(', ')}`
            : '未检测到命名实体',
          `识别意图: ${this.getIntentDescription(state.query.intent)}`,
          `复杂度评估: ${state.query.complexity}`,
          `提取关键词: ${state.query.keywords.join(', ') || '无'}`,
        ],
        // 原始数据
        extractedEntities: state.query.entities.map(e => ({
          name: e.name,
          type: e.type,
          confidence: e.confidence,
        })),
        keywords: state.query.keywords,
        logicalRelations: state.query.logicalRelations,
      };

      // Step 2: 实体校验
      const validateStep = this.createStep('实体校验与归一化');
      steps.push(validateStep);
      validateStep.status = 'running';

      const validateStart = Date.now();
      state.validatedEntities = await this.strategyController.validateEntities(state.query.entities);
      validateStep.duration = Date.now() - validateStart;
      validateStep.status = 'completed';
      
      // 构建详细的校验操作描述
      const validationOperations: string[] = [];
      if (state.query.entities.length === 0) {
        validationOperations.push('无实体需要校验');
      } else {
        validationOperations.push(`待校验实体数: ${state.query.entities.length}`);
        for (const ve of state.validatedEntities) {
          if (ve.normalizedName && ve.normalizedName !== ve.name) {
            validationOperations.push(`✓ "${ve.name}" → "${ve.normalizedName}" (别名匹配)`);
          } else if (ve.isValid) {
            validationOperations.push(`✓ "${ve.name}" 已验证 (置信度: ${((ve.matchScore || 1) * 100).toFixed(0)}%)`);
          } else {
            validationOperations.push(`✗ "${ve.name}" 未找到匹配实体`);
          }
        }
      }
      
      validateStep.details = {
        validatedCount: state.validatedEntities.filter(e => e.isValid).length,
        totalCount: state.validatedEntities.length,
        normalizedCount: state.validatedEntities.filter(e => e.normalizedName && e.normalizedName !== e.name).length,
        operations: validationOperations,
        validatedEntities: state.validatedEntities.map(e => ({
          original: e.name,
          normalized: e.normalizedName,
          type: e.type,
          isValid: e.isValid,
          matchScore: e.matchScore,
          aliases: e.aliases,
        })),
      };

      // Step 3: 路由决策与检索循环
      let retryCount = 0;
      let results: SearchResult[] = [];

      while (retryCount <= this.config.maxRetries) {
        // 做出路由决策
        const routingStep = this.createStep(`路由决策${retryCount > 0 ? ` (重试 ${retryCount})` : ''}`);
        steps.push(routingStep);
        routingStep.status = 'running';

        state.currentDecision = this.strategyController.makeRoutingDecision(
          state.query,
          state.validatedEntities,
          retryCount > 0 ? state.currentDecision : undefined,
          results.length
        );

        // 构建路由决策的详细操作描述
        const routingOperations: string[] = [
          `分析查询复杂度: ${state.query.complexity}`,
          `有效实体数: ${state.validatedEntities.filter(e => e.isValid).length}`,
          `决策结果: ${this.getSearchTypeName(state.currentDecision.action)}`,
          `决策原因: ${state.currentDecision.reason}`,
        ];
        
        if (state.currentDecision.constraints.length > 0) {
          routingOperations.push(`约束条件: ${state.currentDecision.constraints.map(c => 
            `${c.field}${c.operator}${c.value}`
          ).join(', ')}`);
        }
        
        if (state.currentDecision.relaxedConstraints && state.currentDecision.relaxedConstraints.length > 0) {
          routingOperations.push(`松弛约束: ${state.currentDecision.relaxedConstraints.join(', ')}`);
        }

        routingStep.status = 'completed';
        routingStep.details = {
          action: state.currentDecision.action,
          actionName: this.getSearchTypeName(state.currentDecision.action),
          reason: state.currentDecision.reason,
          constraintCount: state.currentDecision.constraints.length,
          retryCount: retryCount,
          operations: routingOperations,
          constraints: state.currentDecision.constraints,
          relaxedConstraints: state.currentDecision.relaxedConstraints,
        };

        // 如果决定生成响应，跳出循环
        if (state.currentDecision.action === 'generate_response') {
          break;
        }

        // 执行检索
        const searchTypeName = this.getSearchTypeName(state.currentDecision.action);
        const searchStep = this.createStep(`执行${searchTypeName}`);
        steps.push(searchStep);
        searchStep.status = 'running';

        const searchStart = Date.now();
        const searchOperations: string[] = [
          `检索类型: ${searchTypeName}`,
          `目标数量: ${topK * 2}`,
          `使用 Embedding 模型: ${this.config.embeddingModel}`,
          `Milvus 集合: ${this.config.milvusCollection}`,
        ];

        switch (state.currentDecision.action) {
          case 'structured_search':
            searchOperations.push(`结构化过滤: ${state.currentDecision.constraints.map(c => 
              `${c.field}${c.operator}${c.value}`
            ).join(' AND ')}`);
            results = await this.searchExecutor.structuredSearch(
              question,
              state.currentDecision.constraints,
              topK * 2
            );
            break;
          case 'semantic_search':
            searchOperations.push('纯语义向量检索（无过滤条件）');
            results = await this.searchExecutor.semanticSearch(question, topK * 2);
            break;
          case 'hybrid_search':
            searchOperations.push('混合检索: 结构化过滤 + 语义检索');
            searchOperations.push(`过滤条件: ${state.currentDecision.constraints.map(c => 
              `${c.field}${c.operator}${c.value}`
            ).join(' AND ')}`);
            results = await this.searchExecutor.hybridSearch(
              question,
              state.currentDecision.constraints,
              topK * 2
            );
            break;
          case 'relax_constraints':
            searchOperations.push('约束松弛后重新检索');
            if (state.currentDecision.relaxedConstraints) {
              searchOperations.push(`已松弛: ${state.currentDecision.relaxedConstraints.join(', ')}`);
            }
            results = await this.searchExecutor.structuredSearch(
              question,
              state.currentDecision.constraints,
              topK * 2
            );
            break;
        }

        searchStep.duration = Date.now() - searchStart;
        searchOperations.push(`检索耗时: ${searchStep.duration}ms`);
        searchOperations.push(`返回结果: ${results.length} 条`);
        
        // 添加 Top 3 结果预览
        if (results.length > 0) {
          searchOperations.push('--- Top 3 结果预览 ---');
          results.slice(0, 3).forEach((r, i) => {
            searchOperations.push(`[${i + 1}] 相似度: ${(r.score * 100).toFixed(1)}% | ${r.content.substring(0, 50)}...`);
          });
        }
        
        searchStep.status = 'completed';
        searchStep.details = {
          resultCount: results.length,
          matchType: state.currentDecision.action,
          matchTypeName: searchTypeName,
          operations: searchOperations,
          topResults: results.slice(0, 5).map(r => ({
            id: r.id,
            score: r.score,
            contentPreview: r.content.substring(0, 100),
            matchType: r.matchType,
          })),
        };

        state.searchResults = results;

        // 如果有结果或者已经是语义检索，跳出循环
        if (results.length >= this.config.minResultCount || state.currentDecision.action === 'semantic_search') {
          break;
        }

        retryCount++;
      }

      // Step 4: 重排序
      console.log(`[AdaptiveEntityRAG] 搜索结果数量: ${state.searchResults.length}`);
      const rerankStep = this.createStep('混合重排序');
      steps.push(rerankStep);
      
      const rerankOperations: string[] = [];
      
      if (state.searchResults.length > 0) {
        rerankStep.status = this.config.enableReranking ? 'running' : 'skipped';

        if (this.config.enableReranking) {
          rerankOperations.push(`输入结果数: ${state.searchResults.length}`);
          rerankOperations.push(`目标输出数: ${topK}`);
          rerankOperations.push('使用 LLM 进行相关性重排序');
          
          const rerankStart = Date.now();
          state.rankedResults = await this.searchExecutor.rerank(state.searchResults, state.query, topK);
          rerankStep.duration = Date.now() - rerankStart;
          rerankStep.status = 'completed';
          
          rerankOperations.push(`重排序耗时: ${rerankStep.duration}ms`);
          rerankOperations.push(`输出结果数: ${state.rankedResults.length}`);
          
          // 显示重排序前后的变化
          if (state.rankedResults.length > 0) {
            rerankOperations.push('--- 重排序结果 ---');
            state.rankedResults.slice(0, 3).forEach((r, i) => {
              const originalScore = (r.score * 100).toFixed(1);
              const newScore = (r.rerankedScore * 100).toFixed(1);
              rerankOperations.push(`[${i + 1}] ${originalScore}% → ${newScore}% | ${r.relevanceExplanation || ''}`);
            });
          }
          
          rerankStep.details = {
            inputCount: state.searchResults.length,
            outputCount: state.rankedResults.length,
            enabled: true,
            operations: rerankOperations,
            rankedResults: state.rankedResults.slice(0, 5).map(r => ({
              id: r.id,
              originalScore: r.score,
              rerankedScore: r.rerankedScore,
              explanation: r.relevanceExplanation,
            })),
          };
        } else {
          rerankOperations.push('重排序已禁用');
          rerankOperations.push('直接使用原始相似度分数');
          
          state.rankedResults = state.searchResults.map(r => ({
            ...r,
            rerankedScore: r.score,
            relevanceExplanation: '未启用重排序',
          }));
          
          rerankStep.details = {
            inputCount: state.searchResults.length,
            outputCount: state.rankedResults.length,
            enabled: false,
            operations: rerankOperations,
          };
        }
        console.log(`[AdaptiveEntityRAG] 重排序后结果数量: ${state.rankedResults.length}`);
      } else {
        rerankStep.status = 'skipped';
        rerankOperations.push('⚠️ 无搜索结果，跳过重排序');
        rerankStep.details = {
          inputCount: 0,
          outputCount: 0,
          enabled: false,
          operations: rerankOperations,
          reason: '搜索结果为空',
        };
        console.log('[AdaptiveEntityRAG] ⚠️ 搜索结果为空！');
      }

      // Step 5: 生成响应
      const generateStep = this.createStep('生成响应');
      steps.push(generateStep);
      generateStep.status = 'running';

      const generateOperations: string[] = [
        `使用 LLM 模型: ${this.config.llmModel}`,
        `输入上下文数: ${state.rankedResults.length}`,
        `查询意图: ${state.query.intent}`,
      ];
      
      if (state.rankedResults.length > 0) {
        generateOperations.push('--- 上下文来源 ---');
        state.rankedResults.slice(0, 3).forEach((r, i) => {
          generateOperations.push(`[${i + 1}] 相关度: ${(r.rerankedScore * 100).toFixed(1)}%`);
        });
      } else {
        generateOperations.push('⚠️ 无上下文，将返回默认响应');
      }

      const generateStart = Date.now();
      state.finalResponse = await this.responseGenerator.generate(state.query, state.rankedResults);
      generateStep.duration = Date.now() - generateStart;
      generateStep.status = 'completed';
      
      generateOperations.push(`生成耗时: ${generateStep.duration}ms`);
      generateOperations.push(`响应长度: ${state.finalResponse.length} 字符`);
      
      generateStep.details = {
        contextCount: state.rankedResults.length,
        responseLength: state.finalResponse.length,
        llmModel: this.config.llmModel,
        intent: state.query.intent,
        operations: generateOperations,
      };

    } catch (error) {
      console.error('[AdaptiveEntityRAG] 查询失败:', error);
      const errorStep = steps.find(s => s.status === 'running');
      if (errorStep) {
        errorStep.status = 'failed';
        errorStep.error = error instanceof Error ? error.message : String(error);
      }
      state.finalResponse = `处理查询时出错: ${error instanceof Error ? error.message : '未知错误'}`;
    }

    state.steps = steps;
    state.totalDuration = Date.now() - startTime;

    return state;
  }

  private createStep(name: string): WorkflowStep {
    return {
      step: name,
      status: 'pending',
    };
  }

  private getSearchTypeName(action: string): string {
    const names: Record<string, string> = {
      structured_search: '结构化检索',
      semantic_search: '语义检索',
      hybrid_search: '混合检索',
      relax_constraints: '松弛约束检索',
      generate_response: '生成响应',
    };
    return names[action] || '检索';
  }

  private getIntentDescription(intent: string): string {
    const descriptions: Record<string, string> = {
      factual: '事实查询 - 寻求具体事实或数据',
      conceptual: '概念理解 - 理解概念或原理',
      comparison: '对比分析 - 比较多个对象',
      procedural: '操作指导 - 寻求方法步骤',
      exploratory: '探索性查询 - 开放式探索',
    };
    return descriptions[intent] || intent;
  }

  /**
   * 获取实体元数据存储
   */
  getEntityMetadataStore(): EntityMetadataStore {
    // 同步初始化（如果尚未初始化）
    if (!this.initialized) {
      // 触发异步初始化，但不等待
      this.initialize().catch(err => console.error('[AdaptiveEntityRAG] 初始化失败:', err));
    }
    return this.entityMetadataStore;
  }

  /**
   * 异步获取实体元数据存储（确保已初始化）
   */
  async getEntityMetadataStoreAsync(): Promise<EntityMetadataStore> {
    await this.ensureInitialized();
    return this.entityMetadataStore;
  }

  /**
   * 添加自定义实体映射
   */
  addEntityMapping(metadata: EntityMetadata, persist: boolean = false): void {
    this.entityMetadataStore.addEntity(metadata, persist);
  }
}

// 导出默认实例创建函数
export function createAdaptiveEntityRAG(config?: Partial<AdaptiveRAGConfig>): AdaptiveEntityRAG {
  return new AdaptiveEntityRAG(config);
}
