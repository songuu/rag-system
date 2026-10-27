# W2 ReceiptCore / 独立读回 / Bundle 局部验证

- 日期：2026-10-09；`work/active`，完成计数仍为 2/13，W2 整项 open。
- 新增 `production-receipts.ts` / `.test.mjs`；复用已有 canonical、authorization、journal 和 controlled-artifacts 模块；未修改这些旧模块、Ask/Graph/readiness 或生产状态。
- 本轮交付三阶段 core schema、完整 journal 组合、本地实际加密封存与独立解密读回、bundle 的非循环结构/引用/语义一致性。不是企业级 acceptance verifier。

## 当前验证证据

- 缺模块红测已执行。首轮实现运行 11 个测试均因 fixture 的 terminal.beforeDigest 未指向 prior root 失败；已修正 fixture，不改既有 journal guard。
- Provider 原始异常泄漏红测（11 pass / 1 fail）→ 固定四个 async 操作上下文后 12/12。
- 封存入口 schema-only 可旁路 journal 的红测（12 pass / 1 fail）→ 强制提供并校验 full journal；361-entry、超过 256 KiB 的日志通过，不将它截断为小 JSON 对象。
- 后续 rehashed-result duties fixture 最初没有同步 executionIdentityId，提前触发已有 authorization guard；修正负测输入以触达 bundle duties 比对，未放宽旧验证。
- 初次新增 17/17 定向通过；七组 W1/W2 合同 100/100，0 skipped，duration 495.7986 ms。这是独立复审前的局部证据，不覆盖后续发现的缺陷。
- 独立复审四类 P1 先补红测，17 pass / 6 fail：AAD/context 跨 await 漂移、encrypt 后换绑 decrypt 与损坏密文、core 内部角色别名、recovery ref 绕过原 execution window、future result.notBefore。修复后 23/23；新增同角色 PublicationIdentity 正例与全部 callback 深冻结检查后 25/25。
- 终审另发现 capability 捕获读取 `.bind` 可触发函数 getter，且 callable Proxy 也可在入口执行 trap/泄漏异常；新增两个测试得到 25 pass / 2 fail。改为 descriptor 函数值捕获、拒绝 callable Proxy、稳定 Reflect.apply 闭包，不读取 bind/length/name；最终定向 27/27，duration 203.873 ms。
- 最终七个 TS 合同 strict TypeScript 退出 0；新增两文件 ESLint 退出 0。独立命令显式使用 `--ignoreConfig --types node --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck`。尝试未带 ignoreConfig/Node types 的命令曾分别因 CLI 配置冲突和缺少已安装 Node 类型加载失败，修正命令后通过；没有安装依赖或修改全局/仓库配置。初次 unknown 时间字段类型错误用已有 timestamp validator 收窄。
- 初次本地整体回归：18 文件，243 tests / 242 pass / 1 fail，0 skipped，duration 7508.4936 ms；窗口 2026-10-09T05:03:50.069Z → 2026-10-09T05:03:57.617Z。
- 唯一明确失败：Ask `PATCH cancellation is admin-only and fences a running durable ask`，`src/app/api/ask/route.test.mjs:2232`，queryStarted=false，未在约 2 秒等待内观察到 scoped agent signal。独立只读诊断单例 1/1、Ask 文件 75/75、当时精确 18 文件 243/243 均通过；未修改 Ask 或扩大 deadline。失败仅证明 agent-entered 观察超时，前置 I/O/CAS 延迟或提前返回尚无法区分；并行资源/调度导致 2 秒硬窗口抖动只是推断。不能声称已修复，也不能声称它就是上轮输出丢失的那次未知失败。
- 失败回归 stdout SHA-256 `8f10589f0ff0795c8431bf380ebf826c0af5a21da68a76dd16d886ed95b58644`；七组合 stdout SHA-256 `2ec9dbb3e79d3cd231d192324c507f782ae381a65e1ef66295a29faf52804f2e`，均只是本地主机输出身份。
- 45 个相关文件运行前后无漂移；相对 W0 历史仍仅有此前两个 manifest 修复及其他任务 readiness 变化。未覆盖历史快照、未还原他人修改。
- 四类修复后曾运行 108/108 局部、251/251 整体；随后新增两项函数 getter/Proxy 测试及最小修复，以下为最终源码结果，不覆盖/删除先前失败记录。
- 最终七组合同 110/110、0 skipped，duration 500.874 ms；18 文件整体回归 253/253、0 skipped，duration 7627.1704 ms；窗口 2026-10-09T05:24:03.609Z → 2026-10-09T05:24:11.273Z。45 个文件前后稳定，历史 baseline 差异仍仅两个已主动修复的 manifest 文件和其他任务的 readiness 文件。
- 最终局部 stdout SHA-256 `bc84787d09131733625c7eb4dcbbbce358c3388dfda807545ad5b13d41964380`；整体 stdout SHA-256 `3f93d6c9c2ea5441ed5e6e2ff0c07a4153223ab524f79218af48c351fbb6cd63`。这些仍只是本地主机输出身份。
- 最终两个源码 hash 已获独立 APPROVE，无剩余 P0/P1/P2；独立定向 27/27、ESLint 退出 0。批准仅适用于当前局部/reference 切片，不等于 W2、production trust 或验收通过；一次最终绿色回归不证明 Ask 时序稳定性。

## 实现与明确的非生产边界

