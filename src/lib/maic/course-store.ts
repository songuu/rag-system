/**
 * MAIC 课程与会话仓储。
 *
 * 本地开发允许使用进程内实现；启用 PostgreSQL（生产环境强制）后，
 * 所有业务状态都以 tenant/corpus 范围内的 JSONB 记录为唯一事实源。
 */

import type { PostgresQueryClient } from '../postgres/client';
import {
  getPostgresClient,
  queryPostgres,
} from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
  type PostgresRuntimeConfig,
} from '../postgres/env';
import type {
  Course,
  CourseStatus,
  CourseTitleSource,
  CoursePrepared,
  ClassroomSession,
  ClassroomState,
  Utterance,
  ClassroomMode,
  AgentRole,
  SlidePage,
  MaicRagAsset,
} from './types';

export interface CreateCourseInput {
  course_id: string;
  title: string;
  title_source?: CourseTitleSource;
  source_filename: string;
  source_text: string;
  source_pages?: SlidePage[];
  source_hash?: string;
  rag_asset?: MaicRagAsset;
}

export interface MaicStore {
  listCourses(): Promise<Course[]>;
  getCourse(courseId: string): Promise<Course | undefined>;
  createCourse(input: CreateCourseInput): Promise<Course>;
  updateCourseStatus(
    courseId: string,
    status: CourseStatus,
    error?: string
  ): Promise<Course | undefined>;
  setCoursePrepared(courseId: string, prepared: CoursePrepared): Promise<Course | undefined>;
  deleteCourse(courseId: string): Promise<boolean>;
  getOrCreateSession(courseId: string, roles: AgentRole[]): Promise<ClassroomSession>;
  createSession(courseId: string, roles: AgentRole[]): Promise<ClassroomSession>;
  getSession(sessionId: string): Promise<ClassroomSession | undefined>;
  updateSessionState(
    sessionId: string,
    patch: Partial<ClassroomState>
  ): Promise<ClassroomSession | undefined>;
  appendUtterance(
    sessionId: string,
    utterance: Utterance
  ): Promise<ClassroomSession | undefined>;
  setSessionMode(
    sessionId: string,
    mode: ClassroomMode
  ): Promise<ClassroomSession | undefined>;
}

export class MemoryMaicStore implements MaicStore {
  private courses: Map<string, Course> = new Map();
  private sessions: Map<string, ClassroomSession> = new Map();

  async listCourses(): Promise<Course[]> {
    return Array.from(this.courses.values()).sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
  }

  async getCourse(courseId: string): Promise<Course | undefined> {
    return this.courses.get(courseId);
  }

  async createCourse(input: CreateCourseInput): Promise<Course> {
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

  async updateCourseStatus(
    courseId: string,
    status: CourseStatus,
    error?: string
  ): Promise<Course | undefined> {
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

  async setCoursePrepared(
    courseId: string,
    prepared: CoursePrepared
  ): Promise<Course | undefined> {
    const existing = this.courses.get(courseId);
    if (!existing) return undefined;
    const updated = courseWithPrepared(existing, prepared);
    this.courses.set(courseId, updated);
    return updated;
  }

  async deleteCourse(courseId: string): Promise<boolean> {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.course_id === courseId) this.sessions.delete(sessionId);
    }
    return this.courses.delete(courseId);
  }

  async getOrCreateSession(
    courseId: string,
    roles: AgentRole[]
  ): Promise<ClassroomSession> {
    for (const session of this.sessions.values()) {
      if (session.course_id === courseId && session.state.status !== 'ended') {
        return session;
      }
    }
    return await this.createSession(courseId, roles);
  }

  async createSession(courseId: string, roles: AgentRole[]): Promise<ClassroomSession> {
    const session = newSession(courseId, roles);
    this.sessions.set(session.session_id, session);
    return session;
  }

