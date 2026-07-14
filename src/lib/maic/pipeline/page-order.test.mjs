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

const { buildKnowledgeTree, describePages } = await import('./read-stage.ts');
const {
  generateActiveQuestions,
  generateLectureScript,
  generateSlideFocusPlans,
} = await import('./plan-stage.ts');
const { mapPagesWithOrderedCallbacks, resolveMaicLlmConcurrency } = await import('./page-order.ts');

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

test('read and plan stages prefer final JSON after reasoning blocks', async () => {
  const sourcePage = {
    index: 0,
    raw_text: '课程原文',
    description: '',
    key_points: [],
  };
  const llm = createReasoningAwareLLM();

  const [describedPage] = await describePages(llm, [sourcePage]);
  const tree = await buildKnowledgeTree(llm, [describedPage]);
  const [scriptEntry] = await generateLectureScript(llm, [describedPage]);
  const questions = await generateActiveQuestions(llm, tree);
  const [focusPlan] = await generateSlideFocusPlans(llm, [describedPage], tree);

  assert.equal(describedPage.description, '最终描述');
  assert.deepEqual(describedPage.key_points, ['普通背景', '最终重点']);
  assert.equal(tree.title, '最终知识树');
  assert.equal(scriptEntry.actions[1].value.script, '最终讲稿');
  assert.deepEqual(questions, ['最终问题']);
  assert.equal(focusPlan.primary.elementId, 'slide-0-point-1');
  assert.equal(focusPlan.source, 'model');
});

test('read and plan stages preserve fallbacks for malformed model output', async () => {
  const sourcePage = {
    index: 0,
    raw_text: '课程原文',
    description: '',
    key_points: [],
  };
  const invalidLLM = { async invoke() { return { content: 'not valid JSON' }; } };

  const [describedPage] = await describePages(invalidLLM, [sourcePage]);
  const tree = await buildKnowledgeTree(invalidLLM, [describedPage]);
  const [scriptEntry] = await generateLectureScript(invalidLLM, [describedPage]);
  const questions = await generateActiveQuestions(invalidLLM, tree);
  const [focusPlan] = await generateSlideFocusPlans(invalidLLM, [describedPage], tree);

  assert.equal(describedPage.description, sourcePage.raw_text);
  assert.deepEqual(describedPage.key_points, []);
  assert.equal(tree.title, '课程大纲');
  assert.deepEqual(scriptEntry.actions.map(action => action.type), ['ShowFile', 'ReadScript']);
  assert.equal(questions.length, 6);
  assert.equal(focusPlan.source, 'fallback');
});

test('mapPagesWithOrderedCallbacks slides without batch barrier: starts new work before slow worker finishes', async () => {
  // 滑动窗口的关键不变量: 当 page0 仍在执行时, 其他 worker 已开始/完成 page >= concurrency 的工作。
  // 批次屏障实现: 第一批 [0..3] 必须全部完成才会有 page 4 启动。
  // 滑动窗口实现: page0 慢任务在跑时, worker2/3/4 已轮转处理 page 1..N-1 多次, page 4+ 会被启动。
  const total = 8;
  const concurrency = 4;
  const slowPages = Array.from({ length: total }, (_, index) => ({ index }));
  const startedIndices = [];
  let slowPageActive = false;
  let pagesStartedDuringSlowWindow = 0;

  await mapPagesWithOrderedCallbacks(
    slowPages,
    concurrency,
    async page => {
      startedIndices.push(page.index);
      if (page.index === 0) {
        slowPageActive = true;
        await delay(80);
        slowPageActive = false;
        return page.index;
      }
      if (slowPageActive) pagesStartedDuringSlowWindow += 1;
      await delay(5);
      return page.index;
    }
  );

  // 滑窗下: page0 跑 80ms 期间, 其他 3 worker 已分别启动并完成多次任务,
  // 所以在 page0 还活着的窗口里, 至少 concurrency-1 = 3 个非 slow page 已被启动,
  // 而且会有 page >= concurrency (即 page 4+) 被启动 (滑窗的标志)。
  // 批次屏障下: page 4+ 永远不会在 page0 跑时启动。
  const startedPagesAfterFirstWindow = startedIndices.filter(i => i >= concurrency);
  assert.ok(
    startedPagesAfterFirstWindow.length > 0 &&
      pagesStartedDuringSlowWindow >= concurrency - 1,
    `sliding window must start page>=${concurrency} during slow page0 execution. ` +
      `startedIndices=${JSON.stringify(startedIndices)} ` +
      `pagesStartedDuringSlowWindow=${pagesStartedDuringSlowWindow}`
  );
});

