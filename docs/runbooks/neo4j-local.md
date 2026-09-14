# Neo4j 知识图谱运行手册

本地 Compose 使用 `neo4j:5.26.30-community`，与 PostgreSQL、Milvus 并行运行。
Milvus 仍负责 Passage 向量召回，Neo4j 只负责版本化实体、Claim、社区和有界路径查询。
不要未经 Schema 与查询兼容性验证改用 `latest`。

## 配置

复制 `.env.container.example` 为 `.env.container` 并修改 `NEO4J_PASSWORD`。首次启动保持
`RAG_GRAPH_MODE=off`；Schema 初始化、导入和 shadow 验证通过后才能切换为 `active`。

发布模式：

- `off`：Ask 路由不读取图谱。
- `shadow`：执行并记录图谱 lane，但图谱证据不会进入 Abstention、LLM 提示词或响应证据。
- `active`：图谱 Passage 证据参与融合和回答。

`RAG_GRAPH_MODE` 是正式配置；`RAG_MIROFISH_GRAPH_MODE` 仅作为旧配置兼容回退。

图查询还有两个可选的进程级门禁：`RAG_KG_QUERY_MAX_CONCURRENCY=8`（允许 1～64）和
`RAG_KG_QUERY_RATE_PER_MINUTE=120`（允许 1～10000）。计数键为
`tenant + corpus + actor`，用于限制单个调用方的并发和每分钟请求量；多实例部署时每个进程独立
计数，因此生产环境仍应在网关层配置全局限流。
持久构建入口另有 `RAG_KG_BUILD_RATE_PER_MINUTE=20` 的 per actor 速率门禁，以及
`RAG_KG_BUILD_MAX_PENDING_PER_SCOPE=20` 的 PostgreSQL 原子 per corpus 队列上限；后者使用
事务级 advisory lock，多个应用实例并发提交时也不会越过容量。
驱动事务重试默认由 `NEO4J_MAX_TRANSACTION_RETRY_MS=1000` 限制，避免 Neo4j 不可达时默认
重试约 30 秒拖慢 Ask；如需调整，只能设置为 0～30000 毫秒。

连接地址按运行位置区分：

- 应用容器：`neo4j://neo4j:7687`。
- 宿主机 `pnpm dev`、导入 CLI 与测试：`neo4j://127.0.0.1:7687`。

Neo4j Browser 为 `http://127.0.0.1:7474`。HTTP/Bolt 均只绑定 loopback，默认不暴露到局域网。

## 校验并启动

先渲染合并后的 Compose 配置：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml config --quiet
```

不要把渲染输出粘贴到工单，因为其中可能含数据库密码。然后启动并等待 healthcheck：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml up -d neo4j
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml ps neo4j
```

healthcheck 通过 `cypher-shell` 执行 `RETURN 1`，不能只用 HTTP 端口打开判断就绪。数据写入
命名卷 `rag_neo4j`，正常重启或重建容器不会丢失。

## Schema 与真实数据库验收

应用第一次访问 Neo4j Store 时会幂等初始化 Schema。也可以用隔离的真实数据库测试显式验收：

```powershell
$env:RAG_NEO4J_INTEGRATION='1'
$env:NEO4J_URI='neo4j://127.0.0.1:7687'
$env:RAG_NEO4J_USERNAME='neo4j'
$env:RAG_NEO4J_PASSWORD='<local-password>'
$env:RAG_NEO4J_DATABASE='neo4j'
pnpm test:neo4j:integration
```

测试使用随机 tenant，覆盖 Schema、幂等写入、CAS 并发、实体/邻居/路径/社区、Claim 原文来源、
RAG Evidence 与定向删除，并在 `finally` 中只清理该随机 tenant。

## 历史 MiroFish Artifact 导入

导入器默认只 dry-run；必须先检查摘要，再显式 `--apply`。它不会激活新版本，也不会删除文件副本。

```powershell
$env:RAG_DEFAULT_TENANT_ID='<tenant-id>'
$env:RAG_DEFAULT_CORPUS_ID='<corpus-id>'
$env:RAG_GRAPH_BACKEND='neo4j'
$env:NEO4J_URI='neo4j://127.0.0.1:7687'
$env:NEO4J_USERNAME='neo4j'
$env:NEO4J_PASSWORD='<local-password>'
pnpm graph:import
pnpm graph:import -- --apply
```

同一 `artifactDigest` 重放会跳过；同一版本不同 digest 会明确报冲突。

