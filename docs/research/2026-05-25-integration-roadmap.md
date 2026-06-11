---
title: "Coze / Dify 优点集成落地路线图"
type: research
date: 2026-05-25
tags: [research, roadmap, integration-plan]
aliases: ["Integration roadmap"]
sprint: 2026-05-25-coze-dify-integration-research
depends_on:
  - "[[2026-05-25-integration-feasibility-analysis]]"
  - "[[2026-05-25-platform-capability-matrix]]"
---

# Coze / Dify 优点集成落地路线图

> 来自 [[2026-05-25-integration-feasibility-analysis]] 的 4 个 adopt 决策，按 (能力 / 业务价值 / 工作量 / 风险 / 依赖) 五元组排序。本路线图不启动任何一项落地；每项默认假设单独成 sprint，走 think→plan→work→review→compound 流程。

## 五元组定义

- **能力**：上游对应模块 / 来源
- **业务价值**：解什么实际问题
- **工作量**：S (≤ 1 day) / M (1-3 day) / L (3+ day)
- **风险**：L1 (低风险新增) / L2 (常规改动) / L3 (核心逻辑)
- **依赖**：阻塞此 sprint 的前置条件

## 推荐落地 (4 项)

### 排期 1: Next sprint 候选（2 项，独立可并行启动）

#### R1 — Rerank stage 接入 (G2)

| 五元组 | 内容 |
|--------|------|
| 能力 | Dify `core/rag/rerank/` 模式；接 bge-reranker-v2-m3 (开源) / Cohere rerank-3 / Voyage rerank-2 任一 |
| 业务价值 | 直接提升检索 precision；与 MMR 后处理协同（MMR 解多样性，rerank 解相关性）；user 报 "效果不好" 的最直接解 |
| 工作量 | **M** (1.5 day) — provider 抽象 + lane wire + 测试 |
| 风险 | **L2** — 新 lane stage，retrieval-plan 已有定义 |
| 依赖 | 无（已纠偏：rerank 可独立于 hybrid） |

**Sprint 提案大纲**（仅作参考，启动时按 /sprint 流程重新拆）：

- T1 (L1): 在 `src/lib/rag/retrieval/` 新建 `rerank.ts`，包装 bge-reranker / Cohere / Voyage API；走 `model-config` provider 抽象
- T2 (L2): `vectorSearch` 增加 `rerank?: RerankOptions` 选项；与 `postProcess` 同位
- T3 (L2): retrieval-plan 中 `rerank` lane 类型 → 实际执行（之前是 declarative 未实现）
- T4 (L1): bench + invariant test；rerank 默认 off
- T5 (L1): 文档 + sprint frontmatter `deferred:` 移除"Rerank 模块"

**完成后解锁**：[[2026-05-25-model-vector-cache-optimization]] frontmatter `deferred:` 中"Rerank 模块"项

#### R2 — Cost tracking (G11)

| 五元组 | 内容 |
|--------|------|
| 能力 | Dify `model_manager`/`provider_manager` 推断 + Coze `observability` 推断 |
| 业务价值 | 运营级 token 预算告警；调试时定位昂贵 prompt；与 LangSmith 协同呈现 |
| 工作量 | **S** (0.5-1 day) |
| 风险 | **L1** — 仅横切计数 |
| 依赖 | 无 |

**Sprint 提案大纲**：

- T1 (L1): 新建 `src/lib/cost-tracker.ts`，进程级 `tokenUsageByProvider: Map<provider, {input, output, totalUsdEstimate}>`
- T2 (L2): 在 `src/lib/model-config.ts` createLLM 包装层 hook usage（LangChain callback handler）
- T3 (L1): retrieval-plan trace envelope 加 `cost?: { usd, breakdown }` 字段；可选 response header `x-rag-cost-usd`
- T4 (L1): test + 默认 off (env `COST_TRACKING_ENABLED`)

### 排期 2: Mid-term（1 项，依赖 R1 或独立）

#### R3 — Evaluation framework 雏形 (G1)

| 五元组 | 内容 |
|--------|------|
| 能力 | Coze-loop `modules/{data,evaluation}/`；Dify `core/ops/` |
| 业务价值 | 解 RAG / agent 输出"看着对但实际差"的不可观测；可作为持续质量基线 |
| 工作量 | **M-L** (2-4 day) — dataset / evaluator / experiment 三件套，本地化为 TypeScript |
| 风险 | **L2** — 新子系统，但不动现有 policy |
| 依赖 | 推荐先做 R1 rerank（评估对象更稳定）；可与 R2 cost-tracker 并行 |

**Sprint 提案大纲**：

