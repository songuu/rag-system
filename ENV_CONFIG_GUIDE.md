# 环境变量配置指南

## 快速开始

创建 `.env.local` 文件并配置以下环境变量：

```bash
# LLM 模型提供商选择
MODEL_PROVIDER=ollama  # 可选: ollama | openai | azure | custom

# Embedding 模型提供商选择 (独立于 LLM)
EMBEDDING_PROVIDER=siliconflow  # 可选: ollama | siliconflow | openai | custom
```

## 架构说明

本系统支持 **LLM 与 Embedding 完全解耦**：

| 模块 | 环境变量 | 说明 |
|------|----------|------|
| LLM 模型 | `MODEL_PROVIDER` | 控制对话/生成模型 |
| Embedding 模型 | `EMBEDDING_PROVIDER` | 控制向量嵌入模型 |

## LangSmith 观测与评估配置

本项目支持 LangSmith 最新 JS SDK 追踪能力。开启后，`/api/ask` 会写入 LangSmith root run，本地 `ObservabilityEngine` 会 mirror Trace/Observation/Score，并通过 `thread_id` 支持 Threads、Insights Agent 和 Multi-turn Evals。

```bash
# 推荐新变量
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_xxxxx
LANGSMITH_PROJECT=rag-system

# 可选
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=
LANGSMITH_TRACING_SAMPLE_RATE=1
LANGSMITH_HIDE_INPUTS=false
LANGSMITH_HIDE_OUTPUTS=false
LANGSMITH_HIDE_METADATA=false
LANGSMITH_OMIT_RUNTIME_INFO=false

# 兼容旧 LangChain 变量
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=rag-system
LANGCHAIN_ENDPOINT=https://api.smith.langchain.com
```

关键约定：

- `sessionId` 会映射为 LangSmith `thread_id`、`session_id`、`conversation_id`。
- 未传 `sessionId` 时，系统会生成 UUIDv7 thread id。
- 用户反馈接口 `/api/traces/[traceId]/feedback` 会同步到 LangSmith feedback。
- 未配置 `LANGSMITH_API_KEY` 时，LangSmith 链路自动 no-op，本地行为不变。

这意味着你可以：
- LLM 用本地 Ollama，Embedding 用云端 SiliconFlow
- LLM 用 OpenAI，Embedding 用 SiliconFlow (省钱)
- 或任意组合

## E3-E7 分阶段激活配置

会改变生成 evidence、检索主链或持久化路径的能力默认关闭；检索拒答默认只在
`shadow` 观察。复制容器样例不会改变现有 dense/text 生产回答。除 Durable Ask
仅支持 `off | active` 外，其余查询期 rollout 使用 `off | shadow | active`：

| 能力 | 开关 | 安全默认 | 激活前置条件 |
|------|------|----------|--------------|
| 有序全文上下文 | `RAG_ORDERED_CONTEXT_MODE` | `off` | corpus inventory 完整且文档数/字符数处于有界读取限制 |
| Milvus 原生 hybrid/BM25 | `MILVUS_HYBRID_MODE` | `off` | 独立 hybrid collection schema、embedding 维度和 provider capability 检查通过 |
| 检索拒答 | `RAG_ABSTENTION_MODE` | `shadow` | 先校准 dense lane 分数阈值；仅 `active` 会改变回答 |
| Contextual Retrieval v2 | `CONTEXTUAL_RETRIEVAL_V2_MODE` | `off` | 已验证显式 `CONTEXTUAL_RETRIEVAL_V2_MODEL`，或确认当前默认 LLM 适合作为 contextualizer |
| MiroFish graph | `RAG_MIROFISH_GRAPH_MODE` | `off` | graph artifact 已按 tenant/corpus/trust scope 写入并激活 |
| PDF visual | `RAG_PDF_VISUAL_MODE` | `off` | vision model、PDF page asset manifest 和本地持久卷可用 |
| Durable Ask | `RAG_DURABLE_ASK_MODE` | `off` | integrity secret、本地持久卷、单实例拓扑和容量/保留策略已配置 |

`RAG_DENSE_ABSTAIN_THRESHOLD` 是可选的 `0..1` dense 分数阈值覆盖；未设置时沿用
经过请求校验的 `similarityThreshold`（默认 `0`）。`shadow` 只记录拒答决策，
`active` 才会过滤不合格 evidence 并可能直接返回拒答，因此必须先完成 corpus-native 校准。

`RAG_CORPUS_VERSION` 默认为 `live-corpus-v1`，同时参与 hybrid collection manifest 与
响应缓存身份；语料重建/切换时应显式递增。`RAG_MILVUS_INDEX_VERSION` 可覆盖根据
collection/index/dimension 自动推导的缓存身份，只有实际索引代际变化时才应修改。

`MILVUS_HYBRID_ENABLED` 只保留环境兼容：仅当 `MILVUS_HYBRID_MODE` 未设置时，
值 `true` 才映射为 `shadow`，永远不会隐式进入 `active`。新部署必须显式使用
`MILVUS_HYBRID_MODE`；容器样例设置为 `off`，因此 legacy 变量不会产生额外 probe、
search 或 dual-write。

`CONTEXTUAL_RETRIEVAL_ENABLED` 也只保留环境兼容：仅当
`CONTEXTUAL_RETRIEVAL_V2_MODE` 未设置、且值为小写字面量 `true` 时才映射为
`shadow`，永远不会隐式进入 `active`。Contextual shadow 虽不替换索引正文，仍会在
ingestion 调用 contextualizer 并产生延迟/费用；新部署必须显式设置 V2 mode（安全
默认 `off`），不要同时设置 legacy 变量。

E3/E4 provider deadline 使用以下安全默认：

| 变量 | 默认值 | 覆盖范围 |
|------|--------|----------|
| `RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS` | `5000` | ordered corpus 的 connect、初始化、schema 检查和有界读取 |
| `RAG_HYBRID_PROBE_TIMEOUT_MS` | `2000` | hybrid collection capability probe |
| `RAG_HYBRID_SEARCH_TIMEOUT_MS` | `5000` | 可选 hybrid 检索 lane |

