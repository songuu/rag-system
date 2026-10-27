# PublicationIdentity 三存储只读核心（2026-10-10）

## 结论与边界

W5 仅依赖已完成的 W1，本轮在继续 W2 的同时交付其独立业务核心：新增 `PublicationIdentity`、`PublicationReadbackSources`、`PublicationReadbackPort`、内存测试 source adapter 与 `createReferencePublicationReadback`。新入口只接受闭集 `{}`，从实际 source callbacks 读取 PG、Neo4j 和 Milvus 完整分页，验证冻结身份的关系，而非要求异构字段都字面相等。

只证明本地读取时观察到的一致性：`consistencyVerified=true`；`productionAuthorized`、`stageAcceptanceComplete`、`sourceAuthenticated`、`linearizableSnapshotProven` 全部固定 `false`。两个完整扫描和新 barrier 不等于跨数据库原子快照，不能作为 mutation permission 或 production acceptance。没有执行实际 SQL/Cypher/Milvus SDK 查询、企业 endpoint/IAM/TLS 验证或真实生产读写。

现有 PG/Neo4j/Milvus API 未改变。source 数据是构造时冻结的合成夹具，不是实时数据库；真实只读 backend adapters、BuildJob/document manifest 持久关系、registry/evidence/runner 接入和完整独立 conformance 仍待实现，所以 W5 继续 open。这里只定义 active publication 身份，不把未接入的空/deactivated baseline 或生产阶段视作已支持。

计划仍为 in-progress 2/13，仅 W0/W1 完成，W2–W9、T16/T17/R18 与 18 项端到端 AC 全部开放。用户直接授权不会补出真实数据/gold、阈值、企业身份、维护窗口或 elapsed 证据。

## 关系与读取合同

冻结 identity 包含 environment/tenant/corpus、graphVersion/`sha256:` artifactDigest/正整数 Pointer revision、按 documentId/version/trust 排序的唯一集合、每文档 count 或 content manifest（至少一项非空），以及 collection/schema/index manifest hash。期望 identity ref 的 canonical digest 必须准确绑定整个 identity；这不是 issuer 签名或防篡改存储证明。

| 来源 | 实际核对关系 |
|---|---|
| PG | Pointer scope/version/revision；同 scope/version/revision 的 activated Outbox，真实 publishedAt 非空且没有 dead-letter；published BuildJob 的 artifactDigest 和完整文档集合 |
| Neo4j | Pointer 与 PG 冻结 identity 一致；active Snapshot 的 scope/version/artifactDigest 和完整 DocumentVersion 集合 |
| Milvus | collection 一致；每页 schema/index manifest 必须为非空 record，再重算 canonical hash；全范围行的 tenant/corpus/document/version/trust、唯一 row ID、连续 chunk index、每行 total_chunks、精确数量及适用的实际内容 digest |

source 原始文档/行顺序可以不同，但重复、超集、子集、未知文档或版本、scope/trust/digest/revision 不一致全部 fail-closed。请求只给 scope/graphVersion/collection selector，不给 expected-document filter，防止把额外行过滤掉后制造一致性。

schema/index 最低形状约束只拒绝缺失、空对象和非 record，不定义真实 Milvus SDK 的必需字段、index 参数或值域；这些仍须由后续真实 adapter 与独立 conformance 完成验证。非空记录加匹配的冻结 hash 不是企业 schema 合法性、真实性或来源认证证明。

Milvus 使用 cursor-bound 全页枚举。每页最多 128 行，completion 与 nextCursor 必须一致；禁止循环 cursor、伪造 cursor、空的未完成页。读取按冻结的 maxPages/maxRows 停止，不自动截断为通过。配置 maxPages=1..256、maxRows=1..65536；单扫描实际还受 128*maxPages 页容量约束。超出 profile 不能作为完整验证。每文档检查所有位置 0..total-1，无缺口/重复，global chunk ID 也必须唯一。

内容 manifest 对实际 UTF-8 content 重算 SHA256，并以 chunkIndex/ID 排序的 `{chunkId,chunkIndex,contentSha256}` canonical array 计算 digest。数组成员流式进入 hash，避免大文档被单对象 canonical 256KiB 上限偷偷截断。公开 helper 同样验证完整单文档集合、字段、数量、唯一性和位置。单页、配置和输出继续受原 canonical profile 的 256KiB 上限，单 content 最多 65536 UTF-8 bytes；不记录原始 content。

