# W2 KMS / 制品存储独立行为探针证据

- 日期：2026-10-09。前一轮授权日志已完成本地切片；本轮继续 W2 的 actual behavioral suite，不改生产验收定义。
- 新增 `src/lib/rag/eval/production-artifact-conformance.ts` 与 `.test.mjs`。复用已有 canonical、KMS/store ports、AEAD validators 和 provider requirements；未修改这些已审源码、Ask/Graph/readiness、凭据或用户配置。
- 只执行内存 reference 和明确的 enterprise-profile 实验室包装 fixture。没有连接真实企业服务、旋转生产密钥、创建生产制品或执行生产 mutation。

## 首轮验证与失败历史

- TDD：15 组测试先得到缺实现模块 `ERR_MODULE_NOT_FOUND`（0 pass / 1 runner fail），不是声称 15 条分别执行红测。首次实现采用 TypeScript 参数属性，Node strip-only 明确拒绝；已改普通字段声明，没有更换测试工具或修改项目配置。
- strict TypeScript 与 ESLint 先绿，行为测试 14/15。失败原因是 AAD 伪造负测包装仅替换请求 AAD，却未同时替换 envelope 的 AAD digest，实际上仍由原 adapter 正确拒绝。修正错误 fixture 后 15/15，没有放宽 oracle 或 AEAD 校验。
- 增加 enterprise-profile 同一中立 suite、negative-probe timeout、readback 时间/输出 getter 负测，初版 18/18，0 skipped，duration 240.3087 ms。初版九组合同 158/158，duration 523.7842 ms，窗口 2026-10-09T06:32:55.557Z → 2026-10-09T06:32:56.119Z，stdout SHA-256 `223cd7c93d413b34ca9e2622234e643b99c1505dc37e2fed66095ad0334fc9d3`；20 文件初版组合 301/301，duration 5867.0891 ms，窗口 2026-10-09T06:32:56.119Z → 2026-10-09T06:33:02.026Z，stdout SHA-256 `627ba1c00e6b7eb78b86ae3c9816eb82567fb13a4e0f2a5b188007618d0ae9ae`。这些是终审修复前的快照，不作为最终 APPROVE 身份。
- 独立审查复现了先前可能假通过的实现：第三对象 nonce 重用、部分历史对象撤销遗漏、scope/profile 或管理角色缺失、nonce 未认证、重复对象的 AAD/plaintext/retention 变体、旋转 keyRef 仅换标签、九个 AAD 字段遗漏公开 digest 重算负测，以及安全输出字段未纳入 observations hash。实际红测依次为 16/18、16/20、16/24、16/27、16/28、16/29（最终 13 fail）。修复后 26/29；三组 mutant 因正确的前置角色探针而提早拒绝，保留其原管理角色/profile/scope 防线后仅模拟指定漏洞，得到 29/29，没有放宽通过条件。
- 再审实际复现三类“encrypt / rotate / seal 已改变状态，然后抛拒绝”的假通过：新增 PoC 后 29/32、3 fail。补齐拒绝后的同 ID 合法调用、exact readback、冻结 active key 正向控制后，最终定向 **32/32，0 skipped，duration 500.2368 ms**。这些控制只证明可观察到的指定状态，不证明所有外部副作用不存在。
- 最终九模块 strict TypeScript 退出 0：`--ignoreConfig --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`。新增两个文件 ESLint 退出 0。不是全仓库类型检查或生产 build。
- 中间九组合同 169/169，duration 624.8515 ms，窗口 2026-10-09T06:56:52.606Z → 2026-10-09T06:56:53.275Z，stdout SHA-256 `c41ae475d757f815598d22b4c96f9d69755aee8cce35c28504776a80809e942d`。随后 20 文件组合 **253/312，59 fail**，duration 33411.6011 ms，窗口 2026-10-09T06:56:53.275Z → 2026-10-09T06:57:26.728Z，stdout SHA-256 `2db03240d769a9d49bacf63feeca427188a04a6b8a4f4e4a7aafdf5ef4ae7ffa`。59 项失败均位于 Ask，包含 500/200 不匹配、后续缺失 context/map 和 2 秒 signal 观察超时；原始工具 JSON 输出被截断，未保存完整返回日志，不能据此定位全部失败根因。
- 失败运行的 49 文件前后稳定，但共享 Ask runtime 相对 W0 新增漂移：历史 `72005cbeb49f7ad0cb5975f97b6b3963c5df0bc1c5f4eefeec8405c1cf024c3c` → 失败快照 `b7a73bdfd414b4d17f70a1419e93d98c7ad31dc668ae20792a8979b647c72db0`。只读观察到 runtime / request-validation 的 active embedding 关联校验；推断可能与其他任务正在修改的共享依赖有关，**准确根因仍未知**。root 未编辑、回滚这些文件，也未加长测试超时。
- 只读 Ask 单项隔离 1/1（单项 duration 31.7686 ms，总 duration 873.7302 ms）；Ask 全组随后 75/75，duration 7994.3802 ms，stdout SHA-256 `431f96d3af0d99b16ccf955083ce9252b3607f720161ce99acf52ab2ac211401`。这些结果与后续绿色回归不抹除 59 项失败，也不证明已根治。此前回执切片 Ask 的单次 2 秒观察超时同样继续保留为未知。
- 最终九组合同 **172/172，0 skipped，duration 926.6031 ms**；窗口 2026-10-09T07:09:49.947Z → 2026-10-09T07:09:50.916Z。stdout SHA-256 `be8006ef78e3c2426a8d48d9d33ff545fbad14edee3f5461b1d01f91e3f6a055`。
- 最终 20 文件既有 hermetic 组合 **315/315，0 skipped，duration 5335.917 ms**；窗口 2026-10-09T07:09:50.916Z → 2026-10-09T07:09:56.300Z。stdout SHA-256 `29e724732db0fe142a79883c047687c73c0e5d4d04c2a1168a829fb250ea652b`。
- 最终 50 个相关文件（49 加 request-validation）运行前后摘要一致。共享 runtime 此时为 `ff11b3f42c42da6261ae6e084a29ad37c7e0f06a430f70e952b33f68e5deb52d`；相对原 35 文件 W0 历史仍另外保留既有两个 manifest 修复与其他任务 readiness 变更，不重写基线。该集合未覆盖整个仓库或全部传递依赖。只在既有 hermetic 子进程沿用 `RAG_SEMANTIC_ROUTER=off`，不改用户配置。
- 独立终审 **APPROVE**：针对下方两个精确源码摘要，独立 32/32、strict TypeScript 九模块及 ESLint 两文件通过；未剩可复现 P0/P1。审查不是企业服务、生产身份或 T16/T17 验收。

