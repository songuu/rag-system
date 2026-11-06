/**
 * 项目管理 API
 *
 * GET /api/mirofish/project - 获取项目列表
 * POST /api/mirofish/project - 创建项目
 */

import { NextRequest, NextResponse } from 'next/server';
import { createPublicProjectProjection } from '@/lib/mirofish/model-override';
import { getScopedMiroFishProjectStore, resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { miroFishProjectApiError } from '@/lib/mirofish/project-api-response';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';
import type { CreateProjectRequest } from '@/lib/mirofish/types';

export async function GET(request: NextRequest) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request);
    const store = getScopedMiroFishProjectStore(scope);
    const projects = (await store.list()).map(createPublicProjectProjection);

    return NextResponse.json({ success: true, projects });
  } catch (error) {
    return miroFishProjectApiError(error, '获取项目列表失败');
  }
}

export async function POST(request: NextRequest) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request, 'ingest');
    const raw = await readJsonObjectWithLimit(request, 64 * 1024);
    const body = raw as unknown as CreateProjectRequest;

    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) {
      return NextResponse.json(
        { success: false, error: '项目名称不能为空' },
        { status: 400 }
      );
    }

    if (typeof body.simulation_requirement !== 'string' || !body.simulation_requirement.trim() || body.simulation_requirement.length > 50_000
      || (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 5000))) {
      return NextResponse.json(
        { success: false, error: '模拟需求不能为空' },
        { status: 400 }
      );
    }

    const store = getScopedMiroFishProjectStore(scope);
    const project = await store.create(body);

    return NextResponse.json({ success: true, project: createPublicProjectProjection(project) });
  } catch (error) {
    return miroFishProjectApiError(error, '创建项目失败');
  }
}
