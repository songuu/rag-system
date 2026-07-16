import type { RagEvidence } from '../core/types';
import type { RagLaneHandler, RagLaneHandlerResult } from './lane-executor';
import type { RagRetrievalLane } from './retrieval-plan';
import type { GraphEdge, GraphNode, GraphPassage } from '../../mirofish/types';
import {
  assertArtifactAllowed,
  MIROFISH_GRAPH_ARTIFACT_LIMITS,
  type MiroFishGraphArtifact,
  type MiroFishGraphArtifactIdentity,
  type MiroFishGraphArtifactStore,
} from '../../mirofish/graph-artifact-store';
import type { RagTrustLevel } from '../../security/retrieval-scope';

export interface GraphEntityLaneOptions {
  store: MiroFishGraphArtifactStore;
  defaultMaxHops?: 1 | 2;
  maxEvidence?: number;
  maxSeedNodes?: number;
  maxExpansionStates?: number;
  maxExpansionEdges?: number;
  maxTraversalOperations?: number;
  maxTraversalEdges?: number;
  maxTraversalReferences?: number;
}

export interface GraphExpansionDiagnostics {
  seedCount: number;
  processedStateCount: number;
  inspectedEdgeCount: number;
  indexedEdgeCount: number;
  scoredEdgeCount: number;
  inspectedReferenceCount: number;
  operationCount: number;
  truncated: boolean;
}

export interface GraphPassageRanking {
  evidence: RagEvidence[];
  matchedEntityIds: string[];
  matchedCommunityIds: string[];
  expansionDiagnostics: GraphExpansionDiagnostics;
}

interface GraphEntityLaneConfig {
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  maxHops: 1 | 2;
}

interface PassageScore {
  score: number;
  entityIds: Set<string>;
  communityIds: Set<string>;
  minimumHop: number;
}

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'did', 'do', 'does', 'for', 'from', 'how', 'in',
  'is', 'of', 'on', 'the', 'to', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'with', '什么', '哪些', '如何', '是否', '关于',
]);

const GRAPH_EXPANSION_DEFAULTS = {
  maxSeedNodes: 128,
  maxExpansionStates: 2_048,
  maxExpansionEdges: 20_000,
} as const;

const GRAPH_EXPANSION_HARD_LIMITS = {
  maxSeedNodes: 512,
  maxExpansionStates: 4_096,
  maxExpansionEdges: 100_000,
} as const;

const GRAPH_TRAVERSAL_DEFAULTS = {
  maxTraversalOperations: 1_000_000,
  maxTraversalEdges: MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges,
  // Includes edge endpoints, source chunks, and community member lookups.
  maxTraversalReferences: 500_000,
} as const;

const GRAPH_TRAVERSAL_HARD_LIMITS = GRAPH_TRAVERSAL_DEFAULTS;
const GRAPH_TRAVERSAL_YIELD_INTERVAL = 256;

