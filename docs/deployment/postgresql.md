# 自建 PostgreSQL 部署与运维

当前活动方案使用自建 PostgreSQL 保存 tenant/corpus、文档 manifest、二进制对象和 trace
数据。Milvus/Zilliz 仍是默认向量后端；不要因为启用了 PostgreSQL 持久化就把
`RAG_VECTOR_BACKEND` 改成尚未验收的后端。

新环境只使用 `db/postgres/migrations` 与 `scripts/migrate-postgres.mjs`。不要把其他平台的
SQL、认证 helper、对象存储 schema 或扩展 schema 当作本项目初始化入口。

## 运行时配置

新部署优先使用以下变量：

| 变量 | 用途 | 建议 |
| --- | --- | --- |
| `POSTGRES_URL` | PostgreSQL DSN | 只从运行时 secret 注入；用户名、密码必须 URL encode |
| `RAG_PERSISTENCE_BACKEND` | 持久化后端 | 所有生产入口只接受 `postgres`；`local` 与 `dual-write` 都会在启动/发布/热重载前被拒绝 |
| `RAG_DEFAULT_TENANT_ID` | 服务端固定 tenant scope | 必填，runner 会幂等创建并校验 |
| `RAG_DEFAULT_CORPUS_ID` | 服务端固定 corpus scope | 必填，runner 会幂等创建并校验归属 |
| `POSTGRES_SSL_MODE` | `disable` / `require` / `verify-full` | 本地 `disable`；生产优先 `verify-full` |
| `POSTGRES_MAX_CONNECTIONS` | 单个应用进程的连接池上限 | 默认 10，按副本总量核算 |
| `POSTGRES_IDLE_TIMEOUT_MS` | 空闲连接回收时间 | 默认 30000 |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | 建连超时 | 默认 5000 |
| `POSTGRES_MIGRATION_URL` | migration job 的 owner DSN | 只注入一次性迁移进程，绝不注入 app |
| `POSTGRES_APP_ROLE` | 已由 DBA 创建的运行时角色名 | runner 幂等授予 schema/DML/sequence 权限 |

`DATABASE_URL` 只作为兼容别名。新环境使用 `POSTGRES_URL`；不要在 Compose、镜像层、Git
或可归档的 `docker compose config` 输出中固化生产 DSN。本地 Compose 是例外：它给 app
容器显式设置内部 `DATABASE_URL`，主机名固定为 Compose service `postgres`。

