# 容器化部署指南

本指南用于后续云服务一键迁移：同一份镜像可在本地 Docker、私有云、云容器平台运行。镜像只包含应用代码和构建产物；LLM、Embedding、Milvus/Zilliz、Supabase、LangSmith 等服务通过运行时环境变量接入。

## 部署资产

| 文件 | 用途 |
|------|------|
| `Dockerfile` | Next.js 服务端生产镜像，使用 standalone 输出和非 root 用户 |
| `.dockerignore` | 排除依赖、构建产物、上传数据、密钥和缓存 |
| `docker-compose.yml` | 应用基础服务、端口、volume、healthcheck wiring |
| `docker-compose.local.yml` | 本地迁移演练：app + Milvus standalone 依赖栈 |
| `docker-compose.cloud.yml` | 云服务模式：app 连接 Zilliz/Supabase/云模型服务 |
| `.env.container.example` | 容器运行时变量样例，不含真实密钥 |

## 快速本地演练

1. 准备环境变量：

```powershell
Copy-Item .env.container.example .env.container
```

2. 如果使用默认 local 模式，先确保宿主机 Ollama 正在运行，并已准备模型：

```powershell
ollama pull llama3.1
ollama pull nomic-embed-text
```

3. 启动 app + Milvus：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml up --build
```

4. 验证进程级 liveness：

```powershell
Invoke-RestMethod http://localhost:3000/api/health/live
```

5. 验证应用 readiness / 外部依赖：

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

`/api/health/live` 只证明容器进程可服务，不访问 RAG、Milvus、LLM 或 Supabase。`/api/health` 才用于迁移验收和外部依赖诊断。

## 云服务迁移模式

1. 复制 `.env.container.example` 为 `.env.container`。
2. 注释 local 模式变量，启用 cloud 或 hybrid 段。
3. 填入运行时密钥，不提交 `.env.container`。
4. 本地模拟云模式：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.cloud.yml up --build
```

5. 云平台部署时使用同一镜像，将 `.env.container` 中的变量逐项配置到平台 secrets/env，不要把密钥 bake 到镜像。

## 关键环境变量

| 类别 | 变量 |
|------|------|
| LLM | `MODEL_PROVIDER`, `OPENAI_API_KEY`, `CUSTOM_API_KEY`, `CUSTOM_BASE_URL`, `OLLAMA_BASE_URL` |
| Embedding | `EMBEDDING_PROVIDER`, `SILICONFLOW_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `CUSTOM_EMBEDDING_DIMENSION` |
| Milvus/Zilliz | `MILVUS_PROVIDER`, `MILVUS_LOCAL_ADDRESS`, `MILVUS_ZILLIZ_ENDPOINT`, `MILVUS_ZILLIZ_TOKEN`, `MILVUS_DEFAULT_DIMENSION` |
| API 安全边界 | `RAG_ACCESS_MODE`, `RAG_SINGLE_TENANT_TOKEN`, `RAG_TENANT_ISOLATION_REQUIRED`, `RAG_ALLOWED_LLM_MODELS`, `RAG_ALLOWED_EMBEDDING_MODELS` |
| Supabase | `RAG_PERSISTENCE_BACKEND`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DEFAULT_TENANT_ID`, `SUPABASE_DEFAULT_CORPUS_ID` |
| LangSmith | `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` |
| Uploads | `REASONING_RAG_UPLOAD_DIR`, app volume `/app/uploads`, `/app/reasoning-uploads`, `/app/adaptive-rag-uploads` |
| RAG staged rollout | `RAG_ORDERED_CONTEXT_MODE`, `RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS`, `RAG_ABSTENTION_MODE`, `RAG_DENSE_ABSTAIN_THRESHOLD`, `RAG_CORPUS_VERSION`, `RAG_MILVUS_INDEX_VERSION`, `MILVUS_HYBRID_MODE`, `RAG_HYBRID_PROBE_TIMEOUT_MS`, `RAG_HYBRID_SEARCH_TIMEOUT_MS`, `CONTEXTUAL_RETRIEVAL_V2_MODE`, `RAG_MIROFISH_GRAPH_MODE`, `RAG_PDF_VISUAL_MODE` |
| Durable Ask | `RAG_DURABLE_ASK_MODE`, `RAG_DURABLE_WORKFLOW_STORE_ROOT`, `RAG_DURABLE_WORKFLOW_INTEGRITY_KEY`, capacity/lease/topology variables |
| Local artifact stores | app volume `/app/uploads` for graph, PDF visual and durable workflow subdirectories |

