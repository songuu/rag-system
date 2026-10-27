# 私有 authority 会话的实际 bundle 封存（2026-10-10）

## 结论与边界

已补齐 W2 的本地参考 bundle writer 切片。普通与完整 manifest writer 新增 `sealBundle({ resultEnvelope })`：沿用同一私有执行会话已经真实封存并读回的 core，而不是接收 caller core、bundle、时间或通过标签。实际独立 result 签名和 nonce approval 后，分别加密、不可变封存、exact-version 读回并解密 result envelope、core readback proof、最终 acceptance bundle。真实输出可以直接接入历史 receipt observer 与冻结后继 predecessor verifier，无需测试夹具手动持久化 bundle。

`productionAccepted`、`stageAcceptanceComplete`、`machineGateComputed` 始终为 `false`。这里没有重算 W4 machine gate、验证完整递归前驱阶段、组合冻结策略 recovery 或完成企业 provider/IAM/WORM 验收。签名 core 中的 `machineVerdict` 被忠实保存，不冒称由 writer 计算。失败 verdict 同样可封存审计对象，绝不提升为通过。

权威计划 `docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md` 仍为 WORK/ACTIVE 2/13，仅 W0/W1 完成；W2–W9、T16/T17/R18 和 18 项端到端 AC 开放。用户直接授权允许继续实现与本地验证，不会生成实际 dataset/gold、阈值、企业身份、窗口或真实 elapsed 证据。

## 实现合同

请求封闭为一个实际 `resultEnvelope`。私有保存 core seal、已验证 journal head、实际 execution envelope、registry/provider selection 和 approval verifier；结果 payload 除签名方 metadata 外，全部由独立 frozen execution 和实际 core/ref 派生。writer 与 reader 共用该派生函数，拒绝 stage/scope/run/manifest、report/index、core/version、execution ref、verdict/final state 被重标。

状态从 core-sealed 进入 bundle-sealing，再进入 bundle-sealed；三个入口共享 busy/halt。core 尚未封存、重复 bundle/core 或 caller 额外标签在 IO 前拒绝。坏的结构/签名预检不破坏尚可使用的 core 会话；实际 bundle 操作开始后的失败终止会话，没有自动重试或删除已提交对象。

同一个 nonce verifier 实际消费一次 execution 和一次 result，不能通过构造新 verifier 重置额度、时钟或角色。返回 provenance 来自 actual result consume 请求的原 clock reading 和已校验的 exact nonceClaimRef；历史读回只读该 claim，不重消费、不续权。

result issuance 必须不早于私有 core authority observation 的真实完成时钟完整 uncertainty 上界。不能只使用 core proof 的旧 correlation label。writer challenge 集合独立有界：完整会话 begin 7、core 18、bundle 55，共 80；配置的最小一个 execution session 可以完成整条路径。此 IO 预算不改变 nonce verifier 的原审批 attempt 额度；后者只有一次时 result 仍拒绝且不重新构造 verifier。

三个对象按以下顺序执行 encrypt → immutable seal → independent exact store read → decrypt：

| 对象 purpose | canonical 明文 | AAD schema |
|---|---|---|
| result-attestation | 实际独立签名 result envelope | 实际 envelope schema |
| readback-proof | 已封存 core 的真实 readback proof | kg-receipt-readback-proof/v1 |
| acceptance-bundle | 仅前向引用 core/result/proof 的最终 bundle | kg-stage-acceptance-bundle/v1 |

补充 `readback-proof` 为封闭 controlled-artifact purpose。每个对象的 ID 由 scope/run/manifest、实际 core ref 和明文摘要派生；实际存储随机版本来自 reference store。逻辑 ref 和密文 storage ref 必须同 ID/version，前者摘要是 canonical 明文，后者摘要是完整密文/AAD/retention 对象，不能混用。core 不增加 bundle 回指，不改已保存的原对象。

每个实际 crypto/store callback 前先 exact journal head 对照，再 fresh challenged clock/registry；完整 uncertainty 区间同时检查 execution/result 签名有效性、stage window、retention、实际 provider trust。最后一道 live 校验和实际 dispatch 之间无 await。对象 context 时间仅是来自实际 reading 的相关性标签，不替代实时权限。最终观察另记录 fresh completion clock、registry 与 bundle readback hash。

