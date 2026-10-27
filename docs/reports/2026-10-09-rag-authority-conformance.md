# Clock / authorization-nonce 独立行为探针证据

日期：2026-10-09。任务：W2 局部交付；不改变 13 项原任务和 18 项端到端 AC 的范围，不作为生产许可。

## 结论与边界

新增 `production-authority-conformance.ts` 与对应测试：对 provider-neutral clock、authorization-nonce store 和独立实验室 clock control 执行 17 组实际行为探针。输出是机密级、可规范化 hash 的 observations core；`productionAccepted=false`、`requirementVerdict=incomplete` 始终成立。clock/nonce 完整 requirements 仍全部列为未完成；不把局部行为通过重标为企业 provider conformance。

最终代码快照通过定向 34/34、四组组合 115/115、十三组本地合同 323/323、24 文件累计回归 466/466。十三模块 strict TypeScript 与新增两文件零警告 ESLint 通过；独立终审 APPROVE，未发现剩余 P0/P1/P2。首轮累计回归 465/466 的既有超时测试失败必须保留；最终绿色不证明其根因已修复，也不证明全项目稳定性。

没有执行企业端点请求、修改 `.env` 或生产配置、切流、故障注入、删除、提交或推送。实验室 actor、source 与 profile 标签不是身份认证；真实 IAM、可信时间、在线撤销、持久/跨实例 nonce authority 与完整企业签认未证明。外部 harness 仍须独立授权实验资源、隔离进程并签认自身证据。

## 实际探针范围

| 探针 | 验证内容 |
|---|---|
| clock-identity | 精确 source、profile、run、reader、challenge、时间与误差读回 |
| clock-context | 错误 scope/profile/actor 拒绝；拒绝后相同合法 challenge 仍可用 |
| clock-challenge | challenge 跨主体/run 重放拒绝 |
| clock-concurrent-challenge | 并发同 challenge 恰好一成功；观察所有 promise 的结局 |
| clock-monotonic | 单调 sequence/time、合法推进与回退拒绝 |
| clock-unavailable | 实际不可用拒绝；恢复后正向控制 |
| nonce-consume-readback | 独立构造 expected claim，精确比较引用并独立完整读回 |
| nonce-context | 全 binding/profile/reader 拒绝及同 nonce/clock 的合法正向控制 |
| nonce-replay-identity | issuer+nonce 墓碑不随 kind/run/manifest/auth identity 改变 |
| nonce-issuer-namespace | 不同 issuer 的同 nonce 互不误伤 |
| nonce-concurrent-replay | 同 nonce/不同 clock 竞态恰好一 consumed；loser clock 可用性与两种 sequence 顺序 |
| nonce-concurrent-clock | 不同 nonce/同 clock 竞态恰好一 consumed；拒绝不得暗中毒化 loser nonce |
| nonce-clock-validity | source/proof binding/profile/reader/challenge/误差/全半开有效期拒绝及正向控制 |
| nonce-clock-progress | 旧 challenge、sequence、时间不能消费新 nonce；新合法 clock 可重试 |
| nonce-exact-readback | 完整 claim/ref/proof/context/profile/reader 精确读回，拒绝不破坏已有 claim |
| nonce-expired-tombstone | 时间推进后历史 nonce 墓碑不可驱逐，fresh clock/new nonce 仍可用 |
| nonce-capacity | 声明容量耗尽 fail-closed；相同请求重复拒绝，不偷消费 clock/nonce，不泄漏旧引用，旧 claims 仍可读 |

闭集配置/descriptor 捕获拒绝 Proxy、getter、未知字段与非 native promise；原 receiver 保留。请求及独立预期脱离输入并冻结，challenge 使用随机根及计数派生。调用使用实际 elapsed deadline 检查与 timer：同步阻塞超预算即使已 fulfilled 也失败，不能伪称可中断同步 provider；未决超时保存 `pendingCompletionUnknown=true`，晚到结局被观察，不声称取消或回滚已生效。首个失败后后续 probe 为 not-run，不继续危险实验。

## 红绿证据与修复

