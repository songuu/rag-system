# W2 receipt 封存写入调用边界

日期：2026-10-09。所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。

结论：本地 writer 调用边界已实现并通过精确独立审查；扩大回归仍未通过。不代表完整 W2、任何生产授权或 T16/T17/R18 完成。

## 实现与边界

只修改既有 `production-receipts.ts` 与其测试，复用 `boundedProviderCall`，不复制调用器。`sealReferenceReceiptCore` 增加可选第四参数 `operationTimeoutMs`，默认 30000、范围 1–60000；现有三参数调用与输入 schema 保持兼容，非法预算在任何 provider dispatch 前拒绝。

encrypt、store-seal、store-read、decrypt 四阶段均捕获既有方法/receiver 后有界执行。仅接受规范 native Promise；thenable/畸形 Promise metadata 为完成 UNKNOWN，不执行自定义钩子。fulfilled payload 在 async return 前 descriptor-safe detach，拒绝 Proxy/accessor/自定义 prototype，明文必须为 primitive string。逐阶段 AAD、physical ref/digest、stored object、独立 source/reader proof 和 plaintext 语义校验均在相应 detach 边界内，任一失败停止当前 pipeline 的所有后续阶段。

新增冻结 `ReferenceReceiptSealError`，只含固定 code、operation、`pendingCompletionUnknown`、累计 `mutationMayHaveOccurred`、`automaticRetryAllowed=false`；不暴露 provider cause/data。mutation 字段记录当前尝试曾 dispatch encrypt/store-seal，而非只看失败操作；未 dispatch 的 deadline 失败为 false，已提交后错误 metadata/readback 为 true。decrypt 的 plaintext-readback 上下文为固定静态文本，不转发 exception。

时间预算只约束 callback dispatch/settlement，不是完整 workflow SLA、同进程沙箱、取消或回滚。UNKNOWN 不假装后台写入消失，测试明确等待晚到真实完成并核对无后续操作；stateless helper 不提供跨调用/实例 halt 或自动 resume，调用方不能据失败自行重试。它仍不验证执行签名、实时 authority/撤销、clock/nonce、provider registry 或冻结 recovery/predecessor；`productionAccepted=false` 保持。authority-aware sealing composer 是下一工作，不用本地声明或过去的 reader 验收为 writer 授权。

## 真实 TDD 与审查修复

1. 新七项 RED：1 passed/6 failed，203.0447 ms，UTC 13:01:52.106–13:01:52.343；stdout `15fcc26950a8b4eb2217be02e34b4239f48ecfc1a696dbf5836da6e554476cf0`。旧路径接受超预算完成/thenable、忽略第四参数，payload async adoption 和 native metadata 错误也未携带新合同。
2. 首实现 6/7，301.3644 ms，stdout `37ec8e4a593b6f2607a73ba2d658b9403e3799ae5f9c6d695be88c55add9b8f6`。剩余失败为 fixture 先读 sample 到 03 秒又以 02 秒 executor 复用同一单调端口；改为独立 samplePorts，不放宽实际端口合同，也不将 fixture 错误伪称实现漏洞。
3. 加入 dispatch starvation characterization 后，8/8，406.3317 ms；五文件候选组合 120/120，1837.1751 ms；strict16/lint7 退出 0，65 文件无漂移。这些是语义 P1 修复前候选，不能覆盖最终快照。
4. 独立 reviewer 指出已提交后语义不匹配仍抛普通 Error 的 P1。负测先实际 store seal，再独立 exact read 确认对象已提交，随后返回同结构坏 sha；RED 0/1，125.4724 ms，stdout `9090c06d6bc8b404e660650ec10aef86ac708ec97f2e3fa2be66fd34776400da`。将五类语义检查全部移入对应 detach 闭包，AAD/ref/object/proof/plaintext 五 case GREEN 1/1，158.6885 ms，stdout `dfbee6587401ad4653a48a78b7015a367130e46f7317a77d651053a15e2e697b`。不自动覆盖、删除、回滚或重试已经提交的对象。

Pending-phase 测试只用 test-context `performance.now` 固定 dispatch/settled phase，保留实际 20 ms timer；真实 elapsed/starvation 测试继续由原有 utility suite 执行，不放大超时或将 mocking 当真实 clock。

## 最终原预算验证

Node `--test --test-timeout=30000`，外层 90000 ms/16 MiB，沿用现有测试子进程 `RAG_SEMANTIC_ROUTER=off`；无持久环境变化、test skip 或并发调整。十六合同为上一 authority-receipts 切片的相同模块集合，27 文件加原 W0 十一文件。

