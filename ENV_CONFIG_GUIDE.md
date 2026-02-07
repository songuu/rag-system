# 环境变量配置指南

## 快速开始

创建 `.env.local` 文件并配置以下环境变量：

```bash
# LLM 模型提供商选择
MODEL_PROVIDER=ollama  # 可选: ollama | openai | azure | custom

# Embedding 模型提供商选择 (独立于 LLM)
EMBEDDING_PROVIDER=siliconflow  # 可选: ollama | siliconflow | openai | custom
```

## 架构说明

本系统支持 **LLM 与 Embedding 完全解耦**：

| 模块 | 环境变量 | 说明 |
|------|----------|------|
| LLM 模型 | `MODEL_PROVIDER` | 控制对话/生成模型 |
| Embedding 模型 | `EMBEDDING_PROVIDER` | 控制向量嵌入模型 |

这意味着你可以：
- LLM 用本地 Ollama，Embedding 用云端 SiliconFlow
- LLM 用 OpenAI，Embedding 用 SiliconFlow (省钱)
- 或任意组合

## LLM 提供商配置

### 主开关

`MODEL_PROVIDER` 环境变量控制 LLM 模型提供商：

| 值 | 说明 |
|---|---|
| `ollama` | 使用本地 Ollama 服务 (默认) |
| `openai` | 使用 OpenAI API |
| `azure` | 使用 Azure OpenAI 服务 |
| `custom` | 使用自定义 OpenAI 兼容 API (如 DeepSeek, 智谱等) |

### Ollama 配置 (本地模式)

当 `MODEL_PROVIDER=ollama` 时使用：

```bash
# Ollama 服务地址
OLLAMA_BASE_URL=http://localhost:11434

# LLM 模型 (对话/生成)
# 推荐: llama3.1, qwen2.5, glm-4
OLLAMA_LLM_MODEL=llama3.1

# 推理模型 (复杂推理任务)
# 推荐: deepseek-r1, qwen3
OLLAMA_REASONING_MODEL=deepseek-r1
```

### OpenAI 配置

当 `MODEL_PROVIDER=openai` 时使用：

```bash
# API Key (必填)
OPENAI_API_KEY=sk-xxxxx

# API 基础地址 (可选，用于代理)
OPENAI_BASE_URL=https://api.openai.com/v1

# LLM 模型
OPENAI_LLM_MODEL=gpt-4o-mini

# 推理模型
OPENAI_REASONING_MODEL=gpt-4o
```

### Azure OpenAI 配置

当 `MODEL_PROVIDER=azure` 时使用：

```bash
# API Key (必填)
AZURE_OPENAI_API_KEY=xxxxx

# 终端地址 (必填)
AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com

# 部署名称
AZURE_OPENAI_LLM_DEPLOYMENT=gpt-4o-mini
```

### 自定义 API 配置

当 `MODEL_PROVIDER=custom` 时使用，支持 OpenAI 兼容的第三方 API：

```bash
# API Key (必填)
CUSTOM_API_KEY=sk-xxxxx

# API 基础地址 (必填)
# DeepSeek: https://api.deepseek.com
# 智谱: https://open.bigmodel.cn/api/paas/v4
# 月之暗面: https://api.moonshot.cn/v1
CUSTOM_BASE_URL=https://api.deepseek.com

# 模型名称
CUSTOM_LLM_MODEL=deepseek-chat
```

---

## 推理模型提供商配置（独立）

### 主开关

`REASONING_PROVIDER` 环境变量**独立控制**推理模型提供商：

| 值 | 说明 |
|---|---|
| `ollama` | 使用本地 Ollama 推理模型（默认跟随 `MODEL_PROVIDER`） |
| `openai` | 使用 OpenAI 推理模型 |
| `custom` | 使用自定义 OpenAI 兼容 API (如 DeepSeek) |

> **注意**: 如果未设置 `REASONING_PROVIDER`，将自动跟随 `MODEL_PROVIDER` 的设置。

### Ollama 推理模型配置

当 `REASONING_PROVIDER=ollama` 时使用：

