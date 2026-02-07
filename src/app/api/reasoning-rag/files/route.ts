/**
 * Reasoning RAG 独立文件管理 API
 * 使用独立的上传目录和 Milvus 集合，与主页面完全分离
 */

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { 
  parseDocument, 
  isSupportedFile, 
  getSupportedTypesDescription,
  SUPPORTED_EXTENSIONS 
} from '@/lib/document-parser';

// Reasoning RAG 专用上传目录
const REASONING_UPLOAD_DIR = path.join(process.cwd(), 'reasoning-uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// 文件类型图标映射
const FILE_ICONS: Record<string, { icon: string; color: string; label: string }> = {
  '.pdf': { icon: '📕', color: 'red', label: 'PDF' },
  '.xlsx': { icon: '📊', color: 'green', label: 'Excel' },
  '.xls': { icon: '📊', color: 'green', label: 'Excel' },
  '.csv': { icon: '📋', color: 'green', label: 'CSV' },
  '.docx': { icon: '📘', color: 'blue', label: 'Word' },
  '.doc': { icon: '📘', color: 'blue', label: 'Word' },
  '.md': { icon: '📝', color: 'purple', label: 'Markdown' },
  '.markdown': { icon: '📝', color: 'purple', label: 'Markdown' },
  '.json': { icon: '🔧', color: 'yellow', label: 'JSON' },
  '.txt': { icon: '📄', color: 'gray', label: 'Text' },
};

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

function getFileInfo(filename: string) {
  const ext = getFileExtension(filename);
  return FILE_ICONS[ext] || { icon: '📄', color: 'gray', label: '文件' };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * POST: 上传文件到 Reasoning RAG 专用目录
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { success: false, error: '请选择要上传的文件' },
        { status: 400 }
      );
    }

    // 确保上传目录存在
    if (!existsSync(REASONING_UPLOAD_DIR)) {
      await mkdir(REASONING_UPLOAD_DIR, { recursive: true });
    }

    const results = [];
    const errors = [];

    for (const file of files) {
      try {
        // 验证文件类型
        if (!isSupportedFile(file.name)) {
          errors.push({
            filename: file.name,
            error: `不支持的文件类型。${getSupportedTypesDescription()}`
          });
          continue;
        }

        // 验证文件大小
        if (file.size > MAX_FILE_SIZE) {
          errors.push({
            filename: file.name,
            error: `文件太大，最大支持 ${MAX_FILE_SIZE / 1024 / 1024}MB`
          });
          continue;
        }

        // 读取文件内容
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);
        
        // 解析文档内容
        const parseResult = await parseDocument(buffer, file.name);
        
        if (!parseResult.success || !parseResult.document) {
          errors.push({
            filename: file.name,
            error: parseResult.error || '文件解析失败'
          });
          continue;
        }

        // 生成安全的文件名
        const timestamp = Date.now();
        const safeFilename = `${timestamp}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const originalFilePath = path.join(REASONING_UPLOAD_DIR, safeFilename);
        
        // 保存原始文件
        await writeFile(originalFilePath, buffer);
        
        // 同时保存解析后的文本内容（.txt 格式）
        const textFilename = `${timestamp}_${path.basename(file.name, path.extname(file.name))}_parsed.txt`;
        const textFilePath = path.join(REASONING_UPLOAD_DIR, textFilename);
        await writeFile(textFilePath, parseResult.document.content, 'utf-8');

        results.push({
          filename: file.name,
          savedAs: safeFilename,
          textFile: textFilename,
          size: file.size,
          sizeFormatted: formatFileSize(file.size),
          contentLength: parseResult.document.content.length,
          metadata: parseResult.document.metadata,
          fileInfo: getFileInfo(file.name),
          path: originalFilePath
        });

      } catch (error) {
        console.error(`[Reasoning Files] 处理文件 ${file.name} 时出错:`, error);
        errors.push({
          filename: file.name,
          error: error instanceof Error ? error.message : '上传失败'
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `成功上传 ${results.length} 个文件到 Reasoning RAG`,
      results,
      errors: errors.length > 0 ? errors : undefined,
      supportedTypes: SUPPORTED_EXTENSIONS,
      uploadDir: 'reasoning-uploads'
    });

  } catch (error) {
    console.error('[Reasoning Files] 文件上传错误:', error);
    return NextResponse.json(
      { 
        success: false,
        error: '处理文件上传时发生错误',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

/**
 * GET: 获取 Reasoning RAG 专用目录中的文件列表
 */
export async function GET() {
  try {
    // 确保目录存在
    if (!existsSync(REASONING_UPLOAD_DIR)) {
      await mkdir(REASONING_UPLOAD_DIR, { recursive: true });
      return NextResponse.json({
        success: true,
        files: [],
        totalSize: 0,
        totalSizeFormatted: '0 B',
        uploadDir: 'reasoning-uploads',
        supportedTypes: SUPPORTED_EXTENSIONS
      });
    }

    const allFiles = await readdir(REASONING_UPLOAD_DIR);
    
    // 过滤出文本文件（用于向量化）
    const textFiles = allFiles.filter(f => f.endsWith('_parsed.txt'));
    
    // 获取原始文件列表（排除 _parsed.txt 文件）
    const originalFiles = allFiles.filter(f => !f.endsWith('_parsed.txt'));
    
    const files = [];
    let totalSize = 0;

    for (const filename of originalFiles) {
      try {
        const filePath = path.join(REASONING_UPLOAD_DIR, filename);
        const fileStat = await stat(filePath);
        
        // 提取原始文件名
        const parts = filename.split('_');
        const timestamp = parseInt(parts[0], 10);
        const originalName = parts.slice(1).join('_');
        
        // 查找对应的解析后文本文件
        const baseName = path.basename(filename, path.extname(filename));
        const textFileName = textFiles.find(tf => {
          const tfParts = tf.split('_');
          return tfParts[0] === parts[0]; // 匹配时间戳
        });
        
        files.push({
          filename,
          originalName,
          size: fileStat.size,
          sizeFormatted: formatFileSize(fileStat.size),
          createdAt: new Date(timestamp).toISOString(),
          fileInfo: getFileInfo(originalName),
          textFile: textFileName || null,
          isVectorizable: !!textFileName
        });
        
        totalSize += fileStat.size;
      } catch (error) {
        console.error(`[Reasoning Files] 读取文件 ${filename} 信息失败:`, error);
      }
    }

    // 按创建时间排序（最新的在前）
    files.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json({
      success: true,
      files,
      textFiles: textFiles.length,
      totalCount: files.length,
      totalSize,
      totalSizeFormatted: formatFileSize(totalSize),
      uploadDir: 'reasoning-uploads',
      supportedTypes: SUPPORTED_EXTENSIONS
    });

  } catch (error) {
    console.error('[Reasoning Files] 获取文件列表错误:', error);
    return NextResponse.json(
      { 
        success: false,
        error: '获取文件列表失败',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE: 删除 Reasoning RAG 专用目录中的文件
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get('filename');

    if (!filename) {
      return NextResponse.json(
        { success: false, error: '请指定要删除的文件名' },
        { status: 400 }
      );
    }

    const filePath = path.join(REASONING_UPLOAD_DIR, filename);

    // 检查文件是否存在
    if (!existsSync(filePath)) {
      return NextResponse.json(
        { success: false, error: '文件不存在' },
        { status: 404 }
      );
    }

    // 删除原始文件
    await unlink(filePath);

    // 尝试删除对应的解析后文本文件
    const parts = filename.split('_');
    const timestamp = parts[0];
    const baseName = path.basename(filename, path.extname(filename));
    
    // 查找并删除 _parsed.txt 文件
    const allFiles = await readdir(REASONING_UPLOAD_DIR);
    const textFile = allFiles.find(f => 
      f.startsWith(timestamp) && f.endsWith('_parsed.txt')
    );
    
    if (textFile) {
      const textFilePath = path.join(REASONING_UPLOAD_DIR, textFile);
      try {
        await unlink(textFilePath);
      } catch (e) {
        console.warn(`[Reasoning Files] 删除文本文件失败: ${textFile}`);
      }
    }

    return NextResponse.json({
      success: true,
      message: `成功删除文件: ${filename}`,
      deletedFiles: textFile ? [filename, textFile] : [filename]
    });

  } catch (error) {
    console.error('[Reasoning Files] 删除文件错误:', error);
    return NextResponse.json(
      { 
        success: false,
        error: '删除文件失败',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