完整变量含义见 `ENV_CONFIG_GUIDE.md`。

## E3-E7 功能激活与回滚

容器样例将会改变检索/持久化主链的开关设置为 `off`；拒答保持观察态 `shadow`。
因此升级镜像本身不会改变既有 dense/text 检索或同步 `/api/ask` 的生成回答：

```text
RAG_ORDERED_CONTEXT_MODE=off
RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS=5000
RAG_ABSTENTION_MODE=shadow
# RAG_DENSE_ABSTAIN_THRESHOLD=0
RAG_CORPUS_VERSION=live-corpus-v1
# RAG_MILVUS_INDEX_VERSION=milvus-index-release-id

MILVUS_HYBRID_MODE=off
RAG_HYBRID_PROBE_TIMEOUT_MS=2000
# Legacy only; ignored because explicit MILVUS_HYBRID_MODE is set above.
# MILVUS_HYBRID_ENABLED=false
RAG_HYBRID_SEARCH_TIMEOUT_MS=5000
CONTEXTUAL_RETRIEVAL_V2_MODE=off
# Legacy only: missing V2 mode + lowercase true maps to shadow and still invokes an LLM.
# Prefer CONTEXTUAL_RETRIEVAL_V2_MODE for all new deployments.
# CONTEXTUAL_RETRIEVAL_ENABLED=false
RAG_MIROFISH_GRAPH_MODE=off
RAG_MIROFISH_GRAPH_STORE_ROOT=/app/uploads/mirofish-graph-artifacts-v2
RAG_MIROFISH_GRAPH_INGEST_TRUST_LEVEL=external
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
RAG_DURABLE_ASK_MODE=off
```

上线前按以下顺序操作：

1. 将 `/app/uploads` 绑定到可写持久卷；确认容器运行用户有权限访问 graph、PDF
   visual 和 durable workflow 子目录。
2. 保持全部 `off` 建立 dense/text 基线。
3. 对支持 `shadow` 的单项能力执行 `off -> shadow -> active`，每次只改一个开关；
   shadow 不得改变生成路由，是否产生候选对比数据取决于具体能力。先在隔离 tenant/corpus
   或专用 canary 实例验证 scope、trust、延迟、预算和 provider capability。
4. Durable Ask 不支持 shadow。只在单实例 canary 设为 `active`，并让少量调用方显式
   发送 `executionMode="durable"`；未携带该字段的同步请求保持原路径。
5. 任一查询期能力异常时将对应开关恢复为 `off` 并滚动重启。这样 ordered、hybrid、
   graph 和 PDF visual 会恢复 dense/text 路由。

Milvus hybrid 应使用独立 hybrid collection；不设置
`MILVUS_HYBRID_COLLECTION_NAME` 时名称为
`${MILVUS_DEFAULT_COLLECTION}_hybrid_v1`，默认 fusion 为 `rrf`。只有 native hybrid、
BM25 和 schema/embedding dimension capability 均通过时才可以激活。回滚
`MILVUS_HYBRID_MODE=off` 会恢复源 dense collection，但不会删除 hybrid collection。

`RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS=5000` 为 ordered connect/init/schema/read 设置整体
deadline；`RAG_HYBRID_PROBE_TIMEOUT_MS=2000` 限制 capability probe；
`RAG_HYBRID_SEARCH_TIMEOUT_MS=5000` 限制可选 hybrid lane。三项只接受 `1..10000`
毫秒的安全整数，且必须低于 `30000` 毫秒检索总预算。Hybrid lane 会额外为必需的 dense
fallback 保留至少 `15000` 毫秒。

