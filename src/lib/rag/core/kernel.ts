import { createDefaultRetrievalPlan } from '../retrieval/retrieval-plan';
import type {
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

    const result = await policy.execute({
      request,
      policyId,
      traceId,
      startedAt,
    });

    const completedAtDate = new Date();
    const retrievalPlan =
      result.retrievalPlan ??
      createDefaultRetrievalPlan(request, policyId, startedAtDate);

    const envelope: RagKernelEnvelope = {
      trace_id: traceId,
      policy_id: policyId,
      question: request.question,
      storage_backend: request.storageBackend,
      retrieval_plan: retrievalPlan,
      started_at: startedAtDate.toISOString(),
      completed_at: completedAtDate.toISOString(),
      duration_ms: Math.max(0, completedAtDate.getTime() - startedAt),
      metadata: {
        policy_description: policy.description,
        ...result.metadata,
      },
    };

    return {
      output: result.output,
      envelope,
    };
  }
}

function createTraceId(policyId: RagPolicyId, timestamp: number): string {
  return `rag-${policyId}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

