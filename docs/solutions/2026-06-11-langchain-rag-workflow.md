# LangChain RAG Workflow 改版

## 背景

项目此前已有 `RagKernel`、`RagPolicy`、LangGraph RAG 策略和 LangSmith root run，但 `/api/ask` 仍直接调用 kernel。这样能跑，但缺一层 LangChain 风格的 workflow harness：无法统一声明 `runName`、tags、metadata、`thread_id`，也不利于后续把 Claude Code 式“准备上下文 -> 执行任务 -> 审查输出”的工作流沉到 RAG 核心。

## 已落地

- 新增 `src/lib/rag/core/workflow.ts`：
  - `prepareRagWorkflowRun` 生成 thread/trace identity、tags、metadata、RunnableConfig。
  - `createRagKernelWorkflow` 用 `RunnableSequence` / `RunnableLambda` 包装 `RagKernel.execute`。
  - `invokeRagKernelWorkflow` 提供 `/api/ask` 的单步调用入口。
- `src/app/api/ask/route.ts` 改为通过 workflow 执行 kernel，并复用 LangSmith root run 的 `runId` / `threadId`。
- `src/lib/rag/core/kernel.test.mjs` 增加 workflow metadata 和 fallback trace id 回归。
- `LANGCHAIN_LANGGRAPH_GUIDE.md`、`LANGSMITH_LATEST_GUIDE.md` 同步更新当前实现边界。

## 设计决策

1. 继续不新增 `langchain` 顶层依赖。当前改版使用已安装的 `@langchain/core/runnables`，避免 lockfile 扩散。
2. `RagKernel.execute` 仍是真实执行点。LangChain workflow 只做可组合 harness、metadata、trace identity 和错误上下文。
3. LangSmith root run 仍由 `runWithLangSmithRootRun` 管理。RunnableConfig 与 root run 复用 `runId/threadId`，为后续自动 tracing 或 child run 接线留口。
4. 复杂 RAG 仍由 LangGraph/Policy 承接，不把 Agentic RAG / Adaptive Entity RAG 改成黑盒 `createAgent`。

## 验证

- `node src/lib/rag/core/kernel.test.mjs`
- `node src/lib/langsmith/config.test.mjs`

## 后续

- 若要真正使用 `createAgent`，再单独新增 `langchain` + `zod`，并优先落在结构化提取、guardrail、轻量工具 agent 这些叶子节点。
- 后续可把 workflow RunnableConfig 传入内部 LLM/retriever child calls，减少手写 RunTree 与 LangChain 自动 tracing 的割裂。
