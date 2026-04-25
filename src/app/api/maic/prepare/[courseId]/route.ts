import { NextRequest, NextResponse } from 'next/server';
import { createSseResponse } from '@/lib/maic/sse-utils';
import { getPrepareRunner } from '@/lib/maic/pipeline/prepare-runner';
import { getMaicStore } from '@/lib/maic/course-store';
import type { PrepareEvent } from '@/lib/maic/types';

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
): Promise<NextResponse> {
  const { courseId } = await params;
  const course = getMaicStore().getCourse(courseId);
  if (!course) {
    return NextResponse.json({ success: false, error: '课程不存在' }, { status: 404 });
  }
  if (course.status === 'ready' && course.prepared) {
    return NextResponse.json({ success: true, data: { status: 'ready' } });
  }

  const runner = getPrepareRunner();
  if (runner.isRunning(courseId) || course.status === 'preparing') {
    return NextResponse.json({ success: true, data: { status: 'running' } });
  }

  void runner.start(courseId);
  return NextResponse.json({ success: true, data: { status: 'started' } });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
): Promise<Response> {
  const { courseId } = await params;

  return createSseResponse<PrepareEvent>(emitter => {
    const runner = getPrepareRunner();
    const unsubscribe = runner.subscribe(courseId, event => {
      emitter.emit(event);
      if (event.type === 'prepare:done' || event.type === 'prepare:error') {
        emitter.close();
      }
    });

    const course = getMaicStore().getCourse(courseId);
    if (course?.status === 'ready') {
      emitter.emit({
        type: 'prepare:done',
        data: { course_id: courseId, message: '课程已就绪', progress: 1 },
      });
      emitter.close();
    }

    return { cleanup: unsubscribe };
  });
}
