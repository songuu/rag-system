# W2 实际签名、clock 与 nonce/readback 的参考组合证据

- 日期：2026-10-09。继续已批准的完整 W2 范围，不缩减 W0-W9、T16/T17/R18 或 18 项 AC。
- 新增 `production-authority-approval.ts` 与 `.test.mjs`；在既有 `production-authorization.ts` 抽取共用实际 Ed25519 验签并增加不消费 nonce 的 stateless verifier，追加两项测试。原 `verifyOnce` 的 nonce 墓碑、容量及成功时间单调规则保持；没有改写 clock/nonce ports、journal、receipt、trust、Ask/runtime/request-validation、配置或生产能力标志。
- 本组合器使用调用方配置的本地公钥、clock/nonce ports 和独立期待。所有结果固定 `productionAuthorized=false`，factory 固定 `productionCapable=false / executionProfile=local-reference`；不是 enterprise ApprovalVerifier、IAM/JIT 认证或生产动作 capability。
- 本轮只有本地 reference 测试及文档；无企业端点/凭据注入、真实审批消费、网络请求、生产写入/切流、提交、推送、学习写入或清理。

## 当前已验证

- 最终候选定向 **81/81**：authorization 15、authority ports 28、approval composer 38；0 fail / 0 skipped，duration 873.6468 ms。
- 十二个控制面模块 strict TypeScript 退出 0；本轮四个源码/测试文件 ESLint 退出 0，无警告。不是全仓库类型检查、生产构建、全部 purpose conformance 或企业验收。
- 最终独立只读审查 **APPROVE**，独立 81/81、strict TypeScript 与四文件 ESLint 通过，四文件摘要精确一致；未发现剩余可复现 P0/P1/P2。仅批准本局部参考组合切片，不代表 W2、生产授权或全仓稳定性验收。
- 最后一次相同 23 文件组合 **432/432**，0 fail / cancelled / skipped，duration 24984.6987 ms，2026-10-09T09:55:57.903Z → 2026-10-09T09:56:22.922Z；stdout SHA-256 `64850582dc2627722227a5b22997fc7a23c017ff9f667f3d0256c4be5a7c0f6c`。前两次 Ask 异常完整保留于本报告统计，后续绿色不证明根因修复。

验证命令：

```text
node --experimental-strip-types --test src/lib/rag/eval/production-authorization.test.mjs src/lib/rag/eval/production-authority-ports.test.mjs src/lib/rag/eval/production-authority-approval.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node <十二个控制面模块>
node node_modules/eslint/bin/eslint.js src/lib/rag/eval/production-authorization.ts src/lib/rag/eval/production-authorization.test.mjs src/lib/rag/eval/production-authority-approval.ts src/lib/rag/eval/production-authority-approval.test.mjs
```

十二模块：canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance、production-authority-ports、production-authority-approval。扩展清单复用 W0 既有测试与这些模块去重，只有测试子进程设置 `RAG_SEMANTIC_ROUTER=off`，没有改变用户运行配置。

## 实际 TDD 与 P1 修复记录

1. Stateless verifier 两项新增测试先执行：13 pass / 2 fail（factory 缺失），duration 133.7716 ms。共用验签实现后 authorization 15 + 既有 authorized-journal 30 = 45/45，duration 243.1988 ms；原 13 项授权测试全部保留。
2. Composer 测试先执行：缺失模块 `ERR_MODULE_NOT_FOUND`，0 pass / 1 runner fail，duration 63.4493 ms。首次实现还有 Node strip-types 不支持参数属性的语法失败，0/1，duration 71.5441 ms；改为显式只读字段后 23/23，duration 591.056 ms。未宣称缺失模块时每个 case 已独立红测。
3. 真实 deadline P1：同步 port 阻塞 40 ms，预算 10 ms，返回 fulfilled Promise 比 timer 队列先执行。clock/consume 两条反例真实 RED 0/2（Missing expected rejection），duration 232.7114 ms。增加 monotonic elapsed 检查后定向 68/68，duration 689.4784 ms。已经 settle 的迟到操作标记 `pendingCompletionUnknown=false`，仍未完成的超时保持 true；不虚称 timer 能中断同步 JS。
4. 增补独立读回/输入边界等特征测试，定向 73/73，duration 852.0285 ms。
5. 独立审查复现 actor 替换 P1。execution/result 的消费者可替换为非签名 executor，真实 RED 0/2，duration 109.0685 ms；恢复缺少冻结 rescue principal 仍可复用原 executor，真实 RED 0/1，duration 113.2741 ms。
6. 按既有 authorized-journal 的角色语义修复：execution/result 精确绑定 signed executor；recovery 要求冻结 actor、role、credentialRef，actor 与全部五个 signed participants 独立。新增缺失/null、所有角色重叠、role/credential 三字段替换、配置脱离、恶意 getter、普通路径防混用测试；最终定向 81/81 与 strict/lint 均退出 0。

