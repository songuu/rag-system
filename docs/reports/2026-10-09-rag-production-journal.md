# W2 Production Run Journal 局部验证

- 时间：2026-10-09；属于当前 `work/active` Sprint 的 W2 切片；W2 整项仍 open。
- 实现范围：`production-run-journal.ts` / `.test.mjs`；没有真实生产存储、审批或恢复 mutation。

## 已验证

- 新测试先因缺模块失败；首版 9/9 通过。
- 独立审查发现 terminal head 可错误声称更大 fencing generation；新增红测 11 pass / 1 fail，修复后 12/12。
- 最终 strict TypeScript / ESLint 检查链退出 0；独立复审 APPROVE，无剩余 P0/P1。
- 合并本地回归：# tests 184；# pass 184；# fail 0；# skipped 0；# duration_ms 7267.1891。
- 时间窗口：2026-10-09T03:08:57.939Z → 2026-10-09T03:09:05.247Z。
- 37 文件运行前后无漂移；原 35 文件与 W0 快照一致。仅测试子进程使用已有 `RAG_SEMANTIC_ROUTER=off`，不代表语义模型/生产质量验证。
- 完整 stdout 摘要：`ea20b8c3b6dbf8b007ade51dcdbd81879a91d7d794aaefdc1befaeebb5f299f2`（本地输出身份，不是防篡改生产制品证明）。

## 合同

- `kg-gate-run-journal/v1` 的 entry/head：run/scope/manifest binding、严格 seq/prevDigest、actor/authorization digest、闭集 action/parameters digest、before/after、canonical trustedTime。
- intent/result 按 idempotencyKey、intentDigest、action、parameters 和 before readback 配对；重复、未配对、hash 修改、删尾、重排、fork、旧 fence 或跨 scope 均拒绝。
- terminal 前必须处理全部 intent，之后不允许追加；terminal head 精确匹配最后 entry 的 generation。open head 可反映尚未追加事件的 fence advance。
- 单 entry 使用既有 canonical profile；chain 独立有界为 10000 entries / 16 MiB，不以一个 256 KiB 对象限制误拒整个链。350 条大链回归已验证。
- Reference CAS 在单进程无 await 临界区完成；并发竞争只有一方追加成功，精确重试只返回 existing acknowledgement，旧 token 连重试确认也拒绝。
- snapshot/readback 深冻结并分离；Proxy、array getter、hole 和额外属性在遍历前拒绝；错误只有固定 schema 路径/原因。

## 不代表

- `RunJournalStorePort` 是 provider-neutral 接口；reference 实现固定 `local-reference / productionCapable=false`，不具分布式持久化和生产能力。
- 结构 verifier 的 `productionAccepted=false` 是固定结果。传入一个 head、digest、authorizationDigest 或 trustedTime，不等于已验证权威来源。
- 真实 registry/adapter conformance、身份签名/角色/吊销/nonce、TrustedClock、独立 exact head proof、writer authorization、receiptCore/resultAttestation/acceptanceBundle 均仍是未完成 W2。
- journal entry 只保存机密级伪名/摘要；不含 query/gold/响应、任意命令/URL。真实 journal 传输/存储保护、AEAD 制品索引和企业 adapter 仍待共同 trust 基础。

## 本切片文件摘要

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-run-journal.ts` | `664ef32e124a2e1ad77ee1a1a0b57f120783312197cbdb41f0d1f975707571f8` |
| `src/lib/rag/eval/production-run-journal.test.mjs` | `ac82e864fdf9a0d54685378a468b944dc0ba76eeab63706fab8645f0b4075f07` |

## 下一步

继续 W2：定义全部 provider-neutral ports 与部署侧 trust/conformance 边界；实现不可互换 execution/result/recovery envelope、无环 receipt 三层结构、独立 exact readback 与受控制品保护。暂不推进 W3/W6 或 T16/T17/R18。

