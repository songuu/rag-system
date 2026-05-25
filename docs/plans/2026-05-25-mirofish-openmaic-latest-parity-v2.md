---
title: "MiroFish/OpenMAIC 最新能力保真吸收 v2"
type: sprint
status: completed
created: "2026-05-25"
updated: "2026-05-25"
checkpoints: 0
tasks_total: 3
tasks_completed: 3
tags: [sprint, mirofish, openmaic, parity, anti-drift]
aliases: ["MiroFish OpenMAIC latest parity v2", "Sprint 2026-05-25"]
upstream:
  mirofish: "https://github.com/666ghj/MiroFish"
  openmaic: "https://github.com/THU-MAIC/OpenMAIC"
  fetch_method: "gh API + WebFetch raw (无本地 clone)"
  window: "since 2026-05-08T00:00:00Z to HEAD as of 2026-05-25"
mode:
  auto: true
  caveman: true
invariants:
  - "OPENMAIC_LATEST_MODEL_NOTES 仅记录上游存在的模型，删除模型必须同步本地"
  - "model-catalog.ts 是纯静态参考表，不引入运行时依赖，不要求新 API key"
  - "MAIC upload 入口必须先 isSupportedFile 校验再 parseSlides，错误消息列出支持扩展名"
invariant_tests:
  - src/lib/model-catalog.test.mjs  # 本 sprint 新增
  - src/lib/maic/upload-validation.test.mjs  # 本 sprint 新增
deferred:
  - sprint: next
    item: "Brave + Baidu Search 集成 (OpenMAIC 47cc2a5)"
    deadline: "2026-08-01"
    reason: "需要用户提供 API key，本项目目前无 web-search 通用层"
  - sprint: next
    item: "HappyHorse video adapter (OpenMAIC 46b61de) + video manifest (2dff6d1)"
    deadline: "2026-08-01"
    reason: "本项目无 video 生成 pipeline，引入需要先建 media adapter 层"
  - sprint: next
    item: "Classroom zip 导出/导入 (OpenMAIC 757ac07)"
    deadline: "2026-08-01"
    reason: "目前只有 HTML 导出 (classroom-export.ts)，zip 流需要 jszip 依赖 + discussion trigger 状态机"
deadcode_until: []
---

# MiroFish/OpenMAIC 最新能力保真吸收 v2

## 元信息

- 触发命令：`/sprint --auto mirofish 和 openmaic 又更新新功能，需要完全接入进来`
- 模式：caveman + auto
- 上一次 parity：`docs/plans/2026-05-08-mirofish-openmaic-latest-parity.md` (completed)
- 中间相关 sprint：
  - `2026-05-11-mirofish-prepare-snapshot-architecture.md`
  - `2026-05-11-mirofish-architecture-optimization.md`
  - `2026-05-13-openmaic-ppt-animation-parity.md`
  - `2026-05-14-openmaic-ppt-focus-hover.md`
  - `2026-05-14-openmaic-ppt-model-focus-strategy.md`
  - `2026-05-14-mirofish-openmaic-cache-optimization.md`

## Phase 1: 需求分析

### 用户原始需求

> mirofish 和 openmaic 又更新新功能，需要完全接入进来

### 范围 (Scope)

- 上游来源：`666ghj/MiroFish` master HEAD + `THU-MAIC/OpenMAIC` master HEAD（用户确认）。
- 范围维度：runtime + prompt + UI 全量 diff，逐项分类决策（用户确认：分类决策模式）。
- 决策矩阵（沿用 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]]）：
  - Runtime contract change → 仅在本地持久化产物可迁移/有 fallback 时 adopt。
  - Prompt/output quality change → 优先 adopt。
  - UI experience change → 加为可选 state/panel，不替换主流程。
  - Dependency/service change → 不强制；用户未配置则 skip。

### 非范围 (Non-scope)

