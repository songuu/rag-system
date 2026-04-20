/**
 * MiroFish 本体生成 API
 *
 * POST /api/mirofish/ontology
 */

import { NextRequest, NextResponse } from 'next/server';
import { OntologyGenerator } from '@/lib/mirofish/ontology-generator';
import { validateModelOverride } from '@/lib/mirofish/model-override';
import type { OntologyGenerateRequest } from '@/lib/mirofish/types';

export async function POST(request: NextRequest) {
  try {
    const body: OntologyGenerateRequest & { modelOverride?: unknown } = await request.json();

    // 验证必填字段
    if (!body.texts || !body.simulationRequirement) {
      return NextResponse.json(
        {
          success: false,
          error: '缺少必要字段：texts 和 simulationRequirement',
        },
        { status: 400 }
      );
    }

    const modelOverride = validateModelOverride(body.modelOverride) || undefined;
    const generator = new OntologyGenerator(modelOverride);
    const ontology = await generator.generate({
      texts: body.texts,
      simulationRequirement: body.simulationRequirement,
      additionalContext: body.additionalContext,
    });

    return NextResponse.json({
      success: true,
      ontology,
    });
  } catch (error) {
    console.error('[MiroFish Ontology API] 生成失败:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '本体生成失败',
      },
      { status: 500 }
    );
  }
}
