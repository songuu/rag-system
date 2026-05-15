# Milvus RAG Pipeline 完整指南

> 最后更新: 2026-05-15

## 🎯 概述

本系统实现了完整的 RAG (检索增强生成) 管道，支持多种数据源输入，通过 Milvus 向量数据库进行高效的向量存储和检索。

### ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🔄 **自动维度适配** | 根据集合维度自动选择匹配的 Embedding 模型 |
| 🎨 **向量空间可视化** | 查询路径、相似度分布、2D 散点图 |
| 🧠 **多模型支持** | nomic-embed-text (768D), mxbai-embed-large (1024D) 等 |
| 📊 **实时统计** | 相似度分布统计、均值/中位数/极值 |
| ⚙️ **Milvus 2.6 搜索控制** | 支持 consistency、filter templating、grouping、ignore growing、nprobe/ef 覆盖 |

### 🛡️ 维度不匹配自动处理

系统会**自动检测**集合的向量维度并选择匹配的模型：

```
集合维度: 768  → 自动使用: nomic-embed-text
集合维度: 1024 → 自动使用: mxbai-embed-large
```

如果用户选择的模型维度与集合不匹配，系统会**自动切换**到正确的模型，确保搜索正常工作。

## 🔄 Pipeline 流程图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              RAG Pipeline 完整流程                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   📁 数据源                                                                     │
│   ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐      │
│   │  📄    │  │  📕    │  │  📘    │  │  🌐    │  │  📺    │  │  📝    │      │
│   │ .txt   │  │ .pdf   │  │ .docx  │  │  URL   │  │YouTube │  │  Raw   │      │
│   └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘      │
│        │           │           │           │           │           │           │
│        └───────────┴───────────┴─────┬─────┴───────────┴───────────┘           │
│                                      │                                          │
│                                      ▼                                          │
│                          ┌─────────────────────┐                               │
│                          │      📥 Loader      │                               │
│                          │   (文档加载器)       │                               │
│                          │  - loadTextFile()   │                               │
│                          │  - loadPdfFile()    │                               │
│                          │  - loadDocxFile()   │                               │
│                          │  - loadUrl()        │                               │
│                          │  - loadYouTube()    │                               │
│                          └──────────┬──────────┘                               │
│                                     │                                          │
│                                     ▼ Documents                                │
│                          ┌─────────────────────┐                               │
│                          │   ✂️ TextSplitter   │                               │
│                          │   (文本分割器)       │                               │
│                          │  ChunkSize: 500     │                               │
│                          │  Overlap: 50        │                               │
│                          └──────────┬──────────┘                               │
│                                     │                                          │
│                                     ▼ Chunks                                   │
│                          ┌─────────────────────┐                               │
│                          │   🧠 嵌入模型        │                               │
│                          │  (Ollama Embedding) │                               │
│                          │  nomic-embed-text   │                               │
│                          │  维度: 768          │                               │
│                          └──────────┬──────────┘                               │
│                                     │                                          │
│                                     ▼ 向量                                     │
│                          ┌─────────────────────┐                               │
│                          │   🗄️ Milvus         │                               │
│                          │   (向量数据库)       │                               │
│                          │  IVF_FLAT 索引      │                               │
│                          │  COSINE 度量        │                               │
│                          └─────────────────────┘                               │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 📦 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                         RAG 系统                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   用户查询                                                      │
│      │                                                          │
│      ▼                                                          │
│   ┌─────────────────┐     ┌─────────────────┐                  │
│   │  Ollama         │     │   向量存储      │                  │
│   │  Embedding      │────▶│   选择器        │                  │
│   │  (nomic-embed)  │     │                 │                  │
│   └─────────────────┘     └────────┬────────┘                  │
│                                    │                            │
│            ┌───────────────────────┼───────────────────────┐   │
│            │                       │                       │   │
│            ▼                       ▼                       ▼   │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────┐ │
│   │  内存向量存储   │   │    Milvus       │   │  其他存储   │ │
│   │  (SimpleMemory) │   │  向量数据库     │   │  (扩展...)  │ │
│   └─────────────────┘   └─────────────────┘   └─────────────┘ │
│            │                       │                       │   │
│            └───────────────────────┼───────────────────────┘   │
│                                    │                            │
│                                    ▼                            │
│                        ┌─────────────────┐                     │
│                        │   搜索结果      │                     │
│                        └─────────────────┘                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 1. 安装 Milvus

