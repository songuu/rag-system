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

const { describePages } = await import('./read-stage.ts');
const { generateLectureScript, generateSlideFocusPlans } = await import('./plan-stage.ts');

const pages = Array.from({ length: 4 }, (_, index) => ({
  index,
  raw_text: `第 ${index + 1} 页原文`,
  description: '',
  key_points: [],
}));

test('describePages emits page callbacks in slide order even if LLM calls finish out of order', async () => {
  const callbackOrder = [];

  const described = await describePages(createOutOfOrderLLM(), pages, pageIndex => {
    callbackOrder.push(pageIndex);
  });

  assert.deepEqual(callbackOrder, [0, 1, 2, 3]);
  assert.deepEqual(
    described.map(page => page.description),
    ['第 1 页描述', '第 2 页描述', '第 3 页描述', '第 4 页描述']
  );
});

test('generateLectureScript emits page callbacks in slide order even if LLM calls finish out of order', async () => {
  const callbackOrder = [];
  const describedPages = pages.map(page => ({
    ...page,
    description: `第 ${page.index + 1} 页描述`,
    key_points: [`第 ${page.index + 1} 页要点`],
  }));

  const script = await generateLectureScript(createOutOfOrderLLM(), describedPages, pageIndex => {
    callbackOrder.push(pageIndex);
  });

  assert.deepEqual(callbackOrder, [0, 1, 2, 3]);
  assert.deepEqual(
    script.map(entry => entry.slide_index),
    [0, 1, 2, 3]
  );
});

test('generateSlideFocusPlans lets the model choose the PPT focus target in slide order', async () => {
  const callbackOrder = [];
  const describedPages = pages.map(page => ({
    ...page,
    description: `第 ${page.index + 1} 页描述`,
    key_points: [`第 ${page.index + 1} 页普通背景`, `第 ${page.index + 1} 页模型重点`],
  }));
  const tree = { title: '课程主题', summary: '课程摘要', page_refs: [], children: [] };

  const focusPlans = await generateSlideFocusPlans(
    createOutOfOrderLLM(),
    describedPages,
    tree,
    pageIndex => {
      callbackOrder.push(pageIndex);
    }
  );

  assert.deepEqual(callbackOrder, [0, 1, 2, 3]);
  assert.deepEqual(
    focusPlans.map(plan => plan.primary.elementId),
    ['slide-0-point-1', 'slide-1-point-1', 'slide-2-point-1', 'slide-3-point-1']
  );
  assert.ok(focusPlans.every(plan => plan.source === 'model'));
});

function createOutOfOrderLLM() {
  return {
    async invoke(messages) {
      const prompt = String(messages[0]?.content ?? '');
      const pageIndex = Number(prompt.match(/<slide index="(\d+)">/)?.[1] ?? 0);
      await delay([40, 20, 5, 10][pageIndex] ?? 1);

      if (prompt.includes('教学动作格式')) {
        return {
          content: JSON.stringify([
            { type: 'ShowFile', value: { slide_index: pageIndex } },
            { type: 'ReadScript', value: { script: `讲解第 ${pageIndex + 1} 页` } },
          ]),
        };
      }

      if (prompt.includes('重点策略格式')) {
        return {
          content: JSON.stringify({
            primary_candidate_id: 'point_1',
            secondary_candidate_id: 'point_0',
            focus_label: '模型判断重点',
            rationale: '第二个要点最能解释本页核心概念。',
            confidence: 0.88,
            hold_mode: 'until_next_focus',
          }),
        };
      }

      return {
        content: JSON.stringify({
          description: `第 ${pageIndex + 1} 页描述`,
          key_points: [`第 ${pageIndex + 1} 页要点`],
        }),
      };
    },
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
