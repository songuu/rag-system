/**
 * MiroFish 图谱构建 API
 *
 * POST /api/mirofish/graph - 创建图谱构建任务
 * GET /api/mirofish/graph?action=status&taskId=xxx - 获取任务状态
 * GET /api/mirofish/graph?action=data&graphId=xxx - 获取图谱数据
 * DELETE /api/mirofish/graph?graphId=xxx - 删除图谱
 */

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  MiroFishGraphOntologyValidationError,
  MiroFishGraphBuilder,
  createPublicGraphProjection,
  normalizeMiroFishGraphOntology,
} from '@/lib/mirofish/graph-builder';
import { purgeMiroFishLegacyGraphCache } from '@/lib/mirofish/artifact-cache';
import { getTaskManager } from '@/lib/mirofish/task-manager';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
} from '@/lib/mirofish/model-override';
import type { GraphBuildRequest, GraphData } from '@/lib/mirofish/types';
import {
  createMiroFishGraphTaskScopeMetadata,
  filterMiroFishGraphTasksByScope,
  isMiroFishGraphTaskInScope,
} from '@/lib/mirofish/graph-api-scope';
import {
  RagSecurityError,
  resolveRagSecurityContext,
} from '@/lib/security/request-context';
import { createStableErrorLog } from '@/lib/security/error-redaction';
import {
  REQUEST_LIMITS,
  RequestValidationError,
  readJsonObjectWithLimit,
  validateChunking,
  validatePipelineText,
} from '@/lib/security/request-validation';

const MIROFISH_GRAPH_TASK_LIMIT = 20;
const MIROFISH_GRAPH_GLOBAL_TASK_LIMIT = 200;
const MIROFISH_GRAPH_GLOBAL_TERMINAL_TASK_LIMIT = 100;
const MIROFISH_GRAPH_GLOBAL_ACTIVE_JOB_LIMIT = 16;
const MIROFISH_GRAPH_ACTIVE_JOB_LIMIT = 4;
const MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT = 1_000;
const MIROFISH_GRAPH_BATCH_LIMIT = 20;
const MIROFISH_GRAPH_NAME_LIMIT = 200;

export async function POST(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  try {
    const body = await readJsonObjectWithLimit(
      request,
      REQUEST_LIMITS.pipelineJsonBytes
    ) as unknown as GraphBuildRequest & {
      modelOverride?: unknown;
      corpusId?: unknown;
    };

    if (body.corpusId !== undefined && typeof body.corpusId !== 'string') {
      return graphValidationResponse(
        'INVALID_CORPUS_ID',
        'corpusId 必须是字符串',
        requestId
      );
    }

    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'ingest',
      requestedCorpusId:
        body.corpusId === undefined ? readCorpusIdHeader(request) : body.corpusId,
      requestIdFactory: () => requestId,
    });

    const text = validatePipelineText(body.text);
    const { chunkSize, chunkOverlap } = validateChunking({
      chunkSize: body.chunkSize ?? 4000,
      chunkOverlap: body.chunkOverlap ?? 300,
    });
    const batchSize = validateGraphBatchSize(body.batchSize);
    const graphName = validateGraphName(body.graphName);
    enforceGraphExtractionBudget(text.length, chunkSize, chunkOverlap);

    const modelOverride = validateHttpModelOverride(body.modelOverride) || undefined;
    const ontology = validateGraphOntology(body.ontology);

    const taskManager = getTaskManager();
    const scopedTaskPredicate = (task: ReturnType<typeof taskManager.getAllTasks>[number]) =>
      task.task_type === 'graph_build'
      && isMiroFishGraphTaskInScope(task, securityContext);
    taskManager.cleanOldTasks(MIROFISH_GRAPH_TASK_LIMIT, scopedTaskPredicate);
    // A scope-local retention pass cannot prevent many tenants from filling the
    // process-wide task map with terminal work. Reclaim only terminal graph jobs;
    // pending/processing work is never eligible for cleanOldTasks.
    taskManager.cleanOldTasks(
      MIROFISH_GRAPH_GLOBAL_TERMINAL_TASK_LIMIT,
      task => task.task_type === 'graph_build'
    );

    const taskScopeMetadata = createMiroFishGraphTaskScopeMetadata(securityContext);
    const admission = taskManager.tryCreateTask(
      'graph_build',
      taskScopeMetadata,
      [
        {
          id: 'global-graph-task-limit',
          limit: MIROFISH_GRAPH_GLOBAL_TASK_LIMIT,
          predicate: task => task.task_type === 'graph_build',
        },
        {
          id: 'global-active-graph-job-limit',
          limit: MIROFISH_GRAPH_GLOBAL_ACTIVE_JOB_LIMIT,
          predicate: task =>
            task.task_type === 'graph_build'
            && (task.status === 'pending' || task.status === 'processing'),
        },
        {
          id: 'scoped-active-graph-job-limit',
          limit: MIROFISH_GRAPH_ACTIVE_JOB_LIMIT,
          predicate: task =>
            task.task_type === 'graph_build'
            && isMiroFishGraphTaskInScope(task, securityContext)
            && (task.status === 'pending' || task.status === 'processing'),
        },
      ]
    );
    if (!admission.accepted) {
      if (admission.constraintId === 'global-graph-task-limit') {
        throw new RequestValidationError(
          'MIROFISH_GRAPH_GLOBAL_TASK_LIMIT',
          '图谱任务队列已满，请删除旧图谱后重试',
          429
        );
      }
      if (admission.constraintId === 'global-active-graph-job-limit') {
        throw new RequestValidationError(
          'MIROFISH_GRAPH_GLOBAL_ACTIVE_JOB_LIMIT',
          '图谱构建服务已达全局并发上限，请稍后重试',
          429
        );
      }
      throw new RequestValidationError(
        'MIROFISH_GRAPH_ACTIVE_JOB_LIMIT',
        '当前语料库的图谱构建任务已达并发上限，请稍后重试',
        429
      );
    }
    const reservedTaskId = admission.taskId;

    // 创建图谱构建器
    const builder = new MiroFishGraphBuilder(
      {
        chunkSize,
        chunkOverlap,
        batchSize,
      },
      modelOverride
    );

    // 异步构建图谱
    let taskId: string;
    try {
      taskId = await builder.buildGraphAsync(
        {
          text,
          ontology,
          graphName,
          chunkSize,
          chunkOverlap,
          batchSize,
        },
        undefined,
        taskScopeMetadata,
        reservedTaskId
      );
    } catch (error) {
      // Admission reserves before any async builder work. Release that slot if
      // startup fails; worker failures are terminally recorded by the builder.
      taskManager.deleteTask(reservedTaskId);
      throw error;
    }
    taskManager.cleanOldTasks(
      MIROFISH_GRAPH_TASK_LIMIT,
      scopedTaskPredicate
    );

    return NextResponse.json({
      success: true,
      taskId,
      requestId,
    });
  } catch (error) {
    return graphErrorResponse(
      error,
      'MIROFISH_GRAPH_BUILD_FAILED',
      '图谱构建失败',
      requestId,
      'build'
    );
  }
}

