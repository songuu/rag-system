---
type: sprint
status: completed
created: 2026-08-11
---

# MiroFish / OpenMAIC upstream refresh

研究 MiroFish 与 OpenMAIC 的最新公开上游更新，识别与当前仓库相关且可移植的变更，直接应用到项目，并完成与风险相匹配的测试、审查和结果沉淀。

## Think

### 已验证上游基线

- MiroFish：最新 release 仍为 `v0.1.2`（`985f89f`），实时 `main` 为 `b5b53acc57189a4a42e44a23e149dc655c98fe82`；相对本仓库旧锚点 `96096ea...` 前进 53 个提交。
- OpenMAIC：最新 release 为 `v0.3.1`（`04acb17c1a3e7aca5f717ab7e9a94a9ab73cf3a0`），实时 `main` 为 `c38da84ef6c906020ff08abb1ec480befd29a678`；相对 `v0.3.1` 前进 65 个提交。
- 两个 `main` 都包含未发布更新；实现时按独立行为合同移植，并记录来源，不宣称已升级为新的稳定版。

### 要做

- MiroFish：移植长文 ontology 全文等距采样、严格的单对象 JSON 解析、LLM 生成 seam 的字符串 attribute 规范化，以及 profile 结构字段的有界文本 coercion。
- OpenMAIC：更新最新模型目录为 `documented` 能力，增加模型/思考能力元数据漂移守卫；核对并在确有缺口时修正分阶段组合路由、PBL thinking 参数与 SiliconFlow 零预算序列化。
- 为 reasoning-wrapped JSON 补兼容回归，但保留本地 `parseMaicJsonResponse` 更强的“合法 JSON 字符串内 reasoning tag 不被破坏”语义。
- 修复阻塞本轮验证的 `prepare-cache.test.mjs` 既存最小语法破损，不扩展到无关脏改动。

### 不做

- 不整仓迁移 MiroFish 的 Flask/Vue/Zep/OASIS 架构。
- 不引入 OpenMAIC editor、renderer v2、generation package 大迁移、RuntimeStore/Postgres、asset registry 或 video export 完整栈。
- 不在没有凭据和运行时 smoke 的前提下宣称新增模型、Bedrock、Atlas Cloud、Claude Search 等 provider 可用。
- 不回滚、重写或提交当前工作区的其他未提交改动。

### 可观察的成功标准（L3）

1. WHEN ontology 输入超过本地长度预算，THE SYSTEM SHALL 从全文首、中、尾的确定性片段构造提示，并由测试证明尾部事实不会永远丢失。
2. WHEN MiroFish LLM 输出为截断 JSON、多 JSON、顶层数组或结构化字段对象，THE SYSTEM SHALL 显式拒绝或有界规范化，且错误信息不得回显原始模型内容。
3. WHEN ontology attribute 是上游兼容的字符串形式，THE SYSTEM SHALL 仅在 LLM 生成 seam 转换为严格 attribute 对象，而 HTTP/artifact 边界继续严格校验。
4. WHEN OpenMAIC 新模型或 thinking 元数据被加入目录，THE SYSTEM SHALL 将未实测项标为 `documented`，并由漂移测试阻止遗漏能力分类。
5. WHEN 运行本轮聚焦测试、TypeScript、范围 lint、diff hygiene 与 production build，THE SYSTEM SHALL 在不破坏既存脏改动的前提下通过；build 仍须证明 `standaloneRaw=0`。

### 风险、假设与未知项

- 上游 `main` 尚未发布且可能继续变化；本轮锚定上述精确 SHA。
- 新模型/provider 的真实可用性未知；只记录目录能力，不做运行时可用声明。
- 工作树有多处既存并行改动，且与 MAIC 路由/cache 文件重叠；实现必须窄补丁并逐文件复核。
- `src/lib/maic/prepare-cache.test.mjs` 当前存在既存语法破损，会先做最小修复以恢复可信测试基线。

### 下一步

进入 Plan，定位上述行为的最小源码 seam、测试先后顺序和回滚边界。

## Plan

### 方案概述与关键取舍

