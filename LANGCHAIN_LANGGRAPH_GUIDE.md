# LangChain / LangGraph / LangSmith：完整实现、架构与搭建指南

> 当前事实快照：2026-08-31
> 适用仓库：rag-system
> 主查询入口：`POST /api/ask`
> 文档目标：解释项目现在如何运行，并给出从零搭建、数据导入、真实 `createAgent` 联调、部署、验收和排障的完整过程；历史演进仅放在附录

本文以当前源码、依赖锁、测试和运行配置为权威。框架官网能力、旧指南、历史类名和未来规划都不能覆盖当前调用链。

全文使用四种证据状态：

| 状态 | 含义 |
| --- | --- |
| 当前运行事实 | 当前源码存在可从入口追到实现的调用链 |
| 已实现但当前不可达 | 代码与测试存在，但正常 route 没有触发点 |
| 条件能力 | 只有开关、凭据、provider 或部署条件满足时才运行 |
| 非当前能力 | 历史实现或未来候选，不属于现在的 runtime |

阅读路线：只看架构与真实调用链，阅读第 1–6 章；从空环境搭建并完成 canary，直接执行第 9 章；
审查当前验证事实、未知项和代码落点，阅读第 10–12 章。

## 1. 当前架构结论

### 1.1 三套技术现在分别做什么

| 技术 | 当前角色 | 项目中的真实结论 |
| --- | --- | --- |
| LangChain | LLM/RAG 叶子能力和轻量编排基础 | 真实运行。除 ChatModel、Embedding、Runnable 和结构化输出外，Agentic policy 已在 canonical 路径使用顶层 `createAgent`、tool 和 middleware |
| LangGraph | `createAgent` 的内部 runtime | Agentic 叶子循环由 `createAgent` 内部 LangGraph runtime 执行；项目没有手写 `StateGraph`/checkpointer/HITL，其他状态流程仍由 Runnable、TypeScript 控制流和自研 durable runtime 承担 |
| LangSmith | 可选外部观测接收端 | 当前 `/api/ask` 只对外上报 content-free 手工 RunTree root；含 evidence 的 Runnable/model/tool child spans 强制写入 non-networked discard client，不上传 Cloud；反馈接口会条件式同步 feedback；详细 Observation mirror 已实现但当前正常 route 不可达 |

理解当前系统时最重要的七个事实：

1. canonical 查询入口是 `POST /api/ask`，不是 Agentic、Adaptive、Self-Corrective、Reasoning 的专用旧 route。
2. `/api/ask` 先建立服务端身份和 corpus scope，再选择策略；客户端不能自己指定 tenant、actor 或 MiroFish server policy。
3. `RagKernel` 是统一执行边界，当前注册五个 policy：`memory`、`milvus-2step`、`agentic`、`adaptive-entity`、`mirofish-research`。
4. `RagLaneExecutor` 负责检索计划、预算、required/optional lane、超时、证据校验、去重和部分失败证据。
5. LangChain workflow 只做 prepare/execute harness；`agentic` policy 在 canonical scope、检索和 context composition 之后才调用受限 `createAgent` 叶子，不能取代 Kernel 或自行扩大检索范围。
6. PostgreSQL 是 durable 业务持久化面；Milvus/Zilliz 是主要向量检索面；LangSmith 只是可选外部观测面。
7. `createAgent` 内部使用 LangGraph 不等于项目已采用自定义 StateGraph、checkpointer 或 HITL；页面显示 LangSmith 也不代表 Cloud readback 已验证。

### 1.2 当前系统边界

~~~mermaid
flowchart TB
    subgraph WritePath[文档写入路径]
        U1[POST /api/upload] --> BLOB[Blob + Upload Manifest]
        BLOB --> PERSIST[(PostgreSQL 或本地开发存储)]
        U2[POST /api/pipeline] --> LOAD[Loader]
        LOAD --> SPLIT[LangChain Text Splitter]
        SPLIT --> CTX[Contextual Retrieval v2 可选]
        CTX --> EMB[Embedding Factory]
        EMB --> DENSE[(Milvus Dense)]
        EMB --> HYBRID[(Milvus Hybrid 可选)]
        LOAD --> PDF[PDF Visual Sidecar 可选]
    end

    subgraph QueryPath[当前查询路径]
        C[Client] --> ASK[POST /api/ask]
        ASK --> VALIDATE[输入限制与 schema 校验]
        VALIDATE --> SECURITY[Security Context + Retrieval Scope]
        SECURITY --> DURABLE{executionMode}
        DURABLE -->|sync| ROOT[LangSmith 手工 Root 可选]
        DURABLE -->|durable| DW[自研 Durable Ask]
        DW --> ROOT
        ROOT -->|共享业务 trace/thread identity| WF[LangChain Runnable Workflow]
        WF --> KERNEL[RagKernel]
        KERNEL --> POLICY[五类已注册 Policy]
        POLICY --> PLAN[Retrieval Plan]
        PLAN --> LANES[RagLaneExecutor]
        LANES --> DENSE
        LANES --> GEN{agentic policy}
        GEN -->|yes| AGENT[createAgent + scoped context tool]
        GEN -->|no| MODEL[Model Factory invoke]
        AGENT --> MODEL
        KERNEL --> ENV[RagKernel Envelope]
        ENV --> RESP[NextResponse + RAG Headers]
    end

    subgraph Observe[当前观测与持久化]
        ROOT -. best effort .-> SM[(LangSmith Cloud)]
        FB[Feedback API] --> LOCAL[本地 Trace 可选]
        FB --> PG[(PostgreSQL trace_scores)]
        FB -. 条件式 .-> SM
        LIB[askWithDetails library path] -. 当前正常 route 不可达 .-> DETAIL[Detailed Observability Mirror]
    end
~~~

上传和 pipeline 是两个独立操作入口：`/api/upload` 负责原始/解析资产与 manifest，`/api/pipeline` 负责加载、切分、向量化和入库。图中并不表示每次 upload 都会自动触发 pipeline。

### 1.3 当前分层

| 层 | 责任 | 当前核心文件 |
| --- | --- | --- |
| API/控制面 | 输入限制、身份、策略请求、响应映射 | `src/app/api/ask/route.ts`、upload/pipeline/traces routes |
| 安全边界 | 服务端 actor、tenant/corpus、capability、检索隔离 | `src/lib/security/request-context.ts`、`retrieval-scope.ts` |
| 工作流层 | 准备 trace/thread/tags/metadata，调用 Kernel | `src/lib/rag/core/workflow.ts` |
| Kernel 层 | policy 注册、执行、失败归一和 envelope | `src/lib/rag/core/kernel.ts`、`policies.ts`、`types.ts` |
| 检索执行层 | plan、lane、预算、deadline、证据安全 | `retrieval-plan.ts`、`lane-executor.ts`、lane handlers |
| LangChain 叶子层 | 模型、Embedding、Prompt、Message、Runnable、Parser、受限 agent/tool loop | `model-config.ts`、`embedding-config.ts`、`rag/agents/scoped-retrieval-agent.ts`、业务 RAG 模块 |
| 数据层 | 向量、blob、manifest、pipeline、trace、MAIC state | Milvus/Zilliz、PostgreSQL stores、本地开发 stores |
| 外部观测层 | RunTree root、自动 tracer、feedback | `src/lib/langsmith/*` |
| Durable 层 | idempotency、checkpoint、lease、replay、result artifact | `src/lib/rag/core/durable-*` |

## 2. 当前 `/api/ask` 查询实践

### 2.1 真实请求顺序

~~~mermaid
sequenceDiagram
    participant C as Client
    participant A as POST /api/ask
    participant S as Security Context
    participant D as Durable Ask 可选
    participant L as LangSmith Manual Root
    participant W as LangChain Workflow
    participant K as RagKernel
    participant P as Selected Policy
    participant E as RagLaneExecutor
    participant V as Retrieval Backends
    participant M as ChatModel

    C->>A: question + bounded options
    A->>A: body limit + validateAskInput
    A->>S: capability + requestedCorpusId
    S-->>A: server-owned actor tenant corpus scope
    A->>A: resolve server MiroFish policy
    alt durable
        A->>D: idempotency identity + checkpoint/result stores
        D->>L: execute-ask step
    else sync
        A->>L: direct execution
    end
    L->>W: root identity；child 外部上传关闭
    W->>W: prepare runName tags metadata RunnableConfig
    W->>K: request + policyId + AbortSignal
    K->>P: RagPolicyContext + default plan
    P->>E: plan + handlers + execution budget
    E->>V: execute required and optional retrieval lanes
    E->>M: generation or structured leaf calls
    E-->>P: evidence + laneExecutions + transitions
    P-->>K: RagPolicyResult
    K->>K: completed or failed envelope
    K-->>W: output + envelope
    W-->>A: NextResponse
    A-->>C: body + x-rag-* + optional x-langsmith-*
~~~

### 2.2 请求与安全边界

`POST` handler 当前执行以下硬边界：

1. 校验或生成 `x-request-id`；外部值只允许有限字符且最多 128 字符。
2. 通过 `readJsonObjectWithLimit` 限制 JSON body 大小。
3. `validateAskInput` 归一 question、模型、Embedding、topK、threshold、executionMode 和策略开关。
4. sync 请求要求 `query` capability；durable 请求要求 `manage-runtime` capability。
5. `resolveRagSecurityContext` 只允许 `local-dev` 或 `single-tenant-token` 两种 access mode。
6. production 禁止 `local-dev`；single-tenant 模式要求 Bearer token、固定 tenant/corpus 和角色能力。
7. `retrievalScope` 完全由服务端 security context 构造；body 中的旧 `userId`、`tenantId` 不参与身份决策。
8. 开启隔离后只允许能执行 corpus scope 的 Milvus policy，`memory` policy 会以 `UNSCOPED_RAG_POLICY` 拒绝。
9. MiroFish server policy 和 graph artifact identity 由服务端解析，不能由请求 JSON 直接注入。