## 健康、管理与来源追溯

- 健康：`GET /rag-api/knowledge-graph/health`
- 管理页：`/knowledge-graph`
- 管理 API：`/rag-api/knowledge-graph/snapshots|entities|paths|communities`
- Claim 来源：`GET /rag-api/knowledge-graph/claims/:claimId/sources`

所有查询从服务端安全上下文解析 tenant/corpus，强制 active `graphVersion`、trust 范围、1～2 跳和
结果上限；实体、社区和路径 API 只投影白名单字段，引用 ID 在 Cypher 与 HTTP 边界均截断，
单次 JSON 响应硬限制为 1 MiB，超限返回 `KNOWLEDGE_GRAPH_RESPONSE_TOO_LARGE`。接口不接受
任意 Cypher。在 Ask 响应中检查：

```text
retrievalDetails.graph.requestedMode
retrievalDetails.graph.executed
retrievalDetails.graph.active
retrievalDetails.graph.evidenceCount
retrievalDetails.graph.shadowEvidenceCount
retrievalDetails.graph.diagnostics
laneExecutions[*].durationMs / status / errorCode / metadata
```

## 发布与回滚

使用管理页执行带 `expectedRevision` 的 CAS 激活、停用或回滚。Postgres 模式下先运行
以下命令通过同一个 Compose env-file 应用 `0005_knowledge_graph_control.sql`，Active Pointer 与 Outbox
以 Postgres 为权威；Neo4j 只保存图结构。构建或校验失败时不要激活 staging 版本。

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml run --rm app node scripts/migrate-postgres.mjs
```

回滚顺序：

1. 在实际 Compose 环境文件（本地为 `.env.container`，云端示例为 `.env.cloud`）中将
   `RAG_GRAPH_MODE=off`，然后强制重建应用容器以保证新环境变量生效：

   ```powershell
   docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate app
   ```

   云端应使用实际部署的 env-file 和 Compose 覆盖文件，例如：

   ```powershell
   docker compose --env-file .env.cloud -f docker-compose.yml -f docker-compose.cloud.yml up -d --force-recreate app
   ```

   不要只执行 `restart`：Docker Compose 的 `restart` 不会重新读取 env-file。Milvus 主链继续工作。
2. 如需回退数据版本，在管理页用当前 revision 激活上一稳定快照。
3. 保留旧文件 Artifact 至少一个发布周期；不要在故障处理中删除 `rag_neo4j`。

## 云部署

`docker-compose.cloud.yml` 不启动或暴露 Neo4j，并默认 `RAG_GRAPH_BACKEND=file`，所以缺少 Secret
时不会隐式启用 Neo4j。通过 Secret Manager 注入 `NEO4J_URI`、`NEO4J_USERNAME`、
`NEO4J_PASSWORD` 后再显式设置 `RAG_GRAPH_BACKEND=neo4j`。生产只接受证书可验证的
`neo4j+s://...` 或 `bolt+s://...`；明文或 `+ssc` 连接只有在风险已被明确接受且设置
`NEO4J_ALLOW_INSECURE=true` 时才允许。先 `off`，再 `shadow`，只有在
跨租户泄漏为 0、质量和延迟门禁通过后才切换 `active`。

## 控制面后台任务与补偿

主文档入口 `/rag-api/pipeline` 在 Milvus 向量写入和 PostgreSQL 文档资产持久化均成功后，自动提交
一个 Graph BuildJob。任务身份完全来自服务端作用域与文档版本，同一文档版本重试不会创建重复
任务。`RAG_GRAPH_BACKEND=neo4j` 时默认启用；紧急暂停新任务入队可设置
`RAG_GRAPH_AUTO_BUILD=false`。成功响应的每个文件包含 `graphBuild.id/status/graphVersion`；若入队
失败，接口返回 `KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED` 和稳定 reconciliationId，此时 Milvus
写入已完成，必须按该标识补偿或幂等重试。

`graph_build_jobs` 支持 `queued → running → staged → validated → published` 状态机；worker 在
Neo4j Artifact 与 snapshot lifecycle 完成 staged 校验后，用单条带租约的 SQL 将 BuildJob 从
`running → validated`，不持久化可卡死的中间窗口。失败与取消必须显式进入
`failed`/`cancelled`。worker 通过租约 claim，进程崩溃后
只有过期租约可被接管。