- 为 MiroFish 新建独立的严格 JSON object parser；不收紧 MAIC 的 permissive parser，因为 MAIC 合法支持顶层数组和“最后一个平衡 payload”。
- 只在 LLM 生成 seam 兼容字符串 attribute 和结构化 profile 字段，公共类型、HTTP 输入和 artifact 校验继续严格。
- 把 interaction/report 当前的 raw-response fallback 一并移除；只修 helper Error 不足以消除泄漏。
- OpenMAIC 只移植目录与验证合同：新增模型保持 `documented`，纠正未接 runtime adapter 却标为 `supported` 的条目，并把 status 暴露给 capability profile；不添加空壳 provider/PBL 路由。
- 当前 `prepare-cache.test.mjs` 的语法修复单独处理，先保存红证据，只修 import/解构结构，不改变断言或 cache 源码。

### Before / After 契约

| 消费面 | Before | After | 一致性消费者 |
| --- | --- | --- | --- |
| Ontology 长文 | 只取前 50,000 字 | 确定性首/中/尾等距采样，正文与分隔符合计不超预算 | ontology prompt、ontology tests |
| MiroFish JSON | 贪婪 `{...}` 与宽松修复可接受多文档/数组内部对象 | 恰好一个顶层 plain object；支持单 fence/reasoning wrapper；拒绝数组、多对象、截断、空内容 | ontology、profile、interaction、simulation、report |
| 错误输出 | interaction/report fallback 可包含完整 raw 模型输出 | 稳定错误码/安全固定文案，Error/cause/artifact 均不含 raw | API 消费者、日志/缓存 |
| Ontology attribute | 字符串 attribute 被静默丢弃 | 仅生成后处理把字符串转为严格对象；外部输入仍严格 | ontology generator、graph builder、artifact store |
| Profile 字段 | object 变 `[object Object]`，标量/对象数组被丢弃 | 优先提取 `text/value/description/content/summary/name`，再安全序列化并按命名上限截断 | profile prompt result、prepare/cache |
| OpenMAIC 能力目录 | 新模型缺失，部分未接 provider 被标 `supported`，profile 不返回 status | 最新模型记录为 `documented`；唯一性/思考元数据/runtime status 守卫；profile 返回 status | model API/UI 能力提示、catalog tests |

### 有序任务

- [x] **Task 0 — 恢复可信测试语法基线（L1）**
  - 文件：`src/lib/maic/prepare-cache.test.mjs`。
  - 前置：无。
  - 动作：先运行 `node --check` 保存红证据；最小修复错误嵌套的 `getModelFactory` import；再次 `node --check` 和直接测试。
  - 完成证据：语法绿、测试可执行；不改 `prepare-cache.ts`，除非随后出现独立行为红。

- [x] **Task 1 — MiroFish 严格单对象 parser（L2）**
  - 文件：新增 `src/lib/mirofish/json-object-response.ts`、`src/lib/mirofish/json-object-response.test.mjs`。
  - 前置：无。
  - TDD：先覆盖 exact/fence/reasoning final object；拒绝顶层数组、多对象、截断、空内容；证明 secret 不出现在错误 message/cause。
  - 完成证据：直接 Node 测试从红到绿；无 MAIC parser 改动。

- [x] **Task 2 — Ontology 全文采样、严格解析与 attribute 规范化（L2）**
  - 文件：`src/lib/mirofish/ontology-generator.ts`、`src/lib/mirofish/ontology-generator.test.mjs`。
  - 前置：Task 1。
  - TDD：短文原样；长文首/中/尾 marker 均可见、输出确定、总预算有界；字符串 attribute 只在生成 seam 变为严格对象；多 JSON/数组失败安全。
  - 完成证据：ontology 聚焦测试通过，`types.ts`、graph builder/artifact validators 不放宽。

- [x] **Task 3 — Profile 结构字段有界 coercion（L2）** `[P after Task 1]`
  - 文件：`src/lib/mirofish/profile-generator.ts`，新增 `src/lib/mirofish/profile-generator.test.mjs`。
  - 前置：Task 1。
  - TDD：对象优先键、数组元素、循环/不可序列化值、长度上限、viewpoints、behavioral-anchor 原语义；严格 parser 拒绝坏 JSON。
  - 完成证据：profile 测试通过，输出类型不变且不产生 `[object Object]`。

- [x] **Task 4 — 其余 MiroFish consumer 统一 parser 并消除 raw fallback（L2）**
  - 文件：`src/lib/mirofish/interaction-agent.ts`、`simulation-engine.ts`、`report-agent.ts` 及各自新增/扩展测试。
  - 前置：Task 1。
  - 子任务文件互不相交，可并行；每个 consumer 的源码与测试必须由同一 owner 完成。
  - 完成证据：多对象/数组/截断输入不被接受，interaction/report fallback 不包含 raw secret，simulation 保持显式安全失败。

