/**
 * 中转分析层（Analysis Middleware）
 * 
 * 核心目标：将原本不可见的"黑盒分词"与"无形向量"转化为可追踪、可量化的结构化日志流
 * 
 * 位于分词器（Tokenizer）、嵌入模型（Embedding Model）与向量数据库（Vector DB）的交汇点
 */

import { v4 as uuidv4 } from 'uuid';
import { DecisionCaptureEngine } from './decision-capture-engine';
import { DensityCalculator, type DensityResult } from './density-calculator';
import { RetrievalAlignmentMapper, type ChunkAnalysis } from './retrieval-mapper';
import { ModelCrossValidator, SUPPORTED_MODELS } from './model-cross-validator';
import type {
  TraceContext,
  TokenDecisionMetadata,
  EmbeddingMapping,
  StabilityMetrics,
  RetrievalContribution,
  KnowledgeCoverage,
  LogicWaterfallData,
  ModelComparisonResult,
  RetrievalPathGraph,
  AnalysisMiddlewareResponse,
  StreamingAnalysisEvent
} from './types';

export class AnalysisMiddleware {
  private decisionEngine: DecisionCaptureEngine;
  private densityCalculator: DensityCalculator;
  private retrievalMapper: RetrievalAlignmentMapper;
  private modelValidator: ModelCrossValidator;
  
  private primaryModel: string;
  private initialized: boolean = false;

  constructor(primaryModel: string = 'Xenova/bert-base-multilingual-cased') {
    this.primaryModel = primaryModel;
    this.decisionEngine = new DecisionCaptureEngine(primaryModel);
    this.densityCalculator = new DensityCalculator();
    this.retrievalMapper = new RetrievalAlignmentMapper();
    this.modelValidator = new ModelCrossValidator();
  }

  /**
   * 初始化中间层
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    console.log('[AnalysisMiddleware] 初始化中...');
    await this.decisionEngine.initialize();
    this.initialized = true;
    console.log('[AnalysisMiddleware] 初始化完成');
  }

  /**
   * 完整分析流程
   * 1. 分词拦截 → 2. 权重注入 → 3. 检索反馈 → 4. 数据归一化
   */
  async analyze(
    text: string,
    options: {
      queryEmbedding?: number[];
      retrievedChunks?: ChunkAnalysis[];
      compareModels?: string[];
      onProgress?: (event: StreamingAnalysisEvent) => void;
    } = {}
  ): Promise<TraceContext> {
    await this.initialize();

    const traceId = uuidv4();
    const startTime = Date.now();
    const warnings: TraceContext['warnings'] = [];

    options.onProgress?.({
      type: 'stage_complete',
      data: { stage: 'initialization', traceId },
      timestamp: Date.now(),
      progress: 0.1
    });

    // ========== Step 1: 分词拦截 ==========
    console.log('[AnalysisMiddleware] Step 1: 分词拦截');
    const { waterfall, tokenDecisions, stabilityMetrics } = 
      await this.decisionEngine.captureDecisions(text);

    options.onProgress?.({
      type: 'stage_complete',
      data: { stage: 'tokenization', tokenCount: tokenDecisions.length },
      timestamp: Date.now(),
      progress: 0.3
    });

    // 检查稳定性警告
    stabilityMetrics.forEach((metric, index) => {
      if (metric.level === 'critical' || metric.level === 'unstable') {
        warnings.push({
          type: 'unstable_decision',
          severity: metric.level === 'critical' ? 'error' : 'warning',
          message: `Token "${tokenDecisions[index].token}" 的分词决策不稳定 (系数: ${metric.coefficient.toFixed(3)})`,
          position: index,
          suggestion: '该位置的分词具有争议性，可能影响语义理解'
        });
      }
    });

    // ========== Step 2: 权重注入 ==========
    console.log('[AnalysisMiddleware] Step 2: 权重注入');
    const densityResult = this.densityCalculator.calculateDensity(text, tokenDecisions);
    
    // 计算 Embedding 映射
    let embeddingMappings: EmbeddingMapping[] = [];
    if (options.queryEmbedding) {
      embeddingMappings = this.densityCalculator.calculateEmbeddingWeights(
        [options.queryEmbedding],
        options.queryEmbedding
      );
    }

    // 计算知识覆盖率
    const knowledgeCoverage = this.densityCalculator.calculateKnowledgeCoverage(
      text,
      tokenDecisions,
      this.decisionEngine.getVocabSize()
    );

    // 检查覆盖率警告
    if (knowledgeCoverage.level === 'unfamiliar' || knowledgeCoverage.level === 'unknown') {
      warnings.push({
        type: 'low_coverage',
        severity: 'warning',
        message: `知识覆盖率较低 (${(knowledgeCoverage.score * 100).toFixed(1)}%)`,
        suggestion: '该领域文本在模型中的熟练程度较低，可能影响检索质量'
      });
    }

    // 检查碎片化警告
    if (densityResult.globalStats.fragmentationIndex > 0.3) {
      warnings.push({
        type: 'high_fragmentation',
        severity: 'warning',
        message: `文本碎片化程度较高 (${(densityResult.globalStats.fragmentationIndex * 100).toFixed(1)}%)`,
        suggestion: '过多低密度词元可能导致语义丢失，建议检查专有名词或特殊词汇'
      });
    }

    options.onProgress?.({
      type: 'stage_complete',
      data: { stage: 'weight_injection', coverage: knowledgeCoverage.score },
      timestamp: Date.now(),
      progress: 0.5
    });

    // ========== Step 3: 检索反馈 ==========
    console.log('[AnalysisMiddleware] Step 3: 检索反馈');
    let retrievalContributions: RetrievalContribution[] = [];
    let retrievalPath: RetrievalPathGraph | undefined;

    if (options.queryEmbedding) {
      retrievalContributions = this.retrievalMapper.calculateRetrievalContributions(
        tokenDecisions,
        options.queryEmbedding
      );
      retrievalContributions = this.retrievalMapper.normalizeAndMarkKeyTokens(retrievalContributions);

      if (options.retrievedChunks && options.retrievedChunks.length > 0) {
        retrievalPath = this.retrievalMapper.buildRetrievalPathGraph(
          traceId,
          tokenDecisions,
          options.queryEmbedding,
          options.retrievedChunks
        );

        // 分析检索质量
        const qualityAnalysis = this.retrievalMapper.analyzeRetrievalQuality(retrievalPath);
        qualityAnalysis.issues.forEach(issue => {
          warnings.push({
            type: 'low_density',
            severity: 'warning',
            message: issue
          });
        });
      }
    }

    options.onProgress?.({
      type: 'stage_complete',
      data: { stage: 'retrieval_feedback' },
      timestamp: Date.now(),
      progress: 0.7
    });

    // ========== Step 4: 多模型对比（可选）==========
    let modelComparison: ModelComparisonResult | undefined;
    if (options.compareModels && options.compareModels.length > 1) {
      console.log('[AnalysisMiddleware] Step 4: 多模型对比');
      modelComparison = await this.modelValidator.compareModels(text, options.compareModels);
      
      options.onProgress?.({
        type: 'stage_complete',
        data: { stage: 'model_comparison', modelsCompared: options.compareModels.length },
        timestamp: Date.now(),
        progress: 0.9
      });
    }

    // ========== Step 5: 数据归一化 ==========
    console.log('[AnalysisMiddleware] Step 5: 数据归一化');
    const totalTime = Date.now() - startTime;

    const traceContext: TraceContext = {
      traceId,
      createdAt: new Date(),
      input: text,
      primaryModel: this.primaryModel,
      
      // 核心数据
      waterfall,
      tokenDecisions,
      embeddingMappings,
      
      // 计算指标
      stabilityMetrics,
      retrievalContributions,
      knowledgeCoverage,
      
      // 可选数据
      modelComparison,
      retrievalPath,
      
      // 元数据
      stats: {
        totalTokens: tokenDecisions.length,
        totalTime,
        compressionRatio: waterfall.compressionRatio,
        avgStability: stabilityMetrics.reduce((sum, m) => sum + m.coefficient, 0) / stabilityMetrics.length,
        avgContribution: retrievalContributions.length > 0
          ? retrievalContributions.reduce((sum, c) => sum + c.normalizedContribution, 0) / retrievalContributions.length
          : 0
      },
      warnings
    };

    options.onProgress?.({
      type: 'analysis_complete',
      data: { traceId, totalTime, warnings: warnings.length },
      timestamp: Date.now(),
      progress: 1.0
    });

    console.log(`[AnalysisMiddleware] 分析完成: ${traceId}, 耗时: ${totalTime}ms`);
    
    return traceContext;
  }

