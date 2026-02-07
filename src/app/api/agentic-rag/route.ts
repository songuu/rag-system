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
  // 如果配置变化，重新创建实例
  if (!agenticRAGInstance || config) {
    const milvusConfig = getMilvusConfig();
    agenticRAGInstance = new AgenticRAGSystem({
      ollamaBaseUrl: OLLAMA_BASE_URL,
      llmModel: config?.llmModel || 'llama3.1',
      embeddingModel: config?.embeddingModel || 'nomic-embed-text',
      milvusConfig,
      enableHallucinationCheck: true,
      enableSelfReflection: true,
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
      maxRetries = 2,
      llmModel = 'llama3.1',
      embeddingModel = 'nomic-embed-text',
      stream = false,
    } = body;

    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { error: '请提供有效的问题' },
        { status: 400 }
      );
    }

    console.log(`[Agentic RAG] 查询: "${question}", 模型: LLM=${llmModel}, Embedding=${embeddingModel}`);

    const agenticRAG = getAgenticRAG({ llmModel, embeddingModel });

    // 流式响应
    if (stream) {
      const encoder = new TextEncoder();
      const streamResponse = new ReadableStream({
        async start(controller) {
          try {
            const generator = agenticRAG.streamQuery(question, {
              topK: parseInt(topK),
              similarityThreshold: parseFloat(similarityThreshold),
              maxRetries: parseInt(maxRetries),
            });

            for await (const chunk of generator) {
              const data = JSON.stringify(chunk);
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
            
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (error) {
            const errorData = JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            });
            controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
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
    });

    return NextResponse.json({
      success: !result.error,
      question,
      answer: result.answer,
      
      // 工作流信息
      workflow: {
        steps: result.workflowSteps,
        totalDuration: result.totalDuration,
        retryCount: result.retryCount,
      },
      
      // 查询分析
      queryAnalysis: result.queryAnalysis,
      
      // 检索结果
      retrievalDetails: {
        documents: result.retrievedDocuments.map((doc, i) => ({
          index: i,
          content: doc.content,
          metadata: doc.metadata,
          score: doc.score,
          relevanceScore: doc.relevanceScore,
          factualScore: doc.factualScore,
        })),
        quality: result.retrievalQuality,
        selfReflection: result.selfReflection,
      },
      
      // 检索评估结果 (Retrieval Grader)
      retrievalGrade: result.retrievalGrade,
      
      // 调试信息 (LangSmith Trace)
      debugInfo: result.debugInfo,
      
      // 幻觉检查
      hallucinationCheck: result.hallucinationCheck,
      
      // 上下文
      context: result.context,
      
      // 模型信息
      models: {
        llm: llmModel,
        embedding: embeddingModel,
      },
      
      // 元数据
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
    version: '1.0.0',
    description: '基于 LangGraph 的代理化检索增强生成系统',
    features: [
      '查询分析与优化',
      '智能检索判断',
      '自省评分机制',
      '检索质量评估',
      '幻觉检查',
      '自动重试机制',
    ],
    workflow: [
      { step: 'analyze_query', description: '分析查询意图，优化查询语句' },
      { step: 'retrieve', description: '从向量数据库检索相关文档' },
      { step: 'self_reflect', description: '对检索结果进行自省评分' },
      { step: 'evaluate_quality', description: '评估检索质量，决定是否重试' },
      { step: 'generate', description: '基于上下文生成回答' },
      { step: 'check_hallucination', description: '检查答案是否存在幻觉' },
    ],
    config: {
      ollamaBaseUrl: OLLAMA_BASE_URL,
      milvusAddress: milvusConfig.address,
      milvusCollection: milvusConfig.collectionName,
    },
  });
}