AEAD/AAD、实际存储对象、闭合 proof 的 source/reader/ref/lock/retention/time、canonical UTF-8/base64url plaintext 全部严格核对。配置、请求和 key roots 在 await 前快照/冻结，descriptor-safe 回调提前捕获；getter/Proxy/thenable 不得执行钩子。bounded native Promise UNKNOWN 或超时后停止；迟到提交不会继续 proof/bundle IO，已提交对象保留审计。

全部运行均为内存 `local-reference`；没有实际网络/企业权限、跨实例持久性或生产 WORM 证明。

## TDD 与失败保留

- 原入口缺失 RED：`node --test --test-timeout=30000 --test-name-pattern=both private-session writers expose src/lib/rag/eval/production-authority-bundle-writer.test.mjs`，0/1、exit=1，`sealBundle` 实际是 undefined；stdout SHA256 `742c8b8de995d9eb3c9bd8df2d4980555081b4a798db6f9a293e590c4cdc62e5`。
- 首次实现后新增 16/16；strict16/lint3 exit=0。首次 narrow stdout SHA256 `4bea2773a2cea0dabd8a9c462aff628189810715b07be34ae71d4d131d3eac93`，duration_ms=9023.7595。首次 local 502/502、cumulative 645/645 是中间绿色，不是修复后的最终验收；对应 stdout SHA256 `b32cd4eba305aef54abf9f02952be9146890dd5fbe06160948ab3eb37460e359`、`428fb359a58b59418fe352d1a5c66ca220ef6cc2e39a7bdf3cd029b844ca1428`。
- 独立审查提出真实完成时序疑点；主 agent 实际推进 core decrypt 后时钟到 04:00:50，而 result issuedAt=04:00:40、proof label=04:00:30。新增原预算 leaf 0/1、exit=1、Missing expected rejection，stdout SHA256 `73527f4e32e7b2a1eefa1cadb5d0965ccd399dd850fc84dfd0b5c9767f9c7752`。修复真实 completion upper-bound 门禁，没有接收 caller time 标签。
- TypeScript 独立审查提出旧 core-only challenge 预算问题；主 agent 实际配置 writer maxVerifications=1、保留原 approval verifier 额度，新增原预算 leaf 0/1、exit=1、journal: attempt-capacity，stdout SHA256 `5dc41d265ac87b9c189aa5f91f00a1edd5ff78aa8fbea9f731b5d20c70ecd432`。将预算按完整会话的实际 80 次 challenge 计算，另加 approval max1 无 result 消费/不重建的负测。
- 修复后 expanded 首轮 18/19，stdout SHA256 `0c7acf99506fe43f435dcb245a1caa8c609043ed5a05a77595acfd4350f0ac1f`，duration_ms=9866.1294。失败发生在 500ms uncertainty 夹具 begin 的 registry 校验：初始 clock=授权 startsAt，误差下界早于 grant。修正夹具实际 clock advance 到 begin+500ms，使起始整个区间合法再命中 post-core 边界，不放宽 runtime 门禁。随后新增 19/19、strict16/lint3 通过；stdout SHA256 `755e4154718a3e00848cc3dc270f73689352b962df0d835ac3bdf706f421751f`、duration_ms=9909.9776。
- 19 项覆盖三阶段真实对象与后继消费、caller 标签/签名/绑定替换、actual approval provenance、failed verdict、授权过期（包括 journal IO 和已提交 storage 后）、跨入口 clock regression、错误 proof/AAD/object/plaintext、UNKNOWN 与迟到完成、共享 busy lock、await 漂移、恶意钩子、真实 completion 全误差时序及独立 session/approval 预算。没有降低负测断言、跳过或延长 test deadline。

既有 Ask 503/200、500/200、EPERM、journal/nonce UNKNOWN、30s timeout，以及前几轮跨入口时钟 HIGH 和真实时序 RED 保留在历史报告。本轮绿色不宣称这些未知根因已被修复。

## 验证证据

原 `node --test --test-timeout=30000`；无 skip/preload、deadline 放宽、concurrency/isolation 改动或持久环境切换。仅测试子进程 `RAG_SEMANTIC_ROUTER=off` 沿用基线；90s 外层观测和 16MiB 输出上限。下表 UTC；最终检查均 exit=0、stderr 空，测试 fail/cancelled/skipped/todo 均为 0。

