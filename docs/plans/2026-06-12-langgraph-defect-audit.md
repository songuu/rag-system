---
title: "LangGraph 缺陷审计与 LangChain Runnable 迁移"
type: sprint
status: completed
created: "2026-06-12"
updated: "2026-06-15"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, rag, langgraph, langchain, langsmith, audit]
aliases: ["langgraph-defect-audit"]
invariants:
  - "旧 LangGraph runtime 全部迁移为 LangChain Runnable 编排"
  - "保持现有 RAG 业务节点、API 导出和前端消费契约兼容"
  - "至少 3 轮检测，覆盖静态扫描、定向测试、lint、typecheck、build"
invariant_tests:
  - "rg -n \"@langchain/langgraph|StateGraph|Annotation\\.Root|LangGraph\" src/lib/agentic-rag.ts src/lib/self-corrective-rag.ts src/lib/reasoning-rag.ts src/lib/intent-router.ts src/lib/adaptive-entity-rag.ts"
  - "rg -n \"LangGraph|StateGraph|Annotation|agentic|self.?corrective|reasoning|intent router|routeIntent|executeSCRAG|executeReasoningRAG|streamQuery\" src -g \"*.test.mjs\" -g \"*.test.ts\" -g \"*.spec.ts\""
  - "npx tsc --noEmit --pretty false --incremental false"
deferred: []
deadcode_until: []
---

# LangGraph 缺陷审计与 LangChain Runnable 迁移

## 实施结果

本计划已从审计落地为实现：旧 `StateGraph` / `Annotation.Root` runtime 已从 Agentic RAG、Self-Corrective RAG、Reasoning RAG、Intent Router 移除，统一改为 LangChain `RunnableLambda` 子节点编排。`buildIntentRouterGraph`、`buildSCRAGGraph`、`buildReasoningRAGGraph` 和 `AgenticRAGSystem` 的对外入口保持兼容。

新增共享 helper：
- `src/lib/rag/core/langchain-state-workflow.ts`：统一创建 node-level Runnable、注入 `graph_name/node_name` metadata、合并状态 patch。

核心迁移：
- `src/lib/agentic-rag.ts`：保留 fan-out、检索评分、rewrite retry、generate、finalize 流程，`streamQuery()` 改为输出清洗后的状态快照，避免 raw graph chunk 泄露 `debugInfo.milvusQueryVector` / `milvusRawScores`。
- `src/lib/self-corrective-rag.ts`：保留 retrieve → grade → rewrite loop → generate 语义，显式追加 `decisionPath` / `nodeExecutions`。
- `src/lib/reasoning-rag.ts`：保留 orchestrator → gateway → retrieval → reranker → formatter → generator 语义，显式追加 `scratchpad` / `decisionPath` / `nodeExecutions`。
- `src/lib/intent-router.ts`：保留 quick route 和 fallback route，`buildIntentRouterGraph().invoke()` 仍可用。
- `src/lib/adaptive-entity-rag.ts`：修正文案漂移，从“基于 LangGraph”改为 “LangChain Runnable-inspired”。

发布 blocker 修复：
- `src/lib/pdf-parser.ts`：补齐 LiteParse result/page 类型，修复全量 `tsc` 的隐式 `any`。
- `src/types/llamaindex-liteparse.d.ts`：为 `@llamaindex/liteparse` 增加本地类型声明。
- `src/lib/rag/core/kernel.test.mjs`：修复缺失的 test 闭合，恢复核心 kernel 测试。

## 实施后验证

第一轮：
- `rg -n "@langchain/langgraph|StateGraph|Annotation\\.Root|LangGraph" src/lib/agentic-rag.ts src/lib/self-corrective-rag.ts src/lib/reasoning-rag.ts src/lib/intent-router.ts src/lib/adaptive-entity-rag.ts`：无命中。
- `node src/lib/langchain-workflow-migration.test.mjs`：5/5 pass。

第二轮：
- `node node_modules/eslint/bin/eslint.js src/lib/agentic-rag.ts src/lib/self-corrective-rag.ts src/lib/reasoning-rag.ts src/lib/intent-router.ts src/lib/adaptive-entity-rag.ts src/lib/rag/core/langchain-state-workflow.ts src/lib/langchain-workflow-migration.test.mjs`：pass。
- `npx tsc --noEmit --pretty false --incremental false`：pass。
- `node src/lib/pdf-parser.test.mjs`：6/6 pass。

第三轮：
- `node src/lib/rag/core/kernel.test.mjs`：6/6 pass。
- `node src/lib/langsmith/config.test.mjs`：3/3 pass。
- `git diff --check`：pass，仅 Git 报 CRLF 工作区提示。
- `pnpm build`：pass，Next.js production build 成功。

## 审计基线

以下内容是 2026-06-12 的改造前缺陷基线，用于追溯本次迁移的来源。

## 结论

项目里的 LangGraph 主要缺陷不是“版本太旧”或“当前编译不过”，而是只使用了 `StateGraph` 做一次性状态机编排，没有接入 LangGraph 最有价值的 production primitives：`checkpointer` / `thread_id` 持久化、interrupt / human-in-the-loop、明确的 streaming mode、graph node 级别 LangSmith tracing，以及针对图路由的回归测试。