读取顺序：PG → Neo4j → Milvus full scan 1 → full scan 2 → Neo4j barrier → PG barrier → actual completion clock。两次实际 row manifest/count 必须相同，两个 graph 来源前后完整数据 hash 必须一致；count-only 文档内容在扫描期间变化也会拒绝。

Outbox acknowledgement 必须不晚于最后真实 clock reading 的完整 uncertainty **下界**，不能以旧 correlation label 或未来时间证明确认已完成。每次 source callback 前读取 actual challenged clock，完整 uncertainty 位于 observation window；同一 reader 的真实 clock cursor 和 challenge 集合跨 invocation 保留，成功不缓存。context 的 reader/auth digest 只是本地相关性标签，不冒充 IAM。

source proof 精确绑定 source/profile/ref、context、selector、cursor、独立 challenge 和重算 dataHash。每次调用都是 fresh read；proofHash、实际 completionClockHash 与 observationHash 进入 confidential 输出，但不暴露原始 passage content。reference source 全局跨三个方法拒绝 nonce replay，检查 scope/run/selector/reader/auth/window、容量和 availability，没有 mutation/任意查询接口。

设每个 scan 为 P 页，一次成功会话 source reads=4+2P、clock reads=5+2P、独立 challenges=9+4P；私有最大额度为 `maxVerifications*(9+4*maxPages)`，并独立限制 invocation 次数。maxVerifications=1/maxPages=2 支持夹具完整路径，没有重建或重置 clock/challenge。callback 在 await 前 descriptor-safe 捕获；配置/请求/返回值快照冻结，拒绝 getter/Proxy/thenable hooks。UNKNOWN timeout 或非法 carrier 永久 halt，迟到完成不继续 source IO；并发调用 busy fail-closed。没有 stage authorization 消费或控制面 mutation。

## TDD 与失败保留

- 入口缺失 RED：`node --test --test-timeout=30000 --test-name-pattern="publication identity validation, source adapter" src/lib/knowledge-graph/publication-identity.test.mjs`，0/1、exit=1，实际工厂 undefined；stdout SHA256 `f0dd3db797e7480cc7783529680af2c6fa48a5adf03685a2dd2702a271355759`，duration_ms=88.1499。
- 首次实现 21/22、exit=1；stdout SHA256 `8e0dde6c6eefa8410a6d26220bdc91e20e3bc69db88b705da329ac9cd8fd0765`，duration_ms=273.9806。失败是 UNKNOWN 夹具正常手动 release 后，t.after 再次执行实际同 nonce source read，触发正确的 source-replay 拒绝。将测试 release 设为一次性，没有放宽实现的 replay 门禁或原测试 deadline。
- actual acknowledgement RED：`node --test --test-timeout=30000 --test-name-pattern="Outbox acknowledgement cannot originate" src/lib/knowledge-graph/publication-identity.test.mjs`，0/1、exit=1、Missing expected rejection。实际 callbacks/proof hash 都有效，但 publishedAt=06:02、最后 actual clock=06:01 仍被原 composer 接受。stdout SHA256 `4249cac009075b958073bb74f6738c2f3e9afdc0bfc61f96b7fc49e03e25aa30`，duration_ms=104.6579。
- 修复后同时覆盖未来 acknowledgement 与 observedAt=acknowledgedAt/1000ms uncertainty 情况，均不得超过 actual completion lower bound。expanded 23/23、strict18/lint2 green；首次修复后 stdout SHA256 `b76f7ac90cfb74287bbf2c09fbc66922ea78071756a9835f561d67304e993e43`、duration_ms=288.5219；77 文件无漂移。

23 项还覆盖完整三来源关系、count-only/content-only、乱序与重复、全部 scope/版本/trust 替换、schema/index hash、分页/上限、两扫描及 graph barriers 漂移、成功不缓存、最小会话额度、caller 标签、配置漂移、并发 busy、expiry/sequence、UNKNOWN/迟到完成和恶意 hooks。

补充审查发现并独立复现 HIGH 本地业务完整性漏洞：原源码 `9a7169324bc37e8a73802514a92c06949cf140d38dd4d74b70061c898b58d237`、原测试 `c0fa4572a7e49773a85bf087d9b4aee04b09760fcac45ae70fdb4a65699b2781` 仅按 hash 接受清单。分别将 schema/index 清单设为 null、空对象、字符串、数组，同步冻结相同值的 expected hash 和 identity ref 后，实际 source/clock/core 8/8 返回 consistencyVerified=true。不是企业授权升级，但违反缺失清单 fail-closed；此前 bounded APPROVE 已撤回，不能作为当前代码的验收。

