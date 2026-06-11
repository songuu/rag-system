# LangChain / LangGraph 最新特性融入指南

> 更新日期: 2026-06-11
> 适用范围: 本项目的 RAG Kernel、Agentic RAG、Adaptive Entity RAG、Context Management、MiroFish / OpenMAIC 长流程编排。

## 一、当前项目基线

当前 `pnpm-lock.yaml` 中的 LangChain / LangGraph 相关版本:

| 包 | 锁定版本 | 项目用途 |
|----|----------|----------|
| `@langchain/core` | `^1.1.47` | 消息、Prompt、Runnable、输出解析、Embedding / ChatModel 基础类型 |
| `@langchain/langgraph` | `^1.3.1` | Agentic RAG 的 `StateGraph` 工作流 |
| `@langchain/openai` | `^1.4.6` | OpenAI-compatible provider |
| `@langchain/ollama` | `^1.2.7` | 本地 Ollama 模型 |
| `@langchain/community` | `^1.1.28` | 社区集成和兼容层 |
| `@langchain/textsplitters` | `1.0.1` | 文档切分 |

项目暂未直接依赖 `langchain` 包，因此 `createAgent`、agent middleware、`responseFormat` 等 LangChain v1 高层 agent API 不能直接用于运行时代码。当前已通过 `src/lib/langchain-structured-output.ts` 在 `@langchain/core` 模型基础上落地 structured output 优先、prompt JSON fallback 的兼容层；后续若要使用 `createAgent`，再同步更新 `package.json` 与 `pnpm-lock.yaml`。

2026-06-11 起，RAG Kernel 增加 `src/lib/rag/core/workflow.ts`：用 `@langchain/core/runnables` 的 `RunnableSequence` / `RunnableLambda` 包住 policy 执行，把 `/api/ask` 从“直接调用 kernel”改成“LangChain workflow 调用 kernel”。这对应 Claude Code workflow 的可观察执行层思想：先准备 trace/thread/metadata，再执行任务，再返回 envelope；但不把复杂 RAG 策略塞进高层 agent 黑盒。

## 二、最新特性对项目的直接含义

| 官方方向 | 最新变化 | 本项目融入方式 |
|----------|----------|----------------|
| LangChain v1 `createAgent` | 新的高层 agent 构建入口，替代 LangGraph prebuilt `createReactAgent` 的常规 agent 场景 | 用于轻量工具型 agent、结构化提取 agent、guardrail agent；不要替换本项目已经定制过的 Agentic RAG `StateGraph` |
| Middleware | 支持在 agent loop 的 before/after/wrap 阶段做上下文、工具、模型调用、guardrail 控制 | 把查询改写、摘要压缩、敏感操作审批、模型重试和内容安全放到 middleware 思维中设计 |
| Structured Output | `createAgent` 支持 `responseFormat`，可走 provider-native 或 tool strategy；v1.1+ 可通过 model profile 推断能力 | 已先在 Agentic RAG / Adaptive Entity RAG 叶子节点接入 `withStructuredOutput` 优先路径，并为本地模型保留 JSON fallback |
| Standard Content Blocks | 统一 reasoning trace、citations、provider built-in tools 等内容块 | 生成答案和观测链路要保留结构化 content block，不要把所有模型输出提前压平成字符串 |
| Model Profiles | v1.1+ 暴露模型能力信息，如 structured output、tool calling、JSON mode | 扩展 `src/lib/model-config.ts` 时记录 capability，不靠 provider 名字硬编码能力 |
| Retry / Moderation / Summarization Middleware | v1.1+ 强化重试、安全检查和基于模型 profile 的摘要触发 | 长对话、OpenMAIC 课堂、MiroFish 模拟应把重试和摘要视为 runtime policy，而不是散落在页面层 |
| LangGraph v1 | 核心 graph API 保持稳定，durable execution、persistence、streaming、human-in-the-loop 继续是一等能力 | Agentic RAG、自适应路由、课堂/模拟准备流程继续优先使用低层 `StateGraph` |
| LangGraph v1 typed interrupts | `StateGraph` 可以约束 interrupt 类型 | 适合人工审批、敏感工具调用、课程生成确认、MiroFish 关键参数确认 |
| LangGraph v1.1 StateSchema | 支持 Standard Schema、`ReducedValue`、`UntrackedValue`、`MessagesValue` 和类型辅助工具 | 新增 graph 优先使用 schema-first 状态；旧 `Annotation.Root()` 可以保留到迁移窗口 |
| Durable execution | 通过 checkpointer + `thread_id` 恢复长流程；副作用和非确定性操作应包进 task 或独立节点 | MAIC prepare、MiroFish simulation、长 Agentic RAG 评估适合引入持久 checkpointer；普通一次性问答无需强行持久化 |
| Frontend stream SDK | LangGraph 前端 SDK 支持更灵活的 stream encoding 和 transport | 当前 Next.js API SSE 可以保留；只有独立部署 LangGraph server 时再接 SDK |