这意味着：当前生产查询不是“客户端传几个 flag 就直接调用某个 RAG 类”，而是先经过身份、scope、server policy 和 capability 控制面。

### 2.3 Policy 选择优先级

`resolveRagPolicyId` 的当前顺序如下：

| 优先级 | 条件 | 结果 |
| --- | --- | --- |
| 1 | Milvus + `useAdaptiveEntityRAG` | `adaptive-entity` |
| 2 | Milvus + `useAgenticRAG` | `agentic` |
| 3 | Milvus + 服务端 `serverPolicyId` | `mirofish-research` |
| 4 | Milvus | `milvus-2step` |
| 5 | memory backend | `memory` |

因此 Adaptive 和 Agentic flag 会优先于服务端 MiroFish policy。若未来需要组合策略，不能只再加一个 boolean；应先重新定义互斥/组合语义和测试矩阵。

### 2.4 当前注册的五个 Policy

`RagPolicyId` 类型还包含 `self-corrective`、`reasoning`、`maic-course`，但当前 `/api/ask` 的 `createAskKernel()` 只注册下表五项。类型联合存在不等于 Kernel 已注册。

| Policy | 当前入口实现 | 实际 lanes/行为 | LangChain 实践 | 关键边界 |
| --- | --- | --- | --- | --- |
| `memory` | `handleMemoryQuery` | memory retrieval → generation-only | `Document`、Embedding、ChatModel invoke | 只适合未强制 tenant/corpus 隔离的本地开发 |
| `milvus-2step` | `handleMilvusQuery` | dense 或 ordered/hybrid/PDF visual → context pack → generation | Embedding、ChatModel、Prompt/Message | 当前默认的 Milvus 基线策略；实际线上流量分布需要部署侧观测确认 |
| `mirofish-research` | 同样使用 `handleMilvusQuery` | dense 必选；global/multi-hop 时可增加 server-scoped graph-entity lane | ChatModel + 项目 MiroFish artifact runtime | graph lane 可选且必须绑定 document/version/trust scope |
| `agentic` | `handleAgenticQuery` | 默认 dense required lane → canonical context pack → `createAgent` 模型/工具/模型；`legacy` 环境值回滚旧 workflow | `createAgent`、无参数 tool、tool/model call limit middleware | agent 只能读取服务端已限定的 evidence snapshot；不拥有数据库、tenant/corpus/query 参数 |
| `adaptive-entity` | `handleAdaptiveEntityQuery` | metadata-filter 可选 → dense → rerank 可配 → generation | 结构化实体提取、显式 class/state pipeline | 约束和证据都必须绑定 request-local scope |

Self-Corrective、Reasoning 和 Adaptive 等专用旧 routes 仍可作为本地演示/兼容入口，但 legacy route policy 会在 production 或 authenticated access mode 下 fail closed。主产品链应以 `/api/ask` 为准。

### 2.5 Retrieval Plan 与 Lane Executor

`createDefaultRetrievalPlan` 把 policy 转换成明确的 lanes，而不是让每个 route 临时拼装不可见流程。

当前 lane 类型包括：

- `memory`
- `dense-vector`
- `ordered-context`
- `visual-page`
- `sparse-bm25`
- `metadata-filter`
- `graph-entity`
- `fusion`
- `rerank`
- `generation-only`

`RagLaneExecutor` 的实际工程实践：

1. 顺序执行 plan 中的 lanes，并记录 `planned → retrieving → evidence_ready → completed`；失败时记录 `retrieving → failed`。
2. 同时执行全局 `maxLanes/maxEvidence/maxDurationMs` 和单 lane deadline。
3. optional handler 缺失时记录 skipped；required handler 缺失时立即生成 partial failure。
4. 每条 evidence 都经过 tenant/corpus/trust/lane scope 校验。
5. 以 evidence ID 去重，并在到达 maxEvidence 时以 `budget` 停止。
6. rerank/fusion 使用显式 transform 重排已有 evidence，不偷偷替换证据身份。
7. timeout、provider busy、请求取消、证据越界都有稳定 error code。
8. `RagLaneExecutionError` 携带 partial evidence、已执行 lanes、transitions、budget 和 stop reason，供 Kernel 生成失败 envelope。

这层是当前 RAG 架构的核心：LangChain 提供模型与 Runnable，项目自己的 plan/lane/evidence 合同负责生产可控性。

### 2.6 Kernel 与响应合同

Policy 返回：

~~~typescript
interface RagPolicyResult<TOutput> {
  output: TOutput;
  retrievalPlan?: RagRetrievalPlan;
  evidence?: RagEvidence[];
  laneExecutions?: RagLaneExecution[];
  execution?: RagPolicyExecutionSummary;
  metadata?: Record<string, unknown>;
}
~~~

Kernel 再统一生成 `RagKernelEnvelope`：

- `trace_id`
- `policy_id`
- `status`
- `question`
- `storage_backend`
- `retrieval_plan`
- `evidence`
- `lane_executions`
- `execution.transitions/budget/stop_reason`
- `duration_ms`
- `error`
- `metadata`

当前失败语义：

- Policy 返回非 2xx `Response`：保留原 Response，同时生成 failed envelope。
- Policy 显式报告 failed execution：生成 `RAG_POLICY_STATE_FAILED`。
- Lane 抛错：Kernel 保留 partial result 后抛 `RagKernelExecutionError`。
- 请求取消：归一为 `RAG_REQUEST_ABORTED`，route 映射为 499。
- 其他请求、安全、provider 和验证错误由 route 的稳定 public error mapper 处理。

成功响应总是增加：

- `x-rag-policy`
- `x-rag-trace-id`
- `x-rag-status`

LangSmith 手工 adapter 启用时还会增加：

- `x-langsmith-run-id`
- `x-langsmith-thread-id`
- `x-langsmith-project`

这些 header 是 identity，不是远端或 PostgreSQL 写入成功证明。

### 2.7 Durable Ask 当前实践

`executionMode=durable` 使用项目自研 runtime，而不是 LangGraph：

- `RAG_DURABLE_ASK_MODE` 默认 `off`；只有 `active` 才接受请求。
- 要求 `Idempotency-Key`、server-derived tenant/corpus/actor scope 和 `manage-runtime` capability。
- identity 同时绑定 query/request/routing digests，避免相同 key 重放到不同请求。
- checkpoint store 提供 revision、generation、lease、resume/restart、cancel 和 tombstone。
- result artifact 保存 status/body/允许的 headers，并支持 idempotent replay。
- 当前 workflow 只有一个 `execute-ask` 业务 step，内部仍调用同一个 `/api/ask` Kernel path。
- file provider 不支持安全 shared multi-instance 时会 fail closed。

它解决的是请求级幂等与恢复，不提供 LangGraph node topology、interrupt 或 graph time travel。

## 3. 当前文档写入与索引实践

### 3.1 Upload 持久化

`POST /api/upload` 使用 `createUploadPersistence` 选择实际存储：

| 环境/配置 | Blob | Manifest |
| --- | --- | --- |
| development `local` | `LocalBlobStore` | `LocalUploadManifestStore` |
| `postgres` 且配置完整 | `PostgresBlobStore` | `PostgresUploadManifestStore` |
| development `dual-write` | local + PostgreSQL | local + PostgreSQL |
| production | 必须是 PostgreSQL | 配置不完整即失败，不回退 local |

Upload route 保存原始文件、解析文本和 manifest；它不等于已经完成 embedding 或 Milvus 入库。

### 3.2 DocumentPipeline

`src/lib/document-pipeline.ts` 是当前完整 ingestion pipeline：

~~~mermaid
flowchart LR
    SRC[Text PDF DOCX XLSX CSV JSON Markdown URL YouTube] --> LOAD[安全 Loader]
    LOAD --> CANON[Canonical Document + Metadata]
    CANON --> SPLIT[RecursiveCharacterTextSplitter]
    SPLIT --> CR[Contextual Retrieval v2 off shadow active]
    CR --> EMB[Embedding batches]
    EMB --> DENSE[Milvus Dense Insert]
    EMB --> HYBRID[Hybrid Insert 可选]
    LOAD --> PVS[PDF Visual Sidecar 可选]
~~~

当前阶段与约束：

| 阶段 | 当前实现 |
| --- | --- |
| loading | 多格式 loader、URL 安全访问、ZIP 安全检查、PDF canonical text |
| splitting | `RecursiveCharacterTextSplitter`；chunkSize 100–4000，overlap 不超过一半；保留 source offsets |
| contextualizing | v2 `off/shadow/active`；shadow 只记录，active 才改变 embedding text |
| embedding | 通过统一 Embedding factory，batch size 32；校验向量数量和有效性 |
| storing | dense Milvus 必选；hybrid active 时写第二 collection；PDF sidecar 条件式发布 |

Pipeline 的工作上限：单文档最多 1000 chunks、批处理最多 2000 chunks。Embedding provider 返回数量异常或空向量会明确失败。

### 3.3 Dense/Hybrid 写入补偿

hybrid active 模式不是“多写一次然后忽略失败”：

- dense 与 hybrid 写入共享 audit identity；
- hybrid 写失败后尝试精确补偿 dense/hybrid rows；
- 补偿成功抛 `MILVUS_HYBRID_ACTIVE_WRITE_FAILED_ROLLED_BACK`；
- 补偿不完整抛 `MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED`，带 tenant/corpus/collection/chunk count 和失败侧；
- 不把部分写入报告为成功。

### 3.4 写入与查询的数据边界

