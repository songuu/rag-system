# 上下文管理系统架构指南

## 一、系统概述

### 1.1 核心挑战

在多轮对话的 RAG 系统中，存在两个核心挑战：

| 挑战 | 描述 | 示例 |
|------|------|------|
| **向量检索健忘** | 向量数据库无法理解代词和省略句 | "它多少钱？" → 检索不到任何结果 |
| **LLM 窗口限制** | 对话历史过长会超出 Token 限制 | 20轮对话 → Context Window 溢出 |

### 1.2 解决方案

本系统采用 **状态流转与认知加工** 的方式，通过以下机制解决上述挑战：

- **查询改写 (Query Rewriting)**: 将包含代词的问题改写为独立完整的问题
- **窗口管理 (Window Management)**: 动态截断对话历史，控制 Token 消耗
- **摘要压缩 (Summary Compression)**: 将长历史压缩为简洁摘要
- **状态持久化 (State Checkpointing)**: 支持会话恢复和无状态扩展

---

## 二、宏观架构全景图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     Context Management Lifecycle (LangGraph)                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌──────────────┐                                                              │
│   │   用户请求    │                                                              │
│   │  + SessionID │                                                              │
│   └──────┬───────┘                                                              │
│          │                                                                       │
│          ▼                                                                       │
│   ┌──────────────┐     ┌──────────────┐                                        │
│   │ 1. 状态加载器 │◄────│  持久化存储   │  (Postgres/Redis/File)                │
│   │ State Loader │     │  Checkpointer │                                        │
│   └──────┬───────┘     └──────────────┘                                        │
│          │                                                                       │
│          ▼                                                                       │
│   ┌──────────────┐                                                              │
│   │ 2. 窗口截断器 │  滑动窗口 / Token限制 / 混合策略                            │
│   │ Token Trimmer│                                                              │
│   └──────┬───────┘                                                              │
│          │                                                                       │
│          ▼                                                                       │
│   ┌──────────────┐     是否存在历史？                                           │
│   │   条件分支    │─────────────────────┐                                       │
│   └──────┬───────┘                      │                                       │
│          │ Yes                          │ No                                    │
│          ▼                              │                                       │
│   ┌──────────────┐                      │                                       │
│   │ 3. 查询改写器 │  指代消解            │                                       │
│   │ Query Rewriter│  "它" → "上下文中的它" │                                       │
│   └──────┬───────┘                      │                                       │
│          │                              │                                       │
│          ▼                              ▼                                       │
│   ┌──────────────┐◄─────────────────────┘                                       │
│   │ 4. 向量检索器 │  使用改写后的Query                                          │
│   │   Retriever  │◄────► Vector DB (Milvus)                                    │
│   └──────┬───────┘                                                              │
│          │                                                                       │
│          ▼                                                                       │
│   ┌──────────────┐                                                              │
│   │ 5. 响应生成器 │  历史 + 检索文档 → LLM → 回答                               │
│   │   Generator  │◄────► LLM (Ollama)                                          │
│   └──────┬───────┘                                                              │
│          │                                                                       │
│          ▼                                                                       │
│   ┌──────────────┐     ┌──────────────┐                                        │
│   │ 6. 状态保存器 │────►│  持久化存储   │                                        │
│   │ Checkpointer │     │   Database   │                                        │
│   └──────────────┘     └──────────────┘                                        │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心层级架构

### 3.1 状态层 (State Layer) - 使用 LangGraph Annotation

使用 LangGraph 官方的 `Annotation.Root()` 定义状态，这是推荐的状态定义方式：

```typescript
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

const ContextGraphState = Annotation.Root({
  // 1. 消息历史 - 使用官方的 messagesStateReducer
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,  // 官方提供的消息合并策略
    default: () => [],
  }),
  
  // 2. 当前查询
  currentQuery: Annotation<string>({
    reducer: (_, y) => y,  // 使用最新值
    default: () => '',
  }),
  
  // 3. 改写后的查询
  rewrittenQuery: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  
  // 4. 检索到的文档
  retrievedDocs: Annotation<RetrievedDocument[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  
  // 5. 工作流步骤 - 使用累加策略
  workflowSteps: Annotation<WorkflowStep[]>({
    reducer: (x, y) => [...x, ...y],  // 累加新步骤
    default: () => [],
  }),
  
  // 6. 会话 ID
  sessionId: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
});
```

