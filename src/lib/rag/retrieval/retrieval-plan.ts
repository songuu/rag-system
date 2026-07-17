import type { RagPolicyId, RagQueryRequest } from '../core/types';
import { classifyRetrievalQuery, type RetrievalRouteDecision } from './retrieval-router';

export type RagRetrievalLaneType =
  | 'memory'
  | 'dense-vector'
  | 'ordered-context'
  | 'visual-page'
  | 'sparse-bm25'
  | 'metadata-filter'
  | 'graph-entity'
  | 'fusion'
  | 'rerank'
  | 'generation-only';

export const DEFAULT_HYBRID_LANE_TIMEOUT_MS = 5_000;
export const DEFAULT_HYBRID_DENSE_FALLBACK_RESERVE_MS = 15_000;

export interface RagLaneExecutionBudget {
  /** Hard relative deadline for this lane, still capped by the global budget. */
  maxDurationMs: number;
  /** Time the executor must leave for a later required rollback lane. */
  reserveForRequiredMs?: number;
}

export interface RagRetrievalLane {
  id: string;
  type: RagRetrievalLaneType;
  required: boolean;
  description: string;
  parameters?: Record<string, unknown>;
  executionBudget?: RagLaneExecutionBudget;
}

export interface RagRetrievalPlan {
  id: string;
  policy_id: RagPolicyId;
  query: string;
  lanes: RagRetrievalLane[];
  top_k: number;
  similarity_threshold: number;
  context_budget_tokens?: number;
  created_at: string;
}

export function createRetrievalLane(
  input: Omit<RagRetrievalLane, 'id'> & { id?: string }
): RagRetrievalLane {
  return {
    id: input.id ?? `${input.type}-${input.required ? 'required' : 'optional'}`,
    type: input.type,
    required: input.required,
    description: input.description,
    parameters: input.parameters,
    executionBudget: input.executionBudget
      ? { ...input.executionBudget }
      : undefined,
  };
}

export function createDefaultRetrievalPlan(
  request: RagQueryRequest,
  policyId: RagPolicyId,
  now: Date = new Date()
): RagRetrievalPlan {
  const lanes = createDefaultLanes(request, policyId);

  return {
    id: `${policyId}:${request.storageBackend}:${request.topK}:${request.similarityThreshold}`,
    policy_id: policyId,
    query: request.question,
    lanes,
    top_k: request.topK,
    similarity_threshold: request.similarityThreshold,
    context_budget_tokens: 4000,
    created_at: now.toISOString(),
  };
}

function createDefaultLanes(
  request: RagQueryRequest,
  policyId: RagPolicyId
): RagRetrievalLane[] {
  if (policyId === 'memory') {
    return [
      createRetrievalLane({
        type: 'memory',
        required: true,
        description: 'Use the existing in-memory vector store path.',
        parameters: {
          topK: request.topK,
          similarityThreshold: request.similarityThreshold,
        },
      }),
      createRetrievalLane({
        type: 'generation-only',
        required: true,
        description: 'Generate only after the memory evidence snapshot is available.',
      }),
    ];
  }

  if (policyId === 'agentic') {
    return [
      createRetrievalLane({
        type: 'dense-vector',
        required: true,
        description: 'Retrieve candidate chunks from Milvus before agent grading.',
      }),
      createRetrievalLane({
        type: 'rerank',
        required: true,
        description: 'Grade retrieval quality and optionally rewrite the query.',
      }),
      createRetrievalLane({
        type: 'generation-only',
        required: true,
        description: 'Project the legacy generation result after canonical evidence is captured.',
      }),
    ];
  }

  if (policyId === 'adaptive-entity') {
    return [
      createRetrievalLane({
        type: 'metadata-filter',
        required: false,
        description: 'Apply entity-derived structured constraints when available.',
      }),
      createRetrievalLane({
        type: 'dense-vector',
        required: true,
        description: 'Run semantic retrieval against Milvus.',
      }),
      createRetrievalLane({
        type: 'rerank',
        required: Boolean(request.enableReranking),
        description: 'Rerank the request-local candidate set when enabled.',
      }),
      createRetrievalLane({
        type: 'generation-only',
        required: true,
        description: 'Project the legacy generation result after canonical evidence is captured.',
      }),
    ];
  }

  if (policyId === 'self-corrective') {
    return [
      createRetrievalLane({
        type: 'dense-vector',
        required: true,
        description: 'Retrieve candidate chunks from Milvus.',
      }),
      createRetrievalLane({
        type: 'rerank',
        required: true,
        description: 'Grade documents and rewrite the query when quality is low.',
      }),
    ];
  }

  if (policyId === 'reasoning') {
    return [
      createRetrievalLane({
        type: 'dense-vector',
        required: true,
        description: 'Retrieve evidence for reasoning model context.',
      }),
      createRetrievalLane({
        type: 'sparse-bm25',
        required: false,
        description: 'Optional keyword lane for hybrid retrieval.',
      }),
      createRetrievalLane({
        type: 'rerank',
        required: false,
        description: 'Optional deep reranking before reasoning.',
      }),
    ];
  }

  if (policyId === 'maic-course' || policyId === 'mirofish-research') {
    const lanes: RagRetrievalLane[] = [
      createRetrievalLane({
        type: 'dense-vector',
        required: true,
        description: 'Retrieve product-scoped evidence from the shared corpus.',
      }),
    ];
    const queryKind = classifyRetrievalQuery(request.question).queryKind;
    if (
      policyId === 'mirofish-research'
      && (queryKind === 'global' || queryKind === 'multi-hop')
    ) {
      lanes.push(createRetrievalLane({
        type: 'graph-entity',
        required: false,
        description: 'Use a scoped MiroFish graph artifact for global or multi-hop expansion.',
        parameters: {
          queryKind,
          ...request.graphArtifactIdentity,
        },
      }));
    }
    return lanes;
  }

  return [
    createRetrievalLane({
      type: 'dense-vector',
      required: true,
      description: 'Run two-step dense vector retrieval against Milvus.',
      parameters: {
        topK: request.topK,
        similarityThreshold: request.similarityThreshold,
      },
    }),
  ];
}