新增 RED：`node --test --test-timeout=30000 --test-name-pattern="Milvus missing or non-record manifests" src/lib/knowledge-graph/publication-identity.test.mjs`，UTC 05:38:02.745–05:38:02.877，0/1、exit=1、Missing expected rejection，duration_ms=101.6533，stdout SHA256 `24b2a33f2de6c44f4a6ff0d4c53772629bb47d0f79a8312c61705d2868ba1e76`。执行前后旧源码未变，新测试 SHA256 `7139ae8c63c5faf3c518bc08575dad2f56e41371ad0d87126c46a2bd802b641d`。核心每页读取加入非空 record 最小检查，不只防住 fixture factory，也不放宽原 hash 匹配。

新 aggregate 测试共实际覆盖两种清单 × null/空对象/string/array/number/boolean 12 种值，同值预期 hash 也须拒绝；失败时不继续扫描或 barrier。修复后首轮 publication24/24，UTC 05:39:01.937–05:39:02.283，duration_ms=313.7094，stdout SHA256 `05cfdd6a578721cce62000afba9c65a65229dc0b497cc8bc7087cdb7968ee52b`；strict18/lint2 exit=0，77 个保护文件 drift=[]。全部原有 23 测试保留，完整当前源身份验证另列。

首次全组合发生既有 Ask 容量用例失败：`POST maps durable result capacity exhaustion to 503` 在 route.test.mjs:1982 的第一个请求 actual=500/expected=200，不是第二个容量耗尽请求的 503 断言。692 项中 691 pass/1 fail，exit=1、duration_ms=20586.073，UTC 05:24:39.102–05:24:59.725，stdout SHA256 `14ee790936945cbbe959da280de3515cc4ecc5e3d0c7e4d3c473fe68dfdb9df9`；77 文件无漂移。未更改 Ask 代码/夹具/env/原预算。

原预算该 Ask leaf 隔离诊断 1/1、exit=0、duration_ms=1106.4422，stdout SHA256 `e401e417a70a90e7b50cf49d723947d0b8fc32b5044c0c0c25bed45cd5e42df2`。随后同一 source/test identity 和完全相同 35 文件原条件复核 692/692，见下表。单例或后续绿色不能证明根因已解决；实际原因仍未知，首次失败及既有 Ask 503/200、500/200、EPERM、journal/nonce UNKNOWN、30s timeout 等历史证据均保留。

## 验证证据

原 `node --test --test-timeout=30000`；没有 skip/preload、deadline 放宽、concurrency/isolation 改动或持久环境切换。仅测试子进程 `RAG_SEMANTIC_ROUTER=off` 沿用基线；外层观测 90s/16MiB 输出。下表 UTC，全部 exit=0、stderr 空，测试 fail/cancelled/skipped/todo 均 0；首次累计失败另列，不抹去。第一表保留 manifest 修复前旧 source/test 的结果，不冒充当前身份验证。

| 检查 | UTC 起止 | 结果 | duration_ms / stdout SHA256 |
|---|---|---|---|
| strict18 | 05:24:15.347–05:24:16.473 | exit 0，stdout/stderr 空 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| lint2 | 05:24:16.473–05:24:17.899 | exit 0，零 warning | 同上 |
| publication23 | 05:24:17.899–05:24:18.228 | 23/23 | 296.3036 / 7ca2add068468b7777d17ace64ff3ed1a94fcf14194f2847b54359cba3942402 |
| local24 | 05:24:18.228–05:24:39.101 | 549/549 | 20835.6529 / 91450b7b630a67b7f14854ce57d4bd5970aee162cf32f4a17d6e661fa83190e5 |
| cumulative35 复核 | 05:26:48.916–05:27:10.001 | 692/692 | 21043.6194 / da641b36414b3b9bf35d07bd5b2dc4984f24be0b999d239f0903d91e3cf81d9a |

修复 manifest 后，下列同条件全验证使用本报告最终 source/test SHA；两个新增文件外的原 75 文件未变。外层退出码同时反映任何子检查失败或 snapshot 漂移，不将 child fail 藏在 exit=0 中。实际全部子检查及外层最终 exit=0；不是仅启动或观测超时状态。

