/**
 * PDF 种子文件上传 API
 *
 * POST /api/mirofish/upload - 接收 PDF 文件并抽取文本
 *
 * 仅支持 application/pdf，单文件 ≤10MB
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = 'application/pdf';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: '未提供文件或文件格式错误' },
        { status: 400 }
      );
    }

    // MIME 类型校验（前端也检查，但后端必须独立校验）
    if (file.type !== ALLOWED_MIME) {
      return NextResponse.json(
        { success: false, error: '仅支持 PDF 文件' },
        { status: 400 }
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { success: false, error: '文件为空' },
        { status: 400 }
      );
    }

    if (file.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        { success: false, error: `文件大小不能超过 ${MAX_PDF_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // pdf-parse v2.x: 使用 PDFParse 类实例 (与 document-parser.ts 一致)
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });

    const textResult = await parser.getText();
    const infoResult = await parser.getInfo();
    await parser.destroy();

    const text = (textResult.text || '').trim();
    if (!text) {
      return NextResponse.json(
        { success: false, error: '无法从 PDF 中抽取文本（可能是扫描件）' },
        { status: 422 }
      );
    }

    // 文件名消毒（保留中英文、数字、点、连字符）
    const safeFilename = file.name
      .replace(/[^\w\s\u4e00-\u9fff.-]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 120);

    return NextResponse.json({
      success: true,
      text,
      pages: infoResult.total ?? 0,
      filename: safeFilename || 'document.pdf',
      size: file.size,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'PDF 解析失败',
      },
      { status: 500 }
    );
  }
}
