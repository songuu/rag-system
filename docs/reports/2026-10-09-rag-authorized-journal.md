# W2 授权日志写入器：本地参考实现证据

- 日期：2026-10-09；active sprint 仍为 `work/active`，W0/W1 done，2/13；W2 整项与 18 项端到端 AC 不提前完成。
- 新增 `src/lib/rag/eval/production-authorized-journal.ts` / `.test.mjs`；复用原 canonical、approval verifier、journal CAS 和 receipt validators，未改动这些已审模块、Ask/Graph/readiness 或生产配置。
- 本轮针对既定 W2 的 authorized writer：从“可写的结构日志”推进到实际签名注册、逐写授权检查、阶段动作限制与恢复授权/代次组合。不是企业审批、可信时钟或生产完成凭据。

## 当前验证

- 先写 17 组行为测试并运行；因实现模块缺失得到 `ERR_MODULE_NOT_FOUND` 红测（0 pass / 1 runner fail），不是声称 17 条用例已分别红测。首版实现后 17/17。
- 增加 3 组：重算 envelope ref 后仍须触达真实 Ed25519/key-role/revocation/key-validity 校验；恢复授权过期/签名者吊销/再失锁后的精确 retry 拒绝；actual signed execution → new-generation recovery → aborted terminal → full receipt 的组合。初始定向 20/20，0 skipped，duration 189.7646 ms。
- 独立审查发现三个 P1：并发撤销不识别 pending recovery、不同语义角色/摘要共用对象身份、未实际验签原 execution 却可注册 recovery。新增测试先得到 20 pass / 4 fail；加原执行验签和 fence headroom 负测后 20 pass / 6 fail；修复后 26/26。继续补充失败 pending 清理、并发注册 17 容量、64 个撤销 tombstones 耗尽后的全写者 fail-closed，以及原执行已撤销仍可依法签发独立 rescue 的正测，最终 30/30，0 skipped，duration 244.6297 ms。
- 八个合同模块 strict TypeScript 退出 0：`--ignoreConfig --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`；新增两个文件 ESLint 退出 0。不是全仓库类型检查或生产 build。
- 初始八组 W1/W2 合同：130/130，0 skipped，duration 556.0933 ms；窗口 2026-10-09T05:52:08.462Z → 2026-10-09T05:52:09.056Z。stdout SHA-256 `0d5e7b6d667cc7fecc87e44e1b3bf25d9018bb064e886ecca2b890f9b2059e37`。修复后最终 140/140，0 skipped，duration 458.3975 ms；窗口 2026-10-09T06:12:09.383Z → 2026-10-09T06:12:09.878Z。stdout SHA-256 `ea97d4dc16b4b68f7fe522540bd9a9deaa9ef8d595cdd0d06ca76d04f7a89e71`。
- 初始 19 文件完整既有 hermetic 组合：273/273，0 skipped，duration 23702.3275 ms；窗口 2026-10-09T05:52:09.057Z → 2026-10-09T05:52:32.797Z。stdout SHA-256 `29b646567f586f47cc1270a4c189aec3ba246445551fb384ed316205d207ef80`。修复后最终 283/283，0 skipped，duration 7779.5812 ms；窗口 2026-10-09T06:12:09.878Z → 2026-10-09T06:12:17.697Z。stdout SHA-256 `7b0e4383945df61e8709b0e45e9515354eb6a63b0153cb81398589becd4109c8`。
- 47 个相关文件运行前后身份一致。相对 W0 历史只有此前两个 manifest 主动修复和其他任务的 readiness 变化；没有还原或覆盖用户脏文件。
- 子进程沿用既有 `RAG_SEMANTIC_ROUTER=off`，未改变用户配置、启用真实网络模型或执行 T16/T17 指标。上轮 Ask agent-entered 2 秒观察超时仍保留在回执报告，本轮不宣称修复或时序稳定。
- 独立复审 `/root/txn_review_final` 最终 APPROVE，无剩余可复现 P0/P1/P2；核对以下精确摘要，独立重放三个原 PoC 均 fail-closed，独立定向 30/30 与新增两文件 ESLint 通过。批准只覆盖 local-reference 合同切片，不是 W2 整项或真实生产验收。

## 实际能力与边界

