---
title: "MAIC TTS 朗读被事件流打断"
date: 2026-04-25
tags: [solution, maic, tts, classroom]
related_instincts: [maic-tts-queue-before-cancel]
aliases: ["TTS 朗读半句跳转", "speechSynthesis cancel 打断"]
---

# MAIC TTS 朗读被事件流打断

## Problem
课堂 TTS 正在朗读时，下一条 SSE 发言到达会让当前语音只读半句就切到下一句，页面节奏也跟着向前跳。

## Root Cause
前端 `latestUtterance` effect 在每次发言变化时执行 `speechSynthesis.cancel()`，而后端课堂循环默认约 1.2 秒推进一次。浏览器 TTS 还没读完，新的发言和 slide change 已经到达，于是当前朗读被硬停。

## Solution
在 `OpenMaicClassroom` 内维护 TTS queue：非学生发言只入队，不直接取消当前语音。队列播放期间自动暂停课堂循环，读完后自动恢复；用户手动暂停、跳页、重播或关闭 TTS 时再取消当前朗读。

## Prevention
事件流驱动的音频播放要区分“新内容排队”和“用户明确接管”。除关闭、暂停、跳页、重播等显式操作外，不要在数据更新 effect 里调用硬取消 API。

## Related
- [[maic-tts-queue-before-cancel]] — TTS 播放节奏必须由队列控制
- [[session-2026-04-25]] — MAIC TTS pacing sprint
