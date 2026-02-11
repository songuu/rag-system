/**
 * Agentic RAG API 路由
 * 提供代理化工作流的查询接口
 */

import { NextRequest, NextResponse } from 'next/server';
import { AgenticRAGSystem, AgentState, WorkflowStep } from '@/lib/agentic-rag';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

// 获取 Milvus 配置（使用统一配置系统）
function getMilvusConfig() {
  const connConfig = getMilvusConnectionConfig();
  return {
    address: connConfig.address,
    collectionName: connConfig.defaultCollection,
    token: connConfig.token,
    ssl: connConfig.ssl,
  };
}

// 全局单例
let agenticRAGInstance: AgenticRAGSystem | null = null;

function getAgenticRAG(config?: {
  llmModel?: string;
  embeddingModel?: string;
}): AgenticRAGSystem {
  if (!agenticRAGInstance || config) {
    const milvusConfig = getMilvusConfig();
    agenticRAGInstance = new AgenticRAGSystem({
      ollamaBaseUrl: OLLAMA_BASE_URL,
      llmModel: config?.llmModel || 'llama3.1',
      embeddingModel: config?.embeddingModel || 'nomic-embed-text',
      milvusConfig,
      enableHallucinationCheck: true,
      enableSemanticCache: true,
    });
  }
  return agenticRAGInstance;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      question,
      topK = 5,
      similarityThreshold = 0.3,
      maxRetries = 1,
      llmModel = 'llama3.1',
      embeddingModel = 'nomic-embed-text',
      stream = false,
      streamTokens = false,
      skipSemanticCache = false,
    } = body;

    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { error: '请提供有效的问题' },
        { status: 400 }
      );
    }

    console.log(`[Agentic RAG] 查询: "${question}", 模型: LLM=${llmModel}, Embedding=${embeddingModel}`);

    const agenticRAG = getAgenticRAG({ llmModel, embeddingModel });

    // 流式响应 (SSE 流式输出)
    if (stream) {
      const encoder = new TextEncoder();
      const HALLUCINATION_WAIT_MS = 3000;

      const streamResponse = new ReadableStream({
        async start(controller) {
          const enqueue = (type: string, payload: Record<string, unknown> = {}) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`));
          };

          try {
            const generator = agenticRAG.streamQuery(question, {
              topK: parseInt(topK),
              similarityThreshold: parseFloat(similarityThreshold),
              maxRetries: parseInt(maxRetries),
              skipSemanticCache,
              onToken: streamTokens
                ? (token: string) => enqueue('token', { token })
                : undefined,
              onHallucinationCorrection: (correction) => {
                enqueue('hallucination_correction', {
                  original: correction.original,
                  corrected: correction.corrected,
                });
              },
            });

            for await (const chunk of generator) {
              enqueue('state', { state: chunk });
            }

            // 等待异步幻觉检查可能发送的修正事件
            await new Promise((r) => setTimeout(r, HALLUCINATION_WAIT_MS));
            enqueue('done', {});
            controller.close();
          } catch (error) {
            enqueue('error', {
              error: error instanceof Error ? error.message : String(error),
            });
            controller.close();
          }
        },
      });

      return new Response(streamResponse, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // 非流式响应
    const result = await agenticRAG.query(question, {
      topK: parseInt(topK),
      similarityThreshold: parseFloat(similarityThreshold),
      maxRetries: parseInt(maxRetries),
      skipSemanticCache,
    });

    return NextResponse.json({
      success: !result.error,
      question,
      answer: result.answer,

      workflow: {
        steps: result.workflowSteps,
        totalDuration: result.totalDuration,
        retryCount: result.retryCount,
      },

      queryAnalysis: result.queryAnalysis,

      retrievalDetails: {
        documents: result.retrievedDocuments.map((doc, i) => ({
          index: i,
          content: doc.content,
          metadata: doc.metadata,
          score: doc.score,
          relevanceScore: doc.relevanceScore,
        })),
        retrievalGrade: result.retrievalGrade,
        quality: result.retrievalGrade
          ? {
              overallScore: result.retrievalGrade.score,
              relevanceScore: result.retrievalGrade.semanticScore,
              coverageScore: 1,
              diversityScore: 1,
              isAcceptable: result.retrievalGrade.isRelevant,
              suggestions: result.retrievalGrade.isRelevant ? [] : ['建议重写查询'],
            }
          : undefined,
      },

      debugInfo: result.debugInfo,
      context: result.context,

      models: { llm: llmModel, embedding: embeddingModel },

      timestamp: new Date().toISOString(),
      error: result.error,
    });

  } catch (error) {
    console.error('[Agentic RAG Error]:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Agentic RAG 处理失败',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// GET 请求返回系统信息
export async function GET() {
  const milvusConfig = getMilvusConfig();
  return NextResponse.json({
    name: 'Agentic RAG System',
    version: '2.0.0',
    description: '基于新架构的代理化检索增强生成系统',
    architecture: {
      bffSemanticCache: 'BFF 层语义缓存，命中直接返回',
      fanOut: '并发执行: analyze_query + retrieve_original',
      gradeRetrieval: 'Reranker 模型评分，最大 1 次重试',
      generate: '大模型生成，立即 SSE 流式输出',
      asyncHallucinationCheck: '异步后台幻觉检查，严重时发送修正事件',
    },
    features: [
      'BFF 语义缓存',
      '并发查询分析与原始检索',
      'Reranker 检索质量评估',
      '最大 1 次重试',
      'SSE 流式输出',
      '异步幻觉检查与修正',
    ],
    workflow: [
      { step: 'semantic_cache', description: 'BFF 层语义缓存检查' },
      { step: 'fan_out_join', description: '并发: analyze_query + retrieve_original' },
      { step: 'grade_retrieval', description: 'Reranker 模型评分' },
      { step: 'rewrite_query', description: '低分时重写查询 (仅 1 次)' },
      { step: 'generate', description: '大模型生成' },
      { step: 'async_hallucination_check', description: '异步幻觉检查' },
    ],
    config: {
      ollamaBaseUrl: OLLAMA_BASE_URL,
      milvusAddress: milvusConfig.address,
      milvusCollection: milvusConfig.collectionName,
    },
  });
}
