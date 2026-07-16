import type { RagRetrievalScope } from '../../security/retrieval-scope';

export const MILVUS_HYBRID_POLICY_VERSION = 'milvus-hybrid/v1' as const;
export const MILVUS_HYBRID_MANIFEST_VERSION = 'milvus-hybrid-manifest/v1' as const;

export type MilvusHybridRolloutMode = 'off' | 'shadow' | 'active';
export type MilvusHybridFusionMethod = 'rrf' | 'weighted';

export interface MilvusHybridCapability {
  nativeHybridSearch: boolean;
  bm25Function: boolean;
  schemaCompatible: boolean;
  provider: string;
  serverVersion?: string;
  reason?: string;
}

export interface MilvusHybridCapabilityProbe {
  probe(input: {
    collectionName: string;
    signal?: AbortSignal;
  }): Promise<MilvusHybridCapability>;
}

export interface MilvusHybridHit {
  id: string;
  score: number;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface MilvusHybridSearchRequest {
  collectionName: string;
  query: string;
  denseEmbedding: number[];
  sparseVector?: Record<number, number>;
  topK: number;
  scope: RagRetrievalScope;
  fusion?: MilvusHybridFusionMethod;
  signal?: AbortSignal;
}

export interface MilvusHybridSearchPort extends MilvusHybridCapabilityProbe {
  search(request: MilvusHybridSearchRequest): Promise<MilvusHybridHit[]>;
}

export interface MilvusHybridSearchResponse {
  version: typeof MILVUS_HYBRID_POLICY_VERSION;
  mode: MilvusHybridRolloutMode;
  participatesInGeneration: boolean;
  hits: MilvusHybridHit[];
  shadowHits: MilvusHybridHit[];
  capability?: MilvusHybridCapability;
  stopReason: 'disabled' | 'shadow_only' | 'sufficient' | 'no_gain';
}

export interface HybridFusedCandidate extends MilvusHybridHit {
  fusionScore: number;
  matchedLanes: string[];
  laneRanks: Record<string, number>;
}

export interface HybridIndexDocument {
  id: string;
  rawContent: string;
  denseText: string;
  sparseText: string;
  sourceHash: string;
  documentVersion: string;
  contextualIdentity?: string;
}

export interface MilvusHybridCollectionManifest {
  version: typeof MILVUS_HYBRID_MANIFEST_VERSION;
  collectionName: string;
  sourceCollectionName: string;
  corpusVersion: string;
  embeddingModel: string;
  embeddingDimension: number;
  rawTextField: string;
  denseVectorField: string;
  sparseVectorField: string;
  bm25OutputField: string;
  fusionVersion: string;
}

export function resolveMilvusHybridRolloutMode(
  env: Record<string, string | undefined> = process.env
): MilvusHybridRolloutMode {
  const requested = env.MILVUS_HYBRID_MODE?.trim().toLowerCase();
  if (requested === undefined || requested === '') {
    // A legacy boolean can only opt into shadow mode; it cannot silently change evidence.
    return env.MILVUS_HYBRID_ENABLED === 'true' ? 'shadow' : 'off';
  }
  if (requested === 'off' || requested === 'shadow' || requested === 'active') {
    return requested;
  }
  throw new Error('Unsupported MILVUS_HYBRID_MODE: ' + requested);
}

export function isHybridCapabilityUsable(
  capability: MilvusHybridCapability
): boolean {
  return capability.nativeHybridSearch && capability.bm25Function && capability.schemaCompatible;
}

export async function milvusHybridSearch(
  request: MilvusHybridSearchRequest,
  options: { port: MilvusHybridSearchPort; mode?: MilvusHybridRolloutMode }
): Promise<MilvusHybridSearchResponse> {
  validateHybridRequest(request);
  const mode = validateHybridMode(options.mode ?? resolveMilvusHybridRolloutMode());
  if (mode === 'off') {
    return {
      version: MILVUS_HYBRID_POLICY_VERSION,
      mode,
      participatesInGeneration: false,
      hits: [],
      shadowHits: [],
      stopReason: 'disabled',
    };
  }

  const capability = validateHybridCapability(await options.port.probe({
    collectionName: request.collectionName,
    signal: request.signal,
  }));
  if (!isHybridCapabilityUsable(capability)) {
    if (mode === 'active') {
      throw new Error(
        'Milvus hybrid active mode requires native hybrid, BM25, and a compatible shadow schema.'
      );
    }
    return {
      version: MILVUS_HYBRID_POLICY_VERSION,
      mode,
      participatesInGeneration: false,
      hits: [],
      shadowHits: [],
      capability,
      stopReason: 'shadow_only',
    };
  }

  const hybridHits = validateHybridHits(await options.port.search(request)).slice(0, request.topK);
  if (mode === 'shadow') {
    return {
      version: MILVUS_HYBRID_POLICY_VERSION,
      mode,
      participatesInGeneration: false,
      hits: [],
      shadowHits: hybridHits,
      capability,
      stopReason: 'shadow_only',
    };
  }
  return {
    version: MILVUS_HYBRID_POLICY_VERSION,
    mode,
    participatesInGeneration: true,
    hits: hybridHits,
    shadowHits: [],
    capability,
    stopReason: hybridHits.length > 0 ? 'sufficient' : 'no_gain',
  };
}

export function reciprocalRankFusion(
  lanes: Readonly<Record<string, readonly MilvusHybridHit[]>>,
  options: { rankConstant?: number; laneWeights?: Record<string, number>; topK?: number } = {}
): HybridFusedCandidate[] {
  const rankConstant = options.rankConstant ?? 60;
  if (!Number.isFinite(rankConstant) || rankConstant <= 0) {
    throw new Error('RRF rankConstant must be positive.');
  }
  const accumulator = createFusionAccumulator(lanes);
  for (const [laneId, hits] of Object.entries(lanes)) {
    const weight = options.laneWeights?.[laneId] ?? 1;
    validateLaneWeight(laneId, weight);
    if (weight === 0) continue;
    uniqueLaneHits(hits).forEach((hit, index) => {
      const rank = index + 1;
      mergeFusionCandidate(accumulator, laneId, hit, rank, weight / (rankConstant + rank));
    });
  }
  return finalizeFusion(accumulator, options.topK);
}

export function weightedScoreFusion(
  lanes: Readonly<Record<string, readonly MilvusHybridHit[]>>,
  options: { laneWeights: Record<string, number>; topK?: number }
): HybridFusedCandidate[] {
  const accumulator = createFusionAccumulator(lanes);
  let positiveWeight = false;
  for (const [laneId, hits] of Object.entries(lanes)) {
    const weight = options.laneWeights[laneId] ?? 0;
    validateLaneWeight(laneId, weight);
    positiveWeight ||= weight > 0;
    if (weight === 0) continue;
    const uniqueHits = uniqueLaneHits(hits);
    const normalized = normalizeLaneScores(uniqueHits);
    uniqueHits.forEach((hit, index) => {
      mergeFusionCandidate(accumulator, laneId, hit, index + 1, weight * normalized[index]);
    });
  }
  if (!positiveWeight && Object.keys(lanes).length > 0) {
    throw new Error('Weighted fusion requires at least one positive lane weight.');
  }
  return finalizeFusion(accumulator, options.topK);
}

export function createHybridIndexDocument(input: {
  id: string;
  rawContent: string;
  contextualPreamble?: string;
  sourceHash: string;
  documentVersion: string;
  contextualIdentity?: string;
}): HybridIndexDocument {
  assertNonBlank(input.rawContent, 'rawContent');
  const rawContent = input.rawContent;
  const contextualPreamble = input.contextualPreamble?.trim();
  return {
    id: required(input.id, 'id'),
    rawContent,
    denseText: contextualPreamble ? contextualPreamble + '\n\n' + rawContent : rawContent,
    // BM25 sees the source passage, never LLM-generated terms.
    sparseText: rawContent,
    sourceHash: required(input.sourceHash, 'sourceHash'),
    documentVersion: required(input.documentVersion, 'documentVersion'),
    contextualIdentity: input.contextualIdentity,
  };
}

export function createMilvusHybridCollectionManifest(
  input: Omit<MilvusHybridCollectionManifest, 'version'>
): MilvusHybridCollectionManifest {
  if (!Number.isInteger(input.embeddingDimension) || input.embeddingDimension < 1) {
    throw new Error('Hybrid manifest embeddingDimension must be a positive integer.');
  }
  const fields = [
    input.rawTextField,
    input.denseVectorField,
    input.sparseVectorField,
    input.bm25OutputField,
  ].map((field, index) => safeIdentifier(field, 'field[' + index + ']'));
  if (new Set(fields).size !== fields.length) {
    throw new Error('Hybrid manifest fields must be distinct.');
  }
  return {
    version: MILVUS_HYBRID_MANIFEST_VERSION,
    collectionName: safeIdentifier(input.collectionName, 'collectionName'),
    sourceCollectionName: safeIdentifier(input.sourceCollectionName, 'sourceCollectionName'),
    corpusVersion: required(input.corpusVersion, 'corpusVersion'),
    embeddingModel: required(input.embeddingModel, 'embeddingModel'),
    embeddingDimension: input.embeddingDimension,
    rawTextField: fields[0],
    denseVectorField: fields[1],
    sparseVectorField: fields[2],
    bm25OutputField: fields[3],
    fusionVersion: required(input.fusionVersion, 'fusionVersion'),
  };
}

function validateHybridRequest(request: MilvusHybridSearchRequest): void {
  safeIdentifier(request.collectionName, 'collectionName');
  required(request.query, 'query');
  if (!Array.isArray(request.denseEmbedding) || request.denseEmbedding.length === 0) {
    throw new Error('Hybrid denseEmbedding must not be empty.');
  }
  if (request.denseEmbedding.some(value => !Number.isFinite(value))) {
    throw new Error('Hybrid denseEmbedding values must be finite.');
  }
  if (request.sparseVector) {
    for (const [index, value] of Object.entries(request.sparseVector)) {
      if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) {
        throw new Error('Hybrid sparseVector indices must be non-negative safe integers.');
      }
      if (!Number.isFinite(value)) {
        throw new Error('Hybrid sparseVector values must be finite.');
      }
    }
  }
  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 1000) {
    throw new Error('Hybrid topK must be an integer between 1 and 1000.');
  }
  required(request.scope.tenantId, 'scope.tenantId');
  required(request.scope.corpusId, 'scope.corpusId');
  if (request.scope.allowedTrustLevels.length === 0) {
    throw new Error('Hybrid scope must include at least one trust level.');
  }
}