| 检查 | UTC 起止 | 结果 | duration_ms / stdout SHA256 |
|---|---|---|---|
| strict18 | 05:40:11.324–05:40:12.472 | exit 0，stdout/stderr 空 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| lint2 | 05:40:12.472–05:40:13.918 | exit 0，零 warning | 同上 |
| publication24 | 05:40:13.918–05:40:14.290 | 24/24 | 337.5113 / d8916c6f3800e6f7022b9169ed8fb641434b297ae61da7828244bd8b7568b940 |
| local24 | 05:40:14.290–05:40:35.092 | 550/550 | 20763.1045 / d0444a477d2aef835df265ff1cde046e0a8b3d893be076eb0efab05de1395c61 |
| cumulative35 | 05:40:35.093–05:40:56.633 | 693/693 | 21502.4167 / 5480d36bfb4666058ac589198294900237f9a602c4f237e71968fb2cff0ef74c |

最终 693/693 不抹去此前 691/692 的 Ask 失败、也不证明其未知根因已解决；manifest 修复的实际 RED 和读取端最小 guard 才是本轮明确修复证据。

strict18：`node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`；上轮 `2026-10-10-rag-provider-evidence-readback.md` 的 eval 17 模块加 publication-identity.ts。lint2：`node node_modules/eslint/bin/eslint.js --max-warnings 0`，检查下表两个新文件。

local24：上轮 local23 加 publication-identity.test.mjs。cumulative35：该 local24 加 eval dataset/metrics/gate/matrix/production-policy-contract、context-composer-v2、legacy-evidence-adapter、KG contracts/postgres-publication-store/graph-snapshot-recovery、Ask route 共 11 文件。Ask 隔离 leaf 仅为诊断，不替代累计范围。

77 个 source/test/fixture/request-validation 文件执行前后 SHA256 一致（drift=[]）；上轮 75 文件加两个新文件。本轮仅新增并修复下列 source/test；未编辑原 provider、authority、PG/Neo4j/Milvus、Ask、UI 与用户无关 dirty edits。77 文件范围不冒充整个工作树的身份审计。

| 文件 | SHA256 |
|---|---|
| src/lib/knowledge-graph/publication-identity.ts | 65704bfba5d29f5e2cf66404156dd2699a9b564d02d0642561723dd6bf6261e4 |
| src/lib/knowledge-graph/publication-identity.test.mjs | 7139ae8c63c5faf3c518bc08575dad2f56e41371ad0d87126c46a2bd802b641d |

`git diff --check` exit=0，30 条既有 LF→CRLF 提示保留。未 commit/push、写 learning/Compound、改 env/生产策略、发流量、触发 fault/cleanup 或创建 acceptance harness binding。当前计划两个规范 binding 路径均不存在，使用宿主本地验证，不启动外发 Harness。

## 独立审查

原 source/test 的 43/43 功能测试和初始 bounded APPROVE 已被补充 manifest finding 撤回，不作为修复后验收。

修复后功能/安全独立复审明确关闭原8值 finding；按最终 source/test SHA，实际 `node --test --test-timeout=30000` 运行 publication-identity、KG contracts、postgres-publication-store、graph-snapshot-recovery 四文件，44/44（24+4+13+3），fail/cancelled/skipped/todo 均0、duration_ms=330.5007、exit=0；审前后 source/test SHA 与本报告最终表一致，没有编辑文件或生产 IO。结论为 bounded APPROVE，仅限 provider-neutral 最小结构修复，不代表完整 SDK schema 语义、W5 或原子快照验收。

随后串行 TypeScript/async 专项复审回报 bounded APPROVE：独立 strict18/lint2 均 exit=0，未重复测试、未编辑文件，审前后 source/test SHA 与本报告最终表完全一致；核查 descriptor-safe/native Promise、UNKNOWN halt/迟到完成、跨 invocation 时钟/challenge、完整额度、分页/chunk hash、双 scan 和实际完成下界。该结论同样不升级真实 SDK schema 语义、生产来源认证或 W5 整项。旧 W2 审查结论、子 agent 启动、中间状态或主 agent 回归没有被计作当前独立 APPROVE。

## 下一步

继续 W5 真实只读 backend adapters 与持久 BuildJob/document manifest 关系、PublicationIdentity artifact/evidence/runner 接入及完整独立 conformance；不以 fixture snapshot 替代真实后端。并按既定依赖继续 W2 的共同 ports/实际测量/behavioral suite/recovery/renewal、W3/W4 runner/computed machine gate、W6–W9 与生产阶段。所有本地及生产剩余范围保持，不缩小目标，也不把本轮核心单元验证计作 W5 整项完成。
