# Provider 证据实际读取的本地参考切片（2026-10-10）

## 结论与边界

W2 新增 provider-neutral `ProviderEvidenceReadbackPort`、受限内存 reference store、结构 readback validator，以及 `createReferenceProviderEvidenceVerifier`。新 verifier 的调用输入封闭为 `{}`：从实际 registry/clock/evidence callbacks 读取冻结 policy、精确版本 conformance 对象和对应 runtime 对象，复用既有独立 Ed25519 trust 验证，不接受 caller 传入证书、测量对象、时间、policy 或成功标签。

这是新入口自身的合同，不代表已有 authority writer、旧 registry-bound verifier 或 runner 已接入它。旧 trust API 的 caller-object 验证仍保留；接入、新的实时测量和完整 behavioral suite 尚未完成。reference runtime store 只保存测试夹具提供的真实签名对象，不会测量企业运行进程。

全部输出固定 `productionAuthorized=false`；新入口的 `stageAcceptanceComplete`、`behavioralConformanceComplete`、`conformanceSourceAuthenticated`、`runtimeSourceAuthenticated` 均为 `false`。reference ports 固定 `productionCapable=false`。没有企业 registry/measurement/harness/IAM、持久性、网络传输或 production source authenticity 证明，也没有机器 gate 重算、阶段授权消费或 production mutation。

权威计划仍为 WORK/ACTIVE 2/13，仅 W0/W1 完成；W2–W9、T16/T17/R18 和 18 项端到端 AC 保持开放。用户直接授权允许继续本地实现与验证，不生成真实数据/gold、阈值、企业身份、维护窗口或实际 elapsed 证据。

## 实现合同

两个 evidence 操作分别接收封闭 context、独立新 challenge，以及精确 certificate ref 或完整 selected provider。readback 绑定实际对象 ID/version/canonical digest、kind、source identity、context、challenge 和 selector。结构 validator 重算真实对象和整个 readback 的 canonical digest，但不声称验证企业来源身份；最终 composer 另实际验证所有证书与 runtime 的独立签名、key version/role/revocation、scope/run/manifest/stage、完整 provider-set hash、check/verdict 和有效期。

reference store 在构造时快照并冻结对象。certificate 只能 exact-ref 读取，runtime 只能按 purpose/provider 和全部选中 identity 字段匹配；不提供版本 fallback、修改对象或自动重试。绑定的 reader/auth digest 是本地相关性合同，不是实际 IAM。scope/run、窗口、时序、全局跨两操作 challenge replay、读次数、availability 和 ID/version 冲突均有有界拒绝。存储是进程内测试状态，不是持久 WORM 或独立实时测量系统。

新 verifier 在首次 evidence IO 前读取真实 registry，并核对每个 selected provider 已登记的 purpose/providerId/adapter/version/config；key roots、expected selection、ports 的 descriptor-safe callbacks 在 await 前捕获/冻结。每次 source callback 前使用新的实际 challenged clock reading，检查完整 uncertainty 区间位于 observation window 和实际 policy 有效期内。observation window 只是读取边界，不是 execution grant。

每次 invocation 最后再次读取实际 registry，再取得实际完成时钟。registry policy 不得变化；最后时钟的两个 uncertainty 端点分别交给新的 stateless signature verifier，避免把重叠误差区间误当真实时钟倒退。实际 clock sequence/time cursor 和 challenge 集合仍在同一 verifier 内跨调用保留，成功不缓存为下一次授权。第二次成功也重新读取全部来源。

每个 invocation 预留全部冻结 certificate 的 ID/version，runtime 不得占用已读、未来 certificate 或之前 runtime 的同一版本，即使各自 body/signature/digest 都有效。收到冲突后不继续下一次 source IO。

设 selected purpose 数为 N：一次完整读取需要 evidence `2*N`、registry `2`、clock `2*N+3`，合计 `4*N+5` 个独立 challenge；私有 challenge 额度按 `maxVerifications*(4*N+5)` 计算，并保留独立 invocation 上限。T16、T17、R18 最低 required purpose 清单复用共享只读常量；既有 conformance requirements/schema hash 不变。

