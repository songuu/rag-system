---
title: "R1 Rerank + R2 Cost Tracking 落地（排期 1）"
type: sprint
status: planning
created: "2026-05-25"
updated: "2026-05-25"
checkpoints: 0
tasks_total: 7
tasks_completed: 0
tags: [sprint, rag, rerank, cost-tracking, anti-drift]
aliases: ["R1 R2 排期 1", "Sprint 2026-05-25 v4"]
mode:
  auto: true
  caveman: true
source_plan: "[[2026-05-25-integration-roadmap]] - 排期 1 (R1 + R2 可并行启动)"
invariants:
  - "Rerank 默认 off；未传 option / 未设 env 时 vectorSearch 行为字节级不变"
  - "Cost tracker 默认 off；启用后不修改 LLM 输入/输出，仅观测"
  - "Reranker provider 走 model-config 同款 env-based 抽象；未配置时显式 throw 而非静默 fallback"
  - "MilvusVectorStore.search 旧签名继续可用；rerank 是 wrapper 层"
  - "RagKernelEnvelope.metadata 是 Record<string, unknown>，新增 cost/rerank 字段是 additive"
  - "现有 retrieval-plan rerank lane (declarative) 不破坏；本 sprint 添加 lane 实际执行 helper"
  - "rerank 调用失败时降级到原排序，不抛 error 出去"
invariant_tests:
  - src/lib/milvus-client.test.mjs
  - src/lib/rag/core/kernel.test.mjs
  - src/lib/rag/retrieval/post-process.test.mjs
  - src/lib/semantic-cache.test.mjs
  - src/lib/embedding-cache.test.mjs
  - src/lib/model-catalog.test.mjs
deferred:
  - sprint: next+1
    item: "R3 Evaluation framework (dataset/evaluator/experiment)"
    deadline: "2026-07-15"
    reason: "排期 2 — 需在 R1 稳定后再启动，让 eval 对象稳定"
  - sprint: next+2
    item: "R4 Prompt registry"
    deadline: "2026-08-15"
    reason: "排期 3 — 等 R3 启用后再评估是否需要 version + playground"
  - sprint: next+N
    item: "G4 MCP 客户端 / G5 Tool registry / G7 Variable pool / G8 Memory 抽象"
    deadline: "2026-09-01 / 2026-10-01"
    reason: "research sprint 已 defer，等具体业务需求出现"
deadcode_until:
  - path: "src/lib/rag/retrieval/hybrid-policy.ts"
    until_sprint: "2026-08"
    unblock: "Milvus hybrid sparse + dense 实现"
---

# R1 Rerank + R2 Cost Tracking 落地（排期 1）

## Phase 1 + 2 (压缩 / 复用 roadmap)

完整 Think + Plan 已在 [[2026-05-25-integration-roadmap]] 的 R1 / R2 段落给出。本 sprint 仅记录差异与具体任务拆分。

### 用户反馈契机

- 用户对 R1-R4 建议的 pushback 已接受，但**坚持执行排期 1**（R1+R2，本 sprint）。R3+R4 严格保留为后续 sprint
- 强调"保证准确" → 选型必须 data-driven，cost tracker 不改请求语义

### 范围 (Scope)

- **R1 Rerank** (T1-T3)：reranker provider 抽象 + rerank 包装层 + retrieval-plan lane 执行 helper
- **R2 Cost tracking** (T4-T5)：cost-tracker 模块 + model-config hook
- **R1+R2 共享** (T6-T7)：trace envelope cost/rerank 字段 + 测试 + bench

### 非范围 (Non-scope)

- 不启动 R3 evaluation framework / R4 prompt registry
- 不动 retrieval-plan declarative lane 定义（只加 helper 让 lane 真执行）
- 不引入新 npm dependency（reranker 走现有 SiliconFlow API endpoint）
- 不动 lane-handlers.ts（前 sprint deferred 项，由后续 sprint 处理）
- 不修改 LLM prompt（cost tracker 仅观测）

