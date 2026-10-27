# W2 私有 execution-session 与 authority-aware 封存

日期：2026-10-10。所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。

本地 writer 切片已实际实现及回归：新定向 19/19，local17 427/427，cumulative28 570/570，strict16 与两文件零警告 lint 均退出 0，66 文件前后无漂移。两项精确身份独立审查均 APPROVE。此结果不是完整 W2、生产 runner 或 T16/T17/R18 的验收凭据；所有 production/stage acceptance 标志仍 false。

## 本轮实施边界

- 在既有 `production-authority-receipts.ts` 新增 `createReferenceAuthorityReceiptWriter`，复用配置校验、descriptor-safe 能力捕获、实际签名 verifier、authority approval、registry、journal 与已有 AEAD/readback helper。未改既有 reader 的授权语义；`detachedEntries` 只有 writer 空日志读回显式开启 allowEmpty，reader 默认仍拒绝空链。
- `beginExecution` 先独立读取稳定、完整、空的 journal；验证实际 Ed25519 execution envelope 与冻结 expectation/ref。随后通过实际 clock/registry/provider selection 和 execution nonce 原子消费、独立 exact claim readback，复核空日志并记录私有 startNotBefore。调用方不能传入“已批准”标签或可转移 session token。
- `sealCore` 只接受私有已启动会话；不再次消费 execution nonce。不接受 caller `sealedAt`；core identities/stage/run/签名执行主体/授权 ref/运行时证明与冻结配置精确一致。完整 terminal journal 必须稳定、同 fence、同 signed executor/digest、stage action 闭集，所有记录都不得早于私有 startNotBefore。
- 真正 encrypt、store-seal、store-read、decrypt 前，先精确读回 terminal head，再重新挑战 clock 与 registry，检查签名、窗口、provider 资格和 retention 的整个不确定性区间。封存时间从实际 clock reading 取得。最终 head 读回后还有 fresh checkpoint，最终时间校验至冻结输出之间无额外 await。
- 请求与端口方法在 await 前 detach/capture；不执行 caller/provider getter、Proxy 或 thenable。所有诊断使用固定阶段/code，省略 provider 异常和机密内容。
- begin 实际消费或 seal 已启动后失败均停止会话。未知完成不取消、不删除、不回滚、不自动重试、不返回成功缓存。mutationMayHaveOccurred 依据真正 KMS/store 回调 dispatch，不以 helper 入场冒充实际写入。执行 nonce 的 reported/unknown outcome 独立保留。

这里只是内存 reference：没有企业身份、可信时间、在线撤销、持久/跨实例 nonce/WORM、完整 manifest 外部 authority、machine gate 计算、前驱 acceptance、recovery 或长跑证明续期。配置中的 identities 是本地冻结 expectation，不是已验证的企业 manifest。T17 普通路径可结构封存，任何 recovery refs 仍拒绝。store proof 的 observedAt 仍是本地上下文关联标签，不冒充真实企业完成时间；authorityObservation 单列实际最后 reading。

## TDD 与失败记录

1. 新测试先在既有可导入模块上查找不存在的 writer：9 项全部 RED，第一项明确 `undefined !== function`；不是缺文件导致整套测试未加载。
2. 第一实现使用了 Node v22.22.0 strip-only 不支持的 TypeScript 参数属性，整文件退出 1。改为仓库现有显式字段赋值写法后基础 9/9。保留这一实现错误，不将它称为环境根因。
3. 扩展到 19 项后真实结果 17 passed/2 failed：
   - journal head 读回期间 clock 到期，原“先 checkpoint 后 journal IO”仍实际 dispatch store；断言 `true !== false`。调整为 journal IO 在前、最后 fresh authority checks 在后，才允许真实回调。
   - 重叠 uncertainty 区间：对同一个有时间单调性状态的 provider verifier 先检查上界，再检查下一读数的较早下界，会假报时间倒退，begin 即失败。每一完整区间使用基于同份冻结 readback 的独立 verifier；真实 clock reading 的 sequence/nominal-time 单调性仍由私有 lastClock 验证，未放宽该约束。
4. 修复后同一原预算 19/19。覆盖正常三阶段、无私有会话、坏签名/标签、事后授权、重复 nonce/启动/封存、冻结身份、caller seal time、过早 run、recovery fail-closed、完整重哈希 actor/digest/action/fence/time、截断/不稳定 journal、failed verdict、写前/写后过期、已提交对象保留、fresh registry、uncertainty/provider expiry/clock regression、AAD/object/proof/plaintext、显式 throw、unsafe carrier、加密 UNKNOWN+真实迟到 fulfillment、nonce 实际消费后 claim UNKNOWN、busy/能力与数据捕获、配置 getter/Proxy。

