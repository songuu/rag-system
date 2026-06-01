import { createDefaultRetrievalPlan } from '../retrieval/retrieval-plan';
import type {
  RagKernelErrorSummary,
  RagKernelEnvelope,
  RagKernelResult,
  RagPolicy,
  RagPolicyId,
  RagQueryRequest,
} from './types';

export class RagKernel<TOutput> {
  private policies: Map<RagPolicyId, RagPolicy<TOutput>>;

  constructor(policies: RagPolicy<TOutput>[]) {
    this.policies = new Map(policies.map(policy => [policy.id, policy]));
  }

  async execute(
    request: RagQueryRequest,
    policyId: RagPolicyId,
    options: { now?: Date; traceId?: string } = {}
  ): Promise<RagKernelResult<TOutput>> {
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new Error(`RAG policy is not registered: ${policyId}`);
    }

    const startedAtDate = options.now ?? new Date();
    const startedAt = startedAtDate.getTime();
    const traceId = options.traceId ?? createTraceId(policyId, startedAt);

    try {
      const result = await policy.execute({
        request,
        policyId,
        traceId,
        startedAt,
      });

      const envelope = createEnvelope({
        request,
        policy,
        policyId,
        traceId,
        startedAtDate,
        retrievalPlan:
          result.retrievalPlan ??
          createDefaultRetrievalPlan(request, policyId, startedAtDate),
        metadata: result.metadata,
        status: 'completed',
      });

      return {
        output: result.output,
        envelope,
      };
    } catch (error) {
      const envelope = createEnvelope({
        request,
        policy,
        policyId,
        traceId,
        startedAtDate,
        retrievalPlan: createDefaultRetrievalPlan(request, policyId, startedAtDate),
        status: 'failed',
        error: summarizeError(error),
      });

      throw new RagKernelExecutionError(envelope, error);
    }
  }
}

export class RagKernelExecutionError extends Error {
  readonly envelope: RagKernelEnvelope;
  readonly originalError: unknown;

  constructor(envelope: RagKernelEnvelope, originalError: unknown) {
    const originalMessage =
      originalError instanceof Error ? originalError.message : String(originalError);
    super(
      `RAG policy execution failed (${envelope.policy_id}, ${envelope.trace_id}): ${originalMessage}`
    );
    this.name = 'RagKernelExecutionError';
    this.envelope = envelope;
    this.originalError = originalError;
  }
}

function createEnvelope<TOutput>(input: {
  request: RagQueryRequest;
  policy: RagPolicy<TOutput>;
  policyId: RagPolicyId;
  traceId: string;
  startedAtDate: Date;
  retrievalPlan: RagKernelEnvelope['retrieval_plan'];
  status: RagKernelEnvelope['status'];
  metadata?: Record<string, unknown>;
  error?: RagKernelErrorSummary;
}): RagKernelEnvelope {
  const completedAtDate = new Date();

  return {
    trace_id: input.traceId,
    policy_id: input.policyId,
    status: input.status,
    question: input.request.question,
    storage_backend: input.request.storageBackend,
    retrieval_plan: input.retrievalPlan,
    started_at: input.startedAtDate.toISOString(),
    completed_at: completedAtDate.toISOString(),
    duration_ms: Math.max(0, completedAtDate.getTime() - input.startedAtDate.getTime()),
    error: input.error,
    metadata: {
      policy_description: input.policy.description,
      ...input.metadata,
    },
  };
}

function summarizeError(error: unknown): RagKernelErrorSummary {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

function createTraceId(policyId: RagPolicyId, timestamp: number): string {
  return `rag-${policyId}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

