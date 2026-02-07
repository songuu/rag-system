/**
 * 语义密度计算器（Density & Entropy Calculator）
 * 
 * 实时计算当前 Token 序列的"压缩效率"
 * 输出词元密度热力图数据
 */

import type {
  TokenDecisionMetadata,
  KnowledgeCoverage,
  EmbeddingMapping,
  StaticWeight,
  DynamicImportance
} from './types';

export interface DensityResult {
  /** 每个 Token 的密度信息 */
  tokenDensities: Array<{
    tokenIndex: number;
    token: string;
    tokenId: number;
    /** 字符密度 = tokenLength / charLength */
    charDensity: number;
    /** 字节密度 = tokenLength / byteLength */
    byteDensity: number;
    /** 信息密度（基于熵）*/
    informationDensity: number;
    /** 压缩效率 */
    compressionEfficiency: number;
    /** 热力值 (0-1) */
    heatValue: number;
    /** 是否为高密度区 */
    isHighDensity: boolean;
    /** 是否为低密度区（碎片化）*/
    isLowDensity: boolean;
  }>;
  /** 全局统计 */
  globalStats: {
    avgDensity: number;
    maxDensity: number;
    minDensity: number;
    densityVariance: number;
    totalEntropy: number;
    compressionRatio: number;
    fragmentationIndex: number;
  };
  /** 热力图区间 */
  heatmapRegions: Array<{
    start: number;
    end: number;
    avgHeat: number;
    type: 'hot' | 'warm' | 'neutral' | 'cold';
  }>;
}

export class DensityCalculator {
  /**
   * 计算 Token 序列的密度信息
   */
  calculateDensity(
    text: string,
    tokens: TokenDecisionMetadata[]
  ): DensityResult {
    const tokenDensities = tokens.map((token, index) => {
      const charLength = token.byteRange.charLength || token.token.length;
      const byteLength = token.byteRange.byteLength || new TextEncoder().encode(token.token).length;
      const tokenLength = 1; // 每个 token 计为 1

      // 字符密度：一个 token 代表多少字符
      const charDensity = charLength / tokenLength;
      
      // 字节密度：一个 token 代表多少字节
      const byteDensity = byteLength / tokenLength;
      
      // 信息密度：基于熵贡献
      const entropyContribution = token.semanticEntropy.entropyContribution;
      const informationDensity = entropyContribution / Math.max(1, byteLength);
      
      // 压缩效率：实际 token 数与最大可能 token 数的比值
      const maxPossibleTokens = byteLength; // 最坏情况：每字节一个 token
      const compressionEfficiency = 1 - (tokenLength / maxPossibleTokens);

      // 热力值计算
      const heatValue = this.calculateHeatValue(charDensity, byteDensity, informationDensity);

      return {
        tokenIndex: index,
        token: token.token,
        tokenId: token.tokenId,
        charDensity,
        byteDensity,
        informationDensity,
        compressionEfficiency,
        heatValue,
        isHighDensity: heatValue > 0.7,
        isLowDensity: heatValue < 0.3
      };
    });

    // 计算全局统计
    const densities = tokenDensities.map(t => t.charDensity);
    const avgDensity = densities.reduce((a, b) => a + b, 0) / densities.length;
    const maxDensity = Math.max(...densities);
    const minDensity = Math.min(...densities);
    const densityVariance = densities.reduce((sum, d) => sum + Math.pow(d - avgDensity, 2), 0) / densities.length;
    const totalEntropy = tokens.reduce((sum, t) => sum + t.semanticEntropy.entropyContribution, 0);
    const compressionRatio = text.length / tokens.length;
    
    // 碎片化指数：低密度 token 的比例
    const fragmentationIndex = tokenDensities.filter(t => t.isLowDensity).length / tokenDensities.length;

    // 生成热力图区间
    const heatmapRegions = this.generateHeatmapRegions(tokenDensities);

    return {
      tokenDensities,
      globalStats: {
        avgDensity,
        maxDensity,
        minDensity,
        densityVariance,
        totalEntropy,
        compressionRatio,
        fragmentationIndex
      },
      heatmapRegions
    };
  }

