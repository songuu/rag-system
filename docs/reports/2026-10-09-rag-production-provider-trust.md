# W2 Provider Trust / Conformance 合同局部验证

- 时间：2026-10-09；当前 Sprint `work/active`，完成计数仍为 2/13，W2 整项 open。
- 本轮新增 `production-provider-trust.ts` / `.test.mjs`；未修改既有 Ask、Graph、W1、journal、authorization、readiness 或部署状态。
- 范围是部署 policy、provider selection 和独立 conformance/runtime attestation 的合同及受限本地 verifier，不是企业 registry 或完整 behavioral harness。

## 已验证

- 新测试先因缺模块失败；首版 11/11 green。
- 独立审查确认 P1：只签 run/manifest 而不直接签 stage/provider set 时，可改请求阶段并重算子集摘要。红测 11 pass / 1 fail，修复后 12/12。
- 最终五组 W1/W2 合同 67/67，0 skipped，duration 418.9134 ms。
- 五个 TS 合同模块 strict TypeScript 退出 0；新增两文件 ESLint 退出 0。
- 独立最终复审 APPROVE，无剩余 P0/P1/P2；reviewer 另独立执行 12/12 和两文件 ESLint。
- 本地整体回归 210/210，0 skipped，16 个测试文件，duration 10381.9716 ms；窗口 2026-10-09T04:09:07.580Z → 2026-10-09T04:09:18.003Z。
- 41 个相关源码/测试文件运行前后摘要无漂移。与 W0 历史快照比较仍仅有上轮两个 manifest 修复和其他任务 readiness 变化；本轮未扩大这些变化、未回滚它们、未重写历史证据。
- 最新 stdout SHA-256：`c731d6529183c2acd4372834dedd7b0517506852266a6f94689f06ad4eb4a970`，只是本地输出身份，不是生产防篡改证据。

## 合同与修复

- `kg-provider-trust-policy/v1` 冻结精确 environment/tenant/corpus、有效期、必测项摘要、用途/provider ID、operator ID、adapter/version/image digest、artifact signature reference、config hash、endpoint origin、网络限制及 credential policy reference。
- 已定义 14 个用途的共同必测项和 purpose-specific 必测项：13 个生产 gate provider，加 CitationLocator。当前 W1 gate manifest 仍只支持原 13 个用途；CitationLocator 的 operation port/W8 集成未完成。
- manifest selection 只能提供登记的 purpose/provider/adapter/version/config tuple 与 conformance reference，不能提供 policy、endpoint、credential 或降低网络限制。每阶段必需用途仍为 T16 8、T17 13、R18 7。
- policyRef digest 精确对应独立配置输入的 policy；selection 的 registry object ID/version/digest 必须完全一致。duplicate registration/purpose、缺 provider/证明、额外 readback、unknown version/config/digest、替换 conformance object version 均拒绝。
- conformance 与 runtime 使用分离的 Ed25519 key/issuer role 和签名 domain；禁止与 provider operator 重合、跨角色共用 issuer 或复用 public key material。显式未知/吊销/version/有效期错误均拒绝。
- conformance attestation 绑定 registry/scope、精确 provider identity、必测项摘要、完整唯一 passed check 集和 harness-run nonce。它的 nonce 是独立 harness 运行身份，不是生产 run nonce；符合有效期的证书可被后续生产 run 引用。
- runtime attestation 另绑定实例、registry/scope、精确 artifact/image/signature-ref/config/origin/profile、生产 run nonce、manifest hash、stage 和完整 providersHash，TTL 最长 5 分钟。
- 修复后的每个 runtime signature 都覆盖 stage/providersHash；checker 先重算 request provider set 摘要，再逐个 proof 精确比对。T17→T16 改标和删 Ask→R18 子集复用均拒绝。
- 无环顺序是 policy → conformance object → manifest provider set/hash → runtime measurement。providersHash 不含 runtime object refs，runtime proofs 不会自引用。
- registry/runtime identity 只能声明 enterprise 且 fallback=false；fake/reference/fallback 在合同层拒绝。**承载本地测试的 verifier 自身始终是 local-reference，不能因被测 identity 声明 enterprise 而升为生产 verifier。**
- endpoint 必须是规范化 TLS origin，无 userinfo/path/query/fragment；端口与 network policy 一致。redirect/proxy/TLS 降级、零值/超上限 IO limit、路径或 wildcard credential ID、inline secret 字段拒绝。
- 输入先 canonical 分离；Proxy/getter 不执行，错误只使用固定 schema 位置，不复制输入值或 crypto exception。

## 明确未证明的内容

- `validateProviderTrustPolicy` 固定 `structural-only / productionAuthorized=false`；reference factory 固定 `local-reference / productionCapable=false`，signature 验证结果也固定 `productionAuthorized=false`。
- keys、revocation、policyRef、observedAt 和 object readback 是本地调用方配置/输入。并未证明真实部署 registry 来源、可信时间、权威存储锁定/封存、artifact signature 本身、实际 adapter 测量或企业 principal 的身份独立性。
- object ref/hash/version 检查只是输入之间的一致性；不能替代独立 TamperResistantArtifactStore 的 exact version/lock/retention proof。
- `PROVIDER_CONFORMANCE_REQUIREMENTS` 冻结的是必须执行的检查名称，不是已实现或已执行的 behavioral suite。合成 fixture 人工签名的 passed 项只用于测试 verifier，不是 adapter 或生产 conformance 凭据。实际 harness/suite code identity、逐 port 行为测试及真实封存仍待交付。
- origin 字符串校验和 network policy 声明不证明 DNS/IP/metadata/loopback/private-network 越界、TLS chain/hostname、重定向、代理、响应/压缩/流式限额已经被网络 adapter 执行；这些还要由 W3/相应 ports 的实际出站实现和 conformance 验证。
- 本 checker 尚未将 W1 完整 stage view、有效 execution authorization、实际 trusted clock/nonce authority 和每次动作的 fresh identity/fencing 组合为生产许可；相关 writer/runner 仍 open。返回对象不是授权后续 mutation 的 capability。
- 上轮记录的一次未复现回归失败仍根因未知，本轮 210/210 不代表已经修复该 flaky 行为；W9 保留稳定性检查责任。

## 最终文件身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-provider-trust.ts` | `99e95ee9e88625c734e82bb0145bccb40520cde7ba0632ccf0cce35051c0a569` |
| `src/lib/rag/eval/production-provider-trust.test.mjs` | `18719ea773a4f509a899d18d059e8a2ae5b7071f5a6235ca418dab11d717b698` |

回归只在测试子进程沿用既有 `RAG_SEMANTIC_ROUTER=off`；不改用户功能配置，不访问本轮新定义的 provider origins，不注入凭据，也不证明真实语义模型/生产质量或完整仓库 build。

## 下一步

继续 W2：完整 provider-neutral operation ports 与受限 reference adapters、实际独立 behavioral harness、权威 approval/time/revocation/nonce 组合、无环 receiptCore/exact readback/result attestation/acceptanceBundle、受控制品 AEAD/AAD/index 和 authorized journal writer。W3-W9、T16/T17/R18 均仍 open；18 项端到端 AC 未提前标记通过。
