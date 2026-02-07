/**
 * Self-Corrective RAG API 路由
 * 
 * 提供自省式修正 RAG 的 HTTP 接口
 */

import { NextRequest, NextResponse } from 'next/server';
import { executeSCRAG, SCRAGInput, SCRAGOutput } from '@/lib/self-corrective-rag';
import { MilvusConfig } from '@/lib/milvus-client';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';

export const maxDuration = 60; // 最大执行时间 60 秒

interface RequestBody {
  query: string;
  topK?: number;
  similarityThreshold?: number;
  maxRewriteAttempts?: number;
  gradePassThreshold?: number;
  milvusConfig?: {
    address?: string;
    collectionName?: string;
    embeddingDimension?: number;
  };
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    const body: RequestBody = await request.json();
    
    // 验证必需参数
    if (!body.query || typeof body.query !== 'string' || body.query.trim() === '') {
      return NextResponse.json(
        { error: '请提供有效的查询内容' },
        { status: 400 }
      );
    }
    
    console.log(`\n[API] Self-Corrective RAG 请求`);
    console.log(`[API] 查询: "${body.query}"`);
    console.log(`[API] 配置:`, {
      topK: body.topK || 5,
      similarityThreshold: body.similarityThreshold || 0.3,
      maxRewriteAttempts: body.maxRewriteAttempts || 3,
      gradePassThreshold: body.gradePassThreshold || 0.6,
    });
    
    // 构建 Milvus 配置（使用统一配置系统）
    const connConfig = getMilvusConnectionConfig();
    const milvusConfig: MilvusConfig = {
      address: body.milvusConfig?.address || connConfig.address,
      collectionName: body.milvusConfig?.collectionName || connConfig.defaultCollection,
      embeddingDimension: body.milvusConfig?.embeddingDimension || connConfig.defaultDimension,
      token: connConfig.token,
      ssl: connConfig.ssl,
    };
    
    // 构建输入
    const input: SCRAGInput = {
      query: body.query.trim(),
      topK: body.topK,
      similarityThreshold: body.similarityThreshold,
      maxRewriteAttempts: body.maxRewriteAttempts,
      gradePassThreshold: body.gradePassThreshold,
      milvusConfig,
    };
    
    // 执行 Self-Corrective RAG
    const result: SCRAGOutput = await executeSCRAG(input);
    
    // 构建响应
    const response = {
      success: !result.error,
      answer: result.answer,
      
      // 查询信息
      query: {
        original: result.originalQuery,
        final: result.finalQuery,
        wasRewritten: result.wasRewritten,
        rewriteCount: result.rewriteCount,
      },
      
      // 重写历史
      rewriteHistory: result.rewriteHistory.map(r => ({
        original: r.originalQuery,
        rewritten: r.rewrittenQuery,
        reason: r.rewriteReason,
        keywords: r.keywords,
        attempt: r.rewriteCount,
      })),
      
      // 检索结果
      retrieval: {
        totalDocuments: result.retrievedDocuments.length,
        filteredDocuments: result.filteredDocuments.length,
        documents: result.filteredDocuments.map(d => ({
          id: d.id,
          content: d.content.substring(0, 500),
          score: d.score,
          gradeResult: d.gradeResult,
          metadata: d.metadata,
        })),
      },
      
      // Grader 结果
      graderResult: result.graderResult ? {
        passRate: result.graderResult.passRate,
        passCount: result.graderResult.passCount,
        totalCount: result.graderResult.totalCount,
        shouldRewrite: result.graderResult.shouldRewrite,
        reasoning: result.graderResult.overallReasoning,
        documentGrades: result.graderResult.documentGrades,
      } : null,
      
      // 生成结果
      generation: result.generationResult ? {
        confidence: result.generationResult.confidence,
        usedDocuments: result.generationResult.usedDocuments,
        sources: result.generationResult.sources,
      } : null,
      
      // 执行追踪
      workflow: {
        nodeExecutions: result.nodeExecutions.map(n => ({
          node: n.node,
          status: n.status,
          duration: n.duration,
          input: n.input,
          output: n.output,
          error: n.error,
        })),
        decisionPath: result.decisionPath,
        totalDuration: result.totalDuration,
      },
      
      // 错误信息
      error: result.error,
      
      // API 元数据
      meta: {
        apiDuration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
    };
    
    console.log(`[API] 响应完成，耗时: ${Date.now() - startTime}ms`);
    
    return NextResponse.json(response);
    
  } catch (error: any) {
    console.error(`[API] Self-Corrective RAG 错误:`, error);
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || '未知错误',
        answer: '',
        meta: {
          apiDuration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 500 }
    );
  }
}

// GET 请求返回 API 信息
export async function GET() {
  return NextResponse.json({
    name: 'Self-Corrective RAG API',
    version: '1.0.0',
    description: '基于 LangGraph + Milvus 的自省式修正检索增强生成系统',
    architecture: {
      nodes: [
        {
          name: 'Retrieve',
          description: '从 Milvus 向量数据库检索 Top-K 相关文档',
          icon: '🔍',
        },
        {
          name: 'Grader',
          description: '使用轻量级 LLM 判断文档是否包含回答必要信息',
          icon: '🔬',
        },
        {
          name: 'Rewrite',
          description: '当质检失败时分析原因并生成新查询',
          icon: '✏️',
        },
        {
          name: 'Generate',
          description: '基于通过质检的高质量文档生成回答',
          icon: '💬',
        },
      ],
      flow: 'START → Retrieve → Grade → [Rewrite → Retrieve] (loop) → Generate → END',
    },
    endpoints: {
      POST: {
        description: '执行 Self-Corrective RAG 查询',
        body: {
          query: 'string (required) - 用户查询',
          topK: 'number (optional, default: 5) - 检索文档数量',
          similarityThreshold: 'number (optional, default: 0.3) - 相似度阈值',
          maxRewriteAttempts: 'number (optional, default: 3) - 最大重写次数',
          gradePassThreshold: 'number (optional, default: 0.6) - 质检通过阈值',
          milvusConfig: 'object (optional) - Milvus 配置',
        },
      },
    },
  });
}
