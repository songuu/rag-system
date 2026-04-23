---
title: "MAIC 准备进度页面顺序回退"
date: 2026-04-23
tags: [solution, maic, pipeline, concurrency]
related_instincts: [maic-page-progress-monotonic]
aliases: ["prepare describe 顺序错乱", "页面解析回到第一页"]
---

# MAIC 准备进度页面顺序回退

## Problem
准备课程时实时事件会出现第 3 页先完成，随后又显示第 1 页，导致用户误以为解析顺序倒退。

## Root Cause
`describePages` 和 `generateLectureScript` 按 4 页一组并发调用 LLM，并在每个 worker 完成时立即触发 `onPage`。LLM 返回顺序不稳定，所以事件顺序不等于幻灯片顺序。

## Solution
新增 `mapPagesWithOrderedCallbacks`：保留批内并发，但先收集批处理结果，再按 batch index 发出回调。这样计算仍可并发，`prepare:describe` 和 `prepare:script` 的外部进度保持单调递增。

## Prevention
涉及用户可见进度、游标、事件流的并发处理，要用乱序完成的 fake worker 做回归测试，验证回调顺序和进度单调性。

## Related
- [[maic-page-progress-monotonic]] — 用户可见页面进度必须和课程页序一致
- [[session-2026-04-23]] — OpenMAIC classroom parity 后续修复