#### 方式一：Docker Compose（推荐）

```bash
# 下载 docker-compose.yml
wget https://github.com/milvus-io/milvus/releases/download/v2.6.15/milvus-standalone-docker-compose.yml -O docker-compose.yml

# 启动 Milvus
docker-compose up -d

# 检查状态
docker-compose ps
```

#### 方式二：Docker 单容器

```bash
# 启动 Milvus Standalone
docker run -d \
  --name milvus-standalone \
  -p 19530:19530 \
  -p 9091:9091 \
  milvusdb/milvus:v2.6.15 \
  milvus run standalone
```

#### 方式三：Milvus Lite（开发环境）

```bash
# 在 Python 环境中安装
pip install milvus

# Milvus Lite 会自动嵌入运行
```

### 2. 验证安装

```bash
# 检查端口
curl http://localhost:9091/healthz

# 应该返回 "OK"
```

### 3. 配置环境变量

在项目根目录创建或编辑 `.env.local`：

```env
# Milvus 配置
MILVUS_ADDRESS=localhost:19530
MILVUS_USERNAME=
MILVUS_PASSWORD=
MILVUS_DATABASE=default
MILVUS_COLLECTION=rag_documents
MILVUS_DEFAULT_CONSISTENCY_LEVEL=Bounded
MILVUS_SEARCH_PARAMS={"nprobe":16}

# Ollama 配置
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
```

### 4. 访问管理界面

访问 `http://localhost:3000/milvus` 进入 Milvus 管理界面

## 📊 管理界面功能

### 状态页

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔌 连接状态                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ 状态     │  │ 文档数量 │  │ 向量维度 │  │ 索引类型 │       │
│  │ 已连接 ✓ │  │ 1,234    │  │ 768      │  │ IVF_FLAT │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│                                                                 │
│  [连接 Milvus]  [刷新状态]  [清空集合]                         │
└─────────────────────────────────────────────────────────────────┘
```

### 搜索页

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔍 向量搜索                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────┐ ┌──────────┐    │
│  │ 输入搜索内容...                            │ │ 🔍 搜索  │    │
│  └───────────────────────────────────────────┘ └──────────┘    │
│                                                                 │
│  Top K: [5]    阈值: [0.0]                                     │
├─────────────────────────────────────────────────────────────────┤
│  搜索结果 (3)                                                   │
│                                                                 │
│  ① sample.txt              95.23%                               │
│     文档内容预览...                                              │
│                                                                 │
│  ② sample2.txt             82.15%                               │
│     文档内容预览...                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 导入页

```
┌─────────────────────────────────────────────────────────────────┐
│ 📥 导入文档                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │  粘贴要导入的文本内容...                                │   │
│  │                                                         │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  字符数: 1,234                    [清空]  [📥 导入到 Milvus]    │
└─────────────────────────────────────────────────────────────────┘
```

### 配置页

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚙️ 连接配置                                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Milvus 地址                    集合名称                        │
│  ┌────────────────────┐        ┌────────────────────┐          │
│  │ localhost:19530    │        │ rag_documents      │          │
│  └────────────────────┘        └────────────────────┘          │
│                                                                 │
│  索引类型                        度量类型                        │
│  ┌────────────────────┐        ┌────────────────────┐          │
│  │ IVF_FLAT (推荐) ▼  │        │ COSINE         ▼  │          │
│  └────────────────────┘        └────────────────────┘          │
│                                                                 │
│  [应用配置并连接]                                               │
└─────────────────────────────────────────────────────────────────┘
```

