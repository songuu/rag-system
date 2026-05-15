---
title: "Milvus 优化和演进"
type: sprint
status: completed
created: "2026-05-15"
updated: "2026-05-15"
checkpoints: 0
tasks_total: 7
tasks_completed: 7
tags: [sprint, rag, milvus, retrieval]
aliases: ["Milvus optimization evolution"]
---

# Milvus 优化和演进

## Sprint Goal

把 Milvus 最新搜索控制能力直接融入当前 RAG 项目,让现有 Milvus adapter 支持更生产化的搜索策略,同时保持既有 API 和 dense retrieval 行为兼容。

## Think

当前问题不是缺少 Milvus 接入,而是接入层只覆盖了基础 collection、index、insert、search。随着项目继续演进到 RAG Kernel 和 Retrieval Control Plane,Milvus 搜索策略必须先变成 adapter-level policy,否则后续 dense/sparse/hybrid/multi-vector 都会在路由层分叉。

关键判断:

- 默认行为必须兼容旧调用: `search(embedding, topK, threshold, filter)` 继续可用。
- 新能力通过可选配置和 object-style search options 暴露。
- API route 只传递策略参数,不承载 Milvus 搜索实现细节。
- 文档和架构规则要同步写明 Milvus 的演进边界。

## Plan

1. 官方核对 Milvus 2.6 Node search、filter templating、multi-vector/hybrid search 文档。
2. 扩展 `milvus-config` 的环境变量和默认连接配置。
3. 扩展 `milvus-client` 的索引参数、搜索参数和插入后 flush/reload 策略。
4. 让 `/api/milvus` 支持传递 search policy,并保持旧请求兼容。
5. 增加 focused tests 覆盖搜索参数归一化和旧签名兼容。
6. 更新 Milvus 配置/集成文档、架构规则和架构演进方案。
7. 跑 targeted validation,记录剩余风险。

## Work

- `src/lib/milvus-config.ts`: 增加 consistency、ignore growing、grouping、flush/reload、search params 等配置入口。
- `src/lib/milvus-client.ts`: 增加 `MilvusSearchOptions`、一致性归一化、索引默认搜索参数、`AUTOINDEX` 支持和 object-style search。
- `src/app/api/milvus/route.ts`: 搜索 action 接受 `exprValues`/`filterParams`、consistency、grouping、hints、round decimal、search params。
- `src/lib/milvus-client.test.mjs`: 用 Node test 覆盖参数构建、SDK enum 映射、旧签名兼容、新选项合并。
- `MILVUS_CONFIG_GUIDE.md`、`MILVUS_INTEGRATION_GUIDE.md`: 补充 Milvus 2.6 搜索控制和环境变量。
- `.codex/rules/architecture.md`: 沉淀 Milvus search policy 属于 adapter 的架构规则。

## Review

风险评估: L2 标准。改动涉及核心 Milvus adapter 和 API route,但没有改变默认调用语义,验证聚焦在类型、lint 和搜索参数 contract。

验收标准:

- 旧 search 签名继续解析 threshold/filter。
- 新 search options 可覆盖 filter templating、consistency、grouping、search params。
- 配置项可从环境变量进入默认 Milvus config。
- 文档说明如何使用和为什么放在 adapter 层。

## Compound

本轮沉淀:

- Milvus 新搜索能力应作为 retrieval adapter policy,不要分散到页面或 API 分支。
- 对 Milvus 动态过滤优先使用 filter templating values,减少复杂 filter 解析和字符串拼接风险。
- flush/reload 适合做成可配置策略: 本地开发默认强可见,批量导入可关闭以换吞吐。
