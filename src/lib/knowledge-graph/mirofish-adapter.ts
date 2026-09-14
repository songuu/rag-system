import { createHash } from 'node:crypto';
import {
  createMiroFishGraphArtifact,
  type MiroFishGraphArtifact,
  type MiroFishGraphArtifactIdentity,
} from '../mirofish/graph-artifact-store';
import type { GraphData, GraphEdge, GraphNode } from '../mirofish/types';
import type {
  KnowledgeGraphClaim,
  KnowledgeGraphSnapshot,
  KnowledgeGraphSnapshotStatus,
} from './contracts';

export function mapMiroFishArtifactToKnowledgeGraphSnapshot(
  artifact: MiroFishGraphArtifact,
  options: {
    graphVersion?: string;
    graphName?: string;
    status?: KnowledgeGraphSnapshotStatus;
    createdAt?: string;
    expiresAt?: string;
  } = {}
): KnowledgeGraphSnapshot {
  const graphVersion = options.graphVersion?.trim() || createMiroFishGraphVersion(artifact);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const passageIds = new Set(artifact.graph.passages.map((passage) => passage.id));
  const entities = artifact.graph.nodes.map((node) => ({
    id: node.uuid,
    name: node.name,
    normalizedName: normalizeEntityName(node.name),
    labels: [...node.labels],
    summary: node.summary,
    aliases: readStringArray(node.attributes.aliases),
    passageIds: filterPassageIds(node.attributes.sourceChunks, passageIds),
    attributes: cloneRecord(node.attributes),
    ...(node.created_at ? { createdAt: node.created_at } : {}),
  }));
  const claims = artifact.graph.edges.map((edge) => mapEdge(edge, passageIds));

  return {
    tenantId: artifact.tenantId,
    corpusId: artifact.corpusId,
    graphVersion,
    graphId: artifact.graph.graph_id,
    ...(options.graphName ? { graphName: options.graphName } : {}),
    status: options.status ?? 'staging',
    artifactDigest: createArtifactDigest(artifact),
    createdAt,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    documents: [{
      documentId: artifact.documentId,
      documentVersion: artifact.documentVersion,
      trustLevel: artifact.trustLevel,
    }],
    passages: artifact.graph.passages.map((passage) => ({
      id: passage.id,
      documentId: passage.document_id,
      documentVersion: artifact.documentVersion,
      trustLevel: artifact.trustLevel,
      content: passage.content,
      index: passage.index,
      startOffset: passage.start_offset,
      endOffset: passage.end_offset,
      ...(passage.source ? { source: passage.source } : {}),
      ...(passage.page !== undefined ? { page: passage.page } : {}),
      ...(passage.section_path ? { sectionPath: [...passage.section_path] } : {}),
      ...(passage.metadata ? { metadata: cloneRecord(passage.metadata) } : {}),
    })),
    entities,
    claims,
    communities: (artifact.graph.communities ?? []).map((community) => ({
      id: community.id,
      name: community.name,
      entityIds: [...community.entities],
      claimIds: [...community.relations],
      summary: community.summary,
      keywords: [...community.keywords],
      level: community.level,
      ...(community.parent_id ? { parentId: community.parent_id } : {}),
    })),
  };
}

/**
 * A compatibility artifact is identified by scope, document revision, and trust.
 * Hashing all five fields prevents two tenants or trust classifications from
 * aliasing the same immutable Neo4j snapshot version.
 */
export function createMiroFishGraphVersion(
  identity: MiroFishGraphArtifactIdentity
): string {
  const serializedIdentity = stableStringify({
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    documentId: identity.documentId,
    documentVersion: identity.documentVersion,
    trustLevel: identity.trustLevel,
  });
  return `mirofish:${createHash('sha256').update(serializedIdentity).digest('hex')}`;
}

