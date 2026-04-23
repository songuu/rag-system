---
title: "OpenMAIC 课堂体验对齐"
type: sprint
status: completed
created: "2026-04-23"
updated: "2026-04-23"
checkpoints: 0
tasks_total: 7
tasks_completed: 7
tags: [sprint, feature, maic, openmaic]
aliases: ["OpenMAIC parity"]
---

# OpenMAIC 课堂体验对齐

## 需求分析

用户反馈当前 `/maic` 功能过于简单，与真实 OpenMAIC classroom 页面差距很大。对齐目标不再是简单的“幻灯片 + 聊天”，而是尽量靠近 OpenMAIC 的 Stage 播放体验：

- Stage / Scene 结构：slides、quiz、interactive simulation、online programming、PBL。
- Action Engine 体验：speech、spotlight、laser、whiteboard、discussion、widget action。
- 多智能体圆桌：teacher、TA、classmates 可见，支持 continuous / interactive。
- 课堂控制：播放/暂停、上一页/下一页、重播、白板、TTS、导出。
- 课程准备产物：Read/Plan 后生成 OpenMAIC 风格的 `stage`、`scenes`、`actions`，而不是只生成讲课脚本。

## 技术方案

- 保留本项目现有 `src/lib/maic` 独立模块，不把上游 OpenMAIC 全量迁入，避免依赖爆炸。
- 在 `CoursePrepared` 中新增 `stage` 与 `scenes`，前端优先使用服务端准备好的场景，旧课程缺字段时客户端降级生成 fallback scenes。
- 在 `plan-stage` 增加确定性 `buildCourseStage`，把 pages、knowledge tree、active questions 转换为 slides/quiz/interactive/code/PBL 场景。
- 扩展课堂控制 API：`pause`、`resume`、`restart`、`navigate`。
- 用新的 `OpenMaicClassroom` 组件替换原课堂页，提供接近 OpenMAIC 的 stage/sidebar/canvas/action timeline/roundtable/chat/whiteboard 体验。

## 任务拆解

- [x] T1 调研真实 OpenMAIC README 与源码结构，确认 Stage、Action、Playback、Scene 类型能力。
- [x] T2 扩展 MAIC 类型：`CourseScene`、`SceneAction`、`CourseStage`、Quiz/PBL/Interactive 数据。
- [x] T3 课程准备流水线生成 OpenMAIC 风格 stage/scenes/actions。
- [x] T4 课堂运行时新增暂停/继续/重播/跳页控制，并修复 classmate 插话重复卡游标风险。
- [x] T5 重做课堂 UI 为 Stage/Scene/Roundtable/Whiteboard 结构。
- [x] T6 类型检查、Lint、核心路径回归。
- [x] T7 Review + Compound。

## 变更日志

### 2026-04-23

- 新增 `CoursePrepared.stage` 与 `CoursePrepared.scenes`。
- 新增 `buildCourseStage()`，从已解析页面生成 slides、quiz、interactive/code、PBL 场景。
- `prepare-runner` 增加 `prepare:scenes` 事件。
- `SessionController` 新增 `pause/resume/navigateTo/restart` 控制能力。
- `manager-agent` 避免同一脚本 cursor 处 classmate 插话无限重复。
- `/maic/classroom/[courseId]` 改为使用 `OpenMaicClassroom`。

## 审查结果

- 局部 ESLint：通过，覆盖本轮 MAIC 改动文件。
- 局部 TypeScript：`tsc --noEmit` 输出中过滤 MAIC 改动路径后无错误。
- 全量 `tsc --noEmit`：失败，阻塞来自既有非 MAIC 模块，如 traces route params、ask/trace-trie、mirofish d3 类型、reasoning-rag 类型等。
- 全量 `pnpm lint`：失败，阻塞来自既有项目历史 lint 问题；临时 `.tmp-openmaic` 已清理，避免再污染 lint。
- P0 修复：`manager-agent` 增加最近 speaker guard，避免 classmate `Idle` 插话不推进 cursor 时重复触发。

## 复利记录

- 解决方案：`docs/solutions/2026-04-23-openmaic-stage-parity.md`
- 架构规则：`.codex/rules/architecture.md`
- 调试踩坑：`.codex/rules/debugging-gotchas.md`
- 测试模式：`.codex/rules/testing-patterns.md`
- Skill 信号：`.codex/skill-signals/sprint.jsonl`、`.codex/skill-signals/vercel-react-best-practices.jsonl`
