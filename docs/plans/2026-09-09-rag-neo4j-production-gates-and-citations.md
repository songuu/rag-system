---
type: sprint
status: in-progress
tasks_completed: 0
tasks_total: 13
task_ids: ["W0","W1","W2","W3","W4","W5","W6","W7","W8","W9","T16","T17","R18"]
open_task_ids: ["W0","W1","W2","W3","W4","W5","W6","W7","W8","W9","T16","T17","R18"]
---

# RAG / Neo4j 生产门禁与可点击引用后续 Sprint

- 状态：Sprint owner 已批准完整范围；仅在可审计 supersede 事务绑定 active pointer 后授权进入正常阶段流转
- 日期：2026-09-09
- 上游计划：`docs/plans/2026-09-07-neo4j-knowledge-graph-integration.md`
- 总体目标：保持原 T16/T17 验收范围不变，先补齐所有本地可执行门禁工具和正文引用链，再在真实生产输入、阈值与维护窗口到位后完成生产 Shadow、单 corpus 灰度、故障降级、回滚和发布周期留存

## 0. 重基线边界

本计划不把未完成工作改名为“完成”，也不缩小活动 Goal。Sprint runtime 以内容寻址的 `sprint-migration-receipt/v2`、owner 批准证据、显式任务映射和 CAS 绑定旧 pointer 与新计划；批准本计划本身仍不等于迁移成功。迁移必须满足：

1. 旧 Sprint 在事务提交前保持 `compound/blocked, 16/18`；禁止调用 `complete --expected compound`，也禁止手工改写、删除或覆盖 pointer。
2. Sprint owner 批准“旧 T16/T17 → 新 T16/T17、W0-W9、R18”的完整映射和不缩减 Goal；任何源 open task 都不得消失或改记为完成。
3. `supersede` 事务以 CAS 绑定旧 pointer/计划 hash、新计划 hash、owner 批准记录、任务映射和规范化 receipt，保留旧 Sprint 的未完成/迁移事实；不得复用 completion record。
4. 只有 migration receipt 与新 pointer 均通过权威 readback 后，本 Sprint 才能从正常 `think -> plan -> work` 状态机启动；失败或证据漂移必须保留旧 pointer 和恢复证据并 fail-closed。

当前批准记录：

| 字段 | 状态 |
|---|---|
| Sprint owner | 当前 Codex task 的用户 owner |
| 批准人 / 时间 | owner 明确要求“必须全部完成”；精确时间由 approval evidence 与可信运行时钟绑定 |
| 批准记录或签名 | 本地主机观察边界内的消息定位符与 UTF-8 SHA-256；不冒充密码学签名 |
| 事务化 supersede/migration 能力 | runtime 提供只读 proposal、调用方精确落盘 receipt、CAS supersede 与崩溃恢复 |
| 任务映射与新旧计划 hash receipt | 由迁移事务按规范化任务 ID 和精确文件 hash 生成并回读 |
| Pointer 迁移 | 仅允许 runtime 的精确事务执行；禁止手工改写 |

## 1. Think Frame

### 1.1 要做

- 复用现有 RagEval V2 dataset/hash、metrics、matrix、Snapshot CAS、PostgreSQL Outbox、Neo4j artifact store 和 Milvus 文档查询能力。
- 实现分阶段 fail-closed、可审计的生产门禁 manifest、production Ask runner、T16/T17 receiptCore/acceptanceBundle、PublicationIdentity readback 与崩溃恢复 journal；质量/延迟阈值可配置，安全 hard gate 不可放宽。
- 实现普通 Ask 与 agent 路径的结构化引用输出、服务端诊断，以及正文 `[n]` 到最终 served Evidence 的安全、可持久化映射。
- 在本地隔离环境完成正向、负向、故障、篡改、回滚和敏感数据泄漏测试。
- 生产数据和审批到位后，按冻结合同完成 T16/T17，不用 synthetic 或 hermetic 结果替代。

### 1.2 不做

- 不在仓库、普通日志、receipt、shell argv、stdout/stderr、OTel/APM、崩溃转储或工单中保存 Token、Cookie、认证头、生产原始问答/gold 或 PII。
- 不把 WORM/append-only 当作审批真实性。审批必须来自身份可验证的签名或企业审批事件，并与防篡改存储同时存在；二者不能互相替代。
- 不允许请求参数临时绕过进程级 `RAG_GRAPH_MODE`，不在共享 Neo4j 上执行停库故障注入。
- 不直接 UPDATE PostgreSQL Pointer/Outbox，不直接用 Cypher 改 Pointer，不用删除 Snapshot、卷或重建 Milvus 充当回滚。
- 不在 Pointer lineage 已分叉时刷新 revision 后盲目 CAS；自动 mutation 只能作用于仍属于本 run 的前驱和目标。
- 不允许 manifest 放宽跨 scope Evidence、认证绕过、Secrets/PII 普通落盘或无效审批等安全 hard gate。
- 不在发布周期留存证据通过前删除旧文件 Store 或历史图谱。

### 1.3 可观察成功标准

