---
title: "OpenMAIC v0.2.1 对齐与文档解析优化"
type: sprint
status: completed
created: "2026-04-28"
updated: "2026-04-28"
checkpoints: 0
tasks_total: 6
tasks_completed: 6
tags: [sprint, feature, maic, openmaic, performance]
aliases: ["OpenMAIC v0.2.1 parity", "MAIC parse speed"]
---

# OpenMAIC v0.2.1 对齐与文档解析优化

## 需求分析

上游 OpenMAIC 在 2026-04-26 发布 v0.2.1，主要新增 VoxCPM2 TTS、per-model thinking 配置、课程完成页与测验状态持久化、最新模型注册、首页 recent classrooms 搜索、Deep-Interactive 标识，并继续优化白板提示与 PDF/MinerU 能力。

本项目的 `/maic` 是独立轻量实现，目标不是全量迁入上游工程，而是在现有边界内保持用户可感知的一致性：

- 首页支持课程发现/搜索，课程卡片显式展示交互课程能力。
- 课堂结束后出现完成视图，测验答案刷新后可恢复。
- 文档上传解析更快：同一文件不重复解析，PDF 解析避免额外阻塞。
- 保留现有独立 `src/lib/maic` 模块，不引入上游完整 provider/settings 体系。

## 技术方案

- 增加 MAIC parsed slides 缓存，以文件内容 hash 命中上传阶段的解析文本和分页。
- 优化 `document-parser` 的 PDF 路径，复用 `getText()` 返回的 `total`，避免额外 `getInfo()`。
- `/maic` 首页增加搜索输入与“精选课程/发现”区域，按标题、文件名和状态延迟过滤。
- 课程列表 API 暴露 scene 类型摘要，课程卡片显示 Deep-Interactive badge。
- 课堂组件把 quiz answers 存入 `localStorage`，并在课堂 ended 时显示完成页、得分卡和场景统计。

## 任务拆解

- [x] T1 调研上游 v0.2.1 changelog 与本地 MAIC 结构。
- [x] T2 增加解析结果缓存并优化 PDF 解析热路径。
- [x] T3 补齐首页搜索/精选课程与 Deep-Interactive 标识。
- [x] T4 补齐课堂完成页与测验状态持久化。
- [x] T5 增加/更新针对性测试。
- [x] T6 运行验证并记录审查结果。

## 变更日志

- 2026-04-28: 确认上游 v0.2.1 变更点，制定轻量对齐方案。
- 2026-04-28: 新增上传解析缓存，PDF 解析复用 `getText().total`，避免额外 `getInfo()` 阻塞。
- 2026-04-28: `/maic` 首页加入搜索和精选课程；课程卡片展示 Deep-Interactive 标识。
- 2026-04-28: 课堂结束后展示完成页，测验答案持久化到本地存储。

## 审查结果

- 上游确认：`CHANGELOG.md` v0.2.1 发布日期为 2026-04-26，核心变更包括 VoxCPM2、per-model thinking、完成页/quiz 状态、模型注册、课程搜索和 Deep-Interactive 标识。
- 本轮对齐：实现课程搜索/精选、Deep-Interactive badge、完成页、quiz 本地持久化、上传解析缓存和 PDF 解析热路径优化。
- 未全量迁入：VoxCPM2/provider settings 和 per-model thinking UI 依赖上游完整 provider/store 架构，本仓库当前 MAIC 独立模块未引入该体系。
- 验证：MAIC 相关 6 个 node test 通过；本轮文件 ESLint 通过；MAIC/文档解析范围 TypeScript 过滤无错误。
- 全量 `pnpm exec tsc --noEmit --pretty false` 仍失败，错误来自既有非本轮模块，包括 `api/traces` Next 16 route params、`ask`/`trace-trie`、MiroFish D3 类型、Reasoning RAG 类型等。

## 复利记录

- 解决方案：`docs/solutions/2026-04-28-maic-parsed-slides-cache.md`
- 性能规则：`.codex/rules/performance.md` 新增“Cache Before The First Expensive Stage”。
- Skill 信号：`.codex/skill-signals/sprint.jsonl`、`.codex/skill-signals/compound.jsonl` 已记录。