export function createRoutedMilvusRetrievalPlan(
  basePlan: RagRetrievalPlan,
  decision: RetrievalRouteDecision,
  options: {
    hybridMode?: 'off' | 'shadow' | 'active';
    hybridUsable?: boolean;
    pdfVisualMode?: 'off' | 'shadow' | 'active';
    hybridLaneTimeoutMs?: number;
    hybridDenseFallbackReserveMs?: number;
    pdfVisualUsable?: boolean;
    pdfVisualIntent?: boolean;
  } = {}
): RagRetrievalPlan {
  if (decision.route === 'ordered-context') {
    let replacedDenseLane = false;
    const lanes = basePlan.lanes.map(lane => {
      if (lane.type !== 'dense-vector') return lane;
      replacedDenseLane = true;
      return createRetrievalLane({
        id: 'ordered-context-required',
        type: 'ordered-context',
        required: true,
        description: 'Read the complete bounded corpus in deterministic source order.',
        parameters: {
          routerVersion: decision.version,
          activationReason: decision.reason,
        },
      });
    });
    if (!replacedDenseLane) {
      throw new Error('Ordered context routing requires a dense control lane to replace.');
    }
    return appendPdfVisualLane({
      ...basePlan,
      id: basePlan.id + ':ordered-context',
      lanes,
    }, options);
  }

  const hybridMode = options.hybridMode ?? 'off';
  if (hybridMode === 'off' || !options.hybridUsable) return appendPdfVisualLane(basePlan, options);
  if (!basePlan.lanes.some(lane => lane.type === 'dense-vector')) {
    throw new Error('Hybrid routing requires a dense rollback lane.');
  }
  const hybridLane = createRetrievalLane({
    id: hybridMode === 'active' ? 'hybrid-primary' : 'hybrid-shadow',
    type: 'sparse-bm25',
    required: false,
    description: hybridMode === 'active'
      ? 'Run native Milvus hybrid retrieval before the dense rollback lane.'
      : 'Run native Milvus hybrid retrieval for shadow diagnostics only.',
    executionBudget: {
      maxDurationMs: options.hybridLaneTimeoutMs ?? DEFAULT_HYBRID_LANE_TIMEOUT_MS,
      reserveForRequiredMs: options.hybridDenseFallbackReserveMs ?? DEFAULT_HYBRID_DENSE_FALLBACK_RESERVE_MS,
    },
    parameters: {
      mode: hybridMode,
      routerVersion: decision.version,
      plannedRoute: decision.route,
      activationReason: decision.reason,
    },
  });
  return appendPdfVisualLane({
    ...basePlan,
    id: basePlan.id + ':hybrid-' + hybridMode,
    lanes: [
      hybridLane,
      ...basePlan.lanes.filter(lane => lane.type !== 'sparse-bm25'),
    ],
  }, options);
}

function appendPdfVisualLane(
  plan: RagRetrievalPlan,
  options: {
    pdfVisualMode?: 'off' | 'shadow' | 'active';
    pdfVisualUsable?: boolean;
    pdfVisualIntent?: boolean;
  }
): RagRetrievalPlan {
  const mode = options.pdfVisualMode ?? 'off';
  if (mode === 'off' || !options.pdfVisualUsable || !options.pdfVisualIntent) {
    return plan;
  }
  const hasTextRollback = plan.lanes.some(lane =>
    lane.type === 'dense-vector'
    || lane.type === 'ordered-context'
    || lane.type === 'sparse-bm25'
  );
  if (!hasTextRollback) {
    throw new Error('PDF visual routing requires a text retrieval rollback lane.');
  }
  return {
    ...plan,
    id: plan.id + ':pdf-visual-' + mode,
    lanes: [
      ...plan.lanes.filter(lane => lane.type !== 'visual-page'),
      createRetrievalLane({
        id: mode === 'active' ? 'pdf-visual-active' : 'pdf-visual-shadow',
        type: 'visual-page',
        required: false,
        description: mode === 'active'
          ? 'Analyze exact scoped PDF page assets after text retrieval.'
          : 'Analyze exact scoped PDF page assets for shadow diagnostics only.',
        parameters: { mode },
      }),
    ],
  };
}
