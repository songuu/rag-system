/**
 * Reasoning RAG - 基于 LangChain Runnable 和推理模型的检索增强生成系统
 * 
 * 支持 DeepSeek-R1、Qwen3 等推理模型的高级 RAG 系统
 * 
 * 核心架构：
 * 1. Graph State (全局精细化状态) - 结构化内存对象
 *    - messages: OpenAI 标准格式消息列表
 *    - scratchpad: 思维链片段存储
 * 
 * 2. Cognitive Layer (认知层) - The Orchestrator
 *    - 意图识别
 *    - 工具调用决策
 *    - 逻辑综合
 * 
 * 3. Tool Execution Layer (执行层) - The Heavy Lifting
 *    - Tool Gateway: 安全检查
 *    - Hybrid Retrieval: Dense + BM25
 *    - Reranker: 深度重排序
 *    - Formatter: 结果格式化
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { getMilvusInstance, MilvusConfig } from './milvus-client';
import {
  createEmbedding,
  createReasoningModel,
  selectModelByDimension,
  getConfigSummary,
} from './model-config';
import { getEmbeddingConfigSummary } from './embedding-config';
import { getReasoningRAGConfig } from './milvus-config';
import {
  applyStatePatch,
  createRunnableStateNode,
} from './rag/core/langchain-state-workflow';

// ==================== 类型定义 ====================

/** OpenAI 标准消息格式 */
export interface BaseMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** 工具调用结构 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 思维链片段 */
export interface ThinkingStep {
  id: string;
  timestamp: number;
  type: 'reasoning' | 'planning' | 'reflection' | 'decision';
  content: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/** 检索文档 */
export interface RetrievedDocument {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  source: 'dense' | 'sparse' | 'hybrid';
  rerankScore?: number;
}

/** 混合检索结果 */
export interface HybridRetrievalResult {
  denseResults: RetrievedDocument[];
  sparseResults: RetrievedDocument[];
  mergedResults: RetrievedDocument[];
  rerankedResults: RetrievedDocument[];
  statistics: {
    denseCount: number;
    sparseCount: number;
    mergedCount: number;
    finalCount: number;
    denseTime: number;
    sparseTime: number;
    rerankTime: number;
    totalTime: number;
  };
}

/** Orchestrator 决策 */
export interface OrchestratorDecision {
  action: 'tool_call' | 'generate' | 'clarify';
  intent: string;
  confidence: number;
  reasoning: string;
  toolCalls?: ToolCall[];
  clarifyQuestion?: string;
}

/** 节点执行信息 */
export interface NodeExecution {
  node: 'orchestrator' | 'tool_gateway' | 'hybrid_retrieval' | 'reranker' | 'formatter' | 'generator';
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

/** 推理 RAG 状态 */
export interface ReasoningRAGState {
  // 消息历史 (OpenAI 标准格式)
  messages: BaseMessage[];
  
  // 思维链存储
  scratchpad: ThinkingStep[];
  
  // 用户原始输入
  originalQuery: string;
  
  // 配置
  config: {
    reasoningModel: string;        // 推理模型名称
    embeddingModel: string;        // 嵌入模型名称
    topK: number;                  // 检索数量
    rerankTopK: number;            // 重排后保留数量
    similarityThreshold: number;   // 相似度阈值
    enableBM25: boolean;           // 启用 BM25
    enableRerank: boolean;         // 启用重排序
    maxIterations: number;         // 最大迭代次数
    temperature: number;           // 生成温度
    milvusConfig?: MilvusConfig;
  };
  
  // Orchestrator 状态
  orchestratorDecision?: OrchestratorDecision;
  currentIteration: number;
  
  // 检索状态
  retrievalResult?: HybridRetrievalResult;
  formattedContext?: string;
  
  // 生成结果
  finalAnswer: string;
  
  // 流程控制
  currentNode: string;
  shouldContinue: boolean;
  decisionPath: string[];
  
  // 执行追踪
  nodeExecutions: NodeExecution[];
  startTime: number;
  endTime?: number;
  totalDuration?: number;
  
  // 错误处理
  error?: string;
}

/** API 输出格式 */
export interface ReasoningRAGOutput {
  query: string;
  answer: string;
  
  // 思维链可视化
  thinkingProcess: ThinkingStep[];
  
  // 消息历史
  messages: BaseMessage[];
  
  // 检索详情
  retrieval?: HybridRetrievalResult;
  
  // Orchestrator 决策
  orchestratorDecision?: OrchestratorDecision;
  
  // 工作流信息
  workflow: {
    totalDuration: number;
    iterations: number;
    decisionPath: string[];
    nodeExecutions: NodeExecution[];
  };
  
  // 配置信息
  config: ReasoningRAGState['config'];
  
