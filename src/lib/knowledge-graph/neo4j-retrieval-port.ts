import type { ManagedTransaction } from 'neo4j-driver';
import type { Neo4jClient } from '../neo4j/driver';
import type { RagEvidence } from '../rag/core/types';
import {
  assertGraphRetrievalEvidence,
  KnowledgeGraphError,
  normalizeGraphRetrievalRequest,
  type GraphRetrievalPort,
  type GraphRetrievalRequest,
  type GraphRetrievalResult,
} from './contracts';

const MAX_PATH_ROWS = 2_000;
const MAX_PASSAGE_CANDIDATES = 512;
const PATH_QUERY_ONE_HOP = createPathQuery('*0..2');
const PATH_QUERY_TWO_HOPS = createPathQuery('*0..4');
const PASSAGE_QUERY = [
  'MATCH (snapshot:GraphSnapshot {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})',
  "WHERE snapshot.status IN ['active', 'superseded']",
  '  AND (snapshot.expiresAt IS NULL OR snapshot.expiresAt > $now)',
  'UNWIND range(0, size($passageIds) - 1) AS rank',
  'WITH rank, $passageIds[rank] AS passageId',
  'MATCH (passage:Passage {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,',
  '  passageId: passageId',
  '})',
  'WHERE passage.trustLevel IN $allowedTrustLevels',
  '  AND ($documentId IS NULL OR passage.documentId = $documentId)',
  '  AND ($documentVersion IS NULL OR passage.documentVersion = $documentVersion)',
  '  AND ($trustLevel IS NULL OR passage.trustLevel = $trustLevel)',
  'RETURN properties(passage) AS passage, rank',
  'ORDER BY rank',
  'LIMIT toInteger($topK)',
].join('\n');

interface PathRow {
  entityId: string;
  seedId: string;
  hop: number;
  entityPassageIds: string[];
  claimPassageIds: string[];
  claimIds: string[];
  communityIds: string[];
}

interface RankedPassage {
  score: number;
  minimumHop: number;
  entityIds: Set<string>;
  claimIds: Set<string>;
  communityIds: Set<string>;
}

export class Neo4jGraphRetrievalPort implements GraphRetrievalPort {
  readonly retriever = 'neo4j-knowledge-graph-v1';
  private readonly client: Pick<Neo4jClient, 'executeRead'>;

  constructor(client: Pick<Neo4jClient, 'executeRead'>) {
    this.client = client;
  }

  async retrieve(input: GraphRetrievalRequest): Promise<GraphRetrievalResult> {
    const request = normalizeGraphRetrievalRequest(input);
    throwIfAborted(request.signal);
    const parameters = {
      tenantId: request.scope.tenantId,
      corpusId: request.scope.corpusId,
      graphVersion: request.snapshot.graphVersion,
      now: new Date().toISOString(),
      allowedTrustLevels: [...request.scope.allowedTrustLevels].sort(),
      documentId: request.snapshot.documentId ?? null,
      documentVersion: request.snapshot.documentVersion ?? null,
      trustLevel: request.snapshot.trustLevel ?? null,
      queryTokens: tokenizeQuery(request.query),
      seedPassageIds: request.seedPassageIds,
      seedLimit: Math.min(128, Math.max(16, request.topK * 8)),
      pathLimit: MAX_PATH_ROWS,
    };

    try {
      const queryResult = await this.client.executeRead(
        'retrieve source passages from Neo4j knowledge graph',
        transaction => readGraphEvidence(transaction, request, parameters)
      );
      throwIfAborted(request.signal);
      queryResult.evidence.forEach(evidence =>
        assertGraphRetrievalEvidence(evidence, request.scope)
      );
      return queryResult;
    } catch (error) {
      if (isAbortError(error) || error instanceof KnowledgeGraphError) throw error;
      const code = readErrorCode(error).toLowerCase();
      if (code.includes('timeout') || code.includes('terminated') || code.includes('deadline')) {
        throw new KnowledgeGraphError(
          'KNOWLEDGE_GRAPH_QUERY_TIMEOUT',
          'Neo4j graph retrieval exceeded its query budget.',
          error
        );
      }
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_UNAVAILABLE',
        'Neo4j graph retrieval is unavailable.',
        error
      );
    }
  }
}

