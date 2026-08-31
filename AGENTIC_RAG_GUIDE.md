# Agentic RAG 系统指南

> 当前运行时说明（2026-08-28）：canonical `POST /api/ask` 在 `useAgenticRAG=true` 时，先执行服务端 scope 下的检索与 evidence composition，再用顶层 `langchain` 的 `createAgent` 完成一次受限的模型 → 工具 → 模型循环。`src/lib/agentic-rag.ts` 的 Runnable + 显式状态循环只保留为 `RAG_AGENTIC_RUNTIME=legacy` 回滚路径。下文出现的 StateGraph/Annotation 属于历史设计背景；完整边界见 [LANGCHAIN_LANGGRAPH_GUIDE.md](LANGCHAIN_LANGGRAPH_GUIDE.md)。

## 概述

Agentic RAG 的 canonical 路径当前使用真实 `createAgent`。检索仍由 `RagKernel`、`RagLaneExecutor` 和服务端 `retrievalScope` 控制；agent 只能调用一次无参数的只读工具，读取已经验证、排序并截断的 evidence snapshot，不能自行提交 tenant、corpus、query 或过滤条件。旧实现仍提供查询分析、检索评分、有限重写和幻觉检查，但不再是默认路径。

## LangChain / LangGraph v1+ 对齐

截至 2026-05-15，LangChain v1 已将高层 agent 入口收敛到 `createAgent`，并通过 middleware、structured output、model profiles、retry / moderation / summarization middleware 强化生产 agent 开发；LangGraph v1/v1.1 则继续把稳定 Graph API、durable execution、persistence、streaming、human-in-the-loop、typed interrupts 和 `StateSchema` 作为低层编排能力。

本项目没有让通用 agent 接管检索和安全控制面。当前选择是在 canonical RAG 主链末端增加一个最小、可审计的 `createAgent` 叶子循环：

| 最新能力 | 在本模块中的落点 |
|----------|------------------|
| `createAgent` | 已安装 `langchain@1.5.10`；`useAgenticRAG=true` 默认在 `/api/ask` 末端真实执行模型 → `read_scoped_rag_context` → 模型 |
| Structured Output | 已用于 query analysis、retrieval grade、hallucination check，并保留 JSON fallback |
| Middleware | `toolCallLimitMiddleware` 限制工具一次，`modelCallLimitMiddleware` 限制模型两次；超限 fail closed |
| StateSchema | 项目没有手写 StateGraph/StateSchema；`createAgent` 内部使用 LangGraph runtime，业务状态仍由 Kernel/envelope 管理 |
| Durable execution | 当前自研 durable ask 默认关闭，且不是 LangGraph checkpointer |
| Content blocks | PDF 视觉消息已使用 content blocks；答案 envelope 的结构化内容仍是后续演进项 |

### Canonical 入口与回滚

- 请求入口：`POST /api/ask`，Milvus 后端并设置 `useAgenticRAG=true`。
- 默认运行时：未设置 `RAG_AGENTIC_RUNTIME` 或设置为 `create-agent`。
- 显式回滚：`RAG_AGENTIC_RUNTIME=legacy`；其他值会在执行前失败，避免静默选择未知实现。
- agent 只有在 canonical 检索得到可回答 evidence 时才调用模型；无 evidence 或 active abstention 直接返回受控拒答。
- 当前生成模型必须支持原生 tool calling。代码与 hermetic 测试已验证 agent 循环合同；具体部署模型仍需单独 canary。
- scope/integrity 校验后会在首个模型 await 前复制冻结工具快照，调用方后续修改原 context pack 不会改变 agent 可见证据。
- 包含 evidence 的 LangChain child spans 只绑定 non-networked discard client，不上传 LangSmith；canonical agent 的外部观测只保留 content-free 手工 root。输入/输出隐藏不会清洗 child error/stack，因此不能用“双隐藏”开放 child 外传。

## Canonical `createAgent` 工作流

```text
POST /api/ask + useAgenticRAG=true
  → server security context / retrieval scope
  → required dense lane
  → canonical evidence validation + context composition
  → createAgent
      1. model requests read_scoped_rag_context
      2. zero-argument tool returns the validated, locally frozen snapshot
      3. model answers only from that snapshot
  → Kernel envelope + safe agent diagnostics
```

## Legacy 回滚路径能力

以下查询分析、评分、重写和幻觉检查属于 `RAG_AGENTIC_RUNTIME=legacy` 的旧 `AgenticRAGSystem`，不代表默认 createAgent 路径会执行这些额外节点。

### 1. 查询分析与优化 (Query Analysis & Optimization)

系统自动分析用户查询，提取关键信息：

