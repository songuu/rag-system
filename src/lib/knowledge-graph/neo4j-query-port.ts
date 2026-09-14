import type { Neo4jClient } from '../neo4j/driver';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import {
  createKnowledgeGraphSnapshotIdentity,
  KnowledgeGraphError,
  type KnowledgeGraphClaim,
  type KnowledgeGraphClaimSourceResult,
  type KnowledgeGraphEntity,
  type KnowledgeGraphEntityResult,
  type KnowledgeGraphCommunity,
  type KnowledgeGraphCommunityResult,
  type KnowledgeGraphPathResult,
  type KnowledgeGraphPassage,
  type KnowledgeGraphQueryPort,
} from './contracts';

const ENTITY_QUERY = [
  'MATCH (entity:Entity {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})',
  'WHERE any(token IN $queryTokens WHERE',
  '  entity.normalizedName CONTAINS token',
  '  OR any(alias IN entity.aliases WHERE toLower(alias) CONTAINS token)',
  '  OR toLower(entity.summary) CONTAINS token)',
  'MATCH (passage:Passage {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})-[:MENTIONS]->(entity)',
  'WHERE passage.trustLevel IN $allowedTrustLevels',
  '  AND NOT EXISTS {',
  '    MATCH (restrictedPassage:Passage {',
  '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '    })-[:MENTIONS]->(entity)',
  '    WHERE NOT restrictedPassage.trustLevel IN $allowedTrustLevels',
  '  }',
  'WITH entity, collect(DISTINCT passage.passageId) AS allowedPassageIds,',
  '  CASE WHEN entity.normalizedName = $normalizedQuery THEN 2.0 ELSE 1.0 END AS score',
  'RETURN entity {',
  '  .entityKey, .name, .normalizedName,',
  '  entityLabels: coalesce(entity.entityLabels, [])[0..$maxListValues],',
  '  summary: substring(coalesce(entity.summary, ""), 0, $maxTextCharacters),',
  '  aliases: coalesce(entity.aliases, [])[0..$maxListValues],',
  '  passageIds: allowedPassageIds[0..$maxReferenceIds], .createdAt',
  '} AS entity, score',
  'ORDER BY score DESC, entity.normalizedName, entity.entityKey',
  'LIMIT toInteger($limit)',
].join('\n');

const COMMUNITY_QUERY = [
  'MATCH (community:Community {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})',
  'WHERE (size($queryTokens) = 0 OR any(token IN $queryTokens WHERE',
  '  toLower(community.name) CONTAINS token',
  '  OR toLower(community.summary) CONTAINS token',
  '  OR any(keyword IN community.keywords WHERE toLower(keyword) CONTAINS token)))',
  'MATCH (passage:Passage {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})-[:MENTIONS]->(allowedEntity:Entity {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})-[:IN_COMMUNITY]->(community)',
  'WHERE passage.trustLevel IN $allowedTrustLevels',
  '  AND NOT EXISTS {',
  '    MATCH (restrictedPassage:Passage {',
  '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '    })-[:MENTIONS]->(:Entity {',
  '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '    })-[:IN_COMMUNITY]->(community)',
  '    WHERE NOT restrictedPassage.trustLevel IN $allowedTrustLevels',
  '  }',
  '  AND NOT EXISTS {',
  '    MATCH (community)-[:HAS_CLAIM]->(:Claim {',
  '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '    })-[:SUPPORTED_BY]->(restrictedClaimPassage:Passage {',
  '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '    })',
  '    WHERE NOT restrictedClaimPassage.trustLevel IN $allowedTrustLevels',
  '  }',
  'WITH community, collect(DISTINCT allowedEntity.entityKey) AS allowedEntityIds,',
  '  CASE WHEN size($queryTokens) = 0 THEN 0.0 ELSE 1.0 END AS score',
  'OPTIONAL MATCH (community)-[:HAS_CLAIM]->(allowedClaim:Claim {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})-[:SUPPORTED_BY]->(claimPassage:Passage {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})',
  "WHERE allowedClaim.status = 'active'",
  '  AND claimPassage.trustLevel IN $allowedTrustLevels',
  'WITH community, allowedEntityIds, score,',
  '  collect(DISTINCT allowedClaim.claimId) AS allowedClaimIds',
  'RETURN community {',
  '  .communityId, .name,',
  '  entityIds: allowedEntityIds[0..$maxReferenceIds],',
  '  claimIds: allowedClaimIds[0..$maxReferenceIds],',
  '  summary: substring(coalesce(community.summary, ""), 0, $maxTextCharacters),',
  '  keywords: coalesce(community.keywords, [])[0..$maxListValues],',
  '  .level, .parentId',
  '} AS community,',
  '  score',
  'ORDER BY score DESC, community.level, community.name, community.communityId',
  'LIMIT toInteger($limit)',
].join('\n');

