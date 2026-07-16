import type { RagRetrievalPlan } from '../retrieval/retrieval-plan';
import type { RagSecurityContext } from '../../security/request-context';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../../security/retrieval-scope';

export type RagPolicyId =
  | 'memory'
  | 'milvus-2step'
  | 'agentic'
  | 'adaptive-entity'
  | 'self-corrective'
  | 'reasoning'
  | 'maic-course'
  | 'mirofish-research';

export type RagStorageBackend = 'memory' | 'milvus';

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
  securityContext?: RagSecurityContext;
  retrievalScope?: RagRetrievalScope;
  /** Server-owned policy selection; never populated from request JSON. */
  serverPolicyId?: 'mirofish-research';
  /** Exact server-owned graph artifact identity for an optional graph lane. */
  graphArtifactIdentity?: {
    documentId: string;
    documentVersion: string;
    trustLevel: RagTrustLevel;
  };
  raw?: Record<string, unknown>;
}

export interface RagPolicyContext {
  request: RagQueryRequest;
  policyId: RagPolicyId;
  traceId: string;
  startedAt: number;
  retrievalPlan: RagRetrievalPlan;
  /** Transient request cancellation only. AbortSignal is never serialized. */
  signal?: AbortSignal;
}

export interface RagPolicyResult<TOutput> {
  output: TOutput;
  retrievalPlan?: RagRetrievalPlan;
  evidence?: RagEvidence[];
  laneExecutions?: RagLaneExecution[];
  execution?: RagPolicyExecutionSummary;
  metadata?: Record<string, unknown>;
}

export interface RagPolicy<TOutput> {
  id: RagPolicyId;
  description: string;
  execute(context: RagPolicyContext): Promise<RagPolicyResult<TOutput>>;
}

export type RagKernelExecutionStatus = 'completed' | 'failed';

export interface RagKernelErrorSummary {
  name: string;
  message: string;
  code?: string;
  http_status?: number;
}

export interface RagKernelEnvelope {
  trace_id: string;
  policy_id: RagPolicyId;
  status: RagKernelExecutionStatus;
  question: string;
  storage_backend: RagStorageBackend;
  retrieval_plan: RagRetrievalPlan;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  evidence: RagEvidence[];
  lane_executions: RagLaneExecution[];
  execution: RagKernelExecutionSummary;
  error?: RagKernelErrorSummary;
  metadata?: Record<string, unknown>;
}

export interface RagKernelResult<TOutput> {
  output: TOutput;
  envelope: RagKernelEnvelope;
}

export interface RagEvidence {
  id: string;
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  content: string;
  source?: string;
  page?: number;
  sectionPath?: string[];
  startOffset?: number;
  endOffset?: number;
  retrievalScore?: number;
  rerankScore?: number;
  trustLevel: RagTrustLevel;
  laneId: string;
  // Deprecated compatibility alias. New code writes retrievalScore.
  score?: number;
  metadata?: Record<string, unknown>;
}

export type RagLaneExecutionStatus = 'completed' | 'skipped' | 'failed';

export type RagStopReason =
  | 'sufficient'
  | 'budget'
  | 'max_steps'
  | 'no_gain'
  | 'failed'
  | 'capability_unavailable';

export interface RagLaneExecution {
  laneId: string;
  retriever: string;
  status: RagLaneExecutionStatus;
  retrievedEvidenceIds: string[];
  retrievalQuality?: number;
  generationUtility?: number;
  uncertainty?: number;
  latencyMs: number;
  inputTokens?: number;
  costUsd?: number;
  stopReason?: RagStopReason;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export type RagExecutionState =
  | 'planned'
  | 'retrieving'
  | 'evidence_ready'
  | 'generating'
  | 'completed'
  | 'failed';

export interface RagExecutionTransition {
  from: RagExecutionState;
  to: RagExecutionState;
  at: string;
  reason?: string;
}

export interface RagExecutionBudget {
  maxLanes: number;
  maxEvidence: number;
  maxDurationMs: number;
}

export interface RagPolicyExecutionSummary {
  state: 'completed' | 'failed';
  transitions: RagExecutionTransition[];
  budget?: RagExecutionBudget;
  stopReason?: RagStopReason;
}

export interface RagKernelExecutionSummary {
  state: RagKernelExecutionStatus;
  transitions: RagExecutionTransition[];
  budget?: RagExecutionBudget;
  stop_reason?: RagStopReason;
}

export interface RagAnswerEnvelope {
  success: boolean;
  question: string;
  answer: string;
  storageBackend?: RagStorageBackend;
  context?: string;
  traceId?: string;
  evidence?: RagEvidence[];
  laneExecutions?: RagLaneExecution[];
  execution?: {
    budget?: RagExecutionBudget;
    stopReason?: RagStopReason;
  };
  cacheIdentity?: {
    version: string;
    context: string;
    answer: string;
  };
  retrievalDetails?: Record<string, unknown>;
  rag?: RagKernelEnvelope;
}

