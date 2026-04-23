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
const { generateLectureScript } = await import('./plan-stage.ts');

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
