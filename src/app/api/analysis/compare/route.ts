/**
 * 多模型对比 API
 * 
 * POST /api/analysis/compare - 对比多个分词模型的效果
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAnalysisMiddleware } from '@/lib/analysis-middleware';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, modelNames } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { success: false, error: '请提供有效的文本' },
        { status: 400 }
      );
    }

    if (!modelNames || !Array.isArray(modelNames) || modelNames.length < 2) {
      return NextResponse.json(
        { success: false, error: '请提供至少 2 个模型进行对比' },
        { status: 400 }
      );
    }

    console.log(`[Compare API] 开始对比 ${modelNames.length} 个模型`);
    const startTime = Date.now();

    const middleware = getAnalysisMiddleware();
    const comparison = await middleware.compareModels(text, modelNames);

    const totalTime = Date.now() - startTime;
    console.log(`[Compare API] 对比完成, 耗时: ${totalTime}ms`);

    return NextResponse.json({
      success: true,
      data: {
        input: comparison.input,
        
        // 各模型分析结果
        models: comparison.models.map(m => ({
          modelName: m.modelName,
          modelType: m.modelType,
          tokenCount: m.tokens.length,
          tokens: m.tokens.map(t => ({
            token: t.token,
            tokenId: t.tokenId,
            decisionType: t.decisionType,
            confidence: t.confidence,
            byteRange: t.byteRange
          })),
          knowledgeCoverage: m.knowledgeCoverage,
          processingTime: m.processingTime,
          vocabSize: m.vocabSize
        })),
        
        // 字符级对齐
        characterAlignment: comparison.characterAlignment.slice(0, 200), // 限制数量
        
        // 差异点
        differences: comparison.differences,
        
        // 推荐
        recommendation: comparison.recommendation
      },
      processingTime: totalTime
    });

  } catch (error) {
    console.error('[Compare API] 对比错误:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '对比时发生错误'
      },
      { status: 500 }
    );
  }
}