  error?: string;
}

// ==================== LangChain Runnable 状态定义 ====================

type ReasoningWorkflowState = ReasoningRAGState;

export interface ReasoningRAGWorkflow {
  invoke(
    input: Partial<ReasoningWorkflowState>,
    config?: RunnableConfig
  ): Promise<ReasoningWorkflowState>;
}

function createReasoningWorkflowState(input: Partial<ReasoningWorkflowState>): ReasoningWorkflowState {
  return {
    messages: input.messages ?? [],
    scratchpad: input.scratchpad ?? [],
    originalQuery: input.originalQuery ?? '',
    config: input.config ?? {
      reasoningModel: 'deepseek-r1:7b',
      embeddingModel: 'nomic-embed-text',
      topK: 50,
      rerankTopK: 5,
      similarityThreshold: 0.3,
      enableBM25: true,
      enableRerank: true,
      maxIterations: 3,
      temperature: 0.7,
    },
    orchestratorDecision: input.orchestratorDecision,
    currentIteration: input.currentIteration ?? 0,
    retrievalResult: input.retrievalResult,
    formattedContext: input.formattedContext,
    finalAnswer: input.finalAnswer ?? '',
    currentNode: input.currentNode ?? 'start',
    shouldContinue: input.shouldContinue ?? true,
    decisionPath: input.decisionPath ?? [],
    nodeExecutions: input.nodeExecutions ?? [],
    startTime: input.startTime ?? Date.now(),
    endTime: input.endTime,
    totalDuration: input.totalDuration,
    error: input.error,
  };
}

function mergeReasoningState(
  state: ReasoningWorkflowState,
  patch: Partial<ReasoningWorkflowState>
): ReasoningWorkflowState {
  return applyStatePatch(state, patch, ['scratchpad', 'decisionPath', 'nodeExecutions']);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ==================== BM25 简单实现 ====================

class SimpleBM25 {
  private documents: Array<{ id: string; content: string; tokens: string[] }> = [];
  private k1 = 1.5;
  private b = 0.75;
  private avgDocLength = 0;
  private idf: Map<string, number> = new Map();
  
  constructor(documents: Array<{ id: string; content: string }>) {
    // 分词并构建索引
    this.documents = documents.map(doc => ({
      ...doc,
      tokens: this.tokenize(doc.content)
    }));
    
    // 计算平均文档长度
    const totalLength = this.documents.reduce((sum, doc) => sum + doc.tokens.length, 0);
    this.avgDocLength = this.documents.length > 0 ? totalLength / this.documents.length : 0;
    
    // 计算 IDF
    this.calculateIDF();
  }
  
  private tokenize(text: string): string[] {
    // 简单的中英文分词
    return text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 0);
  }
  
  private calculateIDF() {
    const N = this.documents.length;
    const docFreq: Map<string, number> = new Map();
    
    for (const doc of this.documents) {
      const uniqueTokens = new Set(doc.tokens);
      for (const token of uniqueTokens) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
    
    for (const [token, freq] of docFreq) {
      this.idf.set(token, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    }
  }
  
  search(query: string, topK: number = 10): Array<{ id: string; content: string; score: number }> {
    const queryTokens = this.tokenize(query);
    const scores: Array<{ id: string; content: string; score: number }> = [];
    
    for (const doc of this.documents) {
      let score = 0;
      const termFreq: Map<string, number> = new Map();
      
      for (const token of doc.tokens) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
      }
      
      for (const token of queryTokens) {
        const tf = termFreq.get(token) || 0;
        const idf = this.idf.get(token) || 0;
        const docLength = doc.tokens.length;
        
        const tfNorm = (tf * (this.k1 + 1)) / 
          (tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength)));
        
        score += idf * tfNorm;
      }
      
      if (score > 0) {
        scores.push({ id: doc.id, content: doc.content, score });
      }
    }
    
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ==================== 节点实现 ====================

/**
 * 认知层节点: Orchestrator (编排器)
 * 
 * 职责：
 * 1. 分析用户意图
 * 2. 决定是调用工具还是直接回答
 * 3. 生成思维链
 */
async function orchestratorNode(
  state: ReasoningWorkflowState
): Promise<Partial<ReasoningWorkflowState>> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[ORCHESTRATOR] 🧠 认知层 - 开始分析`);
  console.log(`[ORCHESTRATOR] 查询: "${state.originalQuery}"`);
  console.log(`[ORCHESTRATOR] 当前迭代: ${state.currentIteration}`);
  console.log(`${'='.repeat(60)}`);
  
  try {
    // 使用统一模型配置系统创建推理模型
    const llm = createReasoningModel(state.config.reasoningModel, { 
      temperature: state.config.temperature 
    });
    
    // 构建消息上下文
    // 注意: LangChain prompt 模板中 { 和 } 需要转义为 {{ 和 }}
    const systemPrompt = `你是一个智能助手，具备以下能力：
1. 分析用户问题的意图和复杂度
2. 决定是否需要检索知识库
3. 如果需要检索，生成精准的搜索查询
4. 如果问题简单或是打招呼，直接回答

请分析用户的问题，并输出你的思考过程和决策。

输出格式（JSON）：
{{
  "thinking": "你的思考过程...",
  "intent": "问题的意图类型: factual/exploratory/greeting/clarification",
  "needs_retrieval": true或false,
  "search_query": "如果需要检索，生成的搜索查询",
  "direct_answer": "如果不需要检索，直接的回答",
  "confidence": 0.0到1.0之间的数字
}}

注意：
- 对于打招呼(你好、hi等)，直接友好回复，不需要检索
- 对于简单问题（天气、时间等），说明无法获取实时信息
- 对于知识性问题，需要检索知识库`;

    // 转义 LangChain 模板中的花括号
    const escapeBraces = (str: string) => str.replace(/\{/g, '{{').replace(/\}/g, '}}');
    
    // 构建用户消息历史（转义花括号）
    let messagesContext = '';
    if (state.messages.length > 0) {
      messagesContext = '\n\n之前的对话历史:\n' + 
        state.messages.map(m => `${m.role}: ${escapeBraces(m.content)}`).join('\n');
    }
    
    // 如果有之前的检索结果，包含在上下文中（已在 formatter 中转义）
    let retrievalContext = '';
    if (state.formattedContext) {
      retrievalContext = `\n\n已检索到的相关信息:\n${state.formattedContext}`;
    }
    
    // 转义用户查询
    const safeQuery = escapeBraces(state.originalQuery);
    
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', systemPrompt],
      ['user', `用户问题: ${safeQuery}${messagesContext}${retrievalContext}\n\n请分析并决策：`]
    ]);
    
    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    const response = await chain.invoke({});
    
    console.log(`[ORCHESTRATOR] 原始响应: ${response.substring(0, 500)}...`);
    
    // 解析推理模型的输出（可能包含 <think> 标签）
    let thinkingContent = '';
    let jsonContent = response;
    
    // 提取思维链内容
    const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      thinkingContent = thinkMatch[1].trim();
      jsonContent = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    
    // 尝试解析 JSON
    let decision: OrchestratorDecision;
    try {
      const jsonMatch = jsonContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // 添加思维链步骤
        const thinkingStep: ThinkingStep = {
          id: `think-${Date.now()}`,
          timestamp: Date.now(),
          type: 'reasoning',
          content: thinkingContent || parsed.thinking || '分析用户意图...',
          confidence: parsed.confidence || 0.8,
          metadata: { intent: parsed.intent }
        };
        
        if (parsed.needs_retrieval) {
          decision = {
            action: 'tool_call',
            intent: parsed.intent || 'factual',
            confidence: parsed.confidence || 0.8,
            reasoning: parsed.thinking || '需要检索知识库',
            toolCalls: [{
              id: `call-${Date.now()}`,
              type: 'function',
              function: {
                name: 'search_knowledge_base',
                arguments: JSON.stringify({ query: parsed.search_query || state.originalQuery })
              }
            }]
          };
        } else {
          decision = {
            action: 'generate',
            intent: parsed.intent || 'greeting',
            confidence: parsed.confidence || 0.9,
            reasoning: parsed.thinking || '可以直接回答'
          };
          
          // 如果有直接回答，设置最终答案
          if (parsed.direct_answer) {
            const duration = Date.now() - startTime;
            return {
              orchestratorDecision: decision,
              finalAnswer: parsed.direct_answer,
              currentNode: 'orchestrator',
              shouldContinue: false,
              decisionPath: [`orchestrator:direct_answer`],
              scratchpad: [thinkingStep],
              nodeExecutions: [{
                node: 'orchestrator',
                status: 'completed',
                startTime,
                endTime: Date.now(),
                duration,
                input: { query: state.originalQuery },
                output: { decision, directAnswer: parsed.direct_answer }
              }]
            };
          }
        }
        
        const duration = Date.now() - startTime;
        return {
          orchestratorDecision: decision,
          currentNode: 'orchestrator',
          shouldContinue: true,
          decisionPath: [`orchestrator:${decision.action}`],
          scratchpad: [thinkingStep],
          nodeExecutions: [{
            node: 'orchestrator',
            status: 'completed',
            startTime,
            endTime: Date.now(),
            duration,
            input: { query: state.originalQuery },
            output: { decision }
          }]
        };
      }
    } catch (parseError) {
      console.error('[ORCHESTRATOR] JSON 解析失败:', parseError);
    }
    
    // 默认决策：检索
    decision = {
      action: 'tool_call',
      intent: 'factual',
      confidence: 0.7,
      reasoning: '无法解析决策，默认进行检索',
      toolCalls: [{
        id: `call-${Date.now()}`,
        type: 'function',
        function: {
          name: 'search_knowledge_base',
          arguments: JSON.stringify({ query: state.originalQuery })
        }
      }]
    };
    
    const duration = Date.now() - startTime;
    return {
      orchestratorDecision: decision,
      currentNode: 'orchestrator',
      shouldContinue: true,
      decisionPath: [`orchestrator:${decision.action}`],
      scratchpad: [{
        id: `think-${Date.now()}`,
        timestamp: Date.now(),
        type: 'decision',
        content: '默认进行知识库检索',
        confidence: 0.7
      }],
      nodeExecutions: [{
        node: 'orchestrator',
        status: 'completed',
        startTime,
        endTime: Date.now(),
        duration,
        input: { query: state.originalQuery },
        output: { decision }
      }]
    };
    
  } catch (error) {
    console.error('[ORCHESTRATOR] 错误:', error);
    const duration = Date.now() - startTime;
    return {
      error: `Orchestrator 错误: ${error instanceof Error ? error.message : '未知错误'}`,
      currentNode: 'orchestrator',
      shouldContinue: false,
      nodeExecutions: [{
        node: 'orchestrator',
        status: 'error',
        startTime,
        endTime: Date.now(),
        duration,
        error: error instanceof Error ? error.message : '未知错误'
      }]
    };
  }
}

/**
 * 执行层节点: Tool Gateway (工具网关)
 * 
 * 职责：
 * 1. 拦截 Orchestrator 的工具调用
 * 2. 参数验证和安全检查
 * 3. 路由到对应的工具执行
 */
async function toolGatewayNode(
  state: ReasoningWorkflowState
): Promise<Partial<ReasoningWorkflowState>> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[TOOL_GATEWAY] 🔒 工具网关 - 安全检查`);
  console.log(`${'='.repeat(60)}`);
  