## 实际行为与未完成范围

`runIsolatedArtifactConformance` 接受既有中立 KMS/store ports 和精确隔离测试合同；oracle 固定在仓库代码中，不接受 adapter 提供 checks、pass 回调或 verdict。独立生成随机 challenge 和伪名 artifact ID，按顺序调用真实方法，直接比较结果并检查拒绝行为。

18 个固定 probe 覆盖：

1. KMS roundtrip 正向控制。
2. 所有合法加密的全历史 nonce 区分，以及冻结 active key 身份；只在合法显式 rotation 后改变预期 key。
3. 同对象重复加密及 ordinal/schema/plaintext 变体拒绝，旧对象继续可读。
4. 十个 AAD 字段逐一交换，分别测试原 digest 与公开 digest 重算；每次负测后正向控制。
5. 交换 AAD 并重算公开 digest，仍必须由真实 AEAD 拒绝。
6. ciphertext/tag/nonce 篡改不得释放 plaintext。
7. key object ID/version/digest 替换拒绝。
8. KMS writer/reader、全部五个 scope 字段和 profile 的 encrypt/decrypt/rotate/revoke 拒绝；错误 encrypt 不得消费同 ID，错误 rotate 不得切换 active key，错误 revoke 后旧对象必须仍可读。
9. plaintext 上界 + 1 拒绝，随后同 ID 合法加密与解密成功。
10. 两个并发 identical store creates 只能一个成功，另一项必须为 provider 拒绝，而不是 timeout。
11. 独立 reader 的 exact object/hash/version/store identity/proof 读回；预期对象由请求独立构造。
12. 错误 object ID/version/digest 拒绝，不允许 latest-object fallback。
13. immutable retry（包括另一合法未来 retention）不得覆盖，重新读回原对象。
14. store writer/reader、全部五个 scope 字段和 profile 拒绝；错误 seal 后同 ID 合法 seal 及 exact readback 必须成功。
15. envelope/AAD 交换拒绝；错误 seal 不得消费同 ID。
16. 非未来 retainUntil 拒绝；同 ID 的合法 seal 与 exact readback 必须成功。
17. 实际 key rotation，旧对象可读、新对象使用新 ref；两个已注册 keyRef 交叉交换仍由实际解密拒绝。
18. 按真实 keyRef 撤销全部历史样本，其他 key 正向可读；撤销 active key 后全部相应样本拒绝，新 encrypt 不得 fallback。

