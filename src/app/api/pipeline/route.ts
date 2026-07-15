import { NextRequest, NextResponse } from 'next/server';
import { 
  DocumentPipeline, 
  loadDocument, 
  splitDocument, 
  DataSourceType 
} from '@/lib/document-pipeline';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';
import {
  REQUEST_LIMITS,
  RequestValidationError,
  publicErrorPayload,
  readJsonObjectWithLimit,
  validateBatchItems,
  validateChunking,
  validateEmbeddingModelSelection,
  validateExternalUrlInput,
  validatePipelineText,
  validateUploadedFiles,
} from '@/lib/security/request-validation';
import {
  RagSecurityError,
  resolveRagSecurityContext,
} from '@/lib/security/request-context';
import {
  createRetrievalScope,
  stampDocumentScope,
} from '@/lib/security/retrieval-scope';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import { toPublicMilvusConfig } from '@/lib/security/public-config';

export const runtime = 'nodejs';

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

function getPublicMilvusConfig() {
  const connConfig = getMilvusConnectionConfig();
  return toPublicMilvusConfig(
    connConfig as unknown as Record<string, unknown>,
    { provider: connConfig.provider }
  );
}

// POST: 处理文档
export async function POST(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  try {
    const contentType = request.headers.get('content-type') || '';
    
    // 处理 multipart/form-data (文件上传)
    if (contentType.includes('multipart/form-data')) {
      return handleFileUpload(request, requestId);
    }
    
    // 处理 JSON 请求
    const body = await readJsonObjectWithLimit(request, REQUEST_LIMITS.pipelineJsonBytes);
    const { action, ...params } = body;

    if (typeof action !== 'string') {
      return NextResponse.json({
        success: false,
        error: 'action must be a string',
        code: 'INVALID_ACTION',
        requestId,
      }, { status: 400 });
    }

    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'ingest',
      requestedCorpusId: typeof params.corpusId === 'string' ? params.corpusId : undefined,
      requestIdFactory: () => requestId,
    });
    const retrievalScope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });
    const scopeMetadata = stampDocumentScope(
      { createdBy: securityContext.actorId },
      retrievalScope,
      'external'
    );
    
    switch (action) {
      // 处理文本
      case 'process-text': {
        const { text: rawText, source, chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap, embeddingModel } = params;
        const text = validatePipelineText(rawText);
        const sourceName = validateSourceName(source, 'text-input');
        const { chunkSize, chunkOverlap } = validateChunking({ chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap });
        
        console.log(`[Pipeline] process-text with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = validateEmbeddingModelSelection(embeddingModel);
        
        const pipeline = new DocumentPipeline({
          chunkSize,
          chunkOverlap,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const result = await pipeline.processDocument(text, {
          filename: sourceName,
          metadata: scopeMetadata,
        });
        
        return NextResponse.json({
          success: true,
          ...result,
          embeddingModel: modelToUse,
        });
      }
      
      // 处理 URL
      case 'process-url': {
        const { url: rawUrl, chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap, embeddingModel } = params;
        const url = validateExternalUrlInput(rawUrl);
        const { chunkSize, chunkOverlap } = validateChunking({ chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap });
        
        console.log(`[Pipeline] process-url with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = validateEmbeddingModelSelection(embeddingModel);
        
        const pipeline = new DocumentPipeline({
          chunkSize,
          chunkOverlap,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const result = await pipeline.processDocument(url, { metadata: scopeMetadata });
        
        return NextResponse.json({
          success: true,
          ...result,
          embeddingModel: modelToUse,
        });
      }
      
      // 处理 YouTube
      case 'process-youtube': {
        const { videoUrl: rawVideoUrl, chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap, embeddingModel } = params;
        const videoUrl = validateExternalUrlInput(rawVideoUrl, 'videoUrl');
        const { chunkSize, chunkOverlap } = validateChunking({ chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap });
        
        console.log(`[Pipeline] process-youtube with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = validateEmbeddingModelSelection(embeddingModel);
        
        const pipeline = new DocumentPipeline({
          chunkSize,
          chunkOverlap,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const result = await pipeline.processDocument(videoUrl, {
          type: 'youtube',
          metadata: scopeMetadata,
        });
        
        return NextResponse.json({
          success: true,
          ...result,
          embeddingModel: modelToUse,
        });
      }
      
      // 预览分块（不存储）
      case 'preview-chunks': {
        const { text: rawText, source, chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap } = params;
        const text = validatePipelineText(rawText);
        const sourceName = validateSourceName(source, 'preview');
        const { chunkSize, chunkOverlap } = validateChunking({ chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap });
        
        const document = await loadDocument(text, { filename: sourceName });
        const chunks = await splitDocument(document, {
          chunkSize,
          chunkOverlap,
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
        const { items: rawItems, chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap, embeddingModel } = params;
        const items = validateBatchItems(rawItems);
        const { chunkSize, chunkOverlap } = validateChunking({ chunkSize: rawChunkSize, chunkOverlap: rawChunkOverlap });
        
        console.log(`[Pipeline] batch-process with model: ${embeddingModel || EMBEDDING_MODEL}`);
        
        // 使用页面选择的模型，如果没有则使用环境变量默认值
        const modelToUse = validateEmbeddingModelSelection(embeddingModel);
        
        const pipeline = new DocumentPipeline({
          chunkSize,
          chunkOverlap,
          embeddingModel: modelToUse,
          ollamaBaseUrl: OLLAMA_BASE_URL,
          milvusConfig: getMilvusConfig(),
        });
        
        const inputs = items.map((item) => {
          const input = [item.content, item.url, item.text].find(
            (value): value is string => typeof value === 'string' && value.trim().length > 0
          )!;
          return {
            input,
            type: validateDataSourceType(item.type),
            filename: typeof item.filename === 'string'
              ? validateSourceName(item.filename, 'document')
              : typeof item.source === 'string'
                ? validateSourceName(item.source, 'document')
                : undefined,
            metadata: scopeMetadata,
          };
        });
        
        const results = await pipeline.processDocuments(inputs);
        
        const successCount = results.filter(r => r.success).length;
        const totalChunks = results.reduce((sum, r) => sum + r.chunks, 0);
        
        return NextResponse.json({
          success: true,
          processed: results.length,
          successful: successCount,
          failed: results.length - successCount,
          totalChunks,
          results: results.map((result) => result.success
            ? result
            : { ...result, error: 'Document processing failed' }),
          embeddingModel: modelToUse,
        });
      }
      
      default:
        return NextResponse.json({
          success: false,
          error: 'Unknown action',
          code: 'UNKNOWN_ACTION',
          requestId,
        }, { status: 400 });
    }
  } catch (error) {
    console.error(`[Pipeline API] requestId=${requestId}`, redactErrorForLog(error));
    const mapped = mapPipelineError(error, 'PIPELINE_INTERNAL_ERROR', '文档处理失败', requestId);
    return NextResponse.json({
      success: false,
      error: mapped.body.error.message,
      code: mapped.body.error.code,
      requestId,
    }, { status: mapped.status });
  }
}

function validateSourceName(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new RequestValidationError('INVALID_SOURCE_NAME', 'Invalid document source name.', 400);
  }
  return value.trim();
}

function validateDataSourceType(value: unknown): DataSourceType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const supported: DataSourceType[] = [
    'text', 'pdf', 'docx', 'xlsx', 'csv', 'json', 'markdown', 'url', 'youtube', 'raw',
  ];
  if (typeof value !== 'string' || !supported.includes(value as DataSourceType)) {
    throw new RequestValidationError('UNSUPPORTED_SOURCE_TYPE', 'Unsupported document source type.', 400);
  }
  return value as DataSourceType;
}

function mapPipelineError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  requestId: string
) {
  if (error instanceof RagSecurityError) {
    return {
      status: error.status,
      body: {
        error: { code: error.code, message: error.message },
        requestId: error.requestId,
      },
    };
  }
  return publicErrorPayload(error, fallbackCode, fallbackMessage, requestId);
}

// 处理文件上传
async function handleFileUpload(request: NextRequest, requestId: string) {
  try {
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'ingest',
      requestedCorpusId: request.headers.get('x-rag-corpus-id') || undefined,
      requestIdFactory: () => requestId,
    });
    const scopeMetadata = stampDocumentScope(
      { createdBy: securityContext.actorId },
      createRetrievalScope({
        tenantId: securityContext.tenantId,
        corpusId: securityContext.corpusId,
        enforceIsolation: securityContext.enforceIsolation,
      }),
      'external'
    );
    const declaredHeader = request.headers.get('content-length');
    if (
      securityContext.enforceIsolation
      && (!declaredHeader || !/^\d+$/.test(declaredHeader))
    ) {
      throw new RequestValidationError(
        'CONTENT_LENGTH_REQUIRED',
        'A valid Content-Length header is required for multipart uploads.',
        411
      );
    }
    const declaredLength = Number(declaredHeader || 0);
    if (declaredLength > REQUEST_LIMITS.totalFileBytes + 1024 * 1024) {
      throw new RequestValidationError('FILES_TOO_LARGE', 'Multipart request is too large.', 413);
    }
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    validateUploadedFiles(files);
    const chunkSizeValue = formData.get('chunkSize');
    const chunkOverlapValue = formData.get('chunkOverlap');
    const { chunkSize, chunkOverlap } = validateChunking({
      chunkSize: typeof chunkSizeValue === 'string' && chunkSizeValue ? Number(chunkSizeValue) : undefined,
      chunkOverlap: typeof chunkOverlapValue === 'string' && chunkOverlapValue ? Number(chunkOverlapValue) : undefined,
    });
    const embeddingModel = formData.get('embeddingModel');
    
    console.log(`[Pipeline] handleFileUpload with model: ${embeddingModel || EMBEDDING_MODEL}`);
    
    // 使用页面选择的模型，如果没有则使用环境变量默认值
    const modelToUse = validateEmbeddingModelSelection(
      typeof embeddingModel === 'string' && embeddingModel ? embeddingModel.split(':')[0] : undefined
    );
    
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
        const supportedExtensions = new Set([
          'txt', 'pdf', 'docx', 'xlsx', 'xls', 'csv', 'json', 'md', 'markdown',
        ]);
        if (!ext || !supportedExtensions.has(ext)) {
          throw new RequestValidationError(
            'UNSUPPORTED_FILE_TYPE',
            'Unsupported file type.',
            400
          );
        }
        // 根据扩展名确定文件类型
        let type: DataSourceType = 'text';
        if (ext === 'pdf') type = 'pdf';
        else if (ext === 'docx') type = 'docx';
        else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') type = 'xlsx';
        else if (ext === 'json') type = 'json';
        else if (ext === 'md' || ext === 'markdown') type = 'markdown';
        
        const buffer = Buffer.from(await file.arrayBuffer());
        
        const result = await pipeline.processDocument(buffer, {
          type,
          filename,
          metadata: scopeMetadata,
        });
        
        results.push({
          filename,
          ...result,
          success: true,
        });
      } catch {
        results.push({
          filename,
          success: false,
          error: 'File processing failed',
          code: 'FILE_PROCESSING_FAILED',
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
    console.error(`[Pipeline API] file requestId=${requestId}`, redactErrorForLog(error));
    const mapped = mapPipelineError(error, 'FILE_UPLOAD_FAILED', '文件上传处理失败', requestId);
    return NextResponse.json({
      success: false,
      error: mapped.body.error.message,
      code: mapped.body.error.code,
      requestId,
    }, { status: mapped.status });
  }
}

// GET: 获取管道信息
export async function GET(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'info';
  
  try {
    await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: searchParams.get('corpusId') || undefined,
      requestIdFactory: () => requestId,
    });
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
              milvus: getPublicMilvusConfig(),
            }
          }
        });
      }
      
      default:
        return NextResponse.json({
          success: false,
          error: 'Unknown action',
          code: 'UNKNOWN_ACTION',
          requestId,
        }, { status: 400 });
    }
  } catch (error) {
    console.error(`[Pipeline API] info requestId=${requestId}`, redactErrorForLog(error));
    const mapped = mapPipelineError(error, 'PIPELINE_INFO_FAILED', '无法读取管道信息', requestId);
    return NextResponse.json({
      success: false,
      error: mapped.body.error.message,
      code: mapped.body.error.code,
      requestId,
    }, { status: mapped.status });
  }
}

function resolvePublicRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}