## 三、项目内架构分工

### 3.1 高层 agent 与低层 graph 的边界

- 使用 LangChain `createAgent` 的场景:
  - 单一 ReAct 工具循环。
  - 结构化提取 / 归一化 / 审查这类叶子 agent。
  - 需要 middleware 快速接入重试、摘要、人工审批、PII / moderation 的场景。

- 使用 LangGraph `StateGraph` 的场景:
  - Agentic RAG 这种包含 fan-out、条件重试、异步幻觉检查、SSE 修正事件的工作流。
  - Adaptive Entity RAG 这种有状态路由、约束松弛、降级策略的流程。
  - MAIC / MiroFish 这种可中断、可恢复、跨步骤产物缓存的长流程。

因此，本项目的方向不是“把所有东西换成 `createAgent`”，而是:

1. RAG Kernel 继续作为统一入口。
2. 复杂 RAG 策略继续用 policy adapter + StateGraph。
3. 叶子智能步骤逐步吸收 LangChain v1 middleware 和 structured output。

### 3.2 RAG Kernel 的融入点

`src/lib/rag/core/*` 是后续 LangChain / LangGraph 能力进入项目的唯一中枢:

- `RagPolicy`: 决定用 memory、milvus、agentic、adaptive-entity、reasoning 等策略。
- `RagWorkflow`: 用 LangChain Runnable 承接执行配置、tags、metadata 和 trace/thread identity。
- `ContextComposer`: 吸收 content blocks、citation blocks、reasoning traces。
- `RagAnswerEnvelope`: 保存 `x-rag-policy`、`x-rag-trace-id`、workflow metadata。
- `RetrievalPlan`: 将 dense / sparse / graph lane、fusion、rerank 和 cache 显式化。

新能力优先落在 kernel、policy、retrieval lane、corpus、eval，而不是继续给 `/api/ask` 增加顶层分支。

## 四、推荐迁移路线

### T1. 短期: 文档和约束先对齐

- 在 Agentic RAG、Adaptive Entity RAG、Context Management 文档中明确 v1+ 对齐边界。
- 标注 `createAgent` 需要新增 `langchain` 依赖，不能在当前代码中直接 import。
- 保留现有响应结构和前端字段，避免为了追新 API 破坏兼容性。

### T2. 中期: 结构化输出替换 prompt JSON parsing

优先改造风险较低、收益明显的叶子节点:

- `src/lib/adaptive-entity-rag.ts` 的实体提取、实体校验、reranking。已接入统一 helper。
- `src/lib/agentic-rag.ts` 的 query analysis、retrieval grade、hallucination check。已接入统一 helper。
- `src/lib/mirofish/ontology-generator.ts` 的 ontology normalization。
- `src/lib/maic/pipeline/plan-stage.ts` 的课堂 plan / focus plan。

目标是减少 `JSON.parse` 兜底和格式漂移，输出用 schema 验证。

### T3. 中期: 新 graph 使用 StateSchema

新增 LangGraph 工作流时优先使用 `StateSchema`:

```typescript
import { StateGraph, StateSchema, ReducedValue, MessagesValue, START, END } from '@langchain/langgraph';
import { z } from 'zod';

const RagWorkflowState = new StateSchema({
  messages: MessagesValue,
  retrievalTrace: new ReducedValue(
    z.array(z.string()).default(() => []),
    {
      inputSchema: z.string(),
      reducer: (current, next) => [...current, next],
    }
  ),
  currentPolicy: z.string(),
});

const graph = new StateGraph(RagWorkflowState)
  .addNode('retrieve', retrieveNode)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', END)
  .compile();
```

旧代码里的 `Annotation.Root()` 不需要立即重写；只有新增图或高风险维护点才迁移。

### T4. 长期: 长流程引入 durable execution

当流程具备以下任一特征时，才引入持久 checkpointer:

- 可能跨页面、跨请求、跨分钟继续执行。
- 需要人工审批或外部输入。
- 有昂贵的 LLM / 解析 / 向量化中间产物。
- 失败后必须从上一个稳定步骤恢复。

执行规范:

```typescript
const graph = workflow.compile({ checkpointer });

await graph.invoke(input, {
  configurable: {
    thread_id: sessionId,
  },
});
```

副作用边界:

- 文件写入、数据库写入、外部 API 调用必须设计为幂等。
- 非确定性操作不要混在一个大节点里，拆成可重放的节点或 task。
- checkpoint store 是完整性敏感资产，生产环境要限制写权限并跟踪官方 security advisories。

## 五、现有模块更新建议

| 模块 | 保留 | 融入最新特性 |
|------|------|--------------|
| `src/lib/agentic-rag.ts` | 保留自定义 `StateGraph`、fan-out、SSE 和异步幻觉修正 | 后续把 query analysis / retrieval grade / hallucination check 改成 schema 输出；长运行评估可加 checkpointer |
| `src/lib/adaptive-entity-rag.ts` | 保留四层架构和约束松弛策略 | 用 structured output 固化 `ParsedQuery`、`ValidatedEntity`、`RankedResult` |
| `src/lib/context-management.ts` | 当前 LCEL / Runnable 实现可继续运行 | 文档上明确两条路线: 轻量对话用 LangChain middleware，强恢复需求用 LangGraph persistence |
| `src/lib/rag/core/*` | 保留 policy adapter 和兼容响应 | 承接 content blocks、trace、eval、retrieval plan，而不是扩大 API 分支 |
| `src/lib/rag/core/workflow.ts` | 保留 `RagKernel.execute` 作为真正执行点 | 用 Runnable workflow 标准化 `runName`、tags、metadata、`thread_id`、fallback trace id |
| `src/lib/maic/*` | 保留 `Course -> Prepared -> Scene -> Action` | prepare / classroom 长流程未来可接 durable execution 和 typed interrupt |
| `src/lib/mirofish/*` | 保留 prepare snapshot 和 simulation runner | simulation 可用 thread checkpoint 做恢复；用户确认点可用 typed interrupt |

## 六、官方参考

- LangChain v1 release notes: https://docs.langchain.com/oss/javascript/releases/langchain-v1
- LangChain JS changelog: https://docs.langchain.com/oss/javascript/releases/changelog
- LangChain agents: https://docs.langchain.com/oss/javascript/langchain/agents
- LangChain structured output: https://docs.langchain.com/oss/javascript/langchain/structured-output
- LangGraph v1 release notes: https://docs.langchain.com/oss/javascript/releases/langgraph-v1
- LangGraph persistence: https://docs.langchain.com/oss/javascript/langgraph/persistence
- LangGraph durable execution: https://docs.langchain.com/oss/javascript/langgraph/durable-execution
- LangGraph interrupts: https://docs.langchain.com/oss/javascript/langgraph/interrupts
- LangChain JS security advisories: https://github.com/langchain-ai/langchainjs/security/advisories
- LangGraph security advisories: https://github.com/langchain-ai/langgraph/security/advisories