生产 runner 会 trim 两个 DSN 的首尾空白，只接受 `postgres://` / `postgresql://` scheme，
并拒绝未编码空白。若 `DATABASE_URL` 与 `POSTGRES_URL` 同时存在，trim 后必须完全一致；
错误日志不会回显 DSN。默认 tenant/corpus 必须分别匹配
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`。

## 本地 Compose

本地栈使用固定镜像 `postgres:17-bookworm` 和 volume `rag_postgres`。5432 只绑定到
`127.0.0.1`，不会监听宿主机公网接口；app 通过 Compose 内网的 `postgres:5432` 访问。

1. 创建本地配置并同时修改 `POSTGRES_PASSWORD` 与主机侧 `POSTGRES_URL` 中的密码。Compose
   会给 app 显式设置内部 `DATABASE_URL`；示例通过 DSN 拼接密码，因此本地密码应使用
   URL-safe 字符，生产密码必须进行 URL encode。

   ```powershell
   Copy-Item .env.container.example .env.container
   ```

2. 先启动数据库，等待 `pg_isready`：

   ```powershell
   docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml up -d postgres
   docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml ps postgres
   ```

3. 从仓库工作区执行版本化迁移。脚本优先读取 migration-job-only 的
   `POSTGRES_MIGRATION_URL`，否则读取一致的 `POSTGRES_URL` / `DATABASE_URL`；本地可
   让 Node.js 直接加载未提交的 `.env.container`：

   ```powershell
   node --env-file=.env.container scripts/migrate-postgres.mjs
   ```

   迁移来源是 `db/postgres/migrations`。runner 用 session advisory lock 串行化迁移，为每个
   migration 单独提交，并把版本、名称和 SHA-256 checksum 写入
   `public.rag_schema_migrations`；已应用文件被修改时会 fail closed。不要使用非版本化 SQL，
   也不要用应用启动隐式代替迁移。CI/云平台已经把 DSN 注入进程环境时，使用
   `node scripts/migrate-postgres.mjs`。

4. 启动其余服务：

   ```powershell
   docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml up -d --build
   ```

`app.depends_on.postgres.condition=service_healthy` 只保证 PostgreSQL 已接受连接。首次部署若未
先跑迁移，app 可以启动，但 readiness 会因 schema 不完整而失败。

## 云部署

`docker-compose.cloud.yml` 默认 `RAG_PERSISTENCE_BACKEND=postgres`，但不会提供默认 DSN；
`POSTGRES_URL` 必须由云平台 secret manager 或编排系统在运行时注入。推荐顺序：

1. 创建 PostgreSQL 17 实例、数据库、迁移角色和权限更小的应用角色。
2. 配置 TLS、DNS 和网络 allowlist；数据库端口只允许应用、迁移任务和备份任务访问。
3. 在 release workspace 或一次性 migration job 中注入 DSN，执行
   `node scripts/migrate-postgres.mjs`。
4. 验证迁移与默认 tenant/corpus 后，再滚动发布 app 副本。
5. 同时检查 app readiness、一次受控写入和数据库回读，再切流。

迁移 job 使用 `POSTGRES_MIGRATION_URL`（owner/migration role）与 `POSTGRES_APP_ROLE`（例如
`rag_app`）；应用只使用 `POSTGRES_URL`。runner 会为已存在的 app role 授予 ledger/scope
只读权限及当前业务表的显式 DML/sequence 权限，不授予未来表的默认全量 DML，也不会创建登录角色
或管理密码。新增业务表时必须在同一迁移版本中显式更新权限清单。宿主 app bootstrap
会主动剔除 `POSTGRES_MIGRATION_URL`，不要把高权限 DSN 写入应用 `.env.prod`。

容器镜像和宿主机 release artifact 都包含 `db/postgres` 与 migration runner，供一次性
migration job 使用；应用启动仍不会隐式迁移。通用生产环境应在滚动发布前由 CI/release
workspace 或专用 migration job 显式执行，避免多个 app 副本争用启动时迁移。

## songuu.top 宿主机发布

仓库的 GitHub Actions 宿主机发布会自动调用
`deploy/songuu/provision-postgres-host.sh`，不要求把数据库密码放入 GitHub Secrets。首次运行会
创建一套只属于 RAG 的 PostgreSQL 17 基础设施：

- 容器：`rag-system-postgres`
- 数据卷：`rag-system-postgres-data`
- 监听：`127.0.0.1:25432`（不暴露公网）
- 数据库：`rag_system`
- 应用角色：`rag_app`
- migration owner：`rag_owner`

宿主 provisioner 的 `postgres:17-bookworm` 使用仓库内固定 digest，镜像升级需要显式更新并重新跑
provisioner 契约，避免同一 tag 在不同发布时间解析到未经审阅的镜像。

随机密码保存在 `/opt/rag-system/shared/.postgres-host/credentials.env`，应用 DSN 写入权限为
`0600` 的 `.env.prod`；owner DSN 单独写入权限为 `0600` 的
`.postgres-migration.env`。应用 bootstrap 会过滤 `POSTGRES_MIGRATION_URL`，因此 owner 凭据
不会进入 PM2 worker。`rag_owner` 是 `NOSUPERUSER`、`NOCREATEDB`、`NOCREATEROLE` 的 schema
owner；只有保存在 root-only credential state 中、不会写入应用或 migration env 的 `postgres`
管理员负责幂等创建/修复 `rag_owner` 与低权限 `rag_app`。migration runner 只能读取
`rag_owner` DSN。

发布顺序固定为：持有环境热重载锁 → 幂等 provision → 校验生产配置 → 解压新 release →
执行 `node scripts/migrate-postgres.mjs` → 用 `rag_app` 执行 PG17/scope/回滚式 DML 探针 →
检查并事务回填旧本地上传 → 原子切换 `current` →
PM2 reload → liveness/readiness → watcher/Nginx/token/gateway verify。任何 provision、迁移、回填、
readiness 或 gateway gate 失败都会阻止提交新 release，并恢复旧 `current`、环境/defaults、PM2、
watcher 与 Nginx 快照后重新验证旧服务。
provisioner 不会删除同名容器、已有数据卷或端口占用者；发现不符合托管标签、镜像、volume
或 loopback 端口契约时会 fail closed，交由人工确认。

GitHub Actions 只在 SSH 校验/安装步骤注入 root 私钥。默认生产 IP 的 Ed25519 host key 固定在
`deploy/songuu/ssh-known-hosts`；使用非默认 `RAG_SYSTEM_DEPLOY_HOST` 时必须同时配置经过人工核验的
`RAG_SYSTEM_SSH_KNOWN_HOSTS`，运行时不会通过 `ssh-keyscan` 自动信任未知主机。

### SSL

- `verify-full`：加密并验证证书链/主机名，是生产推荐值。私有 CA 需要让 Node.js 进程信任
  对应 CA（例如平台证书注入和 `NODE_EXTRA_CA_CERTS`）。
- `require`：链路加密，但当前客户端不会验证服务端证书；只作为受控过渡值。
- `disable`：仅用于本机隔离网络。

不要把 `sslmode` 查询参数和 `POSTGRES_SSL_MODE` 混用为两套相互冲突的策略。迁移、`psql`、
`pg_dump` 等外部工具也要单独配置等价的 TLS 校验。

### 连接池 sizing

每个 Node.js 进程都有独立连接池。预算至少满足：

```text
app 副本数 × POSTGRES_MAX_CONNECTIONS + migration/admin/backup 连接
  <= PostgreSQL max_connections - 运维余量
