# Contextual Retrieval (上下文检索增强) 系统指南

## 🎯 功能概述

**Contextual Retrieval** 是一种在 Embedding 之前为每个文本切片 (Chunk) 注入全文语境的技术。传统 RAG 管道将文档分割为固定大小的 Chunk 后直接进行 Embedding，每个 Chunk 丧失了所属文档的整体上下文，导致语义匹配质量受限。Contextual Retrieval 通过 LLM 阅读完整文档并为每个 Chunk 生成一段简短的"背景提要 (Contextual Preamble)"，再将提要与原始切片拼接后进行 Embedding，显著提升检索相关性。

> 参考：Anthropic 官方 Contextual Retrieval 方案

## 📊 系统架构

### 传统 RAG 管道 vs Contextual Retrieval 管道

```
传统 RAG:
  Document → Load → Split → [chunks] → Embed → Store
                              ↓
                     每个 chunk 独立，缺失文档上下文

Contextual Retrieval:
  Document → Load → Split → [chunks] → Contextualize(LLM) → Embed → Store
                                              ↑
                                    LLM 阅读全文，为每个 chunk
                                    生成简短的背景提要 (preamble)
                                              ↓
                              最终 Embedding 文本 = preamble + "\n\n" + original_chunk
```

### 详细流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Contextual Retrieval 处理流程                      │
│                                                                     │
│   文档加载                                                          │
│      │                                                              │
│      ▼                                                              │
│   ┌─────────────────┐                                              │
│   │  Text Splitter   │  ──▶  将文档分割为多个 Chunk                  │
│   │  📄 Split        │       (默认: 500 字符, 50 重叠)              │
│   └────────┬────────┘                                              │
│            │                                                        │
│            ▼                                                        │
│   ┌─────────────────┐                                              │
│   │  Config Check    │  ──▶  检查 CONTEXTUAL_RETRIEVAL_ENABLED     │
│   │  ⚙️ 开关判断     │       false → 跳过，走传统管道               │
│   └────────┬────────┘                                              │
│            │ (enabled = true)                                       │
│            ▼                                                        │
│   ┌─────────────────┐                                              │
│   │  LRU Cache Check │  ──▶  检查缓存是否命中                      │
│   │  🗂️ 缓存查询     │       命中 → 直接使用缓存的 preamble        │
│   └────────┬────────┘                                              │
│            │ (缓存未命中)                                           │
│            ▼                                                        │
│   ┌─────────────────┐                                              │
│   │  LLM Generate    │  ──▶  发送 全文 + chunk 给 LLM              │
│   │  🤖 上下文生成    │       生成简短背景提要 (preamble)            │
│   └────────┬────────┘                                              │
│            │                                                        │
│            ▼                                                        │
│   ┌─────────────────┐                                              │
│   │  Text Concat     │  ──▶  preamble + "\n\n" + original_chunk    │
│   │  📝 文本拼接     │       写入缓存供后续使用                     │
│   └────────┬────────┘                                              │
│            │                                                        │
│            ▼                                                        │
│   ┌─────────────────┐                                              │
│   │  Embedding       │  ──▶  对拼接后的文本生成向量                  │
│   │  🔢 向量嵌入     │                                              │
│   └────────┬────────┘                                              │
│            │                                                        │
│            ▼                                                        │
│   ┌─────────────────┐                                              │
│   │  Milvus Store    │  ──▶  存储到向量数据库                       │
│   │  💾 向量存储     │       metadata 保留原始文本和 preamble       │
│   └─────────────────┘                                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 🔑 核心概念

### 1. 为什么需要 Contextual Retrieval？

**问题场景**：一篇关于"MySQL 索引优化"的长文档被分割为 20 个 Chunk。其中第 15 个 Chunk 内容为：

```
将 B+ 树的扇出系数设置为 200，叶子节点的填充因子保持在 70% 左右，
可以有效减少磁盘 I/O 次数。同时建议对频繁范围查询的列建立联合索引。
```

这个 Chunk 本身虽然包含有价值的技术细节，但缺少"这是关于 MySQL 索引优化"的上下文。当用户查询"MySQL 索引优化最佳实践"时，传统 Embedding 可能无法建立足够的语义关联。

**Contextual Retrieval 解决方案**：LLM 阅读完整文档后，为该 Chunk 生成一段背景提要：

```
本文档是关于 MySQL 数据库索引优化的完整指南，涵盖 B+ 树索引结构、
查询性能调优和联合索引策略。以下片段讨论的是 B+ 树索引的物理参数配置建议。
```

最终 Embedding 的文本变为：

```
本文档是关于 MySQL 数据库索引优化的完整指南，涵盖 B+ 树索引结构、
查询性能调优和联合索引策略。以下片段讨论的是 B+ 树索引的物理参数配置建议。

将 B+ 树的扇出系数设置为 200，叶子节点的填充因子保持在 70% 左右，
可以有效减少磁盘 I/O 次数。同时建议对频繁范围查询的列建立联合索引。
```