  const decision = state.orchestratorDecision;
  if (!decision || !decision.toolCalls || decision.toolCalls.length === 0) {
    return {
      currentNode: 'tool_gateway',
      shouldContinue: true,
      decisionPath: ['tool_gateway:no_tools'],
      nodeExecutions: [{
        node: 'tool_gateway',
        status: 'skipped',
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime
      }]
    };
  }
  
  // 验证工具调用
  const toolCall = decision.toolCalls[0];
  const validTools = ['search_knowledge_base', 'clarify_question'];
  
  if (!validTools.includes(toolCall.function.name)) {
    console.log(`[TOOL_GATEWAY] ⚠️ 无效工具: ${toolCall.function.name}`);
    return {
      error: `无效的工具调用: ${toolCall.function.name}`,
      currentNode: 'tool_gateway',
      shouldContinue: false,
      nodeExecutions: [{
        node: 'tool_gateway',
        status: 'error',
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
        error: `无效的工具调用: ${toolCall.function.name}`
      }]
    };
  }
  
  // 参数安全检查
  let args: Record<string, unknown>;
  try {
    const parsedArgs = JSON.parse(toolCall.function.arguments);
    if (!isRecord(parsedArgs)) {
      throw new Error('工具参数必须是 JSON object');
    }
    args = parsedArgs;
    
    // 检查 SQL 注入风险
    const dangerousPatterns = [/drop\s+table/i, /delete\s+from/i, /insert\s+into/i, /update\s+.*set/i];
    const query = typeof args.query === 'string' ? args.query : '';
    for (const pattern of dangerousPatterns) {
      if (pattern.test(query)) {
        throw new Error('检测到潜在的安全风险');
      }
    }
    
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      error: `参数解析错误: ${message}`,
      currentNode: 'tool_gateway',
      shouldContinue: false,
      nodeExecutions: [{
        node: 'tool_gateway',
        status: 'error',
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
        error: message
      }]
    };
  }
  
