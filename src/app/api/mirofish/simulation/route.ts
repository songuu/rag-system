/**
 * 模拟管理 API
 *
 * POST /api/mirofish/simulation - 创建模拟
 * GET /api/mirofish/simulation - 获取模拟列表
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSimulationRunner } from '@/lib/mirofish/simulation-runner';
import type { SimulationConfig, EntityProfile } from '@/lib/mirofish/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { config, profiles } = body as {
      config: SimulationConfig;
      profiles: EntityProfile[];
    };

    if (!config?.project_id) {
      return NextResponse.json(
        { success: false, error: '缺少 project_id' },
        { status: 400 }
      );
    }

    if (!profiles?.length) {
      return NextResponse.json(
        { success: false, error: '至少需要一个 Agent 人设' },
        { status: 400 }
      );
    }

    // 参数限制防止资源耗尽
    const MAX_PROFILES = 50;
    const MAX_ROUNDS = 30;
    const MAX_AGENTS_PER_ROUND = 20;
    const MAX_TOPICS = 20;

    if (profiles.length > MAX_PROFILES) {
      return NextResponse.json(
        { success: false, error: `Agent 人设数量不能超过 ${MAX_PROFILES}` },
        { status: 400 }
      );
    }

    const roundCount = Math.min(Math.max(config.round_count || 10, 1), MAX_ROUNDS);
    const agentsPerRound = Math.min(config.agents_per_round || 5, MAX_AGENTS_PER_ROUND, profiles.length);
    const seedTopics = (config.seed_topics || []).slice(0, MAX_TOPICS);

    const simulationId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const fullConfig: SimulationConfig = {
      simulation_id: simulationId,
      project_id: config.project_id,
      platforms: config.platforms || ['twitter'],
      round_count: roundCount,
      posts_per_round: config.posts_per_round || 5,
      agents_per_round: agentsPerRound,
      temperature: Math.min(Math.max(config.temperature || 0.8, 0), 2),
      seed_topics: seedTopics,
      time_interval: Math.min(Math.max(config.time_interval || 2, 0), 60),
    };

    const runner = getSimulationRunner();
    const info = runner.create(fullConfig, profiles);

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
