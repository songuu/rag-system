import type {
  RagEvidence,
  RagExecutionBudget,
  RagExecutionTransition,
  RagLaneExecution,
  RagQueryRequest,
  RagStopReason,
} from '../core/types';
import type {
  RagRetrievalLane,
  RagRetrievalLaneType,
  RagRetrievalPlan,
} from './retrieval-plan';

export interface RagLaneHandlerContext {
  request: RagQueryRequest;
  plan: RagRetrievalPlan;
  lane: RagRetrievalLane;
  priorEvidence: readonly RagEvidence[];
  signal: AbortSignal;
}

export interface RagLaneHandlerResult {
  evidence: RagEvidence[];
  retrievalQuality?: number;
  generationUtility?: number;
  uncertainty?: number;
  inputTokens?: number;
  costUsd?: number;
  stopReason?: RagStopReason;
  metadata?: Record<string, unknown>;
}

export interface RagLaneHandler {
  type: RagRetrievalLaneType;
  retriever: string;
  execute(context: RagLaneHandlerContext): Promise<RagLaneHandlerResult>;
}

export interface RagLaneExecutorResult {
  evidence: RagEvidence[];
  laneExecutions: RagLaneExecution[];
  transitions: RagExecutionTransition[];
  budget: RagExecutionBudget;
  stopReason: RagStopReason;
}

export class RagLaneExecutionError extends Error {
  readonly laneId: string;
  readonly cause: unknown;
  readonly code: string;
  readonly partialResult: RagLaneExecutorResult;

  constructor(
    laneId: string,
    message: string,
    partialResult: RagLaneExecutorResult,
    options: { cause?: unknown; code?: string } = {}
  ) {
    super(message);
    this.name = 'RagLaneExecutionError';
    this.laneId = laneId;
    this.cause = options.cause;
    this.code = options.code ?? 'RAG_LANE_FAILED';
    this.partialResult = partialResult;
  }
}

export class RagLaneExecutor {
  private readonly handlers: Map<RagRetrievalLaneType, RagLaneHandler>;
  private readonly now: () => number;

  constructor(
    handlers: readonly RagLaneHandler[],
    options: { now?: () => number } = {}
  ) {
    this.handlers = new Map();
    for (const handler of handlers) {
      if (this.handlers.has(handler.type)) {
        throw new Error('Duplicate retrieval lane handler: ' + handler.type);
      }
      this.handlers.set(handler.type, handler);
    }
    this.now = options.now ?? Date.now;
  }