- **意图识别**: factual（事实性）、exploratory（探索性）、comparison（比较）、procedural（操作步骤）
- **复杂度评估**: simple、moderate、complex
- **查询改写**: 自动优化查询语句以提高检索效果
- **关键词提取**: 识别查询中的核心关键词

### 2. 智能检索判断 (Retrieval Decision)

根据查询分析结果，智能决定是否需要检索：

- 简单闲聊类问题可跳过检索
- 需要外部知识的问题自动触发检索
- 支持多轮重试机制

### 3. 自省评分 (Self-Reflection Scoring)

对每个检索结果进行多维度评分：

| 维度 | 说明 |
|------|------|
| relevance | 与查询的相关程度 |
| usefulness | 对回答问题的帮助程度 |
| factuality | 信息的准确性和可信度 |

系统还会给出整体建议：
- **use**: 结果质量好，可直接使用
- **expand**: 需要扩展检索范围
- **rewrite**: 需要重写查询
- **skip**: 结果太差，建议跳过检索

### 4. 检索质量评估 (Retrieval Quality Assessment)

综合评估检索结果的质量：

- **相关性评分**: 检索结果与查询的匹配度
- **覆盖度评分**: 来源多样性
- **多样性评分**: 内容丰富度
- **总体评分**: 综合以上指标

### 5. 幻觉检查 (Hallucination Check)

验证生成内容的事实性：

- 检测答案中是否存在幻觉
- 识别有问题的声明
- 标记有据可查的声明
- 计算整体事实性评分

## Legacy 工作流程

```
┌─────────────────┐
│   用户输入查询   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  查询分析与优化  │ ← 分析意图、复杂度、改写查询
└────────┬────────┘
         │
         ▼
    ┌────────┐
    │需要检索?│
    └────┬───┘
    是   │   否
    ▼    │    ▼
┌───────┐│┌──────────┐
│文档检索│││直接生成答案│
└───┬───┘│└──────────┘
    │    │
    ▼    │
┌───────┐│
│自省评分││
└───┬───┘│
    │    │
    ▼    │
┌────────┐
│需要重写?│ ← 如果质量不佳，重写查询并重试
└────┬───┘
    否│
    ▼
┌───────────┐
│检索质量评估│
└─────┬─────┘
      │
      ▼
┌───────────┐
│  答案生成  │
└─────┬─────┘
      │
      ▼
┌───────────┐
│  幻觉检查  │
└─────┬─────┘
      │
      ▼
┌───────────┐
│  返回结果  │
└───────────┘
```

## API 使用

### Canonical 查询

```typescript
POST /api/ask

{
  "question": "什么是人工智能？",
  "storageBackend": "milvus",
  "useAgenticRAG": true,
  "topK": 5,
  "similarityThreshold": 0.3,
  "llmModel": "llama3.1",
  "embeddingModel": "nomic-embed-text"
}
```

canonical 响应沿用 `/api/ask` envelope，并增加不含 tool payload 的安全诊断：

```typescript
{
  "answer": "人工智能是...",
  "agenticMode": true,
  "agent": {
    "runtime": "langchain-create-agent-v1",
    "toolCallCount": 1,
    "servedEvidenceIds": ["evidence-id"]
  },
  "workflow": {
    "runtime": "langchain-create-agent-v1",
    "steps": [
      { "step": "retrieve_original", "status": "completed" },
      { "step": "agent_model_request_tool", "status": "completed" },
      { "step": "read_scoped_rag_context", "status": "completed" },
      { "step": "agent_model_answer", "status": "completed" }
    ],
    "retryCount": 0
  },
  "queryAnalysis": {
    "analysisMode": "canonical-create-agent",
    "originalQuery": "什么是人工智能？",
    "semanticCategory": "conceptual",
    "intent": "factual",
    "confidence": 0.9,
    "nearestConcepts": ["人工智能"],
    "quality": {
      "queryQualityScore": 0.8,
      "specificity": 0.7,
      "ambiguity": 0.2,
      "retrievability": 0.9
    }
  },
  "evidence": [...],
  "rag": {...}
}
```

该 `workflow` 是新 runtime 的真实兼容投影，只记录 canonical 检索和实际 model → tool → model 边界；不会伪造 legacy 的 retrieval grader、自省评分或幻觉检查。`queryAnalysis.analysisMode` 是 UI 的判别字段，canonical 消费者不会回读 `rewrittenQuery`、`complexity` 或 `needsRetrieval` 等 legacy 字段。首页面板会显示 `LangChain createAgent` runtime；无 evidence 或 active abstention 时生成步骤为 `skipped`，界面明确显示 agent 未调用。durable 首次结果与 replay 使用严格 allowlist 保留同一组 agent/workflow 标量诊断，不持久化 tool context 或原始 metadata。

### Legacy 演示端点