#### Annotation Reducer 策略

| Reducer | 描述 | 使用场景 |
|---------|------|----------|
| `messagesStateReducer` | 官方消息合并策略，支持消息去重和更新 | 消息历史 |
| `(_, y) => y` | 使用最新值覆盖 | 单值属性 |
| `(x, y) => [...x, ...y]` | 累加数组 | 工作流步骤 |

#### 消息类型 (使用 LangChain 官方类型)

```typescript
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';

// 创建消息
const userMsg = new HumanMessage('你好');
const aiMsg = new AIMessage('你好！有什么可以帮你的？');
const sysMsg = new SystemMessage('你是一个智能助手');
```

### 3.2 加工层 (Processing Layer)

#### 3.2.1 窗口管理器 - 使用官方 trimMessages

使用 LangGraph 官方的 `trimMessages` 函数进行消息截断：

```typescript
import { trimMessages } from '@langchain/core/messages';

// 使用官方 trimMessages
const trimmedMessages = await trimMessages(messages, {
  maxTokens: 4000,                    // 最大 Token 数
  tokenCounter: (msgs) => {           // Token 计数函数
    return msgs.reduce((sum, msg) => {
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      return sum + estimateTokens(content);
    }, 0);
  },
  strategy: 'last',                   // 保留最近的消息
  startOn: 'human',                   // 从 human 消息开始
  includeSystem: true,                // 保留 system 消息
});
```

| 参数 | 描述 | 默认值 |
|------|------|--------|
| `maxTokens` | 最大 Token 数限制 | 4000 |
| `strategy` | `'last'` 保留最近, `'first'` 保留最早 | `'last'` |
| `startOn` | 从哪种消息类型开始 | `'human'` |
| `includeSystem` | 是否保留系统消息 | `true` |

#### 3.2.2 查询改写器 (Query Rewriter)

解决 **指代消解 (Coreference Resolution)** 和 **主题追踪** 问题：

```
对话历史:
  用户: "介绍下华为Mate60"
  AI: "华为Mate60是一款旗舰手机，搭载麒麟9000s..."
  用户: "它的下一代是什么？"
  AI: "华为Mate60的下一代可能是Mate70系列..."

当前问题: "版本是多少呢？"
                    ↓ Query Rewriter (带主题追踪)
改写结果: "华为Mate60下一代产品的版本是多少？"
```

**核心能力**：
1. **主题追踪**: 识别对话中建立的讨论主题（如 "华为Mate60下一代"）
2. **指代消解**: 将代词替换为具体实体
3. **省略补全**: 补充被省略的主语、宾语

**触发条件**：
- 存在代词：它、这个、那个、他们、她们、这些、那些
- 存在省略：前面、上面、刚才、之前
- 问句过短（可能省略主语）
- 追问细节：版本、价格、配置等

### 3.3 执行层 (Execution Layer)

#### 3.3.1 检索器 (Retriever)

- **输入**: 使用 **改写后的独立问题** (Rewritten Query)
- **动作**: 在向量数据库中进行语义搜索
- **自动维度适配**: 检测集合维度，自动切换兼容的 Embedding 模型

```typescript
// 自动维度适配逻辑
const stats = await milvus.getCollectionStats();
if (stats.embeddingDimension !== configuredDimension) {
  // 自动选择兼容的模型
  embeddingModel = selectModelByDimension(stats.embeddingDimension);
}
```

#### 3.3.2 相关性验证器 (Relevance Validator)

检索后对结果进行相关性过滤，防止使用不相关的文档：

- **关键词匹配**: 检查文档是否包含查询的关键实体/关键词
- **相似度阈值**: 过滤低于阈值的结果
- **主题一致性**: 确保检索结果与对话主题相关

```typescript
// 过滤逻辑
const relevantDocs = docs.filter(doc => {
  // 基本相似度过滤
  if (doc.score < 0.2) return false;
  
  // 关键词匹配检查
  const keywordMatches = queryKeywords.filter(kw => 
    doc.content.includes(kw)
  );
  
  // 至少匹配一个关键词，或相似度较高
  return keywordMatches.length > 0 || doc.score > 0.5;
});
```

