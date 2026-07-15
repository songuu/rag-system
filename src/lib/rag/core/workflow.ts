import {
  RunnableLambda,
  RunnableSequence,
  type RunnableConfig,
} from '@langchain/core/runnables';
import {
  buildLangSmithMetadata,
  createLangSmithThreadId,
} from '../../langsmith/config';
import {
  RagKernelExecutionError,
  type RagKernel,
} from './kernel';
import type {
  RagKernelResult,
  RagPolicyId,
  RagQueryRequest,
} from './types';

export interface RagWorkflowContext {
  name?: string;
  route?: string;
  userId?: string;
  sessionId?: string;
  conversationId?: string;
  threadId?: string;
  traceId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface RagWorkflowInput {
  request: RagQueryRequest;
  policyId: RagPolicyId;
  context?: RagWorkflowContext;
  prepared?: PreparedRagWorkflowRun;
}

export interface PreparedRagWorkflowRun {
  name: string;
  policyId: RagPolicyId;
  traceId: string;
  threadId: string;
  startedAtDate: Date;
  tags: string[];
  metadata: Record<string, unknown>;
  runnableConfig: RunnableConfig;
}

export interface RagWorkflowResult<TOutput> extends RagKernelResult<TOutput> {
  workflow: {
    name: string;
    policyId: RagPolicyId;
    traceId: string;
    threadId: string;
    tags: string[];
    metadata: Record<string, unknown>;
  };
}

type PreparedRagWorkflowState = Omit<RagWorkflowInput, 'prepared'> & {
  prepared: PreparedRagWorkflowRun;
};

export function createRagKernelWorkflow<TOutput>(
  kernel: RagKernel<TOutput>
): RunnableSequence<RagWorkflowInput, RagWorkflowResult<TOutput>> {
  const prepare = RunnableLambda.from<RagWorkflowInput, PreparedRagWorkflowState>((input) => ({
    ...input,
    prepared: input.prepared ?? prepareRagWorkflowRun(input),
  }));

  const execute = RunnableLambda.from<PreparedRagWorkflowState, RagWorkflowResult<TOutput>>(
    async (state) => {
      try {
        const result = await kernel.execute(
          state.request,
          state.policyId,
          {
            now: state.prepared.startedAtDate,
            traceId: state.prepared.traceId,
          }
        );

        return {
          ...result,
          workflow: {
            name: state.prepared.name,
            policyId: state.policyId,
            traceId: state.prepared.traceId,
            threadId: state.prepared.threadId,
            tags: state.prepared.tags,
            metadata: state.prepared.metadata,
          },
        };
      } catch (error) {
        if (error instanceof RagKernelExecutionError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `RAG workflow failed for policy "${state.policyId}" and trace "${state.prepared.traceId}": ${message}`
        );
      }
    }
  );

  return RunnableSequence.from([prepare, execute], {
    name: 'rag-kernel-workflow',
  });
}

export async function invokeRagKernelWorkflow<TOutput>(
  kernel: RagKernel<TOutput>,
  input: RagWorkflowInput
): Promise<RagWorkflowResult<TOutput>> {
  const prepared = input.prepared ?? prepareRagWorkflowRun(input);
  const workflow = createRagKernelWorkflow(kernel);
  return workflow.invoke(
    {
      ...input,
      prepared,
    },
    prepared.runnableConfig
  );
}

export function prepareRagWorkflowRun(input: RagWorkflowInput): PreparedRagWorkflowRun {
  const context = input.context ?? {};
  const startedAtDate = context.now ?? new Date();
  const sessionId = context.sessionId ?? input.request.sessionId;
  const threadId =
    normalizeExternalId(context.threadId) ??
    createLangSmithThreadId({
      sessionId,
      conversationId: context.conversationId,
      fallback: input.request.requestId ?? context.traceId,
    });
  const traceId =
    normalizeExternalId(context.traceId) ??
    createRagWorkflowTraceId(input.policyId, startedAtDate, threadId);
  const name = context.name ?? `RAG ${input.policyId} workflow`;
  const tags = uniqueStrings([
    'rag',
    'rag-kernel',
    input.policyId,
    ...(context.tags ?? []),
  ]);
  const metadata = buildLangSmithMetadata({
    threadId,
    sessionId,
    conversationId: context.conversationId,
    userId: context.userId ?? input.request.userId,
    route: context.route,
    policyId: input.policyId,
    metadata: {
      ...(context.metadata ?? {}),
      workflow_name: name,
      request_id: input.request.requestId,
      llm_model: input.request.llmModel,
      embedding_model: input.request.embeddingModel,
      storage_backend: input.request.storageBackend,
      top_k: input.request.topK,
      similarity_threshold: input.request.similarityThreshold,
      use_agentic_rag: input.request.useAgenticRAG,
      use_adaptive_entity_rag: input.request.useAdaptiveEntityRAG,
      enable_reranking: input.request.enableReranking,
    },
  });

  return {
    name,
    policyId: input.policyId,
    traceId,
    threadId,
    startedAtDate,
    tags,
    metadata,
    runnableConfig: {
      runName: name,
      tags,
      metadata,
      configurable: {
        thread_id: threadId,
        rag_policy: input.policyId,
      },
    },
  };
}

function createRagWorkflowTraceId(
  policyId: RagPolicyId,
  startedAtDate: Date,
  threadId: string
): string {
  return `rag-${policyId}-${startedAtDate.getTime()}-${safeIdSegment(threadId)}`;
}

function safeIdSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10);
  return segment || 'workflow';
}

function normalizeExternalId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}
