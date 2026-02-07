# Milvus 配置指南

本指南详细说明如何配置 Milvus 向量数据库，支持本地部署和 Zilliz Cloud 托管服务两种模式。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     应用层 (RAG System)                          │
├─────────────────────────────────────────────────────────────────┤
│                  milvus-client.ts (统一接口)                     │
├─────────────────────────────────────────────────────────────────┤
│                  milvus-config.ts (配置管理)                     │
├─────────────────┬───────────────────────────────────────────────┤
│   本地 Milvus   │              Zilliz Cloud                     │
│  (localhost)    │         (托管向量数据库)                        │
└─────────────────┴───────────────────────────────────────────────┘
```

## 快速开始

### 1. 选择部署模式

在 `.env.local` 文件中设置 `MILVUS_PROVIDER`：

```bash
# 本地部署
MILVUS_PROVIDER=local

# 或 Zilliz Cloud
MILVUS_PROVIDER=zilliz
```

### 2. 配置连接参数

#### 本地 Milvus

```bash
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=localhost:19530
# 可选认证
MILVUS_LOCAL_USERNAME=
MILVUS_LOCAL_PASSWORD=
```

#### Zilliz Cloud

```bash
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=https://in01-xxx.zillizcloud.com:19530
MILVUS_ZILLIZ_TOKEN=your-api-token
MILVUS_ZILLIZ_SERVERLESS=false
```

## 详细配置说明

### 环境变量完整列表

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `MILVUS_PROVIDER` | `local` | 提供商选择：`local` 或 `zilliz` |
| `MILVUS_LOCAL_ADDRESS` | `localhost:19530` | 本地 Milvus 地址 |
| `MILVUS_LOCAL_USERNAME` | 空 | 本地 Milvus 用户名 |
| `MILVUS_LOCAL_PASSWORD` | 空 | 本地 Milvus 密码 |
| `MILVUS_ZILLIZ_ENDPOINT` | 空 | Zilliz Cloud 集群端点 |
| `MILVUS_ZILLIZ_TOKEN` | 空 | Zilliz Cloud API Token |
| `MILVUS_ZILLIZ_SERVERLESS` | `false` | 是否为 Serverless 实例 |
| `MILVUS_DEFAULT_DATABASE` | `default` | 默认数据库名 |
| `MILVUS_DEFAULT_COLLECTION` | `rag_documents` | 默认集合名 |
| `MILVUS_DEFAULT_DIMENSION` | `768` | 默认向量维度 |
| `MILVUS_DEFAULT_INDEX_TYPE` | `IVF_FLAT` | 默认索引类型 |
| `MILVUS_DEFAULT_METRIC_TYPE` | `COSINE` | 默认距离度量 |

### 索引类型说明

| 索引类型 | 适用场景 | 性能特点 |
|---------|---------|---------|
| `FLAT` | 小数据集 | 精确搜索，无损失 |
| `IVF_FLAT` | 中等数据集 | 平衡的性能和精度 |
| `IVF_SQ8` | 大数据集 | 量化压缩，节省内存 |
| `IVF_PQ` | 超大数据集 | 高压缩比，较低精度 |
| `HNSW` | 高召回需求 | 高性能，内存占用大 |

### 距离度量类型

| 度量类型 | 说明 | 适用场景 |
|---------|------|---------|
| `COSINE` | 余弦相似度 | 文本嵌入（推荐） |
| `L2` | 欧氏距离 | 图像特征 |
| `IP` | 内积 | 归一化向量 |

## Zilliz Cloud 配置指南

### 获取连接信息

1. 登录 [Zilliz Cloud Console](https://cloud.zilliz.com)
2. 创建或选择一个集群
3. 在集群详情页获取：
   - **Public Endpoint**: 形如 `https://in01-xxx.zillizcloud.com:19530`
   - **API Key**: 在 API Keys 页面创建

### Serverless vs Dedicated

| 特性 | Serverless | Dedicated |
|------|------------|-----------|
| 计费 | 按使用量 | 固定价格 |
| 性能 | 弹性扩展 | 固定资源 |
| 适用 | 开发/测试 | 生产环境 |
| 冷启动 | 可能有延迟 | 无 |

```bash
# Serverless 实例配置
MILVUS_ZILLIZ_SERVERLESS=true
```

## 代码使用示例

### 基本使用

```typescript
import { getMilvusInstance } from '@/lib/milvus-client';

// 获取实例（自动使用环境变量配置）
const milvus = getMilvusInstance();

// 连接
await milvus.connect();

// 插入文档
await milvus.insertDocuments([{
  id: 'doc-1',
  content: '文档内容',
  embedding: [0.1, 0.2, ...],
  metadata: { source: 'test.txt' }
}]);

// 搜索
const results = await milvus.search(queryEmbedding, 5, 0.5);
```

### 使用配置管理器

```typescript
import { 
  getMilvusConfigManager,
  getMilvusProvider,
  isZillizCloud,
  getMilvusConfigSummary 
} from '@/lib/milvus-config';

// 获取当前提供商
const provider = getMilvusProvider(); // 'local' 或 'zilliz'

// 检查是否使用云端
if (isZillizCloud()) {
  console.log('使用 Zilliz Cloud');
}

// 获取配置摘要
const summary = getMilvusConfigSummary();
console.log(summary);
// {
//   provider: 'zilliz',
//   endpoint: 'https://xxx.zillizcloud.com:19530',
//   hasCredentials: true,
//   ssl: true,
//   defaultCollection: 'rag_documents',
//   defaultDimension: 768
// }
```

