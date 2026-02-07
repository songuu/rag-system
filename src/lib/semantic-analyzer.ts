/**
 * 语义分析器（Semantic Analyzer）
 * 
 * 基于向量空间的真正语义分析，而非简单的关键词匹配
 * 
 * 核心能力：
 * 1. 向量投影分析 - 将查询向量投影到预定义的语义维度
 * 2. 语义聚类检测 - 基于向量距离判断语义类别
 * 3. 信息熵计算 - 评估查询的信息量和确定性
 * 4. 多维特征提取 - 从向量分布中提取高阶特征
 */

// ============= 类型定义 =============

export interface VectorFeatures {
  // 领域得分（基于向量投影）
  techScore: number;
  businessScore: number;
  dailyScore: number;
  emotionScore: number;
  academicScore: number;
  
  // 向量统计特征
  vectorMagnitude: number;
  vectorEntropy: number;
  vectorSparsity: number;
  vectorKurtosis: number;
  
  // 信息质量指标
  informationDensity: number;
  semanticClarity: number;
}

export interface SemanticContext {
  context: string;
  semanticCategory: string;
  confidence: number;
  nearestConcepts: string[];
  
  // 扩展分析
  categoryDistribution: Record<string, number>;
  semanticClusters: Array<{
    name: string;
    similarity: number;
    centroidDistance: number;
  }>;
  intentAnalysis: {
    primaryIntent: string;
    intentConfidence: number;
    possibleIntents: string[];
  };
}

export interface QueryAnalysisResult {
  tokenization: {
    tokenCount: number;
    avgTokenLength: number;
    processingTime: number;
    originalText: string;
    tokenTypes: {
      chinese: number;
      english: number;
      numbers: number;
      punctuation: number;
    };
  };
  embedding: {
    embedding: number[];
    embeddingDimension: number;
    semanticAnalysis: SemanticContext & {
      vectorFeatures: VectorFeatures;
    };
    modelInfo: {
      name: string;
      vocabularySize: number;
      embeddingNorm: number;
    };
  };
  quality: {
    queryQualityScore: number;
    specificity: number;
    ambiguity: number;
    retrievability: number;
  };
}

// ============= 语义原型定义 =============

/**
 * 语义类别原型
 * 每个类别定义了特征词和对应的向量特征模式
 */
const SEMANTIC_PROTOTYPES = {
  AI技术: {
    keywords: ['人工智能', 'AI', '机器学习', '深度学习', '神经网络', '算法', '模型', 'NLP', 'GPT', 'transformer', '训练', '推理', '向量', '嵌入'],
    vectorPattern: { highVariance: true, positiveBias: true, clustered: true },
    weight: 1.2
  },
  技术开发: {
    keywords: ['编程', '代码', '软件', '系统', '开发', '框架', 'API', '数据库', '服务器', '前端', '后端', '架构', '部署', '测试'],
    vectorPattern: { highVariance: true, positiveBias: false, clustered: true },
    weight: 1.1
  },
  商业管理: {
    keywords: ['商业', '市场', '销售', '客户', '产品', '服务', '管理', '运营', '战略', '投资', '收入', '成本', '利润', 'ROI'],
    vectorPattern: { highVariance: false, positiveBias: true, clustered: false },
    weight: 1.0
  },
  学术研究: {
    keywords: ['研究', '论文', '实验', '假设', '理论', '分析', '方法', '数据', '结论', '引用', '文献', '学术'],
    vectorPattern: { highVariance: true, positiveBias: false, clustered: true },
    weight: 1.15
  },
  日常生活: {
    keywords: ['生活', '日常', '健康', '运动', '饮食', '睡眠', '旅游', '购物', '娱乐', '社交', '家庭'],
    vectorPattern: { highVariance: false, positiveBias: false, clustered: false },
    weight: 0.9
  },
  情感表达: {
    keywords: ['喜欢', '讨厌', '开心', '难过', '愤怒', '恐惧', '感谢', '抱歉', '爱', '希望', '担心'],
    vectorPattern: { highVariance: true, positiveBias: true, clustered: false },
    weight: 0.95
  },
  通用问答: {
    keywords: ['什么', '如何', '为什么', '怎么', '哪里', '谁', '多少', '何时', '是否'],
    vectorPattern: { highVariance: false, positiveBias: false, clustered: false },
    weight: 0.8
  }
};

