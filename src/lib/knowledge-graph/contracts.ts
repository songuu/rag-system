import { createHash } from 'node:crypto';
import type { RagEvidence, RagStopReason } from '../rag/core/types';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../security/retrieval-scope';

export const KNOWLEDGE_GRAPH_LIMITS = Object.freeze({
  maxTopK: 100,
  maxSeedPassageIds: 256,
  maxQueryCharacters: 8_000,
  maxIdentifierCharacters: 512,
});

export type KnowledgeGraphSnapshotStatus =
  | 'staging'
  | 'active'
  | 'superseded'
  | 'failed';

export interface KnowledgeGraphSnapshotIdentity {
  tenantId: string;
  corpusId: string;
  graphVersion: string;
}

export interface KnowledgeGraphDocumentIdentity {
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
}

export interface KnowledgeGraphPassage extends KnowledgeGraphDocumentIdentity {
  id: string;
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  source?: string;
  page?: number;
  sectionPath?: string[];
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGraphEntity {
  id: string;
  name: string;
  normalizedName: string;
  labels: string[];
  summary: string;
  aliases: string[];
  passageIds: string[];
  attributes: Record<string, unknown>;
  createdAt?: string;
}

export interface KnowledgeGraphClaim {
  id: string;
  predicate: string;
  fact: string;
  factType: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceEntityName: string;
  targetEntityName: string;
  episodes: string[];
  passageIds: string[];
  confidence: number;
  status: 'active' | 'invalid' | 'expired' | 'superseded';
  attributes: Record<string, unknown>;
  createdAt?: string;
  validAt?: string;
  invalidAt?: string;
  expiredAt?: string;
}

export interface KnowledgeGraphCommunity {
  id: string;
  name: string;
  entityIds: string[];
  claimIds: string[];
  summary: string;
  keywords: string[];
  level: number;
  parentId?: string;
}

export interface KnowledgeGraphSnapshot extends KnowledgeGraphSnapshotIdentity {
  graphId: string;
  graphName?: string;
  status: KnowledgeGraphSnapshotStatus;
  artifactDigest: string;
  createdAt: string;
  expiresAt?: string;
  documents: KnowledgeGraphDocumentIdentity[];
  passages: KnowledgeGraphPassage[];
  entities: KnowledgeGraphEntity[];
  claims: KnowledgeGraphClaim[];
  communities: KnowledgeGraphCommunity[];
}

export interface KnowledgeGraphSnapshotDescriptor
  extends KnowledgeGraphSnapshotIdentity {
  graphId: string;
  graphName?: string;
  status: KnowledgeGraphSnapshotStatus;
  artifactDigest: string;
  createdAt: string;
  expiresAt?: string;
  documentCount: number;
  passageCount: number;
  entityCount: number;
  claimCount: number;
  communityCount: number;
}

export interface KnowledgeGraphCompatibilitySnapshotDescriptor
  extends KnowledgeGraphSnapshotDescriptor {
  document: KnowledgeGraphDocumentIdentity;
}

export type KnowledgeGraphCompatibilityAvailability =
  | 'available'
  | 'expired'
  | 'all';

export interface KnowledgeGraphCompatibilityListOptions {
  limit?: number;
  availability?: KnowledgeGraphCompatibilityAvailability;
}

export interface KnowledgeGraphActivePointer {
  tenantId: string;
  corpusId: string;
  graphVersion: string | null;
  revision: number;
  updatedAt: string;
}

export interface KnowledgeGraphCommandStore {
  readonly coordination: 'process' | 'shared';
  stageSnapshot(snapshot: KnowledgeGraphSnapshot): Promise<KnowledgeGraphSnapshotDescriptor>;
  getSnapshot(
    identity: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<KnowledgeGraphSnapshot | null>;
  listSnapshots(
    scope: RagRetrievalScope,
    options?: { limit?: number }
  ): Promise<KnowledgeGraphSnapshotDescriptor[]>;
  getCompatibilityDescriptor(
    identity: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope,
    options?: Pick<KnowledgeGraphCompatibilityListOptions, 'availability'>
  ): Promise<KnowledgeGraphCompatibilitySnapshotDescriptor | null>;
  listCompatibilityDescriptors(
    scope: RagRetrievalScope,
    options?: KnowledgeGraphCompatibilityListOptions
  ): Promise<KnowledgeGraphCompatibilitySnapshotDescriptor[]>;
  deleteSnapshot(
    identity: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean>;
  snapshotExists(
    identity: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean>;
  getActive(scope: RagRetrievalScope): Promise<KnowledgeGraphActivePointer>;
  compareAndSetActive(
    scope: RagRetrievalScope,
    graphVersion: string | null,
    expectedRevision: number
  ): Promise<KnowledgeGraphActivePointer>;
  gcExpired(scope: RagRetrievalScope, options?: { limit?: number }): Promise<number>;
}

export interface KnowledgeGraphEntityResult {
  entity: KnowledgeGraphEntity;
  score?: number;
}

export interface KnowledgeGraphCommunityResult {
  community: KnowledgeGraphCommunity;
  score?: number;
}

export interface KnowledgeGraphPathResult {
  entityIds: string[];
  claimIds: string[];
  passageIds: string[];
  score: number;
}

export interface KnowledgeGraphClaimSourceResult {
  claim: KnowledgeGraphClaim;
  passages: KnowledgeGraphPassage[];
}

export interface KnowledgeGraphQueryPort {
  searchEntities(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphEntityResult[]>;
  getNeighbors(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    entityId: string;
    maxHops: 1 | 2;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphPathResult[]>;
  findPaths(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    sourceEntityId: string;
    targetEntityId: string;
    maxHops: 1 | 2;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphPathResult[]>;
  searchCommunities(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    query?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphCommunityResult[]>;
  getClaimSources(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    claimId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphClaimSourceResult | null>;
}

export interface GraphRetrievalSnapshotSelector {
  graphVersion: string;
  documentId?: string;
  documentVersion?: string;
  trustLevel?: RagTrustLevel;
}

export interface GraphRetrievalRequest {
  scope: RagRetrievalScope;
  snapshot: GraphRetrievalSnapshotSelector;
  query: string;
  laneId: string;
  topK: number;
  maxHops: 1 | 2;
  seedPassageIds: string[];
  signal?: AbortSignal;
}

export interface GraphRetrievalDiagnostics {
  seedCount: number;
  matchedEntityCount: number;
  matchedCommunityCount: number;
  inspectedPathCount: number;
  inspectedClaimCount: number;
  truncated: boolean;
  degraded?: boolean;
  degradationReason?: string;
}

export interface GraphRetrievalResult {
  evidence: RagEvidence[];
  stopReason: RagStopReason;
  diagnostics: GraphRetrievalDiagnostics;
}

export interface GraphRetrievalPort {
  readonly retriever: string;
  retrieve(input: GraphRetrievalRequest): Promise<GraphRetrievalResult>;
}

export type KnowledgeGraphErrorCode =
  | 'KNOWLEDGE_GRAPH_UNAVAILABLE'
  | 'KNOWLEDGE_GRAPH_QUERY_TIMEOUT'
  | 'KNOWLEDGE_GRAPH_CAPACITY'
  | 'KNOWLEDGE_GRAPH_CONFLICT'
  | 'KNOWLEDGE_GRAPH_SCOPE_VIOLATION'
  | 'KNOWLEDGE_GRAPH_NOT_FOUND';

export class KnowledgeGraphError extends Error {
  readonly code: KnowledgeGraphErrorCode;

  constructor(code: KnowledgeGraphErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KnowledgeGraphError';
    this.code = code;
  }
}

export function createKnowledgeGraphSnapshotIdentity(
  input: KnowledgeGraphSnapshotIdentity
): KnowledgeGraphSnapshotIdentity {
  return {
    tenantId: requiredScopeIdentifier(input.tenantId, 'tenantId'),
    corpusId: requiredScopeIdentifier(input.corpusId, 'corpusId'),
    graphVersion: requiredGraphVersion(input.graphVersion),
  };
}

export function normalizeGraphRetrievalRequest(
  input: Omit<GraphRetrievalRequest, 'seedPassageIds'> & {
    seedPassageIds?: readonly string[];
  }
): GraphRetrievalRequest {
  const identity = createKnowledgeGraphSnapshotIdentity({
    tenantId: input.scope.tenantId,
    corpusId: input.scope.corpusId,
    graphVersion: input.snapshot.graphVersion,
  });
  const query = requiredText(input.query, 'query', KNOWLEDGE_GRAPH_LIMITS.maxQueryCharacters);
  const laneId = requiredIdentifier(input.laneId, 'laneId');
  if (!Number.isInteger(input.topK)
    || input.topK < 1
    || input.topK > KNOWLEDGE_GRAPH_LIMITS.maxTopK) {
    throw new Error(`Graph retrieval topK must be an integer between 1 and ${KNOWLEDGE_GRAPH_LIMITS.maxTopK}.`);
  }
  if (input.maxHops !== 1 && input.maxHops !== 2) {
    throw new Error('Graph retrieval maxHops must be 1 or 2.');
  }
  const trustLevel = input.snapshot.trustLevel;
  if (trustLevel && !input.scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error(`Graph retrieval trustLevel ${trustLevel} is not allowed by the current scope.`);
  }
  const seedPassageIds = [...new Set(
    (input.seedPassageIds ?? []).map((value) => requiredIdentifier(value, 'seedPassageId'))
  )].sort();
  if (seedPassageIds.length > KNOWLEDGE_GRAPH_LIMITS.maxSeedPassageIds) {
    throw new Error(
      `Graph retrieval seedPassageIds exceed ${KNOWLEDGE_GRAPH_LIMITS.maxSeedPassageIds}.`
    );
  }
  return {
    scope: {
      ...input.scope,
      tenantId: identity.tenantId,
      corpusId: identity.corpusId,
      allowedTrustLevels: [...input.scope.allowedTrustLevels],
    },
    snapshot: {
      graphVersion: identity.graphVersion,
      ...(input.snapshot.documentId
        ? { documentId: requiredIdentifier(input.snapshot.documentId, 'documentId') }
        : {}),
      ...(input.snapshot.documentVersion
        ? { documentVersion: requiredIdentifier(input.snapshot.documentVersion, 'documentVersion') }
        : {}),
      ...(trustLevel ? { trustLevel } : {}),
    },
    query,
    laneId,
    topK: input.topK,
    maxHops: input.maxHops,
    seedPassageIds,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

export function assertGraphRetrievalEvidence(
  evidence: RagEvidence,
  scope: RagRetrievalScope
): void {
  if (evidence.tenantId !== scope.tenantId) {
    throw new Error('Graph evidence tenantId does not match the retrieval scope.');
  }
  if (evidence.corpusId !== scope.corpusId) {
    throw new Error('Graph evidence corpusId does not match the retrieval scope.');
  }
  if (!scope.allowedTrustLevels.includes(evidence.trustLevel)) {
    throw new Error(`Graph evidence trustLevel ${evidence.trustLevel} is not allowed.`);
  }
  if (!evidence.content.trim()) {
    throw new Error('Graph evidence content must come from a non-empty source passage.');
  }
  const passageId = evidence.metadata?.graphPassageId;
  if (typeof passageId !== 'string' || !passageId.trim()) {
    throw new Error('Graph evidence metadata.graphPassageId is required.');
  }
  requiredGraphVersion(String(evidence.metadata?.graphVersion ?? ''));
}

export function createDeterministicKnowledgeGraphId(
  namespace: string,
  components: readonly string[]
): string {
  const normalizedNamespace = requiredScopeIdentifier(namespace, 'namespace').toLowerCase();
  if (components.length === 0) {
    throw new Error('Knowledge graph id components must not be empty.');
  }
  const digest = createHash('sha256')
    .update(normalizedNamespace)
    .update('\u0000')
    .update(components.map((value, index) =>
      requiredText(value, `components[${index}]`, KNOWLEDGE_GRAPH_LIMITS.maxIdentifierCharacters)
    ).join('\u001f'))
    .digest('hex');
  return `${normalizedNamespace}:${digest}`;
}

function requiredScopeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${field} must be a safe identifier of at most 128 characters.`);
  }
  return normalized;
}

function requiredGraphVersion(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) {
    throw new Error('graphVersion must be a safe identifier of at most 256 characters.');
  }
  return normalized;
}

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized
    || normalized.length > KNOWLEDGE_GRAPH_LIMITS.maxIdentifierCharacters
    || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${field} must be a non-empty identifier without control characters.`);
  }
  return normalized;
}

function requiredText(value: string, field: string, maxCharacters: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxCharacters || /\u0000/.test(normalized)) {
    throw new Error(`${field} must be non-empty and at most ${maxCharacters} characters.`);
  }
  return normalized;
}