## 📡 API 接口

### POST /api/milvus

#### 连接

```typescript
// 请求
{
  "action": "connect",
  "config": {
    "address": "localhost:19530",
    "collectionName": "my_collection",
    "indexType": "IVF_FLAT",
    "metricType": "COSINE"
  }
}

// 响应
{
  "success": true,
  "message": "Connected to Milvus",
  "stats": {
    "name": "my_collection",
    "rowCount": 1234,
    "embeddingDimension": 768,
    "indexType": "IVF_FLAT",
    "metricType": "COSINE",
    "loaded": true
  }
}
```

#### 搜索

```typescript
// 请求
{
  "action": "search",
  "query": "机器学习是什么？",
  "topK": 5,
  "threshold": 0.5,
  "filter": "source in {sources}",
  "exprValues": { "sources": ["ai_intro.txt"] },
  "consistencyLevel": "Bounded",
  "searchParams": { "nprobe": 16 },
  "groupByField": "source",
  "groupSize": 1
}

// 响应
{
  "success": true,
  "query": "机器学习是什么？",
  "results": [
    {
      "id": "doc-001",
      "content": "机器学习是人工智能的一个分支...",
      "metadata": { "source": "ai_intro.txt" },
      "score": 0.9523,
      "distance": 0.0477
    }
  ],
  "count": 5
}
```

Milvus 2.6+ 推荐把过滤值放入 `exprValues`，避免把动态值直接拼进 filter 字符串；搜索一致性、`ignoreGrowing`、grouping、`nprobe`/`ef` 等调优项统一由 `src/lib/milvus-client.ts` 和 `src/lib/milvus-config.ts` 承接，API 层只传递策略参数。

#### 插入文档

```typescript
// 请求
{
  "action": "insert",
  "documents": [
    {
      "content": "文档内容...",
      "metadata": { "source": "file.txt" }
    }
  ]
}

// 响应
{
  "success": true,
  "message": "Inserted 1 documents",
  "ids": ["uuid-xxx"]
}
```

#### 导入文件

```typescript
// 请求
{
  "action": "import-files",
  "files": [
    {
      "filename": "document.txt",
      "content": "完整文件内容..."
    }
  ]
}

// 响应
{
  "success": true,
  "message": "Imported 1 files as 15 chunks",
  "files": ["document.txt"],
  "chunkCount": 15
}
```

### GET /api/milvus

#### 获取状态

```typescript
// 请求
GET /api/milvus?action=status

// 响应
{
  "success": true,
  "connected": true,
  "health": { "healthy": true, "message": "Milvus is healthy" },
  "stats": { ... },
  "config": { ... }
}
```

## 🔧 索引类型详解

### FLAT

- **原理**: 暴力搜索，逐一比较
- **准确率**: 100%
- **速度**: 慢
- **适用场景**: 小数据集 (<10K)

### IVF_FLAT ⭐ 推荐

- **原理**: 倒排文件索引
- **准确率**: 高 (~95%)
- **速度**: 快
- **适用场景**: 中等数据集 (10K-1M)

### IVF_SQ8

- **原理**: 倒排索引 + 标量量化
- **准确率**: 中高 (~90%)
- **速度**: 很快
- **适用场景**: 大数据集，内存受限

### IVF_PQ

- **原理**: 倒排索引 + 乘积量化
- **准确率**: 中 (~80%)
- **速度**: 最快
- **适用场景**: 超大数据集 (>10M)

### HNSW

- **原理**: 分层可导航小世界图
- **准确率**: 高 (~95%)
- **速度**: 很快
- **适用场景**: 大数据集，高性能需求

## 📈 度量类型

### COSINE（推荐）

- **公式**: `1 - (A·B) / (|A||B|)`
- **范围**: [0, 2]
- **特点**: 方向敏感，长度无关
- **适用**: 文本相似度

### L2

