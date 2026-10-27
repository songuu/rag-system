# 冻结前驱 bundle 的真实对象读回（2026-10-10）

## 结论与边界

已补齐 W2 的一个本地参考切片：T17→T16、R18→T17 的冻结前驱引用，必须对应实际 exact-version 密文存储对象、真实 AEAD 解密内容以及完整历史 receipt authority 读回。不能用 caller 的 bundle、通过标签或旧 decision 代替实际 IO；不会再次消费前驱 result nonce，不续权、不写入或删除对象。

这不是完整前驱阶段验收。`productionAccepted`、`stageAcceptanceComplete`、`executionAuthorized`、`nonceConsumedByThisVerifier`、`machineGateComputed`、`predecessorChainComplete` 全部固定为 `false`。`predecessorLinkVerified=true` 仅表示本次对象/内容/manifest 关联验证。结构化签名 `machineVerdict=passed` 仍不能替代 W4 的实际 machine gate 重算。

权威计划仍为 `docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`；WORK/ACTIVE 2/13，仅 W0/W1 已完成。W2–W9、T16/T17/R18 与 18 项端到端 AC 仍开放。直接授权并没有提供真实生产 dataset/gold、冻结阈值、企业 registry/IAM 或维护窗口。

## 实现合同

新增 `createReferencePredecessorReceiptVerifier`，配置是封闭的 `executionProfile / successorManifest / predecessorReceiptOptions`。从独立 prior 完整 manifest 派生 execution binding；冻结 successor 对应阶段、scope、prior manifestHash 与逻辑 acceptanceBundleRef。R18 还必须逐项匹配实际 T17 manifest 的整个 frozenRetention（policy、oldStoreManifest 及两个哈希），不能只比较 R18 自己生成的标签。

请求封闭为 `bundleStorageRef / bundle / evidence / conformanceObjects / runtimeObjects / resultApprovalProvenance`。候选 bundle 先通过现有封闭 receipt 合同，并与 successor 冻结的逻辑内容哈希相符；候选内容本身不能替代存储读回。

两个引用的含义不同：

| 引用 | objectId / objectVersion | sha256 |
|---|---|---|
| 冻结 acceptanceBundleRef | 实际 bundle 对象的同一不可变 ID、版本 | canonical plaintext bundle |
| bundleStorageRef | 必须与上述 ID、版本相同 | 实际 ControlledArtifactObject（密文、AAD、保留时间） |

实际读取与验证：

1. 捕获的只读 store 回调读取 exact ciphertext version，校验对象哈希、闭合 proof、来源、reader、immutable lock、retention；AAD 必须绑定实际 prior scope/run/manifest、`acceptance-bundle` purpose、objectId、ordinal=0 和 bundle schema。
2. 捕获的 KMS 回调实际解密；返回值必须严格等于冻结候选 bundle 的 canonical UTF-8/base64url 字节，拒绝非 canonical、替换内容、乱码、错误编码和超界载体。
3. 私有 manifest-aware `verifyExistingBundle` 重新验证真实 registry/trust、稳定完整 journal、实际 encrypted core/AEAD、独立签名与 result payload、actual original nonce claim、fresh challenged clocks。不是接收 caller verifier 或缓存成功标签。
4. fresh final clock 的完整 uncertainty 上界必须仍在 bundle retention 内。T17 窗口必须晚于 bundle 创建时间，且不能早于已经独立验证的原始审批 clock 的完整 uncertainty 上界。

上下文历史时间只用于相关性，来自已经匹配冻结内容哈希的 bundle，不是当前时钟或权限。actor 从独立配置的 readOnlyId 派生，不采纳 caller 角色。成功只读观察不会调用 encrypt/seal/nonce-consume。工厂共享一个 busy lock、attempt budget 与 halt 状态；UNKNOWN/非法 Promise 载体后停止，迟到完成不能继续下一次 IO。构造时和第一个 await 前深拷贝/冻结数据、捕获 descriptor-safe 回调，禁止 getters/Proxy/thenable 钩子。

本轮未改 manifest schema、原普通/历史 reader 的 authority 算法、生产配置、env、流量、故障、数据库或外部状态。测试夹具直接用真实 reference AEAD/store 持久化 bundle 仅用于本地验证；它不是生产 authority bundle writer。

## TDD 与失败保留

- 新入口未实现时：0/17，确认缺少 `createReferencePredecessorReceiptVerifier`；并不把随后定位的夹具错误混同为产品缺陷。
- 首次实现：14/17；3 项已定位为夹具问题（直接修改冻结的 storage ref 两处、替换 KMS 回调未记录调用一处），strict 通过。修正为独立 mutable input clone 与准确 callback 记录，没有降低 runtime 断言。
- 第二轮：16/17；剩余失败是测试预期引用与 caller 配置共享对象，被测试自身篡改。实际 observer 已正确保留旧哈希；将独立预期引用与被篡改配置分离。
- 补充时序 RED：真实 prior bundle 创建 04:00:50、actual result nonce 审批 04:01:00，successor T17 窗口 04:00:55；旧实现没有拒绝（0/1，`Missing expected rejection`）。修复为验证 actual original approval 的完整 uncertainty 区间，再判断窗口，未用 caller 时间提示或 decision 标签。
- 最终新增 19/19、strict16/lint2 通过。原 17 用例均保留，另外新增上述时序与冻结内容哈希拒绝时间替换用例。

