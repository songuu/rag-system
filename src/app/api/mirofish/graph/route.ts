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
import { getUnifiedPublicationWriteBlock } from '@/lib/security/unified-publication-write-guard';
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
import { getScopedMiroFishProjectStore } from '@/lib/mirofish/request-scope';
import { withMiroFishProjectLock } from '@/lib/mirofish/project-lifecycle';
import { enqueueStandaloneGraphBuild, readStandaloneGraphTask, usesDurableStandaloneGraphBuilds } from '@/lib/mirofish/standalone-graph-runtime';
import { wakeStandaloneGraphBuild } from '@/lib/mirofish/standalone-graph-worker';
import { getConfigSummary } from '@/lib/model-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';
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
import {
  acquireKnowledgeGraphQueryPermit,
  isKnowledgeGraphAdmissionError,
  knowledgeGraphHttpError,
} from '@/lib/knowledge-graph/http';
import { KnowledgeGraphError } from '@/lib/knowledge-graph/contracts';
import { getGraphQueryAuthorityClient, readGraphQueryAuthority, readGraphQueryAuthorities, withAuthorizedGraphSnapshots } from '@/lib/knowledge-graph/query-authority';
import { shouldRequireDurableGraphBuildApi, withAuthorizedMirofishGraphArtifact } from './route-helpers';

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
      projectId?: unknown;
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

    const publicationBlock = getUnifiedPublicationWriteBlock();
    if (publicationBlock) return NextResponse.json({ success: false, code: publicationBlock.code, error: publicationBlock.message, requestId }, { status: publicationBlock.status });
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

    if (shouldRequireDurableGraphBuildApi(process.env)) {
      throw new RequestValidationError(
        'MIROFISH_DURABLE_GRAPH_BUILD_REQUIRED',
        '生产 Neo4j 图谱构建必须使用 /api/knowledge-graph/builds 持久任务入口',
        409
      );
    }

    if (body.projectId !== undefined && (typeof body.projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{1,128}$/.test(body.projectId))) {
      return graphValidationResponse('INVALID_PROJECT_ID', '项目 ID 无效', requestId);
    }
    const projectId = body.projectId as string | undefined;
    const projectStore = projectId ? getScopedMiroFishProjectStore(securityContext) : undefined;
    let durableTaskToWake: string | undefined;
    const startBuild = async () => {
    const project = projectId ? await projectStore!.get(projectId) : null;
    if (projectId && !project) return NextResponse.json({ success: false, error: '项目不存在', requestId }, { status: 404 });
    if (project?.graph_task_id) {
      const previous = getTaskManager().getTask(project.graph_task_id);
      if (previous && ['pending', 'processing'].includes(previous.status)) {
        return NextResponse.json({ success: false, code: 'MIROFISH_PROJECT_GRAPH_BUILDING', error: '项目已有图谱构建任务', requestId }, { status: 409 });
      }
    }

    const graphRuntime = getMiroFishGraphArtifactRuntime();
    const graphScope = createGraphManagementScope(securityContext);
    if (projectId && usesDurableStandaloneGraphBuilds()) {
      const model = getConfigSummary();
      const embedding = getEmbeddingConfigSummary();
      const taskId = await enqueueStandaloneGraphBuild({ projectId, text, ontology, chunkSize, chunkOverlap,
        trustLevel: graphRuntime.trustLevel,
        modelOverride: modelOverride ?? { provider: model.provider, modelName: model.llmModel, temperature: .1 },
        embeddingModel: embedding.model, embeddingProvider: embedding.provider,
        ttlMs: graphRuntime.ttlMs,
      }, securityContext, project?.graph_task_id);
      if (!await projectStore!.update(projectId, { graph_task_id: taskId })) throw new Error('Project unavailable');
      durableTaskToWake = taskId;
      return NextResponse.json({ success: true, taskId, requestId });
    }
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
    if (projectId) {
      try {
        if (!await projectStore!.update(projectId, { graph_task_id: reservedTaskId })) throw new Error('Project unavailable');
      } catch (error) { taskManager.deleteTask(reservedTaskId); throw error; }
    }

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
      if (projectId && (await projectStore!.get(projectId))?.graph_task_id === reservedTaskId) await projectStore!.update(projectId, { graph_task_id: null });
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
    };
    const response = projectId ? await withMiroFishProjectLock(securityContext, projectId, startBuild) : await startBuild();
    if (durableTaskToWake) wakeStandaloneGraphBuild(durableTaskToWake, securityContext);
    return response;
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

    const publicationBlock = getUnifiedPublicationWriteBlock();
    if (publicationBlock) return NextResponse.json({ success: false, code: publicationBlock.code, error: publicationBlock.message, requestId }, { status: publicationBlock.status });
    // 获取任务状态
    if (action === 'status' && taskId) {
      const taskManager = getTaskManager();
      const task = taskManager.getTask(taskId);

      if (
        !task
        || !isMiroFishGraphTaskInScope(task, securityContext)
        || isMiroFishGraphTaskQuarantined(task)
      ) {
        if (!task) {
          const durable = await readStandaloneGraphTask(taskId, securityContext);
          if (durable) {
            wakeStandaloneGraphBuild(taskId, securityContext);
            return NextResponse.json({ ...durable,
              ...(durable.status === 'failed' ? publicGraphTaskError(durable.code) : {}), requestId });
          }
        }
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
        ...(task.status === 'failed' ? publicGraphTaskError(task.error) : {}),
        requestId,
      });
    }

    // 获取图谱数据
    if (action === 'data' && graphId) {
      const release = acquireKnowledgeGraphQueryPermit(securityContext);
      try {
        const graphRuntime = getMiroFishGraphArtifactRuntime();
        const graphScope = createGraphQueryScope(securityContext);
        const requestedVersion = readOptionalGraphIdentityField(searchParams.get('documentVersion'), 'documentVersion');
        const requestedTrust = readOptionalGraphTrustLevel(searchParams.get('trustLevel'));
        const requestedGeneration = readOptionalGraphIdentityField(searchParams.get('graphGeneration'), 'graphGeneration');
        const exactIdentity = requestedVersion && requestedTrust ? {
          tenantId: graphScope.tenantId, corpusId: graphScope.corpusId,
          documentId: readOptionalGraphIdentityField(graphId, 'graphId')!,
          documentVersion: requestedVersion, trustLevel: requestedTrust,
          ...(requestedGeneration ? { graphGeneration: requestedGeneration } : {}),
        } : undefined;
        const descriptor = exactIdentity ? undefined : await findGraphDescriptor(
          graphRuntime.store,
          graphScope,
          graphId,
          searchParams.get('documentVersion'),
          searchParams.get('trustLevel'),
          searchParams.get('graphGeneration')
        );
        const identity = exactIdentity ?? descriptor?.identity;
        if (identity) {
          const client = graphRuntime.backend === 'neo4j' ? getGraphQueryAuthorityClient() : undefined;
          const artifact = await withAuthorizedMirofishGraphArtifact(
            graphRuntime.backend,
            graphScope,
            identity,
            (identity, version) => client
              ? readGraphQueryAuthority(client, graphScope, identity, version)
              : Promise.resolve(null),
            () => graphRuntime.store.get(identity, graphScope)
          );
          if (!artifact) {
            return graphNotFoundResponse('图谱不存在', requestId);
          }
          return boundedGraphDataResponse({
            success: true,
            graph: createPublicGraphProjection(artifact.graph),
            documentVersion: identity.documentVersion,
            trustLevel: identity.trustLevel,
            graphGeneration: identity.graphGeneration,
            requestId,
          });
        }

        // A legacy task carries no canonical document identity to authorize.
        if (graphRuntime.backend === 'neo4j') {
          return graphNotFoundResponse('图谱不存在', requestId);
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
        return boundedGraphDataResponse({
          success: true,
          graph: createPublicGraphProjection(legacyGraph),
          requestId,
        });
      } finally {
        release();
      }
    }

    // 获取所有图谱列表
    if (action === 'list') {
      const release = acquireKnowledgeGraphQueryPermit(securityContext);
      try {
        const graphRuntime = getMiroFishGraphArtifactRuntime();
        const graphScope = createGraphQueryScope(securityContext);
        await graphRuntime.store.gcExpired(graphScope, { limit: 10 });
        const { snapshots: descriptors, active: activePointer } = graphRuntime.backend === 'neo4j'
          ? await withAuthorizedGraphSnapshots(graphScope, {
            list: () => graphRuntime.store.list(graphScope, { limit: 1_000 }),
            getActive: () => graphRuntime.store.getActive(graphScope),
            readAuthorities: identities => readGraphQueryAuthorities(
              getGraphQueryAuthorityClient(), graphScope, identities
            ),
          })
          : await Promise.all([
            graphRuntime.store.list(graphScope, { limit: 1_000 }),
            graphRuntime.store.getActive(graphScope),
          ]).then(([snapshots, active]) => ({ snapshots, active }));
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
        const legacyGraphs = graphRuntime.backend === 'neo4j' ? [] : scopedTasks
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
      } finally {
        release();
      }
    }

    return graphValidationResponse(
      'MIROFISH_GRAPH_ACTION_REQUIRED',
      '未指定操作',
      requestId
    );
  } catch (error) {
    if (isKnowledgeGraphAdmissionError(error) || error instanceof KnowledgeGraphError) {
      return knowledgeGraphHttpError(error, requestId);
    }
    return graphErrorResponse(
      error,
      'MIROFISH_GRAPH_REQUEST_FAILED',
      '请求失败',
      requestId,
      'query'
    );
  }
}

