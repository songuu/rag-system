---
title: "RAG 性能与卡顿审计"
type: sprint
status: completed
created: "2026-05-27"
updated: "2026-05-27"
tags: [sprint, audit, performance, rag]
---

# RAG 性能与卡顿审计

## Scope

本轮只读审计，不改运行时代码。检查面覆盖：

- 查询热路径：`/api/ask`、Agentic RAG、Reasoning RAG、lane handlers、Adaptive Entity RAG、Milvus API
- 导入/向量化热路径：`vectorization-utils`、`document-pipeline`、`/api/pipeline`、`/api/milvus`
- 缓存/后处理：`EmbeddingCache`、`SemanticCache`、MMR/source dedupe
- OpenMAIC/Contextual Retrieval 并发路径
- 前端长任务体感：首页 client bundle、D3 图谱渲染、轮询/SSE cleanup
- 长时间运行状态：trace、MiroFish task/project/simulation/report 内存 store
- 构建/工具链明显卡点

## Findings

### P1: Agentic RAG streaming 固定多等 3 秒

`src/app/api/agentic-rag/route.ts:74` 定义 `HALLUCINATION_WAIT_MS = 3000`，`src/app/api/agentic-rag/route.ts:104` 在 graph stream 完成后无条件 `setTimeout` 再发送 `done`。

影响：每次 streaming 请求末尾固定增加 3 秒体感延迟，即使没有 hallucination correction。

建议：把异步幻觉检查改成可等待 promise / deadline-aware race，或先 `done`，后续 correction 走单独事件，不要固定 sleep。

### P1: `/api/pipeline` 旧导入管道仍逐 chunk 串行 embedding

`src/lib/document-pipeline.ts:619-635` 对每个 chunk 逐个 `await embeddings.embedQuery(chunk.content)`；`src/app/api/pipeline/route.ts:262-280` 多文件上传也逐文件串行处理；`src/lib/document-pipeline.ts:878-905` batch API 同样逐文档串行。

影响：大 PDF / 多文件导入耗时约等于 `文件数 * chunks * 单次 embedding RTT`，且绕过新的 `EmbeddingCache`。

建议：复用 `src/lib/vectorization-utils.ts` 的批量 embedding/cache helper，或把 `document-pipeline.generateEmbeddings` 改为 `EmbeddingCache.getMany -> embedDocuments(misses) -> setMany`。

### P1: 新 embedding cache 没覆盖主要导入入口

`src/lib/vectorization-utils.ts:236-256` 的 `generateEmbeddings()` 已接 `EmbeddingCache`，但 `vectorizeAndInsert()` 在 `src/lib/vectorization-utils.ts:410-418` 直接 `embeddings.embedDocuments(texts)`；`insertDocumentsWithEmbeddings()` 在 `src/lib/vectorization-utils.ts:516-518` 也直接 `embedDocuments(texts)`。

`src/app/api/milvus/route.ts:205-206` 的 `insert` action 仍是 `Promise.all(... embedQuery(doc.content))`，属于 N 次 provider 请求。

影响：重复导入相同内容仍会打 embedding provider；Milvus API insert 还可能并发打爆本地 Ollama/远端限流。

建议：导入入口全部走同一个 cached batch embedding helper；直接 insert action 至少改成 `embedDocuments` + concurrency limit。

### P1: 多条查询路径绕过 query cache 和 Milvus fast path

项目里有 29 处 `embedQuery(`、33 处 `getCollectionStats(`。新 fast path 主要在 `/api/milvus` search 和 `vectorSearch()`，但旧路径仍直接做 query embedding / stats：

- `src/app/api/ask/route.ts:329-370`
- `src/lib/lane-handlers.ts:226-236`
- `src/lib/lane-handlers.ts:514-541`
- `src/lib/agentic-rag.ts:571-576`
- `src/lib/agentic-rag.ts:845-850`
- `src/lib/adaptive-entity-rag.ts:1274-1317`
- `src/lib/reasoning-rag.ts:779-789`

