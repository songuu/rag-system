import { createHash, randomUUID } from 'crypto';
import { mkdir, open, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../security/retrieval-scope';
import { createRetrievalScope } from '../security/retrieval-scope';
import type { GraphData, GraphPassage } from './types';

export const MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION = 'mirofish-graph-artifact-v2' as const;
export const MIROFISH_GRAPH_ARTIFACT_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxNodes: 25_000,
  maxEdges: 100_000,
  maxPassages: 25_000,
  maxCommunities: 10_000,
  maxPassageCharacters: 10_000_000,
  maxSourceChunkReferences: 100_000,
  maxCommunityReferences: 100_000,
});

export interface MiroFishGraphArtifactIdentity {
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
}

export interface MiroFishGraphArtifact extends MiroFishGraphArtifactIdentity {
  schemaVersion: typeof MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION;
  graph: GraphData & {
    artifact_version: 'mirofish-graph-v2';
    passages: GraphPassage[];
  };
}

export interface MiroFishGraphArtifactStore {
  put(artifact: MiroFishGraphArtifact): Promise<void>;
  get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null>;
}

/**
 * Resource gate shared by durable artifacts and the legacy TaskManager result.
 * It intentionally runs before either store retains the graph, including for
 * direct library callers that do not yet have a full retrieval identity.
 */
export function assertMiroFishGraphDataResourceLimits(graph: GraphData): void {
  if (!isRecord(graph)) {
    throw new Error('Graph artifact must contain a graph object.');
  }
  if (!Array.isArray(graph.nodes)
    || graph.nodes.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes) {
    throw new Error('Graph artifact node count exceeds the configured limit.');
  }
  if (!Array.isArray(graph.edges)
    || graph.edges.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges) {
    throw new Error('Graph artifact edge count exceeds the configured limit.');
  }
  if (!Array.isArray(graph.passages)) {
    throw new Error('Graph artifact is missing source passages.');
  }
  if (graph.passages.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages) {
    throw new Error('Graph artifact passage count exceeds the configured limit.');
  }
  if (graph.communities !== undefined && !Array.isArray(graph.communities)) {
    throw new Error('Graph artifact communities must be an array.');
  }
  if ((graph.communities?.length ?? 0) > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunities) {
    throw new Error('Graph artifact community count exceeds the configured limit.');
  }

  let passageCharacters = 0;
  for (const passage of graph.passages) {
    if (!isRecord(passage) || typeof passage.content !== 'string') {
      throw new Error('Graph artifact contains a malformed passage.');
    }
    passageCharacters += passage.content.length;
    assertAggregateReferenceBudget(
      passageCharacters,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassageCharacters,
      'passage text'
    );
  }

  let sourceChunkReferenceCount = 0;
  for (const item of [...graph.nodes, ...graph.edges]) {
    if (!isRecord(item) || !isRecord(item.attributes)) {
      throw new Error('Graph artifact contains malformed source passage references.');
    }
    const sourceChunks = item.attributes.sourceChunks;
    if (sourceChunks === undefined) continue;
    if (!Array.isArray(sourceChunks)) {
      throw new Error('Graph artifact contains malformed source passage references.');
    }
    sourceChunkReferenceCount += sourceChunks.length;
    assertAggregateReferenceBudget(
      sourceChunkReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxSourceChunkReferences,
      'source passage'
    );
  }

  let communityReferenceCount = 0;
  for (const community of graph.communities ?? []) {
    if (!isRecord(community)
      || !Array.isArray(community.entities)
      || !Array.isArray(community.relations)) {
      throw new Error('Graph artifact contains malformed community references.');
    }
    communityReferenceCount += community.entities.length + community.relations.length;
    assertAggregateReferenceBudget(
      communityReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunityReferences,
      'community member'
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(graph);
  } catch (error) {
    throw new Error('Graph artifact cannot be safely serialized.', { cause: error });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes) {
    throw new Error('Graph artifact serialized bytes exceed the configured limit.');
  }
}

/**
 * Converts the compatibility GraphData object into a scope-bound retrieval artifact.
 * Missing security fields are stamped; conflicting fields are rejected rather than overwritten.
 */
export function createMiroFishGraphArtifact(input: {
  identity: MiroFishGraphArtifactIdentity;
  graph: GraphData;
}): MiroFishGraphArtifact {
  const identity = normalizeIdentity(input.identity);
  if (input.graph.graph_id !== identity.documentId) {
    throw new Error('Graph artifact document identity does not match graph_id.');
  }
  if (input.graph.artifact_version !== 'mirofish-graph-v2') {
    throw new Error('Graph artifact must use the mirofish-graph-v2 graph format.');
  }
  if (!Array.isArray(input.graph.passages)) {
    throw new Error('Graph artifact must retain source passages.');
  }

  const passages = input.graph.passages.map(passage =>
    bindPassageToIdentity(passage, identity)
  );
  const artifact: MiroFishGraphArtifact = {
    schemaVersion: MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION,
    ...identity,
    graph: {
      ...clone(input.graph),
      artifact_version: 'mirofish-graph-v2',
      passages,
    },
  };
  assertGraphArtifact(artifact);
  return artifact;
}

/**
 * Hermetic store for lane wiring and tests. Production persistence can implement
 * the same port without weakening the exact scope + version lookup contract.
 */
export class InMemoryMiroFishGraphArtifactStore implements MiroFishGraphArtifactStore {
  private readonly artifacts = new Map<string, MiroFishGraphArtifact>();

  async put(artifact: MiroFishGraphArtifact): Promise<void> {
    assertGraphArtifact(artifact);
    this.artifacts.set(createArtifactKey(artifact), clone(artifact));
  }

  async get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    const artifact = this.artifacts.get(createArtifactKey(normalized));
    if (!artifact) return null;
    assertArtifactAllowed(artifact, normalized, scope);
    return clone(artifact);
  }
}