三项都只接受 `1..10000` 毫秒的安全整数，并且必须小于 `/api/ask` 的
`30000` 毫秒检索总预算。Hybrid lane 还会在总预算内为必需的 dense fallback 保留至少
`15000` 毫秒。同一进程内，provider 超时或同一 collection/provider key 上已有未结束的
超时任务时，`shadow/active` 都拒绝重复进入该 provider，并继续 dense fallback；实际
provider promise 结束后才重新开放。该 admission fence 不跨实例；多副本仍需共享控制面
才能形成部署级上限。请求方取消仍按取消处理，scope/integrity 不变量失败仍 fail closed。

容器安全基线：

```bash
RAG_ORDERED_CONTEXT_MODE=off
RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS=5000
RAG_ABSTENTION_MODE=shadow
# 可选；省略时使用请求 similarityThreshold（默认 0）
# RAG_DENSE_ABSTAIN_THRESHOLD=0
RAG_CORPUS_VERSION=live-corpus-v1
# 可选；省略时从 Milvus collection/index/dimension 推导
# RAG_MILVUS_INDEX_VERSION=milvus-index-release-id

MILVUS_HYBRID_MODE=off
RAG_HYBRID_PROBE_TIMEOUT_MS=2000
# Legacy only; only used when MILVUS_HYBRID_MODE is omitted, true => shadow
# MILVUS_HYBRID_ENABLED=false
RAG_HYBRID_SEARCH_TIMEOUT_MS=5000
MILVUS_HYBRID_FUSION=rrf
# MILVUS_HYBRID_COLLECTION_NAME=rag_documents_hybrid_v1

CONTEXTUAL_RETRIEVAL_V2_MODE=off
# Legacy only: missing V2 mode + lowercase true maps to shadow and still invokes an LLM.
# Prefer CONTEXTUAL_RETRIEVAL_V2_MODE for all new deployments.
# CONTEXTUAL_RETRIEVAL_ENABLED=false
# CONTEXTUAL_RETRIEVAL_V2_MODEL=replace-with-a-tested-contextualizer-model

RAG_MIROFISH_GRAPH_MODE=off
RAG_MIROFISH_GRAPH_STORE_ROOT=/app/uploads/mirofish-graph-artifacts-v2
RAG_MIROFISH_GRAPH_INGEST_TRUST_LEVEL=external
# RAG_MIROFISH_GRAPH_ARTIFACT_TTL_MS=2592000000
RAG_MIROFISH_GRAPH_MAX_ARTIFACTS=1000
RAG_MIROFISH_GRAPH_MAX_TOTAL_BYTES=2147483648
RAG_MIROFISH_GRAPH_MAX_SCOPE_ARTIFACTS=200
RAG_MIROFISH_GRAPH_MAX_SCOPE_BYTES=536870912
RAG_MIROFISH_GRAPH_MAX_TOMBSTONES=10000
RAG_MIROFISH_GRAPH_STAGING_TTL_MS=900000
RAG_MIROFISH_GRAPH_MULTI_INSTANCE=false
RAG_MIROFISH_GRAPH_REQUIRE_SHARED_CONTROL_PLANE=false

RAG_PDF_VISUAL_MODE=off
RAG_PDF_VISUAL_STORE_ROOT=/app/uploads/pdf-visual-assets-v1
# RAG_PDF_VISUAL_MODEL=replace-with-a-tested-vision-model
RAG_PDF_VISUAL_RENDER_WIDTH=1280
RAG_PDF_VISUAL_MAX_RENDER_PAGES=20
RAG_PDF_VISUAL_MAX_ROOT_ASSETS=10000
RAG_PDF_VISUAL_MAX_ROOT_BYTES=34359738368
RAG_PDF_VISUAL_MAX_SCOPE_ASSETS=2000
RAG_PDF_VISUAL_MAX_SCOPE_BYTES=8589934592
RAG_PDF_VISUAL_RETENTION_MS=2592000000
RAG_PDF_VISUAL_ORPHAN_RETENTION_MS=3600000
RAG_PDF_VISUAL_GC_MAX_ENTRIES=64
RAG_PDF_VISUAL_GC_MAX_BYTES=67108864
RAG_PDF_VISUAL_GC_MAX_DURATION_MS=50
RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES=2048
RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES=16
RAG_PDF_VISUAL_LEDGER_MAX_BYTES=1048576
RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS=4096
RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS=64
RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES=4096
RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS=4
RAG_PDF_VISUAL_MAX_CONCURRENT_RENDERS=4
RAG_PDF_VISUAL_MAX_IN_FLIGHT_SOURCE_BYTES=268435456
RAG_PDF_VISUAL_MULTI_INSTANCE=false
RAG_PDF_VISUAL_REQUIRE_SHARED_CONTROL_PLANE=false

RAG_DURABLE_ASK_MODE=off
RAG_DURABLE_WORKFLOW_STORE_ROOT=/app/uploads/rag-durable-workflows-v1
# RAG_DURABLE_WORKFLOW_INTEGRITY_KEY=inject-through-runtime-secret-manager
RAG_DURABLE_WORKFLOW_CONTROL_PLANE=file
RAG_DURABLE_WORKFLOW_LEASE_MS=30000
RAG_DURABLE_WORKFLOW_MAX_THREADS=1000
RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS=4096
RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS=32
RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_BYTES=1048576
RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_ROOT_BYTES=68719476736
RAG_DURABLE_WORKFLOW_MAX_TOMBSTONES=1000
RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS=604800000
RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS=3600000
RAG_DURABLE_WORKFLOW_TEMP_TTL_MS=3600000
RAG_DURABLE_WORKFLOW_RESULT_MAX_BYTES=4194304
RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS=2000
RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES=17179869184
RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_ARTIFACTS=200
RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_BYTES=536870912
RAG_DURABLE_WORKFLOW_RESULT_ORPHAN_TTL_MS=3600000
RAG_DURABLE_WORKFLOW_RESULT_TEMP_TTL_MS=3600000
RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_ENTRIES=64
RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES=67108864
RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_DURATION_MS=50
RAG_DURABLE_WORKFLOW_RESULT_REBUILD_MAX_DURATION_MS=5000
RAG_DURABLE_WORKFLOW_MULTI_INSTANCE=false
RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE=false
```

### Rollout 与回滚顺序

1. 保持全部 `off`，先记录当前 dense/text 的质量、延迟、空结果率和错误率。
2. 每次只把一个支持 shadow 的能力切到 `shadow`。Shadow 不得参与生成；只有实现候选
   执行的能力才会产生对比数据。Milvus hybrid、ordered context、PDF visual 等仍以
   dense/text 为权威路径。
