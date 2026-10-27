# W2 Journal 独立行为探针与输入边界修订证据

- 日期：2026-10-09。继续既定 W2，不改变 13 项任务、18 项 AC 或 T16/T17/R18 范围。
- 新增 `production-journal-conformance.ts` 与 `.test.mjs`；复用现有 canonical / journal / provider requirements。另修复前轮 artifact conformance 的 descriptor/captured map 原型边界并加一条实际 PoC。未修改原 journal、authorization、trust、controlled-artifacts、receipt、Ask/runtime/request-validation、凭据或用户配置。
- 只执行一次性本地 reference journal，以及明确的 enterprise-profile 实验室包装；不连接真实企业资源，不触发生产 journal、fencing、密钥或制品操作。

## 已验证结果

- Journal 48 项、Artifact 33 项，合并定向 **81/81**，0 skipped，duration 24092.7989 ms。
- 十模块 strict TypeScript 退出 0；四个变更源码/测试文件 ESLint 退出 0。独立复核记录 0 errors、3 条非阻断测试 unused-vars warnings；不是全仓库 TypeScript 或生产 build。
- 独立终审 **APPROVE**，四文件精确摘要前后一致；未发现剩余 P0/P1/P2。只批准下方本地代码快照，不是企业 conformance 或生产验收。
- 十组本地合同 **221/221**，0 skipped，duration 24605.2074 ms；2026-10-09T08:10:15.228Z → 2026-10-09T08:10:39.868Z，stdout SHA-256 `619847399c12e8a41b6386c3eee992d38a631d32b8c64dff2cc9d127b9c830ce`。
- 当前 21 文件完整既有 hermetic 组合最终 **364/364**，0 skipped，duration 24643.5891 ms；2026-10-09T08:14:56.800Z → 2026-10-09T08:15:21.490Z，stdout SHA-256 `299dd4e015dedc64f24d55abc6606e2973b767146d99e694d8329f89b85dfc3f`。
- 52 个相关文件在各次完整组合运行前后稳定；不等于整个仓库或全部传递依赖冻结。原 W0 35 文件历史未重写；两个既有 manifest 修复及其他任务 readiness/runtime 变化仍单独保留。当前共享 runtime 为 `2309d3a282dc7fa8256d5854f9473c665c087db092f6191fdc2f62868dd2de3a`，不同于前轮 artifact 报告的 `ff11b3f42c42da6261ae6e084a29ad37c7e0f06a430f70e952b33f68e5deb52d`，root 没有编辑或回滚这些共享文件。
- 仅在既有测试子进程沿用 `RAG_SEMANTIC_ROUTER=off`；没有修改用户功能配置。没有 commit/push、学习写入、清理或生产操作。

验证命令沿用现有 Node strip-types / resolver hooks：

```text
node --experimental-strip-types --test src/lib/rag/eval/production-artifact-conformance.test.mjs src/lib/rag/eval/production-journal-conformance.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node <十个已验证模块>
node node_modules/eslint/bin/eslint.js <四个变更源码/测试文件>
```

TypeScript 模块：canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance。广回归使用 W0 已记录的既有测试清单与这十组合同去重组合，不把新清单重写为旧基线。

## TDD 与独立复审的实际红绿记录

1. 首次缺实现模块 `ERR_MODULE_NOT_FOUND`：0 pass / 1 runner fail；不是声称所有新 case 分别执行红测。
2. 初版 21/22，strict TypeScript 同时发现 result 字段访问缺少联合类型。唯一行为失败是 binding-normalization mutant 同时错误修补 digest，提前被 entry-integrity 拦下。修正字段联合及 fixture 原 digest 防线后 22/22，没有放宽 oracle。
3. Root 实际 PoC 得到 22/26、4 fail：拒绝 fence 后后续合法 generation 被毒化；terminal 后新 result/terminal 被接受；合法 scope ID 等于默认 adversarial label 造成非不同 perturbation。补实际合法 fence 续代、三 kind 终态拒绝、去碰撞及 MAX_SAFE fence headroom 后 27/27。
4. 独立审查确认 Promise.all 快速拒绝后另一个调用仍晚到的 unknown-completion 漏洞，以及 expectedHead binding 除 runNonce 外的五字段缺口。实际 27/34、7 fail；observeAll 改 allSettled，head/entry 各六 binding 字段逐项测试（scope 三字段重算合法 scopeHash），之后 34/34。
5. 并发 loser / 提前 terminal 的 ID 隐形消费、terminal 后历史 intent/result exact retry：实际 34/38、4 fail，修复后 38/38。CAS loser 仅更新 seq/prev，保留同 ID/body 进行合法 corrected append。
6. 后续闭集 PoC：terminal-kind tombstone、same-key action/timestamp 假确认、不同完成结果假确认、resolved key 被复用为 intent/terminal、existing digest 绕过 expectedHead 验证。实际 38/45、7 fail；existing key + foreign entry run 单项另得到 0/1。补同 terminal ID 的最终合法 seal、完整 ID 语义变体、已完成 key 保留与 existing digest 前置验证后 41/46。五个 fixture 因新 exact-retry 安全探针而提前失败；保留它们既有 digest 校验，只模拟 new-entry CAS 缺口，46/46。
7. Root 新增 descriptor 原型 PoC：内部普通 `{}` map 收到自有 `__proto__` 数据后，缺失方法可能读到继承 getter并透出异常；Journal 与 Artifact 实际均红。两模块改 null-prototype map，getter 不执行。独立终审另确认“业务字段相同，仅 seq/prev/digest 重嵌”的第二 result 不能称 exact retry；准确 open-only mutant 单项 0/1，duplicate-result 负测加入空变化 `{}` 后修复。最终 Journal 48 + Artifact 33 合并 81/81。

