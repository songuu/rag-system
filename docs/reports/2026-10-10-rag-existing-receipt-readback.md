# W2 既有回执 authority 的完整只读观察链路

日期：2026-10-10。计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。

本轮把历史审批 exact-claim provenance 接入既有 receipt reader 与完整 manifest wrapper。正常入口仍真实消费结果 nonce，独立历史入口不会重消费；两者共享完整证据检查、资源预算和实际 validated clock progression。安全复审发现的跨入口时钟绕过 HIGH 已有3项实际红绿修复；最终新17/17、local20 467/467、cumulative31 610/610、strict16/lint3退出0，71文件测试前后 drift=[]，新3 SHA的两项独立终审均APPROVE。这不是完整前驱阶段验收或 W2 整项完成。

## 实际实现与明确边界

- `production-authority-receipts.ts` 的普通与 manifest-aware reader 均新增 `verifyExistingBundle`。历史请求是原 bundle/evidence/conformanceObjects/runtimeObjects 加闭合 `resultApprovalProvenance={nonceClaimRef,claimedClockReading}`。不能把旧 decision/hash 标签当成原 claim，不能在正常入口添加 skipNonce 或历史字段来跳过消费。
- 复用同一私有完整 verifier：实际 execution/result Ed25519 签名与独立 expected execution/result payload、execution ref/fence/时间范围、challenged registry exact policy、冻结 provider selection、稳定 journal 双 head 与完整终态链、逐 entry actor/digest/fence/action、exact 密文版本与 store proof、AAD/AEAD/实际解密后的完整 core 一致性。manifest wrapper 对九项 derived identities、stage/run/scope/manifest/execution/predecessor refs 和 R18 原冻结 refs 保持前置对应检查。
- result payload 仍由冻结配置与已经核对的 core/bundle 独立构造，不复制 provider 宣称的批准状态。历史分支调用实际 `verifyExistingClaim`，由签名 expectation 和原 clock reading 派生完整 expected claim，通过只读 actor 真正读回精确 object/ref/version/source/proof。原 reading 和 claim ref 在测试中来自实际 nonce 消费请求与返回值，不用成功标签造证。
- 两入口共用 busy、halt、累计 attempt budget；历史入口不是第二个可绕过额度的 verifier。配置/request/method 在 await 前捕获。普通已确定的读回失败只能明确重试；UNKNOWN/unsafe carrier 停止两入口，真正迟到 fulfillment 不继续 IO。不采用缓存成功、自动重试或回滚 nonce。
- 审查修复后，approval 模块的 `createReferenceAuthorityApprovalVerificationPair` 在内部创建一个不可外供/重置的私有 ClockProgress，实际校验通过后才更新 sequence/time/challenge Set，普通/历史读时共用它。standalone 两旧工厂仍有各自私有 cursor、原闭合配置和输出。pair 只共享 clock progression，不宣称共享 grant/approval/事务状态；完整 receipt owner 自己控制全局 lock/budget/halt。没有包装 provider Promise、二次 deadline 或改变 UNKNOWN/late completion 边界，历史转普通的倒退在 nonce 消费前被拒绝。
- 历史路径 dispatch registry/journal/store/KMS decrypt/read-only clock/nonce readback，不调用 encrypt、seal 或 consume。新返回类型使用独立 schema/validationLevel，`productionAccepted=false`、`stageAcceptanceComplete=false`、`executionAuthorized=false`、`nonceConsumedByThisVerifier=false`。错误 `nonceOutcome=not-attempted` 指本次观察，没有声称过去未消费。
- fresh 最终 clock 的整个 uncertainty 区间仍检查保留期限与当前冻结 provider selection 有效性；历史 claim 不续期证书。原 pre-run proofs 不可被后来签发的 proof 追认；长周期当前 qualification/renewal 组合尚未实现，旧证书过期仍拒绝。失败的已签名 machine verdict 保持失败，`machinePassed` 只是既有结构化签认对应，不是本轮计算的 W4 machine gate。
- 工厂依旧兼容并捕获正常 nonce consume 方法；历史分支不 dispatch 不等于独立 read-only 企业 IAM。所有 registry/time/signing roots/store/KMS 仍显式 local reference，未证明企业 source authentication、在线吊销刷新、跨实例耐久 nonce/日志或 WORM。

下阶段冻结前驱与实际前驱 acceptanceBundle 的独立 object/ref/stage/scope/manifest 衔接、递归完整前驱验收、W4 computed machine gate、实际 frozen-policy recovery、周期续期和真实 elapsed evidence 仍开放。本轮的 T17/R18 合成 fixture 只证明对应检查，不证明实际流量、故障恢复、经过完整保留周期或生产通过。已有 claim 证明实际消费，不自动证明以前整个 verifier 已返回成功，也不能凭这个观察授予新 execution/rescue 权限。