### 2. LLM Prompt 设计

系统使用 Anthropic 官方推荐的 Prompt 模板：

```xml
<document>
{DOCUMENT_TEXT}
</document>

Here is the chunk we want to situate within the whole document:

<chunk>
{CHUNK_TEXT}
</chunk>

Please give a short succinct context to situate this chunk within the overall document
for the purposes of improving search retrieval of the chunk.
Answer only with the succinct context and nothing else.
```

**设计要点**：
- 使用 XML 标签明确区分文档全文和目标切片
- 要求 LLM 只返回简短上下文，不输出其他内容
- 生成的 preamble 通常为 1-3 句话，聚焦于定位切片在全文中的角色

### 3. 并发与降级策略

| 策略 | 说明 |
|------|------|
| **并发控制** | 默认 3 个并行 LLM 调用 (`CONTEXTUAL_RETRIEVAL_BATCH_CONCURRENCY`) |
| **LRU 缓存** | 基于 `hash(docPrefix) + hash(chunk)` 的内存缓存，避免重复文档冗余调用 |
| **单 chunk 降级** | 任何一个 chunk 的 LLM 调用失败，降级使用原始文本，不影响其他 chunks |
| **全局开关** | `CONTEXTUAL_RETRIEVAL_ENABLED=false` 完全跳过，零开销 |
| **文档截断** | 超过 `maxDocLength` 的文档自动截断并记录日志 |

## 🚀 核心实现

### 核心模块：`src/lib/contextual-retrieval.ts`

**主要导出函数**：

```typescript
// 从环境变量加载配置
function loadContextualRetrievalConfig(): ContextualRetrievalConfig

// 为单个 Chunk 生成上下文提要
async function generateContextForChunk(
  fullDoc: string,
  chunkText: string,
  llm: BaseChatModel,
  maxDocLength?: number,
): Promise<string>

// 批量处理编排器（并发控制、缓存、降级）
async function contextualizeChunks(
  options: ContextualizeChunksOptions
): Promise<ContextualizedChunk[]>
```

**类型定义**：

```typescript
interface ContextualRetrievalConfig {
  enabled: boolean;          // 是否启用
  model?: string;            // LLM 模型名称（留空使用默认）
  maxDocLength: number;      // 全文最大字符数
  batchConcurrency: number;  // 并行 LLM 调用数
  temperature: number;       // LLM temperature
  cacheEnabled: boolean;     // 是否启用缓存
  cacheMaxSize: number;      // 缓存最大条目数
}

interface ContextualizedChunk {
  contextualPreamble: string;   // LLM 生成的上下文前缀
  originalText: string;         // 原始切片文本
  contextualizedText: string;   // preamble + "\n\n" + original
}
```

### LRU 缓存设计

```
┌──────────────────────────────────────────────────────────┐
│                  ContextualCache (LRU)                    │
│                                                          │
│  Key = MD5(docPrefix[:2000])[:12] + ":" +               │
│        MD5(chunkText)[:12]                               │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  oldest       │→│  ...         │→│  newest       │   │
│  │  (淘汰优先)   │  │              │  │  (最近使用)   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                          │
│  maxSize = 500 (默认)                                    │
│  超出容量时淘汰最旧条目                                   │
└──────────────────────────────────────────────────────────┘
```

**缓存策略**：
- 使用文档前 2000 字符的 MD5 哈希 + chunk 文本的 MD5 哈希作为 Key
- 基于 JavaScript `Map` 的插入顺序实现 LRU 语义
- 命中时将条目移至末尾（delete + re-insert）
- 同一文档的不同 chunks 共享 docPrefix 哈希

## 📋 管道集成

### 1. DocumentPipeline（主管道）

在 `src/lib/document-pipeline.ts` 的 `processDocument()` 方法中，Contextual Retrieval 作为 **步骤 2.5** 插入在分割和嵌入之间：

```
processDocument() 流程:
  Step 1:  加载文档 (loading)
  Step 2:  分割文本 (splitting)
  Step 2.5: 上下文生成 (contextualizing)  ← 新增
  Step 3:  生成嵌入 (embedding)
  Step 4:  存储向量 (storing)
```

**进度回调**新增 `'contextualizing'` 阶段，前端可实时显示上下文生成进度。

### 2. VectorizationUtils（批量管道）

在 `src/lib/vectorization-utils.ts` 的 `vectorizeAndInsert()` 中：

```
vectorizeAndInsert() 流程:
  1. splitDocuments() → chunks[]
  2. 按 source 文档分组 chunks             ← 新增
  3. 对每组调用 contextualizeChunks()      ← 新增
  4. 替换 chunk.text 为 contextualized     ← 新增
  5. 批量 Embedding
  6. 插入 Milvus
```