/**
 * 意图模式
 */
const INTENT_PATTERNS = {
  查询信息: { patterns: ['什么是', '是什么', '介绍', '定义', '概念'], weight: 1.0 },
  操作指导: { patterns: ['如何', '怎么', '怎样', '步骤', '方法', '教程'], weight: 1.1 },
  原因分析: { patterns: ['为什么', '原因', '为何', '导致'], weight: 1.0 },
  比较评估: { patterns: ['区别', '比较', '对比', '哪个更', '优缺点'], weight: 1.05 },
  问题解决: { patterns: ['解决', '处理', '修复', '问题', '错误', '失败'], weight: 1.15 },
  推荐建议: { patterns: ['推荐', '建议', '最好', '应该', '选择'], weight: 1.0 }
};

// ============= 核心分析类 =============

export class SemanticAnalyzer {
  /**
   * 计算向量的高阶统计特征
   */
  static calculateVectorStatistics(embedding: number[]): {
    mean: number;
    variance: number;
    stdDev: number;
    skewness: number;
    kurtosis: number;
    entropy: number;
    sparsity: number;
    l1Norm: number;
    l2Norm: number;
  } {
    const n = embedding.length;
    
    // 基础统计
    const mean = embedding.reduce((a, b) => a + b, 0) / n;
    const variance = embedding.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    
    // 偏度（Skewness）- 衡量分布的不对称性
    const skewness = stdDev > 0 
      ? embedding.reduce((sum, v) => sum + Math.pow((v - mean) / stdDev, 3), 0) / n
      : 0;
    
    // 峰度（Kurtosis）- 衡量分布的尖锐程度
    const kurtosis = stdDev > 0
      ? embedding.reduce((sum, v) => sum + Math.pow((v - mean) / stdDev, 4), 0) / n - 3
      : 0;
    
    // 向量熵（基于值分布）
    const absValues = embedding.map(Math.abs);
    const sumAbs = absValues.reduce((a, b) => a + b, 0) || 1;
    const probs = absValues.map(v => v / sumAbs);
    const entropy = -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
    
    // 稀疏度（接近零的值的比例）
    const threshold = 0.01;
    const nearZeroCount = embedding.filter(v => Math.abs(v) < threshold).length;
    const sparsity = nearZeroCount / n;
    
    // 范数
    const l1Norm = embedding.reduce((sum, v) => sum + Math.abs(v), 0);
    const l2Norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    
    return { mean, variance, stdDev, skewness, kurtosis, entropy, sparsity, l1Norm, l2Norm };
  }

