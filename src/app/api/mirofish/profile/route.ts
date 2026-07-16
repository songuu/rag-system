/**
 * MiroFish 人设生成 API
 *
 * POST /api/mirofish/profile - 生成单个人设
 * POST /api/mirofish/profile/batch - 批量生成人设
 */

import { NextRequest, NextResponse } from 'next/server';
import { ProfileGenerator } from '@/lib/mirofish/profile-generator';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
} from '@/lib/mirofish/model-override';
import {
  getMiroFishProfileBatchCacheIdentity,
  getMiroFishProfileCacheIdentity,
  loadMiroFishProfileBatchFromCache,
  loadMiroFishProfileFromCache,
  saveMiroFishProfileBatchToCache,
  saveMiroFishProfileToCache,
} from '@/lib/mirofish/artifact-cache';
import type {
  ProfileGenerateRequest,
  ProfileBatchGenerateRequest,
} from '@/lib/mirofish/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const modelOverride = validateHttpModelOverride(body.modelOverride) || undefined;

    // 判断是否为批量请求
    const isBatch = body.entities !== undefined;

    if (isBatch) {
      // 批量生成
      const batchRequest: ProfileBatchGenerateRequest = {
        entities: body.entities,
        simulationContext: body.simulationContext,
        options: body.options,
      };

      // 验证必填字段
      if (!batchRequest.entities || !batchRequest.simulationContext) {
        return NextResponse.json(
          {
            success: false,
            error: '缺少必要字段：entities 和 simulationContext',
          },
          { status: 400 }
        );
      }

      const cacheIdentity = getMiroFishProfileBatchCacheIdentity({
        request: batchRequest,
        modelOverride,
      });
      const cached = await loadMiroFishProfileBatchFromCache(cacheIdentity);
      if (cached) {
        return NextResponse.json({
          success: true,
          profiles: cached.artifact,
          cache_status: 'hit',
        });
      }

      const generator = new ProfileGenerator(modelOverride);
      const profiles = await generator.generateProfiles(batchRequest);
      const stored = await saveMiroFishProfileBatchToCache(cacheIdentity, profiles);

      return NextResponse.json({
        success: true,
        profiles,
        cache_status: stored ? 'stored' : 'miss',
      });
    } else {
      // 单个生成
      const profileRequest: ProfileGenerateRequest = {
        entity: body.entity,
        simulationContext: body.simulationContext,
        options: body.options,
      };

      // 验证必填字段
      if (!profileRequest.entity || !profileRequest.simulationContext) {
        return NextResponse.json(
          {
            success: false,
            error: '缺少必要字段：entity 和 simulationContext',
          },
          { status: 400 }
        );
      }

      const cacheIdentity = getMiroFishProfileCacheIdentity({
        request: profileRequest,
        modelOverride,
      });
      const cached = await loadMiroFishProfileFromCache(cacheIdentity);
      if (cached) {
        return NextResponse.json({
          success: true,
          profile: cached.artifact,
          cache_status: 'hit',
        });
      }

      const generator = new ProfileGenerator(modelOverride);
      const profile = await generator.generateProfile(profileRequest);
      const stored = await saveMiroFishProfileToCache(cacheIdentity, profile);

      return NextResponse.json({
        success: true,
        profile,
        cache_status: stored ? 'stored' : 'miss',
      });
    }
  } catch (error) {
    const modelOverrideError = getHttpModelOverrideErrorResponse(error);
    if (modelOverrideError) {
      return NextResponse.json(modelOverrideError.body, { status: modelOverrideError.status });
    }
    console.error('[MiroFish Profile API] 生成失败:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '人设生成失败',
      },
      { status: 500 }
    );
  }
}
