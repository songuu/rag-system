---
type: implementation-evidence
date: 2026-10-10
status: local-increment-reviewed-regression-open
task: W5
production_authorized: false
---

# W5 Neo4j / Milvus 实际业务回读与统一身份容量

## 范围与结论边界

本轮按 Work 的真实 RED → 最小实现 → 实际引擎 → 独立审查 → 扩大验证流程，继续既有完整架构目标，不另建缩减任务。本文冻结切片已完成真实引擎、窄测和双审，但累积回归仍有明确失败；不是 W5 或完整目标完成凭据。下一轮 reader UNKNOWN 修复会产生新的 core 身份，不能沿用本文旧身份批准。

计划仍是 2/13、11 个任务开放、18 项端到端 AC 未勾选。新增适配器是 `local-reference` 的**实际业务数据回读**，不是内存数据冒充数据库，也不是 PublicationSource proof issuer。`productionCapable=false`；环境仅为冻结本地部署标签，不证明企业环境、IAM、TLS/DNS、artifact provenance、零 SDK 重试或跨库原子快照。W5 整项保持 open。

## 实现内容

- 统一 PublicationIdentity 保留既有 opaque 中文、路径/标点式文档 ID、版本和 chunk ID：精确比对、禁止隐式 trim、C0 控制字符和超过 512 字符；tenant/corpus/graph/collection 等选择器仍按原安全规则验证。
- `maxPages` 从 256 修正为 1024，使原声明的 65,536 短行上限可在每页至多 128 行的两次完整扫描中达到。完整 proof 日志仍遵循原 256KiB canonical profile，不修改全局编码合同。超长正文或页/byte/proof 预算超限必须明确失败，不能把前缀宣告为完成。`chunksHash` 原本已有流式实现，本轮没有该处缺陷或修改。
- Neo4j 一次固定参数 Cypher 获取实际 Pointer 的 `activeGraphVersion`、当前 Snapshot 及所有 `CONTAINS` 文档。按真实节点分组，不用 LIMIT / DISTINCT，不按期望文档、trust 或状态过滤来隐藏歧义、重复边或跨 scope 文档。核对 active Snapshot、真实整数 revision/count、digest、完整文档集合和每个文档的 scope/version；真实文档 status 是 staging，不能误要求 active。
- Neo4j 映射真实官方 Record / Integer / Result，并拒绝 getter、Proxy、危险载体控制字段和多次业务回调。区分已完成的已知失败与仍未完成的 UNKNOWN；UNKNOWN 永久 halt，不发第二次业务 Cypher，结束后的迟到回调也不得发查询。SDK 内部可能重试，不能据此宣称零网络重试。
- Milvus 直接 Strong scope-only count/query，参数模板传递 tenant/corpus 和完整 `seenIds`，续页使用 `id not in {seenIds}`。不使用有已验证缺陷的 SDK iterator，不依赖顺序、offset、count 达标提前终止或手拼引号主键。必须看到真实空终页、累计唯一行数等于前后 count，前后实际 schema/index 身份相同。
- Milvus 从实际 `describeCollection(cache:false)` 与未过滤的 `describeIndex` 回读全部字段、flags/functions 和索引；校验并移除 SDK 派生 helper，不从声明配置补造 manifest。索引易变进度仅验证不进入身份 hash。保留所有额外实际字段；非空 struct_array_fields 因 SDK 不可逆转换明确拒绝，不假称支持原始完整 proto。
- Milvus 保留九个实际业务标量，严格转换默认 loader 的 Int64 十进制字符串，原样读取 trusted / reviewed / external / quarantined。缺标量不得从 metadata 回填；同 scope 的额外版本和 trust 必须读出。原生 SDK 会修改请求，因此每 RPC 使用新鲜 detached mutable transport shell，私有配置和累计状态继续冻结。
- Milvus 单次操作的总 deadline、紧邻 dispatch 的剩余时间、row/parameter byte 容量均有界；迟到或 UNKNOWN 不继续 IO。默认 loader 语义与结构限制明确，超限不回退小窗口并 complete。

## 真实失败与修复记录

