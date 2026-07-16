/**
 * MiroFish 本体生成 API
 *
 * POST /api/mirofish/ontology
 */

import { NextRequest, NextResponse } from 'next/server';
import { OntologyGenerator } from '@/lib/mirofish/ontology-generator';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
} from '@/lib/mirofish/model-override';
import {
  getMiroFishOntologyCacheIdentity,
  loadMiroFishOntologyFromCache,
  saveMiroFishOntologyToCache,
} from '@/lib/mirofish/artifact-cache';
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

    const modelOverride = validateHttpModelOverride(body.modelOverride) || undefined;
    const cacheIdentity = getMiroFishOntologyCacheIdentity({
      request: {
        texts: body.texts,
        simulationRequirement: body.simulationRequirement,
        additionalContext: body.additionalContext,
      },
      modelOverride,
    });
    const cached = await loadMiroFishOntologyFromCache(cacheIdentity);
    if (cached) {
      return NextResponse.json({
        success: true,
        ontology: cached.artifact,
        cache_status: 'hit',
      });
    }

    const generator = new OntologyGenerator(modelOverride);
    const ontology = await generator.generate({
      texts: body.texts,
      simulationRequirement: body.simulationRequirement,
      additionalContext: body.additionalContext,
    });
    const stored = await saveMiroFishOntologyToCache(cacheIdentity, ontology);

    return NextResponse.json({
      success: true,
      ontology,
      cache_status: stored ? 'stored' : 'miss',
    });
  } catch (error) {
    const modelOverrideError = getHttpModelOverrideErrorResponse(error);
    if (modelOverrideError) {
      return NextResponse.json(modelOverrideError.body, { status: modelOverrideError.status });
    }
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
