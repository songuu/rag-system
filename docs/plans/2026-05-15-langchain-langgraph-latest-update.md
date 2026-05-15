---
title: "LangChain / LangGraph 最新特性融入"
type: sprint
status: completed
created: "2026-05-15"
updated: "2026-05-15"
checkpoints: 0
tasks_total: 9
tasks_completed: 9
tags: [sprint, rag, langchain, langgraph]
aliases: ["LangChain LangGraph latest update"]
---

# LangChain / LangGraph 最新特性融入

## Phase 1: Think

### Scope

- 核对 LangChain / LangGraph 官方 JS/TS 文档、release notes、changelog 中的最新稳定能力。
- 找到项目中 LangChain / LangGraph 内容真实落点。
- 把最新能力融入项目文档、架构规则和文章生成配置。

### Non-scope

- 本轮不新增 `langchain` 运行时依赖。
- 本轮不重写 Agentic RAG / Adaptive Entity RAG 的运行时代码。
- 本轮不改变 API 响应结构、路由、前端交互。

### Success Criteria

- 项目有一份统一的 LangChain / LangGraph 最新特性融入指南。
- Agentic RAG、Adaptive Entity RAG、Context Management 文档能明确 v1+ 能力的项目落点。
- RAG Kernel 架构文档和 `.codex/rules/architecture.md` 固化后续演进边界。
- 文章生成脚本纳入新指南。

## Phase 2: Plan

| Task | 内容 | 风险 | 状态 |
|------|------|------|------|
| T1 | 官方来源核对最新能力 | L1 | done |
| T2 | 新增统一指南 `LANGCHAIN_LANGGRAPH_GUIDE.md` | L1 | done |
| T3 | 更新 Agentic / Adaptive / Context 文档 | L1 | done |
| T4 | 更新架构 solution、规则和文章配置 | L1 | done |
| T5 | 运行文档生成和格式/差异校验 | L1 | done |
| T6 | 新增统一结构化输出 helper，优先 provider-native structured output，保留 JSON fallback | L2 | done |
| T7 | Agentic RAG 的 query analysis、retrieval grade、hallucination check 接入 schema-first 输出 | L2 | done |
| T8 | Adaptive Entity RAG 的实体抽取、实体校验、reranking 接入 schema-first 输出 | L2 | done |
| T9 | 新增 helper 单测并做触达文件 lint / 类型过滤验证 | L2 | done |

## Phase 3: Work

### T1 官方来源核对

已核对:

- LangChain v1 release notes
- LangChain JS changelog
- LangChain agents / structured output docs
- LangGraph v1 release notes
- LangGraph persistence / durable execution / interrupts docs
- LangChain JS / LangGraph security advisories入口

### T2 新增统一指南

新增 `LANGCHAIN_LANGGRAPH_GUIDE.md`，记录:

- 当前项目锁定版本。
- LangChain v1+ / LangGraph v1+ 能力映射。
- 高层 `createAgent` 与低层 `StateGraph` 的边界。
- RAG Kernel、Agentic RAG、Adaptive Entity RAG、Context Management、MAIC、MiroFish 的融入点。
- 后续迁移路线。

### T3 更新现有指南

- `AGENTIC_RAG_GUIDE.md`: 增加 v1+ 对齐表和最佳实践。
- `ADAPTIVE_ENTITY_RAG_GUIDE.md`: 增加 schema-first 和 graph state 融入原则。
- `CONTEXT_MANAGEMENT_GUIDE.md`: 增加当前代码事实 vs 下一阶段目标的边界，补 StateSchema 示例，更新参考资料。

### T4 更新架构沉淀

- `docs/solutions/2026-05-14-rag-system-architecture-evolution.md`: 增加 LangChain / LangGraph v1+ alignment。
- `docs/solutions/2026-05-15-langchain-langgraph-latest-update.md`: 新增本轮 solution。
- `.codex/rules/architecture.md`: 新增规则“LangChain v1 用于叶子 agent，LangGraph v1 用于有状态工作流”。
- `scripts/generate-articles.mjs`: 将新指南加入文章列表。

### T5 验证

- `node scripts/generate-articles.mjs`: pass
- `pnpm exec eslint scripts/generate-articles.mjs`: pass
- `git diff --check`: pass

### T6 统一结构化输出 helper

新增 `src/lib/langchain-structured-output.ts`:

- 优先调用模型的 `withStructuredOutput(schema, { name })`。
- 对不支持 native structured output 的本地模型或旧集成，自动降级到 `model.invoke()` + JSON 提取。
- 统一处理字符串、content block、fenced code block、正文中的首个平衡 JSON object。

### T7 Agentic RAG 运行时代码落实

更新 `src/lib/agentic-rag.ts`:

- `analyze_query` 使用 `QUERY_ANALYSIS_SCHEMA` 规范查询分析输出。
- `grade_retrieval` 使用 `RETRIEVAL_GRADE_SCHEMA` 规范评分输出。
- 异步 `check_hallucination` 使用 `HALLUCINATION_CHECK_SCHEMA` 规范幻觉检查输出。
- 对 LangGraph v1 编译图只暴露当前需要的 `invoke/stream` 契约，避免内部泛型泄漏到业务代码。

### T8 Adaptive Entity RAG 运行时代码落实

更新 `src/lib/adaptive-entity-rag.ts`:

- 认知解析层使用 `ENTITY_EXTRACTION_SCHEMA` 输出 `ParsedQuery`。
- 策略控制层使用 `ENTITY_RESOLUTION_SCHEMA` 输出实体归一化结果。
- 执行检索层使用 `RERANKING_SCHEMA` 输出 rerank 分数和解释。
- 移除旧的重复 `safeParseJson`，改为统一 helper 的兼容解析路径。

### T9 代码验证

- `node src\lib\langchain-structured-output.test.mjs`: pass
- `pnpm exec eslint src\lib\langchain-structured-output.ts src\lib\langchain-structured-output.test.mjs src\lib\agentic-rag.ts src\lib\adaptive-entity-rag.ts`: pass
- `npx tsc --noEmit --pretty false --incremental false`: blocked by existing repo-wide errors outside本次运行时代码改动面
- `npx tsc --noEmit --pretty false --incremental false 2>&1 | Select-String -Pattern "src/lib/(langchain-structured-output|agentic-rag|adaptive-entity-rag)"`: no matching errors
- `git diff --check`: pass, only CRLF normalization warnings

## Phase 4: Review

### Findings

未发现 P0/P1 问题。

### Residual Risk

- 本轮是文档和架构沉淀更新，没有引入 `langchain` 包，因此 `createAgent` 仍是迁移目标，不是可直接运行的代码入口。
- `structured output` 已先落到当前 `@langchain/core` / `@langchain/langgraph` 运行时代码，未新增 `langchain` 包；`createAgent` 仍是后续迁移目标。
- 全量 `tsc` 仍受既有 repo-wide 类型错误阻塞，包括 Next 16 route params、页面 state literal、MiroFish d3 类型、旧 observability / tokenizer 类型等。

## Phase 5: Compound

### Knowledge

- 快速变化的 LangChain / LangGraph 能力不要直接替换现有产品工作流，先拆成叶子 agent 能力和状态机能力。
- 本项目 RAG 演进继续走 `RAG Kernel -> policy -> retrieval lane -> eval`，避免扩大 `/api/ask` 分支。
- Context Management 文档必须区分“当前 LCEL 实现”和“未来 LangGraph persistence 目标”。
- 运行时代码先把“结构化输出”落在叶子节点上，主流程继续保留显式 StateGraph / class workflow 边界。
