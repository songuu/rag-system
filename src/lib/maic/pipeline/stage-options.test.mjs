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

const { buildLanguageDirective } = await import('./read-stage.ts');
const { buildCourseStage } = await import('./plan-stage.ts');

const pages = [
  {
    index: 0,
    raw_text: '第一讲介绍核心概念和示例。',
    description: '介绍核心概念。',
    key_points: ['核心概念', '示例'],
  },
  {
    index: 1,
    raw_text: '第二讲介绍练习和迁移应用。',
    description: '介绍迁移应用。',
    key_points: ['练习', '迁移'],
  },
];

const tree = {
  id: 'root',
  title: '课程主题',
  summary: '课程主旨',
  page_refs: [],
  children: [
    { id: 'c1', title: '核心概念', summary: '概念', page_refs: [0], children: [] },
  ],
};

test('language directive keeps classroom content language explicit', () => {
  assert.match(buildLanguageDirective('zh-CN'), /中文/);
  assert.match(buildLanguageDirective('en-US'), /English/);
  assert.match(buildLanguageDirective('pt-BR'), /Português do Brasil/);
});

test('stage builder keeps current capabilities enabled by default', () => {
  const { scenes } = buildCourseStage(pages, tree, ['问题一', '问题二']);
  assert.ok(scenes.some(scene => scene.type === 'quiz'));
  assert.ok(scenes.some(scene => scene.type === 'interactive'));
  assert.ok(scenes.some(scene => scene.type === 'pbl'));
  assert.ok(scenes[0].actions.some(action => action.type === 'whiteboard'));
  assert.ok(scenes[0].actions.some(action => action.type === 'spotlight' && action.animation));
  assert.equal(
    scenes[0].actions.find(action => action.type === 'spotlight')?.focusHold,
    'until_next_focus'
  );
});

test('stage builder maps slide animations to stable OpenMAIC action targets', () => {
  const { scenes } = buildCourseStage(
    [
      {
        ...pages[0],
        animations: [
          {
            id: 'source_anim_1',
            elId: 'pptx-sp-4',
            effect: 'wipe',
            type: 'in',
            duration: 720,
            trigger: 'auto',
          },
        ],
      },
    ],
    tree,
    ['问题一'],
    { capabilities: { quiz: false, interactive: false, pbl: false } }
  );

  const spotlight = scenes[0].actions.find(action => action.type === 'spotlight');
  assert.equal(spotlight?.elementId, 'slide-0-point-0');
  assert.equal(spotlight?.animation?.elId, 'slide-0-point-0');
  assert.equal(spotlight?.animation?.duration, 720);
});

test('stage builder uses model-derived PPT focus plan instead of first key point heuristic', () => {
  const { scenes } = buildCourseStage(pages, tree, ['问题一'], {
    capabilities: { quiz: false, interactive: false, pbl: false },
    focusPlans: [
      {
        slide_index: 0,
        source: 'model',
        primary: {
          kind: 'key_point',
          index: 1,
          elementId: 'slide-0-point-1',
          text: '示例',
          label: '模型选择的重点',
          reason: '示例最适合帮助学生迁移核心概念。',
          confidence: 0.91,
        },
        secondary: {
          kind: 'key_point',
          index: 0,
          elementId: 'slide-0-point-0',
          text: '核心概念',
        },
        focusHold: 'until_next_focus',
        confidence: 0.91,
      },
    ],
  });

  const spotlight = scenes[0].actions.find(action => action.type === 'spotlight');
  const laser = scenes[0].actions.find(action => action.type === 'laser');
  assert.equal(spotlight?.elementId, 'slide-0-point-1');
  assert.equal(spotlight?.title, '模型选择的重点');
  assert.equal(spotlight?.focusSource, 'model');
  assert.equal(spotlight?.focusConfidence, 0.91);
  assert.equal(laser?.elementId, 'slide-0-point-0');
});

test('stage builder keeps PPT spotlight focus hovering unless explicitly disabled', () => {
  const { scenes } = buildCourseStage(pages, tree, ['问题一'], {
    capabilities: {
      quiz: false,
      interactive: false,
      pbl: false,
      focusHover: false,
    },
  });

  const spotlight = scenes[0].actions.find(action => action.type === 'spotlight');
  assert.equal(spotlight?.focusHold, 'duration');
});

test('stage builder can conditionally remove capabilities without changing slide fallback', () => {
  const { scenes } = buildCourseStage(pages, tree, ['问题一'], {
    capabilities: {
      quiz: false,
      interactive: false,
      pbl: false,
      whiteboard: false,
      animations: false,
    },
  });

  assert.deepEqual(
    scenes.map(scene => scene.type),
    ['slide', 'slide']
  );
  assert.ok(scenes.every(scene => !scene.actions.some(action => action.type === 'whiteboard')));
  assert.ok(scenes.every(scene => scene.actions.every(action => !action.animation)));
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
