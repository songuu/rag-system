/**
 * 意图路由器 (Semantic Router)
 * 
 * 基于 LangGraph 的智能意图分类系统
 * 
 * 三条车道:
 * - Lane 1 (Fast Track): 闲聊/通用问题，0 IO，< 1秒
 * - Lane 2 (Standard RAG): 知识库问答，标准 RAG，3-5秒
 * - Lane 3 (Reasoning Agent): 复杂推理，深度分析，15-60秒
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';
import { createLLM, getModelFactory } from './model-config';

// ==================== 类型定义 ====================

/** 意图类型 */
export type IntentType = 'chat' | 'fast_rag' | 'reasoning';

/** 意图分类结果 */
export interface IntentClassification {
  intent: IntentType;
  confidence: number;
  reasoning: string;
  keywords: string[];
  complexity: 'low' | 'medium' | 'high';
  requiresRetrieval: boolean;
  requiresReasoning: boolean;
  suggestedLane: 1 | 2 | 3;
  estimatedTime: string;
}

/** 路由状态 */
export interface RouterState {
  query: string;
  classification: IntentClassification | null;
  routerModel: string;
  startTime: number;
  error?: string;
}

/** 路由配置 */
export interface RouterConfig {
  routerModel?: string;  // 用于路由的轻量级模型
  timeout?: number;      // 路由超时（毫秒）
}

// ==================== 意图分类提示词 ====================

const CLASSIFICATION_PROMPT = `你是一个智能意图分类器。分析用户查询并判断需要哪种处理方式。

## 三种分类

### 1. chat (闲聊/通用) - 不需要知识库
- 问候: "你好", "早上好"
- 身份: "你是谁", "介绍一下你自己"
- 写作: "帮我写封邮件", "写一首诗"
- 通用常识: "今天星期几"

### 2. fast_rag (简单知识库查询) - 一步检索即可回答
- 直接查询: "张三的职位是什么？"
- 定义查询: "什么是RAG系统？"
- 文档摘要: "总结一下这份文档"
- 单一事实: "公司成立于哪一年？"

### 3. reasoning (复杂推理) - 需要多步思考或推理 ⚠️ 重要
以下情况必须选择 reasoning:

**多步推理**: 需要先获取A，再用A推导B
- "马斯克出生那一年，美国总统是谁？" → 先查马斯克生年，再查该年总统
- "张三入职时公司有多少员工？" → 先查入职时间，再查当时员工数

**条件关联**: 涉及时间、条件的关联查询
- "当苹果市值突破万亿时，CEO是谁？"
- "2020年之前，公司最大的客户是哪家？"

**对比分析**: 比较多个对象
- "对比A和B的优劣"
- "这两种方案哪个更好？"

**因果推理**: 分析原因、影响、结果
- "什么导致了项目延期？"
- "这个决策会带来什么影响？"

**计算推断**: 需要计算或逻辑推断
- "两人相差多少岁？"
- "按这个增长率，明年能达到多少？"

**综合分析**: 整合多个信息源
- "综合各方面因素，给出建议"

## 判断要点
- 如果问题包含"那一年"、"那时候"、"当时"等时间条件词，通常是 reasoning
- 如果问题涉及两个以上实体的关联，通常是 reasoning  
- 如果答案不能直接从单一文档片段获得，需要推导，选 reasoning
- 宁可选 reasoning 也不要漏掉复杂问题

## 用户查询
"{query}"

## 输出要求
只输出JSON，不要任何解释文字！confidence必须是单个数字（如0.85），不能是范围。

示例输出:
{{"intent":"reasoning","confidence":0.85,"reasoning":"多步推理","keywords":["时间条件"],"complexity":"high","requiresRetrieval":true,"requiresReasoning":true}}

你的输出:`;

// ==================== LangGraph 状态定义 ====================