- 不替换本地 Next.js/RAG 架构。
- 不切换上游为 AIDC-AI/OpenMAIC（用户明确选 THU-MAIC）。
- 不引入必填的新外部 API key 或新付费服务。
- 不重写已有的 5 步 mirofish 工作流或 stage/scene 课堂模型。
- 不替换已通过 [[2026-05-14-mirofish-openmaic-cache-optimization]] 落地的 artifact-cache。

### 成功标准

- 上游 diff 全部分类标注（adopt / skip / defer），每条决策有书面依据。
- adopt 项落地后，所有原有入口、API 路径、字段语义保持向后兼容。
- 沿用 `src/lib/maic`、`src/lib/mirofish` 文件结构与 `src/app/api/{maic,mirofish}` 薄包装层不变。
- 改动后所有现有测试 + 本 sprint 新增的不变量测试全部通过。
- `npx tsc --noEmit` 不在本次改动文件中新增错误（历史债允许）。

### 风险

- 上游 commit 时间线长，diff 量大 → Plan 阶段必须先做"上游能力清单"再拆 task。
- prompt 模板变化可能微改语义却影响生成质量 → 对 prompt 类改动加聚焦的 parsing / shape 测试。
- 模型注册更新（新增模型 ID）可能影响 [[DEFAULT_RUNTIME_MODELS]] 统一配置 → 必须经过 model-override / runtime model 路径。
- UI 改动若直接搬上游可能与现有 `src/app/(*classroom*)` 路径不兼容 → 改 UI 前必须读现有页面文件。

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| MiroFish 服务层 | 核心逻辑在 `src/lib/mirofish/`，每服务一文件；单例 `getXxx()` | 新增服务沿用同模式 |
| MiroFish API | PUT/POST 字段白名单 + 数值上下限 + filename 消毒 | 新增 API 套用相同 schema |
| MiroFish SSE | `cancel()` hook + abort listener + 结束延迟 1s | 新事件类型不破坏现有流 |
| MiroFish state | Map 不可变 `set(key, {...old, ...updates})` | 新增 store 字段沿用 |
| MiroFish 缓存 | `artifact-cache` + source/model signature key | 新 artifact 类型加入同 cache，不绕过 |
| MiroFish profile | `behavioral_anchors` 可选字段 + prompt 注入 + 旧 profile fallback | 新 prompt 不删字段，可选叠加 |
| MiroFish ontology | PascalCase entities / SCREAMING_SNAKE_CASE relations / 过滤保留属性 | 后处理必经此层 |
| OpenMAIC language | Read/Plan 走 `buildLanguageDirective()` | 新 prompt 也必经此 |
| OpenMAIC capability | Stage scene capability flags 默认全开 | 新 capability 加可选 flag |
| OpenMAIC quiz state | course-scoped localStorage | 不绕过；新增字段做版本化 |
| OpenMAIC completion | 课堂结束 completion panel | 不删；可扩展 metric |
| OpenMAIC prepare cache | `uploads/maic-cache` 路径 + identity 不变 | 新增 prepare 字段进入 identity hash |
| Runtime model | `DEFAULT_RUNTIME_MODELS` 统一 + fallback 一致 | 新增模型 ID 经此层注入 |

### 入场扫描 - 集成路径

待 Phase 2 在拿到上游 diff 后填写。每条新增 API / 持久状态 / 跨层组件必须画出"用户触发 → 中间层 → 持久化 → 刷新可见"链路；任一 ❌ 必须收口或写入 `deferred:`。

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| — | — | — | — |

（前置 sprint 文档无 `deferred:` 字段；本表为空 = 无遗留半完成项。本 sprint 留下的 defer 须在 Phase 4 后回填。）

## Phase 2: 技术方案

> 取源方式调整：用户改选 WebFetch GitHub API 路径，不在本地 clone。所有 diff 通过 `gh api repos/.../commits` + raw.githubusercontent.com 抓取。