1. **WHEN** 当前阶段所需字段、hash、审批真实性、可信时间或窗口无效，**THE TOOLING SHALL** 在该阶段任何生产写入和切流前退出；T17/Retention 字段缺失不得反向阻塞只读 T16。
2. **WHEN** 同一 roster 执行 `off` 与 `shadow`，**THE TOOLING SHALL** 锁定相同 image/build/model/index 和 `sharedConfigHash`，分别保存完整 `armConfigHash` 与回读的 `rolloutMode=off|shadow`；两 arm 只允许批准的模式字段不同。
3. **WHEN** 保存生产 Ask 数据，**THE TOOLING SHALL** 默认不保存响应头，按批准白名单最小开放；请求、gold、响应、错误和遥测全链路脱敏，原始制品使用 AEAD、每对象唯一 nonce 和每 run KMS/envelope key，AAD 绑定 environment/scope、run、manifest、artifact type/ID、case/ordinal 与 schema version；receiptCore 只保存机密级伪名索引和 hash。
4. **WHEN** 跨 scope、认证绕过、普通落盘 Secrets/PII、无效审批或其他 hard gate 任一触发，**THE TOOLING SHALL** 立即停止后续请求和 mutation；manifest 只能收紧，不能调宽为非零容忍。
5. **WHEN** T16 Shadow 完成，**THE RECEIPT CORE SHALL** 证明“无新增 serving/control-plane/index mutation”：served Evidence、context/prompt digest、cache identity 与 off 强一致，Pointer/Outbox/BuildJob/Neo4j/Milvus/流量无未批准变化；回答按批准的语义非劣化阈值比较，只有 provider 明确保证 deterministic seed 时才额外比较 answer digest；报告区分 cache hit/miss，避免缓存掩盖生成路径。批准的加密审计制品、受控遥测、模型计费和与 off 等价的普通缓存写入单列为预期副作用。不得据此宣称 Active 最终答案提升。
6. **WHEN** 任一阶段结束，**THE ACCEPTANCE SHALL** 按无环三层对象生成：先封存不含 post-run 签名反向引用、但包含权威 journal root digest/entry count 的 immutable `receiptCore`，再由独立 `resultAttestationEnvelope` 绑定 exact `receiptCoreDigest`、report/artifact hash、verdict、同一 run nonce、执行身份和完成时间，最后由 `acceptanceBundle` 引用 receiptCore、attestation 与防篡改对象证明；只有完整 bundle 可作为阶段完成凭据，pre-run authorization 不得替代结果签认。
7. **WHEN** T16 未达批准阈值、无有效 acceptanceBundle 或其中任一 digest/version/防篡改对象证明不匹配，**THE SYSTEM SHALL** 拒绝 T17。
8. **WHEN** T17 开始，**THE ORCHESTRATOR SHALL** 先验证 execution authorization 并冻结独立 recovery authority 与只允许降风险动作的 `SafetyRecoveryPolicy`，再取得带单调 fencing generation 的权威分布式 scope lease，并证明专用 canary 零流量且进程处于 `off`，然后执行 lineage/fencing-bound CAS；流量、模式、fault adapter 和 journal 都必须拒绝 stale token。所有非零流量权重必须带不长于 lease 的控制面 TTL，lease/owner 失效时由流量控制面自动归零；旧 token 不能救援，任何后续 rescue mutation 还必须先取得绑定实际新 generation 的 SafetyRecoveryAuthorizationEnvelope。
9. **WHEN** T17 放量前探针运行，**THE GATE SHALL** 对同一 roster 和相同 image/build/model/index/sharedConfigHash 的 `off`/`active` arm 配对，分别保存 armConfigHash/mode readback，验证批准的 trial/warm-up、多跳质量、引用、安全、错误、P95 和超时指标；未达标不得放量。
10. **WHEN** T17 灰度放量，**THE ORCHESTRATOR SHALL** 只执行签名 manifest 中冻结的最大权重/请求数、dwell、逐级 ramp 和 abort 规则，并逐步记录权威流量 readback；每级非零权重使用 lease-bound TTL/deadman，续租失败不得继续放量。
11. **WHEN** 执行故障注入，**THE FAULT ADAPTER SHALL** 只接受签名 FaultPlan 的闭集动作、不可变资源 ID、参数上限、TTL、预期影响、撤销动作、stop condition 和 kill switch；故障必须由 adapter 端 TTL/deadman 自动撤销，禁止任意 shell、Cypher 或 URL。
12. **WHEN** canary Neo4j 隔离故障，**THE SYSTEM SHALL** 保持 Dense/Milvus 问答可用，并记录 Graph 降级；故障身份不得触达共享 Neo4j、Milvus、Outbox 或流量选择器。
13. **WHEN** 自动回滚，**THE ORCHESTRATOR SHALL** 在持有当前 fencing generation 时先摘除 canary 流量并回读进程 `off`，且仅在 Pointer 仍匹配本 run 的前驱/目标 lineage 时 CAS；若已失锁，lease-bound 流量 TTL 必须自动归零且 fault TTL 自动撤销，旧 owner 停止全部动作。只有取得新 generation、有效 SafetyRecoveryAuthorizationEnvelope 且通过 journal hash-chain/head 与现场 readback 校验的 rescue operator 才可继续安全恢复；lineage 分叉或 journal 截断/分叉时禁止自动 Pointer mutation 并进入事故处置。
14. **WHEN** 回答含合法 `[n]`，**THE UI SHALL** 只按权威 served-ID 映射 opaque CitationLocator；候选/served-ID 映射中的重复或缺失 ID 非法，但正文可多次引用同一合法编号。
15. **WHEN** 用户点击来源，**THE SERVER SHALL** 跨实例解析带 TTL/完整性保护且不赋权的 CitationLocator，再按当前主体重新校验 tenant/corpus/trust/version；浏览器状态不具授权能力。
16. **WHEN** IndexedDB 恢复、账号/租户切换、权限撤销、TTL 到期、文档删除、locator key rotation 或 schema 迁移，**THE UI/SERVER SHALL** 分区验证或清理最小引用元数据，拒绝 stale/cross-scope ID。
17. **WHEN** T17 获得执行授权，**THE MANIFEST SHALL** 同时冻结 retentionPolicy 和旧 Store manifest/hash；R18 只能验证该既有政策和同一 Store 身份，不能事后选择更短周期。
18. **WHEN** retentionPolicy 尚未满足，**THE RETENTION ACCEPTANCE SHALL** fail-closed；达到完整发布周期后按 receiptCore/resultAttestation/acceptanceBundle 三层对象生成凭据。实际清理属于 Goal 外独立动作，仍需 `validateForCleanup` 和单独删除授权。