## 已验证快照

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-receipts.ts` | `624fd20b1123905813bc6254836eb060f81bf160343354ddfe427e5659c488ef` |
| `src/lib/rag/eval/production-authority-receipt-writer.test.mjs` | `2cc20228a742dd3067a209841a6097ac7271e7322fa5e91a00eb6ab0a6a3b35f` |

受检集合明确为 W0 报告哈希表 35 个路径，与以下 16 组 `.ts/.test.mjs` 的并集，加 `request-validation.ts`、显式 shared fixture、writer 新测试，去重后 66 文件：

```text
canonical-json
production-gate-manifest
production-run-journal
production-authorization
production-provider-trust
production-controlled-artifacts
production-receipts
production-authorized-journal
production-artifact-conformance
production-journal-conformance
production-authority-ports
production-authority-approval
production-authority-conformance
bounded-provider-call
production-provider-registry
production-authority-receipts
```

前后 drift=[]；不等于全工作树、node_modules 或宿主被冻结。用户/其他任务的脏文件没有撤销。未 commit/push、修改 `.env`/持久开关、连接生产、注入 fault、删除或写学习记录。

## 原预算验证

Node v22.22.0；串行 spawnSync，外层每命令 90000 ms/16 MiB；测试统一 `--test --test-timeout=30000`，仅沿用已有测试子进程 `RAG_SEMANTIC_ROUTER=off`。无 preload/skip/concurrency/isolation/test-budget 修改。统一命令：

- strict16：`node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node` 加上述 16 个同名 TS 文件。
- lint2：`node node_modules/eslint/bin/eslint.js --max-warnings 0 src/lib/rag/eval/production-authority-receipts.ts src/lib/rag/eval/production-authority-receipt-writer.test.mjs`。
- writer19：`node --test --test-timeout=30000 src/lib/rag/eval/production-authority-receipt-writer.test.mjs`。
- local17：上述 16 个同名 `.test.mjs`，再加 writer 新测试。
- cumulative28：local17 加 W0 已冻结的 11 文件：eval dataset/metrics/gate/matrix/production-policy-contract、core/context-composer-v2、retrieval/legacy-evidence-adapter、knowledge-graph contracts/postgres-publication-store/graph-snapshot-recovery、app/api/ask/route；完整路径/既有环境边界见 `docs/reports/2026-10-09-rag-production-baseline.md`。

| 范围 | UTC 窗口 | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| strict16 | 02:06:25.378–02:06:26.314 | exit 0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| lint2 | 02:06:26.314–02:06:27.838 | exit 0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| writer19 | 02:06:27.838–02:06:33.074 | 19/19，5200.4961 ms | `fa0623c5e29b5ab5aa3fd6eb03c2b8014e1d133362e4adc28c9b48d1f6e1ff16` |
| local17 | 02:06:33.074–02:06:53.491 | 427/427，20379.1193 ms | `443ea765811ad0a0c438e7da028465bdf8c2f6ca92d88f70c58cae20eda38495` |
| cumulative28 | 02:06:53.492–02:07:18.281 | 570/570，24731.5575 ms | `fa15ed1713d7c78130a52365db41334ae32880f49ae2e13e6f4eeeb8fbdaadf4` |

全部进程正常终态，无 signal/error，stderr 为空；所有测试 fail/cancelled/skipped 均 0。历史 Ask durable replay 500/200、EPERM、journal/Ask 整文件 timeout、nonce 短预算 phase 未知等仍见原报告，后续绿色不视为根因已修复。旧报告的局部身份和失败不改写。

## 独立审查

- 安全/code reviewer 对两指定精确 SHA 报告 APPROVE；独立运行原预算 writer19 + reader20，共 39/39、exit 0，无失败/取消。确认 nonce 前置且仅消费一次、四次实际制品操作前 head/live checks、能力和数据捕获、迟到完成被 halt 阻断、诊断不暴露机密、sealedAt 与 false flags。无文件编辑或外部状态变更。
- TypeScript 专项 reviewer 对同一 SHA 报告 APPROVE；独立 strict16/lint2 均 exit 0、零警告，没有另跑测试。确认 strip-only 显式赋值、首 await 前状态锁定、async return 前 detach、outer timeout 后 active 阻断。四个 guarded 能力转换为原完整 KMS/store port 的双重 cast 是类型债；当前 helper 只捕获这四项能力且逐结果验证，未提出可复现缺陷，不借机扩大原接口改造范围。
- 主 agent 在审查后重新核对两 SHA 均仍匹配，`git diff --check` exit 0（既有工作树 CRLF 提示保留）。独立窄验证不替代主累计 28 文件结果，也不代表完整 W2/企业验收。

## 剩余范围

Sprint 真实状态为 WORK/ACTIVE，W0/W1 已完成，整体 2/13；W2-W9、T16/T17/R18 及 18 项端到端 AC 保持开放。当前 writer 仅解决本地执行 nonce 前置消费与封存私有生命周期，不把实读回执、provider 声明、fixture actor/time 或测试通过当企业许可。接下来仍需 W2 完整 manifest/trust/writer 组合、predecessor/recovery/周期续期证明、其余共同 operation ports 与完整独立 behavioral harness，然后按原依赖推进 W3-W9 和真实生产验收。
