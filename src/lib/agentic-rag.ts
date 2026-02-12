/**
 * Agentic RAG - 基于 LangGraph 的代理化检索增强生成系统
 *
 * 新架构 (按流程图实现):
 * 1. BFF 层语义缓存：命中直接返回
 * 2. 并发执行 (Fan-out)：analyze_query + retrieve_original 并行
 * 3. 决策：需要检索吗？No -> 纯闲聊通道; Yes -> grade_retrieval
 * 4. grade_retrieval：专用 Reranker 模型 (<100ms)，低分触发最大 1 次重试
 * 5. generate：大模型生成，立即触发 SSE 流式输出
 * 6. 异步后台 check_hallucination：发现严重幻觉时发送撤回/修正事件
 *
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Embeddings } from '@langchain/core/embeddings';
import { HumanMessage } from '@langchain/core/messages';
import { getMilvusInstance, MilvusConfig } from './milvus-client';
import { getMilvusConnectionConfig } from './milvus-config';
import {
  createLLM,
  createEmbedding,
  createReasoningModel,
  getModelDimension,
  selectModelByDimension,
  getModelFactory,
  isOllamaProvider,
  ModelConfig,
} from './model-config';
import { getEmbeddingProvider, getEmbeddingConfigSummary } from './embedding-config';
import { SemanticCache } from './semantic-cache';

// LangSmith 追踪配置
const LANGSMITH_ENABLED = process.env.LANGCHAIN_TRACING_V2 === 'true';
const LANGSMITH_PROJECT = process.env.LANGCHAIN_PROJECT || 'agentic-rag';

function trace(step: string, data: unknown) {
  const timestamp = new Date().toISOString();
  console.log(`[LangSmith Trace] [${timestamp}] [${step}]`, JSON.stringify(data, null, 2));
  if (LANGSMITH_ENABLED) {
    console.log(`[LangSmith] Project: ${LANGSMITH_PROJECT}, Step: ${step}`);
  }
}

// ==================== 类型定义 ====================

export interface RetrievedDocument {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  relevanceScore?: number;
  rerankScore?: number;
}

export interface QueryAnalysis {
  originalQuery: string;
  rewrittenQuery: string;
  intent: 'factual' | 'exploratory' | 'comparison' | 'procedural' | 'greeting' | 'unknown';
  complexity: 'simple' | 'moderate' | 'complex';
  needsRetrieval: boolean;
  keywords: string[];
  confidence: number;
}

export interface RetrievalQuality {
  overallScore: number;
  relevanceScore: number;
  coverageScore: number;
  diversityScore: number;
  isAcceptable: boolean;
  suggestions: string[];
}

export interface HallucinationCheck {
  hasHallucination: boolean;
  confidence: number;
  problematicClaims: string[];
  supportedClaims: string[];
  overallFactualScore: number;
}

export interface SelfReflectionScore {
  documentScores: Array<{
    index: number;
    relevance: number;
    usefulness: number;
    factuality: number;
    overall: number;
    reasoning: string;
  }>;
  queryAlignmentScore: number;
  contextCompleteness: number;
  recommendation: 'use' | 'expand' | 'rewrite' | 'skip';
}

export interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface RetrievalGradeResult {
  isRelevant: boolean;
  score: number;
  keywordMatchScore: number;
  semanticScore: number;
  hasAnswerSignals: boolean;
  reasoning: string;
  documentGrades: Array<{
    index: number;
    isRelevant: boolean;
    score: number;
    matchedKeywords: string[];
    reasoning: string;
  }>;
}

export interface AgentState {
  query: string;
  originalQuery: string;
  processedQuery: string;
  topK: number;
  similarityThreshold: number;
  maxRetries: number;

  queryAnalysis?: QueryAnalysis;
  retrievedDocuments: RetrievedDocument[];
  originalQueryResults: RetrievedDocument[];
  processedQueryResults: RetrievedDocument[];
  retrievalQuality?: RetrievalQuality;
  selfReflection?: SelfReflectionScore;
  retrievalGrade?: RetrievalGradeResult;

  context: string;
  answer: string;
  hallucinationCheck?: HallucinationCheck;

  currentStep: string;
  retryCount: number;
  shouldRewrite: boolean;
  shouldRetrieve: boolean;
  gradePassThreshold: number;

  workflowSteps: WorkflowStep[];
  startTime: number;
  endTime?: number;
  totalDuration?: number;
  error?: string;

  debugInfo?: {
    milvusQueryVector?: number[];
    milvusRawScores?: number[];
    embeddingModel?: string;
    collectionDimension?: number;
    semanticCacheHit?: boolean;
  };
}

// ==================== 状态图定义 ====================

const AgentStateAnnotation = Annotation.Root({
  query: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  originalQuery: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  processedQuery: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  topK: Annotation<number>({ reducer: (_, b) => b, default: () => 5 }),
  similarityThreshold: Annotation<number>({ reducer: (_, b) => b, default: () => 0.1 }),
  maxRetries: Annotation<number>({ reducer: (_, b) => b, default: () => 1 }),

  queryAnalysis: Annotation<QueryAnalysis | undefined>({ reducer: (_, b) => b }),
  retrievedDocuments: Annotation<RetrievedDocument[]>({ reducer: (_, b) => b, default: () => [] }),
  originalQueryResults: Annotation<RetrievedDocument[]>({ reducer: (_, b) => b, default: () => [] }),
  processedQueryResults: Annotation<RetrievedDocument[]>({ reducer: (_, b) => b, default: () => [] }),
  retrievalQuality: Annotation<RetrievalQuality | undefined>({ reducer: (_, b) => b }),
  selfReflection: Annotation<SelfReflectionScore | undefined>({ reducer: (_, b) => b }),
  retrievalGrade: Annotation<RetrievalGradeResult | undefined>({ reducer: (_, b) => b }),

  context: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  answer: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  hallucinationCheck: Annotation<HallucinationCheck | undefined>({ reducer: (_, b) => b }),

  currentStep: Annotation<string>({ reducer: (_, b) => b, default: () => 'start' }),
  retryCount: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  shouldRewrite: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  shouldRetrieve: Annotation<boolean>({ reducer: (_, b) => b, default: () => true }),
  gradePassThreshold: Annotation<number>({ reducer: (_, b) => b, default: () => 0.5 }),

  workflowSteps: Annotation<WorkflowStep[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  startTime: Annotation<number>({ reducer: (_, b) => b, default: () => Date.now() }),
  endTime: Annotation<number | undefined>({ reducer: (_, b) => b }),
  totalDuration: Annotation<number | undefined>({ reducer: (_, b) => b }),
  error: Annotation<string | undefined>({ reducer: (_, b) => b }),

  debugInfo: Annotation<AgentState['debugInfo'] | undefined>({ reducer: (_, b) => b }),
});

// ==================== Agentic RAG 系统类 ====================

export interface AgenticRAGConfig {
  ollamaBaseUrl?: string;
  llmModel?: string;
  embeddingModel?: string;
  /** 小模型/极速 API 用于 analyze_query (~50ms) */
  fastLlmModel?: string;
  /** Reranker 专用模型用于 grade_retrieval (<100ms) */
  rerankerModel?: string;
  milvusConfig?: Partial<MilvusConfig>;
  enableHallucinationCheck?: boolean;
  enableSemanticCache?: boolean;
  semanticCacheConfig?: { maxSize?: number; similarityThreshold?: number };
  onStepUpdate?: (step: WorkflowStep) => void;
  /** 流式生成时每 token 回调 */
  onToken?: (token: string) => void;
  /** 异步幻觉检查发现严重问题时，发送修正事件 */
  onHallucinationCorrection?: (correction: { original: string; corrected: string }) => void;
  modelConfig?: Partial<ModelConfig>;
}

