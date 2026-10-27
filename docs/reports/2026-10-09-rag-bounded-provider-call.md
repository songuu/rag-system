# W2 统一 provider 调用边界与超时阶段证据

日期：2026-10-09。所属计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。这是本地 W2 局部实现及验证，不是企业 conformance、生产授权或 T16/T17/R18 完成凭据。

## 当前结论

新增一个共享 `bounded-provider-call`，替换 artifact conformance、journal conformance、authority conformance 与 authority approval 的四份调用包装。修复 journal/artifact 同步阻塞超预算假通过与 thenable getter 执行；修复 Promise 元数据及 descriptor 校验缺陷。approval 的四个 pending timeout 测试现在保持目标操作明确未决并验证具体 phase；独立测试继续覆盖真实同步耗时和已 settled 的 readback/final-clock 超预算。

最终 payload adoption 定向 9/9；共享调用器 17 项测试包含在十四组合同 358/358 与 25 文件累计回归 501/501 中，0 failed/cancelled/skipped。十四模块 strict TypeScript 与十个修改文件 `ESLint --max-warnings=0` 均退出 0，stdout/stderr 均为空。60 个有界源码/测试文件在累计运行前后 SHA-256 无漂移。十文件精确独立终审 APPROVE，另验五文件定向 188/188、strict TypeScript 与零警告 lint；无剩余 P0/P1/P2/Low。这只交付本切片，整个 W2 仍未完成。先前 349/349、492/492 属于 payload adoption 修复前候选，不与最终身份混用。

主 agent 按 Work 的 L4 单任务/TDD流程串行实施，并复用既有 reviewer 作只读独立复审。未修改生产配置、`.env`、测试并发或用户功能开关；未调用企业端点、切流、注入故障、删除、提交或推送。没有绑定或启动外部 Harness。原计划仍 2/13，18 项端到端 AC 未勾选。

## 调用语义与限制

| 结果 | 处理 |
|---|---|
| dispatch deadline 已到、provider 尚未调用 | timeout，`pendingCompletionUnknown=false`，不启动操作 |
| 支持的 native Promise 在预算内 fulfilled/rejected | 精确观察结局；错误对象不读取/泄漏 |
| 支持的 native Promise 已 settled，但 elapsed 达到或超过预算 | timeout，`pendingCompletionUnknown=false`；不声称副作用回滚 |
| timer 到期仍无已观察结局 | timeout，`pendingCompletionUnknown=true`；已接受 Promise 的晚到 fulfilled/rejected 继续被观察 |
| 非 Promise、thenable、Proxy carrier、非标准 native Promise 或 metadata 漂移 | contract-invalid，统一 `pendingCompletionUnknown=true`；不得作为合法负向拒绝 |

调用预算闭集为整数 1–60000 ms。timer 不能中断同步 JavaScript，因此还检查实际 dispatch/settlement elapsed。捕获原 receiver 的责任保留在各 consumer；共享调用器只调用既有捕获 closure，不重新读取 provider 方法。请求及 oracle 仍由各 consumer 独立 snapshot/freeze。

对支持的 Promise 使用捕获的 intrinsic `then`，不读取 own `then` getter。own constructor、自定义 Promise prototype/subclass，以及继承的 constructor / `Symbol.species` descriptor 漂移均 fail-closed。descriptor 采用固定六字段、own-property 比较，不依赖 provider 执行后可变的 Array 方法。反射/type/timer/freeze 引用捕获；intrinsic attach 的同步异常显式处理。共享函数无外层 async adoption，避免额外 Promise metadata 读取。

共享 observation 是安全外层 wrapper，但 consumer 的 async raw return 也会再次 adoption。四 consumer 现在在 return 前同步执行 descriptor-safe canonical JSON detach/freeze，拒绝 accessor/callable then，且不返回原 provider 对象；合法 void/undefined 保留。approval detach 失败按 phase 明确映射 clock-invalid、nonce-response-invalid、nonce-read-invalid，不落入泛化 invalid-request，也不把该失败当作业务拒绝。复制后的 JSON own then 不可能是 callable，避免在 timer 清除后挂起。

畸形 native carrier 无法在“不执行其 metadata hook”的同时保证安全 drain，因此报告 UNKNOWN，不冒充取消、静止或回滚。非法 carrier 也可能掩盖已启动的后台提交；对应测试证明了这一点。该 helper 不是同进程 JavaScript 沙箱，不能阻止任意 adapter 代码修改宿主、另启后台工作或退出进程；真实企业 harness 仍必须鉴权实验资源、隔离进程并独立签认。宿主 elapsed 不是企业可信时间证明。四 consumer 的生产能力/许可/验收标志继续为 false，完整 requirements 仍 incomplete。

