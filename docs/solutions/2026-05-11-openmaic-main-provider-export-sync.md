---
title: "OpenMAIC main provider and export parity"
date: 2026-05-11
tags: [solution, maic, openmaic, model-provider, export]
related_instincts: []
aliases: ["OpenMAIC main sync", "OpenRouter Lemonade export parity"]
---

# OpenMAIC main provider and export parity

## Problem

OpenMAIC v0.2.1 之后 main 分支继续增加 provider、thinking model metadata 和导出容错能力。本项目需要继续同步这些增量，但不能全量迁入上游 provider/media/settings 架构。

## Root Cause

本项目已有独立 `ModelFactory`、`/api/ollama/models` 和轻量 MAIC classroom/export 管线，适合承载 OpenAI-compatible LLM provider 与模型元数据；Bocha、HappyHorse、image/audio provider 等上游能力缺少本地抽象，直接搬运会产生未使用的大型结构。

## Solution

- 在 `src/lib/model-config.ts` 增加 OpenRouter 和 Lemonade provider，复用 OpenAI-compatible helper，并保留 Azure 使用 `AzureChatOpenAI` 专用类。
- 新增 `src/lib/model-catalog.ts`，集中维护 OpenMAIC 最新模型/provider 元数据和 thinking 控制提示。
- 更新 `src/app/api/ollama/models/route.ts`，把 latest model notes 暴露给模型列表 API，并用 catalog 判断本地/远程模型能力。
- 抽出 `src/lib/maic/classroom-export.ts`，让 HTML 导出逐 scene 容错：坏 scene 写入 skipped 占位并返回 warning，整份课堂继续导出。
- 增加纯函数测试覆盖 provider env、model catalog、Azure deployment 校验和导出容错。

## Prevention

同步上游 OpenMAIC 时先写增量矩阵，把每项变更归类为直接落地、轻量记录或明确不迁入。provider 类改动要区分真正 OpenAI-compatible 端点和 provider-specific SDK，例如 Azure 必须继续走 `AzureChatOpenAI`。

## Related

- [[session-2026-05-11]]
- [[2026-05-11-openmaic-main-sync]]