export async function GET(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  const taskId = searchParams.get('taskId');
  const graphId = searchParams.get('graphId');

  try {
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: readRequestedCorpusId(searchParams, request),
      requestIdFactory: () => requestId,
    });

    // 获取任务状态
    if (action === 'status' && taskId) {
      const taskManager = getTaskManager();
      const task = taskManager.getTask(taskId);

      if (!task || !isMiroFishGraphTaskInScope(task, securityContext)) {
        return graphNotFoundResponse('任务不存在', requestId);
      }

      return NextResponse.json({
        success: true,
        status: task.status,
        progress: task.progress,
        message: task.message,
        graphId: task.result?.graphId,
        error: task.status === 'failed' ? '图谱构建失败' : undefined,
        requestId,
      });
    }

    // 获取图谱数据
    if (action === 'data' && graphId) {
      // 只在当前授权 scope 内查找任务结果。
      const taskManager = getTaskManager();
      const tasks = filterMiroFishGraphTasksByScope(
        taskManager.getAllTasks(),
        securityContext
      );

      let graphData: GraphData | null = null;
      for (const task of tasks) {
        if (task.result?.graphId === graphId) {
          graphData = task.result.graphData as GraphData;
          break;
        }
      }

      if (!graphData) {
        return graphNotFoundResponse('图谱不存在', requestId);
      }

      return NextResponse.json({
        success: true,
        graph: createPublicGraphProjection(graphData),
        requestId,
      });
    }

    // 获取所有图谱列表
    if (action === 'list') {
      const taskManager = getTaskManager();
      const tasks = filterMiroFishGraphTasksByScope(
        taskManager.getAllTasks(),
        securityContext
      );

      const graphs = tasks
        .filter(t => t.result?.graphId)
        .map(t => {
          const result = t.result as Record<string, unknown> | undefined;
          const graphData = result?.graphData as { node_count?: number; edge_count?: number } | undefined;
          return {
            graphId: result?.graphId,
            graphName: t.metadata?.graphName,
            nodeCount: graphData?.node_count || 0,
            edgeCount: graphData?.edge_count || 0,
            createdAt: new Date(t.created_at).toISOString(),
            status: t.status,
          };
        });

      return NextResponse.json({
        success: true,
        graphs,
        requestId,
      });
    }

    return graphValidationResponse(
      'MIROFISH_GRAPH_ACTION_REQUIRED',
      '未指定操作',
      requestId
    );
  } catch (error) {
    return graphErrorResponse(
      error,
      'MIROFISH_GRAPH_REQUEST_FAILED',
      '请求失败',
      requestId,
      'query'
    );
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  const { searchParams } = new URL(request.url);
  const graphId = searchParams.get('graphId');

  try {
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'delete-document',
      requestedCorpusId: readRequestedCorpusId(searchParams, request),
      requestIdFactory: () => requestId,
    });

    if (!graphId) {
      return graphValidationResponse(
        'MIROFISH_GRAPH_ID_REQUIRED',
        '缺少 graphId 参数',
        requestId
      );
    }

    // 只删除当前授权 scope 内的任务结果。
    const taskManager = getTaskManager();
    const tasks = filterMiroFishGraphTasksByScope(
      taskManager.getAllTasks(),
      securityContext
    );
    const task = tasks.find(candidate => candidate.result?.graphId === graphId);

    if (!task) {
      return graphNotFoundResponse('图谱不存在', requestId);
    }

    // Legacy graph cache records were unscoped and may contain raw passages.
    // Fail closed if cleanup cannot be verified, then remove the scoped task.
    await purgeMiroFishLegacyGraphCache();
    taskManager.deleteTask(task.task_id);

    return NextResponse.json({
      success: true,
      requestId,
    });
  } catch (error) {
    return graphErrorResponse(
      error,
      'MIROFISH_GRAPH_DELETE_FAILED',
      '删除失败',
      requestId,
      'delete'
    );
  }
}