影响：同 query 无法稳定命中 `generateQueryEmbedding()` TTL cache；`getCollectionStats()` 内部会 `getCollectionStatistics + getLoadState + describeCollection`，旧路径每次查询都多一串 Milvus 管理请求。

建议：收敛到共享 retrieval helper：`generateQueryEmbedding()` + `milvus.search(..., { outputFields: getSlimSearchFields() })`；集合维度优先用已初始化 config，只有维度不确定或管理接口才读 stats。

### P2: Contextual Retrieval 仍是 batch barrier

`src/lib/contextual-retrieval.ts:288-296` 按 `batchConcurrency` 切批，每批 `await Promise.all(batch)` 后才启动下一批。

影响：一个慢 chunk 会拖住整批之后的所有 chunk。OpenMAIC prepare 已在 `src/lib/maic/pipeline/page-order.ts` 改成滑动窗口，但 Contextual Retrieval 还没复用这套模式。

建议：抽一个通用 `mapWithOrderedCallbacks` / worker pool，替换 batch barrier。

### P2: Adaptive Entity RAG rerank 是最多 10 次串行 LLM

`src/lib/adaptive-entity-rag.ts:1447-1475` 对 top 10 结果逐个 `await invokeStructuredJson(...)`。

影响：启用 reranking 时，尾延迟约等于 10 次 LLM 调用累加。

建议：加 provider-aware concurrency limit，或先用轻量 local score 预筛到 3-5 条再 LLM rerank。

### P1: Reasoning RAG reranker 是最多 20 次串行 LLM

`src/lib/reasoning-rag.ts:962-989` 先取 `docs.slice(0, Math.min(20, docs.length))`，再在 `for (const doc of docsToRerank)` 内逐个 `await chain.invoke(...)`。

影响：默认启用 rerank 时，Reasoning RAG 查询尾延迟可能从 1 次回答 LLM 变成额外 20 次评分 LLM 串行；本地模型会非常明显。

建议：先把 rerank 候选压到 5-8 条，或改成 provider-aware 并发窗口；更推荐接统一 rerank provider（本地 cross-encoder / SiliconFlow rerank / fallback LLM）。

### P2: Reasoning RAG hybrid 维度字段疑似读错

`src/lib/reasoning-rag.ts:779-781` 使用 `(stats as any)?.dimension || 768`，但 Milvus stats 类型里实际字段是 `embeddingDimension`。

影响：非 768 维集合可能选错 embedding model，导致查询向量维度不匹配、失败重试或空结果，表现为慢和“不好用”。

建议：改为 `stats?.embeddingDimension`，并接入统一 `selectModelForCollection` / `generateQueryEmbedding`。

### P2: Reasoning RAG vectorize 专线仍逐文件串行

`src/app/api/reasoning-rag/vectorize/route.ts:243-347` 对 `filesToProcess` 逐个处理；每个文件内部 `src/app/api/reasoning-rag/vectorize/route.ts:288-310` 再按 10 个 chunk 一批串行 embedding，失败 fallback 还会逐 text 串行 `embedDocuments([truncatedText])`。

影响：Reasoning RAG 独立上传目录绕过主向量化 helper/cache；多文件导入、Contextual Retrieval 开启、或 provider 偶发 batch 失败时，耗时会按文件和 chunk 叠加。

建议：复用统一 cached batch embedding helper；文件级别加小并发（2 左右），chunk 级别保持 batch + retry，不要退化成全串行。

### P3: stats 路径日志偏重

`src/lib/milvus-client.ts:1006-1022` 每次 `getCollectionStats()` 都打印 schema fields。

影响：stats 被旧查询路径调用时会放大日志 IO 和控制台噪音。

建议：改为 `debugLog` 或只在维度解析失败时打印。

### P3: sprint 文档含 NUL 字节，影响检索

`docs/plans/2026-05-25-model-vector-cache-optimization.md` 有 2 个 NUL 字节，`rg` 将它视为 binary file。

影响：后续审计/grep 会漏上下文或输出 `binary file matches`。

建议：清理 NUL 字节，保持 markdown 文本可检索。

### P1: MiroFish / entity extraction 图谱构建是 chunk 串行 LLM

