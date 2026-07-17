import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';
import { analyzeQuery } from '@/lib/semantic-analyzer';
import {
  getMilvusInstance,
  createMilvusHybridRuntimeManifest,
  type MilvusConfig,
  type CollectionStats,
  type MilvusSearchResult,
} from '@/lib/milvus-client';
import { Embeddings } from '@langchain/core/embeddings';
import {
  AgenticRAGSystem,
  type AgentState,
  type RetrievedDocument as AgenticRetrievedDocumentBase,
} from '@/lib/agentic-rag';
import {
  AdaptiveEntityRAGExecutionError,
  createAdaptiveEntityRAG,
  type WorkflowState as AdaptiveWorkflowState,
} from '@/lib/adaptive-entity-rag';
import { 
  createLLM, 
  createEmbedding,
} from '@/lib/model-config';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';
import {
  RagKernel,
  RagKernelExecutionError,
  RagRequestAbortedError,
  RagLaneExecutor,
  adaptMilvusSearchResultsToEvidence,
  composeEvidenceContextV2,
  createLegacyEvidenceTransform,
  createRagContextDigest,
  createMilvusHybridLaneHandler,
  createPdfVisualLaneHandler,
  getPdfVisualAssetRuntime,
  isHybridCapabilityUsable,
  isPdfVisualIntent,
  resolvePdfMultimodalMode,
  resolvePdfVisualModel,
  resolveMilvusHybridRolloutMode,
  createRoutedMilvusRetrievalPlan,
  createRagCacheIdentity,
  createRagPolicy,
  invokeRagKernelWorkflow,
  invokePreRouteProviderWithDeadline,
  isRagPreRouteProviderUnavailableError,
  MAX_RAG_PRE_ROUTE_PROVIDER_TIMEOUT_MS,
  readBoundedOrderedCorpus,
  normalizeLegacyPolicyDocuments,
  resolveRagPolicyId,
  throwIfRagRequestAborted,
  type DurableJsonObject,
  type RagAnswerEnvelope,
  type RagExecutionTransition,
  type RagLaneHandler,
  type RagLaneExecutorResult,
  type RagPolicyContext,
  type RagQueryRequest,
  type OrderedCorpusSnapshot,
  type RagStorageBackend,
  type MilvusHybridCapability,
  type MilvusHybridSearchPort,
} from '@/lib/rag';
import { decideRagAbstention } from '@/lib/rag/retrieval/abstention-policy';
import {
  createAnswerExecutionTransitions,
  createMilvusAnswerPrompt,
  createPublicRagFailureEnvelope,
  didApplyStructuredConstraints,
  prepareMilvusGenerationContext,
  resolveAgenticLegacyFailure,
  resolveMinimumDistinctDocuments,
} from '@/lib/rag/retrieval/ask-route-contract';
import {
  classifyRetrievalQuery,
  routeRetrievalQuery,
  resolveRetrievalRouterCapabilities,
} from '@/lib/rag/retrieval/retrieval-router';
import { createGraphEntityLaneHandler } from '@/lib/rag/retrieval/graph-entity-lane';
import {
  getMiroFishGraphArtifactRuntime,
} from '@/lib/mirofish/graph-artifact-runtime';
import {
  assertRagResponseTrace,
  attachRagKernelHeaders,
} from '@/lib/rag/core/http-contract';
import { runWithLangSmithRootRun } from '@/lib/langsmith/tracing';
import {
  REQUEST_LIMITS,
  RequestValidationError,
  publicErrorPayload,
  readJsonObjectWithLimit,
  validateAskInput,
} from '@/lib/security/request-validation';
import {
  RagSecurityError,
  resolveRagSecurityContext,
} from '@/lib/security/request-context';
import {
  buildScopedMilvusSearchOptions,
  createRetrievalScope,
  type RagRetrievalScope,
  type RagTrustLevel,
} from '@/lib/security/retrieval-scope';

export const runtime = 'nodejs';

type RagAskSuccessPayload = Omit<
  RagAnswerEnvelope,
  'storageBackend' | 'traceId'
> & {
  storageBackend: RagStorageBackend;
  traceId: string;
  models: {
    llm: string;
    embedding: string;
  };
  [key: string]: unknown;
};

type AgenticRetrievedDocument = AgenticRetrievedDocumentBase & {
  factualScore?: number;
};

// 获取默认 Milvus 配置（使用统一配置系统）
function getDefaultMilvusConfig(): MilvusConfig {
  const connConfig = getMilvusConnectionConfig();
  return {
    address: connConfig.address,
    collectionName: connConfig.defaultCollection,
    embeddingDimension: connConfig.defaultDimension,
    indexType: connConfig.defaultIndexType,
    metricType: connConfig.defaultMetricType,
    token: connConfig.token,
    ssl: connConfig.ssl,
  };
}

/**
 * 获取 Embedding 模型 (使用统一配置系统)
 */
function getEmbeddingModel(modelName: string): Embeddings {
  return createEmbedding(modelName);
}

function assertLaneNotAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

class RagGenerationTimeoutError extends Error {
  readonly code = 'RAG_GENERATION_TIMEOUT';

  constructor(modelKey: string, timeoutMs: number) {
    super(`RAG generation timed out for ${modelKey} after ${timeoutMs}ms.`);
    this.name = 'RagGenerationTimeoutError';
  }
}

class RagGenerationProviderBusyError extends Error {
  readonly code = 'RAG_GENERATION_PROVIDER_BUSY';

  constructor(modelKey: string) {
    super(`RAG generation provider still has detached work in flight: ${modelKey}`);
    this.name = 'RagGenerationProviderBusyError';
  }
}

const DETACHED_GENERATION_WORK = new Map<string, Set<Promise<void>>>();

/**
 * Bounds answer generation and admission-blocks a model while a timed-out or
 * cancelled non-cooperative invocation is still consuming provider capacity.
 */
export async function invokeGenerationWithDeadline<T>(input: {
  modelKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  invoke(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  throwIfRagRequestAborted(input.signal);
  const modelKey = input.modelKey.trim();
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!modelKey) throw new Error('RAG generation modelKey is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('RAG generation timeoutMs must be an integer between 1 and 300000.');
  }
  if ((DETACHED_GENERATION_WORK.get(modelKey)?.size ?? 0) > 0) {
    throw new RagGenerationProviderBusyError(modelKey);
  }

  const controller = new AbortController();
  let operationSettled = false;
  let timeoutError: RagGenerationTimeoutError | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => input.invoke(controller.signal));
  const settlement = operation
    .then(
      () => { operationSettled = true; },
      () => { operationSettled = true; }
    )
    .finally(() => {
      const pendingWork = DETACHED_GENERATION_WORK.get(modelKey);
      pendingWork?.delete(settlement);
      if (pendingWork?.size === 0) {
        DETACHED_GENERATION_WORK.delete(modelKey);
      }
    });
  let tracked = false;
  const trackUnsettledOperation = () => {
    if (operationSettled || tracked) return;
    const pendingWork = DETACHED_GENERATION_WORK.get(modelKey) ?? new Set();
    pendingWork.add(settlement);
    DETACHED_GENERATION_WORK.set(modelKey, pendingWork);
    tracked = true;
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      if (operationSettled) return;
      const error = new RagGenerationTimeoutError(modelKey, timeoutMs);
      timeoutError = error;
      trackUnsettledOperation();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  let requestAbortError: RagRequestAbortedError | undefined;
  let rejectRequestAbort: ((error: RagRequestAbortedError) => void) | undefined;
  const requestAbort = new Promise<never>((_resolve, reject) => {
    rejectRequestAbort = reject;
  });
  const abortFromRequest = () => {
    if (requestAbortError || timeoutError || operationSettled) return;
    const error = new RagRequestAbortedError();
    requestAbortError = error;
    trackUnsettledOperation();
    controller.abort(error);
    rejectRequestAbort?.(error);
  };
  input.signal?.addEventListener('abort', abortFromRequest, { once: true });
  if (input.signal?.aborted) abortFromRequest();

  try {
    return await Promise.race([operation, timeout, requestAbort]);
  } catch (error) {
    if (requestAbortError) throw requestAbortError;
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abortFromRequest);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function createLegacyPolicyTransitions(
  laneResult: RagLaneExecutorResult,
  completionReason: string
): RagExecutionTransition[] {
  const generationFrom = laneResult.evidence.length > 0
    ? 'evidence_ready'
    : 'retrieving';
  return [
    ...laneResult.transitions.filter(transition => transition.to !== 'completed'),
    {
      from: generationFrom,
      to: 'generating',
      at: new Date().toISOString(),
      reason: 'legacy_generation_projected',
    },
    {
      from: 'generating',
      to: 'completed',
      at: new Date().toISOString(),
      reason: completionReason,
    },
  ];
}

type RagFeatureRolloutMode = 'off' | 'shadow' | 'active';
const RAG_RETRIEVAL_EXECUTION_BUDGET_MS = 30_000;
const DEFAULT_HYBRID_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_ORDERED_CONTEXT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_HYBRID_SEARCH_TIMEOUT_MS = 5_000;

function resolveRagProviderTimeoutMs(
  name: string,
  fallback: number
): number {
  const configured = process.env[name];
  if (configured === undefined || configured.trim() === '') return fallback;
  const timeoutMs = Number(configured);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_RAG_PRE_ROUTE_PROVIDER_TIMEOUT_MS
    || timeoutMs >= RAG_RETRIEVAL_EXECUTION_BUDGET_MS
  ) {
    throw new Error(
      `${name} must be an integer between 1 and ${MAX_RAG_PRE_ROUTE_PROVIDER_TIMEOUT_MS}ms `
      + 'and remain below the total retrieval budget.'
    );
  }
  return timeoutMs;
}

function resolveRagFeatureRolloutMode(
  name: string,
  fallback: RagFeatureRolloutMode
): RagFeatureRolloutMode {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'off' || value === 'shadow' || value === 'active') return value;
  throw new Error(`${name} must be off, shadow, or active.`);
}

function resolveDenseAbstentionThreshold(fallback: number): number {
  const configured = process.env.RAG_DENSE_ABSTAIN_THRESHOLD;
  if (configured === undefined || configured.trim() === '') {
    return Math.max(0, Math.min(1, fallback));
  }
  const threshold = Number(configured);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('RAG_DENSE_ABSTAIN_THRESHOLD must be between 0 and 1.');
  }
  return threshold;
}

function publicRagPolicyFailure(error: RagKernelExecutionError, requestId: string) {
  const policy = error.envelope.policy_id;
  const mapped = error.envelope.error?.code === 'RAG_REQUEST_ABORTED'
    ? { status: 499, code: 'RAG_REQUEST_ABORTED', message: 'RAG 请求已取消' }
    : policy === 'agentic'
    ? { status: 502, code: 'AGENTIC_QUERY_FAILED', message: 'Agentic RAG 查询失败' }
    : policy === 'adaptive-entity'
      ? { status: 500, code: 'ADAPTIVE_QUERY_FAILED', message: '自适应实体路由 RAG 查询失败' }
      : policy === 'memory'
        ? { status: 500, code: 'MEMORY_QUERY_FAILED', message: '内存 RAG 查询失败' }
        : { status: 500, code: 'RAG_POLICY_FAILED', message: 'RAG 查询执行失败' };
  return {
    status: mapped.status,
    body: {
      error: { code: mapped.code, message: mapped.message },
      requestId,
    },
    publicEnvelope: {
      ...createPublicRagFailureEnvelope(error.envelope, {
        code: mapped.code,
        message: mapped.message,
      }),
    },
  };
}