async function readGraphEvidence(
  transaction: ManagedTransaction,
  request: GraphRetrievalRequest,
  parameters: Record<string, unknown>
): Promise<GraphRetrievalResult> {
  const pathResult = await transaction.run(
    request.maxHops === 1 ? PATH_QUERY_ONE_HOP : PATH_QUERY_TWO_HOPS,
    parameters
  );
  throwIfAborted(request.signal);
  const rows = pathResult.records.map(record => readPathRow(record));
  if (rows.length === 0) return emptyResult(request.seedPassageIds.length);

  const ranking = new Map<string, RankedPassage>();
  const entityIds = new Set<string>();
  const seedIds = new Set<string>();
  const claimIds = new Set<string>();
  const communityIds = new Set<string>();
  for (const row of rows) {
    entityIds.add(row.entityId);
    seedIds.add(row.seedId);
    row.claimIds.forEach(id => claimIds.add(id));
    row.communityIds.forEach(id => communityIds.add(id));
    const baseScore = 1 / (row.hop + 1);
    for (const passageId of [...row.entityPassageIds, ...row.claimPassageIds]) {
      const current = ranking.get(passageId) ?? {
        score: 0,
        minimumHop: Number.POSITIVE_INFINITY,
        entityIds: new Set<string>(),
        claimIds: new Set<string>(),
        communityIds: new Set<string>(),
      };
      current.score += baseScore + (request.seedPassageIds.includes(passageId) ? 0.25 : 0);
      current.minimumHop = Math.min(current.minimumHop, row.hop);
      current.entityIds.add(row.entityId);
      row.claimIds.forEach(id => current.claimIds.add(id));
      row.communityIds.forEach(id => current.communityIds.add(id));
      ranking.set(passageId, current);
    }
  }

  const rankedPassageIds = [...ranking.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .slice(0, MAX_PASSAGE_CANDIDATES)
    .map(([passageId]) => passageId);
  if (rankedPassageIds.length === 0) {
    return emptyResult(request.seedPassageIds.length, {
      matchedEntityCount: entityIds.size,
      matchedCommunityCount: communityIds.size,
      inspectedPathCount: rows.length,
      inspectedClaimCount: claimIds.size,
    });
  }

  const passageResult = await transaction.run(PASSAGE_QUERY, {
    ...parameters,
    passageIds: rankedPassageIds,
    topK: request.topK,
  });
  throwIfAborted(request.signal);
  const evidence = passageResult.records.map(record => {
    const data = asRecord(record.get('passage'), 'passage');
    const passageId = requiredString(data.passageId, 'passageId');
    return toEvidence(data, passageId, ranking.get(passageId), request);
  });

  return {
    evidence,
    stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
    diagnostics: {
      seedCount: seedIds.size || request.seedPassageIds.length,
      matchedEntityCount: entityIds.size,
      matchedCommunityCount: communityIds.size,
      inspectedPathCount: rows.length,
      inspectedClaimCount: claimIds.size,
      truncated: rows.length >= MAX_PATH_ROWS || ranking.size > MAX_PASSAGE_CANDIDATES,
    },
  };
}

function createPathQuery(variableLength: '*0..2' | '*0..4'): string {
  return [
    'MATCH (snapshot:GraphSnapshot {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '})',
    "WHERE snapshot.status IN ['active', 'superseded']",
    '  AND (snapshot.expiresAt IS NULL OR snapshot.expiresAt > $now)',
    'MATCH (seed:Entity {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '})',
    'WHERE EXISTS {',
    '  MATCH (allowedSeedSource:Passage {',
    '    tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '  })-[:MENTIONS]->(seed)',
    '  WHERE allowedSeedSource.trustLevel IN $allowedTrustLevels',
    '    AND ($documentId IS NULL OR allowedSeedSource.documentId = $documentId)',
    '    AND ($documentVersion IS NULL OR allowedSeedSource.documentVersion = $documentVersion)',
    '    AND ($trustLevel IS NULL OR allowedSeedSource.trustLevel = $trustLevel)',
    '}',
    'AND NOT EXISTS {',
    '  MATCH (restrictedSeedSource:Passage {',
    '    tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '  })-[:MENTIONS]->(seed)',
    '  WHERE NOT restrictedSeedSource.trustLevel IN $allowedTrustLevels',
    '}',
    'AND (',
    '  any(token IN $queryTokens WHERE',
    '    seed.normalizedName CONTAINS token',
    '    OR any(alias IN seed.aliases WHERE toLower(alias) CONTAINS token)',
    '    OR toLower(seed.summary) CONTAINS token)',
    '  OR EXISTS {',
    '    MATCH (seedPassage:Passage {',
    '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '    })-[:MENTIONS]->(seed)',
    '    WHERE seedPassage.passageId IN $seedPassageIds',
    '      AND seedPassage.trustLevel IN $allowedTrustLevels',
    '      AND ($documentId IS NULL OR seedPassage.documentId = $documentId)',
    '      AND ($documentVersion IS NULL OR seedPassage.documentVersion = $documentVersion)',
    '      AND ($trustLevel IS NULL OR seedPassage.trustLevel = $trustLevel)',
    '  }',
    ')',
    'WITH DISTINCT seed LIMIT toInteger($seedLimit)',
    'MATCH path = (seed)-[:SUBJECT_OF|OBJECT' + variableLength + ']-(matched:Entity {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '})',
    'WHERE all(node IN nodes(path) WHERE',
    '  node.tenantId = $tenantId',
    '  AND node.corpusId = $corpusId',
    '  AND node.graphVersion = $graphVersion)',
    '  AND all(entity IN [pathNode IN nodes(path) WHERE pathNode:Entity] WHERE',
    '    EXISTS {',
    '      MATCH (allowedEntitySource:Passage {',
    '        tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '      })-[:MENTIONS]->(entity)',
    '      WHERE allowedEntitySource.trustLevel IN $allowedTrustLevels',
    '        AND ($documentId IS NULL OR allowedEntitySource.documentId = $documentId)',
    '        AND ($documentVersion IS NULL OR allowedEntitySource.documentVersion = $documentVersion)',
    '        AND ($trustLevel IS NULL OR allowedEntitySource.trustLevel = $trustLevel)',
    '    }',
    '    AND NOT EXISTS {',
    '      MATCH (restrictedEntitySource:Passage {',
    '        tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '      })-[:MENTIONS]->(entity)',
    '      WHERE NOT restrictedEntitySource.trustLevel IN $allowedTrustLevels',
    '    }',
    '  )',
    '  AND all(claim IN [pathNode IN nodes(path) WHERE pathNode:Claim] WHERE',
    "    claim.status = 'active'",
    '    AND EXISTS {',
    '      MATCH (claim)-[:SUPPORTED_BY]->(claimSource:Passage {',
    '        tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '      })',
    '      WHERE claimSource.trustLevel IN $allowedTrustLevels',
    '        AND ($documentId IS NULL OR claimSource.documentId = $documentId)',
    '        AND ($documentVersion IS NULL OR claimSource.documentVersion = $documentVersion)',
    '        AND ($trustLevel IS NULL OR claimSource.trustLevel = $trustLevel)',
    '    }',
    '    AND NOT EXISTS {',
    '      MATCH (claim)-[:SUPPORTED_BY]->(restrictedClaimSource:Passage {',
    '        tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '      })',
    '      WHERE NOT restrictedClaimSource.trustLevel IN $allowedTrustLevels',
    '    }',
    '  )',
    'OPTIONAL MATCH (matched)-[:IN_COMMUNITY]->(community:Community {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '})',
    'WITH seed, matched, path,',
    '  [node IN nodes(path) WHERE node:Claim] AS claims,',
    '  collect(DISTINCT community.communityId) AS communityIds',
    'RETURN seed.entityKey AS seedId,',
    '  matched.entityKey AS entityId,',
    '  toInteger(length(path) / 2) AS hop,',
    '  matched.passageIds AS entityPassageIds,',
    '  reduce(ids = [], claim IN claims | ids + claim.passageIds) AS claimPassageIds,',
    '  [claim IN claims | claim.claimId] AS claimIds,',
    '  [id IN communityIds WHERE id IS NOT NULL] AS communityIds',
    'LIMIT toInteger($pathLimit)',
  ].join('\n');
}