| 用例 | UTC / 退出码 | 实际统计 / stdout SHA-256 |
|---|---|---|
| 既有 opaque ID 全三库合同 RED | 07:07:23.071–07:07:23.203 / 1 | 0/1；`81b052326de5ff5f79d78433b3bb36cdd31745734654bae6f2d4936239f750f4` |
| 65,536 行分页容量 RED | 07:21:51.331–07:21:51.465 / 1 | 0/1；maxPages=512 被旧上限误拒；`7f59f76b5d293d5af5c32df17ca67872b12630306ad4c1e88d2d770a7a5aa9be` |
| Neo4j 单元入口完整 RED | 07:17:42.943–07:17:43.178 / 1 | 0/16；`8171e229694395b99f46c5a210014afafe55247c5e3eceabc3cda2e59a1aafc4` |
| Neo4j 真实 Bolt 入口 RED | 07:14:40.990–07:14:41.219 / 1 | 0/3；`abdfb5f5a964eb69ea8e23c5c1777e0655863f9b0c6ad586169fc7d218dd6a6b` |
| Neo4j 非法 inner carrier RED | 07:22:12.457–07:22:12.731 / 1 | 0/1；`4bde97be161c9b15ea63ff73bf08f714a67901ecdf56b78e6f85603e6e1d6ab6` |
| Neo4j 提前成功/并发回调 RED | 07:28:12.202–07:28:12.473 / 1 | 0/2；`7c81b6279664daf479492a1b4743dcb8b478ae0614e0fcb01eea1ec1768046bf` |
| Milvus 完整合同 RED | 07:21:43.608–07:21:43.706 / 1 | 0/10；`23eb68b060b0a4064d17ce706b8abeaedc20df8eacef47a381d7c95439dcbe1a` |
| Milvus 四级 trust RED | 07:30:00.139–07:30:00.255 / 1 | 0/1；`3d60e2174d90d42076120dc4ab9214a84e317763230658ef5c3286c1f6935fde` |
| Milvus SDK 修改请求 RED | 07:34:34.874–07:34:34.987 / 1 | 0/1；`ff99baab4bd47db227023e22da3867044c354a4e86cebb43b7480f59cce390cf` |
| Milvus clone 越界晚 dispatch RED | 07:37:50.250–07:37:50.397 / 1 | 0/1；`def172ca3814b0fddafd4126a042190bcd11a0b718e8b5c3d9ee9c987ad7760e` |

Neo4j 首次实际业务用例 0/3，`query-failed`，UTC 07:23:07.550–07:23:08.747，stdout `5357b10a99226388f722eda465792cd2cccb439f855f270ef920939eb9ceb922`。固定 Cypher 独立实际成功；原因是直接 `beginTransaction` 返回未公开导出的 TransactionPromise 子类。隔离测试改用**公开 await API**得到真实 SDK own-bound transaction API，不手造 run shim、不引入私有模块。该修复后的 3/3、后续管理事务路径 4/4 是中间证据，不能替代新的源身份验证。

Milvus 首次实际集成 1/2，UTC 07:32:33.474–07:32:36.372，stdout `c8832e661169f3acaa250ee765d30205a31e8b44bee1d004c46981ee37317900`：全容量模板成功，业务 count 因 SDK 写 frozen request 而失败。已安装官方 Data.js 确认会写 `data.expr` 与 `data.expr_template_values`；加入真实风格 fake 的 RED 后仅修 transport shell，保留冻结合同和强 Oracle。入口、helper 派生冲突 RED，以及验证 CLI 配置错误也保留在子任务证据，不视为生产失败或被抹去。

### Neo4j 首审发现的两项 HIGH

首审时 core28 + Neo20 的 48/48 绿色并不充分。审查者实际两个纯内存 PoC 均 exit0：

1. 外层 executeRead 已拒绝，但已启动的 inner query 仍 pending；错误漏报 UNKNOWN、未 halt，第二次读竟发出第二条 Cypher。补真实 callbackSettled 与 per-call closed lifecycle，不只依赖成功 completed 标志。
2. 仿 Result.prototype 的载体通过 own-data 检查，captured `Result.then` 仍动态执行载体 `_getOrCreatePromise`，hooks=1 并返回成功。补完整 fresh SDK 结构/行为控制，拒绝 method shadow、cached promise/mapper 和 prototype 漂移；这不构成企业来源认证。

