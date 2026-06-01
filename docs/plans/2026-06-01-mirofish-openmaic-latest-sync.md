---
title: "MiroFish/OpenMAIC 2026-06-01 最新同步"
type: sprint
status: completed
created: "2026-06-01"
updated: "2026-06-01"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, mirofish, openmaic, parity, anti-drift]
aliases: ["MiroFish OpenMAIC latest sync 2026-06-01"]
upstream:
  mirofish: "https://github.com/666ghj/MiroFish"
  mirofish_head: "96096ea0ff42b1a30cbc41a1560b8c91090f9968"
  openmaic: "https://github.com/THU-MAIC/OpenMAIC"
  openmaic_head: "ea049417cd2ce302f6b0602f8ec6284c9bdd994e"
  window: "since 2026-05-25 parity sprint to 2026-06-01 HEAD"
invariants:
  - "MiroFish 当前 HEAD 仍为 96096ea，本轮不制造 MiroFish 伪更新"
  - "OPENMAIC_LATEST_MODEL_NOTES 仍是纯静态参考表，不引入运行时依赖或新 API key"
  - "MAIC Manager history 必须用结构化 speaker 标签区分 student/agent，不解析显示前缀"
  - "CourseGenerationLanguage 新语言必须只改 prompt directive，不改变默认 zh-CN 行为"
invariant_tests:
  - src/lib/model-catalog.test.mjs
  - src/lib/model-config.test.mjs
  - src/lib/maic/pipeline/stage-options.test.mjs
  - src/lib/maic/agents/manager-agent.test.mjs
deferred:
  - sprint: next
    item: "OpenMAIC MAIC Editor v0 slide-surface editing (47d2814)"
    deadline: "2026-08-15"
    reason: "本项目当前无编辑器 mode/scene-edit registry，直接搬会形成大型半成品 UI"
  - sprint: next
    item: "Offline classroom export asset inlining (86c8e0c)"
    deadline: "2026-08-15"
    reason: "本项目 classroom-export 目前只生成文本 HTML 且未接 UI；需要先决定 zip/resource pack 出口"
  - sprint: next
    item: "Azure STT runtime adapter (07115df)"
    deadline: "2026-08-15"
    reason: "本项目无 ASR pipeline，本轮只记录 catalog 能力，运行时接入需先建 audio/asr 边界"
  - sprint: next
    item: "Interactive outline mediaGeneration snippets (ea04941)"
    deadline: "2026-08-15"
    reason: "本项目无 image/video generation prompt path；需等本地 media pipeline 决策"
deadcode_until: []
---

# MiroFish/OpenMAIC 2026-06-01 最新同步

## Phase 1: 需求分析

用户要求：最新的 mirofish 和 openmaic 已经有更新，需要更新到最新。

### Scope

- 核对 `666ghj/MiroFish` 与 `THU-MAIC/OpenMAIC` 当前 HEAD。
- 沿用上次 parity 的分类矩阵：本地有对应子系统则 adopt；无对应子系统但值得后续建设则 defer；纯上游文档/CI/包内实现则 skip。
- 保持本项目 Next.js/RAG 架构、MiroFish 5 步工作流、OpenMAIC `Course -> Prepared -> Scene -> Action` 模型不变。

### Non-scope

- 不全量迁入 OpenMAIC app/editor/docs site。
- 不新增必填外部服务或 API key。
- 不触碰当前工作区已有 PDF parser/liteparse 改动。

### Success

- 上游最新 commit 全部分类。
- Adopt 项有回归测试。
- `pnpm exec tsc --noEmit --pretty false` 不新增类型错误。

## Phase 2: 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| MiroFish latest parity | 上游 diff 必须真实核对，不能凭用户描述假设 | clone 最新 HEAD 后确认无新 commit |
| OpenMAIC model catalog | 静态元数据，不引入运行时依赖 | Azure STT 仅 documented，不接 ASR runtime |
| OpenMAIC manager | 学生输入必须被 teacher/agent 实质性回应 | history summary 使用 `[Student (Human)]` / `[Agent:*]` 标签 |
| MAIC language directive | 默认中文输出不变 | pt-BR 只新增分支，默认仍 zh-CN |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| Lemonade default model 更新 | `loadEnvConfig()` 读取默认值 | `DEFAULT_LEMONADE_CONFIG` | 环境默认，无持久化 | 重启服务后生效 |
| Azure STT catalog note | 读取 `OPENMAIC_LATEST_MODEL_NOTES` | 静态 const | 编译进 bundle | 立即可见 |
| pt-BR 语言指令 | pipeline 传入 `language: "pt-BR"` | `buildLanguageDirective()` | prepared artifact 仍按现有 cache | 生成内容为巴西葡语 |
| Manager history labels | LLM fallback 调度 | `summarizeManagerHistory()` | session history 原结构不变 | SSE/课堂继续按原结构 |

