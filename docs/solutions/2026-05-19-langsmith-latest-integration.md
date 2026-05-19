# LangSmith 最新特性接入方案

## 背景

2026-05 LangSmith 的关键发布包括 Engine public beta、Sandboxes GA、SmithDB、Context Hub，以及 Threads / Multi-turn Evals 的持续增强。对当前 RAG 系统来说，最有价值的代码落点不是把现有观测体系推倒重做，而是把已有 trace、retrieval span、generation、feedback 结构化同步给 LangSmith。

## 已落地

- `langsmith@0.7.1` 作为直接依赖。
- `ws@8.20.1` 补齐现代 SDK peer。
- `src/lib/langsmith/config.ts`：LangSmith env/runtime/client/thread metadata。
- `src/lib/langsmith/tracing.ts`：`/api/ask` root run wrapper + feedback sync。
- `src/lib/langsmith/trace-mirror.ts`：本地 `ObservabilityEngine` -> LangSmith run tree mirror。
- `src/app/api/ask/route.ts`：所有 RAG policy 统一输出 LangSmith root run。
- `src/lib/persistence/trace-store.ts`：用户 feedback 同步写入 LangSmith。
- `src/lib/rag-instance.ts`：Supabase mirror 与 LangSmith mirror 并行触发。
- `LANGSMITH_LATEST_GUIDE.md` 与 `ENV_CONFIG_GUIDE.md`：运行配置和使用说明。

## 设计原则

1. **LangSmith 是观测/评估面，不替代本地 observability 或 Supabase persistence。**
2. **线程优先。** 所有 trace 统一写 `thread_id`、`session_id`、`conversation_id`，让 Multi-turn Evals 能按会话评估。
3. **metadata 可筛选。** 每个 run 携带 `rag_policy`、route、model、embedding、vector backend。
4. **默认 no-op。** 没有 `LANGSMITH_API_KEY` 时不发网络请求、不影响本地开发。
5. **反馈三写。** 用户 feedback 同步进入本地 trace、Supabase trace_scores、LangSmith feedback。

## 最新特性映射

| LangSmith 最新能力 | 项目映射 |
| --- | --- |
| Engine | 依赖高质量 trace metadata 和 feedback，本轮已补足输入 |
| SmithDB | 结构化 tags/metadata 让 trace tree、搜索、filter 更有效 |
| Threads / Multi-turn Evals | `sessionId` -> `thread_id`，支持完整会话级评估 |
| Context Hub | 后续将 AGENTS、skills、prompt/eval rubric 纳入 context repo |
| Sandboxes | 保留给未来代码执行/数据分析 agent，不进 RAG 热路径 |

## 后续建议

- 增加 LangSmith dataset/eval 脚本，把失败 trace 自动沉淀为 regression examples。
- 为 `agentic` 和 `adaptive-entity` 路径补更细粒度 child run mirror。
- 增加 Context Hub 导出目录，版本化 `AGENTS.md`、RAG policy、prompt 和 eval rubric。
- 在生产环境区分 `rag-system-dev`、`rag-system-staging`、`rag-system-prod` 项目。