两项主线分别实际 RED：0/1，UTC 07:38:17.128–07:38:17.401，stdout `bbdc37f3c4234689147248ad201ba999d63fe66bd8c2dd5b9030b37eab4f950f`；0/1，UTC 07:38:21.516–07:38:21.809，stdout `b807c2c0c9acd12a30d068971190f525f627323f9c4d7dd86b2c79da05659eb0`。另一个操作结束后迟到 callback 的 RED 0/1，UTC 07:39:29.394–07:39:29.669，stdout `dd1dfd94893b2951196c077457947d13d3ed805f91d6581ba2119e165b3b4aa4`。

修复后 26/26 单元仍在真实 Bolt 出现 0/4 `provider-contract-invalid`，UTC 07:44:57.639–07:44:57.963，stdout `70a31ad54c54f88a4cf5ca78656ec4ecd545bae41841377b39bf780bf48fa4c0`。实际只读诊断确认：Node test 的异步追踪在真实 native stream Promise 上添加两个 symbol data number 元数据；旧 `ownKeys.length===0` 过严。必须安全容许不参与 Promise 控制的追踪数据，继续拒 getter/then/constructor/Proxy/控制字段；不得改真实断言成接受错误。

实际 createHook + 公开 new Result 的兼容 RED 为 0/1，UTC 07:51:15.528–07:51:15.816，stdout `c322d8e8aa92f78ea357abd74b41995aa69f776e7c467094a2f4bc0bfecc93a7`。随后单元 28/28，真实 Bolt 4/4，UTC 07:53:54.543–07:53:54.899，321.8785ms，stdout `e6232958599ff84a3caf0039c8ec5157c9262120b65e9b219a853d4e63bcf8b3`，均无跳过；这些依然只是中间源身份的证据。

再次功能终审的 core28 + Neo28 实际 56/56 仍发现同一控制载体 HIGH 的间接残余：公开 SDK new Result 的 native stream Promise 履约后，未经校验的 observer subscribe getter 执行一次、Proxy observer 触发五次；connectionHolder getConnection getter 也执行一次，三种实际 PoC 都竟成功返回业务结果。检查 Promise 本身和 holder 非 Proxy 不足以封闭异步 payload 与 SDK 间接 receiver。原两个 PoC、late callback 和 AsyncHooks 兼容已经关闭，但此残余未关闭前不作最终 APPROVE。

三种残余分别建立真实 RED：observer getter 0/1，UTC 08:07:13.936–08:07:14.222，stdout `7a856d28a32d07d639770d8c6c6b1a706f54b271076c8cfbfc01d5fa70e63f92`；observer Proxy 0/1，UTC 08:07:18.890–08:07:19.163，stdout `c1cc2a3dabd6a4a72343c44be8ff3acdc25f7c4534d40336ea89ee0dfa232c01`；holder getter 0/1，UTC 08:07:23.615–08:07:23.898，stdout `e033ede010fc00bee954c88fa889ecaa5ee5d4e44c9ba8ce7a1a6e03d4ffd714`。Proxy 用例不把提供者自身 Promise.resolve(proxy) 构造时的 then 查询归咎于适配器：重置计数后只断言适配器与 SDK 后续零 trap。

安全 facade 修复后再补异步间隙的真实 RED 0/1，UTC 08:15:25.793–08:15:26.095，265.6166ms，stdout `bb066c229a2fae7d832ea160118cae7cac374b98f619ded4290b7abdcf52f85d`：等待 stream 时外部替换 own `_getOrCreatePromise`，首次结构检查不足，仍执行 hook 并伪成功。修复必须在 await 后、封闭 facade 和调用 SDK 前复检完整控制面及 holder/stream 身份，不冻结全局 SDK prototype。

该轮修复使用 descriptor-safe observer/holder/connection 直接控制面与自有 facade，保留原 Result 生命周期；先有界观察 native stream payload，await 后和 SDK 实际调用的微任务内复检完整载体，共享总 deadline。新增连接载体/异步 payload 的六变体 hooks=0，以及正常 release/protocol 生命周期和晚到超时不得再 dispatch 的测试。过程中曾有 34/35：正向 Oracle 错读 summary.protocolVersion，按公开 SDK 的 server.protocolVersion 修正；不把该 Oracle 错误抹去，也不弱化业务断言。此轮单元 35/35，UTC 08:19:59.190–08:19:59.638，415.8304ms，stdout `fc373909ebe72096f0df9a39b24a803483fdc846da87f83ac72d2b99fd1df1b4`；strict/lint exit0 且输出空，前后两 SHA 无漂移。