### 成功标准

- `vectorSearch(query, { rerank: { ... } })` 启用时返回结果顺序变化（rerank 生效）
- `vectorSearch()` 不传 rerank 时所有现有测试通过（行为零变化）
- `getCostStats()` 在 enabled 时统计 token usage；disabled 时 noop
- 启用 rerank 后 reranker provider API 失败 → 降级到原排序，warn log 不 throw
- 所有 invariant_tests 全绿；新增 ≥ 15 个测试

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| vectorSearch 返回 shape | 仅追加字段 ([[2026-05-25-model-vector-cache-optimization]]) | 新增 `rerank?: RerankResult` 字段，additive |
| MilvusVectorStore.search | 旧 4-arg 签名兼容 | 不动 milvus-client；rerank 在 wrapper |
| postProcess 默认 off | MMR / dedupeBySource 默认 undefined | rerank 默认 off 同模式 |
| EmbeddingCache namespace | sha256+version key 不变 | 不动 cache |
| RagKernelEnvelope.metadata | Record<string, unknown> 不限定 | cost/rerank 是 additive metadata |
| model-config provider 抽象 | env-based 切换 | reranker provider 沿用 |
| 不引入强依赖 | provider 不强制启用 | reranker 未配置时 throw "no reranker"；调用方需显式 try/catch |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| rerank-providers 调用 | `vectorSearch({rerank:...})` | provider env → fetch reranker API | 不持久化 | 立即（重排 result） |
| cost tracker 累加 | createLLM callback `handleLLMEnd` | Map in-process | 进程内存 | 立即（getCostStats） |
| trace envelope metadata | kernel.run 完成时 | RagKernelEnvelope | 不持久化 | 立即（响应字段） |
| rerank 调用失败降级 | reranker API 错误 | catch → console.warn → 返回原结果 | 不持久化 | 立即 |

所有路径闭环，无 ❌。

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-25 v2 | Rerank 模块（依赖 hybrid） | **本 sprint R1 解决**（research 已纠偏，可独立于 hybrid） | — |
| 2026-05-25 v2 | lane-handlers cache 迁移 | ⏭ 保留 | 2026-08-01 |
| 2026-05-25 v2 | Milvus hybrid sparse + dense | ⏭ 保留（feature flag 已就位） | 2026-08-01 |
| 2026-05-25 v1 | Brave + Baidu Search | ⏭ 保留 | 2026-08-01 |
| 2026-05-25 v1 | HappyHorse video | ⏭ 保留 | 2026-08-01 |
| 2026-05-25 v1 | Classroom zip | ⏭ 保留 | 2026-08-01 |
| 2026-05-25 v3 (research) | G4-G8 (MCP/tools/var-pool/memory) | ⏭ 保留 | 2026-09-01 ~ 2026-10-01 |
| 2026-05-25 v3 (research) | R3 Eval / R4 Prompt | ⏭ 排期 2/3 留给后续 sprint | 2026-07-15 / 2026-08-15 |

### 任务拆解

**R1 — Rerank**：

- [ ] **T1** (L2) — Reranker provider 抽象 (`src/lib/rag/retrieval/rerank-providers.ts`)
  - Interface `RerankerProvider { name; rerank(query, docs[], topK): Promise<RerankedDoc[]> }`
  - 3 实现：
    - `SiliconFlowReranker`（默认；BAAI/bge-reranker-v2-m3；与项目已有 SILICONFLOW_API_KEY 共用）
    - `CohereReranker`（rerank-3；env `COHERE_API_KEY`）
    - `VoyageReranker`（rerank-2；env `VOYAGE_API_KEY`）
  - `getDefaultReranker()` 按 env `RERANK_PROVIDER` 选择；未配置任何 key 时 throw