### 3. Reasoning RAG 管道

在 `src/app/api/reasoning-rag/vectorize/route.ts` 中：

```
Reasoning RAG vectorize 流程:
  1. 解析文件内容
  2. splitTextIntoChunks()
  3. contextualizeChunks(fullDocument=content)  ← 新增
  4. 批量 Embedding
  5. 构建文档（含 contextual metadata）
  6. 插入 Milvus
```

## ⚙️ 配置指南

### 环境变量

在 `.env.local` 中配置以下变量：

```env
# Contextual Retrieval 配置
CONTEXTUAL_RETRIEVAL_ENABLED=false          # 是否启用（默认关闭）
# CONTEXTUAL_RETRIEVAL_MODEL=              # LLM 模型名称（留空使用默认 LLM）
CONTEXTUAL_RETRIEVAL_MAX_DOC_LENGTH=25000  # 全文最大字符数
CONTEXTUAL_RETRIEVAL_BATCH_CONCURRENCY=3   # 并行 LLM 调用数
CONTEXTUAL_RETRIEVAL_TEMPERATURE=0         # LLM 温度
CONTEXTUAL_RETRIEVAL_CACHE_ENABLED=true    # 是否启用缓存
CONTEXTUAL_RETRIEVAL_CACHE_MAX_SIZE=500    # 缓存最大条目数
```

### 配置项详解

| 变量 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `CONTEXTUAL_RETRIEVAL_ENABLED` | boolean | `false` | 全局开关。`false` 时完全跳过，行为与修改前一致 |
| `CONTEXTUAL_RETRIEVAL_MODEL` | string | (空) | 指定 LLM 模型。留空则复用系统默认 LLM |
| `CONTEXTUAL_RETRIEVAL_MAX_DOC_LENGTH` | number | `25000` | 全文最大字符数，超出截断 |
| `CONTEXTUAL_RETRIEVAL_BATCH_CONCURRENCY` | number | `3` | 同时并行的 LLM 调用数 |
| `CONTEXTUAL_RETRIEVAL_TEMPERATURE` | number | `0` | LLM 温度参数，0 表示确定性输出 |
| `CONTEXTUAL_RETRIEVAL_CACHE_ENABLED` | boolean | `true` | 是否启用内存 LRU 缓存 |
| `CONTEXTUAL_RETRIEVAL_CACHE_MAX_SIZE` | number | `500` | 缓存最大条目数 |

### 推荐配置

**开发环境（资源有限）**：

```env
CONTEXTUAL_RETRIEVAL_ENABLED=true
CONTEXTUAL_RETRIEVAL_BATCH_CONCURRENCY=1
CONTEXTUAL_RETRIEVAL_MAX_DOC_LENGTH=10000
```

**生产环境（性能优先）**：

```env
CONTEXTUAL_RETRIEVAL_ENABLED=true
CONTEXTUAL_RETRIEVAL_BATCH_CONCURRENCY=5
CONTEXTUAL_RETRIEVAL_MAX_DOC_LENGTH=25000
CONTEXTUAL_RETRIEVAL_CACHE_MAX_SIZE=1000
```

## 💾 存储影响

### Milvus Schema

**无需变更现有 Schema**。Contextual Retrieval 完全兼容现有的 Milvus 集合结构：

| 字段 | 变化 | 说明 |
|------|------|------|
| `content` (VarChar) | 内容变化 | 存放 `preamble + "\n\n" + original_chunk`，不超过 65535 字符限制 |
| `embedding` (FloatVector) | 维度不变 | 向量基于 contextualized 文本生成 |
| `metadata_json` | 新增字段 | 增加 `originalContent` 和 `contextualPreamble` 字段用于调试 |

### Metadata 结构

存储后的每条记录 `metadata_json` 中新增两个字段：

```json
{
  "source": "document.pdf",
  "chunkIndex": 5,
  "totalChunks": 20,
  "originalContent": "将 B+ 树的扇出系数设置为 200...",
  "contextualPreamble": "本文档是关于 MySQL 数据库索引优化的完整指南..."
}
```

这两个字段便于调试和分析 Contextual Retrieval 的效果，不影响检索逻辑。

## 💡 使用场景

### 场景 1：技术文档检索

**文档**：一篇 15 页的 Kubernetes 部署指南

**原始 Chunk**：
```
设置 replicas: 3 和 maxSurge: 1，
滚动更新时会先创建一个新 Pod，再终止一个旧 Pod。
```

**生成的 Preamble**：
```
This chunk is from a Kubernetes deployment guide, specifically the section on
Rolling Update strategy configuration for production workloads.
```