## 2. 目标架构

```text
T16 executionAuthorizationEnvelope + tamper-resistant storage
  -> validateForT16
  -> frozen shared identity + off/shadow arm descriptors
  -> controlled production Ask runner (off)
  -> controlled production Ask runner (shadow)
  -> paired Shadow/SideEffectPolicy gate
  -> immutable T16 receiptCore + tamper-resistant proof
  -> independent post-run resultAttestationEnvelope
  -> T16 acceptanceBundle
  -> T17 executionAuthorizationEnvelope + frozen SafetyRecoveryPolicy
  -> validateForT17
  -> dedicated canary zero traffic + process off readback
  -> authoritative per-scope lease/fencing + CAS/hash-chain write-ahead run journal
  -> lineage/fencing-bound expectedRevision CAS
  -> Outbox ack + PublicationIdentity readback
  -> active process/mode readback
  -> frozen-arm off/active pre-traffic quality gate
  -> signed ramp plan + controlled canary traffic
  -> signed closed-set FaultPlan + isolated failure injection
  -> withdraw traffic + process off readback
  -> recovery-authorized lineage/fencing-checked CAS rollback + final readback
  -> immutable T17 receiptCore + independent resultAttestationEnvelope
  -> T17 acceptanceBundle
  -> R18 executionAuthorizationEnvelope + trusted elapsed-time evidence
  -> validateForRetention
  -> retentionPolicy checker
  -> immutable retention receiptCore + independent resultAttestationEnvelope
  -> retention acceptanceBundle
```

回答引用链独立于生产切流，但共享同一 Evidence 身份：

```text
ordinary/agent generation -> structured citation output + server diagnostics
  + API candidate evidence
  + contextPacking.includedEvidenceIds (authoritative served order)
  -> partitioned/TTL assistant persistence with opaque IDs only
  -> validated citation map
  -> inline [n] internal link
  -> server re-authorization with current principal
  -> scoped source preview
```

## 3. 版本化合同

### 3.1 分阶段 Gate manifest

基础 schema 建议为 `kg-production-gate-manifest/v1`，但 validator 必须提供三个非循环视图：

- `validateForT16`：只要求 dataset/roster、scope、制品、off/shadow arm、T16 指标、SideEffectPolicy、受控制品策略和 T16 execution authorization；不得要求尚未安排的 T17 维护窗口或 retentionPolicy。
- `validateForT17`：在已验证 T16 acceptanceBundle 上增加专用 canary/流量控制身份、PublicationIdentity、off/active arm 与 trial/warm-up/阈值、最大流量权重/请求数、dwell/ramp/abort、签名 FaultPlan、变更单/窗口/on-call、停止/回滚条件、scope lease/fencing、T17 execution authorization 与 SafetyRecoveryPolicy/recovery authority。RetentionPolicy 与旧 Store manifest/hash 最迟在这里冻结。
- `validateForRetention`：在已验证 T17 acceptanceBundle 上验证已经冻结的 retentionPolicy、旧 Store identity、权威时钟、经过时间/后继发布证据和 R18 execution authorization；不得事后替换政策，也不要求删除授权。
- Goal 外另设 `validateForCleanup`：只接受有效 retention acceptanceBundle 与独立删除授权；清理不属于 R18 验收本身。

基础字段组：

- 数据身份：dataset ID/version/normalized SHA-256、伪名 roster case IDs、trial count。
- Scope：environment、tenant、corpus、允许 trust levels、专用 canary host/instance 与流量选择器身份。
- 制品身份：commit、build/release、image digest、`sharedConfigHash`；每个 arm 单独保存完整 `armConfigHash`、`rolloutMode` 和实际进程回读。
- 模型与索引：LLM、Embedding、Reranker，以及 PublicationIdentity 引用。
- 阈值：T16 Shadow 与 T17 Active 使用独立批准阈值；质量/延迟可配置阈值仅引用当前 schema 可计算的指标。跨 scope、认证、Secrets/PII、审批有效性等安全不变量是不可放宽 hard gate，manifest 只能收紧。
- `SideEffectPolicy`：列出 T16 允许的加密审计制品、受控遥测、模型计费和与 off 等价缓存写入，以及禁止的 serving 输出、Graph 专属缓存、Pointer/Outbox/BuildJob、Neo4j/Milvus/index、模式和流量 mutation；定义每项 pre/post readback 与计数差异。
- `FaultPlan`：动作来自版本化闭集，绑定不可变目标 ID、参数上限、最大 TTL、预期影响、撤销动作、stop condition 和 kill switch；禁止携带任意命令、Cypher 或 URL。
- 敏感制品策略：默认空响应头白名单、KMS key policy、访问范围、保留/删除/legal-hold 策略。
- T17 extension：owner、approver、变更单、窗口、on-call、停止条件、回滚 owner、JIT mutation credential policy、独立 read-only identity、SafetyRecoveryPolicy/recovery authority/duty role，以及 PostgreSQL/外部分布式 lease 的单调 fencing generation。
- Retention extension：在 T17 授权时冻结的周期定义、起点事件、最短时长或后继发布条件、权威时钟、回滚/重置规则与旧 Store manifest/hash。

Secrets 不属于 manifest，也不得从 CLI 参数或 shell argv 注入；只允许由部署侧 secret provider 在目标 origin 校验完成后提供。

### 3.2 审批与 Receipt

建议 schema：

- `kg-t16-shadow-receipt-core/v1`
- `kg-t17-canary-receipt-core/v1`
- `kg-retention-receipt-core/v1`
- `kg-stage-acceptance-bundle/v1`
- `kg-gate-run-journal/v1`
- `kg-safety-recovery-authorization-envelope/v1`