export class AgenticRAGSystem {
  private llm: BaseChatModel;
  private fastLlm: BaseChatModel;
  private rerankerLlm: BaseChatModel;
  private embeddings: Embeddings;
  private milvusConfig: MilvusConfig;
  private config: AgenticRAGConfig;
  private graph: ReturnType<StateGraph<typeof AgentStateAnnotation.State>['compile']>;
  private requestedEmbeddingModel: string;
  private semanticCache: SemanticCache;

  constructor(config: AgenticRAGConfig = {}) {
    const factory = getModelFactory();
    const envConfig = factory.getEnvConfig();

    const {
      llmModel,
      embeddingModel,
      fastLlmModel,
      rerankerModel,
      milvusConfig = {},
      enableHallucinationCheck = true,
      enableSemanticCache = true,
      semanticCacheConfig = {},
      modelConfig = {},
    } = config;

    this.config = {
      ...config,
      enableHallucinationCheck,
      enableSemanticCache,
    };

    const actualLlmModel = llmModel || (isOllamaProvider() ? envConfig.OLLAMA_LLM_MODEL : envConfig.OPENAI_LLM_MODEL);
    const actualFastModel = fastLlmModel || (isOllamaProvider() ? envConfig.OLLAMA_LLM_MODEL : 'gpt-4o-mini');
    const actualRerankerModel = rerankerModel || (factory.getReasoningProvider() === 'ollama' ? envConfig.OLLAMA_REASONING_MODEL : envConfig.OPENAI_REASONING_MODEL);

    this.llm = createLLM(actualLlmModel, { temperature: 0, ...modelConfig });
    this.fastLlm = createLLM(actualFastModel, { temperature: 0, ...modelConfig });
    this.rerankerLlm = createReasoningModel(actualRerankerModel, { temperature: 0.1, ...modelConfig });

    const embeddingConfig = getEmbeddingConfigSummary();
    const actualEmbeddingModel = embeddingModel || embeddingConfig.model;
    this.requestedEmbeddingModel = actualEmbeddingModel;
    this.embeddings = createEmbedding(embeddingModel, modelConfig);

    this.semanticCache = new SemanticCache(this.embeddings, {
      ...semanticCacheConfig,
      enabled: enableSemanticCache,
    });

    console.log(`[Agentic RAG] 初始化完成 (新架构):`);
    console.log(`  - LLM: ${actualLlmModel}, Fast: ${actualFastModel}, Reranker: ${actualRerankerModel}`);
    console.log(`  - Embedding: ${getEmbeddingProvider()}, ${embeddingConfig.model}`);
    console.log(`  - 语义缓存: ${enableSemanticCache ? '启用' : '禁用'}`);

    const connConfig = getMilvusConnectionConfig();
    this.milvusConfig = {
      address: milvusConfig.address || connConfig.address,
      collectionName: milvusConfig.collectionName || connConfig.defaultCollection,
      embeddingDimension: milvusConfig.embeddingDimension || connConfig.defaultDimension,
      indexType: milvusConfig.indexType || connConfig.defaultIndexType,
      metricType: milvusConfig.metricType || connConfig.defaultMetricType,
      token: milvusConfig.token || connConfig.token,
      ssl: milvusConfig.ssl !== undefined ? milvusConfig.ssl : connConfig.ssl,
    };

    this.graph = this.buildGraph();
  }

