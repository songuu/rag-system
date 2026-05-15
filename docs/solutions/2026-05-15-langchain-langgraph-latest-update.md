---
title: "LangChain / LangGraph 最新特性融入"
type: solution
created: "2026-05-15"
updated: "2026-05-15"
tags: [solution, rag, langchain, langgraph]
aliases: ["LangChain LangGraph latest update"]
---

# LangChain / LangGraph 最新特性融入

## Problem

项目已经在 RAG、Agentic RAG、Adaptive Entity RAG、Context Management、MiroFish 和 OpenMAIC 中使用或引用 LangChain / LangGraph，但文档仍混合了旧 API、设计理念和未来目标。随着 LangChain v1+ 和 LangGraph v1+ 把 agent、middleware、structured output、durable execution、typed interrupts、StateSchema 等能力稳定下来，项目需要把这些变化转成可执行的架构边界。

## Solution

新增 `LANGCHAIN_LANGGRAPH_GUIDE.md` 作为项目内统一指南，并同步更新:

- `AGENTIC_RAG_GUIDE.md`: 明确主工作流继续保留 `StateGraph`，只把 `createAgent` / structured output 用于叶子 agent。
- `ADAPTIVE_ENTITY_RAG_GUIDE.md`: 将实体提取、实体校验、reranking 规划为 schema-first 输出，约束松弛规划为可追溯 graph state。
- `CONTEXT_MANAGEMENT_GUIDE.md`: 修正“当前代码事实”和“下一阶段 StateGraph 目标”的边界，并更新到 docs.langchain.com 的 JS 文档。
- `docs/solutions/2026-05-14-rag-system-architecture-evolution.md`: 把 LangChain v1 / LangGraph v1+ 作为 RAG Kernel 的能力来源，而不是新的 API 分支。
- `.codex/rules/architecture.md`: 固化“LangChain v1 用于叶子 agent，LangGraph v1 用于有状态工作流”的规则。

## Code Implementation

按规划继续落实运行时代码:

- `src/lib/langchain-structured-output.ts`: 新增统一结构化输出 helper。优先使用模型的 `withStructuredOutput`，不支持时降级到 prompt JSON 解析，兼容本地 Ollama 和旧模型集成。
- `src/lib/langchain-structured-output.test.mjs`: 覆盖 native structured output、JSON fallback、正文 JSON 提取和 content block 提取。
- `src/lib/agentic-rag.ts`: 将 `analyze_query`、`grade_retrieval`、异步 `check_hallucination` 改成 schema-first 输出；保留现有 fan-out、重试、SSE 和异步修正语义。
- `src/lib/adaptive-entity-rag.ts`: 将实体抽取、实体校验、reranking 接入统一 helper；移除重复的旧 JSON 解析函数。

本轮没有新增 `langchain` 包依赖，继续沿用当前已安装的 `@langchain/core` 与 `@langchain/langgraph`。这样可以先把 structured output 的工程边界落到叶子节点，同时保持主工作流的可解释状态机不变。

## Key Decisions

1. 不直接替换现有 Agentic RAG 工作流。当前 fan-out、条件重试、SSE、异步幻觉修正都是产品语义，不能被黑盒 agent loop 吞掉。
2. 不在本轮添加 `langchain` 依赖。项目当前没有直接依赖该包，文档先标明使用边界；真正代码迁移时再同步更新 `package.json` 和 `pnpm-lock.yaml`。
3. 新 graph 优先使用 LangGraph v1.1 `StateSchema`，旧 `Annotation.Root()` 保留到迁移窗口。
4. Durable execution 只用于长流程和可恢复流程，普通一次性 RAG 查询保持轻量无状态。
5. Content blocks、reasoning trace、citations 后续进入 `RagAnswerEnvelope`，不要在各模式里提前压平成字符串。

## Verification

- `node scripts/generate-articles.mjs`
- `pnpm exec eslint scripts/generate-articles.mjs`
- `node src\lib\langchain-structured-output.test.mjs`
- `pnpm exec eslint src\lib\langchain-structured-output.ts src\lib\langchain-structured-output.test.mjs src\lib\agentic-rag.ts src\lib\adaptive-entity-rag.ts`
- `npx tsc --noEmit --pretty false --incremental false 2>&1 | Select-String -Pattern "src/lib/(langchain-structured-output|agentic-rag|adaptive-entity-rag)"`
- `git diff --check`

全量 `npx tsc --noEmit --pretty false --incremental false` 仍被既有 repo-wide 类型错误阻塞，主要集中在 Next 16 route params、页面 state literal、MiroFish d3 类型、旧 tokenizer / observability 类型等位置；本次新增和触达的运行时代码文件没有匹配到类型错误。