每阶段按固定无环顺序构造 execution/result 两个通用且不可互换的 envelope 和三层验收对象；T17 另冻结 SafetyRecoveryPolicy，并只在真正 rescue 时签发第三类受限 envelope：

1. pre-run `executionAuthorizationEnvelope`：在任何请求、CAS、流量或 fault 动作前，绑定 canonical manifest hash、environment、tenant/corpus、operation、阈值、窗口、唯一 run nonce 和授权时间。
2. `SafetyRecoveryAuthorizationEnvelope`：由独立 recovery authority 基于 T17 中已冻结的 policy 按需签发，绑定原 run/authorization、environment/scope、精确 predecessor/target lineage、新 fencing generation、rescue role、短有效期、JIT credential reference 和闭集 allowed actions。它只允许流量归零、撤销既有 fault、切换/recreate 为 `off`、精确回滚到已签名 predecessor；禁止激活、增加流量、新建 fault、更换 target 或跨 scope。协调面可在冻结 policy 下取得新 lease，但任何 serving/control-plane 恢复 mutation 前必须取得绑定实际 generation 的有效 envelope；原 execution authorization 过期/吊销/窗口关闭不能被复用。
3. immutable `receiptCore`：执行结束后一次性封存，包含 execution authorization 与适用的 recovery authorization 引用、规范化 manifest/data/config/artifact/report hash、journal terminal root digest/entry count、机密级受控制品索引、逐步状态、machine verdict、执行身份和终态；不得包含尚未生成的 result attestation 或任何反向引用。
4. tamper-resistant object proof：由独立只读身份回读 receiptCore，精确绑定其 object ID、canonical digest、object version、锁定模式和保留截止时间。
5. post-run `resultAttestationEnvelope`：由独立结果审批者或权威系统绑定同一 receiptCore digest/version、report/artifact hashes、machine verdict、run nonce、执行身份、终态和完成时间。
6. immutable `acceptanceBundle`：只引用 receiptCore、result attestation 和 tamper-resistant proof 的精确 digest/version，不回填或修改 receiptCore。只有完整、无环且逐项可回读的 bundle 才是阶段完成凭据；T17 只能消费有效 T16 bundle，R18 只能消费有效 T17 bundle。

Validator 必须校验 signer 角色、执行授权人/recovery authority/执行人/结果签认人职责分离、密钥版本、有效期、吊销状态、nonce 唯一性、顺序和跨环境/跨 scope/跨结果重放；SafetyRecoveryAuthorization 还必须验证单调降风险动作和实际 fencing generation。WORM/append-only 不能替代审批身份，pre-run authorization 也不能替代 post-run 结果签认。路径实现必须限制 ID 字符集/长度，固定并验证存储根，拒绝绝对路径、`..`、junction/reparse point、硬链接和 TOCTOU；使用 exclusive create、受限 ACL、大小上限、fsync 和原子 rename。没有有效终态 acceptanceBundle 永远不是成功。

权威 `RunJournalStorePort` 使用数据库事务 compare-and-append 或防篡改 append store 实现不可原地修改的 write-ahead journal。每条记录绑定 runNonce、manifestHash、environment/scope、fencingGeneration、严格递增 seq、prevDigest、idempotencyKey、actor/authorization digest、intent|result、闭集 action/parameters digest、before/after readback digest 与 trustedTime；任何外部动作前先持久化 intent，动作后追加 result。权威 head 以 CAS 更新并独立回读，receiptCore 封存 terminal root digest 与 entry count。恢复必须验证完整 hash chain/head 和现场状态，拒绝缺口、截断、删除尾部、重排、重复、分叉、旧 fence 条目注入或 journal/live-state 不一致。

权威 lease 必须由 PostgreSQL 或外部分布式锁提供单调 fencing token，journal、CAS、部署、流量、mode 和 fault adapter 全部强制拒绝 stale generation。崩溃恢复先验证 journal、lease、SafetyRecoveryAuthorization 与现场状态，再按 lineage/fencing 决定安全续跑、受限回滚或人工事故处置；journal 不可信时不得据其执行自动 Pointer mutation。

### 3.3 PublicationIdentity

`PublicationIdentity` 不是要求异构字段字符串相等，而是定义可验证关系：

- `scope`：environment、tenantId、corpusId。
- `graph`：graphVersion、artifactDigest、Pointer revision。
- `documents`：按 documentId/version/trustLevel 排序的集合，以及每文档 expectedChunkCount 或内容 manifest digest。
- `milvus`：collection、schema manifest hash、index manifest hash 和精确文档行版本集合。

权威回读关系：

- PostgreSQL Pointer/Outbox 提供 scope、graphVersion、revision 和投影 ack；BuildJob 提供 artifactDigest 与文档身份。
- Neo4j Pointer/Snapshot 提供相同 scope、graphVersion、revision、artifactDigest 和 DocumentVersion 集合。
- Milvus verifier 以只读身份按 scope/文档版本查询精确行，并校验 chunk/content manifest 与 collection/schema/index manifest。

任一段缺失、超集、子集、版本、digest、revision 或 scope 不匹配均 fail-closed。

### 3.4 Production target 与数据保护