- `kg-t16-shadow-receipt-core/v1`、`kg-t17-canary-receipt-core/v1`、`kg-retention-receipt-core/v1` 严格字段/阶段组合；confidential 分类、manifest/run/scope、数据/config/provider/arm identities、execution/recovery refs、机密索引/report refs、终态 journal/head/ref、stage-specific evidence 与时间/verdict。
- Core 无 result attestation/bundle/自身 ref 或任意 inline query/answer 字段；T16 无 predecessor/recovery，T17/R18 需要 predecessor；T17 可封存终态必须 off/零流量。这里只证明值/结构，尚不证明真实前驱 bundle、冻结 manifest、PublicationIdentity、SideEffect/Ramp/Fault/Retention 事实。
- `createReceiptCore` 校验完整 hash chain、精确 head digest/root/count/fence 与 terminal outcome/finalState/time/actor/authority；head/readback 是输入一致性，不是权威 store/clock/writer 证明。
- `sealReferenceReceiptCore` 再次强制 full journal 校验；预检 profile/run/角色/时间/self-object 后才调用 KMS/store，实际执行 encrypt → exclusive seal → independent exact read → decrypt → exact plaintext 比对。Getter/Proxy 不执行，schema-only fake core 在任何操作前拒绝。
- 逻辑 `receiptCoreRef.sha256` 是 canonical plaintext core digest，`storageObjectRef.sha256` 是 encrypted object digest；两者共享精确 object ID/version，不能互相替代。独立解密回读将真实内容桥接为 `kg-receipt-readback-proof/v1`。
- 对象/AAD/ciphertext/store ID/version/digest、reader、retention cutoff 或解密内容不匹配则失败；请求、contexts/binding/AAD、envelope/object/ref 深冻结，AAD 与对象 canonical/digest 在调用前固定，不以 callback 改写后的值重新定义期望。方法从入口 data descriptor 固定捕获，不跨 await 动态换绑或读取函数 bind/length/name；callable Proxy 零 trap 拒绝。四个 port 异常不透出原始错误文本。不能保证 adapter 内部日志、string/GC/进程内存或崩溃转储不会泄漏，统一 harness/隔离/全链路脱敏仍 open。
- Reference workflow 只接受 trusted local executable dependencies 与 local-reference profile，返回 `local-reference-readback / productionAccepted=false`；不证明真实 KMS、WORM、独立企业主体、网络安全、durability 或可信时间。
- `kg-stage-acceptance-bundle/v1` 只含前向 exact refs；core 内部不可互换 refs 与 core/result/proof/execution 的 object-role alias、反向引用、缺失/换域/版本/hash、pre-run envelope 冒充 result、重算 hash 后的 result claims/duties 改写均拒绝。仅 index identity 与 final publication identity 可同语义复用精确同一 ref，hash 不同仍拒绝。Result claimed issuance/bundle 构造时间须晚于独立 readback，bundle 必须处于 result.notBefore/expiresAt 有效区间。
- `validateAcceptanceBundle` 仅调用 `validateAuthorizationEnvelope` 做结构校验，**不执行 Ed25519 verify、authority/nonce/revocation、ProviderTrustPolicy 或真实防篡改对象认证**。测试故意使用 syntactically valid zero signatures，返回仍 `structural-only / productionAccepted=false`，没有 signatureVerified/stageAccepted。machinePassed 只是输入 verdict 的展示信息，不是许可。
- Enterprise assurance/lock 元数据的一致性也不证明真实 enterprise capability。Caller 不能靠 bool/profile 字段或 schema 返回值使生产验收通过。
- Core 可记录 recovery refs 作为机密取证数据，但当前 bundle helper 明确拒绝任何 recovery refs，普通 execution terminal 无条件受原有效期/window 限制；引用存在不延长授权时间。尚未实现 recovery envelopes/frozen manifest-policy/lineage/实际新 generation 的完整组合 validator，合法 rescue 的验收支持仍是 W2 必做项，不用“拒绝所有 rescue”冒充该项完成。真正的 authority-aware acceptance/writer 仍 open。
- 尚未验证 predecessor T16/T17 bundle 的完整信任链、artifact index 跨页完整性、逐 runtime provider proof、机器 gate 真实性、已封存 result/proof/bundle 的真实存储版本或整个 workflow 的崩溃重放。没有生产 acceptanceBundle 产生。
- 回归沿用已有测试子进程 `RAG_SEMANTIC_ROUTER=off`；未改用户配置、未执行完整仓库 build，也不证明实际语义模型或 T16/T17 指标。

## 最终源码身份（独立 APPROVE）

| 文件 | SHA-256 |
|---|---|
| `src/lib/rag/eval/production-receipts.ts` | `5725ead4e09038a1456906bb7a336e6d5436226ab49c8f97518a2f70eda4b492` |
| `src/lib/rag/eval/production-receipts.test.mjs` | `fb85be1a5102a4865291ff13ae31fbd32b98b8cb04366c3ed22c765e6faccbb5` |

W2/其他本地任务和 T16/T17/R18 均不提前完成；18 项 AC 仍 open。下一步完成其余 operation ports/独立 behavioral suite、可信 approval/provider/clock/recovery 组合和 authorized write-ahead journal writer。FULL goal 保持 active；不更改迁移/owner approval/task map 记录、不提交/push、不执行生产变更或删除。