const RouterAnnotation = Annotation.Root({
  query: Annotation<string>(),
  classification: Annotation<IntentClassification | null>({ default: () => null }),
  routerModel: Annotation<string>({ default: () => 'llama3.2' }),
  startTime: Annotation<number>({ default: () => Date.now() }),
  error: Annotation<string | undefined>()
});

// ==================== 路由节点 ====================

/**
 * 意图分类节点
 * 使用轻量级模型快速分类用户意图
 */
async function classifyIntentNode(
  state: typeof RouterAnnotation.State
): Promise<Partial<typeof RouterAnnotation.State>> {
  const nodeStartTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[INTENT_ROUTER] 开始意图分类`);
  console.log(`[INTENT_ROUTER] 查询: "${state.query}"`);
  console.log(`[INTENT_ROUTER] 路由模型: ${state.routerModel}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 快速规则匹配（极速路径）
    const quickMatch = quickIntentMatch(state.query);
    if (quickMatch) {
      console.log(`[INTENT_ROUTER] 快速匹配成功: ${quickMatch.intent}`);
      console.log(`[INTENT_ROUTER] 耗时: ${Date.now() - nodeStartTime}ms`);
      return { classification: quickMatch };
    }

    // 使用 LLM 进行深度分类 (使用统一配置系统)
    console.log(`[INTENT_ROUTER] 调用 LLM 模型: ${state.routerModel}`);
    
    const llm = createLLM(state.routerModel);

    const prompt = CLASSIFICATION_PROMPT.replace('{query}', escapeBraces(state.query));
    
    console.log(`[INTENT_ROUTER] 发送分类请求...`);
    const llmResponse = await llm.invoke(prompt);
    
    // 提取响应内容 (BaseChatModel 返回 AIMessage 对象)
    const response = typeof llmResponse === 'string' 
      ? llmResponse 
      : (typeof llmResponse.content === 'string' ? llmResponse.content : '');
    
    console.log(`[INTENT_ROUTER] LLM 原始响应 (前500字符):`);
    console.log(response.substring(0, 500));

    // 解析 JSON 响应
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`[INTENT_ROUTER] 无法从响应中提取 JSON`);
      throw new Error('无法解析分类结果');
    }
    
    // 预处理 JSON 字符串，修复常见的 LLM 输出格式问题
    let jsonStr = jsonMatch[0];
    
    // 修复 "0.9-1.0" 这种范围格式，取第一个数字
    jsonStr = jsonStr.replace(/"confidence":\s*([\d.]+)\s*-\s*[\d.]+/g, '"confidence": $1');
    
    // 修复没有引号的值 (如 true或false → true)
    jsonStr = jsonStr.replace(/:\s*"?(chat|fast_rag|reasoning)"?\s*或[^,}]*/g, ': "$1"');
    jsonStr = jsonStr.replace(/:\s*"?(low|medium|high)"?\s*或[^,}]*/g, ': "$1"');
    jsonStr = jsonStr.replace(/:\s*"?(true|false)"?\s*或[^,}]*/g, (match, val) => `: ${val}`);
    
    // 修复可能的尾随逗号
    jsonStr = jsonStr.replace(/,\s*}/g, '}');
    jsonStr = jsonStr.replace(/,\s*]/g, ']');
    
    console.log(`[INTENT_ROUTER] 原始 JSON: ${jsonMatch[0].substring(0, 200)}...`);
    console.log(`[INTENT_ROUTER] 修复后 JSON: ${jsonStr.substring(0, 200)}...`);

    const parsed = JSON.parse(jsonStr);
    console.log(`[INTENT_ROUTER] 解析结果:`, parsed);
    
    // 构建分类结果
    const classification: IntentClassification = {
      intent: parsed.intent || 'fast_rag',
      confidence: parsed.confidence || 0.7,
      reasoning: parsed.reasoning || '默认分类',
      keywords: parsed.keywords || [],
      complexity: parsed.complexity || 'medium',
      requiresRetrieval: parsed.requiresRetrieval !== false,
      requiresReasoning: parsed.requiresReasoning || false,
      suggestedLane: getSuggestedLane(parsed.intent),
      estimatedTime: getEstimatedTime(parsed.intent)
    };

    const duration = Date.now() - nodeStartTime;
    console.log(`[INTENT_ROUTER] 分类完成:`);
    console.log(`  - 意图: ${classification.intent}`);
    console.log(`  - 置信度: ${(classification.confidence * 100).toFixed(0)}%`);
    console.log(`  - 车道: Lane ${classification.suggestedLane}`);
    console.log(`  - 预计耗时: ${classification.estimatedTime}`);
    console.log(`[INTENT_ROUTER] 路由耗时: ${duration}ms`);

    return { classification };

  } catch (error) {
    console.error('[INTENT_ROUTER] ❌ 分类错误:', error);
    console.error('[INTENT_ROUTER] 错误详情:', error instanceof Error ? error.message : String(error));
    console.error('[INTENT_ROUTER] 使用的路由模型:', state.routerModel);
    console.error('[INTENT_ROUTER] ⚠️ 降级到默认 Lane 2');
    
    // 降级到默认分类
    const fallbackClassification: IntentClassification = {
      intent: 'fast_rag',
      confidence: 0.5,
      reasoning: '分类失败，降级到标准 RAG',
      keywords: [],
      complexity: 'medium',
      requiresRetrieval: true,
      requiresReasoning: false,
      suggestedLane: 2,
      estimatedTime: '3-5秒'
    };

    return { 
      classification: fallbackClassification,
      error: error instanceof Error ? error.message : '分类失败'
    };
  }
}

