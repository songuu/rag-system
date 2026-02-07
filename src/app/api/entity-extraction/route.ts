/**
 * 实体抽取 API
 * 
 * POST /api/entity-extraction - 从文本中抽取实体和关系
 * GET /api/entity-extraction - 获取已存储的知识图谱
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// 动态导入以避免服务端初始化问题
let EntityExtractor: typeof import('@/lib/entity-extraction').EntityExtractor | null = null;
let DEFAULT_EXTRACTION_CONFIG: typeof import('@/lib/entity-extraction').DEFAULT_EXTRACTION_CONFIG | null = null;

async function getEntityExtractor() {
  if (!EntityExtractor) {
    const module = await import('@/lib/entity-extraction');
    EntityExtractor = module.EntityExtractor;
    DEFAULT_EXTRACTION_CONFIG = module.DEFAULT_EXTRACTION_CONFIG;
  }
  return { EntityExtractor, DEFAULT_EXTRACTION_CONFIG };
}

// 内存缓存知识图谱
let cachedGraph: {
  entities: unknown[];
  relations: unknown[];
  communities: unknown[];
  chunks: unknown[];
  metadata: {
    documentId: string;
    createdAt: Date;
    entityCount: number;
    relationCount: number;
    communityCount: number;
  };
} | null = null;
let extractionInProgress = false;
let currentProgress: {
  stage: string;
  current: number;
  total: number;
  message: string;
} | null = null;

// 上传目录
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const REASONING_UPLOADS_DIR = path.join(process.cwd(), 'reasoning-uploads');

/**
 * GET - 获取知识图谱或抽取状态
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'graph';

  try {
    switch (action) {
      case 'graph':
        // 返回当前知识图谱
        if (!cachedGraph) {
          return NextResponse.json({
            success: true,
            hasGraph: false,
            message: '尚未进行实体抽取',
          });
        }
        return NextResponse.json({
          success: true,
          hasGraph: true,
          graph: cachedGraph,
        });

      case 'status':
        // 返回抽取状态
        return NextResponse.json({
          success: true,
          inProgress: extractionInProgress,
          progress: currentProgress,
        });

      case 'files':
        // 列出可用于抽取的文件
        const files: Array<{ name: string; path: string; size: number }> = [];
        
        // 检查 uploads 目录
        if (existsSync(UPLOADS_DIR)) {
          const uploadFiles = await readdir(UPLOADS_DIR);
          for (const file of uploadFiles) {
            if (file.endsWith('.txt') || file.endsWith('.md')) {
              const filePath = path.join(UPLOADS_DIR, file);
              const content = await readFile(filePath, 'utf-8');
              files.push({
                name: file,
                path: `uploads/${file}`,
                size: content.length,
              });
            }
          }
        }

        // 检查 reasoning-uploads 目录（解析后的文件）
        if (existsSync(REASONING_UPLOADS_DIR)) {
          const reasoningFiles = await readdir(REASONING_UPLOADS_DIR);
          for (const file of reasoningFiles) {
            if (file.endsWith('_parsed.txt')) {
              const filePath = path.join(REASONING_UPLOADS_DIR, file);
              const content = await readFile(filePath, 'utf-8');
              files.push({
                name: file,
                path: `reasoning-uploads/${file}`,
                size: content.length,
              });
            }
          }
        }

        return NextResponse.json({
          success: true,
          files,
        });

      default:
        return NextResponse.json({
          success: false,
          error: '未知操作',
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Entity Extraction API] GET 错误:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '获取失败',
    }, { status: 500 });
  }
}

/**
 * POST - 执行实体抽取
 */
export async function POST(request: NextRequest) {
  if (extractionInProgress) {
    return NextResponse.json({
      success: false,
      error: '已有抽取任务在进行中',
      progress: currentProgress,
    }, { status: 409 });
  }

  try {
    const body = await request.json();
    const { 
      text,           // 直接提供的文本
      files,          // 文件路径数组
      config,         // 抽取配置
    } = body;

    // 获取要处理的文本
    let contentToProcess = '';
    let documentId = `doc_${Date.now()}`;

    if (text) {
      // 直接使用提供的文本
      contentToProcess = text;
    } else if (files && Array.isArray(files) && files.length > 0) {
      // 从文件读取
      const contents: string[] = [];
      for (const filePath of files) {
        let fullPath: string;
        if (filePath.startsWith('uploads/')) {
          fullPath = path.join(UPLOADS_DIR, filePath.replace('uploads/', ''));
        } else if (filePath.startsWith('reasoning-uploads/')) {
          fullPath = path.join(REASONING_UPLOADS_DIR, filePath.replace('reasoning-uploads/', ''));
        } else {
          fullPath = path.join(process.cwd(), filePath);
        }

        if (existsSync(fullPath)) {
          const content = await readFile(fullPath, 'utf-8');
          contents.push(`=== ${path.basename(fullPath)} ===\n${content}`);
        }
      }
      contentToProcess = contents.join('\n\n');
      documentId = `batch_${Date.now()}`;
    } else {
      return NextResponse.json({
        success: false,
        error: '请提供文本内容或文件路径',
      }, { status: 400 });
    }

    if (!contentToProcess.trim()) {
      return NextResponse.json({
        success: false,
        error: '内容为空',
      }, { status: 400 });
    }

    // 动态导入 EntityExtractor
    const { EntityExtractor: Extractor, DEFAULT_EXTRACTION_CONFIG: defaultConfig } = await getEntityExtractor();
    
    if (!Extractor || !defaultConfig) {
      throw new Error('无法加载实体抽取模块');
    }

    // 合并配置
    const extractionConfig = {
      ...defaultConfig,
      ...config,
    };

    // 开始抽取
    extractionInProgress = true;
    currentProgress = {
      stage: 'starting',
      current: 0,
      total: 1,
      message: '正在初始化抽取器...',
    };

    const extractor = new Extractor(extractionConfig);
    
    // 设置进度回调
    extractor.onProgress((progress) => {
      currentProgress = {
        stage: progress.stage,
        current: progress.current,
        total: progress.total,
        message: progress.message,
      };
    });

    // 执行抽取
    const graph = await extractor.extract(contentToProcess, documentId);
    
    // 序列化并缓存
    cachedGraph = Extractor.serializeGraph(graph);
    
    extractionInProgress = false;
    currentProgress = null;

    return NextResponse.json({
      success: true,
      message: '实体抽取完成',
      summary: {
        entityCount: graph.metadata.entityCount,
        relationCount: graph.metadata.relationCount,
        communityCount: graph.metadata.communityCount,
        documentId: graph.metadata.documentId,
      },
      graph: cachedGraph,
    });

  } catch (error) {
    extractionInProgress = false;
    currentProgress = null;
    
    console.error('[Entity Extraction API] POST 错误:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '抽取失败',
    }, { status: 500 });
  }
}

/**
 * DELETE - 清除知识图谱缓存
 */
export async function DELETE() {
  cachedGraph = null;
  return NextResponse.json({
    success: true,
    message: '知识图谱缓存已清除',
  });
}