export function mapKnowledgeGraphSnapshotToMiroFishArtifact(
  snapshot: KnowledgeGraphSnapshot,
  identity: MiroFishGraphArtifactIdentity
): MiroFishGraphArtifact {
  assertSnapshotScope(snapshot, identity);
  const entityNames = new Map(snapshot.entities.map((entity) => [entity.id, entity.name]));
  const graph: GraphData = {
    graph_id: identity.documentId,
    artifact_version: 'mirofish-graph-v2',
    nodes: snapshot.entities.map((entity): GraphNode => ({
      uuid: entity.id,
      name: entity.name,
      labels: [...entity.labels],
      summary: entity.summary,
      attributes: cloneRecord(entity.attributes),
      ...(entity.createdAt ? { created_at: entity.createdAt } : {}),
    })),
    edges: snapshot.claims.map((claim): GraphEdge => ({
      uuid: claim.id,
      name: claim.predicate,
      fact: claim.fact,
      fact_type: claim.factType,
      source_node_uuid: claim.sourceEntityId,
      target_node_uuid: claim.targetEntityId,
      source_node_name:
        claim.sourceEntityName || entityNames.get(claim.sourceEntityId) || claim.sourceEntityId,
      target_node_name:
        claim.targetEntityName || entityNames.get(claim.targetEntityId) || claim.targetEntityId,
      attributes: cloneRecord(claim.attributes),
      episodes: [...claim.episodes],
      ...(claim.createdAt ? { created_at: claim.createdAt } : {}),
      ...(claim.validAt ? { valid_at: claim.validAt } : {}),
      ...(claim.invalidAt ? { invalid_at: claim.invalidAt } : {}),
      ...(claim.expiredAt ? { expired_at: claim.expiredAt } : {}),
    })),
    passages: snapshot.passages
      .filter((passage) =>
        passage.documentId === identity.documentId
        && passage.documentVersion === identity.documentVersion
        && passage.trustLevel === identity.trustLevel
      )
      .map((passage) => ({
        id: passage.id,
        document_id: passage.documentId,
        content: passage.content,
        index: passage.index,
        start_offset: passage.startOffset,
        end_offset: passage.endOffset,
        ...(passage.source ? { source: passage.source } : {}),
        ...(passage.page !== undefined ? { page: passage.page } : {}),
        ...(passage.sectionPath ? { section_path: [...passage.sectionPath] } : {}),
        tenant_id: snapshot.tenantId,
        corpus_id: snapshot.corpusId,
        document_version: identity.documentVersion,
        trust_level: identity.trustLevel,
        ...(passage.metadata ? { metadata: cloneRecord(passage.metadata) } : {}),
      })),
    communities: snapshot.communities.map((community) => ({
      id: community.id,
      name: community.name,
      entities: [...community.entityIds],
      relations: [...community.claimIds],
      summary: community.summary,
      keywords: [...community.keywords],
      level: community.level,
      ...(community.parentId ? { parent_id: community.parentId } : {}),
    })),
    node_count: snapshot.entities.length,
    edge_count: snapshot.claims.length,
  };
  return createMiroFishGraphArtifact({ identity, graph });
}

function mapEdge(
  edge: GraphEdge,
  knownPassageIds: ReadonlySet<string>
): KnowledgeGraphClaim {
  const sourceChunks = filterPassageIds(edge.attributes.sourceChunks, knownPassageIds);
  const episodes = filterPassageIds(edge.episodes, knownPassageIds);
  const rawConfidence = readFiniteNumber(
    edge.attributes.confidence,
    readFiniteNumber(edge.attributes.weight, 1)
  );
  return {
    id: edge.uuid,
    predicate: edge.name,
    fact: edge.fact,
    factType: edge.fact_type,
    sourceEntityId: edge.source_node_uuid,
    targetEntityId: edge.target_node_uuid,
    sourceEntityName: edge.source_node_name,
    targetEntityName: edge.target_node_name,
    episodes: [...edge.episodes],
    passageIds: [...new Set([...sourceChunks, ...episodes])].sort(),
    confidence: Math.max(0, Math.min(1, rawConfidence)),
    status: edge.expired_at
      ? 'expired'
      : edge.invalid_at
        ? 'invalid'
        : 'active',
    attributes: cloneRecord(edge.attributes),
    ...(edge.created_at ? { createdAt: edge.created_at } : {}),
    ...(edge.valid_at ? { validAt: edge.valid_at } : {}),
    ...(edge.invalid_at ? { invalidAt: edge.invalid_at } : {}),
    ...(edge.expired_at ? { expiredAt: edge.expired_at } : {}),
  };
}

function assertSnapshotScope(
  snapshot: KnowledgeGraphSnapshot,
  identity: MiroFishGraphArtifactIdentity
): void {
  if (snapshot.tenantId !== identity.tenantId || snapshot.corpusId !== identity.corpusId) {
    throw new Error('Knowledge graph snapshot scope does not match the artifact identity.');
  }
  const matchesRequestedDocument = (candidate: {
    documentId: string;
    documentVersion: string;
    trustLevel: string;
  }) =>
    candidate.documentId === identity.documentId
    && candidate.documentVersion === identity.documentVersion
    && candidate.trustLevel === identity.trustLevel;
  if (
    snapshot.documents.length !== 1
    || !matchesRequestedDocument(snapshot.documents[0])
    || snapshot.passages.some(passage => !matchesRequestedDocument(passage))
  ) {
    throw new Error(
      'A compatibility graph snapshot must contain exactly the requested document version.'
    );
  }
}

function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function filterPassageIds(
  value: unknown,
  knownPassageIds: ReadonlySet<string>
): string[] {
  return readStringArray(value).filter((id) => knownPassageIds.has(id)).sort();
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function createArtifactDigest(artifact: MiroFishGraphArtifact): string {
  return `sha256:${createHash('sha256').update(stableStringify(artifact)).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
