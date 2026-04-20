import { NextRequest, NextResponse } from 'next/server';
import { createSseResponse } from '@/lib/maic/sse-utils';
import { getMaicStore } from '@/lib/maic/course-store';
import {
  getSessionController,
  ensureSessionForCourse,
} from '@/lib/maic/session/session-controller';
import { DEFAULT_ACTIVE_ROLES } from '@/lib/maic/agents/profiles';
import type { ClassroomEvent } from '@/lib/maic/types';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
): Promise<Response> {
  const { courseId } = await params;
  const store = getMaicStore();
  const course = store.getCourse(courseId);
  if (!course) {
    return NextResponse.json({ success: false, error: '课程不存在' }, { status: 404 });
  }
  if (course.status !== 'ready' || !course.prepared) {
    return NextResponse.json(
      { success: false, error: '课程尚未准备完成' },
      { status: 400 }
    );
  }

  const session = ensureSessionForCourse(courseId, DEFAULT_ACTIVE_ROLES);
  const controller = getSessionController();

  return createSseResponse<ClassroomEvent>(emitter => {
    const unsubscribe = controller.subscribe(session.session_id, event => {
      emitter.emit(event);
      if (event.type === 'end') {
        emitter.close();
      }
    });

    emitter.emit({
      type: 'state',
      data: store.getSession(session.session_id)!.state,
    });

    return { cleanup: unsubscribe };
  });
}