function validateHybridHits(hits: readonly MilvusHybridHit[]): MilvusHybridHit[] {
  const ids = new Set<string>();
  return hits.map((hit, index) => {
    const id = required(hit.id, 'hits[' + index + '].id');
    if (ids.has(id)) throw new Error('Hybrid search returned duplicate hit ID: ' + id);
    ids.add(id);
    if (!Number.isFinite(hit.score)) throw new Error('Hybrid search hit score must be finite.');
    assertNonBlank(hit.content, 'hits[' + index + '].content');
    assertHybridMetadataAliasConsistency(hit.metadata ?? {}, 'hits[' + index + '].metadata');
    return { ...hit, id, content: hit.content };
  });
}

const HYBRID_METADATA_ALIASES = [
  ['tenantId', 'tenant_id'],
  ['corpusId', 'corpus_id'],
  ['documentId', 'document_id'],
  ['documentVersion', 'document_version'],
  ['trustLevel', 'trust_level'],
  ['startOffset', 'start_offset'],
  ['endOffset', 'end_offset'],
] as const;

function assertHybridMetadataAliasConsistency(
  metadata: Record<string, unknown>,
  field: string
): void {
  for (const [canonical, alias] of HYBRID_METADATA_ALIASES) {
    if (
      Object.prototype.hasOwnProperty.call(metadata, canonical) &&
      Object.prototype.hasOwnProperty.call(metadata, alias) &&
      !Object.is(metadata[canonical], metadata[alias])
    ) {
      throw new Error(
        'Hybrid ' + field + ' contains conflicting ' + canonical + '/' + alias + ' values.'
      );
    }
  }
}

