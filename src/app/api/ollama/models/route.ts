import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getConfigSummary, getCurrentProvider, getReasoningProvider } from '@/lib/model-config';
import { getEmbeddingConfigSummary, getEmbeddingProvider } from '@/lib/embedding-config';
import {
  OPENMAIC_LATEST_MODEL_NOTES,
  RECOMMENDED_MODELS,
  categorizeModelName,
  getModelCapabilityProfile,
  type ModelCategory,
} from '@/lib/model-catalog';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

// ==================== 提供商配置检测 ====================

interface ProviderConfig {
  llm: {
    provider: string;
    model: string;
    isOllama: boolean;
  };
  embedding: {
    provider: string;
    model: string;
    dimension: number;
    isOllama: boolean;
  };
  reasoning: {
    provider: string;
    model: string;
    baseUrl: string;
    isOllama: boolean;
  };
  // 是否需要加载 Ollama 本地模型
  needsOllamaModels: boolean;
}

interface RuntimeModelInfo {
  name: string;
  displayName?: string;
  tag?: string;
  size?: number;
  sizeFormatted?: string;
  modified_at?: string;
  modifiedAt?: string;
  digest?: string;
  dimension?: number;
  category?: ModelCategory;
  supportsThinking?: boolean;
  thinkingControl?: string;
  openMaicLatest?: boolean;
  isRemote?: boolean;
  provider?: string;
  isConfiguredFallback?: boolean;
}

interface OllamaApiModel {
  name: string;
  size?: number;
  modified_at?: string;
  digest?: string;
}

/**
 * 获取当前的提供商配置
 * 统一判断 LLM、Embedding、Reasoning 模型的提供商
 */
function getProviderConfig(): ProviderConfig {
  // 获取 LLM 配置
  const llmConfig = getConfigSummary();
  const llmProvider = getCurrentProvider();

  // 获取 Embedding 配置
  const embeddingConfig = getEmbeddingConfigSummary();
  const embeddingProvider = getEmbeddingProvider();

  // 获取推理模型配置（使用独立的 REASONING_PROVIDER）
  const reasoningProvider = getReasoningProvider();
  const reasoningModel = llmConfig.reasoningModel;
  const reasoningBaseUrl = llmConfig.reasoningBaseUrl;

  const isLlmOllama = llmProvider === 'ollama';
  const isEmbeddingOllama = embeddingProvider === 'ollama';
  const isReasoningOllama = reasoningProvider === 'ollama';

  return {
    llm: {
      provider: llmProvider,
      model: llmConfig.llmModel,
      isOllama: isLlmOllama,
    },
    embedding: {
      provider: embeddingProvider,
      model: embeddingConfig.model,
      dimension: embeddingConfig.dimension,
      isOllama: isEmbeddingOllama,
    },
    reasoning: {
      provider: reasoningProvider,
      model: reasoningModel,
      baseUrl: reasoningBaseUrl,
      isOllama: isReasoningOllama,
    },
    // 只有当任何一个使用 Ollama 时，才需要加载本地模型
    needsOllamaModels: isLlmOllama || isEmbeddingOllama || isReasoningOllama,
  };
}

/**
 * 生成远程提供商的模型信息
 */
function generateRemoteModelInfo(config: ProviderConfig) {
  const result: {
    llmModels: RuntimeModelInfo[];
    embeddingModels: RuntimeModelInfo[];
    reasoningModels: RuntimeModelInfo[];
  } = {
    llmModels: [],
    embeddingModels: [],
    reasoningModels: [],
  };

  // 远程 LLM 模型
  if (!config.llm.isOllama) {
    const category = categorizeModelName(config.llm.model);
    result.llmModels.push({
      name: config.llm.model,
      displayName: `${config.llm.model}`,
      tag: config.llm.provider,
      size: 0,
      sizeFormatted: `云端 (${config.llm.provider})`,
      modified_at: new Date().toISOString(),
      category: 'llm',
      ...getModelCapabilityProfile(config.llm.provider, config.llm.model, category),
      isRemote: true,
      provider: config.llm.provider,
    });
  }

  // 远程 Embedding 模型
  if (!config.embedding.isOllama) {
    const modelDisplayName = config.embedding.model.split('/').pop() || config.embedding.model;
    result.embeddingModels.push({
      name: config.embedding.model,
      displayName: modelDisplayName,
      tag: config.embedding.provider,
      size: 0,
      sizeFormatted: `云端 (${config.embedding.provider})`,
      modified_at: new Date().toISOString(),
      dimension: config.embedding.dimension,
      category: 'embedding',
      ...getModelCapabilityProfile(config.embedding.provider, config.embedding.model, 'embedding'),
      isRemote: true,
      provider: config.embedding.provider,
    });
  }

  // 远程推理模型
  if (!config.reasoning.isOllama) {
    const capability = getModelCapabilityProfile(
      config.reasoning.provider,
      config.reasoning.model,
      'reasoning'
    );
    result.reasoningModels.push({
      name: config.reasoning.model,
      displayName: `${config.reasoning.model}`,
      tag: config.reasoning.provider,
      size: 0,
      sizeFormatted: `云端 (${config.reasoning.provider})`,
      modified_at: new Date().toISOString(),
      category: 'reasoning',
      ...capability,
      isRemote: true,
      provider: config.reasoning.provider,
    });
  }

  return result;
}

