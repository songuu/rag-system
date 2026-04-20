/**
 * Agent 采访 API
 *
 * POST /api/mirofish/interaction/interview - 采访 Agent
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInteractionAgent } from '@/lib/mirofish/interaction-agent';
import { getSimulationRunner } from '@/lib/mirofish/simulation-runner';
import { validateModelOverride } from '@/lib/mirofish/model-override';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { simulation_id, agent_id, question, batch } = body as {
      simulation_id: string;
      agent_id?: string;
      question: string;
      batch?: boolean;
    };
    const modelOverride = validateModelOverride(body.modelOverride) || undefined;

    if (!simulation_id || !question) {
      return NextResponse.json(
        { success: false, error: '缺少 simulation_id 或 question' },
        { status: 400 }
      );
    }

    const runner = getSimulationRunner();
    const info = runner.get(simulation_id);
    if (!info) {
      return NextResponse.json(
        { success: false, error: '模拟不存在' },
        { status: 404 }
      );
    }

    const interactionAgent = getInteractionAgent(modelOverride);
    const allPosts = runner.getPosts(simulation_id);

    // 批量采访所有 Agent
    if (batch) {
      const responses = await interactionAgent.batchInterview(
        info.agent_profiles,
        question,
        allPosts
      );
      return NextResponse.json({ success: true, responses });
    }

    // 采访单个 Agent
    if (!agent_id) {
      return NextResponse.json(
        { success: false, error: '缺少 agent_id（单个采访时必需）' },
        { status: 400 }
      );
    }

    const profile = info.agent_profiles.find(p => p.entity_id === agent_id);
    if (!profile) {
      return NextResponse.json(
        { success: false, error: 'Agent 不存在' },
        { status: 404 }
      );
    }

    const agentPosts = allPosts.filter(p => p.author_id === agent_id);
    const response = await interactionAgent.interview(profile, question, agentPosts);

    return NextResponse.json({ success: true, response });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '采访失败' },
      { status: 500 }
    );
  }
}
