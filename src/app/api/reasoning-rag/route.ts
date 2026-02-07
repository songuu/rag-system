/**
 * Reasoning RAG API 路由
 * 
 * 支持推理模型的高级 RAG 系统 API
 * 使用独立的环境变量配置（REASONING_RAG_* 前缀）
 */

import { NextRequest, NextResponse } from 'next/server';
import { executeReasoningRAG, ReasoningRAGOutput } from '@/lib/reasoning-rag';
import { MilvusConfig } from '@/lib/milvus-client';
import { getReasoningRAGConfig, getReasoningRAGConfigSummary } from '@/lib/milvus-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';
import { getConfigSummary } from '@/lib/model-config';

// 推理模型识别模式 - 用于从本地模型中识别推理模型
const REASONING_MODEL_PATTERNS = [
  { pattern: 'deepseek-r1', supportsThinking: true, description: 'DeepSeek R1 推理模型' },
  { pattern: 'qwen3', supportsThinking: true, description: 'Qwen3 推理模型' },
  { pattern: 'o1', supportsThinking: true, description: 'OpenAI o1 推理模型' },
  { pattern: 'o3', supportsThinking: true, description: 'OpenAI o3 推理模型' },
];

// 判断是否为推理模型
function isReasoningModel(modelName: string): { isReasoning: boolean; supportsThinking: boolean; description: string } {
  const nameLower = modelName.toLowerCase();
  
  for (const config of REASONING_MODEL_PATTERNS) {
    if (nameLower.includes(config.pattern) && !nameLower.includes('embedding')) {
      return {
        isReasoning: true,
        supportsThinking: config.supportsThinking,
        description: config.description
      };
    }
  }
  
  return { isReasoning: false, supportsThinking: false, description: '' };
}

// 格式化模型名称
function formatModelName(name: string): string {
  // 提取基础名称和标签
  const [baseName, tag] = name.split(':');
  const parts = baseName.split('-');
  
  // 首字母大写处理
  const formatted = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  
  return tag && tag !== 'latest' ? `${formatted} (${tag})` : formatted;
}

// 格式化字节大小
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

export interface ReasoningRAGRequest {
  query: string;
  config?: {
    reasoningModel?: string;
    embeddingModel?: string;
    topK?: number;
    rerankTopK?: number;
    similarityThreshold?: number;
    enableBM25?: boolean;
    enableRerank?: boolean;
    maxIterations?: number;
    temperature?: number;
  };
  milvusConfig?: MilvusConfig;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    // 获取 Reasoning RAG 配置（从环境变量）
    const ragConfig = getReasoningRAGConfig();
    const embeddingConfig = getEmbeddingConfigSummary();
    const llmConfig = getConfigSummary();
    
