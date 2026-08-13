import { NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';
import { getConfigSummary } from '@/lib/model-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';
import {
  isVectorBackendDisabled,
  resolveRagVectorBackend,
} from '@/lib/rag/vector-backend';
import { checkPostgresReadiness } from '@/lib/postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
} from '@/lib/postgres/env';
import { redactErrorForLog } from '@/lib/security/error-redaction';

// GET /api/health - 系统健康检查
export async function GET() {
  try {
    // 获取实际的模型配置
    const llmConfig = getConfigSummary();
    const embeddingConfig = getEmbeddingConfigSummary();
    const postgresConfig = getPostgresRuntimeConfig();
    const persistence = shouldUsePostgresPersistence(postgresConfig)
      ? await resolvePostgresReadiness(postgresConfig)
      : {
          backend: 'local' as const,
          connected: null,
          schemaReady: null,
        };

    if (persistence.backend === 'postgres' && !persistence.schemaReady) {
      return NextResponse.json({
        success: false,
        status: 'not_ready',
        persistence,
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
        timestamp: new Date().toISOString(),
      }, { status: 503 });
    }

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
        persistence,
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
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
      persistence,
      // 返回实际的模型配置
      modelConfig: publicModelConfig(llmConfig, embeddingConfig),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('健康检查错误:', redactErrorForLog(error));
    
    // 即使 RAG 系统初始化失败，也返回配置信息
    try {
      const llmConfig = getConfigSummary();
      const embeddingConfig = getEmbeddingConfigSummary();
      
      return NextResponse.json({
        success: false,
        status: 'not_ready',
        error: '健康检查失败',
        // 仍然返回配置信息
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
      }, { status: 503 });
    } catch {
      return NextResponse.json(
        { 
          success: false,
          status: 'not_ready',
          error: '健康检查失败'
        },
        { status: 503 }
      );
    }
  }
}

async function resolvePostgresReadiness(
  config: ReturnType<typeof getPostgresRuntimeConfig>
): Promise<{
  backend: 'postgres';
  connected: boolean;
  schemaReady: boolean;
}> {
  assertPostgresPersistenceConfigured(config);
  const readiness = await checkPostgresReadiness(config);
  return {
    backend: 'postgres',
    ...readiness,
  };
}

function publicModelConfig(
  llmConfig: ReturnType<typeof getConfigSummary>,
  embeddingConfig: ReturnType<typeof getEmbeddingConfigSummary>
) {
  return {
    llm: {
      provider: llmConfig.provider,
      model: llmConfig.llmModel,
    },
    embedding: {
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      dimension: embeddingConfig.dimension,
    },
  };
}
