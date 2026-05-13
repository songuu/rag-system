---
title: "OpenMAIC PPT Animation Parity"
type: sprint
status: completed
created: "2026-05-13"
updated: "2026-05-13"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, openmaic, maic, ppt, animation]
aliases: ["OpenMAIC PPT 动画对齐"]
---

# OpenMAIC PPT Animation Parity

## Phase 1: Think

### 需求分析

用户要求在当前 OpenMAIC/MAIC 模块中，PPT 部分按官方最新实现支持动画，并可直接参考官方实现。

### 官方参考

- 官方仓库: `https://github.com/THU-MAIC/OpenMAIC`
- 本轮对照主干: `b29efe1f1d67e5d2518208b181cd03d00622fea1` (`2026-05-13T13:35:46+08:00`)
- 关键实现:
  - `lib/types/action.ts`: fire-and-forget `spotlight` / `laser`, synchronous speech/whiteboard/video/discussion actions
  - `lib/playback/engine.ts`: scene actions 直接驱动播放, spotlight/laser 不阻塞, speech/whiteboard 等等待完成
  - `components/slide-renderer/Editor/SpotlightOverlay.tsx`: DOM 测量 + SVG mask 聚光
  - `components/slide-renderer/Editor/LaserOverlay.tsx`: 激光点飞入 + 呼吸光环
  - `lib/types/slides.ts`: `PPTAnimation`, `TurningMode`, slide `animations`

### 保真约束

- 不重写现有 MAIC 课堂运行时和多 agent 会话循环。
- 不破坏已有 PDF/MD/TXT/Word/JSON 上传与缓存行为。
- 新增动画字段必须 optional；旧 course/prepared artifacts 缺字段时行为保持一致。
- 官方完整 PPTist canvas/editor 不迁入本仓库；本仓库吸收兼容数据结构和课堂播放视觉语义。

## Phase 2: Plan

### 技术方案

1. 数据模型对齐
   - 增加 OpenMAIC 风格 `PPTAnimation` / `TurningMode`。
   - `SlidePage` 支持 `animations`、`turning_mode`。
   - `SceneAction` 支持 `elementId`、`dimOpacity`、`color`、`duration`、`trigger`、`animation` 等可选字段。

2. PPT 上传与解析
   - 让 MAIC upload 接受 `.pptx`。
   - 增加轻量 PPTX ZIP/XML 解析器,提取 slide 文本与 `p:timing` 动画元数据。
   - 对无显式动画的 PPT/文本页生成默认 `PPTAnimation` 序列,确保课堂端可播放。

3. 课程生成与播放
   - `buildCourseStage()` 把 slide page 动画映射到 scene actions。
   - 保持默认 capability 全开,旧调用签名不变。
   - 课堂端按 selected scene actions 播放 spotlight/laser/元素入场动画,并保留 legacy utterance effect fallback。

4. 验证与沉淀
   - 增加 parser/stage 回归测试。
   - scoped eslint + 相关 node 测试。
   - 记录官方对齐规则与 solution。

### 任务拆解

- [x] Task 1: 添加 PPTAnimation/turningMode/SceneAction 动画字段与 PPTX 上传入口
- [x] Task 2: 增加 PPTX 动画解析和默认动画生成
- [x] Task 3: 将动画映射到 scene actions 并在课堂 UI 渲染
- [x] Task 4: 回归测试、review、compound

## Phase 3: Work

### 变更日志

- `src/lib/maic/types.ts`
  - 新增 OpenMAIC/PPTist 风格 `PPTAnimation`, `AnimationType`, `AnimationTrigger`, `TurningMode`。
  - `SlidePage` 增加可选 `animations` / `turning_mode`。
  - `SceneAction` 增加可选 `elementId`, `dimOpacity`, `color`, `duration`, `trigger`, `animation`。
  - 扩展 action type 以容纳官方 `play_video`, `wb_*`, widget reveal/annotation 等动作。
