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
- 宿主机监听：`0.0.0.0:25432`（固定公网端口，强制 PostgreSQL TLS）
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

发布顺序固定为：上传受保护 staging → provisioner `prepare` 公网候选并保留 loopback rollback
容器 → GitHub runner 通过 SCP 临时取得 CA/client env 并执行不依赖业务表的 `network` 外网 verifier
→ 成功后仍保留 pending/backup，不写活动应用环境 → 远端 release 先持有环境热重载锁并完成环境快照
→ release-host 在同一发布事务中通过 `activate` action 写入 PostgreSQL 环境但保留拓扑回滚点 →
校验生产配置 →
解压新 release → 执行
`node scripts/migrate-postgres.mjs` → 用 `rag_app` 执行 PG17/scope/回滚式 DML 探针 →
检查并事务回填旧本地上传 → 原子切换 `current` →
PM2 reload → liveness/readiness → watcher/Nginx/token/gateway verify → provisioner `finalize` 删除 pending/
loopback backup 并提交拓扑 → GitHub runner 再次安全取得
CA/client env 并执行依赖已迁移 schema 的 `full` 外网 verifier。任何 provision、迁移、回填、
readiness 或 gateway gate 失败都会阻止提交新 app release，并恢复旧 `current`、环境/defaults、PM2、
watcher 与 Nginx 快照后重新验证旧服务；最后的 `full` gate 位于 release 事务之后，失败会把 workflow
标红，但不会自动回滚已经通过本机 migration/runtime/readiness 门禁的 app/数据库提交。
公网数据库的 `prepare` 不提交应用环境，也不会删除 loopback backup；只有 runner 的公网
TLS/认证/HBA `network` gate 成功后，release-host 才允许在环境锁和回滚快照保护下执行 `activate`。
这个阶段不能查询尚未由 migration 创建的业务 relation，因此首次空 PG17 数据库也能把已验证的
prepared 状态安全交给 release 事务。不能在两个独立 SSH step 之间提前提交活动 `.env.prod`：env
watcher 可能在 migration 前 reload 到空 schema。`activate` 不能删除 prepare 的 snapshot、loopback
backup 或 pending；只有 migration/backfill/runtime/readiness/gateway/PM2 全部成功后，release-host
才调用 `finalize`。远端事务在 finalize 前非零退出时，会在删除 staging 前调用 provisioner
`rollback` 恢复旧拓扑和环境；失败则写入 `postgres-rollback.failed` 并保留 root-only staging。
workflow 末尾还有 `failure() || cancelled()` finalizer，用于重试清理未完成 pending，但它不回滚已经
finalize 且通过本机发布门禁的 release。

每次 workflow 使用当次 `RELEASE_NAME` 作为 `RAG_POSTGRES_CUTOVER_TOKEN`；`prepare`、`activate`、
`finalize` 和 `rollback` 必须携带完全相同的 1–128 位安全 token，pending marker 和受保护 snapshot
也记录该 token。只有本轮 `prepare` 明确成功后，本轮步骤才 arm 主动 rollback。不同 token 遇到
遗留 `activated`/finalizing 状态必须 fail closed，不能把正在使用的公网 PostgreSQL 降回 prepared
或由新 workflow 的失败 finalizer 回滚。此时应先在环境锁内检查 pending、当前 app/readiness 和
release receipt，再使用原 token 明确选择 `finalize` 或 `rollback`；不要手工改 marker 伪造归属。
`finalizing` receipt 是最后一个仍需按 token 协调的提交边界：release-host 在收到不确定的 finalize
返回值或 SSH acknowledgement 丢失时，必须先用同一个 token 重试并核对 durable receipt，再决定是否
恢复 app/env。若 provisioner 已删除 loopback backup 并跨过不可逆点，则该 release 视为已提交；后续
marker/snapshot 清理失败只记录为 cleanup pending，保留新 app/env，不能再盲目 rollback。相反，只有
同 token 明确证明拓扑仍可回滚时，才恢复旧 app/env 和 loopback 拓扑。遇到这类 warning，应保留
root-only staging/receipt，使用原 token 完成 reconcile 或清理，而不是让下一次发布接管该事务。

