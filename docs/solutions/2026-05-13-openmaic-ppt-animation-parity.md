# OpenMAIC PPT Animation Parity

## Problem

本地 MAIC 课堂已有 Stage/Scene/Action 结构,但 PPT 部分只把页面当作静态文本幻灯片。对齐 OpenMAIC 最新实现时,如果直接迁入官方 PPTist canvas/editor 会扩大风险,还会破坏当前课程准备、缓存和课堂会话边界。

## Root Cause

官方 OpenMAIC 的动画能力分两层:

- slide 数据层: `PPTAnimation`, `TurningMode`, element-level `animations`
- 播放层: `ActionEngine` / `PlaybackEngine` 直接消费 scene actions,其中 `spotlight` / `laser` 是 fire-and-forget 视觉效果,speech/whiteboard/video/discussion 是同步动作

本仓库缺的是这些数据语义和播放端渲染桥,不是完整 PPT 编辑器。

## Solution

- 在 `src/lib/maic/types.ts` 增加可选 `PPTAnimation`, `TurningMode`, `SlidePage.animations`, `SceneAction.animation` 及官方 action 字段。
- 在 `src/lib/maic/pptx-parser.ts` 增加轻量 PPTX ZIP/XML 读取,提取 slide 文本与 `p:timing` 动画元数据。
- 在 `src/lib/maic/slide-animation.ts` 统一生成稳定 slide element id 与默认动画。
- 在 `src/lib/maic/pipeline/plan-stage.ts` 将 PPT 动画映射到 spotlight/laser/speech/whiteboard actions。
- 在 `src/components/maic/OpenMaicClassroom.tsx` 用 scene actions 驱动聚光、激光和元素入场动画,旧 artifacts 缺动画时 runtime hydration 自动补默认 metadata。

## Verification

- `node src\lib\maic\pptx-parser.test.mjs`
- `node src\lib\maic\pipeline\stage-options.test.mjs`
- `node src\lib\maic\pipeline\page-order.test.mjs`
- `node src\lib\maic\prepare-cache.test.mjs`
- scoped `pnpm exec eslint ...`
- `git diff --check`
- `npx tsc --noEmit` 仍失败于 repo 既有历史债务,本次 MAIC/PPT 改动文件未进入错误集。

## Prevention

以后对齐 OpenMAIC PPT 能力时,先检查官方 `lib/types/slides.ts`, `lib/types/action.ts`, `lib/playback/engine.ts`, `components/slide-renderer/Editor/*Overlay.tsx` 的语义变化,再映射成本仓库的 optional metadata 和播放桥。只有在明确需要编辑器级 parity 时才考虑引入完整 PPTist canvas。