function validateHybridCapability(
  capability: MilvusHybridCapability
): MilvusHybridCapability {
  if (
    typeof capability?.nativeHybridSearch !== 'boolean' ||
    typeof capability?.bm25Function !== 'boolean' ||
    typeof capability?.schemaCompatible !== 'boolean'
  ) {
    throw new Error('Milvus hybrid capability flags must be explicit booleans.');
  }
  return {
    ...capability,
    provider: required(capability.provider, 'capability.provider'),
  };
}

function validateHybridMode(mode: MilvusHybridRolloutMode): MilvusHybridRolloutMode {
  if (!['off', 'shadow', 'active'].includes(mode)) {
    throw new Error('Unsupported Milvus hybrid rollout mode: ' + String(mode));
  }
  return mode;
}

type FusionAccumulator = Map<string, HybridFusedCandidate & { firstSeen: number }>;

function createFusionAccumulator(
  lanes: Readonly<Record<string, readonly MilvusHybridHit[]>>
): FusionAccumulator {
  for (const laneId of Object.keys(lanes)) required(laneId, 'laneId');
  return new Map();
}

function uniqueLaneHits(hits: readonly MilvusHybridHit[]): MilvusHybridHit[] {
  const seen = new Set<string>();
  return validateHybridHits(hits).filter(hit => {
    if (seen.has(hit.id)) return false;
    seen.add(hit.id);
    return true;
  });
}