- **公式**: `sqrt(Σ(Ai-Bi)²)`
- **范围**: [0, ∞)
- **特点**: 绝对距离
- **适用**: 图像、空间数据

### IP

- **公式**: `A·B`
- **范围**: (-∞, ∞)
- **特点**: 内积，方向和长度都敏感
- **适用**: 推荐系统

## 🏗️ 集合 Schema

```typescript
// 自动创建的 Schema
{
  collection_name: "rag_documents",
  fields: [
    { name: "id", data_type: "VarChar", is_primary_key: true, max_length: 256 },
    { name: "content", data_type: "VarChar", max_length: 65535 },
    { name: "embedding", data_type: "FloatVector", dim: 768 },
    { name: "source", data_type: "VarChar", max_length: 1024 },
    { name: "metadata_json", data_type: "VarChar", max_length: 65535 },
    { name: "created_at", data_type: "Int64" }
  ]
}
```

## 🔄 与内存存储的对比

| 特性 | 内存存储 | Milvus |
|------|---------|--------|
| **持久化** | ❌ 重启丢失 | ✅ 持久存储 |
| **性能** | 快 (小数据) | 更快 (大数据) |
| **扩展性** | 受内存限制 | 水平扩展 |
| **索引** | 无 | 多种高效索引 |
| **过滤** | 基础 | 标量过滤 |
| **适用场景** | 开发/演示 | 生产环境 |

## 📋 最佳实践

### 1. 选择合适的索引

```
数据量 < 10K        → FLAT
10K < 数据量 < 1M   → IVF_FLAT ⭐
数据量 > 1M         → HNSW
内存受限            → IVF_PQ
```

### 2. 调优搜索参数

```typescript
// IVF_FLAT 搜索参数
{
  nprobe: 16  // 搜索的簇数，越大越准确但越慢
}

// HNSW 搜索参数
{
  ef: 64  // 搜索时的动态列表大小
}
```

接口返回的 `timings` 字段会拆分 `initMs`、`embeddingMs`、`searchMs`、`totalMs`，用于判断慢在集合准备、embedding 生成还是 Milvus search 本身。重复查询会命中短 TTL query embedding cache；如只是列表预览或健康检查，可通过 `MILVUS_SEARCH_OUTPUT_FIELDS` 减少返回字段。

### 3. 批量插入

```typescript
// ❌ 不推荐：逐条插入
for (const doc of documents) {
  await milvus.insertDocuments([doc]);
}

// ✅ 推荐：批量插入
await milvus.insertDocuments(documents);
```

### 4. 使用过滤器

```typescript
// 按来源过滤
await milvus.search(embedding, 5, 0.5, 'source == "important.txt"');

// 按时间过滤
await milvus.search(embedding, 5, 0.5, 'created_at > 1700000000000');
```

复杂过滤或 CJK 字段过滤推荐使用 `filter + exprValues`，不要把长数组或中文值直接拼进 filter 字符串，这会减少 Milvus 解析开销。

## 🔒 安全配置

### 启用认证

```env
MILVUS_USERNAME=root
MILVUS_PASSWORD=your_password
```

### 启用 SSL/TLS

```env
MILVUS_SSL=true
```

## 🐛 故障排查

### 连接失败

```bash
# 检查 Milvus 是否运行
docker ps | grep milvus

# 检查端口
netstat -an | grep 19530

# 检查健康状态
curl http://localhost:9091/healthz
```

### 搜索无结果

1. 确认集合中有数据
2. 检查相似度阈值是否过高
3. 确认 embedding 维度匹配

### 性能问题

1. 确认索引已创建并加载
2. 调整 `nprobe` 或 `ef` 参数
3. 考虑使用更高效的索引类型

## 📚 相关资源