### 上游 diff 分类

#### MiroFish

| commit | 日期 | 决策 | 依据 |
|--------|------|------|------|
| 96096ea | 2026-05-25 00:48 +0800 | no-op | 与 2026-05-25 parity sprint 已核对 HEAD 相同；`--since 2026-05-25 00:48:58 +0800` 无新提交 |

#### OpenMAIC commits since 2026-05-25

| commit | 简述 | 决策 | 本地落点 |
|--------|------|------|----------|
| e5148be | restore agent attribution in director summary | adopt | `manager-agent.ts` history 标签 + 测试 |
| 448c1e4 | add pt-BR locale | adopt | `CourseGenerationLanguage` + `buildLanguageDirective()` |
| 07115df | add Azure STT Fast Transcription | partial adopt | `model-catalog.ts` 记录 audio capability，runtime defer |
| b29efe1 carry-over | remove weak Lemonade recommended models | adopt gap | `DEFAULT_LEMONADE_CONFIG` 从 Qwen3.5 改为 Gemma-4 |
| 6d29bbe / 35d3690 | server provider key fallback/admin-managed providers | skip | 本项目模型配置已由 env/server 控制，无 client settings override |
| f064590 | orchestration maxTurns behavior | skip | 本项目 manager 已优先处理 `recentStudentMessage`，`MAX_LOOP_STEPS` 只是安全上限 |
| 86c8e0c | inline external assets for offline export | defer | 本项目 export 尚未接 zip/resource pack |
| 47d2814 | MAIC Editor v0 slide surface | defer | 大型 editor 子系统，本轮不做半成品迁入 |
| ea04941 | gate media snippets in interactive outline prompt | defer | 本项目无 image/video generation prompt path |
| 77bcd58 | Fumadocs docs site | skip | docs app 不映射本项目 |
| c0b7ea2 | pptxgenjs rollup ESM import | skip | 本项目无上游 packages/pptxgenjs |
| ebff58e | licensing email docs | skip | 文档联系信息不映射本项目 |

## Phase 3: Work

- [x] Task 1 (L1) — 同步 model catalog/defaults：Azure STT documented，Lemonade 默认 Gemma-4。
- [x] Task 2 (L1) — 新增 pt-BR 课堂内容语言指令，保持默认 zh-CN。
- [x] Task 3 (L2) — Manager history summary 使用结构化标签，防止把学生输入误判为 agent。
- [x] Task 4 (L2) — 补回归测试、lint、TypeScript 验证。

## Phase 4: Review

### 视角矩阵

| 视角 | 结论 | 说明 |
|------|------|------|
| 架构 | pass | 所有 adopt 都落在现有 lib 层；无新子系统半迁移 |
| 安全 | pass | 不新增 secret、fetch、外部 API 调用 |
| 性能 | pass | history summary 只处理最近 8 条 utterance |
| 代码质量 | pass | 新 helper 纯函数可测；默认值变更有测试覆盖 |
| 测试覆盖 | pass | 4 个 targeted node:test + scoped ESLint + full tsc |
| 集成连续性 | pass | MiroFish no-op；MAIC scene/action/cache 结构不变；deferred 有 deadline |

### Findings

- P0: none
- P1: none
- P2: `classroom-export.ts` 仍未接 UI/API，OpenMAIC offline export inlining 只能 defer；后续做 zip/resource pack 时再接。

## Phase 5: Compound

### Validation

- `node --experimental-strip-types --test src/lib/model-catalog.test.mjs` → pass (7/7)
- `node --experimental-strip-types --test src/lib/model-config.test.mjs` → pass (3/3)
- `node --experimental-strip-types --test src/lib/maic/pipeline/stage-options.test.mjs` → pass (6/6)
- `node --experimental-strip-types --test src/lib/maic/agents/manager-agent.test.mjs` → pass (2/2)
- `pnpm exec eslint src/lib/model-config.ts src/lib/model-catalog.ts src/lib/maic/types.ts src/lib/maic/pipeline/read-stage.ts src/lib/maic/agents/manager-agent.ts src/lib/maic/agents/manager-agent.test.mjs src/lib/model-config.test.mjs src/lib/model-catalog.test.mjs src/lib/maic/pipeline/stage-options.test.mjs` → pass
- `pnpm exec tsc --noEmit --pretty false` → pass

### 沉淀

- Solution: `docs/solutions/2026-06-01-mirofish-openmaic-latest-sync.md`
- Skill signals: sprint / test-strategy / compound