  /**
   * 计算知识覆盖率
   */
  calculateKnowledgeCoverage(
    text: string,
    tokens: TokenDecisionMetadata[],
    vocabSize: number
  ): KnowledgeCoverage {
    // 统计已知词元
    const knownTokens = tokens.filter(t => 
      !t.token.startsWith('[UNK') && 
      !t.token.startsWith('[0x') &&
      t.decisionType !== 'fallback'
    );
    const knownTokenRatio = knownTokens.length / tokens.length;

    // 计算字节回退比例
    const fallbackTokens = tokens.filter(t => 
      t.decisionType === 'fallback' || 
      t.token.startsWith('[0x')
    );
    const fallbackRatio = fallbackTokens.length / tokens.length;

    // 计算平均 Token 频率
    const avgTokenFrequency = tokens.reduce((sum, t) => 
      sum + t.semanticEntropy.frequency, 0
    ) / tokens.length;

    // 领域识别
    const domainRecognition = this.recognizeDomain(text, tokens);

    // 计算总体覆盖率得分
    const score = this.calculateCoverageScore(
      knownTokenRatio,
      fallbackRatio,
      avgTokenFrequency,
      domainRecognition.confidence
    );

    // 确定覆盖级别
    const level = this.determineCoverageLevel(score);

    return {
      score,
      knownTokenRatio,
      fallbackRatio,
      avgTokenFrequency,
      domainRecognition,
      level
    };
  }

  /**
   * 计算 Embedding 映射的权重
   */
  calculateEmbeddingWeights(
    embeddings: number[][],
    queryEmbedding?: number[]
  ): EmbeddingMapping[] {
    return embeddings.map((embedding, index) => {
      const staticWeight = this.calculateStaticWeight(embedding);
      const dynamicImportance = queryEmbedding 
        ? this.calculateDynamicImportance(embedding, queryEmbedding)
        : this.getDefaultDynamicImportance();

      return {
        tokenId: index,
        embedding: embedding.slice(0, 20), // 只保留前20维用于展示
        dimension: embedding.length,
        staticWeight,
        dynamicImportance
      };
    });
  }

  /**
   * 计算静态权重
   */
  private calculateStaticWeight(embedding: number[]): StaticWeight {
    const l2Norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    const l1Norm = embedding.reduce((sum, v) => sum + Math.abs(v), 0);
    const maxAbsValue = Math.max(...embedding.map(Math.abs));
    const mean = embedding.reduce((a, b) => a + b, 0) / embedding.length;
    const variance = embedding.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / embedding.length;
    const nonZeroCount = embedding.filter(v => Math.abs(v) > 1e-6).length;
    const sparsity = 1 - (nonZeroCount / embedding.length);

    return { l2Norm, l1Norm, maxAbsValue, mean, variance, sparsity };
  }

  /**
   * 计算动态重要性
   */
  private calculateDynamicImportance(
    tokenEmbedding: number[],
    queryEmbedding: number[]
  ): DynamicImportance {
    // 余弦相似度
    const dotProduct = tokenEmbedding.reduce((sum, v, i) => sum + v * queryEmbedding[i], 0);
    const tokenNorm = Math.sqrt(tokenEmbedding.reduce((sum, v) => sum + v * v, 0));
    const queryNorm = Math.sqrt(queryEmbedding.reduce((sum, v) => sum + v * v, 0));
    const queryCosineSimilarity = dotProduct / (tokenNorm * queryNorm + 1e-8);

    // 上下文相关性
    const contextRelevance = Math.abs(queryCosineSimilarity);

    // 语义贡献度 = 相似度 * 向量模长
    const semanticContribution = queryCosineSimilarity * tokenNorm;

    return {
      contextRelevance,
      queryCosineSimilarity,
      semanticContribution
    };
  }

  /**
   * 默认动态重要性
   */
  private getDefaultDynamicImportance(): DynamicImportance {
    return {
      contextRelevance: 0.5,
      semanticContribution: 0.5
    };
  }

