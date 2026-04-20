/**
 * MiroFish 人设生成 API
 *
 * POST /api/mirofish/profile - 生成单个人设
 * POST /api/mirofish/profile/batch - 批量生成人设
 */

import { NextRequest, NextResponse } from 'next/server';
import { ProfileGenerator } from '@/lib/mirofish/profile-generator';
import { validateModelOverride } from '@/lib/mirofish/model-override';
import type {
  ProfileGenerateRequest,
  ProfileBatchGenerateRequest,
} from '@/lib/mirofish/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const modelOverride = validateModelOverride(body.modelOverride) || undefined;

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

      const generator = new ProfileGenerator(modelOverride);
      const profiles = await generator.generateProfiles(batchRequest);

      return NextResponse.json({
        success: true,
        profiles,
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

      const generator = new ProfileGenerator(modelOverride);
      const profile = await generator.generateProfile(profileRequest);

      return NextResponse.json({
        success: true,
        profile,
      });
    }
  } catch (error) {
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