每次可能 mutation 的负测使用独立 AAD/对象 ID，随后按合法身份验证对应可观察状态。本地 reference 成功路径约 28 个 KMS 对象与 10 个 store 对象；fixture 容量足够但不代表生产容量或持久性。retainUntil/proof 时刻只做规范化合同检查，不构造可信时间来源。

所有 adapter 方法在首次 await 前从 own data descriptors 捕获。getter、Proxy 对象或 Proxy 方法拒绝；不读取函数 bind/name/length。请求和配置脱离调用方后深冻，返回对象按 bounded canonical data 验证，读回预期不是从返回值反向提取。供应商错误、原始请求、plaintext、密文与凭据不写入结果。不可变 observations core 包含完整合同/challenge/requirements 摘要、probes、安全分类、verdict、pending 状态和未完成要求，再对完整 core 计算 hash；没有未绑定的外层安全旗标。输出标记 `classification=confidential`，没有签名。

失败即停止后续 probe，不继续 rotate/revoke/seal。每次 async 调用有观察上限；timeout 不被当成 negative probe 的安全拒绝。KMS/store 既有接口无 abort 能力，timeout 后可能晚到完成，报告必须保留 `pendingCompletionUnknown=true`，不得宣称已取消、回滚或制品未创建。JS timer 不能中断同步恶意/阻塞代码，外部 harness 仍须进程隔离。

同一 suite 可用于 local-reference 与 enterprise-profile 实验室 ports；profile/booleans 只校验合同一致性，不建立真实企业身份。`isolation=disposable-test-scope` 仅表达调用方意图，不是 authenticated permission。外部独立 harness 必须事先验证隔离资源、授权、真实 adapter artifact/config/身份，并负责自身执行隔离与签认；本模块没有自行认证或使用任意 endpoint 的路径。

观察输出固定：

- `validationLevel=isolated-behavioral-observations`
- `productionAccepted=false`
- `requirementVerdict=incomplete`
- `verdict=passed|failed` 只针对这些实际 probes
- 无 signature，不采用 provider conformance attestation schema

现有 KMS/store 各自八项完整 requirements 均保留为未完成。探针不证明 IAM/审批真实性、真实密钥熵与不可导出、跨实例/重启 nonce 连续性、真实 WORM/ACL/fsync/法律保留、独立权威读回、完整身份测量、network/TLS/DNS/transport bounds、全链路脱敏或生产 no-fallback。其他 provider purposes、统一完整 suite、共同 operation ports、authority-aware receipt/恢复组合与完整 manifest/trust/writer 仍 open。未修改已冻结的 `PROVIDER_CONFORMANCE_REQUIREMENTS_HASH`，不能将局部 observations 直接变为要求全 passed 的 conformance attestation。

## 首轮终审源码身份（后续修订前）

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-artifact-conformance.ts` | `0c8481f0e7b3dd03b1198858847fce5e6d0f0049855959a46997df8e17c40861` |
| `src/lib/rag/eval/production-artifact-conformance.test.mjs` | `36e44d2e665cda96cc374a1789bd972d3d07455208f6a8747d62d2b169d8cb72` |

Sprint 保持 work/active，2/13，18 项端到端 AC 未通过；W2 整项仍 open。没有 commit/push、学习写入、清理或生产操作，完整 Goal 保持 active。

## 后续 descriptor 输入边界修订（2026-10-09）

Journal 行为探针实现时，root 实际复现本模块同模式的 `__proto__` descriptor map 漏洞：自有数据属性可能污染内部普通对象，使缺失方法读到继承 getter。新增真实 PoC 后，data/captured map 改为 null prototype，getter 不执行且异常不透出。Artifact 当前 33 项、Journal 48 项，合并 81/81；十模块 strict TypeScript、四文件 ESLint 退出 0（独立复核有 3 条非阻断测试 warnings），四文件最新独立 APPROVE。当前完整组合复核 364/364、52 文件前后稳定；首轮 363/364 的 Ask EPERM、后续隔离 1/1 与 Ask 75/75 均保留，准确根因仍未知。

本节更新后的 artifact 精确源码：TS `7fec3453f56404713237c3d42c28af7bde5a26e6d5fbf41fa0e2b6970b534654`，test `9d2a8e2b6b5ed1d4b329081e50cb35ef10248b0c82decb82a0514a6ac264c802`。上方原 32 项/hash/APPROVE 是历史快照，不能作为当前文件身份；完整修订证据见 `docs/reports/2026-10-09-rag-journal-conformance.md`。本次没有修改 KMS/store operation ports、冻结 requirements hash 或 false/incomplete 生产标志。