#### 3.3.3 生成器 (Generator)

- **输入**: 
  - `Original History`: 原始对话流（保持语气连贯）
  - `Retrieved Documents`: 检索到的知识片段（经过相关性过滤）
  - `Topic Context`: 对话主题上下文
- **输出**: 基于知识的回答

**生成策略**：
1. **相关性优先**: 只使用与问题真正相关的资料
2. **诚实承认**: 如果资料不相关，明确告知用户
3. **主题连贯**: 保持与对话主题的一致性
4. **不编造**: 不基于不相关资料强行回答

### 3.4 持久层 (Persistence Layer)

#### Checkpointer 机制

```typescript
class Checkpointer {
  // 内存缓存（短时记忆）
  private memoryCache: Map<string, ContextState>;
  
  // 文件持久化（长时记忆）
  private dataDir: string = 'data/context-sessions';
  
  // 保存状态快照
  async save(state: ContextState): Promise<void>;
  
  // 加载状态
  async load(sessionId: string): Promise<ContextState | null>;
  
  // 列出所有会话
  async listSessions(): Promise<SessionMetadata[]>;
  
  // 删除会话
  async delete(sessionId: string): Promise<boolean>;
}
```

**存储层级**：

| 层级 | 存储介质 | 用途 |
|------|----------|------|
| L1 | 内存 (Map) | 热会话快速访问 |
| L2 | 文件系统 (JSON) | 持久化存储 |
| L3 | 数据库 (可扩展) | 生产环境大规模存储 |

---

## 四、工作流详解

### 4.1 完整工作流程

```
1. 加载 (Load)
   └─ 用户发送 "版本是多少呢？" + thread_id=123
   └─ 系统加载 ID=123 的历史: [User: Mate60下一代是什么?, AI: 可能是Mate70...]

2. 截断 (Trim)
   └─ 检查历史 Token 是否超限
   └─ 如超限，删除最早记录，保留系统提示

3. 改写 (Rewrite) ⭐ 主题追踪
   └─ 检测到存在历史记录
   └─ 识别主题: "华为Mate60下一代"
   └─ "版本是多少呢？" → "华为Mate60下一代产品的版本是多少？"

4. 检索 (Retrieve)
   └─ 使用改写后的完整句子检索
   └─ 返回 5 条候选结果

5. 相关性验证 (Validate) ⭐ 新增
   └─ 提取关键词: ["华为", "Mate60", "下一代", "版本"]
   └─ 过滤不包含关键词的结果
   └─ 过滤相似度过低的结果
   └─ 保留 2 条相关文档

6. 生成 (Generate)
   └─ LLM 看到完整历史（保持语气）
   └─ LLM 看到过滤后的文档（仅相关内容）
   └─ 如无相关文档，诚实告知用户
   └─ 生成回答: "关于华为Mate60下一代的版本..."

7. 保存 (Save)
   └─ 追加新的 User/AI 消息到 State
   └─ 写入持久化存储
```

### 4.2 工作流步骤可视化

每个步骤都会记录详细信息：

```typescript
interface WorkflowStep {
  step: string;           // 步骤名称
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;      // 耗时 (ms)
  details?: {             // 详细信息
    action?: string;
    sessionId?: string;
    messageCount?: number;
    trimmedCount?: number;
    originalQuery?: string;
    rewrittenQuery?: string;
    resultCount?: number;
    // ...
  };
  error?: string;
}
```

---

## 五、API 接口

### 5.1 查询接口

```http
POST /api/context-management
Content-Type: application/json

{
  "action": "query",
  "sessionId": "session-123",
  "question": "它的续航怎么样？",
  "llmModel": "qwen2.5:0.5b",
  "embeddingModel": "bge-m3:latest",
  "windowStrategy": "hybrid",
  "maxRounds": 10,
  "maxTokens": 4000,
  "enableQueryRewriting": true,
  "topK": 5,
  "similarityThreshold": 0.3
}
```

**响应**：