该 35 单元的源身份再次功能审查仍 request changes（core28 + Neo35 63/63、3678.9451ms）：完成 handler 的 raw metadata 可在 ResultSummary 中执行 type getter（hooks=1）或 Proxy（hooks=14）；订阅开始后外部重定义 `_connectionHolder` 为 getter，完成时也执行 hooks=1。这两条都是直接 SDK 边界，不能用“闭包来源不认证”免除。需在 metadata 进入 SDK 前无 hook 校验，且封闭后续读取的 holder/stream 载体字段而保留 SDK 可写的普通缓存状态；两项尚未关闭前不把 35 绿色称为最终放行。

两项实际 RED：metadata 0/1，UTC 08:28:21.461–08:28:21.737，241.8599ms，stdout `a4eb243da20cb67aea1cabc7c53d1fe878d2c017ac6d8822608642c9ba75c277`；post-subscribe receiver 0/1，UTC 08:28:46.591–08:28:46.872，246.87ms，stdout `eb1e5d9f69e324fe2b680d9dabfdd40890d112cbc6fdedc553ade4c385c28c25`。修复不冻结 `_p/_keys/_summary` 等 SDK 普通生命周期缓存，而只封闭后续读到的私有 receiver，并对完成 metadata 做有界无 hook 复制/校验。

继续补直接回调控制的实际 RED：late method shadow 0/1，UTC 08:36:40.660–08:36:40.933，240.9711ms，stdout `c31eb5416c819ff5753da8a92ad61a7afddabd02bc431cfa37bc324aa5088dda`；constructor/state accessor 0/1，UTC 08:39:51.856–08:39:52.124，236.6212ms，stdout `178fe6b8db589740cc6c0b163f699c655cb3aeefa437233fca29a5e3e752de18`；Cypher scope 参数可变 RED 0/1，UTC 08:43:44.656–08:43:44.929，stdout `8f22a6d3d664468af091bdf2f0aadd57e74454300b6ff1457ad6c320c5dbfb55`。固定参数冻结；原 Result preventExtensions、控制 descriptor 不可配置，合法 SDK 状态仍为可写 own-data。phase-aware 检查在每次进入 SDK handler 前执行；拒绝走私有 bridge，仍 pending 的 SDK `_p` 不被冒充已完成，UNKNOWN=true 并 halt，迟到 next/completed/error 不再 dispatch。metadata 有界复制最多 4096 节点、深度 32、字符串 64KiB，官方 Integer 按安全整数校验并规范化。不冻结全局 prototype，不把结构检查当成来源或权限认证。

新冻结单元 44/44，UTC 08:46:17.295–08:46:17.750，422.8361ms，stdout `15b043625ceea64c911eaff78030c0df791b6523e76efc197276965ca2a1f1b7`；strict/lint 均 exit0、输出空、两文件 drift=[]。四种私有拒绝均 UNKNOWN=true，原 SDK `_p` 未 settle，late dispatch/holder/hook 为零；正常 onError 仍为已知失败。此轮精确身份的双审待下文补齐。

### Milvus TS 初审发现的 HIGH

功能初审 17/17 与 bounded APPROVE、strict/lint 绿色后，独立 TypeScript 审查实际发现 `#io` 的 async raw return 会再次 Promise-resolve SDK payload，在 descriptor-safe 校验之前执行其 then getter。已履约 native Promise 的 payload 后加 enumerable then getter，实际读拒绝但 hooks=1；独立 hooks=0 断言真实 exit1。这不是 getter 已拒绝就可忽略的副作用。

已新增真实 RED 0/1，UTC 07:54:40.231–07:54:40.348，84.4529ms，stdout `d9be21964c5338222a88dd22a2419f1ca28771bcba00f3ba61944cdbe67a9931`，hooks 实际 1 而非 0。修复让 async IO 仅返回自建冻结 own-data `{value}` envelope；schema/index/count/page 四处先解包再校验 raw descriptor，不对整个大页强制 256KiB snapshot。