```

初始可按每副本 5–10 个连接估算，并为故障处理保留 20%–30% 余量。不要把数据库的
`max_connections` 原样配置给每个副本。副本多或连接抖动明显时，再在验证事务语义后引入
PgBouncer；这不是当前 Compose 的隐式组成部分。

## Auth 与对象存储边界

自建 PostgreSQL 只负责数据库持久化，不自动提供用户认证、REST 网关或对象存储：

- 当前生产入口使用 `RAG_ACCESS_MODE=single-tenant-token`。必须注入长随机
  `RAG_SINGLE_TENANT_TOKEN`，由受信服务端/BFF 或反向代理添加
  `Authorization: Bearer <token>`，不能把共享 token 下发到浏览器。
- `RAG_DEFAULT_TENANT_ID` 与 `RAG_DEFAULT_CORPUS_ID` 是服务端固定 scope；请求体中的
  `tenantId`/`userId` 不能替代鉴权。真正的多租户登录需要另行接入 IdP/session、membership
  授权与数据库策略。
- 当前对象数据写入 PostgreSQL `bytea`，manifest 与元数据写入关系表。应用上传限制和当前
  `bytea` 持久化验收边界都是单对象 **10 MB**；这不是 PostgreSQL 类型的理论上限。
- 超过 10 MB 或高吞吐对象应迁移到 S3/MinIO 等对象存储，PostgreSQL 只保存 object key、
  hash、大小和事务状态。提高限制前必须重新评估 Node.js 内存、请求超时、WAL、复制延迟、
  备份体积和恢复时间；当前版本未实现该扩展路径。

## 迁移与备份

### 迁移规则

1. 迁移前创建可恢复备份并记录应用版本。
2. 在单独的 migration job 中执行 `node scripts/migrate-postgres.mjs`。
3. 迁移失败时停止发布；不要让部分新旧 app 副本继续写入未知 schema。
4. 先验证 `rag_schema_migrations`、核心表和默认 tenant/corpus，再启动/切换流量。迁移 runner
   会要求两项 scope 成对出现且符合 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`，幂等创建默认
   tenant/corpus，并回读拒绝 corpus 已属于其他 tenant 的冲突状态。
