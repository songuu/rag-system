/**
 * 项目管理 API
 *
 * GET /api/mirofish/project - 获取项目列表
 * POST /api/mirofish/project - 创建项目
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/mirofish/project-store';
import type { CreateProjectRequest } from '@/lib/mirofish/types';

export async function GET() {
  try {
    const store = getProjectStore();
    const projects = store.list();

    return NextResponse.json({ success: true, projects });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '获取项目列表失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateProjectRequest = await request.json();

    if (!body.name?.trim()) {
      return NextResponse.json(
        { success: false, error: '项目名称不能为空' },
        { status: 400 }
      );
    }

    if (!body.simulation_requirement?.trim()) {
      return NextResponse.json(
        { success: false, error: '模拟需求不能为空' },
        { status: 400 }
      );
    }

    const store = getProjectStore();
    const project = store.create(body);

    return NextResponse.json({ success: true, project });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建项目失败' },
      { status: 500 }
    );
  }
}
