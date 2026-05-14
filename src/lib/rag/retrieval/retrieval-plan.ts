import type { RagPolicyId, RagQueryRequest } from '../core/types';

export type RagRetrievalLaneType =
  | 'memory'
  | 'dense-vector'
  | 'sparse-bm25'
  | 'metadata-filter'
  | 'graph-entity'
  | 'fusion'
  | 'rerank'
  | 'generation-only';

export interface RagRetrievalLane {
  id: string;
  type: RagRetrievalLaneType;
  required: boolean;
  description: string;
  parameters?: Record<string, unknown>;
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
        type: 'fusion',
        required: true,
        description: 'Merge structured and semantic matches.',
      }),
      createRetrievalLane({
        type: 'rerank',
        required: Boolean(request.enableReranking),
        description: 'Rerank merged results when enabled.',
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
    return [
      createRetrievalLane({
        type: 'dense-vector',
        required: true,
        description: 'Retrieve product-scoped evidence from the shared corpus.',
      }),
      createRetrievalLane({
        type: 'graph-entity',
        required: false,
        description: 'Use product graph artifacts when available.',
      }),
    ];
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