export function createGraphEntityLaneHandler(
  options: GraphEntityLaneOptions
): RagLaneHandler {
  const defaultMaxHops = options.defaultMaxHops ?? 2;
  const maxEvidence = options.maxEvidence ?? 20;
  const maxSeedNodes = readBoundedBudget(
    options.maxSeedNodes,
    GRAPH_EXPANSION_DEFAULTS.maxSeedNodes,
    GRAPH_EXPANSION_HARD_LIMITS.maxSeedNodes,
    'maxSeedNodes'
  );
  const maxExpansionStates = readBoundedBudget(
    options.maxExpansionStates,
    GRAPH_EXPANSION_DEFAULTS.maxExpansionStates,
    GRAPH_EXPANSION_HARD_LIMITS.maxExpansionStates,
    'maxExpansionStates'
  );
  const maxExpansionEdges = readBoundedBudget(
    options.maxExpansionEdges,
    GRAPH_EXPANSION_DEFAULTS.maxExpansionEdges,
    GRAPH_EXPANSION_HARD_LIMITS.maxExpansionEdges,
    'maxExpansionEdges'
  );
  const maxTraversalOperations = readBoundedBudget(
    options.maxTraversalOperations,
    GRAPH_TRAVERSAL_DEFAULTS.maxTraversalOperations,
    GRAPH_TRAVERSAL_HARD_LIMITS.maxTraversalOperations,
    'maxTraversalOperations'
  );
  const maxTraversalEdges = readBoundedBudget(
    options.maxTraversalEdges,
    GRAPH_TRAVERSAL_DEFAULTS.maxTraversalEdges,
    GRAPH_TRAVERSAL_HARD_LIMITS.maxTraversalEdges,
    'maxTraversalEdges'
  );
  const maxTraversalReferences = readBoundedBudget(
    options.maxTraversalReferences,
    GRAPH_TRAVERSAL_DEFAULTS.maxTraversalReferences,
    GRAPH_TRAVERSAL_HARD_LIMITS.maxTraversalReferences,
    'maxTraversalReferences'
  );
  if (defaultMaxHops !== 1 && defaultMaxHops !== 2) {
    throw new Error('Graph entity lane defaultMaxHops must be 1 or 2.');
  }
  if (!Number.isInteger(maxEvidence) || maxEvidence < 1) {
    throw new Error('Graph entity lane maxEvidence must be a positive integer.');
  }

  return {
    type: 'graph-entity',
    retriever: 'mirofish-graph-artifact-v2',
    async execute(context): Promise<RagLaneHandlerResult> {
      throwIfAborted(context.signal);
      const scope = context.request.retrievalScope;
      if (!scope) {
        throw new Error('Graph entity retrieval requires an explicit retrieval scope.');
      }
      const config = readLaneConfig(context.lane, defaultMaxHops);
      if (!config) {
        return noGain('graph_lane_not_configured');
      }
      const identity: MiroFishGraphArtifactIdentity = {
        tenantId: scope.tenantId,
        corpusId: scope.corpusId,
        documentId: config.documentId,
        documentVersion: config.documentVersion,
        trustLevel: config.trustLevel,
      };
      const artifact = await options.store.get(identity, scope);
      throwIfAborted(context.signal);
      if (!artifact) {
        return noGain('graph_artifact_missing', {
          documentVersion: config.documentVersion,
        });
      }
      // A custom store implementation must not be able to bypass lane checks.
      assertArtifactAllowed(artifact, identity, scope);
      const ranking = await rankGraphArtifactPassages({
        artifact,
        query: context.plan.query,
        laneId: context.lane.id,
        topK: Math.min(context.plan.top_k, maxEvidence),
        maxHops: config.maxHops,
        signal: context.signal,
        maxSeedNodes,
        maxExpansionStates,
        maxExpansionEdges,
        maxTraversalOperations,
        maxTraversalEdges,
        maxTraversalReferences,
      });
      if (ranking.evidence.length === 0) {
        return noGain('graph_no_passage_gain', {
          matchedEntityCount: ranking.matchedEntityIds.length,
          matchedCommunityCount: ranking.matchedCommunityIds.length,
          ...ranking.expansionDiagnostics,
        });
      }
      return {
        evidence: ranking.evidence,
        retrievalQuality: ranking.evidence[0]?.retrievalScore,
        stopReason: 'sufficient',
        metadata: {
          graphArtifactSchema: artifact.schemaVersion,
          documentVersion: artifact.documentVersion,
          maxHops: config.maxHops,
          matchedEntityCount: ranking.matchedEntityIds.length,
          matchedCommunityCount: ranking.matchedCommunityIds.length,
          passageCount: ranking.evidence.length,
          ...ranking.expansionDiagnostics,
        },
      };
    },
  };
}

/**
 * Ranks graph entities/communities, then maps every result back to source passages.
 * Graph summaries are intentionally never emitted as RagEvidence.
 */
