import type { RagRetrievalPlan } from '../retrieval/retrieval-plan';

export type RagPolicyId =
  | 'memory'
  | 'milvus-2step'
  | 'agentic'
  | 'adaptive-entity'
  | 'self-corrective'
  | 'reasoning'
  | 'maic-course'
  | 'mirofish-research';

export type RagStorageBackend = 'memory' | 'milvus' | string;

export interface RagQueryRequest {
  question: string;
  topK: number;
  similarityThreshold: number;
  llmModel: string;
  embeddingModel: string;
  storageBackend: RagStorageBackend;
  userId?: string;
  sessionId?: string;
  useAgenticRAG?: boolean;
  useAdaptiveEntityRAG?: boolean;
  maxRetries?: number;
  enableReranking?: boolean;
  requestId?: string;
  raw?: Record<string, unknown>;
}

export interface RagPolicyContext {
  request: RagQueryRequest;
  policyId: RagPolicyId;
  traceId: string;
  startedAt: number;
}

export interface RagPolicyResult<TOutput> {
  output: TOutput;
  retrievalPlan?: RagRetrievalPlan;
  metadata?: Record<string, unknown>;
}

export interface RagPolicy<TOutput> {
  id: RagPolicyId;
  description: string;
  execute(context: RagPolicyContext): Promise<RagPolicyResult<TOutput>>;
}

export interface RagKernelEnvelope {
  trace_id: string;
  policy_id: RagPolicyId;
  question: string;
  storage_backend: RagStorageBackend;
  retrieval_plan: RagRetrievalPlan;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  metadata?: Record<string, unknown>;
}

export interface RagKernelResult<TOutput> {
  output: TOutput;
  envelope: RagKernelEnvelope;
}

export interface RagEvidence {
  id: string;
  content: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RagAnswerEnvelope {
  success: boolean;
  question: string;
  answer: string;
  context?: string;
  traceId?: string;
  evidence?: RagEvidence[];
  retrievalDetails?: Record<string, unknown>;
  rag?: RagKernelEnvelope;
}

