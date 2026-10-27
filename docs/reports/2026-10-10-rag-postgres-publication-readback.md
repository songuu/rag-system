---
type: implementation-evidence
date: 2026-10-10
status: local-increment-verified-reviewed
task: W5
production_authorized: false
---

# W5 PostgreSQL 实际业务回读与完整文档清单持久化

## 结论与边界

本地增量在修复三项独立审查 HIGH 后已通过 native PG17 实测 3/3、定向单元测试 49/49、累计 41 文件 751/751、strict22 和 lint10；新身份的串行功能/安全、TypeScript 终审均 bounded APPROVE。本报告不宣称 W5 整项、阶段验收或生产授权完成。计划仍为 2/13；11 个任务、18 项端到端 AC 保持开放。

本次使用 Work 的 RED→最小修复→扩大验证流程；Postgres Best Practices 影响了参数化单 SELECT、复用现有组合索引、避免新增权限与 DDL 的实现选择。

完成内容：

- 新增闭集 `kg-build-publication-manifest/v1`：绑定 tenant/corpus/graph/artifactDigest 和完整、排序、无重复的文档 ID/version/trust 清单；1–512 文档；规范化脱离输入引用并深冻结。结构校验不等于生产者 provenance。
- worker 从实际 `getCompatibilityDescriptor` 与 `getSnapshot` 获取已完成 Snapshot，核对 scope/version/digest 和完整文档集合；当前 worker 的服务器持有 documentIdentity 为单文档任务，因此明确要求 singleton 精确相等，不假称支持多文档构建任务。
- `completeValidated` 在同一 UPDATE 中检查运行态、所有权 token、实际未过期租约、manifest scope/version，并原子保存 digest 和完整 manifest。禁止通过 enqueue/transition 直接写入保留的 publicationManifest/documentIdentity。
- 新增 `PostgresKnowledgeGraphPublicationReadback`。只接受冻结本地配置和闭集 `{}`；实际执行一次参数化 SELECT，将当前 Pointer、对应 revision 的 Outbox、对应 graphVersion 的 BuildJob LEFT JOIN。缺失、未发布、未确认、死信、歧义、scope/version/revision/digest/manifest 不一致均拒绝。不按 caller 期望图或文档过滤，不使用 LIMIT 1 隐藏异常。
- 捕获安全 query callback；拒绝 getter/Proxy/thenable、不透明或多余数据；有界 read/timeout、busy 拒绝、UNKNOWN 永久 halt，无迟到成功缓存和自动重试，静态脱敏错误。

这是 **业务数据 adapter**，不是 PublicationSource proof issuer。`executionProfile=local-reference`、`productionCapable=false`；environment 仅为冻结部署标签，并非已认证数据库环境。未接入实际 registry/evidence/artifact/runner；不证明独立 read-only IAM、TLS/DNS 信任或跨库原子快照。

