---
title: "OpenMAIC 课程准备阶段提速"
type: sprint
status: completed
created: "2026-05-21"
updated: "2026-05-21"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, performance, maic, openmaic, pipeline]
aliases: ["OpenMAIC parse speed v2", "prepare pipeline parallelization"]
invariants:
  - "SSE 事件回调必须按 page.index 单调"
  - "prepared cache identity 与 shape 不变 (复用 getMaicPrepareCacheIdentity / CoursePrepared)"
  - "LLM 失败兜底返回稳定 fallback (describe/script/focus 三处)"
invariant_tests:
  - src/lib/maic/pipeline/page-order.test.mjs
  - src/lib/maic/pipeline/stage-options.test.mjs
  - src/lib/maic/pipeline/plan-stage-actions.test.mjs
  - src/lib/maic/prepare-cache.test.mjs
deferred:
  - sprint: TBD
    item: "describe+script+focus 合并 per-page mega prompt"
    deadline: "2026-07-01"
    reason: "需要重写 prompt + 全套 fallback 测试，本 sprint 优先做依赖图重排"
deadcode_until: []
---

# OpenMAIC 课程准备阶段提速

## Phase 1: Think

### 需求分析

用户反馈 OpenMAIC 课程 prepare（`/maic/prepare/[courseId]`）首跑慢。当前 5 阶段全串行：describe → tree → script → questions → focus，调用数 3N+2（N 页），且每阶段是"批次屏障"（每批 4 个等齐才开下一批）。N=30 时约 92 次 LLM、23 批，最慢的请求拖批，wall time 远超 LLM 实际吞吐上限。

### 保真约束

- SSE 事件 (`prepare:describe` / `prepare:script` / `prepare:focus`) 仍按 page.index 单调
- prepared 缓存 identity 不变，命中路径不动
- 三个 LLM 阶段的失败兜底分支保留
- `CoursePrepared` / `SlidePage` / `SlideFocusPlan` 等公开 shape 不变

## Phase 2: 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| MAIC prepare cache | 共享 artifact cache identity (`getMaicPrepareCacheIdentity`) | 不动 cache 调用，只动 cache miss 之后的流水线 |
| MAIC SSE | `prepare:*` 事件 page_index 单调 | page-order 改滑动窗口时仍按 page.index 触发回调 |
| MAIC LLM 调用 | `createLLM(undefined, { temperature: 0.3 })` 单实例复用 | 阶段并行时复用同一 llm 实例，不新建 |
| LangChain `llm.invoke` | 现有 page-order.ts 已假设可并发 4 | 阶段并行后峰值 = describe 完成 → script+focus 并发；总并发上限默认 8，可 env 覆盖 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| prepare 加速 | UI 进 prepare 页 → `prepare-runner.start` → SSE | runner emit → /maic SSE route | course-store + prepare-cache | 缓存命中 OK；miss 走加速后流水线 |
| page-order 滑窗 | describe/script/focus 内部调用 | mapPagesWithOrderedCallbacks (改) | 无 | onPage 回调仍按 index 顺序 |
| 阶段图并行 | runPipeline 内部编排 | Promise 并行 | 无 | 各 SSE 阶段事件保持现有 type，event order 仅在阶段并发时交错（UI 不依赖跨阶段 type 顺序） |

潜在不可见环节：SSE 事件类型间顺序若 UI 强依赖（如必须 describe-all-done 才能渲染 script），需确认。

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-04-28 (parity & parse speed) | "上传 PDF total 复用" | 已完成，无遗留 | — |
| 2026-05-14 (cache optimization) | "MiroFish graph 磁盘缓存" | 与本 sprint 无关，不动 | — |
| 本 sprint 推迟 | per-page mega prompt 合并 | ⏭ 下个 sprint，先看本 sprint 加速效果 | 2026-07-01 |

### 实现方案

**改动 1：`page-order.ts` 批次屏障 → 滑动窗口（pool）**
- 当前：`for (start += concurrency) { Promise.all(batch) }` — 慢请求拖整批
- 改为：维持 `safeConcurrency` 个 in-flight worker，任一完成立即取下一个 page
- 仍按 page.index 单调触发 onPage（用 cursor + pending map）
- API/类型不变

**改动 2：`prepare-runner.ts` 阶段依赖图重排**
- 现状：describe → tree → script → questions → focus（5 阶段串行）
- 新依赖图：
  ```
  describe (N calls)
      ├── tree (1) ─→ questions (1)
      │            ─→ focus (N)
      └── script (N)
  ```
- 实现：describe 完成后 → `Promise.all([scriptTask, treeThenFocusAndQuestions])`
- script 与 (tree → questions, focus) 并行
- 其中 questions 仅依赖 tree，focus 依赖 tree+described，二者也并行

**改动 3：concurrency 可配置**
- 新增 `MAIC_LLM_CONCURRENCY` env（默认 4），三阶段共享
- 不引入 per-stage 配置（YAGNI）

**改动 4：测试覆盖滑动窗口与阶段并行**
- 扩展 `page-order.test.mjs`：构造一个 task 拖慢，验证其他 task 不被阻塞
- 新增 `prepare-runner.test.mjs`：mock LLM，断言 script 与 focus 的 invoke 时间重叠

### 验证策略