  console.log(`[TOOL_GATEWAY] ✅ 安全检查通过: ${toolCall.function.name}`);
  
  const duration = Date.now() - startTime;
  return {
    currentNode: 'tool_gateway',
    shouldContinue: true,
    decisionPath: [`tool_gateway:pass:${toolCall.function.name}`],
    scratchpad: [{
      id: `gateway-${Date.now()}`,
      timestamp: Date.now(),
      type: 'planning',
      content: `工具调用安全检查通过: ${toolCall.function.name}`,
      metadata: { args }
    }],
    nodeExecutions: [{
      node: 'tool_gateway',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration,
      input: { toolCall },
      output: { validated: true, args }
    }]
  };
}

/**
 * 执行层节点: Hybrid Retrieval (混合检索)
 * 
 * 职责：
 * 1. Dense 检索 (Milvus 向量搜索)
 * 2. Sparse 检索 (BM25 关键词搜索)
 * 3. 结果合并
 */
async function hybridRetrievalNode(
  state: ReasoningWorkflowState
): Promise<Partial<ReasoningWorkflowState>> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[HYBRID_RETRIEVAL] 🔍 混合检索`);
  console.log(`${'='.repeat(60)}`);
  
  const decision = state.orchestratorDecision;
  if (!decision?.toolCalls?.[0]) {
    return {
      currentNode: 'hybrid_retrieval',
      shouldContinue: true,
      decisionPath: ['hybrid_retrieval:no_query'],
      nodeExecutions: [{
        node: 'hybrid_retrieval',
        status: 'skipped',
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime
      }]
    };
  }
  
  const args = JSON.parse(decision.toolCalls[0].function.arguments);
  const searchQuery = args.query || state.originalQuery;
  
  console.log(`[HYBRID_RETRIEVAL] 搜索查询: "${searchQuery}"`);
  console.log(`[HYBRID_RETRIEVAL] Top-K: ${state.config.topK}`);
  console.log(`[HYBRID_RETRIEVAL] BM25 启用: ${state.config.enableBM25}`);
  
  try {
    const result: HybridRetrievalResult = {
      denseResults: [],
      sparseResults: [],
      mergedResults: [],
      rerankedResults: [],
      statistics: {
        denseCount: 0,
        sparseCount: 0,
        mergedCount: 0,
        finalCount: 0,
        denseTime: 0,
        sparseTime: 0,
        rerankTime: 0,
        totalTime: 0
      }
    };
    
    // 1. Dense 检索 (Milvus)
    const denseStartTime = Date.now();
    const milvus = await getMilvusInstance(state.config.milvusConfig);
    const stats = await milvus.getCollectionStats() as { dimension?: number; embeddingDimension?: number } | null | undefined;
    const dimension = stats?.dimension ?? stats?.embeddingDimension ?? 768;
    const embeddingModelName = selectModelByDimension(dimension);
    
    console.log(`[HYBRID_RETRIEVAL] Embedding 模型: ${embeddingModelName}, 维度: ${dimension}`);
    
    // 使用统一模型配置系统创建 Embedding 模型
    const embeddings = createEmbedding(embeddingModelName);
    
    const queryVector = await embeddings.embedQuery(searchQuery);
    const denseSearchResult = await milvus.search(queryVector, state.config.topK);
    
    result.denseResults = denseSearchResult.map((doc, idx) => ({
      id: doc.id || `dense-${idx}`,
      content: doc.content,
      metadata: doc.metadata || {},
      score: doc.score,
      source: 'dense' as const
    }));
    result.statistics.denseTime = Date.now() - denseStartTime;
    result.statistics.denseCount = result.denseResults.length;
    
    console.log(`[HYBRID_RETRIEVAL] Dense 检索: ${result.denseResults.length} 结果, ${result.statistics.denseTime}ms`);
    
    // 2. Sparse 检索 (BM25) - 如果启用
    if (state.config.enableBM25 && result.denseResults.length > 0) {
      const sparseStartTime = Date.now();
      
      // 从 Dense 结果构建 BM25 索引
      const bm25 = new SimpleBM25(
        result.denseResults.map(doc => ({ id: doc.id, content: doc.content }))
      );
      
      const sparseSearchResult = bm25.search(searchQuery, state.config.topK);
      
      result.sparseResults = sparseSearchResult.map(doc => ({
        id: doc.id,
        content: doc.content,
        metadata: result.denseResults.find(d => d.id === doc.id)?.metadata || {},
        score: doc.score,
        source: 'sparse' as const
      }));
      
      result.statistics.sparseTime = Date.now() - sparseStartTime;
      result.statistics.sparseCount = result.sparseResults.length;
      
      console.log(`[HYBRID_RETRIEVAL] Sparse 检索: ${result.sparseResults.length} 结果, ${result.statistics.sparseTime}ms`);
    }
    
    // 3. 结果合并 (Reciprocal Rank Fusion)
    const docScores = new Map<string, { doc: RetrievedDocument; score: number }>();
    const k = 60; // RRF 参数
    
    // Dense 结果加权
    result.denseResults.forEach((doc, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = docScores.get(doc.id);
      if (existing) {
        existing.score += rrfScore * 0.6; // Dense 权重 60%
      } else {
        docScores.set(doc.id, { doc: { ...doc, source: 'hybrid' }, score: rrfScore * 0.6 });
      }
    });
    
    // Sparse 结果加权
    result.sparseResults.forEach((doc, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = docScores.get(doc.id);
      if (existing) {
        existing.score += rrfScore * 0.4; // Sparse 权重 40%
      } else {
        docScores.set(doc.id, { doc: { ...doc, source: 'hybrid' }, score: rrfScore * 0.4 });
      }
    });
    
    // 排序合并结果
    result.mergedResults = Array.from(docScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, state.config.topK)
      .map(item => ({ ...item.doc, score: item.score }));
    
    result.statistics.mergedCount = result.mergedResults.length;
    result.statistics.totalTime = Date.now() - startTime;
    
    console.log(`[HYBRID_RETRIEVAL] 合并结果: ${result.mergedResults.length} 个文档`);
    
    const duration = Date.now() - startTime;
    return {
      retrievalResult: result,
      currentNode: 'hybrid_retrieval',
      shouldContinue: true,
      decisionPath: [`hybrid_retrieval:${result.mergedResults.length}_docs`],
      scratchpad: [{
        id: `retrieval-${Date.now()}`,
        timestamp: Date.now(),
        type: 'planning',
        content: `混合检索完成: Dense ${result.statistics.denseCount} + Sparse ${result.statistics.sparseCount} = ${result.mergedResults.length} 文档`,
        metadata: { statistics: result.statistics }
      }],
      nodeExecutions: [{
        node: 'hybrid_retrieval',
        status: 'completed',
        startTime,
        endTime: Date.now(),
        duration,
        input: { query: searchQuery },
        output: { statistics: result.statistics }
      }]
    };
    
  } catch (error) {
    console.error('[HYBRID_RETRIEVAL] 错误:', error);
    const duration = Date.now() - startTime;
    return {
      error: `检索错误: ${error instanceof Error ? error.message : '未知错误'}`,
      currentNode: 'hybrid_retrieval',
      shouldContinue: false,
      nodeExecutions: [{
        node: 'hybrid_retrieval',
        status: 'error',
        startTime,
        endTime: Date.now(),
        duration,
        error: error instanceof Error ? error.message : '未知错误'
      }]
    };
  }
}

/**
 * 执行层节点: Reranker (重排序)
 * 
 * 职责：
 * 1. 对混合检索结果进行深度重排序
 * 2. 使用 LLM 评估相关性
 * 3. 保留 Top-K 最相关结果
 */
async function rerankerNode(
  state: ReasoningWorkflowState
): Promise<Partial<ReasoningWorkflowState>> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[RERANKER] 📊 深度重排序`);
  console.log(`${'='.repeat(60)}`);
  
  if (!state.config.enableRerank || !state.retrievalResult?.mergedResults?.length) {
    console.log('[RERANKER] 跳过重排序');
    return {
      currentNode: 'reranker',
      shouldContinue: true,
      decisionPath: ['reranker:skipped'],
      nodeExecutions: [{
        node: 'reranker',
        status: 'skipped',
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime
      }]
    };
  }
  
  const docs = state.retrievalResult.mergedResults;
  console.log(`[RERANKER] 重排序 ${docs.length} 个文档, 保留 Top-${state.config.rerankTopK}`);
  
  try {
    // 使用统一模型配置系统创建推理模型
    const llm = createReasoningModel(state.config.reasoningModel, { 
      temperature: 0.1 // 低温度保证一致性
    });
    
    // 使用 LLM 进行相关性评分
    // 注意: LangChain prompt 模板中 { 和 } 需要转义为 {{ 和 }}，但 {query} 和 {content} 是变量
    const rerankPrompt = ChatPromptTemplate.fromMessages([
      ['system', `你是一个文档相关性评估专家。评估文档与查询的相关性。
输出格式（JSON）：
{{
  "relevance_score": 0.0到1.0之间的数字,
  "reasoning": "简短的评估理由"
}}`],
      ['user', `查询: {query}\n\n文档内容:\n{content}\n\n请评估相关性：`]
    ]);
    
    const rerankedDocs: RetrievedDocument[] = [];
    
    // 批量评估（为了效率，只评估前 20 个）
    const docsToRerank = docs.slice(0, Math.min(20, docs.length));
    
    for (const doc of docsToRerank) {
      try {
        const chain = rerankPrompt.pipe(llm).pipe(new StringOutputParser());
        const response = await chain.invoke({
          query: state.originalQuery,
          content: doc.content.substring(0, 1000) // 限制长度
        });
        
        // 解析评分
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          rerankedDocs.push({
            ...doc,
            rerankScore: parsed.relevance_score || 0.5
          });
        } else {
          rerankedDocs.push({ ...doc, rerankScore: doc.score });
        }
      } catch {
        rerankedDocs.push({ ...doc, rerankScore: doc.score });
      }
    }
    
    // 按重排分数排序
    rerankedDocs.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
    
    // 更新结果
    const finalDocs = rerankedDocs.slice(0, state.config.rerankTopK);
    
    const updatedResult: HybridRetrievalResult = {
      ...state.retrievalResult,
      rerankedResults: finalDocs,
      statistics: {
        ...state.retrievalResult.statistics,
        rerankTime: Date.now() - startTime,
        finalCount: finalDocs.length
      }
    };
    
    console.log(`[RERANKER] 重排序完成: ${finalDocs.length} 个文档`);
    
    const duration = Date.now() - startTime;
    return {
      retrievalResult: updatedResult,
      currentNode: 'reranker',
      shouldContinue: true,
      decisionPath: [`reranker:${finalDocs.length}_docs`],
      scratchpad: [{
        id: `rerank-${Date.now()}`,
        timestamp: Date.now(),
        type: 'reflection',
        content: `重排序完成: ${docs.length} → ${finalDocs.length} 个文档`,
        metadata: { topScores: finalDocs.slice(0, 3).map(d => d.rerankScore) }
      }],
      nodeExecutions: [{
        node: 'reranker',
        status: 'completed',
        startTime,
        endTime: Date.now(),
        duration,
        input: { docCount: docs.length },
        output: { finalCount: finalDocs.length }
      }]
    };
    
  } catch (error) {
    console.error('[RERANKER] 错误:', error);
    // 出错时使用原始排序
    const duration = Date.now() - startTime;
    return {
      retrievalResult: {
        ...state.retrievalResult!,
        rerankedResults: state.retrievalResult!.mergedResults.slice(0, state.config.rerankTopK),
        statistics: {
          ...state.retrievalResult!.statistics,
          rerankTime: duration,
          finalCount: Math.min(state.config.rerankTopK, state.retrievalResult!.mergedResults.length)
        }
      },
      currentNode: 'reranker',
      shouldContinue: true,
      decisionPath: ['reranker:fallback'],
      nodeExecutions: [{
        node: 'reranker',
        status: 'completed',
        startTime,
        endTime: Date.now(),
        duration,
        output: { fallback: true }
      }]
    };
  }
}

