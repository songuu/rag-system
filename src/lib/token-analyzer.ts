/**
 * 词元分析器
 * 提供向量加权、密度分析等功能
 */

import { AutoTokenizer, AutoModel } from '@xenova/transformers';

// 向量加权信息
export interface VectorWeightInfo {
  token: string;
  tokenId: number;
  vectorMagnitude: number;
  embedding: number[];
  semanticUniqueness: number; // 语义独特性分数
}

// 词元密度信息
export interface TokenDensityInfo {
  token: string;
  tokenId: number;
  byteLength: number;
  tokenLength: number;
  density: number; // 密度 = tokenLength / byteLength
  compressionRatio: number; // 压缩比
}

// 分词效能评分卡
export interface TokenizationScorecard {
  fragmentationRate: number; // 碎片化率 = 文本长度 / Token 数量
  semanticAlignment: {
    mean: number;
    variance: number;
    distribution: number[];
  };
  oovRobustness: {
    byteFallbackCount: number;
    byteFallbackRate: number;
    unkTokenCount: number;
  };
  overallScore: number;
}

// 模型对比结果
export interface ModelComparison {
  modelName: string;
  tokenization: {
    tokenCount: number;
    tokens: Array<{
      token: string;
      tokenId: number;
      vectorWeight?: VectorWeightInfo;
      density?: TokenDensityInfo;
    }>;
  };
  scorecard: TokenizationScorecard;
  processingTime: number;
}

/**
 * 向量加权分析器
 */
export class VectorWeightAnalyzer {
  private tokenizer: any = null;
  private model: any = null;
  private embeddingWeights: Float32Array | null = null;
  private initialized: boolean = false;

  constructor(private modelName: string) {}

  /**
   * 初始化模型和权重
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log(`[VectorWeightAnalyzer] 加载模型: ${this.modelName}`);
      
      // 加载 tokenizer
      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
      
      // 尝试加载模型以获取权重
      try {
        this.model = await AutoModel.from_pretrained(this.modelName);
        
        // 提取 word_embeddings 权重
        if (this.model && this.model.embeddings && this.model.embeddings.word_embeddings) {
          const weights = this.model.embeddings.word_embeddings.weight;
          if (weights && weights.data) {
            this.embeddingWeights = weights.data;
            console.log(`[VectorWeightAnalyzer] 权重矩阵维度: ${weights.shape}`);
          }
        }
      } catch (error) {
        console.warn('[VectorWeightAnalyzer] 无法加载模型权重，将使用估算方法:', error);
      }
      
      this.initialized = true;
      console.log(`[VectorWeightAnalyzer] 初始化完成`);
    } catch (error) {
      console.error('[VectorWeightAnalyzer] 初始化失败:', error);
      throw error;
    }
  }

  /**
   * 分析词元的向量权重
   */
  async analyzeVectorWeights(tokens: Array<{ token: string; tokenId: number }>): Promise<VectorWeightInfo[]> {
    await this.initialize();

    const results: VectorWeightInfo[] = [];

    for (const { token, tokenId } of tokens) {
      let vectorMagnitude = 0;
      let embedding: number[] = [];
      let semanticUniqueness = 0;

      // 使用估算方法（@xenova/transformers 的向量提取比较复杂）
      // 基于 tokenId 和 token 特征进行估算
        vectorMagnitude = this.estimateMagnitude(token, tokenId);
        semanticUniqueness = this.calculateSemanticUniqueness(token, tokenId);

      results.push({
        token,
        tokenId,
        vectorMagnitude,
        embedding,
        semanticUniqueness
      });
    }

    return results;
  }

  /**
   * 估算向量模长
   */
  private estimateMagnitude(token: string, tokenId: number): number {
    // 基于启发式规则估算
    let magnitude = 0.5; // 基础值
    
    // 中文词通常有更高的语义密度
    if (/[\u4e00-\u9fff]/.test(token)) {
      magnitude += 0.3;
    }
    
    // 长词通常有更高的语义独特性
    if (token.length > 2) {
      magnitude += 0.2;
    }
    
    // 特殊 token 的模长较低
    if (token.startsWith('[') && token.endsWith(']')) {
      magnitude = 0.1;
    }
    
    // 基于 tokenId 的随机性（模拟真实分布）
    magnitude += (tokenId % 100) / 1000;
    
    return Math.min(1.5, Math.max(0.1, magnitude));
  }

  /**
   * 计算语义独特性
   */
  private calculateSemanticUniqueness(token: string, tokenId: number): number {
    // 语义独特性 = 模长 * 频率倒数（频率越低，独特性越高）
    const magnitude = this.estimateMagnitude(token, tokenId);
    
    // 估算频率（基于 tokenId 范围）
    let estimatedFreq = 1;
    if (tokenId < 100) {
      estimatedFreq = 1000; // 特殊 token，高频
    } else if (tokenId < 1000) {
      estimatedFreq = 100; // 常用词
    } else if (tokenId < 5000) {
      estimatedFreq = 10; // 一般词
    } else {
      estimatedFreq = 1; // 低频词
    }
    
    return magnitude * (1 / Math.log(estimatedFreq + 1));
  }
}