release-host 还会在 staging 的固定 direct child `release-state.receipt` 原子写入 root-only `0600`
app receipt。文件精确记录本轮 release、cutover token 和 `app-committed` 或 `app-rolled-back`：前者
只能在新 app/gateway/readiness、PM2 save 和 PostgreSQL finalize/receipt reconcile 都成功后写入；
后者只能在旧 env/current/shared wrapper、旧服务 readiness、gateway rollback 和 PM2 save 都完成后
写入。外层 remote EXIT 和 workflow cancellation finalizer 必须严格核对本轮 release/token 后再行动：
`app-committed` 还需 provisioner `verify` 证明 strict public 拓扑已无 rollback-capable marker/backup，
随后保留新 app/env/wrapper；`app-rolled-back` 才授权本轮 token-bound PostgreSQL 与共享资产回滚。
若 release 已创建 shared-asset backup（表示可能开始修改 app）但 app receipt 缺失、损坏或归属不符，
应视为 SIGKILL/OOM/主机重启留下的未知状态：不得改 PostgreSQL、app/current 或 shared assets，保留
staging 并让 workflow 标红等待人工 reconcile。仅在 release 尚未开始、没有 receipt 和 shared backup
证据时，finalizer 才可把仍为 prepared 的 PostgreSQL 候选按本轮 token 安全回滚。cleanup 不能主动
finalize 一个仍处于 `activated`、本来可回滚的事务。GitHub cancellation finalizer 在读取 receipt 或
调用 provisioner 前也必须获取 `/run/lock/rag-system-env-reload.lock`，与仍在服务器执行的 release-host
串行；等待 120 秒仍无法获得锁时直接 fail closed 并保留全部状态，不能绕过锁继续清理。
provisioner 不会删除同名容器、已有数据卷或端口占用者；发现不符合托管标签、镜像、volume
或公网 TLS 端口契约时会 fail closed，交由人工确认。应用仍通过加密的 `127.0.0.1:25432`
连接；由于服务端证书身份是公网 Host，本机应用进程使用 `POSTGRES_SSL_MODE=require` 而不是主机名
校验。migration job 的 `rag_owner` DSN 则只使用 root-protected 的宿主机 Unix socket
`/opt/rag-system/shared/.postgres-host/socket`，对应进程使用 `POSTGRES_SSL_MODE=disable`，不会通过
TCP 暴露 owner。公网监听不会把 owner/admin DSN 写入应用环境。

GitHub Actions 只在 SSH 校验/安装步骤注入 root 私钥。默认生产 IP 的 Ed25519 host key 固定在
`deploy/songuu/ssh-known-hosts`；使用非默认 `RAG_SYSTEM_DEPLOY_HOST` 时必须同时配置经过人工核验的
`RAG_SYSTEM_SSH_KNOWN_HOSTS`，运行时不会通过 `ssh-keyscan` 自动信任未知主机。

### 公网直连

宿主发布把经过校验的 `DEPLOY_HOST` 作为 `RAG_POSTGRES_PUBLIC_HOST` 传给 provisioner。它用于
生成服务端证书的 DNS/IP SAN；外部客户端连接时必须使用同一个主机名或 IP，不能改用另一个解析
到该服务器的别名。公网协议固定为 PostgreSQL over TLS，端口固定为 TCP/25432，不提供明文回退。

监听端口不等于云防火墙已经放行。必须在云平台安全组中另外增加入站规则：

```text
协议：TCP
端口：25432
来源：实际客户端 CIDR，以及执行发布探针的 runner 出口地址
```

如果来源配置为 `0.0.0.0/0`（启用 IPv6 时还包括 `::/0`），任何互联网主机都可以发起 TLS/登录
尝试；这才是“全公网可达”，风险也最高。优先配置业务客户端固定 CIDR，并使用固定出口 IP 的
self-hosted runner 执行发布。GitHub-hosted runner 的出口地址范围较大且会变化，不应把它当成稳定
allowlist 合同；若安全组不允许当前 runner，发布后的外部 TLS/auth gate 会失败，即使服务器本机
检查全部正常。

Docker `--publish 0.0.0.0:25432:5432` 的转发流量可能不会经过常规 UFW `INPUT` 规则，因此不能把
“UFW 未放行 25432”当作端口已关闭的证据。云安全组是首要公网入口；如果还要在宿主机按 CIDR
二次限制，应在 Docker 的 `DOCKER-USER` 链或等价 nftables forward hook 中实施，并从允许和拒绝
两个外部来源实测。Docker/防火墙规则升级后也必须复测，不能只检查规则文本。

公网 IPv4/IPv6 `pg_hba.conf` 只允许 `rag_app` 通过 `hostssl` 连接 `rag_system`，后续规则明确
reject 其他 TCP 角色，所有非 TLS TCP 连接也会被拒绝。`rag_owner` 只允许 root-protected 的本机
Unix socket/SCRAM 运维链路；`postgres` 管理员只通过容器内 peer 身份执行。迁移、建角色、备份等
管理操作继续通过 SSH 登录宿主机后在本机执行。
不要把 `.postgres-migration.env` 或管理员密码复制给 DBeaver、脚本和普通开发人员。

#### 获取 CA 和应用凭据

私有 CA 与仅含 `rag_app` 公网连接参数的 root-only client env 位于服务器：