  private async getMatchingEmbeddings(collectionDimension: number): Promise<Embeddings> {
    const requestedDimension = getModelDimension(this.requestedEmbeddingModel);
    if (requestedDimension === collectionDimension) return this.embeddings;
    const matchingModel = selectModelByDimension(collectionDimension);
    return createEmbedding(matchingModel);
  }

  // ==================== 节点实现 ====================

  /** 路 A: analyze_query - 小模型/极速 API (~50ms) */
  private async analyzeQuery(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();

    try {
      const prompt = ChatPromptTemplate.fromTemplate(`
你是一个智能查询分析器。用户查询: {query}

以JSON格式返回（不要包含markdown代码块）:
{{
  "originalQuery": "原始查询",
  "rewrittenQuery": "优化后的查询（适合向量检索）",
  "intent": "factual/exploratory/comparison/procedural/unknown",
  "complexity": "simple/moderate/complex",
  "needsRetrieval": true,
  "keywords": ["关键词1", "关键词2"],
  "confidence": 0.0-1.0
}}

规则: 只有纯粹的问候（如"你好"、"谢谢"）才设 needsRetrieval=false，其余均为 true。
`);

      const chain = prompt.pipe(this.fastLlm).pipe(new StringOutputParser());
      const result = await chain.invoke({ query: state.query });

      let analysis: QueryAnalysis;
      try {
        const cleaned = result.replace(/```json\n?|\n?```/g, '').trim();
        analysis = JSON.parse(cleaned);
        analysis.originalQuery = state.query;

        const greetingPatterns = [
          /^(你好|您好|hi|hello|hey|嗨|哈喽)[\s!！。.]*$/i,
          /^(谢谢|感谢|thanks|thank you|thx)[\s!！。.]*$/i,
          /^(再见|拜拜|bye|goodbye)[\s!！。.]*$/i,
          /^(早上好|下午好|晚上好|早安|晚安)[\s!！。.]*$/i,
          /^(好的|ok|okay|没问题|收到)[\s!！。.]*$/i,
        ];
        const isGreeting = greetingPatterns.some((p) => p.test(state.query.trim()));
        if (isGreeting) {
          analysis.needsRetrieval = false;
          analysis.intent = 'greeting';
        } else {
          analysis.needsRetrieval = true;
        }

        if (!analysis.keywords?.length) {
          analysis.keywords = state.query.split(/\s+/).filter((w) => w.length > 0);
        }
      } catch {
        analysis = {
          originalQuery: state.query,
          rewrittenQuery: state.query,
          intent: 'unknown',
          complexity: 'moderate',
          needsRetrieval: true,
          keywords: state.query.split(/\s+/).filter((w) => w.length > 0),
          confidence: 0.5,
        };
      }

      const stepEnd = Date.now();
      trace('analyze_query', { ...analysis, duration: stepEnd - stepStart });

      return {
        queryAnalysis: analysis,
        processedQuery: analysis.rewrittenQuery,
        shouldRetrieve: analysis.needsRetrieval,
        currentStep: 'query_analyzed',
        workflowSteps: [
          {
            step: 'analyze_query',
            status: 'completed',
            startTime: stepStart,
            endTime: stepEnd,
            duration: stepEnd - stepStart,
            input: { query: state.query },
            output: analysis,
          },
        ],
      };
    } catch (error) {
      return {
        processedQuery: state.query,
        shouldRetrieve: true,
        currentStep: 'query_analyzed',
        workflowSteps: [
          {
            step: 'analyze_query',
            status: 'error',
            startTime: stepStart,
            endTime: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** 路 B: retrieve_original - 向量库查询 (~200ms)，仅使用原始查询 */
  private async retrieveOriginal(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();
    const query = state.originalQuery || state.query;

    if (!state.shouldRetrieve) {
      return {
        currentStep: 'retrieved',
        retrievedDocuments: [],
        originalQueryResults: [],
        processedQueryResults: [],
        workflowSteps: [{ step: 'retrieve_original', status: 'skipped', startTime: stepStart, endTime: Date.now() }],
      };
    }

    try {
      const milvus = getMilvusInstance(this.milvusConfig);
      await milvus.connect();
      await milvus.initializeCollection();

      const stats = await milvus.getCollectionStats();
      const collectionDimension = stats?.embeddingDimension || this.milvusConfig.embeddingDimension || 768;
      const matchingEmbeddings = await this.getMatchingEmbeddings(collectionDimension);
      const embeddingModelName = matchingEmbeddings.model || this.requestedEmbeddingModel;

      const embedding = await matchingEmbeddings.embedQuery(query);
      const results = await milvus.search(embedding, state.topK, state.similarityThreshold);

      const docs: RetrievedDocument[] = results.map((r) => ({
        content: r.content,
        metadata: { ...r.metadata, querySource: 'original' },
        score: r.score,
      }));

      const stepEnd = Date.now();
      trace('retrieve_original', { count: docs.length, duration: stepEnd - stepStart });

      return {
        retrievedDocuments: docs,
        originalQueryResults: docs,
        processedQueryResults: docs,
        currentStep: 'retrieved',
        debugInfo: {
          embeddingModel: embeddingModelName,
          collectionDimension,
          milvusRawScores: results.map((r) => r.score),
        },
        workflowSteps: [
          {
            step: 'retrieve_original',
            status: 'completed',
            startTime: stepStart,
            endTime: stepEnd,
            duration: stepEnd - stepStart,
            input: { query, topK: state.topK },
            output: { documentCount: docs.length },
          },
        ],
      };
    } catch (error) {
      return {
        retrievedDocuments: [],
        originalQueryResults: [],
        processedQueryResults: [],
        currentStep: 'retrieved',
        workflowSteps: [
          {
            step: 'retrieve_original',
            status: 'error',
            startTime: stepStart,
            endTime: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** 并发执行 (Fan-out) + 汇聚 (Join): analyze_query || retrieve_original */
  private async fanOutAndJoin(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();

    const [analysisResult, retrievalResult] = await Promise.all([
      this.analyzeQuery(state),
      this.retrieveOriginal(state),
    ]);

    const merged: Partial<typeof AgentStateAnnotation.State> = {
      ...analysisResult,
      ...retrievalResult,
      currentStep: 'joined',
      workflowSteps: [
        ...(analysisResult.workflowSteps || []),
        ...(retrievalResult.workflowSteps || []),
        {
          step: 'fan_out_join',
          status: 'completed',
          startTime: stepStart,
          endTime: Date.now(),
          duration: Date.now() - stepStart,
          input: { parallel: true },
          output: {},
        },
      ],
    };

    return merged;
  }

  /** grade_retrieval: 专用 Reranker 模型 (<100ms)，低分触发最大 1 次重试 */
  private async gradeRetrieval(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();
    const MAX_RETRIES = 1;

    if (state.retrievedDocuments.length === 0) {
      const canRetry = state.retryCount < MAX_RETRIES;
      return {
        retrievalGrade: {
          isRelevant: false,
          score: 0,
          keywordMatchScore: 0,
          semanticScore: 0,
          hasAnswerSignals: false,
          reasoning: '无检索结果',
          documentGrades: [],
        },
        shouldRewrite: canRetry,
        retryCount: state.retryCount + (canRetry ? 1 : 0),
        currentStep: 'graded',
        workflowSteps: [
          {
            step: 'grade_retrieval',
            status: 'completed',
            startTime: stepStart,
            endTime: Date.now(),
            output: { isRelevant: false, retry: canRetry },
          },
        ],
      };
    }

    try {
      const docsForPrompt = state.retrievedDocuments
        .slice(0, 10)
        .map((d, i) => `[Doc${i + 1}] score=${(d.score * 100).toFixed(1)}%\n${d.content.substring(0, 300)}`)
        .join('\n\n');

      const prompt = ChatPromptTemplate.fromTemplate(`
评估以下检索结果与查询的相关性。查询: {query}

文档:
{docs}

返回JSON（不要markdown）:
{{
  "overall_score": 0.0-1.0,
  "reasoning": "简短理由"
}}
`);

      const chain = prompt.pipe(this.rerankerLlm).pipe(new StringOutputParser());
      const response = await chain.invoke({ query: state.query, docs: docsForPrompt });

      let overallScore = 0.5;
      let reasoning = '解析失败';
      try {
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          overallScore = Math.min(1, Math.max(0, parseFloat(parsed.overall_score) || 0.5));
          reasoning = parsed.reasoning || reasoning;
        }
      } catch {
        overallScore = state.retrievedDocuments.reduce((s, d) => s + d.score, 0) / state.retrievedDocuments.length;
      }

      const isRelevant = overallScore >= (state.gradePassThreshold ?? 0.5);
      const canRetry = state.retryCount < MAX_RETRIES;
      const shouldRewrite = !isRelevant && canRetry;

      const stepEnd = Date.now();
      trace('grade_retrieval', { overallScore, isRelevant, duration: stepEnd - stepStart });

      return {
        retrievalGrade: {
          isRelevant,
          score: overallScore,
          keywordMatchScore: overallScore,
          semanticScore: overallScore,
          hasAnswerSignals: isRelevant,
          reasoning,
          documentGrades: state.retrievedDocuments.slice(0, 5).map((_, i) => ({
            index: i,
            isRelevant,
            score: overallScore,
            matchedKeywords: [],
            reasoning,
          })),
        },
        shouldRewrite,
        retryCount: state.retryCount + (shouldRewrite ? 1 : 0),
        currentStep: 'graded',
        workflowSteps: [
          {
            step: 'grade_retrieval',
            status: 'completed',
            startTime: stepStart,
            endTime: stepEnd,
            duration: stepEnd - stepStart,
            output: { overallScore, isRelevant, shouldRewrite },
          },
        ],
      };
    } catch (error) {
      return {
        retrievalGrade: {
          isRelevant: true,
          score: 0.5,
          keywordMatchScore: 0.5,
          semanticScore: 0.5,
          hasAnswerSignals: true,
          reasoning: 'Reranker 出错，默认通过',
          documentGrades: [],
        },
        shouldRewrite: false,
        currentStep: 'graded',
        workflowSteps: [
          {
            step: 'grade_retrieval',
            status: 'error',
            startTime: stepStart,
            endTime: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** 查询重写（用于低分重试，最大 1 次） */
  private async rewriteQuery(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();

    try {
      const prompt = ChatPromptTemplate.fromTemplate(`
原始查询检索结果不理想，请重写查询以获得更好结果。

原始查询: {query}
检索评估: {feedback}

直接返回重写后的查询（不要解释）:
`);

      const feedback = state.retrievalGrade?.reasoning || '相关性不足';
      const chain = prompt.pipe(this.fastLlm).pipe(new StringOutputParser());
      const rewritten = (await chain.invoke({ query: state.query, feedback })).trim();

      return {
        queryAnalysis: state.queryAnalysis ? { ...state.queryAnalysis, rewrittenQuery: rewritten } : undefined,
        processedQuery: rewritten,
        shouldRewrite: false,
        currentStep: 'query_rewritten',
        workflowSteps: [
          {
            step: 'rewrite_query',
            status: 'completed',
            startTime: stepStart,
            endTime: Date.now(),
            output: { rewrittenQuery: rewritten },
          },
        ],
      };
    } catch (error) {
      return {
        shouldRewrite: false,
        processedQuery: state.query,
        currentStep: 'query_rewritten',
        workflowSteps: [
          {
            step: 'rewrite_query',
            status: 'error',
            startTime: stepStart,
            endTime: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** 重写后重新检索（使用重写后的查询） */
  private async retrieveAfterRewrite(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();
    const query = state.processedQuery || state.query;

    try {
      const milvus = getMilvusInstance(this.milvusConfig);
      await milvus.connect();
      await milvus.initializeCollection();

      const stats = await milvus.getCollectionStats();
      const collectionDimension = stats?.embeddingDimension || this.milvusConfig.embeddingDimension || 768;
      const matchingEmbeddings = await this.getMatchingEmbeddings(collectionDimension);

      const embedding = await matchingEmbeddings.embedQuery(query);
      const results = await milvus.search(embedding, state.topK, state.similarityThreshold);

      const docs: RetrievedDocument[] = results.map((r) => ({
        content: r.content,
        metadata: { ...r.metadata, querySource: 'rewritten' },
        score: r.score,
      }));

      return {
        retrievedDocuments: docs,
        originalQueryResults: state.originalQueryResults || [],
        processedQueryResults: docs,
        currentStep: 'retrieved',
        workflowSteps: [
          {
            step: 'retrieve_after_rewrite',
            status: 'completed',
            startTime: stepStart,
            endTime: Date.now(),
            duration: Date.now() - stepStart,
            output: { documentCount: docs.length },
          },
        ],
      };
    } catch (error) {
      return {
        retrievedDocuments: [],
        currentStep: 'retrieved',
        workflowSteps: [
          {
            step: 'retrieve_after_rewrite',
            status: 'error',
            startTime: stepStart,
            endTime: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** generate: 大模型生成，支持流式输出 */
  private async generate(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const stepStart = Date.now();
    const isGreeting = !state.shouldRetrieve && state.retrievedDocuments.length === 0;

    try {
      if (isGreeting) {
        const prompt = ChatPromptTemplate.fromTemplate(`你是一个友好的AI助手。用户说: {question}\n请简短友好地回应:`);
        const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
        const answer = await chain.invoke({ question: state.query });

        return {
          context: '（简单问候，无需检索）',
          answer,
          currentStep: 'generated',
          workflowSteps: [
            {
              step: 'generate',
              status: 'completed',
              startTime: stepStart,
              endTime: Date.now(),
              duration: Date.now() - stepStart,
              output: { answerLength: answer.length },
            },
          ],
        };
      }

      const context =
        state.retrievedDocuments.length > 0
          ? state.retrievedDocuments
              .map((d, i) => `[文档${i + 1}]\n${d.content}`)
              .join('\n\n---\n\n')
          : '没有找到相关文档。';

      const prompt = ChatPromptTemplate.fromTemplate(`
你是一个知识库助手。根据以下文档回答用户问题。

【文档】：
{context}

【用户问题】：{question}

【重要】：基于文档回答，引用具体信息。若文档无关则说"未找到相关信息"。使用中文。
`);

      const onToken = this.config.onToken;
      let answer: string;

      if (onToken) {
        const messages = await prompt.formatMessages({ context, question: state.query });
        const stream = await this.llm.stream(messages);
        const chunks: string[] = [];
        for await (const chunk of stream) {
          const text = chunk.content?.toString() || '';
          if (text) {
            chunks.push(text);
            onToken(text);
          }
        }
        answer = chunks.join('');
      } else {
        const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
        answer = await chain.invoke({ context, question: state.query });
      }

      const stepEnd = Date.now();

      // 异步后台幻觉检查
      if (this.config.enableHallucinationCheck && answer && context !== '没有找到相关文档。') {
        this.runAsyncHallucinationCheck(context, answer);
      }

      return {
        context,
        answer,
        currentStep: 'generated',
        workflowSteps: [
          {
            step: 'generate',
            status: 'completed',
            startTime: stepStart,
            endTime: stepEnd,
            duration: stepEnd - stepStart,
            output: { answerLength: answer.length },
          },
        ],
      };
    } catch (error) {
      return {
        answer: '抱歉，生成答案时发生错误。',
        currentStep: 'generated',
        workflowSteps: [
          {
            step: 'generate',
            status: 'error',
            startTime: stepStart,
            endTime: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /** 异步后台幻觉检查，发现严重问题时发送修正事件 */
  private async runAsyncHallucinationCheck(context: string, answer: string): Promise<void> {
    const onCorrection = this.config.onHallucinationCorrection;
    if (!onCorrection) return;

    try {
      const prompt = ChatPromptTemplate.fromTemplate(`
检查以下答案是否与上下文一致，是否存在幻觉。

【上下文】：{context}

【答案】：{answer}

返回JSON：
{{
  "hasHallucination": true/false,
  "confidence": 0.0-1.0,
  "severity": "none/mild/severe",
  "correctedAnswer": "若严重幻觉则提供修正后的答案，否则为空字符串"
}}
`);

      const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
      const result = await chain.invoke({ context, answer });

      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (
          parsed.hasHallucination === true &&
          parsed.severity === 'severe' &&
          parsed.confidence >= 0.8 &&
          parsed.correctedAnswer
        ) {
          onCorrection({ original: answer, corrected: parsed.correctedAnswer });
        }
      }
    } catch {
      // 忽略异步检查错误
    }
  }

  private async finalize(state: typeof AgentStateAnnotation.State): Promise<Partial<typeof AgentStateAnnotation.State>> {
    const endTime = Date.now();
    return {
      endTime,
      totalDuration: endTime - state.startTime,
      currentStep: 'completed',
    };
  }

  // ==================== 图构建 ====================

  /**
   * 新架构流程图:
   *
   *  BFF 语义缓存 ──命中──> 直接返回
   *       │ 未命中
   *       v
   *  START ──> fan_out_join (analyze_query || retrieve_original)
   *       │
   *       v
   *  需要检索? ──No──> generate (纯闲聊)
   *       │ Yes
   *       v
   *  grade_retrieval (Reranker <100ms)
   *       │ 低分 ──> rewrite_query ──> retrieve_after_rewrite ──> grade_retrieval (最多1次)
   *       │ 高分
   *       v
   *  generate (大模型) ──> 立即 SSE 流式输出
   *       │
   *       v
   *  异步 check_hallucination ──严重幻觉──> 发送撤回/修正事件
   *       v
   *  finalize ──> END
   */
  private buildGraph() {
    const workflow = new StateGraph(AgentStateAnnotation)
      .addNode('fan_out_join', this.fanOutAndJoin.bind(this))
      .addNode('grade_retrieval', this.gradeRetrieval.bind(this))
      .addNode('rewrite_query', this.rewriteQuery.bind(this))
      .addNode('retrieve_after_rewrite', this.retrieveAfterRewrite.bind(this))
      .addNode('generate', this.generate.bind(this))
      .addNode('finalize', this.finalize.bind(this))

      .addEdge(START, 'fan_out_join')

      .addConditionalEdges('fan_out_join', (state) => {
        return state.shouldRetrieve ? 'grade_retrieval' : 'generate';
      })

      .addConditionalEdges('grade_retrieval', (state) => {
        if (state.shouldRewrite && state.retryCount <= 1) return 'rewrite_query';
        return 'generate';
      })

      .addEdge('rewrite_query', 'retrieve_after_rewrite')
      .addEdge('retrieve_after_rewrite', 'grade_retrieval')

      .addEdge('generate', 'finalize')
      .addEdge('finalize', END);

    return workflow.compile();
  }

  // ==================== 公共接口 ====================

  async query(
    question: string,
    options: {
      topK?: number;
      similarityThreshold?: number;
      maxRetries?: number;
      gradePassThreshold?: number;
      skipSemanticCache?: boolean;
    } = {}
  ): Promise<AgentState> {
    trace('query_start', { question, options });

    // 1. BFF 层语义缓存检查
    if (this.config.enableSemanticCache && !options.skipSemanticCache) {
      const cacheResult = await this.semanticCache.get(question);
      if (cacheResult.hit) {
        trace('semantic_cache_hit', { query: question });
        return {
          query: question,
          originalQuery: question,
          processedQuery: question,
          topK: options.topK || 5,
          similarityThreshold: options.similarityThreshold ?? 0.1,
          maxRetries: options.maxRetries ?? 1,
          gradePassThreshold: options.gradePassThreshold ?? 0.5,
          retrievedDocuments: [],
          originalQueryResults: [],
          processedQueryResults: [],
          context: cacheResult.entry.context,
          answer: cacheResult.entry.answer,
          currentStep: 'completed',
          retryCount: 0,
          shouldRewrite: false,
          shouldRetrieve: true,
          workflowSteps: [{ step: 'semantic_cache', status: 'completed', output: { hit: true } }],
          startTime: Date.now(),
          endTime: Date.now(),
          totalDuration: 0,
          debugInfo: { semanticCacheHit: true },
        } as AgentState;
      }
    }

    const initialState = {
      query: question,
      originalQuery: question,
      processedQuery: question,
      topK: options.topK || 5,
      similarityThreshold: options.similarityThreshold ?? 0.1,
      maxRetries: options.maxRetries ?? 1,
      gradePassThreshold: options.gradePassThreshold ?? 0.5,
      retrievedDocuments: [] as RetrievedDocument[],
      originalQueryResults: [] as RetrievedDocument[],
      processedQueryResults: [] as RetrievedDocument[],
      context: '',
      answer: '',
      currentStep: 'start',
      retryCount: 0,
      shouldRewrite: false,
      shouldRetrieve: true,
      workflowSteps: [] as WorkflowStep[],
      startTime: Date.now(),
    };

    try {
      const result = await this.graph.invoke(initialState, { recursionLimit: 30 });

      // 写入语义缓存
      if (this.config.enableSemanticCache && result.answer && !result.error) {
        await this.semanticCache.set(question, result.answer, result.context);
      }

      trace('query_complete', { answerLength: result.answer?.length, totalDuration: result.totalDuration });
      return result as AgentState;
    } catch (error) {
      trace('query_error', { error: error instanceof Error ? error.message : String(error) });
      return {
        ...initialState,
        error: error instanceof Error ? error.message : String(error),
        currentStep: 'error',
        endTime: Date.now(),
        totalDuration: Date.now() - initialState.startTime,
      } as AgentState;
    }
  }

  async *streamQuery(
    question: string,
    options: {
      topK?: number;
      similarityThreshold?: number;
      maxRetries?: number;
      gradePassThreshold?: number;
      skipSemanticCache?: boolean;
      onToken?: (token: string) => void;
      onHallucinationCorrection?: (correction: { original: string; corrected: string }) => void;
    } = {}
  ): AsyncGenerator<Partial<AgentState>> {
    const mergedConfig = {
      ...this.config,
      onToken: options.onToken ?? this.config.onToken,
      onHallucinationCorrection: options.onHallucinationCorrection ?? this.config.onHallucinationCorrection,
    };
    const prevConfig = this.config;
    this.config = mergedConfig;

    const initialState = {
      query: question,
      originalQuery: question,
      processedQuery: question,
      topK: options.topK || 5,
      similarityThreshold: options.similarityThreshold ?? 0.1,
      maxRetries: options.maxRetries ?? 1,
      gradePassThreshold: options.gradePassThreshold ?? 0.5,
      retrievedDocuments: [] as RetrievedDocument[],
      originalQueryResults: [] as RetrievedDocument[],
      processedQueryResults: [] as RetrievedDocument[],
      context: '',
      answer: '',
      currentStep: 'start',
      retryCount: 0,
      shouldRewrite: false,
      shouldRetrieve: true,
      workflowSteps: [] as WorkflowStep[],
      startTime: Date.now(),
    };

    try {
      if (this.config.enableSemanticCache && !options.skipSemanticCache) {
        const cacheResult = await this.semanticCache.get(question);
        if (cacheResult.hit) {
          yield {
            ...initialState,
            context: cacheResult.entry.context,
            answer: cacheResult.entry.answer,
            currentStep: 'completed',
            debugInfo: { semanticCacheHit: true },
          };
          return;
        }
      }

      for await (const chunk of await this.graph.stream(initialState, { recursionLimit: 30 })) {
        yield chunk as Partial<AgentState>;
      }
    } finally {
      this.config = prevConfig;
    }
  }
}

export function createAgenticRAG(config?: AgenticRAGConfig): AgenticRAGSystem {
  return new AgenticRAGSystem(config);
}

export default AgenticRAGSystem;
