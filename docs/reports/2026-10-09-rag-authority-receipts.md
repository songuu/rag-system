# W2 authority-aware 回执实读组合

日期：2026-10-09。所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。本报告记录可执行本地消费链，不表示 W2 或任何生产阶段完成。

## 已实现

新增 `createReferenceAuthorityReceiptVerifier`，不接收调用方伪造的 approval/trust decision。其私有配置冻结 expected execution payload/ref、provider bindings、fencing generation、registry/source/public roots、store source 和 approval key/clock/nonce anchors；每次调用重新实际读取并验证：

1. bundle/core/envelope 无环结构，部署配置中的 exact execution payload/ref；执行签名在 run 开始/完成/封存时间实际 Ed25519 验证，封存必须位于关闭边界前，结果业务载荷从独立 core/config/ref 推导，结果签名在 bundle 时间预检。
2. 带独立 challenge/context 的 registry exact readback，policy hash/scope/version/source 和 provider conformance/runtime 实际签名；冻结的 pre-run proofs 必须在 startedAt 已有效，core runtime readback refs 必须与已验签对象集合一致。
3. 独立 `head -> entries -> head` journal 实读，两个 head 必须稳定且与 receipt 精确绑定；完整 chain/terminal 验证后逐 entry 核对 actor、authorization digest、冻结 fence、stage action 和执行签名时间。新共享冻结 `STAGE_EXECUTION_ACTIONS` 让 writer/readback 使用同一闭集，不扩大 writer 权限。
4. 独立只读 store 实读，精确 physical storage reference/digest、十字段 AAD、envelope、retention 和 source/reader proof；实际 KMS 解密必须得到 canonical receipt core，而不是接受调用方 plaintext/hash 自报。
5. 复用已有实际 authority approval factory，以独立 clock/nonce ports 验结果签名、全误差时间、原子 nonce 消费及 exact readback，最终再读 clock。
6. 在最后 clock 读数的完整误差区间重新验 provider/key/registry validity，并验证保留尚未过期；从最终检查到返回没有 await。

registry/journal/store/KMS 的外部只读核对先于结果 nonce 消费；approval 内部仍按初始 clock、consume、exact nonce readback、最终 clock 的顺序执行。每次重读，无成功缓存；busy/attempt 容量、配置/request/方法 receiver/roots 快照明确。非标准 carrier/thenable/未知完成 halt；result nonce 消费后任何失败 halt，不假设 rollback 或偷偷重试。错误只含固定 code/phase/nonceOutcome/pending 状态，不转发 provider exceptions。

journal 保持既有 10000 entries/16 MiB profile，每 entry descriptor-safe canonical detach，拒绝 Proxy、稀疏/额外字段、array/element accessor。不会把合法完整链强塞入单 JSON 对象的 256 KiB 限制；实测 403-entry 大链可通过。其他 provider payload 在 async return 前同步 detach，避免 then 二次 adoption。调用预算 1–60000 ms，实例 attempt 上限 4096；这些不构成同进程沙箱、取消或完整 workflow wall-clock SLA。

输出为 confidential `local-reference-authority-readback` observation，含精确 bundle/core/journal/store/registry/approval hash。`productionAccepted=false`、`stageAcceptanceComplete=false` 固定；`machinePassed` 只反映签名 core 中的声明，并未计算 W4 machine gate。T16/T17/R18 普通 reference bundle 都覆盖，但带 recovery refs 的 bundle 仍按既有结构 helper fail-closed；T17/R18 predecessor 的真实性没有在这里获得验证。

## 文件范围与实际红绿链

- 新增 `production-authority-receipts.ts`、对应测试。
- 从 registry test 原样抽取真实签名 fixture 到 `production-provider-fixtures.test-support.mjs`，不复制第二套 provider fixture；registry 的 18 项行为保持。
- `production-authorized-journal.ts` 仅导出并冻结原有 stage action 集合，供两个消费者共用。
- 没有修改 Ask/API、生产配置、`.env`、用户开关或真实 runner；没有外部连接、mutation、fault、清理、commit/push。

实际执行：

