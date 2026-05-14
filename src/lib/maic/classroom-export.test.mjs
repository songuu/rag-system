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

const { buildOpenMaicClassroomHtml } = await import('./classroom-export.ts');

test('buildOpenMaicClassroomHtml escapes course and scene content', () => {
  const result = buildOpenMaicClassroomHtml(
    {
      course_id: 'course_1',
      title: '<script>bad()</script>',
      prepared: {
        stage: { summary: 'A & B', title: 'Stage', objectives: [], scene_count: 1, estimated_minutes: 5 },
      },
    },
    [
      {
        id: 'scene_1',
        order: 0,
        type: 'slide',
        title: 'Intro <One>',
        description: 'Use "quotes" safely',
        page_refs: [0],
        key_points: ['A&B', '<tag>'],
        actions: [],
      },
    ]
  );

  assert.equal(result.warnings.length, 0);
  assert.match(result.html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(result.html, /A &amp; B/);
  assert.match(result.html, /Intro &lt;One&gt;/);
  assert.match(result.html, /A&amp;B/);
});

test('buildOpenMaicClassroomHtml keeps exporting when one scene is malformed', () => {
  const brokenScene = {
    id: 'broken_scene',
    order: 1,
    type: 'slide',
    description: 'unreachable',
    page_refs: [],
    key_points: [],
    actions: [],
  };
  Object.defineProperty(brokenScene, 'title', {
    get() {
      throw new Error('bad scene title');
    },
  });

  const result = buildOpenMaicClassroomHtml(
    {
      course_id: 'course_1',
      title: 'Course',
      prepared: { stage: { summary: 'Summary', title: 'Stage', objectives: [], scene_count: 2, estimated_minutes: 5 } },
    },
    [
      {
        id: 'good_scene',
        order: 0,
        type: 'quiz',
        title: 'Good Scene',
        description: 'This scene still exports.',
        page_refs: [0],
        key_points: ['point'],
        actions: [],
      },
      brokenScene,
    ]
  );

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].sceneId, 'broken_scene');
  assert.match(result.warnings[0].message, /bad scene title/);
  assert.match(result.html, /Good Scene/);
  assert.match(result.html, /Skipped Scene/);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
