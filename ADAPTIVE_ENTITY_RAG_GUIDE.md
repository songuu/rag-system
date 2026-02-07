# 自适应实体路由 RAG (Adaptive Entity-Routing RAG) 系统指南

## 概述

自适应实体路由 RAG 是一个基于 LangGraph 设计理念的智能检索增强生成系统。该系统通过**分层架构设计**，将自然语言理解、逻辑控制、检索执行和数据存储解耦，旨在解决生产环境中查询精准度低和零结果问题。

## 架构设计

### 四层架构

```
┌─────────────────────────────────────────────────────────────┐
│                   第一层：认知解析层                          │
│              Cognitive Parsing Layer                        │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │   实体提取器     │  │   意图分类器     │                  │
│  │ Entity Extractor│  │ Intent Classifier│                  │
│  └─────────────────┘  └─────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   第二层：策略控制层                          │
│              Strategic Control Layer                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐       │
│  │ 实体校验器  │ │ 自适应路由器 │ │   约束松弛器    │       │
│  │  Validator  │ │Adaptive Router│ │Constraint Relaxer│       │
│  └─────────────┘ └─────────────┘ └─────────────────┘       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   第三层：执行检索层                          │
│                  Execution Layer                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐       │
│  │ 结构化检索  │ │  语义检索   │ │   混合重排序    │       │
│  │ Structured  │ │  Semantic   │ │ Hybrid Reranker │       │
│  └─────────────┘ └─────────────┘ └─────────────────┘       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                第四层：数据基础设施层                         │
│              Data Infrastructure Layer                      │
│  ┌─────────────────────┐  ┌─────────────────────┐          │
│  │     向量数据库       │  │   实体元数据存储    │          │
│  │  Vector Database    │  │ Entity Metadata Store│          │
│  │     (Milvus)        │  │   (In-Memory/Redis)  │          │
│  └─────────────────────┘  └─────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件详解

### 1. 认知解析层 (Cognitive Parsing Layer)

**职责**：将非结构化的用户自然语言转化为结构化的数据对象。

#### 实体提取与逻辑分析器 (CognitiveParser)

```typescript
interface ParsedQuery {
  originalQuery: string;      // 原始查询
  entities: ExtractedEntity[]; // 提取的实体
  logicalRelations: LogicalRelation[]; // 逻辑关系 (AND/OR/NOT)
  intent: IntentType;         // 意图类型
  complexity: 'simple' | 'moderate' | 'complex';
  confidence: number;
  keywords: string[];
}
```

**实体类型**:
- `PERSON`: 人名（马斯克、库克）
- `ORGANIZATION`: 组织/公司（苹果、特斯拉）
- `LOCATION`: 地点（北京、上海）
- `PRODUCT`: 产品/品牌（iPhone 15、ChatGPT）
- `DATE`: 日期/时间（2024年）
- `EVENT`: 事件
- `CONCEPT`: 概念/术语
- `OTHER`: 其他

**意图类型**:
- `factual`: 事实查询 → 走实体路由
- `conceptual`: 概念性问题 → 走纯语义检索
- `comparison`: 比较分析
- `procedural`: 操作指导
- `exploratory`: 探索性问题

### 2. 策略控制层 (Strategic Control Layer)

**职责**：作为系统的"大脑"，维护当前状态，执行校验、路由判断和降级策略。

#### 实体校验器 (Entity Validator)

解决用户输入与数据库存储不一致的"脏数据"问题：

- **归一化 (Normalization)**：将同义词映射为标准词
  - "魔都" → "上海"
  - "老马" → "Elon Musk"
  - "苹果" → "Apple"
  
- **模糊匹配 (Fuzzy Matching)**：纠正拼写错误
  - "Iphone" → "iPhone"

#### 自适应路由器 (Adaptive Router)

基于当前上下文决定下一步动作的状态机：

```
IF 有有效实体 AND 意图为事实查询:
    → 结构化过滤检索
ELIF 检索结果为 0 AND 未达重试上限:
    → 约束松弛器（移除优先级最低的条件）
ELIF 检索结果为 0 AND 已达重试上限:
    → 降级为纯语义检索
ELIF 有足够结果:
    → 重排序与生成
ELSE:
    → 混合检索
