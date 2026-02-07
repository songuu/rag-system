/**
 * Embedding 配置 API
 * 
 * 提供 Embedding 配置查看、测试和管理接口
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getEmbeddingFactory,
  getEmbeddingConfigSummary,
  validateEmbeddingConfig,
  reloadEmbeddingConfig,
  createEmbeddingModel,
  getEmbeddingDimension,
  SILICONFLOW_MODELS,
  OLLAMA_EMBEDDING_MODELS,
  OPENAI_EMBEDDING_MODELS,
} from '@/lib/embedding-config';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'status';

  try {
    switch (action) {
      // 获取配置状态
      case 'status': {
        const summary = getEmbeddingConfigSummary();
        const validation = validateEmbeddingConfig();
        
        return NextResponse.json({
          success: true,
          config: summary,
          validation,
          timestamp: new Date().toISOString(),
        });
      }

      // 获取可用模型列表
      case 'models': {
        const factory = getEmbeddingFactory();
        const provider = factory.getProvider();
        const availableModels = factory.getAvailableModels();
        
        return NextResponse.json({
          success: true,
          provider,
          models: availableModels,
          allModels: {
            ollama: Object.entries(OLLAMA_EMBEDDING_MODELS).map(([model, info]) => ({
              model,
              ...info,
            })),
            siliconflow: Object.entries(SILICONFLOW_MODELS).map(([model, info]) => ({
              model,
              ...info,
            })),
            openai: Object.entries(OPENAI_EMBEDDING_MODELS).map(([model, info]) => ({
              model,
              ...info,
            })),
          },
        });
      }

      // 获取当前维度
      case 'dimension': {
        const dimension = getEmbeddingDimension();
        const summary = getEmbeddingConfigSummary();
        
        return NextResponse.json({
          success: true,
          dimension,
          model: summary.model,
          provider: summary.provider,
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Embedding Config API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      // 重新加载配置
      case 'reload': {
        reloadEmbeddingConfig();
        const summary = getEmbeddingConfigSummary();
        
        return NextResponse.json({
          success: true,
          message: 'Embedding 配置已重新加载',
          config: summary,
        });
      }

      // 测试 Embedding
      case 'test': {
        const { text = '这是一个测试文本', model } = body;
        
        console.log(`[Embedding Test] 测试文本: "${text}"`);
        console.log(`[Embedding Test] 指定模型: ${model || '使用默认'}`);
        
        const startTime = Date.now();
        
        try {
          const embedding = createEmbeddingModel(model);
          const result = await embedding.embedQuery(text);
          
          const duration = Date.now() - startTime;
          const dimension = result.length;
          
          console.log(`[Embedding Test] 成功! 维度: ${dimension}, 耗时: ${duration}ms`);
          
          return NextResponse.json({
            success: true,
            message: 'Embedding 测试成功',
            result: {
              dimension,
              duration,
              model: model || getEmbeddingConfigSummary().model,
              provider: getEmbeddingConfigSummary().provider,
              // 只返回前10个和后10个值作为示例
              vectorPreview: {
                first10: result.slice(0, 10),
                last10: result.slice(-10),
              },
            },
          });
        } catch (testError) {
          console.error('[Embedding Test] 失败:', testError);
          return NextResponse.json({
            success: false,
            error: testError instanceof Error ? testError.message : 'Embedding 测试失败',
            config: getEmbeddingConfigSummary(),
          }, { status: 500 });
        }
      }

      // 批量测试
      case 'batch-test': {
        const { texts = ['测试文本1', '测试文本2', '测试文本3'], model } = body;
        
        console.log(`[Embedding Batch Test] 批量测试 ${texts.length} 个文本`);
        
        const startTime = Date.now();
        
        try {
          const embedding = createEmbeddingModel(model);
          const results = await embedding.embedDocuments(texts);
          
          const duration = Date.now() - startTime;
          
          return NextResponse.json({
            success: true,
            message: '批量 Embedding 测试成功',
            result: {
              count: results.length,
              dimension: results[0]?.length || 0,
              duration,
              avgDuration: Math.round(duration / texts.length),
              model: model || getEmbeddingConfigSummary().model,
              provider: getEmbeddingConfigSummary().provider,
            },
          });
        } catch (testError) {
          console.error('[Embedding Batch Test] 失败:', testError);
          return NextResponse.json({
            success: false,
            error: testError instanceof Error ? testError.message : '批量 Embedding 测试失败',
          }, { status: 500 });
        }
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Embedding Config API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