| 数据 | 当前权威存储 |
| --- | --- |
| 原始/解析文件、manifest | production PostgreSQL；development 可 local/dual-write |
| Dense/Hybrid vectors | Milvus/Zilliz |
| PDF visual asset manifest | pipeline 生成的受控 sidecar |
| RAG pipeline artifacts | PostgreSQL persistence stores |
| MAIC course/session state | PostgreSQL |
| Trace/Observation/Score | PostgreSQL trace stores；详细 Observability 当前无正常 route 触发 |
| LangSmith runs/feedback | 可选外部副本，不是业务真相源 |

## 4. 当前 LangChain 实践

### 4.1 依赖基线

| 包 | 当前版本 | 实际用途 |
| --- | --- | --- |
| `@langchain/core` | `1.2.9` | Runnable、Prompt、Message、Document、Parser、ChatModel/Embeddings 接口 |
| `@langchain/openai` | `1.4.7` | OpenAI、Azure、OpenAI-compatible Chat/Embedding |
| `@langchain/ollama` | `1.2.7` | Ollama Chat/Embedding |
| `@langchain/textsplitters` | `1.0.1` | 文档递归切分 |
| `@langchain/langgraph` | `1.4.13` | `createAgent` 内部图 runtime；业务 adapter 直接识别 `GraphRecursionError` |
| `langchain` | `1.5.10` | `createAgent`、tool、tool/model call limit middleware、测试用 tool-calling model |
| `langsmith` | `0.7.3` | Client、RunTree、uuid7、feedback |
| `zod` | `4.4.3` | agent tool 输入 schema |

顶层 `langchain` 只进入 Agentic 的受限叶子节点；canonical 检索、安全 scope、预算与 evidence envelope 仍由项目核心负责。

### 4.2 ModelFactory：统一 provider 边界

`src/lib/model-config.ts` 将业务调用统一到 LangChain ChatModel 接口：

| Provider | 当前实现 |
| --- | --- |
| Ollama | `ChatOllama` |
| OpenAI | `ChatOpenAI` |
| Azure OpenAI | `AzureChatOpenAI` |
| Custom/OpenRouter/Lemonade | 带不同 baseURL/headers 的 `ChatOpenAI` |

当前实践：

- provider/model/temperature/maxRetries 集中配置；
- transport attempt timeout 与 retry budget 在工厂层限制；
- 覆盖完整 generation 的 deadline 在 ask route wrapper 处理；
- 模型实例缓存集中在工厂，不在 route/page 中散落实例化；
- Embedding 与 LLM provider 独立选择；
- SiliconFlow Embedding 使用直接 HTTP 兼容实现，不强行套 OpenAIEmbeddings。

### 4.3 Runnable Workflow Harness

`src/lib/rag/core/workflow.ts` 使用两个 `RunnableLambda` 组成 `RunnableSequence`：

1. `prepare`：接收已解析 policyId，生成/补齐 name、traceId、threadId、tags、metadata、RunnableConfig。
2. `execute`：调用 `RagKernel.execute`，把 workflow identity 写回结果。

RunnableConfig 当前包含：

- `runName`
- tags：`rag`、`rag-kernel`、policy、调用方 tags
- metadata：route、user/session/conversation、模型、Embedding、storage、topK、threshold、策略 flags
- `configurable.thread_id`
- `configurable.rag_policy`

设计意图是统一可观测身份，不是把 Kernel 逻辑重写成 LangChain agent。

### 4.4 Scoped Retrieval `createAgent`

`src/lib/rag/agents/scoped-retrieval-agent.ts` 是 canonical Agentic policy 的真实 agent 叶子：

1. `/api/ask` 先完成服务端身份、tenant/corpus scope、dense retrieval、证据校验和 context composition。
2. agent 注册唯一的 `read_scoped_rag_context` 工具；schema 是严格空对象，模型不能提供 query、filter、tenant 或 corpus。
3. scope/integrity 校验后、任何模型 await 前，工具字段会复制为本地冻结快照；工具只返回该快照中的 evidence IDs、token/truncation metadata 和 context，调用方并发修改原 pack 不会改变工具结果。
4. `toolCallLimitMiddleware(runLimit=1)`、`modelCallLimitMiddleware(runLimit=2)` 和 graph `recursionLimit=16` 共同阻止失控循环。
5. 调用前、工具中、调用后都检查请求 AbortSignal；整个 agent 循环仍受 `/api/ask` 单个 generation deadline 约束。
6. 模型跳过工具、请求任意额外/未知工具、重复调用、空回答或 scope/integrity 不一致都会 fail closed；全局单工具预算与两次模型预算之外仍保留 graph recursion guard。响应只公开 runtime、调用次数、evidence IDs 和无正文的真实阶段计时，不公开内部 messages/tool payload。
7. canonical success 同时投影 `retrieve_original -> agent_model_request_tool -> read_scoped_rag_context -> agent_model_answer`，供既有首页 workflow/trace 面板展示；legacy grader、自省与幻觉检查未执行，因此不会伪造。durable 首次结果与 replay 通过严格 allowlist 保留相同 agent/workflow 诊断。

`RAG_AGENTIC_RUNTIME` 默认/空值为 `create-agent`，只有显式 `legacy` 才回滚旧 `AgenticRAGSystem`。无 evidence 或 active abstention 时直接返回受控拒答，不为形式上的 agent 调用消耗模型预算。真实部署还必须确认所选模型支持原生 tool calling。

### 4.5 显式状态节点

`src/lib/rag/core/langchain-state-workflow.ts` 提供：

- `createRunnableStateNode`：把状态 patch 函数包装为 `RunnableLambda`；
- `applyStatePatch`：普通字段覆盖、指定数组 append，并避免 patch 引用泄漏；
- node `runName=graphName.nodeName`；
- node tags/metadata：`graph_name`、`node_name`。

Agentic、Self-Corrective、Reasoning、Intent Router 使用这些 Runnable 或显式控制流。它们保留可观察节点，但没有 LangGraph topology/checkpointer/interrupt。

### 4.6 结构化输出

`src/lib/langchain-structured-output.ts` 是 provider 差异收敛点：

1. 模型支持 `withStructuredOutput` 时优先 native/schema path。
2. 不支持或非 Abort 失败时降级普通 `invoke` + JSON 解析。
3. 支持直接对象、字符串、content blocks、Markdown JSON fence 和正文首个 JSON object。
4. native 与 fallback 都经过业务 normalize。
5. 调用前后检查 AbortSignal，取消不能被 fallback 吞掉。

实际使用：Agentic query analysis/grade/hallucination、Adaptive entity extraction/resolution/rerank、实体提取等。

### 4.7 Prompt、Message、Document 与 Splitter

当前项目使用：

- `ChatPromptTemplate`、`PromptTemplate`、`MessagesPlaceholder`
- `HumanMessage`、`AIMessage`、`SystemMessage`
- `StringOutputParser`
- `Document`
- `RecursiveCharacterTextSplitter`
- `trimMessages`、`getBufferString`

典型落点：

| 场景 | 文件 |
| --- | --- |
| 内存/Milvus RAG | `rag-system.ts`、`rag-milvus.ts`、ask route |
| Agentic/Self-Corrective/Reasoning | 对应 `src/lib/*-rag.ts` |
| Context Management | `context-management.ts` |
| 对话延伸 | `conversation-expansion.ts` |
| 文档切分 | `document-pipeline.ts`、`vectorization-utils.ts` |
| Contextual Retrieval v2 | `rag/retrieval/langchain-contextualizer-v2.ts` |
| PDF Vision | `rag/multimodal/pdf-visual-lane.ts` |

`rag-milvus.ts` 当前保留一个未使用的 `Document` import，不能把它算作 Document runtime 使用；真实 Document 运行点主要是 `rag-system.ts` 和 `context-management.ts`。

### 4.8 当前业务模块怎样使用 LangChain

| 模块 | 当前编排 | LangChain 负责什么 |
| --- | --- | --- |
| Agentic RAG | canonical `/api/ask` 默认受限 `createAgent`；旧 Runnable 循环仅回滚 | scoped tool loop、call-limit middleware、ChatModel；旧路径仍有分析/评分/重写 |
| Self-Corrective RAG | Runnable 节点 + 有界 retrieve/grade/rewrite 循环 | grader、rewrite、generate |
| Reasoning RAG | 一次性条件 pipeline | orchestrator、tool gateway 后的模型/检索/rerank/generate |
| Intent Router | keyword quick match + Runnable LLM fallback | 轻量分类 |
| Adaptive Entity | 显式 class/state pipeline | entity structured output、resolution、rerank |
| Context Management | LCEL/Runnable branch/sequence | trim、rewrite、summary、conversation generation |
| MAIC/MiroFish | 项目自己的业务 runtime | 通过 `BaseChatModel` 端口调用模型，不使用 LangChain agent orchestration |

### 4.9 开发实践：如何扩展 LangChain

#### 新增模型 provider

1. 在 ModelFactory 增加 provider 映射和配置校验。
2. 保持返回 `BaseChatModel`/`Embeddings` 接口。
3. 明确 timeout、retry、headers、baseURL 和模型能力。
4. 补普通 invoke、structured output、AbortSignal 和配置摘要测试。
5. 不在 page/route 中直接 new provider SDK。

#### 新增结构化 LLM 叶子任务

1. 定义最小 schema 和业务 normalize。
2. 通过统一 structured-output helper 调用。
3. native 与 JSON fallback 都测。
4. AbortError 必须原样传播。
5. fallback 不能把空对象静默升级为业务成功。

#### 新增状态节点

1. 先决定是否只是 Runnable 节点或显式函数。
2. 状态 patch 使用业务语义命名；数组 reducer 明确 replace/append。
3. 为 runName/tags/metadata 提供稳定节点身份。
4. 循环必须有业务上限和独立 recursion guard。
5. 只有真正需要 checkpoint/HITL 时才评估 LangGraph。

