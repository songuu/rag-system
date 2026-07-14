---
title: "Vercel AI SDK 接入点审视"
type: sprint
status: completed
created: "2026-06-24"
updated: "2026-06-24"
checkpoints: 0
tasks_total: 4
tasks_completed: 4
tags: [sprint, research, ai-sdk, rag]
aliases: ["Vercel AI SDK integration scan"]
invariants:
  - "RagKernel / RagPolicy 仍是 /api/ask 的策略入口, 不用 AI SDK 直接绕过"
  - "现有 SSE 自定义事件协议保留, 除非单独迁移 UI message protocol"
  - "LangSmith trace identity 继续由当前 tracing wrapper 管理"
invariant_tests:
  - "pnpm build"
  - "git diff --check"
deferred:
  - sprint: "ai-sdk-pilot"
    item: "安装 ai / @ai-sdk/langchain / provider 包并新增一个实验性 route"
    deadline: "2026-07-08"
    reason: "当前请求是接入点审视, 不引入未验证依赖和 lockfile churn"
deadcode_until: []
---

# Vercel AI SDK 接入点审视

## Phase 1: Think

### Scope

- 审视当前 Next.js + LangChain/LangGraph/RAG 架构中是否存在可直接接入 Vercel AI SDK 的位置。
- 区分三类接入: 后端模型调用层、后端流式协议层、前端 AI SDK UI hook 层。
- 给出可执行的最小接入路线, 避免把现有 RAG policy、LangSmith tracing、Milvus 检索链路一次性替换。

### Non-scope

- 本 sprint 不安装新依赖, 不改 `pnpm-lock.yaml`。
- 本 sprint 不把现有自定义 SSE UI 全量迁到 `useChat`。
- 本 sprint 不移除 LangChain; 当前项目已有大量 `BaseChatModel` / Runnable / structured output 代码。

### Success

- 列出可直接接入点和不宜直接接入点。
- 给出优先级、改动面、风险、验证策略。
- 明确推荐第一刀。

### Risks

- AI SDK 适合统一模型调用、streaming response 和 UI message protocol, 但本项目已有自定义 RAG envelope、workflow event、thinking event、LangSmith headers。
- UI hook 迁移会影响 `src/app/page.tsx`、`src/app/reasoning-rag/page.tsx`、`src/app/context-management/page.tsx` 等多个自定义消息状态机。
- Provider 层迁移必须覆盖 Ollama、OpenAI、Azure、OpenRouter、Lemonade/custom OpenAI-compatible, 否则会破坏当前模型选择能力。

## Phase 2: Plan

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint / 当前 invariant | 本 sprint 如何保持 |
|--------|----------------------------|--------------------|
| RAG Kernel | `/api/ask` 通过 `RagKernel` / `RagPolicy` 分派策略 | AI SDK 只作为模型/stream adapter 候选, 不绕过 policy |
| LangChain workflow | 当前 Runnable/structured output 是核心实现面 | 优先使用 AI SDK LangChain adapter 或薄适配层, 不直接删除 LangChain |
| SSE | 多个页面使用自定义事件流和工作流事件 | 不把 token stream 与 workflow event 混为 AI SDK UI message |
| LangSmith | `/api/ask` 已有 root run / header 语义 | 任何新增 AI SDK route 需要保留 trace metadata 或标明实验隔离 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| AI SDK LangChain adapter pilot | 用户在实验 route 提问 | Route Handler -> LangChain model/workflow -> AI SDK stream response | ❌ 无持久化 | ❌ 实验 route only |
| AI SDK model provider registry | 现有 `createLLM` 调用 | `model-config.ts` -> AI SDK provider -> optional LangChain adapter | N/A | ✅ 通过现有 UI 使用 |
| AI SDK UI `useChat` | 用户在主聊天页提问 | React hook -> `/api/chat` UIMessage stream | IndexedDB 需重接 | ⚠️ 需迁移现有消息 schema |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| LangChain RAG Workflow | workflow harness 已承载 RAG 入口 | 保留, AI SDK 作为适配层 | 2026-07-08 |
| Containerized deployment | Docker build/run 未验证 | 本 sprint 不扩大部署面 | 2026-07-08 |

### Task 拆解

| ID | 任务 | 风险 | 状态 |
|----|------|------|------|
| T1 | 扫描依赖和模型工厂 | L0 | ✅ |
| T2 | 扫描后端 route / stream / structured output | L0 | ✅ |
| T3 | 对照 AI SDK 官方能力判断接入点 | L0 | ✅ |
| T4 | 写接入建议和验证结论 | L0 | ✅ |

## Phase 3: Work

### 当前事实

- `package.json` 当前没有 `ai`、`@ai-sdk/*` 依赖; 直接代码接入前必须新增依赖并安装。
- `src/lib/model-config.ts` 是最集中的模型工厂: `ModelProvider` 覆盖 `ollama | openai | azure | custom | openrouter | lemonade`, `createLLM()` / `createReasoningModel()` 返回 LangChain `BaseChatModel`。
- `/api/ask` 仍是主 RAG BFF, 通过 `createAskKernel()` 注册 `adaptive-entity`、`agentic`、`milvus-2step`、`memory` 四类 policy。
- `src/lib/lane-handlers.ts` 是最清晰的流式 token 叶子层: Lane 1/2/3 分别调用 `llm.stream()` 或 `reasonerLLM.stream()` 后产出自定义 `StreamEvent`。
- `src/lib/langchain-structured-output.ts` 已封装 LangChain `withStructuredOutput()` fallback; Agentic RAG 的 query analysis / retrieval grade / hallucination check 都依赖它。
- 前端没有使用 AI SDK `useChat` / `useCompletion`; 主聊天、Reasoning RAG、Context Management 都是自定义 `fetch` + 本地消息状态。