`src/lib/mirofish/graph-builder.ts:147-149` 调用 `EntityExtractor.extract()`；`src/lib/entity-extraction.ts:670-682` 对 chunks 逐个 `await this.extractFromChunk(chunk)`；若启用 gleaning，`src/lib/entity-extraction.ts:971-985` 每轮也逐次 LLM。

影响：图谱构建耗时近似 `chunk 数 * (主抽取 LLM + gleaning LLM)`。`GraphBuilder` config 里有 `batchSize`，但当前 worker 没把它传给 extractor 或并发调度，配置看起来可控，实际没有提速作用。

建议：给 EntityExtractor 加 provider-aware 并发窗口，保持合并顺序 deterministic；`batchSize` 接入实际抽取阶段，并增加“慢 chunk 不拖全局”的回归测试。

### P1: 人设生成逐实体串行

`src/lib/mirofish/prepare-service.ts:75-77` 对选中的 entities 调 `generateProfiles()`；`src/lib/mirofish/profile-generator.ts:143-168` 明确逐个生成，注释也写了“可以改为并行”。

影响：准备模拟环境时，10 个 agent 就是 10 次串行 LLM；用户选择较多实体时会明显卡在 prepare 阶段。

建议：加 `MIROFISH_PROFILE_CONCURRENCY`，默认 2-4；失败继续保留单个 profile fallback，避免一个实体拖垮整批。

### P2: 模拟行为生成无并发上限

`src/lib/mirofish/simulation-engine.ts:158-170` 对本轮 posting agents 直接 `Promise.all(promises)`。

影响：agent 数多或平台数多时会瞬时打满 LLM provider，本地 Ollama 会排队，远端 provider 可能限流；体感上表现为某轮突然很慢。

建议：加全局并发池，按 provider 区分默认值；保留平台内并行，但限制峰值。

### P2: KnowledgeGraphViewer 每轮 O(N²) 力导向 + React state 更新

`src/components/KnowledgeGraphViewer.tsx:237-334` 最多 300 次 animation frame；每帧复制 nodes、双层循环节点斥力（O(N²)），再 `setNodes(updatedNodes)`。`src/components/KnowledgeGraphViewer.tsx:568-574` 标签截断每个节点循环 `measureText`。

影响：实体数上百时，图谱页面会占主线程，拖慢 hover/zoom/展开详情。

建议：把布局模拟放到 ref/canvas loop，不每帧进 React state；节点多时降级 Barnes-Hut/d3-force 或服务端预布局；标签宽度缓存到 node id + zoom。

### P2: MiroFish process 页 D3 图每次 graphData 重建整图

`src/app/mirofish/process/page.tsx:319-419` 在 `graphData` 变化时 `svg.selectAll('*').remove()` 后重建所有 nodes/links 和 force simulation。

影响：轮询/局部更新 graphData 时会整图重建，节点多时闪动和卡顿明显。

建议：用 data join 增量更新，或将 graphData 归一化后按 graph id / version 控制重建频率。

### P2: 多个 MiroFish D3 页面重建 force graph 且未显式停止旧 simulation

`src/app/mirofish/entity-extraction/page.tsx:227-328`、`src/app/mirofish/graph-rag/page.tsx:179-273` 都在 render 时 `svg.selectAll('*').remove()` 后新建 `d3.forceSimulation(...)`，但没有保存 simulation 引用并在下一次渲染/卸载时 `simulation.stop()`。

影响：graphData 或全屏状态变化时，旧 force simulation 可能继续 tick 一段时间；多个图谱页来回切换会放大主线程占用。

建议：在 effect cleanup 中停止 simulation；大图统一封装一个 GraphCanvas/D3 adapter，避免每个页面复制一套 lifecycle。

### P2: 首页 client island 过大且默认连接 socket

`src/app/page.tsx:1-24` 整个首页是 `use client`，直接引入 20+ 个交互组件；`src/app/page.tsx:153-203` 首屏即 `io()` 建立 socket；`src/app/page.tsx:1124-1129` 首屏同时打 `/api/health`、`/api/files`、`/api/milvus?action=status`、IndexedDB 会话加载。