```

#### 约束松弛器 (Constraint Relaxer)

当精确检索失败时，智能降低查询门槛：

**优先级队列**（高优先级 → 低优先级）:
```
PERSON > ORGANIZATION > PRODUCT > EVENT > LOCATION > DATE > CONCEPT > OTHER
```

移除优先级最低的条件后重试，例如：
- 原始条件：`product="iPhone 15" AND location="北京" AND date="2024"`
- 松弛后：`product="iPhone 15" AND location="北京"` (移除 date)
- 再次松弛：`product="iPhone 15"` (移除 location)

### 3. 执行检索层 (Execution Layer)

**职责**：执行具体的数据库 I/O 操作。

#### 结构化检索引擎 (Structured Filter Engine)

执行带强过滤条件的向量检索：

```typescript
const filterExpr = 'product like "%iPhone%" && location == "北京"';
const results = await milvus.search({
  vector: queryVector,
  filter: filterExpr,
  topK: 10
});
```

#### 语义检索引擎 (Semantic Search Engine)

执行纯向量相似度检索（兜底手段）：

```typescript
const results = await milvus.search({
  vector: queryVector,
  topK: 10
});
```

#### 混合重排序器 (Hybrid Reranker)

使用 Cross-Encoder 模型对召回结果进行精细化排序：

```typescript
interface RankedResult {
  id: string;
  score: number;           // 原始相似度分数
  rerankedScore: number;   // 重排序后分数
  relevanceExplanation: string; // 相关性解释
}
```

### 4. 数据基础设施层 (Data Infrastructure Layer)

#### 向量数据库 (Vector Database)

使用 Milvus 存储：
- 文档的 Embedding 向量
- 原始文本 Chunk
- 结构化元数据（便于过滤）

#### 实体元数据存储 (Entity Metadata Store)

```typescript
interface EntityMetadata {
  standardName: string;    // 标准名称
  type: EntityType;        // 实体类型
  aliases: string[];       // 同义词列表
  hierarchy?: string[];    // 层级关系（如：中国 > 北京 > 朝阳）
  relatedEntities?: string[]; // 相关实体
}
```

## 工作流程

```
用户提问 → 实体提取 → 意图分类
              ↓
         实体校验与归一化
              ↓
         路由决策
         ├── 结构化检索 ─┬─ 有结果 → 重排序 → 生成回答
         │              └─ 无结果 → 约束松弛 → 重试
         ├── 语义检索 ──────────→ 重排序 → 生成回答
         └── 混合检索 ──────────→ 重排序 → 生成回答
```

## API 接口

### 查询接口

```http
POST /api/adaptive-entity-rag
Content-Type: application/json

{
  "action": "query",
  "question": "马斯克创办的公司有哪些？",
  "topK": 5,
  "llmModel": "qwen2.5:7b",
  "embeddingModel": "nomic-embed-text",
  "maxRetries": 3,
  "enableReranking": true
}
```

### 响应结构

```typescript
{
  success: true,
  answer: "AI 生成的回答",
  workflow: {
    steps: WorkflowStep[],  // 工作流步骤
    totalDuration: number   // 总耗时
  },
  queryAnalysis: {
    originalQuery: string,
    intent: string,
    complexity: string,
    entities: ExtractedEntity[]
  },
  entityValidation: ValidatedEntity[], // 实体校验结果
  routingDecision: {
    action: string,        // 路由动作
    reason: string,        // 决策原因
    relaxedConstraints: string[] // 已松弛的约束
  },
  retrievalDetails: {
    searchResultCount: number,
    rankedResultCount: number,
    topResults: RankedResult[]
  }
}
```

### 添加实体映射

```http
POST /api/adaptive-entity-rag
Content-Type: application/json

{
  "action": "add-entity",
  "standardName": "埃隆·马斯克",
  "type": "PERSON",
  "aliases": ["马斯克", "老马", "Elon Musk", "Musk"]
}
```

### 获取实体列表

```http
GET /api/adaptive-entity-rag?action=entities&type=PERSON
```

## 配置选项

```typescript
interface AdaptiveRAGConfig {
  llmModel: string;           // LLM 模型
  embeddingModel: string;     // Embedding 模型
  maxRetries: number;         // 最大重试次数
  constraintPriority: EntityType[]; // 约束松弛优先级
  minResultCount: number;     // 最小结果数量
  similarityThreshold: number; // 相似度阈值
  enableReranking: boolean;   // 是否启用重排序
  milvusCollection: string;   // Milvus 集合名称
}
```

## 使用示例

### 示例 1：事实性查询

**输入**：`"马斯克创办的公司有哪些？"`

**处理流程**：
1. 提取实体：`马斯克 (PERSON)`
2. 归一化：`马斯克 → Elon Musk`
3. 意图分类：`factual`
4. 路由决策：`structured_search`
5. 检索条件：`person like "%Elon Musk%"`
6. 重排序后返回结果

### 示例 2：约束松弛

**输入**：`"2024年苹果在北京发布的产品"`

**处理流程**：
1. 提取实体：
   - `2024 (DATE)`
   - `苹果 (ORGANIZATION) → Apple`
   - `北京 (LOCATION)`
2. 第一次检索：`organization="Apple" AND location="北京" AND date="2024"` → 0 结果
3. 松弛约束：移除 `DATE`
4. 第二次检索：`organization="Apple" AND location="北京"` → 3 结果
5. 重排序后返回结果

### 示例 3：概念性查询

**输入**：`"什么是机器学习？"`

**处理流程**：
1. 提取实体：`机器学习 (CONCEPT)`
2. 意图分类：`conceptual`
3. 路由决策：`semantic_search` (直接语义检索)
4. 返回结果

## 最佳实践

1. **实体库维护**：定期添加新的实体映射和同义词
2. **优先级调整**：根据业务需求调整约束松弛优先级
3. **重排序优化**：对于高精度要求的场景启用重排序
4. **监控指标**：关注松弛次数和降级率

## 故障排除

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 检索结果为空 | 实体未正确归一化 | 添加实体同义词映射 |
| 相关性差 | 未启用重排序 | 开启 `enableReranking` |
| 响应慢 | 重试次数过多 | 减少 `maxRetries` |
| 实体提取不准 | LLM 模型能力不足 | 使用更大的模型 |

## 相关链接

- [GraphRAG 实体抽取](/entity-extraction)
- [Agentic RAG](/agentic-rag)
- [Self-Corrective RAG](/self-corrective-rag)
- [Milvus 向量数据库](/milvus)
