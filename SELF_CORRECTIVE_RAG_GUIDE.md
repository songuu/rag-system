# Self-Corrective RAG 架构设计指南

## 概述

Self-Corrective RAG（自省式修正检索增强生成）是基于 **LangGraph + Milvus** 的 4 节点质量控制闭环架构。与传统 RAG 和 Agentic RAG 不同，它通过独立的 LLM 质检员来确保只有高质量文档才能进入生成阶段。

## 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Self-Corrective RAG 架构                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   START                                                          │
│     │                                                            │
│     ▼                                                            │
│  ┌──────────┐                                                    │
│  │ RETRIEVE │ ◄──────────────────────────────────────────┐      │
│  │  检索者  │                                            │      │
│  └────┬─────┘                                            │      │
│       │                                                   │      │
│       ▼                                                   │      │
│  ┌──────────┐      质检未通过       ┌──────────┐         │      │
│  │  GRADER  │ ─────────────────────► │ REWRITE  │ ────────┘      │
│  │  质检员  │   (passRate < 60%)    │  修正者  │                 │
│  └────┬─────┘                       └──────────┘                 │
│       │                                                          │
│       │ 质检通过 (passRate >= 60%)                               │
│       │ 或已达最大重写次数                                        │
│       ▼                                                          │
│  ┌──────────┐                                                    │
│  │ GENERATE │                                                    │
│  │  生成者  │                                                    │
│  └────┬─────┘                                                    │
│       │                                                          │
│       ▼                                                          │
│     END                                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 4 个关键节点

### 1. Retrieve (检索者) 🔍

**职责**: 从 Milvus 向量数据库检索 Top-K 相关文档

**输入**:
- `currentQuery`: 当前查询（原始或重写后）
- `topK`: 检索文档数量
- `similarityThreshold`: 相似度阈值

**输出**:
- `retrievedDocuments`: 检索到的文档列表

**实现细节**:
```typescript
async function retrieveNode(state) {
  const query = state.currentQuery || state.originalQuery;
  
  // 1. 获取 Milvus 实例
  const milvus = await getMilvusInstance(state.milvusConfig);
  
  // 2. 根据 collection 维度选择 embedding 模型
  const stats = await milvus.getCollectionStats();
  const embeddingModel = selectModelByDimension(stats.dimension);
  
  // 3. 生成查询向量
  const embeddings = new OllamaEmbeddings({ model: embeddingModel });
  const queryVector = await embeddings.embedQuery(query);
  
  // 4. 执行向量搜索
  const results = await milvus.search(queryVector, state.topK);
  
  return { retrievedDocuments: results };
}
```

### 2. Grader (质检员) 🔬 **核心节点！**

**职责**: 使用轻量级 LLM 判断每个文档是否包含回答问题的必要信息

**特点**:
- **不回答问题**，只做二分类判断（相关/不相关）
- 充当**过滤器**，拦截 Milvus 返回的噪音
- 防止"垃圾输入导致垃圾输出"

**评估逻辑**:
```typescript
const graderPrompt = `
你是一个专业的文档相关性评估专家。
请判断给定的文档是否包含回答用户问题的必要信息。

用户问题：{question}
待评估文档：{document}

评估标准：
1. 文档是否包含与问题直接相关的信息？
2. 文档中的信息是否足以部分或完全回答问题？
3. 文档内容是否与问题的核心意图匹配？

返回 JSON：
{
  "is_relevant": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "判断理由"
}
`;
```

**决策规则**:
- 如果 `passRate >= gradePassThreshold` → 进入 Generate
- 如果 `passRate < gradePassThreshold` 且 `rewriteCount < maxRewriteAttempts` → 触发 Rewrite
- 如果已达最大重写次数 → 强制进入 Generate

### 3. Rewrite (修正者) ✏️

**职责**: 当 Grader 判定质量不佳时，分析失败原因并生成新的查询

**触发条件**: 质检通过率低于阈值

**价值**: 模拟人类"换个词搜搜看"的行为

**重写策略**:
```typescript
const rewritePrompt = `
用户的原始查询没有获得理想的检索结果，请分析原因并生成更好的查询。

原始问题：{original_query}
当前查询：{current_query}
失败的检索结果：{failed_context}
历史重写记录：{rewrite_history}

重写策略建议：
1. 如果原查询太宽泛，尝试添加具体限定词
2. 如果原查询太具体，尝试使用更通用的术语
3. 使用同义词或相关概念
4. 拆分复合问题为更简单的形式
5. 保留核心意图，调整表达方式

返回 JSON：
{
  "rewritten_query": "新的优化查询",
  "rewrite_reason": "重写原因",
  "keywords": ["关键词1", "关键词2"]
}
`;
```

### 4. Generate (生成者) 💬

**职责**: 基于通过质检的高质量文档生成最终回答

