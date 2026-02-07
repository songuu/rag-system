/**
 * Reasoning RAG 独立向量化 API
 * 使用专用的 Milvus 集合 reasoning_rag_documents
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { MilvusVectorStore } from '@/lib/milvus-client';
import { createEmbedding, getModelFactory } from '@/lib/model-config';
import { getEmbeddingConfigSummary, getEmbeddingDimension, ALL_EMBEDDING_DIMENSIONS, SILICONFLOW_MODELS } from '@/lib/embedding-config';
import { getReasoningRAGConfig, getReasoningRAGConfigSummary } from '@/lib/milvus-config';

// 获取 Reasoning RAG 配置（从环境变量）
function getConfig() {
  const ragConfig = getReasoningRAGConfig();
  return {
    uploadDir: path.join(process.cwd(), ragConfig.uploadDir),
    collection: ragConfig.collection,
    dimension: ragConfig.dimension,
    chunkSize: ragConfig.chunkSize,
    chunkOverlap: ragConfig.chunkOverlap,
  };
}

// 使用独立的 Embedding 配置系统
const embeddingConfig = getEmbeddingConfigSummary();
const DEFAULT_EMBEDDING_MODEL = embeddingConfig.model;

// 模型维度映射 - 使用统一映射
const MODEL_DIMENSIONS = ALL_EMBEDDING_DIMENSIONS;

// 模型 maxTokens 限制映射
const MODEL_MAX_TOKENS: Record<string, number> = {
  // SiliconFlow 模型
  'BAAI/bge-large-zh-v1.5': 512,
  'BAAI/bge-large-en-v1.5': 512,
  'BAAI/bge-m3': 8192,
  'Pro/BAAI/bge-m3': 8192,
  'Qwen/Qwen3-Embedding-8B': 32768,
  'Qwen/Qwen3-Embedding-4B': 32768,
  'Qwen/Qwen3-Embedding-0.6B': 32768,
  'netease-youdao/bce-embedding-base_v1': 512,
  // Ollama 模型 (估计值)
  'nomic-embed-text': 2048,
  'nomic-embed-text-v2-moe': 2048,
  'bge-m3': 8192,
  'bge-large': 512,
  'all-minilm': 512,
  'mxbai-embed-large': 512,
  // 默认值
  'default': 512,
};

function getModelDimension(model: string): number {
  // 优先使用 Reasoning RAG 配置的维度
  const ragConfig = getReasoningRAGConfig();
  if (!model || model === DEFAULT_EMBEDDING_MODEL) {
    return ragConfig.dimension;
  }
  const baseName = model.split(':')[0];
  return MODEL_DIMENSIONS[baseName] || MODEL_DIMENSIONS[model] || ragConfig.dimension;
}

/**
 * 获取模型的 maxTokens 限制
 * 用于自动调整 chunkSize
 */
function getModelMaxTokens(model: string): number {
  // 检查 SiliconFlow 模型
  if (model in SILICONFLOW_MODELS) {
    return (SILICONFLOW_MODELS as Record<string, { maxTokens?: number }>)[model]?.maxTokens || MODEL_MAX_TOKENS['default'];
  }
  // 检查本地映射
  const baseName = model.split(':')[0];
  return MODEL_MAX_TOKENS[baseName] || MODEL_MAX_TOKENS[model] || MODEL_MAX_TOKENS['default'];
}

/**
 * 根据 maxTokens 计算安全的 chunkSize
 * 中文约 1 字符 = 1.5-2 tokens，保守起见用 2
 * 留 20% 余量
 */
function calculateSafeChunkSize(maxTokens: number): number {
  // 安全系数：maxTokens / 2（考虑中文token比例）* 0.8（留余量）
  const safeSize = Math.floor((maxTokens / 2) * 0.8);
  // 最小 100，最大 2000
  return Math.max(100, Math.min(safeSize, 2000));
}

// 文本分块函数
function splitTextIntoChunks(
  text: string, 
  chunkSize: number = 500, 
  overlap: number = 50
): { text: string; startIndex: number; endIndex: number }[] {
  const chunks: { text: string; startIndex: number; endIndex: number }[] = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = Math.min(startIndex + chunkSize, text.length);
    
    // 尝试在句子边界处分割
    if (endIndex < text.length) {
      const lastPeriod = text.lastIndexOf('。', endIndex);
      const lastQuestion = text.lastIndexOf('？', endIndex);
      const lastExclaim = text.lastIndexOf('！', endIndex);
      const lastNewline = text.lastIndexOf('\n', endIndex);
      
      const candidates = [lastPeriod, lastQuestion, lastExclaim, lastNewline]
        .filter(idx => idx > startIndex && idx <= endIndex);
      
      if (candidates.length > 0) {
        endIndex = Math.max(...candidates) + 1;
      }
    }
    
    const chunkText = text.slice(startIndex, endIndex).trim();
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        startIndex,
        endIndex
      });
    }
    
    startIndex = endIndex - overlap;
    if (startIndex >= text.length - overlap) break;
  }

  return chunks;
}