所有修复均基于明确、可复现原因。fixture 的前置防线修正用于只模拟指定漏洞，不改变固定通过语义。供应商自报 pass/checks、恶意错误或方法不定义 oracle。

## 完整回归的失败历史与未知项

- 初版 22 项候选：十组合同 194/194，duration 3874.6619 ms，2026-10-09T07:32:53.203Z → 2026-10-09T07:32:57.114Z，stdout `8b1339fc8e2f8a6db564d6cc39e4d8b11c7ead40fd3414b02fd0dd42c1ea6960`；21 文件 337/337，duration 6103.2396 ms，2026-10-09T07:32:57.114Z → 2026-10-09T07:33:03.260Z，stdout `0d3565bf085c4ce0d468e33c2bfa4bd54c6466a89512dfd0750f03d4d4ecb221`。
- 46 项修订前候选：218/218，duration 23969.087 ms，2026-10-09T08:01:20.877Z → 2026-10-09T08:01:44.887Z，stdout `ea4dc5013cdd153e9ad4f987cd1ebad12d6f19afd9c191c45a3fc06be0386969`；361/361，duration 24180.3201 ms，2026-10-09T08:01:44.887Z → 2026-10-09T08:02:09.103Z，stdout `9492d9902e8b24df35e9293c7a341fff0ab76aaafcb69be26a8c91d12ba07af2`。两者不是最终四文件身份。
- 最终候选首轮完整组合 **363/364、1 fail**，duration 25132.9377 ms；2026-10-09T08:10:39.869Z → 2026-10-09T08:11:05.041Z，stdout `407e80b0162b8ca8cb38548387a67165e89a4984e703a0203e048471f78807c7`。失败名为 `POST durable bounded replay preserves the final evidence and rejects a mode change`；安全日志出现 `{ name: 'Error', code: 'EPERM' }`。该次 stdout 只返回紧凑 case 名与安全日志摘要，未保存完整断言/系统调用栈，不能据此确认具体文件操作或错误原因。
- 隔离该 Ask 单项 **1/1**，duration 1079.4488 ms，2026-10-09T08:13:59.280Z → 2026-10-09T08:14:00.393Z，stdout `93bcd0e432bf28e9a8e72987a8b4731918a85a248a5c5f14001e5f9574455e8e`；Ask 全组 **75/75**，duration 6976.57 ms，2026-10-09T08:14:00.394Z → 2026-10-09T08:14:07.402Z，stdout `2931b9741a323453c3cf4c0ff57b175df482882bf5293fe7a0ed96feda69c697`。
- 三个诊断文件前后摘要稳定：Ask route test `11f0b9763b2d17dae0edbdf648f3bafc433ff0770fa26e739984588da42a066f`；runtime 如上；request-validation `182f33a7eeb33cf2536837cc7459fc319d6ca12ed27214cb46b716b020083760`。未修改 Ask、增大超时、回滚用户文件或删除测试目录来隐藏失败。
- 隔离与最终 364/364 没有复现 EPERM，**根因仍未知，不能声明根治或确定为环境偶发**。前轮 59 个 Ask 失败和更早的 2 秒观察超时同样保留，不用当前绿色结果抹除。

## 18 个固定黑盒 probe 的实际边界

