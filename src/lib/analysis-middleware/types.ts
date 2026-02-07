/**
 * 中转分析层（Analysis Middleware）类型定义
 * 
 * 核心目标：将原本不可见的"黑盒分词"与"无形向量"转化为可追踪、可量化的结构化日志流
 */

// ============= 原子层：Token 决策元数据 =============

/**
 * Trie 树搜索路径信息
 */
export interface PathLogic {
  /** 在 Trie 树中的搜索深度 */
  depth: number;
  /** 命中次数 */
  hitCount: number;
  /** 冲突的 Rank 差值列表 */
  rankConflicts: number[];
  /** 选择的路径索引 */
  selectedPathIndex: number;
  /** 备选路径 */
  alternativePaths: string[];
}

/**
 * 语义熵信息
 */
export interface SemanticEntropy {
  /** 该词元在词表中的信息熵贡献 */
  entropyContribution: number;
  /** 在整个序列中的熵占比 */
  entropyRatio: number;
  /** 词频（在训练语料中的估计频率）*/
  frequency: number;
  /** 逆文档频率 */
  idf: number;
}

/**
 * 字节范围映射
 */
export interface ByteRange {
  /** 原始字符串起始位置 */
  start: number;
  /** 原始字符串结束位置 */
  end: number;
  /** 字节长度 */
  byteLength: number;
  /** 字符长度 */
  charLength: number;
  /** 原始文本片段 */
  originalText: string;
}

/**
 * Token 决策元数据
 */
export interface TokenDecisionMetadata {
  /** Token ID */
  tokenId: number;
  /** Token 文本 */
  token: string;
  /** Trie 路径逻辑 */
  pathLogic: PathLogic;
  /** 语义熵 */
  semanticEntropy: SemanticEntropy;
  /** 字节范围 */
  byteRange: ByteRange;
  /** 决策类型 */
  decisionType: 'merge' | 'split' | 'fallback' | 'direct';
  /** 决策置信度 */
  confidence: number;
}

// ============= 向量层：Embedding 映射 =============

/**
 * 静态权重（从 Embedding 层提取）
 */
export interface StaticWeight {
  /** L2 范数（向量模长）*/
  l2Norm: number;
  /** L1 范数 */
  l1Norm: number;
  /** 最大绝对值 */
  maxAbsValue: number;
  /** 平均值 */
  mean: number;
  /** 方差 */
  variance: number;
  /** 稀疏度（零值比例）*/
  sparsity: number;
}

/**
 * 动态重要性（基于上下文的权重）
 */
export interface DynamicImportance {
  /** 上下文相关性得分 */
  contextRelevance: number;
  /** 注意力权重（如果可用）*/
  attentionWeight?: number;
  /** 与查询的余弦相似度 */
  queryCosineSimilarity?: number;
  /** 语义贡献度 */
  semanticContribution: number;
}

/**
 * Embedding 映射信息
 */
export interface EmbeddingMapping {
  /** Token ID */
  tokenId: number;
  /** 嵌入向量（可选，用于详细分析）*/
  embedding?: number[];
  /** 嵌入维度 */
  dimension: number;
  /** 静态权重 */
  staticWeight: StaticWeight;
  /** 动态重要性 */
  dynamicImportance: DynamicImportance;
}

// ============= 核心指标计算 =============

/**
 * 决策稳定性系数
 * 值越小，代表该处分词越具有争议性
 */
export interface StabilityMetrics {
  /** 稳定性系数 = 1 - (次优得分 / 最优得分) */
  coefficient: number;
  /** 最优得分 */
  topScore: number;
  /** 次优得分 */
  secondScore: number;
  /** 得分差距 */
  scoreDelta: number;
  /** 稳定性级别 */
  level: 'stable' | 'moderate' | 'unstable' | 'critical';
}

/**
 * 检索贡献度
 * 展示哪个 Token 真正决定了 RAG 的检索结果
 */
export interface RetrievalContribution {
  /** Token ID */
  tokenId: number;
  /** 贡献度 = cos_sim(token_vec, query_vec) * ||token_vec|| */
  contribution: number;
  /** 归一化贡献度（在所有 Token 中的占比）*/
  normalizedContribution: number;
  /** 余弦相似度 */
  cosineSimilarity: number;
  /** 向量模长 */
  vectorNorm: number;
  /** 是否为关键 Token */
  isKeyToken: boolean;
}

/**
 * 知识覆盖率
 * 显示该领域文本在模型中的熟练程度
 */
export interface KnowledgeCoverage {
  /** 覆盖率得分 (0-1) */
  score: number;
  /** 已知词元比例 */
  knownTokenRatio: number;
  /** 字节回退比例 */
  fallbackRatio: number;
  /** 平均 Token 频率 */
  avgTokenFrequency: number;
  /** 领域识别 */
  domainRecognition: {
    domain: string;
    confidence: number;
  };
  /** 覆盖级别 */
  level: 'expert' | 'familiar' | 'basic' | 'unfamiliar' | 'unknown';
}

// ============= BPE 合并记录 =============

/**
 * BPE 合并操作记录
 */
