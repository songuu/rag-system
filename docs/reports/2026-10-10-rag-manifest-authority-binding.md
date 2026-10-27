# W2 完整 manifest 与 authority receipt 的本地绑定

日期：2026-10-10。计划：`docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`。

本轮绑定切片已实现：新定向 10/10、local18 437/437、strict16/lint8 退出 0，两项独立审查 APPROVE。累计首轮 579/580，既有 Ask replacement POST 出现 503/200；隔离 leaf 1/1、完整 Ask 75/75、原样累计复跑 580/580。该单次失败根因未知，不因后续绿色而称为已修复。两次回归均有 69 文件前后 drift=[]。整体 WORK/ACTIVE 仍 2/13，W2 未完成，生产和完整阶段验收标志全部 false。

## 实际实现

- 在既有 manifest 模块新增 `validateManifestExecutionBinding`，接收 raw 完整 manifest、独立冻结的 expected execution payload、精确 execution ref；不从签名 envelope 自行生成 expectation，不接受 caller 的“已授权 view”。复用闭合 payload schema 只作形状检查，不把 dummy signature 当验签。
- 选择现有 T16/T17/R18 非循环视图；比对 scope/run/manifest digest、registry/provider digest、threshold digest 与 object ID/version/SHA。T17 还比对签名窗口及 approver/executor/read-only/recovery authority 与已冻结政策。
- 新版本化 `kg-stage-thresholds/v1` 投影只包含 stage、不可放宽 hard gates、质量、sampling、side effects、ramp abort、R18 retention policy；其余策略仍由完整 stage manifestHash 绑定。九项 core identities 从完整 manifest 派生并深冻结，不再接受手填副本。
- 新 `createReferenceManifestAuthorityReceiptWriter` / `createReferenceManifestAuthorityReceiptVerifier` 包装已有实际签名/clock/registry/nonce/journal/AEAD reference 组合。原低层工厂保留为局部组件；新配置不允许 caller `expectedCoreIdentities` 或多余 authority 标签。
- writer 在 crypto/store 调用前检查 core 与派生 identities、stage/scope/run/execution ref、精确 predecessor bundle ref 的对应；R18 比对原冻结 retention/store hash 与 elapsedEvidenceRef。reader 在任何 provider IO 或结果 nonce 消费前作同样检查。错绑定真实密文和有效签名不能绕过这个入口。
- 全部输入先 canonical detach/freeze，不执行 getter/Proxy；跨 await 的 manifest 别名不能改变期望。新错误只报告固定 configuration/seal-preflight/verify-preflight，不泄露 provider 内容，也不声称 nonce 未消费：seal 预检可能在 begin 已消费 execution nonce 后发生。底层操作错误仍原样保留其 UNKNOWN/nonce/mutation 语义。

这只是 manifest 对应关系与本地 reference authority 组合，不证明独立企业 manifest authority、前驱 bundle 的完整验收、真实 elapsed retention、恢复授权或周期续期。predecessor/elapsed 引用不是相应验收证明；有 recovery refs 仍 fail-closed。machinePassed 仍是既有 receipt observation，不代表 W4 机器 gate 已计算。未连接企业服务、改持久开关、注入 fault、执行 cleanup、提交/推送或写学习记录。

## TDD、提取与失败保留

1. 为复用完整 stage manifest 和实际 receipt crypto/approval fixture，机械提取原 manifest/writer fixture，原 assertions 不变；原两文件 36/36 通过。shared provider fixture 仅增加可选 manifestHash，默认保持既有行为。新 fixture 为两种签名使用独立本地 Ed25519 keys，并真实封存/读回。
2. 新 10 项在缺少实际导出入口时全部 RED；明确入口 `undefined !== function`，非缺文件或整文件未加载。实施后 10/10 GREEN。覆盖三个阶段、实际执行/结果 nonce 和 replay、错误 scope/run/provider/ref/threshold、T17 窗口角色、派生身份、前驱/R18 引用、真实签名密文错绑定 PoC、fake view/getter/Proxy、T16 deferred 字段与 await 别名。
3. 首 strict16 退出 0；lint8 真实退出 1，发现提取时多带一个未使用 `arm` 导入。删除该导入，未放宽 lint。
4. 主验证编排首次 ENOENT/exit1：误把 request-validation 写为 `src/app/api/ask/request-validation.ts`；发生在 snapshot 阶段，测试尚未启动。用 `rg --files` 核实并改为 `src/lib/security/request-validation.ts`，没有改产品代码或缩范围。
5. 累计首轮唯一失败：`src/app/api/ask/route.test.mjs:2118`，`PATCH delete is admin-only, revision-fenced, and purges terminal state` 最后的 replacement POST status `503 !== 200`；并非 deletedResponse 的断言。同一源码/预算隔离 leaf、完整 Ask 及累计复跑未复现。没有改变原断言、超时、并发或 isolation；原因仍未知。历史 Ask 500/200、EPERM、journal/Ask timeout 等保留原报告，不能合并为本次已修复根因。

## 精确受检快照