- [x] **Task 5 — OpenMAIC 最新目录与能力漂移守卫（L2）** `[P]`
  - 文件：`src/lib/model-catalog.ts`、`src/lib/model-catalog.test.mjs`、`src/lib/maic/json-response.test.mjs`。
  - 前置：无；与 Tasks 1–4 文件不重叠。
  - 动作：加入 `claude-opus-5`、`claude-sonnet-5`、`claude-fable-5`、`gemini-3.6-flash`、`gemini-3.5-flash-lite`、`kimi-k3`、`grok-4.5`、`grok-4.3`、`grok-build-0.1`，全部标 `documented`；补 reasoning family 分类、provider:model 唯一性、reasoning thinking 元数据、runtime-supported provider allowlist 与 profile status 测试；把当前未接 adapter 的 Google/Xiaomi 条目改为 `documented`；增加 OpenMAIC #750 reasoning fixture，不改 parser 实现。
  - 明确 defer：SiliconFlow LLM、PBL thinking、Bedrock、Atlas、Claude Search、RuntimeStore/generation package。
  - 完成证据：catalog/json-response 测试通过；没有新增 runtime availability 声明。

- [x] **Task 6 — 分层回归与收口（L3）**
  - 前置：Tasks 0–5。
  - 完成证据：聚焦 tests、MAIC 保真 tests、TypeScript、scoped ESLint、`git diff --check`、production build、standalone trace guard 全部按层报告；build 前后 status 证明未把生成物或既存脏改动归入本轮。

### 测试策略

1. 语法：`node --check src/lib/maic/prepare-cache.test.mjs`（红证据 → 最小修复 → 绿）。
2. 最窄 TDD：逐个直接运行新增 `node --test <single-file>`；Windows 下优先单文件，避免 runner `spawn EPERM` 噪声。
3. 行为回归：MiroFish ontology/profile/interaction/simulation/report；MAIC json/manager/stage-options/prepare-cache/prepare-runner；model catalog。
4. 聚合：运行现有 `pnpm test:model-runtime`，但不把它当作 prepare-cache 直接测试的替代品。
5. 静态：直接 `node_modules\\.bin\\tsc.CMD --noEmit --pretty false --incremental false`、实际触及文件的 ESLint、`git diff --check`。
6. 产物：`pnpm build`；若 wrapper 出现 `spawn EPERM`，拆为 repo-native generate → direct Next build → `node scripts/check-standalone-traces.mjs`。最终必须单独确认 `standaloneRaw=0`。

### 风险、回滚与未知项

- 严格 parser 会拒绝过去被宽松接受的弱模型输出；这是预期 fail-closed。回滚只需恢复 consumer import/fallback，不涉及数据迁移。
- 旧 ontology/profile cache 可能绕过新 seam；Work 阶段先核对 cache identity 是否含生成器版本，仅在确有坏 artifact 复用风险时 bump，禁止清空用户缓存。
- profile coercion 上限在本地没有既定标准；以现有字段/请求预算设命名常量并由测试钉住，避免无界序列化。
- GitHub 匿名 API 已触发 rate limit；已取得的 tag/head/compare 与关键补丁证据有效，不再把 rate limit 误判成上游缺失。
- Windows shell 沙箱出现 `CreateProcessAsUserW failed: 5`；沙箱外命令可用。后续环境失败与源码失败分层报告。
- 当前工作树已有 23 个 tracked 修改和 4 个 untracked 文件；回滚边界只包含本计划列出的本轮 diff，不使用 reset/checkout，不覆盖其他 owner 改动。

### 涉及文件与下一动作

- 新增：MiroFish strict parser/test、profile test、三个 consumer focused tests。
- 修改：MiroFish ontology/profile/interaction/simulation/report；OpenMAIC model catalog/tests；MAIC reasoning fixture；最小 prepare-cache test 语法。
- 下一动作：进入 Work，先执行 Task 0 保存红/绿语法证据，同时并行启动 Task 1 与 Task 5 的 TDD 红测。

## Work

### 已实现