- [ ] **T2** (L2) — Rerank 包装层 (`src/lib/rag/retrieval/rerank.ts`)
  - `rerankSearchResults(query, results, options)` — 输入是 MilvusSearchResult-like，输出顺序重排 + 新 score
  - `vectorSearch()` 新增 `rerank?: { provider?, topK? }` option，默认 undefined（行为不变）
  - 失败降级：reranker throw → console.warn + 返回原结果 + `{ rerankFailed: true }` 标记

- [ ] **T3** (L2) — Retrieval-plan rerank lane 实际执行 (`src/lib/rag/retrieval/rerank.ts` 同文件)
  - 新增 `executeRerankLane(lane: RagRetrievalLane, query, candidates, queryEmbedding?)` helper
  - lane.parameters 提取 provider/topK
  - 供未来 lane-handlers 显式调用；本 sprint 不动 lane-handlers 自身
  - 标 `// @deadcode-until: lane-handlers 迁移 sprint (2026-08-01)` 注释提示

**R2 — Cost tracking**：

- [ ] **T4** (L1) — Cost tracker 模块 (`src/lib/cost-tracker.ts`)
  - `recordTokenUsage(provider, model, input, output)`
  - 内置价格表（覆盖主要 model；未在表内的 fallback 到 0 + warn 一次）
  - `getCostStats()` 返回 byProvider / byModel / totalUsd
  - `clearCostStats()` / 默认 off (env `COST_TRACKING_ENABLED`)

- [ ] **T5** (L2) — Cost tracker hook 进 model-config (`src/lib/model-config.ts`)
  - `createLLM` / `createReasoningModel` 在 enabled 时附加 LangChain `BaseCallbackHandler`（`handleLLMEnd`）
  - 提取 token usage 字段（兼容 OpenAI/Ollama 两种 shape）
  - 不附 callback 时行为完全不变

**R1+R2 共享**：

- [ ] **T6** (L1) — Trace envelope metadata schema 约定
  - 文档约定 `RagKernelEnvelope.metadata.cost = { totalUsd, byProvider }`
  - 文档约定 `RagKernelEnvelope.metadata.rerank = { provider, durationMs, rerankFailed? }`
  - 仅写文档约定，不改 types.ts（保持 `Record<string, unknown>`）

- [ ] **T7** (L1) — 测试 + invariant 回归
  - `src/lib/rag/retrieval/rerank-providers.test.mjs` (mock fetch, ≥ 5 case)
  - `src/lib/rag/retrieval/rerank.test.mjs` (default off, 降级, vectorSearch 集成形 — mock milvus)
  - `src/lib/cost-tracker.test.mjs` (≥ 5 case：record, byProvider, byModel, totalUsd, clear, disabled noop)
  - 扩展 `src/lib/perf-bench.test.mjs` 加 rerank mock provider baseline

### 验证策略

- 每 task 完成跑：本 task 测试 + invariant_tests 列表 + tsc 改动文件
- 不跑 full repo lint（历史债保持忽略）
- T7 完成后跑 perf-bench 看 baseline 漂移

### Auto mode 评估

- 任务数 7 ≤ 8 ✓
- 风险最高 L2，无 L3/L4 ✓
- scope 与原始需求一致 ✓
- 入场 checklist 三项填齐 ✓
- 5 task 后建议 checkpoint（保留观察）

→ ✓ auto: phase 2 → 3

## Phase 3: 任务清单

- [ ] **T1** (L2) — Reranker provider 抽象
- [ ] **T2** (L2) — Rerank 包装层 + vectorSearch option
- [ ] **T3** (L2) — Retrieval-plan rerank lane 执行 helper
- [ ] **T4** (L1) — Cost tracker 模块
- [ ] **T5** (L2) — Cost tracker hook 进 model-config
- [ ] **T6** (L1) — Trace envelope metadata 约定文档
- [ ] **T7** (L1) — 测试 + invariant 回归

## Phase 4: 审查结果

（Phase 4 进入后填写）

## Phase 5: 复利记录

（Phase 5 进入后填写）
