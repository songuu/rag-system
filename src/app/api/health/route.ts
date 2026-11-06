import { NextResponse } from 'next/server';
import { getCurrentRagSystem } from '@/lib/rag-instance';
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
import { checkElasticsearchReadiness } from '@/lib/elasticsearch/client';
import { getElasticsearchRuntimeConfig } from '@/lib/elasticsearch/config';

// GET /api/health - 系统健康检查
export async function GET() {
  try {
    // 获取实际的模型配置
    const llmConfig = getConfigSummary();
    const embeddingConfig = getEmbeddingConfigSummary();
    const postgresConfig = getPostgresRuntimeConfig();
    if (process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() === 'active') {
      // Published generations have physical per-generation indexes. Probing the
      // old shared index can report a false failure or initialize legacy state.
      const persistence = await resolvePostgresReadiness(postgresConfig);
      return NextResponse.json({
        success: persistence.schemaReady,
        status: persistence.schemaReady ? 'control_plane_ready' : 'not_ready',
        publication: { mode: 'active', check: 'control-plane' },
        persistence,
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
        timestamp: new Date().toISOString(),
      }, { status: persistence.schemaReady ? 200 : 503, headers: { 'cache-control': 'no-store' } });
    }
    const elasticsearch = await checkElasticsearchReadiness(
      getElasticsearchRuntimeConfig()
    );
    const persistence = shouldUsePostgresPersistence(postgresConfig)
      ? await resolvePostgresReadiness(postgresConfig)
      : {
          backend: 'local' as const,
          connected: null,
          schemaReady: null,
        };

    if (
      (persistence.backend === 'postgres' && !persistence.schemaReady)
      || (elasticsearch.mode === 'active' && !elasticsearch.indexReady)
    ) {
      return NextResponse.json({
        success: false,
        status: 'not_ready',
        persistence,
        elasticsearch,
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
        timestamp: new Date().toISOString(),
      }, { status: 503, headers: { 'cache-control': 'no-store' } });
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
        elasticsearch,
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
        timestamp: new Date().toISOString(),
      }, { headers: { 'cache-control': 'no-store' } });
    }

    // Readiness observes startup; a probe must never create the corpus or
    // compete with user requests for embedding/model capacity.
    const status = getCurrentRagSystem()?.getStatus() ?? {
      initialized: false,
      documentCount: 0,
      embeddingDimension: embeddingConfig.dimension,
    };
    const backend = resolveRagVectorBackend();
    // Remote vector requests do not use the legacy in-memory corpus. Report
    // dependency/control-plane readiness without pretending a model was loaded.
    const remoteVectorBackend = backend === 'milvus' || backend === 'zilliz';
    const ready = remoteVectorBackend || status.initialized;

    return NextResponse.json({
      success: ready,
      status: remoteVectorBackend ? 'control_plane_ready' : ready ? 'ready' : 'not_ready',
      ragSystem: {
        initialized: status.initialized,
        documentCount: status.documentCount,
        embeddingDimension: status.embeddingDimension
      },
      vectorBackend: {
        backend,
        disabled: false,
      },
      persistence,
      elasticsearch,
      // 返回实际的模型配置
      modelConfig: publicModelConfig(llmConfig, embeddingConfig),
      timestamp: new Date().toISOString()
    }, { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } });
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
        ...(process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() === 'active'
          ? { publication: { mode: 'active', check: 'control-plane' } } : {}),
        // 仍然返回配置信息
        modelConfig: publicModelConfig(llmConfig, embeddingConfig),
      }, { status: 503, headers: { 'cache-control': 'no-store' } });
    } catch {
      return NextResponse.json(
        { 
          success: false,
          status: 'not_ready',
          error: '健康检查失败'
        },
        { status: 503, headers: { 'cache-control': 'no-store' } }
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