1. Fresh genesis 的 exact binding/head/empty chain。
2. 实际 intent append，响应与独立 ledger 构造的预期 head/完整 chain 对照。
3. Exact digest retry 支持旧/当前同 binding head；foreign 六字段或畸形 head 必须拒绝，不能以已登记 digest 绕过校验。
4. 两个并发 contender 必须一 appended、一 conflict；各响应 head 与读回一致；loser 同 ID 的合法 corrected append 必须成功。
5. expectedHead 所有顶层字段及六 binding 字段 CAS 约束，负测后同 ID 合法 append。
6. Entry digest/未重算数据、未知字段/schema/action 拒绝，随后同 ID 正向控制。
7. Entry 六 binding 字段逐一交换，scope 三字段同步重算 scopeHash；不允许跨 scope/run 归一化。
8. seq 前后、prevDigest、时间回退负测；公开重算 digest 不替代链规则。
9. 已登记 intent key 的 actor/auth/参数/before/action/time/scope 语义不可别名为 already-applied。
10. Result 与 unresolved intent 精确关联；已完成 result 的第二非 exact 记录必须拒绝，含仅重嵌 seq/prev 的变化及 after/outcome/actor/auth/time；原 exact result 仍可重试。
11. Pending intents 禁止 seal；第一个拒绝 ID 做合法 intent 可用性控制，第二个 seal ID 留到最终合法 terminal 再用。
12. 真实 fixture advanceFence 与独立 head/chain 读回；当前 owner 可以 exact retry 老 generation 的登记对象。
13. 旧 owner 不能获得旧对象的幂等确认；旧/未来/零 token 不能新写，同 ID 当前 token 正向控制。
14. Entry fencing 必须匹配当前 token；旧/未来/零 generation 拒绝。
15. 同/旧/零 fence control 必须拒绝；每次拒绝后实际合法续代/readback/append，证明未毒化下一 generation。
16. 完成所有真实 pending intents；resolved key 不得再作为新 result/intent/terminal，仍支持 exact 原 result。
17. 以曾被 premature seal 拒绝的同 terminal ID 完成合法最终封存。
18. 封存后 exact 历史 intent/result/terminal 可在当前 fence 重试；新三 kind、旧 token 与再 advanceFence 拒绝。

调用前捕获所有 own data methods，拒绝 getter、Proxy、symbol 等非法 journal adapter 表面；descriptor/captured map 使用 null prototype，不触发继承 getter。请求脱离调用者后 deep freeze；head/chain 的预期来自本地独立 ledger，不能反向从 adapter 响应提取。完整 observations core 绑定 probes、classification、config/challenge/requirements hash、verdict、pending 与未完成清单；不保存原始 journal entries、授权制品或供应商异常。

每次 async operation 有观察上限，失败后停止后续 probe。所有已启动的成对操作等待 allSettled；timeout 标记 `pendingCompletionUnknown=true`，不当作安全拒绝。没有 abort/cancel 接口，不宣称已取消、回滚或无晚到写入。JS timer 不能中断同步阻塞代码，外部 harness 仍需进程隔离。Fixture control 是实验资源控制接口，不是生产 fencing authority；caller 的 isolation/profile/booleans 不是权限或企业身份。

## 不可升级为生产凭据

输出固定 `validationLevel=isolated-behavioral-observations`、`classification=confidential`、`productionAccepted=false`、`requirementVerdict=incomplete`。`verdict=passed|failed` 仅描述固定 probes，既无 signature，也不采用 provider conformance attestation schema。

Run-journal 八项完整 requirements 全部保留未完成，冻结的 requirements hash 未修改。上述同进程行为不证明真实 IAM/执行身份、权威可信时间、持久化跨实例分布式 CAS/fencing、防篡改权威 head、重启/崩溃/网络分区连续性、enterprise no-fallback/transport/redaction；KMS/store 的完整 requirements 亦未因边界修订而完成。统一全部 purpose 的共同 ports/full suite、权威 approval/time/revocation/nonce/recovery、authority-aware receipt 与完整 manifest/trust/writer 组合仍 open。

## 终审精确源码身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-journal-conformance.ts` | `bb7b423ca750ebd72233d8126ad9fcea27ebc500559926f49a38aa0da147611f` |
| `src/lib/rag/eval/production-journal-conformance.test.mjs` | `f1f649d73854b25917273d7ba48cbf61b98f3cf4abbe0116dac412f350461308` |
| `src/lib/rag/eval/production-artifact-conformance.ts` | `7fec3453f56404713237c3d42c28af7bde5a26e6d5fbf41fa0e2b6970b534654` |
| `src/lib/rag/eval/production-artifact-conformance.test.mjs` | `9d2a8e2b6b5ed1d4b329081e50cb35ef10248b0c82decb82a0514a6ac264c802` |

Sprint 保持 work/active，2/13；W2 整项仍 open，18 个端到端 AC 未标通过。完整 Goal 保持 active，没有用本地观察替代 T16/T17/R18。
