/**
 * 中转分析层 API
 * 
 * POST /api/analysis - 执行完整的分词分析
 * POST /api/analysis/quick - 快速分析（仅分词）
 * POST /api/analysis/compare - 多模型对比
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAnalysisMiddleware } from '@/lib/analysis-middleware';

/**
 * POST /api/analysis
 * 执行完整的分词分析流程
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      text, 
      queryEmbedding,
      retrievedChunks,
      compareModels,
      primaryModel = 'Xenova/bert-base-multilingual-cased'
    } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { success: false, error: '请提供有效的文本' },
        { status: 400 }
      );
    }

    console.log(`[Analysis API] 开始分析文本: "${text.slice(0, 50)}..."`);
    const startTime = Date.now();

    // 获取中间层实例
    const middleware = getAnalysisMiddleware(primaryModel);

    // 执行完整分析
    const traceContext = await middleware.analyze(text, {
      queryEmbedding,
      retrievedChunks,
      compareModels
    });

    const totalTime = Date.now() - startTime;
    console.log(`[Analysis API] 分析完成, 耗时: ${totalTime}ms`);

    return NextResponse.json({
      success: true,
      data: {
        traceId: traceContext.traceId,
        input: traceContext.input,
        primaryModel: traceContext.primaryModel,
        
        // 瀑布流数据
        waterfall: {
          stages: traceContext.waterfall.stages.map(stage => ({
            level: stage.level,
            tokenCount: stage.tokens.length,
            processingTime: stage.processingTime,
            entropy: stage.entropy,
            tokens: stage.tokens.slice(0, 50).map(t => ({
              token: t.token,
              tokenId: t.tokenId,
              decisionType: t.decisionType,
              confidence: t.confidence,
              byteRange: t.byteRange
            })),
            mergeOperations: stage.mergeOperations.slice(0, 20)
          })),
          totalTime: traceContext.waterfall.totalTime,
          finalTokenCount: traceContext.waterfall.finalTokenCount,
          compressionRatio: traceContext.waterfall.compressionRatio
        },
        
        // Token 决策列表
        tokenDecisions: traceContext.tokenDecisions.map(t => ({
          token: t.token,
          tokenId: t.tokenId,
          decisionType: t.decisionType,
          confidence: t.confidence,
          semanticEntropy: t.semanticEntropy,
          byteRange: t.byteRange
        })),
        
        // 稳定性指标
        stabilityMetrics: traceContext.stabilityMetrics,
        
        // 检索贡献度
        retrievalContributions: traceContext.retrievalContributions,
        
        // 知识覆盖率
        knowledgeCoverage: traceContext.knowledgeCoverage,
        
        // 模型对比（如果有）
        modelComparison: traceContext.modelComparison ? {
          models: traceContext.modelComparison.models.map(m => ({
            modelName: m.modelName,
            modelType: m.modelType,
            tokenCount: m.tokens.length,
            knowledgeCoverage: m.knowledgeCoverage,
            processingTime: m.processingTime
          })),
          differences: traceContext.modelComparison.differences,
          recommendation: traceContext.modelComparison.recommendation
        } : null,
        
        // 检索路径（如果有）
        retrievalPath: traceContext.retrievalPath ? {
          queryId: traceContext.retrievalPath.queryId,
          keyMatchPaths: traceContext.retrievalPath.keyMatchPaths,
          similarityMatrix: traceContext.retrievalPath.similarityMatrix.slice(0, 50)
        } : null,
        
        // 统计信息
        stats: traceContext.stats,
        
        // 警告
        warnings: traceContext.warnings
      },
      processingTime: totalTime
    });

  } catch (error) {
    console.error('[Analysis API] 分析错误:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '分析时发生错误'
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/analysis
 * 获取支持的模型列表
 */
export async function GET() {
  try {
    const middleware = getAnalysisMiddleware();
    const supportedModels = middleware.getSupportedModels();
    
    return NextResponse.json({
      success: true,
      data: {
        supportedModels,
        primaryModel: middleware.getPrimaryModel()
      }
    });
  } catch (error) {
    console.error('[Analysis API] 获取模型列表错误:', error);
    return NextResponse.json(
      { success: false, error: '获取模型列表失败' },
      { status: 500 }
    );
  }
}
