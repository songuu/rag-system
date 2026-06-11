---
title: "LangChain RAG Workflow 改版"
type: sprint
status: completed
created: "2026-06-11"
updated: "2026-06-11"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, rag, langchain, langgraph, langsmith]
aliases: ["langchain-rag-workflow"]
invariants:
  - "LangChain 只做可组合 workflow harness；复杂 RAG 策略继续由 policy adapter / LangGraph 状态机承接"
  - "LangSmith 未配置 API key 时必须 no-op，不影响本地 /api/ask"
  - "/api/ask 响应字段和现有 x-rag-* / x-langsmith-* headers 保持兼容"
invariant_tests:
  - "node src/lib/rag/core/kernel.test.mjs"
  - "node src/lib/langsmith/config.test.mjs"
deferred: []
deadcode_until: []
---

# LangChain RAG Workflow 改版

## Phase 1: Think

### Scope

- 用 LangChain Runnable workflow 改造 RAG Kernel 调用入口，形成可组合、可测试、可打 tags/metadata 的执行层。
- 保留现有 `RagPolicy` / `RagKernel` / `/api/ask` 行为，避免为了追新 API 破坏前端响应结构。
- 结合 LangSmith 最佳实践，把 `thread_id`、route、policy、model、retrieval 参数沉到统一 workflow metadata。

### Non-scope

- 不新增 `langchain` 顶层依赖，不引入 `createAgent`；当前改版先基于已安装的 `@langchain/core/runnables`。
- 不重写现有 Agentic RAG / Adaptive Entity RAG 的 LangGraph 状态机。
- 不修改 Milvus、Supabase、前端 LangSmith ReactFlow viewer。

### Success

- `/api/ask` 通过 LangChain Runnable workflow 调用 `RagKernel`。
- LangSmith root run 仍由现有 `runWithLangSmithRootRun` 管理，workflow 复用同一 `runId/threadId`。
- 定向测试覆盖 workflow metadata、fallback trace id、原 kernel 行为和 LangSmith disabled no-op。

### Risks

- LangChain automatic tracing 与手写 RunTree 可能重复；本轮只把 metadata/config 标准化，不改变手写 root run 的权威地位。
- repo-wide `tsc` 若出现历史债，需和本轮 diff 区分；本轮实际验证中 `npx tsc --noEmit --pretty false --incremental false` 已通过。

## Phase 2: Plan

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| RAG Kernel | 统一入口、policy adapter 保留兼容响应 | 新增 workflow 包在 kernel 外层，不修改 policy 输出结构 |
| LangSmith | tracing disabled 时 no-op | workflow 只生成 metadata/config，不强制发网络请求 |
| LangGraph | 复杂有状态流程继续用 StateGraph | 本轮不重写 agentic/adaptive state graph |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| RAG workflow | `/api/ask` POST | `invokeRagKernelWorkflow` -> `RagKernel.execute` | LangSmith 可选 trace；本地响应 headers | headers / trace viewer 保持现有路径 |
| metadata/tags | RAG request | LangChain RunnableConfig + LangSmith metadata | LangSmith enabled 时可筛选 | LangSmith UI 按 thread/policy/model 过滤 |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-15 LangChain 指南 | `createAgent` 需要新增 `langchain` 依赖 | 继续推迟；本轮只落 `@langchain/core` Runnable workflow | 2026-07-01 |

### Tasks

- [x] T1: 新增 `src/lib/rag/core/workflow.ts`，封装 LangChain Runnable workflow。
- [x] T2: `/api/ask` 改为通过 workflow 执行 kernel，并复用 LangSmith root run id/thread id。
- [x] T3: 补 `kernel.test.mjs` workflow 回归。
- [x] T4: 更新 LangChain / LangGraph / LangSmith 指南和 solution 记录。
- [x] T5: 跑定向验证并做 review。

## Phase 3: Work Log

- 新增 `prepareRagWorkflowRun`：生成 deterministic fallback trace id、thread id、tags、metadata、RunnableConfig。
- 新增 `createRagKernelWorkflow`：用 `RunnableSequence` / `RunnableLambda` 包装 `RagKernel.execute`，并在失败时补 policy/trace 上下文。
- 新增 `invokeRagKernelWorkflow`：为 API 层提供一次性调用 helper，确保动态 RunnableConfig 真正传入 invoke。
- `/api/ask` 改为在 LangSmith root run 内调用 workflow，并复用 `langSmithRun.runId/threadId`。
- `LANGCHAIN_LANGGRAPH_GUIDE.md`、`LANGSMITH_LATEST_GUIDE.md`、`docs/solutions/2026-06-11-langchain-rag-workflow.md` 记录实现边界。

## Phase 4: Review

### 5 + 1 视角

| 视角 | 结论 |
|------|------|
| 架构 | Pass。workflow 是 kernel 外层 harness，没有把复杂策略改成 agent 黑盒。 |
| 安全 | Pass。未新增网络、密钥、持久化写入；LangSmith disabled 仍 no-op。 |
| 性能 | Pass。新增 Runnable 两步包装，热路径额外成本可忽略；未引入 dependency install。 |
| 代码质量 | Pass。错误路径包含 policy/trace 上下文；命名保留业务语义。 |
| 测试覆盖 | Pass。新增 workflow metadata / fallback trace id 回归，保留 kernel / LangSmith no-op 测试。 |
| 集成连续性 | Pass。`/api/ask` 响应和 headers 保持兼容；`RagKernel.execute` 仍是真实执行点。 |

### 验证

- `node src/lib/rag/core/kernel.test.mjs` -> pass (5/5)
- `node src/lib/langsmith/config.test.mjs` -> pass (3/3)
- `node node_modules/eslint/bin/eslint.js src/lib/rag/core/workflow.ts src/lib/rag/core/kernel.test.mjs src/app/api/ask/route.ts` -> pass
- `npx tsc --noEmit --pretty false --incremental false` -> pass
- `git diff --check` -> pass

## Phase 5: Compound

### 经验

- 对本项目而言，“使用 LangChain 改版”优先落到 `@langchain/core/runnables` 的 workflow harness；只有叶子 agent 需要 tool loop 时再引入 `langchain/createAgent`。
- LangSmith root run 与 LangChain RunnableConfig 要共享 `runId/threadId`，避免 trace/filter 语义分叉。

### Skill 信号

- `sprint --auto` 适合本类中风险架构改造：先官方文档确认边界，再小步落到 kernel 层，最后测试覆盖 metadata 和兼容性。
