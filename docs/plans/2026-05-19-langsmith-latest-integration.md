---
title: "LangSmith Latest Integration"
type: sprint
status: completed
created: "2026-05-19"
updated: "2026-05-19"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, langsmith, observability, evals, rag]
aliases: ["LangSmith 最新特性接入"]
---

# LangSmith Latest Integration - 2026-05-19

## Goal

根据 2026-05 LangSmith 最新发布和当前 npm latest SDK，对当前 RAG 项目完成可直接落地的观测、线程、多轮质量评估和反馈链路升级，让后续 LangSmith Engine、Insights Agent、Multi-turn Evals、SmithDB 查询性能和 Context Hub 治理能力能真正吃到结构化数据。

## Latest Signals Verified

- LangSmith Engine public beta：基于生产 traces 聚类失败、诊断根因，并建议修复和 eval 覆盖。
- LangSmith Sandboxes GA：用于安全运行 agent 生成代码，适合未来代码执行/数据分析类 agent，不进入本轮 RAG 热路径。
- SmithDB：LangSmith 新观测数据层，强调 trace tree、全文搜索、run filtering 的低延迟；项目侧应提供更好的 tags、metadata、thread/run 结构。
- Context Hub：集中管理 `AGENTS.md`、skills、policies、memory/context 文件；项目侧应让 agent context 可版本化、可标记 dev/staging/prod。
- Threads + Multi-turn Evals：通过 `thread_id` / `session_id` / `conversation_id` 聚合多轮交互，并将用户反馈与 run 关联。
- npm latest: `langsmith@0.7.1`，本轮已安装为直接依赖。

## Scope

- 将 LangSmith JS SDK 作为直接依赖。
- 增加服务端 LangSmith runtime 配置、client、thread id、metadata/tag 规范。
- 将本地 `ObservabilityEngine` traces/observations/scores mirror 到 LangSmith。
- 将 `/api/ask` 中 Milvus / Agentic / Adaptive Entity 这些非本地 trace 路径包成 LangSmith root run。
- 将用户 feedback 同步写入 LangSmith `createFeedback`。
- 保持未配置 LangSmith API key 时的本地行为完全不变。

## Non-Scope

- 不接入真实 LangSmith 项目 API key。
- 不把 Sandboxes 放进 RAG 查询热路径。
- 不替换现有 Supabase trace persistence。
- 不改变前端 API response 结构，除补充更准确 trace id 外保持兼容。

## Task Breakdown

- [x] T1 核对 LangSmith 最新发布和 SDK 版本。
- [x] T2 升级并验证 `langsmith@0.7.1` 直接依赖。
- [x] T3 实现 LangSmith config/runtime/thread/feedback adapter。
- [x] T4 接入 `ObservabilityEngine` mirror 和 `/api/ask` root run tracing。
- [x] T5 更新文档并完成 type/lint/test/build 验证。

## Acceptance

- 未配置 `LANGSMITH_API_KEY` 时，所有本地 RAG/API 行为不变。
- 配置 LangSmith 后，每次 RAG 调用都携带 `thread_id`、`session_id`/`conversation_id`、policy/model/vector backend metadata。
- 本地 observability 的 trace、observation、score 可被同步为 LangSmith run tree 和 feedback。
- `/api/traces/[traceId]/feedback` 会同步到本地/Supabase/LangSmith 三层。
- TypeScript、scoped lint、相关测试和 build 通过。

## Validation Log

- `node -e "import('langsmith').then(...)"` - pass，确认 SDK 暴露 `Client` / `RunTree` / `uuid7`，并验证本地安装版本为 `0.7.1`。
- `node scripts\generate-articles.mjs` - pass，生成 20 篇文章索引，新增 LangSmith 指南已进入 `public/articles-data.json`。
- `git diff --check` - pass，仅有 CRLF 工作区提示，无 whitespace error。
- `npx eslint --no-error-on-unmatched-pattern ...` - pass，覆盖 LangSmith adapter、trace mirror、API route、文档生成脚本。
- `node --test src\lib\langsmith\config.test.mjs` - pass；沙箱内因 `spawn EPERM` 阻断，已在沙箱外复跑通过 3/3。
- `npx tsc --noEmit --pretty false --incremental false` - pass。
- `pnpm build` - pass，Next.js 16.2.2 / Turbopack 构建成功，87 个 route 完成收集和静态生成。

## Review

- 未配置 LangSmith API key 时，adapter 和 root run wrapper 都保持 no-op，本地 RAG/API 行为不变。
- LangSmith trace 数据按 SmithDB/Engine/Threads 友好形态写入：root run、child observation run、`thread_id`、policy/model/vector metadata、tags、feedback。
- `/api/ask` 现在覆盖 Milvus / Agentic / Adaptive Entity 等此前不一定经过本地 `ObservabilityEngine` 的热路径。
- 用户 feedback 同步到本地/Supabase/LangSmith 三层；非 UUID run id 会跳过 LangSmith feedback，避免污染平台侧数据。
- Sandboxes、Context Hub SDK 和 LLM Gateway 暂不进入热路径；本轮只预留文档与 env 结构，避免在没有真实 workspace/API key 的情况下引入假集成。

## Compound

- 经验沉淀写入 `docs/solutions/2026-05-19-langsmith-latest-integration.md`。
- 新增 `LANGSMITH_LATEST_GUIDE.md` 作为项目内 LangSmith 最新能力使用指南，并挂入博客文章生成。
- 可复用模式：外部 observability 平台接入时，优先把本地 trace 规范化为 platform-native run tree，而不是替换现有 persistence。