### 入场扫描 - 集成路径表（补完 Phase 1 占位）

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| 新增 Gemini 3.5 Flash / Lemonade / Xiaomi MiMo 条目 | 模块加载读 OPENMAIC_LATEST_MODEL_NOTES | 纯静态 const | 编译进 bundle | 立即（无 SSR/CSR 分歧） |
| MAIC upload isSupportedFile 拒绝 | POST /api/maic/upload 早返回 400 | 调用 src/lib/document-parser.isSupportedFile | 不持久化 | 错误立即可见，列出支持扩展名 |

集成路径均闭环，无 ❌。

### 上游 diff 全量分类

#### MiroFish upstream commits since 2026-05-08 (5 commits)

| commit | 简述 | 本地子系统 | 决策 | 依据 |
|--------|------|-----------|------|------|
| daec4b6 | type hints + `FileParser.is_supported()` helper | 本地 `src/lib/document-parser.ts` 已有 `isSupportedFile()` + `SUPPORTED_EXTENSIONS` | **adopt principle**（已落地 90%）+ Task 2 补 MAIC upload 调用 | 模式映射 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]] runtime contract |
| 3f4d561 | Python 3.11-3.12 version constraint | 本地是 TS/Next.js | **skip** | Python 约束不影响 TS runtime |
| db1bc14 / faa1511 | docs typo merges | docs only | **skip** | 不映射本地 |
| 96096ea | merge PR meta | meta | **skip** | 无内容 |

#### OpenMAIC upstream commits since 2026-05-08 (15 commits)

| commit | 简述 | 本地子系统 | 决策 | 依据 |
|--------|------|-----------|------|------|
| 6522780 | feat: add Gemini 3.5 Flash + thinkingLevel medium | `src/lib/model-catalog.ts` `OPENMAIC_LATEST_MODEL_NOTES` 有 google 但无 gemini-3.5 | **adopt** Task 1 | prompt/output quality + registry 增量 |
| 679130a | feat: Xiaomi MiMo Token Plan + 5 models | model-catalog 仅有 `mimo-v2.5` (documented) | **adopt** Task 1 | registry 升级到 supported + 补 model id 列表 |
| be759a8 | feat: lemonade provider full (ASR/TTS/image/llm) | model-catalog 有 lemonade Qwen3.5-4B | **partial adopt** Task 1 | 仅 catalog 文本同步；ASR/TTS/image 三层本地无对应实现，记为 skip 子项 |
| b29efe1 | fix: remove weak Lemonade recommended models | 上游只剩 `Gemma-4-26B-A4B-it-GGUF` | **adopt** Task 1 | 同步上游精简后清单 |
| d9aecf8 | fix: "usable provider ⇒ concrete model" invariant | 本地 `DEFAULT_RUNTIME_MODELS` 是 3 字段 const，永远非空 | **skip** | 本地无 settings store；invariant 已天然满足 |
| 2ed39da | fix: auto-select server llm model | 同上 | **skip** | 同 d9aecf8 |
| 3149955 | fix: memory leaks (ASR/streaming-text/export-pptx) | 本地无 ASR / `use-streaming-text` / `use-export-pptx` | **skip** | 模块不存在 |
| 757ac07 | fix: preserve discussion triggers in zip imports | 本地有 HTML 导出，无 zip | **defer** (frontmatter `deferred:`) | 需先实现 zip 导出层 |
| 976adc6 | fix: ChartElement defensive guards | 本地无 ChartElement; `classroom-export.ts` 已有 per-scene try-catch | **skip**（principle 已应用） | 当前导出层 fallback 行为等价 |
| a5209d7 | feat: outline review clickable card | 本地无 outline-review UI | **skip** | UI 模块不存在 |
| 22c637c | fix: generated video thumbnails | 本地无 video 渲染 | **defer** | 需先建 video pipeline |
| 2dff6d1 | feat: generated video manifest refs | 同上 | **defer** | 同 22c637c |
| 46b61de | feat: HappyHorse video adapter | 同上 | **defer** | 同 22c637c |
| 45929cf | fix: whiteboard code element scroll/drag | 本地无 whiteboard | **skip** | UI 模块不存在 |
| 47cc2a5 | feat: Brave + Baidu Search | 本地无 web-search 统一层 | **defer** | 需要 API key + 通用 web-search 抽象 |

