import { NextRequest, NextResponse } from 'next/server';
import { unlink, readFile, writeFile } from 'fs/promises';
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

// 保存文件清单
async function saveManifest(manifest: Record<string, FileManifestItem>): Promise<void> {
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
}

// DELETE /api/files/[filename] - 删除文件
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;
    const decodedFilename = decodeURIComponent(filename);
    
    // 安全验证：确保文件名不包含路径遍历字符
    if (decodedFilename.includes('..') || decodedFilename.includes('/') || decodedFilename.includes('\\')) {
      return NextResponse.json(
        { error: '无效的文件名' },
        { status: 400 }
      );
    }

    // 加载文件清单
    const manifest = await loadManifest();
    
    // 查找对应的清单项（通过 ID 或原始文件名）
    let manifestItem: FileManifestItem | undefined;
    let manifestKey: string | undefined;
    
    for (const [key, item] of Object.entries(manifest)) {
      if (
        item.id === decodedFilename || 
        item.originalName === decodedFilename ||
        item.storedFilename === decodedFilename ||
        item.parsedFilename === decodedFilename
      ) {
        manifestItem = item;
        manifestKey = key;
        break;
      }
    }

    const deletedFiles: string[] = [];
    const errors: string[] = [];

    if (manifestItem && manifestKey) {
      // 使用新版清单：删除原始文件和解析文件
      
      // 删除原始文件
      const storedPath = path.join(UPLOAD_DIR, manifestItem.storedFilename);
      if (existsSync(storedPath)) {
        try {
          await unlink(storedPath);
          deletedFiles.push(manifestItem.storedFilename);
          console.log(`[Delete] 已删除原始文件: ${storedPath}`);
        } catch (e) {
          errors.push(`删除原始文件失败: ${manifestItem.storedFilename}`);
        }
      }
      
      // 删除解析后的文件
      const parsedPath = path.join(UPLOAD_DIR, manifestItem.parsedFilename);
      if (existsSync(parsedPath)) {
        try {
          await unlink(parsedPath);
          deletedFiles.push(manifestItem.parsedFilename);
          console.log(`[Delete] 已删除解析文件: ${parsedPath}`);
        } catch (e) {
          errors.push(`删除解析文件失败: ${manifestItem.parsedFilename}`);
        }
      }
      
      // 从清单中移除
      delete manifest[manifestKey];
      await saveManifest(manifest);
      console.log(`[Delete] 已从清单中移除: ${manifestItem.originalName}`);

      return NextResponse.json({
        success: true,
        message: `文件 "${manifestItem.originalName}" 删除成功`,
        deletedFiles,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    // 兼容旧版本：直接删除文件
    const filePath = path.join(UPLOAD_DIR, decodedFilename);

    if (!existsSync(filePath)) {
      return NextResponse.json(
        { error: '文件不存在' },
        { status: 404 }
      );
    }

    await unlink(filePath);
    
    // 尝试删除关联的解析文件或原始文件
    const baseName = decodedFilename.replace('_parsed.txt', '').replace(/\.[^.]+$/, '');
    const relatedFiles = [
      `${baseName}_parsed.txt`,
      // 尝试常见扩展名
      `${baseName}.pdf`,
      `${baseName}.docx`,
      `${baseName}.xlsx`,
      `${baseName}.md`,
    ];
    
    for (const relatedFile of relatedFiles) {
      if (relatedFile !== decodedFilename) {
        const relatedPath = path.join(UPLOAD_DIR, relatedFile);
        if (existsSync(relatedPath)) {
          try {
            await unlink(relatedPath);
            deletedFiles.push(relatedFile);
            console.log(`[Delete] 已删除关联文件: ${relatedPath}`);
          } catch (e) {
            // 忽略关联文件删除错误
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `文件 "${decodedFilename}" 删除成功`,
      deletedFiles: [decodedFilename, ...deletedFiles],
    });
  } catch (error) {
    console.error('删除文件错误:', error);
    return NextResponse.json(
      { 
        error: '删除文件失败',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}