  async getSession(sessionId: string): Promise<ClassroomSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async updateSessionState(
    sessionId: string,
    patch: Partial<ClassroomState>
  ): Promise<ClassroomSession | undefined> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    const updated = sessionWithState(existing, patch);
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async appendUtterance(
    sessionId: string,
    utterance: Utterance
  ): Promise<ClassroomSession | undefined> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    return await this.updateSessionState(sessionId, {
      H_t: [...existing.state.H_t, utterance],
    });
  }

  async setSessionMode(
    sessionId: string,
    mode: ClassroomMode
  ): Promise<ClassroomSession | undefined> {
    return await this.updateSessionState(sessionId, { mode });
  }
}

interface VersionedPayloadRow {
  payload: unknown;
  version: string | number;
}

interface PayloadRow {
  payload: unknown;
}

const MAX_OPTIMISTIC_UPDATE_ATTEMPTS = 5;

export class PostgresMaicStore implements MaicStore {
  private readonly config: PostgresRuntimeConfig;
  private readonly client: PostgresQueryClient;

  constructor(
    config: PostgresRuntimeConfig,
    client: PostgresQueryClient
  ) {
    assertPostgresPersistenceConfigured(config);
    this.config = config;
    this.client = client;
  }

  async listCourses(): Promise<Course[]> {
    const result = await queryPostgres<PayloadRow>(
      this.client,
      `select payload
       from public.maic_courses
       where tenant_id = $1 and corpus_id = $2
       order by created_at desc, course_id asc`,
      this.scopeValues(),
      'list MAIC courses'
    );
    return result.rows.map(row => parseCoursePayload(row.payload));
  }

  async getCourse(courseId: string): Promise<Course | undefined> {
    const result = await queryPostgres<PayloadRow>(
      this.client,
      `select payload
       from public.maic_courses
       where tenant_id = $1 and corpus_id = $2 and course_id = $3`,
      [...this.scopeValues(), courseId],
      'load MAIC course'
    );
    return result.rows[0] ? parseCoursePayload(result.rows[0].payload) : undefined;
  }

  async createCourse(input: CreateCourseInput): Promise<Course> {
    const now = new Date().toISOString();
    const course: Course = {
      ...input,
      status: 'uploaded',
      created_at: now,
      updated_at: now,
    };
    const result = await queryPostgres<VersionedPayloadRow>(
      this.client,
      `insert into public.maic_courses (
         tenant_id, corpus_id, course_id, payload, version
       ) values ($1, $2, $3, $4::jsonb, 1)
       returning payload, version`,
      [...this.scopeValues(), course.course_id, serializePayload(course)],
      'create MAIC course'
    );
    return parseCoursePayload(requireRow(result.rows[0], 'created MAIC course').payload);
  }

  async updateCourseStatus(
    courseId: string,
    status: CourseStatus,
    error?: string
  ): Promise<Course | undefined> {
    return await this.mutateCourse(courseId, existing => ({
      ...existing,
      status,
      error,
      updated_at: new Date().toISOString(),
    }));
  }

  async setCoursePrepared(
    courseId: string,
    prepared: CoursePrepared
  ): Promise<Course | undefined> {
    return await this.mutateCourse(courseId, existing => courseWithPrepared(existing, prepared));
  }

  async deleteCourse(courseId: string): Promise<boolean> {
    const result = await queryPostgres<{ course_id: string }>(
      this.client,
      `delete from public.maic_courses
       where tenant_id = $1 and corpus_id = $2 and course_id = $3
       returning course_id`,
      [...this.scopeValues(), courseId],
      'delete MAIC course'
    );
    return result.rowCount === 1;
  }

  async getOrCreateSession(
    courseId: string,
    roles: AgentRole[]
  ): Promise<ClassroomSession> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.findActiveSession(courseId);
      if (existing) return existing;