PG Read Committed 的普通 SELECT 使用语句开始时快照，本实现据此使用一个 SELECT 读取关联数据，而非将数次 SQL 拼装为单一观察；仍不构成跨库线性化证明。[PostgreSQL 17 事务隔离说明](https://www.postgresql.org/docs/17/transaction-iso.html)

## 真实 RED 与修复

| 用例 | UTC / 退出码 | 实际结果 / stdout SHA-256 |
|---|---|---|
| 原子持久清单的初始 RED | 06:01:15.251–06:01:15.405 / 1 | 0/1；旧 SQL 未保存清单和 scope 条件；`a7690c46c2f7dc85656cc3d7adfde715510fc4635eb7ad134d1d7a81d5687da3` |
| codec 入口 RED | 06:02:57.447–06:02:57.527 / 1 | 0/1；入口缺失；`0378731b7a1e17e80789756272f6671b9b24a80efbd2322294d3146dcccaf9dd` |
| native readback 入口 RED | 06:02:57.527–06:02:57.603 / 1 | 0/1；入口缺失；`5c7bf6b17147e1629a5dabdaf4e2e06c08f62a10dc3773d8fad434076bb6a1e3` |
| 初版四文件单元绿色 | 06:08:32.806–06:08:33.157 / 0 | 41/41；317.5965 ms；`1d5cd3b6f02ef2e896e2e83bddd322aead90ef86e97e4214d3e52a14cefc9210` |
| 首次真实 PG17 RED | 06:13:01.172–06:13:01.416 / 1 | 0/2；微秒确认时间被截断、已过期 token 仍完成；`04b48d01a0e601dde8951487a8e5912a39283bd0f0c7f71fa9069eccd8f47b6f` |
| 扩展真实 PG17 RED（可观察终态） | 06:19:59.669–06:19:59.929 / 1 | 0/3；227.017 ms；另含事务中途过期仍完成；`95c6557732173b90c17793bee970f4f8875a8ea88d8dc2d5bf1a9ae2d2481135` |

一次扩展 RED 输出在上下文中被截断，未采用其不可观察统计。上表 06:19:59 运行用于补齐实际终态证据，不将截断输出伪装为已确认成功/失败。

修复一：将 Outbox acknowledgement 从 PG 微秒转换为协议毫秒时使用 **CEIL**，避免把真实确认时刻向前移动。真实引擎覆盖 `.000001→.001`、`.999999→下一秒.000`、精确毫秒不变、`.123456→.124`；缺失 ack 仍拒绝。

修复二：完成构建要求 `lease_expires_at > clock_timestamp()`。真实第三用例在同一事务内证明 `lease_expires_at > now()` 为 true，但实际租约已过期；旧实现错误完成，新实现拒绝。`now()` 固定于事务开始，`clock_timestamp()` 是实际当前时间。[PostgreSQL 17 时间函数说明](https://www.postgresql.org/docs/17/functions-datetime.html)

上述三个引擎用例不覆盖多连接锁等待期间到期、跨实例 fencing 或 lease authority conformance；本次 SQL guard 不作为完整 W6 租约证明。

未通过调大超时、skip、放宽 Oracle、伪造 source proof、回退缺失 manifest 或改成 caller 宣告的 inventory 取得绿色。

## 初审前验证结果（非最终放行）

| 检查 | UTC / 退出码 | 结果 / stdout SHA-256 |
|---|---|---|
| 修复后本地 PG17 | 06:22:00.388–06:22:00.657 / 0 | 3/3；235.4039 ms；`76c84241d001024da6aa5b83d79b683ab66005ff448892cc1baebcb8f1a4e6a8` |
| 四文件单元 | 06:22:09.037–06:22:09.389 / 0 | 44/44；318.3581 ms；`cdff32f7c5d142c349a5b64acf621d4f5dd89203fc2408e347cd33c5d3962cb7` |
| strict22 | 06:24:08.807–06:24:10.853 / 0 | stdout/stderr 空 |
| lint10（max-warnings=0） | 06:24:10.853–06:24:12.457 / 0 | stdout/stderr 空 |
| 累计 41 文件 | 06:24:12.457–06:24:34.397 / 0 | 746/746；21896.7478 ms；`b5216535fe24f6e9a7abd8ec58840e0caee4a8086ce8b46b1d30f926d6bad845` |

所有测试的 fail/cancelled/skipped/todo 均 0；stderr 空。空 stdout/stderr SHA 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。验证前后 91 个源码/测试身份 `drift=[]`，旧 PublicationIdentity 两文件身份保持不变。

实际子进程使用原 `node --test --test-timeout=30000`，父进程 90s、16MiB 输出上限，只有子进程 `RAG_SEMANTIC_ROUTER=off`。不改全局环境、隔离模式、并行度或预加载。四文件单元名单：build-publication-manifest、postgres-publication-readback、postgres-graph-build-store、scripts/graph-control-worker。脚本内部旧标签 `native51` 只是误估标签，权威 TAP 统计是初版 41、最终 44，不宣称 51。

累计名单保留上次原 35 文件（17 eval 模块 + 6 authority writer/readback tests + PublicationIdentity + 原 11 合同/Ask 回归），新增上述四文件以及 local-graph-build-executor、auto-build 两文件；不是替换或缩减原 35。strict 使用既有 17 eval TS + PublicationIdentity + 本次 4 TS，参数：`--noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`；lint 精确检查下列 10 文件。

实际定向/引擎测试子进程 argv：

```text
node --test --test-timeout=30000 src/lib/knowledge-graph/build-publication-manifest.test.mjs src/lib/knowledge-graph/postgres-publication-readback.test.mjs src/lib/knowledge-graph/postgres-graph-build-store.test.mjs scripts/graph-control-worker.test.mjs
node --test --test-timeout=30000 src/lib/knowledge-graph/postgres-publication-readback.integration.test.mjs
```

累计 41 文件的完整闭集名单（均 `.test.mjs`，不是 glob）：

- `src/lib/rag/eval/`：canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance、production-authority-ports、production-authority-approval、production-authority-conformance、bounded-provider-call、production-provider-registry、production-authority-receipts、production-provider-evidence。
- 同一 eval 目录的原 6 authority tests：production-authority-receipt-writer、production-manifest-authority、production-approval-provenance、production-existing-receipt、production-predecessor-receipt、production-authority-bundle-writer。
- 原 11：同一 eval 目录 dataset、metrics、gate、matrix、production-policy-contract；`src/lib/rag/core/context-composer-v2`、`src/lib/rag/retrieval/legacy-evidence-adapter`、`src/lib/knowledge-graph/contracts`、`src/lib/knowledge-graph/postgres-publication-store`、`src/lib/knowledge-graph/graph-snapshot-recovery`、`src/app/api/ask/route`。
- `src/lib/knowledge-graph/publication-identity`，新增上述四个定向文件与 `src/lib/knowledge-graph/local-graph-build-executor`、`src/lib/knowledge-graph/auto-build`。

## 本地数据库安全边界

每次执行前核对实际 Docker inspect：容器 `rag-system-postgres-1` running、image `postgres:17-bookworm`、host binding 严格为 `127.0.0.1:5432`；真实 server_version_num 为 PG17。凭据从该已验证容器仅在父进程内存读取，只传入子进程 TEST_DATABASE_URL，未输出、写文件或改全局环境。

测试 requires 显式 `RAG_PUBLICATION_LOCAL_TEST=1` 与 TEST_DATABASE_URL，且只接受上述 loopback 端口；没有 skip/fallback。每例独立随机租户/corpus，BEGIN、SET LOCAL 5s statement_timeout、只操作自身 fixture；finally ROLLBACK，随后真实查询该租户 count=0，最后关闭客户端。没有 DDL、角色/grant/migration、global claim、触碰其他租户或生产写入。

`scripts/postgres-integration.test.mjs` 仅补齐新必需 manifest 参数并 lint；其整套 DDL/role/global-claim 集成流程本轮 **未执行**。native 三用例是本次真实 PG 验证，不冒充完整旧集成套件。

Node 现有 MODULE_TYPELESS_PACKAGE_JSON 警告保留，不为此改 package 类型。历史 Ask 容量及 approval/timeout/EPERM 等未知失败均保留在上游报告，本轮 746 绿色不证明它们已根治。没有 commit、push、Compound、自动学习或生产权限更改。

## 初审前源码与测试身份（审查已退回）

| 文件 | SHA-256 |
|---|---|
| `src/lib/knowledge-graph/build-publication-manifest.ts` | `e0312f344cc446c0c69c803b6eb78c2ff1c6e40fe4d1ed82b69eae5f3c60fdbc` |
| `src/lib/knowledge-graph/build-publication-manifest.test.mjs` | `b3ebf800296068dbdf9711a7adb94d9d010a7370cd63385759e6d0640beefcb8` |
| `src/lib/knowledge-graph/postgres-publication-readback.ts` | `ef11131a6ca10b7271216e5111d08c803b08f0a7e02dd0cb7912a10010fb731b` |
| `src/lib/knowledge-graph/postgres-publication-readback.test.mjs` | `9e25c355fdcec44656d7088b144eabd248e2a2449e4ab7a756d981e94941219b` |
| `src/lib/knowledge-graph/postgres-publication-readback.integration.test.mjs` | `ae20db0119520ae2d972bdd29c4799f1ec6ddf1a838814e2c1f76ed21c1638da` |
| `src/lib/knowledge-graph/postgres-graph-build-store.ts` | `2c6300c4cce8d418627e996303b0b961b140df5a7861c8abab39cf70262fa96b` |
| `src/lib/knowledge-graph/postgres-graph-build-store.test.mjs` | `022399402ec1e55a337ca642c8180800670df885aa0048449a1096a08512b197` |
| `scripts/graph-control-worker.ts` | `db4d34a4e62becd4a56144e022b56ddb9b177d7ce2b6603ae39bebd1a7a24dd6` |
| `scripts/graph-control-worker.test.mjs` | `9d1e08c66c14889ecdb73fb32a3ae07c46ab53129c6bdf61b3f80c21f54255cd` |
| `scripts/postgres-integration.test.mjs` | `f0ca410adbb6c43973a2a59c723176aad2226f504052edb1c01b1088febf94c3` |

## 独立审查与剩余任务

初审在上表 44/746 绿色、10 文件无漂移的版本中实际发现两个 HIGH，结论为 REQUEST CHANGES。不能用测试绿色覆盖审查发现：

1. `normalizeMetadata` 在原对象上先查 keys，再 stringify/structuredClone；enumerable getter 可在检查后注入 publicationManifest，旧 `metadata || $8` 覆盖持久清单。审查纯内存 PoC 实际 hooks=2/queryCount=1/writtenKeys 含 publicationManifest/返回 published。
2. 新 ASCII documentId/version 限制与旧 MiroFish/KG opaque 文本合同不兼容。旧入口实际接受课程甲、doc/a、版本/一；完整 Snapshot worker 路径却 validated=0/retried=1。

主 agent 独立 RED：

| RED | UTC / 退出码 | 实际结果 / stdout SHA-256 |
|---|---|---|
| metadata getter 注入 | 06:33:53.801–06:33:53.951 / 1 | 0/1；缺失预期拒绝；118.0912 ms；`6507319718f757c46d1edf238af54b0727ddd532bdddecb3c70f67e82511ecec` |
| opaque codec 兼容 | 06:33:53.952–06:33:54.068 / 1 | 0/1；合法身份被拒；85.6815 ms；`d1cb13bcc04721adb67a2f9c9e7aa653bab809e59cdc95d0dae2c8fe1c118126` |
| opaque 完整 worker 路径 | 06:35:31.989–06:35:32.301 / 1 | 0/1；validated 实际0/期望1；280.3502 ms；`2f8e3d330900d371f37e912066fccb5726cbbac8e36f5f771e2d902c0cdd5127` |

修复：metadata 先 canonicalJson 拒绝 hooks，再 JSON.parse 为 detached record，检查 16KiB 和 reserved keys；后续不再读原对象。负测覆盖 transition/enqueue × getter/nested-getter/toJSON/Proxy，要求 0 hooks、0 query、0 transaction。文档 codec 沿用 KG `maxIdentifierCharacters`（512）、非空、精确已归一化文本、无 U+0000–U+001F；中文/slash/version 精确保留，仍排序/去重/绑定 digest。新完整 worker 正向用例覆盖三组旧合法身份，native readback 和真实 PG fixture 同时使用 opaque identities。

修复后定向 48/48（06:36:41.785–06:36:42.133，313.8736 ms），stdout SHA `535642d32f0ed700f979dfe799994327e2497f66fe6a8f89924e4c7dcfd786f6`；真实 PG17 3/3（06:36:34.009–06:36:34.277，234.0369 ms），stdout SHA `4c2ddb089689475da074e40ce834b3800fd7ad3efdffdb6a9afee9ce3b35f29a`。均退出0，fail/cancelled/skipped/todo=0，stderr 空。

新 SHA 功能/安全复审终态为 bounded APPROVE：原注入 PoC 实际拒绝，hooks=0/SQL=0；三个旧合法身份在实际 InMemory 合同及 worker 链均 validated=1/retried=0/complete=1/register=1。独立原预算四文件48/48、324.8389 ms、exit0，fail/cancelled/skipped/todo=0，10 文件审前后 SHA 与下表一致、drift=[]。复审 PoC 首次脚本导出名拼错导致 exit1，纠正后完整 exit0，记录为诊断脚本错误而非源码失败。集成文件只读审查，没有重复 DB IO；未编辑或提交。

串行 TypeScript 专项在该版本独立 strict22/lint10 退出0，但提出第三项 HIGH，终态 REQUEST CHANGES：completeValidated 比较及组装 SQL 时两读 input.artifactDigest，合法动态 getter 可导致 SQL 保存 digest B、同次持久清单为 digest A。该结论来自静态路径，审查者未运行复现或 DB；主 agent 随后独立实证如下。

修复后最终扩大验证：strict22（06:37:40.578–06:37:42.480）、lint10（06:37:42.480–06:37:44.002）均退出0、stdout/stderr 空；累计41（06:37:44.002–06:38:06.047）750/750、fail/cancelled/skipped/todo=0、22002.2031 ms、exit0，stdout SHA `af0c84e69c1d789ea35ec2481919cc08dd0e5505f34eb42a9beccb82ea6908f0`，stderr 空。91 个源码/测试运行前后 `drift=[]`，原 35 文件、预算和环境条件不变。

两项 HIGH 修复后的版本身份（随后 TypeScript 专项发现 digest 漂移，非最终放行版本）：

| 文件 | SHA-256 |
|---|---|
| `src/lib/knowledge-graph/build-publication-manifest.ts` | `269250f8fd9f60531cc672af7838073ff8c6b049175a354d9f75881630acc296` |
| `src/lib/knowledge-graph/build-publication-manifest.test.mjs` | `8a7be6348c090f9e9ec824481190417bcede81d4c8d4f0258423a28020bf3d06` |
| `src/lib/knowledge-graph/postgres-publication-readback.ts` | `ef11131a6ca10b7271216e5111d08c803b08f0a7e02dd0cb7912a10010fb731b` |
| `src/lib/knowledge-graph/postgres-publication-readback.test.mjs` | `deadebdd29993f19b1e21bd70947dc1dc45a62fea668a2768e683711c2fd4b6a` |
| `src/lib/knowledge-graph/postgres-publication-readback.integration.test.mjs` | `3b05dcef5f459cf0e0aaafef124bbf8187ad1cfb0de96bad5a245e480bd11195` |
| `src/lib/knowledge-graph/postgres-graph-build-store.ts` | `2c66d9e8e223decb7663c21ea7b3e6e4230ee4c48fc0831efff970a7eabb3951` |
| `src/lib/knowledge-graph/postgres-graph-build-store.test.mjs` | `cb0b955681c790ba4d5e7634c827d92ae7f074d64a64761ff7d42e642ef1a22a` |
| `scripts/graph-control-worker.ts` | `db4d34a4e62becd4a56144e022b56ddb9b177d7ce2b6603ae39bebd1a7a24dd6` |
| `scripts/graph-control-worker.test.mjs` | `fd651729befaa0f25274bf0958fb17a9858e9c47154ffd9c4dc9d02ce2cfb894` |
| `scripts/postgres-integration.test.mjs` | `f0ca410adbb6c43973a2a59c723176aad2226f504052edb1c01b1088febf94c3` |

## 最后两文件 delta：digest 单次观测绑定

主 agent 实际 getter RED：06:51:59.130–06:51:59.307，0/1、133.8301 ms、exit1，SQL 参数为 B/manifest 为 A；stdout SHA `b2a936238f50a443a57cd25b9311980b5eae632e020870c12891af1cd0b13675`，stderr 空。修复仅捕获 `const artifactDigest = input.artifactDigest` 一次，并将该值同时用于原严格比较及 normalizeDigest/SQL 参数；不扩大整个旧 completeValidated API 的合同。新测试要求两份 digest 相等且 getter 读取次数恰为1。

最终验证（原预算/名单/环境条件保持不变）：

| 检查 | UTC / 退出码 | 实际结果 / stdout SHA-256 |
|---|---|---|
| 四文件单元 | 06:52:56.463–06:52:56.833 / 0 | 49/49；335.6425 ms；`c6184c34faa4e77716548eb259bf5d090a2a0392405dcbbe6e8a24c3faaca530` |
| strict22 | 06:53:42.843–06:53:44.787 / 0 | stdout/stderr 空 |
| lint10 | 06:53:44.787–06:53:46.318 / 0 | stdout/stderr 空 |
| 真实 PG17 | 06:53:54.380–06:53:54.789 / 0 | 3/3；364.6675 ms；`33bf61d75339907460a5ea4da846ca26677bfbb3e74e46962c5d4dbb22faf759` |
| 累计41 | 06:53:46.319–06:54:08.728 / 0 | 751/751；22368.6375 ms；`1101f36e12ba85ac2b6eae50e245ddd8ad56660c235ab73abf288e0600086c34` |

测试 fail/cancelled/skipped/todo 均0，stderr 空；91 文件 drift=[]。其余8文件 SHA 与上表相同；最后变更的2文件如下。旧 44/746、48/750 绿色及各轮 REQUEST CHANGES 仅作为历史中间证据保留，不代替本次身份的复审。

| 文件 | SHA-256 |
|---|---|
| `src/lib/knowledge-graph/postgres-graph-build-store.ts` | `efa8a85851031619eadeb2b9fb90f107a864b405f6879a4b1b7fa66985035c39` |
| `src/lib/knowledge-graph/postgres-graph-build-store.test.mjs` | `de5c051a2b45b6388a296021ec3f4317f752fe08ed9ccac730ec13af4bcbdfd3` |

最后两文件 delta 已按新身份串行终审：功能 bounded APPROVE、独立 `node --test --test-timeout=30000 src/lib/knowledge-graph/postgres-graph-build-store.test.mjs` 实际16/16、139.213 ms、exit0、fail/cancelled/skipped/todo=0；TypeScript bounded APPROVE、独立 strict22/lint10 均exit0，不重复单元/累计/DB测试。两个 reviewer 均核对新两SHA及其余8身份与前轮一致、10文件审前后drift=[]；未编辑、提交或DB/外部IO。以上不是复用旧SHA结论，也不是完整W5验收。

主 agent 最终 `git diff --check` 退出0；35条 LF→CRLF 警告保留，不宣称工作树 clean。报告最后一组10份SHA与真实文件一致、sourceTableFinalDrift=[]，最终751/49、失败证据及production_authorized=false均读回一致；既有 staged/dirty 文件未清理或提交。计划2/13、11open、18未勾选AC已读回。

W5 仍缺 Neo4j/Milvus 实际只读 adapters、SDK schema/index 必需语义、native business data→Source proof/private binding、完整 registry/evidence/artifact/runner 接入、真实独立 conformance；active-only readback 不冒充 empty/deactivated baseline。W2–W9/T16/T17/R18 未关闭，生产真实输入、阈值、维护窗口和企业 authority 仍须按原门禁满足。用户直接授权不替代这些机器可验证事实。
