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
import { Embeddings } from '@langchain/core/embeddings';
import { MilvusVectorStore, MilvusDocument, getMilvusInstance } from './milvus-client';
import { getMilvusConnectionConfig } from './milvus-config';
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import { createEmbedding, getModelFactory } from './model-config';
import { getEmbeddingConfigSummary } from './embedding-config';

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
  totalChunks?: number;
  pageNumber?: number;
  [key: string]: any;
}

// 加载的文档
export interface LoadedDocument {
  content: string;
  metadata: DocumentMetadata;
}

// 文档块
export interface DocumentChunk {
  id: string;
  content: string;
  metadata: DocumentMetadata;
}

// 处理后的文档（带向量）
export interface ProcessedDocument extends DocumentChunk {
  embedding: number[];
}

// 管道配置
export interface PipelineConfig {
  // 文本分割配置
  chunkSize?: number;
  chunkOverlap?: number;
  
  // 嵌入模型配置
  embeddingModel?: string;
  ollamaBaseUrl?: string;
  
  // 存储配置
  storageBackend?: 'memory' | 'milvus';
  milvusConfig?: {
    address?: string;
    collectionName?: string;
  };
}

// 处理进度回调
export interface ProcessingProgress {
  stage: 'loading' | 'splitting' | 'embedding' | 'storing';
  current: number;
  total: number;
  message: string;
}

// 默认配置
const DEFAULT_CONFIG: Required<PipelineConfig> = {
  chunkSize: 500,
  chunkOverlap: 50,
  embeddingModel: 'nomic-embed-text',
  ollamaBaseUrl: 'http://localhost:11434',
  storageBackend: 'milvus',
  milvusConfig: {
    address: 'localhost:19530',
    collectionName: 'rag_documents',
  }
};

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
    // 动态导入 pdf-parse v2.x
    const { PDFParse } = await import('pdf-parse');
    console.log('[Pipeline PDF] pdf-parse 模块加载成功');
    
    // 使用 v2 API
    const parser = new PDFParse({ data: buffer });
    console.log('[Pipeline PDF] PDFParse 实例创建成功');
    
    // 获取文本和文档信息
    const textResult = await parser.getText();
    console.log(`[Pipeline PDF] 文本提取成功, 长度: ${textResult.text.length}`);
    
    const infoResult = await parser.getInfo();
    console.log(`[Pipeline PDF] 文档信息获取成功, 页数: ${infoResult.total}`);
    
    // 释放资源
    await parser.destroy();
    console.log('[Pipeline PDF] 资源已释放');
    
    return {
      content: textResult.text.trim(),
      metadata: {
        source: filename,
        type: 'pdf',
        title: infoResult.info?.Title || filename,
        author: infoResult.info?.Author,
        createdAt: infoResult.info?.CreationDate || new Date().toISOString(),
        pageCount: infoResult.total,
      }
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
    // 如果 mammoth 不可用，尝试基本的文本提取
    console.warn('[Pipeline] Mammoth 不可用，尝试基本文本提取');
    const text = buffer.toString('utf-8').replace(/<[^>]*>/g, ' ').trim();
    return {
      content: text,
      metadata: {
        source: filename,
        type: 'docx',
        title: filename,
        createdAt: new Date().toISOString(),
      }
    };
  }
}

/**
 * Excel 文件加载器 (xlsx, xls, csv)
 */
export async function loadExcelFile(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets: string[] = workbook.SheetNames;
    
    // 将所有工作表内容合并
    const contents: string[] = [];
    
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
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP 错误: ${response.status}`);
    }
    
    const html = await response.text();
    
    // 使用 cheerio 解析 HTML
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    
    // 移除脚本、样式等无关内容
    $('script, style, nav, footer, header, aside, .sidebar, .advertisement').remove();
    
    // 获取标题
    const title = $('title').text() || $('h1').first().text() || new URL(url).hostname;
    
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
        source: url,
        type: 'url',
        title: title.trim(),
        url,
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
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * 获取 YouTube 字幕
 */
async function fetchYouTubeTranscript(videoId: string): Promise<{ text: string; title?: string }> {
  try {
    // 获取视频页面
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = await response.text();
    
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
        const captionResponse = await fetch(captionUrl);
        const captionXml = await captionResponse.text();
        
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
  config: { chunkSize?: number; chunkOverlap?: number } = {}
): Promise<DocumentChunk[]> {
  const { chunkSize = 500, chunkOverlap = 50 } = config;
  
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', '；', ';', ' ', ''],
  });
  
  const chunks = await splitter.splitText(document.content);
  
  return chunks.map((content, index) => ({
    id: `${document.metadata.source}-chunk-${index}-${uuidv4().slice(0, 8)}`,
    content,
    metadata: {
      ...document.metadata,
      chunkIndex: index,
      totalChunks: chunks.length,
    }
  }));
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
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    onProgress?.({
      stage: 'embedding',
      current: i + 1,
      total: chunks.length,
      message: `正在生成向量 (${i + 1}/${chunks.length})...`
    });
    
    const embedding = await embeddings.embedQuery(chunk.content);
    
    results.push({
      ...chunk,
      embedding,
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
  config: { address?: string; collectionName?: string; token?: string; ssl?: boolean } = {},
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
  await milvus.initializeCollection(true);
  
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
  
  console.log(`[Pipeline] Calling milvus.insertDocuments with ${milvusDocs.length} documents`);
  const ids = await milvus.insertDocuments(milvusDocs);
  
  onProgress?.({
    stage: 'storing',
    current: documents.length,
    total: documents.length,
    message: `成功存储 ${ids.length} 个文档块`
  });
  
  return ids;
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
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * 处理单个文档
   */
  async processDocument(
    input: string | Buffer,
    options: {
      type?: DataSourceType;
      filename?: string;
    } = {},
    onProgress?: (progress: ProcessingProgress) => void
  ): Promise<{
    documentId: string;
    chunks: number;
    ids: string[];
    metadata: DocumentMetadata;
  }> {
    // 1. 加载文档
    onProgress?.({
      stage: 'loading',
      current: 0,
      total: 1,
      message: '正在加载文档...'
    });
    
    const document = await loadDocument(input, options);
    
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
    });
    
    onProgress?.({
      stage: 'splitting',
      current: 1,
      total: 1,
      message: `分割完成: ${chunks.length} 个块`
    });
    
    // 3. 生成嵌入
    const processedDocs = await generateEmbeddings(chunks, {
      embeddingModel: this.config.embeddingModel,
      ollamaBaseUrl: this.config.ollamaBaseUrl,
    }, onProgress);
    
    // 4. 存储
    const ids = await storeToMilvus(processedDocs, this.config.milvusConfig, onProgress);
    
    return {
      documentId: document.metadata.source,
      chunks: chunks.length,
      ids,
      metadata: document.metadata,
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
    
    for (let i = 0; i < inputs.length; i++) {
      const { input, type, filename } = inputs[i];
      
      try {
        const result = await this.processDocument(
          input,
          { type, filename },
          (progress) => {
            onProgress?.({
              ...progress,
              documentIndex: i,
              message: `[${i + 1}/${inputs.length}] ${progress.message}`
            });
          }
        );
        
        results.push({ ...result, success: true });
      } catch (error) {
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