export async function rankGraphArtifactPassages(input: {
  artifact: MiroFishGraphArtifact;
  query: string;
  laneId: string;
  topK: number;
  maxHops: 1 | 2;
  signal?: AbortSignal;
  maxSeedNodes?: number;
  maxExpansionStates?: number;
  maxExpansionEdges?: number;
  maxTraversalOperations?: number;
  maxTraversalEdges?: number;
  maxTraversalReferences?: number;
}): Promise<GraphPassageRanking> {
  throwIfSignalAborted(input.signal);
  const maxSeedNodes = readBoundedBudget(
    input.maxSeedNodes,
    GRAPH_EXPANSION_DEFAULTS.maxSeedNodes,
    GRAPH_EXPANSION_HARD_LIMITS.maxSeedNodes,
    'maxSeedNodes'
  );
  const maxExpansionStates = readBoundedBudget(
    input.maxExpansionStates,
    GRAPH_EXPANSION_DEFAULTS.maxExpansionStates,
    GRAPH_EXPANSION_HARD_LIMITS.maxExpansionStates,
    'maxExpansionStates'
  );
  const maxExpansionEdges = readBoundedBudget(
    input.maxExpansionEdges,
    GRAPH_EXPANSION_DEFAULTS.maxExpansionEdges,
    GRAPH_EXPANSION_HARD_LIMITS.maxExpansionEdges,
    'maxExpansionEdges'
  );
  const maxTraversalOperations = readBoundedBudget(
    input.maxTraversalOperations,
    GRAPH_TRAVERSAL_DEFAULTS.maxTraversalOperations,
    GRAPH_TRAVERSAL_HARD_LIMITS.maxTraversalOperations,
    'maxTraversalOperations'
  );
  const maxTraversalEdges = readBoundedBudget(
    input.maxTraversalEdges,
    GRAPH_TRAVERSAL_DEFAULTS.maxTraversalEdges,
    GRAPH_TRAVERSAL_HARD_LIMITS.maxTraversalEdges,
    'maxTraversalEdges'
  );
  const maxTraversalReferences = readBoundedBudget(
    input.maxTraversalReferences,
    GRAPH_TRAVERSAL_DEFAULTS.maxTraversalReferences,
    GRAPH_TRAVERSAL_HARD_LIMITS.maxTraversalReferences,
    'maxTraversalReferences'
  );
  if (!input.query.trim()) {
    return emptyRanking();
  }
  if (!input.laneId.trim()) throw new Error('Graph lane identity is required.');
  if (!Number.isInteger(input.topK)
    || input.topK < 1
    || input.topK > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages) {
    throw new Error(
      `Graph passage topK must be an integer between 1 and ${MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages}.`
    );
  }
  if (input.maxHops !== 1 && input.maxHops !== 2) {
    throw new Error('Graph passage maxHops must be 1 or 2.');
  }

  const queryTokens = tokenize(input.query);
  if (queryTokens.size === 0) {
    return emptyRanking();
  }
  const graph = input.artifact.graph;
  const traversal = new GraphTraversalBudget({
    signal: input.signal,
    maxOperations: maxTraversalOperations,
    maxReferences: maxTraversalReferences,
  });
  const nodes = new Map<string, GraphNode>();
  const nodeLimit = Math.min(
    graph.nodes.length,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes
  );
  if (graph.nodes.length > nodeLimit) traversal.markTruncated();
  for (let index = 0; index < nodeLimit; index++) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    const node = graph.nodes[index];
    nodes.set(node.uuid, node);
  }
  const edgeIndex = await buildEdgeIndexes(
    graph.edges,
    maxTraversalEdges,
    traversal
  );
  const { edgesByNode, edgesById, indexedEdges } = edgeIndex;
  const selectedScores = new Map<string, number>();
  const selectedHops = new Map<string, number>();
  const queue: Array<{ id: string; score: number; hop: number }> = [];
  const seedCandidates: Array<{ id: string; score: number }> = [];

  for (const node of nodes.values()) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    const score = scoreNode(node, input.query, queryTokens);
    if (score <= 0) continue;
    seedCandidates.push({ id: node.uuid, score });
  }
  seedCandidates.sort((left, right) =>
    right.score - left.score || left.id.localeCompare(right.id)
  );
  const seeds = seedCandidates.slice(0, maxSeedNodes);
  const bestQueuedStateScore = new Map<string, number>();
  for (const seed of seeds) {
    const { id, score } = seed;
    selectedScores.set(id, score);
    selectedHops.set(id, 0);
    queue.push({ id, score, hop: 0 });
    bestQueuedStateScore.set(createExpansionStateKey(id, 0), score);
  }

  const processedStates = new Set<string>();
  let inspectedEdgeCount = 0;
  let expansionTruncated = seedCandidates.length > seeds.length;

  expansion:
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const stateCheckpoint = traversal.consumeOperation();
    if (stateCheckpoint === false) break;
    if (stateCheckpoint) await stateCheckpoint;
    const current = queue[cursor];
    const stateKey = createExpansionStateKey(current.id, current.hop);
    if (processedStates.has(stateKey)) continue;
    if (current.score < (bestQueuedStateScore.get(stateKey) ?? current.score)) continue;
    if (processedStates.size >= maxExpansionStates) {
      expansionTruncated = true;
      break;
    }
    processedStates.add(stateKey);
    if (current.hop >= input.maxHops) continue;
    for (const edge of edgesByNode.get(current.id) ?? []) {
      const edgeCheckpoint = traversal.consumeOperation();
      if (edgeCheckpoint === false) break expansion;
      if (edgeCheckpoint) await edgeCheckpoint;
      if (inspectedEdgeCount >= maxExpansionEdges) {
        expansionTruncated = true;
        break expansion;
      }
      inspectedEdgeCount += 1;
      const neighborId = edge.source_node_uuid === current.id
        ? edge.target_node_uuid
        : edge.source_node_uuid;
      if (!nodes.has(neighborId)) continue;
      const hop = current.hop + 1;
      const edgeWeight = readEdgeWeight(edge);
      const score = current.score * edgeWeight * (hop === 1 ? 0.65 : 0.4);
      if (score <= (selectedScores.get(neighborId) ?? 0)) continue;
      selectedScores.set(neighborId, score);
      selectedHops.set(neighborId, hop);
      const neighborStateKey = createExpansionStateKey(neighborId, hop);
      if (processedStates.has(neighborStateKey)) continue;
      if (score <= (bestQueuedStateScore.get(neighborStateKey) ?? 0)) continue;
      bestQueuedStateScore.set(neighborStateKey, score);
      queue.push({ id: neighborId, score, hop });
    }
  }

  const passageScores = new Map<string, PassageScore>();
  for (const [entityId, score] of selectedScores) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    const node = nodes.get(entityId);
    if (!node) continue;
    const hop = selectedHops.get(entityId) ?? 0;
    for (const sourceChunk of readUnknownArray(node.attributes.sourceChunks)) {
      const referenceCheckpoint = traversal.consumeReferences(1);
      if (referenceCheckpoint === false) break;
      if (referenceCheckpoint) await referenceCheckpoint;
      const passageId = readTrimmedString(sourceChunk);
      if (!passageId) continue;
      addPassageScore(passageScores, passageId, score * (hop === 0 ? 2 : 1), {
        entityId,
        hop,
      });
    }
  }

  let scoredEdgeCount = 0;
  for (const edge of indexedEdges) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    scoredEdgeCount += 1;
    const sourceScore = selectedScores.get(edge.source_node_uuid);
    const targetScore = selectedScores.get(edge.target_node_uuid);
    if (sourceScore === undefined || targetScore === undefined) continue;
    const score = ((sourceScore + targetScore) / 2) * readEdgeWeight(edge);
    for (const sourceChunk of readUnknownArray(edge.attributes.sourceChunks)) {
      const referenceCheckpoint = traversal.consumeReferences(1);
      if (referenceCheckpoint === false) break;
      if (referenceCheckpoint) await referenceCheckpoint;
      const passageId = readTrimmedString(sourceChunk);
      if (!passageId) continue;
      addPassageScore(passageScores, passageId, score, {
        entityId: edge.source_node_uuid,
        hop: Math.min(
          selectedHops.get(edge.source_node_uuid) ?? input.maxHops,
          selectedHops.get(edge.target_node_uuid) ?? input.maxHops
        ),
      });
      addPassageScore(passageScores, passageId, 0, {
        entityId: edge.target_node_uuid,
      });
    }
  }

  const matchedCommunityIds: string[] = [];
  const communities = graph.communities ?? [];
  const communityLimit = Math.min(
    communities.length,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunities
  );
  if (communities.length > communityLimit) traversal.markTruncated();
  communities:
  for (let communityIndex = 0; communityIndex < communityLimit; communityIndex++) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    const community = communities[communityIndex];
    const lexicalScore = scoreTexts(
      queryTokens,
      [community.name, community.summary, ...community.keywords]
    );
    let memberScore = 0;
    for (const entityId of community.entities) {
      const referenceCheckpoint = traversal.consumeReferences(1);
      if (referenceCheckpoint === false) break communities;
      if (referenceCheckpoint) await referenceCheckpoint;
      memberScore = Math.max(memberScore, selectedScores.get(entityId) ?? 0);
    }
    const communityScore = lexicalScore + memberScore * 0.5;
    if (communityScore <= 0) continue;
    matchedCommunityIds.push(community.id);
    const passageIds = new Set<string>();
    for (const entityId of community.entities) {
      const entityCheckpoint = traversal.consumeReferences(1);
      if (entityCheckpoint === false) break communities;
      if (entityCheckpoint) await entityCheckpoint;
      const node = nodes.get(entityId);
      for (const sourceChunk of readUnknownArray(node?.attributes.sourceChunks)) {
        const sourceCheckpoint = traversal.consumeReferences(1);
        if (sourceCheckpoint === false) break communities;
        if (sourceCheckpoint) await sourceCheckpoint;
        const passageId = readTrimmedString(sourceChunk);
        if (!passageId) continue;
        passageIds.add(passageId);
      }
    }
    for (const relationId of community.relations) {
      const relationCheckpoint = traversal.consumeReferences(1);
      if (relationCheckpoint === false) break communities;
      if (relationCheckpoint) await relationCheckpoint;
      const edge = edgesById.get(relationId);
      for (const sourceChunk of readUnknownArray(edge?.attributes.sourceChunks)) {
        const sourceCheckpoint = traversal.consumeReferences(1);
        if (sourceCheckpoint === false) break communities;
        if (sourceCheckpoint) await sourceCheckpoint;
        const passageId = readTrimmedString(sourceChunk);
        if (!passageId) continue;
        passageIds.add(passageId);
      }
    }
    for (const passageId of passageIds) {
      const passageCheckpoint = traversal.consumeOperation();
      if (passageCheckpoint === false) break communities;
      if (passageCheckpoint) await passageCheckpoint;
      addPassageScore(passageScores, passageId, communityScore, {
        communityId: community.id,
      });
    }
  }

  const passagesById = new Map<string, GraphPassage>();
  const passageLimit = Math.min(
    graph.passages.length,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages
  );
  if (graph.passages.length > passageLimit) traversal.markTruncated();
  for (let index = 0; index < passageLimit; index++) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    const passage = graph.passages[index];
    passagesById.set(passage.id, passage);
  }
  const ranked: Array<[string, PassageScore]> = [];
  for (const entry of passageScores.entries()) {
    const checkpoint = traversal.consumeOperation();
    if (checkpoint === false) break;
    if (checkpoint) await checkpoint;
    if (passagesById.has(entry[0])) ranked.push(entry);
  }
  ranked.sort((left, right) => {
      const scoreDelta = right[1].score - left[1].score;
      if (scoreDelta !== 0) return scoreDelta;
      const leftPassage = passagesById.get(left[0]);
      const rightPassage = passagesById.get(right[0]);
      return (leftPassage?.index ?? 0) - (rightPassage?.index ?? 0)
        || left[0].localeCompare(right[0]);
    });
  const selectedPassages = ranked.slice(0, input.topK);

  return {
    evidence: selectedPassages.map(([passageId, ranking]) =>
      toEvidence(
        passagesById.get(passageId)!,
        ranking,
        input.artifact,
        input.laneId
      )
    ),
    matchedEntityIds: Array.from(selectedScores.keys()).sort(),
    matchedCommunityIds: matchedCommunityIds.sort(),
    expansionDiagnostics: {
      seedCount: seeds.length,
      processedStateCount: processedStates.size,
      inspectedEdgeCount,
      indexedEdgeCount: indexedEdges.length,
      scoredEdgeCount,
      inspectedReferenceCount: traversal.referenceCount,
      operationCount: traversal.operationCount,
      truncated: expansionTruncated || traversal.truncated,
    },
  };
}

