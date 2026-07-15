import { createDefaultRetrievalPlan } from '../retrieval/retrieval-plan';
import { RagLaneExecutionError } from '../retrieval/lane-executor';
import type {
  RagKernelErrorSummary,
  RagKernelEnvelope,
  RagKernelResult,
  RagPolicy,
  RagPolicyId,
  RagPolicyResult,
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
    const retrievalPlan = createDefaultRetrievalPlan(request, policyId, startedAtDate);

    try {
      const result = await policy.execute({
        request,
        policyId,
        traceId,
        startedAt,
        retrievalPlan,
      });
      const outputError = summarizeFailedPolicyOutput(result.output);
      const executionError = summarizeFailedPolicyExecution(result);
      const policyError = outputError ?? executionError;

      const envelope = createEnvelope({
        request,
        policy,
        policyId,
        traceId,
        startedAtDate,
        retrievalPlan: result.retrievalPlan ?? retrievalPlan,
        evidence: result.evidence,
        laneExecutions: result.laneExecutions,
        execution: result.execution,
        metadata: result.metadata,
        status: policyError ? 'failed' : 'completed',
        error: policyError,
      });

      return {
        output: result.output,
        envelope,
      };
    } catch (error) {
      const partialResult =
        error instanceof RagLaneExecutionError
          ? error.partialResult
          : undefined;
      const envelope = createEnvelope({
        request,
        policy,
        policyId,
        traceId,
        startedAtDate,
        retrievalPlan,
        evidence: partialResult?.evidence,
        laneExecutions: partialResult?.laneExecutions,
        execution:
          partialResult === undefined
            ? undefined
            : {
                state: 'failed',
                transitions: partialResult.transitions,
                budget: partialResult.budget,
                stopReason: partialResult.stopReason,
              },
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
  evidence?: RagKernelEnvelope['evidence'];
  laneExecutions?: RagKernelEnvelope['lane_executions'];
  execution?: RagPolicyResult<TOutput>['execution'];
  status: RagKernelEnvelope['status'];
  metadata?: Record<string, unknown>;
  error?: RagKernelErrorSummary;
}): RagKernelEnvelope {
  const completedAtDate = new Date();
  const defaultTransitions: RagKernelEnvelope['execution']['transitions'] = [
    {
      from: 'planned',
      to: input.status === 'completed' ? 'completed' : 'failed',
      at: completedAtDate.toISOString(),
      reason: input.status === 'completed' ? 'legacy_policy_completed' : 'policy_failed',
    },
  ];

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
    evidence: input.evidence ?? [],
    lane_executions: input.laneExecutions ?? [],
    execution: {
      state: input.status,
      transitions: input.execution?.transitions ?? defaultTransitions,
      budget: input.execution?.budget,
      stop_reason:
        input.execution?.stopReason ??
        (input.status === 'failed' ? 'failed' : undefined),
    },
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
      ...(
        'code' in error && typeof error.code === 'string'
          ? { code: error.code }
          : {}
      ),
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

function summarizeFailedPolicyExecution<TOutput>(
  result: RagPolicyResult<TOutput>
): RagKernelErrorSummary | undefined {
  if (
    result.execution?.state !== 'failed' &&
    result.execution?.stopReason !== 'failed'
  ) {
    return undefined;
  }
  return {
    name: 'RagPolicyStateError',
    message: 'RAG policy reported a failed execution state.',
    code: 'RAG_POLICY_STATE_FAILED',
  };
}

function summarizeFailedPolicyOutput(output: unknown): RagKernelErrorSummary | undefined {
  if (typeof Response === 'undefined' || !(output instanceof Response) || output.ok) {
    return undefined;
  }

  return {
    name: 'RagPolicyHttpError',
    message: 'RAG policy returned HTTP ' + output.status + '.',
    code: 'RAG_POLICY_HTTP_ERROR',
    http_status: output.status,
  };
}

function createTraceId(policyId: RagPolicyId, timestamp: number): string {
  return `rag-${policyId}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

