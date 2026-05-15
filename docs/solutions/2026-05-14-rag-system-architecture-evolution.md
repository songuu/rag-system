# RAG System Architecture Evolution

## Problem

当前项目已经有很多 RAG 能力: memory RAG、Milvus RAG、Contextual Retrieval、Agentic RAG、Self-Corrective RAG、Adaptive Entity RAG、Reasoning RAG、MiroFish 图谱、OpenMAIC 课程桥接和 artifact cache。问题不在能力少,而在能力没有统一内核。

主入口 `/api/ask` 通过参数直接分支到不同实现,各模式各自处理检索、rerank、生成、响应、trace。随着功能继续增长,这会让系统越来越难复用、难评估、难缓存、难接入 MiroFish/OpenMAIC。

## Root Cause

项目缺少三个生产 RAG 中枢:

1. `RAG Kernel`: 统一 query request、policy、context composer、answer envelope。
2. `Retrieval Control Plane`: 统一 query rewrite、dense/sparse/graph retrieval、fusion、rerank、cache。
3. `Corpus / Index Lifecycle`: 统一 document、chunk、embedding、index job、corpus version、delete/update consistency。

## Recommended Architecture

保持当前 Next.js 单体不变,先在 `src/lib/rag/*` 增加核心层:

- `src/lib/rag/core/*`
  - `RagQueryRequest`
  - `RagPolicy`
  - `RagAnswerEnvelope`
  - `RagKernel`
  - `ContextComposer`
- `src/lib/rag/retrieval/*`
  - `RetrievalPlan`
  - `DenseLane`
  - `SparseLane`
  - `GraphLane`
  - `Fusion`
  - `Reranker`
  - `RetrievalCache`
- `src/lib/rag/corpus/*`
  - `Corpus`
  - `DocumentAsset`
  - `ParsedDocument`
  - `Chunk`
  - `IndexManifest`
  - `IndexJob`
- `src/lib/rag/eval/*`
  - golden questions
  - context precision / recall
  - faithfulness
  - answer correctness
  - latency / token / cache hit metrics

Existing modes become policy adapters:

- `memory`
- `milvus-2step`
- `agentic`
- `self-corrective`
- `adaptive-entity`
- `reasoning`
- `maic-course`
- `mirofish-research`

## LangChain / LangGraph v1+ Alignment

最新 LangChain / LangGraph 能力应通过这套核心层吸收:

- LangChain v1 `createAgent`、middleware、structured output 适合作为叶子 agent 能力,用于 query analysis、entity extraction、rerank、hallucination check、guardrails。
- LangGraph v1/v1.1 的 `StateGraph`、`StateSchema`、persistence、durable execution、typed interrupts 适合作为复杂 RAG policy 和长流程产品能力,例如 Agentic RAG、Adaptive Entity RAG、MAIC prepare、MiroFish simulation。
- `contentBlocks`、reasoning trace、citations 不应在模式内部提前压平成字符串,应进入 `RagAnswerEnvelope` 和 shared trace/eval 体系。
- `@langchain/classic` 与 legacy chains 只能作为兼容层,新能力不要继续围绕旧 chain API 设计。

## Milvus 2.6 Alignment

Milvus 优化应先落在 vector store adapter 和 runtime config 上,而不是给 `/api/ask` 增加更多分支:

- 当前 dense retrieval 继续使用现有 collection schema,但搜索请求支持 consistency level、filter templating `exprValues`、grouping、`ignore_growing` 和 `nprobe`/`ef` 覆盖。
- `AUTOINDEX`、IVF、HNSW 等索引差异由 `milvus-client` 生成默认搜索参数,API 层只表达策略意图。
- 后续 sparse/hybrid/multi-vector 检索应作为 retrieval lane 接入 `Retrieval Control Plane`,不要在 Milvus 管理 API 内提前固化多路融合逻辑。
- Corpus/index manifest 负责记录 collection、embedding dimension、index type、metric type 和 corpus version,避免导入、重建、搜索各自猜测索引状态。

## Why This Is Best For This Repo

- It preserves existing features and recent MiroFish/OpenMAIC parity work.
- It prevents `/api/ask` from becoming an unbounded mode switch.
- It lets MiroFish graph capabilities become a reusable GraphRAG lane.
- It makes Contextual Retrieval, reranking, semantic cache and artifact cache shared capabilities.
- It creates a place for evaluation, which is now more important than adding one more RAG variant.

## Migration Order

1. Define the core RAG contracts.
2. Wrap existing `/api/ask` behavior with policy adapters.
3. Add a shared retrieval plan abstraction.
4. Move rerank/fusion/cache into retrieval control plane.
5. Add corpus/index manifests.
6. Promote MiroFish graph data into a shared GraphRAG lane.
7. Add persistent trace and evaluation harness.
8. Promote Milvus dense search options into retrieval policies, then add sparse/hybrid lanes behind the same retrieval plan.

## Guardrails

- Do not remove existing routes.
- Do not change response semantics in the first migration.
- Do not merge MiroFish/OpenMAIC product state into generic RAG state; only share corpus, graph, artifact and retrieval capabilities.
- Add evaluation before changing retrieval ranking logic.