当前已安装版本是较新的 `@langchain/langgraph@^1.3.2`、`@langchain/core@^1.1.48`、`langsmith@0.7.3`。所以优先问题不是升级依赖，而是实现方式没有对齐最佳实践。

## 官方基线

- LangGraph 官方定位：低层 orchestration runtime，核心价值是 durable execution、streaming、human-in-the-loop、persistence，并与 LangSmith 调试/评估结合。
  Source: https://docs.langchain.com/oss/javascript/langgraph/overview
- Persistence 基线：graph 编译时传入 `checkpointer` / `store`，调用时通过 `configurable.thread_id` 绑定线程级状态。
  Source: https://docs.langchain.com/oss/javascript/langgraph/persistence
- Interrupt 基线：interrupt 依赖 checkpointer 和 thread id；payload 需要 JSON serializable；不应被普通 try/catch 包住。
  Source: https://docs.langchain.com/oss/javascript/langgraph/interrupts
- Streaming 基线：生产级 progress/event stream 应声明 `streamMode`，需要自定义事件时通过 writer 输出 `custom` stream，可组合 `["updates", "custom"]`。
  Source: https://docs.langchain.com/oss/javascript/langgraph/streaming

## 源码事实

| 模块 | 当前状态 | 关键位置 |
|------|----------|----------|
| Agentic RAG | 真实使用 `StateGraph`，但 bare `compile` / one-shot `invoke` / raw graph `stream` | `src/lib/agentic-rag.ts:169`, `src/lib/agentic-rag.ts:1074`, `src/lib/agentic-rag.ts:1099`, `src/lib/agentic-rag.ts:1169`, `src/lib/agentic-rag.ts:1246` |
| Self-Corrective RAG | 真实使用 `StateGraph`，但 bare `compile` / one-shot `invoke` | `src/lib/self-corrective-rag.ts:139`, `src/lib/self-corrective-rag.ts:828`, `src/lib/self-corrective-rag.ts:842`, `src/lib/self-corrective-rag.ts:902` |
| Reasoning RAG | 真实使用 `StateGraph`，但 bare `compile` / one-shot `invoke` | `src/lib/reasoning-rag.ts:209`, `src/lib/reasoning-rag.ts:1293`, `src/lib/reasoning-rag.ts:1341`, `src/lib/reasoning-rag.ts:1425` |
| Intent Router | 真实使用 `StateGraph`，但每次调用构建 graph，且无持久化配置 | `src/lib/intent-router.ts:114`, `src/lib/intent-router.ts:361`, `src/lib/intent-router.ts:366`, `src/lib/intent-router.ts:388` |
| Adaptive Entity RAG | 文件注释和设计文案说“基于 LangGraph”，但没有真实 `StateGraph` 使用 | `src/lib/adaptive-entity-rag.ts:6` |
| RAG Kernel Workflow | 新增的是 LangChain Runnable workflow，不是 LangGraph graph | `src/lib/rag/core/workflow.ts` |

## 缺陷清单

### P1: 没有 LangGraph persistence / thread 语义

现有 graph 都是 bare `workflow.compile()`，调用也没有 `configurable.thread_id`。这意味着 graph state 只在单次请求内存在，无法跨请求恢复、无法 time travel、无法在中断后继续，也无法把用户会话和 graph checkpoint 对齐。

影响：
- 不能实现 Claude Code workflow 那类“中断 -> 用户确认 -> 继续”的 durable loop。
- 长链路 RAG 若中途失败，只能重跑，不能从 checkpoint 恢复。
- LangSmith / UI 里的 thread identity 与 LangGraph 内部状态没有真实绑定。

建议：
- 为需要多轮/可恢复的 graph 引入 checkpointer，例如开发期 `MemorySaver`，生产期再换 durable backend。
- graph invoke/stream 统一传入 `{ configurable: { thread_id } }`，优先复用 `/api/ask` 已生成的 LangSmith thread id。

### P1: LangGraph 真实使用范围和文档/命名存在漂移

`adaptive-entity-rag.ts` 宣称“基于 LangGraph 的四层架构设计”，但文件里没有 `StateGraph`。相反，真实 graph 在 Agentic / Self-Corrective / Reasoning / Intent Router 中。

影响：
- 后续重构时容易把 Adaptive Entity 当成已有 LangGraph 实现，错误估计迁移成本。
- 文档、前端可视化、策略命名可能对用户过度承诺“graph-backed”能力。

建议：
- 将 Adaptive Entity 标为 “LangGraph-inspired design” 或补齐真实 StateGraph。
- 在指南中明确哪些策略是真实 LangGraph graph，哪些只是普通 class/workflow。

### P2: 仍使用旧式 `Annotation.Root`，没有对齐 schema-first 类型模式

四个 graph 都使用 `Annotation.Root(...)` 定义状态。官方 JavaScript 文档当前示例偏向 `StateSchema`、`MessagesValue`、`GraphNode` 这一类 schema-first 写法。当前模式能跑，但类型表达弱，node 签名和 reducer/default 逻辑分散。