修复后单元 18/18，UTC 07:55:42.858–07:55:47.260，4370.6931ms，stdout `6b8dedc7a86b44ee7764174346dba938d57ccf5b1fea2c1e7cfe61d1f14d8be9`；四种 RPC 的危险 then getter 均零执行。strict/lint 均 exit0、输出空、前后两 SHA 无漂移。新 source/test 身份对应真实 SDK 2/2，UTC 08:00:59.237–08:01:06.021，6752.2782ms，stdout `b75e127c8ded6ba71ce4989ceb68c98bd1f0a4d58f990df2bfdd80994edaca5b`，无失败/取消/跳过/todo。新身份仍须串行双审，不复用功能首审 APPROVE 关闭该 HIGH。

## 实际引擎隔离与容量边界

- Neo4j：只读检查确认本项目 `rag-system-neo4j-1` 的 5.26.30-community 镜像、healthy 与 loopback Bolt 7687。三个写夹具用例都是随机 scope、未提交事务、finally rollback 后实际 count=0；第四项使用真实 managed executeRead，只读缺失的随机 scope。无 DDL、全局 claim、shared-node 删除或 commit。same-transaction fixture seam 不证明独立 IAM、并发 pointer 或跨库一致性。
- Milvus：只读检查本项目 `rag-system-milvus-1` 的 v2.5.10 声明镜像及实际 running/19530 发布；客户端固定 127.0.0.1，环境不得重定向。未声称由服务版本 API 认证 image 对应的 runtime。每次使用刚确认不存在的 `rag_publication_test_<32hex>`，finally 仅 drop 该新建集合并再次 hasCollection=false；不修改旧集合/配置/索引。
- 真实 SDK/server 的排除模板 canary 使用 65,536 个、每个 256 UTF8 字节的 ID，字符串本身共 16,777,216 字节，scope-only count 仍正确。它证明该本地模板传输/执行，不等于实际存储 65,536 行的全扫描性能、最坏总正文、独立权限或生产容量证明。
- 统一 core 的生成型 source 测试实际两遍各 65,536 行、共 1,024 页、131,072 generated rows，最终完整 proof 日志 1,028 项且 canonical 编码小于 256KiB；第 65,537 行拒绝，不完成前缀。fixture constructor 本身故意保持小对象边界，不冒充大型 DB。

## 最终验证与独立终审

待精确最终源身份、扩大回归和修复后串行双审终态补齐。此前所有绿色只证明相应当时切片，不能回填为最终放行。

Milvus 新三文件的独立功能复审已 bounded APPROVE：18/18、4463.5659ms、exit0，无失败/取消/跳过/todo；额外 getter/Proxy × 四种 RPC 的八个实际 PoC 均拒绝，hooks=0、恶意回调一次、后续 IO=0。同步 CPU 延迟超过预算的实测仍返回 query-timeout 并 halt，后续 IO=0。审前后 source `98157b52b340b44cd7fe3431c5824272ae26b97dea681ce3e6f49aa31fb0899a`、unit `3e168ca045d60408572f3b039afdc175ee336c815534dd7638883f2b3f98b0a1`、integration `05e3e8301957cfc34eca2ada0a06c18d7299d3e3b9f2c8491fa47008d7def684` 身份无漂移。

随后同三文件串行独立 TS 终审也 bounded APPROVE：strict source / lint3 均 exit0；原预算 18/18、4367.9831ms，无失败或跳过；八种 getter/Proxy payload 复测 hooks=0、目标 callback 一次且明确拒绝。审前后三 SHA drift=[]。该 HIGH 按新身份关闭，不将旧功能 APPROVE 当作新修复证明。

Neo4j 新 source `640861300d42a749229617392a6a1c31188eb57a90ef8323e809408ec01a2958`、unit `4071975a9923a0cfbb004b11c9d21eaa18c93c7261f23f5fd8264bfd461b06b6` 对应真实 Bolt 4/4，UTC 08:21:42.620–08:21:42.975，323.2294ms，stdout `696da451e516f71266b617acb76d8e16861b7fcbfff8c61cc1dd52a19dae0cc8`，exit0，失败/取消/跳过/todo 为 0、stderr 空；修复后精确五文件双审尚在执行。

主代理已按原预算执行 strict24 / lint18，均 exit0、stdout/stderr 空；窄 core28 + Neo35 + Milvus18 实际 81/81，UTC 08:22:09.376–08:22:13.940，4526.5308ms，stdout `057ab0f7ee70ef50a88f57a8df8e18b379fdd90cc0a7e15dce175576229da814`，无失败/取消/跳过/todo。

