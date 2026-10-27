# RAG / Neo4j W0 基线与 W1 结构合同验证

- 时间：2026-10-09；所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。
- 范围：本地结构合同与 hermetic 回归；不是 T16/T17/R18 生产完成凭据。
- 本次实现仅新增 canonical JSON / production manifest 两模块及测试；未修改既有 RagEval dataset hash、Ask、Graph CAS、IndexedDB 或 UI，也未提交/推送。

## 1. 已验证结果

- 初次既有 11 文件基线：143/143 通过，0 fail / 0 skipped，9678.1524 ms。
- 最新 13 文件复核：172/172 通过，0 fail / 0 skipped，8795.8345 ms；Node v22.22.0。
- 复核窗口：2026-10-09T02:44:57.733Z → 2026-10-09T02:45:06.618Z。
- 下面列出的 35 文件在这次运行前后 SHA-256 完全一致；未宣称冻结所有传递依赖或整个共享工作树。
- W1 两文件定向测试：29/29；最终 strict TypeScript 与 ESLint 检查链退出 0。
- 独立审查：APPROVE，无剩余 P0/P1；Proxy、lease scope 拆分和 manifest/auth 摘要自循环均已修复并有回归测试。

### 1.1 当前离线基线的必要环境边界

- 未关闭新增语义路由的第一次复核在 2026-10-09T02:39:07.328Z → 2026-10-09T02:40:02.334Z 达到 55 秒超时（ETIMEDOUT / SIGTERM）；当次没有完整 summary，不能记为通过。列出的 30 文件当次未漂移。
- 代码确认：语义路由默认可尝试本地 Ollama；现有 Ask 测试未统一关闭该新路径。只在第二次测试子进程设置已有 `RAG_SEMANTIC_ROUTER=off`，未修改文件、用户配置或持久环境。
- 设置 off 后完整套件约 8.8 秒通过，支持“新增模型分类调用导致原离线套件等待”的判断；没有记录真实请求级网络 trace，因此该因果解释仍是代码与对照运行支持的推断。
- 此基线不覆盖真实语义路由模型质量；该能力应使用其独立 mock/live 测试，不用关闭开关后的结果冒充模型验证。

运行的准确测试文件：

```text
src/lib/rag/eval/dataset.test.mjs
src/lib/rag/eval/metrics.test.mjs
src/lib/rag/eval/gate.test.mjs
src/lib/rag/eval/matrix.test.mjs
src/lib/rag/eval/production-policy-contract.test.mjs
src/lib/rag/core/context-composer-v2.test.mjs
src/lib/rag/retrieval/legacy-evidence-adapter.test.mjs
src/lib/knowledge-graph/contracts.test.mjs
src/lib/knowledge-graph/postgres-publication-store.test.mjs
src/lib/knowledge-graph/graph-snapshot-recovery.test.mjs
src/app/api/ask/route.test.mjs
src/lib/rag/eval/canonical-json.test.mjs
src/lib/rag/eval/production-gate-manifest.test.mjs
```

调用：Node 子进程参数 `--test --test-timeout=30000` 加上述文件；仅追加环境 override `RAG_SEMANTIC_ROUTER=off`；外层超时 55000 ms。

- 最新完整 stdout 摘要：`61ff170c4b089b216ebdae1d5a09c75f5851109b6ae226601f6c275a44db0371`。
- 最新完整 stderr 摘要：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- 摘要仅说明本地输出身份，不构成防篡改生产存储证明；完整 TAP 没有落盘为生产制品。

## 2. TDD 与合同边界

1. canonical 模块先有缺模块红测；实现后 10/10。未知键泄漏负测先红，再修正为结构序号路径后 11/11。
2. Proxy object / array / revoked / changing-descriptor 两项新增红测：11 pass / 2 fail；先 `types.isProxy` 拒绝后 13/13，所有 trap 调用为零。
3. 三阶段完整 manifest fixture 与负测在实现前因缺模块失败；首版合同定向测试 27/27。
4. lease/recovery scope identity 红测：manifest 11 pass / 4 fail；修正为 environment/tenant/corpus 三字段，trust 列表不拆分锁域。
5. authorization ↔ manifest 摘要自循环红测：manifest 15 pass / 1 fail；把 executionAuthorizationRef 移出 hash 投影后最终 29/29。

### 2.1 W1 的实际交付