// ==================== 辅助函数 ====================

/**
 * 快速规则匹配（无需 LLM）
 * 用于极速识别明显的意图类型
 */
function quickIntentMatch(query: string): IntentClassification | null {
  const q = query.toLowerCase().trim();
  
  // 闲聊模式 - 极速匹配
  const chatPatterns = [
    /^(你好|您好|hi|hello|hey|嗨|哈喽)/i,
    /^(早上好|下午好|晚上好|早安|晚安)/i,
    /^(你是谁|你叫什么|介绍一下你自己)/i,
    /^(谢谢|感谢|多谢)/i,
    /^(再见|拜拜|bye|goodbye)/i,
    /^(帮我写|写一个|写一篇|写一封)/i,
    /^(讲个笑话|说个笑话|来个笑话)/i,
  ];

  for (const pattern of chatPatterns) {
    if (pattern.test(q)) {
      return {
        intent: 'chat',
        confidence: 0.95,
        reasoning: '规则匹配: 闲聊/通用请求',
        keywords: [],
        complexity: 'low',
        requiresRetrieval: false,
        requiresReasoning: false,
        suggestedLane: 1,
        estimatedTime: '< 1秒'
      };
    }
  }

  // 复杂推理模式 - 关键词匹配
  // 强触发关键词 - 只要出现就走推理车道
  const strongReasoningKeywords = [
    '对比', '比较', '综合分析', '深度分析', '推断', '推理',
    '异同', '优劣', '利弊', '假设', '假如', '倘若',
    '为什么会', '原因是什么', '背后的逻辑'
  ];
  
  // 弱触发关键词 - 需要配合其他条件
  const weakReasoningKeywords = [
    '分析', '综合', '如果', '趋势', '预测', '评估', '建议'
  ];

  const hasStrongKeyword = strongReasoningKeywords.some(kw => q.includes(kw));
  const hasWeakKeyword = weakReasoningKeywords.some(kw => q.includes(kw));
  const isLongQuery = q.length > 30;  // 降低长度阈值
  const hasMultipleQuestions = (q.match(/？|\?/g) || []).length > 1;
  const hasMultipleEntities = (q.match(/和|与|跟|还有/g) || []).length >= 1; // 涉及多个实体

  // 强关键词直接触发，或弱关键词+其他条件触发
  if (hasStrongKeyword || (hasWeakKeyword && (isLongQuery || hasMultipleQuestions || hasMultipleEntities))) {
    const matchedKeywords = [
      ...strongReasoningKeywords.filter(kw => q.includes(kw)),
      ...weakReasoningKeywords.filter(kw => q.includes(kw))
    ];
    
    return {
      intent: 'reasoning',
      confidence: hasStrongKeyword ? 0.90 : 0.80,
      reasoning: hasStrongKeyword 
        ? '规则匹配: 包含强推理关键词' 
        : '规则匹配: 包含推理关键词且问题有一定复杂度',
      keywords: matchedKeywords,
      complexity: 'high',
      requiresRetrieval: true,
      requiresReasoning: true,
      suggestedLane: 3,
      estimatedTime: '15-60秒'
    };
  }

  // 无法快速匹配，需要 LLM 判断
  return null;
}