### 可直接接入点矩阵

| 优先级 | 位置 | 接入方式 | 为什么能直接接 | 风险 |
|--------|------|----------|----------------|------|
| P0 | `src/lib/lane-handlers.ts` Lane 1/2/3 generation | 用 AI SDK `streamText()` 包装纯 prompt generation, 再继续转成当前 `StreamEvent` | 这里已经是 token 叶子层, 不牵动 RAG policy 和 UI state | Provider 覆盖必须先做; 否则 Ollama/OpenRouter/Lemonade 行为不一致 |
| P0 | 新增实验 route, 例如 `src/app/api/ai-sdk/langchain-chat/route.ts` | 使用 `@ai-sdk/langchain` adapter 把现有 LangChain model/workflow 转 AI SDK stream | 官方 adapter 专门服务 LangChain/LangGraph + AI SDK bridge | 需要新依赖; 与现有 UI 无集成 |
| P1 | `src/lib/model-config.ts` | 增加 AI SDK provider registry, 并保留 LangChain factory | 模型/provider 集中, 能减少散落调用 | 改动面中等; 需要兼容 `BaseChatModel` 调用方 |
| P1 | `src/lib/langchain-structured-output.ts` | 对支持 provider 的路径使用 AI SDK `generateObject()` / schema object generation | 当前文件已是 structured output adapter | Zod/JSON Schema 差异和本地模型 fallback 要验证 |
| P2 | `src/app/api/ask/route.ts` | 只给 `milvus-2step` generation 叶子调用接入 AI SDK `generateText()` | 检索已完成后只剩 prompt -> answer | `/api/ask` 有 LangSmith root run 和 envelope headers, 不能先改主干 |
| P3 | 前端 `useChat` | 新建独立 chat page / route 试点 | AI SDK UI hook 对新页面最直接 | 不适合直接迁移现有主页面; 自定义 queryAnalysis/retrievalDetails/IndexedDB schema 会重写 |

### 不建议直接接入点

- 不建议先改 `src/app/page.tsx` 主聊天页: 当前消息类型携带 `queryAnalysis`、`retrievalDetails`、IndexedDB 恢复逻辑, 不是 AI SDK UI message 协议。
- 不建议先改 `/api/ask` 整个 route response: 当前返回 JSON envelope + headers + LangSmith metadata; 改成 UI message stream 会破坏调用方。
- 不建议替换 Agentic/Adaptive RAG 的 workflow core: 当前 Runnable graph、structured output、retry、幻觉检查有产品语义, AI SDK 应先做叶子模型调用或 route bridge。
- 不建议替换 MAIC/MiroFish 进度 SSE: 这些流不是 token stream, 是业务事件流。

### 推荐第一刀

先做一个 **AI SDK LangChain adapter pilot**:

1. 安装依赖: `ai`、`@ai-sdk/langchain`、按 provider 需要补 `@ai-sdk/openai` / openai-compatible provider。
2. 新增隔离 route: `src/app/api/ai-sdk/langchain-chat/route.ts`。
3. route 内复用 `createLLM()` 产生现有 LangChain model, 用 AI SDK LangChain adapter 输出 AI SDK UI/message stream。
4. 新增最小测试: adapter module smoke + route request validation。
5. 不接 UI; 用 curl/Node smoke 验证 response stream header 和 basic token flow。

第二刀再考虑 `lane-handlers.ts`: 保留当前 `StreamEvent` 协议, 仅把 `llm.stream(prompt)` 替换为统一 `streamModelText(prompt, options)` helper, helper 内可切换 LangChain 或 AI SDK provider。

## Phase 4: Review

### 架构视角

- P0 无。推荐路线保持 `RagKernel`、LangChain Runnable、业务 SSE 边界, 不引入黑盒替换。
- P1: 若直接把 AI SDK UI protocol 接进现有页面, 会产生 schema drift。必须先隔离 route 或 helper。

### 安全视角

- P0 无。
- P1: provider registry 要避免把 API key 暴露到 client bundle; AI SDK provider 创建必须只在 server-only 模块中。

### 性能视角

- P0 无。
- P1: AI SDK `streamText()` 可改善 token streaming ergonomics, 但如果仍要转自定义 `StreamEvent`, 性能收益主要来自统一 backpressure/error handling, 不来自 RAG 检索本身。

### 代码质量视角

- P0 无。
- P1: `extractContent()` / `extractLLMContent()` 已重复出现; 接 AI SDK 前应下沉一个模型输出 normalization helper。

### 测试视角

- 本 sprint 文档改动 L0, 未改运行代码。
- 后续 pilot 至少 L2: route smoke、provider config validation、stream cancellation、OpenAI-compatible provider mapping。

### 第 6 视角 - 集成连续性

- 未破坏现有 invariant。
- 推荐新增 route 是隔离实验, 不产生 dead code 前必须配 README/doc 和 smoke command。
- 若第二刀替换 `lane-handlers.ts`, 必须保留现有 `StreamEvent` 类型和前端消费逻辑。

## Phase 5: Compound

### 经验

- 本项目可直接利用 AI SDK, 但最直接的接入不是 UI hook, 而是 `@ai-sdk/langchain` adapter 或后端 token generation helper。
- “AI SDK UI” 和“业务 workflow SSE”是两条协议, 不应混用。
- `model-config.ts` 是长期接入点; `lane-handlers.ts` 是短期低风险验证点; `/api/ask` 和主页面是后续收口点。

### 下一步建议

执行一个小 sprint:

```powershell
pnpm add ai @ai-sdk/langchain @ai-sdk/openai
```

然后新增实验 route + smoke test。验收只看:

- `pnpm build`
- 新 route stream header 正确
- 不改 `/api/ask` 现有 JSON response
- 不改现有前端消息状态