- [Milvus 官方文档](https://milvus.io/docs)
- [Milvus GitHub](https://github.com/milvus-io/milvus)
- [Milvus Python SDK](https://github.com/milvus-io/pymilvus)
- [Milvus Node.js SDK](https://github.com/milvus-io/milvus-sdk-node)

## 📥 Document Pipeline API

### POST /api/pipeline

#### 处理文本
```typescript
{
  "action": "process-text",
  "text": "要处理的文本内容...",
  "source": "my-document",
  "chunkSize": 500,
  "chunkOverlap": 50
}
```

#### 处理 URL
```typescript
{
  "action": "process-url",
  "url": "https://example.com/article",
  "chunkSize": 500,
  "chunkOverlap": 50
}
```

#### 处理 YouTube
```typescript
{
  "action": "process-youtube",
  "videoUrl": "https://www.youtube.com/watch?v=xxx",
  "chunkSize": 500,
  "chunkOverlap": 50
}
```

#### 预览分块
```typescript
{
  "action": "preview-chunks",
  "text": "文本内容...",
  "chunkSize": 500,
  "chunkOverlap": 50
}
```

#### 批量处理
```typescript
{
  "action": "batch-process",
  "items": [
    { "content": "文本1", "type": "text", "filename": "doc1.txt" },
    { "url": "https://...", "type": "url" }
  ],
  "chunkSize": 500,
  "chunkOverlap": 50
}
```

### 文件上传

```bash
curl -X POST http://localhost:3000/api/pipeline \
  -F "files=@document.pdf" \
  -F "files=@notes.txt" \
  -F "chunkSize=500" \
  -F "chunkOverlap=50"
```

## 🔧 Document Pipeline 模块

### 核心组件

```typescript
// 文档加载器
loadTextFile(content, filename)    // 纯文本
loadPdfFile(buffer, filename)      // PDF 文件
loadDocxFile(buffer, filename)     // Word 文件
loadUrl(url)                       // 网页 URL
loadYouTube(videoUrl)             // YouTube 字幕

// 文本分割器
splitDocument(document, { chunkSize, chunkOverlap })

// 嵌入生成
generateEmbeddings(chunks, { embeddingModel, ollamaBaseUrl })

// 向量存储
storeToMilvus(documents, { address, collectionName })
```

### 使用示例

```typescript
import { DocumentPipeline } from '@/lib/document-pipeline';

// 创建管道
const pipeline = new DocumentPipeline({
  chunkSize: 500,
  chunkOverlap: 50,
  embeddingModel: 'nomic-embed-text',
  ollamaBaseUrl: 'http://localhost:11434',
  milvusConfig: {
    address: 'localhost:19530',
    collectionName: 'rag_documents',
  }
});

// 处理单个文档
const result = await pipeline.processDocument(
  'https://example.com/article',
  {},
  (progress) => console.log(progress)
);

// 批量处理
const results = await pipeline.processDocuments([
  { input: 'text content', filename: 'doc1.txt' },
  { input: buffer, type: 'pdf', filename: 'doc2.pdf' },
  { input: 'https://example.com', type: 'url' },
]);
```

## 📊 支持的数据源

| 类型 | 扩展名 | 说明 | 示例 |
|------|--------|------|------|
| text | .txt | 纯文本文件 | 文档、笔记 |
| pdf | .pdf | PDF 文档 | 论文、报告 |
| docx | .docx | Word 文档 | 文档、报告 |
| url | - | 网页链接 | 文章、博客 |
| youtube | - | 视频链接 | 教程、演讲 |
| raw | - | 原始文本 | 粘贴内容 |

## 🎯 Milvus RAG System

### 使用方式

```typescript
import { getMilvusRAGSystem } from '@/lib/rag-milvus';

// 获取 RAG 系统
const rag = await getMilvusRAGSystem({
  ollamaBaseUrl: 'http://localhost:11434',
  llmModel: 'llama3.1',
  embeddingModel: 'nomic-embed-text',
  storageBackend: 'milvus',
  milvusConfig: {
    address: 'localhost:19530',
    collectionName: 'rag_documents',
  },
});

// 添加文档
await rag.addDocuments([
  { content: '文档内容1', metadata: { source: 'doc1.txt' } },
  { content: '文档内容2', metadata: { source: 'doc2.txt' } },
]);

// 搜索
const results = await rag.search('查询内容', 5, 0.3);

// 提问
const answer = await rag.ask('什么是机器学习?', { topK: 5, threshold: 0.3 });
console.log(answer.answer);
console.log(answer.sources);
```

### RAG-Milvus API

```typescript
// POST /api/rag-milvus
// 提问
{
  "action": "ask",
  "question": "什么是机器学习?",
  "topK": 5,
  "threshold": 0.3
}

// 搜索
{
  "action": "search",
  "query": "机器学习",
  "topK": 5
}

// 添加文档
{
  "action": "add-documents",
  "documents": [
    { "content": "内容...", "metadata": { "source": "xxx" } }
  ]
}
```

---

## 🎨 可视化功能

### 访问方式

在 Milvus 管理页面 (`/milvus`) 中，点击 **🎨 可视化** 标签页。

### 功能模块

#### 1. 🎯 查询路径可视化

展示查询向量与检索结果的空间关系：

```
                    Query
                      │
            ┌─────────┼─────────┐
            │         │         │
          Doc1      Doc2      Doc3
          85%       72%       58%

- 中心点: 查询向量
- 周围点: 匹配的文档
- 连线粗细: 表示相似度
- 点击节点: 查看文档详情
```

#### 2. 📊 相似度分布

统计 Top-K 结果的相似度分布：

```
0.9-1.0  ████████░░░░░░░░░░  3
0.8-0.9  ██████████████░░░░  7
0.7-0.8  ████████████████░░  8
0.6-0.7  ██████████░░░░░░░░  5
0.5-0.6  ████░░░░░░░░░░░░░░  2

统计信息:
- 最高: 95.2%
- 平均: 72.4%
- 中位数: 74.1%
- 最低: 52.3%
```

#### 3. 🌐 向量空间概览

将高维向量投影到 2D 空间，观察数据分布：

- 不同颜色代表不同的语义聚类
- 点击数据点查看详情
- 支持缩放和平移

### 可视化 API

```typescript
// POST /api/milvus/visualize
// 获取向量空间数据
{
  "action": "vector-space",
  "sampleSize": 100,
  "dimensions": 2
}

// 获取相似度分布
{
  "action": "similarity-distribution",
  "query": "人工智能技术",
  "topK": 50
}

// 获取查询路径
{
  "action": "query-path",
  "query": "人工智能技术",
  "topK": 10
}

// 获取集合信息
{
  "action": "collection-info"
}
```

---

## 🔧 故障排查

### 问题: 维度不匹配错误

**症状**: 
```
vector dimension mismatch: channel=...
```

**原因**: 集合中的向量维度与查询向量维度不同。

**解决方案**:

1. **自动修复**: 系统会自动选择匹配的模型
2. **手动修复**: 
   - 查看集合维度 (仪表盘显示)
   - 选择匹配的模型:
     - 768 维 → `nomic-embed-text`
     - 1024 维 → `mxbai-embed-large`
3. **清空重建**: 如果需要使用新模型，清空集合后重新导入

### 问题: 连接失败

**症状**: Milvus 服务不可用

**解决方案**:

1. 检查 Milvus 是否运行: `docker ps | grep milvus`
2. 检查端口: `curl localhost:19530`
3. 重启服务: `docker-compose restart milvus`

### 问题: 搜索结果质量差

**建议**:

1. 检查相似度分布 (可视化标签)
2. 调整阈值参数
3. 检查文档分块大小
4. 尝试不同的 Embedding 模型

---

**版本**: v3.0  
**最后更新**: 2026-01-15  
**状态**: ✅ 生产就绪

**新增功能**:
- ✅ 自动维度适配
- ✅ 查询路径可视化
- ✅ 相似度分布统计
- ✅ 向量空间 2D 概览