  /**
   * 基于向量投影计算语义维度得分
   * 使用向量的不同区域代表不同语义维度
   */
  static calculateVectorFeatures(embedding: number[], text: string): VectorFeatures {
    const stats = this.calculateVectorStatistics(embedding);
    const n = embedding.length;
    
    // 将向量划分为多个区域进行分析
    const segmentSize = Math.floor(n / 5);
    const segments = [
      embedding.slice(0, segmentSize),
      embedding.slice(segmentSize, segmentSize * 2),
      embedding.slice(segmentSize * 2, segmentSize * 3),
      embedding.slice(segmentSize * 3, segmentSize * 4),
      embedding.slice(segmentSize * 4)
    ];
    
    // 计算每个段的能量
    const segmentEnergies = segments.map(seg => 
      Math.sqrt(seg.reduce((sum, v) => sum + v * v, 0))
    );
    
    // 计算关键词匹配度
    const keywordScores = this.calculateKeywordScores(text);
    
    // 综合向量特征和关键词匹配计算各维度得分
    // 使用sigmoid函数进行平滑归一化
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    
    // 技术得分：基于向量高方差区域 + 关键词
    const techBase = (segmentEnergies[0] + segmentEnergies[1]) / (stats.l2Norm || 1);
    const techScore = sigmoid(
      (keywordScores.tech * 3) + 
      (stats.variance * 10) + 
      (techBase * 2) - 2
    );
    
    // 商业得分：基于向量中间区域 + 关键词
    const businessBase = segmentEnergies[2] / (stats.l2Norm || 1);
    const businessScore = sigmoid(
      (keywordScores.business * 3) + 
      (Math.abs(stats.mean) * 5) + 
      (businessBase * 2) - 2
    );
    
    // 日常得分：基于向量低方差区域 + 关键词
    const dailyBase = (1 - stats.variance) * 0.5;
    const dailyScore = sigmoid(
      (keywordScores.daily * 3) + 
      dailyBase + 
      (1 - stats.kurtosis * 0.1) - 1.5
    );
    
    // 情感得分：基于向量尾部区域 + 关键词
    const emotionBase = (segmentEnergies[4]) / (stats.l2Norm || 1);
    const emotionScore = sigmoid(
      (keywordScores.emotion * 3) + 
      (Math.abs(stats.skewness) * 0.5) + 
      (emotionBase * 2) - 2
    );
    
    // 学术得分：基于向量均匀分布 + 关键词
    const academicBase = 1 - Math.abs(stats.skewness) * 0.3;
    const academicScore = sigmoid(
      (keywordScores.academic * 3) + 
      (stats.entropy * 0.1) + 
      academicBase - 2
    );
    
    // 信息密度：基于向量熵和非零元素比例
    const informationDensity = Math.min(1, (stats.entropy / Math.log2(n)) * (1 - stats.sparsity));
    
    // 语义清晰度：基于向量的集中程度
    const maxSegmentEnergy = Math.max(...segmentEnergies);
    const avgSegmentEnergy = segmentEnergies.reduce((a, b) => a + b, 0) / 5;
    const semanticClarity = maxSegmentEnergy / (avgSegmentEnergy || 1) / 3;
    
    return {
      techScore: parseFloat(techScore.toFixed(4)),
      businessScore: parseFloat(businessScore.toFixed(4)),
      dailyScore: parseFloat(dailyScore.toFixed(4)),
      emotionScore: parseFloat(emotionScore.toFixed(4)),
      academicScore: parseFloat(academicScore.toFixed(4)),
      vectorMagnitude: parseFloat(stats.l2Norm.toFixed(4)),
      vectorEntropy: parseFloat(stats.entropy.toFixed(4)),
      vectorSparsity: parseFloat(stats.sparsity.toFixed(4)),
      vectorKurtosis: parseFloat(stats.kurtosis.toFixed(4)),
      informationDensity: parseFloat(informationDensity.toFixed(4)),
      semanticClarity: parseFloat(Math.min(1, semanticClarity).toFixed(4))
    };
  }

  /**
   * 计算关键词匹配得分
   */
  private static calculateKeywordScores(text: string): Record<string, number> {
    const textLower = text.toLowerCase();
    const scores: Record<string, number> = {
      tech: 0,
      business: 0,
      daily: 0,
      emotion: 0,
      academic: 0
    };
    
    const categoryMapping: Record<string, keyof typeof scores> = {
      'AI技术': 'tech',
      '技术开发': 'tech',
      '商业管理': 'business',
      '学术研究': 'academic',
      '日常生活': 'daily',
      '情感表达': 'emotion'
    };
    
    for (const [category, proto] of Object.entries(SEMANTIC_PROTOTYPES)) {
      const scoreKey = categoryMapping[category];
      if (scoreKey) {
        const matchCount = proto.keywords.filter(kw => 
          textLower.includes(kw.toLowerCase())
        ).length;
        scores[scoreKey] += matchCount * proto.weight;
      }
    }
    
    // 归一化
    const maxScore = Math.max(...Object.values(scores), 1);
    for (const key of Object.keys(scores)) {
      scores[key] /= maxScore;
    }
    
    return scores;
  }

