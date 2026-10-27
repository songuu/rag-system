# W2 时钟与 Authorization Nonce 操作端口证据

- 日期：2026-10-09。继续已批准 W2，不缩减 W0-W9、T16/T17/R18 或 18 项 AC。
- 本轮新增 `src/lib/rag/eval/production-authority-ports.ts` 与 `.test.mjs`。复用现有 canonical 数据边界、ArtifactRunBinding 与 ArtifactReference；没有改写现有 authorization、journal、receipt、trust、Ask/runtime/request-validation 或配置。
- `AuthorityClockPort` 与 `AuthorizationNonceStorePort` 是领域 operation ports。这里不把可手动推进的本地 fixture 称为已经认证的 TrustedClock，也不把 nonce 消费结果当作 ApprovalVerifier 决策；共同 ports/可信审批 composer 仍待组合。
- 只有单进程、内存、隔离 reference 行为。没有企业端点、凭据、网络请求、生产读写、真实审批消费、提交、推送、学习写入或清理。

## 当前已验证

- 定向 28/28，0 fail / 0 skipped，duration 114.872 ms。
- 十一个控制面模块 strict TypeScript 退出 0；新源码和测试两文件 ESLint 退出 0、无警告。不是全仓库 TypeScript、生产构建或独立企业 conformance。
- 独立只读终审 **APPROVE**，定向 28/28 与 strict TypeScript 独立通过；下方两文件精确摘要一致，未发现可复现 P0/P1/P2。只批准本局部参考/结构合同切片，不是企业 conformance 或生产验收。
- 最终十一组本地合同 **249/249**，0 skipped，duration 24172.0737 ms，2026-10-09T08:58:03.781Z → 2026-10-09T08:58:27.990Z；stdout SHA-256 `8ca1737ed5ac63dee8f6765e3d3369491070b403fe9688e728e4722fd5e4aff3`。
- 最终当前 22 文件回归 **392/392**，0 skipped，duration 24963.9052 ms，2026-10-09T08:58:27.990Z → 2026-10-09T08:58:52.991Z；stdout SHA-256 `34284beedf312bfe4204c4f415c099f9bafdc24c19bef5ba1f738af4b846067a`。新两文件摘要与终审快照精确一致。
- 54 个相关文件在两次扩展回归前后均稳定。不等于全仓库、全部传递依赖或企业运行环境被冻结。
- 原 W0 历史未重写。既有 manifest 修复、其他任务 runtime/readiness 改动与本轮变更分开；runtime 仍为 `2309d3a282dc7fa8256d5854f9473c665c087db092f6191fdc2f62868dd2de3a`，root 本轮没有编辑或回滚这些文件。

验证方式沿用已有 Node strip-types / resolver hooks：

```text
node --experimental-strip-types --test src/lib/rag/eval/production-authority-ports.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node <十一个控制面模块>
node node_modules/eslint/bin/eslint.js src/lib/rag/eval/production-authority-ports.ts src/lib/rag/eval/production-authority-ports.test.mjs
```

TypeScript 模块为 canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance、production-authority-ports。扩展回归使用 W0 已记录的既有清单与这十一组合同去重，不重写旧基线。仅测试子进程沿用 `RAG_SEMANTIC_ROUTER=off`，未关闭用户功能。

## 实际 TDD 记录

1. 先新增测试，再运行：模块不存在，`ERR_MODULE_NOT_FOUND`，0 pass / 1 runner fail，duration 67.6745 ms。不是声称各个新 case 已分别执行红测。
2. 最小实现后 23/23，duration 111.5909 ms；对应十一模块 strict TypeScript、新两文件 ESLint 均退出 0。
3. 增补 distinct nonce 并发争用同一 clock read、两个结构验证器的 hostile 嵌套输入及 consumer/reader 混同负测，26/26，duration 114.8726 ms；实现未改动。
4. 增补“可伪造的 well-formed clock/approval 标签不代表认证”和“新实例没有共享/重启 nonce 历史”两个边界特征测试，28/28；实现仍未改动。这两条准确暴露 reference 的能力缺口，不是假装已经修复企业信任。

26 项测试的历史候选：十一组合同 247/247，duration 25885.894 ms，2026-10-09T08:50:36.644Z → 2026-10-09T08:51:02.564Z，stdout `254918dd1b3e1ab2983cfd3f59a8b45ba7cf04e549698302a8e74f51e57df9a5`；22 文件组合 390/390，duration 25090.1661 ms，2026-10-09T08:51:02.565Z → 2026-10-09T08:51:27.690Z，stdout `8ad50d3fa8b96b8bff191b7bd4169c47dc9302dda8252effc5fae3b35e023daa`。此时 test 摘要为 `89fe0d61656857969acfeb6a94a872a3c7c78b60acdca09460d05b3dda1c5df8`，不是终审的 28 项快照。

## Operation ports 与 reference 的行为边界

