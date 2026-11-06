# 独立跨库发布测试环境

最后核对：2026-11-04。

此环境使用独立 Compose 项目、数据卷和仅绑定 `127.0.0.1` 的数据库端口。在可信本机范围内，已接通 PostgreSQL 控制面、Elasticsearch、Milvus 和 Neo4j 的真实统一发布与只读对账；原业务环境的数据卷和连接保持独立。

发布请求先保存不可变文档快照和分块，可信消费者向三个后端写入并完整回读核验，再由 PostgreSQL 原子切换已发布 head。目录、搜索、问答和图谱都按当前 head 读取；“已受理”不等于“已发布”。ES 使用独立代际索引与物理写锁，Milvus 使用独立代际集合和临时写入身份，失败或结果未知时保留操作记录，不自动重发。

## 已配置环境的启动与验收

运行前需要 Docker Desktop、Node.js、OpenSSL、本仓库依赖以及本地 Ollama；应用启动器使用 `nomic-embed-text` 向量模型，默认问答模型为 `llama3.1:latest`，快速路由模型为 `qwen2.5:0.5b`。当前验收环境：

| 配置 | 值 |
| --- | --- |
| 隔离环境 ID | `372b94728dedfdab252e037f` |
| PostgreSQL 数据库 | `publication_unified_7e0a8b1d3fc9440c8dc1e614` |
| 已应用 schema | `0026_publication_source_metadata` |
| 默认租户 / 知识库 | `publication-demo-tenant` / `publication-demo-corpus` |
| 应用地址 | `http://127.0.0.1:43107` |

在仓库根目录运行。若该环境此前已停止，可恢复其容器与保留的数据：

```powershell
node --input-type=module -e "import { startSandbox } from './deploy/publication-sandbox/sandbox.mjs'; startSandbox('372b94728dedfdab252e037f');"
node deploy/publication-sandbox/cli.mjs verify 372b94728dedfdab252e037f
```

在两个终端分别启动应用和单个消费者；已有进程运行时无需再启动：

```powershell
node scripts/publication-local-app.mjs 372b94728dedfdab252e037f
```

```powershell
node --import tsx scripts/publication-worker.mjs 372b94728dedfdab252e037f --watch
```

应用启动器显式开启统一发布和本地开发身份，只监听回环地址，屏蔽旧应用 env 文件中的连接与凭据，使用独立 `.next-publication` 构建目录。可在 ID 后追加端口，例如 `43108`。消费者先将 operation ID 持久化到 `worker-operations/`；`--watch` 仅在队列有待处理请求时发起一次尝试，任何不确定结果都会停止循环，需按原 request/operation ID 查询后处理。