const NEIGHBOR_ONE_HOP = createNeighborQuery('*1..2');
const NEIGHBOR_TWO_HOPS = createNeighborQuery('*1..4');
const PATH_ONE_HOP = createPathQuery('*1..2');
const PATH_TWO_HOPS = createPathQuery('*1..4');

const CLAIM_SOURCES_QUERY = [
  'MATCH (claim:Claim {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,',
  '  claimId: $claimId',
  '})-[:SUPPORTED_BY]->(passage:Passage {',
  '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '})',
  "WHERE claim.status = 'active' AND passage.trustLevel IN $allowedTrustLevels",
  '  AND NOT EXISTS {',
  '    MATCH (claim)-[:SUPPORTED_BY]->(restrictedPassage:Passage {',
  '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
  '    })',
  '    WHERE NOT restrictedPassage.trustLevel IN $allowedTrustLevels',
  '  }',
  'WITH claim, passage ORDER BY passage.chunkIndex, passage.passageId',
  'LIMIT toInteger($limit)',
  'WITH claim, collect(passage) AS allowedPassages',
  'RETURN claim {.*, passageIds: [passage IN allowedPassages | passage.passageId]} AS claim,',
  '  [passage IN allowedPassages | properties(passage)] AS passages',
].join('\n');

export class Neo4jKnowledgeGraphQueryPort implements KnowledgeGraphQueryPort {
  private readonly client: Pick<Neo4jClient, 'executeRead'>;

  constructor(client: Pick<Neo4jClient, 'executeRead'>) {
    this.client = client;
  }

