---
title: "RAG Kernel Implementation"
type: sprint
status: completed
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, architecture, rag, kernel, retrieval-control-plane]
aliases: ["RAG Kernel 落地实现"]
---

# RAG Kernel Implementation

## Phase 1: Think

用户要求直接按照最新架构计划完整修改,并强调架构优先、功能优先。本轮落地选择:

- 保持现有功能和响应体兼容。
- 先把 `/api/ask` 接入 `RAG Kernel`。
- 把现有 memory / milvus / agentic / adaptive entity 变成 policy adapter。
- 新增 retrieval plan、corpus store、golden question 的基础结构,为后续 P1-P4 继续演进留出稳定接口。

## Phase 2: Plan

1. 新增 `src/lib/rag/core/*`。
2. 新增 `src/lib/rag/retrieval/*`。
3. 新增 `src/lib/rag/corpus/*`。
4. 新增 `src/lib/rag/eval/*`。
5. 修改 `/api/ask` 使用 kernel policy 分发。

## Phase 3: Work

### RAG Kernel

- `src/lib/rag/core/types.ts`
  - 定义 `RagQueryRequest`, `RagPolicyId`, `RagPolicy`, `RagKernelEnvelope`, `RagEvidence`。
- `src/lib/rag/core/kernel.ts`
  - 新增 `RagKernel<TOutput>`。
  - 负责按 policy id 执行 adapter,并生成最小 trace envelope。
- `src/lib/rag/core/policies.ts`
  - 新增 `createRagPolicy()`。
  - 新增 `resolveRagPolicyId()`,保持 `/api/ask` 旧模式选择逻辑。
- `src/lib/rag/core/context-composer.ts`
  - 新增 evidence context packing 基础函数。

### Retrieval Control Plane

- `src/lib/rag/retrieval/retrieval-plan.ts`
  - 新增 `RagRetrievalPlan` 和 lane 类型。
  - 为 memory、milvus、agentic、adaptive、self-corrective、reasoning、maic、mirofish 生成默认 plan。

### Corpus / Index Lifecycle

- `src/lib/rag/corpus/corpus-store.ts`
  - 新增 `Corpus`, `DocumentAsset`, `IndexManifest`。
  - 新增 `MemoryCorpusStore` 作为后续持久 store 的兼容先行实现。

### Evaluation Harness

- `src/lib/rag/eval/golden-questions.ts`
  - 新增默认 smoke golden questions。
  - 按 policy 过滤,为后续自动评估留入口。

### API Integration

- `src/app/api/ask/route.ts`
  - POST 请求先标准化为 `RagQueryRequest`。
  - `resolveRagPolicyId()` 决定 policy。
  - `RagKernel<NextResponse>` 执行现有处理函数。
  - 旧响应 JSON 不增加破坏性字段。
  - 响应 header 新增 `x-rag-policy` 和 `x-rag-trace-id`。

## Phase 4: Review

### 风险评估

- 风险等级: L3。
- 原因: 核心 API 入口改造,但没有改业务处理函数和响应体结构。
- 降风险策略:
  - policy resolver 单测覆盖旧模式选择。
  - kernel 单测验证 output 不被改变。
  - scoped ESLint 覆盖新增架构层和 `/api/ask`。

### 验证

- `node src\lib\rag\core\kernel.test.mjs` -> pass
- `node src\lib\rag\corpus\corpus-store.test.mjs` -> pass
- scoped `pnpm exec eslint ...` -> pass
- `npx tsc --noEmit --pretty false` -> fail,但错误集中在既有 `.next` validator、trace-trie、d3、LangGraph legacy 类型、reasoning-rag、model-config 等历史债务;本轮新增的 `src/lib/rag/*` 和改造后的 `src/app/api/ask/route.ts` 不再出现在错误列表里。
- `git diff --check` -> pass,仅有 Windows 换行提示。
- `rg -n "[ \t]+$" src/lib/rag docs/plans/2026-05-14-rag-kernel-implementation.md docs/solutions/2026-05-14-rag-kernel-implementation.md docs/plans/2026-05-14-rag-system-architecture-evolution.md docs/solutions/2026-05-14-rag-system-architecture-evolution.md` -> no trailing whitespace.

## Phase 5: Compound

### 复利记录

- 以后新增 RAG 模式时,先注册 policy adapter,不要继续直接扩展 `/api/ask` 的 if/else。
- retrieval plan 是跨 policy 的公共观测对象,后续 rerank、hybrid search、GraphRAG 都应落到 lane 里。
- Corpus store 先以内存实现固定契约,后续可替换为文件/SQLite/数据库持久实现。