## 5. LangGraph 的当前边界

### 5.1 当前运行事实

当前 `src` 中：

- `scoped-retrieval-agent.ts` 直接 import `GraphRecursionError`，顶层 `createAgent` 内部运行 LangGraph graph；
- 没有业务代码手写 `StateGraph`；
- 没有 `Annotation.Root` 或 `StateSchema`；
- 没有 `MemorySaver`/checkpointer；
- 没有 `interrupt`/`Command`；

因此 LangGraph 只应画在 Agentic `createAgent` 叶子内部，不能画成整个 RAG Kernel、检索拓扑或 durable ask 的实现。

### 5.2 当前替代机制

| 原先可能交给 LangGraph 的责任 | 当前项目实现 |
| --- | --- |
| 节点包装 | `RunnableLambda`、`createRunnableStateNode` |
| 状态合并 | `applyStatePatch` + 显式 TypeScript state |
| 条件分支 | TypeScript if/branch 和 RunnableBranch |
| 重写循环 | 有界 while loop + retry/recursion guard |
| 检索拓扑 | `RagRetrievalPlan` + `RagLaneExecutor` |
| 可观察身份 | RunnableConfig + Kernel envelope |
| 请求级恢复 | 自研 Durable Ask checkpoint/result runtime |
| HITL/节点 time travel | 当前未实现 |

### 5.3 为什么不手写业务 StateGraph

迁移前的 StateGraph 主要包装一次性流程，没有使用 persistence、interrupt、resume 或 server thread。除 `createAgent` 的标准内部图外，当前显式实现更容易保持：

- exact evidence contract；
- required/optional lane 语义；
- 业务失败 envelope；
- request-local AbortSignal；
- 与 legacy workflow 的 strangler 兼容；
- 可测试的 retry、recursion、gateway 和 reducer 边界。

### 5.4 重新引入自定义 StateGraph 的门槛

只有同时出现真实产品需求和回归测试能力时才考虑：

- 节点级跨进程恢复；
- 人工审批 interrupt/resume；
- graph topology/stream mode 成为外部合同；
- 需要 LangGraph server/SDK 远程线程；
- 能验证 topology、resume、idempotency、HITL 和 trace parentage。

`createAgent` 已使用内部 graph、依赖存在、名称含 Graph 或自研 durable，都不单独满足引入业务 StateGraph 的门槛。

## 6. 当前 LangSmith 实践

### 6.1 当前真实接线

| 接线 | 当前状态 | 实际语义 |
| --- | --- | --- |
| `/api/ask` 手工 root | 当前可达，条件启用 | `runWithLangSmithRootRun` 分配 run/thread identity，尝试 post/end/patch |
| LangChain child tracer | 私有 discard | 内部 spans 保留给 LangChain/LangGraph 的本地生命周期，但所有 upload-capable tracer 会被替换，并绑定 non-networked discard client；input/output hiding 不清洗 error/stack，不能作为开放含 evidence child 外传的充分隐私门 |
| Feedback API | 当前可达，条件式 | 本地/PG 后尝试 `createFeedback`，受 score 类型、UUID、PG 前置和 SDK 成功影响 |
| Detailed Observation mirror | 已实现并测试，当前正常 route 不可达 | `askWithDetails()` 才产生 Trace/Observation；唯一 legacy fallback 正常不会进入 |
| ReactFlow viewer | 当前本地 UI | 展示传入的 workflowSteps/decisionPath，不读取 LangSmith Cloud |

### 6.2 手工 root 与自动 trace

~~~mermaid
flowchart LR
    ASK[POST /api/ask] --> MANUAL[Manual RunTree Root]
    MANUAL -->|仅共享业务 identity| WF[RunnableSequence 本地执行]
    MANUAL -. post patch best effort .-> CLOUD[(LangSmith Cloud)]
    WF --> PRIVATE[private callbacks + discard client]
    PRIVATE --> DROP[(no-op createRun / updateRun)]
~~~

普通同步请求会把手工 root 的 threadId/runId 复制为业务 workflow identity；durable step 或调用方显式 identity 优先。workflow 会收到一个私有 callback manager；它保留非 LangSmith 本地 handlers 和本地 parentage，但移除任何 upload-capable `langchain_tracer`，再注入绑定 discard client 的 tracer。请求级 `traceable` 使用同一 discard client，防止真实 `createAgent` 在 graph async context 切换后重建默认 env tracer。Runnable/model/tool 因而仍有内部 child 生命周期，但没有外部 child 上传；手工 root 错误只写稳定码，Client 初始化、root create 或 completion patch 失败都降级为本地业务执行。若未来要把 child tree 上传 Cloud，必须先实现并验证覆盖 input、output、metadata、error 和 stack 的 allowlist 脱敏。

### 6.3 启用与 sampling

项目手工 adapter 的启用条件：

~~~text
(LANGSMITH_TRACING 或兼容 LANGCHAIN tracing flag 为 true)
且 LANGSMITH_API_KEY 非空
~~~

关键变量：

| 变量 | 当前作用 |
| --- | --- |
| `LANGSMITH_TRACING` | 项目手工 adapter 主开关 |
| `LANGSMITH_API_KEY` | 项目手工 Client 必需 |
| `LANGSMITH_PROJECT` | 手工 project，默认 `rag-system` |
| `LANGSMITH_ENDPOINT/WORKSPACE_ID` | endpoint/workspace |
| `LANGSMITH_TRACING_SAMPLING_RATE` | SDK 原生 sampling；自动 tracer 使用，手工 Client 未 override 时也会回退读取 |
| `LANGSMITH_TRACING_SAMPLE_RATE` | 项目手工 Client 的显式 override |
| `LANGSMITH_HIDE_INPUTS/OUTPUTS/METADATA` | 手工 root 的 SDK 隐私控制；任何组合都不会授权含 evidence 的 LangChain child 外传 |
| `LANGSMITH_OMIT_RUNTIME_INFO` | 当前只由手工 Client 显式传入 |
| `LANGSMITH_TRACING_V2` | 自动 tracer 可能读取；手工 adapter 不读取 |
| `LANGCHAIN_API_KEY`/SDK profile | 自动/default Client 可能读取；手工 adapter 不读取 |

两个 sampling 变量最终都必须在 0..1。推荐以原生 `...SAMPLING_RATE` 为共同基线；若同时设置项目自定义 `...SAMPLE_RATE`，保持相同值。

`LANGSMITH_HIDE_METADATA=true` 会同时移除 thread/session/tenant/route/policy 等筛选语义，不是无代价的脱敏开关。

### 6.4 手工 root 的实际内容

当前 root run 写入：

- inputs：`question_length`、topK、threshold、策略 flags 等数值/布尔摘要；
- tags：`rag`、`api-ask`、policy；
- metadata：route、policy、thread/session/conversation、model、embedding、tenant/corpus、retry/rerank；
- output：HTTP status、ok、rag_policy。

langsmith 0.7.3 的 `RunTree.postRun/patchRun` 会在 SDK 内部吞掉多数远端 create/update 异常并输出日志，因此 wrapper catch、response headers 或本地 finalized cache 都不能证明 Cloud 已落盘。

### 6.5 Feedback 当前顺序

`addTraceFeedbackToPersistence` 当前顺序：

1. 尽力写本地 trace feedback；
2. PostgreSQL 开启时写 `trace_scores`；
3. primitive score 且 traceId 为 UUID 时尝试 LangSmith feedback；
4. PostgreSQL 开启时返回 PostgreSQL scoreId；否则优先本地 ID，再回退 LangSmith feedback ID。

已知边界：

- PostgreSQL 写失败会阻止后续 LangSmith 尝试；
- canonical manual root 不一定存在于本地/PG trace 表；
- durable 业务 traceId 形如 `rag-step-*`，不是 LangSmith UUID；
- local mirror score 和 direct feedback 可能重复；
- 对象/数组 score 可进入 PG，但跳过 local/LangSmith；
- 三层都没有 ID 时，route 仍可能返回 `success: true` 和空 `scoreId`；
- observability 页面不检查 feedback `response.ok`，且 single-tenant 模式下若网关未注入 Authorization 可能得到 401。

### 6.6 本地、PostgreSQL、LangSmith 三层不能混报

| 层 | 当前职责 | 成功证据 |
| --- | --- | --- |
| 本地 UI/Observability | 当前进程调试数据 | route/UI 可读且内容正确 |
| PostgreSQL | durable trace/score 业务持久化 | 独立 PostgreSQL readback |
| LangSmith Cloud | 可选外部 trace/feedback | Cloud API/UI 按 run/thread 实际回读 |

`x-langsmith-run-id`、本地 ReactFlow 有图、PostgreSQL 有 score 是三个不同事实，不能互相替代。

### 6.7 当前没有实现的 LangSmith 能力

- Dataset 自动创建/维护；
- regression eval 上传与远端 runner；
- Multi-turn Eval rubric；
- Engine/Insights Agent 调用；
- Context Hub 发布；
- Sandbox；
- Cloud run tree 回读；

## 7. 当前工程实践手册

### 7.1 新增一个 `/api/ask` Policy

1. 只有真正需要新稳定语义时才扩展 `RagPolicyId`。
2. 在 `createDefaultRetrievalPlan` 定义 lanes、required/optional 和 parameters。
3. 为每种 lane 提供 handler，不在 route 内写隐式检索支线。
4. 在 `createAskKernel()` 注册 policy；类型存在不等于完成注册。
5. 返回 `RagPolicyResult`，保留 evidence、laneExecutions、execution 和 metadata。
6. 让 Kernel 生成 envelope，不自行伪造 `x-rag-*`。
7. 补 policy resolution、plan、lane、Kernel、HTTP contract 和 route tests。
8. 若 policy 只能本地运行，在 security/legacy route policy 显式 fail closed。

### 7.2 新增检索能力