```text
/opt/rag-system/shared/.postgres-host/tls/ca.crt
/opt/rag-system/shared/.postgres-host/tls/rag-app-client.env
```

其中 `ca.crt` 只是 CA 公共证书，不含 CA 私钥，可以分发给获准连接数据库的客户端，但应通过已固定
host key 的 SSH/SCP 获取，不要从网页、聊天记录或未经认证的文件服务下载。示例：

```bash
scp -i ~/.ssh/rag_system_deploy_key \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=~/.ssh/known_hosts \
  root@47.253.230.197:/opt/rag-system/shared/.postgres-host/tls/ca.crt \
  ./rag-system-postgres-ca.crt
chmod 600 ./rag-system-postgres-ca.crt
openssl x509 -in ./rag-system-postgres-ca.crt -noout -subject -fingerprint -sha256
```

用同样受信的 SCP 把 `rag-app-client.env` 下载到权限为 `0600` 的临时文件。它只包含
`PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER=rag_app`、`PGPASSWORD`、
`PGSSLMODE=verify-full` 和服务器上的 `PGSSLROOTCERT` 路径，不会包含 owner/admin 凭据。下载到
客户端后必须把 `PGSSLROOTCERT` 覆盖为客户端本地 CA 的绝对路径。`rag-app-client.env` 含应用密码，
只能发给获准使用 `rag_app` 的人员或系统；使用后将密码写入受控密码管理器并删除临时 env。不要从
`/opt/rag-system/shared/.postgres-host/credentials.env` 复制包含三个角色的完整 credential state。
命令行优先通过受保护 env、`PGPASSFILE` 或进程级 `PGPASSWORD` 注入密码，不要把密码写进 shell
history、仓库或 CI 日志。

外部 URI 形式为：

```text
postgresql://rag_app:<URL_ENCODED_APP_PASSWORD>@47.253.230.197:25432/rag_system?sslmode=verify-full&sslrootcert=/absolute/path/rag-system-postgres-ca.crt
```

若 `RAG_SYSTEM_DEPLOY_HOST` 配置的是 DNS 名称，URI 中也必须使用该 DNS 名称。密码和 CA 路径中的
URI 特殊字符需要 percent-encode；不确定时使用下面的 libpq keyword 形式。

#### psql 验证

Linux/macOS 示例。client env 通过受信 SCP 获取且权限设为 `0600` 后，密码不会出现在命令参数：

```bash
set -a
. ./rag-app-client.env
set +a
PGSSLMODE=verify-full \
PGSSLROOTCERT="$PWD/rag-system-postgres-ca.crt" \
psql "connect_timeout=10"
unset PGPASSWORD
```

连接后执行：

```sql
SELECT current_user, current_database(), ssl, version
FROM pg_stat_ssl
WHERE pid = pg_backend_pid();
```

预期 `current_user=rag_app`、`current_database=rag_system`、`ssl=true`。再确认低权限边界：

```sql
SELECT rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname = current_user;
```

三项都必须是 `false`。不要用 owner/admin 角色测试公网连接；预期结果本来就是拒绝。

#### DBeaver

新建 PostgreSQL 连接并配置：

- Host：`RAG_SYSTEM_DEPLOY_HOST` 的实际值，例如 `47.253.230.197`
- Port：`25432`
- Database：`rag_system`
- Username：`rag_app`
- Password：受保护 `rag-app-client.env` 中的 `PGPASSWORD`
- SSL mode：`verify-full`
- Root certificate：刚通过受信 SCP 获取的 `rag-system-postgres-ca.crt`
- Client certificate / client key：留空

如果 DBeaver 报主机名不匹配，不要改成 `require` 绕过校验；应检查连接 Host 是否与证书 SAN 中的
`RAG_POSTGRES_PUBLIC_HOST` 完全一致。

每次数据库公网 `prepare` 后，GitHub runner 会从 root-only 路径临时拉取 CA 和 `rag_app` client
env，先以 `network` 模式运行有界 public verifier。该模式不引用任何应用 relation，只以
`verify-full` 验证证书链/Host、PG17、`current_user=rag_app`、`current_database=rag_system`、
TLS 1.3 和低权限登录角色属性；随后以随机密码确认 `rag_owner` 与 `postgres` 在 HBA 层被拒绝，
并确认同一 `rag_app` 凭据的明文 TCP 请求收到 PostgreSQL `28000` 认证拒绝，而不是把网络超时误判
为安全拒绝。这个无 schema 依赖的 gate 成功后只把 prepared 状态交给 app release；数据库 cutover
必须等 release-host 持有环境锁、完成回滚快照后，才在同一事务中 `activate` 并立即执行 migration；
完成 runtime/readiness/gateway 门禁后才 `finalize`。