  async execute(input: {
    request: RagQueryRequest;
    plan: RagRetrievalPlan;
    budget: RagExecutionBudget;
  }): Promise<RagLaneExecutorResult> {
    validateBudget(input.budget);
    const startedAt = this.now();
    const transitions: RagExecutionTransition[] = [
      transition('planned', 'retrieving', startedAt, 'lane_execution_started'),
    ];
    const evidence: RagEvidence[] = [];
    const evidenceIds = new Set<string>();
    const laneExecutions: RagLaneExecution[] = [];
    let executedLanes = 0;
    let stopReason: RagStopReason | undefined;

    for (const lane of input.plan.lanes) {
      if (this.now() - startedAt >= input.budget.maxDurationMs) {
        stopReason = 'budget';
        break;
      }
      if (executedLanes >= input.budget.maxLanes) {
        stopReason = 'budget';
        break;
      }

      const handler = this.handlers.get(lane.type);
      if (!handler) {
        if (lane.required) {
          laneExecutions.push({
            laneId: lane.id,
            retriever: 'unavailable',
            status: 'failed',
            retrievedEvidenceIds: [],
            latencyMs: 0,
            stopReason: 'capability_unavailable',
            errorCode: 'RAG_LANE_UNAVAILABLE',
          });
          const partialResult = createFailureResult({
            evidence,
            laneExecutions,
            transitions,
            budget: input.budget,
            stopReason: 'capability_unavailable',
            at: this.now(),
            reason: 'required_lane_unavailable',
          });
          throw new RagLaneExecutionError(
            lane.id,
            'Required retrieval lane is unavailable: ' + lane.id,
            partialResult,
            { code: 'RAG_LANE_UNAVAILABLE' }
          );
        }
        laneExecutions.push({
          laneId: lane.id,
          retriever: 'unavailable',
          status: 'skipped',
          retrievedEvidenceIds: [],
          latencyMs: 0,
          stopReason: 'capability_unavailable',
        });
        continue;
      }

      const laneStartedAt = this.now();
      executedLanes++;
      try {
        const remainingDurationMs =
          input.budget.maxDurationMs - (this.now() - startedAt);
        const result = await executeLaneWithDeadline(
          signal =>
            handler.execute({
              request: input.request,
              plan: input.plan,
              lane,
              priorEvidence: evidence,
              signal,
            }),
          remainingDurationMs,
          lane.id
        );
        if (this.now() - startedAt >= input.budget.maxDurationMs) {
          throw new RagLaneTimeoutError(lane.id);
        }
        const acceptedIds: string[] = [];
        let truncated = false;
        for (const item of result.evidence) {
          assertEvidenceAllowed(item, lane, input.request);
          if (evidenceIds.has(item.id)) continue;
          if (evidence.length >= input.budget.maxEvidence) {
            truncated = true;
            break;
          }
          evidenceIds.add(item.id);
          evidence.push(item);
          acceptedIds.push(item.id);
        }
        if (result.evidence.length > acceptedIds.length && evidence.length >= input.budget.maxEvidence) {
          truncated = true;
        }
        laneExecutions.push({
          laneId: lane.id,
          retriever: handler.retriever,
          status: 'completed',
          retrievedEvidenceIds: acceptedIds,
          retrievalQuality: result.retrievalQuality,
          generationUtility: result.generationUtility,
          uncertainty: result.uncertainty,
          latencyMs: Math.max(0, this.now() - laneStartedAt),
          inputTokens: result.inputTokens,
          costUsd: result.costUsd,
          stopReason:
            truncated
              ? 'budget'
              : result.stopReason ?? (acceptedIds.length > 0 ? 'sufficient' : 'no_gain'),
          metadata: result.metadata,
        });
        if (truncated) {
          stopReason = 'budget';
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof RagLaneTimeoutError;
        const laneStopReason: RagStopReason = timedOut ? 'budget' : 'failed';
        const errorCode = timedOut ? 'RAG_LANE_TIMEOUT' : 'RAG_LANE_FAILED';
        laneExecutions.push({
          laneId: lane.id,
          retriever: handler.retriever,
          status: 'failed',
          retrievedEvidenceIds: [],
          latencyMs: Math.max(0, this.now() - laneStartedAt),
          stopReason: laneStopReason,
          errorCode,
        });
        if (lane.required) {
          const partialResult = createFailureResult({
            evidence,
            laneExecutions,
            transitions,
            budget: input.budget,
            stopReason: laneStopReason,
            at: this.now(),
            reason: timedOut ? 'required_lane_timed_out' : 'required_lane_failed',
          });
          throw new RagLaneExecutionError(
            lane.id,
            'Required retrieval lane failed: ' + lane.id + ': ' + message,
            partialResult,
            { cause: error, code: errorCode }
          );
        }
        if (timedOut) {
          stopReason = 'budget';
          break;
        }
      }
    }

    if (!stopReason) {
      stopReason = evidence.length > 0 ? 'sufficient' : 'no_gain';
    }
    const evidenceReadyAt = this.now();
    if (evidence.length > 0) {
      transitions.push(
        transition('retrieving', 'evidence_ready', evidenceReadyAt, stopReason)
      );
      transitions.push(
        transition('evidence_ready', 'completed', this.now(), stopReason)
      );
    } else {
      transitions.push(
        transition('retrieving', 'completed', evidenceReadyAt, stopReason)
      );
    }

    return {
      evidence,
      laneExecutions,
      transitions,
      budget: input.budget,
      stopReason,
    };
  }
}

class RagLaneTimeoutError extends Error {
  constructor(laneId: string) {
    super('Retrieval lane exceeded its execution budget: ' + laneId);
    this.name = 'RagLaneTimeoutError';
  }
}

async function executeLaneWithDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  remainingDurationMs: number,
  laneId: string
): Promise<T> {
  if (remainingDurationMs <= 0) {
    throw new RagLaneTimeoutError(laneId);
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new RagLaneTimeoutError(laneId));
      controller.abort();
    }, remainingDurationMs);
  });
  try {
    return await Promise.race([
      execute(controller.signal),
      timeoutPromise,
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RagLaneTimeoutError(laneId);
    }
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function createFailureResult(input: {
  evidence: readonly RagEvidence[];
  laneExecutions: readonly RagLaneExecution[];
  transitions: readonly RagExecutionTransition[];
  budget: RagExecutionBudget;
  stopReason: RagStopReason;
  at: number;
  reason: string;
}): RagLaneExecutorResult {
  return {
    evidence: [...input.evidence],
    laneExecutions: [...input.laneExecutions],
    transitions: [
      ...input.transitions,
      transition('retrieving', 'failed', input.at, input.reason),
    ],
    budget: { ...input.budget },
    stopReason: input.stopReason,
  };
}

function assertEvidenceAllowed(
  evidence: RagEvidence,
  lane: RagRetrievalLane,
  request: RagQueryRequest
): void {
  if (!evidence.id.trim() || !evidence.content.trim()) {
    throw new Error('Retrieval lane returned evidence without identity or content.');
  }
  if (evidence.laneId !== lane.id) {
    throw new Error('Retrieval lane returned evidence with mismatched lane provenance.');
  }
  if (evidence.trustLevel === 'quarantined') {
    throw new Error('Retrieval lane returned quarantined evidence.');
  }
  const scope = request.retrievalScope;
  if (!scope) return;
  if (evidence.tenantId !== scope.tenantId) {
    throw new Error('Retrieval lane returned evidence with a tenant scope mismatch.');
  }
  if (evidence.corpusId !== scope.corpusId) {
    throw new Error('Retrieval lane returned evidence with a corpus scope mismatch.');
  }
  if (!scope.allowedTrustLevels.includes(evidence.trustLevel)) {
    throw new Error('Retrieval lane returned evidence outside the allowed trust scope.');
  }
}

function validateBudget(budget: RagExecutionBudget): void {
  if (!Number.isInteger(budget.maxLanes) || budget.maxLanes < 1) {
    throw new Error('RAG lane budget maxLanes must be a positive integer.');
  }
  if (!Number.isInteger(budget.maxEvidence) || budget.maxEvidence < 1) {
    throw new Error('RAG lane budget maxEvidence must be a positive integer.');
  }
  if (!Number.isFinite(budget.maxDurationMs) || budget.maxDurationMs < 1) {
    throw new Error('RAG lane budget maxDurationMs must be positive.');
  }
}

function transition(
  from: RagExecutionTransition['from'],
  to: RagExecutionTransition['to'],
  at: number,
  reason: string
): RagExecutionTransition {
  return {
    from,
    to,
    at: new Date(at).toISOString(),
    reason,
  };
}