function graphValidationResponse(code: string, message: string, requestId: string) {
  return NextResponse.json(
    { success: false, error: message, code, requestId },
    { status: 400 }
  );
}

function validateGraphOntology(value: unknown) {
  try {
    return normalizeMiroFishGraphOntology(value);
  } catch (error) {
    if (error instanceof MiroFishGraphOntologyValidationError) {
      throw new RequestValidationError(
        'INVALID_GRAPH_ONTOLOGY',
        'ontology 格式无效',
        400
      );
    }
    throw error;
  }
}

function graphNotFoundResponse(message: string, requestId: string) {
  return NextResponse.json(
    {
      success: false,
      error: message,
      code: 'MIROFISH_GRAPH_NOT_FOUND',
      requestId,
    },
    { status: 404 }
  );
}

function graphErrorResponse(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  requestId: string,
  operation: 'build' | 'query' | 'delete'
) {
  console.error(
    `[MiroFish Graph API] operation=${operation} requestId=${requestId}`,
    createStableErrorLog(error)
  );

  if (error instanceof RagSecurityError) {
    const body = error.toResponseBody();
    return NextResponse.json(
      {
        success: false,
        error: body.error.message,
        code: body.error.code,
        requestId: body.error.requestId,
      },
      { status: error.status }
    );
  }

  if (error instanceof RequestValidationError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        code: error.code,
        requestId,
      },
      { status: error.status }
    );
  }

  const modelOverrideError = getHttpModelOverrideErrorResponse(error);
  if (modelOverrideError) {
    return NextResponse.json(
      { ...modelOverrideError.body, requestId },
      { status: modelOverrideError.status }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: fallbackMessage,
      code: fallbackCode,
      requestId,
    },
    { status: 500 }
  );
}

function readCorpusIdHeader(request: NextRequest): string | undefined {
  return request.headers.get('x-rag-corpus-id')?.trim() || undefined;
}

function readRequestedCorpusId(
  searchParams: URLSearchParams,
  request: NextRequest
): string | undefined {
  const queryValue = searchParams.get('corpusId');
  return queryValue === null ? readCorpusIdHeader(request) : queryValue;
}

function validateGraphBatchSize(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > MIROFISH_GRAPH_BATCH_LIMIT
  ) {
    throw new RequestValidationError(
      'INVALID_GRAPH_BATCH_SIZE',
      `batchSize 必须是 1 到 ${MIROFISH_GRAPH_BATCH_LIMIT} 之间的整数`
    );
  }
  return value;
}

/**
 * Exact sliding-window upper bound derived from the only three request values
 * available before provider work starts. Graph extraction disables gleaning,
 * so each possible chunk consumes at least one provider extraction call.
 */
export function calculateMiroFishGraphChunkUpperBound(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): number {
  if (
    !Number.isInteger(textLength)
    || textLength < 0
    || !Number.isInteger(chunkSize)
    || chunkSize < 1
    || !Number.isInteger(chunkOverlap)
    || chunkOverlap < 0
    || chunkOverlap >= chunkSize
  ) {
    throw new Error('Invalid MiroFish graph chunk-bound inputs.');
  }
  if (textLength === 0) return 0;
  if (textLength <= chunkSize) return 1;

  return 1 + Math.ceil(
    (textLength - chunkSize) / (chunkSize - chunkOverlap)
  );
}

function enforceGraphExtractionBudget(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): void {
  const callUpperBound = calculateMiroFishGraphChunkUpperBound(
    textLength,
    chunkSize,
    chunkOverlap
  );
  if (callUpperBound > MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT) {
    throw new RequestValidationError(
      'MIROFISH_GRAPH_PROVIDER_CALL_LIMIT',
      '图谱输入会产生过多提取调用，请增大 chunkSize 或缩短文本',
      422
    );
  }
}

function validateGraphName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RequestValidationError(
      'INVALID_GRAPH_NAME',
      'graphName 必须是字符串'
    );
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MIROFISH_GRAPH_NAME_LIMIT
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new RequestValidationError(
      'INVALID_GRAPH_NAME',
      `graphName 必须是 1 到 ${MIROFISH_GRAPH_NAME_LIMIT} 个无控制字符的文本`
    );
  }
  return normalized;
}

function resolvePublicRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : randomUUID();
}