1. 新模块缺失的 RED：两文件组合 18 passed/1 failed（registry 18 仍通过），461.7929 ms；缺失模块子测试 76.8486 ms。
2. 首实现组合 59/60，543.6635 ms；失败是负测直接修改冻结 core。复制后变异，组合 60/60，607.5036 ms，strict TS 与五文件 lint 退出 0。
3. 增补 journal 重新 hash/seal/sign 的 actor/digest/action 越权、>256 KiB 合法链、array/element getter、全误差 expiry、signed failed verdict 和 recovery 缺失 characterization。初次 65/66，756.9932 ms，负测修改了冻结 entry；复制后组合 66/66，823.9183 ms。两次 fixture 错误不伪称实现安全缺陷，后补绿色测试不伪称先红后绿。
4. pending-native timeout 仅用 test-context `performance.now` mock 固定 pending phase；真实 elapsed 调用器测试在既有累计范围保留。未知完成仍 halt，不宣称终止后台工作。
5. 独立审查指出 sealedAt 漏检：真实重签 execution 使 `completedAt < expiry < sealedAt`，实际 RED 0/1，158.5508 ms，Missing expected rejection。新增 sealedAt 验签与显式窗口边界后，合法四 case GREEN 1/1，551.3504 ms，组合 67/67，827.3829 ms。首修复复核 0/1 + 66/67 是一个 window fixture 的 expiry 超过 window end，被配置 schema 正确拒绝；修正 fixture，不放宽合同。修复的是验收假通过，并未替代 writer 在实际 KMS/store 写入前的 authority gate。
6. 独立审查指出 provider 后发资格追认：真实重签晚生效 policy/keys/certificates 及依赖的 execution/core/result，实际 RED 0/1，164.6349 ms。要求冻结 pre-run selection 在 startedAt 就有效，后续 bundle/final 区间复验保留；三 case GREEN 1/1，183.6264 ms，组合 68/68，947.4869 ms。最终新模块 20 tests。

## 有界回归（候选与最终身份区分）

Node 子进程 `--test --test-timeout=30000`，外层 timeout 90000 ms、输出上限 16 MiB；沿用现有测试子进程 `RAG_SEMANTIC_ROUTER=off`，没有持久环境变更。十六合同为前十五加 authority-receipts，累计加原 W0 十一文件，形成 27 文件并集。

| 范围 | 结果 / duration | UTC 起止 | stdout SHA-256 |
|---|---|---|---|
| 时序 P1 修复前十六合同候选 | 394/394，27536.7114 ms | 12:21:19.947–12:21:47.521 | `5cd7ec113d605c4c31e22bdb32615213386c263227f318ce7628adbedd47900d` |
| 时序 P1 修复前 27 文件候选 | 537/537，29161.3313 ms | 12:21:47.523–12:22:16.721 | `3b72c870e7a5692b61aa041312eaacafed306ae160af13c6c5b0fb612822956b` |
| 时序 P1 修复后十六合同 | 396/396，28074.3588 ms | 12:38:31.493–12:38:59.608 | `1400fbca70dc7359a2c8a09a6c9a5bf8b10ead05368b31d223a7fde64fbfb8b5` |
| 修复后 27 文件首轮 | exit 1：464 passed / 1 cancelled，30018.0389 ms | 12:38:59.610–12:39:29.682 | `7054e98879ab8c3cd3b5c369a3edcc21ab4c46262adc1791cdebd0040346386a` |
| Ask 隔离复核 | exit 1：0 passed / 1 cancelled，30013.3214 ms | 12:45:12.601–12:45:43.112 | `d25488dd7db438375dd80f6a4a353687439cde0b088171b0762c95a04bfafa24` |
| 移除诊断钩子的 27 文件复核 | exit 1：538/539，27301.8351 ms | 12:53:24.333–12:53:51.679 | `f03a1064da664221d3692d10deb71a512800e161f1bf56218265fdbd90ff7583` |

前两轮是修复前候选，不覆盖当前身份。当前十六合同为 0 failed/cancelled/skipped；累计首轮与 Ask 隔离都触发原有 30000 ms 文件超时，尚未进入内部测试。首轮 strict16 退出 0，lint5 在外层 90000 ms ETIMEDOUT；隔离 lint5 同样 ETIMEDOUT。未扩大预算、跳过测试、改变并发或持久环境。

