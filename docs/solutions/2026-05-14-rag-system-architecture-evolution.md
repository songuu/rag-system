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

## Guardrails

- Do not remove existing routes.
- Do not change response semantics in the first migration.
- Do not merge MiroFish/OpenMAIC product state into generic RAG state; only share corpus, graph, artifact and retrieval capabilities.
- Add evaluation before changing retrieval ranking logic.