影响：
- 状态字段增长后容易出现 reducer/default 漏配。
- node 输入输出的类型边界不够清晰，review 难判断某个节点到底允许改哪些字段。
- 与项目新写的 LangChain workflow typed metadata 风格不一致。

建议：
- 新 graph 不再扩散 `Annotation.Root` 写法。
- 旧 graph 迁移时优先从 Router 这种小图开始，抽出 `StateSchema` 和 node type。

### P2: Streaming 使用 raw graph stream，没有 typed event contract

`AgenticRAG.streamQuery()` 调用 `this.graph.stream(initialState, { recursionLimit: 30 })`，没有声明 `streamMode`，也没有用 writer 输出 custom progress event。

同时，Agentic state/debugInfo 可能包含 `milvusQueryVector`、`milvusRawScores` 等调试信息。raw graph chunk 如果直接透传到 SSE，会带来响应过大、调试字段泄露、前端事件契约不稳定的问题。

影响：
- 前端收到的是 graph state chunk，而不是稳定的 `step/progress/token/final/error` 事件。
- 后续接 LangSmith 或可视化 UI 时，不容易区分 node update、token stream、检索调试数据。

建议：
- 统一使用 `streamMode: ["updates", "custom"]`。
- node 内用 writer 发业务 progress event；SSE 层只白名单输出稳定字段。
- debug vector/raw score 只在显式 debug 模式或 server-side trace 中保留。

### P2: 缺少图拓扑和路由回归测试

当前测试只覆盖通用 kernel、LangSmith config、model catalog、structured output。没有找到针对 `StateGraph` graph topology、conditional edge、loop 上限、fallback path、route intent 的测试。

影响：
- 条件边改错时，可能直到运行时才发现。
- recursion loop、fallback route、empty retrieval 等核心路径没有防回归保护。
- 后续迁移 persistence/interrupt 时缺少安全网。

建议：
- 给 Intent Router 先补最小拓扑测试：multi-hop/entity/simple/fallback route。
- 给 Agentic RAG 补 loop 上限和 fallback node 测试。
- persistence 改造后补同一 `thread_id` resume 行为测试。

### P3: Interrupt / human-in-the-loop 只是能力缺口，不是当前运行 bug

项目内没有 `interrupt(...)` 使用，也没有 checkpointer/thread id，所以目前不能实现 LangGraph 官方 HITL 模式。但如果当前产品没有人工确认节点，这不是线上 bug，而是下一阶段架构能力缺口。

建议：
- 只有在引入“人工确认检索范围 / 审核回答 / 工具调用审批”时再接 interrupt。
- interrupt payload 保持 JSON serializable，不把复杂 class、Document 实例、Error 对象直接塞进去。

### P3: LangSmith 观测主要停在外层 root run

`/api/ask` 已经通过 LangChain Runnable workflow 复用 LangSmith run id/thread id，但旧 LangGraph graph 节点没有统一接入 config/callbacks/metadata。现有 `workflowSteps` / `decisionPath` 更像手写业务 trace，不等于 LangGraph node-level trace tree。

影响：
- LangSmith UI 里不一定能按 graph node 精确定位耗时、失败和重试。
- 手写 trace 与 LangChain/LangGraph 自动 tracing 存在语义分叉。

建议：
- 将 `RunnableConfig` 继续下传到 graph invoke/LLM/retriever child calls。
- graph node metadata 标准化：`rag_policy`、`graph_name`、`node_name`、`thread_id`、`route`、`retrieval_strategy`。

## 优先级建议

1. 先修事实漂移：明确 Adaptive Entity 是否真的要改成 LangGraph。
2. 再做最小 persistence：Intent Router 或 Agentic RAG 选一个小闭环，接 `checkpointer + thread_id`。
3. 同步补图测试：先覆盖 route/loop/fallback，再迁移 schema。
4. 最后统一 streaming + LangSmith child tracing。

## 验证记录

- `rg -n "StateGraph|Annotation\\.Root|\\.compile\\(|\\.invoke\\(|\\.stream\\(|MemorySaver|checkpointer|interrupt\\(|thread_id|streamMode|writer" src/lib/agentic-rag.ts src/lib/self-corrective-rag.ts src/lib/reasoning-rag.ts src/lib/intent-router.ts src/lib/adaptive-entity-rag.ts`
  - 确认 4 个真实 `StateGraph`，未发现 `MemorySaver` / `checkpointer` / `interrupt` / `thread_id` / `streamMode` / writer。
- `rg -n "LangGraph|StateGraph|Annotation|agentic|self.?corrective|reasoning|intent router|routeIntent|executeSCRAG|executeReasoningRAG|streamQuery" src -g "*.test.mjs" -g "*.test.ts" -g "*.spec.ts"`
  - 未发现 dedicated LangGraph graph 测试；命中的只是 model/structured-output/kernel/langsmith config 测试。
- `npx tsc --noEmit --pretty false --incremental false`
  - 当前失败点是 `src/lib/pdf-parser.ts` 的 `@llamaindex/liteparse` 模块解析和 `page` 隐式 any；未发现 LangGraph 相关 TypeScript 错误。