- T1 (L1): 扩展 `src/lib/rag/eval/golden-questions.ts` → 抽象为 `Dataset` interface；新增 `dataset/` 子目录
- T2 (L2): 新建 `src/lib/rag/eval/evaluators/` —— containing `correctness.ts` (LLM-as-judge), `relevance.ts` (cosine), `latency.ts` (timings 字段)
- T3 (L2): 新建 `experiment.ts` — `runExperiment({dataset, policy, evaluators})` 返回 metrics summary
- T4 (L1): CLI 入口 `node src/lib/rag/eval/run.mjs --policy agentic --dataset smoke`
- T5 (L1): 文档 + bench harness 整合（perf-bench + quality-bench 并列）

**与 Ragas 关系**：Ragas 是 Python；本地实现 TypeScript 版本，但 metric 定义可借鉴 Ragas (faithfulness / answer relevance / context precision)。

### 排期 3: Long-term（1 项，价值-工作量 trade-off 较弱）

#### R4 — Prompt registry (G3)

| 五元组 | 内容 |
|--------|------|
| 能力 | Coze-loop `modules/prompt/` |
| 业务价值 | 解开发体验；prompt 改动可回滚（git 已部分覆盖）；多模型对比 |
| 工作量 | **S-M** (0.5-2 day, 取决于是否做 playground UI) |
| 风险 | **L1**（仅做 registry）— **L3**（如做 UI playground） |
| 依赖 | R3 完成后做更佳（实验场景多了对 prompt 版本回滚需求更强） |

**Sprint 提案大纲**（不含 UI playground 版本）：

- T1 (L1): 新建 `src/lib/rag/prompt-registry.ts` — `getPrompt(key: string, version?: string)`；version=`'latest'` 默认
- T2 (L2): 将散落在 `agentic-rag.ts` / `reasoning-rag.ts` / `self-corrective-rag.ts` / `adaptive-entity-rag.ts` 的 prompt 抽到 `src/lib/rag/prompts/`
- T3 (L1): bench / golden-question 与 prompt version 关联（experiment 报告显示 prompt version）
- T4 (L1): 文档化

**降级方案**：纯 git 历史本身就是 prompt 版本管理；如果开发体验已能接受，本 sprint 可继续 defer。

## 未推荐 (defer / skip) 汇总

详见 [[2026-05-25-integration-feasibility-analysis]]，简表：

| ID | Gap | 决策 | 重新评估时机 |
|----|-----|------|-------------|
| G4 | MCP 客户端 | defer | 2026-09-01 — 业务出现需要外部 tool 调用 |
| G5 | Tool / plugin registry | defer | ≥ 3 个 tool 复用需求出现 |
| G7 | Variable pool / template rendering | defer | 跨 lane 输出→输入的具体需求出现 |
| G8 | Memory / session 抽象 | defer | 跨 policy 共享状态需求出现 |
| G6 | Workflow 可视化编辑器 | skip | 项目定位转向通用 agent 平台才考虑 |
| G9 | App / template 系统 | skip | 同上 |
| G10 | Multi-tenant workspace | skip | 项目转 B2B SaaS 才考虑 |

## 排期建议（汇总）

```
即刻可启动:
  ┌── R1 (Rerank, M, L2)   ─┐
  │                          ├─ 可并行
  └── R2 (Cost tracking, S, L1) ┘

R1 / R2 完成后:
  └── R3 (Eval framework, M-L, L2) — 依赖稳定的 retrieval baseline

R3 完成后:
  └── R4 (Prompt registry, S-M, L1-L3) — 看是否做 UI playground
```

**总投入估算**: 5-9 day 跨 3-4 sprint。

## 与既有 deferred 列表的对齐

本 sprint 完成后，建议立刻更新 [[2026-05-25-model-vector-cache-optimization]] frontmatter `deferred:` 字段：

- 把 "Rerank 模块（依赖 hybrid）" → 改为 "Rerank 模块（独立可做，参见 R1）"，deadline 不变（2026-08-01）
- 其余 deferred 不动

本研究 sprint 自身 frontmatter `deferred:` 字段保留 4 项 (G4 / G5 / G7 / G8)，deadline 按 R1-R4 完成后回评。

## 不做的事（明确边界）

- **不做** workflow visual editor / 通用 agent platform
- **不做** multi-tenant
- **不做** app / template / connector 抽象
- **不做** plugin marketplace
- **不做** 直接 fork Dify 或 Coze 任何一个 repo

## 调研局限性

- R1-R4 工作量是粗估；启动时按 /sprint 流程会重新拆任务、重新评风险
- R3 evaluation framework 的 LLM-as-judge 实现复杂度可能比 M 高（需 mock provider / golden answer），启动时再细化
- R4 prompt registry 是否包含 UI playground 决定工作量 S vs L 差异显著；建议先做 registry 不做 UI