const MIROFISH_GRAPH_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;

function publicGraphTaskError(code: string | undefined): { code: string; error: string } {
  switch (code) {
    case 'ENTITY_EXTRACTION_PROVIDER_TIMEOUT':
      return { code, error: '模型响应超时，请等待模型加载完成后重试，或选择更轻量的模型。' };
    case 'ENTITY_EXTRACTION_PROVIDER_BUSY':
      return { code, error: '上一次模型调用仍在结束中，请稍后重试。' };
    case 'ENTITY_EXTRACTION_TRUNCATED':
      return { code, error: '文本已拆分到最小块，但模型输出仍被截断。请缩小输入或选择输出能力更强的模型。' };
    case 'ENTITY_EXTRACTION_INVALID_OUTPUT':
      return { code, error: '文本已拆分到最小块，但模型仍未返回完整实体和关系。请缩小输入或更换模型。' };
    case 'MIROFISH_GRAPH_OUTPUT_BUDGET_EXCEEDED':
      return { code, error: '图谱抽取结果超过计算预算，请缩小文本范围或分批构建。' };
    case 'MIROFISH_GRAPH_ARTIFACT_LIMIT_EXCEEDED':
      return { code, error: '图谱规模超过存储预算，请减少实体与关系后重新构建。' };
    case 'MIROFISH_GRAPH_ARTIFACT_PUBLISH_FAILED':
      return { code, error: '图谱抽取完成，但保存失败，请检查图数据库和文档存储后重试。' };
    default:
      // Only allowlisted codes/messages cross the HTTP boundary; provider
      // errors can contain document text, endpoints or credentials.
      return { code: 'MIROFISH_GRAPH_BUILD_FAILED', error: '图谱构建失败' };
  }
}