async function resolveServerMiroFishPolicy(
  question: string,
  scope: RagRetrievalScope
): Promise<Pick<RagQueryRequest, 'serverPolicyId' | 'graphArtifactIdentity'>> {
  const mode = resolveRagFeatureRolloutMode('RAG_MIROFISH_GRAPH_MODE', 'off');
  if (mode !== 'active') return {};
  const queryKind = classifyRetrievalQuery(question).queryKind;
  if (queryKind !== 'global' && queryKind !== 'multi-hop') return {};

  const documentId = process.env.RAG_MIROFISH_GRAPH_DOCUMENT_ID?.trim();
  const documentVersion = process.env.RAG_MIROFISH_GRAPH_DOCUMENT_VERSION?.trim();
  if (Boolean(documentId) !== Boolean(documentVersion)) {
    throw new Error(
      'Pinned MiroFish graph configuration requires both document ID and version.'
    );
  }
  if (documentId && documentVersion) {
    const trustValue = process.env.RAG_MIROFISH_GRAPH_TRUST_LEVEL?.trim() || 'reviewed';
    if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(trustValue)) {
      throw new Error('RAG_MIROFISH_GRAPH_TRUST_LEVEL is invalid.');
    }
    const trustLevel = trustValue as RagTrustLevel;
    assertMiroFishTrustAllowed(trustLevel, scope);
    return {
      serverPolicyId: 'mirofish-research',
      graphArtifactIdentity: {
        documentId,
        documentVersion,
        trustLevel,
      },
    };
  }

  const graphRuntime = getMiroFishGraphArtifactRuntime();
  const pointer = await graphRuntime.store.getActive(scope);
  if (!pointer.identity) return {};
  assertMiroFishTrustAllowed(pointer.identity.trustLevel, scope);
  const artifact = await graphRuntime.store.get(pointer.identity, scope);
  if (!artifact) {
    // Expired or tombstoned pointers are optional retrieval state. Dense
    // retrieval remains authoritative until an administrator activates a
    // currently readable version.
    return {};
  }
  return {
    serverPolicyId: 'mirofish-research',
    graphArtifactIdentity: {
      documentId: pointer.identity.documentId,
      documentVersion: pointer.identity.documentVersion,
      trustLevel: pointer.identity.trustLevel,
    },
  };
}

function assertMiroFishTrustAllowed(
  trustLevel: RagTrustLevel,
  scope: RagRetrievalScope
): void {
  if (trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error('MiroFish graph trust level is outside the retrieval scope.');
  }
}

/**
 * 安全提取 LLM 响应内容
 * LangChain chat models 的 invoke() 返回 AIMessage 对象
 * content 可能是字符串或复杂类型，需要安全提取
 */
function extractLLMContent(response: unknown): string {
  // 如果已经是字符串，直接返回
  if (typeof response === 'string') {
    return response;
  }
  
  // 如果是 null 或 undefined，返回空字符串
  if (response == null) {
    return '';
  }
  
  // 如果有 content 属性（AIMessage 对象）
  if (typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    
    // content 是字符串
    if (typeof content === 'string') {
      return content;
    }
    
    // content 是数组（多部分消息）
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .filter(Boolean)
        .join('');
    }
    
    // content 是其他对象，尝试序列化
    if (typeof content === 'object') {
      return JSON.stringify(content);
    }
  }
  
  // 最后尝试序列化整个响应
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

export async function POST(request: NextRequest) {
  const suppliedRequestId = request.headers.get('x-request-id')?.trim();
  const requestId = suppliedRequestId
    && suppliedRequestId.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(suppliedRequestId)
    ? suppliedRequestId
    : crypto.randomUUID();
  try {
    throwIfRagRequestAborted(request.signal);
    const body = await readJsonObjectWithLimit(request, REQUEST_LIMITS.askJsonBytes);
    throwIfRagRequestAborted(request.signal);
    const {
      question,
      executionMode,
      topK,
      similarityThreshold,
      llmModel,
      embeddingModel,
      sessionId,
      requestedCorpusId,
      storageBackend,
      useAgenticRAG,
      useAdaptiveEntityRAG,
      maxRetries,
      enableReranking,
    } = validateAskInput(body);
    const securityContext = await resolveRagSecurityContext(request, {
      capability: executionMode === 'durable' ? 'manage-runtime' : 'query',
      requestedCorpusId,
      requestIdFactory: () => requestId,
    });
    throwIfRagRequestAborted(request.signal);
    const retrievalScope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });
    // Request identity is server-derived. Legacy body.userId/body.tenantId are ignored.
    const userId = securityContext.actorId;

    if (
      securityContext.enforceIsolation
      && storageBackend !== 'milvus'
    ) {
      throw new RequestValidationError(
        'UNSCOPED_RAG_POLICY',
        'The selected RAG policy cannot enforce the authenticated corpus scope.',
        409
      );
    }

    console.log(`[Ask API] 使用模型 - LLM: ${llmModel}, Embedding: ${embeddingModel}, 后端: ${storageBackend}, Agentic: ${useAgenticRAG}, AdaptiveEntity: ${useAdaptiveEntityRAG}`);

    const ragRequest: RagQueryRequest = {
      question,
      topK,
      similarityThreshold,
      llmModel,
      embeddingModel,
      storageBackend,
      userId,
      sessionId,
      useAgenticRAG,
      useAdaptiveEntityRAG,
      maxRetries,
      enableReranking,
      requestId,
      securityContext,
      retrievalScope,
      ...(await resolveServerMiroFishPolicy(question, retrievalScope)),
      raw: body,
    };

    const output = executionMode === 'durable'
      ? await executeDurableAskRequest({ request, ragRequest })
      : await executeAskKernelResponse({
          ragRequest,
          signal: request.signal,
        });

    throwIfRagRequestAborted(request.signal);
    return output;

  } catch (error) {
    console.error(`[Ask API] requestId=${requestId}`, createSafeAskErrorLog(error));
    const kernelFailure = error instanceof RagKernelExecutionError
      ? publicRagPolicyFailure(error, requestId)
      : undefined;
    const mapped = error instanceof RagRequestAbortedError || request.signal.aborted
      ? {
          status: 499,
          body: {
            error: { code: 'RAG_REQUEST_ABORTED', message: 'RAG 请求已取消' },
            requestId,
          },
        }
      : error instanceof RagSecurityError
      ? {
          status: error.status,
          body: { error: { code: error.code, message: error.message }, requestId: error.requestId },
        }
      : kernelFailure
        ?? publicErrorPayload(error, 'ASK_INTERNAL_ERROR', '处理问题时发生错误', requestId);
    const kernelTraceId =
      error instanceof RagKernelExecutionError
        ? error.envelope.trace_id
        : undefined;
    const response = NextResponse.json(
      {
        success: false,
        error: mapped.body.error.message,
        code: mapped.body.error.code,
        requestId,
        ...(kernelTraceId === undefined ? {} : { traceId: kernelTraceId }),
        ...(kernelFailure === undefined ? {} : { rag: kernelFailure.publicEnvelope }),
      },
      { status: mapped.status }
    );
    if (error instanceof RagKernelExecutionError) {
      assertRagResponseTrace(kernelTraceId, error.envelope);
      attachRagKernelHeaders(response.headers, error.envelope);
    }
    return response;
  }
}

export async function GET(request: NextRequest) {
  const requestId = resolveAskRequestId(request);
  try {
    const query = parseDurableAskQuery(request, true);
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'manage-runtime',
      requestedCorpusId: query.corpusId,
      requestIdFactory: () => requestId,
    });
    const retrievalScope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });
    const durable = await import('@/lib/rag/core/durable-ask-workflow');
    if (durable.resolveDurableAskMode() !== 'active') {
      throw new RequestValidationError(
        'DURABLE_ASK_DISABLED',
        'Durable ask execution is not enabled.',
        409
      );
    }
    const runtimeModule = await import(
      '@/lib/rag/core/durable-workflow-runtime'
    );
    const durableRuntime = runtimeModule.getDurableWorkflowRuntime();
    const threadId = query.threadId
      ?? durable.createDurableAskThreadId({
        integrityKey: durableRuntime.integrityKey,
        tenantId: securityContext.tenantId,
        corpusId: securityContext.corpusId,
        actorId: securityContext.actorId,
        idempotencyKey: durable.normalizeDurableAskIdempotencyKey(
          request.headers.get('idempotency-key')
        ),
      });
    const checkpoint = await durable.inspectDurableAsk({
      threadId,
      scope: retrievalScope,
      checkpointStore: durableRuntime.checkpointStore,
      resultStore: durableRuntime.resultStore,
      integrityKey: durableRuntime.integrityKey,
    });
    if (!checkpoint) {
      throw new RequestValidationError(
        'DURABLE_WORKFLOW_NOT_FOUND',
        'Durable ask workflow was not found.',
        404
      );
    }
    const responseBody: Record<string, unknown> = {
      success: true,
      durable: durable.projectDurableAskCheckpoint(checkpoint),
    };
    if (query.includeResult && checkpoint.status === 'completed') {
      const artifact = await durable.readDurableAskResult({
        checkpoint,
        resultStore: durableRuntime.resultStore,
        scope: retrievalScope,
      });
      responseBody.result = {
        status: artifact.result.status,
        headers: artifact.result.headers,
        body: artifact.result.body,
      };
    }
    const response = NextResponse.json(responseBody);
    attachDurableAskHeaders(response, {
      threadId,
      generationId: checkpoint.generationId,
      status: checkpoint.status,
      revision: checkpoint.revision,
      replay: true,
      resumed: true,
      provider: durableRuntime.checkpointStore.providerId,
      processPersistent:
        durableRuntime.checkpointStore.processPersistent,
    });
    return response;
  } catch (error) {
    return createDurableAskErrorResponse(error, requestId, request.signal);
  }
}

