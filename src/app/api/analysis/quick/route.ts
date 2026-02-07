/**
 * 快速分析 API
 * 
 * POST /api/analysis/quick - 快速分词分析（不包括检索）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAnalysisMiddleware } from '@/lib/analysis-middleware';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, primaryModel = 'Xenova/bert-base-multilingual-cased' } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { success: false, error: '请提供有效的文本' },
        { status: 400 }
      );
    }

    console.log(`[Quick Analysis API] 开始快速分析: "${text.slice(0, 50)}..."`);
    const startTime = Date.now();

    const middleware = getAnalysisMiddleware(primaryModel);
    const result = await middleware.quickAnalyze(text);

    const totalTime = Date.now() - startTime;
    console.log(`[Quick Analysis API] 分析完成, 耗时: ${totalTime}ms`);

    return NextResponse.json({
      success: true,
      data: {
        // 瀑布流数据
        waterfall: {
          stages: result.waterfall.stages.map(stage => ({
            level: stage.level,
            tokenCount: stage.tokens.length,
            processingTime: stage.processingTime,
            entropy: stage.entropy,
            tokens: stage.tokens.map(t => ({
              token: t.token,
              tokenId: t.tokenId,
              decisionType: t.decisionType,
              confidence: t.confidence,
              byteRange: t.byteRange,
              semanticEntropy: t.semanticEntropy
            })),
            mergeOperations: stage.mergeOperations
          })),
          totalTime: result.waterfall.totalTime,
          finalTokenCount: result.waterfall.finalTokenCount,
          compressionRatio: result.waterfall.compressionRatio
        },
        
        // 密度结果
        densityResult: {
          tokenDensities: result.densityResult.tokenDensities,
          globalStats: result.densityResult.globalStats,
          heatmapRegions: result.densityResult.heatmapRegions
        },
        
        // 知识覆盖率
        knowledgeCoverage: result.knowledgeCoverage,
        
        // Token 决策
        tokenDecisions: result.tokenDecisions.map(t => ({
          token: t.token,
          tokenId: t.tokenId,
          decisionType: t.decisionType,
          confidence: t.confidence,
          semanticEntropy: t.semanticEntropy,
          byteRange: t.byteRange,
          pathLogic: t.pathLogic
        }))
      },
      processingTime: totalTime
    });

  } catch (error) {
    console.error('[Quick Analysis API] 分析错误:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '分析时发生错误'
      },
      { status: 500 }
    );
  }
}
