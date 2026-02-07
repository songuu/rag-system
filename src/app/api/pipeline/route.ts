import { NextRequest, NextResponse } from 'next/server';
import { 
  DocumentPipeline, 
  loadDocument, 
  splitDocument, 
  generateEmbeddings,
  storeToMilvus,
  DataSourceType 
} from '@/lib/document-pipeline';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';

// 环境变量配置
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
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

// POST: 处理文档
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    // 处理 multipart/form-data (文件上传)
    if (contentType.includes('multipart/form-data')) {
      return handleFileUpload(request);
    }
    
    // 处理 JSON 请求
    const body = await request.json();
    const { action, ...params } = body;
    
    switch (action) {
      // 处理文本
      case 'process-text': {
        const { text, source = 'text-input', chunkSize, chunkOverlap, embeddingModel } = params;
        
        console.log(`[Pipeline] process-text with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        if (!text || typeof text !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文本内容',
          }, { status: 400 });
        }
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = embeddingModel || EMBEDDING_MODEL;
        
        const pipeline = new DocumentPipeline({
          chunkSize: chunkSize || 500,
          chunkOverlap: chunkOverlap || 50,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const result = await pipeline.processDocument(text, { filename: source });
        
        return NextResponse.json({
          success: true,
          ...result,
          embeddingModel: modelToUse,
        });
      }
      
      // 处理 URL
      case 'process-url': {
        const { url, chunkSize, chunkOverlap, embeddingModel } = params;
        
        console.log(`[Pipeline] process-url with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        if (!url || typeof url !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的 URL',
          }, { status: 400 });
        }
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = embeddingModel || EMBEDDING_MODEL;
        
        const pipeline = new DocumentPipeline({
          chunkSize: chunkSize || 500,
          chunkOverlap: chunkOverlap || 50,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const result = await pipeline.processDocument(url);
        
        return NextResponse.json({
          success: true,
          ...result,
          embeddingModel: modelToUse,
        });
      }
      
      // 处理 YouTube
      case 'process-youtube': {
        const { videoUrl, chunkSize, chunkOverlap, embeddingModel } = params;
        
        console.log(`[Pipeline] process-youtube with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        if (!videoUrl || typeof videoUrl !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的 YouTube URL',
          }, { status: 400 });
        }
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = embeddingModel || EMBEDDING_MODEL;
        
        const pipeline = new DocumentPipeline({
          chunkSize: chunkSize || 500,
          chunkOverlap: chunkOverlap || 50,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const result = await pipeline.processDocument(videoUrl, { type: 'youtube' });
        
        return NextResponse.json({
          success: true,
          ...result,
          embeddingModel: modelToUse,
        });
      }
      
      // 预览分块（不存储）
      case 'preview-chunks': {
        const { text, source = 'preview', chunkSize, chunkOverlap } = params;
        
        if (!text || typeof text !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文本内容',
          }, { status: 400 });
        }
        
        const document = await loadDocument(text, { filename: source });
        const chunks = await splitDocument(document, {
          chunkSize: chunkSize || 500,
          chunkOverlap: chunkOverlap || 50,
        });
        
        return NextResponse.json({
          success: true,
          totalChunks: chunks.length,
          averageChunkSize: Math.round(chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length),
          chunks: chunks.map((chunk, i) => ({
            index: i,
            content: chunk.content,
            length: chunk.content.length,
          })),
        });
      }
      
      // 批量处理
      case 'batch-process': {
        const { items, chunkSize, chunkOverlap, embeddingModel } = params;
        
        console.log(`[Pipeline] batch-process with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        if (!items || !Array.isArray(items) || items.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文档列表',
          }, { status: 400 });
        }
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = embeddingModel || EMBEDDING_MODEL;
        
        const pipeline = new DocumentPipeline({
          chunkSize: chunkSize || 500,
          chunkOverlap: chunkOverlap || 50,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const inputs = items.map((item: any) => ({
          input: item.content || item.url || item.text,
          type: item.type as DataSourceType,
          filename: item.filename || item.source,
        }));
        
        const results = await pipeline.processDocuments(inputs);
        
        const successCount = results.filter(r => r.success).length;
        const totalChunks = results.reduce((sum, r) => sum + r.chunks, 0);
        
        return NextResponse.json({
          success: true,
          processed: results.length,
          successful: successCount,
          failed: results.length - successCount,
          totalChunks,
          results,
          embeddingModel: modelToUse,
        });
      }
      
      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Pipeline API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// 处理文件上传
async function handleFileUpload(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const chunkSize = parseInt(formData.get('chunkSize') as string) || 500;
    const chunkOverlap = parseInt(formData.get('chunkOverlap') as string) || 50;
    const embeddingModel = formData.get('embeddingModel') as string;
    
    console.log(`[Pipeline] handleFileUpload with model: ${embeddingModel || EMBEDDING_MODEL}`);
    
    if (files.length === 0) {
      return NextResponse.json({
        success: false,
        error: '请上传文件',
      }, { status: 400 });
    }
    
    // 使用页面选择的模型，如果没有则使用环境变量默认值
    const modelToUse = (embeddingModel || EMBEDDING_MODEL).split(':')[0]; // 去除 :latest 后缀
    
    const pipeline = new DocumentPipeline({
      chunkSize,
      chunkOverlap,
      embeddingModel: modelToUse,
      ollamaBaseUrl: OLLAMA_BASE_URL,
      milvusConfig: getMilvusConfig(),
    });
    
    const results = [];
    
    for (const file of files) {
      const filename = file.name;
      const ext = filename.toLowerCase().split('.').pop();
      
      try {
        // 根据扩展名确定文件类型
        let type: DataSourceType = 'text';
        if (ext === 'pdf') type = 'pdf';
        else if (ext === 'docx' || ext === 'doc') type = 'docx';
        else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') type = 'xlsx';
        else if (ext === 'json') type = 'json';
        else if (ext === 'md' || ext === 'markdown') type = 'markdown';
        
        const buffer = Buffer.from(await file.arrayBuffer());
        
        const result = await pipeline.processDocument(buffer, {
          type,
          filename,
        });
        
        results.push({
          filename,
          ...result,
          success: true,
        });
      } catch (error) {
        results.push({
          filename,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const totalChunks = results.reduce((sum, r) => sum + (('chunks' in r && r.chunks) || 0), 0);
    
    return NextResponse.json({
      success: true,
      processed: results.length,
      successful: successCount,
      failed: results.length - successCount,
      totalChunks,
      results,
      embeddingModel: modelToUse,
    });
  } catch (error) {
    console.error('[Pipeline API] File upload error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'File upload failed',
    }, { status: 500 });
  }
}

// GET: 获取管道信息
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'info';
  
  try {
    switch (action) {
      case 'info': {
        return NextResponse.json({
          success: true,
          pipeline: {
            name: 'Document Processing Pipeline',
            version: '1.1.0',
            supportedFormats: [
              { type: 'text', extensions: ['.txt'], description: '纯文本文件' },
              { type: 'pdf', extensions: ['.pdf'], description: 'PDF 文档' },
              { type: 'docx', extensions: ['.docx', '.doc'], description: 'Word 文档' },
              { type: 'xlsx', extensions: ['.xlsx', '.xls', '.csv'], description: 'Excel 表格 / CSV' },
              { type: 'markdown', extensions: ['.md', '.markdown'], description: 'Markdown 文档' },
              { type: 'json', extensions: ['.json'], description: 'JSON 数据' },
              { type: 'url', extensions: [], description: '网页 URL' },
              { type: 'youtube', extensions: [], description: 'YouTube 视频' },
            ],
            config: {
              defaultChunkSize: 500,
              defaultChunkOverlap: 50,
              embeddingModel: EMBEDDING_MODEL,
              milvus: getMilvusConfig(),
            }
          }
        });
      }
      
      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Pipeline API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
