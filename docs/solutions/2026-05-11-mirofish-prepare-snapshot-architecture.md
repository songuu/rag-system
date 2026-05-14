---
title: "MiroFish Prepare 与 Snapshot 架构优化"
date: 2026-05-11
tags: [solution, mirofish, multi-agent, nextjs, architecture]
related_instincts: [mirofish-prepare-snapshot-boundary]
aliases: ["MiroFish prepare snapshot", "MiroFish architecture optimization"]
---

# MiroFish Prepare 与 Snapshot 架构优化

## Problem

本地 MiroFish 已有 5 步工作流，但人设准备、模拟配置、运行快照和报告/交互读取分散在 UI、route handler 和 runner 中。`posts_per_round` 已出现在配置里，却没有真正约束执行层。

## Root Cause

第一版实现按页面步骤推进，缺少上游 MiroFish 最新 prepare/status 思路中的独立准备层和可恢复运行视图。配置归一化也散落在 API route 中，导致字段语义和资源上限难以测试。

## Solution

- 新增 `src/lib/mirofish/config-normalizer.ts`，集中归一化 `round_count`、`agents_per_round`、`posts_per_round`、platforms、topics 和 temperature。
- 新增 `src/lib/mirofish/prepare-service.ts`，提供幂等 prepare：`project + graphNodes + selectedEntityIds + config + profiles -> prepare_id + profiles + normalized config`。
- 新增 `src/lib/mirofish/simulation-context.ts`，把 round context、每平台发帖上限和 snapshot summary 做成可测试纯函数。
- 新增 `/api/mirofish/simulation/prepare`，`/api/mirofish/simulation` 支持通过 `prepare_id` 创建模拟。
- `SimulationRunner` 暴露 `getSnapshot()`，报告和 Agent 采访统一读取 snapshot。
- SSE stream 先注册 listener 再发送 connected snapshot，避免连接窗口丢事件。

## Prevention

- 多阶段 agentic 产品不要让 UI 直接拥有领域状态。先定义 lib 层 contract，再让 route/UI 消费。
- 配置字段进入 UI 前必须有执行层测试，尤其是数量、并发、轮次这类资源控制字段。
- SSE 初始快照和事件监听必须按“先监听，后发送快照”组织，避免运行中事件落在连接窗口。

## Related

- [[2026-04-08-mirofish-5step-workflow]]
- [[2026-05-11-mirofish-architecture-optimization]]
