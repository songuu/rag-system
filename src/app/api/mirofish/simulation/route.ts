/**
 * 模拟管理 API
 *
 * POST /api/mirofish/simulation - 创建模拟
 * GET /api/mirofish/simulation - 获取模拟列表
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildSimulationConfig } from '@/lib/mirofish/config-normalizer';
import { getProjectStore } from '@/lib/mirofish/project-store';
import { getSimulationRunner } from '@/lib/mirofish/simulation-runner';
import { validateModelOverride } from '@/lib/mirofish/model-override';
import type { EntityProfile, SimulationConfigDraft } from '@/lib/mirofish/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { config, profiles, prepare_id, project_id } = body as {
      config?: SimulationConfigDraft & { project_id?: string };
      profiles?: EntityProfile[];
      prepare_id?: string;
      project_id?: string;
    };
    const modelOverride = validateModelOverride(body.modelOverride) || undefined;

    const projectId = config?.project_id || project_id;
    if (!projectId) {
      return NextResponse.json(
        { success: false, error: '缺少 project_id' },
        { status: 400 }
      );
    }

    const project = getProjectStore().get(projectId);
    if (prepare_id && project?.prepare_id !== prepare_id) {
      return NextResponse.json(
        { success: false, error: 'prepare_id 无效或已过期' },
        { status: 400 }
      );
    }

    const preparedProfiles = prepare_id ? project?.agent_profiles : undefined;
    const preparedConfig = prepare_id ? project?.simulation_config : undefined;
    const effectiveProfiles = preparedProfiles?.length ? preparedProfiles : profiles;
    const effectiveConfig = preparedConfig ?? config;

    if (!effectiveProfiles?.length) {
      return NextResponse.json(
        { success: false, error: '至少需要一个 Agent 人设' },
        { status: 400 }
      );
    }

    // 参数限制防止资源耗尽
    const MAX_PROFILES = 50;

    if (effectiveProfiles.length > MAX_PROFILES) {
      return NextResponse.json(
        { success: false, error: `Agent 人设数量不能超过 ${MAX_PROFILES}` },
        { status: 400 }
      );
    }

    const simulationId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const fullConfig = buildSimulationConfig(effectiveConfig, {
      projectId,
      simulationId,
      profileCount: effectiveProfiles.length,
    });

    const runner = getSimulationRunner();
    const info = runner.create(fullConfig, effectiveProfiles, modelOverride);

    return NextResponse.json({ success: true, simulation: info });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建模拟失败' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const runner = getSimulationRunner();
    const simulations = runner.list();

    return NextResponse.json({ success: true, simulations });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '获取模拟列表失败' },
      { status: 500 }
    );
  }
}
