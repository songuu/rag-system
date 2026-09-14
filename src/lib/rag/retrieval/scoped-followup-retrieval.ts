import type { RagEvidence, RagQueryRequest } from '../core/types';
import { throwIfRagRequestAborted } from '../core/cancellation';
import { createRetrievalScope, type RagRetrievalScope } from '../../security/retrieval-scope';
import {
  RagLaneExecutor,
  RagLaneExecutionError,
  type RagLaneHandler,
  type RagLaneExecutorResult,
} from './lane-executor';
import { createDefaultRetrievalPlan, type RagRetrievalPlan } from './retrieval-plan';

export const SCOPED_FOLLOWUP_TIMEOUT_MS = 5_000;
export const SCOPED_FOLLOWUP_MAX_SEARCHES = 2;
export type ScopedRetrievalMode = 'snapshot' | 'bounded';

export function resolveScopedRetrievalMode(
  env: NodeJS.ProcessEnv = process.env
): ScopedRetrievalMode {
  const mode = env.RAG_AGENTIC_RETRIEVAL_MODE?.trim().toLowerCase() || 'snapshot';
  if (mode === 'snapshot' || mode === 'bounded') return mode;
  throw new Error('RAG_AGENTIC_RETRIEVAL_MODE mode must be snapshot or bounded.');
}

export function resolveScopedDecisionMode(
  env: NodeJS.ProcessEnv = process.env
): 'native-tools' | 'structured' {
  const mode = env.RAG_AGENTIC_DECISION_MODE?.trim().toLowerCase() || 'structured';
  if (mode === 'native-tools' || mode === 'structured') return mode;
  throw new Error('RAG_AGENTIC_DECISION_MODE decision mode must be native-tools or structured.');
}

/** The agent can change only the query; identity, provider, limits and filters stay server-owned. */
export function createScopedFollowupRetriever(input: {
  request: RagQueryRequest;
  retrieve: (input: {
    query: string;
    laneId: string;
    scope: RagRetrievalScope;
    signal: AbortSignal;
  }) => Promise<RagEvidence[]>;
  rerankHandler?: RagLaneHandler;
  timeoutMs?: number;
  onExecution?: (result: RagLaneExecutorResult, plan: RagRetrievalPlan) => void;
}): (input: { query: string; signal: AbortSignal }) => Promise<RagEvidence[]> {
  if (!input.request.retrievalScope) {
    throw new Error('Scoped follow-up retrieval requires server-derived scope.');
  }
  const scope = createRetrievalScope({
    ...input.request.retrievalScope,
    allowedTrustLevels: [...input.request.retrievalScope.allowedTrustLevels],
  });
  Object.freeze(scope.allowedTrustLevels);
  Object.freeze(scope);
  const request = Object.freeze({ ...input.request, retrievalScope: scope });
  const timeoutMs = input.timeoutMs ?? SCOPED_FOLLOWUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCOPED_FOLLOWUP_TIMEOUT_MS) {
    throw new Error('Scoped follow-up timeout is outside the server budget.');
  }
  let searches = 0;
  return async ({ query, signal }) => {
    throwIfRagRequestAborted(signal);
    const normalized = query.trim();
    if (!normalized || normalized.length > 1024) {
      throw new Error('Scoped follow-up query must contain 1 to 1024 characters.');
    }
    if (searches >= SCOPED_FOLLOWUP_MAX_SEARCHES) {
      throw new Error('Scoped follow-up search budget exhausted.');
    }
    searches += 1;
    const laneId = 'agentic-followup-' + searches;
    const currentRequest = { ...request, question: normalized };
    const plan: RagRetrievalPlan = {
      ...createDefaultRetrievalPlan(currentRequest, 'agentic'),
      lanes: [{
        id: laneId,
        type: 'dense-vector',
        required: true,
        description: 'Agent-requested search within the original server scope.',
        executionBudget: { maxDurationMs: timeoutMs },
      }],
    };
    const handlers: RagLaneHandler[] = [{
      type: 'dense-vector',
      // Match the initial dense handler so an orphan blocks both entry points.
      retriever: 'milvus-dense-v1',
      async execute({ signal: laneSignal }) {
        throwIfRagRequestAborted(laneSignal);
        const evidence = await input.retrieve({
          query: normalized, laneId, scope, signal: laneSignal,
        });
        throwIfRagRequestAborted(laneSignal);
        return { evidence };
      },
    }];
    if (input.rerankHandler) {
      plan.lanes.push({
        id: laneId + '-rerank',
        type: 'rerank',
        required: false,
        description: 'Bounded reranking of the follow-up evidence only.',
        executionBudget: { maxDurationMs: timeoutMs },
      });
      handlers.push(input.rerankHandler);
    }
    try {
      const result = await new RagLaneExecutor(handlers).execute({
        request: currentRequest,
        plan,
        signal,
        budget: {
          maxLanes: plan.lanes.length,
          maxEvidence: request.topK,
          maxDurationMs: timeoutMs,
        },
      });
      input.onExecution?.(result, plan);
      return result.evidence;
    } catch (error) {
      if (error instanceof RagLaneExecutionError) {
        input.onExecution?.(error.partialResult, plan);
      }
      throw error;
    }
  };
}