```json
{
  "success": true,
  "response": "华为Mate60的续航表现非常出色...",
  "rewrittenQuery": "华为Mate60的续航表现怎么样？",
  "retrievedDocs": [...],
  "workflow": {
    "steps": [...],
    "totalDuration": 1234
  },
  "sessionInfo": {
    "sessionId": "session-123",
    "messageCount": 4,
    "totalTokens": 856,
    "truncatedCount": 0
  }
}
```

### 5.2 会话管理接口

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `?action=sessions` | 获取所有会话列表 |
| GET | `?action=session&sessionId=xxx` | 获取单个会话详情 |
| POST | `action=create-session` | 创建新会话 |
| POST | `action=delete-session` | 删除会话 |
| POST | `action=compress` | 手动压缩历史为摘要 |
| DELETE | `?sessionId=xxx` | 删除会话 |

---

## 六、配置参数

### 6.1 完整配置

```typescript
interface ContextManagerConfig {
  // 模型配置
  llmModel: string;              // LLM 模型 (默认: qwen2.5:0.5b)
  embeddingModel: string;        // Embedding 模型 (默认: bge-m3:latest)
  
  // Milvus 配置
  milvusCollection: string;      // 集合名称 (默认: rag_documents)
  
  // 窗口管理
  windowConfig: {
    strategy: WindowStrategy;    // 默认: hybrid
    maxRounds?: number;          // 默认: 10
    maxTokens?: number;          // 默认: 4000
    summaryThreshold?: number;   // 默认: 3000
    preserveSystemPrompt?: boolean; // 默认: true
  };
  
  // 功能开关
  enableQueryRewriting: boolean; // 默认: true
  enableSummarization: boolean;  // 默认: true
  
  // 检索配置
  maxRetries: number;            // 默认: 3
  similarityThreshold: number;   // 默认: 0.3
  topK: number;                  // 默认: 5
}
```

### 6.2 推荐配置

| 场景 | 配置建议 |
|------|----------|
| **轻量对话** | `maxRounds=5`, `maxTokens=2000`, `strategy=sliding_window` |
| **深度对话** | `maxRounds=15`, `maxTokens=6000`, `strategy=hybrid` |
| **成本敏感** | `maxTokens=2000`, `enableSummarization=true` |
| **精度优先** | `similarityThreshold=0.5`, `topK=10` |

---

## 七、文件结构

```
src/
├── lib/
│   └── context-management.ts    # 核心库 (使用 LangGraph 官方 API)
│       ├── ContextGraphState    # Annotation 状态定义
│       ├── trimMessagesNode     # 消息截断节点 (使用 trimMessages)
│       ├── rewriteQueryNode     # 查询改写节点
│       ├── retrieveNode         # 向量检索节点
│       ├── filterRelevanceNode  # 相关性过滤节点
│       ├── generateNode         # 响应生成节点
│       └── ContextManager       # 主类 (使用 StateGraph + MemorySaver)
│
├── app/
│   ├── api/
│   │   └── context-management/
│   │       └── route.ts         # API 路由
│   │
│   └── context-management/
│       └── page.tsx             # 前端页面
│
└── data/
    └── context-sessions/        # 会话持久化目录
        ├── session-123.json
        └── session-456.json
```

---

## 八、架构优势

| 优势 | 描述 |
|------|------|
| **检索准确性高** | 通过查询改写彻底解决多轮对话中检索失效的问题 |
| **成本可控** | 通过窗口管理器严格控制 Token 消耗 |
| **无状态扩展** | 依赖外部持久化的 Checkpointer，支持横向扩缩容 |
| **可调试性** | 每个节点都保存快照，支持回放和问题定位 |
| **自动维度适配** | 自动检测并切换兼容的 Embedding 模型 |

---

## 九、使用示例

### 9.1 基本使用

```typescript
import { createContextManager } from '@/lib/context-management';

// 创建管理器
const manager = createContextManager({
  llmModel: 'qwen2.5:0.5b',
  embeddingModel: 'bge-m3:latest',
  windowConfig: {
    strategy: 'hybrid',
    maxRounds: 10,
    maxTokens: 4000,
  },
});

// 处理查询
const result = await manager.processQuery(
  'session-123',
  '它的续航怎么样？',
  { topK: 5, similarityThreshold: 0.3 }
);

console.log(result.response);           // AI 回答
console.log(result.rewrittenQuery);     // 改写后的查询
console.log(result.workflowSteps);      // 工作流详情
```