/**
 * 执行层节点: Formatter (格式化器)
 * 
 * 职责：
 * 1. 清洗检索结果（去除 HTML、乱码）
 * 2. 格式化为 XML/Markdown 便于 LLM 阅读
 */
async function formatterNode(
  state: ReasoningWorkflowState
): Promise<Partial<ReasoningWorkflowState>> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[FORMATTER] 📝 结果格式化`);
  console.log(`${'='.repeat(60)}`);
  
  const docs = state.retrievalResult?.rerankedResults || 
               state.retrievalResult?.mergedResults || [];
  
  if (docs.length === 0) {
    return {
      formattedContext: '',
      currentNode: 'formatter',
      shouldContinue: true,
      decisionPath: ['formatter:no_docs'],
      nodeExecutions: [{
        node: 'formatter',
        status: 'completed',
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime
      }]
    };
  }
  
  // 清洗和格式化
  const cleanedDocs = docs.map((doc) => {
    // 清洗内容
    let cleanContent = doc.content
      .replace(/<[^>]*>/g, '') // 移除 HTML 标签
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 移除控制字符
      .replace(/\s+/g, ' ') // 规范化空白
      .trim();
    
    // 限制长度
    if (cleanContent.length > 2000) {
      cleanContent = cleanContent.substring(0, 2000) + '...';
    }
    
    return { ...doc, cleanContent };
  });
  
  // 转义 LangChain 模板中的花括号
  const escapeBraces = (str: string) => str.replace(/\{/g, '{{').replace(/\}/g, '}}');
  
  // 格式化为 XML 结构（转义花括号以避免被 LangChain 解释为变量）
  const formattedContext = `<retrieved_documents>
