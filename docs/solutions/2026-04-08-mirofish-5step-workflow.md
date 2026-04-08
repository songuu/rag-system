---
title: "MiroFish 5步工作流完整实现"
date: 2026-04-08
tags: [mirofish, multi-agent, simulation, sse, nextjs]
related_instincts: [sse-listener-cleanup, immutable-state-updates, closure-stale-state]
---

# MiroFish 5步工作流完整实现

## 问题
需要在 Next.js 项目中实现类似 MiroFish (github.com/666ghj/MiroFish) 的完整5步社交舆论模拟工作流，包括图谱构建、Agent人设生成、双平台模拟、报告生成和深度交互。

## 根因
原项目只有4步（本体→图谱→人设→模拟），且模拟使用硬编码mock数据，无真正LLM驱动。缺少项目管理、报告生成、深度交互等核心功能。

## 解决方案

### 架构设计
```
/mirofish → 项目列表首页
/mirofish/console/[projectId] → 5步工作流
  Step 1: 本体+图谱 (复用已有 ontology-generator + graph-builder)
  Step 2: 人设+配置 (复用 profile-generator + 新增模拟配置)
  Step 3: LLM模拟 (simulation-engine + simulation-runner + SSE)
  Step 4: 报告 (report-agent)
  Step 5: 交互 (interaction-agent)
```

### 关键决策
1. **模拟引擎用 LangChain**：每个Agent是一次LLM调用，persona作为上下文
2. **SSE 替代 WebSocket**：Next.js Route Handler 原生支持 ReadableStream
3. **内存存储**：与现有 task-manager 模式保持一致，避免引入新依赖
4. **双平台策略**：Twitter(280字限制) + Reddit(长文本)，同一引擎不同约束

### 文件清单 (20个新文件)
- 后端服务: project-store, simulation-engine, simulation-runner, report-agent, interaction-agent
- API路由: project, simulation, report, interaction (共9个route.ts)
- UI组件: StepNav, Step1-5 (共6个组件)

## 预防
- 大型功能开发前先 Research → Think → Plan，确认范围和不做什么
- SSE 场景必须同时用 ReadableStream.cancel() 和 AbortSignal 双重清理
- React 状态回调中避免读取闭包中的 state，改为直接传参