`MILVUS_HYBRID_ENABLED` 仅用于旧环境兼容：只有未设置 `MILVUS_HYBRID_MODE` 且值为
`true` 时才映射到 `shadow`，不会隐式激活 evidence。新部署应只使用显式 mode；容器
样例的 `MILVUS_HYBRID_MODE=off` 会覆盖 legacy 变量，避免意外 probe/search/dual-write。

`RAG_ABSTENTION_MODE` 默认为 `shadow`，此时只记录拒答决策，不改变生成 evidence。
切到 `active` 后可能直接返回拒答；上线前必须校准 dense 分数。可选的
`RAG_DENSE_ABSTAIN_THRESHOLD` 只接受 `0..1`，未设置时使用请求
`similarityThreshold`（默认 `0`）。

`RAG_CORPUS_VERSION` 默认为 `live-corpus-v1`，同时参与 hybrid manifest 与缓存身份；
语料代际变化时应显式递增。`RAG_MILVUS_INDEX_VERSION` 未设置时会从 collection、
index type、metric 与 embedding dimension 推导；仅在真实索引代际变化时覆盖。

Ordered scope/inventory 不变量失败仍 fail closed；connect、collection init 或 ordered
query 的一般 provider 故障在 `shadow/active` 都记录 `provider_unavailable` 后走
dense fallback，不能让 shadow 破坏主链可用性。
同一进程内，provider deadline 到期或同一 collection/provider key 上前一个非协作任务
尚未真正结束时，不会重新进入该 provider；任务实际 settle 后才解除 admission fence。
该 fence 不跨实例；多副本需要共享控制面才能形成部署级 admission。外部请求取消仍保持
取消语义。

Hybrid `shadow` 写失败保留 dense 成功。Hybrid `active` 写失败会按 server-derived
tenant/corpus/trust scope 与精确 chunk IDs 补偿删除 hybrid+dense 两侧；补偿完整时返回
稳定 502 rolled-back 错误，补偿不完整时返回 503
`MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED` 和确定性 reconciliation ID。公开错误不
反射 provider cause，运营方需按 receipt 的 scope、集合和 chunk 数完成精确对账后再重试。

Legacy `CONTEXTUAL_RETRIEVAL_ENABLED=true` 仅在未设置
`CONTEXTUAL_RETRIEVAL_V2_MODE` 时映射为 `shadow`，永远不会隐式 `active`。但该
shadow 仍会在 ingestion 调用 contextualizer 并产生延迟/费用；升级前应删除 legacy
变量或显式设置 `CONTEXTUAL_RETRIEVAL_V2_MODE=off`，新部署只使用 V2 mode。

Contextual Retrieval v2 是写入期能力。`shadow` 会生成候选 contextual dense text，
但只持久化 identity/status 等诊断元数据，不保存候选正文，也不替换索引文本；
`active` 后的新 ingestion 会让 contextualized text 参与 dense
index。仅关闭开关不能还原已写入的 contextual embeddings；完整回滚必须从 raw content
重新 ingestion，并重建或切回非 contextual dense collection。

MiroFish graph 默认把新 artifact 标记为 `external`，可选
`RAG_MIROFISH_GRAPH_ARTIFACT_TTL_MS` 的范围是 1 ms 到 365 天。固定读取目标时，
`RAG_MIROFISH_GRAPH_DOCUMENT_ID` 和 `RAG_MIROFISH_GRAPH_DOCUMENT_VERSION` 必须成对
设置。Graph file store 默认限制 root 1000 个 artifact/2 GiB、单 scope
200 个/512 MiB，并在发布前持久化 reservation；root 数/字节硬上限分别为 10000 和
128 GiB，scope 配置不能超过 root。查询仅返回 `trusted/reviewed/external`，
`quarantined` 与不存在资源统一返回 404；具有删除权限的管理调用仍可按 exact identity
删除隔离资源。

