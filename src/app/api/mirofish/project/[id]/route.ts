/**
 * 单个项目 API
 *
 * GET /api/mirofish/project/[id] - 获取项目详情
 * PUT /api/mirofish/project/[id] - 更新项目
 * DELETE /api/mirofish/project/[id] - 删除项目
 */

import { NextRequest, NextResponse } from 'next/server';
import { getScopedMiroFishProjectStore, resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { miroFishProjectApiError } from '@/lib/mirofish/project-api-response';
import { assertMiroFishProjectIdle, withMiroFishProjectLock } from '@/lib/mirofish/project-lifecycle';
import { getTaskManager } from '@/lib/mirofish/task-manager';
import { readStandaloneGraphTask } from '@/lib/mirofish/standalone-graph-runtime';
import { readJsonObjectWithLimit, RequestValidationError } from '@/lib/security/request-validation';
import { MIROFISH_SEED_MAX_TOTAL_BYTES, MIROFISH_SEED_MAX_FILES } from '@/lib/mirofish/seed-file-contract';
import {
  createPublicProjectProjection,
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
} from '@/lib/mirofish/model-override';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { scope } = await resolveMiroFishRequestScope(_request);
    const store = getScopedMiroFishProjectStore(scope);
    const project = await store.get(id);

    if (!project) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, project: createPublicProjectProjection(project) });
  } catch (error) {
    return miroFishProjectApiError(error, '获取项目失败');
  }
}

/** 允许更新的字段白名单 */
const ALLOWED_UPDATE_FIELDS = new Set([
  'name', 'description', 'status', 'current_step',
  'simulation_requirement', 'texts', 'ontology',
  'graph_data', 'graph_id', 'graph_task_id', 'graph_identity', 'agent_profiles', 'seed_files',
  'simulation_config', 'prepare_id', 'prepare_fingerprint',
  'prepared_at', 'simulation_id', 'report_id',
  'model_config', 'prepare_task_id', 'selected_entity_ids',
]);