    const body: ReasoningRAGRequest = await request.json();
    const { query, config, milvusConfig } = body;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return NextResponse.json({
        success: false,
        error: '查询不能为空'
      }, { status: 400 });
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[API] Reasoning RAG 请求`);
    console.log(`[API] 查询: "${query}"`);
    console.log(`[API] 用户配置:`, JSON.stringify(config, null, 2));
    console.log(`[API] 环境配置:`, JSON.stringify({
      collection: ragConfig.collection,
      dimension: ragConfig.dimension,
      embeddingModel: embeddingConfig.model,
      reasoningModel: llmConfig.reasoningModel,
    }, null, 2));
    console.log(`${'='.repeat(60)}`);
    
    // 合并配置（环境变量 -> 用户配置 -> 默认值）
    const finalConfig = {
      // 模型配置 - 优先使用用户配置，其次使用环境变量
      reasoningModel: config?.reasoningModel || llmConfig.reasoningModel || 'deepseek-r1:7b',
      embeddingModel: config?.embeddingModel || embeddingConfig.model || 'nomic-embed-text',
      // 检索配置 - 优先使用用户配置，其次使用环境变量
      topK: config?.topK ?? ragConfig.topK,
      rerankTopK: config?.rerankTopK ?? ragConfig.rerankTopK,
      similarityThreshold: config?.similarityThreshold ?? ragConfig.similarityThreshold,
      enableBM25: config?.enableBM25 ?? ragConfig.enableBM25,
      enableRerank: config?.enableRerank ?? ragConfig.enableRerank,
      // 推理配置
      maxIterations: config?.maxIterations ?? ragConfig.maxIterations,
      temperature: config?.temperature ?? ragConfig.temperature,
      // Milvus 配置 - 使用 Reasoning RAG 专用集合
      milvusConfig: milvusConfig || {
        collectionName: ragConfig.collection,
        embeddingDimension: ragConfig.dimension,
      }
    };
    
    // 执行 Reasoning RAG
    const result: ReasoningRAGOutput = await executeReasoningRAG(query, finalConfig);
    
    const totalTime = Date.now() - startTime;
    
    console.log(`\n[API] Reasoning RAG 完成`);
    console.log(`[API] 总耗时: ${totalTime}ms`);
    console.log(`[API] 回答长度: ${result.answer.length}`);
    
    // 获取模型信息
    const modelInfo = isReasoningModel(finalConfig.reasoningModel);
    
    return NextResponse.json({
      success: true,
      data: result,
      meta: {
        requestTime: new Date().toISOString(),
        totalDuration: totalTime,
        modelInfo: {
          name: formatModelName(finalConfig.reasoningModel),
          id: finalConfig.reasoningModel,
          description: modelInfo.description || '自定义模型',
          supportsThinking: modelInfo.supportsThinking
        }
      }
    });
    
  } catch (error) {
    console.error('[API] Reasoning RAG 错误:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '未知错误',
      stack: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
}

// GET: 获取推理模型列表和配置
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');
  
  // 获取 Reasoning RAG 配置
  const ragConfig = getReasoningRAGConfig();
  const configSummary = getReasoningRAGConfigSummary();
  const embeddingConfig = getEmbeddingConfigSummary();
  const llmConfig = getConfigSummary();
  
  if (action === 'models') {
    // 从 Ollama 获取本地已安装的模型
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      const data = await response.json();
      const allModels = data.models || [];
      
      // 只筛选出本地已安装的推理模型
      const installedReasoningModels = allModels
        .map((model: any) => {
          const modelInfo = isReasoningModel(model.name);
          if (modelInfo.isReasoning) {
            return {
              id: model.name,
              name: formatModelName(model.name),
              description: modelInfo.description,
              supportsThinking: modelInfo.supportsThinking,
              installed: true,
              size: model.size,
              sizeFormatted: formatBytes(model.size),
              modifiedAt: model.modified_at,
            };
          }
          return null;
        })
        .filter(Boolean);
      
      // 如果没有推理模型，返回空列表但提示用户
      if (installedReasoningModels.length === 0) {
        return NextResponse.json({
          success: true,
          reasoningModels: [],
          message: '未检测到已安装的推理模型',
          suggestion: '请安装推理模型，例如: ollama pull deepseek-r1:7b 或 ollama pull qwen3:8b',
          supportedPatterns: REASONING_MODEL_PATTERNS.map(p => p.pattern),
          config: configSummary
        });
      }
      
      return NextResponse.json({
        success: true,
        reasoningModels: installedReasoningModels,
        count: installedReasoningModels.length,
        config: configSummary
      });
    } catch (error) {
      return NextResponse.json({
        success: false,
        error: '无法连接到 Ollama 服务',
        reasoningModels: [],
        suggestion: '请确保 Ollama 服务正在运行: ollama serve',
        config: configSummary
      });
    }
  }
  
  if (action === 'config') {
    // 返回完整配置信息
    return NextResponse.json({
      success: true,
      config: configSummary,
      embeddingConfig: {
        provider: embeddingConfig.provider,
        model: embeddingConfig.model,
        dimension: embeddingConfig.dimension,
      },
      llmConfig: {
        provider: llmConfig.provider,
        model: llmConfig.llmModel,
        reasoningModel: llmConfig.reasoningModel,
      }
    });
  }
  
  // 默认返回配置信息
  return NextResponse.json({
    success: true,
    endpoint: '/api/reasoning-rag',
    methods: ['GET', 'POST'],
    description: '推理模型增强的 RAG 系统 API',
    features: [
      'Graph State - 精细化状态管理',
      'Cognitive Layer - 编排器意图识别',
      'Hybrid Retrieval - Dense + BM25 混合检索',
      'Reranker - 深度重排序',
      'Thinking Process - 思维链可视化'
    ],
    supportedReasoningModels: REASONING_MODEL_PATTERNS.map(p => p.pattern),
    // 使用环境变量配置的默认值
    defaultConfig: {
      collection: ragConfig.collection,
      dimension: ragConfig.dimension,
      embeddingModel: embeddingConfig.model,
      reasoningModel: llmConfig.reasoningModel || 'deepseek-r1:7b',
      topK: ragConfig.topK,
      rerankTopK: ragConfig.rerankTopK,
      similarityThreshold: ragConfig.similarityThreshold,
      enableBM25: ragConfig.enableBM25,
      enableRerank: ragConfig.enableRerank,
      maxIterations: ragConfig.maxIterations,
      temperature: ragConfig.temperature
    },
    config: configSummary
  });
}