${cleanedDocs.map((doc, idx) => {
    const safeContent = escapeBraces(doc.cleanContent);
    const safeMetadata = escapeBraces(JSON.stringify(doc.metadata));
    return `  <document id="${idx + 1}" score="${(doc.rerankScore || doc.score).toFixed(3)}" source="${doc.source}">
    <content>${safeContent}</content>
    <metadata>${safeMetadata}</metadata>
  </document>`;
  }).join('\n')}
</retrieved_documents>`;
  
  console.log(`[FORMATTER] 格式化 ${cleanedDocs.length} 个文档完成`);
  
  const duration = Date.now() - startTime;
  return {
    formattedContext,
    currentNode: 'formatter',
    shouldContinue: true,
    decisionPath: [`formatter:${cleanedDocs.length}_docs`],
    nodeExecutions: [{
      node: 'formatter',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration,
      input: { docCount: docs.length },
      output: { formattedLength: formattedContext.length }
    }]
  };
}

/**
 * 生成节点: Generator
 * 
 * 职责：
 * 1. 基于格式化的上下文生成最终回答
 * 2. 使用推理模型进行深度思考
 */
async function generatorNode(
  state: ReasoningWorkflowState
): Promise<Partial<ReasoningWorkflowState>> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[GENERATOR] ✨ 生成回答`);
  console.log(`${'='.repeat(60)}`);
  
  try {
    // 使用统一模型配置系统创建推理模型
    const llm = createReasoningModel(state.config.reasoningModel, { 
      temperature: state.config.temperature 
    });
    
    // 转义 LangChain 模板中的花括号
    const escapeBraces = (str: string) => str.replace(/\{/g, '{{').replace(/\}/g, '}}');
    const safeQuery = escapeBraces(state.originalQuery);
    
    let systemPrompt: string;
    let userPrompt: string;
    
    if (state.formattedContext && state.formattedContext.length > 0) {
      systemPrompt = `你是一个专业的知识助手。请基于提供的参考文档回答用户问题。

要求：
1. 仅使用文档中的信息回答
2. 如果文档信息不足，诚实说明
3. 回答要准确、清晰、有条理
4. 如有必要，引用具体文档

如果你是一个支持推理的模型（如 DeepSeek-R1），请展示你的思考过程。`;
      
      // formattedContext 已在 formatter 节点中转义
      userPrompt = `参考文档：
${state.formattedContext}

用户问题：${safeQuery}

请基于以上文档回答：`;
    } else {
      systemPrompt = `你是一个友好的助手。请直接回答用户的问题。
如果是打招呼，请友好回复。
如果问题需要特定知识但没有可用文档，请诚实说明。`;
      
      userPrompt = `用户问题：${safeQuery}

请回答：`;
    }
    
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', systemPrompt],
      ['user', userPrompt]
    ]);
    
    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    const response = await chain.invoke({});
    
    // 提取思维链（如果有）
    let thinkingContent = '';
    let answer = response;
    
    const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      thinkingContent = thinkMatch[1].trim();
      answer = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    
    console.log(`[GENERATOR] 生成完成: ${answer.substring(0, 100)}...`);
    
    const thinkingSteps: ThinkingStep[] = [];
    if (thinkingContent) {
      thinkingSteps.push({
        id: `gen-think-${Date.now()}`,
        timestamp: Date.now(),
        type: 'reasoning',
        content: thinkingContent,
        confidence: 0.9
      });
    }
    
    // 更新消息历史
    const updatedMessages: BaseMessage[] = [
      ...state.messages,
      { role: 'user', content: state.originalQuery },
      { role: 'assistant', content: answer }
    ];
    
    const duration = Date.now() - startTime;
    return {
      finalAnswer: answer,
      messages: updatedMessages,
      currentNode: 'generator',
      shouldContinue: false,
      endTime: Date.now(),
      totalDuration: Date.now() - state.startTime,
      decisionPath: ['generator:completed'],
      scratchpad: thinkingSteps,
      nodeExecutions: [{
        node: 'generator',
        status: 'completed',
        startTime,
        endTime: Date.now(),
        duration,
        input: { contextLength: state.formattedContext?.length || 0 },
        output: { answerLength: answer.length }
      }]
    };
    
  } catch (error) {
    console.error('[GENERATOR] 错误:', error);
    const duration = Date.now() - startTime;
    return {
      finalAnswer: `抱歉，生成回答时出现错误: ${error instanceof Error ? error.message : '未知错误'}`,
      error: error instanceof Error ? error.message : '未知错误',
      currentNode: 'generator',
      shouldContinue: false,
      endTime: Date.now(),
      totalDuration: Date.now() - state.startTime,
      nodeExecutions: [{
        node: 'generator',
        status: 'error',
        startTime,
        endTime: Date.now(),
        duration,
        error: error instanceof Error ? error.message : '未知错误'
      }]
    };
  }
}

