# RAG Kernel Implementation

## Problem

`/api/ask` 原本直接通过 `storageBackend`, `useAgenticRAG`, `useAdaptiveEntityRAG` 分支到不同 RAG 实现。继续这样扩展会让主入口越来越厚,也不利于复用 retrieval plan、trace、cache 和 eval。

## Solution

新增 `src/lib/rag/*` 架构层:

- `core`: kernel、policy、request/envelope 类型、context composer。
- `retrieval`: retrieval plan 和 lane。
- `corpus`: corpus/document/index manifest 契约。
- `eval`: golden question smoke 数据。

`/api/ask` 现在执行路径变为:

1. request body -> `RagQueryRequest`
2. `resolveRagPolicyId()`
3. `RagKernel<NextResponse>.execute()`
4. policy adapter 调用现有 memory/milvus/agentic/adaptive handler
5. 原 JSON 响应保持兼容
6. header 加 `x-rag-policy`, `x-rag-trace-id`

## Behavior Preservation

现有业务处理函数没有重写:

- memory 仍走 `getRagSystem().askWithDetails()`
- milvus 仍走原 two-step Milvus query
- agentic 仍走 `AgenticRAGSystem`
- adaptive entity 仍走 `createAdaptiveEntityRAG()`

因此前端依赖的响应字段继续保持原样。

## Verification

- `node src\lib\rag\core\kernel.test.mjs`
- `node src\lib\rag\corpus\corpus-store.test.mjs`
- scoped `pnpm exec eslint ...`
- `npx tsc --noEmit --pretty false` still fails on pre-existing repository type debt, but the new `src/lib/rag/*` layer and `src/app/api/ask/route.ts` are not in the final error list.
- `git diff --check`

## Next

下一阶段应把 rerank/fusion/cache 从具体 policy 中逐步抽到 shared retrieval control plane,再推进 corpus/index manifest 的持久化。
