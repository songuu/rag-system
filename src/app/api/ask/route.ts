import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';
import { analyzeQuery } from '@/lib/semantic-analyzer';
import { getMilvusInstance, MilvusConfig } from '@/lib/milvus-client';
import { Embeddings } from '@langchain/core/embeddings';
import { AgenticRAGSystem, type RetrievedDocument as AgenticRetrievedDocumentBase } from '@/lib/agentic-rag';
import { createAdaptiveEntityRAG } from '@/lib/adaptive-entity-rag';
import { 
  createLLM, 
  createEmbedding,
} from '@/lib/model-config';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';
import {
  RagKernel,
  createRagPolicy,
  resolveRagPolicyId,
  type RagKernelEnvelope,
  type RagQueryRequest,
} from '@/lib/rag';
import { runWithLangSmithRootRun } from '@/lib/langsmith/tracing';

type AgenticRetrievedDocument = AgenticRetrievedDocumentBase & {
  factualScore?: number;
};

// 获取默认 Milvus 配置（使用统一配置系统）
function getDefaultMilvusConfig(): MilvusConfig {
  const connConfig = getMilvusConnectionConfig();
  return {
    address: connConfig.address,
    collectionName: connConfig.defaultCollection,
    embeddingDimension: connConfig.defaultDimension,
    indexType: connConfig.defaultIndexType,
    metricType: connConfig.defaultMetricType,
    token: connConfig.token,
    ssl: connConfig.ssl,
  };
}

/**
 * 获取 Embedding 模型 (使用统一配置系统)
 */
function getEmbeddingModel(modelName: string): Embeddings {
  return createEmbedding(modelName);
}

/**
 * 安全提取 LLM 响应内容
 * LangChain chat models 的 invoke() 返回 AIMessage 对象
 * content 可能是字符串或复杂类型，需要安全提取
 */