/** Durable local adapter. Keys are hashed before path construction to prevent path traversal. */
export class FileMiroFishGraphArtifactStore implements MiroFishGraphArtifactStore {
  private readonly rootDir: string;
  private readonly maxFileBytes: number;

  constructor(
    rootDir = path.join(process.cwd(), 'uploads', 'mirofish-graph-artifacts-v2'),
    options: { maxFileBytes?: number } = {}
  ) {
    this.rootDir = path.resolve(rootDir);
    this.maxFileBytes = options.maxFileBytes ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes;
    if (!Number.isInteger(this.maxFileBytes) || this.maxFileBytes < 1
      || this.maxFileBytes > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes) {
      throw new Error('Graph artifact file limit is outside the allowed range.');
    }
  }

  async put(artifact: MiroFishGraphArtifact): Promise<void> {
    assertGraphArtifact(artifact);
    const file = this.getArtifactFile(artifact);
    const serialized = JSON.stringify(artifact, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) {
      throw new Error('Graph artifact exceeds the configured file byte limit.');
    }
    await mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, serialized, { encoding: 'utf-8', flag: 'wx' });
      await rename(temporaryFile, file);
    } catch (error) {
      try {
        await unlink(temporaryFile);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
          throw new Error('Graph artifact store could not clean up a temporary file.', {
            cause: cleanupError,
          });
        }
      }
      throw error;
    }
  }

  async get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    try {
      const file = this.getArtifactFile(normalized);
      const value = JSON.parse(
        await readBoundedArtifactFile(file, this.maxFileBytes)
      ) as MiroFishGraphArtifact;
      assertArtifactAllowed(value, normalized, scope);
      return clone(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw new Error('Graph artifact store rejected an unreadable or invalid artifact.', {
        cause: error,
      });
    }
  }

  private getArtifactFile(identity: MiroFishGraphArtifactIdentity): string {
    const digest = createHash('sha256')
      .update(createArtifactKey(identity))
      .digest('hex');
    return path.join(this.rootDir, digest.slice(0, 2), `${digest}.json`);
  }
}

export function assertArtifactAllowed(
  artifact: MiroFishGraphArtifact,
  identity: MiroFishGraphArtifactIdentity,
  scope: RagRetrievalScope
): void {
  assertGraphArtifact(artifact);
  assertIdentityWithinScope(identity, scope);
  for (const field of [
    'tenantId',
    'corpusId',
    'documentId',
    'documentVersion',
    'trustLevel',
  ] as const) {
    if (artifact[field] !== identity[field]) {
      throw new Error(`Graph artifact ${field} does not match the requested identity.`);
    }
  }
  if (artifact.trustLevel === 'quarantined') {
    throw new Error('Graph artifact is quarantined.');
  }
  if (!scope.allowedTrustLevels.includes(artifact.trustLevel)) {
    throw new Error('Graph artifact trust level is outside the retrieval scope.');
  }
}

