# W2 Production Authorization 局部验证

- 时间：2026-10-09；当前 Sprint 仍为 `work/active`，任务计数仍为 2/13。
- 本轮完成的是 W2 审批合同与本地 reference verifier 切片，不是 W2 整项或生产审批链。
- 新增 `production-authorization.ts` / `.test.mjs`；对 W1 `production-gate-manifest.ts` / `.test.mjs` 做了回滚 revision 预算的最小安全修复。未改 Ask/UI/readiness、部署或生产状态。

## 已验证事实

- 初始测试因模块不存在而失败；首版 11/11 green。
- 独立复审提出 recovery envelope 未直接表达完整 frozen Pointer revision；补红测得到 11 pass / 1 fail，修复后 12/12。
- 双增量边界红测得到 12 pass / 1 fail；修复后 authorization 13/13。
- 只在 recovery 时拒绝还不够：T17 必须在任何发布前预留预算。W1 preflight 红测 16 pass / 1 fail，收紧后 manifest 17/17。
- canonical + manifest + journal + authorization 合并 55/55、0 skipped；4 个 TS 模块 strict 检查退出 0，4 个实际修改代码/测试文件 ESLint 退出 0。
- 独立终审 APPROVE，无剩余 P0/P1/P2；reviewer 另独立合跑 manifest + authorization 30/30，四文件 ESLint 退出 0。
- 最终完整本地回归两次 198/198、0 skipped。最新时间窗口：2026-10-09T03:43:14.722Z → 2026-10-09T03:43:24.125Z，15 个测试文件，duration 9355.9837 ms。
- 最新 39 文件运行前后摘要一致；与 W0 历史快照相比，2 个 manifest 文件是本轮主动修复，`ollama-readiness.ts` 是共享树其他任务的变化。历史基线未被重写，其他修改未被覆盖。
- 最新 stdout SHA-256：`972ff4e672653d6ff45e25b9c5a90e5d4a305a9b65cd382a1236e077df7874ee`。这是本地输出身份，不是防篡改生产制品证明。

## 审批合同

- 三个不互换的 schema/kind：execution authorization、result attestation、T17 safety recovery。
- 签名使用独立 domain/profile，精确覆盖 schema、kind、完整 payload、algorithm/key ID/key version。本地测试使用临时生成的 Ed25519 密钥，源码不含私钥或生产凭据。
- common payload 绑定 stage、environment/tenant/corpus、manifest hash、run nonce、授权 ID、独立 envelope nonce、issuer、职责分离身份和 canonical UTC 有效期。
- execution 绑定 stage-specific operation、registry object digest/version、provider/threshold 摘要及授权必须落入的批准窗口。
- result 绑定 execution/core 的精确 object ID/version/digest、report/artifact index/final state 摘要、machine verdict、实际执行身份和完成时间；不得在完成前签认。
- recovery 仅为 T17，绑定原授权引用、冻结 policy、精确 predecessor/target、实际新 fencing generation、rescue role、JIT credential reference 和短 TTL。
- recovery 只允许 `withdraw-traffic`、`revoke-existing-fault`、`set-off`、`rollback-to-predecessor`。激活、加流、新 fault、空/重复动作、旧 fence 和跨 lineage expectation 均拒绝。
- frozen `lineage.expectedPointerRevision=N` 与 `rollbackExpectedPointerRevision=N+1` 都被签名；同一 target 在 N+3 出现不能刷新 revision 后盲目回滚。N 必须 ≤ `MAX_SAFE_INTEGER-2`，保证 N+1 发布和 N+2 回滚均可精确表达；W1 T17 preflight 同步提前拒绝越界。
- 输入先由已有 canonical profile 分离，再校验严格字段闭集；Proxy/getter 不执行，任意命令/URL/额外字段、路径越界、非规范签名编码拒绝，错误不复制输入值或原始 crypto exception。

## Reference verifier 的明确边界