export async function PATCH(request: NextRequest) {
  const requestId = resolveAskRequestId(request);
  try {
    const query = parseDurableAskQuery(request, false);
    const body = await readJsonObjectWithLimit(request, 4 * 1024);
    const command = validateDurableAskManagementCommand(body);
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'manage-runtime',
      requestedCorpusId: query.corpusId,
      requestIdFactory: () => requestId,
    });
    const retrievalScope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });
    const durable = await import('@/lib/rag/core/durable-ask-workflow');
    if (durable.resolveDurableAskMode() !== 'active') {
      throw new RequestValidationError(
        'DURABLE_ASK_DISABLED',
        'Durable ask execution is not enabled.',
        409
      );
    }
    const runtimeModule = await import(
      '@/lib/rag/core/durable-workflow-runtime'
    );
    const durableRuntime = runtimeModule.getDurableWorkflowRuntime();
    if (command.action === 'delete') {
      const deleted = await durable.deleteDurableAsk({
        threadId: command.threadId,
        scope: retrievalScope,
        expectedRevision: command.expectedRevision,
        expectedGenerationId: command.expectedGenerationId,
        checkpointStore: durableRuntime.checkpointStore,
        resultStore: durableRuntime.resultStore,
        integrityKey: durableRuntime.integrityKey,
      });
      const response = NextResponse.json({
        success: true,
        status: 'deleted',
        deleted: true,
        checkpointDeleted: deleted.checkpointDeleted,
        cleanupResumed: deleted.cleanupResumed,
        resultDeleted: deleted.resultDeleted,
        resultDeletedCount: deleted.resultDeletedCount,
        generationId: deleted.generationId,
        cleanupAcknowledged: deleted.cleanupAcknowledged,
        ...(deleted.previousCheckpoint
          ? {
              previousDurable: {
                ...durable.projectDurableAskCheckpoint(
                  deleted.previousCheckpoint
                ),
                resultAvailable: false,
              },
            }
          : {}),
      });
      attachDurableAskHeaders(response, {
        threadId: command.threadId,
        generationId: command.expectedGenerationId,
        status: 'deleted',
        revision: command.expectedRevision,
        replay: false,
        resumed: deleted.cleanupResumed,
        provider: durableRuntime.checkpointStore.providerId,
        processPersistent:
          durableRuntime.checkpointStore.processPersistent,
      });
      return response;
    }
    let checkpoint;
    if (command.action === 'cancel') {
      checkpoint = await durable.cancelDurableAsk({
        threadId: command.threadId,
        scope: retrievalScope,
        expectedRevision: command.expectedRevision,
        expectedGenerationId: command.expectedGenerationId,
        checkpointStore: durableRuntime.checkpointStore,
        resultStore: durableRuntime.resultStore,
        integrityKey: durableRuntime.integrityKey,
      });
    } else {
      checkpoint = (await durable.recoverDurableAsk({
        threadId: command.threadId,
        scope: retrievalScope,
        expectedRevision: command.expectedRevision,
        expectedGenerationId: command.expectedGenerationId,
        checkpointStore: durableRuntime.checkpointStore,
        resultStore: durableRuntime.resultStore,
        integrityKey: durableRuntime.integrityKey,
      })).checkpoint;
    }
    const response = NextResponse.json({
      success: true,
      durable: durable.projectDurableAskCheckpoint(checkpoint),
    });
    attachDurableAskHeaders(response, {
      threadId: command.threadId,
      generationId: checkpoint.generationId,
      status: checkpoint.status,
      revision: checkpoint.revision,
      replay: false,
      resumed: command.action === 'recover',
      provider: durableRuntime.checkpointStore.providerId,
      processPersistent:
        durableRuntime.checkpointStore.processPersistent,
    });
    return response;
  } catch (error) {
    return createDurableAskErrorResponse(error, requestId, request.signal);
  }
}

function resolveAskRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied
    && supplied.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function parseDurableAskQuery(
  request: NextRequest,
  allowReadOptions: boolean
): {
  corpusId?: string;
  threadId?: string;
  includeResult: boolean;
} {
  const url = new URL(request.url);
  const allowed = new Set(
    allowReadOptions
      ? ['corpusId', 'threadId', 'includeResult']
      : ['corpusId']
  );
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new RequestValidationError(
        'UNKNOWN_FIELDS',
        'Unknown durable ask query field: ' + key + '.',
        400
      );
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new RequestValidationError(
        'DUPLICATE_QUERY_FIELD',
        'Durable ask query fields must not be repeated.',
        400
      );
    }
  }
  const corpusId = optionalDurableIdentifier(
    url.searchParams.get('corpusId'),
    'corpusId',
    128
  );
  const threadId = allowReadOptions
    ? optionalDurableIdentifier(
        url.searchParams.get('threadId'),
        'threadId',
        256
      )
    : undefined;
  const rawIncludeResult = allowReadOptions
    ? url.searchParams.get('includeResult')
    : null;
  if (
    rawIncludeResult !== null
    && rawIncludeResult !== 'true'
    && rawIncludeResult !== 'false'
  ) {
    throw new RequestValidationError(
      'INVALID_BOOLEAN',
      'includeResult must be true or false.',
      400
    );
  }
  return {
    ...(corpusId ? { corpusId } : {}),
    ...(threadId ? { threadId } : {}),
    includeResult: rawIncludeResult === 'true',
  };
}

function validateDurableAskManagementCommand(
  body: Record<string, unknown>
): {
  action: 'cancel' | 'recover' | 'delete';
  threadId: string;
  expectedRevision: number;
  expectedGenerationId: string;
} {
  const allowed = new Set([
    'action',
    'threadId',
    'expectedRevision',
    'expectedGenerationId',
  ]);
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(
      'UNKNOWN_FIELDS',
      'Unknown durable ask management fields: '
        + unknown.sort().join(', ')
        + '.',
      400
    );
  }
  if (
    body.action !== 'cancel'
    && body.action !== 'recover'
    && body.action !== 'delete'
  ) {
    throw new RequestValidationError(
      'INVALID_DURABLE_ACTION',
      'action must be cancel, recover, or delete.',
      400
    );
  }
  const threadId = optionalDurableIdentifier(
    typeof body.threadId === 'string' ? body.threadId : null,
    'threadId',
    256
  );
  if (!threadId) {
    throw new RequestValidationError(
      'INVALID_IDENTIFIER',
      'threadId is required.',
      400
    );
  }
  const expectedGenerationId = optionalDurableIdentifier(
    typeof body.expectedGenerationId === 'string'
      ? body.expectedGenerationId
      : null,
    'expectedGenerationId',
    128
  );
  if (!expectedGenerationId) {
    throw new RequestValidationError(
      'INVALID_IDENTIFIER',
      'expectedGenerationId is required.',
      400
    );
  }
  if (
    !Number.isInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 0
    || (body.expectedRevision as number) > Number.MAX_SAFE_INTEGER
  ) {
    throw new RequestValidationError(
      'INVALID_INTEGER',
      'expectedRevision must be a non-negative safe integer.',
      400
    );
  }
  return {
    action: body.action,
    threadId,
    expectedRevision: body.expectedRevision as number,
    expectedGenerationId,
  };
}

function optionalDurableIdentifier(
  value: string | null,
  field: string,
  maxLength: number
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > maxLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    throw new RequestValidationError(
      'INVALID_IDENTIFIER',
      field + ' contains unsupported characters.',
      400
    );
  }
  return normalized;
}

function createDurableAskErrorResponse(
  error: unknown,
  requestId: string,
  signal: AbortSignal
): NextResponse {
  const normalized = mapDurableAskExecutionError(error);
  const mapped = signal.aborted || normalized instanceof RagRequestAbortedError
    ? {
        status: 499,
        body: {
          error: {
            code: 'RAG_REQUEST_ABORTED',
            message: 'RAG 请求已取消',
          },
          requestId,
        },
      }
    : normalized instanceof RagSecurityError
      ? {
          status: normalized.status,
          body: {
            error: {
              code: normalized.code,
              message: normalized.message,
            },
            requestId: normalized.requestId,
          },
        }
      : publicErrorPayload(
          normalized,
          'DURABLE_ASK_INTERNAL_ERROR',
          'Durable ask operation failed.',
          requestId
        );
  return NextResponse.json({
    success: false,
    error: mapped.body.error.message,
    code: mapped.body.error.code,
    requestId,
  }, {
    status: mapped.status,
  });
}

async function executeAskKernelResponse(input: {
  ragRequest: RagQueryRequest;
  signal: AbortSignal;
  traceId?: string;
  threadId?: string;
}): Promise<NextResponse> {
  const securityContext = input.ragRequest.securityContext;
  if (!securityContext) {
    throw new Error('Ask workflow requires a server-derived security context.');
  }
  const {
    question,
    topK,
    similarityThreshold,
    llmModel,
    embeddingModel,
    storageBackend,
    useAgenticRAG = false,
    useAdaptiveEntityRAG = false,
    maxRetries = 2,
    enableReranking = true,
    sessionId,
  } = input.ragRequest;
  const userId = securityContext.actorId;
  const kernel = createAskKernel();
  const policyId = resolveRagPolicyId(input.ragRequest);
  return runWithLangSmithRootRun<NextResponse>(
    {
      name: 'RAG API Ask',
      runType: 'chain',
      route: '/api/ask',
      policyId,
      userId,
      sessionId,
      fallbackRunId: input.traceId ?? ('ask-' + Date.now()),
      inputs: {
        question,
        topK,
        similarityThreshold,
        storageBackend,
        useAgenticRAG,
        useAdaptiveEntityRAG,
      },
      metadata: {
        llm_model: llmModel,
        embedding_model: embeddingModel,
        vector_backend: storageBackend,
        tenant_id: securityContext.tenantId,
        corpus_id: securityContext.corpusId,
        max_retries: maxRetries,
        enable_reranking: enableReranking,
      },
      tags: ['rag', 'api-ask', policyId],
      output: (response) => ({
        status: response.status,
        ok: response.ok,
        rag_policy: policyId,
      }),
    },
    async (langSmithRun) => {
      const result = await invokeRagKernelWorkflow(kernel, {
        request: input.ragRequest,
        policyId,
        signal: input.signal,
        context: {
          name: 'RAG API Ask Workflow',
          route: '/api/ask',
          userId,
          sessionId,
          threadId: input.threadId ?? langSmithRun.threadId,
          traceId: input.traceId ?? langSmithRun.runId,
          tags: ['api-ask'],
          metadata: {
            llm_model: llmModel,
            embedding_model: embeddingModel,
            vector_backend: storageBackend,
            tenant_id: securityContext.tenantId,
            corpus_id: securityContext.corpusId,
            max_retries: maxRetries,
            enable_reranking: enableReranking,
          },
        },
      });
      throwIfRagRequestAborted(input.signal);
      attachRagKernelHeaders(result.output.headers, result.envelope);
      if (langSmithRun.enabled) {
        result.output.headers.set('x-langsmith-run-id', langSmithRun.runId);
        result.output.headers.set(
          'x-langsmith-thread-id',
          langSmithRun.threadId
        );
        result.output.headers.set(
          'x-langsmith-project',
          langSmithRun.projectName
        );
      }
      return result.output;
    }
  );
}