test('mapPagesWithOrderedCallbacks handles empty pages array', async () => {
  const results = await mapPagesWithOrderedCallbacks([], 4, async () => {
    throw new Error('worker should not be invoked');
  });
  assert.deepEqual(results, []);
});

test('mapPagesWithOrderedCallbacks clamps concurrency above page count', async () => {
  const pages2 = Array.from({ length: 2 }, (_, index) => ({ index }));
  const order = [];
  const results = await mapPagesWithOrderedCallbacks(
    pages2,
    100,
    async page => {
      await delay(5);
      return page.index;
    },
    i => order.push(i)
  );
  assert.deepEqual(results, [0, 1]);
  assert.deepEqual(order, [0, 1]);
});

test('resolveMaicLlmConcurrency: default 4 when env unset', () => {
  const prev = process.env.MAIC_LLM_CONCURRENCY;
  delete process.env.MAIC_LLM_CONCURRENCY;
  try {
    assert.equal(resolveMaicLlmConcurrency(), 4);
  } finally {
    if (prev !== undefined) process.env.MAIC_LLM_CONCURRENCY = prev;
  }
});

test('resolveMaicLlmConcurrency: clamps to [1, 16]', () => {
  const prev = process.env.MAIC_LLM_CONCURRENCY;
  try {
    process.env.MAIC_LLM_CONCURRENCY = '0';
    assert.equal(resolveMaicLlmConcurrency(), 1);
    process.env.MAIC_LLM_CONCURRENCY = '99';
    assert.equal(resolveMaicLlmConcurrency(), 16);
    process.env.MAIC_LLM_CONCURRENCY = '8';
    assert.equal(resolveMaicLlmConcurrency(), 8);
    process.env.MAIC_LLM_CONCURRENCY = 'not-a-number';
    assert.equal(resolveMaicLlmConcurrency(), 4);
  } finally {
    if (prev === undefined) delete process.env.MAIC_LLM_CONCURRENCY;
    else process.env.MAIC_LLM_CONCURRENCY = prev;
  }
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

function createReasoningAwareLLM() {
  return {
    async invoke(messages) {
      const prompt = String(messages[0]?.content ?? '');

      if (prompt.includes('课程知识工程师')) {
        return reasoningResponse({
          id: 'root',
          title: '最终知识树',
          summary: '最终摘要',
          page_refs: [],
          children: [],
        });
      }
      if (prompt.includes('课堂主动提问')) return reasoningResponse(['最终问题']);
      if (prompt.includes('教学动作格式')) {
        return reasoningResponse([
          { type: 'ShowFile', value: { slide_index: 0 } },
          { type: 'ReadScript', value: { script: '最终讲稿' } },
        ]);
      }
      if (prompt.includes('重点策略格式')) {
        return reasoningResponse({
          primary_candidate_id: 'point_1',
          focus_label: '最终重点',
          rationale: '最终理由',
          confidence: 0.9,
          hold_mode: 'until_next_focus',
        });
      }
      return reasoningResponse({
        description: '最终描述',
        key_points: ['普通背景', '最终重点'],
      });
    },
  };
}

function reasoningResponse(finalPayload) {
  return {
    content: [
      '<think>{"draft":true}</think>',
      '```json',
      JSON.stringify(finalPayload),
      '```',
    ].join('\n'),
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
