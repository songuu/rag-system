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

const { getMaicStore } = await import('./course-store.ts');

test('setCoursePrepared adopts generated title for filename-derived courses', () => {
  const store = getMaicStore();
  const courseId = `course_generated_title_${Date.now()}`;
  store.createCourse({
    course_id: courseId,
    title: 'upload-file',
    title_source: 'filename',
    source_filename: 'upload-file.pdf',
    source_text: 'source',
  });

  const updated = store.setCoursePrepared(courseId, prepared('生物化学入门'));

  assert.equal(updated?.title, '生物化学入门');
  assert.equal(updated?.title_source, 'generated');
});

test('setCoursePrepared ignores generic generated course titles', () => {
  const store = getMaicStore();
  const courseId = `course_generic_title_${Date.now()}`;
  store.createCourse({
    course_id: courseId,
    title: 'source-file',
    title_source: 'filename',
    source_filename: 'source-file.pdf',
    source_text: 'source',
  });

  const updated = store.setCoursePrepared(courseId, prepared('OpenMAIC 课堂'));

  assert.equal(updated?.title, 'source-file');
  assert.equal(updated?.title_source, 'filename');
});
test('setCoursePrepared preserves user-supplied course title', () => {
  const store = getMaicStore();
  const courseId = `course_user_title_${Date.now()}`;
  store.createCourse({
    course_id: courseId,
    title: '我的自定义标题',
    title_source: 'user',
    source_filename: 'source.pdf',
    source_text: 'source',
  });

  const updated = store.setCoursePrepared(courseId, prepared('自动生成标题'));

  assert.equal(updated?.title, '我的自定义标题');
  assert.equal(updated?.title_source, 'user');
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
