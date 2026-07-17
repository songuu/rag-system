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
import {
  MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT,
  MIROFISH_GRAPH_PROVIDER_INPUT_CHARACTER_LIMIT,
  calculateMiroFishGraphExtractionBudget,
} from '@/lib/mirofish/graph-extraction-budget';
import { getTaskManager } from '@/lib/mirofish/task-manager';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
} from '@/lib/mirofish/model-override';
import type { GraphBuildRequest, GraphData, TaskInfo } from '@/lib/mirofish/types';
import {
  createMiroFishGraphTaskScopeMetadata,
  filterMiroFishGraphTasksByScope,
  isMiroFishGraphTaskInScope,
} from '@/lib/mirofish/graph-api-scope';
import {
  RagSecurityError,
  resolveRagSecurityContext,
  type RagSecurityContext,
} from '@/lib/security/request-context';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';
import {
  MiroFishGraphStoreError,
  type MiroFishGraphArtifactDescriptor,
  type MiroFishGraphArtifactIdentity,
  type MiroFishGraphArtifactStore,
} from '@/lib/mirofish/graph-artifact-store';
import {
  getMiroFishGraphArtifactRuntime,
} from '@/lib/mirofish/graph-artifact-runtime';
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

    const graphRuntime = getMiroFishGraphArtifactRuntime();
    const graphScope = createGraphManagementScope(securityContext);
    await graphRuntime.store.gcExpired(graphScope, { limit: 10 });
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

    const taskScopeMetadata = {
      ...createMiroFishGraphTaskScopeMetadata(securityContext),
      publicationTrustLevel: graphRuntime.trustLevel,
    };
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
        reservedTaskId,
        {
          store: graphRuntime.store,
          tenantId: securityContext.tenantId,
          corpusId: securityContext.corpusId,
          trustLevel: graphRuntime.trustLevel,
          ttlMs: graphRuntime.ttlMs,
          graphName: graphName || 'MiroFish Graph',
        }
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

      if (
        !task
        || !isMiroFishGraphTaskInScope(task, securityContext)
        || isMiroFishGraphTaskQuarantined(task)
      ) {
        return graphNotFoundResponse('任务不存在', requestId);
      }

      return NextResponse.json({
        success: true,
        status: task.status,
        progress: task.progress,
        message: task.message,
        graphId: task.result?.graphId,
        documentVersion: task.result?.documentVersion,
        trustLevel: task.result?.trustLevel,
        error: task.status === 'failed' ? '图谱构建失败' : undefined,
        requestId,
      });
    }

    // 获取图谱数据
    if (action === 'data' && graphId) {
      const graphRuntime = getMiroFishGraphArtifactRuntime();
      const graphScope = createGraphQueryScope(securityContext);
      const descriptor = await findGraphDescriptor(
        graphRuntime.store,
        graphScope,
        graphId,
        searchParams.get('documentVersion'),
        searchParams.get('trustLevel')
      );
      if (descriptor) {
        const artifact = await graphRuntime.store.get(
          descriptor.identity,
          graphScope
        );
        if (!artifact) {
          return graphNotFoundResponse('图谱不存在', requestId);
        }
        return NextResponse.json({
          success: true,
          graph: createPublicGraphProjection(artifact.graph),
          documentVersion: descriptor.identity.documentVersion,
          trustLevel: descriptor.identity.trustLevel,
          requestId,
        });
      }

      // Compatibility only for direct pre-E5 library callers. HTTP builds now
      // publish durable artifacts and never retain graphData in TaskManager.
      const legacyTask = filterMiroFishGraphTasksByScope(
        getTaskManager().getAllTasks(),
        securityContext
      ).find(task =>
        !isMiroFishGraphTaskQuarantined(task)
        && task.result?.graphId === graphId
        && task.result?.graphData
        && task.result?.trustLevel !== 'quarantined'
      );
      const legacyGraph = legacyTask?.result?.graphData as GraphData | undefined;
      if (!legacyGraph) {
        return graphNotFoundResponse('图谱不存在', requestId);
      }
      return NextResponse.json({
        success: true,
        graph: createPublicGraphProjection(legacyGraph),
        requestId,
      });
    }

    // 获取所有图谱列表
    if (action === 'list') {
      const graphRuntime = getMiroFishGraphArtifactRuntime();
      const graphScope = createGraphQueryScope(securityContext);
      await graphRuntime.store.gcExpired(graphScope, { limit: 10 });
      const [descriptors, activePointer] = await Promise.all([
        graphRuntime.store.list(graphScope, { limit: 1_000 }),
        graphRuntime.store.getActive(graphScope),
      ]);
      const taskManager = getTaskManager();
      const scopedTasks = filterMiroFishGraphTasksByScope(
        taskManager.getAllTasks(),
        securityContext
      ).filter(task => !isMiroFishGraphTaskQuarantined(task));
      const durableIds = new Set(
        descriptors.map(descriptor => descriptor.identity.documentId)
      );
      const durableGraphs = descriptors.map(descriptor => {
        const task = scopedTasks.find(
          candidate => candidate.result?.graphId === descriptor.identity.documentId
        );
        return {
          graphId: descriptor.identity.documentId,
          graphName: descriptor.graphName,
          documentVersion: descriptor.identity.documentVersion,
          trustLevel: descriptor.identity.trustLevel,
          nodeCount: descriptor.nodeCount,
          edgeCount: descriptor.edgeCount,
          createdAt: descriptor.createdAt,
          expiresAt: descriptor.expiresAt,
          active: Boolean(
            activePointer.identity
            && sameGraphIdentity(activePointer.identity, descriptor.identity)
          ),
          status: task?.status ?? 'published',
        };
      });
      const legacyGraphs = scopedTasks
        .filter(task =>
          typeof task.result?.graphId === 'string'
          && task.result?.graphData
          && task.result?.trustLevel !== 'quarantined'
          && !durableIds.has(task.result.graphId as string)
        )
        .map(task => {
          const result = task.result as Record<string, unknown>;
          const graphData = result.graphData as {
            node_count?: number;
            edge_count?: number;
          };
          return {
            graphId: result.graphId,
            graphName: task.metadata?.graphName,
            nodeCount: graphData.node_count || 0,
            edgeCount: graphData.edge_count || 0,
            createdAt: new Date(task.created_at).toISOString(),
            active: false,
            status: task.status,
          };
        });

      return NextResponse.json({
        success: true,
        graphs: [...durableGraphs, ...legacyGraphs],
        activeRevision: activePointer.revision,
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

export async function PATCH(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  const { searchParams } = new URL(request.url);
  try {
    const body = await readJsonObjectWithLimit(
      request,
      REQUEST_LIMITS.pipelineJsonBytes
    ) as {
      graphId?: unknown;
      documentVersion?: unknown;
      trustLevel?: unknown;
      expectedRevision?: unknown;
      active?: unknown;
    };
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'reindex',
      requestedCorpusId: readRequestedCorpusId(searchParams, request),
      requestIdFactory: () => requestId,
    });
    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw new RequestValidationError(
        'INVALID_MIROFISH_GRAPH_ACTIVE',
        'active 必须是布尔值'
      );
    }
    const expectedRevision = validateGraphRevision(body.expectedRevision);
    const graphId = readOptionalGraphIdentityField(body.graphId, 'graphId');
    const documentVersion = readOptionalGraphIdentityField(
      body.documentVersion,
      'documentVersion'
    );
    const trustLevel = readOptionalGraphTrustLevel(body.trustLevel);
    const graphRuntime = getMiroFishGraphArtifactRuntime();
    const graphScope = createGraphManagementScope(securityContext);

    if (body.active === false) {
      const current = await graphRuntime.store.getActive(graphScope);
      if (
        graphId
        && (!current.identity || current.identity.documentId !== graphId)
      ) {
        return graphNotFoundResponse('图谱不存在', requestId);
      }
      const pointer = await graphRuntime.store.compareAndSetActive(
        graphScope,
        null,
        expectedRevision
      );
      return NextResponse.json({
        success: true,
        active: false,
        revision: pointer.revision,
        requestId,
      });
    }

    if (!graphId) {
      return graphValidationResponse(
        'MIROFISH_GRAPH_ID_REQUIRED',
        '缺少 graphId 参数',
        requestId
      );
    }
    const descriptor = await findGraphDescriptor(
      graphRuntime.store,
      graphScope,
      graphId,
      documentVersion,
      trustLevel
    );
    if (!descriptor) {
      return graphNotFoundResponse('图谱不存在', requestId);
    }
    const pointer = await graphRuntime.store.compareAndSetActive(
      graphScope,
      descriptor.identity,
      expectedRevision
    );
    return NextResponse.json({
      success: true,
      graphId: descriptor.identity.documentId,
      documentVersion: descriptor.identity.documentVersion,
      trustLevel: descriptor.identity.trustLevel,
      active: true,
      revision: pointer.revision,
      requestId,
    });
  } catch (error) {
    return graphErrorResponse(
      error,
      'MIROFISH_GRAPH_ACTIVATE_FAILED',
      '图谱激活失败',
      requestId,
      'activate'
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

    const graphRuntime = getMiroFishGraphArtifactRuntime();
    const graphScope = createGraphManagementScope(securityContext);
    const descriptor = await findGraphDescriptor(
      graphRuntime.store,
      graphScope,
      graphId,
      searchParams.get('documentVersion'),
      searchParams.get('trustLevel')
    );
    const taskManager = getTaskManager();
    const tasks = filterMiroFishGraphTasksByScope(
      taskManager.getAllTasks(),
      securityContext
    );

    if (descriptor) {
      // Legacy cache cleanup and durable deletion must both succeed before the
      // process-local task is removed, leaving a retryable control record.
      await purgeMiroFishLegacyGraphCache();
      const deleted = await graphRuntime.store.delete(
        descriptor.identity,
        graphScope
      );
      if (!deleted) {
        return graphNotFoundResponse('图谱不存在', requestId);
      }
      for (const task of tasks) {
        if (task.result?.graphId === graphId) {
          taskManager.deleteTask(task.task_id);
        }
      }
      return NextResponse.json({
        success: true,
        requestId,
      });
    }

    // Compatibility only for direct pre-E5 callers without a durable identity.
    const legacyTask = tasks.find(candidate =>
      candidate.result?.graphId === graphId
      && candidate.result?.graphData
    );
    if (!legacyTask) {
      return graphNotFoundResponse('图谱不存在', requestId);
    }
    await purgeMiroFishLegacyGraphCache();
    taskManager.deleteTask(legacyTask.task_id);

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
  operation: 'build' | 'query' | 'activate' | 'delete'
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

  if (error instanceof MiroFishGraphStoreError) {
    const status = (
      error.code === 'MIROFISH_GRAPH_SHARED_STORE_REQUIRED'
      || error.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
    )
      ? 503
      : 409;
    const message = error.code === 'MIROFISH_GRAPH_ARTIFACT_ACTIVE'
      ? '请先停用图谱后再删除'
      : error.code === 'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT'
        ? '图谱激活版本已变化，请刷新后重试'
        : error.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
          ? '图谱存储容量已满'
          : status === 503
            ? '图谱控制面配置不可用'
            : '图谱状态冲突';
    return NextResponse.json(
      { success: false, error: message, code: error.code, requestId },
      { status }
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

function isMiroFishGraphTaskQuarantined(task: TaskInfo): boolean {
  return task.metadata?.publicationTrustLevel === 'quarantined'
    || task.result?.trustLevel === 'quarantined';
}

function createGraphQueryScope(
  securityContext: RagSecurityContext
) {
  return createRetrievalScope({
    tenantId: securityContext.tenantId,
    corpusId: securityContext.corpusId,
    allowedTrustLevels: ['trusted', 'reviewed', 'external'],
    enforceIsolation: securityContext.enforceIsolation,
  });
}
function createGraphManagementScope(
  securityContext: RagSecurityContext
) {
  return createRetrievalScope({
    tenantId: securityContext.tenantId,
    corpusId: securityContext.corpusId,
    allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
    enforceIsolation: securityContext.enforceIsolation,
  });
}

async function findGraphDescriptor(
  store: MiroFishGraphArtifactStore,
  scope: ReturnType<typeof createGraphManagementScope>,
  graphIdValue: unknown,
  documentVersionValue?: unknown,
  trustLevelValue?: unknown
): Promise<MiroFishGraphArtifactDescriptor | undefined> {
  const graphId = readOptionalGraphIdentityField(graphIdValue, 'graphId');
  if (!graphId) return undefined;
  const documentVersion = readOptionalGraphIdentityField(
    documentVersionValue,
    'documentVersion'
  );
  const trustLevel = readOptionalGraphTrustLevel(trustLevelValue);
  return (await store.list(scope, { limit: 1_000 })).find(descriptor =>
    descriptor.identity.documentId === graphId
    && (
      documentVersion === undefined
      || descriptor.identity.documentVersion === documentVersion
    )
    && (
      trustLevel === undefined
      || descriptor.identity.trustLevel === trustLevel
    )
  );
}

function sameGraphIdentity(
  left: MiroFishGraphArtifactIdentity,
  right: MiroFishGraphArtifactIdentity
): boolean {
  return left.tenantId === right.tenantId
    && left.corpusId === right.corpusId
    && left.documentId === right.documentId
    && left.documentVersion === right.documentVersion
    && left.trustLevel === right.trustLevel;
}

function validateGraphRevision(value: unknown): number {
  if (value === undefined) {
    throw new RequestValidationError(
      'MIROFISH_GRAPH_REVISION_REQUIRED',
      '缺少 expectedRevision'
    );
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RequestValidationError(
      'INVALID_MIROFISH_GRAPH_REVISION',
      'expectedRevision 必须是非负安全整数'
    );
  }
  return value;
}

function readOptionalGraphIdentityField(
  value: unknown,
  field: 'graphId' | 'documentVersion'
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new RequestValidationError(
      'INVALID_MIROFISH_GRAPH_IDENTITY',
      `${field} 必须是字符串`
    );
  }
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 256
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new RequestValidationError(
      'INVALID_MIROFISH_GRAPH_IDENTITY',
      `${field} 格式无效`
    );
  }
  return normalized;
}

function readOptionalGraphTrustLevel(
  value: unknown
): MiroFishGraphArtifactIdentity['trustLevel'] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string'
    || !['trusted', 'reviewed', 'external', 'quarantined'].includes(value)
  ) {
    throw new RequestValidationError(
      'INVALID_MIROFISH_GRAPH_TRUST_LEVEL',
      'trustLevel 格式无效'
    );
  }
  return value as MiroFishGraphArtifactIdentity['trustLevel'];
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
  return calculateMiroFishGraphExtractionBudget(
    textLength,
    chunkSize,
    chunkOverlap
  ).providerCallCount;
}

function enforceGraphExtractionBudget(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): void {
  const budget = calculateMiroFishGraphExtractionBudget(
    textLength,
    chunkSize,
    chunkOverlap
  );
  if (budget.providerCallCount > MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT) {
    throw new RequestValidationError(
      'MIROFISH_GRAPH_PROVIDER_CALL_LIMIT',
      '图谱输入会产生过多提取调用，请增大 chunkSize 或缩短文本',
      422
    );
  }
  if (
    budget.providerInputCharacters
    > MIROFISH_GRAPH_PROVIDER_INPUT_CHARACTER_LIMIT
  ) {
    throw new RequestValidationError(
      'MIROFISH_GRAPH_PROVIDER_INPUT_LIMIT',
      '图谱输入会产生过多累计模型输入，请减小重叠或缩短文本',
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