- 缺少新模块时 runner 0/1，86.8011 ms；首次实现的非法 await 默认参数语法错误 0/1，86.6304 ms，改为函数体内 await 后 15/15。
- 扩展组合 105/106，866.4253 ms：恶意并发 fixture 在 await 后才记录使用的 challenge，没有实际制造预期 loser nonce 污染。修复 fixture 在 await 前记录 pending challenge；不是 provider 实现缺陷。
- 独立 mutant 证明容量隐藏消费、fresh replay 偷耗 clock、proof scope 三字段归一化、未知 consumer 归一化四类假通过：实际 RED 0/4，329.0589 ms；加强独立 oracle 和拒绝后正向控制后组合 GREEN 111/111，1004.1626 ms。更早 0/2 的试验 mutant 阶段不准确，不能替代该实际 RED。
- 并发专用 loser clock 偷耗 mutant 实际 RED 0/1，163.9356 ms；加入两种获胜 sequence 顺序及真实较高 sequence 获胜正向测试后通过。合法旧 sequence 因已过时被拒绝时，再以 fresh clock 重试同 nonce，避免误把正常单调约束判为污染。
- wrong-profile readback 归一化测试属于先修复后 characterization，不宣称实际先红后绿。
- 候选组合 115/115，1222.4038 ms。终审发现一条 unused variable LOW warning；复用已解构 `observationsHash` 并删除重复表达式后，最终组合 115/115，1156.3583 ms。此前 lint 仅退出 0 且只打印 stderr 的检查不足以支持“无诊断”；最终明确捕获 stdout/stderr，并执行 `--max-warnings=0`，输出均为空。
- 最终独立审查精确绑定下方两文件 SHA-256，34/34，strict TypeScript 与零警告 ESLint 通过，结论 APPROVE。

## 最终代码身份

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-authority-conformance.ts` | `4c3131765aa9f99cd5498feec5d02bbc10ca5d6019480d4436713f2b6acb027b` |
| `src/lib/rag/eval/production-authority-conformance.test.mjs` | `f94dd6179b1a8a16d9229b367db4a804bce39802e64c811792beeaacc201218e` |

此前候选测试摘要 `db1a5c95ee4db243d8c9349825ceb81fbb914fd2ff13ffb5fca771818d676313` 对应 unused variable 清理前测试，不与最终身份混用。十三合同包括 canonical JSON、manifest、journal、authorization、provider trust、controlled artifacts、receipts、authorized journal、artifact conformance、journal conformance、authority ports、authority approval 与本模块。

## 累计回归及失败保留

累计范围是原 143 项基线与十三组本地合同 323 项的 24 文件并集。测试子进程沿用已有 `RAG_SEMANTIC_ROUTER=off`，不是修改用户配置。两轮各自 58 文件运行前后摘要均无漂移；本轮只编辑新增两文件，不修改既有 approval/Ask/runtime。

| 轮次 | 范围 | 结果 / duration | UTC 起止 | stdout SHA-256 |
|---|---|---|---|---|
| 候选 | 本地合同 | 323/323，25083.1066 ms | 10:34:27.905–10:34:53.025 | `1f55d75d27de1c19820bc98cc5a5124c56441ea1f6ef91a16315002ecb0d9555` |
| 候选 | 累计 | 465/466，1 failed，25163.1169 ms | 10:34:53.026–10:35:18.225 | `cebd5dce0b34b94b8a349603cb9b6ea6ed8fc49470ddb1c7e4e05e1f651c8994` |
| 最终 | 本地合同 | 323/323，24838.0143 ms | 10:38:58.220–10:39:23.102 | `e02559de13a6658d6fd9188aa61df861c3d8b01ee9fa2b2d9eba63dd938f8fa0` |
| 最终 | 累计 | 466/466，25151.6229 ms | 10:39:23.103–10:39:48.291 | `e893c628a37458457bd4df9cef771315c72d3afba791988c1d5876b8dc6b2faf` |

四次 cancelled/skipped 均为 0。候选累计失败是既有 `production-authority-approval.test.mjs:358` 的 `final clock timeout preserves reported consumption and never issues a cached decision`：测试 duration 34.2654 ms；helper 第 81 行校验 `pendingCompletionUnknown` 时实际 false、预期 true；之前 `nonceOutcome=reported-consumed` 校验通过。原异常 phase 被 assertion predicate 覆盖，未保留，不能仅凭测试名断言实际失败阶段为 final-clock。高负载导致前序已 settled readback 的 elapsed 超时是一种待验证推断，未确定根因；本轮没有提高预算、改变并发或跳过测试以消除失败。

历史报告中的 Ask EPERM、59 项失败、10 cancelled 与 2 秒启动观察超时继续保留。最新绿色、隔离通过及本地 conformance 不作为这些既有问题已根治的证据。

## 未完成及下一步

W2 整项仍 open，Sprint 2/13，18 项端到端 AC 仍未勾选。下一步先核对统一 conformance bounded-IO/未知完成边界以及既有 approval timeout 测试的阶段判定，再完成共同 operation ports、其他 purpose、完整独立 behavioral harness、权威 approval/time/revocation/nonce/recovery 与 trust/registry 组合、authority-aware receipt 和完整 manifest/trust/writer 组合。W3-W9、真实 T16/T17 与 R18 均未完成；真实 roster/gold、冻结阈值/arms、企业 provider/IAM/registry、维护窗口及完整留存时间证据仍为外部前置。

收尾首次文档校验在自动审批 review deadline 超时。恢复后只读确认该报告没有落盘，故重新通过 apply_patch 创建；代码身份保持上述最终 hash。该环境超时不代表实现被判不安全，也不改变生产门禁。