- 仓库只定义 provider-neutral `SecretProvider`、`KmsEnvelopePort`、`ApprovalVerifier`、`TamperResistantArtifactStore`、`TrustedClock`、`ProductionAskTargetPort`、`PublicationReadbackPort`、`RunJournalStorePort`、`DistributedScopeLeasePort/FencingAuthorityPort`、`DeploymentModeControlPort`、`TrafficControlPort`、`FaultControlPort` 和 `CitationLocatorCodec/StorePort`，以及受限本地 reference adapters 与统一 conformance suite；不在仓库自研企业 KMS、审批、WORM、分布式锁、部署或流量系统。
- 部署侧维护 manifest 不可放宽的 `ProviderTrustPolicy`/registry，冻结每个企业 provider 的 ID、用途、签名 adapter artifact/image digest、版本、允许配置摘要、endpoint/origin、TLS trust roots 和凭据引用。manifest 只能选择已注册用途，不能自举信任根、注入 endpoint 或降级到 fake/reference/local fallback。
- T16/T17/R18 启动前，真实 adapter 必须由独立 harness 通过同一 conformance suite；provider/registry version/config identity、adapter digest 和已封存的 conformance receipt 写入 manifest 与 execution authorization，不接受 adapter 自报通过。production profile 发现未注册 digest、reference/fake adapter 或 fallback 时 fail-closed；receiptCore 回读的实际 provider identity 必须与 ProviderTrustPolicy 和 execution authorization 一致。
- Ask、Approval、KMS、tamper store、Clock、Readback、Journal、Lease、Deployment、Traffic、Fault 和 CitationLocator 等所有出站 provider endpoint 都只来自 ProviderTrustPolicy；强制 TLS hostname/chain 校验，默认禁重定向，绝不跨 origin 转发凭据。
- 所有出站连接统一约束 DNS/IP/端口/代理、response schema/size、流式累计、解压后大小和 timeout，拒绝 metadata、loopback（非显式本地测试）、link-local、私网越界与 DNS rebinding。
- 凭据在 registry、adapter digest、origin、DNS 和 TLS 校验成功后才从 secret provider 注入；生产 mutation 使用 JIT、最小 scope、不可 wildcard 身份，readback 使用独立只读身份。
- 请求 query/gold/case ID、响应、错误、日志、遥测、临时文件与崩溃转储统一结构化脱敏；生产制品使用 AEAD、每对象唯一 nonce 和每 run KMS/envelope key，AAD 至少绑定 environment/scope、run nonce、manifest hash、artifact type/ID、case ID、ordinal 与 schema version，防止同 run 密文互换，并记录轮换和访问审计。CitationLocator 使用独立 key purpose/policy。
- Receipt 使用伪名 case ID；hash 和受控索引本身按机密数据保护。删除必须覆盖对象版本、缓存、派生报告、replica/backup，并处理 legal hold，生成可验证 deletion/crypto-shred receipt。
- FaultControlPort 只接收 schema 校验后的闭集 FaultPlan 和 fencing token；adapter 不提供任意 shell、Cypher、URL 或共享资源 fallback。

### 3.5 引用授权合同

- 标准 Ask 与 agent 路径都必须产生结构化引用或明确的无引用诊断；不能只依赖模型偶然输出 `[n]`。
- 服务端先按 served-ID 验证编号、Evidence 唯一性、scope、trace 和引用诊断；Markdown 代码块、链接文本及恶意内容不得被误解析。
- 服务端生成版本化 `CitationLocator`：只能是至少 128-bit 的高熵随机句柄并存入按 environment 隔离的共享 TTL store，或使用 AEAD 的自包含 opaque token；signed-only payload 最多只能携带随机 opaque handle，禁止向客户端暴露 document/Evidence/scope/version/URL/title。locator 必须跨重启、跨实例可解析，并冻结/验证 schema version、issuer、audience、environment、purpose、key ID、issued-at、expiry、服务端固定 max TTL 和唯一 jti。
- CitationLocator key rotation 必须定义新 key 生效、旧验证 key 不超过既有 locator max TTL 的接受窗口和紧急吊销；轮换不得延长原 `exp`。跨 environment/audience/purpose 重放、未知/吊销 key、共享 store/keyring 不可用、超出 max TTL 或恢复已删除文档均 fail-closed。不得要求客户端从任意 Evidence ID 反解析文档身份。
- 浏览器只持久化 CitationLocator 与最少显示元数据，按当前用户/tenant/corpus 分区并设置 TTL；登出、切换账号/租户、权限变化、文档删除和 schema 迁移时清理。
- 点击只访问受控内部预览路由；服务端解析 locator 后按当前 principal 重新授权 Evidence scope/version/trust，并查询权威 version/tombstone 状态，拒绝篡改、过期、已删除、缓存残留、stale 或 cross-scope locator，不信任 IndexedDB 中的 scope、trace、URL 或 title。

## 4. 任务与依赖

