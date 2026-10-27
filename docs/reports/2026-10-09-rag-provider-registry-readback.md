# W2 registry 精确读回与签名验证组合

日期：2026-10-09。所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。本报告只交付本地 reference 消费链；不表示企业 registry、完整 W2 或 T16/T17/R18 已验收。

## 已交付

新增 `production-provider-registry.ts` 与对应测试：

- provider-neutral `ProviderRegistryPort.readExactPolicy`，请求绑定五字段 run identity、profile、reader、authorization digest、caller observedAt、exact policy reference 与独立 request nonce。
- 受限只读 reference registry：配置冻结并深复制；policy 使用既有完整 validator 并重算摘要；同一 object ID/version 不得重复；scope、reader 标签、exact reference、policy validity、nonce 重放和实例容量均校验。最多 64 policies、16 readers、4096 次成功读回；nonce 不淘汰，重新创建实例不提供持久重放保证。
- `validateProviderRegistryReadback`：独立 expectation 精确绑定 context/challenge/source/policy，重新验证 policy 摘要、scope 与有效期。即使 enterprise proof 标签结构正确，结果仍固定 `structural-only`、`productionAuthorized=false`。
- `createReferenceRegistryBoundTrustVerifier`：部署侧 anchor/roots 与 selection 分离，不接收调用方 policy；每次选择都重新执行 registry readback 和现有实际 Ed25519 verifier，包含 T16/T17/R18 的不同必需用途，无成功缓存或 fallback。registry reference 与 signer roots 在实例内冻结，更新需重新构造部署配置，不是在线吊销服务。
- 使用既有共享有界调用器；支持的 native Promise own then getter 不执行。同步超预算和未决 timeout 分开报告；畸形 carrier 或未决 timeout 会 halt 当前 verifier。busy、attempt 上限、成功决定之间 caller observedAt 单调性、方法/receiver/request/roots 快照均验证。registry read budget 为整数 1–60000 ms；不是整个 signature/serialization 操作的总 wall-clock SLA。
- 返回冻结的 confidential 本地 cryptographic decision、exact registryRef、readback proof hash 和 decision hash。所有 reference capability/production authorization 标志仍 false；错误仅含固定 code 与 completion 状态，不转发 provider diagnostics。

没有改变 Ask/API、真实 runner、生产配置或 `.env`；没有执行企业连接、切流、故障、清理、commit/push。该组合是可调用的本地消费链，不冒充已接入完整生产 orchestrator。

## 实际 TDD 与审查

1. 新测试先运行，缺失 `production-provider-registry.ts` 导致实际 RED：runner 0/1，64.5699 ms。
2. 首次实现使用 Node strip-only 不支持的 TypeScript parameter property，runner 0/1，71.4145 ms；显式声明/赋值字段修复，不改变编译配置。
3. 首轮 13/13，314.6855 ms；strict TS、ESLint 无诊断。随后五项边界 characterization 加入，18/18，406.8075 ms；后加测试不伪称先红后绿。
4. pending-native timeout fixture 仅用 test-context mock 固定 `performance.now`，明确区分 pending 与 elapsed dispatch/settlement。另有真实 50 ms 同步阻塞 / 20 ms budget 测试，验证 settled 超预算 UNKNOWN=false；未更改生产预算。
5. 两文件精确独立终审 APPROVE，定向 18/18、strict TypeScript 与 `ESLint --max-warnings=0` 退出 0；未发现可操作 P0/P1/P2。审查身份与最终回归身份一致。

测试签名来自运行时生成的两套 Ed25519 keypair；harness/runtime signer 角色分离并实际执行验签，但仍是本地测试 roots，不是企业独立 behavioral harness 或真实 process measurement 凭据。

## 最终回归证据

Node 子进程参数 `--test --test-timeout=30000`；外层 timeout 90000 ms、输出上限 16 MiB。沿用已有子进程 `RAG_SEMANTIC_ROUTER=off`，不持久写环境。十五组合同为前报告十四组加 provider-registry；累计加入原 W0 十一文件，形成 26 文件并集。

| 范围 | 结果 / duration | UTC 起止 | stdout SHA-256 |
|---|---|---|---|
| 十五合同 | 376/376，26567.2514 ms | 11:53:40.762–11:54:07.370 | `37216fdbd87f08e0997b4c5000e2689819c434f45f1421833269e61142c4880f` |
| 26 文件累计 | 519/519，26601.635 ms | 11:54:07.372–11:54:34.010 | `6e56dea941e1499211ee5cb6e12822c2405d2129be47dd9a5030ccdeb6487bda` |

两轮 0 failed/cancelled/skipped，stderr 为空。十五模块 strict TS 与两新文件零警告 lint 均退出 0，stdout/stderr 为空；空流 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

62 文件有界源码/测试 snapshot 前后 drift=[]；不是共享工作树或所有依赖被冻结。直接定向 Node 输出有既有 MODULE_TYPELESS_PACKAGE_JSON warning，未为此改 package.json。前序历史未知失败/EPERM/超时证据保持原记录；本轮绿色不证明历史全部根治。

| 文件 | 最终 SHA-256 |
|---|---|
| `src/lib/rag/eval/production-provider-registry.ts` | `5cf61f9cf596e768811155e3bb629f140c5db39eb84b80cb8bc36505f9796b7f` |
| `src/lib/rag/eval/production-provider-registry.test.mjs` | `0bd4638f1c0a3fee74895564b267195d1d63a1e16f7f4d0576940b7d6248dc0f` |

## 未完成与边界

context、reader/source 标签、授权摘要及 observedAt 不证明 IAM、审批、真实来源或可信时间；proof hash 不等于签名。reference nonce ledger、signing roots 与单调时间状态没有跨实例持久 authority。只读 fresh readback 不等于企业 registry authentication、实时撤销或完整行为 conformance；签名真实性也不证明证书中声明的所有 behavioral tests 已执行。

该 helper 不是同进程 JavaScript 沙箱，也没有 cancellation/rollback；企业 adapter 仍需独立隔离、鉴权及实际 process/deployment 测量。生产仍需真实 registry/roots/identity、clock、approval/revocation/durable nonce、独立 harness 和 authority-aware receipt/manifest/writer 组合。

真实活动 Sprint 保持 WORK/ACTIVE、2/13；W2-W9、T16/T17/R18 及 18 项端到端 AC 未标通过。下一步是 W2 剩余共同 operation ports、各 purpose/full behavioral harness、authority-aware 组合与 receipt/完整 runner 集成，再按依赖进入 W3-W9。不能以直接授权制造企业 roster/gold/阈值、独立签认、维护窗口或已实际经过的留存时间。