Active pointer 最多扫描 32 个 revision，压缩保留 8 个。Tombstone 默认 10000、硬上限
100000，且不能小于 artifact 上限；满额时新 put/delete fail closed，不淘汰删除 fence。
Staging reservation 默认 15 分钟（范围 1 分钟到 24 小时），仅回收过期、无 descriptor
且无 active writer 的残留。Commit 后 temp/compaction 清理失败不覆盖已提交成功。

PDF visual 默认 render width 为 1280，单次最多渲染 20 页；容器样例继续保持
`RAG_PDF_VISUAL_MODE=off`，`RAG_PDF_VISUAL_MODEL` 只是待验证占位符。完成这些
本地存储控制并不代表任何外部 vision provider 已经生产切流。

PDF asset store 默认以 root 10000 个/32 GiB、单 scope 2000 个/8 GiB 做持久配额，
保留期 30 天、orphan 回收期 1 小时。root ledger 保存总量、有界 active reservation 和
最多 4096 个 scope lifecycle（`creating/active/reclaiming`），scope ledger 按 digest
分片；两者都校验 schema、generation、digest。新 scope 先持久化 `creating`
reservation，占用 registry slot，scope ledger 激活后才转为 `active`；创建中断会在
恢复时回滚。零容量 scope 先持久化 `reclaiming` fence，再删除 marker/ledger 并释放
registry slot，重启会续做未完成的回收。

分片 reservation journal 在页面发布前计入容量，已提交量包含页面和序列化 manifest，
在途量额外包含临时 overhead。root capacity lock 只包围 reserve/commit/release，
bundle 写入使用 exact identity lock，无关 immutable 读取不与慢 put 串行。

惰性 GC 的完整 batch 使用独立进程锁，避免并发 batch 回退持久 cursor。扫描覆盖 bundle、
reservation、staging、scope 控制记录与 root/recovery/scope 原子写 temp；temp 只读取
元数据，manifest byte budget 不包含 temp 正文。entries 与 duration 在目录项之间检查，
因此 duration 是协作式预算，不是单次文件系统操作的硬超时；单 shard 或 invalid debris
超限仍 fail fast。

final identity 目录缺少 manifest 时，put/delete 会保留现场并设置 recovery fence，避免
静默删除后重复计入容量。当前 root/recovery ledger schema 为 v2/v3；旧版、缺失或损坏
控制记录都阻止 mutation，运营方必须执行按 shard 数有界的显式恢复批次。store lifecycle
port 仍支持 exact-scope delete，但没有新增外部文档删除 API。

| 变量 | 默认值 | 单位/含义 | 硬上限 |
|------|--------|-----------|--------|
| `RAG_PDF_VISUAL_GC_MAX_BYTES` | `67108864` | 单批 manifest 检查读取字节（64 MiB）；必须 >= effective `maxManifestBytes`（当前 1 MiB），否则 fail closed | `1073741824`（1 GiB） |
| `RAG_PDF_VISUAL_GC_MAX_DURATION_MS` | `50` | 单批 GC 协作式 wall-clock 预算；在目录项之间检查，不中断正在执行的单次文件系统操作 | `5000` |
| `RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES` | `2048` | 单 shard 可物化目录项数 | `100000` |
| `RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES` | `16` | 单批允许的 invalid/debris 项数 | `1024` |
| `RAG_PDF_VISUAL_LEDGER_MAX_BYTES` | `1048576` | 单个 ledger/journal 控制记录字节（1 MiB） | `16777216`（16 MiB） |
| `RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS` | `64` | 同一 root 的 active publication 数 | `1024` |
| `RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS` | `4096` | root lifecycle registry 中可保留的 scope ledger 数；零容量 scope 会事务式回收 | `100000` |
| `RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES` | `4096` | 每个在途 publication 预留的临时开销字节 | `1048576`（1 MiB） |
| `RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS` | `4` | 每次显式恢复最多扫描的 identity shard 数 | `256` |