### 动态切换配置

```typescript
import { reloadMilvusConfig, resetMilvusInstance } from '@/lib/milvus-config';

// 重新加载环境变量配置
reloadMilvusConfig();

// 重置客户端实例（下次调用会创建新连接）
await resetMilvusInstance();
```

## API 接口

系统提供 REST API 来管理 Milvus 配置：

### 获取当前配置

```bash
GET /api/milvus?action=config
```

响应：
```json
{
  "success": true,
  "config": {
    "provider": "local",
    "endpoint": "localhost:19530",
    "hasCredentials": false,
    "ssl": false,
    "defaultCollection": "rag_documents",
    "defaultDimension": 768
  }
}
```

### 检查连接状态

```bash
GET /api/milvus?action=health
```

## 故障排除

### Schema 不兼容错误

如果遇到类似以下错误：
```
Insert failed: field 'primary_key' is illegal, array type mismatch
```

这通常是因为 Zilliz Cloud 上已存在的集合 Schema 与本系统不兼容。

**解决方案 1: 通过 API 重建集合**

```bash
# 检查 Schema 兼容性
curl -X POST http://localhost:3000/api/milvus \
  -H "Content-Type: application/json" \
  -d '{"action": "check-schema"}'

# 重建集合（会删除现有数据！）
curl -X POST http://localhost:3000/api/milvus \
  -H "Content-Type: application/json" \
  -d '{"action": "recreate"}'
```

**解决方案 2: 连接时自动重建**

```bash
curl -X POST http://localhost:3000/api/milvus \
  -H "Content-Type: application/json" \
  -d '{"action": "connect", "autoRecreate": true}'
```

**解决方案 3: 在 Zilliz Cloud 控制台手动删除集合**

1. 登录 Zilliz Cloud Console
2. 找到对应的集合
3. 删除集合
4. 重新连接

### 连接失败

#### 错误: UNAVAILABLE: No connection established

这是最常见的 Zilliz Cloud 连接错误。可能的原因：

**1. Endpoint 格式问题**

```bash
# ❌ 错误格式
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.zillizcloud.com:19530
MILVUS_ZILLIZ_ENDPOINT=https://in01-xxx.zillizcloud.com:19530

# ✅ 正确格式（不需要 https:// 前缀，SDK 会自动处理）
MILVUS_ZILLIZ_ENDPOINT=in01-xxx.api.gcp-us-west1.zillizcloud.com:443
```

**2. 从 Zilliz Cloud 控制台获取正确的连接信息**

1. 登录 [Zilliz Cloud Console](https://cloud.zilliz.com)
2. 选择你的集群
3. 点击 "Connect" 按钮
4. 选择 "Node.js" SDK
5. 复制 `address` 和 `token` 的值

**3. Token 验证**

```bash
# 确保 Token 已设置且有效
MILVUS_ZILLIZ_TOKEN=your_api_key_here

# Token 可以是：
# - API Key（推荐）
# - 或 "username:password" 格式
```

**4. 网络问题**

```bash
# 测试网络连接
curl -v https://in01-xxx.api.gcp-us-west1.zillizcloud.com:443

# 检查防火墙是否允许出站 443 端口
```

**5. 集群状态**

- 确保集群状态为 "Running"
- 新创建的集群可能需要几分钟才能完全启动

#### 本地 Milvus 连接问题

```bash
# 检查 Milvus 是否运行
docker ps | grep milvus

# 检查端口是否开放
telnet localhost 19530
```

### 维度不匹配

如果遇到向量维度不匹配错误：

1. 检查 `MILVUS_DEFAULT_DIMENSION` 设置
2. 确保 Embedding 模型输出维度与配置一致
3. 如需更改维度，需要清空或重建集合

常用 Embedding 模型维度：

| 模型 | 维度 |
|------|------|
| nomic-embed-text | 768 |
| bge-m3 | 1024 |
| text-embedding-3-small | 1536 |
| text-embedding-3-large | 3072 |

### 性能优化

**本地 Milvus:**
- 使用 SSD 存储
- 增加 `queryNode` 内存
- 使用 HNSW 索引提高召回率

**Zilliz Cloud:**
- 选择合适的实例类型
- 对于高并发场景使用 Dedicated 实例
- 合理设置 `topK` 值减少网络传输

## 从本地迁移到 Zilliz Cloud

1. 导出本地数据（可选）
2. 在 Zilliz Cloud 创建集群
3. 更新环境变量
4. 重新向量化文档或导入数据

```bash
# 更新 .env.local
MILVUS_PROVIDER=zilliz
MILVUS_ZILLIZ_ENDPOINT=https://your-cluster.zillizcloud.com:19530
MILVUS_ZILLIZ_TOKEN=your-token
```

## 最佳实践

1. **开发环境**: 使用本地 Milvus (Docker)
2. **测试环境**: 使用 Zilliz Cloud Serverless
3. **生产环境**: 使用 Zilliz Cloud Dedicated
4. **安全**: 不要将 Token 提交到代码仓库
5. **备份**: 定期备份重要数据
