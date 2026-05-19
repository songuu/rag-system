---
title: "LangSmith ReactFlow Integration"
type: sprint
status: completed
created: "2026-05-19"
updated: "2026-05-19"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, langsmith, reactflow, observability, ui]
aliases: ["LangSmith ReactFlow 接入"]
---

# LangSmith ReactFlow Integration - 2026-05-19

## Goal

在当前 LangSmith 观测与 trace mirror 基础上，直接接入 ReactFlow，让 RAG / Self-Corrective RAG 的执行路径从静态列表升级为可缩放、可拖拽、可查看节点状态的 flow graph。

## Scope

- 使用 React Flow 12 官方包 `@xyflow/react`。
- 将 ReactFlow 样式引入 Next root layout。
- 新增可复用 LangSmith ReactFlow 图组件。
- 将 `LangSmithTraceViewer` 的树形图 tab 改为 ReactFlow 画布。
- 将 `SCRAGLangSmithViewer` 的决策树视图改为 ReactFlow 画布。
- 保留现有 timeline、metrics、debug、grader、rewrite 详情，不改变 API response 和后端 trace 写入。

## Non-Scope

- 不接入 LangSmith 远端 trace 拉取 API。
- 不改变 `ObservabilityEngine` 数据结构。
- 不引入自动布局重型依赖，先用稳定的分层坐标满足现有 RAG workflow。

## Task Breakdown

- [x] T1 确认现有 LangSmith viewer 与 trace 数据合同。
- [x] T2 安装 `@xyflow/react` 并确认官方 v12 包名。
- [x] T3 实现可复用 ReactFlow graph 组件。
- [x] T4 接入两个 LangSmith viewer 并更新文档。
- [x] T5 执行 lint/type/build 验证。

## Acceptance

- 现有 LangSmith 图形视图直接渲染 ReactFlow 画布。
- 节点能展示步骤名、状态、耗时、错误提示等核心信息。
- 画布支持 controls、minimap、background、fitView。
- 没有 workflow 数据时仍保持原有隐藏行为。
- `pnpm build` 和 targeted lint/type-check 通过。

## Validation Log

- `pnpm add @xyflow/react` - pass，安装 `@xyflow/react@12.10.2`；第一次沙箱内因 EPERM 中断，沙箱外复跑成功，并清理了 pnpm 临时文件。
- `node scripts\generate-articles.mjs` - pass，LangSmith 指南更新后文章索引重新生成，LangSmith 指南时长更新为 5 min。
- `git diff --check` - pass，仅有 CRLF 工作区提示，无 whitespace error。
- `npx eslint --no-error-on-unmatched-pattern src/components/LangSmithReactFlowGraph.tsx src/components/LangSmithTraceViewer.tsx src/components/SCRAGLangSmithViewer.tsx src/app/layout.tsx` - pass。
- `npx tsc --noEmit --pretty false --incremental false` - pass。
- `pnpm build` - pass，Next.js 16.2.2 / Turbopack 构建成功，ReactFlow CSS 和 client component 通过生产构建。

## Review

- ReactFlow 接入只影响 UI 层，不改变 `/api/ask`、trace persistence 或 LangSmith mirror 数据合同。
- `LangSmithReactFlowGraph` 统一处理节点状态、耗时、错误、metadata、Controls、MiniMap、Background 和 fitView，两个 viewer 共用。
- `LangSmithTraceViewer` 顺手去掉旧 `any` 和未使用类型，避免新接入继续扩大类型债。
- `SCRAGLangSmithViewer` 修复了早返回导致的 hooks 顺序风险。
- 当前布局使用轻量分层坐标，适合现有线性/少分支 RAG 路径；复杂 agent 分支增多后再评估 dagre/elkjs。

## Compound

- 经验沉淀写入 `docs/solutions/2026-05-19-langsmith-reactflow-integration.md`。
- `LANGSMITH_LATEST_GUIDE.md` 已补充 ReactFlow 可视化章节。
- 可复用模式：先用 ReactFlow 统一 trace graph 呈现，再逐步把节点详情、真实 observation parent tree 和自动布局叠进去。
