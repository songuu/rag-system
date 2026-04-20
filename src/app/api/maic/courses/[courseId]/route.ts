import { NextRequest, NextResponse } from 'next/server';
import { getMaicStore } from '@/lib/maic/course-store';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
): Promise<NextResponse> {
  const { courseId } = await params;
  const course = getMaicStore().getCourse(courseId);
  if (!course) {
    return NextResponse.json({ success: false, error: '课程不存在' }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: course });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
): Promise<NextResponse> {
  const { courseId } = await params;
  const ok = getMaicStore().deleteCourse(courseId);
  return NextResponse.json({ success: ok });
}