artifact/journal/authority 的 negative probe 只允许正常 provider rejection；contract-invalid、timeout 不被当作安全拒绝，后续 probes not-run。approval 在 contract-invalid、未决操作或消费后的失败时 halt，不缓存决定、不盲目重试。

## 实际红绿链

1. journal/artifact 新增同步阻塞和 thenable getter 共四项负测：0/4，1670.6655 ms。两套件的同步 40 ms provider 在 10 ms 预算下仍给出 passed，两个 getter 各执行一次；这是实际实现缺陷，不是推断。
2. approval native Promise own then / constructor 元数据两项负测：0/2，102.2781 ms；constructor getter 实际执行一次。共享模块缺失时另有 runner 0/1，41.4086 ms。
3. 首次五文件组合 170/171，24295.3885 ms，0 cancelled/skipped。首次 stdout 截断，失败栈未完整保留；源码显示既有 thenable 的旧 `clock-operation-failed` 断言需要同步为明确 `provider-contract-invalid`。随后 phase/barrier 测试修订后组合 173/173，24312.3061 ms，stdout hash `c419dcf7736c9d71da8a5d15265c7d62c7abdf65f484afa56efad69eaa9c364a`。不把后续绿色当作历史超时全部根治的证明。
4. 独立 review 指出 inherited constructor/species 漂移：新增实际 RED 0/2，70.2062 ms。捕获原始 descriptor identities、移除外层 async adoption并保护 attach 后 GREEN 14/14，166.2132 ms。
5. 所有 invalid-return 统一 UNKNOWN，并补 concealed background work 与两类 negative contract-invalid characterization；组合 178/178，24449.4236 ms，stdout hash `d949757ee6cba06823149a8b6d2e96015d84e0eb2f02d711343a32ce59f1ec23`。后补测试不重标为先红后绿。
6. 独立 review 指出 descriptor 比较依赖 mutable Array method：新增实际 RED 0/1，69.8252 ms。固定六字段比较后最终定向 GREEN 16/16，169.4169 ms。
7. 第一次零警告 lint 正确退出 1：本轮 barrier 重构新增一条 unused wait，以及 journal 测试中三条既有 unused warnings。只移除 unused wait、复用 observationsHash 并明确过滤 digest，无 skip 或 budget 变更；最终九文件零警告检查通过。
8. 492/492 候选通过后，终审发现四 consumer 的 async raw return adoption；四 payload late then getter 实际 RED 0/4，157.8207 ms，各执行 getter 一次。detach-before-return 修复后，四 getter、四 nonsettling-callable 与 utility wrapper 共 9/9，148.3489 ms；callable 测试有独立 1000 ms Node test backstop，实际 operation budget 未改。authority-conformance 的测试文件因此纳入最终十文件范围。最新 strict14/lint10 零警告退出 0，空输出。

## 超时测试的 phase 判定

旧 pending timeout tests 使用真实 20 ms operation budget、80 ms sleep 和 100 ms 等待，且 failure helper 不断言 phase。前序已 settled 操作也可能 elapsed 超预算；仅凭“final clock timeout”测试名及 prior consumed 状态，不能断言实际失败点为 final-clock。

本轮四项 pending 测试保留 20 ms 预算，使用 test-only `performance.now` mock 将 elapsed 固定，以及明确 Promise barrier 保持目标操作 pending，分别断言 initial-clock / consume / readback / final-clock 与 nonce outcome。finally 释放并观察晚到操作，不声称取消。测试 mock 由 Node test context 恢复，不是生产配置或注入入口。真实同步 clock/consume 40 ms、共享调用器真实 elapsed，以及 exact-deadline fulfilled/rejected tests 独立保留；额外 deterministic characterization 区分 settled readback 和 settled final-clock 的 phase/UNKNOWN=false。

上一报告 465/466 的 pending false 失败，其原异常 phase 未保留，因此历史实际根因仍不能确定。当前可证明的是本轮修复了调用边界缺陷与测试 phase oracle 歧义；不能反向伪造上次失败现场。

## 最终有界回归