  /**
   * 计算热力值
   */
  private calculateHeatValue(
    charDensity: number,
    byteDensity: number,
    informationDensity: number
  ): number {
    // 综合三个密度指标，归一化到 0-1
    const normalizedCharDensity = Math.min(1, charDensity / 10);
    const normalizedByteDensity = Math.min(1, byteDensity / 10);
    const normalizedInfoDensity = Math.min(1, informationDensity / 2);

    // 加权平均
    return (
      normalizedCharDensity * 0.4 +
      normalizedByteDensity * 0.3 +
      normalizedInfoDensity * 0.3
    );
  }

  /**
   * 生成热力图区间
   */
  private generateHeatmapRegions(
    tokenDensities: DensityResult['tokenDensities']
  ): DensityResult['heatmapRegions'] {
    const regions: DensityResult['heatmapRegions'] = [];
    let currentRegion: {
      start: number;
      end: number;
      heats: number[];
      type: 'hot' | 'warm' | 'neutral' | 'cold';
    } | null = null;

    tokenDensities.forEach((token, index) => {
      const type = this.getHeatType(token.heatValue);
      
      if (!currentRegion || currentRegion.type !== type) {
        if (currentRegion) {
          regions.push({
            start: currentRegion.start,
            end: currentRegion.end,
            avgHeat: currentRegion.heats.reduce((a, b) => a + b, 0) / currentRegion.heats.length,
            type: currentRegion.type
          });
        }
        currentRegion = {
          start: index,
          end: index,
          heats: [token.heatValue],
          type
        };
      } else {
        currentRegion.end = index;
        currentRegion.heats.push(token.heatValue);
      }
    });

    if (currentRegion) {
      regions.push({
        start: currentRegion.start,
        end: currentRegion.end,
        avgHeat: currentRegion.heats.reduce((a, b) => a + b, 0) / currentRegion.heats.length,
        type: currentRegion.type
      });
    }

    return regions;
  }

  /**
   * 获取热力类型
   */
  private getHeatType(heatValue: number): 'hot' | 'warm' | 'neutral' | 'cold' {
    if (heatValue >= 0.75) return 'hot';
    if (heatValue >= 0.5) return 'warm';
    if (heatValue >= 0.25) return 'neutral';
    return 'cold';
  }

  /**
   * 识别领域
   */
  private recognizeDomain(
    text: string,
    tokens: TokenDecisionMetadata[]
  ): { domain: string; confidence: number } {
    const domains = [
      { name: 'AI/机器学习', keywords: ['ai', '人工智能', '机器学习', '深度学习', '神经网络', '模型', '训练'] },
      { name: '技术开发', keywords: ['代码', '编程', '软件', '开发', '系统', '接口', 'api'] },
      { name: '商业金融', keywords: ['商业', '金融', '投资', '市场', '销售', '客户', '收入'] },
      { name: '医疗健康', keywords: ['医疗', '健康', '疾病', '治疗', '药物', '医生'] },
      { name: '通用', keywords: [] }
    ];

    const textLower = text.toLowerCase();
    let bestDomain = domains[domains.length - 1];
    let maxScore = 0;

    for (const domain of domains) {
      const score = domain.keywords.filter(kw => textLower.includes(kw)).length;
      if (score > maxScore) {
        maxScore = score;
        bestDomain = domain;
      }
    }

    const confidence = Math.min(0.95, 0.3 + maxScore * 0.15);

    return { domain: bestDomain.name, confidence };
  }

  /**
   * 计算覆盖率得分
   */
  private calculateCoverageScore(
    knownTokenRatio: number,
    fallbackRatio: number,
    avgTokenFrequency: number,
    domainConfidence: number
  ): number {
    return (
      knownTokenRatio * 0.4 +
      (1 - fallbackRatio) * 0.3 +
      Math.min(1, avgTokenFrequency * 100) * 0.15 +
      domainConfidence * 0.15
    );
  }

  /**
   * 确定覆盖级别
   */
  private determineCoverageLevel(score: number): KnowledgeCoverage['level'] {
    if (score >= 0.9) return 'expert';
    if (score >= 0.75) return 'familiar';
    if (score >= 0.5) return 'basic';
    if (score >= 0.25) return 'unfamiliar';
    return 'unknown';
  }
}