function assertGraphArtifact(artifact: MiroFishGraphArtifact): void {
  if (!isRecord(artifact) || !isRecord(artifact.graph)) {
    throw new Error('Graph artifact must contain a graph object.');
  }
  if (artifact.schemaVersion !== MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION) {
    throw new Error('Unsupported graph artifact schema version.');
  }
  const identity = normalizeIdentity(artifact);
  if (artifact.graph.graph_id !== identity.documentId) {
    throw new Error('Graph artifact document identity does not match graph_id.');
  }
  if (artifact.graph.artifact_version !== 'mirofish-graph-v2') {
    throw new Error('Graph artifact has an unsupported graph format.');
  }
  assertMiroFishGraphDataResourceLimits(artifact.graph);
  if (!Array.isArray(artifact.graph.nodes)
    || artifact.graph.nodes.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes) {
    throw new Error('Graph artifact node count exceeds the configured limit.');
  }
  if (!Array.isArray(artifact.graph.edges)
    || artifact.graph.edges.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges) {
    throw new Error('Graph artifact edge count exceeds the configured limit.');
  }
  if (!Array.isArray(artifact.graph.passages)) {
    throw new Error('Graph artifact is missing source passages.');
  }
  if (artifact.graph.passages.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages) {
    throw new Error('Graph artifact passage count exceeds the configured limit.');
  }
  if ((artifact.graph.communities?.length ?? 0) > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunities) {
    throw new Error('Graph artifact community count exceeds the configured limit.');
  }

  if (!Number.isInteger(artifact.graph.node_count)
    || artifact.graph.node_count !== artifact.graph.nodes.length) {
    throw new Error('Graph artifact node_count does not match its nodes.');
  }
  if (!Number.isInteger(artifact.graph.edge_count)
    || artifact.graph.edge_count !== artifact.graph.edges.length) {
    throw new Error('Graph artifact edge_count does not match its edges.');
  }

  const passageIds = new Set<string>();
  let passageCharacters = 0;
  for (const passage of artifact.graph.passages) {
    assertPassageShape(passage, identity);
    addUniqueId(passageIds, passage.id, 'passage');
    passageCharacters += passage.content.length;
    if (passageCharacters > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassageCharacters) {
      throw new Error('Graph artifact passage text exceeds the configured limit.');
    }
  }

  const nodesById = new Map<string, (typeof artifact.graph.nodes)[number]>();
  let sourceChunkReferenceCount = 0;
  for (const node of artifact.graph.nodes) {
    assertNodeShape(node);
    addUniqueId(nodesById, node.uuid, 'node', node);
    sourceChunkReferenceCount += assertSourceChunkReferences(
      node.attributes,
      passageIds,
      `node ${node.uuid}`
    );
    assertAggregateReferenceBudget(
      sourceChunkReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxSourceChunkReferences,
      'source passage'
    );
  }

  const edgesById = new Map<string, (typeof artifact.graph.edges)[number]>();
  for (const edge of artifact.graph.edges) {
    assertEdgeShape(edge);
    addUniqueId(edgesById, edge.uuid, 'edge', edge);
    if (!nodesById.has(edge.source_node_uuid) || !nodesById.has(edge.target_node_uuid)) {
      throw new Error(`Graph edge ${edge.uuid} references a missing endpoint node.`);
    }
    sourceChunkReferenceCount += assertSourceChunkReferences(
      edge.attributes,
      passageIds,
      `edge ${edge.uuid}`
    );
    assertAggregateReferenceBudget(
      sourceChunkReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxSourceChunkReferences,
      'source passage'
    );
  }

  const communities = artifact.graph.communities ?? [];
  if (!Array.isArray(communities)) {
    throw new Error('Graph artifact communities must be an array.');
  }
  const communityIds = new Set<string>();
  for (const community of communities) {
    assertCommunityShape(community);
    addUniqueId(communityIds, community.id, 'community');
  }
  let communityReferenceCount = 0;
  for (const community of communities) {
    communityReferenceCount += community.entities.length + community.relations.length;
    assertAggregateReferenceBudget(
      communityReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunityReferences,
      'community member'
    );
    for (const nodeId of community.entities) {
      if (!nodesById.has(nodeId)) {
        throw new Error(`Graph community ${community.id} references a missing node.`);
      }
    }
    for (const edgeId of community.relations) {
      if (!edgesById.has(edgeId)) {
        throw new Error(`Graph community ${community.id} references a missing edge.`);
      }
    }
    if (community.parent_id !== undefined) {
      if (community.parent_id === community.id || !communityIds.has(community.parent_id)) {
        throw new Error(`Graph community ${community.id} references an invalid parent.`);
      }
    }
  }
}