当前推荐模式：

1. 定义 lane type/handler/capability probe。
2. 先以 `off` 或 `shadow` 接入；shadow 不改变回答证据。
3. active 前验证 tenant/corpus/trust scope、deadline、fallback、budget 和 compensation。
4. evidence 必须包含 document/version/lane/trust identity。
5. 写路径和读路径分别验证；有第二存储时提供回滚或 reconciliation identity。
6. 把 rollout mode、capability、执行结果写入 envelope metadata。

当前采用这一模式的能力包括 Contextual Retrieval v2、Milvus hybrid、ordered context、PDF visual、MiroFish graph 和 abstention。

### 7.3 调整 Prompt/模型/Embedding

每次变更至少同步核对：

- ModelFactory/provider capability；
- structured output native/fallback；
- cache identity 的 model/prompt/embedding version；
- Runnable tags/metadata；
- retrieval/generation deadline；
- evidence/citation 回归；
- 本地、PG、LangSmith 的观测字段是否仍能区分版本。

### 7.4 排查一次 `/api/ask`

按以下顺序定位，避免一开始就追 LangSmith：

1. 请求是否通过 body limit 和 `validateAskInput`。
2. security context 的 accessMode、role、tenant、corpus、capability 是否正确。
3. `resolveRagPolicyId` 最终选择了哪个 policy。
4. `x-rag-trace-id/policy/status` 与 response `rag` envelope 是否一致。
5. retrieval plan 是否包含预期 lanes；rollout 是 off/shadow/active 哪个状态。
6. laneExecutions 的 skipped/failed/errorCode/stopReason/budget。
7. evidence 的 tenant/corpus/documentVersion/trust/lane identity。
8. ModelFactory 实际 provider/model、generation deadline 和 AbortSignal。
9. 若是 durable，请看 generation/revision/replay/resumed/provider headers。
10. 最后分别检查 PostgreSQL readback 和 LangSmith Cloud readback。

### 7.5 当前常见误判

| 误判 | 正确实践 |
| --- | --- |
| “用了 createAgent，所以整个系统已经迁移到 LangGraph” | 只确认 agent 叶子内部 graph；Kernel、lane 和 durable ask 仍是项目 runtime |
| “函数名带 Graph，所以是 LangGraph” | 检查返回的是 Runnable、class 还是 StateGraph |
| “有 x-langsmith-run-id，所以 Cloud 成功” | 用 Cloud readback 验证 |
| “本地 viewer 有流程图，所以是 LangSmith run tree” | viewer 只显示本地 props |
| “upload 成功，所以向量已入库” | upload、pipeline、Milvus readback 分开验证 |
| “PostgreSQL 配置失败可回退 local” | production 必须 fail closed |
| “shadow 已改善答案” | shadow 只观察，不能改变生产 evidence |
| “durable ask 就是 LangGraph durable execution” | 当前是自研单 step 请求级 checkpoint |

## 8. 当前运行与部署边界

### 8.1 Access Mode

| 模式 | 当前用途 | 限制 |
| --- | --- | --- |
| `local-dev` | 本地无认证演示 | production 禁止；不强制 tenant isolation |
| `single-tenant-token` | 当前生产认证模式 | Bearer token、固定 tenant/corpus、role capability |

### 8.2 Persistence Backend

| `RAG_PERSISTENCE_BACKEND` | 当前语义 |
| --- | --- |
| `local` | 仅 development 默认 |
| `postgres` | production 默认且唯一允许值 |
| `dual-write` | 仅 development 迁移/验证 |

`DATABASE_URL` 与 `POSTGRES_URL` 同时存在但不同会直接失败。TLS query 参数禁止写在 URL 中，统一使用 `POSTGRES_SSL_MODE` 和 CA 配置。

### 8.3 主要 rollout 开关

| 能力 | 当前默认/模式 |
| --- | --- |
| Durable Ask | `RAG_DURABLE_ASK_MODE=off`，只支持 off/active |
| Contextual Retrieval v2 | off/shadow/active |
| Milvus Hybrid | off/shadow/active |
| Ordered Context | off/shadow/active |
| PDF Visual | off/shadow/active |
| MiroFish Graph | off/shadow/active；只有 `active` 会被 `/api/ask` 选为 server policy，`shadow` 不改写当前查询主路径 |
| Abstention | 默认 shadow |
| Agentic runtime | `RAG_AGENTIC_RUNTIME=create-agent` 为默认；`legacy` 只用于显式回滚，不是 rollout percentage |

代码存在不代表部署已 active。生产真实状态必须读取部署环境和执行 metadata。

## 9. 从零搭建、联调、部署与验收

这一章是可直接执行的交付 runbook。推荐先走“本地完整容器栈”，因为它与生产的
PostgreSQL + Milvus + 服务端认证边界最接近；`pnpm dev` 只作为源码调试路径，不能代替生产拓扑验收。

### 9.1 最终目标拓扑

完成搭建后，请求必须经过下面的真实链路，而不是旧 `/api/agentic-rag` 演示端点：

~~~mermaid
flowchart LR
    CLIENT[受信客户端/BFF] -->|Bearer token| API[POST /api/ask]
    API --> SCOPE[服务端 tenant/corpus scope]
    SCOPE --> KERNEL[RagKernel + agentic policy]
    KERNEL --> EMB[Embedding provider]
    EMB --> MILVUS[(Milvus/Zilliz)]
    MILVUS --> PACK[Canonical evidence snapshot]
    PACK --> CA[LangChain createAgent]
    CA --> M1[Model: 请求工具]
    M1 --> TOOL[read_scoped_rag_context]
    TOOL --> M2[Model: grounded answer]
    M2 --> RESP[Response + agent/workflow/rag envelope]

    PIPE[POST /api/pipeline] --> EMB
    PIPE --> PG[(PostgreSQL manifests/blobs)]
    API -. content-free root .-> LS[(LangSmith 可选)]
    CA -. child spans discard .-> PRIVATE[Non-networked private tracer]
~~~

验收时要分别证明：进程存活、PostgreSQL schema/权限、Embedding、Milvus scoped
写入/回读、模型原生 tool calling、canonical ask 和可选 LangSmith Cloud readback。任一单项通过都不能替代其余层。

### 9.2 工具链与前置服务

| 项目 | 当前仓库合同 | 说明 |
| --- | --- | --- |
| Node.js | CI 使用 24；生产镜像使用 22 | 仓库当前没有 `engines` 最低版本声明；本机优先用 Node 24 复现 CI |
| pnpm | `11.1.3` | `packageManager`、Dockerfile 和 CI 保持一致 |
| Docker | Docker Engine/Desktop + Compose v2 | 本地完整栈需要 PostgreSQL、etcd、MinIO、Milvus 和 app |
| PostgreSQL | 17 | 业务持久化、trace、pipeline manifest；不是向量后端 |
| Milvus | 本地 Compose 固定 `2.5.10` | Zilliz 是云端替代；`postgres_pgvector` 当前未实现 |
| Ollama | 本地 provider 方案 | 也可替换为 OpenAI/Azure/Custom/OpenRouter/Lemonade，但必须验证 tool calling |

首次安装：

~~~powershell
corepack enable
corepack prepare pnpm@11.1.3 --activate
pnpm install --frozen-lockfile
~~~

`--frozen-lockfile` 是必要门禁。当前锁文件把关键运行版本固定为 `langchain@1.5.10`、
`@langchain/langgraph@1.4.13`、`@langchain/ollama@1.2.7`、
`@langchain/openai@1.4.7`、`next@16.2.6`、`pg@8.23.0` 和
`@zilliz/milvus2-sdk-node@3.0.1`。不要只升级其中一个 LangChain 包后跳过完整测试。

### 9.3 准备本地完整栈配置

复制容器样例；真实密钥只写入未提交的 `.env.container`：

~~~powershell
Copy-Item .env.container.example .env.container
~~~

至少检查并修改这些字段：

~~~text
MODEL_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
REASONING_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_LLM_MODEL=llama3.1
OLLAMA_EMBEDDING_MODEL=nomic-embed-text

MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=milvus:19530
MILVUS_DEFAULT_DIMENSION=768
RAG_VECTOR_BACKEND=milvus

RAG_PERSISTENCE_BACKEND=postgres
POSTGRES_DB=rag_system
POSTGRES_USER=rag
POSTGRES_PASSWORD=<url-safe-password>
POSTGRES_HOST_PORT=5432
POSTGRES_URL=postgresql://rag:<url-safe-password>@127.0.0.1:5432/rag_system
POSTGRES_SSL_MODE=disable

RAG_ACCESS_MODE=single-tenant-token
RAG_SINGLE_TENANT_TOKEN=<long-random-secret>
RAG_DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000001
RAG_DEFAULT_CORPUS_ID=00000000-0000-0000-0000-000000000002
RAG_TENANT_ISOLATION_REQUIRED=true
RAG_ALLOWED_LLM_MODELS=llama3.1
RAG_ALLOWED_EMBEDDING_MODELS=nomic-embed-text

RAG_AGENTIC_RUNTIME=create-agent
LANGSMITH_TRACING=false
~~~

注意：

- 容器访问宿主机 Ollama 必须使用 `host.docker.internal`，不能写 `localhost`。
- `nomic-embed-text` 的输出维度必须与 `MILVUS_DEFAULT_DIMENSION=768` 以及现有 collection 一致。
- 改 Embedding provider/model 通常需要新建或重建 collection，不能只改环境变量。
- 本地 Compose 的 PostgreSQL 同角色配置适合功能演练，不证明生产最小权限。
- 完整变量定义只维护在 [ENV_CONFIG_GUIDE.md](ENV_CONFIG_GUIDE.md)；生产数据库角色/TLS 见
  [docs/deployment/postgresql.md](docs/deployment/postgresql.md)。