### 真正落地的 adopt 列表（3 项）

1. **Task 1 — Model catalog 同步上游**
   - 文件：`src/lib/model-catalog.ts`
   - 新增 `google / gemini-3.5-flash` (reasoning, supportsThinking, thinkingControl `thinking.level`, status `supported`)
   - 升级 `xiaomi / mimo-v2.5` → status `supported`；新增 `mimo-v2.5-pro`、`mimo-v2-pro`、`mimo-v2-omni`、`mimo-v2-flash`
   - 同步 `lemonade` 模型为 `Gemma-4-26B-A4B-it-GGUF`（替换旧 Qwen3.5-4B-GGUF，符合 b29efe1 精简）
   - 风险等级：**L0**（纯静态参考表，无 runtime 行为变化）

2. **Task 2 — MAIC upload 前置 isSupportedFile 校验**
   - 文件：`src/app/api/maic/upload/route.ts`
   - 在 size 校验后、parseSlides 前调用 `isSupportedFile(file.name)`
   - 校验失败返回 400 + 支持扩展名清单（不含 .pptx 需特判：parseSlides 内部走 parsePptxSlides；isSupportedFile 不含 .pptx 但 maic 业务需要支持）
   - 错误消息中文，列出支持类型
   - 风险等级：**L2**（动到 upload contract，但只加更严校验，向后兼容）

3. **Task 3 — 新增不变量测试**
   - `src/lib/model-catalog.test.mjs`：验证 `OPENMAIC_LATEST_MODEL_NOTES` 含 google gemini-3.5-flash / xiaomi mimo-v2.5-pro / lemonade Gemma；旧 Qwen3.5 已替换
   - `src/lib/maic/upload-validation.test.mjs`：mock formData + 不支持扩展名 → 400；.pptx + .md / .pdf / .txt → 通过校验
   - 风险等级：**L1**（仅新增测试）

### 验证策略

- 每 Task 完成后跑：
  1. 本 task 新增的 `.test.mjs`
  2. `invariant_tests` frontmatter 列出的全部测试
  3. `npx tsc --noEmit` 仅检查改动文件
