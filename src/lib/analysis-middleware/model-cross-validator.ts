/**
 * 模型对比协调器（Model Cross-Validator）
 * 
 * 针对 @xenova/transformers 支持的模型同时开启多个分析实例
 * 将不同模型的输出通过"字符索引"进行强对齐
 */

import { AutoTokenizer } from '@xenova/transformers';
import { DecisionCaptureEngine } from './decision-capture-engine';
import { DensityCalculator } from './density-calculator';
import type {
  TokenDecisionMetadata,
  SingleModelAnalysis,
  ModelComparisonResult,
  KnowledgeCoverage
} from './types';

// 支持的模型配置
export const SUPPORTED_MODELS = [
  { name: 'Xenova/bert-base-multilingual-cased', type: 'bert' as const, description: '多语言BERT' },
  { name: 'Xenova/xlm-roberta-base', type: 'bert' as const, description: 'XLM-RoBERTa' },
  { name: 'Xenova/bge-small-zh-v1.5', type: 'bge' as const, description: 'BGE中文' },
  { name: 'Xenova/all-MiniLM-L6-v2', type: 'minilm' as const, description: 'MiniLM' },
  { name: 'Xenova/bert-base-uncased', type: 'bert' as const, description: 'BERT英文' },
  { name: 'Xenova/distilbert-base-uncased', type: 'bert' as const, description: 'DistilBERT' },
  { name: 'Xenova/gpt2', type: 'gpt' as const, description: 'GPT-2' },
];

export class ModelCrossValidator {
  private engines: Map<string, DecisionCaptureEngine> = new Map();
  private densityCalculator: DensityCalculator;
  private initializationPromises: Map<string, Promise<void>> = new Map();

  constructor() {
    this.densityCalculator = new DensityCalculator();
  }

  /**
   * 初始化指定模型
   */
  async initializeModel(modelName: string): Promise<DecisionCaptureEngine> {
    if (this.engines.has(modelName)) {
      return this.engines.get(modelName)!;
    }

    // 检查是否正在初始化
    if (this.initializationPromises.has(modelName)) {
      await this.initializationPromises.get(modelName);
      return this.engines.get(modelName)!;
    }

    // 开始初始化
    const initPromise = (async () => {
      console.log(`[ModelCrossValidator] 初始化模型: ${modelName}`);
      const engine = new DecisionCaptureEngine(modelName);
      await engine.initialize();
      this.engines.set(modelName, engine);
    })();

    this.initializationPromises.set(modelName, initPromise);
    await initPromise;
    this.initializationPromises.delete(modelName);

    return this.engines.get(modelName)!;
  }

  /**
   * 对比多个模型的分词效果
   */
  async compareModels(
    text: string,
    modelNames: string[]
  ): Promise<ModelComparisonResult> {
    console.log(`[ModelCrossValidator] 开始对比 ${modelNames.length} 个模型`);

    // 并行初始化所有模型
    await Promise.all(modelNames.map(name => this.initializeModel(name)));

    // 并行执行分析
    const analyses = await Promise.all(
      modelNames.map(async (modelName) => {
        const startTime = Date.now();
        const engine = this.engines.get(modelName)!;
        
        try {
          const { waterfall, tokenDecisions, stabilityMetrics } = await engine.captureDecisions(text);
          
          // 计算知识覆盖率
          const knowledgeCoverage = this.densityCalculator.calculateKnowledgeCoverage(
            text,
            tokenDecisions,
            engine.getVocabSize()
          );

          const modelConfig = SUPPORTED_MODELS.find(m => m.name === modelName);
          
          return {
            modelName,
            modelType: modelConfig?.type || 'other',
            tokens: tokenDecisions,
            embeddings: [], // 嵌入可选
            knowledgeCoverage,
            processingTime: Date.now() - startTime,
            vocabSize: engine.getVocabSize()
          } as SingleModelAnalysis;
        } catch (error) {
          console.error(`[ModelCrossValidator] 模型 ${modelName} 分析失败:`, error);
          return null;
        }
      })
    );

    // 过滤失败的分析
    const validAnalyses = analyses.filter((a): a is SingleModelAnalysis => a !== null);

    // 构建字符级对齐
    const characterAlignment = this.buildCharacterAlignment(text, validAnalyses);

    // 识别差异点
    const differences = this.identifyDifferences(characterAlignment, validAnalyses);

    // 生成推荐
    const recommendation = this.generateRecommendation(validAnalyses, differences);

    return {
      input: text,
      models: validAnalyses,
      characterAlignment,
      differences,
      recommendation
    };
  }

