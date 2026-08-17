import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  MemoryMaicStore,
  PostgresMaicStore,
  createMaicStore,
} = await import('./course-store.ts');

const POSTGRES_CONFIG = {
  databaseUrl: 'postgresql://rag:secret@db.internal:5432/rag',
  defaultTenantId: 'tenant-maic',
  defaultCorpusId: 'corpus-maic',
  sslMode: 'disable',
  maxConnections: 4,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  persistenceBackend: 'postgres',
  vectorBackend: 'milvus',
};

test('setCoursePrepared adopts generated title for filename-derived courses', async () => {
  const store = new MemoryMaicStore();
  const courseId = `course_generated_title_${Date.now()}`;
  await store.createCourse({
    course_id: courseId,
    title: 'upload-file',
    title_source: 'filename',
    source_filename: 'upload-file.pdf',
    source_text: 'source',
  });

  const updated = await store.setCoursePrepared(courseId, prepared('生物化学入门'));

  assert.equal(updated?.title, '生物化学入门');
  assert.equal(updated?.title_source, 'generated');
});

test('setCoursePrepared ignores generic generated course titles', async () => {
  const store = new MemoryMaicStore();
  const courseId = `course_generic_title_${Date.now()}`;
  await store.createCourse({
    course_id: courseId,
    title: 'source-file',
    title_source: 'filename',
    source_filename: 'source-file.pdf',
    source_text: 'source',
  });

  const updated = await store.setCoursePrepared(courseId, prepared('OpenMAIC 课堂'));

  assert.equal(updated?.title, 'source-file');
  assert.equal(updated?.title_source, 'filename');
});
test('setCoursePrepared preserves user-supplied course title', async () => {
  const store = new MemoryMaicStore();
  const courseId = `course_user_title_${Date.now()}`;
  await store.createCourse({
    course_id: courseId,
    title: '我的自定义标题',
    title_source: 'user',
    source_filename: 'source.pdf',
    source_text: 'source',
  });

  const updated = await store.setCoursePrepared(courseId, prepared('自动生成标题'));

  assert.equal(updated?.title, '我的自定义标题');
  assert.equal(updated?.title_source, 'user');
});

test('PostgreSQL store scopes course and session JSON to the configured tenant and corpus', async () => {
  const database = createFakeMaicDatabase();
  const store = new PostgresMaicStore(POSTGRES_CONFIG, database.client);
  const course = await store.createCourse({
    course_id: 'course-pg',
    title: 'PostgreSQL course',
    source_filename: 'course.pdf',
    source_text: 'source',
  });
  const session = await store.getOrCreateSession('course-pg', ['teacher', 'manager']);
  await store.appendUtterance(session.session_id, {
    id: 'utt-1',
    speaker: 'student',
    speaker_name: '我',
    content: 'hello',
    timestamp: '2026-08-17T00:00:00.000Z',
  });

  assert.equal((await store.getCourse(course.course_id))?.title, 'PostgreSQL course');
  assert.equal((await store.getSession(session.session_id))?.state.H_t[0]?.content, 'hello');
  assert.ok(database.calls.every(({ values }) => (
    values.length < 2
    || (values[0] === POSTGRES_CONFIG.defaultTenantId
      && values[1] === POSTGRES_CONFIG.defaultCorpusId)
  )));
});

test('PostgreSQL store retries a lost optimistic update instead of overwriting newer JSON', async () => {
  const database = createFakeMaicDatabase({ loseFirstCourseUpdate: true });
  const store = new PostgresMaicStore(POSTGRES_CONFIG, database.client);
  await store.createCourse({
    course_id: 'course-cas',
    title: 'CAS course',
    source_filename: 'course.pdf',
    source_text: 'source',
  });

  const updated = await store.updateCourseStatus('course-cas', 'preparing');

  assert.equal(updated?.status, 'preparing');
  assert.equal(database.courseUpdateAttempts, 2);
  assert.equal(database.courses.get('course-cas')?.version, 2);
});

test('PostgreSQL store relies on scoped database cascade when deleting a course', async () => {
  const database = createFakeMaicDatabase();
  const store = new PostgresMaicStore(POSTGRES_CONFIG, database.client);
  await store.createCourse({
    course_id: 'course-delete',
    title: 'Delete course',
    source_filename: 'course.pdf',
    source_text: 'source',
  });
  const session = await store.createSession('course-delete', ['teacher']);

  assert.equal(await store.deleteCourse('course-delete'), true);
  assert.equal(await store.getSession(session.session_id), undefined);
});

test('PostgreSQL mode fails closed when the database is not fully configured', () => {
  assert.throws(
    () => createMaicStore({ ...POSTGRES_CONFIG, databaseUrl: '' }, null),
    /PostgreSQL persistence requires DATABASE_URL/i
  );
});