- 新增 MiroFish 严格单对象响应 parser：仅接受 exact object、单个 JSON fence 或 reasoning wrapper 后的最终 object；统一脱敏错误，不保存 raw/cause。
- Ontology 改为 50,000 字预算内确定性首/中/尾采样，并只在 LLM 生成 seam 兼容 string attribute。
- Profile 对结构化标量、数组和 viewpoints 做语义优先、安全且有界的 coercion，保留 behavioral anchor clamp。
- Interaction、simulation、report 统一严格 parser；interaction/report 使用固定安全回退，simulation 保持原有 fallback post。
- OpenMAIC 最新模型只登记为 `documented`，补唯一性、thinking 元数据、runtime status 漂移守卫与 #750 reasoning fixture。
- 修复 `prepare-cache.test.mjs` 既存 import 语法破损；并把并发图测试依赖的远程 `concurrency=4` 前提显式化，避免与既存本地 provider 默认 1 的改动冲突。

### 验证证据

- TDD 红灯分别命中 parser 缺失、旧 greedy JSON、长文只取前缀、string attribute 丢失、`[object Object]`、raw fallback 和模型目录漂移；首轮实现聚焦/MAIC 矩阵 82/82 通过。
- 仓库原生 `pnpm test:model-runtime` 21/21 通过；TypeScript `--noEmit`、实际触及文件 ESLint、scoped 与整棵 tracked `git diff --check` 均通过。
- `pnpm build` 成功；postbuild 与独立复核均得到 `standaloneRaw=0`（ask=1251、pipeline=472、mirofish-graph=175）。
- 构建自动改写的 `next-env.d.ts` 已按构建前 blob 恢复；HEAD、index、filtered worktree hash 均为 `c4b7818...`，最终 status 不再包含该文件。

### 边界与下一步

- 未新增 provider adapter，未宣称九个新目录模型可运行；OpenMAIC `main` 与 MiroFish `main` 仍属于未发布基线。
- 未触碰或回滚本轮范围之外的既存脏改动，也未提交、暂存或推送。
- 下一动作：进入 Review，对安全边界、上游映射正确性和最终 diff 做独立审查。

## Review — Round 1

结论：不接受，退回 Work。三个只读审查面共确认 2 个 P1、4 个 P2：

- P1：report 只校验顶层 object；`{}` 会生成空 completed 报告，`sections:[null]` 会在安全回退外抛错。
- P1：ontology/profile 生成算法变更未进入 cache identity，相同输入会继续命中升级前产物。
- P2：profile list 不接收 string/object singleton，`expertise` 仍会产生 `[object Object]` 且无界。
- P2：ontology/profile 直接按 UTF-16 code unit `slice`，可能在 emoji 边界生成孤立 surrogate。
- P2：runtime `supported` 守卫只比较 provider 集合，不能阻止同 provider 下未实测模型被误标。
- P2：prepare runner 已有 overlap 断言，但仍用 `<200ms` 墙钟门槛；10 次为 161.7–184.4ms，繁忙 CI 可误红。

其余已核验：官方 #993 provider key 为 `grok`（不是 `xai`）；九个模型与 thinking control 映射正确；strict parser、interaction、simulation、#750 fixture 与环境恢复未发现其他可操作问题。

## Work — Review Round 1 fixes

- Report 现在先完整校验并归一化 title/summary/sections/key_findings；合法 JSON 但错误 schema 与解析错误共用固定安全报告，不保留 raw。
- Ontology/profile 使用共享 UTF-16 安全切片；profile list 支持 string/object singleton，`expertise` 接入 32×1024 上限，结构化字段递归限制为 32 层。
- Ontology 与 profile/profile_batch 的 algorithm revision 纳入 cache signature；同输入旧产物不再命中，但 graph cache key 保持 `bb82889...`，未删除任何缓存文件。
- `supported` 漂移守卫改为精确的大小写无关 `provider:model` 白名单；runner 删除 `<200ms` 墙钟门禁，改用 script/tree/focus 调用窗口验证真实依赖图。

最终 Work 证据：14 个聚焦文件 96/96，`pnpm test:model-runtime` 21/21；TypeScript、scoped ESLint、scoped/new/whole diff check 通过；第二次 production build 通过，postbuild 与独立 trace 均为 ask=1251、pipeline=472、mirofish-graph=175、`standaloneRaw=0`。构建生成的 `next-env.d.ts` 已恢复，HEAD/index/worktree hash 均为 `c4b7818...`。

下一动作：进入 Review Round 2，由未实现对应文件的 reviewer 交叉审查修复后完整 diff。

## Review — Round 2

结论：不接受，退回 Work。交叉审查确认 5 个 P2：