function toEvidence(
  passage: GraphPassage,
  ranking: PassageScore,
  artifact: MiroFishGraphArtifact,
  laneId: string
): RagEvidence {
  return {
    id: `graph:${artifact.documentVersion}:${passage.id}`,
    tenantId: artifact.tenantId,
    corpusId: artifact.corpusId,
    documentId: artifact.documentId,
    documentVersion: artifact.documentVersion,
    content: passage.content,
    source: passage.source,
    page: passage.page,
    sectionPath: passage.section_path,
    startOffset: passage.start_offset,
    endOffset: passage.end_offset,
    retrievalScore: normalizeScore(ranking.score),
    trustLevel: artifact.trustLevel,
    laneId,
    metadata: {
      ...(passage.metadata ?? {}),
      graphId: artifact.graph.graph_id,
      graphArtifactSchema: artifact.schemaVersion,
      graphPassageId: passage.id,
      graphEntityIds: Array.from(ranking.entityIds).sort(),
      graphCommunityIds: Array.from(ranking.communityIds).sort(),
      graphMinimumHop: Number.isFinite(ranking.minimumHop) ? ranking.minimumHop : null,
    },
  };
}

function readLaneConfig(
  lane: RagRetrievalLane,
  defaultMaxHops: 1 | 2
): GraphEntityLaneConfig | null {
  const parameters = lane.parameters;
  if (!parameters) return null;
  const documentId = readNonEmptyString(parameters.documentId);
  const documentVersion = readNonEmptyString(parameters.documentVersion);
  const trustLevel = parameters.trustLevel;
  if (!documentId || !documentVersion || !isTrustLevel(trustLevel)) return null;
  const maxHops = parameters.maxHops ?? defaultMaxHops;
  if (maxHops !== 1 && maxHops !== 2) {
    throw new Error('Graph entity lane maxHops must be 1 or 2.');
  }
  return { documentId, documentVersion, trustLevel, maxHops };
}