`graph_publication_outbox` 通过 `FOR UPDATE SKIP LOCKED` claim；dispatcher 每次只领取一条事件，
先按事件 revision 把 Neo4j `GraphPointer` 和 `GraphSnapshot.status` 从 `staging` 投影为
`active`/`superseded`，再执行可选 webhook，确认或重试完成后才领取下一条。只有本地投影与可选
webhook 都成功后才 ack，避免 PostgreSQL Active Pointer 已更新但 Ask 检索仍看不到图谱。相同
revision 与 graphVersion 的重放为 no-op；跳号、同 revision 不同图或隔离范围不一致会 fail-closed。
外部处理器必须把 event id 当作幂等键。
失败按 `available_at` 延迟重试，达到 `maxAttempts` 后进入 dead letter。`graph_snapshot_lifecycle`
以同一 `(tenant, corpus, graphVersion)` 的 `activating/deleting` 租约串行化激活与删除；删除完成保留
`deleted` 墓碑，避免并发激活产生悬空指针。

启动独立控制 worker 来消费 Outbox、BuildJob 并补偿过期 mutation。发布 Outbox 始终先投影到
Neo4j；`RAG_GRAPH_PUBLICATION_WEBHOOK_URL` 仅控制是否额外转发外部发布事件。

本地完整链路设置 `RAG_GRAPH_BUILD_EXECUTOR=local`。worker 会用 BuildJob 的服务端身份精确读取
Milvus 文档版本，校验分块数量、顺序、首尾覆盖、原文长度、原文 SHA-256、作用域和可信级别，
无损重建文本并调用本地模型抽取图谱，
随后写入 Neo4j 并将任务原子推进到 `validated`。默认租约为 60 分钟，可用
`RAG_GRAPH_LOCAL_BUILD_LEASE_MS` 在 60000～3600000 ms 内调整；同版本 Neo4j 快照已存在时直接复用，
避免 PostgreSQL 短暂失败导致重复模型调用。

本地执行器要求 Milvus 分块包含 `sourceTextLength` 和 `sourceTextHash` 完整性元数据。旧版本已经
向量化的文档不具备这两个字段时会 fail-closed，不能直接自动建图；请重新上传/向量化该文档，
由新管道生成可验证分块后再提交 BuildJob。不要手工伪造摘要或让 worker 跳过校验。

远端构建设置 `RAG_GRAPH_BUILD_EXECUTOR=webhook`。Webhook 地址必须是无内嵌凭据的 HTTPS URL，
并同时配置至少 32 字符的 `RAG_GRAPH_WEBHOOK_SECRET`。worker 通过
`Authorization: Bearer ...` 鉴权，并用 event/job id 写入 `Idempotency-Key`；接收方必须验证 Token
并据此去重。未设置执行器时，仅当构建 URL 与 Secret 均存在才自动选择 webhook，否则为
`disabled`，BuildJob 保留在 PostgreSQL，不会被 stdout 假成功消费。构建 webhook 默认超时由
`RAG_GRAPH_BUILD_WEBHOOK_TIMEOUT_MS=120000` 控制（允许 1000～600000 ms），BuildJob 租约始终比该
超时多 30 秒，避免长构建期间被另一 worker 并发重领。删除补偿
只允许完成为 `deleted` tombstone，检查失败会保留租约供下次重试，不执行跨租户或全库清理：

```powershell
pnpm graph:control-worker:local -- --once
pnpm graph:control-worker:local -- --interval-ms=5000 --batch-size=100
```

容器部署使用同一应用镜像中的自包含入口：`node graph-control-worker.cjs`；基础 Compose 已声明
`graph-control-worker` 服务，本地覆盖将其接到 `postgres` 与 `neo4j`，云端覆盖只读取注入的
PostgreSQL/Neo4j Secret。

云端默认不启动 worker。确认两库和 webhook Secret 都已注入，并显式设置
`RAG_GRAPH_BACKEND=neo4j` 后，再用 `--profile graph-control` 启动；worker 会在其他后端值下
fail-closed，防止应用使用 file 而 worker 单独写 Neo4j。worker 没有 HTTP 监听，Compose
已为它禁用应用镜像的 HTTP healthcheck；运行状态以容器进程、重启计数和结构化 iteration 日志判断。

## 故障恢复

Neo4j 不可用时，Graph Lane 会记录可降级错误；Dense Evidence 足够时问答继续。若需立即止损，
设置 `RAG_GRAPH_MODE=off` 并只重启应用。禁止把删除 `rag_neo4j` 当作常规恢复步骤。
