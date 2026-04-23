---
title: "OpenMAIC Stage 体验对齐"
date: 2026-04-23
tags: [solution, maic, openmaic, nextjs]
related_instincts: [instinct-openmaic-parity-scope]
aliases: ["OpenMAIC 课堂差距修复", "MAIC Stage 化"]
---

# OpenMAIC Stage 体验对齐

## Problem

当前 MAIC 课堂只有“幻灯片摘要 + 聊天流”，与真实 OpenMAIC 的 Stage/Scene/Action/Whiteboard/Roundtable 体验差距明显。

## Root Cause

第一版只实现了论文里的多 agent 讲课循环，没有把 OpenMAIC v0.2.0 的产品层抽象落进本项目：场景类型、动作引擎、播放控制、白板、测验、交互实验、PBL 都缺少统一的数据模型与 UI 承载。

## Solution

- 在 `CoursePrepared` 中加入 `CourseStage` 和 `CourseScene`，把 Read/Plan 产物升级为可播放的 Stage。
- 在 `plan-stage` 增加 `buildCourseStage()`，从页面描述、知识树、主动提问生成 slides/quiz/interactive/code/PBL 场景。
- 在 `SessionController` 和课堂 message API 增加 `pause/resume/restart/navigate` 控制。
- 用 `OpenMaicClassroom` 替换简版课堂页，提供 sidebar、stage canvas、action timeline、whiteboard、roundtable chat、TTS、HTML export。
- 修复 classmate 插话可能在同一 `script_cursor` 重复触发的风险。

## Prevention

以后实现外部产品对齐时，先抽象目标产品的“核心运行时模型”，再写 UI。OpenMAIC 类功能不能只按聊天页面实现，至少要先有 `Stage -> Scene -> Action -> Playback Control` 的主干。

## Related

- [[instinct-openmaic-parity-scope]] — 产品对齐要先抽目标运行时模型
- [[session-2026-04-23]] — 本轮 OpenMAIC parity sprint