const VALID_STATUSES = new Set([
  'created', 'graph_built', 'env_setup', 'simulating', 'report_generated', 'completed',
]);

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { scope } = await resolveMiroFishRequestScope(request, 'ingest');
    const raw = await readJsonObjectWithLimit(request, 16 * 1024 * 1024);

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
      const validated = validateHttpModelOverride(body.model_config);
      if (!validated) {
        return NextResponse.json({ success: false, error: 'model_config 格式无效' }, { status: 400 });
      }
      body.model_config = validated;
    }
    if (body.graph_task_id !== undefined && body.graph_task_id !== null
      && (typeof body.graph_task_id !== 'string' || !/^task_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.graph_task_id))) {
      return NextResponse.json({ success: false, error: '图谱任务 ID 无效' }, { status: 400 });
    }
    if (body.prepare_task_id !== undefined && body.prepare_task_id !== null
      && (typeof body.prepare_task_id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(body.prepare_task_id) || body.prepare_task_id === '.' || body.prepare_task_id === '..')) {
      return NextResponse.json({ success: false, error: '准备任务 ID 无效' }, { status: 400 });
    }
    if (body.selected_entity_ids !== undefined && (!Array.isArray(body.selected_entity_ids) || body.selected_entity_ids.length > 500
      || body.selected_entity_ids.some(value => typeof value !== 'string' || !value || value.length > 256)
      || new Set(body.selected_entity_ids).size !== body.selected_entity_ids.length)) {
      return NextResponse.json({ success: false, error: '所选实体无效' }, { status: 400 });
    }
    if (body.graph_identity !== undefined && body.graph_identity !== null) {
      const identity = body.graph_identity as Record<string, unknown>;
      const invalid = !identity || typeof identity !== 'object' || Array.isArray(identity)
        || ['documentId', 'documentVersion'].some(field => typeof identity[field] !== 'string' || !(identity[field] as string).trim() || (identity[field] as string).length > 256 || /[\u0000-\u001f\u007f]/.test(identity[field] as string))
        || !['trusted', 'reviewed', 'external', 'quarantined'].includes(identity.trustLevel as string)
        || (identity.graphGeneration !== undefined && (typeof identity.graphGeneration !== 'string' || !identity.graphGeneration || identity.graphGeneration.length > 256 || /[\u0000-\u001f\u007f]/.test(identity.graphGeneration)))
        || ('tenantId' in identity || 'corpusId' in identity)
        || (body.graph_id !== undefined && body.graph_id !== identity.documentId);
      if (invalid) return NextResponse.json({ success: false, error: '图谱来源身份无效' }, { status: 400 });
      body.graph_identity = { documentId: identity.documentId, documentVersion: identity.documentVersion, trustLevel: identity.trustLevel,
        ...(identity.graphGeneration === undefined ? {} : { graphGeneration: identity.graphGeneration }) };
    }
    if (body.seed_files !== undefined) {
      const files = body.seed_files;
      const valid = Array.isArray(files) && files.length <= MIROFISH_SEED_MAX_FILES && files.every(file =>
        file && typeof file === 'object' && typeof file.filename === 'string' && file.filename.length <= 120 && file.filename.length > 0
        && !/[\\/\u0000-\u001f\u007f]/.test(file.filename) && Number.isSafeInteger(file.size) && file.size > 0
        && (file.pages === undefined || Number.isSafeInteger(file.pages) && file.pages >= 0)
        && (file.encoding === undefined || typeof file.encoding === 'string' && file.encoding.length <= 32))
        && files.reduce((sum, file) => sum + file.size, 0) <= MIROFISH_SEED_MAX_TOTAL_BYTES;
      if (!valid) return NextResponse.json({ success: false, error: '种子文件信息无效' }, { status: 400 });
      body.seed_files = (files as Array<{ filename: string; size: number; pages?: number; encoding?: string }>).map(file => ({ filename: file.filename, size: file.size,
        ...(file.pages === undefined ? {} : { pages: file.pages }), ...(file.encoding === undefined ? {} : { encoding: file.encoding }) }));
    }

    const store = getScopedMiroFishProjectStore(scope);
    const project = await store.update(id, body);

    if (!project) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, project: createPublicProjectProjection(project) });
  } catch (error) {
    if (error instanceof RequestValidationError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    const modelOverrideError = getHttpModelOverrideErrorResponse(error);
    if (modelOverrideError) {
      return NextResponse.json(modelOverrideError.body, { status: modelOverrideError.status });
    }
    return miroFishProjectApiError(error, '更新项目失败');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { scope } = await resolveMiroFishRequestScope(_request, 'delete-document');
    const store = getScopedMiroFishProjectStore(scope);
    const deleted = await withMiroFishProjectLock(scope, id, async () => {
      const project = await store.get(id);
      if (!project) return false;
      await assertMiroFishProjectIdle(project, scope, { graphTaskStatus: async taskId =>
        getTaskManager().getTask(taskId)?.status ?? (await readStandaloneGraphTask(taskId, scope))?.status });
      return store.delete(id);
    });

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return miroFishProjectApiError(error, '删除项目失败');
  }
}

/** Reset workflow associations; archived source artifacts remain available to saved runs. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { scope } = await resolveMiroFishRequestScope(request, 'ingest');
    const body = await readJsonObjectWithLimit(request, 1024);
    if (body.action !== 'reset') return NextResponse.json({ success: false, error: '未知操作' }, { status: 400 });
    const store = getScopedMiroFishProjectStore(scope);
    const project = await withMiroFishProjectLock(scope, id, async () => {
      const current = await store.get(id);
      if (!current) return null;
      await assertMiroFishProjectIdle(current, scope, { graphTaskStatus: async taskId =>
        getTaskManager().getTask(taskId)?.status ?? (await readStandaloneGraphTask(taskId, scope))?.status });
      return store.reset(id);
    });
    if (!project) return NextResponse.json({ success: false, error: '项目不存在' }, { status: 404 });
    return NextResponse.json({ success: true, project: createPublicProjectProjection(project) });
  } catch (error) { return miroFishProjectApiError(error, '重置项目失败'); }
}