export interface MergeOperation {
  /** 操作序号 */
  step: number;
  /** 左侧 Token */
  left: {
    token: string;
    tokenId: number;
    rank: number;
  };
  /** 右侧 Token */
  right: {
    token: string;
    tokenId: number;
    rank: number;
  };
  /** 合并结果 */
  merged: {
    token: string;
    tokenId: number;
    rank: number;
  };
  /** 被舍弃的备选 Pair */
  discardedAlternatives: Array<{
    left: string;
    right: string;
    rank: number;
    reason: string;
  }>;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 逻辑瀑布流数据
 */
export interface LogicWaterfallData {
  /** 原始输入 */
  input: string;
  /** 阶段列表 */
  stages: Array<{
    level: 'bytes' | 'characters' | 'subwords' | 'fullwords';
    tokens: TokenDecisionMetadata[];
    mergeOperations: MergeOperation[];
    processingTime: number;
    entropy: number;
  }>;
  /** 总处理时间 */
  totalTime: number;
  /** 最终 Token 数量 */
  finalTokenCount: number;
  /** 压缩比 */
  compressionRatio: number;
}

// ============= 检索对齐映射 =============

/**
 * Token 级相似度矩阵条目
 */
export interface TokenSimilarityEntry {
  /** Query Token 索引 */
  queryTokenIndex: number;
  /** Query Token */
  queryToken: string;
  /** Chunk Token 索引 */
  chunkTokenIndex: number;
  /** Chunk Token */
  chunkToken: string;
  /** 相似度得分 */
  similarity: number;
  /** 是否为强匹配 */
  isStrongMatch: boolean;
}

/**
 * 检索路径图
 */
export interface RetrievalPathGraph {
  /** Query ID */
  queryId: string;
  /** Query Tokens */
  queryTokens: Array<{
    token: string;
    tokenId: number;
    contribution: RetrievalContribution;
  }>;
  /** 检索到的 Chunks */
  retrievedChunks: Array<{
    chunkId: string;
    content: string;
    tokens: Array<{
      token: string;
      tokenId: number;
      position: number;
    }>;
    overallSimilarity: number;
  }>;
  /** Token 级相似度矩阵 */
  similarityMatrix: TokenSimilarityEntry[];
  /** 关键匹配路径 */
  keyMatchPaths: Array<{
    queryTokenIndex: number;
    chunkIndex: number;
    chunkTokenIndex: number;
    matchScore: number;
  }>;
}

// ============= 模型对比 =============

/**
 * 单模型分析结果
 */
export interface SingleModelAnalysis {
  /** 模型名称 */
  modelName: string;
  /** 模型类型 */
  modelType: 'bert' | 'gpt' | 'bge' | 'minilm' | 'other';
  /** Token 序列 */
  tokens: TokenDecisionMetadata[];
  /** Embedding 映射 */
  embeddings: EmbeddingMapping[];
  /** 知识覆盖率 */
  knowledgeCoverage: KnowledgeCoverage;
  /** 处理时间 */
  processingTime: number;
  /** 词汇表大小 */
  vocabSize: number;
}

/**
 * 模型对比结果
 */
export interface ModelComparisonResult {
  /** 输入文本 */
  input: string;
  /** 参与对比的模型 */
  models: SingleModelAnalysis[];
  /** 字符级对齐 */
  characterAlignment: Array<{
    charIndex: number;
    char: string;
    modelTokens: Record<string, {
      tokenIndex: number;
      token: string;
      tokenId: number;
    }>;
  }>;
  /** 差异点 */
  differences: Array<{
    position: number;
    type: 'split_difference' | 'merge_difference' | 'unknown_handling';
    models: Record<string, string[]>;
    significance: 'low' | 'medium' | 'high';
  }>;
  /** 最佳模型推荐 */
  recommendation: {
    bestModel: string;
    reason: string;
    scores: Record<string, number>;
  };
}

// ============= 完整 TraceContext =============

/**
 * 完整的 Trace 上下文
 * 包含所有分析数据的标准化容器
 */
export interface TraceContext {
  /** Trace ID */
  traceId: string;
  /** 创建时间 */
  createdAt: Date;
  /** 原始输入 */
  input: string;
  /** 使用的模型 */
  primaryModel: string;
  
  // 核心数据
  /** 逻辑瀑布流 */
  waterfall: LogicWaterfallData;
  /** Token 决策元数据列表 */
  tokenDecisions: TokenDecisionMetadata[];
  /** Embedding 映射列表 */
  embeddingMappings: EmbeddingMapping[];
  
  // 计算指标
  /** 稳定性指标 */
  stabilityMetrics: StabilityMetrics[];
  /** 检索贡献度 */
  retrievalContributions: RetrievalContribution[];
  /** 知识覆盖率 */
  knowledgeCoverage: KnowledgeCoverage;
  
  // 可选：多模型对比
  /** 模型对比结果 */
  modelComparison?: ModelComparisonResult;
  /** 检索路径图 */
  retrievalPath?: RetrievalPathGraph;
  
  // 元数据
  /** 处理统计 */
  stats: {
    totalTokens: number;
    totalTime: number;
    compressionRatio: number;
    avgStability: number;
    avgContribution: number;
  };
  /** 警告列表 */
  warnings: Array<{
    type: 'low_density' | 'high_fragmentation' | 'unstable_decision' | 'low_coverage';
    severity: 'info' | 'warning' | 'error';
    message: string;
    position?: number;
    suggestion?: string;
  }>;
}

// ============= API 响应类型 =============

export interface AnalysisMiddlewareResponse {
  success: boolean;
  traceContext: TraceContext;
  error?: string;
}

export interface StreamingAnalysisEvent {
  type: 'stage_complete' | 'token_processed' | 'embedding_computed' | 'analysis_complete' | 'warning' | 'error';
  data: any;
  timestamp: number;
  progress?: number;
}
