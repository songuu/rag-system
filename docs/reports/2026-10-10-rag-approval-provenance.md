# W2 历史审批 exact claim 的只读 provenance

日期：2026-10-10。计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。

前驱 bundle 不能通过重消费旧结果 nonce 来证明已有批准。本轮新增历史审批证据读回基础：定向 13/13、local19 450/450、cumulative30 593/593、strict16/lint2 退出 0；70 文件运行前后 drift=[]。它尚未接入完整 predecessor acceptance，不代表 W2 或生产验收完成。

## 实际实现与边界

- 既有 `production-authority-approval.ts` 新增 `createReferenceAuthorityApprovalProvenanceVerifier` / `verifyExistingClaim`、闭合 request/decision 类型；复用原 verifier 的闭合配置验证，构造不执行 IO。旧/new 路径共享 `matchesApprovalConsumer`，保留普通 signed executor 与 recovery 独立 frozen principal/role/credential 的区分。
- 请求必须独立提供 context、实际 envelope、expected payload、精确 nonce claim ref、原消费时的 clock reading。先 actual Ed25519 验签并比对 expectation；原 reading 的 scope/run/source/actor/nonce/sequence/uncertainty 必须合法，整个原时间误差区间都要落在签名与 key 有效期内。吊销 key 仍拒绝。
- 由实际签名 expectation 和原 reading 独立派生 expected claim 的每项字段及 digest；不能从 provider response 借用 claimedAt、consumer 或 envelope digest。随后通过独立 read-only actor 实际 `readExactNonceClaim`，校验完整 object/proof/source/ref/version/hash 一致。
- 两次 fresh challenged clock 包围实际读回，检查 sequence、全误差时间顺序、source/reader/binding、当前 reading 跨尝试单调性。当前时间可以在旧批准过期后，但它只证明观察顺序，不延长旧 window/key/approval 或签发新许可。
- 新路径不调用 `consumeAuthorizationNonce`。结果明确 `productionAuthorized=false`、`executionAuthorized=false`、`nonceConsumedByThisVerifier=false`；错误 nonceOutcome 也是本观察者的 `not-attempted`，不是声称存储里没有既有消费。
- 配置/request 在 await 前 snapshot/freeze，端口方法 descriptor-safe capture；共享 bounded 调用边界防 getter/Proxy/then adoption，诊断固定且不泄露 provider 内容。busy/永久 attempt budget 与 UNKNOWN/unsafe carrier halt；迟到 fulfillment 不继续 final clock、不消费 nonce、不返回成功缓存。已确定的普通读回失败可由调用方明确重试，不自动重试。
- 配置兼容原完整 nonce port；构造/内部 capture 会校验并暂存其存在的 consume 方法，但该历史读回路径从不 dispatch 它。不能将这一代码级只读调用证明冒充独立企业 read-only IAM 或最小权限认证。

原 reading、claim ref 等输入不是 authority 自举：成功必须有实际 signature 和存储中的 exact claim。所有 port/time/store/signing roots 仍为显式 local reference；缺失 claim、未知 exact version、lost reference restart、无企业 IAM/持久 store/time/在线撤销/registry freshness 不能被这些输出补齐。本轮不验证完整 predecessor bundle、W4 computed machine gate、完整 recovery acceptance 或周期续期，不把 recovery provenance 用作新的 rescue authorization。

未连接生产、改 `.env`/持久开关、注入 fault、删除、commit/push 或写学习记录。根目录 `AGENTS.md` 文件实际不存在，沿用用户提供的规则；计划 `.acceptance.json` 不存在，未自绑定或启动 Harness。

## TDD 与真实失败

1. 新入口及实际已消费 execution/result claim 的两项测试先 RED：`undefined !== function` / 工厂不存在。模块可导入，真实签名/消费 fixture 已成功运行，不以缺文件代替缺能力。
2. 首版 new2 + existing approval44 = 46/46。旧角色语义仍通过。
3. 扩展 13 项首次实际 11 passed/2 failed：fixture 将原批准 decision 的冻结 nonceClaimRef 直接作为可变测试 input，修改 objectId/objectVersion 时 TypeError；第二项 barrier 未释放，在测试结束后还有 readback timeout 的 unhandledRejection。
4. helper 改为独立 clone nonceClaimRef，并为 blocked test 增加 after cleanup/rejection observer；未改产品判断或预算。原 13/13 通过。保留上述 fixture 错误，不称环境根因。
5. 覆盖三类 envelope 的真实历史消费；坏 signature/expectation/scope/run/actor/original reading/ref；空 store/exact version absence；actual claim/object/proof substitution；revoked keys/frozen config；fresh/current/final clock；redacted unavailable read；100ms UNKNOWN+真正迟到 fulfillment；busy/attempt/capability/data capture；getter/Proxy/thenable；restart lost claim；独立 rescue principal 与 false flags。