- `prepare-runner.test.mjs` 手工复制 production Promise 图，真实 runner 即使退化为串行也可能全绿；必须直接测试 production 编排 seam。
- reasoning catalog/category 不一致：`Gemma-4-26B-A4B-it-GGUF` 被分类为 llm，`gemini-3.5-flash` 为 unknown；需全量 reasoning invariant。
- #750 fixture 未覆盖上游关键 `parseable draft JSON </think> final JSON` 非配对 closing 形态。
- Interaction 允许 `1e400`、负数或大于 1 的 confidence；Infinity 经 JSON 序列化会变为 null。
- Simulation 仅严格顶层 object，内部对象/数组会被 `String()` 成 `[object Object]`，`{}` 会进入有效空 post 而非 fallback。

Round 1 修复交叉审查未发现新问题：UTF-16、singleton/expertise/depth、cache revision 与 graph key、report schema 均成立；旧 cache 只失配不删除是明确的非阻塞磁盘残余风险。

## Work — Review Round 2 fixes

- `prepare-runner` 抽出并实际调用 production `runPrepareDependencyGraph`；测试删除复制的 Promise 图，直接验证 script/tree/questions/focus 的依赖与并发不变量。
- Model catalog 增加“所有 reasoning note 必须被分类为 reasoning”的全量 invariant；精确 catalog metadata 优先于启发式分类，同时保留 embedding 排除语义。
- OpenMAIC #750 回归夹具改为可解析 draft、非配对 `</think>` 与 fenced final payload 的上游关键形态；现有 parser 已满足合同，因此未改实现。
- Interaction confidence 只接受有限且位于 `[0,1]` 的数；越界、非有限值回退 `0.5`，边界 `0/1` 保留。
- Simulation 对 action/content/target_id/sentiment/topics 做显式 schema 与动作相关必填校验；语义无效统一进入既有安全 fallback，错误不回显原始模型内容。

定向修复证据：catalog/#750/production runner 29/29，interaction/simulation 8/8；各 owner 的红测均先命中对应缺口，随后 TypeScript、scoped ESLint 与 diff-check 通过。下一动作：运行最终完整验证矩阵，再进入 Review Round 3。

最终 Work 证据：14 个聚焦文件 100/100，仓库原生 `pnpm test:model-runtime` 21/21；全量 TypeScript、21 个本轮文件 scoped ESLint、tracked 与新增文件 whitespace check 全部通过。第三次 `pnpm build` 成功，postbuild 与独立复核均为 ask=1251、pipeline=472、mirofish-graph=175、`standaloneRaw=0`。构建自动改写的 `next-env.d.ts` 已用窄补丁恢复，HEAD/index/worktree blob 均为 `c4b7818...`，生成文章文件也无状态变化。

## Review — Round 3

结论：不接受，退回 Work。三组全新只读 reviewer 确认 2 个 P2：

- Profile `viewpoints` 只限制 value 与条目数量，topic key 可保持数千 UTF-16 code units 并进入缓存及后续 prompt；需要 surrogate-safe key 上限和截断碰撞策略。
- Model categorizer 只排除名称中的 `embedding`，没有覆盖常见 `-embed` 变体；`gemini-3.5-flash-lite-embed` 等会被 reasoning pattern 错分。

Consumer 安全面无 finding：interaction/simulation/report 的公共 production 路径、schema fallback 和 raw non-leak 合同成立。OpenMAIC #993/#750 映射、production runner seam、prepare-cache identity 与环境恢复也未发现其他问题。

## Work — Review Round 3 fixes

- Profile viewpoint topic key 复用 1,024 code-unit 上限与 surrogate-safe truncate；截断碰撞稳定追加计入预算的 `#2`、`#3` 后缀，最多 32 条合同不变。
- Model categorizer 抽出统一 embedding 判定并置于 exact catalog 与 reasoning heuristic 之前；`-embed`/`-embedding` 变体不再继承 reasoning 类别。

TDD 证据：profile 红灯 10/12、绿灯 12/12；catalog 红灯 18/19、绿灯 19/19；主线组合复核 31/31。下一动作：重跑完整验证并进入 Review Round 4。

最终 Work 复核：14 文件矩阵 104/104，`pnpm test:model-runtime` 21/21；全量 TypeScript、scoped ESLint、tracked/untracked whitespace check、第四次 production build 全部通过。postbuild 与独立 trace 均为 ask=1251、pipeline=472、mirofish-graph=175、`standaloneRaw=0`；`next-env.d.ts` 再次恢复为 HEAD/index/worktree `c4b7818...`，生成文章文件无状态变化。