- 工厂只能接受 `local-reference`，固定 `productionCapable=false`；结果固定 `productionAuthorized=false`。
- 本地 verifier 检查签名、key type/version/role/issuer、显式 revoked 状态、完整 key 生命周期覆盖、授权有效期、完整 expectation、clock 不倒退和一次性 nonce 消费。
- key registry 会分离，拒绝重复 key/version、跨角色复用同一 public key、非 Ed25519 或非规范 SPKI；有限 nonce 集不淘汰，满容量直接失败。
- nonce check/consume 无 await 临界区仅在单实例中原子；重启、多实例或分布式持久化没有保证。返回对象只是不可变的本地校验结果，不是可以授权后续 mutation 的 capability。
- `observedAt`、keys、revocation 和完整 `expectedPayload` 都是调用方传入的测试边界。把 envelope 自身 payload 作为 expectation 只能测试签名/结构，不能证明它符合真实 manifest/core/policy/live fence。生产必须从独立、权威、冻结来源构造 expectation，并在每次动作前重新检查时效/吊销/fencing。
- 本模块不证明 registry 来源、TrustedClock、独立 ApprovalVerifier、durable nonce authority、conformance、KMS、受控制品或 receiptCore/tamper proof/result attestation 信任链。任何结构/本地通过都不能用来运行 T16/T17/R18。

签名 API 用法核对了 [Node.js v22 crypto.verify 官方文档](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback)：显式公共 KeyObject、字节编码，以及 Ed25519 的 `null` algorithm。这里只复用标准运行时 API，不自行实现密码算法。

## 单次回归失败与未知项

- 2026-10-09T03:40:47.737Z → 03:40:56.918Z 的完整组第一次运行是 **197/198，exit 1**；39 文件在该运行前后未变。
- 该次工具返回截断了 stdout 中部，唯一失败的名称/断言未保留下来；其 stdout digest 是 `250b6c1c256be1913a7adf236e49d6f012379e438ffddf72c716fe9ee7ef443a`。不能根据缺失片段猜测失败原因。
- Ask 单文件复核 75/75；随后完整组 198/198（duration 7337.1095 ms，stdout `10898a800bed96805d2737b146f0d5e441000c299fa9c1317b224d9eff14a532`）；再一次 198/198 且运行前后 39 文件稳定。
- 因此单次失败未复现、根因未知，不宣称已修复 flaky test；readiness 的并行变化只证明共享树变化，不证明它导致失败。后续 W9 需要保留失败片段并继续检查测试稳定性。
- 回归只在测试子进程沿用既有 `RAG_SEMANTIC_ROUTER=off`，不修改功能配置，也不代表语义模型/真实质量或完整仓库 build 验证。

## 本轮最终源码/测试身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authorization.ts` | `7c80952723f2770225f5667874339a159456784bbc9026bd96d6b08e3202c08e` |
| `src/lib/rag/eval/production-authorization.test.mjs` | `4c4604b72d6d6f661f71c06f94ba9b56d77f38760cf785828d036463b9c51f7c` |
| `src/lib/rag/eval/production-gate-manifest.ts` | `47021f79b930da5e7c987b261ed4532609522c030245e37dcc87553982269b2e` |
| `src/lib/rag/eval/production-gate-manifest.test.mjs` | `07c622140187f284ae3cc3094d87ba786560a07e4f3e41fb8cdf1d0deb25ea37` |

最新观察到的其他任务 readiness hash 为 `845bd49f7039d81534eb568f2ddbdada04da3ff2a51088db81559a1425d10344`；本轮未编辑该文件。canonical/journal 与其余 W0 相关文件身份保持不变。

## 下一步

继续 W2 的 provider-neutral ports/部署侧 trust registry 与独立 conformance 基础；接入真实来源的 approval/time/revocation/nonce 合同、无环 receiptCore/independent exact readback/result attestation/acceptanceBundle、受控制品 AEAD/AAD/index 和 authorized journal writer。W2 未完成，W3-W9、T16/T17/R18 全部继续开放；18 项端到端 AC 未提前勾选。
