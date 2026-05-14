---
title: "MAIC 上传解析缓存与 OpenMAIC v0.2.1 轻量对齐"
date: 2026-04-28
tags: [solution, maic, performance, openmaic]
related_instincts: [maic-cache-before-expensive-stage]
aliases: ["MAIC parsed slides cache", "OpenMAIC v0.2.1 parity"]
---

# MAIC 上传解析缓存与 OpenMAIC v0.2.1 轻量对齐

## Problem

OpenMAIC v0.2.1 新增课程发现、完成页、测验持久化和 Deep-Interactive 标识等用户可见能力；本地 `/maic` 同时存在重复上传同一 PDF 时解析仍然偏慢的问题。

## Root Cause

原有缓存覆盖的是 LLM 准备产物，上传阶段仍会每次完整执行文档解析。PDF 解析还在 `getText()` 之后额外调用 `getInfo()`，增加了首个响应前的阻塞时间。

## Solution

- 新增 `src/lib/maic/parsed-slides-cache.ts`，以文件内容 hash 缓存 `ParsedSlides`。
- `POST /api/maic/upload` 先查解析缓存，命中后直接进入 prepared cache/RAG mirror。
- PDF 解析复用 `pdf-parse` 的 `TextResult.total`，不再额外调用 `getInfo()`。
- `/maic` 首页增加搜索和精选课程；课程 API 返回 `scene_types`，卡片展示 Deep-Interactive 标识。
- 课堂结束页展示得分和场景统计，quiz answers 通过 `localStorage` 持久化。

## Prevention

遇到“准备流程已有缓存但入口仍慢”的问题时，按阶段拆开看：上传解析、RAG mirror、LLM 准备、播放初始化分别测量和缓存。不要只缓存最后的 LLM 产物。

## Related

- [[maic-cache-before-expensive-stage]] — 昂贵流水线要在最早可复用阶段建立缓存
- [[session-2026-04-28]] — OpenMAIC v0.2.1 对齐与解析优化
