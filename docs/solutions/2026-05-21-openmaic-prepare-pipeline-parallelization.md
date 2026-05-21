---
title: "OpenMAIC prepare 流水线并行化加速"
date: "2026-05-21"
tags: [solution, performance, maic, openmaic, pipeline, llm-orchestration]
related: ["[[2026-04-28-maic-parsed-slides-cache]]", "[[2026-05-14-mirofish-openmaic-cache-optimization]]"]
sprint: "[[2026-05-21-openmaic-prepare-speed]]"
---

# OpenMAIC prepare 流水线并行化加速

## 问题

`/maic/prepare/[courseId]` 首跑慢。流水线 5 阶段（describe / tree / script / questions / focus）全串行，每阶段内 `mapPagesWithOrderedCallbacks` 是批次屏障（每批 4 个等齐再开下一批），慢请求拖累整批。N 页 → 3N+2 次 LLM 调用 / 5 阶段 wall time 串接。

## 修复

### 改动 1: page-order 滑动窗口

`mapPagesWithOrderedCallbacks` 从批次屏障改为 worker pool：

```ts
// 旧: for (start += concurrency) { Promise.all(batch) }
//     最慢请求拖累整批
// 新: 维持 concurrency 个 in-flight worker, 任一完成立即取下一页
const runWorker = async () => {
  while (true) {
    const slot = nextSlot;
    if (slot >= total) return;
    nextSlot = slot + 1;
    const result = await worker(pages[slot]);
    results[slot] = result;
    completed.add(slot);
    emitReady(); // onPage 仍按 page.index 单调
  }
};
await Promise.all(Array.from({ length: safeConcurrency }, runWorker));
```

关键不变量：onPage 仍按 page.index 单调（emitCursor + completed Set 守护）。

### 改动 2: 依赖图重排

原 5 阶段串行依赖图实际有冗余：

```
旧: describe → tree → script → questions → focus  (全串行)

新: describe (gate)
        ├── script (仅依赖 describe)        ┐
        └── tree → ┬── questions             ├─ Promise.all
                   └── focus (依赖 described+tree)
```

实现：

```ts
const scriptPromise = generateLectureScript(llm, described, ...);
const treePromise = buildKnowledgeTree(llm, described).then(tree => {
  return Promise.all([
    generateActiveQuestions(llm, tree),
    generateSlideFocusPlans(llm, described, tree, ...),
  ]).then(([questions, focusPlans]) => ({ tree, questions, focusPlans }));
});
const [script, treeBundle] = await Promise.all([scriptPromise, treePromise]);
```

### 改动 3: concurrency 可配置

`MAIC_LLM_CONCURRENCY` env，默认 4，clamp [1, 16]。阶段并行后全局峰值 LLM 并发 ≈ `2 * concurrency + 1`（默认 9）。

### 改动 4: UI 进度单调

跨阶段事件交错后 progress 数据会回退（script 0.5 → focus 0.2 → script 0.75）。`page.tsx` 的 setProgress 改为 max 单调：

```tsx
setProgress(prev => (next > prev ? next : prev));
```

## 理论收益

N 页课程，假设每 LLM 调用 ~3s：

- 旧（5 阶段串行 + 批次屏障）：`(N/4)·3·3 + 6 ≈ 2.25N+6` 秒
- 新（3 支路并行 + 滑窗）：`(N/4)·3 + 3 + (N/4)·3 ≈ 1.5N+3` 秒
- N=20 时 51s → 33s（≈ 35% 降低），N=30 时 73s → 48s

实际还看长尾吸收，预计 **wall time 降低 30-45%**。

## 经验

### LLM 流水线依赖图不要默认串行

每个阶段写完容易"自然串"：写完 describe 等结果再写 tree，写完 tree 等结果再写 script。但**实际数据依赖图往往比代码顺序更稀疏**。

每加一个 LLM 阶段，问：
1. 它**真正**依赖哪些上游产出？（不是代码顺序上的"前面"）
2. 上游产出齐了之后，能并发跑哪几条独立支路？

OpenMAIC 这次：5 阶段串行 → 重画依赖图后变成 1 gate + 3 并行支路，wall time 砍掉一半。

### 滑动窗口 > 批次屏障

只要任务时延有方差（LLM 调用一定有），批次屏障 = 等批内最慢请求。换成 worker pool，长尾请求只占一个 worker，其他 worker 不停推进。

实现上要点：用 `nextSlot` 抢占 + 单独 `emitCursor + completed Set` 守 onPage 单调，避免 worker 完成顺序污染外部回调契约。

### 异步并行后要 audit UI 进度反馈

阶段串行时 progress 天然单调。改并行后**多源 progress 同时更新**，直接 setState 会导致 UI 回退。

修复 5 行：`setProgress(prev => Math.max(prev, next))`。但**容易漏**——本 sprint 第 6 视角 review 才发现，差点漏成回归。

教训：任何把"串行 step"改成"并行 branch"的重构，**必须同时审计所有消费 step 状态的 UI 监听器**，把"单调假设"显式 max 化。

## 验证

- 27 个 node test 全绿（含新增 4 个：滑窗慢任务、空数组、concurrency overflow、env clamp；2 个并行图重叠断言）
- ESLint clean
- `pnpm exec tsc --noEmit` exit 0
- 同阶段 SSE 单调保留；跨阶段事件允许交错（UI 已 max 化）
