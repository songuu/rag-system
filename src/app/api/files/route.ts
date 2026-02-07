import { NextResponse } from 'next/server';
import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const MANIFEST_FILE = path.join(UPLOAD_DIR, 'file-manifest.json');

// 文件清单项接口
interface FileManifestItem {
  id: string;
  originalName: string;
  originalExtension: string;
  storedFilename: string;
  parsedFilename: string;
  size: number;
  contentLength: number;
  uploadedAt: string;
  parseMethod: string;
  pages?: number;
}

// 加载文件清单
async function loadManifest(): Promise<Record<string, FileManifestItem>> {
  try {
    if (existsSync(MANIFEST_FILE)) {
      const content = await readFile(MANIFEST_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('加载文件清单失败:', error);
  }
  return {};
}

// GET /api/files - 获取文件列表
export async function GET() {
  try {
    // 优先使用文件清单（新版本）
    if (existsSync(MANIFEST_FILE)) {
      const manifest = await loadManifest();
      
      // 返回原始文件信息用于前端展示
      const files = Object.values(manifest).map(item => ({
        id: item.id,
        name: item.originalName,           // 原始文件名（展示用）
        extension: item.originalExtension,  // 原始扩展名（图标用）
        size: item.size,                   // 原始文件大小
        contentLength: item.contentLength, // 解析后文本长度
        modified: item.uploadedAt,
        parseMethod: item.parseMethod,
        pages: item.pages,
        // 内部字段（不展示给用户，但系统需要）
        _storedFilename: item.storedFilename,
        _parsedFilename: item.parsedFilename,
      }));

      return NextResponse.json({
        success: true,
        files,
        version: 'v2',
      });
    }

    // 兼容旧版本：直接在 uploads 根目录的文件
    if (!existsSync(UPLOAD_DIR)) {
      return NextResponse.json({
        success: true,
        files: [],
        version: 'v1',
      });
    }

    const allFiles = await readdir(UPLOAD_DIR);
    
    // 查找解析后的 txt 文件，并尝试匹配原始文件
    const parsedFiles = allFiles.filter(file => file.endsWith('_parsed.txt'));
    
    const fileList = await Promise.all(
      parsedFiles.map(async (parsedFilename) => {
        const filePath = path.join(UPLOAD_DIR, parsedFilename);
        const stats = await stat(filePath);
        
        // 提取基础名称（去掉 _parsed.txt）
        const baseName = parsedFilename.replace('_parsed.txt', '');
        
        // 查找对应的原始文件（非 .txt 文件）
        const originalFile = allFiles.find(f => 
          f.startsWith(baseName) && 
          !f.endsWith('.txt') && 
          !f.endsWith('.json')
        );
        
        // 获取原始文件扩展名
        const extension = originalFile 
          ? path.extname(originalFile).toLowerCase() 
          : '.txt';
        
        // 尝试恢复原始文件名
        const displayName = originalFile || parsedFilename;
        
        return {
          id: baseName,
          name: displayName,
          extension,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          _storedFilename: originalFile || parsedFilename,
          _parsedFilename: parsedFilename,
        };
      })
    );

    return NextResponse.json({
      success: true,
      files: fileList,
      version: 'v1',
    });
  } catch (error) {
    console.error('获取文件列表错误:', error);
    return NextResponse.json(
      { 
        error: '获取文件列表失败',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}