3. 在隔离 tenant/corpus 或专用 canary 实例把单项能力切到 `active`，验证 scope、
   trust、provider capability、预算、超时和回退指标后再扩大流量。
4. 任一查询期能力异常时立即切回 `off` 并重启实例，使请求恢复 dense/text。
   不要同时修改 collection、embedding model 和路由开关，否则无法归因。

Contextual Retrieval v2 是 ingestion-time 变更：`shadow` 会执行候选 contextual
dense text 并保存 identity/status 等诊断元数据，但不会持久化候选正文，也不替换当前
索引文本；`active` 会让 contextualized text 参与 dense index。
因此把开关从 `active` 改回 `off` 只影响后续 ingestion。若要完整回滚已有语料，
必须从保留的 raw content 重新 ingestion，并重建/切换回非 contextual 的 dense
collection。Milvus hybrid 使用独立 collection（未显式设置时默认为
`${MILVUS_DEFAULT_COLLECTION}_hybrid_v1`）；将 hybrid 模式设为 `off` 会恢复源 dense
collection 路由，但不会自动删除 hybrid 数据。
Ordered context 的 scope/inventory 不变量失败仍 fail closed；Milvus connect、collection
初始化或 ordered query 的一般 provider 故障会记录 `provider_unavailable` snapshot，
在 `shadow` 和 `active` 都回到 dense，不把可用的主链升级为 500。

Hybrid `shadow` 写失败只记录诊断，dense ingest 仍为权威。Hybrid `active` 写失败会按
同一 server-derived tenant/corpus/trust scope 和精确 chunk IDs 补偿删除 hybrid 与
dense 两侧；全部补偿成功返回稳定 502 rolled-back 错误。任一补偿失败返回稳定 503
`MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED`，携带确定性 reconciliation ID、
scope、集合与 chunk 数但不反射 provider cause；运营方必须完成精确 reconciliation 后重试。


PDF asset store 同时执行 root/scope 数量与字节配额、30 天 retention、1 小时 orphan
retention，以及每次最多 64 项的惰性 GC。root ledger 保存总量、有界 active
reservation 和有界 scope lifecycle registry（`creating/active/reclaiming`），独立 scope ledger
按 scope digest 分片；ledger 包含 schema、generation 和 digest，正常 put 不会为计算
配额全盘枚举已有 bundle。新 scope 先以持久 `creating` reservation 占用 registry slot，
scope ledger 激活成功后才转为 `active`；创建中断会在恢复时回滚 reservation。
零容量 scope 进入持久 `reclaiming` fence 后依次移除 marker 和 ledger，再释放 registry
slot；进程在任一边界崩溃时，重启后的控制面对账会继续完成。

发布先写分片 reservation journal，root capacity lock 只覆盖 reserve/commit/release，
bundle 页面与 manifest 写入由 exact identity lock 隔离，因此无关 immutable
`getManifest`/`readPage` 不会被慢 put 串行阻塞。已提交容量包含页面和序列化 manifest；
在途容量还加入每次 publication 的临时 reservation overhead。

GC 的完整 batch 使用独立进程锁串行化，持久 cursor 不会被并发旧 batch 回退。扫描阶段
覆盖 bundle、reservation、staging、scope 控制记录以及 root/recovery/scope 原子写 temp；
temp 清理只读取文件元数据而不读取正文，因此 GC byte budget 仍只统计 manifest 读取。
entries 与 duration 都在目录项之间协作式检查；duration 不是正在执行的单次文件系统
操作的硬超时。单 shard 条目或 invalid debris 超额仍 fail fast。

final identity 目录存在但 manifest 缺失时，put/delete 都会保留现场、设置 recovery
fence 并拒绝 mutation，避免静默清理后重复计入容量。当前 root/recovery ledger schema
分别为 v2/v3；旧版本、缺失或 digest 损坏都不会静默归零，而要用持久 cursor 按限定
shard 数执行显式恢复。store lifecycle port 仍提供 exact-scope delete，但没有新增外部
文档删除 API，既有授权删除工作流需要显式调用该 port。

| 变量 | 默认值 | 单位/含义 | 硬上限 |
|------|--------|-----------|--------|
| `RAG_PDF_VISUAL_GC_MAX_BYTES` | `67108864` | 单批 manifest 检查读取字节（64 MiB）；必须 >= effective `maxManifestBytes`（当前 1 MiB），否则 fail closed | `1073741824`（1 GiB） |
| `RAG_PDF_VISUAL_GC_MAX_DURATION_MS` | `50` | 单批 GC 协作式 wall-clock 预算；在目录项之间检查，不中断正在执行的单次文件系统操作 | `5000` |
| `RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES` | `2048` | 单 shard 可物化目录项数 | `100000` |
| `RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES` | `16` | 单批允许的 invalid/debris 项数 | `1024` |
| `RAG_PDF_VISUAL_LEDGER_MAX_BYTES` | `1048576` | 单个 ledger/journal 控制记录字节（1 MiB） | `16777216`（16 MiB） |
| `RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS` | `4096` | root lifecycle registry 中可保留的 scope ledger 数；零容量 scope 会事务式回收 | `100000` |
| `RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS` | `64` | 同一 root 的 active publication 数 | `1024` |
| `RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES` | `4096` | 每个在途 publication 预留的临时开销字节 | `1048576`（1 MiB） |
| `RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS` | `4` | 每次显式恢复最多扫描的 identity shard 数 | `256` |

Renderer 默认最多 4 个并发任务和 256 MiB 在途源文件，超时或取消后的原生任务真正
settle 前仍占用 admission。上述默认值都有代码硬上限，不能用环境变量绕过；配置解析
会 fail closed。容器样例继续保持 `RAG_PDF_VISUAL_MODE=off`，model 也只是待验证占位符；
这些本地控制面能力不表示任何外部 vision provider 已完成生产切流。

Graph file store 默认限制 root 1000 个 artifact/2 GiB、单 scope 200 个/512 MiB；
持久 reservation 会在 artifact/descriptor 发布前占用数量和字节容量，失败、TTL GC 或
exact delete 会释放。root artifact 数硬上限为 10000、总字节硬上限为 128 GiB，
scope 数不得超过 root 或 1000，scope 字节不得超过 root；越界配置和超额发布都 fail
closed。查询只返回 `trusted/reviewed/external`，`quarantined` 与不存在资源统一为
404；具有删除权限的管理调用仍可按 exact identity 删除隔离资源。

