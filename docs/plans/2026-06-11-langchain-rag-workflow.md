---
title: "LangChain RAG Workflow 改版"
type: sprint
status: completed
created: "2026-06-11"
updated: "2026-08-28"
checkpoints: 0
tasks_total: 11
tasks_completed: 11
tags: [sprint, rag, langchain, langgraph, langsmith]
aliases: ["langchain-rag-workflow"]
invariants:
  - "LangChain workflow 只做 harness；createAgent 只在 canonical scope/retrieval 后读取不可变 evidence snapshot"
  - "LangSmith 未配置 API key 时必须 no-op，不影响本地 /api/ask"
  - "/api/ask 响应字段和现有 x-rag-* / x-langsmith-* headers 保持兼容"
invariant_tests:
  - "node src/lib/rag/core/kernel.test.mjs"
  - "node src/lib/langsmith/config.test.mjs"
  - "node src/lib/rag/agents/scoped-retrieval-agent.test.mjs"
  - "node src/app/api/ask/route.test.mjs"
deferred: []
deadcode_until: []
---

# LangChain RAG Workflow 改版

> 当前架构、真实 `createAgent` 实现和从零搭建/部署/验收 runbook：
> [LangChain / LangGraph / LangSmith 完整实现、架构与搭建指南](../../LANGCHAIN_LANGGRAPH_GUIDE.md)

## Phase 1: Think

### Scope

- 用 LangChain Runnable workflow 改造 RAG Kernel 调用入口，形成可组合、可测试、可打 tags/metadata 的执行层。
- 保留现有 `RagPolicy` / `RagKernel` / `/api/ask` 行为，避免为了追新 API 破坏前端响应结构。
- 结合 LangSmith 最佳实践，把 `thread_id`、route、policy、model、retrieval 参数沉到统一 workflow metadata。

### Non-scope（2026-06-11 原始范围）

- 不新增 `langchain` 顶层依赖，不引入 `createAgent`；当前改版先基于已安装的 `@langchain/core/runnables`。此条已被 2026-08-28 用户对“真正使用 `createAgent`”的明确要求 supersede。
- 不重写现有 Agentic RAG / Adaptive Entity RAG 的 LangGraph 状态机。
- 不修改 Milvus、PostgreSQL 持久化层、前端 LangSmith ReactFlow viewer。

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
| 2026-05-15 LangChain 指南 | `createAgent` 需要新增 `langchain` 依赖 | 2026-08-28 已关闭：在 canonical Agentic 叶子引入 `langchain` + `zod`，不让 agent 接管检索 scope | completed |

### Tasks

- [x] T1: 新增 `src/lib/rag/core/workflow.ts`，封装 LangChain Runnable workflow。
- [x] T2: `/api/ask` 改为通过 workflow 执行 kernel，并复用 LangSmith root run id/thread id。
- [x] T3: 补 `kernel.test.mjs` workflow 回归。
- [x] T4: 更新 LangChain / LangGraph / LangSmith 指南和 solution 记录。
- [x] T5: 跑定向验证并做 review。
- [x] T6: 对齐 `langchain` / core / LangGraph / Zod 依赖版本。
- [x] T7: TDD 实现只读、scope-bound 的真实 `createAgent` 叶子。
- [x] T8: 将 canonical `/api/ask` Agentic policy 默认接到 createAgent，并保留 legacy 回滚。
- [x] T9: 覆盖全局工具上限、模型/graph 上限的 route 错误映射、取消、generation deadline 和 partial failure envelope。
- [x] T10: 更新 Agentic、LangChain/LangGraph、环境和 solution 文档。
- [x] T11: 执行定向类型、lint、agent、route、Kernel、LangSmith 与旁路回归并复审。

## Phase 3: Work Log