### 9.4 准备本地模型

默认完整栈至少需要回答模型和 Embedding 模型：

~~~powershell
ollama pull llama3.1
ollama pull nomic-embed-text
~~~

若还要运行 legacy Agentic 的轻量分析/重排或其他推理能力，再准备对应模型：

~~~powershell
ollama pull qwen2.5:0.5b
ollama pull deepseek-r1
~~~

“模型已下载”不代表真实 `createAgent` 可用。所选 ChatModel adapter 必须具有 `bindTools`，
模型服务必须返回 LangChain 能识别的原生 tool call；最终要用 9.9 的 canonical canary 证明。

### 9.5 启动 PostgreSQL、执行迁移、启动完整栈

先只启动 PostgreSQL：

~~~powershell
docker compose --env-file .env.container `
  -f docker-compose.yml `
  -f docker-compose.local.yml `
  up -d postgres
~~~

从宿主机使用 `.env.container` 中的 host DSN 执行版本化迁移：

~~~powershell
node --env-file=.env.container scripts/migrate-postgres.mjs
~~~

迁移 runner 使用 advisory lock 串行化迁移，并记录版本与 checksum；已应用 SQL 被修改时会
fail closed。迁移成功只证明 migration job，不证明 app 使用了同一个 DSN。

随后启动并构建 app + PostgreSQL + Milvus 依赖栈：

~~~powershell
docker compose --env-file .env.container `
  -f docker-compose.yml `
  -f docker-compose.local.yml `
  up -d --build
~~~

检查容器状态：

~~~powershell
docker compose --env-file .env.container `
  -f docker-compose.yml `
  -f docker-compose.local.yml `
  ps
~~~

### 9.6 基础健康检查

~~~powershell
Invoke-RestMethod http://localhost:3000/api/health/live
Invoke-RestMethod http://localhost:3000/api/health
~~~

证据含义必须分开：

| 探针 | 能证明 | 不能证明 |
| --- | --- | --- |
| `/api/health/live` | Next.js 进程可响应 | PostgreSQL、Milvus、Embedding、LLM、tool calling |
| `/api/health` | 当前 readiness 合同，包含 PostgreSQL 核心检查 | scoped Milvus 写入/查询和真实 `createAgent` 闭环 |
| Compose `healthy` | 容器自身 healthcheck 通过 | 完整业务数据链 |

所以健康检查通过后仍必须完成下面的导入和查询 canary。

### 9.7 通过 canonical pipeline 导入一条可回答证据

生产认证模式下 `/api/pipeline` 同样要求 Bearer token。不要把共享生产 token 下发给浏览器；
这里的 PowerShell 只用于受控本机/服务端 canary。

~~~powershell
$headers = @{
  Authorization = 'Bearer <same-value-as-RAG_SINGLE_TENANT_TOKEN>'
  'X-Request-ID' = 'create-agent-ingest-smoke-001'
}

$ingestBody = @{
  action = 'process-text'
  source = 'create-agent-smoke.txt'
  text = 'RAG System 的 canonical Agentic 运行时是 langchain-create-agent-v1。它必须先读取服务端限定的证据快照，再生成答案。'
  chunkSize = 500
  chunkOverlap = 50
  embeddingModel = 'nomic-embed-text'
} | ConvertTo-Json

$ingest = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/pipeline `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $ingestBody

$ingest | ConvertTo-Json -Depth 8
~~~

最低验收：`success=true`，pipeline 返回已完成的 chunk/vector 结果。随后还应通过受 scope 的
Milvus search 或管理工具回读该文档；只有 HTTP 200、upload receipt 或 PostgreSQL manifest
都不能单独证明向量已成功入库。

### 9.8 `createAgent` 生效条件

canonical agent 只在全部条件满足时运行：

1. 请求入口是 `POST /api/ask`。
2. `storageBackend="milvus"`。
3. `useAgenticRAG=true`，且不能同时设置 `useAdaptiveEntityRAG=true`。
4. `RAG_AGENTIC_RUNTIME` 为空或 `create-agent`；`legacy` 只用于显式回滚，其他值直接拒绝。
5. `RAG_VECTOR_BACKEND` 未禁用。
6. 服务端认证与 tenant/corpus scope 已建立。
7. 检索返回当前 scope 内、非 quarantined 的有效 evidence，且未被 active abstention 门禁拒绝。
8. 当前 ChatModel adapter 和真实模型支持原生 tool calling。

无 evidence 或 active abstention 时，系统会返回受控拒答并把 agent 步骤标为 skipped；这不是
`createAgent` 故障，也不能用来证明模型 tool-calling 已通过。

### 9.9 执行真实 canonical `createAgent` canary

使用与导入相同的认证头，提问刚写入的确定性事实：

~~~powershell
$askBody = @{
  question = 'RAG System 的 canonical Agentic 运行时是什么？回答前必须使用知识库证据。'
  storageBackend = 'milvus'
  useAgenticRAG = $true
  topK = 3
  similarityThreshold = 0
  llmModel = 'llama3.1'
  embeddingModel = 'nomic-embed-text'
  enableReranking = $true
} | ConvertTo-Json

$askResponse = Invoke-WebRequest `
  -Method Post `
  -Uri http://localhost:3000/api/ask `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $askBody

$askPayload = $askResponse.Content | ConvertFrom-Json
$askPayload | ConvertTo-Json -Depth 12
$askResponse.Headers
~~~

真实成功的最低合同：

| 字段/信号 | 预期 |
| --- | --- |
| HTTP | 2xx |
| `success` | `true` |
| `storageBackend` | `milvus` |
| `agent.runtime` | `langchain-create-agent-v1` |
| `agent.toolCallCount` | `1` |
| `agent.servedEvidenceIds` | 非空，且与 response evidence 身份一致 |
| `workflow.steps` | 包含模型请求工具、`read_scoped_rag_context`、模型回答 |
| `x-rag-policy` | `agentic` |
| `x-rag-status` | `completed` |
| `x-rag-trace-id` | 与 body 中 trace/rag envelope 一致 |

这条 canary 同时证明真实模型完成了“模型 → 工具 → 模型”两轮循环。普通 chat 成功、
`bindTools` 方法存在、FakeToolCallingModel 测试通过或页面显示 Agentic 标签都不能替代它。

### 9.10 Agent 内部合同与失败门禁

Agent 不拥有检索控制权。它只有一个严格空参数工具：

~~~text
read_scoped_rag_context({})
~~~

工具读取的是在第一次模型 await 之前复制、校验并冻结的 snapshot：

- evidence ID 顺序必须和 canonical context 一致；
- evidence ID 必须唯一；
- context 必须能由 included evidence 完整重建；
- evidence 必须在服务端 tenant/corpus/trust scope 内；
- quarantined evidence 永远拒绝；
- 工具不能接收 query、filter、tenant、corpus 或数据库连接参数。

执行预算：

| 预算 | 当前值 | 超限结果 |
| --- | --- | --- |
| 工具调用 | 1 | `RAG_AGENT_TOOL_LIMIT` |
| 模型调用 | 2 | `RAG_AGENT_MAX_STEPS` |
| graph recursion | 16 | 归一为 `RAG_AGENT_MAX_STEPS` |
| generation deadline | `/api/ask` 统一 30 秒预算 | 失败 envelope，不返回未受控答案 |

模型跳过工具、调用未知/额外工具、重复调用、返回空答案、scope 越界、请求取消或 deadline
超时都会 fail closed。失败 envelope 会保留已经检索到的无正文证据身份、lane execution 和
`evidence_ready → generating → failed` transition，但不会把内部 messages、tool payload 或 provider stack 暴露给客户端。

### 9.11 LangSmith 的启用和隐私验收

需要外部 root 可观测时配置：

~~~text
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=<secret>
LANGSMITH_PROJECT=rag-system
# LANGSMITH_ENDPOINT=https://api.smith.langchain.com
~~~

当前设计刻意不是“上传完整 agent tree”：

1. `/api/ask` 手工创建一个 content-free RunTree root，只发送数值/布尔摘要和稳定错误码。
2. Runnable、model、tool、`createAgent`/LangGraph child runs 会被重新绑定到 non-networked discard client。
3. 调用方已有 upload-capable tracer 会被替换；非 LangSmith 本地 callbacks 会保留。
4. root 创建或完成 patch 失败是 best-effort telemetry failure，不会把已成功业务回答改成失败。

验收必须在 LangSmith Cloud 中独立回读 root run，并确认 child prompt/evidence/tool payload 没有上传。
只有 `x-langsmith-run-id`、本地 viewer 或 hermetic tracer 测试不等于 Cloud readback 成功。

### 9.12 源码调试模式

不需要重建 app 容器时，可只启动依赖并在宿主机运行 Next.js：