function boundedGraphDataResponse(body: Record<string, unknown>): NextResponse {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MIROFISH_GRAPH_HTTP_RESPONSE_BYTES) {
    return NextResponse.json({
      success: false,
      code: 'MIROFISH_GRAPH_RESPONSE_TOO_LARGE',
      error: '图谱过大，请使用知识图谱分页查询接口',
      requestId: body.requestId,
    }, { status: 413 });
  }
  return NextResponse.json(body);
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
      graphGeneration?: unknown;
      expectedRevision?: unknown;
      active?: unknown;
    };
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'reindex',
      requestedCorpusId: readRequestedCorpusId(searchParams, request),
      requestIdFactory: () => requestId,
    });
    const publicationBlock = getUnifiedPublicationWriteBlock();
    if (publicationBlock) return NextResponse.json({ success: false, code: publicationBlock.code, error: publicationBlock.message, requestId }, { status: publicationBlock.status });
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
      trustLevel,
      body.graphGeneration
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
      graphGeneration: descriptor.identity.graphGeneration,
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
    const publicationBlock = getUnifiedPublicationWriteBlock();
    if (publicationBlock) return NextResponse.json({ success: false, code: publicationBlock.code, error: publicationBlock.message, requestId }, { status: publicationBlock.status });

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
      searchParams.get('trustLevel'),
      searchParams.get('graphGeneration')
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
  trustLevelValue?: unknown,
  graphGenerationValue?: unknown
): Promise<MiroFishGraphArtifactDescriptor | undefined> {
  const graphId = readOptionalGraphIdentityField(graphIdValue, 'graphId');
  if (!graphId) return undefined;
  const documentVersion = readOptionalGraphIdentityField(
    documentVersionValue,
    'documentVersion'
  );
  const trustLevel = readOptionalGraphTrustLevel(trustLevelValue);
  const graphGeneration = readOptionalGraphIdentityField(graphGenerationValue, 'graphGeneration');
  return (await store.list(scope, { limit: 1_000, documentId: graphId, documentVersion, trustLevel })).find(descriptor =>
    descriptor.identity.documentId === graphId
    && (
      documentVersion === undefined
      || descriptor.identity.documentVersion === documentVersion
    )
    && (
      trustLevel === undefined
      || descriptor.identity.trustLevel === trustLevel
    )
    && ((documentVersion === undefined || trustLevel === undefined) && graphGeneration === undefined
      || descriptor.identity.graphGeneration === graphGeneration)
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
    && left.trustLevel === right.trustLevel
    && left.graphGeneration === right.graphGeneration;
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
  field: 'graphId' | 'documentVersion' | 'graphGeneration'
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