5. 破坏性 schema 变更采用 expand → backfill → switch → contract，回滚应用前确认旧版本仍
   能读取新 schema。

### 本地逻辑备份与恢复演练

以下命令把 custom-format 备份先写到容器临时目录，再复制到宿主机，避免把二进制 dump
经由 Windows 文本管道重编码：

```powershell
New-Item -ItemType Directory -Force .\backups | Out-Null
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml exec postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/rag-system.dump'
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml cp postgres:/tmp/rag-system.dump .\backups\rag-system.dump
```

恢复会覆盖目标数据库，必须在隔离实例或已批准的维护窗口执行：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml cp .\backups\rag-system.dump postgres:/tmp/rag-system.dump
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml exec postgres sh -lc 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner /tmp/rag-system.dump'
```

生产环境至少启用加密备份、保留策略、异地副本和定期恢复演练。仅备份 Docker volume 快照
不等于可恢复方案；需要一致性快照或 `pg_basebackup`/WAL 归档来满足所需 RPO/RTO。备份成功
与恢复成功必须分别记录证据。

## Readiness 与验收

这些信号不能合并成一个“成功”：

1. PostgreSQL Compose `healthy`：`pg_isready` 能连接，不证明 schema 或业务 scope 正确。
2. `node scripts/migrate-postgres.mjs` 成功：证明迁移 runner 完成，不证明 app 已连到同一 DSN。
3. `/api/health/live` 200：只证明 Next.js 进程存活，**不访问数据库**。
4. 镜像 `HEALTHCHECK` 调用 `/api/health` readiness，检查数据库连接和核心 schema；失败返回 503。
5. 发布前 `node scripts/verify-postgres-runtime.mjs`：使用应用 DSN 验证实际 `current_user`、
   PostgreSQL 17、默认 scope，并在 blob、document、MAIC course/session 表内完成增删改查后强制
   回滚和零残留回读；这证明受限应用角色具备真实运行权限。
6. 一次带认证的 HTTP 业务写入和直接数据库回读：才证明网关、当前 app、scope 与完整请求链路一致。

本地检查示例：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml ps
Invoke-RestMethod http://localhost:3000/api/health/live
Invoke-RestMethod http://localhost:3000/api/health
```

不要将 liveness、容器 `running`、`pg_isready` 或迁移日志中的任意单项当作数据库业务成功。

## 已有数据切换

宿主机发布支持把旧 `uploads/file-manifest.json` 及其引用的本地 blob 自动回填到
`document_assets` / `object_blobs`。`scripts/backfill-local-postgres.mjs` 会扫描共享 uploads 和历史
release 的 uploads，拒绝路径穿越、符号链接、缺失文件、超过 10 MB、大小或 SHA-256 冲突。
需要导入时，发布器先停止旧 PM2 writer，再以 advisory lock 和单个 PostgreSQL 事务写入、回读，
最后把 plan hash、行数和字节数收据写入 corpus metadata。源文件不会自动删除，失败可安全重试。
MAIC 上传已走同一 PostgreSQL persistence seam，不会在回填后继续生成 local-only manifest。

该自动工具只覆盖仓库旧本地 upload manifest/blob，不覆盖其他外部数据库、对象存储或历史 trace。
这些源若有存量，不能直接切换流量，应单独完成：

1. 冻结增量窗口，导出表数据与对象清单。
2. 映射到 `document_assets` / `object_blobs` / trace 三表族，并校验 tenant/corpus scope。
3. 对表行数、对象字节数与 SHA-256 做源/目标回读对账。
4. 通过新 app 的受控读写、readiness 和回滚演练后再切流。

在没有源端与 PostgreSQL 双向 readback 证据前，只能声明“新库链路可用”，不能声明“历史数据迁移完成”。