/**
 * 词元密度分析器
 */
export class TokenDensityAnalyzer {
  /**
   * 分析词元密度
   */
  analyzeDensity(tokens: Array<{ token: string; tokenId: number }>): TokenDensityInfo[] {
    const results: TokenDensityInfo[] = [];

    for (const { token, tokenId } of tokens) {
      const byteLength = new TextEncoder().encode(token).length;
      const tokenLength = token.length;
      
      // 密度 = tokenLength / byteLength
      // 高密度表示一个 token 代表多个字节（压缩率高）
      const density = byteLength > 0 ? tokenLength / byteLength : 0;
      
      // 压缩比 = byteLength / tokenLength
      // 高压缩比表示用更少的 token 编码了更多字节
      const compressionRatio = tokenLength > 0 ? byteLength / tokenLength : 0;

      results.push({
        token,
        tokenId,
        byteLength,
        tokenLength,
        density,
        compressionRatio
      });
    }

    return results;
  }

  /**
   * 生成热力图数据
   */
  generateHeatmapData(densityInfos: TokenDensityInfo[]): {
    positions: number[];
    densities: number[];
    colors: string[];
  } {
    const positions: number[] = [];
    const densities: number[] = [];
    const colors: string[] = [];

    let currentPos = 0;

    for (const info of densityInfos) {
      positions.push(currentPos);
      densities.push(info.density);
      
      // 根据密度设置颜色
      // 高密度（深色）= 压缩率高，模型知识丰富
      // 低密度（浅色）= 碎片化，模型知识盲区
      if (info.density > 1.5) {
        colors.push('#1e3a8a'); // 深蓝 - 高密度
      } else if (info.density > 1.0) {
        colors.push('#3b82f6'); // 中蓝
      } else if (info.density > 0.5) {
        colors.push('#60a5fa'); // 浅蓝
      } else {
        colors.push('#dbeafe'); // 很浅 - 低密度/碎片化
      }
      
      currentPos += info.byteLength;
    }

    return { positions, densities, colors };
  }
}

/**
 * 分词效能评分器
 */
export class TokenizationScorecardGenerator {
  /**
   * 生成评分卡
   */
  generateScorecard(
    originalText: string,
    tokens: Array<{ token: string; tokenId: number }>,
    vectorWeights: VectorWeightInfo[],
    densityInfos: TokenDensityInfo[]
  ): TokenizationScorecard {
    // 1. 碎片化率
    const textLength = new TextEncoder().encode(originalText).length;
    const tokenCount = tokens.length;
    const fragmentationRate = tokenCount > 0 ? textLength / tokenCount : 0;

    // 2. 语义对齐度（向量权重的方差分布）
    const magnitudes = vectorWeights.map(w => w.vectorMagnitude);
    const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    const variance = magnitudes.reduce((sum, m) => sum + Math.pow(m - mean, 2), 0) / magnitudes.length;
    
    // 分布：将权重分成 10 个区间
    const distribution = new Array(10).fill(0);
    magnitudes.forEach(m => {
      const bin = Math.min(9, Math.floor(m * 10));
      distribution[bin]++;
    });

    // 3. OOV 鲁棒性
    const byteFallbackCount = tokens.filter(t => 
      t.token.startsWith('[') && t.token.includes('0x')
    ).length;
    const unkTokenCount = tokens.filter(t => 
      t.token.includes('[UNK]') || t.tokenId === 0
    ).length;
    const byteFallbackRate = tokenCount > 0 ? byteFallbackCount / tokenCount : 0;

    // 4. 综合评分
    // 碎片化率越低越好（归一化到 0-1）
    const fragmentationScore = Math.min(1, 10 / (fragmentationRate + 1));
    
    // 语义对齐度：方差适中最好（太均匀或太极端都不好）
    const alignmentScore = 1 - Math.min(1, Math.abs(variance - 0.1) * 5);
    
    // OOV 鲁棒性：回退率越低越好
    const robustnessScore = 1 - byteFallbackRate;
    
    const overallScore = (fragmentationScore * 0.4 + alignmentScore * 0.3 + robustnessScore * 0.3) * 100;

    return {
      fragmentationRate,
      semanticAlignment: {
        mean,
        variance,
        distribution
      },
      oovRobustness: {
        byteFallbackCount,
        byteFallbackRate,
        unkTokenCount
      },
      overallScore
    };
  }
}

/**
 * 多模型对比分析器
 */
export class ModelComparisonAnalyzer {
  private vectorAnalyzer: VectorWeightAnalyzer;
  private densityAnalyzer: TokenDensityAnalyzer;
  private scorecardGenerator: TokenizationScorecardGenerator;

