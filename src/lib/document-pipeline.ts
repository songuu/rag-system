/**
 * 文档处理管道 (Document Pipeline)
 * 
 * 流程: 数据源 → Loader → TextSplitter → 嵌入模型 → 向量数据库
 * 
 * 支持的数据源:
 * - 文本文件 (.txt)
 * - PDF 文件 (.pdf)
 * - Word 文件 (.docx)
 * - URL 网页
 * - YouTube 视频字幕
 * - 纯文本内容
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { createHash } from 'node:crypto';
import {
  createMilvusHybridRuntimeManifest,
  type MilvusDocument,
  getMilvusInstance,
} from './milvus-client';
import { getMilvusConnectionConfig } from './milvus-config';
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import { createEmbedding, getConfigSummary } from './model-config';
import { getEmbeddingConfigSummary } from './embedding-config';
import {
  CONTEXTUAL_RETRIEVAL_V2_VERSION,
  contextualizeChunksV2,
  resolveContextualRetrievalV2Mode,
  type ContextualRetrievalV2Mode,
  type ContextualizerV2Port,
} from './rag/retrieval/contextual-retrieval-v2';
import {
  LANGCHAIN_CONTEXTUALIZER_V2_PROMPT_VERSION,
  createLangChainContextualizerV2,
} from './rag/retrieval/langchain-contextualizer-v2';
import { parsePdfBuffer, type PdfParseOutput } from './pdf-parser';
import { createCanonicalPdfDocumentText } from './rag/multimodal/pdf-asset-manifest';
import { safeFetchExternalUrl } from './security/safe-external-url';
import {
  createRetrievalScope,
  isTenantIsolationRequired,
  type RagRetrievalScope,
  type RagTrustLevel,
} from './security/retrieval-scope';
import {
  resolvePdfMultimodalMode,
  type PdfMultimodalMode,
} from './rag/multimodal/pdf-modality-router';
import { assertSafeZipArchive } from './security/zip-safety';
import { resolveMilvusHybridRolloutMode } from './rag/retrieval/hybrid-policy';

// ============== 类型定义 ==============

// 支持的数据源类型
export type DataSourceType = 'text' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'json' | 'markdown' | 'url' | 'youtube' | 'raw';

// 文档元数据
export interface DocumentMetadata {
  source: string;
  type: DataSourceType;
  title?: string;
  author?: string;
  createdAt?: string;
  url?: string;
  chunkIndex?: number;
  documentId?: string;
  documentVersion?: string;
  sourceHash?: string;
  startOffset?: number;
  endOffset?: number;
  totalChunks?: number;
  pageNumber?: number;
  originalContent?: string;
  contextualPreamble?: string;
  [key: string]: unknown;
}

// 加载的文档
export interface LoadedDocument {
  content: string;
  metadata: DocumentMetadata;
  /** Internal-only PDF bytes used for content-addressed sidecar publication. */
  pdfAssetSource?: Uint8Array;
  /** Internal-only page-wise parse output; never copied into metadata/API responses. */
  pdfParsed?: PdfParseOutput;
}

// 文档块
export interface DocumentChunk {
  id: string;
  content: string;
  /** Text used only for embedding; persisted evidence remains content. */
  embeddingContent?: string;
  metadata: DocumentMetadata;
}

// 处理后的文档（带向量）
export interface ProcessedDocument extends DocumentChunk {
  embedding: number[];
}

export interface MilvusHybridIngestAuditIdentity {
  version: 'milvus-hybrid-ingest-compensation/v1';
  reconciliationId: string;
  tenantId: string;
  corpusId: string;
  denseCollectionName: string;
  hybridCollectionName: string;
  chunkCount: number;
}

export class MilvusHybridIngestOperationalError extends Error {
  readonly code:
    | 'MILVUS_HYBRID_ACTIVE_WRITE_FAILED_ROLLED_BACK'
    | 'MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED';
  readonly status: 502 | 503;
  readonly auditIdentity: MilvusHybridIngestAuditIdentity;
  readonly compensationStatus: 'rolled_back' | 'reconciliation_required';

  constructor(input: {
    code: MilvusHybridIngestOperationalError['code'];
    status: MilvusHybridIngestOperationalError['status'];
    auditIdentity: MilvusHybridIngestAuditIdentity;
    compensationStatus: MilvusHybridIngestOperationalError['compensationStatus'];
    message: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'MilvusHybridIngestOperationalError';
    this.code = input.code;
    this.status = input.status;
    this.auditIdentity = input.auditIdentity;
    this.compensationStatus = input.compensationStatus;
  }
}

export class MilvusHybridActiveWriteRolledBackError
  extends MilvusHybridIngestOperationalError {
  constructor(auditIdentity: MilvusHybridIngestAuditIdentity, cause: unknown) {
    super({
      code: 'MILVUS_HYBRID_ACTIVE_WRITE_FAILED_ROLLED_BACK',
      status: 502,
      auditIdentity,
      compensationStatus: 'rolled_back',
      message:
        'Active Milvus hybrid write failed; exact dense and hybrid compensation completed. '
        + formatMilvusHybridAuditIdentity(auditIdentity),
      cause,
    });
    this.name = 'MilvusHybridActiveWriteRolledBackError';
  }
}

export class MilvusHybridIngestReconciliationRequiredError
  extends MilvusHybridIngestOperationalError {
  readonly failedCompensations: Array<'dense' | 'hybrid'>;

  constructor(input: {
    auditIdentity: MilvusHybridIngestAuditIdentity;
    failedCompensations: Array<'dense' | 'hybrid'>;
    cause: unknown;
  }) {
    const failedCompensations = [...new Set(input.failedCompensations)].sort() as Array<
      'dense' | 'hybrid'
    >;
    super({
      code: 'MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED',
      status: 503,
      auditIdentity: input.auditIdentity,
      compensationStatus: 'reconciliation_required',
      message:
        'Milvus hybrid ingest requires reconciliation after compensation failure. '
        + formatMilvusHybridAuditIdentity(input.auditIdentity)
        + ' failedCompensations=' + failedCompensations.join(','),
      cause: input.cause,
    });
    this.name = 'MilvusHybridIngestReconciliationRequiredError';
    this.failedCompensations = failedCompensations;
  }
}

// 管道配置
export interface PipelineConfig {
  // 文本分割配置
  chunkSize?: number;
  chunkOverlap?: number;