/**
 * 获取建议的车道
 */
function getSuggestedLane(intent: IntentType): 1 | 2 | 3 {
  switch (intent) {
    case 'chat': return 1;
    case 'fast_rag': return 2;
    case 'reasoning': return 3;
    default: return 2;
  }
}

/**
 * 获取预计耗时
 */
function getEstimatedTime(intent: IntentType): string {
  switch (intent) {
    case 'chat': return '< 1秒';
    case 'fast_rag': return '3-5秒';
    case 'reasoning': return '15-60秒';
    default: return '3-5秒';
  }
}

/**
 * 转义大括号
 */
function escapeBraces(text: string): string {
  return text.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

// ==================== 构建路由图 ====================

/**
 * 构建意图路由图
 */
export function buildIntentRouterGraph() {
  const workflow = new StateGraph(RouterAnnotation)
    .addNode('classify', classifyIntentNode)
    .addEdge(START, 'classify')
    .addEdge('classify', END);

  return workflow.compile();
}

// ==================== 主执行函数 ====================

/**
 * 执行意图路由
 */
export async function routeIntent(
  query: string,
  config?: RouterConfig
): Promise<IntentClassification> {
  const startTime = Date.now();
  
  const initialState: Partial<typeof RouterAnnotation.State> = {
    query,
    routerModel: config?.routerModel || 'qwen2.5:0.5b',
    startTime
  };

  try {
    const graph = buildIntentRouterGraph();
    const result = await graph.invoke(initialState);

    const routingTime = Date.now() - startTime;
    console.log(`\n[INTENT_ROUTER] 总路由耗时: ${routingTime}ms\n`);

    if (result.classification) {
      return result.classification;
    }

    // 默认返回 fast_rag
    return {
      intent: 'fast_rag',
      confidence: 0.5,
      reasoning: '默认分类',
      keywords: [],
      complexity: 'medium',
      requiresRetrieval: true,
      requiresReasoning: false,
      suggestedLane: 2,
      estimatedTime: '3-5秒'
    };

  } catch (error) {
    console.error('[INTENT_ROUTER] 执行错误:', error);
    
    return {
      intent: 'fast_rag',
      confidence: 0.5,
      reasoning: '路由失败，降级到标准 RAG',
      keywords: [],
      complexity: 'medium',
      requiresRetrieval: true,
      requiresReasoning: false,
      suggestedLane: 2,
      estimatedTime: '3-5秒'
    };
  }
}

// ==================== 车道处理器类型 ====================

export interface LaneHandler {
  lane: 1 | 2 | 3;
  name: string;
  description: string;
  execute: (query: string, config: any) => AsyncGenerator<any, void, unknown>;
}

export interface LaneResult {
  lane: 1 | 2 | 3;
  laneName: string;
  answer: string;
  thinkingProcess?: any[];
  retrievalStats?: any;
  totalDuration: number;
}