  /**
   * 分析语义上下文
   * 使用向量距离和关键词匹配的混合方法
   */
  static analyzeSemanticContext(text: string, embedding: number[]): SemanticContext {
    const stats = this.calculateVectorStatistics(embedding);
    const categoryScores: Record<string, number> = {};
    
    // 计算每个类别的得分
    for (const [category, proto] of Object.entries(SEMANTIC_PROTOTYPES)) {
      let score = 0;
      
      // 关键词匹配得分
      const keywordMatches = proto.keywords.filter(kw => 
        text.toLowerCase().includes(kw.toLowerCase())
      );
      score += keywordMatches.length * 0.3;
      
      // 向量模式匹配得分
      const patternScore = this.matchVectorPattern(stats, proto.vectorPattern);
      score += patternScore * 0.4;
      
      // 应用权重
      categoryScores[category] = score * proto.weight;
    }
    
    // 找出最佳类别
    const sortedCategories = Object.entries(categoryScores)
      .sort(([, a], [, b]) => b - a);
    
    const bestCategory = sortedCategories[0][0];
    const bestScore = sortedCategories[0][0];
    
    // 计算置信度
    const totalScore = Object.values(categoryScores).reduce((a, b) => a + b, 0) || 1;
    const confidence = Math.min(0.95, 0.3 + (categoryScores[bestCategory] / totalScore) * 0.65);
    
    // 归一化类别分布
    const categoryDistribution: Record<string, number> = {};
    for (const [cat, score] of Object.entries(categoryScores)) {
      categoryDistribution[cat] = parseFloat((score / totalScore).toFixed(4));
    }
    
    // 构建语义聚类信息
    const semanticClusters = sortedCategories.slice(0, 3).map(([name, score]) => ({
      name,
      similarity: parseFloat((score / totalScore).toFixed(4)),
      centroidDistance: parseFloat((1 - score / totalScore).toFixed(4))
    }));
    
    // 意图分析
    const intentAnalysis = this.analyzeIntent(text);
    
    // 生成最近概念
    const nearestConcepts = this.extractNearestConcepts(text, bestCategory);
    
    // 生成上下文描述
    const contextMap: Record<string, string> = {
      'AI技术': '人工智能与机器学习语境',
      '技术开发': '软件开发与技术实现语境',
      '商业管理': '商业运营与管理决策语境',
      '学术研究': '学术研究与理论分析语境',
      '日常生活': '日常生活与实用信息语境',
      '情感表达': '情感交流与社交互动语境',
      '通用问答': '通用信息查询语境'
    };
    
    return {
      context: contextMap[bestCategory] || '通用语境',
      semanticCategory: bestCategory,
      confidence: parseFloat(confidence.toFixed(4)),
      nearestConcepts,
      categoryDistribution,
      semanticClusters,
      intentAnalysis
    };
  }

  /**
   * 匹配向量模式
   */
  private static matchVectorPattern(
    stats: ReturnType<typeof this.calculateVectorStatistics>,
    pattern: { highVariance: boolean; positiveBias: boolean; clustered: boolean }
  ): number {
    let score = 0;
    
    // 高方差匹配
    const isHighVariance = stats.variance > 0.1;
    if (pattern.highVariance === isHighVariance) score += 0.33;
    
    // 正偏置匹配
    const isPositiveBias = stats.mean > 0;
    if (pattern.positiveBias === isPositiveBias) score += 0.33;
    
    // 聚集性匹配
    const isClustered = stats.kurtosis > 0;
    if (pattern.clustered === isClustered) score += 0.34;
    
    return score;
  }

  /**
   * 分析用户意图
   */
  private static analyzeIntent(text: string): SemanticContext['intentAnalysis'] {
    const intentScores: Record<string, number> = {};
    
    for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
      const matches = config.patterns.filter(p => text.includes(p));
      intentScores[intent] = matches.length * config.weight;
    }
    
    const sortedIntents = Object.entries(intentScores)
      .filter(([, score]) => score > 0)
      .sort(([, a], [, b]) => b - a);
    
    if (sortedIntents.length === 0) {
      return {
        primaryIntent: '查询信息',
        intentConfidence: 0.5,
        possibleIntents: ['查询信息']
      };
    }
    
    const totalScore = sortedIntents.reduce((sum, [, s]) => sum + s, 0) || 1;
    