```bash
# Ollama 服务地址（共用）
OLLAMA_BASE_URL=http://localhost:11434

# 推理模型名称
# 推荐: deepseek-r1, qwen3
OLLAMA_REASONING_MODEL=deepseek-r1
```

### OpenAI 推理模型配置

当 `REASONING_PROVIDER=openai` 时使用：

```bash
# API Key（共用 OpenAI 配置）
OPENAI_API_KEY=sk-xxxxx

# API 基础地址（可选）
OPENAI_BASE_URL=

# 推理模型
OPENAI_REASONING_MODEL=gpt-4o
```

### 自定义推理模型 API 配置

当 `REASONING_PROVIDER=custom` 时使用：

```bash
# API Key (可独立配置，默认复用 CUSTOM_API_KEY)
CUSTOM_REASONING_API_KEY=sk-xxxxx

# API 基础地址 (可独立配置，默认复用 CUSTOM_BASE_URL)
# DeepSeek Reasoner: https://api.deepseek.com
CUSTOM_REASONING_BASE_URL=https://api.deepseek.com

# 模型名称
# DeepSeek: deepseek-reasoner
CUSTOM_REASONING_MODEL=deepseek-reasoner
```

### 配置说明

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `REASONING_PROVIDER` | 跟随 `MODEL_PROVIDER` | 推理模型提供商 |
| `OLLAMA_REASONING_MODEL` | `deepseek-r1` | Ollama 推理模型 |
| `OPENAI_REASONING_MODEL` | `gpt-4o` | OpenAI 推理模型 |
| `CUSTOM_REASONING_API_KEY` | 复用 `CUSTOM_API_KEY` | 自定义推理 API Key |
| `CUSTOM_REASONING_BASE_URL` | 复用 `CUSTOM_BASE_URL` | 自定义推理 API 地址 |
| `CUSTOM_REASONING_MODEL` | `deepseek-reasoner` | 自定义推理模型名称 |

---

## Embedding 提供商配置 (独立)

### 主开关

`EMBEDDING_PROVIDER` 环境变量**独立控制** Embedding 模型提供商：

| 值 | 说明 |
|---|---|
| `ollama` | 使用本地 Ollama Embedding 模型 |
| `siliconflow` | 使用硅基流动 (SiliconFlow) 云服务 ⭐ **推荐** |
| `openai` | 使用 OpenAI Embedding API |
| `custom` | 使用自定义 OpenAI 兼容 API |

### SiliconFlow 配置 (推荐) ⭐