function noGain(
  reason: string,
  metadata: Record<string, unknown> = {}
): RagLaneHandlerResult {
  return {
    evidence: [],
    stopReason: 'no_gain',
    metadata: { reason, ...metadata },
  };
}

function scoreNode(
  node: GraphNode,
  query: string,
  queryTokens: ReadonlySet<string>
): number {
  const aliases = readStringArray(node.attributes.aliases);
  let score = scoreTexts(queryTokens, [node.name, node.summary, ...node.labels, ...aliases]);
  const normalizedName = normalize(node.name);
  if (normalizedName && normalize(query).includes(normalizedName)) score += 2;
  return score;
}

function scoreTexts(
  queryTokens: ReadonlySet<string>,
  values: readonly string[]
): number {
  const candidateTokens = tokenize(values.join(' '));
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap++;
  }
  return overlap / Math.max(1, queryTokens.size);
}

function tokenize(value: string): Set<string> {
  const tokens = new Set<string>();
  const matches = normalize(value).match(/[a-z0-9][a-z0-9._:-]*|[\u3400-\u9fff]+/g) ?? [];
  for (const match of matches) {
    if (/[\u3400-\u9fff]/.test(match)) {
      if (!QUERY_STOP_WORDS.has(match)) tokens.add(match);
      for (let index = 0; index < match.length; index++) {
        const character = match[index];
        if (!QUERY_STOP_WORDS.has(character)) tokens.add(character);
        if (index + 1 < match.length) tokens.add(match.slice(index, index + 2));
      }
    } else if (!QUERY_STOP_WORDS.has(match) && match.length > 1) {
      tokens.add(match);
    }
  }
  return tokens;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFKC').trim();
}