本轮累计首次即绿色。上一轮 Ask replacement POST 单次 503/200、此前 500/200、EPERM、journal/Ask timeout 等未知失败仍保留其原报告；本轮绿色不代表历史根因已修复。

## 精确身份与原预算验证

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-approval.ts` | `6dec4ad9fd3a86737da96cd27eae4365be56c691eb14a3b9adc6c0792067b2e1` |
| `src/lib/rag/eval/production-approval-provenance.test.mjs` | `6ec7c493ccbef13947fd30f34f5c71bf17cec3a1ba2aaa40eabae0dae9b8a45c` |

受检集合是上一轮 manifest 绑定报告 69 文件，加本轮新 provenance test =70；实际生成方式仍为 W0 baseline 35 路径表 ∪ 原16个TS/tests ∪ writer/shared-provider/manifest-fixtures/receipt-fixtures/manifest-authority/provenance 六 explicit tests/support ∪ `src/lib/security/request-validation.ts`。前后 drift=[] 不代表全宿主、node_modules 或 baseline 以来用户其他修改冻结；旧报告身份不回写。

Node v22.22.0；串行 spawnSync；外层每命令90000ms/16MiB；所有 tests 保持 `--test --test-timeout=30000`，只沿用测试子进程 `RAG_SEMANTIC_ROUTER=off`，没有 skip/preload/concurrency/isolation/测试预算修改。

- strict16：沿用上轮16 TS 模块，`--noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`。
- lint2：本表两个文件，`--max-warnings 0`。
- local19：上轮 local18 + new provenance test。
- cumulative30：上轮 cumulative29 + new provenance test；包含完整原 Ask、RagEval 与 Graph CAS/Evidence 基线，不用 leaf 代替。

| 范围 | UTC 窗口 | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| strict16 | 02:56:00.519–02:56:01.457 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| lint2 | 02:56:01.457–02:56:03.045 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| provenance13 | 02:57:47.804–02:57:48.633 | 13/13，793.0614ms | `ea1620adee5b704cd433fee2eae3c859d54d92e63f9244d2f55b701a3ee67801` |
| local19 | 02:57:48.633–02:58:10.324 | 450/450，21644.1398ms | `056ebcfe3b50912bcb0a8fb9e5d3791ff13d54590d39e6f525fdb13aeb05e0ca` |
| cumulative30 | 02:58:10.325–02:58:33.674 | 593/593，23310.9951ms | `58e85c9aa957a18d7c7a44062270da4d8e4b6ae329201f5ac626e4fde8de2401` |

所有进程正常终态，无 signal/error，stderr 空；fail/cancelled/skipped/todo 均0。

## 独立审查与续接

- 安全/code：两精确 SHA 前后一致，APPROVE；独立原预算新13 + old approval44 =57/57、exit0，无失败/取消/跳过。确认历史验签、独立 expected claim、actual read、clock/order、capture/UNKNOWN/late completion 与共享旧角色语义。无文件编辑、提交或生产 IO。
- TypeScript：两精确 SHA 前后一致，APPROVE；独立 strict16/lint2退出0，未重复测试。确认 recovery 判别类型收窄、共享旧消费者语义、冻结/首 await 前锁、UNKNOWN/late continuation 及历史/当前时间区分；并明确修正“未暂存 consume”的早期误读，实际是暂存存在的 optional 方法但不 dispatch，不等于只读企业 IAM。未修改文件。
- 下一工作把此能力组合到完整 predecessor bundle 的 actual registry/journal/encrypted core/manifest/ref/结果签认读回链路；不是再次消费原 result nonce。完整机器 gate、恢复政策与续期分别按原依赖继续。
- 整体目标保持原范围：W2-W9、T16/T17/R18 与18项AC仍开放，不用这个局部 reference 基础替代完整 W2 或企业验收。
