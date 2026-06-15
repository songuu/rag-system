# LangChain Runnable RAG 迁移

## 背景

`docs/plans/2026-06-12-langgraph-defect-audit.md` 识别出旧 RAG 模块只使用 `StateGraph` 做单次状态机编排：没有持久化 thread 语义、没有 typed streaming contract、缺少图路由回归测试，并且 Adaptive Entity 文案承诺与源码不一致。

本次按用户要求直接落地实现：不再继续保留这些旧 LangGraph runtime，改为 LangChain Runnable 编排。

## 已落地

- 新增 `src/lib/rag/core/langchain-state-workflow.ts`，用 `RunnableLambda` 包装每个 workflow node，并统一注入 `graph_name` / `node_name` metadata。
- `src/lib/agentic-rag.ts` 移除 `StateGraph` / `Annotation.Root`，保留原 fan-out、grade、rewrite retry、generate、finalize 业务流程。
- `src/lib/agentic-rag.ts` 的 `streamQuery()` 不再透传 raw graph chunk，改为输出清洗后的状态快照，避免 debug vector/raw score 进入 SSE。
- `src/lib/self-corrective-rag.ts` 改为显式 Runnable loop，保持 retrieve → grade → rewrite → retrieve → generate 语义。
- `src/lib/reasoning-rag.ts` 改为显式 Runnable pipeline，保持 orchestrator → gateway → hybrid retrieval → reranker → formatter → generator 语义。
- `src/lib/intent-router.ts` 改为 Runnable workflow，保留 `buildIntentRouterGraph().invoke()` 兼容契约。
- `src/lib/adaptive-entity-rag.ts` 修正文案，从 “基于 LangGraph” 改为 “LangChain Runnable-inspired”。
- 新增 `src/lib/langchain-workflow-migration.test.mjs` 覆盖迁移契约、Adaptive 文案漂移、Intent Router quick route 和 invoke 兼容。
- 修复 `src/lib/pdf-parser.ts` / `src/types/llamaindex-liteparse.d.ts`，解除全量 TypeScript blocker。
- 修复 `src/lib/rag/core/kernel.test.mjs` 缺失闭合，恢复核心测试。

## 验证

- `node src/lib/langchain-workflow-migration.test.mjs`：5/5 pass。
- `node src/lib/langchain-structured-output.test.mjs`：4/4 pass。
- `node src/lib/pdf-parser.test.mjs`：6/6 pass。
- `node src/lib/rag/core/kernel.test.mjs`：6/6 pass。
- `node src/lib/langsmith/config.test.mjs`：3/3 pass。
- `node node_modules/eslint/bin/eslint.js src/lib/agentic-rag.ts src/lib/self-corrective-rag.ts src/lib/reasoning-rag.ts src/lib/intent-router.ts src/lib/adaptive-entity-rag.ts src/lib/rag/core/langchain-state-workflow.ts src/lib/langchain-workflow-migration.test.mjs`：pass。
- `npx tsc --noEmit --pretty false --incremental false`：pass。
- `git diff --check`：pass，只有 CRLF 工作区提示。
- `pnpm build`：pass，Next.js production build 成功。

## 环境备注

`pnpm build` 初次触发 pnpm 自动 install 时被沙箱 `EPERM unlink` 卡住，随后用 `pnpm install --offline --frozen-lockfile` 在已批准权限下恢复 `node_modules/.bin` 和 `.modules.yaml`。恢复后 `pnpm build` 成功。