type GraphTraversalCheckpoint = Promise<void> | false | undefined;

class GraphTraversalBudget {
  private readonly options: {
    signal?: AbortSignal;
    maxOperations: number;
    maxReferences: number;
  };
  private operations = 0;
  private references = 0;
  private lastYieldOperation = 0;
  private operationLimitReached = false;
  private referenceLimitReached = false;
  private wasTruncated = false;

  constructor(options: {
    signal?: AbortSignal;
    maxOperations: number;
    maxReferences: number;
  }) {
    this.options = options;
  }

  get operationCount(): number {
    return this.operations;
  }

  get referenceCount(): number {
    return this.references;
  }

  get referencesAvailable(): boolean {
    return !this.referenceLimitReached && !this.operationLimitReached;
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }

  markTruncated(): void {
    this.wasTruncated = true;
  }

  consumeOperation(): GraphTraversalCheckpoint {
    return this.consume(1, 0);
  }

  consumeReferences(count: number): GraphTraversalCheckpoint {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('Graph traversal reference count must be a positive integer.');
    }
    return this.consume(count, count);
  }

  private consume(
    operationCount: number,
    referenceCount: number
  ): GraphTraversalCheckpoint {
    throwIfSignalAborted(this.options.signal);
    if (this.operationLimitReached
      || this.operations + operationCount > this.options.maxOperations) {
      this.operationLimitReached = true;
      this.wasTruncated = true;
      return false;
    }
    if (referenceCount > 0
      && (this.referenceLimitReached
        || this.references + referenceCount > this.options.maxReferences)) {
      this.referenceLimitReached = true;
      this.wasTruncated = true;
      return false;
    }

    this.operations += operationCount;
    this.references += referenceCount;
    if (this.operations - this.lastYieldOperation < GRAPH_TRAVERSAL_YIELD_INTERVAL) {
      return undefined;
    }
    this.lastYieldOperation = this.operations;
    return yieldToEventLoop(this.options.signal);
  }
}