- 新增 `prepareRagWorkflowRun`：生成 deterministic fallback trace id、thread id、tags、metadata、RunnableConfig。
- 新增 `createRagKernelWorkflow`：用 `RunnableSequence` / `RunnableLambda` 包装 `RagKernel.execute`，并在失败时补 policy/trace 上下文。
- 新增 `invokeRagKernelWorkflow`：为 API 层提供一次性调用 helper，确保动态 RunnableConfig 真正传入 invoke。
- `/api/ask` 改为在 LangSmith root run 内调用 workflow，并复用 `langSmithRun.runId/threadId`。
- `LANGCHAIN_LANGGRAPH_GUIDE.md`、`LANGSMITH_LATEST_GUIDE.md`、`docs/solutions/2026-06-11-langchain-rag-workflow.md` 记录实现边界。

### 2026-08-28 Follow-up：LangSmith root 隐私边界

- 原“双 hide 后接 callback bridge”的方案在安全复审中撤回：LangSmith input/output processors 不清洗 child 的 `error`/stack，无法保证 provider/tool 错误不回显 evidence、endpoint 或 credential fragment。
- 当前所有 Runnable/model/tool child spans 都被请求级和最内层 callback 边界强制绑定到 non-networked discard client；workflow 会透传这个私有 manager 以保留本地 parentage，但不会向 LangSmith 上传 child。真实 `createAgent` 证明仅靠 `tracingEnabled=false` 不足以阻止 graph context 切换后重建 env tracer。
- 手工 root inputs 强制收敛为数值/布尔摘要（问题正文只记录长度），失败只写稳定码 `RAG_EXECUTION_FAILED`；completion patch 为 best-effort，失败不改变已成功业务响应。
- tracing disabled、无手工 client 或 root 创建失败时继续本地执行，不改变 `/api/ask` 响应与 headers 合同。
- 当时“不引入顶层 `langchain/createAgent`”的结论已被后续用户澄清 supersede；原 Runnable workflow harness 仍保留。

### 2026-08-28 Follow-up：真正的 `createAgent` 叶子

- 新增 `langchain@1.5.10`、`zod@4.4.3`，并把 `@langchain/core` / `@langchain/langgraph` 对齐到兼容版本。
- 新增 `scoped-retrieval-agent.ts`：真实调用顶层 `createAgent`，注册唯一的无参数只读 context tool，执行模型 → 工具 → 模型。
- `useAgenticRAG=true` 的 canonical `/api/ask` 默认选择该路径；`RAG_AGENTIC_RUNTIME=legacy` 只作为显式服务端回滚。
- agent 不接触 Milvus/PostgreSQL，也不能提供 tenant、corpus、query 或 filter；scope/integrity 校验后会在任何模型 await 前复制并冻结工具快照，后续只读取该本地 snapshot。
- 单次工具、两次模型调用、graph recursion guard、统一 generation deadline、AbortSignal 和稳定错误码共同 fail closed。
- Agentic 失败（包括模型工厂同步失败）保留 content-free partial evidence identity/lane execution，并准确记录 `evidence_ready -> generating -> failed`；内部 messages/tool context 不进入 HTTP 响应。
- canonical success 为既有 UI 投影真实的 scoped retrieval/model/tool/model 阶段和带 `analysisMode` 的查询分析，不伪造 legacy grader、重写字段或向量分数；无 evidence/abstention 显示 skipped agent。durable 首次结果与 replay 以严格 allowlist 保留相同 agent/workflow 诊断。

## Phase 4: Review

### 5 + 1 视角

| 视角 | 结论 |
|------|------|
| 架构 | Pass。workflow 是 kernel 外层 harness，没有把复杂策略改成 agent 黑盒。 |
| 安全 | Pass。agent 无新写工具；证据快照在 await 前复制，未知工具计入全局预算；LangChain child 强制使用 non-networked discard client，外部 tracer 会被替换，root input/error 采用 content-free 投影。 |
| 性能 | Conditional Pass。canonical 可回答请求固定为模型 → 工具 → 模型，受 30 秒 generation 总预算约束；新增 `langchain`/`zod` 及对齐依赖已锁定，真实 provider 延迟与费用仍需部署 canary。 |
| 代码质量 | Pass。错误路径包含 policy/trace 上下文；命名保留业务语义。 |
| 测试覆盖 | Pass。覆盖真实 createAgent loop、scope/快照/预算/取消、route/durable/UI 投影、LangSmith 私有边界和原 kernel workflow 回归。 |
| 集成连续性 | Pass。`/api/ask` 响应和 headers 保持兼容；`RagKernel.execute` 仍是真实执行点。 |

