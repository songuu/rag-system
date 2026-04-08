/**
 * 单个模拟 API
 *
 * GET /api/mirofish/simulation/[id] - 获取模拟详情
 * POST /api/mirofish/simulation/[id] - 控制模拟 (start/stop)
 * DELETE /api/mirofish/simulation/[id] - 删除模拟
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSimulationRunner } from '@/lib/mirofish/simulation-runner';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    const runner = getSimulationRunner();

    // 获取帖子列表
    if (action === 'posts') {
      const platform = searchParams.get('platform') || undefined;
      const limit = parseInt(searchParams.get('limit') || '50');
      const posts = runner.getPosts(id, platform, limit);
      return NextResponse.json({ success: true, posts });
    }

    // 获取时间线
    if (action === 'timeline') {
      const timeline = runner.getTimeline(id);
      return NextResponse.json({ success: true, timeline });
    }

    // 获取 Agent 统计
    if (action === 'agent-stats') {
      const stats = runner.getAgentStats(id);
      return NextResponse.json({ success: true, stats });
    }

    // 默认返回模拟详情
    const info = runner.get(id);
    if (!info) {
      return NextResponse.json(
        { success: false, error: '模拟不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, simulation: info });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '获取模拟信息失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { action } = body as { action: 'start' | 'stop' };
    const runner = getSimulationRunner();

    if (action === 'start') {
      // 非阻塞启动（错误由 simulation-runner 内部处理状态转换）
      runner.start(id).catch(() => {
        // 运行错误已在 runner 内部处理，状态会标记为 failed
      });
      return NextResponse.json({ success: true, message: '模拟已启动' });
    }

    if (action === 'stop') {
      runner.stop(id);
      return NextResponse.json({ success: true, message: '模拟已停止' });
    }

    return NextResponse.json(
      { success: false, error: '未知操作，支持: start, stop' },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '操作失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const runner = getSimulationRunner();
    runner.delete(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '删除模拟失败' },
      { status: 500 }
    );
  }
}