Active pointer 最多扫描 32 个 revision，常态压缩保留 8 个。Tombstone 默认/硬上限为
10000/100000，且不能小于 artifact 上限；catalog 满时新 put/delete 返回稳定 capacity，
绝不淘汰仍有效的 exact-identity 删除 fence。Staging reservation 默认 15 分钟，允许范围
1 分钟到 24 小时；惰性 reconcile 只回收过期、无 descriptor 且无本进程 active writer
的残留。Commit 后的 temp/compaction 维护失败不会把已提交成功翻成失败。
MiroFish 和 PDF visual 的当前 file provider 都是 process-coordinated。它们可以依赖
`/app/uploads` 持久卷跨进程重启保存文件，但不提供多实例共享事务或跨实例 failover。
只要把对应 `*_MULTI_INSTANCE` 或 `*_REQUIRE_SHARED_CONTROL_PLANE` 设为 `true`，
本地 provider 就会 fail closed；接入真正的 shared provider 之前不要绕过该检查。

### Durable Ask 请求与持久化边界

Durable Ask 没有 shadow 模式。推荐先保持全局 `off`，在专用单实例 canary 中设为
`active`；同步请求仍是默认路径。只有显式携带 durable 执行模式、且服务端身份具有
`manage-runtime` capability 的请求才进入该工作流，普通 query 身份不能创建 durable job：

```http
POST /api/ask
Authorization: Bearer <admin-token>
Idempotency-Key: tenant-job-0001
Content-Type: application/json

{"question":"...","executionMode":"durable", "...":"其他既有 ask 字段"}
```

`Idempotency-Key` 必须为 8-128 个字符，以字母或数字开头，后续只允许字母、数字、
`.`、`_`、`:`、`-`。同一 scope 和请求投影重复使用该 key 才能安全 replay；
同 key 不同请求会发生冲突。启用时必须通过 secret manager 注入 32-4096 字符的
`RAG_DURABLE_WORKFLOW_INTEGRITY_KEY`，不得写入镜像、日志或仓库。lease 样例和默认值为
30000 ms；生产配置至少保持 300 ms，并应覆盖 provider 的正常调度抖动。

Durable replay 只持久化紧凑 allowlist：答案、模型标识、执行摘要，以及不含正文和任意
metadata 的安全 citation 标量。raw query、完整 request/context、evidence content、
provider 原始响应和 credential 字段不进入 result artifact。Checkpoint 只保存请求、
query 和路由投影的 HMAC digest，不保存明文问题。

当前 durable checkpoint/result provider 也是 process-coordinated file provider：
`RAG_DURABLE_WORKFLOW_CONTROL_PLANE=file` 只能用于单实例，并依赖
`/app/uploads/rag-durable-workflows-v1` 持久卷。设置
`RAG_DURABLE_WORKFLOW_MULTI_INSTANCE=true`、
`RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE=true` 或请求
`RAG_DURABLE_WORKFLOW_CONTROL_PLANE=shared` 时，本地 provider 会返回 503，而不是宣称
共享 failover。在线 checkpoint 默认只保留 latest pointer 指向的最近 32 个 revision；
`RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS=4096` 是 legacy/recovery 有界扫描和配置
上限，不代表常态保留 4096 个文件。每个 thread 按 checkpoint 大小和保留窗口预留最坏
字节数，tombstone 也固定预留容量，root 默认上限 64 GiB；配置不足以容纳 tombstone
上限加一个 thread reservation 时启动即 fail closed。Result artifact 另受单份大小和总数
上限保护。Checkpoint 的 orphan reservation 与临时文件默认都保留 1 小时，分别由
`RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS` 和
`RAG_DURABLE_WORKFLOW_TEMP_TTL_MS` 控制，硬上限均为 30 天。

Result root 默认最多 2000 份/16 GiB，单 scope 默认最多 200 份/512 MiB；orphan
reservation 与 result 临时文件默认都保留 1 小时。GC 默认每批 64 项、64 MiB、50 ms，
显式 ledger rebuild
默认最多 5000 ms；对应 `RESULT_MAX_ROOT_BYTES`、`RESULT_MAX_SCOPE_ARTIFACTS`、
`RESULT_MAX_SCOPE_BYTES`、`RESULT_ORPHAN_TTL_MS`、`RESULT_TEMP_TTL_MS`、
`RESULT_GC_MAX_ENTRIES`、
`RESULT_GC_MAX_BYTES`、`RESULT_GC_MAX_DURATION_MS` 和
`RESULT_REBUILD_MAX_DURATION_MS` 均使用上方完整变量前缀。硬上限依次为 128 GiB、
5000、64 GiB、30 天、30 天、1024、1 GiB、10000 ms 和 30000 ms，scope 配额不能
超过 root。
`RESULT_GC_MAX_BYTES` 还必须至少等于 `RESULT_MAX_BYTES + 65536`，确保任一合法 artifact
或 reservation 都能推进持久 GC cursor，不会被首个大文件永久卡住。

Result 原子写临时文件只允许位于同一持久卷的
`ask-results/ledgers/tmp`，文件名严格为
`<target-sha256>.<13-digit-epoch-ms>.<uuid>.tmp`。首次写操作和显式 GC/rebuild 会按
`RESULT_TEMP_TTL_MS` 回收过期文件，且复用 GC 的 entry/byte/time 批次边界；普通 mutation
在触及批次边界或仍有未过 TTL 文件时会继续后续批次，因此不依赖人工 GC 才能推进。未过
TTL 的活跃 writer 文件不会被删除。临时目录硬限制为 2048 项，非法名称、非普通文件、单文件
超限或目录超限都会 fail closed。这样 hard crash 不会在 artifact/reservation 目录留下
永久占位文件。

Scope capacity 归零时，scope ledger 与 marker 会在 root pending mutation 内先后删除，
最后才清除 root pending。任一步骤崩溃后，下一次 mutation/reconcile 会继续精确完成；
rebuild 也会丢弃历史零值 scope control，从而让多 scope churn 保持有界。

Workflow/result 本身不会按 TTL 自动清理；终态 workflow 必须由具备
`manage-runtime` 权限的管理员按当前 generation 与 revision 执行明确的 `delete` action：

