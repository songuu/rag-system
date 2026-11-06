/**
 * Bounded PDF/Markdown/TXT seed upload API.
 *
 * POST /api/mirofish/upload - Parse up to 10 PDF/Markdown/TXT files, 50 MiB total.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { MiroFishSeedFileError, parseMiroFishSeedFiles, readMiroFishSeedForm } from '@/lib/mirofish/seed-files';
import { createStableErrorLog } from '@/lib/security/error-redaction';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { RagSecurityError } from '@/lib/security/request-context';
import { miroFishProjectApiError } from '@/lib/mirofish/project-api-response';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    await resolveMiroFishRequestScope(request, 'ingest');
    const formData = await readMiroFishSeedForm(request);
    const repeated = formData.getAll('files');
    const files = repeated.length ? repeated : formData.getAll('file');

    if (!files.length || files.some(file => !(file instanceof File))) {
      return NextResponse.json(
        { success: false, error: '未提供文件或文件格式错误' },
        { status: 400 }
      );
    }

    const result = await parseMiroFishSeedFiles(files as File[]);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof RagSecurityError) return miroFishProjectApiError(error, '无法上传种子文件');
    if (error instanceof MiroFishSeedFileError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    console.error('[MiroFish Upload] seed parsing failed', createStableErrorLog(error));
    return NextResponse.json(
      {
        success: false,
        error: '文件解析失败，请检查文件后重试',
      },
      { status: 500 }
    );
  }
}
