# W2 journal 不可变读回工作量

日期：2026-10-09。所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。

局部性能修复已完成实际 RED/GREEN，最终原预算 local16 408/408、cumulative27 551/551，strict16/lint11 退出 0；四文件精确独立终审 APPROVE。同一最终快照较早 journal 隔离超时仍保留，不宣称未知环境/历史失败根治。W2、W3-W9、T16/T17/R18 与 18 项 AC 均保持原范围，生产能力/验收标志仍 false。

## 诊断事实与推断

- 旧 journal/conformance/bounded 精确身份下，完整原 30000 ms 诊断在 UTC 14:00:29.297–14:00:59.368 终态退出 1，33 passed/1 cancelled、30016.6839 ms；原始 TAP 确认 `ok 33`，40.3457 ms。stdout SHA-256 `fb75222bd530a0a472f8cc9c6c81f4af75f6558a6b5ebf5294e784348e02d5cb`。
- 同一子进程采样 wall 8063.7764 ms、user/system CPU 6171/1531 ms；wall 20125.4975 ms、CPU 12812/4734 ms。之后无 25 秒采样或第 34 项 TAP。没有新输出本身不证明某个 test body 挂起。
- 只选第 34 项及后续 20 项，用 data URL preload 的同步 `beforeEach/afterEach` + `fs.writeSync(2)` 诊断边界；UTC 14:06:59.999–14:07:16.967，20/20、16883.3885 ms，stdout `8c40be8aa0028ec628fb5a710feb0f427f43c20c3353917ee7b6ea7dc717c0fa`。第 34 项 before/after 为 126.348/153.3009 ms；全部 hook 完成后，20 条 TAP 集中输出。最终 CPU 8906/3937 ms。两段观测工作量约 37 秒，支持累计 root 预算耗尽与输出缓冲的解释；不同执行的时长不能当作同一次精确全文件 trace，未证明所有外部环境或前序污染不存在。
- 独立只读检查：最近重型前序与第 33/34 项组合 4/4、5747.816 ms；两个早期 pending-timeout 与第 33/34 项组合 4/4、346.934 ms；静态未见跨 test 的 Promise prototype/species、timer/performance mock、共享锁或可达未收敛 cleanup。没有证实单 leaf 死锁。
- 单个原有绿色 full-suite 正例采用内存 Inspector CPU profile，UTC 14:08:29.808–14:08:32.426，1/1、2561.972 ms；profile duration 2466005 us、1529 samples。canonical-json 的 visit/encodeString/对象字段 visitor/canonicalJson/append self-time 分别 526808/376527/311690/230686/103218 us，约占 profile 63%；stdout `23d6a943f1ea070c8a26044a89a0f5d04c9a001c86f52cbc331c05c77cd2be5b`。这是本地采样证据，不是生产 SLA 或相较历史 27 秒增量来源证明。

所有诊断保持原 30 秒预算，未改变并发或 isolation，未写 profile 文件。preload/hook 只在诊断子进程内，不能当作未插桩整文件验收。诊断四文件前后 SHA 相同。

## 最小实现与 TDD

1. Reference journal 已在 admission 完成 canonical snapshot、闭集验证、整链验证与 deep-freeze。`readHead` 复用私有冻结点时对象；`readEntries` 每次返回新冻结外层数组、只共享已冻结的私有 entries。caller request 与 frozen caller input 仍重新验证，reject 不提交；CAS 区域仍无 await，reference 仍不提供持久或生产 authority。
2. 新隔离计数 test 在实际 encoder 入口只加计数，不按 host elapsed 判定。旧源 warm head + 两次 entries 读回实测 7 次编码，RED `7 !== 0`，236.8887 ms，UTC 14:12:34.046–14:12:34.631，stdout `fdfbfab425fbaaa5666f2bbc65d74ee92236bc45a21361505ddf8fc4020ca9ce`；私有复用后 GREEN 1/1、127.0267 ms，UTC 14:14:18.335–14:14:18.681，stdout `b1ef86a298a2b2111704828693959433e46cc9ab2bf6ac8e5466c7bcca0e2465`。
3. 同一计数 test 扩展到真实 conformance run，oracle 的空数组仍重复 detach：RED `4 !== 3`，2736.4706 ms，UTC 14:22:29.994–14:22:33.079，stdout `34e766e6d46ae6e5d1005c143c25f7eac8d904650f5047baddafcb2109902ac3`。只移除 assertState 对 invoke 已私有 detach/deep-freeze 值的第二次 snapshot，保留一次入站 detach、两项独立 canonical equality、全部 validateJournalChain、allSettled 收敛和 UNKNOWN 分类。显式保留 undefined => invalid-data。
4. 最终计数 GREEN 1/1、2327.8002 ms，UTC 14:24:59.630–14:25:02.228，stdout `6e5d49452e3847127bd192fb08560000b7d826ec488642d799d927a7ee36285e`；两项新增 undefined 合同与计数组合最终 3/3、2311.5756 ms，UTC 14:26:58.401–14:27:00.771，stdout `9201372223abf5ce8fccef6a0de2527ddd4a85f1cdc1c7fbda9213cd284e4018`。

计数测试同时验证旧 head/empty-array 快照不随追加/续 fence 变化、读回数组/entry/binding 不可修改、caller alias 不影响私有状态、frozen 坏 digest 仍被拒绝。loader 仅在实际 spawnSync eval 子进程为 encoder 加计数，未改 canonical-json 产品源码。

