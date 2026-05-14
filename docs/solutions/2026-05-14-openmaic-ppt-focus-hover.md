# OpenMAIC PPT Focus Hover Playback

## Problem

PPT 动画对齐不能只做到“出现一个 spotlight/laser 动画”。用户要求的核心是播放过程中能像重点悬停一样持续强调目标元素: 重点不能闪一下就消失,也不能被后续讲解、白板或讨论动作顺手清掉。

## Root Cause

上一轮播放端只有一个 `stageEffect` 状态。所有 action 共用这一个状态后,短效 action 的 clear timer 会把 spotlight 一起清掉;后续 speech/whiteboard/discussion 也会覆盖 spotlight,导致重点无法驻留。

## Solution

- 类型层增加 `FocusHoldMode`、`SceneAction.focusHold`、`CourseSceneCapabilities.focusHover`。
- 课程生成层让 spotlight 默认 `focusHold: "until_next_focus"`,只有显式关闭 `focusHover` 才退回 duration 短效。
- 播放层拆分:
  - `stageEffect`: laser、speech、whiteboard、discussion 等 transient action。
  - `heldFocusEffect`: spotlight 重点驻留,直到下一个重点或 slide/scene 切换。
- 渲染层给 slide key point 增加 hover/focus 聚光,支持播放时用户主动悬停重点。
- 旧 prepared scene 在 runtime hydration 时补默认 spotlight 驻留语义,避免旧课程缺字段时降级。

## Verification

- `node src\lib\maic\pptx-parser.test.mjs`
- `node src\lib\maic\pipeline\stage-options.test.mjs`
- scoped `pnpm exec eslint ...`
- `git diff --check`

## Prevention

以后提到 PPT “动画”时,需要区分短效动作和驻留重点。OpenMAIC parity 在本仓库里必须保留这个播放语义: laser 可以短效,spotlight/focus hover 默认是 sticky focus,不能被非 focus action 清理。