async function executeDurableAskRequest(input: {
  request: NextRequest;
  ragRequest: RagQueryRequest;
}): Promise<NextResponse> {
  try {
    const durable = await import('@/lib/rag/core/durable-ask-workflow');
    if (durable.resolveDurableAskMode() !== 'active') {
      throw new RequestValidationError(
        'DURABLE_ASK_DISABLED',
        'Durable ask execution is not enabled.',
        409
      );
    }
    const runtimeModule = await import(
      '@/lib/rag/core/durable-workflow-runtime'
    );
    const runtime = runtimeModule.getDurableWorkflowRuntime();
    const securityContext = input.ragRequest.securityContext;
    const retrievalScope = input.ragRequest.retrievalScope;
    if (!securityContext || !retrievalScope) {
      throw new Error(
        'Durable ask execution requires server-derived security scope.'
      );
    }
    const idempotencyKey = durable.normalizeDurableAskIdempotencyKey(
      input.request.headers.get('idempotency-key')
    );
    const threadId = durable.createDurableAskThreadId({
      integrityKey: runtime.integrityKey,
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      actorId: securityContext.actorId,
      idempotencyKey,
    });
    const policyId = resolveRagPolicyId(input.ragRequest);
    const digests = durable.createDurableAskDigests({
      integrityKey: runtime.integrityKey,
      query: input.ragRequest.question,
      requestProjection: {
        question: input.ragRequest.question,
        topK: input.ragRequest.topK,
        similarityThreshold: input.ragRequest.similarityThreshold,
        llmModel: input.ragRequest.llmModel,
        embeddingModel: input.ragRequest.embeddingModel,
        storageBackend: input.ragRequest.storageBackend,
        sessionId: input.ragRequest.sessionId ?? null,
        useAgenticRAG: input.ragRequest.useAgenticRAG === true,
        useAdaptiveEntityRAG:
          input.ragRequest.useAdaptiveEntityRAG === true,
        maxRetries: input.ragRequest.maxRetries ?? 2,
        enableReranking: input.ragRequest.enableReranking !== false,
        tenantId: securityContext.tenantId,
        corpusId: securityContext.corpusId,
        actorId: securityContext.actorId,
      },
      routingProjection: {
        policyId,
        orderedContextMode: resolveRagFeatureRolloutMode(
          'RAG_ORDERED_CONTEXT_MODE',
          'off'
        ),
        hybridMode: resolveMilvusHybridRolloutMode(),
        pdfVisualMode: resolvePdfMultimodalMode(),
        miroFishGraphMode: resolveRagFeatureRolloutMode(
          'RAG_MIROFISH_GRAPH_MODE',
          'off'
        ),
        graphArtifactIdentity: input.ragRequest.graphArtifactIdentity
          ? {
              documentId:
                input.ragRequest.graphArtifactIdentity.documentId,
              documentVersion:
                input.ragRequest.graphArtifactIdentity.documentVersion,
              trustLevel:
                input.ragRequest.graphArtifactIdentity.trustLevel,
            }
          : null,
      },
    });
    const result = await durable.invokeDurableAsk({
      identity: {
        threadId,
        idempotencyKey,
        scope: retrievalScope,
        ...digests,
      },
      checkpointStore: runtime.checkpointStore,
      resultStore: runtime.resultStore,
      integrityKey: runtime.integrityKey,
      signal: input.request.signal,
      adapterOptions: {
        leaseDurationMs: durable.resolveDurableAskLeaseDurationMs(),
      },
      async execute({ signal, stepExecutionId }) {
        const response = await executeAskKernelResponse({
          ragRequest: input.ragRequest,
          signal,
          traceId: stepExecutionId,
          threadId,
        });
        return projectAskResponseForDurable(
          response,
          durable.DURABLE_ASK_HTTP_RESULT_VERSION
        );
      },
    });
    const response = NextResponse.json(
      result.artifact.result.body,
      {
        status: result.artifact.result.status,
        headers: result.artifact.result.headers,
      }
    );
    attachDurableAskHeaders(response, {
      threadId,
      generationId: result.workflow.checkpoint.generationId,
      status: result.workflow.checkpoint.status,
      revision: result.workflow.checkpoint.revision,
      replay: result.workflow.idempotentReplay,
      resumed: result.workflow.resumed,
      provider: result.workflow.checkpointProvider,
      processPersistent: result.workflow.processPersistent,
    });
    return response;
  } catch (error) {
    throw mapDurableAskExecutionError(error);
  }
}

async function projectAskResponseForDurable(
  response: NextResponse,
  schemaVersion: 'rag-durable-ask-http-v1'
): Promise<import(
  '@/lib/rag/core/durable-ask-workflow'
).DurableAskStoredHttpResult> {
  const body = await response.clone().json();
  if (!isJsonObject(body)) {
    throw new Error('Ask response must be a JSON object for durable storage.');
  }
  const headers: Record<string, string> = {};
  const replayBody = sanitizeDurableAskReplayValue(body);
  for (const name of DURABLE_ASK_PERSISTED_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return {
    schemaVersion,
    status: response.status,
    headers,
    body: replayBody,
  };
}

function attachDurableAskHeaders(
  response: NextResponse,
  input: {
    threadId: string;
    generationId: string;
    status: string;
    revision: number;
    replay: boolean;
    resumed: boolean;
    provider: string;
    processPersistent: boolean;
  }
): void {
  response.headers.set('x-rag-durable-thread-id', input.threadId);
  response.headers.set('x-rag-durable-generation-id', input.generationId);
  response.headers.set('x-rag-durable-status', input.status);
  response.headers.set('x-rag-durable-revision', String(input.revision));
  response.headers.set('x-rag-durable-replay', String(input.replay));
  response.headers.set('x-rag-durable-resumed', String(input.resumed));
  response.headers.set('x-rag-durable-provider', input.provider);
  response.headers.set(
    'x-rag-durable-process-persistent',
    String(input.processPersistent)
  );
}

function mapDurableAskExecutionError(error: unknown): unknown {
  if (error instanceof RequestValidationError) return error;
  const code = findDurableAskExecutionErrorCode(error);
  switch (code) {
    case 'DURABLE_ASK_IDEMPOTENCY_KEY_INVALID':
      return new RequestValidationError(
        'DURABLE_ASK_IDEMPOTENCY_KEY_INVALID',
        'Durable ask requires a valid Idempotency-Key.',
        400
      );
    case 'DURABLE_WORKFLOW_BUSY':
      return new RequestValidationError(
        code,
        'The durable ask thread is already running.',
        409
      );
    case 'DURABLE_WORKFLOW_CANCELLED':
    case 'DURABLE_WORKFLOW_FAILED':
    case 'DURABLE_CHECKPOINT_CONFLICT':
    case 'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED':
    case 'DURABLE_ASK_RESULT_CONFLICT':
    case 'WORKFLOW_VERSION_MISMATCH':
    case 'SCOPE_MISMATCH':
    case 'DOCUMENT_ID_MISMATCH':
    case 'DOCUMENT_VERSION_MISMATCH':
    case 'IDEMPOTENCY_KEY_MISMATCH':
    case 'JOB_FINGERPRINT_MISMATCH':
      return new RequestValidationError(
        code,
        'The durable ask cannot resume from its current checkpoint.',
        409
      );
    case 'DURABLE_WORKFLOW_NOT_FOUND':
      return new RequestValidationError(
        code,
        'Durable ask workflow was not found.',
        404
      );
    case 'DURABLE_WORKFLOW_STEP_FAILED':
      return new RequestValidationError(
        'DURABLE_WORKFLOW_PAUSED',
        'The durable ask paused and can be resumed with the same request.',
        503
      );
    case 'DURABLE_ASK_RESULT_UNAVAILABLE':
    case 'DURABLE_ASK_RESULT_CAPACITY':
    case 'DURABLE_ASK_RESULT_INTEGRITY':
    case 'DURABLE_CHECKPOINT_INTEGRITY':
    case 'DURABLE_WORKFLOW_CONFIGURATION_INVALID':
    case 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED':
    case 'DURABLE_CHECKPOINT_SCAN_LIMIT':
    case 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED':
      return new RequestValidationError(
        code,
        'Durable ask persistence is unavailable.',
        503
      );
    default:
      return error;
  }
}

function findDurableAskExecutionErrorCode(
  error: unknown
): string | undefined {
  let current = error;
  let outerCode: string | undefined;
  const persistenceCodes = new Set([
    'DURABLE_ASK_RESULT_CAPACITY',
    'DURABLE_ASK_RESULT_CONFLICT',
    'DURABLE_ASK_RESULT_INTEGRITY',
    'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED',
    'DURABLE_CHECKPOINT_INTEGRITY',
    'DURABLE_CHECKPOINT_SCAN_LIMIT',
    'DURABLE_WORKFLOW_CONFIGURATION_INVALID',
    'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED',
  ]);
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    const code = 'code' in current && typeof current.code === 'string'
      ? current.code
      : undefined;
    if (!outerCode && code) outerCode = code;
    if (code && persistenceCodes.has(code)) return code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return outerCode;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeDurableAskReplayValue(value: unknown): DurableJsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Durable ask replay body must be a JSON object.');
  }
  const output = projectDurableAskScalarObject(
    value,
    DURABLE_ASK_REPLAY_TOP_LEVEL_KEYS,
    'response body'
  );
  if (typeof output.success !== 'boolean' || typeof output.answer !== 'string') {
    throw new Error('Durable ask replay body must contain success and answer.');
  }

  if (value.models !== undefined) {
    output.models = projectDurableAskScalarObject(
      value.models,
      DURABLE_ASK_REPLAY_MODEL_KEYS,
      'models'
    );
  }
  if (value.evidence !== undefined) {
    output.evidence = projectDurableAskObjectArray(
      value.evidence,
      DURABLE_ASK_REPLAY_EVIDENCE_KEYS,
      'evidence'
    );
  }
  if (value.laneExecutions !== undefined) {
    output.laneExecutions = projectDurableAskObjectArray(
      value.laneExecutions,
      DURABLE_ASK_REPLAY_LANE_EXECUTION_KEYS,
      'laneExecutions'
    );
  }
  if (value.execution !== undefined) {
    if (!isJsonObject(value.execution)) {
      throw new Error('Durable ask execution must be a JSON object.');
    }
    const execution = projectDurableAskScalarObject(
      value.execution,
      DURABLE_ASK_REPLAY_EXECUTION_KEYS,
      'execution'
    );
    if (value.execution.budget !== undefined) {
      execution.budget = projectDurableAskScalarObject(
        value.execution.budget,
        DURABLE_ASK_REPLAY_BUDGET_KEYS,
        'execution budget'
      );
    }
    output.execution = execution;
  }
  return output;
}

function projectDurableAskObjectArray(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): DurableJsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error('Durable ask ' + label + ' must be an array.');
  }
  return value.map((entry, index) => projectDurableAskScalarObject(
    entry,
    allowedKeys,
    label + '[' + index + ']'
  ));
}

function projectDurableAskScalarObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): DurableJsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Durable ask ' + label + ' must be a JSON object.');
  }
  const output: DurableJsonObject = {};
  for (const key of allowedKeys) {
    const item = value[key];
    if (item === undefined) continue;
    output[key] = cloneDurableAskScalarValue(item, label + '.' + key);
  }
  return output;
}

function cloneDurableAskScalarValue(
  value: unknown,
  label: string
): DurableJsonObject[string] {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (
    Array.isArray(value)
    && value.every(item => (
      item === null
      || typeof item === 'string'
      || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))
    ))
  ) {
    return [...value];
  }
  throw new Error('Durable ask ' + label + ' is not a replay-safe scalar.');
}

const DURABLE_ASK_REPLAY_TOP_LEVEL_KEYS = [
  'success',
  'answer',
  'storageBackend',
  'agenticMode',
  'adaptiveEntityMode',
  'traceId',
  'timestamp',
] as const;

const DURABLE_ASK_REPLAY_MODEL_KEYS = ['llm', 'embedding'] as const;

const DURABLE_ASK_REPLAY_EVIDENCE_KEYS = [
  'id',
  'documentId',
  'documentVersion',
  'page',
  'sectionPath',
  'startOffset',
  'endOffset',
  'retrievalScore',
  'rerankScore',
  'trustLevel',
  'laneId',
  'score',
] as const;

const DURABLE_ASK_REPLAY_LANE_EXECUTION_KEYS = [
  'laneId',
  'retriever',
  'status',
  'retrievedEvidenceIds',
  'retrievalQuality',
  'generationUtility',
  'uncertainty',
  'latencyMs',
  'inputTokens',
  'costUsd',
  'stopReason',
  'errorCode',
] as const;

const DURABLE_ASK_REPLAY_EXECUTION_KEYS = ['stopReason'] as const;
const DURABLE_ASK_REPLAY_BUDGET_KEYS = [
  'maxLanes',
  'maxEvidence',
  'maxDurationMs',
] as const;

const DURABLE_ASK_PERSISTED_HEADERS = [
  'x-rag-policy',
  'x-rag-trace-id',
  'x-rag-status',
  'x-langsmith-run-id',
  'x-langsmith-thread-id',
  'x-langsmith-project',
] as const;