      const session = newSession(courseId, roles);
      const inserted = await queryPostgres<VersionedPayloadRow>(
        this.client,
        `insert into public.maic_classroom_sessions (
           tenant_id, corpus_id, course_id, session_id, payload, version
         ) values ($1, $2, $3, $4, $5::jsonb, 1)
         on conflict (tenant_id, corpus_id, course_id)
           where ((payload #>> '{state,status}') <> 'ended')
         do nothing
         returning payload, version`,
        [
          ...this.scopeValues(),
          courseId,
          session.session_id,
          serializePayload(session),
        ],
        'create active MAIC classroom session'
      );
      if (inserted.rows[0]) return parseSessionPayload(inserted.rows[0].payload);
    }

    const winner = await this.findActiveSession(courseId);
    if (winner) return winner;
    throw new Error('MAIC classroom session could not be created after concurrent updates.');
  }

  async createSession(courseId: string, roles: AgentRole[]): Promise<ClassroomSession> {
    const session = newSession(courseId, roles);
    const result = await queryPostgres<VersionedPayloadRow>(
      this.client,
      `insert into public.maic_classroom_sessions (
         tenant_id, corpus_id, course_id, session_id, payload, version
       ) values ($1, $2, $3, $4, $5::jsonb, 1)
       returning payload, version`,
      [
        ...this.scopeValues(),
        courseId,
        session.session_id,
        serializePayload(session),
      ],
      'create MAIC classroom session'
    );
    return parseSessionPayload(requireRow(result.rows[0], 'created MAIC session').payload);
  }

  async getSession(sessionId: string): Promise<ClassroomSession | undefined> {
    const result = await queryPostgres<PayloadRow>(
      this.client,
      `select payload
       from public.maic_classroom_sessions
       where tenant_id = $1 and corpus_id = $2 and session_id = $3`,
      [...this.scopeValues(), sessionId],
      'load MAIC classroom session'
    );
    return result.rows[0] ? parseSessionPayload(result.rows[0].payload) : undefined;
  }

  async updateSessionState(
    sessionId: string,
    patch: Partial<ClassroomState>
  ): Promise<ClassroomSession | undefined> {
    return await this.mutateSession(sessionId, existing => sessionWithState(existing, patch));
  }

  async appendUtterance(
    sessionId: string,
    utterance: Utterance
  ): Promise<ClassroomSession | undefined> {
    return await this.mutateSession(sessionId, existing => sessionWithState(existing, {
      H_t: [...existing.state.H_t, utterance],
    }));
  }

  async setSessionMode(
    sessionId: string,
    mode: ClassroomMode
  ): Promise<ClassroomSession | undefined> {
    return await this.updateSessionState(sessionId, { mode });
  }

  private async findActiveSession(courseId: string): Promise<ClassroomSession | undefined> {
    const result = await queryPostgres<PayloadRow>(
      this.client,
      `select payload
       from public.maic_classroom_sessions
       where tenant_id = $1 and corpus_id = $2 and course_id = $3
         and payload #>> '{state,status}' <> 'ended'
       order by created_at desc
       limit 1`,
      [...this.scopeValues(), courseId],
      'load active MAIC classroom session'
    );
    return result.rows[0] ? parseSessionPayload(result.rows[0].payload) : undefined;
  }

  private async mutateCourse(
    courseId: string,
    mutate: (course: Course) => Course
  ): Promise<Course | undefined> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await queryPostgres<VersionedPayloadRow>(
        this.client,
        `select payload, version
         from public.maic_courses
         where tenant_id = $1 and corpus_id = $2 and course_id = $3`,
        [...this.scopeValues(), courseId],
        'load MAIC course for update'
      );
      const row = current.rows[0];
      if (!row) return undefined;
      const next = mutate(parseCoursePayload(row.payload));
      const updated = await queryPostgres<VersionedPayloadRow>(
        this.client,
        `update public.maic_courses
         set payload = $4::jsonb, version = version + 1, updated_at = now()
         where tenant_id = $1 and corpus_id = $2 and course_id = $3 and version = $5
         returning payload, version`,
        [...this.scopeValues(), courseId, serializePayload(next), Number(row.version)],
        'update MAIC course'
      );
      if (updated.rows[0]) return parseCoursePayload(updated.rows[0].payload);
    }
    throw new Error('MAIC course update conflicted too many times.');
  }

  private async mutateSession(
    sessionId: string,
    mutate: (session: ClassroomSession) => ClassroomSession
  ): Promise<ClassroomSession | undefined> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await queryPostgres<VersionedPayloadRow>(
        this.client,
        `select payload, version
         from public.maic_classroom_sessions
         where tenant_id = $1 and corpus_id = $2 and session_id = $3`,
        [...this.scopeValues(), sessionId],
        'load MAIC classroom session for update'
      );
      const row = current.rows[0];
      if (!row) return undefined;
      const next = mutate(parseSessionPayload(row.payload));
      const updated = await queryPostgres<VersionedPayloadRow>(
        this.client,
        `update public.maic_classroom_sessions
         set payload = $4::jsonb, version = version + 1, updated_at = now()
         where tenant_id = $1 and corpus_id = $2 and session_id = $3 and version = $5
         returning payload, version`,
        [...this.scopeValues(), sessionId, serializePayload(next), Number(row.version)],
        'update MAIC classroom session'
      );
      if (updated.rows[0]) return parseSessionPayload(updated.rows[0].payload);
    }
    throw new Error('MAIC classroom session update conflicted too many times.');
  }

  private scopeValues(): [string, string] {
    return [this.config.defaultTenantId, this.config.defaultCorpusId];
  }
}

