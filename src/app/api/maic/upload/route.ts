import { NextRequest, NextResponse } from 'next/server';
import { parseSlides } from '@/lib/maic/slide-parser';
import { getMaicStore } from '@/lib/maic/course-store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const titleField = form.get('title');

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: '未提供文件' }, { status: 400 });
    }

    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { success: false, error: `文件过大,超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB` },
        { status: 413 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const parsed = await parseSlides(buffer, file.name);

    const course_id = `course_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const title =
      typeof titleField === 'string' && titleField.trim()
        ? titleField.trim()
        : file.name.replace(/\.[^.]+$/, '');

    const course = getMaicStore().createCourse({
      course_id,
      title,
      source_filename: file.name,
      source_text: parsed.pages.map(p => p.raw_text).join('\n\n'),
    });

    return NextResponse.json({
      success: true,
      data: { course_id: course.course_id, title: course.title, pages: parsed.pages.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upload failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