  async searchEntities(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphEntityResult[]> {
    const parameters = baseParameters(input.scope, input.graphVersion, input.limit);
    const query = requiredText(input.query, 'query');
    throwIfAborted(input.signal);
    return this.read('search knowledge graph entities', async transaction => {
      const result = await transaction.run(ENTITY_QUERY, {
        ...parameters,
        normalizedQuery: normalize(query),
        queryTokens: tokenize(query),
      });
      throwIfAborted(input.signal);
      return result.records.map(record => ({
        entity: toEntity(record.get('entity')),
        score: toNumber(record.get('score')),
      }));
    });
  }

  async getNeighbors(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    entityId: string;
    maxHops: 1 | 2;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphPathResult[]> {
    const parameters = {
      ...baseParameters(input.scope, input.graphVersion, input.limit),
      entityId: requiredText(input.entityId, 'entityId'),
    };
    return this.readPaths(
      'read knowledge graph neighbors',
      input.maxHops === 1 ? NEIGHBOR_ONE_HOP : NEIGHBOR_TWO_HOPS,
      parameters,
      input.signal
    );
  }

  async findPaths(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    sourceEntityId: string;
    targetEntityId: string;
    maxHops: 1 | 2;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphPathResult[]> {
    const parameters = {
      ...baseParameters(input.scope, input.graphVersion, input.limit),
      sourceEntityId: requiredText(input.sourceEntityId, 'sourceEntityId'),
      targetEntityId: requiredText(input.targetEntityId, 'targetEntityId'),
    };
    return this.readPaths(
      'find knowledge graph paths',
      input.maxHops === 1 ? PATH_ONE_HOP : PATH_TWO_HOPS,
      parameters,
      input.signal
    );
  }

  async searchCommunities(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    query?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphCommunityResult[]> {
    const parameters = baseParameters(input.scope, input.graphVersion, input.limit);
    const query = input.query?.trim() ?? '';
    if (!query) throw new Error('Knowledge graph community query must be non-empty.');
    if (query.length > 8_000) throw new Error('Knowledge graph community query is too long.');
    throwIfAborted(input.signal);
    return this.read('search knowledge graph communities', async transaction => {
      const result = await transaction.run(COMMUNITY_QUERY, {
        ...parameters,
        queryTokens: query ? tokenize(query) : [],
      });
      throwIfAborted(input.signal);
      return result.records.map(record => ({
        community: toCommunity(record.get('community')),
        score: toNumber(record.get('score')),
      }));
    });
  }

  async getClaimSources(input: {
    scope: RagRetrievalScope;
    graphVersion: string;
    claimId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeGraphClaimSourceResult | null> {
    const parameters = {
      ...baseParameters(input.scope, input.graphVersion, input.limit),
      claimId: requiredText(input.claimId, 'claimId'),
    };
    throwIfAborted(input.signal);
    return this.read('read knowledge graph claim sources', async transaction => {
      const result = await transaction.run(CLAIM_SOURCES_QUERY, parameters);
      throwIfAborted(input.signal);
      const record = result.records[0];
      if (!record) return null;
      const passages = record.get('passages');
      return {
        claim: toClaim(record.get('claim')),
        passages: Array.isArray(passages) ? passages.map(toPassage) : [],
      };
    });
  }

  private async readPaths(
    operation: string,
    cypher: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<KnowledgeGraphPathResult[]> {
    throwIfAborted(signal);
    return this.read(operation, async transaction => {
      const result = await transaction.run(cypher, parameters);
      throwIfAborted(signal);
      return result.records.map(record => ({
        entityIds: stringArray(record.get('entityIds')),
        claimIds: stringArray(record.get('claimIds')),
        passageIds: stringArray(record.get('passageIds')),
        score: toNumber(record.get('score')),
      }));
    });
  }

  private async read<T>(
    operation: string,
    work: Parameters<Neo4jClient['executeRead']>[1]
  ): Promise<T> {
    try {
      return await this.client.executeRead(operation, work) as T;
    } catch (error) {
      if (error instanceof KnowledgeGraphError || isAbortError(error)) throw error;
      const timeout = isNeo4jTimeout(error);
      throw new KnowledgeGraphError(
        timeout ? 'KNOWLEDGE_GRAPH_QUERY_TIMEOUT' : 'KNOWLEDGE_GRAPH_UNAVAILABLE',
        timeout
          ? 'Neo4j knowledge graph query exceeded its query budget.'
          : 'Neo4j knowledge graph query is unavailable.',
        error
      );
    }
  }
}

function createNeighborQuery(variableLength: '*1..2' | '*1..4'): string {
  return [
    'MATCH (source:Entity {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,',
    '  entityKey: $entityId',
    '})',
    'MATCH path = (source)-[:SUBJECT_OF|OBJECT' + variableLength + ']-(target:Entity {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '})',
    pathScopeClause(),
    pathReturnClause(),
    'LIMIT toInteger($limit)',
  ].join('\n');
}

function createPathQuery(variableLength: '*1..2' | '*1..4'): string {
  return [
    'MATCH (source:Entity {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,',
    '  entityKey: $sourceEntityId',
    '})',
    'MATCH (target:Entity {',
    '  tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,',
    '  entityKey: $targetEntityId',
    '})',
    'MATCH path = (source)-[:SUBJECT_OF|OBJECT' + variableLength + ']-(target)',
    pathScopeClause(),
    pathReturnClause(),
    'LIMIT toInteger($limit)',
  ].join('\n');
}

function pathScopeClause(): string {
  return [
    'WHERE all(node IN nodes(path) WHERE',
    '  node.tenantId = $tenantId',
    '  AND node.corpusId = $corpusId',
    '  AND node.graphVersion = $graphVersion)',
    'WITH path, [node IN nodes(path) WHERE node:Claim] AS claims,',
    '  [node IN nodes(path) WHERE node:Entity] AS entities',
    "WHERE all(claim IN claims WHERE claim.status = 'active')",
    '  AND all(claim IN claims WHERE EXISTS {',
    '    MATCH (claim)-[:SUPPORTED_BY]->(passage:Passage {',
    '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '    })',
    '    WHERE passage.trustLevel IN $allowedTrustLevels',
    '  })',
    '  AND all(claim IN claims WHERE NOT EXISTS {',
    '    MATCH (claim)-[:SUPPORTED_BY]->(restrictedPassage:Passage {',
    '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '    })',
    '    WHERE NOT restrictedPassage.trustLevel IN $allowedTrustLevels',
    '  })',
    '  AND all(entity IN entities WHERE EXISTS {',
    '    MATCH (allowedEntitySource:Passage {',
    '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '    })-[:MENTIONS]->(entity)',
    '    WHERE allowedEntitySource.trustLevel IN $allowedTrustLevels',
    '  })',
    '  AND all(entity IN entities WHERE NOT EXISTS {',
    '    MATCH (restrictedEntitySource:Passage {',
    '      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion',
    '    })-[:MENTIONS]->(entity)',
    '    WHERE NOT restrictedEntitySource.trustLevel IN $allowedTrustLevels',
    '  })',
  ].join('\n');
}