## 组合行为与可信边界

- 配置和请求在 await 前 canonical 脱离；未知/隐藏字段、Proxy、getter、symbol、自定义 prototype、外部路径、enterprise/fallback 声明 fail-closed。捕获原 receiver 与 own method，await 后方法替换/getter 不会改变实际调用。
- Preflight 用 signed notBefore 检查完整 independently expected payload、签名、key ID/version/issuer/role、静态 revoked 标志及 key/window 有效期；不消费 clock challenge、nonce 或 attempt。该 synthetic 时间不作为观测时间或 verifiedAt。
- 初始 clock 精确匹配完整 environment/tenant/corpus/run/manifest、reader、source object ID/version/hash 和内部随机 128-bit challenge；instance 维护跨授权 sequence/time 单调性。整个误差区间两端都实际验签，必须位于批准及 key 有效期内。
- Ordinary 消费者必须是 signed executor。Recovery 配置可缺失或为 null，只有 recovery 被拒绝，不反向阻塞普通阶段；有效 rescue actor 必须是当前配置消费者且不同于每个 signed participant，role 与 credentialRef 三字段精确等于签名 payload。这里是标签一致性及职责分离结构约束，不证明实际 IAM 身份或 JIT 凭据有效。
- Consume request 来自已验签、冻结的 envelope；expected claim 独立从请求重建，不从 provider 返回字段自举。消费结果只有 closed status/ref，claim digest 必须匹配独立期待，再以单独 reader 对 exact object/version/hash/full binding/proof 读回。更换 run/kind/digest 不绕过 reference issuer+nonce 墓碑。
- 独立读回后再读 fresh clock 并重新检查全误差有效期；慢 consume/readback 跨 expiry、时间/sequence 回退或关联字段替换都不会返回成功。
- 成功决策只有机密元数据、full run binding、签名 envelope digest、consumer/reader/source refs、两次 clock digest、exact nonce claim ref、verifiedAt/uncertainty 与 canonical decisionHash，不返回 raw nonce/完整审批 payload。
- Factory 单一 active operation 串行、最多 10000 attempts，操作预算 1～60000 ms，challenge 由 attempt 上限界定。只接受 native Promise、不访问任意 thenable。所有迟到 Promise rejection 被观察；无自动取消成功、回滚、nonce 驱逐或 cached approval 声明。
- 错误固定 code/phase，区分 not-attempted、source reported-not-consumed、reported-consumed 与 unknown。未完成超时、不确定 consume 或消费后失败永久 halt 当前实例。reported-consumed 与 exact readback 仍不是企业 durable commit 证明；真实 reconcile/独立部署控制仍需后续实现。

## 扩展回归：异常与隔离诊断