test('local development keeps the explicit in-memory MAIC implementation', async () => {
  const store = createMaicStore({
    ...POSTGRES_CONFIG,
    databaseUrl: '',
    persistenceBackend: 'local',
  }, null);
  assert.ok(store instanceof MemoryMaicStore);
  await store.createCourse({
    course_id: 'course-local-development',
    title: 'Local development',
    source_filename: 'local.pdf',
    source_text: 'source',
  });
  assert.equal((await store.getCourse('course-local-development'))?.title, 'Local development');
});

test('PostgreSQL query failure never falls back to process memory', async () => {
  const store = createMaicStore(POSTGRES_CONFIG, {
    async query() {
      throw Object.assign(new Error('driver details must stay hidden'), { code: 'ECONNREFUSED' });
    },
  });

  await assert.rejects(
    () => store.listCourses(),
    error => error?.name === 'PostgresQueryError'
      && error?.operation === 'list MAIC courses'
      && !error.message.includes('driver details')
  );
});

function prepared(title) {
  return {
    pages: [{ index: 0, raw_text: 'source', description: '', key_points: [] }],
    knowledge_tree: {
      id: 'root',
      title,
      summary: '',
      page_refs: [],
      children: [],
    },
    lecture_script: [],
    active_questions: [],
    stage: {
      title,
      summary: '',
      objectives: [],
      scene_count: 0,
      estimated_minutes: 8,
    },
    scenes: [],
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function createFakeMaicDatabase(options = {}) {
  const courses = new Map();
  const sessions = new Map();
  const calls = [];
  let loseCourseUpdate = options.loseFirstCourseUpdate === true;
  let courseUpdateAttempts = 0;

  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
      const [tenantId, corpusId] = values;
      assert.equal(tenantId, POSTGRES_CONFIG.defaultTenantId);
      assert.equal(corpusId, POSTGRES_CONFIG.defaultCorpusId);

      if (sql.startsWith('insert into public.maic_courses')) {
        const payload = parsePayload(values[3]);
        courses.set(values[2], { payload, version: 1 });
        return row(payload, 1);
      }
      if (sql.startsWith('select payload, version from public.maic_courses')) {
        const record = courses.get(values[2]);
        return record ? row(record.payload, record.version) : empty();
      }
      if (sql.startsWith('select payload from public.maic_courses')) {
        const record = courses.get(values[2]);
        return record ? { rows: [{ payload: record.payload }], rowCount: 1 } : empty();
      }
      if (sql.startsWith('update public.maic_courses')) {
        courseUpdateAttempts += 1;
        if (loseCourseUpdate) {
          loseCourseUpdate = false;
          return empty();
        }
        const record = courses.get(values[2]);
        const expectedVersion = Number(values[4]);
        if (!record || record.version !== expectedVersion) return empty();
        const payload = parsePayload(values[3]);
        const version = record.version + 1;
        courses.set(values[2], { payload, version });
        return row(payload, version);
      }
      if (sql.startsWith('delete from public.maic_courses')) {
        const existed = courses.delete(values[2]);
        if (existed) {
          for (const [sessionId, record] of sessions) {
            if (record.payload.course_id === values[2]) sessions.delete(sessionId);
          }
        }
        return existed ? { rows: [{ course_id: values[2] }], rowCount: 1 } : empty();
      }
      if (sql.startsWith('select payload from public.maic_classroom_sessions')
          && sql.includes("payload #>> '{state,status}'")) {
        const record = [...sessions.values()].find(item => (
          item.payload.course_id === values[2] && item.payload.state.status !== 'ended'
        ));
        return record ? { rows: [{ payload: record.payload }], rowCount: 1 } : empty();
      }
      if (sql.startsWith('insert into public.maic_classroom_sessions')) {
        const payload = parsePayload(values[4]);
        sessions.set(values[3], { payload, version: 1 });
        return row(payload, 1);
      }
      if (sql.startsWith('select payload, version from public.maic_classroom_sessions')) {
        const record = sessions.get(values[2]);
        return record ? row(record.payload, record.version) : empty();
      }
      if (sql.startsWith('select payload from public.maic_classroom_sessions')) {
        const record = sessions.get(values[2]);
        return record ? { rows: [{ payload: record.payload }], rowCount: 1 } : empty();
      }
      if (sql.startsWith('update public.maic_classroom_sessions')) {
        const record = sessions.get(values[2]);
        const expectedVersion = Number(values[4]);
        if (!record || record.version !== expectedVersion) return empty();
        const payload = parsePayload(values[3]);
        const version = record.version + 1;
        sessions.set(values[2], { payload, version });
        return row(payload, version);
      }
      throw new Error(`Unexpected SQL in fake MAIC database: ${sql}`);
    },
  };

  return {
    client,
    calls,
    courses,
    sessions,
    get courseUpdateAttempts() { return courseUpdateAttempts; },
  };
}

function parsePayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function row(payload, version) {
  return { rows: [{ payload, version }], rowCount: 1 };
}

function empty() {
  return { rows: [], rowCount: 0 };
}