- `canonical-json/v1`：有限 JSON、字典序 key、确定 UTF-8 hash；拒绝丢失值、unsafe integers、非法 Unicode、accessor、Proxy、自定义原型、稀疏/扩展数组和循环；固定 depth 64 / 256 KiB 上限。
- 三阶段结构 validator：T16 不要求未安排的 T17/Retention；T17 增加 predecessor bundle ref、canary/lineage、lease/fencing、ramp、window、FaultPlan、Recovery 与冻结留存；R18 仅核对冻结政策/Store 并引用经过时间证据，不提供清理授权。
- arm 完整 config hash 与 sharedConfigHash 匹配；只有 rolloutMode 可不同。安全 hard gate 为冻结的 11 项零容忍，质量指标与阈值来自版本化闭集。
- provider 只允许 registry/conformance/adapter/config 引用，不接收 endpoint、凭据、任意 fault shell/Cypher/URL。引用完整性在此只作结构/摘要校验。
- 返回 detached、deep-frozen `structural-only / productionAuthorized=false` view；manifestHash 不含 executionAuthorizationRef，也不含后续 stage / post-run result 对象。

### 2.2 尚未交付，不得混淆

- W2 的真实 registry/ApprovalVerifier/TrustedClock、签名身份/职责分离/吊销/nonce、独立 predecessor acceptanceBundle 和 exact 防篡改 readback。
- W3-W7 的实际 Ask target、全链路 AEAD/脱敏、SideEffect gate、lease/traffic/fault adapter、恢复 journal 和 elapsed-time 留存判定。
- W8 的 opaque citation locator、当前主体重新授权、分区/TTL IndexedDB 与内部预览。
- W9 全量 build/集成/conformance、安全复审，以及 T16/T17/R18 的真实企业数据、provider、维护窗口和时间证据。

## 3. 已有引用/持久化的源代码观察

- 权威 served 身份来自 contextPacking.includedEvidenceIds；agent 有 servedEvidenceIds。这里只观察现有代码与测试，不宣称新 citation 链已完成。
- 当前 IndexedDB `RAGConversations` / dbVersion 1 保存 retrievalDetails、queryAnalysis、processingDetails；未观察到已完成的账号/scope 分区与 TTL。未进行浏览器交互验证。

## 4. 有界源码/测试快照