## 第一候选完整回归：未通过，不抹除

只复用 reference readbacks 的候选 f638/e59f（尚未修消费者重复复制）：

| 范围 | UTC | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| journal 全文件 | 14:16:28.781–14:16:58.899 | 33 passed/1 cancelled，30017.1935 ms | `5d3acab181f3374d4ed97df4758db43b7f6856e80d7484b16e407f3633c8e039` |
| canonical + reference journal | 14:16:58.901–14:16:59.467 | 26/26，495.8707 ms | `3598f11ac16ef735adf4146d2c9227afa87c91243c3b229059dd5f5fc4131512` |
| local16 | 14:17:24.699–14:17:56.743 | 377 passed/1 cancelled，31972.0674 ms | `df6046b4d263be0c8fff3c9d1dfb58041707528daf2ff9684294c8fda652c2b6` |
| cumulative27 | 14:17:56.744–14:18:29.978 | 489 passed/1 failed/2 cancelled，33118.4016 ms | `ec51988296f35ec4ae7e9bc0e7d82142206971095dd0b6db0a69771bedd5c017` |

strict16（14:16:59.467–14:17:04.764）与 lint9（14:17:04.765–14:17:24.699）退出 0。累计未通过包含 Ask/journal 文件 timeout；另有既有 nonce concurrent test 提前在 nonce-consume-readback 失败而未到期望的 nonce-concurrent-replay，准确 phase/根因未知，未修改该测试、实现或 deadline。与历史 Ask 500/200 和其他未知失败一起保留。

第一候选 snapshot 实为 **64 文件**，drift=[]：诊断 script 扩展 changed 列表后，旧 `changed[4]` 不再指向 shared fixture，漏了 fixture snapshot。不能冒称 65，也不证明漏文件或全树稳定。最终 script 已改为明确 fixture path，恢复 65 文件范围。独立第一候选短测 62/62、strict/lint 0，但不替代未通过整轮。

## 最终精确身份与边界

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-run-journal.ts` | `f638b65801bd3ed8bc2e7950022defb1020e702c6e5809005dc2eda3a747cfcd` |
| `src/lib/rag/eval/production-run-journal.test.mjs` | `556ac19d3aeda7b9d5c8536b7284af6d6087274071bcd1909d75653cefb5954f` |
| `src/lib/rag/eval/production-journal-conformance.ts` | `0cc21a6e108082b69b860ff15730128334ae7ba141fbb1e7c48066fa2b7b857d` |
| `src/lib/rag/eval/production-journal-conformance.test.mjs` | `d6dc4277e8a276e7651624f897e344c1cc523238154a9c996c7231755c73d066` |

## 最终原预算完整回归

没有 preload、skip、并发/timeout/isolation 调整，沿用既有仅测试子进程的 `RAG_SEMANTIC_ROUTER=off`。外层每命令 90000 ms/16 MiB，均正常终态，不以观察超时终止/重启。

| 范围 | UTC | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| counter + 两项 undefined | 14:26:58.401–14:27:00.771 | 3/3，2311.5756 ms | `9201372223abf5ce8fccef6a0de2527ddd4a85f1cdc1c7fbda9213cd284e4018` |
| journal 整文件隔离 | 14:27:00.773–14:27:30.854 | **exit 1**：35 passed/1 cancelled，30019.4953 ms | `c62bb8ffb8b9907b366a95567a41c036dd58d28e9457807c50a060812d90a7cb` |
| local16 | 14:27:36.650–14:28:01.243 | 408/408，24525.8321 ms | `73739ffaa3c4ab5db5843ec647a24847a77cddf18d2e20222b1d9d6a14677fbc` |
| cumulative27 | 14:28:01.244–14:28:26.367 | 551/551，25069.1586 ms | `d40033648757f9be75584b0b2238a1c8292f63071469d88892b0de7287ccca70` |

strict16（14:27:30.855–14:27:33.295）和 lint11（14:27:33.295–14:27:36.650）退出 0、双流为空；所有 stderr 为空，空流 SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。65 文件有界 snapshot 前后 drift=[]，shared fixture 显式包含，前七个 writer/authority 相关文件身份未变；不等于整个工作树/node_modules/宿主冻结。

完整 journal 在 local16/cumulative27 中实际执行并计入全绿；较早隔离超时也真实存在。不能把不同执行的结果合并成“从未失败”，也不能把后续绿色视为 host/Ask durable replay/nonce 短预算未知 phase 根治；性能优化的因果贡献没有独立对照证明。此处只解除当前快照完整本地回归无法通过的门禁状态，完整 W2 与生产验收仍未达到。

独立终审对上述四文件精确身份 APPROVE，未发现 P0/P1/P2；独立 counter/undefined 3/3、canonical/run-journal/receipts 62/62、strict16、四文件零警告 lint 均通过，SHA 逐项一致。确认 admission 深冻结/旧快照、caller frozen input 无旁路、唯一入站 detach 在 async adoption 前、undefined 分类与完整链/allSettled 未削弱、计数 loader 只在 child。未运行主完整 journal/Ask/27，不替代主证据；审查也明确保留同快照较早 timeout 未根治。

不放宽 test/prod timeout、hard gate、body/chain/authority 验证，不提供缓存的企业信任或生产许可。不改 Ask、nonce、`.env`/用户开关、不做 commit/push、生产连接、fault、删除或学习写入。

Goal 与 Sprint 保持 ACTIVE/WORK；任务 2/13 完成，全部未完成范围和外部前置继续保留。