let memoryStore: MemoryMaicStore | null = null;

export function createMaicStore(
  config: PostgresRuntimeConfig,
  client: PostgresQueryClient | null = null
): MaicStore {
  if (shouldUsePostgresPersistence(config)) {
    assertPostgresPersistenceConfigured(config);
    const postgresClient = client ?? getPostgresClient(config);
    if (!postgresClient) throw new Error('PostgreSQL persistence requires DATABASE_URL.');
    return new PostgresMaicStore(config, postgresClient);
  }
  memoryStore ??= new MemoryMaicStore();
  return memoryStore;
}

export function getMaicStore(): MaicStore {
  const config = getPostgresRuntimeConfig();
  return createMaicStore(config);
}

function courseWithPrepared(course: Course, prepared: CoursePrepared): Course {
  const generatedTitle = resolveGeneratedCourseTitle(course, prepared);
  return {
    ...course,
    prepared,
    title: generatedTitle ?? course.title,
    title_source: generatedTitle ? 'generated' : course.title_source,
    status: 'ready',
    error: undefined,
    updated_at: new Date().toISOString(),
  };
}

function sessionWithState(
  session: ClassroomSession,
  patch: Partial<ClassroomState>
): ClassroomSession {
  return {
    ...session,
    state: { ...session.state, ...patch },
    updated_at: new Date().toISOString(),
  };
}

function newSession(courseId: string, roles: AgentRole[]): ClassroomSession {
  const now = new Date().toISOString();
  return {
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
}

function serializePayload(payload: Course | ClassroomSession): string {
  return JSON.stringify(payload);
}

function parseCoursePayload(payload: unknown): Course {
  if (!isRecord(payload) || typeof payload.course_id !== 'string') {
    throw new Error('PostgreSQL returned an invalid MAIC course payload.');
  }
  return payload as unknown as Course;
}

function parseSessionPayload(payload: unknown): ClassroomSession {
  if (
    !isRecord(payload)
    || typeof payload.session_id !== 'string'
    || typeof payload.course_id !== 'string'
    || !isRecord(payload.state)
  ) {
    throw new Error('PostgreSQL returned an invalid MAIC classroom session payload.');
  }
  return payload as unknown as ClassroomSession;
}

function requireRow<T>(row: T | undefined, context: string): T {
  if (!row) throw new Error(`PostgreSQL did not return the ${context}.`);
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveGeneratedCourseTitle(course: Course, prepared: CoursePrepared): string | null {
  if (course.title_source === 'user') return null;
  const title = prepared.stage?.title?.replace(/\s+/g, ' ')?.trim();
  if (!title || title.length < 2) return null;
  if (/^(课程主题|课程大纲|未命名|OpenMAIC\s*课堂)$/i.test(title)) return null;
  return title.length > 36 ? `${title.slice(0, 34)}…` : title;
}