影响：首页冷启动 bundle 和首屏请求都偏重；用户只想问答时，也会初始化监控、文件、Milvus、socket 相关状态。

建议：把首页拆成轻 shell + 懒加载 panels；socket 只在打开 RealtimeMonitoring 或发生导入任务时连接；Milvus/status/file list 做可见区域加载。

### P3: 部分轮询完成后仍会继续请求或进度易假卡住

`src/components/mirofish/Step4Report.tsx:67-90` 在 report completed/failed 后只 `setLoading(false)`，interval 仍按 `reportId` 每 3 秒继续请求直到组件卸载。`src/app/mirofish/entity-extraction/page.tsx:148-180` 在函数内启动 interval，依赖闭包里的 `extracting`，没有 effect cleanup；容易只轮询一次就停，或重复点击后多个 interval 并存。

影响：一个是后台闲置请求，一个是长抽取时 UI 进度可能看起来不动，用户体感就是“卡住”。

建议：轮询统一用 `useEffect(taskId/status)` 管理；completed/failed 后立即 clear；函数内 interval 改成 ref/effect。

### P2: build 阶段重复生成 articles，且可能阻塞 Notion 同步

`package.json:7-8` 同时定义 `prebuild = node scripts/generate-articles.mjs` 和 `build = node scripts/generate-articles.mjs && next build`。npm/pnpm lifecycle 会先跑 `prebuild`，然后 `build` 内又跑一次。`scripts/generate-articles.mjs:190-194` 如果存在 Notion env，还会在 build 内同步 Notion。

影响：本地/CI build 至少重复一次文章生成；若配置 Notion，构建可能被外部网络和 Notion API 卡住。

建议：删掉 build script 内的重复生成，保留 `prebuild`；Notion 同步仅保留在 `sync:notion` 显式命令。

### P3: context-management 使用同步文件 IO

`src/lib/context-management.ts:294-331` 使用 `writeFileSync/readFileSync/readdirSync` 保存和枚举 session。

影响：对话 session 较多或消息体较大时，API 请求线程被同步磁盘 IO 阻塞。

建议：改成 async fs；列表接口只读 metadata 索引，不逐个 JSON 全量 parse。

### P3: extraction 文件列表读取全文只为算 size

`src/app/api/entity-extraction/route.ts:113-136` 列文件时读取每个 `.txt/.md/_parsed.txt` 全文，只用 `content.length` 做 size。

影响：上传目录大时，文件列表接口会被全文读取拖慢。

建议：用 `stat.size` 替代 `readFile`，仅在真正抽取时读取内容。

### P2: trace / LangSmith mirror 内存索引无上限

`src/lib/observability.ts:100-102` 用 `Map` 保存 traces/observations/scores，只有手动 `clear()`；`src/lib/langsmith/trace-mirror.ts:12-15` 的 `rootRuns`、`observationRuns`、`finalizedRuns`、`syncedScores` 也没有 TTL/上限。`src/lib/rag-instance.ts:14-27` 又把 RAG 实例挂在 `globalThis`，所以这些对象会随 dev/server lifetime 累积。

影响：长时间问答/压测后，观测数据会占用越来越多内存，`/api/traces` 本地 fallback 还会返回全量 local traces。

建议：本地观测保留最近 N 条 trace（如 200），LangSmith mirror 在 finalized 后删除 root/observation RunTree 缓存，只保留短期去重 Set。

### P2: MiroFish task/project/simulation/report 内存 store 缺自动 TTL

`src/lib/mirofish/task-manager.ts:129-142` 有 `cleanOldTasks()`，但调用面没看到自动执行；`src/lib/mirofish/project-store.ts:10-29`、`src/lib/mirofish/simulation-runner.ts:53-88`、`src/app/api/mirofish/report/route.ts:15` 都是长期 Map。simulation 内还会在 `src/lib/mirofish/simulation-runner.ts:275-305` 累积 posts/timeline。

影响：连续构建图谱/模拟/报告后，服务端内存和列表接口成本会一直增长；只靠用户手动 DELETE 不够稳。