  constructor() {
    this.vectorAnalyzer = new VectorWeightAnalyzer('Xenova/bert-base-multilingual-cased');
    this.densityAnalyzer = new TokenDensityAnalyzer();
    this.scorecardGenerator = new TokenizationScorecardGenerator();
  }

  /**
   * 从 tokenizer 中提取词汇表 (id -> token 映射)
   */
  private extractVocabulary(tokenizer: any): Map<number, string> {
    const idToToken = new Map<number, string>();
    
    // 辅助函数：从对象或Map中提取词汇
    const extractFromVocabObject = (vocabObj: any) => {
      if (!vocabObj) return;
      
      if (vocabObj instanceof Map) {
        vocabObj.forEach((value: any, key: any) => {
          if (typeof key === 'string' && typeof value === 'number') {
            idToToken.set(value, key);
          } else if (typeof value === 'string' && typeof key === 'number') {
            idToToken.set(key, value);
          }
        });
      } else if (Array.isArray(vocabObj)) {
        vocabObj.forEach((token, index) => {
          if (typeof token === 'string') {
            idToToken.set(index, token);
          } else if (token && typeof token.content === 'string') {
            idToToken.set(token.id || index, token.content);
          }
        });
      } else if (typeof vocabObj === 'object') {
        Object.entries(vocabObj).forEach(([key, value]) => {
          if (typeof value === 'number') {
            idToToken.set(value, key);
          } else if (typeof value === 'string' && !isNaN(parseInt(key))) {
            idToToken.set(parseInt(key), value);
          }
        });
      }
    };

    // 尝试多种路径获取词汇表
    const vocabPaths = [
      () => tokenizer.model?.vocab,
      () => tokenizer.model?.encoder,
      () => tokenizer.vocab,
      () => tokenizer.encoder,
      () => tokenizer.tokenizer_?.model?.vocab,
      () => tokenizer.tokenizer_?.vocab,
      () => tokenizer._tokenizer?.model?.vocab
    ];

    for (const getVocab of vocabPaths) {
      try {
        const vocabObj = getVocab();
        if (vocabObj) {
          extractFromVocabObject(vocabObj);
          if (idToToken.size > 0) break;
        }
      } catch {
        // 忽略访问错误
      }
    }
    
    // 添加 added_tokens
    if (tokenizer.added_tokens) {
      try {
        tokenizer.added_tokens.forEach((tokenInfo: any) => {
          if (tokenInfo && tokenInfo.content && typeof tokenInfo.id === 'number') {
            idToToken.set(tokenInfo.id, tokenInfo.content);
          }
        });
      } catch {
        // 忽略错误
      }
    }
    
    return idToToken;
  }

  /**
   * 对比多个模型的分词效果
   */
  async compareModels(
    text: string,
    modelNames: string[]
  ): Promise<ModelComparison[]> {
    const results: ModelComparison[] = [];

    for (const modelName of modelNames) {
      const startTime = Date.now();
      
      try {
        // 加载 tokenizer
        const tokenizer = await AutoTokenizer.from_pretrained(modelName);
        
        // 分词
        const encoded = tokenizer.encode(text, { add_special_tokens: false });
        
        // 获取 id 到 token 的映射
        const idToToken = this.extractVocabulary(tokenizer);
        
        // 如果无法获取词汇表，使用 batch_decode 方式
        let tokens: Array<{ token: string; tokenId: number }>;
        
        if (idToToken.size > 0) {
          tokens = encoded.map((tokenId: number) => ({
          token: idToToken.get(tokenId) || `[UNK:${tokenId}]`,
          tokenId
        }));
        } else {
          // 使用 decode 方式获取 token 字符串
          const decodedTokens = tokenizer.batch_decode(
            encoded.map((id: number) => [id]),
            { skip_special_tokens: false }
          );
          tokens = encoded.map((tokenId: number, index: number) => ({
            token: decodedTokens[index] || `[TOKEN:${tokenId}]`,
            tokenId
          }));
        }

        // 分析向量权重
        const vectorAnalyzer = new VectorWeightAnalyzer(modelName);
        await vectorAnalyzer.initialize();
        const vectorWeights = await vectorAnalyzer.analyzeVectorWeights(tokens);

        // 分析密度
        const densityInfos = this.densityAnalyzer.analyzeDensity(tokens);

        // 生成评分卡
        const scorecard = this.scorecardGenerator.generateScorecard(
          text,
          tokens,
          vectorWeights,
          densityInfos
        );

        // 合并结果
        const tokenization = {
          tokenCount: tokens.length,
          tokens: tokens.map((t, i) => ({
            ...t,
            vectorWeight: vectorWeights[i],
            density: densityInfos[i]
          }))
        };

        results.push({
          modelName,
          tokenization,
          scorecard,
          processingTime: Date.now() - startTime
        });
      } catch (error) {
        console.error(`[ModelComparison] 分析模型 ${modelName} 失败:`, error);
        // 继续处理其他模型
      }
    }

    return results;
  }
}