## Review — Round 4

结论：不接受，退回 Work。两个独立 reviewer 确认 2 个 P2：

- `viewpoints` 使用普通 `{}` 加动态赋值，untrusted `__proto__` key 会命中继承 setter 并被静默丢弃；需要以 own data property 保存并补完整 generate production-path 回归。
- Embedding precedence 实现本身通过 60 个跨类枚举，但永久测试只覆盖 `embed/embedding`，无法防止 `bge/gte/jina/e5/instructor` marker 回归；需把这些 marker 与 reasoning/llm 冲突加入测试。

其余修复成立：普通 topic key 的 1,024 UTF-16 上限、surrogate-safe 截断、`#2…` 碰撞消歧与 32 项上限均通过复现；OpenMAIC reasoning/status invariant 无回归。

## Work — Review Round 4 fixes

- `parseViewpoints` 改用 `Object.defineProperty` 写入 enumerable/writable/configurable own data property，保持普通 `Object.prototype` 的同时完整保留 `__proto__`、`constructor`、`prototype` 与普通 key；完整 `generateProfile → strict parse → build` 回归从 12/13 红到 13/13 绿。
- Catalog precedence 测试扩展为 7 个 embedding marker（`embed/embedding/bge/gte/jina/e5/instructor`）× reasoning/llm 两类基名的 14 个冲突案例，并用 mutation guard 证明仅 `includes('embed')` 的旧捷径会漏掉 5 个 marker；production categorizer 无需再改。

最终 Work 复核：14 文件矩阵 105/105；全量 TypeScript、scoped ESLint、tracked/untracked whitespace check、第五次 production build 全部通过。postbuild 与独立 trace 均为 ask=1251、pipeline=472、mirofish-graph=175、`standaloneRaw=0`；`next-env.d.ts` 已恢复为 HEAD/index/worktree `c4b7818...`，生成文章文件无状态变化。

## Review — Round 5

结论：接受，P0–P3 无 finding。

- Profile reviewer 经完整 `generateProfile` 路径验证特殊 key 均为 own/enumerable/writable/configurable data property，普通原型及 `Object.prototype` 不变；32 条同前缀碰撞、1,024 key 上限、UTF-16 边界与 JSON 往返全部成立，13/13 通过。
- Catalog reviewer 验证 7×2 marker 冲突矩阵实际调用 production categorizer；仅 `includes('embed')` 的退化会失败 10/14，30 个 reasoning 条目与 4 个 runtime-supported allowlist 均无偏差，19/19 通过。
- 两个 reviewer 均未修改、暂存或提交文件；scoped lint/diff-check 通过。

已知非阻塞边界：没有真实 provider 凭据 smoke；`documented` 不代表可调用。UTF-16 helper 不清洗输入原有孤立 surrogate；旧 cache 文件只失配不删除；Node module-type 与 LF→CRLF 提示不是测试失败。

## Compound

### 已验证事实

- 查重命中既有同主题详情源 `docs/solutions/2026-07-14-mirofish-openmaic-latest-sync.md`，因此更新 1 条、未新增近义 solution。
- 追加了 2026-08-11 的 Problem、Root Cause、Solution、Prevention、Verification 与 Known boundaries；没有生成 rule、instinct 或个人 memory 写入。
- 当前仓库没有 `scripts/sync-solution-index.js`；首次按规范调用明确失败为 `MODULE_NOT_FOUND`。随后使用已加载 Tech Persistence 插件内同名脚本，并先 dry-run 确认只更新 canonical index/Claude projection、AGENTS 无变化。
- `docs/solutions/index.jsonl` 已生成 39 条且逐行通过 JSON 解析；第二次实际同步消除了首次新建 projection 的尾换行差异，最终 dry-run 对 index、CLAUDE、AGENTS 全部为 `[ok]`。
- `CLAUDE.md` 与 `docs/solutions/index.jsonl` 是本次新增的未跟踪仓库知识文件；AGENTS projection 未写入。

### 推断

- strict envelope + semantic schema + algorithm revision + production-seam tests 是未来上游 LLM 行为移植时可复用的最小组合防线；该判断由本轮五次 review 的实际 findings 支持。

### 未知项

- 新增 `documented` 模型的真实 provider 可用性仍需凭据 smoke；本轮没有外部同步或云端可见性证据。

Solution index: updated 39 entries -> docs/solutions/index.jsonl; Claude projection: updated; AGENTS projection: disabled