```http
PATCH /api/ask?corpusId=<corpus-id>
Authorization: Bearer <admin-token>
Content-Type: application/json

{"action":"delete","threadId":"rag-ask-<id>","expectedGenerationId":"<generation-id>","expectedRevision":12}
```

所有 durable PATCH 管理 action 都要求 `expectedGenerationId` 与 `expectedRevision`；
POST、GET 与 PATCH 响应还通过 `x-rag-durable-generation-id` 返回当前 generation fence。
Delete 只接受 `completed`、`failed` 或 `cancelled` checkpoint。协议先按 generation +
revision 发布 exact-generation checkpoint tombstone 并清空该 generation 的 revision/thread
reservation，再清理它的所有 attempt result artifact 和 orphan reservation。若后半段失败，
相同 generation + revision 的重试会验证 tombstone 后继续；即使同一 thread 已启动新的
generation B，只要旧 generation A 的 exact tombstone + revision 仍在，A 的重试也只会
清理 A 的 result 并确认 A tombstone，不会读取、删除或确认 B。只有 result cleanup 成功后才
持久确认 cleanup。成功返回独立 `status=deleted` receipt 及 `generationId`、
`checkpointDeleted`、`cleanupResumed`、`resultDeletedCount`、
`cleanupAcknowledged=true`，不会返回看似仍存活的 durable body。

File checkpoint tombstone 默认最多 1000 个、保留 7 天；环境变量硬上限分别为
10000 个和 365 天。保留期内 tombstone 是 thread-key 的 generation barrier；过期后可由
新的随机 generation 接管同一 thread key，但旧 generation 的 replay 仍冲突。惰性 GC
只删除已过保留期、已 `cleanupAcknowledged` 且该 generation 的 latest/revision catalog
已物理清空的 tombstone；未确认 cleanup 的 tombstone 不因过期而回收。

Generation-aware checkpoint 使用 `rag-durable-checkpoint-v3`，result reservation 使用
`rag-durable-ask-result-reservation-v3`。缺少 generation 的旧 checkpoint/result envelope
不会被静默迁移或归入新 generation，而是 fail closed，需通过受控恢复流程处理。不要通过
直接删除 volume 文件绕过 CAS、scope、配额、保留期和完整性校验。

以上是代码路径和本地 file provider 的部署契约，不代表已经在真实 Milvus/Zilliz、
外部 contextualizer/vision model、共享控制面或生产流量上完成切流验证。

## LLM 提供商配置

### 主开关

`MODEL_PROVIDER` 环境变量控制 LLM 模型提供商：

| 值 | 说明 |
|---|---|
| `ollama` | 使用本地 Ollama 服务 (默认) |
| `openai` | 使用 OpenAI API |
| `azure` | 使用 Azure OpenAI 服务 |
| `custom` | 使用自定义 OpenAI 兼容 API (如 DeepSeek, 智谱等) |

### Ollama 配置 (本地模式)

当 `MODEL_PROVIDER=ollama` 时使用：

```bash
# Ollama 服务地址
OLLAMA_BASE_URL=http://localhost:11434

# LLM 模型 (对话/生成)
# 推荐: llama3.1, qwen2.5, glm-4
OLLAMA_LLM_MODEL=llama3.1

# 推理模型 (复杂推理任务)
# 推荐: deepseek-r1, qwen3
OLLAMA_REASONING_MODEL=deepseek-r1
```

### OpenAI 配置

当 `MODEL_PROVIDER=openai` 时使用：

```bash
# API Key (必填)
OPENAI_API_KEY=sk-xxxxx

# API 基础地址 (可选，用于代理)
OPENAI_BASE_URL=https://api.openai.com/v1

# LLM 模型
OPENAI_LLM_MODEL=gpt-4o-mini

# 推理模型
OPENAI_REASONING_MODEL=gpt-4o
```

### Azure OpenAI 配置

当 `MODEL_PROVIDER=azure` 时使用：

```bash
# API Key (必填)
AZURE_OPENAI_API_KEY=xxxxx

# 终端地址 (必填)
AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com

# 部署名称
AZURE_OPENAI_LLM_DEPLOYMENT=gpt-4o-mini
```

### 自定义 API 配置

当 `MODEL_PROVIDER=custom` 时使用，支持 OpenAI 兼容的第三方 API：

```bash
# API Key (必填)
CUSTOM_API_KEY=sk-xxxxx

# API 基础地址 (必填)
# DeepSeek: https://api.deepseek.com
# 智谱: https://open.bigmodel.cn/api/paas/v4
# 月之暗面: https://api.moonshot.cn/v1
CUSTOM_BASE_URL=https://api.deepseek.com

# 模型名称
CUSTOM_LLM_MODEL=deepseek-chat
```

---

## 推理模型提供商配置（独立）

### 主开关

`REASONING_PROVIDER` 环境变量**独立控制**推理模型提供商：

| 值 | 说明 |
|---|---|
| `ollama` | 使用本地 Ollama 推理模型（默认跟随 `MODEL_PROVIDER`） |
| `openai` | 使用 OpenAI 推理模型 |
| `custom` | 使用自定义 OpenAI 兼容 API (如 DeepSeek) |

> **注意**: 如果未设置 `REASONING_PROVIDER`，将自动跟随 `MODEL_PROVIDER` 的设置。

### Ollama 推理模型配置

当 `REASONING_PROVIDER=ollama` 时使用：

```bash
# Ollama 服务地址（共用）
OLLAMA_BASE_URL=http://localhost:11434

# 推理模型名称
# 推荐: deepseek-r1, qwen3
OLLAMA_REASONING_MODEL=deepseek-r1
```

### OpenAI 推理模型配置

当 `REASONING_PROVIDER=openai` 时使用：

```bash
# API Key（共用 OpenAI 配置）
OPENAI_API_KEY=sk-xxxxx

# API 基础地址（可选）
OPENAI_BASE_URL=

# 推理模型
OPENAI_REASONING_MODEL=gpt-4o
```

### 自定义推理模型 API 配置

当 `REASONING_PROVIDER=custom` 时使用：

```bash
# API Key (可独立配置，默认复用 CUSTOM_API_KEY)
CUSTOM_REASONING_API_KEY=sk-xxxxx

# API 基础地址 (可独立配置，默认复用 CUSTOM_BASE_URL)
# DeepSeek Reasoner: https://api.deepseek.com
CUSTOM_REASONING_BASE_URL=https://api.deepseek.com

# 模型名称
# DeepSeek: deepseek-reasoner
CUSTOM_REASONING_MODEL=deepseek-reasoner
```