- 首次十二组本地合同 **289/289**，0 cancelled / skipped，duration 24603.0147 ms，2026-10-09T09:50:35.422Z → 2026-10-09T09:51:00.062Z；stdout SHA-256 `e9ce8243737876bfc1c53e82a588d9af225b182666c301970f019f62a5e6107d`。
- 同次 23 文件组合退出 1：432 tests / 422 pass / 0 fail / **10 cancelled**，duration 25267.8193 ms，2026-10-09T09:51:00.062Z → 2026-10-09T09:51:25.368Z；stdout `e1db4fee65cd18f9deaaedca379d02fcb8c624d553f070236ac722a2f69e6b91`。首取消为 Ask `PATCH recovery releases an explicitly expired crashed-owner lease`，其后九项也取消。首轮只保留统计及测试名，未保存完整取消诊断，因此根因未知；不推断为环境或本轮代码原因。
- 隔离 Ask **75/75**，0 cancelled / skipped，duration 7152.1424 ms，2026-10-09T09:52:20.594Z → 2026-10-09T09:52:27.782Z；stdout `f6e6e2f74e7f9b6925e46298e8cf1a9eb98914cca8dacaed24931e1375009dfa`。同 route test 摘要 `11f0b9763b2d17dae0edbdf648f3bafc433ff0770fa26e739984588da42a066f` 前后稳定；root 未修改 Ask 或超时。隔离通过不证明取消问题已修复。
- 首轮 56 个相关文件前后均稳定。此有限快照不是全仓库、全部传递依赖或企业环境冻结。既有 manifest 修复和其他任务 runtime/readiness 漂移继续与 W0 历史分离；runtime 摘要仍 `2309d3a282dc7fa8256d5854f9473c665c087db092f6191fdc2f62868dd2de3a`。
- 第二次十二组本地合同 **289/289**，duration 24555.3796 ms，2026-10-09T09:53:16.612Z → 2026-10-09T09:53:41.204Z；stdout `9341fda6d39c42fda8a23e473f6b7a3b295171d0a51aa355717308669573ab87`。同次 23 文件组合退出 1：432 / 421 pass / **1 fail / 10 cancelled**，duration 25092.8789 ms，2026-10-09T09:53:41.205Z → 2026-10-09T09:54:06.335Z；stdout `6cab76661005c497b5a88f7bce8acb9791ab9d6a3693edc5eabb453a0145ccc7`。失败为 Ask `PATCH resumes exact generation A cleanup after generation B starts`；同样十项取消，日志含 EPERM。尾部采集没有覆盖失败所在的早期 TAP 区块，未保存完整断言或 syscall stack，EPERM 与取消的确切因果仍未知。
- 为取得失败 TAP 区块，第三次诊断改为提取所有失败区块而不是 stdout 尾部；同 23 文件 **432/432**，未复现、失败区块为空。三轮均无 source drift，最后四文件与终审精确一致；不修改 Ask/runtime、测试 deadline、并发度或测试清单，不跳过异常测试，也不继续盲目重跑以制造稳定性结论。
- 原 Ask EPERM、59 项 Ask 失败与早期 2 秒启动观察失败仍保留于先前报告。本轮不以任何一次后续绿色抹掉历史异常或声称根治。

## 终审精确文件身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authorization.ts` | `4c648675e15ef047bd4deb74174032a49b45fb4c359b62489a5af0f9dea0918b` |
| `src/lib/rag/eval/production-authorization.test.mjs` | `5f65625d988b60156a7451e0175388292f102f943898f4553df4b850380e2bb1` |
| `src/lib/rag/eval/production-authority-approval.ts` | `e5ffb1c880968ab8b140dcb96bf08d9b115e1cc5e255d9b8694a92519f85c53d` |
| `src/lib/rag/eval/production-authority-approval.test.mjs` | `1752b025e3c4246100aaba7279903ffea9692085a25c90d2d8023aa9828bacdd` |

## 未完成项

- 当前公钥、静态 revocation 配置、source ref、actor/profile 都来自 caller 的 local reference 配置，不能自举企业 trust roots、部署 adapter identity、权限或 revocation freshness。
- Clock/nonce 端口仍是单实例内存 fixture。良构假的 clock/approval 标签可被底层结构 store 消费、新实例会丢失 replay 历史的两个既有测试保持；组合器的实际 Ed25519 校验未把它们升级为真实可信时间或 durable nonce authority。
- 没有独立企业时钟签名/IAM、在线撤销、跨实例/重启 nonce 原子连续性、fsync/WORM、provider registry/conformance 签名或真实 enterprise adapters。本地 receipt 仍需完整 authority/trust/journal/recovery 组合。
- 同步 adapter 可阻塞 JS；elapsed 检查只拒绝迟到 settle，不能抢占同步代码或证明进程隔离。未知提交后的真实状态 reconcile 与持久 halt 尚未实现。
- W2 全部 purpose/共同 ports/完整独立 harness、W3-W9 以及真实 T16/T17/R18 外部输入、阈值、维护窗口和发布周期留存仍未完成。

Sprint 保持 work/active、2/13；W2 整项 open，18 项端到端 AC 均未标通过。完整 Goal active。用户直接授权允许继续既有本地实现，但不生成缺失的企业证据。