function pathReturnClause(): string {
  return [
    'WITH path, claims, [node IN nodes(path) WHERE node:Entity | node.entityKey] AS entityIds',
    'RETURN entityIds[0..$maxPathEntityIds] AS entityIds,',
    '  [claim IN claims | claim.claimId][0..$maxPathClaimIds] AS claimIds,',
    '  reduce(ids = [], claim IN claims | ids + [(claim)-[:SUPPORTED_BY]->(passage:Passage)',
    '    WHERE passage.tenantId = $tenantId',
    '      AND passage.corpusId = $corpusId',
    '      AND passage.graphVersion = $graphVersion',
    '      AND passage.trustLevel IN $allowedTrustLevels | passage.passageId])',
    '    [0..$maxReferenceIds] AS passageIds,',
    '  1.0 / (1.0 + toFloat(length(path) / 2)) AS score',
    'ORDER BY score DESC',
  ].join('\n');
}

function baseParameters(
  scope: RagRetrievalScope,
  graphVersion: string,
  limit: number
): Record<string, unknown> {
  const identity = createKnowledgeGraphSnapshotIdentity({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    graphVersion,
  });
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Knowledge graph query limit must be between 1 and 100.');
  }
  return {
    ...identity,
    allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
    limit,
    maxListValues: 32,
    maxPathClaimIds: 8,
    maxPathEntityIds: 8,
    maxReferenceIds: 64,
    maxTextCharacters: 8_192,
  };
}

function toEntity(value: unknown): KnowledgeGraphEntity {
  const data = asRecord(value);
  return {
    id: requiredText(data.entityKey, 'entityKey'),
    name: requiredText(data.name, 'name'),
    normalizedName: requiredText(data.normalizedName, 'normalizedName'),
    labels: stringArray(data.entityLabels),
    summary: typeof data.summary === 'string' ? data.summary : '',
    aliases: stringArray(data.aliases),
    passageIds: stringArray(data.passageIds),
    attributes: parseRecord(data.attributesJson),
    ...(typeof data.createdAt === 'string' && data.createdAt
      ? { createdAt: data.createdAt }
      : {}),
  };
}

function toCommunity(value: unknown): KnowledgeGraphCommunity {
  const data = asRecord(value);
  return {
    id: requiredText(data.communityId, 'communityId'),
    name: requiredText(data.name, 'name'),
    entityIds: stringArray(data.entityIds),
    claimIds: stringArray(data.claimIds),
    summary: typeof data.summary === 'string' ? data.summary : '',
    keywords: stringArray(data.keywords),
    level: toNumber(data.level),
    ...(typeof data.parentId === 'string' && data.parentId
      ? { parentId: data.parentId }
      : {}),
  };
}

