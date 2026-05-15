import { NextResponse } from 'next/server';
import path from 'path';
import { createUploadPersistence } from '@/lib/persistence/upload-store';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const MANIFEST_FILE = path.join(UPLOAD_DIR, 'file-manifest.json');

// GET /api/files - 获取文件列表
export async function GET() {
  try {
    const { blobStore, manifestStore } = createUploadPersistence({
      uploadDir: UPLOAD_DIR,
      manifestFile: MANIFEST_FILE,
    });
    const manifest = await manifestStore.loadManifest();

    // 优先使用文件清单（新版本）
    if (Object.keys(manifest).length > 0) {
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
    const allFiles = await blobStore.list();
    if (allFiles.length === 0) {
      return NextResponse.json({
        success: true,
        files: [],
        version: 'v1',
      });
    }

    // 查找解析后的 txt 文件，并尝试匹配原始文件
    const parsedFiles = allFiles.filter(file => file.endsWith('_parsed.txt'));
    
    const fileList = await Promise.all(
      parsedFiles.map(async (parsedFilename) => {
        const stats = await blobStore.stat(parsedFilename);
        
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
          modified: stats.modified,
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
