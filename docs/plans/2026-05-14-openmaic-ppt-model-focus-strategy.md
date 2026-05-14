---
title: "OpenMAIC PPT Model Focus Strategy"
type: sprint
status: completed
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, openmaic, maic, ppt, focus, model-strategy]
aliases: ["OpenMAIC PPT 模型重点解析"]
---

# OpenMAIC PPT Model Focus Strategy

## Phase 1: Think

### 强制需求

用户进一步澄清: PPT 重点不是固定取第一个要点,而是需要通过模型判断解析。这是复杂策略,必须发生在课程准备/场景生成链路中,而不是 UI 播放时临时猜测。

### 保真约束

- 模型策略是主路径;确定性 key point 顺序只能作为模型失败时的 fallback。
- 重点策略必须映射到稳定 slide element id,保证播放端能真实定位。
- 保持旧 artifacts 可用;缺少模型 focus plan 时仍可用 fallback/hydration。
- 不破坏原有 lecture script、active questions、scene actions、缓存流程。

## Phase 2: Plan

1. 类型层增加 `SlideFocusPlan` / `SlideFocusTarget` / focus source 元数据。
2. prepare pipeline 增加 `generateSlideFocusPlans()` 模型判定阶段。
3. `buildCourseStage()` 消费模型 focus plan,替代“第一个 key point”启发式。
4. 增加回归测试、缓存版本升级和本地规则沉淀。

## Phase 3: Work

- `src/lib/maic/types.ts`
  - 新增 `SlideFocusPlan`, `SlideFocusTarget`, `FocusSource`。
  - `CoursePrepared` 持久化 `focus_plans`。
  - `SceneAction` 带上 `focusSource`, `focusReason`, `focusConfidence`。
- `src/lib/maic/pipeline/plan-stage.ts`
  - 新增 `FOCUS_PROMPT` 和 `generateSlideFocusPlans()`。
  - 模型在候选 description/key point 中选择 primary/secondary 重点。
  - `buildCourseStage()` 使用 `options.focusPlans` 生成 spotlight/laser。
- `src/lib/maic/pipeline/prepare-runner.ts`
  - 在 active questions 后增加 `prepare:focus` 阶段。
  - 将 `focus_plans` 写入 prepared artifact。
- `src/app/maic/prepare/[courseId]/page.tsx`
  - 准备页显示“解析重点悬停”阶段。
- `src/lib/maic/prepare-cache.ts`
  - 缓存版本升级到 `maic-prepared-v2`,避免旧缓存跳过模型重点解析。

## Phase 4: Review

### 验收点

- 模型可选择第二个或任意候选元素作为 spotlight,不再被 key point 顺序限制。
- scene action 记录模型来源、原因和置信度。
- 模型失败时 fallback 仍保持原课堂可播放。
- 旧 prepared 缺 `focus_plans` 时不会崩溃。

## Phase 5: Compound

- Solution: `docs/solutions/2026-05-14-openmaic-ppt-model-focus-strategy.md`
- Architecture rule: `.codex/rules/architecture.md` -> `OpenMAIC PPT Focus Is Model-Derived`
- Skill signal: `.codex/skill-signals/sprint.jsonl` -> `2026-05-14 OpenMAIC PPT model focus strategy`
