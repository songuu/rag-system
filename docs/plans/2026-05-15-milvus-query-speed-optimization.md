---
title: "Milvus 查询速度优化"
type: sprint
status: completed
created: "2026-05-15"
updated: "2026-05-15"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, rag, milvus, performance]
aliases: ["Milvus query speed optimization"]
---

# Milvus 查询速度优化

## Sprint Goal

降低当前 Milvus 查询耗时,优先处理每次查询重复初始化、重复读取集合 stats、重复生成 query embedding、热路径日志序列化和不必要返回字段。

## Think

查询慢通常不是单一 Milvus search 慢,而是这些步骤叠加:

- API route 每次搜索都 `connect -> initializeCollection -> getCollectionStats`。
- `initializeCollection()` 没有 initialized fast path,会重复 `hasCollection`、schema 检查和 load 检查。
- 维度只用于选择 embedding 模型,但每次都通过 stats/describeCollection 获取。
- 相同 query 反复搜索时,embedding 生成重复发生。
- search 热路径会输出大量 console log,包含命中结果的 JSON 序列化。

## Plan

1. 官方核对 Milvus search、load/release、filter templating、consistency 对查询性能的影响。
2. 给 Milvus vector store 增加初始化短路和调试日志开关。
3. API search 改用已校验配置维度,并返回阶段 timings。
4. 给 query embedding 增加短 TTL LRU 风格缓存。
5. 支持 `MILVUS_SEARCH_OUTPUT_FIELDS` 以减少返回字段。
6. 更新文档、架构规则并运行 focused validation。

## Work

- `src/lib/milvus-client.ts`
  - `initializeCollection()` 在实例已初始化时直接返回。
  - `debugLog()` 控制热路径日志。
  - `searchOutputFields` 支持瘦身返回字段。
- `src/app/api/milvus/route.ts`
  - 搜索阶段不再调用 `getCollectionStats()`。
  - 返回 `timings.initMs / embeddingMs / searchMs / totalMs`。
  - 查询向量生成改走共享 cache helper。
- `src/lib/vectorization-utils.ts`
  - 增加 query embedding cache。
  - `vectorSearch()` 不再每次读取集合 stats。
- `src/lib/milvus-config.ts`
  - 新增 `MILVUS_SEARCH_OUTPUT_FIELDS`、`MILVUS_DEBUG_LOGS`。

## Review

风险等级: L2 标准。改动集中在 Milvus 查询热路径和共享 vectorization helper,保持旧 API 响应字段兼容,新增 `timings` 字段为非破坏性扩展。

验收标准:

- 重复查询不会重复执行 collection 初始化流程。
- API search 不再每次读取 collection stats。
- 重复 query 可命中 embedding cache。
- 默认关闭热路径 debug log。
- 仍保留旧 `milvus.search(embedding, topK, threshold, filter)` 签名。

## Compound

本轮沉淀:

- Milvus query hot path 不应做 schema/stats/load 维护工作。
- 查询速度拆分要看 `initMs`、`embeddingMs`、`searchMs`,否则容易把 embedding 或 route 初始化误判成 Milvus 本身慢。
- 大字段结果和 verbose log 都会放大查询延迟,尤其是 chunk 内容较长时。