function extractLLMContent(response: unknown): string {
  // 如果已经是字符串，直接返回
  if (typeof response === 'string') {
    return response;
  }
  
  // 如果是 null 或 undefined，返回空字符串
  if (response == null) {
    return '';
  }
  
  // 如果有 content 属性（AIMessage 对象）
  if (typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    
    // content 是字符串
    if (typeof content === 'string') {
      return content;
    }
    
    // content 是数组（多部分消息）
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .filter(Boolean)
        .join('');
    }
    
    // content 是其他对象，尝试序列化
    if (typeof content === 'object') {
      return JSON.stringify(content);
    }
  }
  
  // 最后尝试序列化整个响应
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      question, 
      topK = 3, 
      similarityThreshold = 0.0,
      llmModel = 'llama3.1',
      embeddingModel = 'nomic-embed-text',
      userId,
      sessionId,
      storageBackend = 'memory', // 存储后端选择
      useAgenticRAG = false,     // 是否使用 Agentic RAG 模式
      useAdaptiveEntityRAG = false, // 是否使用自适应实体路由 RAG 模式
      maxRetries = 2,            // Agentic RAG 最大重试次数
      enableReranking = true,    // 自适应实体 RAG 是否启用重排序
    } = body;

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { error: "请提供有效的问题" },
        { status: 400 }
      );
    }

    console.log(`[Ask API] 使用模型 - LLM: ${llmModel}, Embedding: ${embeddingModel}, 后端: ${storageBackend}, Agentic: ${useAgenticRAG}, AdaptiveEntity: ${useAdaptiveEntityRAG}`);

    const ragRequest: RagQueryRequest = {
      question: question.trim(),
      topK: parseInt(topK),
      similarityThreshold: parseFloat(similarityThreshold),
      llmModel,
      embeddingModel,
      storageBackend,
      userId,
      sessionId,
      useAgenticRAG,
      useAdaptiveEntityRAG,
      maxRetries: parseInt(maxRetries),
      enableReranking,
      raw: body,
    };

    const kernel = createAskKernel(ragRequest);
    const policyId = resolveRagPolicyId(ragRequest);
    const output = await runWithLangSmithRootRun<NextResponse>(
      {
        name: 'RAG API Ask',
        runType: 'chain',
        route: '/api/ask',
        policyId,
        userId,
        sessionId,
        fallbackRunId: `ask-${Date.now()}`,
        inputs: {
          question: ragRequest.question,
          topK: ragRequest.topK,
          similarityThreshold: ragRequest.similarityThreshold,
          storageBackend,
          useAgenticRAG,
          useAdaptiveEntityRAG,
        },
        metadata: {
          llm_model: llmModel,
          embedding_model: embeddingModel,
          vector_backend: storageBackend,
          max_retries: maxRetries,
          enable_reranking: enableReranking,
        },
        tags: ['rag', 'api-ask', policyId],
        output: (response) => ({
          status: response.status,
          ok: response.ok,
          rag_policy: policyId,
        }),
      },
      async (langSmithRun) => {
        const result = await kernel.execute(ragRequest, policyId);

        attachRagKernelHeaders(result.output, result.envelope);
        if (langSmithRun.enabled) {
          result.output.headers.set('x-langsmith-run-id', langSmithRun.runId);
          result.output.headers.set('x-langsmith-thread-id', langSmithRun.threadId);
          result.output.headers.set('x-langsmith-project', langSmithRun.projectName);
        }
        return result.output;
      }
    );

    return output;

  } catch (error) {
    console.error("问答处理错误:", error);
    return NextResponse.json(
      { 
        error: "处理问题时发生错误",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

function createAskKernel(ragRequest: RagQueryRequest): RagKernel<NextResponse> {
  return new RagKernel<NextResponse>([
    createRagPolicy({
      id: 'adaptive-entity',
      description: 'Adaptive entity-routing RAG backed by Milvus.',
      execute: () => handleAdaptiveEntityQuery(ragRequest.question, {
        topK: ragRequest.topK,
        llmModel: ragRequest.llmModel,
        embeddingModel: ragRequest.embeddingModel,
        maxRetries: ragRequest.maxRetries ?? 2,
        enableReranking: ragRequest.enableReranking ?? true,
      }),
    }),
    createRagPolicy({
      id: 'agentic',
      description: 'Agentic RAG backed by Milvus with retrieval grading.',
      execute: () => handleAgenticQuery(ragRequest.question, {
        topK: ragRequest.topK,
        similarityThreshold: ragRequest.similarityThreshold,
        llmModel: ragRequest.llmModel,
        embeddingModel: ragRequest.embeddingModel,
        maxRetries: ragRequest.maxRetries ?? 2,
      }),
    }),
    createRagPolicy({
      id: 'milvus-2step',
      description: 'Two-step Milvus dense-vector retrieval and generation.',
      execute: () => handleMilvusQuery(ragRequest.question, {
        topK: ragRequest.topK,
        similarityThreshold: ragRequest.similarityThreshold,
        llmModel: ragRequest.llmModel,
        embeddingModel: ragRequest.embeddingModel,
        userId: ragRequest.userId,
        sessionId: ragRequest.sessionId,
      }),
    }),
    createRagPolicy({
      id: 'memory',
      description: 'Legacy in-memory vector store RAG path.',
      execute: () => handleMemoryQuery(ragRequest),
    }),
  ]);
}

function attachRagKernelHeaders(
  response: NextResponse,
  envelope: RagKernelEnvelope
): void {
  response.headers.set('x-rag-policy', envelope.policy_id);
  response.headers.set('x-rag-trace-id', envelope.trace_id);
}

async function handleMemoryQuery(ragRequest: RagQueryRequest) {
  const ragSystem = await getRagSystem();

  const result = await ragSystem.askWithDetails(ragRequest.question, {
    topK: ragRequest.topK,
    similarityThreshold: ragRequest.similarityThreshold,
    llmModel: ragRequest.llmModel,
    embeddingModel: ragRequest.embeddingModel,
    userId: ragRequest.userId,
    sessionId: ragRequest.sessionId
  });

  // 使用语义分析器进行深度分析
  const queryEmbedding = result.retrievalDetails.queryEmbedding;
  const queryAnalysis = analyzeQuery(
    ragRequest.question,
    queryEmbedding,
    ragRequest.embeddingModel,
    result.retrievalDetails.queryVectorizationTime || 0
  );

  return NextResponse.json({
    success: true,
    question: ragRequest.question,
    answer: result.answer,
    models: {
      llm: ragRequest.llmModel,
      embedding: ragRequest.embeddingModel
    },
    retrievalDetails: {
      searchResults: result.retrievalDetails.searchResults.map(r => ({
        document: {
          content: r.document.pageContent,
          metadata: r.document.metadata
        },
        similarity: r.similarity,
        index: r.index
      })),
      queryEmbedding: queryEmbedding.slice(0, 10),
      threshold: result.retrievalDetails.threshold,
      topK: result.retrievalDetails.topK,
      totalDocuments: result.retrievalDetails.totalDocuments,
      searchTime: result.retrievalDetails.searchTime
    },
    queryAnalysis,
    context: result.context,
    traceId: result.traceId,
    timestamp: new Date().toISOString(),
  });
}

// Milvus 查询处理
async function handleMilvusQuery(
  question: string,
  options: {
    topK: number;
    similarityThreshold: number;
    llmModel: string;
    embeddingModel: string;
    userId?: string;
    sessionId?: string;
  }
) {
  const startTime = Date.now();
  const { topK, similarityThreshold, llmModel, embeddingModel } = options;

  try {
    // 1. 连接 Milvus (使用统一的全局实例)
    const milvus = getMilvusInstance(getDefaultMilvusConfig());
    await milvus.connect();
    await milvus.initializeCollection();

    // 2. 获取查询向量
    const embeddings = getEmbeddingModel(embeddingModel);
    const queryEmbedding = await embeddings.embedQuery(question);
    const vectorizationTime = Date.now() - startTime;

    // 3. 执行 Milvus 搜索
    const searchStart = Date.now();
    const searchResults = await milvus.search(queryEmbedding, topK, similarityThreshold);
    const searchTime = Date.now() - searchStart;

    // 4. 构建上下文
    const context = searchResults
      .map((r, i) => `[文档 ${i + 1}] (相似度: ${(r.score * 100).toFixed(1)}%)\n${r.content}`)
      .join('\n\n');

    // 5. 调用 LLM 生成回答 (使用统一配置系统)
    const llm = createLLM(llmModel);

    const prompt = `基于以下上下文信息回答用户的问题。如果上下文中没有相关信息，请说明你无法从现有知识库中找到答案。

上下文信息:
${context}

用户问题: ${question}

请提供详细、准确的回答:`;

    const llmStart = Date.now();
    const response = await llm.invoke(prompt);
    // 使用安全提取函数处理 AIMessage 对象
    const answer = extractLLMContent(response);
    const llmTime = Date.now() - llmStart;

    // 6. 生成查询分析
    const queryAnalysis = analyzeQuery(
      question,
      queryEmbedding,
      embeddingModel,
      vectorizationTime
    );

    // 7. 获取集合统计
    const stats = await milvus.getCollectionStats();

    return NextResponse.json({
      success: true,
      question,
      answer,
      models: {
        llm: llmModel,
        embedding: embeddingModel
      },
      storageBackend: 'milvus',
      retrievalDetails: {
        searchResults: searchResults.map((r, i) => ({
          document: {
            content: r.content,
            metadata: r.metadata
          },
          similarity: r.score,
          distance: r.distance,
          index: i
        })),
        queryEmbedding: queryEmbedding.slice(0, 10),
        threshold: similarityThreshold,
        topK,
        totalDocuments: stats?.rowCount || 0,
        searchTime,
        vectorizationTime,
        llmTime,
        milvusStats: stats
      },
      queryAnalysis,
      context,
      traceId: `milvus-${Date.now()}`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[Milvus Query Error]:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Milvus 查询失败',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

// Agentic RAG 查询处理
async function handleAgenticQuery(
  question: string,
  options: {
    topK: number;
    similarityThreshold: number;
    llmModel: string;
    embeddingModel: string;
    maxRetries: number;
  }
) {
  const { topK, similarityThreshold, llmModel, embeddingModel, maxRetries } = options;
  const milvusConfig = getDefaultMilvusConfig();

  try {
    // 使用统一配置系统创建 Agentic RAG 实例
    const agenticRAG = new AgenticRAGSystem({
      llmModel,
      embeddingModel,
      milvusConfig: {
        address: milvusConfig.address,
        collectionName: milvusConfig.collectionName,
      },
      enableHallucinationCheck: true,
    });

    const result = await agenticRAG.query(question, {
      topK,
      similarityThreshold,
      maxRetries,
    });

    return NextResponse.json({
      success: !result.error,
      question,
      answer: result.answer,
      models: {
        llm: llmModel,
        embedding: embeddingModel,
      },
      storageBackend: 'milvus',
      agenticMode: true,
      
      // 工作流信息
      workflow: {
        steps: result.workflowSteps,
        totalDuration: result.totalDuration,
        retryCount: result.retryCount,
      },
      
      // 查询分析
      queryAnalysis: result.queryAnalysis,
      
      // 检索详情
      retrievalDetails: {
        searchResults: result.retrievedDocuments.map((doc, i) => {
          const scoredDocument = doc as AgenticRetrievedDocument;

          return {
            document: {
              content: scoredDocument.content,
              metadata: scoredDocument.metadata,
            },
            similarity: scoredDocument.score,
            relevanceScore: scoredDocument.relevanceScore,
            factualScore: scoredDocument.factualScore,
            index: i,
          };
        }),
        quality: result.retrievalQuality,
        selfReflection: result.selfReflection,
        totalDocuments: result.retrievedDocuments.length,
        // 添加标准字段以兼容前端显示
        threshold: similarityThreshold,
        topK: topK,
        searchTime: result.workflowSteps?.find((step: { step?: string; duration?: number }) => step.step === '文档检索')?.duration || 0,
      },
      
      // 幻觉检查
      hallucinationCheck: result.hallucinationCheck,
      
      context: result.context,
      traceId: `agentic-${Date.now()}`,
      timestamp: new Date().toISOString(),
      error: result.error,
    });

  } catch (error) {
    console.error('[Agentic RAG Error]:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Agentic RAG 查询失败',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// 自适应实体路由 RAG 查询处理
async function handleAdaptiveEntityQuery(
  question: string,
  options: {
    topK: number;
    llmModel: string;
    embeddingModel: string;
    maxRetries: number;
    enableReranking: boolean;
  }
) {
  const { topK, llmModel, embeddingModel, maxRetries, enableReranking } = options;
  const milvusConfig = getDefaultMilvusConfig();
  try {
    console.log(`[Adaptive Entity RAG] 处理查询: "${question}"`);
    
    const adaptiveRAG = createAdaptiveEntityRAG({
      llmModel,
      embeddingModel,
      maxRetries,
      enableReranking,
      milvusCollection: milvusConfig.collectionName, // 使用主集合
    });

    const startTime = Date.now();
    const result = await adaptiveRAG.query(question, topK);
    const duration = Date.now() - startTime;

    console.log(`[Adaptive Entity RAG] 查询完成, 耗时 ${duration}ms`);

    // 确保 query 对象存在且有必要的字段
    const queryData = result.query || {};

    return NextResponse.json({
      success: true,
      question,
      answer: result.finalResponse || '',
      models: {
        llm: llmModel,
        embedding: embeddingModel,
      },
      storageBackend: 'milvus',
      adaptiveEntityMode: true,
      
      // 工作流信息
      workflow: {
        steps: result.steps || [],
        totalDuration: result.totalDuration || duration,
      },
      
      // 查询分析（认知解析层输出）- 确保所有字段都有默认值
      queryAnalysis: {
        originalQuery: queryData.originalQuery || question,
        intent: queryData.intent || 'factual',
        complexity: queryData.complexity || 'simple',
        confidence: queryData.confidence || 0.8,
        entities: queryData.entities || [],
        logicalRelations: queryData.logicalRelations || [],
        keywords: queryData.keywords || [],
      },
      
      // 实体校验结果
      entityValidation: (result.validatedEntities || []).map(e => ({
        name: e.name,
        type: e.type,
        normalizedName: e.normalizedName,
        isValid: e.isValid,
        matchScore: e.matchScore,
        suggestions: e.suggestions,
      })),
      
      // 路由决策 - 确保有默认值
      routingDecision: {
        action: result.currentDecision?.action || 'semantic_search',
        reason: result.currentDecision?.reason || '默认语义检索',
        constraints: result.currentDecision?.constraints || [],
        relaxedConstraints: result.currentDecision?.relaxedConstraints || [],
        retryCount: result.currentDecision?.retryCount || 0,
      },
      
      // 检索详情
      retrievalDetails: {
        searchResults: (result.rankedResults || []).map((r, i) => ({
          document: {
            content: r.content,
            metadata: r.metadata,
          },
          similarity: r.score,
          rerankedScore: r.rerankedScore,
          relevanceExplanation: r.relevanceExplanation,
          matchType: r.matchType,
          index: i,
        })),
        searchResultCount: (result.searchResults || []).length,
        rankedResultCount: (result.rankedResults || []).length,
        topResults: (result.rankedResults || []).slice(0, 3).map(r => ({
          id: r.id,
          score: r.score,
          rerankedScore: r.rerankedScore,
          relevanceExplanation: r.relevanceExplanation,
          contentPreview: r.content.substring(0, 200) + (r.content.length > 200 ? '...' : ''),
          matchType: r.matchType,
        })),
        totalDocuments: (result.rankedResults || []).length,
        topK: topK,
      },
      
      context: (result.rankedResults || []).map(r => r.content).join('\n\n'),
      traceId: `adaptive-entity-${Date.now()}`,
      timestamp: new Date().toISOString(),
      duration,
    });

  } catch (error) {
    console.error('[Adaptive Entity RAG Error]:', error);
    return NextResponse.json(
      {
        success: false,
        error: '自适应实体路由 RAG 查询失败',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