/**
 * Ollama 离线时仍返回当前配置里的模型,避免前端模型选择器卡在 Loading。
 * 这些条目不是“已安装模型”,只是 runtime config 的只读回退。
 */
function generateConfiguredOllamaFallbackModels(config: ProviderConfig) {
  const now = new Date().toISOString();
  const result: {
    llmModels: RuntimeModelInfo[];
    embeddingModels: RuntimeModelInfo[];
    reasoningModels: RuntimeModelInfo[];
  } = {
    llmModels: [],
    embeddingModels: [],
    reasoningModels: [],
  };

  if (config.llm.isOllama) {
    result.llmModels.push({
      name: config.llm.model,
      displayName: config.llm.model,
      tag: 'configured',
      size: 0,
      sizeFormatted: '配置值',
      modified_at: now,
      category: 'llm',
      supportsThinking: false,
      isRemote: false,
      provider: 'ollama',
      isConfiguredFallback: true,
    });
  }

  if (config.embedding.isOllama) {
    result.embeddingModels.push({
      name: config.embedding.model,
      displayName: config.embedding.model,
      tag: 'configured',
      size: 0,
      sizeFormatted: '配置值',
      modified_at: now,
      dimension: config.embedding.dimension,
      category: 'embedding',
      isRemote: false,
      provider: 'ollama',
      isConfiguredFallback: true,
    });
  }

  if (config.reasoning.isOllama) {
    result.reasoningModels.push({
      name: config.reasoning.model,
      displayName: config.reasoning.model,
      tag: 'configured',
      size: 0,
      sizeFormatted: '配置值',
      modified_at: now,
      category: 'reasoning',
      supportsThinking: true,
      isRemote: false,
      provider: 'ollama',
      isConfiguredFallback: true,
    });
  }

  return result;
}