本轮首次完整 43 文件累计回归 **807/808，exit1**，UTC 08:22:13.940–08:22:36.461，22480.8649ms，stdout `6afea259d8dbb401d70bb7e148c3d12bf216b5284040075d792909a8367eeada`，无取消/跳过/todo、stderr 空、97 文件 drift=[]。唯一失败是既有 Ask 的 `POST preserves nested durable result integrity failures instead of reporting pause`：建立正常完整性 fixture 的第一条请求预期 200 实际 503，尚未进入篡改/完整性负测。失败块之后的下一用例 `DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED` 日志不能被误当成本例 503 的根因。

不改预算、环境或断言的单例隔离 1/1，UTC 08:25:36.475–08:25:37.504，996.4813ms，stdout `c5096430280d0b1e0445f95ace65ab863acfd8ffa8c2a9e08795957f4a26ec5f`；未修改的原 Ask 完整文件 75/75，UTC 08:28:40.496–08:28:47.004，6474.2809ms，stdout `a16b2f997f51857dc7baa024398e11a95eaf521568ff25b00ad8a1165199dd5d`，均无失败/取消/跳过/todo、stderr 空。另一次纯内存诊断仅为失败断言添加受限 code 消息、未改文件或放宽 Oracle，exit0 未复现；该次摘要 parser 错误未采到统计，不作为正式通过计数。503 根因仍未知，不以隔离绿色或后续完整绿色宣称修复；不删除历史失败。

当前核心身份下再次实际 PostgreSQL 隔离回读 3/3，UTC 08:04:19.658–08:04:19.940，249.2336ms，stdout `9932555f39f5f34a22f593bd78b40a9f6fb1d5c8c18ca463de72d7f74f342304`，exit0，无失败/取消/跳过/todo，stderr 空。保留 Node MODULE_TYPELESS_PACKAGE_JSON 诊断，未为了隐藏告警改变项目 module 配置。

Neo4j 最后修复后冻结 source `e0315b3ecba1fa98d8eb9b1895fdfe408aa6d165723d67e27f1f686881fdac02`、unit `71d725a7aab535b2d621b7107951f13adf986ca44fac3ceee3c6df6c85e11156`，integration 保持 `ffd6a9b8c126eab21a2ee080d9cd97af04ad0ad086c7c7fd26aa747436ecef51`。真实 Bolt 4/4，UTC 08:51:58.005–08:51:58.358，321.0008ms，stdout `5152784aedab2bf3be92e94fc82a051ab95c51ac3e9943fd25e0bdc7e6104947`，exit0，失败/取消/跳过/todo 为 0，stderr 空。旧 `640861…/407197…` 的结果只保留为历史，不作为新身份批准。

同一冻结身份主代理 strict24（UTC 08:52:08.443–08:52:10.349）/lint18（08:52:10.349–08:52:12.114）均 exit0、stdout/stderr 空；窄 core28 + Neo44 + Milvus18 **90/90**，UTC 08:52:12.114–08:52:16.593，4440.8284ms，stdout `4cbacd8ca05b1d25967a7cdf3b2ed5518e5964c9c96b258c98b4ca0763dea762`，无失败/取消/跳过/todo。

原预算累积 43 文件再次 **816/817，exit1**，UTC 08:52:16.593–08:52:40.827，24193.3623ms，stdout `f3a4d11eb3320abf73bbf557731504592773d124bf24c363ca91f45bde61c9e7`，无取消/跳过/todo、stderr 空，97 文件 drift=[]。失败改为原 Ask `PATCH cancellation is admin-only and fences a running durable ask`：2216 行用例、2232 行运行状态断言，实际 false 预期 true，2020.8807ms。尚未定位原因，独立只读诊断中；不增大轮询窗口或改并发/环境/Oracle，不用重跑绿色宣告修复。此前 503 失败仍保留。

