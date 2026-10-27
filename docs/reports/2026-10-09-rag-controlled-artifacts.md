# W2 受控制品操作与 reference 行为局部验证

- 日期：2026-10-09；当前 `work/active`，完成计数仍为 2/13，W2 整项 open。
- 新增 `production-controlled-artifacts.ts` / `.test.mjs`；未修改 Ask、Graph、其他 W1/W2 合同、readiness 或部署状态。
- 将 KMS/制品存储操作合同、实际内存 reference 行为与索引放在同一 data-protection 模块，避免仅新增未实现的接口清单；其余 operation ports 和统一独立 conformance suite 仍待实现。

## 已验证

- 新测试缺模块 red → 首版 13/13 green。
- 索引缺函数 red（13 pass / 2 fail）→ 15/15 green。
- 逐例 request/gold/response AAD 缺 case ID 红测（15 pass / 1 fail）→ 16/16 green；report 等 run-level 制品可使用 null case ID。
- 六组 W1/W2 局部合同 83/83，0 skipped，duration 425.7269 ms。
- W0 原范围加四个 W2 test 文件的完整本地回归 226/226，17 个测试文件，0 skipped，duration 5051.7392 ms。
- 回归窗口：2026-10-09T04:34:55.408Z → 2026-10-09T04:35:00.498Z；stdout SHA-256 `b8b25c563e43df712a0023bd5204619dafeafa18ddf42d588721e0c2f4d86805`，仅作为本地输出身份。
- 六个 TS 合同 strict TypeScript 退出 0；新增两文件 ESLint 退出 0。
- 43 个相关源码/测试文件运行前后摘要无漂移。相对 W0 历史基线仍只有已记录的两个 manifest 修复及其他任务 readiness 变化；本轮未修改这些文件，也未覆盖历史记录。
- 独立最终复审 APPROVE，无 P0/P1/P2；reviewer 另独立执行 16/16 及新增两文件 ESLint。批准严格限于本局部，不覆盖统一 harness、真实企业 trust、receipt/writer 或 W2 整项。

## 操作与安全边界

- 定义 provider-neutral `KmsEnvelopePort` / `TamperResistantArtifactStore`，包含 encrypt/decrypt/rotate/revoke、exclusive seal 和独立 readExact；operation context 是数据，**不是授权 capability**。
- 两个 reference factory 只接受 `local-reference`，固定 `productionCapable=false`；enterprise profile、unknown/inline endpoint 配置、相同 writer/reader 均拒绝。
- 每个 reference run factory 生成独立 256-bit key，密钥不出现在 envelope 或 readback。AEAD 为 AES-256-GCM，96-bit nonce、128-bit tag；同一 factory 的 nonce counter 跨 rotation 保持唯一，已加密 object ID 不允许再次使用，历史不被容量驱逐。
- 十字段 AAD 精确绑定 environment/tenant/corpus、run nonce、manifest hash、artifact type/ID、case ID、ordinal 和 schema version。逐例 case ID 必须符合 32 位小写 hex 的伪名形状；这不证明真实匿名性或其属于批准 roster，后者需 runner 与冻结 manifest 组合验证。
- decrypt 只有在 `final()` 成功认证后才返回 plaintext；密文/tag/nonce/AAD/版本/key object ref 替换失败，未认证的 update plaintext 不向调用方释放。
- rotate 保留旧 key 的读能力；revoke 将内部 key buffer 置零并拒绝后续 decrypt。当前 key 吊销后 encrypt 失败，不自动回退。没有从这里生成企业 key rotation/revocation 证据。
- 每次操作检查固定 run/profile/角色和本地有效期；成功时间不倒退，失败尝试不推进时间。caller 提供的时间、actor ID 和 authorization digest 不是企业身份/可信时钟/有效审批。
- store 只接收有界 encrypted envelope，原子本地 exclusive create，禁止 overwrite/delete/plaintext upload。exact readback 校验 object ID/version/digest，输出 detached/frozen 对象；并发 duplicate 只有一次成功。
- proof 固定 `assurance=local-reference`、`productionTamperResistant=false`、`lockMode=local-reference-immutable`。独立读角色仅是配置/调用合同，不是已证明的企业职责分离或 WORM readback。
- confidential index page 最多 256 个 entry，且受 canonical 256 KiB 上限约束；只保留 opaque/pseudonymous identity、object/key refs 与 AAD digest，拒绝额外原始 query/response、duplicate ID/semantic slot、错误 object ID 和 scope/AAD digest。
- index 固定 `structural-only / productionAccepted=false`；不证明完整 roster/trial 集合、真实 key/store、ciphertext authenticity、审批或留存政策，也尚未有跨页 root/完整性协议。
- 输入先 canonical 分离，Proxy/getter 不执行，错误不复制输入内容；byte buffers 尽量置零。这不证明 JS string/GC/OpenSSL 内存、崩溃转储或遥测已具企业级全链路保护。

## 未完成与不声称的证明

- 内存参考实现没有 durable escrow/shared store、重启或跨实例连续性、fsync/atomic rename、ACL/WORM/legal hold 或 deletion/crypto-shred。未进行任何实际文件/数据库保存、历史清理或生产 mutation。
- retainUntil 在这里只验证本地未来时间/上限，不替代 T17 冻结的 retentionPolicy；store 校验 envelope 结构/AAD digest，不自行证明 AEAD tag 或 KMS identity，实际 authenticity 需通过 KMS 的独立解密及可信 ports 链。
- operation context 未与部署侧 ProviderTrustPolicy、完整 stage view、签名 approval、可信 clock/nonce/revocation 和 fencing 实时组合；未证明 registry/image/artifact identity、网络 origin/DNS/TLS、凭据晚注入或 out-of-process 隔离。
- 测试是真实的本地 AEAD/内存行为执行，不是 adapter 自报 passed；但仍不是全部 14 个 provider 用途的统一独立 conformance harness，也不会签发生产 conformance receipt。
- 回归仅在测试子进程使用已有 `RAG_SEMANTIC_ROUTER=off`，不改用户功能配置、不验证真实模型质量、生产 gates 或完整仓库 build。上轮单次未复现失败的根因仍未知，W9 稳定性责任保留。
- 下一步仍为 W2 的完整 operation ports/独立 behavioral suite、authority 组合、immutable receiptCore → exact readback → result attestation → acceptanceBundle，以及 authorized journal writer。W3-W9、T16/T17/R18、18 项端到端 AC 仍 open。

## 最终文件身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-controlled-artifacts.ts` | `108183f1d114a1d7c6c7fd61392f8d8c95bdef6a6a702d59f852e99a1916cdb2` |
| `src/lib/rag/eval/production-controlled-artifacts.test.mjs` | `2941fdfd31e1043e8fc15ca67d34667307a32a369c8332a8e1db641c7ef3ae2d` |