### 配置说明

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `REASONING_PROVIDER` | 跟随 `MODEL_PROVIDER` | 推理模型提供商 |
| `OLLAMA_REASONING_MODEL` | `deepseek-r1` | Ollama 推理模型 |
| `OPENAI_REASONING_MODEL` | `gpt-4o` | OpenAI 推理模型 |
| `CUSTOM_REASONING_API_KEY` | 复用 `CUSTOM_API_KEY` | 自定义推理 API Key |
| `CUSTOM_REASONING_BASE_URL` | 复用 `CUSTOM_BASE_URL` | 自定义推理 API 地址 |
| `CUSTOM_REASONING_MODEL` | `deepseek-reasoner` | 自定义推理模型名称 |

---

## Embedding 提供商配置 (独立)

### 主开关

`EMBEDDING_PROVIDER` 环境变量**独立控制** Embedding 模型提供商：

| 值 | 说明 |
|---|---|
| `ollama` | 使用本地 Ollama Embedding 模型 |
| `siliconflow` | 使用硅基流动 (SiliconFlow) 云服务 ⭐ **推荐** |
| `openai` | 使用 OpenAI Embedding API |
| `custom` | 使用自定义 OpenAI 兼容 API |

### SiliconFlow 配置 (推荐) ⭐

[SiliconFlow (硅基流动)](https://cloud.siliconflow.cn) 提供高性价比的 Embedding 服务，新用户注册送 2000 万 Tokens。

当 `EMBEDDING_PROVIDER=siliconflow` 时使用：

```bash
# SiliconFlow API Key (必填)
# 获取地址: https://cloud.siliconflow.cn/account/ak
SILICONFLOW_API_KEY=sk-xxxxx

# API 基础地址 (可选，使用默认即可)
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1

# Embedding 模型选择
# 推荐: BAAI/bge-m3 (1024维, 8192 tokens)
# 更多模型: https://cloud.siliconflow.cn/me/models?types=embedding
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3
```

**SiliconFlow 支持的 Embedding 模型：**

| 模型 | 维度 | 最大 Tokens | 说明 |
|------|------|-------------|------|
| `BAAI/bge-large-zh-v1.5` | 1024 | 512 | 中文优化 |
| `BAAI/bge-large-en-v1.5` | 1024 | 512 | 英文优化 |
| `BAAI/bge-m3` | 1024 | 8192 | 多语言，长文本 ⭐ |
| `Pro/BAAI/bge-m3` | 1024 | 8192 | Pro 版本 |
| `Qwen/Qwen3-Embedding-8B` | 4096 | 32768 | 最强精度 |
| `Qwen/Qwen3-Embedding-4B` | 2560 | 32768 | 平衡选择 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | 32768 | 轻量快速 |
| `netease-youdao/bce-embedding-base_v1` | 768 | 512 | 网易有道 |

### Ollama Embedding 配置

当 `EMBEDDING_PROVIDER=ollama` 时使用：

```bash
# Ollama 服务地址
OLLAMA_BASE_URL=http://localhost:11434

# Embedding 模型
# 推荐: nomic-embed-text (768维), bge-m3 (1024维)
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

**Ollama 支持的 Embedding 模型：**

| 模型 | 维度 | 说明 |
|------|------|------|
| `nomic-embed-text` | 768 | 默认推荐 |
| `bge-m3` | 1024 | 多语言 |
| `bge-large` | 1024 | BGE 系列 |
| `all-minilm` | 384 | 轻量 |
| `mxbai-embed-large` | 1024 | 高质量 |
| `qwen3-embedding` | 1024 | Qwen3 系列 |

### OpenAI Embedding 配置

当 `EMBEDDING_PROVIDER=openai` 时使用：

```bash
# API Key (必填)
OPENAI_API_KEY=sk-xxxxx

# API 基础地址 (可选)
OPENAI_BASE_URL=

# Embedding 模型
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

### 自定义 Embedding API 配置

当 `EMBEDDING_PROVIDER=custom` 时使用：

```bash
# API Key (必填)
CUSTOM_EMBEDDING_API_KEY=sk-xxxxx

# API 基础地址 (必填)
CUSTOM_EMBEDDING_BASE_URL=https://api.example.com/v1

# 模型名称
CUSTOM_EMBEDDING_MODEL=custom-embedding

# 向量维度 (必填 - 自定义模型需要显式指定)
# 因为系统无法自动识别自定义模型的维度
CUSTOM_EMBEDDING_DIMENSION=1024
```

> ⚠️ **重要**: 使用自定义 Embedding API 时，**必须**设置 `CUSTOM_EMBEDDING_DIMENSION`，否则系统将使用默认值 768，可能导致维度不匹配错误。

---

## Milvus 配置

Milvus 向量数据库支持两种部署模式：

### 主开关

```bash
# Milvus 提供商选择
MILVUS_PROVIDER=local  # 可选: local | zilliz
```

| 值 | 说明 |
|---|---|
| `local` | 使用本地自建 Milvus 服务 (默认) |
| `zilliz` | 使用 Zilliz Cloud 托管服务 |

### 本地 Milvus 配置 (local)

当 `MILVUS_PROVIDER=local` 时使用：

```bash
# Milvus 服务地址
MILVUS_LOCAL_ADDRESS=localhost:19530

# 认证（可选）
MILVUS_LOCAL_USERNAME=
MILVUS_LOCAL_PASSWORD=
```

### Zilliz Cloud 配置 (zilliz)

当 `MILVUS_PROVIDER=zilliz` 时使用：

```bash
# Zilliz Cloud 集群端点 (必填)
# ⚠️ 注意：不需要 https:// 前缀，SDK 会自动处理
# 格式: in01-xxx.api.region.zillizcloud.com:443
# 从 Zilliz Cloud 控制台 -> 集群 -> Connect -> Node.js 获取
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443

# API Token (必填)
# 从 Zilliz Cloud 控制台 -> API Keys 获取
MILVUS_ZILLIZ_TOKEN=your_api_key_here

# 是否为 Serverless 实例
MILVUS_ZILLIZ_SERVERLESS=false
```

### 通用默认配置

```bash
# 默认数据库
MILVUS_DEFAULT_DATABASE=default

# 默认集合名称
MILVUS_DEFAULT_COLLECTION=rag_documents

# 默认向量维度
MILVUS_DEFAULT_DIMENSION=1024

# 默认索引类型
MILVUS_DEFAULT_INDEX_TYPE=IVF_FLAT

# 默认距离度量
MILVUS_DEFAULT_METRIC_TYPE=COSINE
```

---

## Reasoning RAG 配置（独立）

Reasoning RAG 使用独立的配置，与主应用的 Milvus 配置分离。这样可以：
- 使用不同的集合存储推理文档
- 配置不同的向量维度
- 独立调整检索和推理参数

### 主要配置

```bash
# Reasoning RAG 专用集合名称（独立于主应用）
REASONING_RAG_COLLECTION=reasoning_rag_documents

# Reasoning RAG 专用向量维度（独立于主应用）
# 不设置时自动从 EMBEDDING_PROVIDER 对应的模型维度获取
REASONING_RAG_DIMENSION=1024

# 文件上传目录
REASONING_RAG_UPLOAD_DIR=reasoning-uploads
```

### 向量化配置

```bash
# 文本块大小（字符数）
# 注意：会根据 Embedding 模型的 maxTokens 自动调整
REASONING_RAG_CHUNK_SIZE=500

# 文本块重叠大小
REASONING_RAG_CHUNK_OVERLAP=50
```

### 检索配置

```bash
# 初始检索数量
REASONING_RAG_TOP_K=50

# 重排后保留数量
REASONING_RAG_RERANK_TOP_K=5

# 相似度阈值
REASONING_RAG_SIMILARITY_THRESHOLD=0.3

# 是否启用 BM25 混合检索
REASONING_RAG_ENABLE_BM25=true

# 是否启用重排序
REASONING_RAG_ENABLE_RERANK=true
```

### 推理配置

```bash
# 最大推理迭代次数
REASONING_RAG_MAX_ITERATIONS=3

# 生成温度
REASONING_RAG_TEMPERATURE=0.7
```

### 配置说明

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `REASONING_RAG_COLLECTION` | `reasoning_rag_documents` | 专用集合，与主应用分离 |
| `REASONING_RAG_DIMENSION` | 自动获取 | 跟随 Embedding 模型维度 |
| `REASONING_RAG_UPLOAD_DIR` | `reasoning-uploads` | 文件上传目录 |
| `REASONING_RAG_CHUNK_SIZE` | `500` | 会自动适配模型 maxTokens |
| `REASONING_RAG_CHUNK_OVERLAP` | `50` | 块重叠大小 |
| `REASONING_RAG_TOP_K` | `50` | 初始检索数量 |
| `REASONING_RAG_RERANK_TOP_K` | `5` | 重排后保留数量 |
| `REASONING_RAG_SIMILARITY_THRESHOLD` | `0.3` | 相似度阈值 |
| `REASONING_RAG_ENABLE_BM25` | `true` | 启用混合检索 |
| `REASONING_RAG_ENABLE_RERANK` | `true` | 启用重排序 |
| `REASONING_RAG_MAX_ITERATIONS` | `3` | 最大迭代次数 |
| `REASONING_RAG_TEMPERATURE` | `0.7` | 生成温度 |

---

## 完整配置示例

### 示例 1: 本地开发 (全本地)

```bash
# LLM 配置 - 使用本地 Ollama
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.1
OLLAMA_REASONING_MODEL=deepseek-r1

# Embedding 配置 - 使用本地 Ollama
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBEDDING_MODEL=nomic-embed-text

# Milvus 配置 - 本地
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
MILVUS_DEFAULT_DIMENSION=768
```

### 示例 2: 混合模式 (本地 LLM + 云端 Embedding) ⭐ 推荐

```bash
# LLM 配置 - 使用本地 Ollama (省钱)
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.1
OLLAMA_REASONING_MODEL=deepseek-r1

# Embedding 配置 - 使用 SiliconFlow (高质量)
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置 - Zilliz Cloud
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443
MILVUS_ZILLIZ_TOKEN=xxxxx
MILVUS_DEFAULT_DIMENSION=1024  # 匹配 bge-m3 维度

# Reasoning RAG 独立配置（可选）
REASONING_RAG_COLLECTION=reasoning_rag_documents
REASONING_RAG_DIMENSION=1024  # 跟随 Embedding 模型维度
```

### 示例 3: 生产环境 (全云端)

```bash
# LLM 配置 - 使用 OpenAI
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxx
OPENAI_LLM_MODEL=gpt-4o-mini
OPENAI_REASONING_MODEL=gpt-4o

# Embedding 配置 - 使用 SiliconFlow (省钱)
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置 - Zilliz Cloud
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.aws-us-west-2.vectordb.zillizcloud.com:443
MILVUS_ZILLIZ_TOKEN=xxxxx
MILVUS_DEFAULT_DIMENSION=1024
```

### 示例 4: 使用 DeepSeek API + SiliconFlow

```bash
# LLM 配置 - 使用 DeepSeek
MODEL_PROVIDER=custom
CUSTOM_API_KEY=sk-xxxxx
CUSTOM_BASE_URL=https://api.deepseek.com
CUSTOM_LLM_MODEL=deepseek-chat

# Embedding 配置 - 使用 SiliconFlow
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
MILVUS_DEFAULT_DIMENSION=1024
```

### 示例 5: 完整 Reasoning RAG 配置

```bash
# LLM 配置 - 使用 DeepSeek
MODEL_PROVIDER=custom
CUSTOM_API_KEY=sk-xxxxx
CUSTOM_BASE_URL=https://api.deepseek.com
CUSTOM_LLM_MODEL=deepseek-chat

# 推理模型配置 - 独立使用 DeepSeek Reasoner
REASONING_PROVIDER=custom
CUSTOM_REASONING_API_KEY=sk-xxxxx  # 可省略，默认复用 CUSTOM_API_KEY
CUSTOM_REASONING_BASE_URL=https://api.deepseek.com  # 可省略，默认复用 CUSTOM_BASE_URL
CUSTOM_REASONING_MODEL=deepseek-reasoner

# Embedding 配置 - 使用 SiliconFlow
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# 主应用 Milvus 配置
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443
MILVUS_ZILLIZ_TOKEN=xxxxx
MILVUS_DEFAULT_COLLECTION=rag_documents
MILVUS_DEFAULT_DIMENSION=1024

# Reasoning RAG 独立配置（与主应用分离）
REASONING_RAG_COLLECTION=reasoning_rag_documents
REASONING_RAG_DIMENSION=1024
REASONING_RAG_UPLOAD_DIR=reasoning-uploads
REASONING_RAG_CHUNK_SIZE=500
REASONING_RAG_CHUNK_OVERLAP=50
REASONING_RAG_TOP_K=50
REASONING_RAG_RERANK_TOP_K=5
REASONING_RAG_SIMILARITY_THRESHOLD=0.3
REASONING_RAG_ENABLE_BM25=true
REASONING_RAG_ENABLE_RERANK=true
REASONING_RAG_MAX_ITERATIONS=3
REASONING_RAG_TEMPERATURE=0.7
```

### 示例 6: LLM 和推理模型使用不同提供商

```bash
# LLM 配置 - 使用本地 Ollama（省钱）
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.1

# 推理模型配置 - 使用 DeepSeek Reasoner（强推理能力）
REASONING_PROVIDER=custom
CUSTOM_REASONING_API_KEY=sk-xxxxx
CUSTOM_REASONING_BASE_URL=https://api.deepseek.com
CUSTOM_REASONING_MODEL=deepseek-reasoner

# Embedding 配置 - 使用 SiliconFlow
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
MILVUS_DEFAULT_DIMENSION=1024
```

---

## API 使用

### 获取当前配置

```typescript
import { getConfigSummary } from '@/lib/model-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';

// 获取 LLM 配置摘要
const llmSummary = getConfigSummary();
console.log(llmSummary);
// {
//   provider: 'ollama',
//   llmModel: 'llama3.1',
//   embeddingProvider: 'siliconflow',
//   embeddingModel: 'BAAI/bge-m3',
//   ...
// }

// 获取 Embedding 配置摘要
const embeddingSummary = getEmbeddingConfigSummary();
console.log(embeddingSummary);
// {
//   provider: 'siliconflow',
//   model: 'BAAI/bge-m3',
//   dimension: 1024,
//   baseUrl: 'https://api.siliconflow.cn/v1',
//   hasApiKey: true
// }
```

### 创建模型实例

```typescript
import { createLLM, createReasoningModel } from '@/lib/model-config';
import { createEmbeddingModel, getEmbeddingDimension } from '@/lib/embedding-config';

// 创建 LLM (会根据 MODEL_PROVIDER 自动选择)
const llm = createLLM();

// 创建指定模型的 LLM
const llm2 = createLLM('gpt-4o');

// 创建 Embedding 模型 (会根据 EMBEDDING_PROVIDER 自动选择)
const embedding = createEmbeddingModel();

// 获取当前 Embedding 模型维度
const dimension = getEmbeddingDimension();
console.log(`当前 Embedding 维度: ${dimension}`);

// 创建推理模型
const reasoning = createReasoningModel();
```

### 验证配置

```typescript
import { getModelFactory } from '@/lib/model-config';
import { validateEmbeddingConfig } from '@/lib/embedding-config';

// 验证 LLM 配置
const factory = getModelFactory();
const llmValidation = factory.validateConfig();

// 验证 Embedding 配置
const embeddingValidation = validateEmbeddingConfig();

if (!llmValidation.valid) {
  console.error('LLM 配置错误:', llmValidation.errors);
}

if (!embeddingValidation.valid) {
  console.error('Embedding 配置错误:', embeddingValidation.errors);
}
```

### 重新加载配置

```typescript
import { getModelFactory } from '@/lib/model-config';
import { reloadEmbeddingConfig } from '@/lib/embedding-config';

// 重新加载 LLM 配置
getModelFactory().reloadConfig();

// 重新加载 Embedding 配置
reloadEmbeddingConfig();
```

---

## 常见问题

### Q: 如何选择 Embedding 提供商？

| 场景 | 推荐方案 |
|------|----------|
| 本地开发，无需联网 | `ollama` + `nomic-embed-text` |
| 生产环境，追求性价比 | `siliconflow` + `BAAI/bge-m3` |
| 生产环境，追求最高质量 | `siliconflow` + `Qwen/Qwen3-Embedding-8B` |
| 已有 OpenAI 账号 | `openai` + `text-embedding-3-small` |

### Q: 切换 Embedding 提供商后需要重新生成向量吗？

是的。不同模型生成的向量维度和语义空间不同，切换后需要：
1. 更新 `MILVUS_DEFAULT_DIMENSION` 匹配新模型维度
2. 重新创建 Milvus 集合 (或删除旧集合)
3. 重新上传所有文档

### Q: SiliconFlow 如何获取 API Key？

1. 访问 https://cloud.siliconflow.cn
2. 注册账号 (新用户送 2000 万 Tokens)
3. 进入控制台 -> Account -> API Keys
4. 创建新的 API Key

### Q: Milvus 维度不匹配怎么办？

如果出现 `dimension mismatch` 错误：
1. 检查 `MILVUS_DEFAULT_DIMENSION` 是否与 Embedding 模型匹配
2. 删除现有集合：通过 API 调用 `/api/milvus?action=recreate`
3. 重新上传文档

### Q: Reasoning RAG 和主应用的数据是分开的吗？

是的。Reasoning RAG 使用独立的配置和集合：
- 主应用使用 `MILVUS_DEFAULT_COLLECTION`（默认 `rag_documents`）
- Reasoning RAG 使用 `REASONING_RAG_COLLECTION`（默认 `reasoning_rag_documents`）

两者的数据完全隔离，可以独立配置向量维度。

### Q: Reasoning RAG 向量化时报 "input length exceeds context length" 错误？

这是因为文本块超过了 Embedding 模型的上下文长度限制。系统会自动根据模型的 maxTokens 调整 chunkSize：

| 模型 | maxTokens | 安全 chunkSize |
|------|-----------|---------------|
| `BAAI/bge-large-zh-v1.5` | 512 | ~200 字符 |
| `nomic-embed-text` | 2048 | ~800 字符 |
| `BAAI/bge-m3` | 8192 | ~2000 字符 |

建议使用 `BAAI/bge-m3` 或 `Qwen3-Embedding` 系列，支持更长的文本。

### Q: 如何查看 Reasoning RAG 当前配置？

调用 API：
```bash
# 获取完整配置
curl http://localhost:3000/api/reasoning-rag?action=config

# 获取向量化状态和配置
curl http://localhost:3000/api/reasoning-rag/vectorize
```