精确 Neo+core 五文件功能终审 bounded APPROVE：原预算 72/72、3737.6367ms，无失败/取消/跳过/todo；额外 PoC 复验 metadata getter/Proxy hooks=0、holder=0、UNKNOWN=true→halt、原 SDK `_p` 未完成，late dispatch 为零；订阅后 holder/stream/method/参数/状态 accessor 注入被 TypeError 阻止，合法读取仍成功。随后串行 TS 终审 bounded APPROVE：strict 两源码/lint5 exit0，原预算 72/72、3683.7333ms，无失败/跳过；两轮 exact5 审前后一致。仅关闭本文 Neo SDK 边界 HIGH；reader owned UNKNOWN reason 遗失另轮待修，不以旧 core 的 APPROVE 覆盖它。

本文冻结八文件身份如下。Milvus/Neo4j 实际测试与两轮审查匹配各自该身份；回归失败状态不被批准替代。

| 文件 | SHA-256 |
|---|---|
| publication-identity.ts | `4bb4ef874e2bce1ee6c1b79da890b05995b21630b63ea067ea5e225fadf28e66` |
| publication-identity.test.mjs | `2b21a6861d9a15748d91c27263d92a78522e38548dc93c7b1e9e96f55ecbaf22` |
| neo4j-publication-readback.ts | `e0315b3ecba1fa98d8eb9b1895fdfe408aa6d165723d67e27f1f686881fdac02` |
| neo4j-publication-readback.test.mjs | `71d725a7aab535b2d621b7107951f13adf986ca44fac3ceee3c6df6c85e11156` |
| neo4j-publication-readback.integration.test.mjs | `ffd6a9b8c126eab21a2ee080d9cd97af04ad0ad086c7c7fd26aa747436ecef51` |
| milvus-publication-readback.ts | `98157b52b340b44cd7fe3431c5824272ae26b97dea681ce3e6f49aa31fb0899a` |
| milvus-publication-readback.test.mjs | `3e168ca045d60408572f3b039afdc175ee336c815534dd7638883f2b3f98b0a1` |
| milvus-publication-readback.integration.test.mjs | `05e3e8301957cfc34eca2ada0a06c18d7299d3e3b9f2c8491fa47008d7def684` |

取消失败点经只读诊断确认是测试 fixture 的 `waitForScopedAgentSignal` 默认 2000ms 内未进入 fake `invokeScopedRetrievalAgent`，不是取消业务结果断言。原预算 isolated 1/1（160.2541ms，UTC 08:57:30.965–08:57:31.953，stdout `a080bbb77ec2af47a319701de893799c801f6fbfd3f755659b5bb6139a1b804e`）和原整 Ask 75/75（6299.5537ms，UTC 08:58:11.055–08:58:17.387，stdout `4f7bf6c02ce673e7b1195201d9969d07d2e35b7d0765751ec27354914d7efe8e`）通过，route/test/runtime 三身份无漂移。原失败没有检查 pending POST 的 status/body，尚不能区分前置业务失败和资源/初始化延迟；根因仍未知，不宣称修复。

上述 isolated 的 160.2541ms 是子测试时长，TAP 总时长954.3659ms，外层进程约988ms，三者不混用。只读进一步核对：请求准备→独立临时 root runtime→checkpoint→running lease CAS→kernel 检索→generation admission→agent；结果 artifact 发布在 agent 完成后，不属本次入口前置路径。runtime cache 和锁包含 unique root，未发现固定 scope/idempotencyKey 直接共享 fixture 存储。存在 modelKey 级 detached-generation admission，但没有原失败命中它的证据；默认30s lease和2s fixture signal是不同预算。共享OS调度/文件IO压力仅假说，未作代码或预算调整。

## 未完成工作

W5 仍需真实 native adapters → 私有 SourceProof/readback source 的绑定、registry/evidence/artifact/runner 接入、完整独立 conformance；还需实际大库存/字节/期限容量、空/deactivated baseline 和相关观察生命周期测试。非空 struct-array 等 SDK 范围限制保留，不能用这次 13 字段集合假称支持全部 schema。

W2 共同 ports / measured runtime / 入口接入 / 全 purpose 行为认证，W3-W9、T16/T17/R18 以及 18 项端到端 AC 都未因此关闭。真实生产数据、阈值、目标 scope、窗口、负责人和有效审批/验收对象尚未完整给出；用户“直接授权”是继续本地工作的授权，不能代替这些事实或签认。所有历史 Ask/approval/环境失败继续保留；没有 commit、push、生产切流或历史 Store 清理。