  // 嵌入模型配置
  embeddingModel?: string;
  ollamaBaseUrl?: string;

  // Contextual Retrieval 配置
  contextualRetrieval?: boolean;
  /** Server-owned rollout mode. Legacy true can only request shadow. */
  contextualRetrievalMode?: ContextualRetrievalV2Mode;
  contextualRetrievalModel?: string;
  /** Internal test/runtime injection; never populated from request input. */
  contextualizerV2?: ContextualizerV2Port;

  /** Server-owned PDF visual sidecar rollout. */
  pdfVisualMode?: PdfMultimodalMode;

  // 存储配置
  storageBackend?: 'memory' | 'milvus';
  milvusConfig?: {
    address?: string;
    collectionName?: string;
  };
}

// 处理进度回调
export interface ProcessingProgress {
  stage: 'loading' | 'splitting' | 'contextualizing' | 'embedding' | 'storing';
  current: number;
  total: number;
  message: string;
}

export interface PipelinePdfVisualSummary {
  mode: PdfMultimodalMode;
  status: 'not_applicable' | 'disabled' | 'published' | 'fallback';
  version?: string;
  manifestVersion?: string;
  documentId?: string;
  documentVersion?: string;
  pageCount: number;
  visualPageCount: number;
  fallbackReason?: 'visual_sidecar_unavailable';
}

// 默认配置
const DEFAULT_CONFIG: Required<PipelineConfig> = {
  chunkSize: 500,
  chunkOverlap: 50,
  embeddingModel: 'nomic-embed-text',
  ollamaBaseUrl: 'http://localhost:11434',
  contextualRetrieval: false,
  contextualRetrievalMode: 'off',
  contextualRetrievalModel: '',
  contextualizerV2: undefined as unknown as ContextualizerV2Port,
  pdfVisualMode: 'off',
  storageBackend: 'milvus',
  milvusConfig: {
    address: 'localhost:19530',
    collectionName: 'rag_documents',
  }
};

export const PIPELINE_WORK_LIMITS = {
  maxChunksPerDocument: 1_000,
  maxChunksPerBatch: 2_000,
  embeddingBatchSize: 32,
} as const;

// ============== 文档加载器 ==============

/**
 * 文本文件加载器
 */
export async function loadTextFile(content: string, filename: string): Promise<LoadedDocument> {
  return {
    content: content.trim(),
    metadata: {
      source: filename,
      type: 'text',
      title: filename,
      createdAt: new Date().toISOString(),
    }
  };
}

/**
 * PDF 文件加载器
 */
export async function loadPdfFile(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  console.log(`[Pipeline PDF] 开始加载: ${filename}, 大小: ${buffer.length} bytes`);
  
  try {
    const pdf = await parsePdfBuffer(buffer, filename, { includeMetadata: true });
    const canonicalText = createCanonicalPdfDocumentText(pdf);
    console.log(`[Pipeline PDF] 文本提取成功, 长度: ${canonicalText.length}, 页数: ${pdf.pages}, 方法: ${pdf.parseMethod}`);
    
    return {
      content: canonicalText,
      metadata: {
        source: filename,
        type: 'pdf',
        title: pdf.title || filename,
        author: pdf.author,
        createdAt: pdf.createdAt || new Date().toISOString(),
        pageCount: pdf.pages,
        parseMethod: pdf.parseMethod,
      },
      pdfAssetSource: new Uint8Array(buffer),
      pdfParsed: pdf,
    };
  } catch (error) {
    console.error(`[Pipeline PDF] 解析失败:`, error);
    throw new Error(`PDF 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Word 文件加载器 (DOCX)
 */
export async function loadDocxFile(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  assertSafeZipArchive(buffer);
  try {
    // 动态导入 mammoth
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    
    return {
      content: result.value.trim(),
      metadata: {
        source: filename,
        type: 'docx',
        title: filename,
        createdAt: new Date().toISOString(),
      }
    };
  } catch (error) {
    throw new Error('DOCX parsing failed.', { cause: error });
  }
}

/**
 * Excel 文件加载器 (xlsx, xls, csv)
 */
export async function loadExcelFile(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  try {
    if (/\.(?:xlsx|xlsm|xltx)$/i.test(filename)) {
      assertSafeZipArchive(buffer);
    }
    const workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: 10_000 });
    const sheets: string[] = workbook.SheetNames;
    if (sheets.length > 50) {
      throw new Error('Spreadsheet contains too many sheets.');
    }
    
    // 将所有工作表内容合并
    const contents: string[] = [];
    let totalCells = 0;
    let totalCharacters = 0;
    
    for (const sheetName of sheets) {
      const worksheet = workbook.Sheets[sheetName];
      
      // 转换为 JSON 格式
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
      
      if (jsonData.length > 0) {
        contents.push(`## 工作表: ${sheetName}\n`);
        
        // 获取表头
        const headers = jsonData[0] as string[];
        
        // 构建表格内容
        for (let i = 0; i < jsonData.length; i++) {
          const row = jsonData[i] as unknown[];
          if (row.length === 0) continue;
          totalCells += row.length;
          if (totalCells > 250_000) {
            throw new Error('Spreadsheet contains too many cells.');
          }
          
          if (i === 0) {
            // 表头行
            contents.push(`| ${row.join(' | ')} |`);
            contents.push(`| ${row.map(() => '---').join(' | ')} |`);
          } else {
            // 数据行 - 确保每个单元格都有值
            const cells = headers.map((_, idx) => {
              const cell = row[idx];
              return cell !== undefined && cell !== null ? String(cell) : '';
            });
            contents.push(`| ${cells.join(' | ')} |`);
          }
          totalCharacters += contents[contents.length - 1]?.length ?? 0;
          if (totalCharacters > 2_000_000) {
            throw new Error('Spreadsheet extracted text is too large.');
          }
        }
        contents.push('\n');
      }
    }
    
    return {
      content: contents.join('\n'),
      metadata: {
        source: filename,
        type: 'xlsx',
        title: filename,
        sheets,
        createdAt: new Date().toISOString(),
      }
    };
  } catch (error) {
    throw new Error(`Excel 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * JSON 文件加载器
 */
export async function loadJsonFile(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  try {
    const content = buffer.toString('utf-8');
    // 验证 JSON 格式
    const parsed = JSON.parse(content);
    // 格式化输出
    const formattedContent = JSON.stringify(parsed, null, 2);
    
    return {
      content: formattedContent,
      metadata: {
        source: filename,
        type: 'json',
        title: filename,
        createdAt: new Date().toISOString(),
      }
    };
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Markdown 文件加载器
 */
export async function loadMarkdownFile(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  try {
    const content = buffer.toString('utf-8');
    
    // 提取标题（如果有）
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : filename;
    
    return {
      content: content.trim(),
      metadata: {
        source: filename,
        type: 'markdown',
        title,
        createdAt: new Date().toISOString(),
      }
    };
  } catch (error) {
    throw new Error(`Markdown 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * URL 网页加载器
 */
export async function loadUrl(url: string): Promise<LoadedDocument> {
  try {
    const response = await safeFetchExternalUrl(url, {
      allowHttp: process.env.RAG_EXTERNAL_URL_ALLOW_HTTP === 'true',
      allowedContentTypes: ['text/html', 'text/plain', 'application/xhtml+xml'],
      maxResponseBytes: 5 * 1024 * 1024,
      timeoutMs: 10_000,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP 错误: ${response.statusCode}`);
    }

    const html = new TextDecoder('utf-8').decode(response.body);
    
    // 使用 cheerio 解析 HTML
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    
    // 移除脚本、样式等无关内容
    $('script, style, nav, footer, header, aside, .sidebar, .advertisement').remove();
    
    // 获取标题
    const title = $('title').text() || $('h1').first().text() || new URL(response.finalUrl).hostname;
    
    // 提取主要内容
    let content = '';
    
    // 尝试获取文章主体
    const articleSelectors = ['article', 'main', '.content', '.post', '.article', '#content'];
    for (const selector of articleSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        content = element.text();
        break;
      }
    }
    
    // 如果没找到，获取 body 内容
    if (!content) {
      content = $('body').text();
    }
    
    // 清理空白
    content = content.replace(/\s+/g, ' ').trim();
    
    return {
      content,
      metadata: {
        source: response.finalUrl,
        type: 'url',
        title: title.trim(),
        url: response.finalUrl,
        trustLevel: 'external',
        trust_level: 'external',
        createdAt: new Date().toISOString(),
      }
    };
  } catch (error) {
    throw new Error(`URL 加载失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * YouTube 视频字幕加载器
 */
export async function loadYouTube(videoUrl: string): Promise<LoadedDocument> {
  try {
    // 提取视频 ID
    const videoId = extractYouTubeId(videoUrl);
    if (!videoId) {
      throw new Error('无效的 YouTube URL');
    }
    
    // 尝试获取字幕
    const transcript = await fetchYouTubeTranscript(videoId);
    
    return {
      content: transcript.text,
      metadata: {
        source: videoUrl,
        type: 'youtube',
        title: transcript.title || `YouTube Video: ${videoId}`,
        url: videoUrl,
        videoId,
        createdAt: new Date().toISOString(),
      }
    };
  } catch (error) {
    throw new Error(`YouTube 加载失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 提取 YouTube 视频 ID
 */
export function extractYouTubeId(value: string): string | null {
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    let videoId: string | null = null;
    if (hostname === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname)) {
      if (url.pathname === '/watch') {
        videoId = url.searchParams.get('v');
      } else {
        const match = url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
        videoId = match?.[1] ?? null;
      }
    }
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
}

/**
 * 获取 YouTube 字幕
 */
async function fetchYouTubeTranscript(videoId: string): Promise<{ text: string; title?: string }> {
  try {
    // 获取视频页面
    const response = await safeFetchExternalUrl(`https://www.youtube.com/watch?v=${videoId}`, {
      isHostnameAllowed: isYouTubeFetchHostname,
      allowedContentTypes: ['text/html'],
      maxResponseBytes: 2 * 1024 * 1024,
      timeoutMs: 10_000,
    });
    const html = new TextDecoder('utf-8').decode(response.body);
    
    // 提取标题
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : undefined;
    
    // 尝试提取字幕 URL
    const captionMatch = html.match(/"captions":.*?"captionTracks":\[(.*?)\]/);
    
    if (captionMatch) {
      const captionData = captionMatch[1];
      const urlMatch = captionData.match(/"baseUrl":"([^"]+)"/);
      
      if (urlMatch) {
        const captionUrl = urlMatch[1].replace(/\\u0026/g, '&');
        const captionResponse = await safeFetchExternalUrl(captionUrl, {
          isHostnameAllowed: isYouTubeFetchHostname,
          allowedContentTypes: ['text/xml', 'application/xml', 'text/plain'],
          maxResponseBytes: 2 * 1024 * 1024,
          timeoutMs: 10_000,
        });
        const captionXml = new TextDecoder('utf-8').decode(captionResponse.body);
        
        // 解析字幕 XML
        const textMatches = captionXml.matchAll(/<text[^>]*>([^<]*)<\/text>/g);
        const texts: string[] = [];
        
        for (const match of textMatches) {
          const text = match[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .trim();
          if (text) texts.push(text);
        }
        
        return { text: texts.join(' '), title };
      }
    }
    
    // 如果没有字幕，返回视频描述
    const descMatch = html.match(/"shortDescription":"([^"]+)"/);
    if (descMatch) {
      return { 
        text: descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
        title 
      };
    }
    
    throw new Error('无法获取视频字幕或描述');
  } catch (error) {
    throw new Error(`字幕获取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isYouTubeFetchHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'youtube.com'
    || normalized.endsWith('.youtube.com')
    || normalized === 'youtu.be'
    || normalized === 'googlevideo.com'
    || normalized.endsWith('.googlevideo.com');
}

/**
 * 纯文本加载器
 */
export async function loadRawText(content: string, source: string = 'raw-input'): Promise<LoadedDocument> {
  return {
    content: content.trim(),
    metadata: {
      source,
      type: 'raw',
      createdAt: new Date().toISOString(),
    }
  };
}

// ============== 统一加载器 ==============

/**
 * 自动检测并加载文档
 */
export async function loadDocument(
  input: string | Buffer,
  options: {
    type?: DataSourceType;
    filename?: string;
  } = {}
): Promise<LoadedDocument> {
  const { type, filename } = options;
  
  // 如果是 Buffer，根据文件名推断类型
  if (Buffer.isBuffer(input)) {
    const ext = filename?.toLowerCase().split('.').pop();
    
    // PDF
    if (ext === 'pdf' || type === 'pdf') {
      return loadPdfFile(input, filename || 'document.pdf');
    }
    
    // Word
    if (ext === 'docx' || ext === 'doc' || type === 'docx') {
      return loadDocxFile(input, filename || 'document.docx');
    }
    
    // Excel / CSV
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || type === 'xlsx' || type === 'csv') {
      return loadExcelFile(input, filename || 'document.xlsx');
    }
    
    // JSON
    if (ext === 'json' || type === 'json') {
      return loadJsonFile(input, filename || 'document.json');
    }
    
    // Markdown
    if (ext === 'md' || ext === 'markdown' || type === 'markdown') {
      return loadMarkdownFile(input, filename || 'document.md');
    }
    
    // 默认作为文本处理
    return loadTextFile(input.toString('utf-8'), filename || 'document.txt');
  }
  
  // 字符串输入
  const content = input as string;
  
  // URL 检测
  if (content.startsWith('http://') || content.startsWith('https://')) {
    // YouTube
    if (content.includes('youtube.com') || content.includes('youtu.be')) {
      return loadYouTube(content);
    }
    // 普通 URL
    return loadUrl(content);
  }
  
  // 纯文本
  return loadRawText(content, filename || 'raw-input');
}

// ============== 文本分割器 ==============

/**
 * 智能文本分割器
 */
export async function splitDocument(
  document: LoadedDocument,
  config: { chunkSize?: number; chunkOverlap?: number; maxChunks?: number } = {}
): Promise<DocumentChunk[]> {
  const { chunkSize = 500, chunkOverlap = 50 } = config;
  if (
    !Number.isInteger(chunkSize)
    || chunkSize < 100
    || chunkSize > 4_000
    || !Number.isInteger(chunkOverlap)
    || chunkOverlap < 0
    || chunkOverlap > Math.floor(chunkSize / 2)
  ) {
    throw new Error('Chunking configuration is outside the safe processing bounds.');
  }
  const maxChunks = config.maxChunks ?? PIPELINE_WORK_LIMITS.maxChunksPerDocument;
  if (
    !Number.isInteger(maxChunks)
    || maxChunks < 1
    || maxChunks > PIPELINE_WORK_LIMITS.maxChunksPerDocument
  ) {
    throw new Error('Document chunk budget is outside the safe processing bounds.');
  }
  
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', '；', ';', ' ', ''],
  });
  
  const chunks = await splitter.splitText(document.content);
  if (chunks.length > maxChunks) {
    throw new Error(
      `Document expands to ${chunks.length} chunks, exceeding the limit of ${maxChunks}.`
    );
  }
  
  let searchCursor = 0;
  return chunks.map((content, index) => {
    const startOffset = document.content.indexOf(
      content,
      searchCursor
    );
    if (startOffset < 0) {
      throw new Error('Document chunk cannot be aligned to its source content.');
    }
    const endOffset = startOffset + content.length;
    searchCursor = Math.max(startOffset + 1, endOffset - chunkOverlap);
    return {
      id: `${document.metadata.source}-chunk-${index}-${uuidv4().slice(0, 8)}`,
      content,
      metadata: {
        ...document.metadata,
        chunkIndex: index,
        totalChunks: chunks.length,
        startOffset,
        endOffset,
      },
    };
  });
}

// ============== 嵌入生成器 ==============

/**
 * 生成文档嵌入向量
 */
export async function generateEmbeddings(
  chunks: DocumentChunk[],
  config: { embeddingModel?: string; ollamaBaseUrl?: string } = {},
  onProgress?: (progress: ProcessingProgress) => void
): Promise<ProcessedDocument[]> {
  // 使用独立的 Embedding 配置系统
  const embeddingConfig = getEmbeddingConfigSummary();
  
  const { 
    embeddingModel = embeddingConfig.model, 
  } = config;
  
  // 使用统一配置系统创建 Embedding 模型 (会根据 EMBEDDING_PROVIDER 自动选择)
  const embeddings = createEmbedding(embeddingModel);
  
  const results: ProcessedDocument[] = [];
  if (chunks.length > PIPELINE_WORK_LIMITS.maxChunksPerDocument) {
    throw new Error('Embedding request exceeds the document chunk budget.');
  }

  for (
    let offset = 0;
    offset < chunks.length;
    offset += PIPELINE_WORK_LIMITS.embeddingBatchSize
  ) {
    const batch = chunks.slice(offset, offset + PIPELINE_WORK_LIMITS.embeddingBatchSize);
    const vectors = await embeddings.embedDocuments(
      batch.map(chunk => chunk.embeddingContent ?? chunk.content)
    );
    if (vectors.length !== batch.length) {
      throw new Error('Embedding provider returned an unexpected vector count.');
    }
    for (let index = 0; index < batch.length; index += 1) {
      results.push({
        ...batch[index],
        embedding: vectors[index],
      });
    }
    const current = offset + batch.length;
    onProgress?.({
      stage: 'embedding',
      current,
      total: chunks.length,
      message: `正在生成向量 (${current}/${chunks.length})...`
    });
  }
  
  return results;
}

// ============== 向量存储 ==============

/**
 * 存储到 Milvus
 */
export async function storeToMilvus(
  documents: ProcessedDocument[],
  config: {
    address?: string;
    collectionName?: string;
    token?: string;
    ssl?: boolean;
    embeddingModel?: string;
  } = {},
  onProgress?: (progress: ProcessingProgress) => void
): Promise<string[]> {
  onProgress?.({
    stage: 'storing',
    current: 0,
    total: documents.length,
    message: '正在连接 Milvus...'
  });
  
  // 使用统一配置系统获取默认值
  const connConfig = getMilvusConnectionConfig();
  
  // 从实际的嵌入向量中获取维度
  const embeddingDimension = documents[0]?.embedding?.length;
  if (!embeddingDimension) {
    throw new Error('Documents have no valid embedding vectors');
  }
  console.log(`[Pipeline] Using embedding dimension: ${embeddingDimension}D`);
  
  const milvus = getMilvusInstance({
    address: config.address || connConfig.address,
    collectionName: config.collectionName || connConfig.defaultCollection,
    token: config.token || connConfig.token,
    ssl: config.ssl !== undefined ? config.ssl : connConfig.ssl,
    embeddingDimension: embeddingDimension, // 传递实际的嵌入维度
  });
  
  await milvus.connect();
  // 使用 autoRecreate=true 以便在维度不匹配时自动重建集合
  await milvus.initializeCollection(!isTenantIsolationRequired());
  
  onProgress?.({
    stage: 'storing',
    current: 0,
    total: documents.length,
    message: '正在存储文档...'
  });
  
  // 验证所有文档都有有效的 embedding
  console.log(`[Pipeline] Preparing ${documents.length} documents for Milvus insertion`);
  
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (!doc.embedding || !Array.isArray(doc.embedding) || doc.embedding.length === 0) {
      console.error(`[Pipeline] Document ${i} (id: ${doc.id}) has invalid embedding:`, {
        hasEmbedding: !!doc.embedding,
        isArray: Array.isArray(doc.embedding),
        length: doc.embedding?.length
      });
      throw new Error(`Document ${i} (id: ${doc.id}) has invalid embedding`);
    }
  }
  
  const firstDimension = documents[0].embedding.length;
  console.log(`[Pipeline] All documents validated. First embedding dimension: ${firstDimension}D`);
  
  const milvusDocs: MilvusDocument[] = documents.map((doc, index) => {
    if (doc.embedding.length !== firstDimension) {
      throw new Error(`Document ${index} has mismatched dimension: expected ${firstDimension}, got ${doc.embedding.length}`);
    }
    return {
      id: doc.id,
      content: doc.content,
      embedding: doc.embedding,
      metadata: doc.metadata,
    };
  });
  
  const hybridMode = resolveMilvusHybridRolloutMode();
  const denseCollectionName = config.collectionName || connConfig.defaultCollection;
  const activeManifest = hybridMode === 'active'
    ? createMilvusHybridRuntimeManifest({
      sourceCollectionName: denseCollectionName,
      embeddingModel: config.embeddingModel || getEmbeddingConfigSummary().model,
      embeddingDimension: firstDimension,
    })
    : undefined;
  const activeCompensation = activeManifest
    ? createMilvusHybridIngestCompensationContext(
      milvusDocs,
      denseCollectionName,
      activeManifest.collectionName
    )
    : undefined;

  console.log(`[Pipeline] Calling milvus.insertDocuments with ${milvusDocs.length} documents`);
  const ids = await milvus.insertDocuments(milvusDocs);
  if (hybridMode === 'shadow') {
    try {
      const manifest = createMilvusHybridRuntimeManifest({
        sourceCollectionName: denseCollectionName,
        embeddingModel: config.embeddingModel || getEmbeddingConfigSummary().model,
        embeddingDimension: firstDimension,
      });
      await milvus.insertHybridDocuments(manifest, milvusDocs);
    } catch (error) {
      console.warn(
        '[Pipeline] Hybrid shadow write failed; dense ingestion remains authoritative:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  if (hybridMode === 'active') {
    if (!activeManifest || !activeCompensation) {
      throw new Error('Active Milvus hybrid ingest compensation was not prepared.');
    }
    try {
      await milvus.insertHybridDocuments(activeManifest, milvusDocs);
    } catch (error) {
      const failedCompensations: Array<'dense' | 'hybrid'> = [];
      try {
        await milvus.deleteScopedHybridDocuments(
          activeManifest,
          activeCompensation.ids,
          activeCompensation.scope
        );
      } catch {
        failedCompensations.push('hybrid');
      }
      try {
        await milvus.deleteScopedDocuments(
          activeCompensation.ids,
          activeCompensation.scope
        );
      } catch {
        failedCompensations.push('dense');
      }
      if (failedCompensations.length > 0) {
        throw new MilvusHybridIngestReconciliationRequiredError({
          auditIdentity: activeCompensation.auditIdentity,
          failedCompensations,
          cause: error,
        });
      }
      throw new MilvusHybridActiveWriteRolledBackError(
        activeCompensation.auditIdentity,
        error
      );
    }
  }

  
  onProgress?.({
    stage: 'storing',
    current: documents.length,
    total: documents.length,
    message: `成功存储 ${ids.length} 个文档块`
  });
  
  return ids;
}

function createMilvusHybridIngestCompensationContext(
  documents: MilvusDocument[],
  denseCollectionName: string,
  hybridCollectionName: string
): {
  ids: string[];
  scope: RagRetrievalScope;
  auditIdentity: MilvusHybridIngestAuditIdentity;
} {
  const ids = documents.map((document, index) => {
    if (
      typeof document.id !== 'string'
      || !document.id.trim()
      || document.id.length > 256
      || /[\u0000-\u001f]/.test(document.id)
    ) {
      throw new Error('Active Milvus hybrid ingest received an invalid chunk ID at index ' + index + '.');
    }
    return document.id.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error('Active Milvus hybrid ingest requires unique chunk IDs.');
  }

  const tenantIds = new Set<string>();
  const corpusIds = new Set<string>();
  const trustLevels = new Set<RagTrustLevel>();
  for (const document of documents) {
    tenantIds.add(readMilvusCompensationScopeValue(
      document.metadata,
      ['tenantId', 'tenant_id'],
      'tenantId'
    ));
    corpusIds.add(readMilvusCompensationScopeValue(
      document.metadata,
      ['corpusId', 'corpus_id'],
      'corpusId'
    ));
    const trustLevel = readMilvusCompensationScopeValue(
      document.metadata,
      ['trustLevel', 'trust_level'],
      'trustLevel'
    );
    if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(trustLevel)) {
      throw new Error('Active Milvus hybrid ingest received an invalid trust level.');
    }
    trustLevels.add(trustLevel as RagTrustLevel);
  }
  if (tenantIds.size !== 1 || corpusIds.size !== 1) {
    throw new Error('Active Milvus hybrid ingest cannot span tenant or corpus boundaries.');
  }
  const tenantId = [...tenantIds][0];
  const corpusId = [...corpusIds][0];
  const scope = createRetrievalScope({
    tenantId,
    corpusId,
    allowedTrustLevels: [...trustLevels],
    enforceIsolation: true,
  });
  const version = 'milvus-hybrid-ingest-compensation/v1' as const;
  const reconciliationId = createHash('sha256')
    .update(JSON.stringify({
      version,
      tenantId,
      corpusId,
      denseCollectionName,
      hybridCollectionName,
      trustLevels: [...trustLevels].sort(),
      ids: [...ids].sort(),
    }))
    .digest('hex');
  return {
    ids,
    scope,
    auditIdentity: {
      version,
      reconciliationId,
      tenantId,
      corpusId,
      denseCollectionName,
      hybridCollectionName,
      chunkCount: ids.length,
    },
  };
}

function readMilvusCompensationScopeValue(
  metadata: Record<string, unknown>,
  aliases: string[],
  field: string
): string {
  const values = aliases
    .map(alias => metadata[alias])
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(value => value.trim());
  if (values.length === 0 || new Set(values).size !== 1) {
    throw new Error('Active Milvus hybrid ingest requires one authoritative ' + field + '.');
  }
  return values[0];
}

function formatMilvusHybridAuditIdentity(
  identity: MilvusHybridIngestAuditIdentity
): string {
  return [
    'reconciliationId=' + identity.reconciliationId,
    'tenantId=' + identity.tenantId,
    'corpusId=' + identity.corpusId,
    'denseCollection=' + identity.denseCollectionName,
    'hybridCollection=' + identity.hybridCollectionName,
    'chunkCount=' + identity.chunkCount,
  ].join(' ');
}

export async function applyContextualRetrievalV2ToChunks(input: {
  mode: ContextualRetrievalV2Mode;
  documentText: string;
  sourceHash: string;
  documentVersion: string;
  model: string;
  promptVersion: string;
  chunks: DocumentChunk[];
  contextualizer: ContextualizerV2Port;
  signal?: AbortSignal;
}) {
  const contextualChunks = input.chunks.map((chunk, index) => {
    const startOffset = chunk.metadata.startOffset;
    const endOffset = chunk.metadata.endOffset;
    if (
      !Number.isInteger(startOffset)
      || !Number.isInteger(endOffset)
      || (startOffset as number) < 0
      || (endOffset as number) <= (startOffset as number)
      || input.documentText.slice(startOffset as number, endOffset as number) !== chunk.content
    ) {
      throw new Error('Pipeline chunk does not match its source-aligned span.');
    }
    const tenantId = pipelineIdentityValue(
      chunk.metadata.tenantId ?? chunk.metadata.tenant_id,
      process.env.SUPABASE_DEFAULT_TENANT_ID || 'local'
    );
    const corpusId = pipelineIdentityValue(
      chunk.metadata.corpusId ?? chunk.metadata.corpus_id,
      process.env.SUPABASE_DEFAULT_CORPUS_ID || 'default'
    );
    const documentId = pipelineIdentityValue(
      chunk.metadata.documentId ?? chunk.metadata.document_id,
      chunk.metadata.source
    );
    const stableChunkId = 'chunk:sha256:' + createHash('sha256')
      .update(JSON.stringify([
        tenantId,
        corpusId,
        documentId,
        input.documentVersion,
        index,
        startOffset,
        endOffset,
        createHash('sha256').update(chunk.content).digest('hex'),
      ]))
      .digest('hex');
    return {
      id: stableChunkId,
      text: chunk.content,
      startOffset: startOffset as number,
      endOffset: endOffset as number,
    };
  });

  const result = await contextualizeChunksV2({
    mode: input.mode,
    documentText: input.documentText,
    sourceHash: input.sourceHash,
    documentVersion: input.documentVersion,
    model: input.model,
    promptVersion: input.promptVersion,
    chunks: contextualChunks,
    contextualizer: input.contextualizer,
    signal: input.signal,
    failureMode: 'fallback',
    maxChunks: PIPELINE_WORK_LIMITS.maxChunksPerDocument,
    maxProviderCalls: PIPELINE_WORK_LIMITS.maxChunksPerDocument,
  });

  result.chunks.forEach((contextualChunk, index) => {
    const chunk = input.chunks[index];
    // Never persist generated context as citation content or sparse/BM25 text.
    chunk.embeddingContent = contextualChunk.denseText;
    delete chunk.metadata.originalContent;
    delete chunk.metadata.contextualPreamble;
    chunk.metadata.contextualIdentity = contextualChunk.identity.key;
    chunk.metadata.contextualVersion = result.version;
    chunk.metadata.contextualMode = result.mode;
    chunk.metadata.contextualStatus = contextualChunk.status;
    chunk.metadata.contextualModel = input.model;
    chunk.metadata.contextualPromptVersion = input.promptVersion;
  });
  return result;
}

export function resolvePipelineDocumentId(requested: unknown, source: string): string {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string') {
      throw new Error('Pipeline documentId must be a string.');
    }
    const normalized = requested.trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
      throw new Error('Pipeline documentId is outside the safe scalar bounds.');
    }
    return normalized;
  }
  const normalizedSource = source.trim();
  if (normalizedSource && normalizedSource.length <= 256 && !/[\u0000-\u001f]/.test(normalizedSource)) {
    return normalizedSource;
  }
  return 'source:sha256:' + createHash('sha256').update(source).digest('hex');
}

function pipelineIdentityValue(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : fallback.trim();
  if (!normalized) throw new Error('Pipeline contextual identity is incomplete.');
  return normalized;
}

function assertPipelineNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Document processing was aborted.');
  error.name = 'AbortError';
  throw error;
}

export async function publishPipelinePdfVisualSidecar(input: {
  document: LoadedDocument;
  documentId: string;
  documentVersion: string;
  mode: PdfMultimodalMode;
  signal?: AbortSignal;
}): Promise<PipelinePdfVisualSummary> {
  const pageCount = input.document.pdfParsed?.pages
    ?? (Number.isInteger(input.document.metadata.pageCount)
      ? input.document.metadata.pageCount as number
      : 0);
  if (input.document.metadata.type !== 'pdf') {
    return {
      mode: input.mode,
      status: 'not_applicable',
      pageCount: 0,
      visualPageCount: 0,
    };
  }
  if (input.mode === 'off') {
    return {
      mode: input.mode,
      status: 'disabled',
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      pageCount,
      visualPageCount: 0,
    };
  }
  if (!input.document.pdfAssetSource || !input.document.pdfParsed) {
    return {
      mode: input.mode,
      status: 'fallback',
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      pageCount,
      visualPageCount: 0,
      fallbackReason: 'visual_sidecar_unavailable',
    };
  }

  try {
    assertPipelineNotAborted(input.signal);
    const [{ getPdfVisualAssetRuntime }, { publishPdfVisualSidecar }] =
      await Promise.all([
        import('./rag/multimodal/pdf-visual-runtime'),
        import('./rag/multimodal/pdf-visual-ingest'),
      ]);
    const runtime = getPdfVisualAssetRuntime();
    const { scope, trustLevel } = resolvePipelinePdfScope(input.document.metadata);
    const summary = await publishPdfVisualSidecar({
      mode: input.mode,
      source: input.document.pdfAssetSource,
      sourceName: input.document.metadata.source,
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      parsed: input.document.pdfParsed,
      scope,
      trustLevel,
      store: runtime.store,
      renderer: runtime.renderer,
      maxRenderPages: runtime.maxRenderPages,
      signal: input.signal,
    });
    return {
      mode: summary.mode,
      status: summary.status,
      version: summary.version,
      manifestVersion: summary.manifestVersion,
      documentId: summary.documentId,
      documentVersion: summary.documentVersion,
      pageCount: summary.pageCount,
      visualPageCount: summary.visualPageCount,
    };
  } catch (error) {
    assertPipelineNotAborted(input.signal);
    console.warn(
      '[Pipeline] PDF visual sidecar fell back to text retrieval.',
      error instanceof Error ? error.name : 'Error'
    );
    return {
      mode: input.mode,
      status: 'fallback',
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      pageCount,
      visualPageCount: 0,
      fallbackReason: 'visual_sidecar_unavailable',
    };
  }
}

function resolvePipelinePdfScope(metadata: DocumentMetadata): {
  scope: RagRetrievalScope;
  trustLevel: RagTrustLevel;
} {
  const tenantId = strictMetadataAlias(
    metadata.tenantId,
    metadata.tenant_id,
    process.env.SUPABASE_DEFAULT_TENANT_ID || 'local',
    'tenant'
  );
  const corpusId = strictMetadataAlias(
    metadata.corpusId,
    metadata.corpus_id,
    process.env.SUPABASE_DEFAULT_CORPUS_ID || 'default',
    'corpus'
  );
  const trustValue = strictMetadataAlias(
    metadata.trustLevel,
    metadata.trust_level,
    'external',
    'trust'
  );
  if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(trustValue)) {
    throw new Error('Pipeline PDF trust level is invalid.');
  }
  const trustLevel = trustValue as RagTrustLevel;
  return {
    scope: createRetrievalScope({
      tenantId,
      corpusId,
      allowedTrustLevels: [trustLevel],
      enforceIsolation: true,
    }),
    trustLevel,
  };
}

function strictMetadataAlias(
  canonical: unknown,
  alias: unknown,
  fallback: string,
  field: string
): string {
  const canonicalValue = typeof canonical === 'string' && canonical.trim()
    ? canonical.trim()
    : undefined;
  const aliasValue = typeof alias === 'string' && alias.trim()
    ? alias.trim()
    : undefined;
  if (canonicalValue && aliasValue && canonicalValue !== aliasValue) {
    throw new Error('Pipeline PDF ' + field + ' provenance aliases conflict.');
  }
  return canonicalValue ?? aliasValue ?? fallback;
}

// ============== 完整管道 ==============

/**
 * 文档处理管道
 * 
 * 完整流程: 加载 → 分割 → 嵌入 → 存储
 */
export class DocumentPipeline {
  private config: Required<PipelineConfig>;
  
  constructor(config: PipelineConfig = {}) {
    const requestedMode = config.contextualRetrievalMode
      ?? (config.contextualRetrieval === true
        ? 'shadow'
        : config.contextualRetrieval === false
          ? 'off'
          : resolveContextualRetrievalV2Mode());
    const pdfVisualMode = config.pdfVisualMode ?? resolvePdfMultimodalMode();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      contextualRetrievalMode: requestedMode,
      pdfVisualMode,
      contextualizerV2: config.contextualizerV2
        ?? createLangChainContextualizerV2(),
    };
  }
  
  /**
   * 处理单个文档
   */
  async processDocument(
    input: string | Buffer,
    options: {
      type?: DataSourceType;
      filename?: string;
      /** Server-derived metadata such as tenant/corpus scope. */
      metadata?: Record<string, unknown>;
      /** Internal batch budget; callers cannot raise the global ceiling. */
      /** Request cancellation propagated to contextual/model/storage boundaries. */
      signal?: AbortSignal;
      maxChunks?: number;
    } = {},
    onProgress?: (progress: ProcessingProgress) => void
  ): Promise<{
    documentId: string;
    chunks: number;
    ids: string[];
    metadata: DocumentMetadata;
    contextualRetrieval: {
      version: typeof CONTEXTUAL_RETRIEVAL_V2_VERSION;
      mode: ContextualRetrievalV2Mode;
      fallbackCount: number;
      generatedCharacters: number;
    };
    pdfVisual: PipelinePdfVisualSummary;
  }> {
    // 1. 加载文档
    onProgress?.({
      stage: 'loading',
      current: 0,
      total: 1,
      message: '正在加载文档...'
    });
    
    const document = await loadDocument(input, options);
    const sourceIdentity = document.pdfAssetSource ?? document.content;
    const sourceHash = createHash('sha256').update(sourceIdentity).digest('hex');
    const documentVersion = 'sha256:' + sourceHash;
    const requestedDocumentId = options.metadata?.documentId ?? options.metadata?.document_id;
    const defaultDocumentId = document.pdfAssetSource
      ? 'pdf:sha256:' + sourceHash
      : document.metadata.source;
    const documentId = resolvePipelineDocumentId(requestedDocumentId, defaultDocumentId);
    assertPipelineNotAborted(options.signal);
    document.metadata = {
      ...document.metadata,
      ...(options.metadata ?? {}),
      documentId,
      document_id: documentId,
      documentVersion,
      document_version: documentVersion,
      sourceHash: documentVersion,
      source_hash: documentVersion,
    };
    
    onProgress?.({
      stage: 'loading',
      current: 1,
      total: 1,
      message: `加载完成: ${document.metadata.source}`
    });
    
    // 2. 分割文档
    onProgress?.({
      stage: 'splitting',
      current: 0,
      total: 1,
      message: '正在分割文档...'
    });
    
    const chunks = await splitDocument(document, {
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      maxChunks: options.maxChunks ?? PIPELINE_WORK_LIMITS.maxChunksPerDocument,
    });
    
    onProgress?.({
      stage: 'splitting',
      current: 1,
      total: 1,
      message: `分割完成: ${chunks.length} 个块`
    });

    // 2.5 Contextual Retrieval v2 only changes the embedding input.
    const contextualMode = this.config.contextualRetrievalMode;
    if (contextualMode !== 'off' && chunks.length > 0) {
      onProgress?.({
        stage: 'contextualizing',
        current: 0,
        total: chunks.length,
        message: '正在生成上下文提要...'
      });

    }
    const contextualModel = contextualMode === 'off'
      ? 'disabled'
      : this.config.contextualRetrievalModel
        || process.env.CONTEXTUAL_RETRIEVAL_V2_MODEL?.trim()
        || getConfigSummary().llmModel;
    const contextualResult = await applyContextualRetrievalV2ToChunks({
      mode: contextualMode,
      documentText: document.content,
      sourceHash: documentVersion,
      documentVersion,
      model: contextualModel,
      promptVersion: LANGCHAIN_CONTEXTUALIZER_V2_PROMPT_VERSION,
      chunks,
      contextualizer: this.config.contextualizerV2,
      signal: options.signal,
    });
    if (contextualMode !== 'off' && chunks.length > 0) {
      onProgress?.({
        stage: 'contextualizing',
        current: chunks.length,
        total: chunks.length,
        message: `上下文提要生成完成`
      });
    }

    // 3. 生成嵌入
    assertPipelineNotAborted(options.signal);
    const processedDocs = await generateEmbeddings(chunks, {
      embeddingModel: this.config.embeddingModel,
      ollamaBaseUrl: this.config.ollamaBaseUrl,
    }, onProgress);
    
    // 4. 存储
    assertPipelineNotAborted(options.signal);
    const ids = await storeToMilvus(
      processedDocs,
      { ...this.config.milvusConfig, embeddingModel: this.config.embeddingModel },
      onProgress
    );
    assertPipelineNotAborted(options.signal);
    // Text/OCR retrieval is authoritative; visual sidecars publish afterwards.
    const pdfVisual = await publishPipelinePdfVisualSidecar({
      document,
      documentId,
      documentVersion,
      mode: this.config.pdfVisualMode,
      signal: options.signal,
    });
    assertPipelineNotAborted(options.signal);
    
    return {
      documentId,
      chunks: chunks.length,
      ids,
      metadata: document.metadata,
      contextualRetrieval: {
        version: contextualResult.version,
        mode: contextualResult.mode,
        fallbackCount: contextualResult.fallbackCount,
        generatedCharacters: contextualResult.generatedCharacters,
      },
      pdfVisual,
    };
  }
  
  /**
   * 批量处理文档
   */
  async processDocuments(
    inputs: Array<{
      input: string | Buffer;
      type?: DataSourceType;
      filename?: string;
      metadata?: Record<string, unknown>;
      signal?: AbortSignal;
    }>,
    onProgress?: (progress: ProcessingProgress & { documentIndex: number }) => void
  ): Promise<Array<{
    documentId: string;
    chunks: number;
    ids: string[];
    metadata: DocumentMetadata;
    success: boolean;
    error?: string;
  }>> {
    const results = [];
    let processedChunks = 0;
    
    for (let i = 0; i < inputs.length; i++) {
      const { input, type, filename, metadata, signal } = inputs[i];
      
      try {
        const remainingChunks = PIPELINE_WORK_LIMITS.maxChunksPerBatch - processedChunks;
        if (remainingChunks <= 0) {
          throw new Error('Batch chunk budget exhausted.');
        }
        const result = await this.processDocument(
          input,
          {
            type,
            filename,
            metadata,
            maxChunks: Math.min(
              PIPELINE_WORK_LIMITS.maxChunksPerDocument,
              remainingChunks
            ),
            signal,
          },
          (progress) => {
            onProgress?.({
              ...progress,
              documentIndex: i,
              message: `[${i + 1}/${inputs.length}] ${progress.message}`
            });
          }
        );
        processedChunks += result.chunks;
        results.push({ ...result, success: true });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        if (error instanceof MilvusHybridIngestReconciliationRequiredError) throw error;
        results.push({
          documentId: filename || `document-${i}`,
          chunks: 0,
          ids: [],
          metadata: { source: filename || `document-${i}`, type: type || 'raw' },
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    
    return results;
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<PipelineConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * 获取当前配置
   */
  getConfig(): Required<PipelineConfig> {
    return { ...this.config };
  }
}

// ============== 便捷函数 ==============

/**
 * 快速处理文本到 Milvus
 */
export async function processTextToMilvus(
  text: string,
  source: string = 'raw-input',
  config: PipelineConfig = {}
): Promise<string[]> {
  const pipeline = new DocumentPipeline(config);
  const result = await pipeline.processDocument(text, { filename: source });
  return result.ids;
}

/**
 * 快速处理 URL 到 Milvus
 */
export async function processUrlToMilvus(
  url: string,
  config: PipelineConfig = {}
): Promise<string[]> {
  const pipeline = new DocumentPipeline(config);
  const result = await pipeline.processDocument(url);
  return result.ids;
}

/**
 * 快速处理 PDF 到 Milvus
 */
export async function processPdfToMilvus(
  buffer: Buffer,
  filename: string,
  config: PipelineConfig = {}
): Promise<string[]> {
  const pipeline = new DocumentPipeline(config);
  const result = await pipeline.processDocument(buffer, { type: 'pdf', filename });
  return result.ids;
}

/**
 * 快速处理 Excel 到 Milvus
 */
export async function processExcelToMilvus(
  buffer: Buffer,
  filename: string,
  config: PipelineConfig = {}
): Promise<string[]> {
  const pipeline = new DocumentPipeline(config);
  const result = await pipeline.processDocument(buffer, { type: 'xlsx', filename });
  return result.ids;
}

/**
 * 快速处理 Markdown 到 Milvus
 */
export async function processMarkdownToMilvus(
  buffer: Buffer,
  filename: string,
  config: PipelineConfig = {}
): Promise<string[]> {
  const pipeline = new DocumentPipeline(config);
  const result = await pipeline.processDocument(buffer, { type: 'markdown', filename });
  return result.ids;
}

export default DocumentPipeline;