function createAskKernel(): RagKernel<NextResponse> {
  return new RagKernel<NextResponse>([
    createRagPolicy({
      id: 'adaptive-entity',
      description: 'Adaptive entity-routing RAG backed by Milvus.',
      execute: context => handleAdaptiveEntityQuery(context),
    }),
    createRagPolicy({
      id: 'agentic',
      description: 'Agentic RAG backed by Milvus with retrieval grading.',
      execute: context => handleAgenticQuery(context),
    }),
    createRagPolicy({
      id: 'milvus-2step',
      description: 'Two-step Milvus dense-vector retrieval and generation.',
      execute: context => handleMilvusQuery(context),
    }),
    createRagPolicy({
      id: 'mirofish-research',
      description: 'Server-scoped dense retrieval with an optional MiroFish graph artifact lane.',
      execute: context => handleMilvusQuery(context),
    }),
    createRagPolicy({
      id: 'memory',
      description: 'Legacy in-memory vector store RAG path.',
      execute: context => handleMemoryQuery(context),
    }),
  ]);
}

async function handleMemoryQuery(policyContext: RagPolicyContext) {
  const { request: ragRequest, traceId, retrievalPlan } = policyContext;
  const retrievalScope = ragRequest.retrievalScope;
  if (!retrievalScope) {
    throw new Error('memory policy requires a server-derived local retrieval scope.');
  }
  throwIfRagRequestAborted(policyContext.signal);
  const ragSystem = await getRagSystem();
  throwIfRagRequestAborted(policyContext.signal);
  let retrievalDetails: Awaited<ReturnType<typeof ragSystem.similaritySearch>> | undefined;
  let context = '';
  let answer = '';
  const laneExecutor = new RagLaneExecutor([
    {
      type: 'memory',
      retriever: 'memory-vector-v1',
      async execute({ lane, signal }) {
        assertLaneNotAborted(signal);
        retrievalDetails = await ragSystem.similaritySearch(
          ragRequest.question,
          ragRequest.topK,
          ragRequest.similarityThreshold
        );
        assertLaneNotAborted(signal);
        const normalized = normalizeLegacyPolicyDocuments(
          retrievalDetails.searchResults.map(item => ({
            content: item.document.pageContent,
            metadata: item.document.metadata,
            score: item.similarity,
          }))
        );
        const evidence = adaptMilvusSearchResultsToEvidence(normalized, {
          laneId: lane.id,
          scope: retrievalScope,
        });
        return {
          evidence,
          stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
          metadata: { adapter: 'memory-vector-v1' },
        };
      },
    },
    {
      type: 'generation-only',
      retriever: 'memory-generation-v1',
      async execute({ priorEvidence, signal }) {
        assertLaneNotAborted(signal);
        const packed = composeEvidenceContextV2(priorEvidence, {
          maxTokens: retrievalPlan.context_budget_tokens ?? 4_000,
          includeScores: true,
          includeStructure: true,
          scope: retrievalScope,
        });
        context = packed.context;
        if (!context.trim()) {
          answer = '根据当前知识库无法回答该问题。';
        } else {
          const llm = createLLM(ragRequest.llmModel);
          const response = await llm.invoke(
            `你是一个专业的知识库助手。请只根据下方上下文回答问题；如果上下文不包含答案，请明确说不知道。\n\n上下文：\n${context}\n\n问题：${ragRequest.question}`,
            { signal }
          );
          assertLaneNotAborted(signal);
          answer = extractLLMContent(response);
        }
        return {
          evidence: [],
          stopReason: priorEvidence.length > 0 ? 'sufficient' : 'no_gain',
          metadata: {
            adapter: 'memory-generation-v1',
            context_evidence_ids: packed.includedEvidenceIds,
          },
        };
      },
    },
  ]);
  const laneResult = await laneExecutor.execute({
    request: ragRequest,
    plan: retrievalPlan,
    signal: policyContext.signal,
    budget: {
      maxLanes: retrievalPlan.lanes.length,
      maxEvidence: ragRequest.topK,
      maxDurationMs: 30_000,
    },
  });
  if (!retrievalDetails) throw new Error('Memory retrieval completed without details.');

  // 使用语义分析器进行深度分析
  const queryEmbedding = retrievalDetails.queryEmbedding;
  const queryAnalysis = analyzeQuery(
    ragRequest.question,
    queryEmbedding,
    ragRequest.embeddingModel,
    retrievalDetails.queryVectorizationTime || 0
  );

  const payload: RagAskSuccessPayload = {
    success: true,
    question: ragRequest.question,
    answer,
    storageBackend: 'memory',
    evidence: laneResult.evidence,
    laneExecutions: laneResult.laneExecutions,
    execution: {
      budget: laneResult.budget,
      stopReason: laneResult.stopReason,
    },
    models: {
      llm: ragRequest.llmModel,
      embedding: ragRequest.embeddingModel
    },
    retrievalDetails: {
      searchResults: retrievalDetails.searchResults.map(r => ({
        document: {
          content: r.document.pageContent,
          metadata: r.document.metadata
        },
        similarity: r.similarity,
        index: r.index
      })),
      queryEmbedding: queryEmbedding.slice(0, 10),
      threshold: retrievalDetails.threshold,
      topK: retrievalDetails.topK,
      totalDocuments: retrievalDetails.totalDocuments,
      searchTime: retrievalDetails.searchTime
    },
    queryAnalysis,
    context,
    traceId,
    timestamp: new Date().toISOString(),
  };
  assertRagResponseTrace(payload.traceId, traceId);
  const output = NextResponse.json(payload);
  return {
    output,
    retrievalPlan,
    evidence: laneResult.evidence,
    laneExecutions: laneResult.laneExecutions,
    execution: {
      state: 'completed' as const,
      transitions: createLegacyPolicyTransitions(laneResult, 'legacy_memory_completed'),
      budget: laneResult.budget,
      stopReason: laneResult.stopReason,
    },
    metadata: {
      adapter: 'memory-lane-v1',
      evidence_count: laneResult.evidence.length,
      generation_separation: 'real-lane',
      transition_timing: 'post-execution-projection',
    },
  };
}