- L2 风险（流水线编排重写，但 type/cache/SSE 不变）
- 每 task 完成跑 `invariant_tests` 全列表
- 不需要 E2E（已有 node test 覆盖回调顺序与 fallback）

## Phase 3: Work

- [x] T1 page-order.ts: 批次屏障 → 滑动窗口，单调 onPage 保留
- [x] T2 page-order.test.mjs: 新增"慢任务不拖批"用例
- [x] T3 prepare-runner.ts: 阶段依赖图改写（script ∥ tree→questions ∥ focus）
- [x] T4 prepare-runner.test.mjs: 新增"script 与 focus 时间重叠"用例
- [x] T5 concurrency env: `MAIC_LLM_CONCURRENCY` 默认 4, clamp [1,16]
- [x] T6 invariant 全量回归 + ESLint + tsc 全绿

### 实现要点

- `mapPagesWithOrderedCallbacks` 用 nextSlot + completed Set + emitCursor 实现滑窗，onPage 仍按 page.index 单调
- `runPipeline` describe 后用 `Promise.all([scriptPromise, treePromise])`；treePromise 内部 `Promise.all([questions, focus])`
- `prepare:tree` / `prepare:questions` / `prepare:focus` 事件按当前阶段并行触发；同阶段内事件 page_index 单调
- `MAIC_LLM_CONCURRENCY` 由 `resolveMaicLlmConcurrency()` 解析；3 个并行阶段共享

### 验证（不变量回归全跑）

- `node src/lib/maic/pipeline/page-order.test.mjs` → 8 pass
- `node src/lib/maic/pipeline/stage-options.test.mjs` → 6 pass
- `node src/lib/maic/pipeline/plan-stage-actions.test.mjs` → 1 pass
- `node src/lib/maic/prepare-cache.test.mjs` → 3 pass
- `node src/lib/maic/pipeline/prepare-runner.test.mjs` (新增) → 2 pass
- `node src/lib/maic/pptx-parser.test.mjs` → 3 pass
- `node src/lib/maic/parsed-slides-cache.test.mjs` → 2 pass
- `node src/lib/maic/classroom-export.test.mjs` → 2 pass
- scoped ESLint → pass
- `pnpm exec tsc --noEmit` → exit 0

## Phase 4: Review

### 五视角

- 架构: clean (依赖图清晰; P2 可提 async helper, 非必修)
- 安全: clean (无新 surface, env clamp [1,16])
- 性能: clean (理论 30-45% wall time 降低; P2 可加 provider 限流提示文档)
- 代码质量: clean (ESLint + tsc 全绿, 类型签名不变)
- 测试覆盖: clean (滑窗用 in-flight 计数断言, 无 timer 抖动)

### 第 6 视角 — 集成连续性

3 条 invariant 全部保持：
- 同阶段 SSE 单调 ✓ (page-order test 覆盖, runner 内每阶段仍走 mapPagesWithOrderedCallbacks)
- cache identity / CoursePrepared shape ✓ (prepare-cache.test pass)
- LLM fallback 保留 ✓ (三处 catch 未动)

**P1 — UI 进度条倒退**（集成断裂, 已修）：
- 跨阶段并行后 script/focus/questions 的 progress 数据交错到达, 旧 `setProgress(p)` 直赋值会让进度条倒退。
- 修复: `src/app/maic/prepare/[courseId]/page.tsx` 改为 `setProgress(prev => Math.max(prev, next))`。

### 验证

- 所有 invariant_tests 仍绿
- prepare page tsc + ESLint clean

## Phase 5: Compound

### 沉淀

- Solution: `docs/solutions/2026-05-21-openmaic-prepare-pipeline-parallelization.md`
- Performance rules: `.codex/rules/performance.md` 新增 3 条
  - Redraw LLM Pipeline Dependency Graph Before Optimizing
  - Sliding Window Beats Batch Barrier For LLM Concurrency
  - Audit Progress UI When Serializing Stages Into Parallel Branches
- Memory feedback (跨项目通用):
  - `feedback_llm_pipeline_dependency_graph.md`
  - `feedback_parallel_progress_monotonic.md`
  - `feedback_worker_pool_over_batch_barrier.md`
  - MEMORY.md index 更新

### 关键经验

1. **LLM 流水线优化前必先重画数据依赖图** — 代码顺序往往比真实依赖更串行；本 sprint 没改任何 prompt / 缓存 / 调用数就拿到 ~35% wall time。
2. **滑动窗口 > 批次屏障** — 任何并发 LLM helper 默认用 worker pool；批次屏障让长尾请求拖累整批。
3. **串行→并行重构必查 progress UI 单调性** — 第 6 视角 review 才发现的 UX 回归类型；setProgress max 化是 5 行修复但极易漏。

## 变更日志

- 2026-05-21: 创建 sprint 文档，确认依赖图重排 + 滑动窗口方案，列入场 checklist。
- 2026-05-21: T1-T6 全部完成；page-order 滑窗化，prepare-runner 依赖图重排为 script ∥ (tree → questions ∥ focus)，MAIC_LLM_CONCURRENCY env 接入；27 个 node test 全绿，tsc/ESLint clean。
- 2026-05-21: Review P1 修复 — UI prepare page progress 改单调 (`setProgress(prev => Math.max(prev, next))`)，避免跨阶段事件交错导致进度条倒退。