function bindPassageToIdentity(
  passage: GraphPassage,
  identity: MiroFishGraphArtifactIdentity
): GraphPassage {
  if (!isRecord(passage)) {
    throw new Error('Graph passage must be an object.');
  }
  if (!isNonEmptyIdentifier(passage.id)
    || typeof passage.content !== 'string'
    || !passage.content.trim()) {
    throw new Error('Graph passage must contain a non-empty identity and content.');
  }
  if (
    !Number.isInteger(passage.start_offset) ||
    !Number.isInteger(passage.end_offset) ||
    passage.start_offset < 0 ||
    passage.end_offset <= passage.start_offset
  ) {
    throw new Error('Graph passage contains an invalid source span.');
  }
  const fields = {
    document_id: identity.documentId,
    tenant_id: identity.tenantId,
    corpus_id: identity.corpusId,
    document_version: identity.documentVersion,
    trust_level: identity.trustLevel,
  } as const;
  for (const [field, expected] of Object.entries(fields)) {
    const actual = passage[field as keyof GraphPassage];
    if (actual !== undefined && actual !== expected) {
      throw new Error(`Graph passage ${field} conflicts with its artifact identity.`);
    }
  }
  return { ...clone(passage), ...fields };
}

function assertPassageShape(
  passage: GraphPassage,
  identity: MiroFishGraphArtifactIdentity
): void {
  bindPassageToIdentity(passage, identity);
  if (!Number.isInteger(passage.index) || passage.index < 0) {
    throw new Error(`Graph passage ${passage.id} contains an invalid index.`);
  }
  if (passage.document_id !== identity.documentId
    || passage.tenant_id !== identity.tenantId
    || passage.corpus_id !== identity.corpusId
    || passage.document_version !== identity.documentVersion
    || passage.trust_level !== identity.trustLevel) {
    throw new Error(`Graph passage ${passage.id} is missing its exact artifact identity.`);
  }
  if (passage.source !== undefined && !isNonEmptyString(passage.source)) {
    throw new Error(`Graph passage ${passage.id} contains an invalid source.`);
  }
  if (passage.page !== undefined
    && (!Number.isInteger(passage.page) || passage.page < 1)) {
    throw new Error(`Graph passage ${passage.id} contains an invalid page.`);
  }
  if (passage.section_path !== undefined) {
    assertStringArray(passage.section_path, `passage ${passage.id} section_path`);
  }
  if (passage.metadata !== undefined && !isRecord(passage.metadata)) {
    throw new Error(`Graph passage ${passage.id} contains invalid metadata.`);
  }
}

function assertNodeShape(node: MiroFishGraphArtifact['graph']['nodes'][number]): void {
  if (!isRecord(node)
    || !isNonEmptyIdentifier(node.uuid)
    || !isNonEmptyString(node.name)
    || typeof node.summary !== 'string'
    || !isRecord(node.attributes)) {
    throw new Error('Graph artifact contains a malformed node.');
  }
  assertStringArray(node.labels, `node ${node.uuid} labels`);
  assertOptionalString(node.created_at, `node ${node.uuid} created_at`);
}

function assertEdgeShape(edge: MiroFishGraphArtifact['graph']['edges'][number]): void {
  if (!isRecord(edge)
    || !isNonEmptyIdentifier(edge.uuid)
    || !isNonEmptyString(edge.name)
    || typeof edge.fact !== 'string'
    || !isNonEmptyString(edge.fact_type)
    || !isNonEmptyIdentifier(edge.source_node_uuid)
    || !isNonEmptyIdentifier(edge.target_node_uuid)
    || !isNonEmptyString(edge.source_node_name)
    || !isNonEmptyString(edge.target_node_name)
    || !isRecord(edge.attributes)) {
    throw new Error('Graph artifact contains a malformed edge.');
  }
  assertStringArray(edge.episodes, `edge ${edge.uuid} episodes`);
  for (const field of ['created_at', 'valid_at', 'invalid_at', 'expired_at'] as const) {
    assertOptionalString(edge[field], `edge ${edge.uuid} ${field}`);
  }
}

function assertCommunityShape(
  community: NonNullable<MiroFishGraphArtifact['graph']['communities']>[number]
): void {
  if (!isRecord(community)
    || !isNonEmptyIdentifier(community.id)
    || !isNonEmptyString(community.name)
    || typeof community.summary !== 'string'
    || !Number.isInteger(community.level)
    || community.level < 0) {
    throw new Error('Graph artifact contains a malformed community.');
  }
  assertIdentifierArray(
    community.entities,
    `community ${community.id} entities`,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes
  );
  assertIdentifierArray(
    community.relations,
    `community ${community.id} relations`,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges
  );
  assertStringArray(community.keywords, `community ${community.id} keywords`);
  assertOptionalIdentifier(community.parent_id, `community ${community.id} parent_id`);
}