// ==================== 图构建 ====================

/**
 * 构建 Reasoning RAG Runnable 工作流
 */
function buildReasoningRAGGraph(): ReasoningRAGWorkflow {
  const orchestrator = createRunnableStateNode<ReasoningWorkflowState>('reasoning-rag', 'orchestrator', orchestratorNode);
  const toolGateway = createRunnableStateNode<ReasoningWorkflowState>('reasoning-rag', 'tool_gateway', toolGatewayNode);
  const hybridRetrieval = createRunnableStateNode<ReasoningWorkflowState>('reasoning-rag', 'hybrid_retrieval', hybridRetrievalNode);
  const reranker = createRunnableStateNode<ReasoningWorkflowState>('reasoning-rag', 'reranker', rerankerNode);
  const formatter = createRunnableStateNode<ReasoningWorkflowState>('reasoning-rag', 'formatter', formatterNode);
  const generator = createRunnableStateNode<ReasoningWorkflowState>('reasoning-rag', 'generator', generatorNode);

  return {
    async invoke(input, config) {
      let state = createReasoningWorkflowState(input);
      state = mergeReasoningState(state, await orchestrator.invoke(state, config));

      if (!state.shouldContinue) {
        return state;
      }

      if (state.orchestratorDecision?.action === 'tool_call') {
        state = mergeReasoningState(state, await toolGateway.invoke(state, config));
        state = mergeReasoningState(state, await hybridRetrieval.invoke(state, config));
        state = mergeReasoningState(state, await reranker.invoke(state, config));
        state = mergeReasoningState(state, await formatter.invoke(state, config));
      }

      return mergeReasoningState(state, await generator.invoke(state, config));
    },
  };
}