bounded native Promise 超时或非法异步 carrier 后，verifier 永久 halt；迟到完成不会继续读取，也不会恢复为成功。并发第二次调用 fail-closed。provider 抛错、非法对象、getter/Proxy/thenable 等均以封闭 phase/code 红acted 错误处理，不调用 payload hooks。此模块只读，不执行实际 approval nonce 消费或写入制品。

## TDD 与失败保留

- 新入口缺失 RED：原预算 factory leaf 0/1、exit=1，实际工厂为 undefined；stdout SHA256 `6d0c5099707fb7f7511dc62a381a9cb0bbfe6fa6545d3e4dae0ba87d61b88492`，duration_ms=103.5937。
- 首次实现 19/19、strict17 exit=0。lint3 exit=1：一个未使用的 `ProductionGateStage` type import，0 errors/1 warning；stdout SHA256 `4b7706a5032b53b87e62718b4c01677ce514295d85cae527404f5136241488d9`，stderr SHA256 `99a3dfa8107e1f53d2ffb780a3dfb2d79c4ec1f2ba90a4173dc91308d07b536b`。移除未使用 import，没有降低零告警要求。首次 19 项 stdout SHA256 `684b6c2ade7586a8ca4904fe99906c185869332a48b0d7fd2637750fcd905945`、duration_ms=809.9787；不是最终 21 项身份的验收结果。
- 新增实际对象版本别名 RED：`node --test --test-timeout=30000 --test-name-pattern="different evidence roles cannot alias" src/lib/rag/eval/production-provider-evidence.test.mjs`，0/1、exit=1、Missing expected rejection。实际 callback 返回有效签名 runtime 对象，但把 ID/version 改为 selected certificate 的版本，并更新实际 proof；旧 composer 错误通过。stdout SHA256 `b7239f1526170b1c52c79ec29ef9876d1093cf48d3bd8053bcf30d1297f0170c`，duration_ms=142.5372。
- 修复后同一反例覆盖 current certificate、future certificate 和 previous runtime，分别在实际 evidence call 2/2/4 后拒绝，不继续后续读取。另增加重复成功时的实际重新读取与 fresh challenge/clock hash 断言；补强 missing/duplicate purpose 负测，修改列表后重算 providers hash，确保命中 purpose 校验而不是仅 hash 错误。
- expanded 21/21、strict17/lint3 green；第一次修复后 stdout SHA256 `a924a752637ffb41051be3b9bce1dfda6920fb60ecd2102546db17d7cecc9908`，duration_ms=834.6907。以下表格是随后完整回归的同一 source/test 身份。

21 项涵盖三个阶段及全部 14 purpose、真实两来源签名、source/context/challenge/selector/hash/version、registry 未登记/中断、错误/吊销/跨角色签名、stage/check 替换、时间边界与跨调用倒退、最后 registry 再读、成功不缓存、caller 标签、配置漂移/恶意 hooks、完整最小 challenge 预算、并发 busy、UNKNOWN 和迟到完成。既有 Ask 503/200、500/200、EPERM、journal/nonce UNKNOWN 和 30s timeout 等未知历史失败保持在既有报告；本轮绿色不声称已根治。

## 验证证据

原 `node --test --test-timeout=30000`；无 skip/preload、deadline 放宽、concurrency/isolation 改动或持久环境切换。仅测试子进程 `RAG_SEMANTIC_ROUTER=off` 沿用基线；90s 外层观测和 16MiB 输出上限。下表 UTC；全部 exit=0、stderr 空，测试 fail/cancelled/skipped/todo 均为 0。

| 检查 | UTC 起止 | 结果 | duration_ms / stdout SHA256 |
|---|---|---|---|
| strict17 | 04:52:36.104–04:52:37.046 | exit 0，stdout/stderr 空 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| lint3 | 04:52:37.046–04:52:38.519 | exit 0，零 warning | 同上 |
| evidence21 | 04:52:38.519–04:52:39.409 | 21/21 | 856.4233 / f2e9afae4f3b4c4f1ac8bbd0692d3afe59d811b2e97398800dbd7c2759893079 |
| local23 | 04:52:39.409–04:53:00.402 | 526/526 | 20956.3416 / a7a7e2bc8958636ebbc9fa619296d687fc7ec05ce52fccc2a6955201443f4d14 |
| cumulative34 | 04:53:00.403–04:53:22.372 | 669/669 | 21929.5919 / 3f539afe297d4b8e87e2447ffae371804325e2dd06ffc894e39c23fafaa7b304 |