Renderer 默认最多 4 个并发任务与 256 MiB 在途源文件；即使调用超时或取消，也会等
原生 work 真正 settle 后才释放 admission。配置解析受代码 hard cap 约束并 fail closed。

MiroFish、PDF visual 和 Durable Ask 的当前 file provider 都只提供 process
coordination。持久卷可以跨容器重启保存文件，但不是多实例共享控制面。将任一
`*_MULTI_INSTANCE` / `*_REQUIRE_SHARED_CONTROL_PLANE` 设为 `true` 时，本地
provider 会 fail closed；Durable Ask 请求
`RAG_DURABLE_WORKFLOW_CONTROL_PLANE=shared` 也会返回 503。真正接入 shared
transactional provider 之前，不要把多个副本指向同一普通 filesystem volume 并宣称
具备 CAS、lease 或 failover 一致性。

### Durable Ask 单实例配置

```bash
RAG_DURABLE_ASK_MODE=active
RAG_DURABLE_WORKFLOW_STORE_ROOT=/app/uploads/rag-durable-workflows-v1
RAG_DURABLE_WORKFLOW_INTEGRITY_KEY=<32-4096-character-runtime-secret>
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

Integrity key 必须由平台 secret manager 注入，不能提交或 bake 到镜像。Lease 默认和
样例都是 30000 ms，生产值至少为 300 ms，并应覆盖 provider 调度抖动。
Durable POST、thread GET 和 PATCH 管理操作都要求 `manage-runtime` capability。

Canary 请求必须显式携带：

```http
POST /api/ask
Authorization: Bearer <token>
Idempotency-Key: tenant-job-0001
Content-Type: application/json

{"question":"...","executionMode":"durable"}
```

`Idempotency-Key` 长度为 8-128，字符范围为字母、数字、`.`、`_`、`:`、`-`，
且必须以字母或数字开头。Durable result 采用 compact replay allowlist，只保存答案、
模型标识、执行摘要和不带正文/metadata 的 citation 标量；raw query、完整
request/context、evidence content、provider 原始响应和 credential 不会写入 result
artifact，checkpoint 只保存 HMAC digests。

在线 checkpoint 默认保留最近 32 个 revision；`CHECKPOINT_MAX_REVISIONS=4096` 是
legacy/recovery 有界扫描和配置上限。每个 thread 按最坏 checkpoint 窗口持久预留字节，
tombstone 也固定预留容量，root 默认 64 GiB；若不能容纳 tombstone 上限和至少一个
thread reservation，配置会 fail closed。Result artifact 另受单份大小和总数上限保护。
Checkpoint orphan reservation 与临时文件默认都保留 1 小时，分别由
`RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS` 和
`RAG_DURABLE_WORKFLOW_TEMP_TTL_MS` 控制，硬上限均为 30 天。

Result root 默认最多 2000 份/16 GiB，单 scope 默认最多 200 份/512 MiB，orphan
reservation 与 result 临时文件默认都保留 1 小时。GC 默认每批 64 项、64 MiB、50 ms，
显式 ledger rebuild 默认最多 5000 ms；相关 `RESULT_*` 变量都已列在上方容器配置块。
root bytes、scope artifacts、scope bytes、orphan TTL、temp TTL、GC entries、GC bytes、
GC duration 与 rebuild duration 的硬上限依次为 128 GiB、5000、64 GiB、30 天、30 天、
1024、1 GiB、10000 ms 和 30000 ms，scope 配额不能超过 root；
`RESULT_GC_MAX_BYTES` 还必须至少为 `RESULT_MAX_BYTES + 65536`，否则启动 fail closed，
以保证单个合法 artifact 不会永久卡住 GC cursor。

Result 原子写临时文件只允许位于同一持久卷的
`ask-results/ledgers/tmp`，严格命名为
`<target-sha256>.<13-digit-epoch-ms>.<uuid>.tmp`。首次写操作和显式 GC/rebuild 按
`RESULT_TEMP_TTL_MS` 回收过期文件，并复用 GC 的 entry/byte/time 批次边界；普通 mutation
在触及批次边界或仍有未过 TTL 文件时会继续后续批次，因此不依赖人工 GC 才能推进。未过
TTL 的活跃 writer 文件不会被删除。临时目录硬限制为 2048 项，非法名称、非普通文件、单文件
超限或目录超限均 fail closed。Scope capacity 归零时，ledger 与 marker 会在 root pending
mutation 内先后清除，root pending 最后清除；崩溃恢复和 rebuild 会继续完成该顺序并丢弃
历史零值 scope control，避免多 scope churn 无界增长。

Workflow/result 不会按 TTL 自动清理；终态 workflow 应由具有 `manage-runtime` 权限的
管理员按当前 generation 与 revision 执行明确的 `delete` action：

```http
PATCH /api/ask?corpusId=<corpus-id>
Authorization: Bearer <admin-token>
Content-Type: application/json