- Context 不含调用方 `observedAt` 或授权能力，只包含 execution profile、environment/tenant/corpus/run/manifest 五字段 binding 与 actor label；data inputs 在首次 await 前 canonical 脱离，捕获的合同、配置及输出深冻结。Proxy、getter、symbol、隐藏/未知字段和任意外部路径/URL 拒绝，错误只含固定上下文，不输出供应商异常或输入秘密。
- Clock read 精确绑定 request nonce、source object ID/version/digest、reader label 和完整 run binding，返回 canonical UTC、误差上限及递增 sequence。实例内 challenge 不因 actor/run 改变而重用；失效不消费 challenge/sequence/capacity，耗尽后不驱逐历史。
- 手动 fixture time 只能不倒退地前进，单次 advance 有界；整个误差区间不能越过四位年份 UTC 边界。availability fixture control 不重置已使用 history；不是企业时钟管理接口。
- 结构 clock validator 独立对照完整期待，约束误差上限、前次 source/reader/run、sequence/time 不回退及不同 challenge。输出固定 `validationLevel=structural-only / productionAuthorized=false`；provider 的 `productionTimeAuthenticated=true` 不会升级结果。
- Nonce 消费前检查 local role/scope/profile、独立期待的 clock source/ref/reader/run/challenge、误差上限和完整时间区间 `[observedAt-uncertainty, observedAt+uncertainty]` 必须落入 `[validFrom, expiresAt)`。有效期最长 24 小时；恰好触达 expiry 也拒绝。
- Replay key 仅为 canonical `[issuerId, authorizationNonce]`，不含 kind、run、manifest、approval ID 或 envelope digest；更换这些值不能在同实例绕过墓碑。不同 issuer 有不同命名空间；过期不会回收墓碑，容量耗尽不删除旧 nonce。
- 每次成功前完成全部 validation/hash，同步执行 exclusive commit，中途没有 await；并发同 nonce 一 consumed、一 replayed。不同 nonce 争用同 clock read 时只有一个成功，失败方换新 clock read 后原 nonce 仍可用。只有成功推进 store 的 sequence/time/challenge fence；失败或 capacity exhaustion 不提交该状态。
- 成功返回 exact claim ref；replayed/capacity-exhausted 返回 null，不泄露旧 run claim ref。Claim 为机密元数据，只保存 nonce identity hash、不保存原始 authorization nonce；仍含 run identity，不作为公开数据。
- Readback 使用独立 reader label，严格匹配 object ID/version/digest 与原 claim 的全部 run/manifest binding，没有 latest fallback。结构 validator 与独立构造的 expectedClaim、source ref、proof reader/ref 逐项比较；consumer 和 reader 不能混同，自洽重算 provider hash 不能代替独立期待。

## 必须保留的未知与未完成项

- Scope/profile/actor/sourceIdentityRef 都是数据意图与精确匹配标签，**不是 IAM、密码学身份或授权 capability**。
- 当前 nonce-store 只做结构检查，不验审批签名、key role/revocation、真实 clock source attestation 或企业有效凭据。调用方可以构造 well-formed clock reading 和 envelope digest，被 reference store 结构消费；这已由测试明确证明，结果不是执行许可。
- Clock sequence/challenge 和 nonce tombstones 都只在单实例内存保留。新 factory 实例可再消费同 issuer+nonce；没有 fsync/WORM、跨实例原子消费、重启/崩溃/网络分区连续性。Clock 手动 advance 不证明真实时间或发布周期经过。
- Clock/store booleans、structural readback 相等和 opaque refs 不能认证真实 source、独立 principal 或 durability；企业 composer 必须从已冻结 registry/trust roots 独立认证并验证实际调用的 provider、clock reading 与审批，再消费 nonce，处理不确定提交并 exact reconcile 后才允许任何生产动作。
- `production-provider-trust` 的 clock 全部共同 checks 与 authority-proof/monotonic-time/unavailable-fail-closed，以及 approval 的 durable-nonce-replay-rejection 等完整 requirements 仍未完成。没有修改 requirements hash、制造 conformance attestation 或 acceptanceBundle。
- Authority-aware approval/time/revocation/nonce/recovery 组合、receipt 完整组合、所有 purpose 共同 ports/独立完整 harness、真实 enterprise adapters 及 W3-W9 仍 open。
- 历史 Ask EPERM、59 项 Ask 失败和 2 秒启动观察失败继续保留于前轮报告；本轮扩展回归未复现，不宣称已根治或确定为环境问题。

## 终审精确文件身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-ports.ts` | `9f5c558b00e3e7e2d65a58e89da7012fd287e36e4c69e1263f751b8bc6c08c62` |
| `src/lib/rag/eval/production-authority-ports.test.mjs` | `5bc9d64bb4216311264fd57a8e3dbdaf66dc07acbb287784068f174f37a1a509` |

Sprint 保持 work/active、2/13；W2 整项 open，18 项端到端 AC 未标通过。完整 Goal 保持 active，真实 T16/T17/R18 尚未验收；用户直接授权不生成缺失的企业证据。