`POST /api/agentic-rag` 保留旧 workflow 的演示/兼容响应；production 或 authenticated access mode 下 legacy route policy 会 fail closed，主产品调用不要依赖它。

```typescript
POST /api/agentic-rag

{
  "question": "什么是人工智能？",
  "topK": 5,
  "similarityThreshold": 0.3,
  "maxRetries": 2,
  "llmModel": "llama3.1",
  "embeddingModel": "nomic-embed-text"
}
```

### Legacy 响应结构

```typescript
{
  "success": true,
  "question": "什么是人工智能？",
  "answer": "人工智能是...",
  
  // 工作流信息
  "workflow": {
    "steps": [...],
    "totalDuration": 5234,
    "retryCount": 0
  },
  
  // 查询分析
  "queryAnalysis": {
    "originalQuery": "什么是人工智能？",
    "rewrittenQuery": "人工智能定义和概念",
    "intent": "factual",
    "complexity": "simple",
    "needsRetrieval": true,
    "keywords": ["人工智能", "定义"],
    "confidence": 0.9
  },
  
  // 检索详情
  "retrievalDetails": {
    "documents": [...],
    "quality": {
      "overallScore": 0.85,
      "relevanceScore": 0.9,
      "coverageScore": 0.8,
      "diversityScore": 0.75,
      "isAcceptable": true,
      "suggestions": []
    },
    "selfReflection": {
      "documentScores": [...],
      "queryAlignmentScore": 0.88,
      "contextCompleteness": 0.82,
      "recommendation": "use"
    }
  },
  
  // 幻觉检查
  "hallucinationCheck": {
    "hasHallucination": false,
    "confidence": 0.95,
    "problematicClaims": [],
    "supportedClaims": ["人工智能是计算机科学的分支"],
    "overallFactualScore": 0.92
  }
}
```

### 在主应用中使用

在主页面切换到 Milvus 后端后，可以启用 Agentic RAG 模式：

```typescript
// 请求参数
{
  "question": "...",
  "storageBackend": "milvus",
  "useAgenticRAG": true
}
```

## 前端组件

### AgenticWorkflowPanel

展示 Agentic RAG 工作流程的可视化组件：

```tsx
import AgenticWorkflowPanel from '@/components/AgenticWorkflowPanel';

<AgenticWorkflowPanel
  workflow={workflow}
  queryAnalysis={queryAnalysis}
  retrievalQuality={retrievalQuality}
  selfReflection={selfReflection}
  hallucinationCheck={hallucinationCheck}
  isLoading={isLoading}
/>
```

## 配置选项

### AgenticRAGConfig

```typescript
interface AgenticRAGConfig {
  ollamaBaseUrl?: string;        // Ollama 服务地址
  llmModel?: string;             // LLM 模型名称
  embeddingModel?: string;       // Embedding 模型名称
  milvusConfig?: {               // Milvus 配置
    address?: string;
    collectionName?: string;
    embeddingDimension?: number;
  };
  enableHallucinationCheck?: boolean;  // 是否启用幻觉检查
  enableSelfReflection?: boolean;      // 是否启用自省评分
}
```

## 最佳实践

1. **合理设置 maxRetries**: 建议设置为 2-3，避免过多重试导致响应时间过长
2. **调整相似度阈值**: 根据数据质量调整，通常 0.3-0.5 较为合适
3. **选择合适的 Top-K**: 5-10 通常能提供足够的上下文
4. **监控工作流步骤**: 通过 workflow.steps 了解每个步骤的耗时和状态
5. **关注幻觉检查结果**: 如果频繁检测到幻觉，可能需要改进知识库质量
6. **优先结构化叶子节点**: 新增或重构查询分析、评分、幻觉检查时，优先采用 LangChain structured output 思维，以 schema 校验替代脆弱的自由文本 JSON。
7. **持久化只给长流程**: 引入 LangGraph checkpointer 前，先确认是否真的需要跨请求恢复、time travel 或 human-in-the-loop；一次性问答保持无状态更简单。

## 性能优化

- 自省评分和幻觉检查会增加 LLM 调用次数，可根据需要禁用
- 使用更快的 LLM 模型可以减少整体响应时间
- 合理设置 maxRetries 避免不必要的重试
- 可把模型重试、摘要压缩和内容安全沉到共享 runtime policy，避免每个 RAG mode 重复实现。

## 故障排除

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 检索结果为空 | Milvus 集合为空 | 先上传文档并同步到 Milvus |
| 响应时间过长 | LLM 调用过多 | 减少 maxRetries，禁用部分检查 |
| 幻觉检测误报 | 上下文不完整 | 增加 Top-K 值 |
| 查询重写循环 | 质量阈值过高 | 降低相似度阈值 |