| Task | 工作 | 依赖 | 风险 | 完成证据 |
|---|---|---|---|---|
| W0 | 冻结现有 RagEval、Ask、Graph CAS、Evidence 与 IndexedDB 行为基线；先补失败测试 | 无 | L2 | 基线测试清单；新测试先红后绿 |
| W1 | 实现分阶段 manifest、arm descriptor、`SideEffectPolicy`、闭集 `FaultPlan`、`SafetyRecoveryPolicy`、冻结 retention 扩展、规范化 hash、不可放宽 hard gate 和 `validateForT16/T17/Retention` | W0 | L3 | 阶段缺字段、篡改、审批失效、跨阶段自循环、arm 非批准差异、FaultPlan/RecoveryPolicy 越界、retention 事后替换和安全阈值调宽负测 |
| W2 | 实现全部 provider-neutral ports 的共同 trust/conformance 基础、`RunJournalStorePort` 与受限 reference adapters、受控制品索引、execution/result/recovery envelope、无环 receiptCore/acceptanceBundle、CAS/hash-chain journal 与 writer/validator | W1 | L4 | envelope 不可互换与 recovery 单调降风险、自引用/core-bundle 混淆/object-version 替换、journal 修改/截断/重排/fork/旧 fence 注入、intent/result 崩溃边界、signer/角色/密钥/吊销/时间/nonce/重放、独立 harness、防篡改 readback、AEAD/AAD swap、路径/链接/TOCTOU、泄漏和删除负测 |
| W3 | 实现受部署侧 origin allowlist 约束的 canonical Ask target 与同 roster `off`/`shadow` runner | W1、W2 | L4 | SSRF/DNS rebinding/跨源重定向/TLS/代理/压缩炸弹/超时测试、隔离 E2E、逐例机密 hash/index |
| W4 | 实现 manifest 驱动的 T16 `off`/`shadow` SideEffectPolicy gate 与 T17 `off`/`active` 放量前质量 gate，并统一执行不可放宽安全 hard gate 与阶段独立的可配置质量/延迟 gate | W3 | L3 | T16 pre/post mutation readback、T17 arm identity/mode readback、阈值边界、逐例配对、立即终止、失败分类、遗漏安全指标及机器 verdict |
| W5 | 实现 PublicationIdentity 及 PG Pointer/Outbox/BuildJob、Neo4j Snapshot、Milvus exact rows/index manifest 的统一只读 readback | W1 | L4 | 本地三存储关系测试；scope/集合/chunk/version/digest/revision 不一致与超集/子集负测 |
| W6 | 实现 `DistributedScopeLeasePort/FencingAuthorityPort`、`DeploymentModeControlPort`、`TrafficControlPort`、`FaultControlPort` 及受限 reference adapters；完成 lease renewal/fencing、stage-aware runner、lineage+fencing CAS、Outbox、RampPlan、FaultPlan、流量/fault TTL deadman、幂等 resume 与需 SafetyRecoveryAuthorization 的新 generation rescue/off-first 回滚 | W2、W4、W5 | L4 | 双 orchestrator/网络分区/续租竞态/失锁/stale token、owner 崩溃后流量自动归零/fault 自动撤销、原 auth 过期/吊销/窗口关闭、recovery auth 缺失/过期/跨 scope/跨 lineage、rescue 尝试激活/加流/新 fault 拒绝、journal/live-state 不一致、每级 ramp、CAS 后崩溃、回滚和终态缺失测试 |
| W7 | 实现在 T17 授权时冻结 retentionPolicy 与旧 Store identity 的 checker、机密制品删除/crypto-shred 与清理前门禁 | W1、W2 | L3 | 政策/Store 被替换、起止、可信时钟、后继发布、回滚重置、legal hold、对象版本/缓存/replica/backup 与未满周期拒绝测试 |
| W8 | 实现标准 Ask/agent 结构化引用、服务端诊断、`CitationLocatorCodec/StorePort`、权威 served-ID 映射、最小 IndexedDB 持久化和当前主体重新授权的内部预览 | W0、W2 | L3 | 随机句柄/AEAD、跨重启/多实例/环境重放、TTL/maxTTL、未知/吊销 key、轮换边界、store/keyring 中断、普通 Ask/agent/无引用、重复合法编号、非法 ID、Markdown、历史迁移、账号切换、权限撤销、tombstone/删除后缓存、恶意元数据和跨租户点击测试 |
| W9 | 全量集成、安全审查、构建、Runbook、本地 reference adapter conformance 与操作演练；明确真实企业 adapters 为外部前置 | W2-W8 | L4 | TypeScript/ESLint/定向与全量测试、生产构建、本地 Docker E2E、ports/reference adapters conformance、独立代码/架构/安全复审 |
| T16 | 使用通过独立 conformance 的真实企业 adapters 与有效 T16 execution authorization 执行 `off`/`shadow`，验证 SideEffectPolicy 与 Graph 候选诊断，封存 receiptCore 后取得独立 result attestation 并组装 acceptanceBundle | W9 + 全部 T16 外部输入 | L4 | pre/post side-effect readback、cache hit/miss、受控制品、arm readback、paired Shadow report、machine verdict、三层验收对象、真实 provider/registry identity、防篡改证明和零泄漏 |
| T17 | 消费有效 T16 acceptanceBundle，以 T17 authorization 与冻结 SafetyRecoveryPolicy 取得 scope lease/fencing；按冻结 arms/RampPlan/FaultPlan 完成零流量激活、放量前门禁、灰度、降级、摘流、受限 rescue、回滚和 PublicationIdentity readback，再组装 T17 acceptanceBundle | T16 + 全部 T17 外部输入/维护窗口 | L4 | arm/build/model/index/config/mode identity、lease/fencing、journal root/count、逐级权重/dwell/sample/SLO/TTL、FaultPlan 自动撤销、失锁自动零流量、适用的 SafetyRecoveryAuthorization/JIT 身份、rescue action、三层验收对象、最终 off/稳定 Pointer 与完整 readback |
| R18 | 只按 T17 authorization 已冻结的 retentionPolicyHash 与 oldStoreManifestHash 验证完整发布周期，不执行清理；封存 receiptCore 后取得独立 result attestation 并组装 acceptanceBundle | 有效 T17 acceptanceBundle + 冻结 Retention extension + 可信时间/后继发布证据 + R18 execution authorization | L3 | policy/store hash 精确匹配、回滚重置、时钟、legal hold、后继发布和事后换政策负测；三层验收对象；清理仍需 Goal 外独立授权 |

依赖顺序：W0 → W1；W1 后并行 W2/W5；W2 后并行 W3/W7/W8；W3 → W4；W2+W4+W5 → W6；W2-W8 全部完成后由 W9 汇总。W0-W9 只交付 provider-neutral ports、受限 reference adapters、独立 conformance harness/suite 和本地证据，不自行冒充企业 provider。T16 只消费有效 T16 authorization；T17 只消费有效 T16 acceptanceBundle 与 T17 authorization；R18 只消费有效 T17 acceptanceBundle、T17 时已冻结的 policy/store hash、经过时间证据与 R18 authorization。三阶段严格串行，不得与本地开发证据混淆。

## 5. 预计修改边界

优先复用而非复制现有能力，实际文件名在 Work 阶段以当前代码结构为准：

