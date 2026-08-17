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
const {
  resolvePrepareStartStatus,
  runPrepareDependencyGraph,
} = await import('./prepare-runner.ts');

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

test('persisted preparing state restarts after the previous process disappears', () => {
  assert.equal(resolvePrepareStartStatus('preparing', false), 'restarted');
  assert.equal(resolvePrepareStartStatus('uploaded', false), 'started');
  assert.equal(resolvePrepareStartStatus('preparing', true), 'running');
});

test('runner dependency graph: script and focus execute concurrently after describe gate', async t => {
  const previousConcurrency = process.env.MAIC_LLM_CONCURRENCY;
  process.env.MAIC_LLM_CONCURRENCY = '4';
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.MAIC_LLM_CONCURRENCY;
    } else {
      process.env.MAIC_LLM_CONCURRENCY = previousConcurrency;
    }
  });

  // 显式 concurrency=4，直接用调用时间窗口验证依赖图，不用易受 CI 负载影响的墙钟门槛。
  const llm = makeTrackedLLM({ describe: 30, script: 80, focus: 80, tree: 30, questions: 5 });
  const pagesRaw = Array.from({ length: 4 }, (_, index) => ({
    index,
    raw_text: `第 ${index + 1} 页`,
    description: '',
    key_points: [],
  }));

  const described = await describePages(llm, pagesRaw);
  const result = await runPrepareDependencyGraph({
    described,
    scriptLlm: llm,
    treeLlm: llm,
    questionsLlm: llm,
    focusLlm: llm,
    emit: () => {},
  });

  assert.equal(result.script.length, 4, 'script generated for all pages');
  assert.equal(result.focusPlans.length, 4, 'focus plans generated for all pages');
  assert.equal(result.questions.length, 6, 'questions generated');
  assert.equal(result.tree.title, 'mock 课程', 'tree built');

  // 关键并发不变量: 至少一对 (script, focus) 调用的时间窗口存在重叠。
  const scriptCalls = llm.calls.filter(c => c.kind === 'script');
  const focusCalls = llm.calls.filter(c => c.kind === 'focus');
  const treeCall = llm.calls.find(c => c.kind === 'tree');
  assert.ok(scriptCalls.length > 0 && focusCalls.length > 0);
  assert.ok(treeCall, 'tree invoked');
  assert.ok(
    scriptCalls.some(call => call.startedAt < treeCall.finishedAt),
    'script branch must begin before the tree branch finishes'
  );
  assert.ok(
    focusCalls.every(call => call.startedAt >= treeCall.finishedAt),
    'focus branch must wait for the tree dependency'
  );
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
  await runPrepareDependencyGraph({
    described,
    scriptLlm: llm,
    treeLlm: llm,
    questionsLlm: llm,
    focusLlm: llm,
    emit: () => {},
  });

  const questionsCall = llm.calls.find(c => c.kind === 'questions');
  const focusCalls = llm.calls.filter(c => c.kind === 'focus');
  const treeCall = llm.calls.find(c => c.kind === 'tree');
  assert.ok(questionsCall, 'questions invoked');
  assert.ok(focusCalls.length > 0, 'focus invoked');
  assert.ok(treeCall, 'tree invoked');
  assert.ok(
    questionsCall.startedAt >= treeCall.finishedAt,
    'questions branch must wait for the tree dependency'
  );
  assert.ok(
    focusCalls.every(call => call.startedAt >= treeCall.finishedAt),
    'focus branch must wait for the tree dependency'
  );

  const overlaps = focusCalls.some(
    f => questionsCall.startedAt < f.finishedAt && f.startedAt < questionsCall.finishedAt
  );
  assert.ok(
    overlaps,
    'questions and focus must run concurrently after tree completes'
  );
});