建议：给 task/report/simulation/project 加 TTL 或最近 N 条保留；长文本 graph/report 快照落盘或 blob store，内存只放索引。

### P3: Milvus visualization 一次请求串行 5 次查询

`src/app/api/milvus/visualize/route.ts:178-190` 的 `vector-space` action 对 `['技术','商业','日常','科学','文化']` 逐个 `embedQuery + milvus.search`；`src/app/api/milvus/visualize/route.ts:299` 计算 median 时还会原地 `results.sort(...)`。

影响：可视化面板一次刷新至少 5 轮 embedding/search RTT；虽然不是核心 RAG 热路径，但打开 Milvus 可视化会明显拖慢面板响应。

建议：固定主题 query embedding 走 query cache，并发限制为 2-3；median 用拷贝数组排序，避免改变返回 top results 顺序。

## Non-Bottlenecks Verified

- `SemanticCache.get` 1000 entries scan：avg 0.60ms，本轮不是主要瓶颈。
- `EmbeddingCache` 1000 set/get：set 5ms、get 3ms，cache key/hash 开销很低。
- `mmrRerank` 100 docs：1-2ms 级。
- `dedupeBySource` 500 docs：0ms 级。
- OpenMAIC prepare sliding window / dependency graph tests 通过，当前 prepare 提速不变量没回退。
- 大文件信号：`adaptive-entity-rag.ts` 2129 行、`milvus/page.tsx` 2060 行、`OpenMaicClassroom.tsx` 1926 行、`app/page.tsx` 1632 行。大文件本身不是卡顿证据，但它们集中承载状态和渲染逻辑，后续性能修复应优先拆出可测试 helper。
- 已有 polling cleanup 较好的路径：`src/components/mirofish/Step1GraphBuild.tsx:172-194` 会随 `graphLoading=false` 触发 cleanup；`src/app/entity-extraction/page.tsx:191-215` 也用 effect cleanup 管 interval。问题集中在函数内 interval 和完成后未停的轮询。

## Validation

- `node src/lib/perf-bench.test.mjs` -> 4 pass
- `node src/lib/embedding-cache.test.mjs` -> 9 pass
- `node src/lib/semantic-cache.test.mjs` -> 5 pass
- `node src/lib/rag/retrieval/post-process.test.mjs` -> 6 pass
- `node src/lib/milvus-client.test.mjs` -> 5 pass
- `node src/lib/maic/pipeline/page-order.test.mjs` -> 8 pass
- `node src/lib/maic/pipeline/prepare-runner.test.mjs` -> 2 pass

Node 测试均出现 `MODULE_TYPELESS_PACKAGE_JSON` warning；这是测试/Node ESM 解析开销，不是线上热路径证据。不要直接加 `"type": "module"`，会影响现有 CommonJS 风格脚本，需单独评估。

## Recommended Fix Order

1. 移除 Agentic RAG stream 固定 3 秒等待。
2. 统一 query retrieval helper：旧路径接 `generateQueryEmbedding`、slim output fields、避免 stats hot path。
3. 统一 document embedding helper：`document-pipeline`、`vectorizeAndInsert`、`insertDocumentsWithEmbeddings`、Milvus insert action 全走 cached batch。
4. Contextual Retrieval batch barrier 改滑动窗口。
5. EntityExtractor / MiroFish profile generation 加 provider-aware 并发窗口。
6. Reasoning / Adaptive Entity rerank 加并发限制/预筛，并接统一 rerank provider。
7. Reasoning RAG hybrid 修 `embeddingDimension` 字段，Reasoning vectorize 接统一 cached batch helper。
8. KnowledgeGraphViewer 和 MiroFish D3 图谱 lifecycle 修复：停止旧 simulation，避免每帧 React state。
9. 首页拆轻 shell，socket/status/file list 延迟到需要时加载。
10. 给 trace、LangSmith mirror、MiroFish task/project/simulation/report store 加 TTL/上限。
11. build script 去重，Notion 同步从 build 中移出。
12. `getCollectionStats()` 日志降级到 debug。
13. 清理 `docs/plans/2026-05-25-model-vector-cache-optimization.md` NUL 字节。