// GET: 获取模型列表（统一处理所有提供商）
export async function GET() {
  try {
    // 获取当前提供商配置
    const providerConfig = getProviderConfig();

    // 生成远程模型信息
    const remoteModels = generateRemoteModelInfo(providerConfig);

    // 初始化结果
    let reasoningModels: RuntimeModelInfo[] = [...remoteModels.reasoningModels];
    let llmModels: RuntimeModelInfo[] = [...remoteModels.llmModels];
    let embeddingModels: RuntimeModelInfo[] = [...remoteModels.embeddingModels];
    const unknownModels: RuntimeModelInfo[] = [];
    let allOllamaModels: OllamaApiModel[] = [];
    let ollamaOnline = false;

    // 如果需要加载 Ollama 模型（任何一个提供商使用 Ollama）
    if (providerConfig.needsOllamaModels) {
      try {
        const statusResponse = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        if (statusResponse.ok) {
          ollamaOnline = true;
          const data = await statusResponse.json();
          allOllamaModels = Array.isArray(data.models) ? data.models : [];

          // 分类 Ollama 本地模型
          for (const model of allOllamaModels) {
            const modelName = model.name;
            const category = categorizeModelName(modelName);

            const modelInfo = {
              name: modelName,
              displayName: modelName.split(':')[0],
              tag: modelName.split(':')[1] || 'latest',
              size: model.size ?? 0,
              sizeFormatted: formatBytes(model.size ?? 0),
              modifiedAt: model.modified_at,
              digest: model.digest,
              category,
              ...getModelCapabilityProfile('ollama', modelName, category),
              isRemote: false,
              provider: 'ollama',
            };

            // 只添加到对应的使用 Ollama 的类别
            if (category === 'reasoning' && providerConfig.reasoning.isOllama) {
              reasoningModels.push(modelInfo);
            } else if (category === 'llm' && providerConfig.llm.isOllama) {
              llmModels.push(modelInfo);
            } else if (category === 'embedding' && providerConfig.embedding.isOllama) {
              embeddingModels.push(modelInfo);
            } else if (category === 'unknown') {
              unknownModels.push(modelInfo);
            }
          }
        }
      } catch (ollamaError) {
        console.warn('Ollama 服务不可用:', ollamaError);
        // Ollama 不可用时，如果某个提供商需要 Ollama，记录警告
      }
    }

    // 如果完全不使用 Ollama（所有提供商都是远程的）
    if (!providerConfig.needsOllamaModels) {
      return NextResponse.json({
        success: true,
        hasModels: true,
        reasoningModels,
        llmModels,
        embeddingModels,
        unknownModels: [],
        allModels: [...reasoningModels, ...llmModels, ...embeddingModels],
        count: {
          total: reasoningModels.length + llmModels.length + embeddingModels.length,
          reasoning: reasoningModels.length,
          llm: llmModels.length,
          embedding: embeddingModels.length,
          unknown: 0
        },
        providerConfig: {
          llm: { provider: providerConfig.llm.provider, model: providerConfig.llm.model },
          embedding: { provider: providerConfig.embedding.provider, model: providerConfig.embedding.model, dimension: providerConfig.embedding.dimension },
          reasoning: { provider: providerConfig.reasoning.provider, model: providerConfig.reasoning.model, baseUrl: providerConfig.reasoning.baseUrl },
        },
        recommended: null, // 远程提供商不需要推荐
        openMaicLatest: OPENMAIC_LATEST_MODEL_NOTES,
        status: {
          hasRecommendedReasoning: true,
          hasRecommendedLLM: true,
          hasRecommendedEmbedding: true,
          ready: true,
          ollamaOnline: false,
          usingRemoteProviders: true,
        },
        warnings: [],
        message: '使用远程模型提供商'
      });
    }

    // 混合模式或纯 Ollama 模式
    // 检查 Ollama 是否必须在线
    const ollamaRequired = providerConfig.llm.isOllama || providerConfig.embedding.isOllama || providerConfig.reasoning.isOllama;

    if (ollamaRequired && !ollamaOnline) {
      const fallbackModels = generateConfiguredOllamaFallbackModels(providerConfig);
      reasoningModels = [...reasoningModels, ...fallbackModels.reasoningModels];
      llmModels = [...llmModels, ...fallbackModels.llmModels];
      embeddingModels = [...embeddingModels, ...fallbackModels.embeddingModels];

      return NextResponse.json({
        success: true,
        hasModels: true,
        offline: true,
        error: 'Ollama 服务未运行',
        code: 'OLLAMA_OFFLINE',
        suggestion: '请先启动 Ollama 服务: ollama serve',
        reasoningModels,
        llmModels,
        embeddingModels,
        unknownModels: [],
        allModels: [...reasoningModels, ...llmModels, ...embeddingModels],
        providerConfig: {
          llm: { provider: providerConfig.llm.provider, model: providerConfig.llm.model },
          embedding: { provider: providerConfig.embedding.provider, model: providerConfig.embedding.model, dimension: providerConfig.embedding.dimension },
          reasoning: { provider: providerConfig.reasoning.provider, model: providerConfig.reasoning.model, baseUrl: providerConfig.reasoning.baseUrl },
        },
        openMaicLatest: OPENMAIC_LATEST_MODEL_NOTES,
        status: {
          ollamaOnline: false,
          ollamaRequired: true,
          ready: false,
          usingConfiguredFallback: true,
        },
        warnings: ['Ollama 离线,模型列表使用当前环境配置作为回退。'],
      });
    }

    // 如果没有任何模型
    if (reasoningModels.length === 0 && llmModels.length === 0 && embeddingModels.length === 0) {
      return NextResponse.json({
        success: true,
        hasModels: false,
        llmModels: [],
        embeddingModels: [],
        reasoningModels: [],
        allModels: [],
        providerConfig: {
          llm: { provider: providerConfig.llm.provider, model: providerConfig.llm.model },
          embedding: { provider: providerConfig.embedding.provider, model: providerConfig.embedding.model, dimension: providerConfig.embedding.dimension },
          reasoning: { provider: providerConfig.reasoning.provider, model: providerConfig.reasoning.model, baseUrl: providerConfig.reasoning.baseUrl },
        },
        recommended: RECOMMENDED_MODELS,
        openMaicLatest: OPENMAIC_LATEST_MODEL_NOTES,
        message: '未检测到已安装的模型',
        suggestion: '请安装推荐的模型'
      });
    }

    // 获取推荐模型状态（仅对 Ollama 有效）
    const recommendedStatus = {
      reasoning: RECOMMENDED_MODELS.reasoning.map(rec => ({
        ...rec,
        installed: reasoningModels.some(m => m.name?.includes(rec.name.split(':')[0]))
      })),
      llm: RECOMMENDED_MODELS.llm.map(rec => ({
        ...rec,
        installed: llmModels.some(m => m.name?.includes(rec.name.split(':')[0]))
      })),
      embedding: RECOMMENDED_MODELS.embedding.map(rec => ({
        ...rec,
        installed: embeddingModels.some(m => m.name?.includes(rec.name.split(':')[0]))
      }))
    };

    // 检查是否有推荐模型已安装（或使用远程提供商）
    const hasRecommendedReasoning = !providerConfig.reasoning.isOllama || recommendedStatus.reasoning.some(m => m.installed);
    const hasRecommendedLLM = !providerConfig.llm.isOllama || recommendedStatus.llm.some(m => m.installed);
    const hasRecommendedEmbedding = !providerConfig.embedding.isOllama || recommendedStatus.embedding.some(m => m.installed);

    // 构建警告信息
    const warnings: string[] = [];
    if (providerConfig.reasoning.isOllama && !hasRecommendedReasoning) {
      warnings.push('未检测到推理模型，建议安装 DeepSeek R1 或 Qwen3 以使用 Reasoning RAG');
    }
    if (providerConfig.llm.isOllama && !hasRecommendedLLM) {
      warnings.push('未检测到推荐的 LLM 模型，建议安装 Llama 3.1 或 Qwen 2.5');
    }
    if (providerConfig.embedding.isOllama && !hasRecommendedEmbedding) {
      warnings.push('未检测到推荐的 Embedding 模型，建议安装 nomic-embed-text');
    }
    if (unknownModels.length > 0) {
      warnings.push(`检测到 ${unknownModels.length} 个未分类的模型`);
    }

    return NextResponse.json({
      success: true,
      hasModels: true,
      reasoningModels,
      llmModels,
      embeddingModels,
      unknownModels,
      allModels: [...reasoningModels, ...llmModels, ...embeddingModels, ...unknownModels],
      count: {
        total: reasoningModels.length + llmModels.length + embeddingModels.length + unknownModels.length,
        reasoning: reasoningModels.length,
        llm: llmModels.length,
        embedding: embeddingModels.length,
        unknown: unknownModels.length
      },
      providerConfig: {
        llm: { provider: providerConfig.llm.provider, model: providerConfig.llm.model },
        embedding: { provider: providerConfig.embedding.provider, model: providerConfig.embedding.model, dimension: providerConfig.embedding.dimension },
        reasoning: { provider: providerConfig.reasoning.provider, model: providerConfig.reasoning.model, baseUrl: providerConfig.reasoning.baseUrl },
      },
      recommended: recommendedStatus,
      openMaicLatest: OPENMAIC_LATEST_MODEL_NOTES,
      status: {
        hasRecommendedReasoning,
        hasRecommendedLLM,
        hasRecommendedEmbedding,
        ready: hasRecommendedLLM && hasRecommendedEmbedding,
        ollamaOnline,
        usingRemoteProviders: !providerConfig.needsOllamaModels ||
          !providerConfig.llm.isOllama ||
          !providerConfig.embedding.isOllama,
      },
      warnings
    });

  } catch (error) {
    console.error('Failed to fetch models:', error);
    return NextResponse.json({
      success: false,
      error: '获取模型列表失败',
      code: 'FETCH_ERROR',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

// POST: 模型操作（拉取、删除等）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, modelName } = body;

    if (action === 'pull') {
      // 触发模型拉取（异步）
      const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });

      if (!response.ok) {
        throw new Error('Failed to initiate model pull');
      }

      return NextResponse.json({
        success: true,
        message: `正在下载模型: ${modelName}`,
        note: '下载过程可能需要几分钟，请稍后刷新查看'
      });
    }

    if (action === 'delete') {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });

      if (!response.ok) {
        throw new Error('Failed to delete model');
      }

      return NextResponse.json({
        success: true,
        message: `已删除模型: ${modelName}`
      });
    }

    if (action === 'validate') {
      // 验证模型是否可用
      const response = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });

      return NextResponse.json({
        success: response.ok,
        available: response.ok,
        modelName
      });
    }

    return NextResponse.json({
      success: false,
      error: 'Unknown action'
    }, { status: 400 });

  } catch (error) {
    console.error('Model operation error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Operation failed'
    }, { status: 500 });
  }
}

// 格式化字节大小
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