准确命令范围：Node 子进程 `--test --test-timeout=30000`；十四组合同为 canonical-json、manifest、run-journal、authorization、provider-trust、controlled-artifacts、receipts、authorized-journal、artifact/journal/authority conformance、authority-ports、authority-approval 与 bounded-provider-call。累计并入 W0 报告的原 11 文件基线，形成 25 文件并集。外层子进程 deadline 90000 ms，沿用已有测试子进程 `RAG_SEMANTIC_ROUTER=off`，没有持久环境更改。

| 范围 | 结果 / duration | UTC 起止 | stdout SHA-256 |
|---|---|---|---|
| 十四合同 | 349/349，24843.2097 ms | 11:17:57.478–11:18:22.356 | `278597431f1500b616cd73bd3f5a25fb1a38171d1796039779f9c61c64f94647` |
| 25 文件累计 | 492/492，25232.4457 ms | 11:18:22.358–11:18:47.628 | `f3ba994801d0aa4a56fe4de4b7793df31ba92e19e292df2ab242d046e9b88fed` |
| 最终十四合同 | 358/358，26806.9943 ms | 11:29:25.899–11:29:52.744 | `1180adb2d85a49e8aab5066ecc7e31060501a038770b17c24c010a55c8bfa4fc` |
| 最终 25 文件累计 | 501/501，27219.568 ms | 11:29:52.745–11:30:20.003 | `c671661b164097cca928316781575680b8f737d30bf95a2f68416485c79b8b4a` |

四次 stderr 为空，hash `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。有界 snapshot 是 W0 原 35 文件、十四模块源码/测试及 request-validation 的 60 文件并集；两轮各自 drift=[]。不是整个共享工作树或所有传递依赖冻结。直接定向 Node 输出存在既有 MODULE_TYPELESS_PACKAGE_JSON warning；没有为消除它修改 package.json。

## 十文件最终身份

| `src/lib/rag/eval/` 下文件 | SHA-256 |
|---|---|
| `bounded-provider-call.ts` | `a76984002e4467e34b3e5c022f1791fffab40c99149a05467b08cb243898a3cc` |
| `bounded-provider-call.test.mjs` | `4800a98f79a7abe1d5c5737ac486db09b65410a4ac194f2ad33e9c1a7429cfa2` |
| `production-artifact-conformance.ts` | `21631ddf8330e4381f5a807fae10cab70553376aeff183c1ac74c46957fe576e` |
| `production-artifact-conformance.test.mjs` | `500852baa32c48c325c893508a385b32d99908a7a1d0470e9478dfa742b7745a` |
| `production-journal-conformance.ts` | `af239ca29281bcbdc159c14f323431e0bf60f75de8bc38f86e1b4bb87477c169` |
| `production-journal-conformance.test.mjs` | `1ecfdf936869ba6d6d42bfbf8efd88ebd82fb9966131939582ca44d7be4e8cc1` |
| `production-authority-approval.ts` | `f1b5bfd55b7fe56a104d2d30d9aba27abc31a6955d2d2eca81d32df359447726` |
| `production-authority-approval.test.mjs` | `0ede3bb50d453e61baf134c65e7ea46c80a6e7c72b1cd3d4c3490cad5ba51a9f` |
| `production-authority-conformance.ts` | `5a071759b12acbb08c9b79de5347c4a61930ece0ae3f8e04c50a917644e36f9b` |
| `production-authority-conformance.test.mjs` | `2e3e30475a97c4801c3abf2beecf488128dd136018944872a9ac5cdf1f13f60a` |

上述更新只 supersede 对应当前代码身份，不改写历史报告及历史失败。旧审批/时钟组合或 conformance 报告的旧 hash 不继续充当最新代码身份。

## 未完成与下一步

此前一次 reviewer turn 被环境内容分类错误终止，其 P1 消息是有效输入，但该终止不是 APPROVE。重用同一 reviewer 只读核对当前十文件后，精确 SHA-256 全部匹配，独立定向 188/188、strict TypeScript 与零警告 lint 通过，最终结论 APPROVE，无剩余 P0/P1/P2/Low。包括 payload adoption 在内的所有已报告 P1 均已实际先红后绿；没有用环境中断或候选绿色替代最终复审。

W2 的共同 operation ports、其他 purpose、完整独立 behavioral harness、权威 approval/time/revocation/nonce/recovery 与 trust/registry 组合、authority-aware receipt、完整 manifest/trust/writer 组合仍未交付。下一步继续这些共同接口与组合，不反复重新定义 W2 或整个 Goal 的完成标准。W3-W9、真实 T16/T17 和 R18 仍开放；真实企业输入、IAM/provider/registry、冻结阈值和维护窗口/留存时间证据不能由用户的直接授权凭空生成。