- `src/lib/rag/eval/**`：分阶段 manifest、arm、production target、runner、hard/configurable gate、journal、receiptCore 与 acceptanceBundle 合同。
- `scripts/**`：production gate 与 T17 编排 CLI；默认 dry-run，生产 mutation 需有效阶段审批、JIT 最小权限身份和专用 canary readback。
- `src/lib/knowledge-graph/**`、`src/lib/rag/storage/**`：PublicationIdentity、统一只读 readback、lineage 与幂等编排；不开放任意数据库查询。
- provider ports/reference adapters：实现第 3.4 节列出的 provider-neutral 接口、production-profile fail-closed 与统一 conformance harness；只暴露专用 canary 的零流量、模式切换/recreate、闭集 fault 和权威 readback，不包含真实企业 provider 实现。
- `src/app/api/**`、`src/app/page.tsx`、`src/components/ChatMessage.tsx`、`src/lib/indexeddb.ts`：标准/agent 引用输出、CitationLocator、最小持久化、诊断和当前主体重新授权的内部来源预览。
- `docs/runbooks/**`：经过测试的 operator 命令、JIT 权限、停止条件、崩溃恢复、回滚和机密证据定位。

禁止把生产凭据、完整 env、原始生产请求/响应、gold、用户数据、受控索引或可关联 hash 加入 Git。

## 6. 验证策略

### 6.1 本地自动化

- 单元：分阶段 schema/normalization/hash、T16/T17 arm diff、SideEffectPolicy、hard/configurable gate、RampPlan/FaultPlan、SafetyRecoveryPolicy/envelope、execution/result envelope、无环 receiptCore/acceptanceBundle、PublicationIdentity、冻结 retention 与 CitationLocator。
- Port 合同：第 3.4 节全部 provider-neutral ports 使用独立 conformance harness；fake/reference adapter 必须在 production profile fail-closed，真实 adapter 的 provider/version/config/artifact identity 可回读且不能自报通过。
- 安全合同：所有 provider endpoint 的 registry/origin/TLS/DNS/redirect/proxy/schema/size/timeout、Secret 晚注入、响应头默认空白名单、全链路脱敏、KMS AEAD/唯一 nonce/AAD object swap、签名角色/吊销/nonce/职责分离、闭集 FaultPlan 与不可放宽 hard gate。
- 文件、journal 与验收对象：路径穿越、reparse/hard link、exclusive create、fsync/atomic rename、大小上限、receipt 自引用/core-bundle 混淆/object-version 替换、journal entry 修改/删尾/截断/重排/重复/fork/旧 fence 注入、intent/result 每个崩溃边界、防篡改独立 head/readback及无终态 acceptanceBundle。
- 并发与恢复：两个 orchestrator 争用同一 scope、lease renewal/loss/network partition、stale fencing 对 journal/CAS/deployment/mode/traffic/fault 的逐端口拒绝；原 execution auth 过期/吊销/窗口关闭时，缺失/过期/越权 SafetyRecoveryAuthorization 必须拒绝，只有新 generation + JIT 身份可执行冻结的降风险动作。
- 集成：PostgreSQL + Neo4j + Milvus PublicationIdentity、Outbox ack、冻结 off/active arms、每级 RampPlan readback、FaultPlan TTL/撤销和 lineage+fencing rollback。
- E2E：本地专用 canary 的 `lease/fencing -> zero-traffic/off -> journal intent/result -> CAS -> projection/readback -> frozen off/active arms -> signed ramp -> signed fault -> withdraw/off -> recovery-authorized fenced rollback -> receiptCore(journal root/count) -> result attestation -> acceptanceBundle`，另覆盖已放量后 lease 过期/owner 崩溃时流量自动归零、fault 自动撤销，以及 rescue 尝试激活/加流/新 fault/跨 lineage 时被拒绝。
- UI/API：CitationLocator 随机句柄/AEAD、跨重启/实例/环境、TTL/maxTTL、key rotation/revocation、store/keyring 中断、当前主体重新授权、tombstone，以及普通 Ask/agent/无引用/合法重复编号/Markdown/历史迁移/恶意元数据/跨租户边界。
- 数据生命周期：T17-frozen policy/store hash、可信时钟、回滚重置、对象版本、缓存、临时文件、派生报告、replica/backup、legal hold 和 deletion/crypto-shred receipt。
- 回归：现有 RagEval、Ask route、Graph control、生产构建与 standalone trace。

### 6.2 生产门禁

生产命令只有在 W9 通过、对应阶段 validator 通过、部署侧 ProviderTrustPolicy 与独立 conformance receipt 有效、受控制品/KMS/secret provider 可用时才生成。任何正常生产请求或 mutation 前必须验证对应阶段 executionAuthorizationEnvelope；原授权过期/吊销/窗口关闭后的 rescue 不得复用它，只能以绑定实际新 fencing generation 的有效 SafetyRecoveryAuthorizationEnvelope 执行已冻结的降风险动作。执行完成后必须先封存 receiptCore 并独立回读防篡改对象，再由独立结果审批者签发 resultAttestationEnvelope 并组装 acceptanceBundle，才允许该阶段通过并成为下阶段输入。T16 只需要 T16 view；T17 和 R18 分别验证自己的 extension。任何 hard gate 失败立即停止，任何预检失败都必须零生产写入。生产验证结果只按有效 T16/T17/R18 acceptanceBundle 判定，控制台成功文本、HTTP 200、健康页或人工截图均不能单独替代。

## 7. 生产输入状态