release-host 完成 migration、runtime DML/readback、PM2 reload 和 readiness 后，runner 会重新通过
受信 SCP 获取这两个 root-only 文件，并显式以 `full` 模式运行同一 verifier。`full` 在上述网络合同
之外还检查已创建的业务表 DML allowlist 和 parent relation 写拒绝；因此首次空库是先通过 network、
迁移后再通过 full，而不是在 migration 前查询不存在的表。两个阶段的临时凭据都不会输出到日志，
并在各自 gate 结束时删除。`full` 失败表示“发布已提交，但外部完整验证失败”：workflow 会失败并
要求人工排查公网路径/schema/权限，不会自动回滚已提交 release。两个 gate 只证明当次 runner 的
公网链路，不代替其他客户端网络和安全组检查。

#### 关闭公网和回滚

需要立即停止外部访问时，先删除云安全组的 TCP/25432 入站规则。这一步不重启数据库，也不影响
应用继续通过 `127.0.0.1:25432` 读写，是首选的紧急关闭方式。然后验证外部 TCP/TLS 连接超时或
被拒绝，同时验证应用 readiness 仍为 200。

需要永久恢复为仅本机监听时，在批准的维护窗口内：先创建并验证备份，停止应用 writer，把
provisioner 的发布绑定契约恢复为 `127.0.0.1:25432:5432`，仅重建
`rag-system-postgres` 容器并保留 `rag-system-postgres-data` 数据卷，再运行 migration/runtime
probe/readiness。不要删除命名数据卷或 root-only credential state。当前 provisioner 对既有容器
端口漂移会 fail closed，不会未经确认自动重建数据库容器。

如果 CA、服务端私钥或 `rag_app` 密码泄漏，应先关闭安全组，再按下面的受控流程轮换并重新发布；
只删除 CA 客户端副本不能撤销已泄漏的服务器凭据。

`RAG_POSTGRES_PUBLIC_HOST` 变更时，provisioner 保留私有 CA 并为新 DNS/IP SAN 轮换服务端证书；
客户端应继续使用原 CA，但必须把连接 Host 改为新值并重新通过 `verify-full`。当前没有通过空值或
loopback Host 自动关闭公网的模式；关闭应使用安全组，并按上面的维护窗口流程恢复端口绑定。

#### CA、服务端证书与应用密码轮换

provisioner 会在服务端证书接近到期时使用现有私有 CA 为同一公网 Host 续签证书；它不会自动轮换
CA。CA 剩余有效期不足 900 天时发布会 fail closed，要求人工安排轮换。`rag_app` 密码也不会自动
轮换。轮换前必须记录备份、维护窗口、当前证书指纹和回滚材料。

CA 轮换流程：

1. 先关闭 TCP/25432 公网安全组入口，保留应用本机链路并验证 readiness。
2. 备份 root-only TLS/credential state 和数据库，验证备份可读；不要删除命名数据卷。
3. 离线生成新 CA 与匹配 `RAG_POSTGRES_PUBLIC_HOST` DNS/IP SAN 的服务端证书。先把“旧 CA + 新
   CA”信任 bundle 分发到所有客户端并核对新 CA SHA-256 指纹，不能先切服务器再通知客户端。
4. 在维护窗口切换服务端证书/私钥，重启或受控 reload PostgreSQL；从外部用新 CA bundle 完成
   `verify-full`、`rag_app` 登录、TLS/权限 readback 和 owner/admin 拒绝验证。
5. 逐个确认 DBeaver、服务和备份任务都已使用新链后重新开放安全组。观察期结束再从客户端 bundle
   移除旧 CA，并保留审计记录。任何 readback 不一致都应关闭入口并恢复旧证书材料。

`rag_app` 密码轮换流程：

1. 关闭或严格收窄 TCP/25432 安全组入口，创建数据库和 root-only 环境备份，并持有
   `/run/lock/rag-system-env-reload.lock`，防止 watcher 在半更新状态 reload。
2. 生成新的 URL-safe 随机密码，在同一维护事务中更新 PostgreSQL `rag_app`、
   `credentials.env` 的 `APP_PASSWORD`、`.env.prod` 的 app DSN 以及
   `tls/rag-app-client.env` 的 `PGPASSWORD`；所有落盘文件保持 root-only `0600`，日志不得输出新旧
   密码。PostgreSQL 单角色密码切换不是双密码协议，因此必须预留旧文件和受控回滚步骤。
3. 原子落盘后 reload PM2，执行本机 runtime DML/readback、readiness，再从外部运行 public
   verifier。确认旧密码已拒绝、新密码可用且 `current_user=rag_app` 后才重新开放安全组。
4. 删除临时凭据副本并更新密码管理器/审计记录。任一步失败都先关闭公网入口，再在发布锁内恢复
   数据库角色密码和全部 root-only 文件，不能只回滚其中一处。

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
