# LangSmith 最新特性接入指南

> 当前实现边界说明（2026-08-28）：本文件保留 LangSmith 专项配置入口；完整的当前调用链、LangGraph 迁移事实、前端 viewer 边界、已实现/未实现能力及风险矩阵，以 [LANGCHAIN_LANGGRAPH_GUIDE.md](LANGCHAIN_LANGGRAPH_GUIDE.md) 为准。Engine、Multi-turn Evals、Context Hub 和 Sandboxes 在本仓库中仍是候选方向，不是已完成的 SDK 集成。

本项目在本地观测和自建 PostgreSQL 持久化之外，真实接入了 LangSmith 的 RunTree、thread metadata 与 feedback。Engine、Insights Agent、Multi-turn Evals、Context Hub 和 Sandboxes 仅有数据前置或路线说明，当前没有对应 SDK 调用闭环。

## 当前真实接入与候选前置

| LangSmith 能力 | 项目落地 |
| --- | --- |
| Threads | adapter 为 run metadata 构建 `thread_id`、`session_id`、`conversation_id`；hide-metadata 会移除这些字段，且未实现 Multi-turn Eval rubric/runner |
| Run filtering 前置 | run tags 和 metadata 已标准化；未调用 SmithDB 专属管理接口 |
| Engine 前置 | traces 携带 policy、model、vector backend、route；未实现 Engine/Insights Agent 调用 |
| Feedback | `/api/traces/[traceId]/feedback` 在 primitive score、UUID runId、PostgreSQL 前置写成功等条件满足时，best-effort 调用 LangSmith `createFeedback` |
| Run tree | `LocalRAGSystem.askWithDetails()` 的 mirror adapter 已实现并有测试；当前 canonical `/api/ask` 五个 policy 都不走该路径，唯一 legacy Self-RAG 调用只是正常不可达的 fallback |
| ReactFlow graph | 前端同名 viewer 使用 `@xyflow/react` 展示本地 workflowSteps/decisionPath，不读取 LangSmith Cloud |
| LangChain workflow metadata | `/api/ask` 通过 `invokeRagKernelWorkflow` 生成 RunnableConfig，统一 `runName`、tags、metadata、`thread_id` |
| SDK baseline | 当前直接依赖 `langsmith@0.7.3`，项目声明 `ws@^8.21.0` |

## 环境变量

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_xxxxx
LANGSMITH_PROJECT=rag-system

# 可选
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=
LANGSMITH_TRACING_SAMPLING_RATE=1
LANGSMITH_TRACING_SAMPLE_RATE=1
# 手工 root 的纵深隐藏；LangChain child 仅写入 non-networked discard client
LANGSMITH_HIDE_INPUTS=true
LANGSMITH_HIDE_OUTPUTS=true
LANGSMITH_HIDE_METADATA=false
LANGSMITH_OMIT_RUNTIME_INFO=false
```

兼容旧变量：

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=rag-system
LANGCHAIN_ENDPOINT=https://api.smith.langchain.com
# 自动/default SDK Client 还可能读取：
# LANGSMITH_TRACING_V2=true
# LANGCHAIN_API_KEY=legacy-key
```

优先用原生 `LANGSMITH_TRACING_SAMPLING_RATE` 作为手工与自动 tracing 的共同基线；项目自定义 `LANGSMITH_TRACING_SAMPLE_RATE` 只覆盖手工 Client，若两者都设置应保持相同值。`LANGSMITH_HIDE_METADATA=true` 会连同 `thread_id`、tenant、route、policy 等筛选字段一起移除；`LANGSMITH_OMIT_RUNTIME_INFO` 当前只由项目手工 Client 显式传入。

## Trace 语义

### `/api/ask` root run

每次非 replay 的实际 `/api/ask` 执行在项目手工 adapter 启用后都会分配 root identity，并尝试创建远端 root run。sampling=0、SDK 写入失败或 durable replay 时，identity/header 都不能作为云端已落盘证明。计划写入：

- `route=/api/ask`
- `rag_policy=memory | milvus-2step | agentic | adaptive-entity | mirofish-research`
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