/**
 * POST: 向量化 Reasoning RAG 专用目录中的文件
 */
export async function POST(request: NextRequest) {
  try {
    // 获取 Reasoning RAG 配置
    const ragConfig = getConfig();
    
    const body = await request.json();
    const { 
      action = 'vectorize-all',
      embeddingModel = DEFAULT_EMBEDDING_MODEL,
      chunkSize: requestedChunkSize = ragConfig.chunkSize,
      chunkOverlap = ragConfig.chunkOverlap,
      files: specificFiles  // 可选：指定要向量化的文件
    } = body;

    // 获取模型的 maxTokens 限制并自动调整 chunkSize
    const modelMaxTokens = getModelMaxTokens(embeddingModel);
    const safeChunkSize = calculateSafeChunkSize(modelMaxTokens);
    const chunkSize = Math.min(requestedChunkSize, safeChunkSize);
    
    console.log(`[Reasoning Vectorize] ========================================`);
    console.log(`[Reasoning Vectorize] Action: ${action}`);
    console.log(`[Reasoning Vectorize] Model: ${embeddingModel}`);
    console.log(`[Reasoning Vectorize] Model maxTokens: ${modelMaxTokens}`);
    console.log(`[Reasoning Vectorize] Safe chunkSize: ${safeChunkSize} (requested: ${requestedChunkSize}, using: ${chunkSize})`);
    console.log(`[Reasoning Vectorize] Collection: ${ragConfig.collection}`);
    console.log(`[Reasoning Vectorize] Dimension: ${ragConfig.dimension}D`);
    console.log(`[Reasoning Vectorize] Upload Dir: ${ragConfig.uploadDir}`);
    console.log(`[Reasoning Vectorize] ========================================`);

    // 检查上传目录
    if (!existsSync(ragConfig.uploadDir)) {
      return NextResponse.json({
        success: false,
        error: '没有找到上传的文件，请先上传文件',
        uploadDir: ragConfig.uploadDir
      }, { status: 400 });
    }

    // 获取文件列表
    const allFiles = await readdir(ragConfig.uploadDir);
    const textFiles = allFiles.filter(f => f.endsWith('_parsed.txt'));

    if (textFiles.length === 0) {
      return NextResponse.json({
        success: false,
        error: '没有找到可向量化的文本文件'
      }, { status: 400 });
    }

    // 如果指定了特定文件，进行过滤
    const filesToProcess = specificFiles 
      ? textFiles.filter(f => specificFiles.includes(f))
      : textFiles;

    if (filesToProcess.length === 0) {
      return NextResponse.json({
        success: false,
        error: '指定的文件不存在或不可向量化'
      }, { status: 400 });
    }

    // 使用配置的维度（优先）或模型维度
    const dimension = ragConfig.dimension;
    console.log(`[Reasoning Vectorize] Using dimension: ${dimension}D (from config)`);

    // 创建 Milvus 客户端 - 使用配置的独立集合
    const milvus = new MilvusVectorStore({
      collectionName: ragConfig.collection,
      embeddingDimension: dimension,
      metricType: 'COSINE'
    });

    // 连接并初始化集合
    await milvus.connect();
    
    // 检查集合维度是否匹配
    const stats = await milvus.getCollectionStats();
    if (stats && stats.embeddingDimension !== dimension) {
      console.log(`[Reasoning Vectorize] 维度变化，重建集合 (${stats.embeddingDimension}D -> ${dimension}D)`);
      await milvus.clearCollection();
    }
    
    await milvus.initializeCollection(true);

    // 使用统一配置系统创建 Embedding 模型
    const embeddings = createEmbedding(embeddingModel);

    // 处理每个文件
    const results: Array<{
      filename: string;
      chunks: number;
      success: boolean;
      error?: string;
    }> = [];
    let totalChunks = 0;
    let totalDocuments = 0;

    for (const filename of filesToProcess) {
      try {
        const filePath = path.join(ragConfig.uploadDir, filename);
        const content = await readFile(filePath, 'utf-8');

        if (!content.trim()) {
          results.push({ filename, chunks: 0, success: false, error: '文件内容为空' });
          continue;
        }

        // 分块处理
        const chunks = splitTextIntoChunks(content, chunkSize, chunkOverlap);
        console.log(`[Reasoning Vectorize] ${filename}: ${chunks.length} chunks`);

        // 分批生成嵌入向量（每批最多 10 个 chunk，避免超出 API 限制）
        const BATCH_SIZE = 10;
        const chunkTexts = chunks.map(c => c.text);
        const vectors: number[][] = [];
        
        for (let i = 0; i < chunkTexts.length; i += BATCH_SIZE) {
          const batch = chunkTexts.slice(i, i + BATCH_SIZE);
          try {
            const batchVectors = await embeddings.embedDocuments(batch);
            vectors.push(...batchVectors);
          } catch (batchError) {
            // 如果批量失败，尝试逐个处理
            console.warn(`[Reasoning Vectorize] 批量嵌入失败，尝试逐个处理...`);
            for (const text of batch) {
              try {
                // 如果单个文本仍然太长，截断它
                const truncatedText = text.length > chunkSize ? text.slice(0, chunkSize) : text;
                const singleVector = await embeddings.embedDocuments([truncatedText]);
                vectors.push(...singleVector);
              } catch (singleError) {
                console.error(`[Reasoning Vectorize] 单个文本嵌入失败:`, singleError);
                // 使用零向量作为占位符
                const dimension = getModelDimension(embeddingModel);
                vectors.push(new Array(dimension).fill(0));
              }
            }
          }
        }

        // 构建文档
        const documents = chunks.map((chunk, i) => ({
          id: `reasoning_${filename.replace(/[^a-zA-Z0-9]/g, '_')}_${i}_${Date.now()}`,
          content: chunk.text,
          embedding: vectors[i],
          metadata: {
            source: filename,
            chunkIndex: i,
            totalChunks: chunks.length,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
            collection: ragConfig.collection,
            timestamp: Date.now()
          }
        }));

        // 插入 Milvus
        await milvus.insertDocuments(documents);

        results.push({ filename, chunks: chunks.length, success: true });
        totalChunks += chunks.length;
        totalDocuments += 1;
        
        console.log(`[Reasoning Vectorize] ✅ ${filename}: ${chunks.length} chunks indexed`);

      } catch (error) {
        console.error(`[Reasoning Vectorize] ❌ ${filename}:`, error);
        results.push({
          filename,
          chunks: 0,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // 获取最新统计
    const newStats = await milvus.getCollectionStats();

    return NextResponse.json({
      success: true,
      message: `成功向量化 ${results.filter(r => r.success).length}/${filesToProcess.length} 个文件`,
      collection: ragConfig.collection,
      embeddingModel,
      dimension,
      chunkSize,
      chunkOverlap,
      totalChunks,
      totalDocuments,
      results,
      stats: newStats,
      config: getReasoningRAGConfigSummary()
    });

  } catch (error) {
    console.error('[Reasoning Vectorize] Error:', error);
    return NextResponse.json({
      success: false,
      error: '向量化处理失败',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

/**
 * GET: 获取 Reasoning RAG 集合状态
 */
export async function GET() {
  try {
    // 获取 Reasoning RAG 配置
    const ragConfig = getConfig();
    const configSummary = getReasoningRAGConfigSummary();
    
    const milvus = new MilvusVectorStore({
      collectionName: ragConfig.collection,
      embeddingDimension: ragConfig.dimension
    });

    await milvus.connect();
    const stats = await milvus.getCollectionStats();

    // 获取上传目录文件统计
    let fileCount = 0;
    let textFileCount = 0;
    
    if (existsSync(ragConfig.uploadDir)) {
      const allFiles = await readdir(ragConfig.uploadDir);
      textFileCount = allFiles.filter(f => f.endsWith('_parsed.txt')).length;
      fileCount = allFiles.filter(f => !f.endsWith('_parsed.txt')).length;
    }

    return NextResponse.json({
      success: true,
      collection: ragConfig.collection,
      collectionStats: stats || { rowCount: 0, name: ragConfig.collection },
      fileStats: {
        uploadedFiles: fileCount,
        textFiles: textFileCount,
        uploadDir: ragConfig.uploadDir
      },
      isReady: stats && stats.rowCount > 0,
      config: configSummary
    });

  } catch (error) {
    console.error('[Reasoning Vectorize] Get stats error:', error);
    const ragConfig = getConfig();
    return NextResponse.json({
      success: false,
      error: '获取状态失败',
      details: error instanceof Error ? error.message : String(error),
      collection: ragConfig.collection,
      collectionStats: null,
      isReady: false,
      config: getReasoningRAGConfigSummary()
    }, { status: 500 });
  }
}

/**
 * DELETE: 清空 Reasoning RAG 集合
 */
export async function DELETE() {
  try {
    // 获取 Reasoning RAG 配置
    const ragConfig = getConfig();
    
    const milvus = new MilvusVectorStore({
      collectionName: ragConfig.collection,
      embeddingDimension: ragConfig.dimension
    });

    await milvus.connect();
    await milvus.clearCollection();

    return NextResponse.json({
      success: true,
      message: `成功清空集合: ${ragConfig.collection}`,
      collection: ragConfig.collection
    });

  } catch (error) {
    console.error('[Reasoning Vectorize] Clear collection error:', error);
    const ragConfig = getConfig();
    return NextResponse.json({
      success: false,
      error: '清空集合失败',
      details: error instanceof Error ? error.message : String(error),
      collection: ragConfig.collection
    }, { status: 500 });
  }
}