| 检查 | UTC 起止 | 结果 | duration_ms / stdout SHA256 |
|---|---|---|---|
| strict16 | 04:25:18.500–04:25:19.450 | exit 0，stdout/stderr 空 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| lint3 | 04:25:19.451–04:25:20.964 | exit 0，零 warning | 同上 |
| bundle19 | 04:25:20.964–04:25:31.148 | 19/19 | 10149.3036 / ebdd3121c322def47ca5e0f031154e37b3f78912c2f8efc10cfab0fb7607cc4d |
| local22 | 04:25:31.148–04:25:52.812 | 505/505 | 21626.5645 / ae7496099e3ef9b7e1a13cbe0085ee50a7b5525c68358f6c07a8a6575bc1a91a |
| cumulative33 | 04:25:52.813–04:26:14.692 | 648/648 | 21840.656 / 45a4a53a76dda1b20770a19488de4bec204e3a132624603ca466a53151df576a |

strict16：`node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`，对 eval 下 canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance、production-authority-ports、production-authority-approval、production-authority-conformance、bounded-provider-call、production-provider-registry、production-authority-receipts 共 16 个 `.ts`。lint3：`node node_modules/eslint/bin/eslint.js --max-warnings 0` 对下表三个文件。

local22：上述 16 模块 `.test.mjs`，加 authority-receipt-writer、manifest-authority、approval-provenance、existing-receipt、predecessor-receipt、authority-bundle-writer 六个测试。cumulative33 在此基础上增加 eval dataset/metrics/gate/matrix/production-policy-contract、context-composer-v2、legacy-evidence-adapter、KG contracts/postgres-publication-store/graph-snapshot-recovery、Ask route 共 11 文件。

73 个 source/test/fixture/request-validation 文件执行前后 SHA256 一致（drift=[]）；集合是上轮 `2026-10-10-rag-predecessor-bundle-readback.md` 的 72 文件加 bundle-writer 测试。本轮仅下列 source/test 身份改变，其余既有文件保持原值：

| 文件 | SHA256 |
|---|---|
| src/lib/rag/eval/production-authority-receipts.ts | 421452d89a1b040d773b7883fcfd4e1da5d6fc5fb9376b1647bb1741c48b4bb8 |
| src/lib/rag/eval/production-controlled-artifacts.ts | 4491761221e72e3ae98216b000ab73efab50c39bf690bf9946ff57545d286b5c |
| src/lib/rag/eval/production-authority-bundle-writer.test.mjs | 1071f16cae36121cbb9736a584eae4e86a9ae45f26b1385680a7f48e6673f816 |

`git diff --check` exit=0；30 条既有 LF→CRLF 提示保留。用户 staged/unstaged/untracked 和无关变更均保留。未 commit/push、写 learning/Compound、改 env/生产策略、发流量、触发 fault/cleanup 或创建 acceptance harness binding。

## 独立审查

功能/正确性独立终审 APPROVE，上表三个 SHA 审查前后精确一致。指定六文件原 `--test-timeout=30000` 组合（bundle、writer、manifest-authority、approval-provenance、existing-receipt、predecessor-receipt）97/97，suites=0、exit=0，fail/cancelled/skipped/todo 全 0，duration_ms=11839.8565。独立实际 core 完成时钟 04:00:50/零误差及 04:00:40/500ms 两例均在新 IO 前拒绝 04:00:40 的 result；新增 provider calls=0、nonce/store 都保持 1→1。没有新 actionable findings，只批准此 local-reference 切片。

TypeScript/async 独立终审 APPROVE，上表三个 SHA 审查前后精确一致；独立 strict16/lint3 均 exit=0、未改文件或重复累计测试。确认完整 80 challenge 路径无 off-by-one，original nonce 审批额度未重置，actual completion 全误差时序、captured/frozen inputs、共享状态、UNKNOWN/迟到完成边界保持。

初次功能审查在旧 94/94 快照后曾因工具内容审查中断，未将其视作 APPROVE；主 agent 保留真实两项 RED、修复和回归，再进行上述新 SHA 独立终审。旧 94/94 或首次 645 个绿色不能替代本次终审。两项批准都不代表 W2/生产或完整阶段 acceptance。

## 下一步

继续 W2 剩余共同 operation ports、各 purpose 的实际独立 behavioral harness、冻结策略 recovery/新 fence/独立 rescue principal 与周期续期证明组合。按既定依赖完成 W3/W4 的实际 runner/computed machine gate、完整递归阶段 acceptance，以及 W5–W9；企业 trust/IAM、真实数据/阈值/维护窗口和实际 elapsed 仍是生产前置。本轮真实 bundle sealing 只解除手工持久化 bundle 的本地缺口，不改变整个目标或生产门禁。