以下 hash 来自最新通过运行前后 readback；35 文件均无变化。共享工作树的其他修改属于用户/其他任务，未回滚。

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/dataset.test.mjs` | `c0404d6026445e19558169fa1bbc3921f6d5bec6f8e96ea5a01ed9434e0de017` |
| `src/lib/rag/eval/metrics.test.mjs` | `d27c6b43730a331617f53fab18262289e52779fe5b0f5487d8d74cd5b0dc8a56` |
| `src/lib/rag/eval/gate.test.mjs` | `032a20e0aa7dceb4d2a9bfb1151f2bad914cd274224874d7553be6d70008a303` |
| `src/lib/rag/eval/matrix.test.mjs` | `0b61bd928b8a71231530c0434c2454227c620dfae0e3baf8a92305605ddb7ab5` |
| `src/lib/rag/eval/production-policy-contract.test.mjs` | `32530b64b25295c7af298569fd8243f64278266db4a06214f3b6593cf78ceecf` |
| `src/lib/rag/core/context-composer-v2.test.mjs` | `45eb630eef152252541780c670150428d90194c234a69c85106cca2d5a6fd4c2` |
| `src/lib/rag/retrieval/legacy-evidence-adapter.test.mjs` | `94d8a4396490e41798a9def0ac31a70cf335223a93ae500a5721453486941e70` |
| `src/lib/knowledge-graph/contracts.test.mjs` | `46c68a53121ac554935b33919270ada1b909bc52907a604c60dc83a4f5fe58aa` |
| `src/lib/knowledge-graph/postgres-publication-store.test.mjs` | `2b0162dadbaf37a1cdac27dfbf6fbd64ad569aa3350a84cd317fd742c0cffabc` |
| `src/lib/knowledge-graph/graph-snapshot-recovery.test.mjs` | `dd678644bfd4a88635f29ea45f0b4de799ce840a3621f54b8bd01bcfdef162ee` |
| `src/app/api/ask/route.test.mjs` | `11f0b9763b2d17dae0edbdf648f3bafc433ff0770fa26e739984588da42a066f` |
| `src/lib/rag/eval/canonical-json.test.mjs` | `1acab0a5423bf1a551ad8209d5b74a4172cbcc75e12b6beab5cc2b9cc85f45f5` |
| `src/lib/rag/eval/production-gate-manifest.test.mjs` | `7a73f870d50871c5250889c8a249a0445d209450454e9a6c8fc28d324598fde3` |
| `src/lib/rag/eval/dataset.ts` | `8685d845931351d5b9049d5e0084b430ce399c1dcee9d51573ff06ac69bc3d7f` |
| `src/lib/rag/eval/metrics.ts` | `aef705e7579a28bf92fed42abe7257761f78361c7e5a059d14f649301c895941` |
| `src/lib/rag/eval/gate.ts` | `97c413a1e09b63da598c51f237d6d9765251ad73f2751dc5b8eb779bd3e5f104` |
| `src/lib/rag/eval/matrix.ts` | `558b9225c4a1caa76394c142cf3257ae4b7cd59bc3320d687939d8053e384fed` |
| `src/lib/rag/eval/production-policy-contract.ts` | `3b67c4fa49e24d09ae452e406a256c61d9f6e1164447201e800f04f1d2ce5354` |
| `src/lib/rag/core/context-composer.ts` | `40277156a094d143ea6e81bda43a1fdbfb7bb841721a55900b2c9af824ab6905` |
| `src/lib/rag/retrieval/legacy-evidence-adapter.ts` | `f063b8967a5f874b27f7a6509082db1cc7353e30b44a27d360e7b0fcbe5c9c55` |
| `src/lib/knowledge-graph/contracts.ts` | `3f1eb0921418dd7df360b4afdd8a2049e5f620dfcb8d27cfc053acbb2918e61c` |
| `src/lib/knowledge-graph/postgres-publication-store.ts` | `35e1aa3eae7b4c542cf9ef484577338609763bd35e2c40f5e0044e7518e833d5` |
| `src/lib/knowledge-graph/graph-snapshot-recovery.ts` | `a1a9a1ecac0d30af14e0017b6464a457c1e9ba175a0b24aa15d890cba13cce2c` |
| `src/app/api/ask/route.ts` | `648a322b3dbe4be849f489f1e7284566ea80bd0b5258461b6d2b9fb31455c825` |
| `src/app/api/ask/runtime.ts` | `72005cbeb49f7ad0cb5975f97b6b3963c5df0bc1c5f4eefeec8405c1cf024c3c` |
| `src/lib/indexeddb.ts` | `f3cfa5224ff1f1ecb3a10d28270b9368d7d910912e5da8b132c2829cfc8b8a37` |
| `src/components/ChatMessage.tsx` | `37eae20416b2f854dd0c6871cf60c7e250875224ae9ab03f9ab4b90e48362315` |
| `src/lib/security/retrieval-scope.ts` | `ca9e414f7bc3c6eec3f3686ece2c090457b8c4c40cc70b6fd58ddefdebb6e8a9` |
| `src/lib/rag/eval/canonical-json.ts` | `525f1b05c4c2ef7a368c488c3fd3fe775a5d30ac655dbb1ffa9890ce4f234345` |
| `src/lib/rag/eval/production-gate-manifest.ts` | `61f43459f3bbd35645b4ca77fd958ad846e5be48974f66b3b8795f6ad0794d33` |
| `src/app/api/ask/prepared-request.ts` | `9fe17cfc7aef014c8a606438c6820f2a40929729c84e6025ceb1f18efbcc3bf8` |
| `src/lib/rag/semantic-conversation-router.ts` | `0f3efbff55e71111f5b472722a440c0a227a7ffe4f4b7adc809f1a21dae1a568` |
| `src/lib/rag/conversation-router.ts` | `36dcdc57e1ee8faccd5b944db4db9dfa972e553d0189026d1fb7a4729b75cd04` |
| `src/lib/rag/local-calculator.ts` | `fadd3726dfea0ec9287f0c6f7786235e5526c3001a923f2d4ae89d3d3dcf68c4` |
| `src/lib/ollama-readiness.ts` | `fc3d39a40e0c959bf3280182cb6217ebc54f28a4695cf40c3cccb80d88855f82` |

## 5. 下一步

W0 基线/红测与 W1 结构合同已具备局部完成证据；继续 W2 的 provider-neutral trust、不可互换 execution/result/recovery envelope、无环三层 receipt 和 CAS/hash-chain journal。活动 Goal 仍未完成。