// ==================== 主执行函数 ====================

/**
 * 执行 Reasoning RAG 工作流
 */
export async function executeReasoningRAG(
  query: string,
  config?: Partial<ReasoningRAGState['config']>
): Promise<ReasoningRAGOutput> {
  console.log(`\n${'#'.repeat(80)}`);
  console.log(`# Reasoning RAG - 开始执行`);
  console.log(`# 查询: "${query}"`);
  console.log(`${'#'.repeat(80)}\n`);
  
  const startTime = Date.now();
  
  // 从环境变量获取 Reasoning RAG 配置
  const ragEnvConfig = getReasoningRAGConfig();
  const llmConfig = getConfigSummary();
  const embeddingConfig = getEmbeddingConfigSummary();
  
  // 合并配置 - 使用 Reasoning RAG 专用集合（从环境变量）
  const defaultMilvusConfig: MilvusConfig = {
    collectionName: ragEnvConfig.collection,  // 从环境变量: REASONING_RAG_COLLECTION
    embeddingDimension: ragEnvConfig.dimension, // 从环境变量: REASONING_RAG_DIMENSION
  };
  
  // 默认配置（从环境变量）
  const defaultConfig: ReasoningRAGState['config'] = {
    // 模型配置 - 从统一配置系统获取
    reasoningModel: llmConfig.reasoningModel || 'deepseek-r1:7b',
    embeddingModel: embeddingConfig.model || 'nomic-embed-text',
    // 检索配置 - 从 REASONING_RAG_* 环境变量获取
    topK: ragEnvConfig.topK,
    rerankTopK: ragEnvConfig.rerankTopK,
    similarityThreshold: ragEnvConfig.similarityThreshold,
    enableBM25: ragEnvConfig.enableBM25,
    enableRerank: ragEnvConfig.enableRerank,
    // 推理配置
    maxIterations: ragEnvConfig.maxIterations,
    temperature: ragEnvConfig.temperature,
    milvusConfig: defaultMilvusConfig,
  };
  
  // 智能合并配置，确保 milvusConfig.collectionName 始终使用环境变量配置的专用集合
  const finalConfig = { 
    ...defaultConfig, 
    ...config,
    // 强制使用 Reasoning RAG 专用集合（从环境变量），不允许被覆盖
    milvusConfig: {
      ...defaultMilvusConfig,
      ...(config?.milvusConfig || {}),
      collectionName: ragEnvConfig.collection,  // 强制使用环境变量配置的专用集合
      embeddingDimension: ragEnvConfig.dimension,
    }
  };
  
  console.log(`[Reasoning RAG] 配置信息:`, {
    collection: finalConfig.milvusConfig?.collectionName,
    dimension: finalConfig.milvusConfig?.embeddingDimension,
    reasoningModel: finalConfig.reasoningModel,
    embeddingModel: finalConfig.embeddingModel,
  });
  
  // 初始状态
  const initialState: Partial<ReasoningWorkflowState> = {
    originalQuery: query,
    messages: [{ role: 'system', content: '你是一个专业的知识助手，支持深度推理。' }],
    scratchpad: [],
    config: finalConfig,
    currentIteration: 0,
    currentNode: 'start',
    shouldContinue: true,
    decisionPath: [],
    nodeExecutions: [],
    startTime,
    finalAnswer: '',
  };
  
  try {
    const graph = buildReasoningRAGGraph();
    const result = await graph.invoke(initialState);
    
    const totalDuration = Date.now() - startTime;
    
    console.log(`\n${'#'.repeat(80)}`);
    console.log(`# Reasoning RAG - 执行完成`);
    console.log(`# 总耗时: ${totalDuration}ms`);
    console.log(`${'#'.repeat(80)}\n`);
    
    return {
      query,
      answer: result.finalAnswer || '无法生成回答',
      thinkingProcess: result.scratchpad || [],
      messages: result.messages || [],
      retrieval: result.retrievalResult,
      orchestratorDecision: result.orchestratorDecision,
      workflow: {
        totalDuration,
        iterations: result.currentIteration || 1,
        decisionPath: result.decisionPath || [],
        nodeExecutions: result.nodeExecutions || []
      },
      config: finalConfig,
      error: result.error
    };
    
  } catch (error) {
    console.error('Reasoning RAG 执行错误:', error);
    return {
      query,
      answer: `执行错误: ${error instanceof Error ? error.message : '未知错误'}`,
      thinkingProcess: [],
      messages: [],
      workflow: {
        totalDuration: Date.now() - startTime,
        iterations: 0,
        decisionPath: [],
        nodeExecutions: []
      },
      config: finalConfig,
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

// ==================== 导出 ====================

export { buildReasoningRAGGraph };
