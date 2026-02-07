import { NextResponse } from 'next/server';
import { 
  createExpansionEngine, 
  ConversationExpansionEngine,
  ExpansionConfig,
  DocumentChunk 
} from '@/lib/conversation-expansion';

// 全局实例
let engine: ConversationExpansionEngine | null = null;

function getEngine(config?: Partial<ExpansionConfig>): ConversationExpansionEngine {
  if (!engine || config) {
    engine = createExpansionEngine(config);
  }
  return engine;
}

/**
 * POST - 生成推荐问题
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      action = 'expand',
      userQuery,
      aiResponse,
      contextChunks,
      llmModel,
      embeddingModel,
      maxSuggestions,
      minRelevanceScore,
      enableValidation,
    } = body;

    let currentEngine = getEngine();

    // 更新配置（如果提供）
    if (llmModel || embeddingModel || maxSuggestions || minRelevanceScore !== undefined || enableValidation !== undefined) {
      const newConfig: Partial<ExpansionConfig> = {};
      if (llmModel) newConfig.llmModel = llmModel;
      if (embeddingModel) newConfig.embeddingModel = embeddingModel;
      if (maxSuggestions) newConfig.maxSuggestions = maxSuggestions;
      if (minRelevanceScore !== undefined) newConfig.minRelevanceScore = minRelevanceScore;
      if (enableValidation !== undefined) newConfig.enableValidation = enableValidation;
      currentEngine.updateConfig(newConfig);
    }

    switch (action) {
      case 'expand': {
        if (!userQuery || !aiResponse) {
          return NextResponse.json(
            { success: false, error: '缺少 userQuery 或 aiResponse' },
            { status: 400 }
          );
        }

        // 转换文档格式
        const chunks: DocumentChunk[] = (contextChunks || []).map((chunk: any, index: number) => ({
          id: chunk.id || `chunk-${index}`,
          content: chunk.content || chunk.pageContent || '',
          metadata: chunk.metadata || {},
          score: chunk.score,
        }));

        console.log(`[ConversationExpansion] Expanding for query: "${userQuery.slice(0, 50)}..."`);
        console.log(`[ConversationExpansion] Context chunks: ${chunks.length}`);

        const result = await currentEngine.expand(userQuery, aiResponse, chunks);

        return NextResponse.json({
          success: true,
          suggestions: result.suggestions,
          anchor: result.anchor,
          processingTime: result.processingTime,
          timings: result.timings,
        });
      }

      case 'config': {
        return NextResponse.json({
          success: true,
          config: currentEngine.getConfig(),
        });
      }

      case 'update-config': {
        const { config } = body;
        if (!config) {
          return NextResponse.json(
            { success: false, error: '缺少 config' },
            { status: 400 }
          );
        }
        
        currentEngine.updateConfig(config);
        return NextResponse.json({
          success: true,
          config: currentEngine.getConfig(),
        });
      }

      default:
        return NextResponse.json(
          { success: false, error: `未知操作: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[ConversationExpansion API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}

/**
 * GET - 获取配置
 */
export async function GET() {
  try {
    const currentEngine = getEngine();
    return NextResponse.json({
      success: true,
      config: currentEngine.getConfig(),
    });
  } catch (error) {
    console.error('[ConversationExpansion API] GET Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}