**效果**：用户查询"Kubernetes 滚动更新配置"时，由于 preamble 明确包含"Kubernetes deployment"和"Rolling Update strategy"，语义匹配显著提升。

### 场景 2：API 参考文档

**文档**：REST API 接口文档

**原始 Chunk**：
```
POST /api/v2/users
Content-Type: application/json

{ "name": "string", "email": "string", "role": "admin|user" }

返回 201 Created，包含新用户的完整信息。
```

**生成的 Preamble**：
```
This is from the User Management API reference documentation.
The following describes the user creation endpoint with required fields and response format.
```

### 场景 3：研究论文检索

**文档**：机器学习论文

**原始 Chunk**：
```
实验结果显示，在 MMLU 基准测试上，模型 A 的准确率为 78.3%，
而模型 B 为 72.1%，差距主要来自数学推理子任务。
```

**生成的 Preamble**：
```
This paper compares the performance of different large language models on reasoning tasks.
The following chunk presents experimental results on the MMLU benchmark.
```

## 🔧 调试与验证

### 1. 启用 Contextual Retrieval

```env
CONTEXTUAL_RETRIEVAL_ENABLED=true
```

### 2. 观察服务端日志

上传文档并向量化后，检查控制台输出：

```
[ContextualRetrieval] 开始处理 15 个 chunks
[ContextualRetrieval] 配置: model=default, concurrency=3, maxDocLength=25000
[ContextualRetrieval] 已处理 3/15 个 chunks
[ContextualRetrieval] 已处理 6/15 个 chunks
[ContextualRetrieval] 已处理 9/15 个 chunks
[ContextualRetrieval] 已处理 12/15 个 chunks
[ContextualRetrieval] 已处理 15/15 个 chunks
[ContextualRetrieval] 处理完成: 15 个 chunks, 0 个降级, 缓存命中约 0 次
```

### 3. 验证存储结果

查询 Milvus 中的记录，确认：
- `content` 字段包含上下文前缀
- `metadata_json` 中包含 `originalContent` 和 `contextualPreamble`

### 4. 测试降级逻辑

断开 LLM 服务（如停止 Ollama），重新向量化文档：

```
[ContextualRetrieval] chunk 0 上下文生成失败, 降级使用原始文本: Connection refused
[ContextualRetrieval] chunk 1 上下文生成失败, 降级使用原始文本: Connection refused
...
[ContextualRetrieval] 处理完成: 15 个 chunks, 15 个降级, 缓存命中约 0 次
```

降级模式下，所有 chunk 使用原始文本进行 Embedding，系统继续正常运行。

### 5. 测试全局关闭

```env
CONTEXTUAL_RETRIEVAL_ENABLED=false
```

日志输出：
```
[ContextualRetrieval] 未启用，跳过上下文生成
```

确认无任何 LLM 调用发生。

## 📈 性能考量

### 处理时间估算

| 文档大小 | Chunk 数量 | 并发数 | 估算时间 |
|----------|-----------|--------|---------|
| 5KB | ~10 | 3 | ~10s |
| 20KB | ~40 | 3 | ~40s |
| 50KB | ~100 | 3 | ~100s |
| 50KB | ~100 | 5 | ~60s |

> 实际时间取决于 LLM 响应速度。使用本地 Ollama 模型通常比远程 API 更快。

### 优化建议

1. **提高并发数**：如果 LLM 服务资源充足，可以将 `BATCH_CONCURRENCY` 提高到 5-10
2. **启用缓存**：对于需要重复处理的文档集合，缓存可以显著减少 LLM 调用
3. **控制文档长度**：过长的文档全文会增加每次 LLM 调用的 Token 消耗，可适当降低 `MAX_DOC_LENGTH`
4. **选择合适的模型**：较小的模型（如 Gemma 2B, Qwen 1.5B）即可胜任上下文生成任务，无需使用顶级模型

## 🔄 与其他 RAG 模式的协同

Contextual Retrieval 作为**预处理步骤**，可以与本系统中的其他 RAG 模式无缝协同：

```
                    Contextual Retrieval (预处理)
                              │
                    优化后的向量存储
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         Self-RAG        Agentic RAG    Reasoning RAG
       (自反思检索)     (代理化工作流)   (推理增强检索)
              │               │               │
              └───────────────┼───────────────┘
                              │
                        最终回答输出
```

| RAG 模式 | 与 Contextual Retrieval 的协同 |
|----------|-------------------------------|
| **Self-RAG** | 检索到的 chunks 质量更高，Retrieve Token 判断更准确 |
| **Agentic RAG** | 代理的检索步骤返回更相关的文档片段 |
| **Reasoning RAG** | 推理模型获得更完整的上下文，思维链质量提升 |
| **Self-Corrective RAG** | 减少需要自省修正的检索错误 |
| **Query Expansion** | 扩展查询与 contextualized chunks 的匹配度进一步提升 |