历史 Ask 503/200、500/200、EPERM、journal/nonce pending、30s timeout 和上一轮跨入口时钟 HIGH 及其 RED 仍保留在既有报告。本轮绿色不能宣称这些历史失败的未知根因已经解决。

## 验证证据

执行原 `node --test --test-timeout=30000`；无 skip、preload、deadline 放宽、concurrency/isolation 调整或持久环境切换。仅子进程 `RAG_SEMANTIC_ROUTER=off` 沿用基线，90s 外层观测/16MiB 输出上限。以下时间均 UTC，所有最终命令 exit=0、stderr 为空；fail/cancelled/skipped/todo 均为 0。

| 检查 | 起止时间（UTC） | 结果 | duration_ms / stdout SHA256 |
|---|---|---|---|
| strict16 | 03:53:46.826–03:53:47.715 | 0，stdout/stderr 空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| lint2 | 03:53:47.716–03:53:49.174 | 0，零 warning | 同上 |
| predecessor19 | 03:53:49.174–03:53:57.729 | 19/19 | 8520.9206 / `828e450be94ecda022751377ff4ecef05bc37edf8cc0f15c4266e321cb797102` |
| local21 | 03:53:57.729–03:54:18.362 | 486/486 | 20595.2732 / `843a6cc0a526e2bb66153fa479b63b809ffde082f127323670d7205ff0a407ca` |
| cumulative32 | 03:54:18.364–03:54:41.387 | 629/629 | 22986.6565 / `aa1f1f7bec31df3bd66fd51545175c731c7a54bcdb6ea8000062ed101e979a47` |

strict16 使用 `tsc --noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`，模块为 canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance、production-authority-ports、production-authority-approval、production-authority-conformance、bounded-provider-call、production-provider-registry、production-authority-receipts。lint2 对下表两文件执行 `eslint --max-warnings 0`。

local21 是以上 16 模块的 `.test.mjs`，加 authority-receipt-writer、manifest-authority、approval-provenance、existing-receipt、predecessor-receipt 五个测试。cumulative32 在此基础上增加 eval dataset/metrics/gate/matrix/production-policy-contract、context-composer-v2、legacy-evidence-adapter、KG contracts/postgres-publication-store/graph-snapshot-recovery、Ask route 共 11 个测试文件。

72 个 source/test/fixture/request-validation 文件执行前后 SHA256 一致（drift=[]）。集合沿用 `2026-10-10-rag-existing-receipt-readback.md` 的 71 文件集合，加新增 predecessor 测试；本轮更新 identity 如下，其余既有文件未改。

| 文件 | 最终 SHA256 |
|---|---|
| `src/lib/rag/eval/production-authority-receipts.ts` | `0b5e0c7a598fd1d585a3a7a5a3b3f69ea4f4d4afa7e9d61bf00b3c06e918f156` |
| `src/lib/rag/eval/production-predecessor-receipt.test.mjs` | `f01d7a9ae3ef3401fe0c29fe1aaec7c5b703a65e68c811f29421935b681320fe` |

`git diff --check` exit=0；30 条既有 LF→CRLF 提示不是本轮格式失败。dirty worktree 和所有无关改动保留。未 commit/push、未写 learning/Compound、未绑定或创建独立 behavioral acceptance harness。

## 独立审查

TypeScript/async 独立终审 APPROVE，上表两 SHA 审查前后匹配；独立 strict16/lint2 均 exit=0、零 warning，没有改动文件或重复累计测试。确认 descriptor snapshot/callback capture、native Promise/UNKNOWN/迟到完成、共享 lock/budget/halt、双引用 digest、actual T17 frozenRetention、完整 uncertainty 边界；结论仅针对本地参考切片，不代表 W2/生产验收。

功能/安全独立终审 APPROVE，上表两 SHA 审查前后匹配；独立六文件组合（receipt、writer、manifest-authority、approval-provenance、existing-receipt、predecessor-receipt）98/98，exit=0、suites=0，fail/cancelled/skipped/todo=0，duration_ms=9552.4957。无可复现 actionable findings；同样仅批准本地对象读回切片，没有把 machinePassed 宣称为已计算 W4 gate。

## 下一步（仍属于完整目标）

继续本地共同 operation ports 与独立 behavioral/conformance harness，冻结策略 recovery/新 fence/独立 rescue principal 与周期续期证明组合；实现真正的 W4 machine gate 与完整递归阶段验收、实际 bundle authority sealing 后才能宣布前驱 complete。W3/W5/W6/W7/W8/W9 与企业 provider trust/IAM/真实数据、阈值、窗口、elapsed 仍需按依赖完成。局部 source foundation、读回和 629 个回归不能代替以上门禁，不能启动真实 production traffic/fault/retention cleanup。