{"action":"delete","threadId":"rag-ask-<id>","expectedGenerationId":"<generation-id>","expectedRevision":12}
```

所有 durable PATCH 管理 action 都要求 `expectedGenerationId` 与 `expectedRevision`；
POST、GET 和 PATCH 响应通过 `x-rag-durable-generation-id` 暴露当前 generation fence。
Delete 只接受 `completed`、`failed` 或 `cancelled` checkpoint。协议按 generation +
revision 发布 exact-generation checkpoint tombstone，清空该 generation 的 revision/thread
reservation，再清理其所有 attempt result artifact 和 orphan reservation；后半段失败时，
相同 generation + revision 重试会验证 tombstone 后继续。即使同一 thread 已启动新的
generation B，只要旧 generation A 的 exact tombstone + revision 仍在，A 重试也只清理
A result 并确认 A tombstone，不读取、删除或确认 B。只有 result cleanup 成功才持久
确认 cleanup；成功 receipt 包含 `generationId`、`checkpointDeleted`、`cleanupResumed`、
`resultDeletedCount` 与 `cleanupAcknowledged=true`。

File checkpoint tombstone 默认最多 1000 个、保留 7 天；环境变量硬上限分别为
10000 个和 365 天。保留期内它是 thread-key 的 generation barrier；过期后新的随机
generation 可接管同一 thread key，但旧 generation replay 仍冲突。惰性 GC 只删除已过期、
已 `cleanupAcknowledged` 且该 generation 的 latest/revision catalog 已物理清空的
tombstone；未确认 cleanup 的 tombstone 不因过期而回收。

Generation-aware checkpoint 使用 `rag-durable-checkpoint-v3`，result reservation 使用
`rag-durable-ask-result-reservation-v3`。缺少 generation 的旧 checkpoint/result envelope
会 fail closed，不能静默归入新 generation。禁止直接删除 volume 内的 latest、revision、
reservation、tombstone 或 artifact 文件。

这些步骤只说明代码和容器配置的安全边界。没有真实 Milvus/Zilliz、contextualizer、
vision model、shared control plane 与生产流量证据时，只能报告“配置/本地测试通过”，
不能报告“外部 provider 验证”或“生产切流完成”。

## API 身份、租户与语料库边界

`/api/ask`、`/api/pipeline` 和 `/api/milvus` 统一使用服务端派生的安全上下文，客户端
`userId` / `tenantId` 不作为授权依据。

- `RAG_ACCESS_MODE=local-dev`：只允许非 production，保留本地无登录开发体验。
- `RAG_ACCESS_MODE=single-tenant-token`：生产过渡模式；必须设置长随机
  `RAG_SINGLE_TENANT_TOKEN` 与固定 tenant/corpus，请求使用
  `Authorization: Bearer <token>`。
- `RAG_ACCESS_MODE=supabase`：使用 Supabase 用户 JWT；服务端通过 publishable key +
  用户 JWT 验证 Auth user、RLS 可见 corpus 和 tenant membership，不回退 service role。

`single-tenant-token` 面向受信服务端调用或会注入 Authorization 的反向代理，不能把共享
token 下发到浏览器。当前第一方演示 UI 不发送生产 bearer/session，且首页默认 memory
policy；它只适用于 `local-dev`。认证模式的浏览器体验必须先接入同源 BFF/session，或由受信
反向代理在服务端注入身份，并把默认策略限制为 scoped Milvus。

应用层硬边界覆盖 canonical API：`/api/ask`、`/api/pipeline`、`/api/milvus`。旧的
`rag-milvus`、Milvus sync/visualize、agentic/adaptive/reasoning/self-RAG、upload/files 与
reinitialize 路由在 production 或显式认证模式统一返回 410，只在非 production 的
`local-dev` 保留。生产网关仍应使用 route allowlist 作为纵深防御；当前 compose 不包含
身份代理，不能仅复制示例环境变量后直接把演示 UI 作为生产入口。

生产环境应设置 `RAG_ALLOWED_LLM_MODELS` 和 `RAG_ALLOWED_EMBEDDING_MODELS`（逗号分隔）。
外部 URL ingestion 默认只允许 HTTPS；仅在明确接受风险时设置
`RAG_EXTERNAL_URL_ALLOW_HTTP=true`。

新建 Milvus collection 会包含 `tenant_id`、`corpus_id`、`document_id`、
`trust_level` 标量字段。旧 collection 不具备这些字段；启用
`RAG_TENANT_ISOLATION_REQUIRED=true` 前，必须通过受控重建或 shadow collection 回填迁移，
否则服务会按 fail-closed 策略拒绝读写，避免静默跨租户检索。

## 持久化边界

本地 compose 使用 Docker volumes 保存：

- `/app/uploads`
- `/app/reasoning-uploads`
- `/app/adaptive-rag-uploads`
- Milvus/MinIO/etcd 数据 volume

云迁移建议：

- 文件/manifest：设置 `RAG_PERSISTENCE_BACKEND=supabase`。
- 向量库：设置 `MILVUS_PROVIDER=zilliz` 或后续接入 `RAG_VECTOR_BACKEND`。
- 不依赖容器本地磁盘保存长期业务数据，除非平台显式绑定持久卷。


## 本机生产启动

服务端模式启用 Next.js standalone 输出。生产启动前必须先构建：

```powershell
pnpm build
pnpm start
```

`pnpm start` 会运行 `.next/standalone/server.js`；静态导出仍使用 `STATIC_EXPORT=true pnpm build` 生成 `out/`。

## 静态导出与容器镜像

`STATIC_EXPORT=true` 仍用于静态站点导出，输出 `out/` 并使用 `/rag-system` base path。容器部署走服务端模式，不设置 `STATIC_EXPORT=true`，Next.js 会生成 standalone server 输出。

## 常见问题

### 容器内 localhost 连接不到宿主机 Ollama

容器内 `localhost` 指向 app 容器自身。默认 local compose 使用：

```text
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

Linux Docker 通过 `extra_hosts: host.docker.internal:host-gateway` 提供这个地址。

### `/api/health/live` 通过但 `/api/health` 失败

这是预期边界：liveness 只证明进程活着，readiness 会初始化 RAG 并读取模型/向量库配置。排查 `.env.container`、Ollama/Zilliz/Supabase 连接和 API Key。

### Zilliz endpoint 是否需要 `https://`

不需要。按现有配置指南，`MILVUS_ZILLIZ_ENDPOINT` 使用 SDK endpoint 形态，例如：

```text
in01-xxx.api.gcp-us-west1.zillizcloud.com:443
```

### 能否把 `.env.container` 打进镜像

不能。镜像必须可复用，密钥只通过运行时 env/secrets 注入。`.dockerignore` 已排除 `.env*`。

## 验证命令

```powershell
pnpm build
docker version
docker build -t rag-system:container-smoke .
docker compose --env-file .env.container.example -f docker-compose.yml -f docker-compose.local.yml config
docker compose -f docker-compose.yml -f docker-compose.cloud.yml config
```

如果 Docker daemon 不可用，只能说明本地代码构建通过，不能宣称容器验证完成。