`runWithLangSmithRootRun` 手写 API root。root inputs 强制只保留数值/布尔摘要，`/api/ask` 的问题正文只记录长度。Runnable/model/tool 的内部 child spans 仍会为 LangGraph/LangChain 本地执行而产生，但请求级 `traceable` 和显式 callback manager 都强制绑定 non-networked discard client；任何调用方或环境注入的 `langchain_tracer` 会在最内层被替换，因此这些 child 不会上传到 LangSmith。不能只用 `tracingEnabled=false`：真实 `createAgent` 在 graph async context 切换后可能重建 env tracer。`LANGSMITH_HIDE_INPUTS/OUTPUTS` 也只处理 input/output，不能清洗 child 的 `error`/stack，所以“双隐藏”不构成开放外传的授权。手工 root 失败只上报稳定错误码 `RAG_EXECUTION_FAILED`；Client 构造、root create 或 completion patch 失败都不会改变已完成的本地业务结果。

响应 header 会额外返回：

- `x-langsmith-run-id`
- `x-langsmith-thread-id`
- `x-langsmith-project`

这些 header 只证明 adapter 分配了 identity；不证明 Cloud root 已落盘。child 的外部上传按设计禁用。langsmith 0.7.3 可能在 SDK 内部吞掉远端 create/update 错误，因此必须通过 Cloud readback 单独核验手工 root。

### 本地 Observability mirror

`LocalRAGSystem.askWithDetails()` 的内置 trace 可 best-effort 尝试镜像到 LangSmith，但当前没有正常可达的 route 调用它；legacy Self-RAG 只有在始终存在的 `similaritySearch()` 方法缺失时才进入该理论 fallback：

- Trace -> root run
- Generation -> `llm` child run
- Vector Retrieval -> `retriever` child run
- Span/Event -> `chain` / `tool` child run
- Score -> LangSmith feedback

未配置 `LANGSMITH_API_KEY` 时，项目手写 RunTree adapter、trace mirror 和 feedback helper 会 no-op；但 `@langchain/core` 的自动 tracer 有独立的 SDK 环境/profile 解析，完整边界见统一指南。

## ReactFlow 可视化

前端已经直接接入 React Flow 12 官方包 `@xyflow/react`：

- `src/components/LangSmithReactFlowGraph.tsx` 是统一画布组件。
- `LangSmithTraceViewer` 的 ReactFlow tab 会把 workflow steps 转成可拖拽、可缩放的节点图。
- `SCRAGLangSmithViewer` 的 ReactFlow tab 会把 Self-Corrective RAG 的 decision path 转成同一套节点图。
- 画布包含 Controls、MiniMap、Background 和 `fitView`，适合检查本地 workflow/decision projection；它不回读 LangSmith Cloud run tree。

这个 UI 层只消费已有 workflow/decision 数据，不改变 `/api/ask` response 结构，也不影响后端 LangSmith trace mirror。

## 推荐使用方式

1. 开发环境先打开 `LANGSMITH_TRACING=true`，用 `LANGSMITH_PROJECT=rag-system-dev` 隔离数据。
2. 生产环境用稳定的 `sessionId` 作为多轮对话 ID；若未来真正接入 Multi-turn Evals，可在此 thread identity 上构建 rubric/runner。
3. 每次 RAG 策略、prompt、Milvus 参数或模型变更，都通过 tags/metadata 对比 run filtering。
4. 用户反馈可写 `/api/traces/[traceId]/feedback`，但本地、PostgreSQL、LangSmith 三层需分别核验；当前存在 PostgreSQL 前置失败和 durable traceId/UUID 不对齐边界。
5. 若未来接入 LangSmith Engine，再把其失败模式沉淀为项目 regression eval 或 `docs/plans/*` 修复任务。

## 后续路线

- Context Hub：把 `AGENTS.md`、RAG policy、prompt/eval rubric、skills 作为 context repo 管理，并用 `dev/staging/prod` tags 发布。
- Multi-turn Evals：为 `sessionId` 级别 conversation 配置 LLM-as-judge rubric，衡量任务完成、幻觉、检索质量和用户满意度。
- Sandboxes：只用于未来需要执行模型生成代码的 agent/eval，不进入当前 RAG 查询热路径。