未接触生产、`.env`/持久开关、fault、删除、commit/push、学习记录或 Harness 绑定。沿用用户规则、现有端口/fixture 和 Work 的 TDD/风险匹配验证流程；只读审查与主线程文档工作分离。

## TDD 与真实失败记录

1. 两项新测试先 RED：历史入口 `undefined !== function` / `verifyExistingBundle is not a function`，0/2。此前真实签名、执行消费、密文封存和结果消费 fixture 正常，不把 import 或缺文件当作行为红测。
2. 首实现 new2 + old receipt20 + manifest10：31/32。重构把 manifest wrapper 的 Promise rejection 变成同步 throw，既有错绑定测试真实失败。恢复 async wrapper（产品修正），原三文件32/32。
3. 扩展14项首轮13/14。明文替换 fixture 同步返回 string，违反 KMS port 的 Promise carrier 合同，实际被 `provider-contract-invalid` 拒绝，未到预期明文对应校验。仅将 fixture 改为 async 返回，未放宽产品边界/断言或测试预算，14/14。
4. 覆盖两工厂、三个 stage、重复历史观察与正常 replay 拒绝、正常 skip/decision 标签闭集、manifest/core/签名/ref 替换、原 claim/ref/clock/失去存储历史、实际 registry/certificate/journal/store/plaintext/nonce 替换、只读 dispatch、显式 retry、store/nonce UNKNOWN 与迟到完成、共享 busy/额度、跨 await 捕获、getter/Proxy/thenable、证书/retention 过期、实际 signed failed verdict。

5. 中间快照的代码审查实际发现 HIGH：普通入口 final sequence20/time04:01:10 后，历史 first sequence20/time04:01:05、final sequence21/time04:01:06 仍返回 provenance true。原44/44和607/607没覆盖跨入口 private cursor，此成功观察不授予生产/执行权限，但违反 fresh clock 单调约束。TypeScript 原身份 APPROVE 不能覆盖这一行为缺陷。
6. 新增3项原预算红测：普通→历史 repeated sequence/time regression 均 `Missing expected rejection`；历史→普通实际触发 consume/replay，outcome 为 reported-not-consumed 而不是要求的 not-attempted，0/3。最小共享实际 cursor 后 new17 + old approval44 + provenance13 + reader20 + manifest10 =104/104（9339.2271ms）；最终完整17/467/610全部绿色，未删测试、改预算或弱化断言。

中间累计首次607/607及修复后最终610/610均保留。此前 Ask replacement POST 503/200、500/200、EPERM、journal/Ask timeout 等未知失败保留原报告；此次绿色不等于这些历史根因已修复。首次 apply_patch 因上下文行顺序不匹配被拒绝，没有产生半应用编辑。

## 首实现中间快照与原预算验证（后续发现 HIGH，非终态）

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-receipts.ts` | `24d6629acb4963ecb7b35c4eaa46927f01b4d2b3c6ea4c00c747520a8803851c` |
| `src/lib/rag/eval/production-existing-receipt.test.mjs` | `5da235e2a75c634f35259137113915c5d7642799cd98b50ba19a60e54995e64e` |

受检集合：上轮70文件 + 新 existing-receipt test =71。由 W0 baseline35路径表 ∪ 16 TS/tests ∪ writer/provider-fixtures/manifest-fixtures/receipt-fixtures/manifest-authority/provenance/existing-receipt七 explicit tests/support ∪ `src/lib/security/request-validation.ts` 生成，前后 drift=[]。不是全宿主或 node_modules 身份保证，旧报告 SHA 不回写。

Node v22.22.0；串行 spawnSync，外层每命令90000ms/16MiB；所有 tests 原样 `--test --test-timeout=30000`。只沿用测试子进程 `RAG_SEMANTIC_ROUTER=off`，未改 skip/preload/concurrency/isolation/预算或生产开关。

- strict16：既有16 TS 模块，`--noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`。
- lint2：本表两个文件，`--max-warnings 0`。
- local20：上轮 local19 加新14项；cumulative31：上轮 cumulative30 加新14项，保留完整 Ask、RagEval、Graph CAS/Evidence 基线，不用 isolated leaf 替代。

| 范围 | UTC 窗口 | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| strict16 | 03:16:47.862–03:16:48.844 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| lint2 | 03:16:48.844–03:16:50.621 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| existingReceipt14 | 03:16:50.621–03:16:59.733 | 14/14，9075.7365ms | `1786621503edc4b7c15105bc160b567d389f68a2759cee43dcf4cd4525de2bd2` |
| local20 | 03:16:59.733–03:17:24.588 | 464/464，24814.8199ms | `35dc96ffef426a749c4880527c7aeb4d93e0f80d2793a98cb83e381230db4673` |
| cumulative31 | 03:17:24.589–03:17:47.512 | 607/607，22871.0812ms | `2ff135f533f2568adaba30328dee17129f3c27f47ce2727b009304ef509d773a` |

所有进程正常终态，无 signal/error，stderr 空；fail/cancelled/skipped/todo 均0。初始 `git diff --check` exit0，保留30个既有 LF/CRLF 提示，未重写 unrelated dirty changes。

## HIGH 修复后的最终快照与原预算验证

| 文件 | 最终 SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-approval.ts` | `4d39540cf94d331199d29be99d34ceb10a44d64b87593c4a20932743c103ac4f` |
| `src/lib/rag/eval/production-authority-receipts.ts` | `a0ad8e257600a98e7cea845f6c7671cbba3ae91d83ba17caab0b8b46a55230d2` |
| `src/lib/rag/eval/production-existing-receipt.test.mjs` | `fe5eb680657f4b29940d357f4be3f402a0e2af568ca83673a349f08434e56ffc` |

