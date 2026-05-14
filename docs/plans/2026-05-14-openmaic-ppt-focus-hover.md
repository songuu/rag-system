---
title: "OpenMAIC PPT Focus Hover Playback"
type: sprint
status: completed
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, openmaic, maic, ppt, animation, focus-hover]
aliases: ["OpenMAIC PPT 重点悬停播放"]
---

# OpenMAIC PPT Focus Hover Playback

## Phase 1: Think

### 强制需求

用户明确澄清: PPT 播放时需要支持类似“重点悬停”的功能,并且这是强制需求。上一轮只实现了 spotlight/laser 的短暂播放效果,不满足“重点必须停留在目标元素上”的验收标准。

### 保真约束

- 保持当前 MAIC 课堂的 Stage/Scene/Action 结构,不迁入完整 PPTist editor。
- 保留原有 speech、discussion、whiteboard、laser 的播放行为。
- 重点悬停必须在 speech/whiteboard/discussion 等后续动作期间继续可见。
- 切换 slide/scene 时重点应自动清除,避免跨页残留。

## Phase 2: Plan

1. 增加 `focusHold` / `focusHover` 语义,让 spotlight 默认具备驻留行为。
2. 播放端拆分 transient stage effect 与 held focus effect。
3. slide key point 卡片增加真实 hover/focus 聚光,覆盖用户交互式“悬停”语义。
4. 增加回归测试和本地规则沉淀。

## Phase 3: Work

- `src/lib/maic/types.ts`
  - 新增 `FocusHoldMode`。
  - `SceneAction` 增加 `focusHold`。
  - `CourseSceneCapabilities` 增加 `focusHover`。
- `src/lib/maic/slide-animation.ts`
  - 新增 `getFocusHoldMode()` / `shouldHoldFocus()`。
  - `spotlight` 默认 `until_next_focus`,不再被当作纯短效 fire-and-forget。
- `src/lib/maic/pipeline/plan-stage.ts`
  - spotlight action 默认写入 `focusHold: "until_next_focus"`。
  - 显式 `focusHover: false` 时退回 duration 短效。
- `src/components/maic/OpenMaicClassroom.tsx`
  - 新增 `heldFocusEffect`,让重点驻留独立于 speech/whiteboard/discussion。
  - laser 等短动作仍按 duration 自动清理。
  - key point 支持鼠标 hover 和键盘 focus 时聚光。
  - 旧 prepared scene runtime hydration 默认补 spotlight 驻留语义。

## Phase 4: Review

### 验收点

- PPT 播放 spotlight 时重点停留到下一个重点或 slide/scene 切换。
- speech、discussion、whiteboard 不会自动清空重点悬停。
- laser 仍为短效动画,不改变现有视觉节奏。
- 鼠标悬停或键盘 focus key point 时立即进入重点悬停。

## Phase 5: Compound

- Solution: `docs/solutions/2026-05-14-openmaic-ppt-focus-hover.md`
- Architecture rule: `.codex/rules/architecture.md` -> `OpenMAIC PPT Focus Hover Is Sticky`
- Skill signal: `.codex/skill-signals/sprint.jsonl` -> `2026-05-14 OpenMAIC PPT focus hover`