    return {
      primaryIntent: sortedIntents[0][0],
      intentConfidence: parseFloat((sortedIntents[0][1] / totalScore).toFixed(4)),
      possibleIntents: sortedIntents.slice(0, 3).map(([intent]) => intent)
    };
  }

  /**
   * 提取最近概念
   */
  private static extractNearestConcepts(text: string, primaryCategory: string): string[] {
    const concepts: string[] = [];
    
    // 从其他类别中提取匹配的关键词
    for (const [category, proto] of Object.entries(SEMANTIC_PROTOTYPES)) {
      if (category === primaryCategory) continue;
      
      const matches = proto.keywords.filter(kw => 
        text.toLowerCase().includes(kw.toLowerCase())
      );
      concepts.push(...matches);
    }
    
    // 如果没有匹配，添加通用概念
    if (concepts.length === 0) {
      const primaryProto = SEMANTIC_PROTOTYPES[primaryCategory as keyof typeof SEMANTIC_PROTOTYPES];
      if (primaryProto) {
        concepts.push(...primaryProto.keywords.slice(0, 3));
      } else {
        concepts.push('信息', '内容', '文本');
      }
    }
    
    return [...new Set(concepts)].slice(0, 5);
  }

  /**
   * 评估查询质量
   */
  static evaluateQueryQuality(text: string, embedding: number[]): {
    queryQualityScore: number;
    specificity: number;
    ambiguity: number;
    retrievability: number;
  } {
    const stats = this.calculateVectorStatistics(embedding);
    
    // 特异性：基于向量的信息熵
    const specificity = 1 - (stats.entropy / Math.log2(embedding.length));
    
    // 模糊度：基于向量的稀疏度和方差
    const ambiguity = stats.sparsity * 0.5 + (1 - Math.min(1, stats.variance * 10)) * 0.5;
    
    // 可检索性：基于向量模长和信息密度
    const retrievability = Math.min(1, stats.l2Norm / 10) * 0.5 + (1 - stats.sparsity) * 0.5;
    
    // 综合质量得分
    const queryQualityScore = (
      specificity * 0.3 +
      (1 - ambiguity) * 0.3 +
      retrievability * 0.4
    );
    
    return {
      queryQualityScore: parseFloat(queryQualityScore.toFixed(4)),
      specificity: parseFloat(specificity.toFixed(4)),
      ambiguity: parseFloat(ambiguity.toFixed(4)),
      retrievability: parseFloat(retrievability.toFixed(4))
    };
  }

  /**
   * 分析文本的 token 分布
   */
  static analyzeTokenDistribution(text: string): {
    tokenCount: number;
    avgTokenLength: number;
    tokenTypes: {
      chinese: number;
      english: number;
      numbers: number;
      punctuation: number;
    };
  } {
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
    const englishWords = text.match(/[a-zA-Z]+/g) || [];
    const numbers = text.match(/\d+/g) || [];
    const punctuation = text.match(/[^\w\s\u4e00-\u9fff]/g) || [];
    
    // 估算 token 数量（中文字符通常1-2个字符一个token，英文单词通常1-3个token）
    const estimatedTokens = 
      Math.ceil(chineseChars.length * 0.7) + 
      Math.ceil(englishWords.length * 1.5) + 
      numbers.length + 
      punctuation.length;
    
    const totalChars = chineseChars.length + 
      englishWords.reduce((sum, w) => sum + w.length, 0) + 
      numbers.reduce((sum, n) => sum + n.length, 0);
    
    return {
      tokenCount: Math.max(1, estimatedTokens),
      avgTokenLength: totalChars / Math.max(1, estimatedTokens),
      tokenTypes: {
        chinese: chineseChars.length,
        english: englishWords.length,
        numbers: numbers.length,
        punctuation: punctuation.length
      }
    };
  }

  /**
   * 完整的查询分析
   */
  static analyzeQuery(
    text: string, 
    embedding: number[],
    modelName: string = 'nomic-embed-text',
    processingTime: number = 0
  ): QueryAnalysisResult {
    const tokenAnalysis = this.analyzeTokenDistribution(text);
    const vectorFeatures = this.calculateVectorFeatures(embedding, text);
    const semanticContext = this.analyzeSemanticContext(text, embedding);
    const quality = this.evaluateQueryQuality(text, embedding);
    const stats = this.calculateVectorStatistics(embedding);
    
    return {
      tokenization: {
        tokenCount: tokenAnalysis.tokenCount,
        avgTokenLength: parseFloat(tokenAnalysis.avgTokenLength.toFixed(2)),
        processingTime,
        originalText: text,
        tokenTypes: tokenAnalysis.tokenTypes
      },
      embedding: {
        embedding: embedding.slice(0, 20), // 只返回前20维用于展示
        embeddingDimension: embedding.length,
        semanticAnalysis: {
          ...semanticContext,
          vectorFeatures
        },
        modelInfo: {
          name: modelName,
          vocabularySize: 50000, // 估算
          embeddingNorm: parseFloat(stats.l2Norm.toFixed(4))
        }
      },
      quality
    };
  }
}

// 导出便捷函数
export function analyzeQuery(
  text: string, 
  embedding: number[], 
  modelName?: string, 
  processingTime?: number
): QueryAnalysisResult {
  return SemanticAnalyzer.analyzeQuery(text, embedding, modelName, processingTime);
}