| 改动代码文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-gate-manifest.ts` | `294114d0a9fc7c9d20104e0c3977be7966d7bd85f907daa5dbb905cdace69623` |
| `src/lib/rag/eval/production-authority-receipts.ts` | `c5ab743c7e5a1895c078fb52699a8cd10588ae59abbc98ce986ea2a76fbcbf43` |
| `src/lib/rag/eval/production-gate-manifest.test.mjs` | `5def3b864188fb5721e610832c0cbb561cfd45422f57df0dcfff42027dbcd483` |
| `src/lib/rag/eval/production-authority-receipt-writer.test.mjs` | `59ed578c5b570ffa0c9b007182a9811ffd948045059523095cdf94b86f5dd2f0` |
| `src/lib/rag/eval/production-provider-fixtures.test-support.mjs` | `c593f147f6c4bccffc77f8c4cc6063ea536edc37f42f63711e51f3cc1aa7236d` |
| `src/lib/rag/eval/production-manifest-fixtures.test-support.mjs` | `77b9e75da9dc20f0063b4041ebc90306f8b632acec2cdc8b070cd8396c68be56` |
| `src/lib/rag/eval/production-receipt-fixtures.test-support.mjs` | `7553dfa51d82b82cbd5bf843935e445fa031282b9ba72458e251319358820abf` |
| `src/lib/rag/eval/production-manifest-authority.test.mjs` | `d7ef457788ee9a4d5e8fe01bbdd5811b06c2e59fd288294465fa49c37193fafd` |

受检集合 = W0 baseline 报告 35 个哈希表路径 ∪ 上轮 writer 报告 16 个 `.ts/.test.mjs` 模块 ∪ 本表 8 文件 ∪ `src/lib/security/request-validation.ts`，去重 69。旧报告记录的是其当时身份，本轮 fixture 提取/实现后的 SHA 不回写过去。drift=[] 仅表示本轮集合运行前后稳定，不表示 baseline 至今没有其他已知改变、整个工作树或宿主被冻结。保留用户无关脏文件。

## 原预算验证

Node v22.22.0；串行 spawnSync；每命令外层 90000 ms/16 MiB；所有测试 `--test --test-timeout=30000`，只沿用测试子进程 `RAG_SEMANTIC_ROUTER=off`，无 preload/skip/concurrency/isolation/budget 修改。

- strict16：上轮 writer 报告同一 16 TS 模块，`--noEmit --ignoreConfig --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node`。
- lint8：本表八文件，`--max-warnings 0`。
- local18：16 同名 tests + writer test + 新 manifest-authority test。
- cumulative29：local18 + W0 的 dataset/metrics/gate/matrix/production-policy-contract、context-composer-v2、legacy-evidence-adapter、KG contracts/postgres-publication-store/graph-snapshot-recovery、Ask route，全部 11 文件。
- Ask leaf 是诊断隔离，不替代完整 Ask 或累计验收。

| 范围 | UTC 窗口 | 实际结果 | stdout SHA-256 |
|---|---|---|---|
| strict16 | 02:36:46.498–02:36:47.455 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| lint8 | 02:36:47.456–02:36:49.283 | exit0，双流空 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| manifest10 | 02:36:49.283–02:36:51.951 | 10/10，2616.7205ms | `b9e7ba1cfccf7d90936adaa74ffe225c4be50205d69075fecc1f88349f546bca` |
| local18 | 02:36:51.951–02:37:13.856 | 437/437，21865.1789ms | `f7c35a5c8c6cc3862ba50b79d376bd7afbf0028ed4d47a4d6019110b8475b4b2` |
| cumulative29 首轮 | 02:37:13.857–02:37:37.989 | exit1，579 passed/1 failed，24092.4555ms | `8c72444940cf6df286ce2aa1fb2e7df72615c45bbf07aacdc8b2b20dc61fbf05` |
| Ask delete leaf | 02:39:18.750–02:39:20.085 | 1/1，1299.343ms | `9881494b5c1d4030cbbc3f0f07a5f925a2440b2fed2c2c5739a150ddb8ffa4f9` |
| 完整 Ask | 02:39:20.086–02:39:26.636 | 75/75，6517.416ms | `1a95f2f5441f0bffbc85c455497a7aab3c9c8a84457d1c0003aa77120bfff0f3` |
| cumulative29 原样复跑 | 02:39:26.636–02:39:48.243 | 580/580，21565.6825ms | `7023d787095154272f04e758eb7f9fd0a4ba8407acf24e5ea399e7de3e791d4a` |

全部进程正常终态、无 signal/error，stderr 均空，所有 cancelled/skipped/todo 为 0；首累计 fail1 如实列出。`git diff --check` exit0，保留既有 CRLF 提示。

## 独立审查与续接

- 安全/code：两 production 精确 SHA 前后一致，APPROVE；原预算独立新10 + writer19 + manifest17 + reader20 = 66/66、exit0。覆盖闭合 schema、derived identity/ref、T17/R18、getter/Proxy/alias、真正签名加密错绑定与 nonce 前拒绝。无文件编辑或外部 I/O。
- TypeScript：同一 production SHA 前后一致，APPROVE；独立 strict16/lint8 exit0，无另跑 tests。检查 strip-only、runtime dependency cycle、async capture 与原私有实例，未发现 actionable finding。审查仅本地绑定切片，不等于完整 W2。
- 实际 Sprint runtime 为 WORK/ACTIVE，W0/W1 done，2/13；pointer.next 仍有旧 W0/W1 字样，不手改控制面。权威接续以计划 Section4 为准。
- 下一工作是 W2 predecessor acceptance、完整 frozen-policy recovery/周期续期证明与其余 common ports/完整 independent behavioral harness；随后按既定依赖 W3-W9、T16/T17/R18。18 项端到端 AC 仍 open；尚需外部数据/gold/阈值/企业身份与 provider/维护窗口等，不从本地 fixture 或用户一般授权伪造这些证据。