~~~powershell
docker compose --env-file .env.container `
  -f docker-compose.yml `
  -f docker-compose.local.yml `
  up -d postgres etcd minio milvus

pnpm dev
~~~

此时不要直接复制容器地址到 `.env.local`：

~~~text
OLLAMA_BASE_URL=http://localhost:11434
MILVUS_LOCAL_ADDRESS=localhost:19530
POSTGRES_URL=postgresql://rag:<password>@127.0.0.1:5432/rag_system
RAG_ACCESS_MODE=local-dev
RAG_PERSISTENCE_BACKEND=local
RAG_VECTOR_BACKEND=milvus
RAG_AGENTIC_RUNTIME=create-agent
~~~

`local-dev` 只允许非 production。若要验证生产认证、隔离和 PostgreSQL-only 行为，应继续使用
完整容器配置或等价的 production process env，而不是用开发首页代替。

### 9.13 自动测试与构建门禁

先跑变更最相关的定向测试：

~~~powershell
node src/lib/rag/agents/scoped-retrieval-agent.test.mjs
node src/lib/langsmith/config.test.mjs
node src/lib/rag/core/kernel.test.mjs
node src/app/api/ask/route.test.mjs
node src/components/canonical-create-agent-ui.test.mjs
node src/lib/langchain-workflow-migration.test.mjs
node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false
pnpm exec eslint src/lib/rag/agents/scoped-retrieval-agent.ts src/lib/langsmith/private-tracing.ts src/lib/langsmith/tracing.ts src/lib/rag/core/workflow.ts src/app/api/ask/route.ts
git diff --check
~~~

准备合并/发布时再执行仓库门禁：

~~~powershell
pnpm test:model-runtime
pnpm test:rag-security
pnpm test:postgres
pnpm test:rag-eval
pnpm test:rag-kernel
pnpm rag:eval:validate
pnpm rag:eval:e1b
pnpm rag:eval:matrix
pnpm rag:eval:contracts
pnpm test
pnpm lint
pnpm build
~~~

`pnpm test` 不包含真实 PostgreSQL integration。需要可丢弃的真实 PostgreSQL 环境时另跑：

~~~powershell
$env:TEST_DATABASE_URL = 'postgresql://<test-owner>:<password>@<host>:<port>/<database>'
pnpm test:postgres:integration
~~~

Hermetic tests 中的 FakeToolCallingModel、data stub 和 fixture hash 只证明代码合同、scope、错误映射
和确定性评估；它们不证明真实模型质量、网络、Milvus/Zilliz、LangSmith Cloud 或生产 rollout。

### 9.14 生产部署顺序

生产部署使用以下顺序，不能让应用启动时隐式替代 migration job：

1. 准备 PostgreSQL 17、私网/TLS、备份、migration owner 和更低权限的 `rag_app`。
2. 准备 Milvus/Zilliz collection，确认 embedding model、dimension、metric/index 与 corpus version。
3. 通过 secret manager 注入 provider key、`POSTGRES_URL`、Bearer token 和固定 tenant/corpus；
   `POSTGRES_MIGRATION_URL` 只注入一次性 migration job，绝不注入 app。
4. 执行 `node scripts/migrate-postgres.mjs`，回读 schema migration 与默认 scope。
5. 以受限应用角色执行 `node scripts/verify-postgres-runtime.mjs`，证明实际角色、PG17、scope、
   rollback-only DML 和零残留。
6. 执行 `pnpm build`，或构建同一 `Dockerfile` 的 Node 22 standalone 镜像。
7. 部署 app，先看 liveness，再看 readiness。
8. 通过受信 BFF/服务端执行 `/api/pipeline` scoped 写入和 Milvus 回读。
9. 执行 9.9 的真实 canonical createAgent canary。
10. 若启用 LangSmith，再做 Cloud root readback 和 child privacy 检查。
11. 最后才切流；保留上一版本镜像、环境快照和数据库备份。

非容器 standalone 启动：

~~~powershell
pnpm build
pnpm start
~~~

`pnpm start` 会先执行 PostgreSQL-only bootstrap，再启动 `.next/standalone/server.js`。production
缺少 DSN/scope，或持久化配置为 `local`/`dual-write`，会在 server 加载前 fail closed。

当前 CI/CD 已覆盖 frozen install、完整自动测试、真实 PostgreSQL integration、TypeScript、Docker
镜像、standalone artifact、迁移、受限角色 DML/readback、PM2 reload、liveness/readiness、Nginx
gateway 与 PostgreSQL TLS/auth/permission gates；它仍没有替代真实 LLM tool-calling、Milvus scoped
insert/search、canonical pipeline→ask、答案质量和 LangSmith Cloud readback canary。

### 9.15 回滚与紧急降级

| 场景 | 动作 | 边界 |
| --- | --- | --- |
| 新 agent 与真实 provider 不兼容 | `RAG_AGENTIC_RUNTIME=legacy` 后受控 reload | 仅回滚 Agentic 叶子，不回滚 security/scope/Kernel |
| Agentic 全部流量需暂停 | 调用方停止发送 `useAgenticRAG=true` | Milvus 2-step 仍可继续；先验证默认 policy |
| 向量后端事故 | `RAG_VECTOR_BACKEND=disabled` | scoped ask/ingest fail closed，不降级到未隔离 memory |
| LangSmith 故障 | 关闭 `LANGSMITH_TRACING` | 业务继续本地运行；不删除本地/PG 业务证据 |
| 新 app release 失败 | 恢复上一镜像/standalone release 与环境快照 | 不执行破坏性 DB rollback；先确认 schema 向后兼容 |
| PostgreSQL 公网风险 | 先关闭云安全组入口 | 保持应用私网链路；不要删除 volume/PGDATA |

回滚后必须重新执行 liveness、readiness、受限 PostgreSQL readback 和与当前 policy 对应的真实 ask canary。

### 9.16 本次实现是怎样搭建出来的

下面记录从 Runnable harness 演进到真实 `createAgent` 的完整工程过程，便于后续继续修改而不破坏边界：

| 阶段 | 实现内容 | 主要文件 | 验收重点 |
| --- | --- | --- | --- |
| 1. 统一入口 | 保留 `/api/ask` 请求/响应，建立 Policy、Plan、Lane、Kernel envelope | `route.ts`、`rag/core/*` | 不新增旁路入口，不破坏 headers/envelope |
| 2. Runnable harness | 用 `RunnableSequence`/`RunnableLambda` 统一 trace/thread/tags/metadata，再调用 Kernel | `rag/core/workflow.ts` | workflow 是 harness，不接管 scope 或业务 state |
| 3. 依赖对齐 | 引入顶层 `langchain` 与 Zod，并对齐 core/langgraph/adapters | `package.json`、lockfile | frozen install、类型、结构化输出/迁移回归 |
| 4. TDD agent 叶子 | 先用 FakeToolCallingModel 写失败/成功合同，再实现真实 `createAgent` + strict no-arg tool | `rag/agents/scoped-retrieval-agent.*` | 必须真实出现 tool request/result/final model turn |
| 5. Scope 与快照 | 在任何模型 await 前校验 evidence、复制并冻结 context snapshot | agent、context composer、安全 scope | tenant/corpus/trust/identity/integrity 与并发篡改测试 |
| 6. 预算和取消 | 工具 1、模型 2、graph 16、30 秒 generation deadline、AbortSignal | agent、ask route、cancellation | 未知/重复工具、max steps、deadline、499/partial failure |
| 7. Canonical 接线 | `agentic` policy 默认选择 create-agent；`legacy` 仅环境回滚 | `ask/route.ts`、policies | 默认/空值成功、legacy 回滚、未知 runtime 拒绝 |
| 8. 响应/UI/durable | 只投影真实 agent 阶段和安全诊断；durable replay 使用 allowlist | route、UI、durable ask | 不伪造 legacy grader/score，不序列化 messages/tool context |
| 9. LangSmith 隐私 | 手工 content-free root；自动 child 全部重新绑定 discard client | `langsmith/tracing.ts`、`private-tracing.ts` | env/outer/caller tracer 都不能上传 evidence child spans |
| 10. 复审与文档 | agent/route/kernel/LangSmith/UI/type/lint/build 分层验收并明确外部未知 | tests、plans、solutions、本文 | 本地 pass 不冒充 provider、Cloud 或生产切流成功 |

任何后续扩展都应从相同顺序开始：先写失败合同和安全不变量，再扩工具/模型能力；不要先把数据库、
tenant、query 或任意 URL 暴露成 agent 参数后再试图补 guardrail。

### 9.17 交付验收清单

| 层 | 必须看到的证据 | 当前文档快照状态 |
| --- | --- | --- |
| 依赖 | frozen install；锁定版本一致 | 已有本地/CI 合同 |
| 源码 | 顶层 `createAgent` + 唯一 strict tool | 已实现 |
| 单元/合同 | agent、route、Kernel、LangSmith、UI、durable | 已验证，详见第 10 章 |
| Type/lint | TypeScript、定向 ESLint、diff check | 已验证 |
| Build | 完整 `pnpm build` 退出 0 | 当前 Windows 环境未完整证明；见第 10 章 |
| PostgreSQL | migration + restricted app readback | 部署时必须独立执行 |
| Milvus | scoped insert + search readback | 部署时必须独立执行 |
| Provider | 真实两轮 tool-calling canary | 当前本地 hermetic 测试未证明 |
| HTTP | pipeline→canonical ask，runtime/tool/evidence/header 合同 | 部署时必须独立执行 |
| LangSmith | Cloud root readback + child 不上传 | 未在本地 hermetic 测试中证明 |
| 生产 | rollout、真实流量、错误率/延迟/成本 | 未知，必须从部署环境和观测读取 |

只有前九层按目标环境逐项闭环后，才能声明“真实 createAgent RAG 已在该环境完成搭建”。

## 10. 当前验证证据

### 10.1 本轮定向测试

| 测试组 | 结果 | 验证范围 |
| --- | --- | --- |
| LangChain structured output | 5/5 | native、JSON fallback、content blocks、Abort |
| Workflow migration | 8/8 | legacy workflow 不再手写 StateGraph、Runnable surface、迁移不变量 |
| Runnable state helper | 2/2 | state patch/reducer/metadata |
| Kernel | 14/14 | policy、workflow、envelope、trace/thread、显式测试 callback 下真实 createAgent 的 execute-child parentage |
| LangSmith config | 9/9 | disabled no-op、thread/session、真实 createAgent spans 全量绑定 discard client、legacy tracer 旁路、Client 初始化失败降级、稳定 root error、completion patch best-effort |
| Scoped retrieval agent | 12/12 | 真实 tool loop、模型 tool-calling 前置、外部 tracer 替换且本地 callback 保留、全局工具预算、未知工具、取消、scope/integrity、并发快照篡改拒绝 |
| Canonical agent UI contract | 2/2 | 首页不生成 legacy mock token/固定向量分数；Trace Viewer 按 analysisMode 读取 canonical 字段 |
| Contextual Retrieval v2 | 15/15 | mode、identity、deadline、fallback |
| PDF visual lane | 10/10 | multimodal 限制、fallback、资产边界 |
| RAG trace persistence | 2/2 | trace callback/persistence 接线 |
| Ask route | 50/50 | security、默认 createAgent、canonical query/UI 投影、无 evidence 跳过 agent、durable agent replay、legacy 回滚、未知 runtime 拒绝、headers、取消、模型工厂/生成失败 transition 与模型/工具预算错误映射 |
| Observability persistence | 2/2 | trace persistence |
| PostgreSQL trace store | 6/6 | trace/feedback store 合同 |
| Traces route | 2/2 | trace API 合同 |

合计：139/139 pass。

本轮在当前 Windows sandbox 里再次执行 workflow migration 专项时，`node --test <file>` 的测试隔离子进程被系统以 `spawn EPERM` 拒绝；改为同一测试文件单进程直跑后，8/8 断言通过。这个现象属于测试启动环境边界，不是业务断言失败。

### 10.2 静态检查

~~~bash
rg -n "@langchain/langgraph|StateGraph|Annotation\.Root|StateSchema|MemorySaver|interrupt\(" src
rg -l "@langchain/" src -g "*.ts" -g "*.tsx"
git diff --check
node scripts/generate-articles.mjs
~~~

当前结果：

- LangGraph 相关扫描命中 scoped agent 的 `GraphRecursionError` import 和 legacy migration test 的负向断言，没有业务 `StateGraph`/checkpointer/HITL；
- 38 个 TS/TSX 文件直接引用 `@langchain/*` 或顶层 `langchain`；
- 本轮定向 TypeScript、ESLint 和 `git diff --check` 通过；最终代码的 production `next build` Turbopack 编译成功，随后在 TypeScript worker 启动处被当前 Windows sandbox 的 `spawn EPERM` 阻断，因此不把完整 build 记为 pass。此前 compile-only 尝试也在 page-data worker 处遇到同一环境阻断。文章生成属于独立文档投影验证，不据此声称 runtime canary。

`pnpm test:rag-kernel` 串行回归已通过本次 agent、route、durable、hybrid、contextual、MiroFish 等分组，但在仓库既有 `pdf-asset-store.test.mjs` 的累计恢复用例中数分钟无新输出后被有界终止。挂起后的剩余 PDF renderer/ingest/runtime/lane 与 semantic cache 已分别通过；疑似挂起的单个 recovery-lock 用例隔离运行 1/1 通过。该串行累积挂起与本次 createAgent 定向断言分开记录，不能把整条命令报告为 pass。

### 10.3 本轮没有验证的外部状态

- 当前部署的实际 rollout flags；
- LangSmith Cloud 网络、workspace、run/feedback readback；
- SDK 本地 profile 是否存在；
- production 中 Contextual Retrieval/PDF visual/MiroFish graph 的 active 比例；
- Durable Ask 是否承载真实生产流量。
- 当前部署所选 LLM 是否已通过原生 tool-calling canary。

本轮 shell 中 LangSmith tracing/key/project/sampling 相关环境变量均未设置，因此本地测试不能证明 LangSmith Cloud 成功或失败。

## 11. 当前代码地图

### 11.1 查询核心

| 责任 | 文件 |
| --- | --- |
| canonical ask | `src/app/api/ask/route.ts` |
| policy selection | `src/lib/rag/core/policies.ts` |
| Kernel/envelope | `src/lib/rag/core/kernel.ts`、`types.ts` |
| LangChain workflow | `src/lib/rag/core/workflow.ts` |
| scoped createAgent | `src/lib/rag/agents/scoped-retrieval-agent.ts` |
| state Runnable helper | `src/lib/rag/core/langchain-state-workflow.ts` |
| retrieval plan | `src/lib/rag/retrieval/retrieval-plan.ts` |
| lane executor | `src/lib/rag/retrieval/lane-executor.ts` |
| HTTP contract | `src/lib/rag/core/http-contract.ts` |
| durable ask | `src/lib/rag/core/durable-ask-workflow.ts`、`durable-workflow*.ts` |

### 11.2 LangChain 直接 import 文件

当前直接引用共 38 个，按责任分组：

| 分组 | 文件 |
| --- | --- |
| 模型/Embedding | `model-config.ts`、`embedding-config.ts` |
| Kernel/编排 | ask route、`rag/core/workflow.ts`、`langchain-state-workflow.ts`、`intent-router.ts` |
| RAG 工作流 | `rag/agents/scoped-retrieval-agent.ts`、`agentic-rag.ts`、`self-corrective-rag.ts`、`reasoning-rag.ts`、`adaptive-entity-rag.ts` |
| 基础 RAG | `rag-system.ts`、`rag-milvus.ts` |
| 文档/切分 | `document-pipeline.ts`、`vectorization-utils.ts` |
| 上下文/对话 | `context-management.ts`、`contextual-retrieval.ts`、`conversation-expansion.ts` |
| 检索叶子 | `langchain-contextualizer-v2.ts`、`pdf-visual-lane.ts`、`entity-extraction.ts`、`lane-handlers.ts`、`semantic-cache.ts` |
| 结构化输出 | `langchain-structured-output.ts` |
| MAIC | agents base/manager、pipeline read/plan/prepare |
| MiroFish | interaction、model override、ontology、profile、report、simulation |

不直接 import LangChain 但消费这些模块的入口还包括 Agentic、Adaptive、Self-Corrective、Reasoning legacy routes、pipeline route 和 MiroFish graph builder。

### 11.3 LangSmith 文件

| 责任 | 文件 |
| --- | --- |
| runtime config/client | `src/lib/langsmith/config.ts` |
| manual root/feedback | `src/lib/langsmith/tracing.ts` |
| detailed mirror adapter | `src/lib/langsmith/trace-mirror.ts` |
| trace persistence/feedback | `src/lib/persistence/trace-store.ts`、`postgres-trace-store.ts` |
| instance callback | `src/lib/rag-instance.ts` |
| local viewer | `LangSmithReactFlowGraph.tsx`、`LangSmithTraceViewer.tsx`、`SCRAGLangSmithViewer.tsx` |
| local/PG trace UI | `src/app/observability/page.tsx`、`src/app/api/traces/*` |

### 11.4 LangGraph 文件

当前生产直接 import：`src/lib/rag/agents/scoped-retrieval-agent.ts` 使用 `GraphRecursionError` 归一 graph recursion failure；`createAgent` 自身内部运行 LangGraph graph。

保留面：

- `package.json` / lockfile 直接依赖；
- legacy workflow migration test 负向断言；
- 部分历史 docs、兼容函数名和 UI 文案。

## 12. 附录：演进证据

历史只用于解释当前选择，不是本文主线。

| 日期 | 证据 | 对当前架构的影响 |
| --- | --- | --- |
| 2026-02-07 | `1a322c6` | 初始 Agentic/Self-Corrective/Reasoning/Intent Router 使用真实 StateGraph |
| 2026-05-15 | `066f4e9` | 引入统一 structured-output 实践 |
| 2026-05-19 | `e80d524` | 接入 LangSmith RunTree、feedback、mirror 和本地 ReactFlow viewer |
| 2026-06-11 | `31e99e5` | `/api/ask` 增加 LangChain Runnable workflow harness |
| 2026-06-15 | `c38338e` | 四套 StateGraph 初次迁移为 Runnable/显式状态机 |
| 2026-07-14 | `fef9a31` | 修复 recursionLimit、state merge 引用、tool gateway 并补回归 |
| 2026-07-16/17 | `e0c3690`、`cef3404` | 增加 eval、安全、Contextual Retrieval v2 和 PDF visual |
| 2026-08-13 | `d9d9ec3` | production persistence 收敛到 PostgreSQL |
| 2026-08-28 | `scoped-retrieval-agent.ts` + canonical route tests | `/api/ask` 的 Agentic policy 默认接入真实、受限 `createAgent` 叶子 |

相关证据文档：

- [ENV_CONFIG_GUIDE.md](ENV_CONFIG_GUIDE.md)
- [LANGSMITH_LATEST_GUIDE.md](LANGSMITH_LATEST_GUIDE.md)
- [AGENTIC_RAG_GUIDE.md](AGENTIC_RAG_GUIDE.md)
- [SELF_CORRECTIVE_RAG_GUIDE.md](SELF_CORRECTIVE_RAG_GUIDE.md)
- [docs/solutions/2026-05-15-langchain-langgraph-latest-update.md](docs/solutions/2026-05-15-langchain-langgraph-latest-update.md)
- [docs/solutions/2026-05-19-langsmith-latest-integration.md](docs/solutions/2026-05-19-langsmith-latest-integration.md)
- [docs/solutions/2026-06-11-langchain-rag-workflow.md](docs/solutions/2026-06-11-langchain-rag-workflow.md)
- [docs/plans/2026-06-12-langgraph-defect-audit.md](docs/plans/2026-06-12-langgraph-defect-audit.md)
- [docs/solutions/2026-06-15-langchain-runnable-rag-migration.md](docs/solutions/2026-06-15-langchain-runnable-rag-migration.md)
- [docs/plans/2026-06-15-recent-iteration-audit.md](docs/plans/2026-06-15-recent-iteration-audit.md)
- [docs/deployment/container.md](docs/deployment/container.md)
- [docs/deployment/postgresql.md](docs/deployment/postgresql.md)

---

维护规则：先更新当前入口、policy、plan/lane、Kernel envelope、持久化和部署事实；历史时间线只在当前事实发生变化时补充。任何“已接入”声明都必须指出正常可达入口和独立验证证据。