function toClaim(value: unknown): KnowledgeGraphClaim {
  const data = asRecord(value);
  const status = data.status;
  if (status !== 'active' && status !== 'invalid' && status !== 'expired' && status !== 'superseded') {
    throw new Error('Neo4j claim result has an invalid status.');
  }
  return {
    id: requiredText(data.claimId, 'claimId'),
    predicate: requiredText(data.predicate, 'predicate'),
    fact: requiredResultText(data.fact, 'fact', 100_000),
    factType: requiredText(data.factType, 'factType'),
    sourceEntityId: requiredText(data.sourceEntityId, 'sourceEntityId'),
    targetEntityId: requiredText(data.targetEntityId, 'targetEntityId'),
    sourceEntityName: requiredText(data.sourceEntityName, 'sourceEntityName'),
    targetEntityName: requiredText(data.targetEntityName, 'targetEntityName'),
    episodes: stringArray(data.episodes),
    passageIds: stringArray(data.passageIds),
    confidence: toNumber(data.confidence),
    status,
    attributes: parseRecord(data.attributesJson),
    ...(typeof data.createdAt === 'string' && data.createdAt ? { createdAt: data.createdAt } : {}),
    ...(typeof data.validAt === 'string' && data.validAt ? { validAt: data.validAt } : {}),
    ...(typeof data.invalidAt === 'string' && data.invalidAt ? { invalidAt: data.invalidAt } : {}),
    ...(typeof data.expiredAt === 'string' && data.expiredAt ? { expiredAt: data.expiredAt } : {}),
  };
}

function toPassage(value: unknown): KnowledgeGraphPassage {
  const data = asRecord(value);
  const passage: KnowledgeGraphPassage = {
    id: requiredText(data.passageId, 'passageId'),
    documentId: requiredText(data.documentId, 'documentId'),
    documentVersion: requiredText(data.documentVersion, 'documentVersion'),
    trustLevel: requiredTrustLevel(data.trustLevel),
    content: requiredResultText(data.content, 'content', 1_000_000),
    index: toNumber(data.chunkIndex),
    startOffset: toNumber(data.startOffset),
    endOffset: toNumber(data.endOffset),
    metadata: parseRecord(data.metadataJson),
  };
  if (typeof data.source === 'string' && data.source) passage.source = data.source;
  if (data.page !== undefined && data.page !== null) passage.page = toNumber(data.page);
  const sectionPath = stringArray(data.sectionPath);
  if (sectionPath.length > 0) passage.sectionPath = sectionPath;
  return passage;
}

function tokenize(value: string): string[] {
  const words = normalize(value).match(/[a-z0-9][a-z0-9._:-]*|[\u3400-\u9fff]+/g) ?? [];
  return [...new Set(words.flatMap(word =>
    /[\u3400-\u9fff]/.test(word) ? [...word] : [word]
  ))].sort().slice(0, 128);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error('Knowledge graph ' + field + ' is invalid.');
  }
  return value.trim();
}

function requiredResultText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error('Neo4j ' + field + ' result is invalid.');
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Neo4j entity result is malformed.');
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item).map(String))]
    : [];
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requiredTrustLevel(value: unknown): KnowledgeGraphPassage['trustLevel'] {
  if (value === 'trusted' || value === 'reviewed' || value === 'external' || value === 'quarantined') {
    return value;
  }
  throw new Error('Neo4j passage result has an invalid trustLevel.');
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Knowledge graph query was aborted.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isNeo4jTimeout(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current !== 'object') break;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const value = [candidate.code, candidate.message]
      .filter(item => typeof item === 'string')
      .join(' ')
      .toLowerCase();
    if (value.includes('timeout') || value.includes('timedout')
      || value.includes('timed out') || value.includes('terminated')
      || value.includes('deadline')) return true;
    current = candidate.cause;
  }
  return false;
}