function assertSourceChunkReferences(
  attributes: Record<string, unknown>,
  passageIds: ReadonlySet<string>,
  owner: string
): number {
  const sourceChunks = attributes.sourceChunks;
  if (sourceChunks === undefined) return 0;
  assertIdentifierArray(
    sourceChunks,
    `${owner} sourceChunks`,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages
  );
  const seen = new Set<string>();
  for (const passageId of sourceChunks) {
    if (seen.has(passageId)) {
      throw new Error(`Graph ${owner} contains a duplicate sourceChunks reference.`);
    }
    seen.add(passageId);
    if (!passageIds.has(passageId)) {
      throw new Error(`Graph ${owner} references a missing source passage.`);
    }
  }
  return sourceChunks.length;
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => !isNonEmptyString(item))) {
    throw new Error(`Graph ${field} must be an array of non-empty strings.`);
  }
}

function assertIdentifierArray(
  value: unknown,
  field: string,
  maxEntries = Number.MAX_SAFE_INTEGER
): asserts value is string[] {
  if (!Array.isArray(value)
    || value.length > maxEntries
    || value.some(item => !isNonEmptyIdentifier(item))) {
    throw new Error(`Graph ${field} must be an array of valid identifiers.`);
  }
}

function assertAggregateReferenceBudget(
  count: number,
  limit: number,
  kind: string
): void {
  if (count > limit) {
    throw new Error(`Graph artifact ${kind} references exceed the configured limit.`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new Error(`Graph ${field} must be a non-empty string when provided.`);
  }
}

function assertOptionalIdentifier(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyIdentifier(value)) {
    throw new Error(`Graph ${field} must be a valid identifier when provided.`);
  }
}

function addUniqueId(
  collection: Set<string> | Map<string, unknown>,
  id: string,
  kind: string,
  value: unknown = true
): void {
  if (collection.has(id)) {
    throw new Error(`Graph artifact contains a duplicate ${kind} identity.`);
  }
  if (collection instanceof Map) collection.set(id, value);
  else collection.add(id);
}

async function readBoundedArtifactFile(
  file: string,
  maxFileBytes: number
): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new Error('Graph artifact path is not a regular file.');
    }

    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal <= maxFileBytes) {
      const bytesRemaining = maxFileBytes + 1 - bytesReadTotal;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, bytesRemaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal > maxFileBytes) {
      throw new Error('Graph artifact exceeds the configured file byte limit.');
    }
    return Buffer.concat(chunks, bytesReadTotal).toString('utf8');
  } finally {
    await handle.close();
  }
}

function assertIdentityWithinScope(
  identity: MiroFishGraphArtifactIdentity,
  scope: RagRetrievalScope
): void {
  if (identity.tenantId !== scope.tenantId) {
    throw new Error('Graph artifact tenant scope mismatch.');
  }
  if (identity.corpusId !== scope.corpusId) {
    throw new Error('Graph artifact corpus scope mismatch.');
  }
  if (identity.trustLevel === 'quarantined') {
    throw new Error('Graph artifact is quarantined.');
  }
  if (!scope.allowedTrustLevels.includes(identity.trustLevel)) {
    throw new Error('Graph artifact trust level is outside the retrieval scope.');
  }
}

function normalizeIdentity(
  identity: MiroFishGraphArtifactIdentity
): MiroFishGraphArtifactIdentity {
  const scope = createRetrievalScope({
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    allowedTrustLevels: [identity.trustLevel],
    enforceIsolation: true,
  });
  const documentId = normalizeDocumentField(identity.documentId, 'documentId');
  const documentVersion = normalizeDocumentField(
    identity.documentVersion,
    'documentVersion'
  );
  return {
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    documentId,
    documentVersion,
    trustLevel: identity.trustLevel,
  };
}

function normalizeDocumentField(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${field} must be a non-empty identifier without control characters.`);
  }
  return normalized;
}

function createArtifactKey(identity: MiroFishGraphArtifactIdentity): string {
  return JSON.stringify([
    identity.tenantId,
    identity.corpusId,
    identity.documentId,
    identity.documentVersion,
    identity.trustLevel,
  ]);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return isNonEmptyString(value)
    && value.length <= 512
    && !/[\u0000-\u001f]/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