1. 打开 [文档管理](http://127.0.0.1:43107/documents)，上传一个不超过 2 MiB 的支持文件，或粘贴文本。支持 TXT、Markdown、PDF、DOCX、XLSX、CSV、JSON；统一发布模式暂不受理网页 URL。等待“已发布”，再确认文档进入目录。
2. 打开 [文档搜索](http://127.0.0.1:43107/document-search)，分别验证关键词、语义、融合搜索及文件类型筛选。
3. 打开 [智能问答](http://127.0.0.1:43107/)，选择已安装的本地模型。模型生成编号引用时，原文预览通过签名 locator 校验当前 head、用户和文档版本。
4. 打开 [知识图谱](http://127.0.0.1:43107/knowledge-graph)，查看当前文档的关键词、共现关系和对应原文。此图谱明确表示源文本关键词共现，不宣称已抽取事实或因果关系。

应用健康检查只表明 PostgreSQL 控制面就绪，不代表此时三个后端全部通过实时核验；全量检查使用下述对账命令。

## 身份、创建与停止

运行目录为 `deploy/publication-sandbox/runtime/<ID>/`，由本目录 `.gitignore` 忽略。`credentials.json`、env 文件、TLS 私钥和 `citation-keys.json` 均为敏感文件，不应提交或分享。Windows 创建流程收紧目录 ACL，失败时拒绝继续。

应用使用 `pub_app` 的受限 PostgreSQL 函数和 ES/Milvus reader 身份，无发布 CAS、封存或直接控制表写权限。可信消费者使用 `pub_publisher`、ES writer/sealer，以及后端管理身份进行隔离检查、代际授权和封存。Neo4j Community 在此方案中由可信消费者独占管理身份；应用读取 PostgreSQL 中与图谱 seal 绑定的快照，不持有 Neo4j 管理凭据。

新建另一套环境的命令为 `node deploy/publication-sandbox/cli.mjs create`。该命令引导容器和身份；发布 schema、应用角色授权、默认租户/知识库与 publisher 函数授权还需由可信迁移流程完成，再运行应用和消费者。现有验收环境已完成这些步骤。`readSandboxConfig` 每次从 Docker 读取实际回环端口，并读取 `state.json` 中的数据库名，不能用旧端口连接另一个实例。

`verify <ID>` 检查 TLS、匿名访问拒绝、身份认证及 reader 写入拒绝；其 `productionAuthorized` 固定为 `false`。本方案信任操作系统、Docker、数据库和模型管理员，不防御这些管理员修改身份或数据，也不把撤销权限解释为取消已在途的 Milvus RPC。超时尝试会放弃代际，不能复用未知结果的资源。此开发环境不能据此视为已获生产发布授权。

停止时先退出对应应用和消费者，再执行 `node deploy/publication-sandbox/cli.mjs stop <ID>`；此命令保留卷和密钥。显式执行 `node deploy/publication-sandbox/cli.mjs destroy <ID> --confirm` 才会删除该 ID 的全部隔离数据，旧业务项目不在操作范围。

## 旧资产的手动归档迁移

`scripts/publication-archive-migration.mjs` 保留旧库中已停用或明确禁止检索的资产及其引用 blob。源库使用只读快照；目标库名称必须与源库不同。迁移保留 ID、元数据、blob 字节、时间戳和缺失引用状态，不创建发布请求、head 或三库投影，也不自动重新启用旧文档。

在权限受控的私有 `archive.env` 文件中配置 `PUBLICATION_ARCHIVE_SOURCE_URL` 和 `PUBLICATION_ARCHIVE_TARGET_URL`，不要将连接串放进共享命令或报告。先不设置 `PUBLICATION_ARCHIVE_APPLY`，运行 dry-run：

```powershell
node --env-file=deploy/publication-sandbox/runtime/<ID>/archive.env scripts/publication-archive-migration.mjs
```

核对输出的范围、数量、`conflicts` 与 `snapshotDigest`。确认后在同一私有文件中设置 `PUBLICATION_ARCHIVE_APPLY=1` 和 `PUBLICATION_ARCHIVE_EXPECTED_DIGEST=<已核对的 snapshotDigest>`，再次运行相同命令。源数据摘要变化、目标冲突或完整回读不一致会回滚；内容完全相同的重复执行可复用已有行。

当前隔离数据库已归档迁入 1 个租户、1 个知识库、10 个文档资产和 7 个引用 blob，源/目标完整摘要一致。原有停用、禁止检索和源文件缺失状态均保留，因此这些历史资产不会自动进入默认 demo 知识库的已发布目录；需要重新发布的文档须另行提供可验证原文。

## 已发布文档的只读三库对账

对账必须显式指定隔离环境、租户和知识库，不使用旧应用的默认连接：

```powershell
node --import tsx scripts/publication-reconcile.mjs <ID> <TENANT_ID> <CORPUS_ID>
```

命令从 PostgreSQL 当前有效 head 和封存原文/向量重新构造三个 provider manifest，核对 ES 物理索引 UUID、owner、写锁及 PIT 内全部行，核对 Milvus 集合 ID、字段/向量索引和全部实际 float32 向量，再在同一个 Neo4j 只读事务核对完整节点及关系。最后重读当前 head。PostgreSQL 连接强制只读；命令不重发发布、不修复 head、不修改三个后端的数据或索引配置。

JSON 中 `ok:true`、`outcome:"verified"`、`currentHeads:"unchanged"` 且每个文档的三个 backend 均为 `verified` 才表示此次读窗口对账通过；差异、连接失败或 head 并发变更都会得到非零退出码。空知识库明确返回 `no-active-publications`，不会声称三个后端已验证。SDK 原始异常、原文、向量和凭据不进入报告。

这仍依赖可信本机管理员，不是跨数据库事务，也不创建新的封存凭证。已有发布记录必须包含三库 seal 和 migration 0025 后的图谱快照；旧的双库记录不会被当作三库通过。

对既有已发布测试文档运行集成验收（测试不创建或修改文档，并比较操作前后的完整 head 行）：

```powershell
$env:PUBLICATION_RECONCILE='1'
$env:PUBLICATION_RECONCILE_SANDBOX='<ID>'
$env:PUBLICATION_RECONCILE_TENANT='<TENANT_ID>'
$env:PUBLICATION_RECONCILE_CORPUS='<CORPUS_ID>'
node --import tsx --test scripts/publication-reconcile.integration.test.mjs
```

通过后，无秘密对账报告保存在对应运行目录的 `reconciliation-report-<UUID>.json`。
