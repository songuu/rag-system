---
title: "模型 / 向量 / 缓存 / Milvus 全链路优化"
date: 2026-05-25
tags: [solution, rag, milvus, embedding, cache, performance]
related_instincts: [transparency-before-optimization, batch-vs-per-item-embedding]
aliases: ["Model vector cache optimization", "Sprint 2026-05-25 v2 perf"]
---

# 模型 / 向量 / 缓存 / Milvus 全链路优化

## Problem

用户报告 RAG 系统"效果不好，速度太慢，特别是对于缓存，对于 milvus 的利用效果不是很好"。读代码后定位到 8 个具体痛点：

1. `insertDocumentsWithEmbeddings` 把 N 个 chunk 用 `Promise.all(docs.map(d => embedQuery(d.content)))` 提交，**每个文档单独 HTTP**，吞吐被 RTT 主导
2. `SemanticCache.get()` 每次扫所有 entry 做 cosine（含 2 次 sqrt），entry 数升到几百时开销可见
3. query 有 TTL+LRU cache，**doc embedding 完全没有 cache**，重复上传同文档每次都打 provider
4. query 不归一化："什么是 RAG" / "什么是RAG" / "  什么是RAG" 命中不同 cache key
5. Milvus `output_fields` 默认含 `metadata_json`，多数 retrieval 不需要却照收
6. 没有 MMR / source dedupe 后处理，同一文档多 chunk 命中挤掉其他来源
7. 全链路无 timings：用户报"慢"但无法定位 init / embed / search 哪一段
8. Milvus hybrid (sparse+dense) 框架就位但 dead code

## Root Cause

性能优化的反模式：**没有透明度（metrics）就做优化等于黑盒猜测**。

历史 sprint 已经做过 Milvus 搜索热路径优化（[[2026-05-15-milvus-query-speed-optimization]]）和 search policy 抽象（[[2026-05-15-milvus-optimization-evolution]]），但优化范围限于 Milvus 查询本身，没扩展到：

- ingest 路径（写入）
- 缓存系统（SemanticCache + 未存在的 doc cache）
- query 输入归一化
- 后处理（MMR / dedupe）

而且 `insertDocumentsWithEmbeddings` 的 N 次 HTTP 是上线时遗留 bug，code review 没发现因为 `Promise.all(map(embedQuery))` 表面"并行"看起来很合理。

## Solution

### 三阶段策略（用户确认）

**透明度 → 速度 → 效果**

1. **透明度**: 全链路 timings + cache stats
   - `vectorizeAndInsert.timings = { splitMs, contextualMs, initMs, embedMs, insertMs, totalMs }`
   - `insertDocumentsWithEmbeddings.timings = { initMs, embedMs, insertMs, totalMs }`
   - `SemanticCache.getStats()` 扩展 `{ hits, misses, hitRate, lastScanMs, lastScanEntries }`

2. **速度** (4 项):
   - 修 N 次 HTTP bug：`embedQuery(content)` × N → `embedDocuments(texts)` 一次
   - 新增 `src/lib/embedding-cache.ts`：统一 `query` / `doc` / `doc-contextualized` namespace；key = `v1:namespace:model:sha256(text)`；TTL + LRU
   - `generateEmbeddings()` 经过 doc cache（命中跳过 provider）
   - `normalizeQueryText(q)`：NFKC + trim + 多空白合并；用于 query cache key 归一化
   - `SemanticCache`：set 时预归一化 `normalizedEmbedding`，get 时 dot product 替代 cosine（少 1000 个 sqrt / scan）

3. **效果** (2 项):
   - 新增 `src/lib/rag/retrieval/post-process.ts`：`mmrRerank(query, results, {lambda, topK})` + `dedupeBySource(results, perSource)`
   - `vectorSearch()` 增加 `postProcess?: { mmr, dedupeBySource }` option，默认 undefined（行为不变）

4. **Milvus 利用**:
   - `getSlimSearchFields()` 返回 `['id','content','source']`（不含 metadata_json），供初筛 lane 节省传输
   - `isMilvusHybridEnabled()` env flag + `src/lib/rag/retrieval/hybrid-policy.ts` 占位文件 (`@deadcode-until: 2026-08-01`)

### Anti-drift 措施