### 9.2 会话管理

```typescript
// 创建新会话
const session = await manager.createSession('user-001');

// 获取会话列表
const sessions = await manager.listSessions();

// 获取会话详情
const state = await manager.getSession('session-123');

// 手动压缩历史
const compressResult = await manager.compressBySummary('session-123');

// 删除会话
await manager.deleteSession('session-123');
```

### 9.3 StateGraph 工作流定义 (官方 API)

```typescript
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';

// 构建 StateGraph
const workflow = new StateGraph(ContextGraphState)
  // 添加节点
  .addNode('trim_messages', trimMessagesNode)
  .addNode('rewrite_query', rewriteQueryNode)
  .addNode('retrieve', retrieveNode)
  .addNode('filter_relevance', filterRelevanceNode)
  .addNode('generate', generateNode)
  
  // 添加边 - 使用官方 START/END 常量
  .addEdge(START, 'trim_messages')
  .addEdge('trim_messages', 'rewrite_query')
  .addEdge('rewrite_query', 'retrieve')
  .addEdge('retrieve', 'filter_relevance')
  .addEdge('filter_relevance', 'generate')
  .addEdge('generate', END);

// 使用 MemorySaver 作为检查点
const checkpointer = new MemorySaver();

// 编译图
const graph = workflow.compile({
  checkpointer: checkpointer,
});

// 执行工作流
const result = await graph.invoke(
  { currentQuery: '你好', sessionId: 'session-123' },
  { configurable: { thread_id: 'session-123' } }  // LangGraph 官方方式
);
```

#### 条件边 (可选)

```typescript
// 添加条件边 - 根据状态决定下一个节点
workflow.addConditionalEdges(
  'rewrite_query',
  (state) => {
    // 如果不需要改写，跳过检索直接生成
    if (!state.needsRewrite && state.messages.length === 1) {
      return 'generate';  // 直接生成问候回复
    }
    return 'retrieve';  // 正常检索流程
  },
  {
    generate: 'generate',
    retrieve: 'retrieve',
  }
);
```

---

## 十、常见问题

### Q1: 向量维度不匹配错误

**错误**: `vector dimension mismatch`

**原因**: 查询使用的 Embedding 模型维度与 Milvus 集合中存储的向量维度不一致。

**解决**: 系统已实现自动维度适配，会自动切换到兼容的模型。如仍出现问题，请确保使用与知识库创建时相同的 Embedding 模型。

### Q2: 查询改写效果不佳

**解决方案**：
1. 检查 LLM 模型能力（建议使用 7B 以上模型）
2. 确保历史记录中有足够的上下文
3. 调整 `maxRounds` 参数，保留更多历史

### Q3: Token 超限

**解决方案**：
1. 降低 `maxTokens` 配置
2. 启用摘要压缩 (`enableSummarization=true`)
3. 定期手动触发压缩

### Q4: 检索结果与问题不匹配

**现象**: 用户追问话题细节时，系统返回不相关的内容（如问"版本是多少"却返回屏幕对比信息）

**原因**：
1. 查询改写未能正确追踪对话主题
2. 知识库中缺少相关信息
3. 检索结果未经相关性验证

**解决方案**：
1. 系统已增强主题追踪能力，会自动识别对话中建立的主题
2. 增加了相关性验证步骤，过滤与问题不相关的检索结果
3. 生成器会在资料不相关时诚实告知用户
4. 如仍有问题，可以在知识库中补充相关内容

### Q5: 多轮追问时回答重复

**原因**: 知识库中只有有限的相关文档，每次检索都返回相同内容。

**解决方案**：
1. 丰富知识库内容，覆盖更多细节
2. 调整 `topK` 参数获取更多候选结果
3. 利用对话历史中已回答的内容，避免重复

---

## 十一、版本历史

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| v1.0.0 | 2026-01-22 | 初始版本，实现完整的上下文管理架构 |

---

## 十二、参考资料

- [LangGraph 官方文档](https://python.langchain.com/docs/langgraph)
- [Milvus 向量数据库](https://milvus.io/docs)
- [Ollama 本地 LLM](https://ollama.ai)
