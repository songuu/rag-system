# LangChain RAG Workflow 改版

> 当前架构、真实 `createAgent` 实现和从零搭建/部署/验收 runbook：
> [LangChain / LangGraph / LangSmith 完整实现、架构与搭建指南](../../LANGCHAIN_LANGGRAPH_GUIDE.md)

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

## 设计决策（2026-06-11 原始范围）

1. 当时不新增 `langchain` 顶层依赖，只使用已安装的 `@langchain/core/runnables`。该范围已被 2026-08-28 的明确 `createAgent` 要求 supersede，但 workflow harness 设计继续保留。
2. `RagKernel.execute` 仍是真实执行点。LangChain workflow 只做可组合 harness、metadata、trace identity 和错误上下文。
3. LangSmith root run 仍由 `runWithLangSmithRootRun` 管理。RunnableConfig 与 root run 复用 `runId/threadId`，为后续自动 tracing 或 child run 接线留口。
4. 复杂 RAG 仍由 LangGraph/Policy 承接，不把 Agentic RAG / Adaptive Entity RAG 改成黑盒 `createAgent`。

## 验证

- `node src/lib/rag/core/kernel.test.mjs`
- `node src/lib/langsmith/config.test.mjs`

## 后续

- 已于 2026-08-28 真正引入 `langchain` + `zod`，落在 canonical Agentic policy 的受限叶子节点；详见下方闭环。

## 2026-08-28 后续闭环

- 安全复审撤回了原“双 hide 后接 callback bridge”的方案：LangSmith input/output hiding 不处理 child `error`/stack，无法阻止 provider/tool 错误回显私密内容。
- 当前所有 LangChain Runnable/LLM/tool child spans 都会在本地执行，但请求级 `traceable`、workflow callback manager 和最内层 agent callback 会把任何 upload-capable tracer 替换为 non-networked discard client；生产对外只保留手工 root。真实 `createAgent` 回归证明仅靠 `tracingEnabled=false` 无法覆盖 graph context 切换后的 env tracer 重建。
- 手工 root inputs 只允许数值/布尔摘要，问题正文只记录长度；失败只写 `RAG_EXECUTION_FAILED`。root completion patch 失败是 best-effort telemetry，不会把已完成回答变成 500。
- disabled、无手工 client 与 root create 失败仍保持本地 no-op/fallback；Cloud root 是否真正落盘必须另做远端 readback。

## 2026-08-28 真正 `createAgent` 闭环

- `src/lib/rag/agents/scoped-retrieval-agent.ts` 直接调用顶层 `langchain.createAgent`，执行模型 → `read_scoped_rag_context` → 模型，不再只是把现有 Runnable 称为 agent。
- `/api/ask` 的 `agentic` policy 默认先走服务端 scope、dense retrieval、evidence validation/context composition，再调用该 agent；agent 没有 Milvus/PostgreSQL 工具，也不能提交 tenant、corpus、query 或 filter。
- 工具 schema 为严格空对象；scope/integrity 校验后、任何模型 await 前复制冻结 snapshot，工具只返回该本地副本。全局 tool/model call middleware、recursion guard、generation deadline 和 AbortSignal 共同限制循环。
- `RAG_AGENTIC_RUNTIME=legacy` 保留旧 `AgenticRAGSystem` 的显式回滚，默认或 `create-agent` 使用新实现，未知值 fail closed。
- HTTP 只公开 runtime、工具调用次数和已服务 evidence IDs；内部 messages/tool payload 不进入响应。失败时 Kernel envelope 仅保留 content-free partial evidence identity 和 lane 状态，并记录已进入 `generating` 后失败。
- canonical success 额外投影真实的 scoped retrieval/model/tool/model 阶段和 discriminated query analysis 给既有首页面板，明确显示 `LangChain createAgent`，不伪造旧 grader/self-reflection/hallucination、legacy 查询字段或固定向量分数；无 evidence/abstention 显示 agent skipped。durable 首次响应与 replay 以严格 allowlist 保留同一诊断。
- hermetic agent 测试 12/12、canonical ask route 50/50、canonical UI contract 2/2；真实部署 provider/model 的原生 tool-calling canary 仍需在对应环境执行。
- TypeScript、定向 ESLint、Kernel 14/14、LangSmith 隐私 9/9 和 legacy migration 8/8 均通过。LangSmith 回归用真实 `createAgent` 验证内部 spans 全量绑定 discard client，并覆盖 root content-free inputs、稳定错误、legacy tracer 旁路、Client 初始化失败降级和 completion patch best-effort。有效循环不会自然超过两次模型调用；异常 `RAG_AGENT_MAX_STEPS` 的公共映射由 route fixture 验证。production Turbopack compile 成功，但完整 Next build 在 worker 启动处被当前 Windows sandbox 的 `spawn EPERM` 阻断。整套 `pnpm test:rag-kernel` 在既有 PDF asset-store 累计恢复测试中无输出挂起后有界终止；其后测试分组及疑似挂起单例隔离验证通过，故不把整条串行命令宣称为 pass。
