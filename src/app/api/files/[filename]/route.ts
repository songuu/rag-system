import { NextRequest, NextResponse } from 'next/server';
import { createLegacyRagRouteResponse } from '@/lib/security/legacy-route-policy';
import path from 'path';
import { createUploadPersistence } from '@/lib/persistence/upload-store';
import type { FileManifestItem } from '@/lib/persistence/ports';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const MANIFEST_FILE = path.join(UPLOAD_DIR, 'file-manifest.json');

// DELETE /api/files/[filename] - 删除文件
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const unavailable = createLegacyRagRouteResponse();
  if (unavailable) return unavailable;
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

    const { blobStore, manifestStore } = createUploadPersistence({
      uploadDir: UPLOAD_DIR,
      manifestFile: MANIFEST_FILE,
    });

    // 加载文件清单
    const manifest = await manifestStore.loadManifest();
    
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
      if (await blobStore.exists(manifestItem.storedFilename)) {
        try {
          await blobStore.delete(manifestItem.storedFilename);
          deletedFiles.push(manifestItem.storedFilename);
          console.log(`[Delete] 已删除原始文件: ${manifestItem.storedFilename}`);
        } catch (error) {
          console.warn(`[Delete] 删除原始文件失败: ${manifestItem.storedFilename}`, error);
          errors.push(`删除原始文件失败: ${manifestItem.storedFilename}`);
        }
      }
      
      // 删除解析后的文件
      if (await blobStore.exists(manifestItem.parsedFilename)) {
        try {
          await blobStore.delete(manifestItem.parsedFilename);
          deletedFiles.push(manifestItem.parsedFilename);
          console.log(`[Delete] 已删除解析文件: ${manifestItem.parsedFilename}`);
        } catch (error) {
          console.warn(`[Delete] 删除解析文件失败: ${manifestItem.parsedFilename}`, error);
          errors.push(`删除解析文件失败: ${manifestItem.parsedFilename}`);
        }
      }
      
      // 从清单中移除
      delete manifest[manifestKey];
      await manifestStore.saveManifest(manifest);
      console.log(`[Delete] 已从清单中移除: ${manifestItem.originalName}`);

      return NextResponse.json({
        success: true,
        message: `文件 "${manifestItem.originalName}" 删除成功`,
        deletedFiles,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    // 兼容旧版本：直接删除文件
    if (!await blobStore.exists(decodedFilename)) {
      return NextResponse.json(
        { error: '文件不存在' },
        { status: 404 }
      );
    }

    await blobStore.delete(decodedFilename);
    
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
        if (await blobStore.exists(relatedFile)) {
          try {
            await blobStore.delete(relatedFile);
            deletedFiles.push(relatedFile);
            console.log(`[Delete] 已删除关联文件: ${relatedFile}`);
          } catch (error) {
            console.warn(`[Delete] 删除关联文件失败: ${relatedFile}`, error);
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