// Milvus 查询处理
async function handleMilvusQuery(policyContext: RagPolicyContext) {
  const {
    request,
    policyId,
    traceId,
    retrievalPlan: baseRetrievalPlan,
  } = policyContext;
  const {
    question,
    topK,
    similarityThreshold,
    llmModel,
    embeddingModel,
    retrievalScope,
  } = request;
  if (!retrievalScope) {
    throw new Error('milvus-2step requires a server-derived retrieval scope.');
  }

  let queryEmbedding: number[] = [];
  let queryEmbeddingPromise: Promise<number[]> | undefined;
  let searchResults: MilvusSearchResult[] = [];
  let stats: CollectionStats | null | undefined;
  let vectorizationTime = 0;
  let searchTime = 0;
  let orderedReadTime = 0;
  const milvusConfig = getDefaultMilvusConfig();
  const orderedContextMode = resolveRagFeatureRolloutMode(
    'RAG_ORDERED_CONTEXT_MODE',
    'off'
  );
  let orderedSnapshot: OrderedCorpusSnapshot | undefined;
  const queryKind = classifyRetrievalQuery(question).queryKind;
  const hybridMode = resolveMilvusHybridRolloutMode();
  const orderedReadTimeoutMs = orderedContextMode === 'off'
    ? DEFAULT_ORDERED_CONTEXT_READ_TIMEOUT_MS
    : resolveRagProviderTimeoutMs(
        'RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS',
        DEFAULT_ORDERED_CONTEXT_READ_TIMEOUT_MS
      );
  const hybridProbeTimeoutMs = hybridMode === 'off'
    ? DEFAULT_HYBRID_PROBE_TIMEOUT_MS
    : resolveRagProviderTimeoutMs('RAG_HYBRID_PROBE_TIMEOUT_MS', DEFAULT_HYBRID_PROBE_TIMEOUT_MS);
  const hybridSearchTimeoutMs = hybridMode === 'off'
    ? DEFAULT_HYBRID_SEARCH_TIMEOUT_MS
    : resolveRagProviderTimeoutMs('RAG_HYBRID_SEARCH_TIMEOUT_MS', DEFAULT_HYBRID_SEARCH_TIMEOUT_MS);
  let hybridCapability: MilvusHybridCapability | undefined;
  let hybridPort: MilvusHybridSearchPort | undefined;
  let hybridCollectionName: string | undefined;
  if (queryKind === 'identifier' && hybridMode !== 'off') {
    const hybridConnectionConfig = getMilvusConnectionConfig();
    const hybridManifest = createMilvusHybridRuntimeManifest({
      sourceCollectionName: milvusConfig.collectionName || hybridConnectionConfig.defaultCollection,
      embeddingModel,
      embeddingDimension: milvusConfig.embeddingDimension || hybridConnectionConfig.defaultDimension,
    });
    const nativePort = getMilvusInstance(milvusConfig).createHybridSearchPort(hybridManifest);
    try {
      hybridCapability = await invokePreRouteProviderWithDeadline({
        operationKey: `milvus-hybrid-capability:${hybridManifest.collectionName}`,
        timeoutMs: hybridProbeTimeoutMs,
        signal: policyContext.signal,
        invoke: signal => nativePort.probe({
          collectionName: hybridManifest.collectionName,
          signal,
        }),
      });
    } catch (error) {
      if (error instanceof RagRequestAbortedError) throw error;
      const reason = isRagPreRouteProviderUnavailableError(error)
        ? error.code === 'RAG_PRE_ROUTE_PROVIDER_TIMEOUT'
          ? 'capability_probe_timeout'
          : 'capability_probe_busy'
        : 'capability_probe_failed';
      hybridCapability = {
        nativeHybridSearch: false,
        bm25Function: false,
        schemaCompatible: false,
        provider: 'milvus-native',
        reason,
      };
    }
    hybridCollectionName = hybridManifest.collectionName;
    hybridPort = {
      probe: async input => {
        if (input.collectionName !== hybridManifest.collectionName) {
          throw new Error('Hybrid collection does not match the server manifest.');
        }
        return hybridCapability!;
      },
      search: request => nativePort.search(request),
    };
  }
  const hybridCapabilityUsable = hybridCapability !== undefined
    && isHybridCapabilityUsable(hybridCapability);
  const pdfVisualMode = resolvePdfMultimodalMode();
  const pdfVisualIntent = isPdfVisualIntent(question);
  let pdfVisualModel: string | undefined;
  let pdfVisualHandler: RagLaneHandler | undefined;
  let pdfVisualCapabilityReason = pdfVisualMode === 'off'
    ? 'feature_off'
    : pdfVisualIntent
      ? 'model_unavailable'
      : 'text_intent';
  if (pdfVisualMode !== 'off' && pdfVisualIntent) {
    pdfVisualModel = resolvePdfVisualModel();
    if (pdfVisualModel) {
      try {
        const pdfVisualRuntime = getPdfVisualAssetRuntime();
        pdfVisualHandler = createPdfVisualLaneHandler({
          store: pdfVisualRuntime.store,
          mode: pdfVisualMode,
          model: pdfVisualModel,
        });
        pdfVisualCapabilityReason = 'ready';
      } catch (error) {
        if (
          error
          && typeof error === 'object'
          && 'code' in error
          && error.code === 'RAG_PDF_VISUAL_SHARED_STORE_REQUIRED'
        ) {
          pdfVisualCapabilityReason = 'topology_unavailable';
        } else {
          throw error;
        }
      }
    }
  }
  const pdfVisualCapabilityUsable = pdfVisualHandler !== undefined;

  if (queryKind === 'global' && orderedContextMode !== 'off') {
    const orderedReadStartedAt = Date.now();
    orderedSnapshot = await readBoundedOrderedCorpus({
      store: getMilvusInstance(milvusConfig),
      scope: retrievalScope,
      laneId: 'ordered-context-required',
      deadlineMs: orderedReadTimeoutMs,
      providerKey: `milvus-ordered-context:${milvusConfig.collectionName}`,
      signal: policyContext.signal,
    });
    orderedReadTime = Date.now() - orderedReadStartedAt;
  }
  const orderedCapabilityUsable = orderedSnapshot !== undefined
    && orderedSnapshot.reason !== 'schema_unavailable'
    && orderedSnapshot.reason !== 'provider_unavailable';
  const retrievalRoute = routeRetrievalQuery({
    query: question,
    capabilities: resolveRetrievalRouterCapabilities({
      hybrid: { mode: hybridMode, usable: hybridCapabilityUsable },
      orderedContext: {
        mode: orderedContextMode,
        usable: orderedCapabilityUsable,
      },
    }),
    ...(orderedSnapshot === undefined ? {} : { corpus: orderedSnapshot.inventory }),
    orderedContextLimits: { maxDocuments: 6, maxCharacters: 120_000 },
  });
  const retrievalPlan = createRoutedMilvusRetrievalPlan(baseRetrievalPlan, retrievalRoute, {
    hybridMode,
    hybridUsable: hybridCapabilityUsable,
    hybridLaneTimeoutMs: hybridSearchTimeoutMs,
    pdfVisualMode,
    pdfVisualUsable: pdfVisualCapabilityUsable,
    pdfVisualIntent,
  });
  const orderedEvidenceBudget = retrievalRoute.route === 'ordered-context'
    ? orderedSnapshot?.evidence.length ?? 0
    : 0;
  const textEvidenceBudget = retrievalRoute.route === 'ordered-context'
    ? orderedEvidenceBudget + (policyId === 'mirofish-research' ? topK : 0)
    : policyId === 'mirofish-research' ? topK * 2 : topK;
  const pdfVisualEvidenceBudget =
    pdfVisualMode === 'active' && pdfVisualCapabilityUsable
      ? Math.min(topK, 4)
      : 0;
  const budget = {
    maxLanes: Math.max(1, retrievalPlan.lanes.length),
    maxEvidence: textEvidenceBudget + pdfVisualEvidenceBudget,
    maxDurationMs: RAG_RETRIEVAL_EXECUTION_BUDGET_MS,
  };
  const getQueryEmbedding = async (signal: AbortSignal): Promise<number[]> => {
    if (!queryEmbeddingPromise) {
      const embeddingStartedAt = Date.now();
      const embeddings = getEmbeddingModel(embeddingModel);
      queryEmbeddingPromise = embeddings.embedQuery(question).then(value => {
        queryEmbedding = value;
        vectorizationTime = Date.now() - embeddingStartedAt;
        return value;
      });
    }
    const embedding = await queryEmbeddingPromise;
    assertLaneNotAborted(signal);
    return embedding;
  };

  const laneHandlers: RagLaneHandler[] = [
    {
      type: 'dense-vector',
      retriever: 'milvus-dense-v1',
      async execute({ lane, signal, priorEvidence }) {
        assertLaneNotAborted(signal);
        if (
          retrievalRoute.route === 'hybrid'
          && priorEvidence.some(item => item.laneId === 'hybrid-primary')
        ) {
          return {
            evidence: [],
            stopReason: 'sufficient',
            metadata: { skippedBecauseHybridSufficient: true },
          };
        }
        const milvus = getMilvusInstance(milvusConfig);
        await milvus.connect();
        assertLaneNotAborted(signal);
        await milvus.initializeCollection();
        assertLaneNotAborted(signal);

        queryEmbedding = await getQueryEmbedding(signal);

        const searchStartedAt = Date.now();
        searchResults = await milvus.search(
          queryEmbedding,
          topK,
          buildScopedMilvusSearchOptions(retrievalScope, {
            threshold: similarityThreshold,
          })
        );
        assertLaneNotAborted(signal);
        searchTime = Date.now() - searchStartedAt;
        if (!retrievalScope.enforceIsolation) {
          stats = await milvus.getCollectionStats();
          assertLaneNotAborted(signal);
        }

        const evidence = adaptMilvusSearchResultsToEvidence(searchResults, {
          laneId: lane.id,
          scope: retrievalScope,
        });
        return {
          evidence,
          stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
          metadata: {
            searchTime,
            vectorizationTime,
          },
        };
      },
    },
  ];
  if (hybridPort && hybridCollectionName && hybridCapabilityUsable) {
    const activeHybridPort = hybridPort;
    const activeHybridCollection = hybridCollectionName;
    laneHandlers.push(createMilvusHybridLaneHandler({
      port: activeHybridPort,
      collectionName: activeHybridCollection,
      mode: hybridMode,
      embedQuery: ({ signal }) => getQueryEmbedding(signal),
    }));
  }

  if (orderedSnapshot?.usable) {
    laneHandlers.push({
      type: 'ordered-context',
      retriever: 'milvus-ordered-corpus-v1',
      async execute({ lane, signal }) {
        assertLaneNotAborted(signal);
        searchResults = orderedSnapshot.searchResults;
        searchTime = orderedReadTime;
        const evidence = orderedSnapshot.evidence.map(item => ({
          ...item,
          laneId: lane.id,
          metadata: { ...item.metadata },
        }));
        return {
          evidence,
          stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
          metadata: {
            readerVersion: orderedSnapshot.version,
            inventory: orderedSnapshot.inventory,
            readTime: orderedReadTime,
          },
        };
      },
    });
  }
  if (policyId === 'mirofish-research' && request.graphArtifactIdentity) {
    laneHandlers.push(createGraphEntityLaneHandler({
      store: getMiroFishGraphArtifactRuntime().store,
      defaultMaxHops: 2,
      maxEvidence: topK,
    }));
  }
  if (pdfVisualHandler) {
    laneHandlers.push(pdfVisualHandler);
  }
  const laneExecutor = new RagLaneExecutor(laneHandlers);

  const laneResult = await laneExecutor.execute({
    request,
    plan: retrievalPlan,
    signal: policyContext.signal,
    budget,
  });
  const abstentionMode = resolveRagFeatureRolloutMode(
    'RAG_ABSTENTION_MODE',
    'shadow'
  );
  const denseLaneId = retrievalPlan.lanes.find(lane => lane.type === 'dense-vector')?.id;
  const orderedLaneId = retrievalPlan.lanes.find(lane => lane.type === 'ordered-context')?.id;
  if (!denseLaneId && !orderedLaneId) {
    throw new Error('milvus-2step plan is missing its primary retrieval lane.');
  }
  const graphLaneId = retrievalPlan.lanes.find(lane => lane.type === 'graph-entity')?.id;
  const hybridLaneId = retrievalPlan.lanes.find(lane => lane.type === 'sparse-bm25')?.id;
  const visualLaneId = retrievalPlan.lanes.find(lane => lane.type === 'visual-page')?.id;
  const laneKinds: Record<string, 'dense' | 'ordered' | 'hybrid' | 'graph' | 'visual'> = {
    ...(denseLaneId ? { [denseLaneId]: 'dense' as const } : {}),
    ...(orderedLaneId ? { [orderedLaneId]: 'ordered' as const } : {}),
    ...(hybridLaneId ? { [hybridLaneId]: 'hybrid' as const } : {}),
    ...(graphLaneId ? { [graphLaneId]: 'graph' as const } : {}),
    ...(visualLaneId ? { [visualLaneId]: 'visual' as const } : {}),
  };
  const calibrationLanes: Record<
    string,
    { minimumScore: number; scoreField: 'retrieval'; allowMissingScore?: boolean }
  > = {
    ...(denseLaneId ? {
      [denseLaneId]: {
        minimumScore: resolveDenseAbstentionThreshold(similarityThreshold),
        scoreField: 'retrieval' as const,
      },
    } : {}),
    ...(orderedLaneId ? {
      [orderedLaneId]: {
        minimumScore: 0,
        scoreField: 'retrieval' as const,
        allowMissingScore: true,
      },
    } : {}),
    ...(hybridLaneId
      ? { [hybridLaneId]: { minimumScore: 0, scoreField: 'retrieval' as const } }
      : {}),
    ...(graphLaneId
      ? { [graphLaneId]: { minimumScore: 0, scoreField: 'retrieval' as const } }
      : {}),
    ...(visualLaneId
      ? {
          [visualLaneId]: {
            minimumScore: 0,
            scoreField: 'retrieval' as const,
            allowMissingScore: true,
          },
        }
      : {}),
  };
  const abstention = decideRagAbstention({
    queryKind: retrievalRoute.queryKind,
    evidence: laneResult.evidence,
    laneKinds,
    calibration: {
      version: [
        'milvus',
        orderedLaneId ? 'ordered' : 'dense',
        graphLaneId ? 'graph' : undefined,
        hybridLaneId ? 'hybrid' : undefined,
        visualLaneId ? 'visual' : undefined,
        'calibration-v1',
      ].filter(Boolean).join('-'),
      lanes: calibrationLanes,
    },
    minimumDistinctDocuments: resolveMinimumDistinctDocuments(retrievalRoute.queryKind),
  });
  const generationContext = prepareMilvusGenerationContext({
    evidence: laneResult.evidence,
    abstentionMode,
    abstention,
    maxTokens: retrievalPlan.context_budget_tokens ?? 4_000,
    order: retrievalRoute.route === 'ordered-context' ? 'document' : 'retrieval',
    scope: retrievalScope,
  });
  const { contextPack } = generationContext;
  const context = contextPack.context;
  const activeAbstention = abstentionMode === 'active' && abstention.abstain;
  const cacheIdentityBase = {
    tenantId: retrievalScope.tenantId,
    corpusId: retrievalScope.corpusId,
    corpusVersion: process.env.RAG_CORPUS_VERSION?.trim() || 'live-corpus-v1',
    contextDigest: createRagContextDigest(context),
    documentVersions: generationContext.cacheDimensions.documentVersions,
    evidenceFingerprints: generationContext.cacheDimensions.evidenceFingerprints,
    schemaVersion: 'milvus-tenant-schema-v2',
    indexVersion:
      process.env.RAG_MILVUS_INDEX_VERSION?.trim() ||
      [
        milvusConfig.collectionName,
        milvusConfig.indexType,
        milvusConfig.embeddingDimension,
      ].join(':'),
    embeddingModel,
    policyId,
    fusionVersion: [
      (orderedLaneId ? 'ordered' : 'dense')
        + (policyId === 'mirofish-research' ? '-graph-optional-v1' : '-only-v1'),
      retrievalRoute.version,
      retrievalRoute.route,
      `hybrid:${hybridMode}:${hybridCollectionName ?? 'none'}:${hybridCapabilityUsable}`,
      `pdf-visual:${pdfVisualMode}:${pdfVisualModel ?? 'none'}:${pdfVisualCapabilityUsable}:pdf-asset-manifest-v1`,
      `abstention:${abstentionMode}:${abstention.calibrationVersion}`,
    ].join(':'),
  };
  const contextCacheIdentity = createRagCacheIdentity({
    ...cacheIdentityBase,
    kind: 'context',
    llmModel: 'none',
    promptVersion: 'context-composer-v2',
  });
  const answerCacheIdentity = createRagCacheIdentity({
    ...cacheIdentityBase,
    kind: 'answer',
    llmModel,
    promptVersion: 'milvus-answer-prompt-v2',
  });
  const generationStartedAt = new Date().toISOString();
  let answer: string;
  let llmTime = 0;
  if (!context.trim()) {
    answer = '根据当前知识库无法回答该问题。';
  } else if (activeAbstention) {
    answer = '当前检索证据未达到可回答阈值，暂不生成推测性答案。';
  } else {
    const llm = createLLM(llmModel);
    const prompt = createMilvusAnswerPrompt({ question, context });
    const llmStartedAt = Date.now();
    const response = await invokeGenerationWithDeadline({
      modelKey: `answer:${llmModel}`,
      timeoutMs: 30_000,
      signal: policyContext.signal,
      invoke: signal => llm.invoke(prompt, { signal }),
    });
    answer = extractLLMContent(response);
    llmTime = Date.now() - llmStartedAt;
  }
  const queryAnalysis = analyzeQuery(
    question,
    queryEmbedding,
    embeddingModel,
    vectorizationTime
  );
  const transitions = createAnswerExecutionTransitions({
    laneTransitions: laneResult.transitions,
    hasEvidence: laneResult.evidence.length > 0,
    hasContext: Boolean(context.trim()),
    activeAbstention,
    generationStartedAt,
    completedAt: new Date().toISOString(),
    stopReason: laneResult.stopReason,
  });
  const payload: RagAskSuccessPayload = {
    success: true,
    question,
    answer,
    models: {
      llm: llmModel,
      embedding: embeddingModel,
    },
    storageBackend: 'milvus',
    evidence: laneResult.evidence,
    laneExecutions: laneResult.laneExecutions,
    execution: {
      budget: laneResult.budget,
      stopReason: laneResult.stopReason,
    },
    cacheIdentity: {
      version: answerCacheIdentity.version,
      context: contextCacheIdentity.key,
      answer: answerCacheIdentity.key,
    },
    retrievalDetails: {
      searchResults: searchResults.map((result, index) => ({
        document: {
          id: result.id,
          content: result.content,
          metadata: result.metadata,
        },
        similarity: result.score,
        distance: result.distance,
        index,
      })),
      queryEmbedding: queryEmbedding.slice(0, 10),
      threshold: similarityThreshold,
      topK,
      totalDocuments: retrievalRoute.route === 'ordered-context'
        ? orderedSnapshot?.inventory.documentCount ?? 0
        : retrievalScope.enforceIsolation
          ? searchResults.length
          : stats?.rowCount || 0,
      searchTime,
      vectorizationTime,
      llmTime,
      retrievalRoute,
      hybrid: {
        requestedMode: hybridMode,
        probed: hybridCapability !== undefined,
        usable: hybridCapabilityUsable,
        active: retrievalRoute.route === 'hybrid',
        collectionName: hybridCollectionName,
        capability: hybridCapability && {
          nativeHybridSearch: hybridCapability.nativeHybridSearch,
          bm25Function: hybridCapability.bm25Function,
          schemaCompatible: hybridCapability.schemaCompatible,
          provider: hybridCapability.provider,
          serverVersion: hybridCapability.serverVersion,
          reason: hybridCapability.reason,
        },
      },
      pdfVisual: {
        requestedMode: pdfVisualMode,
        requestedVisual: pdfVisualIntent,
        usable: pdfVisualCapabilityUsable,
        active: pdfVisualMode === 'active' && pdfVisualCapabilityUsable,
        capabilityReason: pdfVisualCapabilityReason,
        evidenceCount: visualLaneId
          ? laneResult.evidence.filter(item => item.laneId === visualLaneId).length
          : 0,
        diagnostics: visualLaneId
          ? laneResult.laneExecutions.find(item => item.laneId === visualLaneId)?.metadata
          : undefined,
      },
      contextPacking: {
        version: contextPack.version,
        order: contextPack.order,
        tokenEstimate: contextPack.tokenEstimate,
        includedEvidenceIds: contextPack.includedEvidenceIds,
        excludedEvidenceIds: contextPack.excludedEvidenceIds,
        truncated: contextPack.truncated,
        requestedRolloutMode: orderedContextMode,
        active: retrievalRoute.route === 'ordered-context',
        activationReason: retrievalRoute.reason,
        readerVersion: orderedSnapshot?.version,
        readerReason: orderedSnapshot?.reason,
        readerInventory: orderedSnapshot?.inventory,
        orderedReadTime,
      },
      abstention: {
        mode: abstentionMode,
        ...abstention,
      },
      ...(retrievalScope.enforceIsolation ? {} : { milvusStats: stats }),
    },
    queryAnalysis,
    context,
    traceId,
    timestamp: new Date().toISOString(),
  };
  assertRagResponseTrace(payload.traceId, traceId);
  const output = NextResponse.json(payload);

  return {
    output,
    retrievalPlan,
    evidence: laneResult.evidence,
    laneExecutions: laneResult.laneExecutions,
    execution: {
      state: 'completed' as const,
      transitions,
      budget: laneResult.budget,
      stopReason: laneResult.stopReason,
    },
    metadata: {
      evidence_count: laneResult.evidence.length,
      context_cache_identity: contextCacheIdentity.key,
      answer_cache_identity: answerCacheIdentity.key,
      retrieval_route: retrievalRoute,
      context_pack_version: contextPack.version,
      abstention_mode: abstentionMode,
      abstention_decision: abstention,
      executed_lane_count: laneResult.laneExecutions.filter(
        lane => lane.status === 'completed'
      ).length,
    },
  };
}