- 不跑：full repo lint（历史债太多，参考 [[2026-05-08-mirofish-openmaic-latest-parity#Verification]]）

### Auto mode 评估

- 任务数：3 ≤ 8 ✓
- 风险等级最高：L2，无 L3/L4 ✓
- scope 与原始需求一致（mirofish/openmaic 最新新功能接入） ✓
- 入场 checklist 三项均填 ✓
- 跨层结合无 ❌ ✓

→ Plan 自动通过，进入 Phase 3 Work。

## Phase 3: 任务拆解

- [ ] **Task 1** (L0) — Model catalog 同步上游 (Gemini 3.5 Flash / Xiaomi MiMo 全量 / Lemonade 精简)
- [ ] **Task 2** (L2) — MAIC upload 前置 isSupportedFile 校验
- [ ] **Task 3** (L1) — 新增 model-catalog + upload-validation 不变量测试

## Phase 4: 审查结果

6 视角 review (auto mode, inline since changes <100 LOC source)。

### 视角矩阵

| 视角 | 结论 | 关键发现 |
|------|------|----------|
| 1. 架构 | ✓ | catalog 仍是静态 const；upload helper 抽到 `src/lib/maic/upload-validation.ts` 与 route 一致风格 |
| 2. 安全 | ✓ | 新校验为防御性收紧（拒绝未支持扩展名），无 secret，无注入面 |
| 3. 性能 | ✓ | upload 路径多一次 O(11) 数组 lookup，可忽略 |
| 4. 代码质量 | ✓ | TS 类型完整，`as const` + readonly，无 `any`，错误消息中文 |
| 5. 测试覆盖 | ✓ | model-catalog +3 测试 (gemini/xiaomi/lemonade) + upload-validation +4 测试；invariant_tests 全部 22/22 通过 |
| 6. 集成连续性 | ✓ | invariant 不变；新 export 全部消费；前 sprint artifact-cache/classroom-export/prepare-cache 未触；集成路径表 2/2 闭环 |

### Findings

- **P0**: none
- **P1**: `src/lib/maic/upload-validation.ts:1` 用 `../document-parser` 相对路径，而 `route.ts` 用 `@/lib/document-parser` 别名。cosmetic 风格不一致，不影响功能，记入未来重构窗口
- **P2**: `model-catalog.ts` lemonade `Gemma-4-26B-A4B-it-GGUF` 不含 `supportsThinking` 字段，与上游 providers.ts 当前状态一致；待 OpenMAIC 后续若公布 thinking 控制再补

### 第 6 视角详情

- **回归扫描**：`OPENMAIC_LATEST_MODEL_NOTES` 仍以 provider/model 唯一键；`getModelCapabilityProfile` 对历史 entry (deepseek-v4/openai gpt-5.5/etc) 行为字节级不变；老测试 case `categorizeModelName('Qwen3.5-4B-GGUF')` 仍走 reasoning patterns（不依赖 NOTES 项是否存在），通过
- **dead code 扫描**：新增 `MAIC_SUPPORTED_EXTENSIONS`, `isMaicSupportedFile` 双消费方（route + test）；`upload-validation.test.mjs` 覆盖 4 个分支；无 dead export
- **前 sprint invariant**：
  - 文件结构（mirofish 服务层、API 薄包装）✓ 沿用
  - 数值上下限、filename 消毒（mirofish-patterns.md）✓ 未触 mirofish
  - 缓存 identity 策略（[[2026-05-14-mirofish-openmaic-cache-optimization]]）✓ 未触
  - 课堂 quiz state / completion panel（[[2026-05-08-mirofish-openmaic-latest-parity]]）✓ 未触
- **中间状态**：上传被拒返回 400 + 中文消息，客户端立即可见；catalog 同步立即体现在所有读 NOTES 的位置
- **半下沉漂移**：无新 shared 边界

### Auto mode 决策

- 无 P0 → 自动进入 Phase 5
- P1 仅 1 项 cosmetic → 跳过 confirmation
- 第 6 视角无 BLOCKED → 不触发强制 manual gate

→ ✓ auto: phase 4 → 5

## Phase 5: 复利记录

### 沉淀去向

- **Solution doc**: `docs/solutions/2026-05-25-mirofish-openmaic-latest-parity-v2.md`（含取源切换、分类决策表、defer 跟踪三个 prevention 规则）
- **不变量测试**：`src/lib/model-catalog.test.mjs` 新增 3 个按 upstream commit hash 命名的 case；`src/lib/maic/upload-validation.test.mjs` 4 个 case
- **frontmatter `deferred:`**: 3 个未落地议题（Brave/Baidu search、video pipeline、classroom zip）已带 deadline 2026-08-01

### 关键经验（写入 prevention）

1. 取源方式应在 sprint 启动时通过 AskUserQuestion 三选一固化（local clone / WebFetch API / 用户给定 commit），避免 Phase 2 阻塞等环境
2. 上游 commit 与本地子系统映射应做成显式表，skip 与 defer 必须区分；defer 必须有 deadline，超 3 sprint 撤回
3. catalog 类静态参考表新增不变量测试时，测试名带上游 commit hash 便于追溯
4. MAIC upload 等所有进入 `parseSlides` 的路径，扩展名校验必须经过 `src/lib/maic/upload-validation.ts` 单一来源，不在 route 内 inline

### 信号采集（自学习）

- 重复工具序列：`gh api commits` × 多条 commit + `WebFetch raw.githubusercontent.com` → 可演进为"upstream diff over API"小工具
- 用户反馈：明确拒绝盲目移植，要求"逐项分类决策"——下次 sprint 启动默认提供分类决策表 template
- 退化检测：本 sprint 全程未触发，无 checkpoint