function mergeFusionCandidate(
  accumulator: FusionAccumulator,
  laneId: string,
  hit: MilvusHybridHit,
  rank: number,
  score: number
): void {
  const existing = accumulator.get(hit.id);
  if (existing) {
    if (
      existing.content !== hit.content ||
      hybridProvenanceKey(existing) !== hybridProvenanceKey(hit)
    ) {
      throw new Error('Fusion candidate ID maps to conflicting content or provenance: ' + hit.id);
    }
    existing.fusionScore += score;
    existing.matchedLanes.push(laneId);
    existing.laneRanks[laneId] = rank;
    return;
  }
  accumulator.set(hit.id, {
    ...hit,
    fusionScore: score,
    matchedLanes: [laneId],
    laneRanks: { [laneId]: rank },
    firstSeen: accumulator.size,
  });
}

function hybridProvenanceKey(hit: MilvusHybridHit): string {
  const metadata = hit.metadata ?? {};
  return JSON.stringify([
    hit.source ?? null,
    metadata.tenantId ?? metadata.tenant_id ?? null,
    metadata.corpusId ?? metadata.corpus_id ?? null,
    metadata.documentId ?? metadata.document_id ?? null,
    metadata.documentVersion ?? metadata.document_version ?? null,
    metadata.page ?? null,
    metadata.startOffset ?? metadata.start_offset ?? null,
    metadata.endOffset ?? metadata.end_offset ?? null,
    metadata.trustLevel ?? metadata.trust_level ?? null,
  ]);
}

function finalizeFusion(accumulator: FusionAccumulator, topK?: number): HybridFusedCandidate[] {
  const limit = topK ?? accumulator.size;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Fusion topK must be a non-negative integer.');
  }
  return [...accumulator.values()]
    .sort((left, right) =>
      right.fusionScore - left.fusionScore ||
      left.firstSeen - right.firstSeen ||
      left.id.localeCompare(right.id)
    )
    .slice(0, limit)
    .map(candidate => ({
      id: candidate.id,
      score: candidate.score,
      content: candidate.content,
      source: candidate.source,
      metadata: candidate.metadata,
      fusionScore: candidate.fusionScore,
      matchedLanes: candidate.matchedLanes,
      laneRanks: candidate.laneRanks,
    }));
}

function normalizeLaneScores(hits: readonly MilvusHybridHit[]): number[] {
  if (hits.length === 0) return [];
  const scores = hits.map(hit => hit.score);
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  if (maximum === minimum) return hits.map(() => 1);
  return scores.map(score => (score - minimum) / (maximum - minimum));
}

function validateLaneWeight(laneId: string, weight: number): void {
  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error('Fusion weight for lane ' + laneId + ' must be finite and non-negative.');
  }
}

function required(value: string, field: string): string {
  assertNonBlank(value, field);
  return value.trim();
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Hybrid ' + field + ' is required.');
  }
}

function safeIdentifier(value: string, field: string): string {
  const identifier = required(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Hybrid ' + field + ' must be a safe Milvus identifier.');
  }
  return identifier;
}