只读临时 loader 诊断保持原预算：Ask 75/75，27516.1223 ms（12:50:57.453–12:51:25.004），stdout `c8481d222edd5f6627428ff5c4e806bcd9b32d8868e4a8e08caa4f607c438ba8`；lint 退出 0（12:51:25.007–12:51:44.464），trace stderr `ba8802664fedcb4c38d507818d16bfc35bc046cc9830b0723f277875346c7e90`。观察到 1428/2488 个模块 load，不足以归因之前的超时；有诊断钩子的绿色不计作原命令累计验收。

原命令最终复核的唯一失败为既有 `POST durable createAgent replay preserves safe agent and workflow diagnostics`（route.test.mjs:1901），actual HTTP 500 / expected 200，根因未知；不把历史 EPERM 推定为这次原因。最终 strict16（12:53:51.682–12:53:54.346）及 lint5（12:53:54.347–12:53:55.908）退出 0、双流为空。所有上述正常测试的 stderr 为空。空流 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。当前累计回归明确未通过，停止无依据重试；局部通过与独立审查不能替代它。

65 文件有界源码/测试 snapshot 前后 drift=[]，不是整个共享树或全部传递依赖冻结。直接定向 Node 仍有既有 MODULE_TYPELESS_PACKAGE_JSON warning，未修改 package.json；历史未知失败/EPERM/超时记录保持，不据本轮绿色声称已根治。

| 文件 | 修复后最终快照 / 独立审查 SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-receipts.ts` | `161f12ba90892217168e6c5bba426a6199a0916c7a4b8545fea945dbeef74829` |
| `src/lib/rag/eval/production-authority-receipts.test.mjs` | `cb89a732ef7ac7651263917eeb3636e72e14f0509a51d741c8035822791f73e7` |
| `src/lib/rag/eval/production-provider-fixtures.test-support.mjs` | `fd5fb04cf2443bb8352a11edeefe9ab0add9e40a7cebb3ae5d26876414cb5bb1` |
| `src/lib/rag/eval/production-provider-registry.test.mjs` | `7c319140918bf9698f25134674af7970a022fa95f60aa17d488b57d0610809bf` |
| `src/lib/rag/eval/production-authorized-journal.ts` | `10be3ec5f7c8d57487c6fb0bed9352ce512b51f466e0b0bea3ce3b4641167c27` |

共享 fixture 与公共动作导出使前报告中的这两个历史文件身份变化；历史证据不覆盖、不混作当前身份。

## 剩余工作

后续 receipt 依赖升级见 `docs/reports/2026-10-09-rag-receipt-writer-boundary.md`：四阶段基础有界/载荷边界已实现，authority-aware sealing 仍未完成。本报告五文件 SHA 不变，但这里的 396/396、538/539 是依赖升级前的切片历史，不覆盖最新组合身份或失败；最新整轮结果以该后续报告为准。

独立 reviewer 对表中精确五文件最终快照返回 APPROVE，无剩余 P0/P1/P2，独立定向 68/68、strict16/lint5 通过且未修改文件；结论只限此局部 false-production 组合，不把当前累计 538/539 声称为成功。本切片不提供 enterprise registry/IAM/time/revocation/durable nonce/真实 WORM/source 证明，不验证完整行为 suite、前序 acceptance、冻结 recovery policy/lineage/new fence 组合或 machine gate。receipt sealing writer 的完整有界/authority-aware 集成、全部共同 ports 与 manifest/trust/writer 仍需继续。

当前 observation 使用一组冻结的 pre-run runtime proofs，要求它在 startedAt/bundle/final 时间均有效。短 TTL 不能被延长或用后发证明回填；长运行的周期测量/更新及其 journal/provenance 链仍需后续编排实现，不把本组件宣称为完整长跑生产阶段验收。

W2 整项未完成；W3-W9、T16/T17/R18 不缩减或改名完成。目标保持完整，生产仍需实际 roster/gold/批准阈值、冻结部署身份、独立签认、维护窗口与真实留存时间。
