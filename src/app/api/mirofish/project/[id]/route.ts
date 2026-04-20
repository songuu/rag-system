/**
 * 单个项目 API
 *
 * GET /api/mirofish/project/[id] - 获取项目详情
 * PUT /api/mirofish/project/[id] - 更新项目
 * DELETE /api/mirofish/project/[id] - 删除项目
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/mirofish/project-store';
import { validateModelOverride } from '@/lib/mirofish/model-override';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const store = getProjectStore();
    const project = store.get(id);

    if (!project) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, project });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '获取项目失败' },
      { status: 500 }
    );
  }
}

/** 允许更新的字段白名单 */
const ALLOWED_UPDATE_FIELDS = new Set([
  'name', 'description', 'status', 'current_step',
  'simulation_requirement', 'texts', 'ontology',
  'graph_id', 'simulation_id', 'report_id',
  'model_config',
]);

const VALID_STATUSES = new Set([
  'created', 'graph_built', 'env_setup', 'simulating', 'report_generated', 'completed',
]);

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const raw = await request.json();

    // 字段白名单过滤
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (ALLOWED_UPDATE_FIELDS.has(key)) {
        body[key] = value;
      }
    }

    // 验证关键字段
    if (body.name !== undefined && (typeof body.name !== 'string' || (body.name as string).length > 200)) {
      return NextResponse.json({ success: false, error: '项目名称无效' }, { status: 400 });
    }
    if (body.status !== undefined && !VALID_STATUSES.has(body.status as string)) {
      return NextResponse.json({ success: false, error: '状态值无效' }, { status: 400 });
    }
    if (body.current_step !== undefined) {
      const step = body.current_step as number;
      if (typeof step !== 'number' || step < 0 || step > 4 || !Number.isInteger(step)) {
        return NextResponse.json({ success: false, error: 'current_step 必须为 0-4 的整数' }, { status: 400 });
      }
    }
    if (body.model_config !== undefined && body.model_config !== null) {
      const validated = validateModelOverride(body.model_config);
      if (!validated) {
        return NextResponse.json({ success: false, error: 'model_config 格式无效' }, { status: 400 });
      }
      body.model_config = validated;
    }

    const store = getProjectStore();
    const project = store.update(id, body);

    if (!project) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, project });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '更新项目失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const store = getProjectStore();
    const deleted = store.delete(id);

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '删除项目失败' },
      { status: 500 }
    );
  }
}