  /**
   * 快速分析（仅分词，不包括检索）
   */
  async quickAnalyze(text: string): Promise<{
    waterfall: LogicWaterfallData;
    tokenDecisions: TokenDecisionMetadata[];
    densityResult: DensityResult;
    knowledgeCoverage: KnowledgeCoverage;
  }> {
    await this.initialize();

    const { waterfall, tokenDecisions } = await this.decisionEngine.captureDecisions(text);
    const densityResult = this.densityCalculator.calculateDensity(text, tokenDecisions);
    const knowledgeCoverage = this.densityCalculator.calculateKnowledgeCoverage(
      text,
      tokenDecisions,
      this.decisionEngine.getVocabSize()
    );

    return { waterfall, tokenDecisions, densityResult, knowledgeCoverage };
  }

  /**
   * 多模型对比分析
   */
  async compareModels(text: string, modelNames: string[]): Promise<ModelComparisonResult> {
    return this.modelValidator.compareModels(text, modelNames);
  }

  /**
   * 获取支持的模型列表
   */
  getSupportedModels() {
    return SUPPORTED_MODELS;
  }

  /**
   * 获取当前主模型
   */
  getPrimaryModel(): string {
    return this.primaryModel;
  }

  /**
   * 设置主模型
   */
  async setPrimaryModel(modelName: string): Promise<void> {
    this.primaryModel = modelName;
    this.decisionEngine = new DecisionCaptureEngine(modelName);
    this.initialized = false;
    await this.initialize();
  }
}

// 导出类型和子模块
export * from './types';
export { DecisionCaptureEngine } from './decision-capture-engine';
export { DensityCalculator } from './density-calculator';
export { RetrievalAlignmentMapper } from './retrieval-mapper';
export { ModelCrossValidator, SUPPORTED_MODELS } from './model-cross-validator';

// 单例实例
let middlewareInstance: AnalysisMiddleware | null = null;

export function getAnalysisMiddleware(primaryModel?: string): AnalysisMiddleware {
  if (!middlewareInstance) {
    middlewareInstance = new AnalysisMiddleware(primaryModel);
  }
  return middlewareInstance;
}

export function resetAnalysisMiddleware(): void {
  middlewareInstance = null;
}
