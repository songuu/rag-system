import { NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';
import { getConfigSummary } from '@/lib/model-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';
import {
  isVectorBackendDisabled,
  resolveRagVectorBackend,
} from '@/lib/rag/vector-backend';

// GET /api/health - 系统健康检查
export async function GET() {
  try {
    // 获取实际的模型配置
    const llmConfig = getConfigSummary();
    const embeddingConfig = getEmbeddingConfigSummary();

    // Do not initialize the legacy local RAG singleton while vector retrieval
    // is explicitly disabled. Health remains safe to call from the portal.
    if (isVectorBackendDisabled()) {
      return NextResponse.json({
        success: true,
        ragSystem: {
          initialized: false,
          documentCount: 0,
          embeddingDimension: embeddingConfig.dimension,
        },
        vectorBackend: {
          backend: resolveRagVectorBackend(),
          disabled: true,
        },
        modelConfig: {
          llm: {
            provider: llmConfig.provider,
            model: llmConfig.llmModel,
          },
          embedding: {
            provider: embeddingConfig.provider,
            model: embeddingConfig.model,
            dimension: embeddingConfig.dimension,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

    const ragSystem = await getRagSystem();
    const status = ragSystem.getStatus();

    return NextResponse.json({
      success: true,
      ragSystem: {
        initialized: status.initialized,
        documentCount: status.documentCount,
        embeddingDimension: status.embeddingDimension
      },
      vectorBackend: {
        backend: resolveRagVectorBackend(),
        disabled: false,
      },
      // 返回实际的模型配置
      modelConfig: {
        llm: {
          provider: llmConfig.provider,
          model: llmConfig.llmModel,
        },
        embedding: {
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dimension: embeddingConfig.dimension,
        },
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('健康检查错误:', error);
    
    // 即使 RAG 系统初始化失败，也返回配置信息
    try {
      const llmConfig = getConfigSummary();
      const embeddingConfig = getEmbeddingConfigSummary();
      
      return NextResponse.json({
        success: false,
        error: '健康检查失败',
        details: error instanceof Error ? error.message : String(error),
        // 仍然返回配置信息
        modelConfig: {
          llm: {
            provider: llmConfig.provider,
            model: llmConfig.llmModel,
          },
          embedding: {
            provider: embeddingConfig.provider,
            model: embeddingConfig.model,
            dimension: embeddingConfig.dimension,
          },
        },
      }, { status: 500 });
    } catch {
      return NextResponse.json(
        { 
          success: false,
          error: '健康检查失败',
          details: error instanceof Error ? error.message : String(error)
        },
        { status: 500 }
      );
    }
  }
}
