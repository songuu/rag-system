---
title: "MAIC TTS 朗读节奏修复"
type: sprint
status: completed
created: "2026-04-25"
updated: "2026-04-25"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, bugfix, maic, tts]
aliases: ["MAIC TTS pacing"]
---

# MAIC TTS 朗读节奏修复

## 需求分析

用户反馈课堂 TTS 正在朗读时会被明显打断，表现为一句话只读到一半就跳到下一句或下一页。成功标准是：新发言到达时不硬切当前语音，课堂推进节奏与 TTS 播放保持一致，用户手动暂停/跳页/重播时仍能立即接管。

## 技术方案

- 将当前单句 `speechSynthesis.cancel() + speak()` 改为前端 TTS 队列。
- TTS 开启且课堂运行时，朗读期间自动发送 `pause`，队列读完后自动 `resume`。
- 记录用户手动暂停意图，避免 TTS 自动恢复覆盖用户操作。
- 用户跳页、重播或手动暂停时清空 TTS 队列并停止当前朗读。

## 任务拆解

- [x] T1 定位 TTS 打断根因与课堂推进间隔。
- [x] T2 实现 TTS 队列、自动暂停/恢复和手动控制保护。
- [x] T3 定向验证 lint、类型过滤和已有顺序回归测试。
- [x] T4 Review + Compound。

## 变更日志

### 2026-04-25

- 定位到 `latestUtterance` effect 每次更新都会 `speechSynthesis.cancel()`，导致浏览器朗读被下一条 SSE 发言硬截断。
- `OpenMaicClassroom` 新增 TTS queue：非学生发言入队，按顺序调用浏览器 TTS。
- TTS 朗读期间自动 `pause` 课堂循环，队列清空后自动 `resume`；用户手动暂停、跳页、重播会停止当前朗读并清空队列。
- 加入 TTS run id 防护，避免旧的异步朗读循环在用户接管后继续改写状态。

## 审查结果

- 局部 ESLint：`src/components/maic/OpenMaicClassroom.tsx` 通过。
- 局部 TypeScript：`tsc --noEmit` 输出中过滤 MAIC 相关路径后无错误。
- 回归测试：`node --experimental-strip-types --test src/lib/maic/pipeline/page-order.test.mjs` 通过。
- 全量 `tsc --noEmit` 仍受既有非 MAIC 历史问题影响，本轮继续采用 MAIC 路径过滤验证。

## 复利记录

- 解决方案：`docs/solutions/2026-04-25-maic-tts-pacing.md`
- 调试踩坑：`.codex/rules/debugging-gotchas.md`
- Skill 信号：`.codex/skill-signals/sprint.jsonl`、`.codex/skill-signals/vercel-react-best-practices.jsonl`、`.codex/skill-signals/test-strategy.jsonl`