  /**
   * 构建字符级对齐
   * 将不同模型的输出通过字符索引进行强对齐
   */
  private buildCharacterAlignment(
    text: string,
    analyses: SingleModelAnalysis[]
  ): ModelComparisonResult['characterAlignment'] {
    const alignment: ModelComparisonResult['characterAlignment'] = [];

    for (let charIndex = 0; charIndex < text.length; charIndex++) {
      const char = text[charIndex];
      const modelTokens: Record<string, { tokenIndex: number; token: string; tokenId: number }> = {};

      for (const analysis of analyses) {
        // 找到覆盖该字符的 token
        const tokenInfo = this.findTokenAtPosition(analysis.tokens, charIndex);
        if (tokenInfo) {
          modelTokens[analysis.modelName] = tokenInfo;
        }
      }

      alignment.push({ charIndex, char, modelTokens });
    }

    return alignment;
  }

  /**
   * 找到覆盖指定位置的 Token
   */
  private findTokenAtPosition(
    tokens: TokenDecisionMetadata[],
    position: number
  ): { tokenIndex: number; token: string; tokenId: number } | null {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.byteRange.start <= position && token.byteRange.end > position) {
        return {
          tokenIndex: i,
          token: token.token,
          tokenId: token.tokenId
        };
      }
    }
    return null;
  }

  /**
   * 识别模型间的差异点
   */
  private identifyDifferences(
    alignment: ModelComparisonResult['characterAlignment'],
    analyses: SingleModelAnalysis[]
  ): ModelComparisonResult['differences'] {
    const differences: ModelComparisonResult['differences'] = [];
    const processedPositions = new Set<number>();

    for (let i = 0; i < alignment.length; i++) {
      const entry = alignment[i];
      const modelNames = Object.keys(entry.modelTokens);

      if (modelNames.length < 2) continue;
      if (processedPositions.has(i)) continue;

      // 检查是否有分词差异
      const tokens = modelNames.map(name => entry.modelTokens[name]);
      const uniqueTokens = new Set(tokens.map(t => t.token));

      if (uniqueTokens.size > 1) {
        // 找到差异类型
        const type = this.determineDifferenceType(tokens, entry.char);
        const significance = this.calculateSignificance(uniqueTokens.size, modelNames.length);

        // 记录各模型在此位置的 token 序列
        const modelTokenMap: Record<string, string[]> = {};
        for (const name of modelNames) {
          const analysis = analyses.find(a => a.modelName === name);
          if (analysis) {
            const tokenIndex = entry.modelTokens[name].tokenIndex;
            // 获取周围的 token 上下文
            const contextTokens = analysis.tokens
              .slice(Math.max(0, tokenIndex - 1), tokenIndex + 2)
              .map(t => t.token);
            modelTokenMap[name] = contextTokens;
          }
        }

        differences.push({
          position: i,
          type,
          models: modelTokenMap,
          significance
        });

        // 标记已处理的位置（避免重复记录同一个差异区域）
        const maxTokenLength = Math.max(...tokens.map(t => t.token.length));
        for (let j = i; j < Math.min(i + maxTokenLength, alignment.length); j++) {
          processedPositions.add(j);
        }
      }
    }

    return differences;
  }

  /**
   * 确定差异类型
   */
  private determineDifferenceType(
    tokens: Array<{ token: string; tokenId: number }>,
    char: string
  ): ModelComparisonResult['differences'][0]['type'] {
    const lengths = tokens.map(t => t.token.replace(/^##|^▁/g, '').length);
    const hasUnknown = tokens.some(t => 
      t.token.includes('[UNK') || t.token.includes('[0x')
    );

    if (hasUnknown) {
      return 'unknown_handling';
    }

    const maxLen = Math.max(...lengths);
    const minLen = Math.min(...lengths);

    if (maxLen > minLen * 1.5) {
      return maxLen > 2 ? 'merge_difference' : 'split_difference';
    }

    return 'split_difference';
  }

  /**
   * 计算差异的重要性
   */
  private calculateSignificance(
    uniqueCount: number,
    totalModels: number
  ): ModelComparisonResult['differences'][0]['significance'] {
    const ratio = uniqueCount / totalModels;
    if (ratio > 0.7) return 'high';
    if (ratio > 0.4) return 'medium';
    return 'low';
  }

  /**
   * 生成模型推荐
   */
  private generateRecommendation(
    analyses: SingleModelAnalysis[],
    differences: ModelComparisonResult['differences']
  ): ModelComparisonResult['recommendation'] {
    const scores: Record<string, number> = {};

    for (const analysis of analyses) {
      let score = 0;

      // 基于知识覆盖率评分
      score += analysis.knowledgeCoverage.score * 40;

      // 基于 Token 数量评分（越少越好，说明压缩效率高）
      const avgTokenCount = analyses.reduce((sum, a) => sum + a.tokens.length, 0) / analyses.length;
      score += (avgTokenCount / analysis.tokens.length) * 20;

      // 基于处理时间评分
      const avgTime = analyses.reduce((sum, a) => sum + a.processingTime, 0) / analyses.length;
      score += (avgTime / analysis.processingTime) * 10;

      // 基于与其他模型的一致性评分
      const consistencyScore = this.calculateConsistency(analysis.modelName, differences, analyses.length);
      score += consistencyScore * 30;

      scores[analysis.modelName] = score;
    }

    // 找出最佳模型
    const bestModel = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)[0][0];

    const bestAnalysis = analyses.find(a => a.modelName === bestModel)!;
    
    let reason = `综合评分最高 (${scores[bestModel].toFixed(1)})`;
    if (bestAnalysis.knowledgeCoverage.level === 'expert') {
      reason += '，知识覆盖率优秀';
    }
    if (bestAnalysis.tokens.length < analyses.reduce((sum, a) => sum + a.tokens.length, 0) / analyses.length) {
      reason += '，压缩效率较高';
    }

    return { bestModel, reason, scores };
  }

  /**
   * 计算模型一致性得分
   */
  private calculateConsistency(
    modelName: string,
    differences: ModelComparisonResult['differences'],
    totalModels: number
  ): number {
    if (differences.length === 0) return 1;

    // 统计该模型与主流意见的一致程度
    let consistentCount = 0;
    let totalDiffs = 0;

    for (const diff of differences) {
      if (diff.models[modelName]) {
        totalDiffs++;
        // 检查是否与多数模型一致
        const modelTokens = Object.values(diff.models);
        const thisModelToken = diff.models[modelName].join('');
        const sameAsThis = modelTokens.filter(t => t.join('') === thisModelToken).length;
        
        if (sameAsThis > totalModels / 2) {
          consistentCount++;
        }
      }
    }

    return totalDiffs > 0 ? consistentCount / totalDiffs : 1;
  }

  /**
   * 获取支持的模型列表
   */
  getSupportedModels() {
    return SUPPORTED_MODELS;
  }

  /**
   * 清理资源
   */
  cleanup() {
    this.engines.clear();
    this.initializationPromises.clear();
  }
}