// Agentic RAG 查询处理
async function handleAgenticQuery(
  policyContext: RagPolicyContext
) {
  const { request, traceId, retrievalPlan } = policyContext;
  const {
    question,
    topK,
    similarityThreshold,
    llmModel,
    embeddingModel,
    retrievalScope,
  } = request;
  if (!retrievalScope) {
    throw new Error('agentic policy requires a server-derived retrieval scope.');
  }
  const maxRetries = request.maxRetries ?? 2;
  const milvusConfig = getDefaultMilvusConfig();
  let result: AgentState | undefined;
  let legacyPromise: Promise<AgentState> | undefined;
  let normalizedResults: MilvusSearchResult[] = [];
  let legacyFailure: string | undefined;

  const executeLegacy = (signal?: AbortSignal): Promise<AgentState> => {
    if (result) return Promise.resolve(result);
    if (legacyPromise) return legacyPromise;
    const pending = (async () => {
      signal?.throwIfAborted();
      const agenticRAG = new AgenticRAGSystem({
        llmModel,
        embeddingModel,
        milvusConfig: {
          address: milvusConfig.address,
          collectionName: milvusConfig.collectionName,
        },
        enableHallucinationCheck: true,
        enableSemanticCache: false,
        retrievalScope,
      });
      const candidate = await agenticRAG.query(question, {
        topK,
        similarityThreshold,
        maxRetries,
        skipSemanticCache: true,
        signal,
      });
      signal?.throwIfAborted();
      legacyFailure = resolveAgenticLegacyFailure({
        error: candidate.error,
        workflowSteps: candidate.workflowSteps,
        retrievedDocumentCount: candidate.retrievedDocuments.length,
      });
      result = candidate;
      normalizedResults = normalizeLegacyPolicyDocuments(
        candidate.retrievedDocuments.map(document => ({
          content: document.content,
          metadata: document.metadata,
          score: document.score,
          rerankScore: document.rerankScore ?? document.relevanceScore,
        }))
      );
      return candidate;
    })();
    legacyPromise = pending;
    void pending.finally(() => {
      if (legacyPromise === pending) legacyPromise = undefined;
    }).catch(() => undefined);
    return pending;
  };

  try {
    const laneExecutor = new RagLaneExecutor([
      {
        type: 'dense-vector',
        retriever: 'legacy-agentic-retrieval-v1',
        async execute({ lane, signal }) {
          assertLaneNotAborted(signal);
          const legacy = await executeLegacy(signal);
          assertLaneNotAborted(signal);
          const evidence = adaptMilvusSearchResultsToEvidence(normalizedResults, {
            laneId: lane.id,
            scope: retrievalScope,
          });
          return {
            evidence,
            retrievalQuality: legacy.retrievalQuality?.overallScore,
            stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
            metadata: {
              adapter: 'legacy-agentic-strangler-v1',
              retry_count: legacy.retryCount,
              legacy_workflow_includes_generation: true,
              phase_timing: 'legacy-workflow-projection',
            },
          };
        },
      },
      {
        type: 'rerank',
        retriever: 'legacy-agentic-grader-v1',
        async execute({ priorEvidence, signal }) {
          assertLaneNotAborted(signal);
          const legacy = await executeLegacy(signal);
          const rerankScores = Object.fromEntries(
            normalizedResults.map((item, index) => {
              const document = legacy.retrievedDocuments[index];
              const score = document?.rerankScore
                ?? document?.relevanceScore
                ?? document?.score;
              return [item.id, score];
            })
          );
          return {
            evidence: [],
            transform: createLegacyEvidenceTransform(
              priorEvidence,
              normalizedResults.map(item => item.id),
              rerankScores
            ),
            retrievalQuality: legacy.retrievalQuality?.overallScore,
            stopReason: priorEvidence.length > 0 ? 'sufficient' : 'no_gain',
            metadata: {
              adapter: 'legacy-agentic-grader-v1',
              retry_count: legacy.retryCount,
            },
          };
        },
      },
      {
        type: 'generation-only',
        retriever: 'legacy-agentic-generation-v1',
        async execute({ priorEvidence, signal }) {
          assertLaneNotAborted(signal);
          const legacy = await executeLegacy(signal);
          if (legacyFailure) throw new Error(legacyFailure);
          if (!legacy.answer.trim()) {
            throw new Error('Agentic legacy generation returned an empty answer.');
          }
          return {
            evidence: [],
            stopReason: priorEvidence.length > 0 ? 'sufficient' : 'no_gain',
            metadata: {
              adapter: 'legacy-agentic-generation-projection-v1',
              answer_length: legacy.answer.length,
              projection_only: true,
            },
          };
        },
      },
    ]);
    const laneResult = await laneExecutor.execute({
      request,
      plan: retrievalPlan,
      signal: policyContext.signal,
      budget: {
        maxLanes: retrievalPlan.lanes.length,
        maxEvidence: topK,
        maxDurationMs: 45_000,
      },
    });
    const completed = result ?? await executeLegacy(policyContext.signal);

    const payload: RagAskSuccessPayload = {
      success: true,
      question,
      answer: completed.answer,
      models: {
        llm: llmModel,
        embedding: embeddingModel,
      },
      storageBackend: 'milvus',
      agenticMode: true,
      evidence: laneResult.evidence,
      laneExecutions: laneResult.laneExecutions,
      execution: {
        budget: laneResult.budget,
        stopReason: laneResult.stopReason,
      },
      
      // 工作流信息
      workflow: {
        steps: completed.workflowSteps,
        totalDuration: completed.totalDuration,
        retryCount: completed.retryCount,
      },
      
      // 查询分析
      queryAnalysis: completed.queryAnalysis,
      
      // 检索详情
      retrievalDetails: {
        searchResults: completed.retrievedDocuments.map((doc, i) => {
          const scoredDocument = doc as AgenticRetrievedDocument;

          return {
            document: {
              content: scoredDocument.content,
              metadata: scoredDocument.metadata,
            },
            similarity: scoredDocument.score,
            relevanceScore: scoredDocument.relevanceScore,
            factualScore: scoredDocument.factualScore,
            index: i,
          };
        }),
        quality: completed.retrievalQuality,
        selfReflection: completed.selfReflection,
        totalDocuments: completed.retrievedDocuments.length,
        // 添加标准字段以兼容前端显示
        threshold: similarityThreshold,
        topK: topK,
        searchTime: completed.workflowSteps?.find((step: { step?: string; duration?: number }) => step.step === '文档检索')?.duration || 0,
      },
      
      // 幻觉检查
      hallucinationCheck: completed.hallucinationCheck,
      
      context: completed.context,
      traceId,
      timestamp: new Date().toISOString(),
    };
    assertRagResponseTrace(payload.traceId, traceId);
    const output = NextResponse.json(payload);
    return {
      output,
      retrievalPlan,
      evidence: laneResult.evidence,
      laneExecutions: laneResult.laneExecutions,
      execution: {
        state: 'completed' as const,
        transitions: createLegacyPolicyTransitions(laneResult, 'legacy_agentic_completed'),
        budget: laneResult.budget,
        stopReason: laneResult.stopReason,
      },
      metadata: {
        adapter: 'legacy-agentic-strangler-v1',
        evidence_count: laneResult.evidence.length,
        retry_count: completed.retryCount,
        generation_separation: 'projection-only',
        phase_timing: 'legacy-workflow-projection',
      },
    };

  } catch (error) {
    console.error('[Agentic RAG Error]', createSafeAskErrorLog(error));
    throw error;
  }
}

