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

const { describePages, buildKnowledgeTree } = await import('./read-stage.ts');
const {
  generateLectureScript,
  generateActiveQuestions,
  generateSlideFocusPlans,
} = await import('./plan-stage.ts');

// Test 验证 prepare-runner 的依赖图重排:
//   describe → Promise.all([script, tree → Promise.all([questions, focus])])
// 关键不变量: script 与 focus 的执行时间窗口重叠 (并行), 而不是首尾串接。

function makeTrackedLLM(latency) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      const prompt = String(messages[0]?.content ?? '');
      const kind = classifyPrompt(prompt);
      const startedAt = Date.now();
      await delay(latency[kind] ?? 5);
      const finishedAt = Date.now();
      calls.push({ kind, startedAt, finishedAt });
      return { content: stubResponse(kind, prompt) };
    },
  };
}

function classifyPrompt(prompt) {
  if (prompt.includes('教学动作格式')) return 'script';
  if (prompt.includes('重点策略格式')) return 'focus';
  if (prompt.includes('生成 6 个高质量')) return 'questions';
  if (prompt.includes('棵树形知识分类')) return 'tree';
  return 'describe';
}

function stubResponse(kind, prompt) {
  if (kind === 'script') {
    const pageIndex = Number(prompt.match(/<slide index="(\d+)">/)?.[1] ?? 0);
    return JSON.stringify([
      { type: 'ShowFile', value: { slide_index: pageIndex } },
      { type: 'ReadScript', value: { script: `讲解第 ${pageIndex + 1} 页` } },
    ]);
  }
  if (kind === 'focus') {
    return JSON.stringify({
      primary_candidate_id: 'point_0',
      secondary_candidate_id: null,
      focus_label: 'mock',
      rationale: 'mock',
      confidence: 0.8,
      hold_mode: 'until_next_focus',
    });
  }
  if (kind === 'questions') {
    return JSON.stringify(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  }
  if (kind === 'tree') {
    return JSON.stringify({
      id: 'root',
      title: 'mock 课程',
      summary: 'mock 摘要',
      page_refs: [],
      children: [],
    });
  }
  const pageIndex = Number(prompt.match(/<slide index="(\d+)">/)?.[1] ?? 0);
  return JSON.stringify({
    description: `mock 描述 ${pageIndex}`,
    key_points: [`要点 ${pageIndex}`],
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

// 复制 prepare-runner.ts 里 describe 之后的依赖图编排, 验证并发结构。
// runner 内部用的就是这个 Promise.all 结构, 这里直接重现以避开 createLLM mock 的复杂性。
async function runDependencyGraph(llm, described) {
  const scriptPromise = generateLectureScript(llm, described);
  const treePromise = buildKnowledgeTree(llm, described).then(async tree => {
    const [questions, focusPlans] = await Promise.all([
      generateActiveQuestions(llm, tree),
      generateSlideFocusPlans(llm, described, tree),
    ]);
    return { tree, questions, focusPlans };
  });
  const [script, treeBundle] = await Promise.all([scriptPromise, treePromise]);
  return { script, ...treeBundle };
}

test('runner dependency graph: script and focus execute concurrently after describe gate', async () => {
  // 30ms describe / 30ms tree / 80ms script per page / 80ms focus per page。
  // 串行模型: describe + tree + 4*script + 4*focus = 30 + 30 + 320 + 320 = 700ms (concurrency=1 等价)
  // 当前实现 (concurrency=4): describe 30ms (4 并发→30ms), tree 30ms, 然后 script 80ms ∥ focus 80ms ∥ questions ≪ 80ms
  //   并行 wall time ≈ describe(30) + max(script(80), tree(30) + max(focus(80), questions(5))) ≈ 30 + max(80, 110) = 140ms
  // 阶段串行 (旧逻辑): describe(30) + tree(30) + script(80) + questions(5) + focus(80) ≈ 225ms
  // 阈值 180ms: 落两者之间, 失败 = 退回串行。
  const llm = makeTrackedLLM({ describe: 30, script: 80, focus: 80, tree: 30, questions: 5 });
  const pagesRaw = Array.from({ length: 4 }, (_, index) => ({
    index,
    raw_text: `第 ${index + 1} 页`,
    description: '',
    key_points: [],
  }));

  const startedAt = Date.now();
  const described = await describePages(llm, pagesRaw);
  const result = await runDependencyGraph(llm, described);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.script.length, 4, 'script generated for all pages');
  assert.equal(result.focusPlans.length, 4, 'focus plans generated for all pages');
  assert.equal(result.questions.length, 6, 'questions generated');
  assert.equal(result.tree.title, 'mock 课程', 'tree built');

  // 验证 wall time 接近并行 (< 200ms) 而不是阶段串行 (~225ms+)。
  assert.ok(
    elapsedMs < 200,
    `parallel dependency graph should complete < 200ms (serial would be ~225ms), got ${elapsedMs}ms`
  );

  // 关键并发不变量: 至少一对 (script, focus) 调用的时间窗口存在重叠。
  const scriptCalls = llm.calls.filter(c => c.kind === 'script');
  const focusCalls = llm.calls.filter(c => c.kind === 'focus');
  assert.ok(scriptCalls.length > 0 && focusCalls.length > 0);
  const overlaps = scriptCalls.some(s =>
    focusCalls.some(f => s.startedAt < f.finishedAt && f.startedAt < s.finishedAt)
  );
  assert.ok(
    overlaps,
    'at least one script call must temporally overlap with at least one focus call (proves parallel branches)'
  );
});

test('runner dependency graph: questions runs in parallel with focus after tree', async () => {
  const llm = makeTrackedLLM({ describe: 5, script: 5, focus: 80, tree: 5, questions: 60 });
  const pagesRaw = Array.from({ length: 2 }, (_, index) => ({
    index,
    raw_text: `第 ${index + 1} 页`,
    description: '',
    key_points: [],
  }));
  const described = await describePages(llm, pagesRaw);
  await runDependencyGraph(llm, described);

  const questionsCall = llm.calls.find(c => c.kind === 'questions');
  const focusCalls = llm.calls.filter(c => c.kind === 'focus');
  assert.ok(questionsCall, 'questions invoked');
  assert.ok(focusCalls.length > 0, 'focus invoked');

  const overlaps = focusCalls.some(
    f => questionsCall.startedAt < f.finishedAt && f.startedAt < questionsCall.finishedAt
  );
  assert.ok(
    overlaps,
    'questions and focus must run concurrently after tree completes'
  );
});