### 验证

- `node src/lib/rag/core/kernel.test.mjs` -> pass (5/5)
- `node src/lib/langsmith/config.test.mjs` -> pass (3/3)
- `node node_modules/eslint/bin/eslint.js src/lib/rag/core/workflow.ts src/lib/rag/core/kernel.test.mjs src/app/api/ask/route.ts` -> pass
- `npx tsc --noEmit --pretty false --incremental false` -> pass
- `git diff --check` -> pass

2026-08-28 follow-up：

- `node src/lib/langsmith/config.test.mjs` -> pass (9/9)，包含真实 `createAgent` 内部 spans 全量绑定 discard client、无手工 client 时 legacy tracer 旁路、Client 构造失败降级、root input/error 脱敏，以及 completion patch 失败不改变业务成功。
- `node src/lib/rag/core/kernel.test.mjs` -> pass (14/14)，包含私有 callback tree 内 workflow execute child 与真实 createAgent 的本地 parentage；不代表生产 LangSmith child 已上传。
- `node src/lib/rag/agents/scoped-retrieval-agent.test.mjs` -> pass (12/12)，覆盖真实 tool loop、调用方外部 tracer 替换且本地 callback 保留、模型 tool-calling 前置、跳过/额外/未知/重复工具、取消、跨 tenant、canonical context 完整性与并发 pack 篡改。
- `node src/components/canonical-create-agent-ui.test.mjs` -> pass (2/2)，覆盖 canonical 首页不生成 legacy mock 数据，以及 Trace Viewer 不读取错误的 legacy 检索字段。
- `node src/app/api/ask/route.test.mjs` -> pass (50/50)，覆盖默认 createAgent、canonical query/UI 投影、无 evidence 跳过 agent、durable agent replay、legacy 回滚、未知 runtime 拒绝、取消、模型工厂及 invoke 的 `generating -> failed` partial envelope，以及 `RAG_AGENT_MAX_STEPS` / `RAG_AGENT_TOOL_LIMIT` 对外 `max_steps` 映射。
- 有效循环在一次工具、两次模型调用内自然终止；`RAG_AGENT_MAX_STEPS` 是异常 graph/model recursion 的最终安全映射，本轮由 route-level fixture 验证公共 envelope，未伪称用正常 FakeToolCallingModel 直接触发该内部异常分支。
- 定向 ESLint、`node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false`、`git diff --check` -> pass。
- 最终代码的 production `next build` Turbopack compile 成功；完整命令随后在 TypeScript worker 启动处被当前 Windows sandbox 的 `spawn EPERM` 阻断，此前 compile-only 尝试也在 page-data worker 处遇到同一环境阻断，因此不把完整 build 记为 pass。
- LangSmith Cloud 实际落盘与回读仍未在本地 hermetic 测试中验证。
- `pnpm test:rag-kernel` 串行跑已通过 agent/route/durable/hybrid/contextual/MiroFish 等分组，但在既有 PDF asset-store 累计恢复测试中无输出挂起后被有界终止；后续测试分组和疑似挂起的单用例隔离运行均通过，因此不把整条命令记为 pass。

## Phase 5: Compound

### 经验

- 对本项目而言，`@langchain/core/runnables` 继续承担 workflow harness；现在已经存在真实 tool loop 需求，因此只在 canonical scope/retrieval 之后的最小叶子引入 `langchain/createAgent`。
- LangSmith root run 与 LangChain RunnableConfig 要共享 `runId/threadId`，避免 trace/filter 语义分叉。

### Skill 信号

- `sprint --auto` 适合本类中风险架构改造：先官方文档确认边界，再小步落到 kernel 层，最后测试覆盖 metadata 和兼容性。
