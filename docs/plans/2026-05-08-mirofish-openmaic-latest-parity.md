---
title: "MiroFish 与 OpenMAIC 最新能力保真升级"
type: sprint
status: completed
created: "2026-05-08"
updated: "2026-05-08"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, mirofish, openmaic, parity]
aliases: ["MiroFish/OpenMAIC latest parity"]
---

# MiroFish 与 OpenMAIC 最新能力保真升级

## 需求分析

用户要求针对当前 MiroFish 和 OpenMAIC 最新升级，对本项目做更新和优化，并且必须保证功能完全一致。

### 外部依据

- MiroFish: GitHub `666ghj/MiroFish` 最新 release 为 `v0.1.2`，README 当前强调 5 步工作流：Graph Building、Environment Setup、Simulation、Report Generation、Deep Interaction。
- MiroFish main 在 `v0.1.2` 后有一批 i18n、安全依赖、本体命名规范相关提交；公开 roadmap 还明确了 prompt layer、Auth/Input validation、async execution、AGPL 边界等生产化方向。
- OpenMAIC: GitHub `THU-MAIC/OpenMAIC` 最新 release 为 `v0.2.1`，核心更新包含 VoxCPM2 TTS、per-model thinking、完成页与持久测验状态、最新模型注册、首页搜索、语言指令统一、条件化 media prompt、prompt markdown 模板化。

### 本项目边界

- 不全量迁入上游仓库，不改变本项目现有 Next.js/RAG/内存存储架构。
- MiroFish 仍保持当前 5 步工作流：项目 -> 图谱 -> 人设 -> 模拟 -> 报告 -> 深度交互。
- OpenMAIC 仍保持当前 Stage/Scene/Action/Roundtable 课堂体验，不把本地实现替换成上游完整应用。
- 优先落地能提高稳定性、质量和一致性且不会破坏现有使用方式的更新。

### 保真验收标准

- 旧入口、API 路径、数据结构字段保持兼容，新增字段必须可选或有 fallback。
- MiroFish 模拟仍能使用既有 `EntityProfile`、`SimulationConfig`、SSE 事件和报告流程。
- OpenMAIC 已准备课程仍能通过 `deriveScenes()` fallback 播放。
- 不引入必须配置的新外部服务，不要求用户新增 API key。
- 验证聚焦本次改动路径，避免被历史 repo-wide 噪音误判。

## 技术方案

### MiroFish

- 为 `EntityProfile` 增加可选 `behavioral_anchors`，让 profile prompt 引导生成 posting style、active hours、stance、drift、influence 等行为锚点。
- 将行为锚点注入模拟决策 prompt 与采访 prompt；没有锚点时保持旧行为。
- 强化 ontology 后处理：实体类型归一化为 PascalCase，关系类型归一化为 SCREAMING_SNAKE_CASE，并同步修正 `source_targets`，过滤系统保留属性名。
- 增加聚焦单元测试覆盖 ontology 归一化与行为锚点 fallback。

### OpenMAIC

- 在 Read/Plan pipeline 中引入统一 language directive，默认仍是中文输出，避免 outline/scene/script 语言漂移。
- 将 scene 构建能力开关显式化，默认能力与当前行为完全一致；未来关闭某能力时才从生成结果中移除。
- 课堂测验答案按 `courseId` 写入 localStorage，刷新或返回课堂后恢复答题/讲评状态。
- 增加课程完成摘要视图：课堂结束后显示测验分数、场景类型统计、学习进度，并保留继续回看能力。

## 任务拆解

- [x] T1 创建 sprint 文档，冻结外部依据、范围、验收标准。
- [x] T2 MiroFish: 行为锚点类型、prompt、模拟与采访注入。
- [x] T3 MiroFish: ontology 命名/属性归一化与测试。
- [x] T4 OpenMAIC: language directive 与 scene capability 兼容升级。
- [x] T5 OpenMAIC: quiz 持久化与完成页。
- [x] T6 验证、审查、compound 沉淀。

## 变更日志

### 2026-05-08

- 创建 sprint 主文档，进入 Work 阶段。
- MiroFish:
  - `EntityProfile` 新增可选 `behavioral_anchors`。
  - `profile-generator` prompt 增加 posting style、active hours、stance、drift、influence 行为锚点。
  - `simulation-engine` 与 `interaction-agent` 注入行为锚点；旧 profile 无该字段时保持原 fallback。
  - `ontology-generator` 增加实体 PascalCase、关系 SCREAMING_SNAKE_CASE、保留属性名过滤。
- OpenMAIC:
  - `read-stage` / `plan-stage` 引入统一 language directive，默认中文输出。
  - `buildCourseStage` 增加默认全开的 scene capability flags。
  - `OpenMaicClassroom` 按 `courseId` 持久化 quiz answers，并在课堂结束时展示完成摘要。
- 测试:
  - 新增 `src/lib/mirofish/ontology-generator.test.mjs`。
  - 新增 `src/lib/maic/pipeline/stage-options.test.mjs`。

## 审查结果

- Scoped ESLint: passed.
  - `pnpm exec eslint src/lib/mirofish/types.ts src/lib/mirofish/profile-generator.ts src/lib/mirofish/simulation-engine.ts src/lib/mirofish/interaction-agent.ts src/lib/mirofish/ontology-generator.ts src/lib/mirofish/ontology-generator.test.mjs src/lib/maic/types.ts src/lib/maic/pipeline/read-stage.ts src/lib/maic/pipeline/plan-stage.ts src/lib/maic/pipeline/stage-options.test.mjs src/components/maic/OpenMaicClassroom.tsx`
- Targeted tests: passed.
  - `node src\lib\mirofish\ontology-generator.test.mjs`
  - `node src\lib\maic\pipeline\stage-options.test.mjs`
  - `node src\lib\maic\pipeline\page-order.test.mjs`
  - `node src\lib\maic\prepare-cache.test.mjs`
- Full TypeScript: failed on pre-existing unrelated debt.
  - Command: `npx tsc --noEmit`
  - Current blockers include `.next/*/validator.ts` traces route handler params, `src/app/api/ask/route.ts`, `src/app/api/trace-trie/route.ts`, d3 typing gaps in older MiroFish pages, reasoning-rag type drift, LangGraph typing drift, and other historical modules.
  - After fixing this sprint's two caught issues, changed files no longer appear in the full TypeScript error list.
- Test runner note:
  - `node --test <multiple files>` failed with sandbox `spawn EPERM`; rerunning each test file directly with `node path\to\test.mjs` passed.

## 复利记录

- Solution: `docs/solutions/2026-05-08-mirofish-openmaic-latest-parity.md`
- Architecture rule: `.codex/rules/architecture.md`
- Testing pattern: `.codex/rules/testing-patterns.md`
- Skill signal: `.codex/skill-signals/sprint.jsonl`
