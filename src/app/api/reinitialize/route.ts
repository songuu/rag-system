/*
 * @Author: songyu
 * @Date: 2026-01-12 20:01:51
 * @LastEditTime: 2026-01-28 16:05:13
 * @LastEditor: songyu
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem, resetRagSystem } from '@/lib/rag-instance';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { LocalRAGSystem } from '@/lib/rag-system';
import {
  getConfigSummary,
} from '@/lib/model-config';
import {
  getEmbeddingConfigSummary,
} from '@/lib/embedding-config';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// POST /api/reinitialize - 重新初始化 RAG 系统
export async function POST(request: NextRequest) {
  try {
    const summary = getConfigSummary();
    const embeddingConfig = getEmbeddingConfigSummary();

    // 获取请求体中的模型配置（如果有）
    let llmModel = summary.llmModel ||'llama3.1';
    let embeddingModel = embeddingConfig.model || 'nomic-embed-text';
    
    try {
      const body = await request.json();
      if (body.llmModel) llmModel = body.llmModel;
      if (body.embeddingModel) embeddingModel = body.embeddingModel;
      console.log(`[Reinitialize] 使用模型 - LLM: ${llmModel}, Embedding: ${embeddingModel}`);
    } catch {
      // 如果没有 body，使用默认值
      console.log('[Reinitialize] 使用默认模型配置');
    }
    
    // 如果指定了新模型，先重置实例
    resetRagSystem();
    
    // 创建新实例（使用指定的模型）
    const instance = new LocalRAGSystem({
      ollamaBaseUrl: "http://localhost:11434",
      llmModel,
      embeddingModel,
    });
    
    // 初始化数据库
    await instance.initializeDatabase();
    
    // 重新加载所有上传的文件
    if (existsSync(UPLOAD_DIR)) {
      const files = await readdir(UPLOAD_DIR);
      const txtFiles = files.filter(f => f.endsWith('.txt'));
      
      const documents: Array<{ content: string; filename: string }> = [];
      for (const filename of txtFiles) {
        const filePath = path.join(UPLOAD_DIR, filename);
        const content = await readFile(filePath, 'utf-8');
        if (content.trim()) {
          documents.push({ content, filename });
        }
      }
      
      console.log(`[Reinitialize] 找到 ${documents.length} 个有效文档`);
      
      // 重新初始化系统
      await instance.reinitialize(documents);
    } else {
      // 如果没有文件，清空系统
      await instance.reinitialize([]);
    }
    
    // 将新实例设置为全局实例
    (global as any).ragSystemInstance = instance;

    return NextResponse.json({
      success: true,
      message: '系统重新初始化成功',
      llmModel,
      embeddingModel
    });
  } catch (error) {
    console.error('重新初始化错误:', error);
    return NextResponse.json(
      { 
        error: '重新初始化失败',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}