function readPathRow(record: { get(key: string): unknown }): PathRow {
  return {
    seedId: requiredString(record.get('seedId'), 'seedId'),
    entityId: requiredString(record.get('entityId'), 'entityId'),
    hop: toNumber(record.get('hop')),
    entityPassageIds: stringArray(record.get('entityPassageIds')),
    claimPassageIds: stringArray(record.get('claimPassageIds')),
    claimIds: stringArray(record.get('claimIds')),
    communityIds: stringArray(record.get('communityIds')),
  };
}

function toEvidence(
  data: Record<string, unknown>,
  passageId: string,
  ranking: RankedPassage | undefined,
  request: GraphRetrievalRequest
): RagEvidence {
  const score = ranking?.score ?? 0;
  const source = optionalString(data.source);
  const page = optionalNumber(data.page);
  const sectionPath = stringArray(data.sectionPath);
  return {
    id: 'graph:' + request.snapshot.graphVersion + ':' + passageId,
    tenantId: requiredString(data.tenantId ?? request.scope.tenantId, 'tenantId'),
    corpusId: requiredString(data.corpusId ?? request.scope.corpusId, 'corpusId'),
    documentId: requiredString(data.documentId, 'documentId'),
    documentVersion: requiredString(data.documentVersion, 'documentVersion'),
    content: requiredString(data.content, 'content'),
    ...(source ? { source } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(sectionPath.length > 0 ? { sectionPath } : {}),
    startOffset: toNumber(data.startOffset),
    endOffset: toNumber(data.endOffset),
    retrievalScore: score <= 0 ? 0 : score / (score + 1),
    trustLevel: requiredTrustLevel(data.trustLevel),
    laneId: request.laneId,
    metadata: {
      ...parseMetadata(data.metadataJson),
      graphVersion: request.snapshot.graphVersion,
      graphPassageId: passageId,
      graphEntityIds: [...(ranking?.entityIds ?? [])].sort(),
      graphClaimIds: [...(ranking?.claimIds ?? [])].sort(),
      graphCommunityIds: [...(ranking?.communityIds ?? [])].sort(),
      graphMinimumHop: Number.isFinite(ranking?.minimumHop) ? ranking?.minimumHop : null,
    },
  };
}

function tokenizeQuery(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9._:-]*|[\u3400-\u9fff]+/g) ?? [];
  const tokens = new Set<string>();
  for (const word of words) {
    if (/[\u3400-\u9fff]/.test(word)) {
      for (let index = 0; index < word.length; index += 1) {
        tokens.add(word[index]);
        if (index + 1 < word.length) tokens.add(word.slice(index, index + 2));
      }
    } else if (word.length > 1) {
      tokens.add(word);
    }
  }
  return [...tokens].sort().slice(0, 128);
}

function emptyResult(
  seedCount: number,
  partial: Partial<GraphRetrievalResult['diagnostics']> = {}
): GraphRetrievalResult {
  return {
    evidence: [],
    stopReason: 'no_gain',
    diagnostics: {
      seedCount,
      matchedEntityCount: 0,
      matchedCommunityCount: 0,
      inspectedPathCount: 0,
      inspectedClaimCount: 0,
      truncated: false,
      ...partial,
    },
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Neo4j ' + field + ' result is malformed.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Neo4j ' + field + ' result is malformed.');
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item).map(String))]
    : [];
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = toNumber(value);
  return Number.isFinite(number) ? number : undefined;
}

function requiredTrustLevel(value: unknown): RagEvidence['trustLevel'] {
  if (value === 'trusted' || value === 'reviewed' || value === 'external') return value;
  throw new Error('Neo4j passage trustLevel result is malformed.');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Neo4j graph retrieval was aborted.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}
