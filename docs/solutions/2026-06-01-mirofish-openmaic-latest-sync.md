---
title: "MiroFish/OpenMAIC latest sync without over-migrating upstream"
date: 2026-06-01
tags: [solution, mirofish, openmaic, parity, maic]
related_instincts: []
aliases: ["MiroFish OpenMAIC latest sync 2026-06-01"]
---

# MiroFish/OpenMAIC latest sync without over-migrating upstream

## Problem

用户要求把 MiroFish 和 OpenMAIC 更新到最新。MiroFish 实际没有新 commit；OpenMAIC 有 12 个新 commit，但多数落在本项目没有的 editor、ASR、media export、docs site 子系统上。

## Root Cause

上游 parity 不能按“commit 数量”机械搬迁。两个项目的架构边界不同：本项目的 MAIC 是 `Course -> Prepared -> Scene -> Action` 轻量课堂运行时，而 OpenMAIC 最新主线正在建设 full editor、media generation、offline zip/resource pack。

## Solution

1. **先真实核对 HEAD**：
   - MiroFish HEAD: `96096ea0ff42b1a30cbc41a1560b8c91090f9968`，与 2026-05-25 sprint 相同，无新提交。
   - OpenMAIC HEAD: `ea049417cd2ce302f6b0602f8ec6284c9bdd994e`，2026-05-25 后新增 12 个 commit。

2. **采用本地可闭环的 4 个更新**：
   - `src/lib/maic/agents/manager-agent.ts`：history summary 改成 `[Student (Human)]` / `[Agent:<role>]`，并把 director prompt 的“不要误判未回答学生问题”规则映射到本地 manager prompt。
   - `src/lib/maic/types.ts` + `src/lib/maic/pipeline/read-stage.ts`：新增 `pt-BR` 课堂内容语言指令，默认 `zh-CN` 不变。
   - `src/lib/model-catalog.ts`：记录 OpenMAIC Azure STT Fast Transcription 为 documented audio capability，不引入 runtime ASR 依赖。
   - `src/lib/model-config.ts`：把 Lemonade 默认模型从已被上游弱化的 `Qwen3.5-4B-GGUF` 对齐到 `Gemma-4-26B-A4B-it-GGUF`。

3. **显式 defer 大型子系统**：
   - MAIC Editor v0 slide surface。
   - Offline classroom asset inlining/zip/resource pack。
   - Azure STT runtime adapter。
   - Interactive outline mediaGeneration snippets。

## Verification

- 4 个 targeted `node --experimental-strip-types --test` 文件全部通过。
- Scoped ESLint 通过。
- `pnpm exec tsc --noEmit --pretty false` 通过。

## Prevention

- 对 fast-moving upstream，先用 commit 分类表区分 `adopt / partial adopt / defer / skip`，再写代码。
- “上游有更新”不等于“两边都有本地可落地更新”：MiroFish 本轮无 delta，应明确 no-op，避免伪同步。
- Provider/media/editor 类能力先记录 capability 或 defer；只有本地存在对应 runtime boundary 时才接入运行时。

## Related

- [[2026-05-25-mirofish-openmaic-latest-parity-v2]]
- [[2026-05-08-mirofish-openmaic-latest-parity]]
- [[2026-05-11-openmaic-main-provider-export-sync]]