strict17：`node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`，对 eval 下 canonical-json、production-gate-manifest、production-run-journal、production-authorization、production-provider-trust、production-controlled-artifacts、production-receipts、production-authorized-journal、production-artifact-conformance、production-journal-conformance、production-authority-ports、production-authority-approval、production-authority-conformance、bounded-provider-call、production-provider-registry、production-authority-receipts、production-provider-evidence 共 17 个 `.ts`。lint3：`node node_modules/eslint/bin/eslint.js --max-warnings 0` 对下表三个文件。

local23：上述 17 模块 `.test.mjs`，加 authority-receipt-writer、manifest-authority、approval-provenance、existing-receipt、predecessor-receipt、authority-bundle-writer 六个测试。cumulative34 在此基础上增加 eval dataset/metrics/gate/matrix/production-policy-contract、context-composer-v2、legacy-evidence-adapter、KG contracts/postgres-publication-store/graph-snapshot-recovery、Ask route 共 11 文件。

75 个 source/test/fixture/request-validation 文件执行前后 SHA256 一致（drift=[]）；集合是上轮 bundle writer 的 73 文件加两个新 evidence 文件。本轮仅下列 source/test 身份新增或改变，其余既有快照值保持。

| 文件 | SHA256 |
|---|---|
| src/lib/rag/eval/production-provider-evidence.ts | 3606bbe97075b466df75745ecd6accf1195c059e302544df35afcf6517ec723f |
| src/lib/rag/eval/production-provider-trust.ts | ecd05cfb919c3e4f11241d39f8e744d5872b5265e90dd1753811fb8a45fbae02 |
| src/lib/rag/eval/production-provider-evidence.test.mjs | 1c0c9043004836704bd9c4ee0e1b4ed5d6401735a6787923196d9cf0168c8c09 |

`git diff --check` exit=0；30 条既有 LF→CRLF 提示保留。用户 staged/unstaged/untracked 和无关变更均保留。未 commit/push、写 learning/Compound、改 env/生产策略、发流量、触发 fault/cleanup 或创建 acceptance harness binding。默认 sandbox helper 的启动错误已通过范围明确的本地只读/测试命令复核，不将环境启动失败当成测试通过。

## 独立审查

功能/安全独立终审 bounded APPROVE，无可复现 actionable findings；上表三个 SHA 审前/后精确一致。独立原预算命令为 `node --test --test-timeout=30000`，依次包含 evidence、trust、registry、bounded-provider-call 四个 `.test.mjs`；只在该子进程设置 `RAG_SEMANTIC_ROUTER=off`。tests=68、suites=0、pass=68，fail/cancelled/skipped/todo 全 0、exit=0、duration_ms=874.0613。主 agent 的同 SHA 原预算累计 669/669 是组合验证，独立 68 项结果不冒称覆盖整个计划。

TypeScript/async 独立终审 APPROVE，上表三个 SHA 审前/后精确一致；独立 strict17/lint3 均 exit=0，没有编辑文件或重复累计测试。确认 descriptor-safe 捕获、深冻结与真实运行时门禁、`4*N+5` 完整路径额度、跨调用 clock/challenge 进度、busy/halt、UNKNOWN/迟到完成和最终 uncertainty 两端点校验。两项批准只限当前 local-reference 切片，不代表企业来源认证、完整 behavioral suite 或 W2 完成。

## 下一步

继续 W2 的剩余共同 operation ports、完整独立 behavioral harness、实际 measured-runtime/证据入口接入、冻结策略 recovery/新 fence/独立 rescue principal 和周期续期证明。按既定依赖推进 W3/W4 实际 runner/computed machine gate、完整递归阶段验收和 W5–W9；企业信任、真实数据/阈值/维护窗口及实际 elapsed 仍是生产前置。新入口只补齐本地实际 callback 读取与组合校验的缺口，不宣称整项目标完成。