**前置条件**: 只有通过 Grader 质检的文档才能进入

**价值**: 确保 LLM 拿到的 Context 是纯净的

**实现**:
```typescript
const generatePrompt = `
基于以下经过质量验证的文档内容，准确回答用户的问题。

用户问题：{question}
参考文档（已通过相关性验证）：{context}

回答要求：
1. 只使用参考文档中的信息，不要编造
2. 如果信息不完整，诚实说明
3. 用清晰、简洁的语言回答
4. 如果可能，引用信息来源
5. 保持专业但友好的语气
`;
```

## 状态定义

```typescript
interface SCRAGState {
  // 查询相关
  originalQuery: string;           // 用户原始查询（永不修改）
  currentQuery: string;            // 当前使用的查询（可能被重写）
  
  // 检索配置
  topK: number;                    // 检索数量
  similarityThreshold: number;     // 相似度阈值
  maxRewriteAttempts: number;      // 最大重写次数
  gradePassThreshold: number;      // 质检通过阈值 (0-1)
  
  // 检索结果
  retrievedDocuments: SCDocument[];
  graderResult?: GraderResult;
  filteredDocuments: SCDocument[]; // 通过质检的文档
  
  // 重写相关
  rewriteHistory: RewriteResult[];
  currentRewriteCount: number;
  
  // 生成结果
  generationResult?: GenerationResult;
  finalAnswer: string;
  
  // 流程控制
  currentNode: string;
  shouldContinue: boolean;
  decisionPath: string[];          // 决策路径追踪
}
```

## 与 Agentic RAG 的区别

| 特性 | Self-Corrective RAG | Agentic RAG |
|------|---------------------|-------------|
| **节点数量** | 4 个核心节点 | 多节点复杂流程 |
| **质检方式** | 独立 LLM 调用 | 规则评分 + 自省 |
| **重写策略** | "换词重搜"闭环 | 查询扩展/改写 |
| **设计理念** | 质量控制优先 | 功能全面 |
| **执行效率** | 更快速、精简 | 更全面、详细 |
| **适用场景** | 快速高质量回答 | 复杂推理任务 |

## API 使用

### 端点

```
POST /api/self-corrective-rag
```

### 请求参数

```json
{
  "query": "用户问题",
  "topK": 5,
  "similarityThreshold": 0.3,
  "maxRewriteAttempts": 3,
  "gradePassThreshold": 0.6,
  "milvusConfig": {
    "address": "localhost:19530",
    "collectionName": "rag_documents"
  }
}
```

### 响应结构

```json
{
  "success": true,
  "answer": "生成的回答",
  "query": {
    "original": "原始查询",
    "final": "最终查询",
    "wasRewritten": true,
    "rewriteCount": 2
  },
  "rewriteHistory": [...],
  "retrieval": {
    "totalDocuments": 5,
    "filteredDocuments": 3,
    "documents": [...]
  },
  "graderResult": {
    "passRate": 0.6,
    "passCount": 3,
    "totalCount": 5,
    "shouldRewrite": false,
    "reasoning": "..."
  },
  "workflow": {
    "nodeExecutions": [...],
    "decisionPath": [...],
    "totalDuration": 2500
  }
}
```

## 前端页面

访问 `/self-corrective-rag` 查看完整的交互界面，包括：

1. **配置面板**: 调整检索和质检参数
2. **对话区域**: 实时问答交互
3. **工作流可视化**: 查看 4 节点执行状态
4. **决策路径**: 追踪系统决策过程
5. **质检详情**: 查看每个文档的评估结果

## 最佳实践

### 1. 调整质检阈值

- **严格模式** (`gradePassThreshold = 0.8`): 更高质量，可能需要更多重写
- **宽松模式** (`gradePassThreshold = 0.4`): 更快响应，质量可能略低

### 2. 控制重写次数

- **建议值**: 2-3 次
- **过多**: 延迟增加，用户体验下降
- **过少**: 可能无法获得满意结果

### 3. 优化检索参数

- **topK**: 根据知识库大小调整（5-10 通常足够）
- **similarityThreshold**: 根据数据质量调整（0.3-0.5）

## 调试技巧

1. **查看决策路径**: 了解系统每一步的决策
2. **检查质检结果**: 分析哪些文档被过滤
3. **追踪重写历史**: 理解查询优化过程
4. **监控执行时间**: 识别性能瓶颈

## 文件结构

```
src/
├── lib/
│   └── self-corrective-rag.ts    # 核心引擎
├── app/
│   ├── api/
│   │   └── self-corrective-rag/
│   │       └── route.ts          # API 路由
│   └── self-corrective-rag/
│       └── page.tsx              # 前端页面
└── components/
    └── SelfCorrectiveRAGVisualizer.tsx  # 可视化组件
```