[SiliconFlow (硅基流动)](https://cloud.siliconflow.cn) 提供高性价比的 Embedding 服务，新用户注册送 2000 万 Tokens。

当 `EMBEDDING_PROVIDER=siliconflow` 时使用：

```bash
# SiliconFlow API Key (必填)
# 获取地址: https://cloud.siliconflow.cn/account/ak
SILICONFLOW_API_KEY=sk-xxxxx

# API 基础地址 (可选，使用默认即可)
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1

# Embedding 模型选择
# 推荐: BAAI/bge-m3 (1024维, 8192 tokens)
# 更多模型: https://cloud.siliconflow.cn/me/models?types=embedding
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3
```

**SiliconFlow 支持的 Embedding 模型：**

| 模型 | 维度 | 最大 Tokens | 说明 |
|------|------|-------------|------|
| `BAAI/bge-large-zh-v1.5` | 1024 | 512 | 中文优化 |
| `BAAI/bge-large-en-v1.5` | 1024 | 512 | 英文优化 |
| `BAAI/bge-m3` | 1024 | 8192 | 多语言，长文本 ⭐ |
| `Pro/BAAI/bge-m3` | 1024 | 8192 | Pro 版本 |
| `Qwen/Qwen3-Embedding-8B` | 4096 | 32768 | 最强精度 |
| `Qwen/Qwen3-Embedding-4B` | 2560 | 32768 | 平衡选择 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | 32768 | 轻量快速 |
| `netease-youdao/bce-embedding-base_v1` | 768 | 512 | 网易有道 |

### Ollama Embedding 配置

当 `EMBEDDING_PROVIDER=ollama` 时使用：

```bash
# Ollama 服务地址
OLLAMA_BASE_URL=http://localhost:11434

# Embedding 模型
# 推荐: nomic-embed-text (768维), bge-m3 (1024维)
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

**Ollama 支持的 Embedding 模型：**

| 模型 | 维度 | 说明 |
|------|------|------|
| `nomic-embed-text` | 768 | 默认推荐 |
| `bge-m3` | 1024 | 多语言 |
| `bge-large` | 1024 | BGE 系列 |
| `all-minilm` | 384 | 轻量 |
| `mxbai-embed-large` | 1024 | 高质量 |
| `qwen3-embedding` | 1024 | Qwen3 系列 |

### OpenAI Embedding 配置

当 `EMBEDDING_PROVIDER=openai` 时使用：

```bash
# API Key (必填)
OPENAI_API_KEY=sk-xxxxx

# API 基础地址 (可选)
OPENAI_BASE_URL=

# Embedding 模型
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

### 自定义 Embedding API 配置

当 `EMBEDDING_PROVIDER=custom` 时使用：

```bash
# API Key (必填)
CUSTOM_EMBEDDING_API_KEY=sk-xxxxx

# API 基础地址 (必填)
CUSTOM_EMBEDDING_BASE_URL=https://api.example.com/v1

# 模型名称
CUSTOM_EMBEDDING_MODEL=custom-embedding

# 向量维度 (必填 - 自定义模型需要显式指定)
# 因为系统无法自动识别自定义模型的维度
CUSTOM_EMBEDDING_DIMENSION=1024
```

> ⚠️ **重要**: 使用自定义 Embedding API 时，**必须**设置 `CUSTOM_EMBEDDING_DIMENSION`，否则系统将使用默认值 768，可能导致维度不匹配错误。

---

## Milvus 配置

Milvus 向量数据库支持两种部署模式：

### 主开关

```bash
# Milvus 提供商选择
MILVUS_PROVIDER=local  # 可选: local | zilliz
```

| 值 | 说明 |
|---|---|
| `local` | 使用本地自建 Milvus 服务 (默认) |
| `zilliz` | 使用 Zilliz Cloud 托管服务 |

### 本地 Milvus 配置 (local)

当 `MILVUS_PROVIDER=local` 时使用：

```bash
# Milvus 服务地址
MILVUS_LOCAL_ADDRESS=localhost:19530

# 认证（可选）
MILVUS_LOCAL_USERNAME=
MILVUS_LOCAL_PASSWORD=
```

### Zilliz Cloud 配置 (zilliz)

当 `MILVUS_PROVIDER=zilliz` 时使用：

```bash
# Zilliz Cloud 集群端点 (必填)
# ⚠️ 注意：不需要 https:// 前缀，SDK 会自动处理
# 格式: in01-xxx.api.region.zillizcloud.com:443
# 从 Zilliz Cloud 控制台 -> 集群 -> Connect -> Node.js 获取
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443

# API Token (必填)
# 从 Zilliz Cloud 控制台 -> API Keys 获取
MILVUS_ZILLIZ_TOKEN=your_api_key_here

# 是否为 Serverless 实例
MILVUS_ZILLIZ_SERVERLESS=false
```

### 通用默认配置

```bash
# 默认数据库
MILVUS_DEFAULT_DATABASE=default

# 默认集合名称
MILVUS_DEFAULT_COLLECTION=rag_documents

# 默认向量维度
MILVUS_DEFAULT_DIMENSION=1024

# 默认索引类型
MILVUS_DEFAULT_INDEX_TYPE=IVF_FLAT

# 默认距离度量
MILVUS_DEFAULT_METRIC_TYPE=COSINE
```

---

## Reasoning RAG 配置（独立）

Reasoning RAG 使用独立的配置，与主应用的 Milvus 配置分离。这样可以：
- 使用不同的集合存储推理文档
- 配置不同的向量维度
- 独立调整检索和推理参数

### 主要配置

```bash
# Reasoning RAG 专用集合名称（独立于主应用）
REASONING_RAG_COLLECTION=reasoning_rag_documents

# Reasoning RAG 专用向量维度（独立于主应用）
# 不设置时自动从 EMBEDDING_PROVIDER 对应的模型维度获取
REASONING_RAG_DIMENSION=1024

# 文件上传目录
REASONING_RAG_UPLOAD_DIR=reasoning-uploads
```

### 向量化配置

```bash
# 文本块大小（字符数）
# 注意：会根据 Embedding 模型的 maxTokens 自动调整
REASONING_RAG_CHUNK_SIZE=500

# 文本块重叠大小
REASONING_RAG_CHUNK_OVERLAP=50
```

### 检索配置

```bash
# 初始检索数量
REASONING_RAG_TOP_K=50

# 重排后保留数量
REASONING_RAG_RERANK_TOP_K=5

# 相似度阈值
REASONING_RAG_SIMILARITY_THRESHOLD=0.3

# 是否启用 BM25 混合检索
REASONING_RAG_ENABLE_BM25=true

# 是否启用重排序
REASONING_RAG_ENABLE_RERANK=true
```

### 推理配置

```bash
# 最大推理迭代次数
REASONING_RAG_MAX_ITERATIONS=3

# 生成温度
REASONING_RAG_TEMPERATURE=0.7
```

### 配置说明

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `REASONING_RAG_COLLECTION` | `reasoning_rag_documents` | 专用集合，与主应用分离 |
| `REASONING_RAG_DIMENSION` | 自动获取 | 跟随 Embedding 模型维度 |
| `REASONING_RAG_UPLOAD_DIR` | `reasoning-uploads` | 文件上传目录 |
| `REASONING_RAG_CHUNK_SIZE` | `500` | 会自动适配模型 maxTokens |
| `REASONING_RAG_CHUNK_OVERLAP` | `50` | 块重叠大小 |
| `REASONING_RAG_TOP_K` | `50` | 初始检索数量 |
| `REASONING_RAG_RERANK_TOP_K` | `5` | 重排后保留数量 |
| `REASONING_RAG_SIMILARITY_THRESHOLD` | `0.3` | 相似度阈值 |
| `REASONING_RAG_ENABLE_BM25` | `true` | 启用混合检索 |
| `REASONING_RAG_ENABLE_RERANK` | `true` | 启用重排序 |
| `REASONING_RAG_MAX_ITERATIONS` | `3` | 最大迭代次数 |
| `REASONING_RAG_TEMPERATURE` | `0.7` | 生成温度 |

---

## 完整配置示例

### 示例 1: 本地开发 (全本地)

```bash
# LLM 配置 - 使用本地 Ollama
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.1
OLLAMA_REASONING_MODEL=deepseek-r1

# Embedding 配置 - 使用本地 Ollama
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBEDDING_MODEL=nomic-embed-text

# Milvus 配置 - 本地
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
MILVUS_DEFAULT_DIMENSION=768
```

### 示例 2: 混合模式 (本地 LLM + 云端 Embedding) ⭐ 推荐

```bash
# LLM 配置 - 使用本地 Ollama (省钱)
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.1
OLLAMA_REASONING_MODEL=deepseek-r1

# Embedding 配置 - 使用 SiliconFlow (高质量)
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置 - Zilliz Cloud
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443
MILVUS_ZILLIZ_TOKEN=xxxxx
MILVUS_DEFAULT_DIMENSION=1024  # 匹配 bge-m3 维度

# Reasoning RAG 独立配置（可选）
REASONING_RAG_COLLECTION=reasoning_rag_documents
REASONING_RAG_DIMENSION=1024  # 跟随 Embedding 模型维度
```

### 示例 3: 生产环境 (全云端)

```bash
# LLM 配置 - 使用 OpenAI
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxx
OPENAI_LLM_MODEL=gpt-4o-mini
OPENAI_REASONING_MODEL=gpt-4o

# Embedding 配置 - 使用 SiliconFlow (省钱)
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置 - Zilliz Cloud
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.aws-us-west-2.vectordb.zillizcloud.com:443
MILVUS_ZILLIZ_TOKEN=xxxxx
MILVUS_DEFAULT_DIMENSION=1024
```

### 示例 4: 使用 DeepSeek API + SiliconFlow

```bash
# LLM 配置 - 使用 DeepSeek
MODEL_PROVIDER=custom
CUSTOM_API_KEY=sk-xxxxx
CUSTOM_BASE_URL=https://api.deepseek.com
CUSTOM_LLM_MODEL=deepseek-chat

# Embedding 配置 - 使用 SiliconFlow
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
MILVUS_DEFAULT_DIMENSION=1024
```

### 示例 5: 完整 Reasoning RAG 配置

```bash
# LLM 配置 - 使用 DeepSeek
MODEL_PROVIDER=custom
CUSTOM_API_KEY=sk-xxxxx
CUSTOM_BASE_URL=https://api.deepseek.com
CUSTOM_LLM_MODEL=deepseek-chat

# 推理模型配置 - 独立使用 DeepSeek Reasoner
REASONING_PROVIDER=custom
CUSTOM_REASONING_API_KEY=sk-xxxxx  # 可省略，默认复用 CUSTOM_API_KEY
CUSTOM_REASONING_BASE_URL=https://api.deepseek.com  # 可省略，默认复用 CUSTOM_BASE_URL
CUSTOM_REASONING_MODEL=deepseek-reasoner

# Embedding 配置 - 使用 SiliconFlow
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# 主应用 Milvus 配置
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443
MILVUS_ZILLIZ_TOKEN=xxxxx
MILVUS_DEFAULT_COLLECTION=rag_documents
MILVUS_DEFAULT_DIMENSION=1024

# Reasoning RAG 独立配置（与主应用分离）
REASONING_RAG_COLLECTION=reasoning_rag_documents
REASONING_RAG_DIMENSION=1024
REASONING_RAG_UPLOAD_DIR=reasoning-uploads
REASONING_RAG_CHUNK_SIZE=500
REASONING_RAG_CHUNK_OVERLAP=50
REASONING_RAG_TOP_K=50
REASONING_RAG_RERANK_TOP_K=5
REASONING_RAG_SIMILARITY_THRESHOLD=0.3
REASONING_RAG_ENABLE_BM25=true
REASONING_RAG_ENABLE_RERANK=true
REASONING_RAG_MAX_ITERATIONS=3
REASONING_RAG_TEMPERATURE=0.7
```

### 示例 6: LLM 和推理模型使用不同提供商

```bash
# LLM 配置 - 使用本地 Ollama（省钱）
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.1

# 推理模型配置 - 使用 DeepSeek Reasoner（强推理能力）
REASONING_PROVIDER=custom
CUSTOM_REASONING_API_KEY=sk-xxxxx
CUSTOM_REASONING_BASE_URL=https://api.deepseek.com
CUSTOM_REASONING_MODEL=deepseek-reasoner

# Embedding 配置 - 使用 SiliconFlow
EMBEDDING_PROVIDER=siliconflow
SILICONFLOW_API_KEY=sk-xxxxx
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3

# Milvus 配置
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
MILVUS_DEFAULT_DIMENSION=1024
```

---

## API 使用

### 获取当前配置

```typescript
import { getConfigSummary } from '@/lib/model-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';

// 获取 LLM 配置摘要
const llmSummary = getConfigSummary();
console.log(llmSummary);
// {
//   provider: 'ollama',
//   llmModel: 'llama3.1',
//   embeddingProvider: 'siliconflow',
//   embeddingModel: 'BAAI/bge-m3',
//   ...
// }

// 获取 Embedding 配置摘要
const embeddingSummary = getEmbeddingConfigSummary();
console.log(embeddingSummary);
// {
//   provider: 'siliconflow',
//   model: 'BAAI/bge-m3',
//   dimension: 1024,
//   baseUrl: 'https://api.siliconflow.cn/v1',
//   hasApiKey: true
// }
```

### 创建模型实例

```typescript
import { createLLM, createReasoningModel } from '@/lib/model-config';
import { createEmbeddingModel, getEmbeddingDimension } from '@/lib/embedding-config';

// 创建 LLM (会根据 MODEL_PROVIDER 自动选择)
const llm = createLLM();

// 创建指定模型的 LLM
const llm2 = createLLM('gpt-4o');

// 创建 Embedding 模型 (会根据 EMBEDDING_PROVIDER 自动选择)
const embedding = createEmbeddingModel();

// 获取当前 Embedding 模型维度
const dimension = getEmbeddingDimension();
console.log(`当前 Embedding 维度: ${dimension}`);

// 创建推理模型
const reasoning = createReasoningModel();
```

### 验证配置

```typescript
import { getModelFactory } from '@/lib/model-config';
import { validateEmbeddingConfig } from '@/lib/embedding-config';

// 验证 LLM 配置
const factory = getModelFactory();
const llmValidation = factory.validateConfig();

// 验证 Embedding 配置
const embeddingValidation = validateEmbeddingConfig();

if (!llmValidation.valid) {
  console.error('LLM 配置错误:', llmValidation.errors);
}

if (!embeddingValidation.valid) {
  console.error('Embedding 配置错误:', embeddingValidation.errors);
}
```

### 重新加载配置

```typescript
import { getModelFactory } from '@/lib/model-config';
import { reloadEmbeddingConfig } from '@/lib/embedding-config';

// 重新加载 LLM 配置
getModelFactory().reloadConfig();

// 重新加载 Embedding 配置
reloadEmbeddingConfig();
```

---

## 常见问题

### Q: 如何选择 Embedding 提供商？

| 场景 | 推荐方案 |
|------|----------|
| 本地开发，无需联网 | `ollama` + `nomic-embed-text` |
| 生产环境，追求性价比 | `siliconflow` + `BAAI/bge-m3` |
| 生产环境，追求最高质量 | `siliconflow` + `Qwen/Qwen3-Embedding-8B` |
| 已有 OpenAI 账号 | `openai` + `text-embedding-3-small` |

### Q: 切换 Embedding 提供商后需要重新生成向量吗？

是的。不同模型生成的向量维度和语义空间不同，切换后需要：
1. 更新 `MILVUS_DEFAULT_DIMENSION` 匹配新模型维度
2. 重新创建 Milvus 集合 (或删除旧集合)
3. 重新上传所有文档

### Q: SiliconFlow 如何获取 API Key？

1. 访问 https://cloud.siliconflow.cn
2. 注册账号 (新用户送 2000 万 Tokens)
3. 进入控制台 -> Account -> API Keys
4. 创建新的 API Key

### Q: Milvus 维度不匹配怎么办？

如果出现 `dimension mismatch` 错误：
1. 检查 `MILVUS_DEFAULT_DIMENSION` 是否与 Embedding 模型匹配
2. 删除现有集合：通过 API 调用 `/api/milvus?action=recreate`
3. 重新上传文档

### Q: Reasoning RAG 和主应用的数据是分开的吗？

是的。Reasoning RAG 使用独立的配置和集合：
- 主应用使用 `MILVUS_DEFAULT_COLLECTION`（默认 `rag_documents`）
- Reasoning RAG 使用 `REASONING_RAG_COLLECTION`（默认 `reasoning_rag_documents`）

两者的数据完全隔离，可以独立配置向量维度。

### Q: Reasoning RAG 向量化时报 "input length exceeds context length" 错误？

这是因为文本块超过了 Embedding 模型的上下文长度限制。系统会自动根据模型的 maxTokens 调整 chunkSize：

| 模型 | maxTokens | 安全 chunkSize |
|------|-----------|---------------|
| `BAAI/bge-large-zh-v1.5` | 512 | ~200 字符 |
| `nomic-embed-text` | 2048 | ~800 字符 |
| `BAAI/bge-m3` | 8192 | ~2000 字符 |

建议使用 `BAAI/bge-m3` 或 `Qwen3-Embedding` 系列，支持更长的文本。

### Q: 如何查看 Reasoning RAG 当前配置？

调用 API：
```bash
# 获取完整配置
curl http://localhost:3000/api/reasoning-rag?action=config

# 获取向量化状态和配置
curl http://localhost:3000/api/reasoning-rag/vectorize
```