| 输入 | 当前状态 |
|---|---|
| 脱敏代表性 V2 roster 及 gold | 缺失 |
| T16 批准的 trial 数、质量/延迟阈值；不可放宽安全 hard gate | 缺失 |
| off/shadow arm、shared/arm config hash、部署侧 target origin allowlist | 缺失 |
| 目标 environment/tenant/corpus、专用 canary/流量选择器、不可变 fault 资源 ID 与 PublicationIdentity | 缺失 |
| 部署侧 ProviderTrustPolicy/registry、各真实 provider/adapter 的版本/config/artifact identity、独立 conformance receipt 与 reference/fake/fallback 禁用证明 | 缺失 |
| Secret/KMS/Approval/TamperStore/Clock/AskTarget/Readback/Journal/Lease/Fencing/Deployment/Traffic/Fault/CitationLocator 企业 provider 与凭据引用 | 缺失 |
| 独立 result attestor 身份、职责分离、可信签认入口与防篡改存储 readback 身份 | 缺失 |
| CitationLocator 共享 store/keyring、服务端 Evidence resolver、TTL/maxTTL 与 rotation/revocation policy | 缺失 |
| T17 冻结 off/active arms、trial/warm-up、shared/arm config hash、逐级权重/请求数/dwell/abort、lease TTL/renewal/fencing 语义、签名 closed-set FaultPlan 与 SafetyRecoveryPolicy | 缺失 |
| T17 变更单、维护窗口、on-call、JIT mutation/read-only/rescue 身份、独立 recovery authority/签认入口、停止/回滚 owner | 缺失 |
| T17 authorization 时冻结的 retentionPolicyHash、oldStoreManifestHash、周期起点/重置规则与 TrustedClock provider | 缺失 |
| R18 execution authorization、经过时间或后继发布证据；实际清理授权另属 Goal 外 | 缺失 |

## 8. 回滚与终止条件

- 本地实现任一 L4 安全/一致性测试失败：停在 Work，不进入 Review。
- T16 数据、制品、sharedConfigHash、armConfigHash/mode 或 roster hash 不一致：作废整次 run，不拼接报告；served Evidence/context/prompt/cache identity 强一致，回答只按批准语义阈值比较并区分 cache hit/miss。
- T16 未通过：保持 `off`/`shadow`，禁止 T17。
- T17 任一 off/active arm identity、trial/warm-up、Outbox ack、PublicationIdentity、RampPlan step/dwell、权威流量 readback 或放量前 verdict 不一致：不得进入下一 ramp；摘流并执行 off-first、lineage+fencing 回滚。
- T17 失锁、续租失败、fencing generation 变化或 owner 崩溃：旧 token 对所有 adapter 拒绝，流量 lease TTL 自动归零、fault TTL 自动撤销；旧 owner 停止动作。rescue 必须取得新 generation、独立 SafetyRecoveryAuthorizationEnvelope 与 JIT 凭据，并验证 journal chain/head/live state；只能执行冻结的降风险动作。缺少授权、journal 不可信或无法确认零流量/off 时禁止自动 Pointer mutation，并进入事故处置。
- 已放量后普通 gate 失败：持有有效 generation 时先从权威流量控制面摘除 canary，强制切换/recreate 为 `off` 并回读，再按本 run lineage 回滚 Pointer；CAS 只恢复图身份，不能代替流量和进程模式回滚。
- FaultPlan 签名无效、动作不在闭集、资源 ID/参数/TTL 越界、stop condition/kill switch 触发、撤销失败或影响非 canary：立即停止 fault；由 adapter deadman 执行冻结撤销动作，无法确认恢复时进入事故处置，禁止继续采样。
- 阶段凭据缺 pre-run executionAuthorizationEnvelope、immutable receiptCore、独立 post-run resultAttestationEnvelope、无环 acceptanceBundle、exact digest/version 防篡改证明或终态：该阶段无效；按 journal、lease/fencing 与现场 readback 安全恢复或人工处置。
- 安全 hard gate 任一触发：立即停止后续请求/mutation，不用聚合平均值覆盖单例违规。
- 发布周期未满、权威时钟不可用、legal hold 未解除或删除范围不完整：禁止历史清理。

## 9. 完成定义

只有下列条件全部成立，活动 Goal 才能标记完成：

- W0-W9 均有与风险等级匹配的测试、构建和独立复审证据。
- 所有 provider-neutral ports、独立 conformance harness 和受限 reference adapters 已实现；production profile 对 fake/reference/fallback fail-closed，且真实企业 adapters 由外部独立 conformance receipt 证明后才进入 T16。
- 标准 Ask 与 agent 路径均产生结构化引用或明确无引用诊断；CitationLocator 跨实例可解析、具 TTL/完整性和受限 key rotation，点击时由当前 principal 重新授权且查询 tombstone，客户端 Evidence/locator 均不具有授权能力。
- T16 acceptanceBundle 同时具备有效 execution authorization、immutable receiptCore、独立 result attestation 和 exact 防篡改存储证明，证明 Shadow SideEffectPolicy 与候选诊断达到冻结阈值，但不越权宣称 Active 答案提升。
- T17 在放量前通过同 roster `off`/`active` 多跳质量、引用、安全、P95/超时门禁，并完成 lease/fencing、可验证 journal chain/root、逐级 RampPlan、闭集 FaultPlan、失锁 fail-safe、专用 canary 激活、降级、摘流、SafetyRecoveryAuthorization 受限 rescue、lineage 回滚和最终 PublicationIdentity readback；T17 acceptanceBundle 三层对象全部有效。
- 最终 canary 权重为零且进程 `off`，Pointer 位于批准的稳定身份，未遗留意外 Active Pointer、非零 TTL 流量或共享/未撤销故障注入。
- R18 只按 T17 时冻结的 retentionPolicy/old Store identity 验证完整周期并生成有效 acceptanceBundle；旧 Store 的实际清理不属于本 Goal，仍需 `validateForCleanup` 与单独删除授权。
- 没有把 synthetic、hermetic、本地 Docker、HTTP 200 或截图冒充生产质量证据。
