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

const { buildCourseStage } = await import('./plan-stage.ts');

test('buildCourseStage gives slide scenes OpenMAIC-style teaching annotation actions', () => {
  const pages = [
    {
      index: 0,
      raw_text: '氮气的三键稳定性与全球氮循环',
      description: '氮是构成蛋白质与核酸的核心元素。',
      key_points: ['大气中的氮气', 'N≡N 三键稳定性', '键能 946 kJ/mol', '全球氮循环'],
    },
  ];
  const tree = {
    id: 'root',
    title: '氮及其化合物',
    summary: '从大气到生命之基',
    page_refs: [0],
    children: [],
  };

  const { scenes } = buildCourseStage(pages, tree, ['为什么氮气很稳定?']);
  const slide = scenes.find(scene => scene.type === 'slide');

  assert.ok(slide);
  assert.deepEqual(
    slide.actions.map(action => action.type).slice(0, 5),
    ['speech', 'spotlight', 'laser', 'highlight', 'annotation']
  );
  assert.equal(slide.actions.find(action => action.type === 'spotlight')?.target, 'info-card');
  assert.equal(slide.actions.find(action => action.type === 'laser')?.target, 'formula');
  assert.equal(slide.actions.find(action => action.type === 'highlight')?.target, 'formula-card');
  assert.equal(slide.actions.find(action => action.type === 'annotation')?.target, 'formula-note');
  assert.equal(slide.actions.find(action => action.type === 'whiteboard')?.target, 'summary-card');
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
