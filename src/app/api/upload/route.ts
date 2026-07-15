import { NextRequest, NextResponse } from 'next/server';
import { createLegacyRagRouteResponse } from '@/lib/security/legacy-route-policy';
import path from 'path';
import { 
  parseDocument, 
  isSupportedFile, 
  getSupportedTypesDescription,
  SUPPORTED_EXTENSIONS,
  getFileExtension
} from '@/lib/document-parser';
import { createUploadPersistence } from '@/lib/persistence/upload-store';
import type { FileManifestItem } from '@/lib/persistence/ports';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const METADATA_FILE = path.join(UPLOAD_DIR, 'file-manifest.json');  // 文件清单
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(request: NextRequest) {
  const unavailable = createLegacyRagRouteResponse();
  if (unavailable) return unavailable;
  try {
    const { blobStore, manifestStore } = createUploadPersistence({
      uploadDir: UPLOAD_DIR,
      manifestFile: METADATA_FILE,
    });
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { error: '请选择要上传的文件' },
        { status: 400 }
      );
    }

    await blobStore.ensureRoot();

    // 加载现有文件清单
    const manifest = await manifestStore.loadManifest();

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

        // 生成唯一 ID
        const timestamp = Date.now();
        const fileId = `${timestamp}_${Math.random().toString(36).substring(2, 8)}`;
        const ext = getFileExtension(file.name);
        const baseName = path.basename(file.name, ext);
        
        // 1. 保存原始文件（保持原始格式，用于下载/预览）
        // 文件名格式: {timestamp}_{originalBaseName}{ext}
        const storedFilename = `${timestamp}_${baseName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_')}${ext}`;
        await blobStore.write(storedFilename, buffer, {
          kind: 'raw',
          contentType: file.type || 'application/octet-stream',
        });
        console.log(`[Upload] 原始文件已保存: ${storedFilename}`);
        
        // 2. 保存解析后的文本内容（用于 RAG 向量化处理）
        // 文件名格式: {timestamp}_{originalBaseName}_parsed.txt
        const parsedFilename = `${timestamp}_${baseName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_')}_parsed.txt`;
        await blobStore.write(parsedFilename, parseResult.document.content, {
          kind: 'parsed',
          contentType: 'text/plain; charset=utf-8',
        });
        console.log(`[Upload] 解析文本已保存: ${parsedFilename} (用于 RAG)`);

        // 3. 保存到文件清单
        const manifestItem: FileManifestItem = {
          id: fileId,
          originalName: file.name,           // 原始文件名（展示用）
          originalExtension: ext,            // 原始扩展名（图标用）
          storedFilename,                    // 存储的原始文件
          parsedFilename,                    // 解析后的文本文件（RAG用）
          size: file.size,
          contentLength: parseResult.document.content.length,
          uploadedAt: new Date().toISOString(),
          parseMethod: parseResult.document.metadata.parseMethod,
          pages: parseResult.document.metadata.pages,
        };
        
        manifest[fileId] = manifestItem;

        results.push({
          id: fileId,
          filename: file.name,
          extension: ext,
          storedFilename,
          parsedFilename,
          size: file.size,
          contentLength: parseResult.document.content.length,
          metadata: parseResult.document.metadata,
        });

      } catch (error) {
        console.error(`处理文件 ${file.name} 时出错:`, error);
        errors.push({
          filename: file.name,
          error: error instanceof Error ? error.message : '上传失败'
        });
      }
    }

    // 保存更新后的文件清单
    await manifestStore.saveManifest(manifest);

    return NextResponse.json({
      success: true,
      message: `成功上传 ${results.length} 个文件`,
      results,
      errors: errors.length > 0 ? errors : undefined,
      supportedTypes: SUPPORTED_EXTENSIONS
    });

  } catch (error) {
    console.error('文件上传错误:', error);
    return NextResponse.json(
      { 
        error: '处理文件上传时发生错误',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

// GET 端点返回支持的文件类型
export async function GET() {
  const unavailable = createLegacyRagRouteResponse();
  if (unavailable) return unavailable;
  return NextResponse.json({
    supportedExtensions: SUPPORTED_EXTENSIONS,
    description: getSupportedTypesDescription(),
    maxSize: MAX_FILE_SIZE,
    maxSizeFormatted: `${MAX_FILE_SIZE / 1024 / 1024}MB`
  });
}