- Provider-neutral `AuthorizedRunJournalPort` 与 reference factory 分离。Reference 始终 `productionCapable=false`；签名注册结果 `productionAuthorized=false`；每个写入结果 `productionAccepted=false`。Enterprise 接口能力字段或返回标签不自动建立信任，仍需要部署侧 trust/conformance 与真实事务实现。
- Reference factory 自持原私有内存 CAS store，不暴露原始 compare-and-append 或接收 caller-supplied commit callbacks。每次写入在异步读取 head/完整链后重查 live authorization，紧接调用无 await 的私有 CAS commit；reference 时钟/吊销 seam 在该单进程同步区域不能插入。不是分布式 atomicity、数据库事务、fsync、restart 或 WORM 证明。
- Execution expectation 与 public keyring 从 factory 数据一次快照冻结，不从 incoming envelope 提取后冒充独立期望。注册必须匹配完整 payload、精确 envelope digest/ref、签名/key role/有效期；nonce 只在注册时消费一次，随后缓存 grant 可用于本 run 的多条授权日志。registered + pending 总量最多 17；pending 在首次 await 前准入、不授予权限、允许并发撤销、finally 移除。已消费 nonce 与单调吊销状态不淘汰/重置；最多 64 个授权撤销 tombstones，耗尽后全写者 fail-closed，不能继续接受无法登记的撤销。
- 注册缓存不豁免后续检查。新的 append 和 exact idempotent acknowledgement 均检查当前 reference time、notBefore/expiresAt、execution window、authorization/signer 吊销、signed duties 与 generation；新 generation 不复用原 execution，即使原窗口尚未关闭。
- Entry 的 seq、prevDigest、binding、actor、authority digest、generation 与 trustedTime 由 writer 构造，不接收 caller 的任意 seq/time/digest/raw query。现有 hash-chain/intents/results/terminal 规则仍由原 validator/store 执行。竞争保留 conflict，不刷新 head 或自动重新执行。
- Exact retry 只认精确同一既有对象：包括旧 expected head、action/parameters/before/after/intent/outcome/actor/auth/fence，保留原 trustedTime/digest；修改已存在 idempotency 身份不覆盖或重新基于新 head 写入。
- T16 只允许 ask-off/ask-shadow/readback/seal；R18 只允许 readback/seal，不赋予 serving mutation 或删除权限。T17 使用 off/active 的闭集动作；这些仅是 journal 动作记录，不是实际业务/部署执行许可，T17 quality/ramp/fault/lineage/live readback 编排仍由 W4-W6 实现。
- T17 factory 必须有严格冻结 recovery policy/hash、scope/authority、独立 rescue actor 标签和 lineage/revision budget。Recovery 域字段来自冻结 contract/policy，实际新 generation 来自私有 store；nonce/发行时间/收窄动作/credential reference 由实际验签的 recovery signer 选择，不能用这些字段替换 run/scope/policy/original authorization/lineage/role/fence。
- Recovery 注册要求本工厂已有实际验签的原 execution grant；允许该原批准随后过期或吊销，不允许 options 中声明的未验签原批准自行建立历史。该非持久工厂不支持 bootstrap/restart/import 历史授权。T17 原 generation 必须预留实际新代次，拒绝 MAX_SAFE_INTEGER 无救援余量。
- 引用使用 object ID/version 识别对象，execution、registry、credential policy、lineage、recovery authorization、credential 的语义角色不能混用；同一身份的摘要不得冲突，并检查已有及 pending recovery。允许精确同一 credential 在同一角色跨授权复用；禁止用不同摘要冒充同一对象版本。
- Recovery 只允许 signed policy 子集的降风险意图及只读/封存日志。可用失败/中止 result 记录已有危险 intent 的结束，不能新建危险 intent 或把旧 activation 记为 completed。仍须精确匹配旧 intent，terminal 不得绕过未解决 intent；记录不证明对应 live readback 事实或真实 serving 操作发生。
- Execution principal 和 rescue actor/role/credential 都是参考数据标签，只校验与冻结/已签名 context 一致；不是真实身份认证、IAM/JIT credential-policy membership 或 ACL。Manual clock、advanceFence、revoke seams 均为显式测试工具，不是权威 provider。
- Source expectation/frozen policy/keyring 本身尚未与完整 manifest、真实独立审批或 ProviderTrustPolicy 自动组合。真实 key trust roots、可验证历史/持久 nonce、跨实例吊销/时钟/fencing、崩溃恢复/导入历史、writer 独立 readback、防篡改 auth object 版本和独立 behavioral harness 仍 open。
- Recovery journal 能组合成终态 forensic ReceiptCore，但现有 bundle structural helper 仍拒绝 recovery refs；完整 authority-aware recovery/receipt/bundle acceptance 仍必须实现，不把可记录救援当成合法生产验收。

## 已复审源码身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authorized-journal.ts` | `c0647e17f11fddd7f20c49fc0a279b1b26ac1ee0ff64c85082db869fa91a31f0` |
| `src/lib/rag/eval/production-authorized-journal.test.mjs` | `3576232a5213a6baa05cee05c876486af6b732aee9268f33eacf39ac133c57f3` |

没有 commit/push、学习写入、历史清理或生产 mutation；FULL goal 继续 active。W2 其余共同 trust/operation ports、独立 conformance suite、authority-aware receipt/恢复组合以及 W3-W9/T16/T17/R18 保持原范围。
