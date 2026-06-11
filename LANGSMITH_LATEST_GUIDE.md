# LangSmith 最新特性接入指南

本项目已按 2026-05 LangSmith 最新发布方向升级观测链路：让 RAG 查询在本地可观测、Supabase 持久化之外，同时可以接入 LangSmith 的线程级追踪、反馈、Engine 自动诊断、Insights Agent 和 Multi-turn Evals。

## 已接入能力

| LangSmith 能力 | 项目落地 |
| --- | --- |
| Threads / Multi-turn Evals | 所有 LangSmith run metadata 都写入 `thread_id`、`session_id`、`conversation_id` |
| SmithDB 查询性能 | run tags 和 metadata 标准化，便于 trace tree、全文搜索、run filtering |
| Engine public beta | 生产 traces 携带 policy、model、vector backend、route 信息，便于 Engine 聚类失败和建议 eval |
| Feedback | `/api/traces/[traceId]/feedback` 会同步写入 LangSmith `createFeedback` |
| Run tree | 本地 `ObservabilityEngine` 的 Trace/Observation/Score 会 mirror 到 LangSmith root/child runs |
| ReactFlow graph | 前端 LangSmith viewer 直接使用 `@xyflow/react` 展示 RAG run tree / decision path |
| LangChain workflow metadata | `/api/ask` 通过 `invokeRagKernelWorkflow` 生成 RunnableConfig，统一 `runName`、tags、metadata、`thread_id` |
| SDK latest | `langsmith@0.7.1` 作为直接依赖，`ws@8.20.1` 满足现代 SDK peer |

## 环境变量

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_xxxxx
LANGSMITH_PROJECT=rag-system

# 可选
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=
LANGSMITH_TRACING_SAMPLE_RATE=1
LANGSMITH_HIDE_INPUTS=false
LANGSMITH_HIDE_OUTPUTS=false
LANGSMITH_HIDE_METADATA=false
LANGSMITH_OMIT_RUNTIME_INFO=false
```

兼容旧变量：

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=rag-system
LANGCHAIN_ENDPOINT=https://api.smith.langchain.com
```

## Trace 语义

### `/api/ask` root run

每个 `/api/ask` 请求在启用 LangSmith 后会生成一个 root run，并写入：

- `route=/api/ask`
- `rag_policy=memory | milvus-2step | agentic | adaptive-entity`
- `llm_model`
- `embedding_model`
- `vector_backend`
- `thread_id`
- `session_id`
- `conversation_id`

同时，`src/lib/rag/core/workflow.ts` 会为同一个请求准备 LangChain Runnable metadata：

- `runName=RAG API Ask Workflow`
- tags: `rag`, `rag-kernel`, `<rag_policy>`, `api-ask`
- `configurable.thread_id`
- `workflow_name`
- `request_id`
- `top_k`
- `similarity_threshold`
- `use_agentic_rag`
- `use_adaptive_entity_rag`
- `enable_reranking`

当前权威 root run 仍由 `runWithLangSmithRootRun` 手写 `RunTree` 管理；RunnableConfig 用于 LangChain/LangSmith 自动 tracing 或后续 child-run 接线时保持同一套筛选语义。

响应 header 会额外返回：

- `x-langsmith-run-id`
- `x-langsmith-thread-id`
- `x-langsmith-project`

### 本地 Observability mirror

`LocalRAGSystem` 的内置 trace 会同步到 LangSmith：

- Trace -> root run
- Generation -> `llm` child run
- Vector Retrieval -> `retriever` child run
- Span/Event -> `chain` / `tool` child run
- Score -> LangSmith feedback

未配置 `LANGSMITH_API_KEY` 时，上述逻辑全部 no-op，不影响本地开发。

## ReactFlow 可视化

前端已经直接接入 React Flow 12 官方包 `@xyflow/react`：

- `src/components/LangSmithReactFlowGraph.tsx` 是统一画布组件。
- `LangSmithTraceViewer` 的 ReactFlow tab 会把 workflow steps 转成可拖拽、可缩放的节点图。
- `SCRAGLangSmithViewer` 的 ReactFlow tab 会把 Self-Corrective RAG 的 decision path 转成同一套节点图。
- 画布包含 Controls、MiniMap、Background 和 `fitView`，适合检查 LangSmith run tree 的执行路径、状态、耗时和错误节点。

这个 UI 层只消费已有 workflow/decision 数据，不改变 `/api/ask` response 结构，也不影响后端 LangSmith trace mirror。

## 推荐使用方式

1. 开发环境先打开 `LANGSMITH_TRACING=true`，用 `LANGSMITH_PROJECT=rag-system-dev` 隔离数据。
2. 生产环境用稳定的 `sessionId` 作为多轮对话 ID，让 LangSmith Threads 和 Multi-turn Evals 能聚合完整会话。
3. 每次 RAG 策略、prompt、Milvus 参数或模型变更，都通过 tags/metadata 对比 run filtering。
4. 用户反馈优先写 `/api/traces/[traceId]/feedback`，让本地、Supabase、LangSmith 三层保持一致。
5. LangSmith Engine 检出的失败模式，沉淀为项目 regression eval 或 `docs/plans/*` 修复任务。

## 后续路线

- Context Hub：把 `AGENTS.md`、RAG policy、prompt/eval rubric、skills 作为 context repo 管理，并用 `dev/staging/prod` tags 发布。
- Multi-turn Evals：为 `sessionId` 级别 conversation 配置 LLM-as-judge rubric，衡量任务完成、幻觉、检索质量和用户满意度。
- Sandboxes：只用于未来需要执行模型生成代码的 agent/eval，不进入当前 RAG 查询热路径。