| 范围 | 实际结果 / duration | UTC 起止 | stdout SHA-256 |
|---|---|---|---|
| 新 writer 定向 | 9/9，397.4642 ms | 13:30:32.931–13:30:33.380 | `83d2929074d5466ef98e1f1580f57784368826b29a24818bbd6f88cf890fe04a` |
| receipts/bounded/authority-receipts/registry/authorized-journal | 121/121，2043.2733 ms | 13:30:33.382–13:30:35.485 | `d786cf830ebb70d0137a43e79abff31964df2aeac4400dc9cbc1542302c5a115` |
| 十六合同 | exit 1：385 passed / 1 cancelled，30750.3635 ms | 13:30:55.579–13:31:26.392 | `5d113290305e4adf002c6b2238709924a99c1e0f270ab114a53093cab9cfb04d` |
| 27 文件累计 | exit 1：453 passed / 2 cancelled，32037.9531 ms | 13:31:26.393–13:31:58.496 | `35bb200dda8aded35ab73b3449cc43374b3883ef076c48142050f73dc7705566` |
| journal 全文件隔离诊断 | exit 1：33 passed / 1 cancelled，30015.5924 ms | 13:36:04.330–13:36:34.392 | `0bd46eaba89752ad6e200faaf768fcb78eb445416429ba84fbe3a39b2dd08387` |
| pending readback leaf 诊断 | 1/1，158.5271 ms | 13:42:37.513–13:42:37.721 | `b8050d45d143f5caab639a5d0a1be41ec320ed313a5b4708b9a4ae02c9272845` |
| rejected concurrent append leaf 诊断 | 1/1，208.5482 ms | 13:45:57.349–13:45:57.607 | `42d410847446e1322f2f48a3d2aa479116c51c256b7310f1d4607b1d515381e3` |

最终 strict16（13:30:35.486–13:30:38.724）和七文件 `ESLint --max-warnings=0`（13:30:38.724–13:30:55.578）退出 0、双流为空。正常测试 stderr 均为空；空流 SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

完整回归失败为原有 `production-journal-conformance.test.mjs` 的 30000 ms 文件 timeout；累计还含 Ask 文件相同 timeout。journal 隔离最后输出名称为 `one rejected concurrent append cannot hide another pending mutation`；只保存 name 不足以确定该用例是已完成还是开始后挂起。两个 leaf 的绿色不证明整个文件完成、前序污染或环境根因。Node v22.22.0，NODE_OPTIONS 缺省，未设 isolation=none。journal 没有直接导入 receipt writer，但不据此证明无间接关联；真正根因仍未知，停止无依据整轮重试并保留只读诊断工作。之前 authority-receipts 切片中的 Ask 500/200 不符及超时记录也不抹除。

65 文件有界 source/test snapshot 前后 drift=[]，不等于整个共享树或 node_modules 冻结。

| 最终文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-receipts.ts` | `e6d5058e5e5ec816c7416d3e0071007475418a790b118dec7f7ff7cc5664bef7` |
| `src/lib/rag/eval/production-receipts.test.mjs` | `0215c37647f7a365e9d36ee406b996e51cd0dc32d1c2fc9e1ff9ee713446d5ee` |

独立终审对此精确快照 APPROVE：36/36 receipt 测试、strict16、两文件零警告 lint；未改文件、未运行 Ask/全量。审批只证明局部 writer 的调用/载荷/错误边界，不覆盖未通过整体回归或生产权限。

## 剩余与完整目标

后续同日追加：journal 不可变读回/消费者重复复制经实际 RED/GREEN 修复后，原预算 local16 408/408、cumulative27 551/551、strict16/lint11 退出 0，65 文件无漂移。此前本报告全部失败记录保留；同一后续最终快照较早隔离 journal 仍超时，不宣称环境/历史 Ask/nonce 根治。精确快照与完整证据见 `docs/reports/2026-10-09-rag-journal-readback-work.md`，不能用后续绿色覆盖本报告较早 source 组合的未通过状态。

先定位 journal/Ask 整轮未通过项；继续 W2 authority-aware sealing、其余共同 ports、完整独立 behavioral suite、manifest/trust/writer、recovery/predecessor 与长跑证明链。W2 整项及 W3-W9、T16/T17/R18 均保持 open，18 项 AC 不标记完成；不减少依赖、生产外部输入、真实留存周期或验收范围。

本轮无生产连接、fault、删除、`.env`/用户开关改动、commit/push 或学习写入。Goal 保持 ACTIVE；未将观察超时当作进程终态或重新启动同一仍存活句柄。
