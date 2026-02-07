# Agentic RAG 系统指南

## 概述

Agentic RAG 是基于 LangGraph 构建的代理化检索增强生成系统。它通过引入多个智能节点，实现了自动化的查询优化、检索质量评估、自省评分和幻觉检查。

## 核心特性

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

## 工作流程

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

### 基本查询

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

### 响应结构

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
  "useAgenticRAG": true,
  "maxRetries": 2
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

## 性能优化

- 自省评分和幻觉检查会增加 LLM 调用次数，可根据需要禁用
- 使用更快的 LLM 模型可以减少整体响应时间
- 合理设置 maxRetries 避免不必要的重试

## 故障排除

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 检索结果为空 | Milvus 集合为空 | 先上传文档并同步到 Milvus |
| 响应时间过长 | LLM 调用过多 | 减少 maxRetries，禁用部分检查 |
| 幻觉检测误报 | 上下文不完整 | 增加 Top-K 值 |
| 查询重写循环 | 质量阈值过高 | 降低相似度阈值 |
