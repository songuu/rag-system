/**
 * MAIC 课程与会话内存存储
 *
 * 单例模式,Map 为底,所有更新均不可变(返回新对象)。
 */

import type {
  Course,
  CourseStatus,
  CoursePrepared,
  ClassroomSession,
  ClassroomState,
  Utterance,
  ClassroomMode,
  AgentRole,
} from './types';

class MaicStore {
  private courses: Map<string, Course> = new Map();
  private sessions: Map<string, ClassroomSession> = new Map();

  // ---------- 课程 ----------

  listCourses(): Course[] {
    return Array.from(this.courses.values()).sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
  }

  getCourse(courseId: string): Course | undefined {
    return this.courses.get(courseId);
  }

  createCourse(input: {
    course_id: string;
    title: string;
    source_filename: string;
    source_text: string;
  }): Course {
    const now = new Date().toISOString();
    const course: Course = {
      ...input,
      status: 'uploaded',
      created_at: now,
      updated_at: now,
    };
    this.courses.set(course.course_id, course);
    return course;
  }

  updateCourseStatus(courseId: string, status: CourseStatus, error?: string): Course | undefined {
    const existing = this.courses.get(courseId);
    if (!existing) return undefined;
    const updated: Course = {
      ...existing,
      status,
      error,
      updated_at: new Date().toISOString(),
    };
    this.courses.set(courseId, updated);
    return updated;
  }

  setCoursePrepared(courseId: string, prepared: CoursePrepared): Course | undefined {
    const existing = this.courses.get(courseId);
    if (!existing) return undefined;
    const updated: Course = {
      ...existing,
      prepared,
      status: 'ready',
      updated_at: new Date().toISOString(),
    };
    this.courses.set(courseId, updated);
    return updated;
  }

  deleteCourse(courseId: string): boolean {
    for (const [sid, sess] of this.sessions.entries()) {
      if (sess.course_id === courseId) this.sessions.delete(sid);
    }
    return this.courses.delete(courseId);
  }

  // ---------- 会话 ----------

  getOrCreateSession(courseId: string, roles: AgentRole[]): ClassroomSession {
    for (const sess of this.sessions.values()) {
      if (sess.course_id === courseId && sess.state.status !== 'ended') {
        return sess;
      }
    }
    return this.createSession(courseId, roles);
  }

  createSession(courseId: string, roles: AgentRole[]): ClassroomSession {
    const now = new Date().toISOString();
    const session: ClassroomSession = {
      session_id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      course_id: courseId,
      state: {
        P_t: 0,
        H_t: [],
        R: roles,
        mode: 'continuous',
        status: 'idle',
        script_cursor: 0,
      },
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(session.session_id, session);
    return session;
  }

  getSession(sessionId: string): ClassroomSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateSessionState(
    sessionId: string,
    patch: Partial<ClassroomState>
  ): ClassroomSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    const updated: ClassroomSession = {
      ...existing,
      state: { ...existing.state, ...patch },
      updated_at: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  appendUtterance(sessionId: string, utterance: Utterance): ClassroomSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    const updated: ClassroomSession = {
      ...existing,
      state: {
        ...existing.state,
        H_t: [...existing.state.H_t, utterance],
      },
      updated_at: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  setSessionMode(sessionId: string, mode: ClassroomMode): ClassroomSession | undefined {
    return this.updateSessionState(sessionId, { mode });
  }
}

let instance: MaicStore | null = null;

export function getMaicStore(): MaicStore {
  if (!instance) instance = new MaicStore();
  return instance;
}

export type { MaicStore };
