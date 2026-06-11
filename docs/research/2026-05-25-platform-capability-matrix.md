---
title: "Dify / Coze / rag-system 能力对照表"
type: research
date: 2026-05-25
tags: [research, comparison, matrix]
aliases: ["Platform capability matrix"]
sprint: 2026-05-25-coze-dify-integration-research
depends_on:
  - "[[2026-05-25-dify-capability-survey]]"
  - "[[2026-05-25-coze-capability-survey]]"
  - "[[2026-05-14-rag-system-architecture-evolution]] - 现有架构基线"
---

# Dify / Coze / rag-system 能力对照表

> 三列对比 + gap 列。每格 ≤ 100 字符，详细描述见 T1/T2/architecture-evolution。

## 8 能力轴主表

| 能力轴 | Dify | Coze | rag-system (local) | local 最大 gap |
|--------|------|------|---------------------|----------------|
| **1. Workflow / orchestration** | `core/workflow/` + visual canvas + variable pool + template rendering + human input 节点 | studio `domain/workflow/` + FlowGram canvas + Eino runtime | RAG Kernel + retrieval-plan (8 lane) + policy adapter；**无可视化编辑器、无 variable pool/template、无 human input** | 缺可视化 workflow IDE；缺 variable pool / template rendering / human input |
| **2. Tool / plugin registry** | `core/{tools,plugin,mcp,external_data_tool}/`；50+ built-in；**MCP first-class** | studio `domain/plugin/` + cloud marketplace；OSS 无 MCP | 完全无 plugin / tool registry / MCP；mirofish/maic 是写死页面 | 缺整套 tool 系统；缺 MCP 客户端；缺动态 plugin 加载 |
| **3. Knowledge base / RAG** | `core/rag/` 14 子模块（cleaner/splitter/extractor/rerank/summary_index/...） | studio `domain/knowledge/`；loop `data/` dataset | Milvus + contextual retrieval + artifact-cache + 4 policy RAG；**Rerank / summary_index 缺位** | 缺显式 pipeline stage 抽象；缺 rerank（前 sprint deferred）；缺 summary_index |
| **4. App / template** | `core/app/`；4 类 app type (Chatflow/Workflow/Chat Assistant/Text Generator) | studio `domain/{app,template}/`；agent/app/bot 三实体分离 | 无 app/template 抽象；MAIC/MiroFish 写死页面 | 缺 app entity + template 系统；缺多模板复用 |
| **5. Memory / session** | `core/memory/` 显式模块；conversation memory + agent memory 分离 | studio `domain/{memory,conversation}/` 分离 | agentic/reasoning RAG 各自维护轻量 state；MAIC session-controller 场景专用 | 缺通用 memory / session 抽象；scene-specific 实现碎片化 |
| **6. Eval / trace / observability** | `core/{ops,telemetry,logging}/` 内嵌；无独立 eval 产品 | **coze-loop 独立产品**：dataset + evaluator + experiment + prompt 版本 + 3 语言 SDK | LangSmith JS SDK + retrieval-plan trace envelope + sprint v2 timings；**无 dataset/experiment/evaluator 三件套** | 缺 evaluation 框架；缺 prompt 版本管理；缺 playground 对比 |
| **7. Multi-tenant / workspace** | `enterprise/` 暗示有；**license 禁止 SaaS 商用 multi-tenant** | studio `domain/{openauth,permission,user}/`；Apache 2.0 无限制 | 单租户 Next.js；MAIC 按 course_id 字符串隔离 | 缺 workspace / org 抽象；缺 OAuth + permission 系统 |
| **8. Cost tracking** | 推断在 `model_manager`/`provider_manager` 拦截 token；README 仅提"LLMOps"伞 [L] | 推断在 `observability` 内嵌 [L] | 完全无 cost tracking | 缺 token usage 累计 / 按 provider 报表 / 预算告警 |

## 第 4 列：架构基线参照点

对照 [[2026-05-14-rag-system-architecture-evolution]] 中列出的 RoutIR / Anthropic Contextual / Milvus hybrid / Ragas / GraphRAG baseline：

| Baseline | Dify 落地 | Coze 落地 | rag-system 落地 |
|----------|-----------|-----------|-----------------|
| LangChain Retrieval 模块化 | ✓ rag/extractor/splitter/embedding | ✓ knowledge domain | ✓ document-pipeline + RAG Kernel |
| Anthropic Contextual Retrieval | 未明确 [L] | 未明确 [L] | ✓ `src/lib/contextual-retrieval.ts` |
| Milvus hybrid (sparse+dense) | rag/retrieval 支持 [M] | knowledge domain 支持 [M] | ❌ feature flag only（前 sprint 落地，2026-08-01 实现） |
| Ragas 评估 | core/ops 集成 [M] | coze-loop modules/evaluation | ❌ |
| GraphRAG | 未明确 | 未明确 | 部分（mirofish ontology-generator） |
| RoutIR (query expansion / fusion / rerank pipeline) | core/rag/ 14 子模块覆盖大部分 | knowledge + workflow 组合 | 部分（retrieval-plan lane 框架在位） |

## Gap 优先级速记（指导 T4）

按"价值 / 工作量"粗排序（详细评估见 [[2026-05-25-integration-feasibility-analysis]]）：

| Gap | 价值 | 工作量 | 优先级建议 |
|-----|------|--------|-----------|
| Eval (dataset + evaluator + experiment) | 高（直接解 RAG 评估不可观测） | 中（langsmith 基础上扩展） | **优先** |
| Rerank stage（前 sprint deferred） | 高（直接提升检索质量） | 中（接 bge-reranker / cohere） | **优先** |
| Prompt 版本管理 + playground | 中高（解开发体验） | 中 | **优先** |
| MCP 客户端接入 | 中（生态扩张） | 中（社区 SDK 已成熟） | 中期 |
| Workflow visual editor | 中（用户面价值高，但 local 主要服务于 RAG，非通用 agent 平台） | 大（前端工程大） | 长期 / 不做 |
| Tool / plugin registry | 中（agentic-rag 可受益） | 中 | 中期 |
| App / template 系统 | 低（local 应用是 MAIC/MiroFish 写死） | 大 | 不做 |
| Memory / session 抽象 | 中（多 RAG policy 受益） | 中 | 中期 |
| Multi-tenant workspace | 低（本项目不卖 SaaS） | 大 | 不做 |
| Cost tracking | 中（运营级需要） | 小 | **优先** |

5 个 gap 标 "优先"（含 cost tracking 小工作量）。详细决策落 T4。