与中间验证使用同一71路径集合，最终整个 strict/lint/test 运行前后再次 drift=[]。strict16命令不变；lint3对本表3文件且零警告；原20/31测试文件集合不变，新增3个行为用例（不是新增文件）；所有进程仍原预算/同一子进程 semantic-off，无测试跳过、取消或对原失败的隔离替代。

| 范围 | UTC 窗口 | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| strict16 | 03:26:17.561–03:26:18.440 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| lint3 | 03:26:18.441–03:26:20.021 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| existingReceipt17 | 03:26:20.021–03:26:29.509 | 17/17，9451.0405ms | `22da12a7a32cfc3ebd810484362d073b9ac924148f774c0ac42aa2e05caec40d` |
| local20 | 03:26:29.509–03:26:50.098 | 467/467，20553.8952ms | `febb017afe4c71513a9cded9a0cfae9af7d2385760b8a90c0527f4d84fb02db7` |
| cumulative31 | 03:26:50.099–03:27:12.929 | 610/610，22789.1563ms | `eb7aa55cfa551782ce8da718c553a9a7cbd97fa8d7eaeff82400512e0fd9570a` |

最终所有进程正常终态，无 signal/error；双流类型/lint空，test stderr空；fail/cancelled/skipped/todo均0。

## 独立审查与续接

中间身份：安全/code给出1 HIGH，独立原预算44/44（10915.6626ms）、前后2 SHA稳定；TypeScript为APPROVE、独立strict16/lint2退出0、前后2 SHA稳定。该结果不能作为修复后终审。

- 最终安全/code：新3 SHA前后一致，APPROVE，无新增actionable finding；独立原预算五文件104/104（9666.6241ms），exit0，fail/cancelled/skipped/todo均0。原PoC实际复跑：normal final seq20/time04:01:10，historical first seq20/time04:01:05立即拒绝，result-approval/approval-failed、nonceOutcome=not-attempted、pending=false，未发生historical final，nonce消费2→2。确认私有共享cursor、独立旧工厂语义、UNKNOWN/late continuation、owner锁/额度/halt和有界challenge。
- 最终TypeScript：新3 SHA前后一致，APPROVE；独立strict16/lint3退出0、零警告，不重复测试。确认精确判别返回、async wrapper、内部cursor不可注入/reset、真实校验后才推进、超时迟到不更新、无Promise/deadline改造、owner lock/budget/halt保持、只共享clock而非grant。两审查者均无编辑、提交或生产IO。

runtime 实际状态仍 WORK/ACTIVE，2/13：仅 W0/W1 完成，W2-W9、T16/T17/R18 与18项端到端AC开放。pointer.next 仍有旧 W0/W1 文本，未手改控制面；以实际 task metadata 与计划进展为准。完整目标范围不缩减，仍有本地实现工作，不把外部生产输入缺失当成本轮本地阻塞，也不冒称全部完成。

下一步在此读回基础组合下阶段冻结前驱与实际前驱 bundle 的独立身份/对象/阶段衔接，再按原依赖完成 recovery/renewal 与其余共同端口/独立 behavioral harness；机器 gate 与真实生产验收保持各自独立门禁。