- frontmatter `invariants:` 7 条（DEFAULT_EMBEDDING_MODEL / search 签名 / cache TTL+key / API 返回 shape / 默认 off 后处理 / 兼容未启用 cache 调用方）
- frontmatter `deferred:` 5 条（含 lane-handlers cache 迁移、Brave/Baidu、HappyHorse、classroom zip、hybrid 实现）
- `invariant_tests:` 6 条（每个 Task 完成必跑）

## Verification

新增测试 24 个，全部通过：

- `node src/lib/embedding-cache.test.mjs` → 9/9
- `node src/lib/semantic-cache.test.mjs` → 5/5
- `node src/lib/rag/retrieval/post-process.test.mjs` → 6/6
- `node src/lib/perf-bench.test.mjs` → 4/4 + bench 基线打到 stdout

Invariant 回归（每 Task 完成强制跑）：

- `node src/lib/milvus-client.test.mjs` → green
- `node src/lib/model-catalog.test.mjs` → 9/9（含 sprint v1 的 3 个 catalog 测试）
- `node src/lib/artifact-cache.test.mjs` → green
- `node src/lib/mirofish/artifact-cache.test.mjs` → green
- `node src/lib/maic/prepare-cache.test.mjs` → green
- `node src/lib/rag/core/kernel.test.mjs` → green
- `node src/lib/maic/upload-validation.test.mjs` → 4/4

`npx tsc --noEmit` 过滤本 sprint 改动 6 个文件 → 零错误。历史 repo-wide 噪音照旧忽略（参见 [[2026-05-14-rag-kernel-implementation#Verification]] 同样做法）。

Perf bench 基线（仅参考，非断言）：

- SemanticCache.get N=20, 1000 entries scan: avg 0.50ms（之前 ~1ms 量级，sqrt 摊销后改善）
- EmbeddingCache N=1000 set=6ms get=4ms（sha256 + Map LRU 总开销可忽略）
- mmrRerank 100 docs lambda=0.5 vs 1.0: top10 overlap=8/10（多样性有效改 2 个位置）
- dedupeBySource 500→150 docs: < 1ms

## Prevention

1. **批量 API 路径必须区分 `embedQuery` vs `embedDocuments`**：单文档循环 `Promise.all(embedQuery)` 是反模式；新增 ingest 路径前先看 provider 是否支持 batch
2. **Cache 性能优化常用技巧：把 per-get 工作摊销到 per-set**：SemanticCache 的 sqrt 摊销 / EmbeddingCache 的 sha256 入 set；类似优化在新 cache 默认采用
3. **跨 namespace cache 必须显式 prefix + 版本号**：`v1:namespace:model:hash`；contextualized chunk 与原始 chunk 单独 namespace 防投毒；归一化算法变化必须 bump 版本（当前 `CACHE_VERSION = 'v1'`）
4. **后处理 op 默认 off + option 显式开启**：MMR / dedupe / hybrid 默认行为不变；想启用必须显式传 option / env，避免静默改变检索语义
5. **"框架就位、实现延后"必须 @deadcode-until + frontmatter deferred 双重跟踪**：避免下次 sprint 启动时再次评估同一议题；超 3 sprint 未落地必须正式撤回
6. **Bench harness 不要写成断言**：CI 抖动会导致断言失败；把基线数据 `console.log` 到 stdout 供 human review；对比逻辑放在后续 sprint 的 review 阶段
7. **性能问题报告进来必须先做透明度再做优化**：用户喊"慢"时下一步不是猜哪段慢，而是先加 timings 在响应里上报，第二步才动代码

## Related

- [[2026-05-15-milvus-query-speed-optimization]] - query embedding cache + initialize fast path（本 sprint 在此之上扩展到 doc cache）
- [[2026-05-15-milvus-optimization-evolution]] - search policy adapter（本 sprint 不动）
- [[2026-05-14-rag-kernel-implementation]] - kernel/policies/retrieval-plan（MMR 后续接入需通过此层）
- [[2026-05-14-rag-system-architecture-evolution]] - Anthropic Contextual Retrieval / Milvus hybrid baseline
- [[2026-05-14-mirofish-openmaic-cache-optimization]] - artifact cache key 策略（本 sprint embedding-cache 沿用相同模式）
- [[2026-05-25-mirofish-openmaic-latest-parity-v2]] - 同日 v1 sprint（model-catalog + MAIC upload 校验）
