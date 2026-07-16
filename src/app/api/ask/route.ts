import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';
import { analyzeQuery } from '@/lib/semantic-analyzer';
import {
  getMilvusInstance,
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
  createRagCacheIdentity,
  createRagPolicy,
  invokeRagKernelWorkflow,
  normalizeLegacyPolicyDocuments,
  resolveRagPolicyId,
  throwIfRagRequestAborted,
  type RagAnswerEnvelope,
  type RagExecutionTransition,
  type RagLaneHandler,
  type RagLaneExecutorResult,
  type RagPolicyContext,
  type RagQueryRequest,
  type RagStorageBackend,
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
} from '@/lib/rag/retrieval/retrieval-router';
import { createGraphEntityLaneHandler } from '@/lib/rag/retrieval/graph-entity-lane';
import { FileMiroFishGraphArtifactStore } from '@/lib/mirofish/graph-artifact-store';
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

function resolveServerMiroFishPolicy(
  question: string,
  scope: RagRetrievalScope
): Pick<RagQueryRequest, 'serverPolicyId' | 'graphArtifactIdentity'> {
  const mode = resolveRagFeatureRolloutMode('RAG_MIROFISH_GRAPH_MODE', 'off');
  if (mode !== 'active') return {};
  const queryKind = classifyRetrievalQuery(question).queryKind;
  if (queryKind !== 'global' && queryKind !== 'multi-hop') return {};

  const documentId = process.env.RAG_MIROFISH_GRAPH_DOCUMENT_ID?.trim();
  const documentVersion = process.env.RAG_MIROFISH_GRAPH_DOCUMENT_VERSION?.trim();
  const trustValue = process.env.RAG_MIROFISH_GRAPH_TRUST_LEVEL?.trim() || 'reviewed';
  if (!documentId || !documentVersion) {
    throw new Error('Active MiroFish graph mode requires a document ID and version.');
  }
  if (
    !['trusted', 'reviewed', 'external', 'quarantined'].includes(trustValue)
  ) {
    throw new Error('RAG_MIROFISH_GRAPH_TRUST_LEVEL is invalid.');
  }
  const trustLevel = trustValue as RagTrustLevel;
  if (trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error('MiroFish graph trust level is outside the retrieval scope.');
  }
  return {
    serverPolicyId: 'mirofish-research',
    graphArtifactIdentity: {
      documentId,
      documentVersion,
      trustLevel,
    },
  };
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
      capability: 'query',
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
      ...resolveServerMiroFishPolicy(question, retrievalScope),
      raw: body,
    };

    const kernel = createAskKernel();
    const policyId = resolveRagPolicyId(ragRequest);
    const output = await runWithLangSmithRootRun<NextResponse>(
      {
        name: 'RAG API Ask',
        runType: 'chain',
        route: '/api/ask',
        policyId,
        userId,
        sessionId,
        fallbackRunId: `ask-${Date.now()}`,
        inputs: {
          question: ragRequest.question,
          topK: ragRequest.topK,
          similarityThreshold: ragRequest.similarityThreshold,
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
          request: ragRequest,
          policyId,
          signal: request.signal,
          context: {
            name: 'RAG API Ask Workflow',
            route: '/api/ask',
            userId,
            sessionId,
            threadId: langSmithRun.threadId,
            traceId: langSmithRun.runId,
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
        throwIfRagRequestAborted(request.signal);

        attachRagKernelHeaders(result.output.headers, result.envelope);
        if (langSmithRun.enabled) {
          result.output.headers.set('x-langsmith-run-id', langSmithRun.runId);
          result.output.headers.set('x-langsmith-thread-id', langSmithRun.threadId);
          result.output.headers.set('x-langsmith-project', langSmithRun.projectName);
        }
        return result.output;
      }
    );

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
    retrievalPlan,
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
  let searchResults: MilvusSearchResult[] = [];
  let stats: CollectionStats | null | undefined;
  let vectorizationTime = 0;
  let searchTime = 0;
  const budget = {
    maxLanes: Math.max(1, retrievalPlan.lanes.length),
    maxEvidence: policyId === 'mirofish-research' ? topK * 2 : topK,
    maxDurationMs: 30_000,
  };
  const milvusConfig = getDefaultMilvusConfig();
  const laneHandlers: RagLaneHandler[] = [
    {
      type: 'dense-vector',
      retriever: 'milvus-dense-v1',
      async execute({ lane, signal }) {
        assertLaneNotAborted(signal);
        const milvus = getMilvusInstance(milvusConfig);
        await milvus.connect();
        assertLaneNotAborted(signal);
        await milvus.initializeCollection();
        assertLaneNotAborted(signal);

        const embeddingStartedAt = Date.now();
        const embeddings = getEmbeddingModel(embeddingModel);
        queryEmbedding = await embeddings.embedQuery(question);
        assertLaneNotAborted(signal);
        vectorizationTime = Date.now() - embeddingStartedAt;

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
  if (policyId === 'mirofish-research' && request.graphArtifactIdentity) {
    laneHandlers.push(createGraphEntityLaneHandler({
      store: new FileMiroFishGraphArtifactStore(
        process.env.RAG_MIROFISH_GRAPH_STORE_ROOT?.trim() || undefined
      ),
      defaultMaxHops: 2,
      maxEvidence: topK,
    }));
  }
  const laneExecutor = new RagLaneExecutor(laneHandlers);

  const laneResult = await laneExecutor.execute({
    request,
    plan: retrievalPlan,
    signal: policyContext.signal,
    budget,
  });
  const orderedContextMode = resolveRagFeatureRolloutMode(
    'RAG_ORDERED_CONTEXT_MODE',
    'off'
  );
  const retrievalRoute = routeRetrievalQuery({
    query: question,
    capabilities: {
      // Native hybrid is not declared active until a probed port is registered.
      hybridActive: false,
      // A dense topK result is not a bounded corpus reader. Keep this false
      // until an ordered reader port proves full-corpus coverage.
      orderedContextActive: false,
    },
  });
  const abstentionMode = resolveRagFeatureRolloutMode(
    'RAG_ABSTENTION_MODE',
    'shadow'
  );
  const denseLaneId = retrievalPlan.lanes.find(lane => lane.type === 'dense-vector')?.id;
  if (!denseLaneId) throw new Error('milvus-2step plan is missing its dense lane.');
  const graphLaneId = retrievalPlan.lanes.find(lane => lane.type === 'graph-entity')?.id;
  const laneKinds: Record<string, 'dense' | 'graph'> = {
    [denseLaneId]: 'dense',
    ...(graphLaneId ? { [graphLaneId]: 'graph' as const } : {}),
  };
  const calibrationLanes: Record<
    string,
    { minimumScore: number; scoreField: 'retrieval' }
  > = {
    [denseLaneId]: {
      minimumScore: resolveDenseAbstentionThreshold(similarityThreshold),
      scoreField: 'retrieval',
    },
    ...(graphLaneId
      ? { [graphLaneId]: { minimumScore: 0, scoreField: 'retrieval' as const } }
      : {}),
  };
  const abstention = decideRagAbstention({
    queryKind: retrievalRoute.queryKind,
    evidence: laneResult.evidence,
    laneKinds,
    calibration: {
      version: graphLaneId
        ? 'milvus-dense-graph-calibration-v1'
        : 'milvus-dense-calibration-v1',
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
      policyId === 'mirofish-research' ? 'dense-graph-optional-v1' : 'dense-only-v1',
      retrievalRoute.version,
      retrievalRoute.route,
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
      totalDocuments: retrievalScope.enforceIsolation
        ? searchResults.length
        : stats?.rowCount || 0,
      searchTime,
      vectorizationTime,
      llmTime,
      retrievalRoute,
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
