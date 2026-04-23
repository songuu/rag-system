import { NextRequest, NextResponse } from 'next/server';
import { getMaicStore } from '@/lib/maic/course-store';
import {
  getSessionController,
  ensureSessionForCourse,
} from '@/lib/maic/session/session-controller';
import { DEFAULT_ACTIVE_ROLES } from '@/lib/maic/agents/profiles';

export const runtime = 'nodejs';

interface MessageBody {
  content?: unknown;
  mode?: unknown;
  control?: unknown;
  slide_index?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
): Promise<NextResponse> {
  const { courseId } = await params;
  const store = getMaicStore();
  const course = store.getCourse(courseId);
  if (!course) {
    return NextResponse.json({ success: false, error: '课程不存在' }, { status: 404 });
  }

  let body: MessageBody = {};
  try {
    body = (await req.json()) as MessageBody;
  } catch {
    return NextResponse.json({ success: false, error: 'invalid json' }, { status: 400 });
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const mode = body.mode === 'continuous' || body.mode === 'interactive' ? body.mode : undefined;
  const control = typeof body.control === 'string' ? body.control : undefined;
  const slideIndex = typeof body.slide_index === 'number' ? body.slide_index : undefined;

  const session = ensureSessionForCourse(courseId, DEFAULT_ACTIVE_ROLES);
  const controller = getSessionController();

  if (mode) controller.setMode(session.session_id, mode);
  if (control === 'pause') {
    controller.pause(session.session_id);
    return NextResponse.json({ success: true, data: { control } });
  }
  if (control === 'resume') {
    controller.resume(session.session_id);
    return NextResponse.json({ success: true, data: { control } });
  }
  if (control === 'restart') {
    controller.restart(session.session_id);
    return NextResponse.json({ success: true, data: { control } });
  }
  if (control === 'navigate' && slideIndex !== undefined) {
    controller.navigateTo(session.session_id, slideIndex, course.prepared);
    return NextResponse.json({ success: true, data: { control, slide_index: slideIndex } });
  }

  if (content) {
    const utterance = controller.submitStudentMessage(session.session_id, content);
    return NextResponse.json({ success: true, data: { utterance } });
  }

  return NextResponse.json({ success: true, data: { mode } });
}
