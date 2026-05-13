---
title: "MiroFish/OpenMAIC 最新能力保真吸收"
date: 2026-05-08
tags: [solution, mirofish, openmaic, parity, nextjs]
related_instincts: []
aliases: ["MiroFish OpenMAIC latest parity"]
---

# MiroFish/OpenMAIC 最新能力保真吸收

## Problem

需要跟进 MiroFish 与 OpenMAIC 的最新能力，但当前项目已经有自己的 Next.js/RAG/MiroFish/MAIC 运行时。直接搬上游会破坏既有入口、存量课程、内存存储和本地 fallback 行为。

## Root Cause

两个上游项目的更新方向不完全相同：

- MiroFish 最新公开信号更偏生产化和模拟质量：本体命名规范、prompt layer 行为锚点、采访真实感、输入校验、安全边界。
- OpenMAIC v0.2.x 更偏课堂体验与生成质量：Stage/Scene/Action、语言指令统一、完成页、测验状态持久化、条件化能力 prompt。

本项目最需要的是保真吸收这些“稳定性/质量/兼容性”能力，而不是重写成本高、风险高的上游全量迁移。

## Solution

- MiroFish:
  - `EntityProfile` 新增可选 `behavioral_anchors`。
  - profile prompt 生成 posting style、active hours、stance、drift、influence。
  - simulation/interview prompt 注入行为锚点；旧 profile 没有字段时继续使用旧行为。
  - ontology 后处理归一化实体 PascalCase、关系 SCREAMING_SNAKE_CASE，并过滤系统保留属性名。

- OpenMAIC:
  - Read/Plan prompt 统一走 `buildLanguageDirective()`，默认中文，避免生成阶段语言漂移。
  - Stage scene builder 增加默认全开的 capability flags，支持未来条件化关闭 quiz/interactive/PBL/whiteboard。
  - 课堂 quiz answer 写入 course-scoped localStorage，刷新后保留答题与讲评状态。
  - 课堂结束后显示 completion panel，展示 quiz score、已答题数、scene 数与 scene type 数。

## Verification

- `node src\\lib\\mirofish\\ontology-generator.test.mjs` passed.
- `node src\\lib\\maic\\pipeline\\stage-options.test.mjs` passed.
- `node src\\lib\\maic\\pipeline\\page-order.test.mjs` passed.
- `node src\\lib\\maic\\prepare-cache.test.mjs` passed.
- Scoped ESLint for all changed source/test files passed.
- Full `npx tsc --noEmit` still fails on unrelated historical debt in traces, ask, trace-trie, d3 pages, reasoning-rag, LangGraph typings, and other pre-existing modules; this sprint introduced no remaining TypeScript errors in changed files.

## Prevention

For future upstream parity work, classify each upstream change as:

- Runtime contract change: only adopt if the local persisted artifacts can migrate or fallback.
- Prompt/output quality change: prefer prompt refinement and post-processing guard.
- UI experience change: add as optional state or panel; keep existing workflow visible.
- Dependency/service change: do not make it mandatory unless the project already has a matching configuration path.