async function buildEdgeIndexes(
  edges: readonly GraphEdge[],
  maxTraversalEdges: number,
  traversal: GraphTraversalBudget
): Promise<{
  edgesByNode: Map<string, GraphEdge[]>;
  edgesById: Map<string, GraphEdge>;
  indexedEdges: GraphEdge[];
}> {
  const edgesByNode = new Map<string, GraphEdge[]>();
  const edgesById = new Map<string, GraphEdge>();
  const indexedEdges: GraphEdge[] = [];
  const edgeLimit = Math.min(
    edges.length,
    maxTraversalEdges,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges
  );
  if (edges.length > edgeLimit) traversal.markTruncated();

  for (let index = 0; index < edgeLimit; index++) {
    const operationCheckpoint = traversal.consumeOperation();
    if (operationCheckpoint === false) break;
    if (operationCheckpoint) await operationCheckpoint;
    const referenceCheckpoint = traversal.consumeReferences(2);
    if (referenceCheckpoint === false) break;
    if (referenceCheckpoint) await referenceCheckpoint;

    const edge = edges[index];
    indexedEdges.push(edge);
    edgesById.set(edge.uuid, edge);
    for (const nodeId of [edge.source_node_uuid, edge.target_node_uuid]) {
      const current = edgesByNode.get(nodeId) ?? [];
      current.push(edge);
      edgesByNode.set(nodeId, current);
    }
  }
  return { edgesByNode, edgesById, indexedEdges };
}

function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const immediate = setImmediate(() => {
      cleanup();
      try {
        throwIfSignalAborted(signal);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    const onAbort = () => {
      clearImmediate(immediate);
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function emptyRanking(): GraphPassageRanking {
  return {
    evidence: [],
    matchedEntityIds: [],
    matchedCommunityIds: [],
    expansionDiagnostics: {
      seedCount: 0,
      processedStateCount: 0,
      inspectedEdgeCount: 0,
      indexedEdgeCount: 0,
      scoredEdgeCount: 0,
      inspectedReferenceCount: 0,
      operationCount: 0,
      truncated: false,
    },
  };
}

function createExpansionStateKey(nodeId: string, hop: number): string {
  return `${hop}:${nodeId}`;
}

function readBoundedBudget(
  value: number | undefined,
  fallback: number,
  hardLimit: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > hardLimit) {
    throw new Error(`Graph entity lane ${name} must be an integer between 1 and ${hardLimit}.`);
  }
  return resolved;
}

function readEdgeWeight(edge: GraphEdge): number {
  const weight = edge.attributes.weight;
  return typeof weight === 'number' && Number.isFinite(weight)
    ? Math.min(1, Math.max(0, weight))
    : 1;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];
}

function readUnknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function addPassageScore(
  scores: Map<string, PassageScore>,
  passageId: string,
  score: number,
  input: { entityId?: string; communityId?: string; hop?: number }
): void {
  const current = scores.get(passageId) ?? {
    score: 0,
    entityIds: new Set<string>(),
    communityIds: new Set<string>(),
    minimumHop: Number.POSITIVE_INFINITY,
  };
  current.score += Math.max(0, score);
  if (input.entityId) current.entityIds.add(input.entityId);
  if (input.communityId) current.communityIds.add(input.communityId);
  if (input.hop !== undefined) current.minimumHop = Math.min(current.minimumHop, input.hop);
  scores.set(passageId, current);
}

function normalizeScore(score: number): number {
  return score <= 0 ? 0 : score / (score + 1);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isTrustLevel(value: unknown): value is RagTrustLevel {
  return value === 'trusted'
    || value === 'reviewed'
    || value === 'external'
    || value === 'quarantined';
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw createAbortError();
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal) throwIfAborted(signal);
}

function createAbortError(): Error {
  const error = new Error('Graph entity retrieval was aborted.');
  error.name = 'AbortError';
  return error;
}
