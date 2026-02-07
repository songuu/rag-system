import { NextRequest, NextResponse } from 'next/server';
import { getMilvusRAGSystem, resetMilvusRAGSystem } from '@/lib/rag-milvus';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';

// 环境变量配置
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

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

// POST: RAG 操作
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      // 初始化系统
      case 'initialize': {
        const milvusConfig = getMilvusConfig();
        const ragSystem = await getMilvusRAGSystem({
          ollamaBaseUrl: OLLAMA_BASE_URL,
          llmModel: params.llmModel || LLM_MODEL,
          embeddingModel: params.embeddingModel || EMBEDDING_MODEL,
          storageBackend: 'milvus',
          milvusConfig: {
            address: params.milvusAddress || milvusConfig.address,
            collectionName: params.collectionName || milvusConfig.collectionName,
            token: milvusConfig.token,
            ssl: milvusConfig.ssl,
          },
        });

        const status = await ragSystem.getStatus();

        return NextResponse.json({
          success: true,
          message: 'RAG 系统已初始化',
          status,
        });
      }

      // 提问
      case 'ask': {
        const { question, topK = 5, threshold = 0.0 } = params;

        if (!question || typeof question !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的问题',
          }, { status: 400 });
        }

        const ragSystem = await getMilvusRAGSystem({
          ollamaBaseUrl: OLLAMA_BASE_URL,
          llmModel: LLM_MODEL,
          embeddingModel: EMBEDDING_MODEL,
          storageBackend: 'milvus',
          milvusConfig: getMilvusConfig(),
        });

        const result = await ragSystem.ask(question, { topK, threshold });

        return NextResponse.json({
          success: true,
          ...result,
        });
      }

      // 搜索
      case 'search': {
        const { query, topK = 5, threshold = 0.0 } = params;

        if (!query || typeof query !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的查询',
          }, { status: 400 });
        }

        const ragSystem = await getMilvusRAGSystem({
          ollamaBaseUrl: OLLAMA_BASE_URL,
          llmModel: LLM_MODEL,
          embeddingModel: EMBEDDING_MODEL,
          storageBackend: 'milvus',
          milvusConfig: getMilvusConfig(),
        });

        const results = await ragSystem.search(query, topK, threshold);

        return NextResponse.json({
          success: true,
          query,
          results,
          count: results.length,
        });
      }

      // 添加文档
      case 'add-documents': {
        const { documents } = params;

        if (!documents || !Array.isArray(documents) || documents.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文档列表',
          }, { status: 400 });
        }

        const ragSystem = await getMilvusRAGSystem({
          ollamaBaseUrl: OLLAMA_BASE_URL,
          llmModel: LLM_MODEL,
          embeddingModel: EMBEDDING_MODEL,
          storageBackend: 'milvus',
          milvusConfig: getMilvusConfig(),
        });

        const ids = await ragSystem.addDocuments(documents);

        return NextResponse.json({
          success: true,
          message: `已添加 ${ids.length} 个文档`,
          ids,
        });
      }

      // 清空
      case 'clear': {
        const ragSystem = await getMilvusRAGSystem({
          ollamaBaseUrl: OLLAMA_BASE_URL,
          llmModel: LLM_MODEL,
          embeddingModel: EMBEDDING_MODEL,
          storageBackend: 'milvus',
          milvusConfig: getMilvusConfig(),
        });

        await ragSystem.clear();

        return NextResponse.json({
          success: true,
          message: '已清空所有文档',
        });
      }

      // 重置
      case 'reset': {
        resetMilvusRAGSystem();

        return NextResponse.json({
          success: true,
          message: 'RAG 系统已重置',
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[RAG-Milvus API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// GET: 获取状态
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'status';

  try {
    switch (action) {
      case 'status': {
        const ragSystem = await getMilvusRAGSystem({
          ollamaBaseUrl: OLLAMA_BASE_URL,
          llmModel: LLM_MODEL,
          embeddingModel: EMBEDDING_MODEL,
          storageBackend: 'milvus',
          milvusConfig: getMilvusConfig(),
        });

        const status = await ragSystem.getStatus();

        return NextResponse.json({
          success: true,
          ...status,
          config: ragSystem.getConfig(),
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[RAG-Milvus API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