- `src/lib/maic/pptx-parser.ts`
  - 新增轻量 ZIP central directory reader,用 Node `zlib` 解压 PPTX slide XML。
  - 提取 `<a:t>` 文本作为页内容。
  - 提取 `<p:timing>` 中的 `animEffect`/motion/scale/rot/set/cmd 动画为 `PPTAnimation`。
- `src/lib/maic/slide-animation.ts`
  - 新增稳定 slide element id 与默认动画生成。
- `src/lib/maic/slide-parser.ts`
  - `.pptx` 上传优先走 PPTX parser。
- `src/components/maic/UploadDropzone.tsx`
  - 上传入口和文案支持 `.pptx`。
- `src/lib/maic/pipeline/plan-stage.ts`
  - 将 PPTAnimation 映射到 scene actions 的 element target / duration / trigger。
  - `animations` capability 默认 true,显式 false 时不注入动画 metadata。
- `src/lib/maic/pipeline/prepare-runner.ts`
  - 保留 source page 的 animation/turning metadata,避免 prepare 阶段丢失。
- `src/lib/maic/prepare-cache.ts`
  - 显式 PPT animation metadata 进入 source hash,避免带动画 PPT 命中旧静态缓存。
- `src/components/maic/OpenMaicClassroom.tsx`
  - selected slide scene 按 actions 播放 speech/spotlight/laser/whiteboard/discussion effect schedule。
  - 聚光使用 DOM 测量 + SVG mask cutout；激光使用飞入点和呼吸光环。
  - 旧 prepared scene 缺动画字段时 runtime hydration 补默认 metadata。
- `src/app/globals.css`
  - 新增 MAIC PPT 动画 keyframes 与 laser/spotlight 样式。
- 测试:
  - 新增 `src/lib/maic/pptx-parser.test.mjs`。
  - 扩展 `src/lib/maic/pipeline/stage-options.test.mjs`。
  - 扩展 `src/lib/maic/prepare-cache.test.mjs`。

## Phase 4: Review

### 审查结果

- P0: 无。
- P1: 无。
- P2: 官方完整 PPTist editor/canvas 未迁入;本轮按当前仓库架构吸收数据语义和播放语义。若未来要求 editable canvas parity,需单独开架构 sprint。

### 验证

- `node src\lib\maic\pptx-parser.test.mjs` -> pass
- `node src\lib\maic\pipeline\stage-options.test.mjs` -> pass
- `node src\lib\maic\pipeline\page-order.test.mjs` -> pass
- `node src\lib\maic\prepare-cache.test.mjs` -> pass
- `pnpm exec eslint src/lib/maic/types.ts src/lib/maic/slide-animation.ts src/lib/maic/pptx-parser.ts src/lib/maic/pptx-parser.test.mjs src/lib/maic/slide-parser.ts src/lib/maic/prepare-cache.ts src/lib/maic/prepare-cache.test.mjs src/lib/maic/pipeline/plan-stage.ts src/lib/maic/pipeline/stage-options.test.mjs src/lib/maic/pipeline/prepare-runner.ts src/components/maic/OpenMaicClassroom.tsx src/components/maic/UploadDropzone.tsx` -> pass
- `git diff --check` -> pass,仅 Git CRLF warning
- `npx tsc --noEmit` -> fail on existing repo debt (`.next` trace routes, `api/ask`, `trace-trie`, MiroFish d3 typing, reasoning-rag type drift, model-config Azure fields, etc.);本次 MAIC/PPT 文件未进入错误集。

## Phase 5: Compound

### 复利记录

- Solution: `docs/solutions/2026-05-13-openmaic-ppt-animation-parity.md`
- Architecture rule: `.codex/rules/architecture.md` -> `OpenMAIC PPT Animation Parity`
- Skill signal: `.codex/skill-signals/sprint.jsonl` -> `2026-05-13 OpenMAIC PPT animation parity`