// 自适应实体路由 RAG 查询处理
async function handleAdaptiveEntityQuery(
  policyContext: RagPolicyContext
) {
  const { request, traceId, retrievalPlan } = policyContext;
  const {
    question,
    topK,
    llmModel,
    embeddingModel,
    similarityThreshold,
    retrievalScope,
  } = request;
  if (!retrievalScope) {
    throw new Error('adaptive-entity policy requires a server-derived retrieval scope.');
  }
  const maxRetries = request.maxRetries ?? 2;
  const enableReranking = request.enableReranking ?? true;
  const milvusConfig = getDefaultMilvusConfig();
  let result: AdaptiveWorkflowState | undefined;
  let legacyPromise: Promise<AdaptiveWorkflowState> | undefined;
  let normalizedResults: MilvusSearchResult[] = [];
  let legacyFailure: string | undefined;

  const executeLegacy = (signal?: AbortSignal): Promise<AdaptiveWorkflowState> => {
    if (result) return Promise.resolve(result);
    if (legacyPromise) return legacyPromise;
    const pending = (async () => {
      signal?.throwIfAborted();
      const adaptiveRAG = createAdaptiveEntityRAG({
        llmModel,
        embeddingModel,
        maxRetries,
        enableReranking,
        similarityThreshold,
        milvusCollection: milvusConfig.collectionName,
        retrievalScope,
      });
      let candidate: AdaptiveWorkflowState;
      try {
        candidate = await adaptiveRAG.query(question, topK, signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (!(error instanceof AdaptiveEntityRAGExecutionError)) throw error;
        candidate = error.state;
        legacyFailure = error.message;
      }
      signal?.throwIfAborted();
      result = candidate;
      const evidenceResults = candidate.rankedResults.length > 0
        ? candidate.rankedResults
        : candidate.searchResults.map(item => ({
            ...item,
            rerankedScore: item.score,
            relevanceExplanation: 'legacy workflow stopped before reranking',
          }));
      normalizedResults = normalizeLegacyPolicyDocuments(
        evidenceResults.map(item => ({
          id: item.id,
          content: item.content,
          metadata: item.metadata,
          score: item.score,
          rerankScore: item.rerankedScore,
        }))
      );
      return candidate;
    })();
    legacyPromise = pending;
    void pending.finally(() => {
      if (legacyPromise === pending) legacyPromise = undefined;
    }).catch(() => undefined);
    return pending;
  };

  try {
    console.log('[Adaptive Entity RAG] 处理查询', { questionLength: question.length });
    const startTime = Date.now();
    const laneExecutor = new RagLaneExecutor([
      {
        type: 'dense-vector',
        retriever: 'legacy-adaptive-candidates-v1',
        async execute({ lane, signal }) {
          assertLaneNotAborted(signal);
          await executeLegacy(signal);
          assertLaneNotAborted(signal);
          const evidence = adaptMilvusSearchResultsToEvidence(normalizedResults, {
            laneId: lane.id,
            scope: retrievalScope,
          });
          return {
            evidence,
            stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
            metadata: {
              adapter: 'legacy-adaptive-strangler-v1',
              legacy_workflow_includes_generation: true,
              phase_timing: 'legacy-workflow-projection',
              structured_filter_mode: retrievalScope.enforceIsolation
                ? 'server-scope-only'
                : 'legacy-local',
            },
          };
        },
      },
      {
        type: 'rerank',
        retriever: 'legacy-adaptive-reranker-v1',
        async execute({ priorEvidence, signal }) {
          assertLaneNotAborted(signal);
          const legacy = await executeLegacy(signal);
          const rerankScores = Object.fromEntries(
            normalizedResults.map((item, index) => [
              item.id,
              legacy.rankedResults[index]?.rerankedScore,
            ])
          );
          return {
            evidence: [],
            transform: createLegacyEvidenceTransform(
              priorEvidence,
              normalizedResults.map(item => item.id),
              rerankScores
            ),
            stopReason: priorEvidence.length > 0 ? 'sufficient' : 'no_gain',
            metadata: {
              adapter: 'legacy-adaptive-reranker-v1',
              enabled: enableReranking,
            },
          };
        },
      },
      {
        type: 'generation-only',
        retriever: 'legacy-adaptive-generation-v1',
        async execute({ priorEvidence, signal }) {
          assertLaneNotAborted(signal);
          const legacy = await executeLegacy(signal);
          if (legacyFailure) throw new Error(legacyFailure);
          if (!legacy.finalResponse.trim()) {
            throw new Error('Adaptive legacy generation returned an empty answer.');
          }
          return {
            evidence: [],
            stopReason: priorEvidence.length > 0 ? 'sufficient' : 'no_gain',
            metadata: {
              adapter: 'legacy-adaptive-generation-projection-v1',
              answer_length: legacy.finalResponse.length,
              projection_only: true,
            },
          };
        },
      },
    ]);
    const laneResult = await laneExecutor.execute({
      request,
      plan: retrievalPlan,
      signal: policyContext.signal,
      budget: {
        maxLanes: retrievalPlan.lanes.length,
        maxEvidence: topK,
        maxDurationMs: 45_000,
      },
    });
    const completed = result ?? await executeLegacy(policyContext.signal);
    const duration = Date.now() - startTime;

    console.log(`[Adaptive Entity RAG] 查询完成, 耗时 ${duration}ms`);

    // 确保 query 对象存在且有必要的字段
    const queryData = completed.query || {};

    const payload: RagAskSuccessPayload = {
      success: true,
      question,
      answer: completed.finalResponse || '',
      models: {
        llm: llmModel,
        embedding: embeddingModel,
      },
      storageBackend: 'milvus',
      adaptiveEntityMode: true,
      evidence: laneResult.evidence,
      laneExecutions: laneResult.laneExecutions,
      execution: {
        budget: laneResult.budget,
        stopReason: laneResult.stopReason,
      },
      
      // 工作流信息
      workflow: {
        steps: completed.steps || [],
        totalDuration: completed.totalDuration || duration,
      },
      
      // 查询分析（认知解析层输出）- 确保所有字段都有默认值
      queryAnalysis: {
        originalQuery: queryData.originalQuery || question,
        intent: queryData.intent || 'factual',
        complexity: queryData.complexity || 'simple',
        confidence: queryData.confidence ?? 0.8,
        entities: queryData.entities || [],
        logicalRelations: queryData.logicalRelations || [],
        keywords: queryData.keywords || [],
      },
      
      // 实体校验结果
      entityValidation: (completed.validatedEntities || []).map(e => ({
        name: e.name,
        type: e.type,
        normalizedName: e.normalizedName,
        isValid: e.isValid,
        matchScore: e.matchScore,
        suggestions: e.suggestions,
      })),
      
      // 路由决策 - 确保有默认值
      routingDecision: {
        action: retrievalScope.enforceIsolation
          ? 'semantic_search'
          : completed.currentDecision?.action || 'semantic_search',
        requestedAction: completed.currentDecision?.action || 'semantic_search',
        reason: retrievalScope.enforceIsolation
          ? '认证模式仅应用服务器作用域；实体约束只用于查询增强和结果打分。'
          : completed.currentDecision?.reason || '默认语义检索',
        constraints: retrievalScope.enforceIsolation
          ? []
          : completed.currentDecision?.constraints || [],
        requestedConstraints: completed.currentDecision?.constraints || [],
        structuredConstraintsApplied: didApplyStructuredConstraints({
          enforceIsolation: retrievalScope.enforceIsolation,
          action: completed.currentDecision?.action,
          constraints: completed.currentDecision?.constraints,
        }),
        relaxedConstraints: completed.currentDecision?.relaxedConstraints || [],
        retryCount: completed.currentDecision?.retryCount || 0,
      },
      
      // 检索详情
      retrievalDetails: {
        searchResults: (completed.rankedResults || []).map((r, i) => ({
          document: {
            content: r.content,
            metadata: r.metadata,
          },
          similarity: r.score,
          rerankedScore: r.rerankedScore,
          relevanceExplanation: r.relevanceExplanation,
          matchType: r.matchType,
          index: i,
        })),
        searchResultCount: (completed.searchResults || []).length,
        rankedResultCount: (completed.rankedResults || []).length,
        topResults: (completed.rankedResults || []).slice(0, 3).map(r => ({
          id: r.id,
          score: r.score,
          rerankedScore: r.rerankedScore,
          relevanceExplanation: r.relevanceExplanation,
          contentPreview: r.content.substring(0, 200) + (r.content.length > 200 ? '...' : ''),
          matchType: r.matchType,
        })),
        totalDocuments: (completed.rankedResults || []).length,
        topK: topK,
      },
      
      context: (completed.rankedResults || []).map(r => r.content).join('\n\n'),
      traceId,
      timestamp: new Date().toISOString(),
      duration,
    };
    assertRagResponseTrace(payload.traceId, traceId);
    const output = NextResponse.json(payload);
    return {
      output,
      retrievalPlan,
      evidence: laneResult.evidence,
      laneExecutions: laneResult.laneExecutions,
      execution: {
        state: 'completed' as const,
        transitions: createLegacyPolicyTransitions(laneResult, 'legacy_adaptive_completed'),
        budget: laneResult.budget,
        stopReason: laneResult.stopReason,
      },
      metadata: {
        adapter: 'legacy-adaptive-strangler-v1',
        evidence_count: laneResult.evidence.length,
        reranking_enabled: enableReranking,
        generation_separation: 'projection-only',
        phase_timing: 'legacy-workflow-projection',
      },
    };

  } catch (error) {
    console.error('[Adaptive Entity RAG Error]', createSafeAskErrorLog(error));
    throw error;
  }
}

function createSafeAskErrorLog(error: unknown): Record<string, unknown> {
  if (error instanceof RagKernelExecutionError) {
    return {
      name: 'RagKernelExecutionError',
      code: 'RAG_POLICY_EXECUTION_FAILED',
      policyId: error.envelope.policy_id,
      traceId: error.envelope.trace_id,
      status: error.envelope.status,
    };
  }
  if (error instanceof RagSecurityError) {
    return {
      name: 'RagSecurityError',
      code: error.code,
      status: error.status,
    };
  }
  const candidateCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return {
    name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
      ? error.name
      : 'Error',
    code: typeof candidateCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidateCode)
      ? candidateCode
      : 'ASK_INTERNAL_ERROR',
  };
}
