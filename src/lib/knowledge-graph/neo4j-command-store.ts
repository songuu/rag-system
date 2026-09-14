import type { ManagedTransaction } from 'neo4j-driver';
import type { Neo4jClient } from '../neo4j/driver';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';
import {
  createKnowledgeGraphSnapshotIdentity,
  KnowledgeGraphError,
  type KnowledgeGraphActivePointer,
  type KnowledgeGraphClaim,
  type KnowledgeGraphCommandStore,
  type KnowledgeGraphCommunity,
  type KnowledgeGraphCompatibilitySnapshotDescriptor,
  type KnowledgeGraphCompatibilityListOptions,
  type KnowledgeGraphDocumentIdentity,
  type KnowledgeGraphEntity,
  type KnowledgeGraphPassage,
  type KnowledgeGraphSnapshot,
  type KnowledgeGraphSnapshotDescriptor,
  type KnowledgeGraphSnapshotIdentity,
  type KnowledgeGraphSnapshotStatus,
} from './contracts';

const BATCH_SIZE = 500;

const CYPHER = Object.freeze({
  findSnapshot: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    RETURN properties(snapshot) AS snapshot
  `,
  findScopedSnapshot: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    WHERE snapshot.status IN ['staging', 'active', 'superseded']
      AND (snapshot.expiresAt IS NULL OR snapshot.expiresAt > $now)
      AND NOT EXISTS {
        MATCH (snapshot)-[:CONTAINS]->(document:DocumentVersion)
        WHERE NOT document.trustLevel IN $allowedTrustLevels
      }
    RETURN properties(snapshot) AS snapshot
  `,
  mergeSnapshot: `
    MERGE (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    ON CREATE SET snapshot.graphId = $graphId,
      snapshot.graphName = $graphName,
      snapshot.status = $status,
      snapshot.artifactDigest = $artifactDigest,
      snapshot.createdAt = $createdAt,
      snapshot.expiresAt = $expiresAt,
      snapshot.documentCount = $documentCount,
      snapshot.passageCount = $passageCount,
      snapshot.entityCount = $entityCount,
      snapshot.claimCount = $claimCount,
      snapshot.communityCount = $communityCount
    RETURN properties(snapshot) AS snapshot
  `,
  mergeDocuments: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    UNWIND $rows AS row
    MERGE (document:DocumentVersion {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      documentId: row.documentId, documentVersion: row.documentVersion
    })
    ON CREATE SET document.trustLevel = row.trustLevel, document.status = 'staging'
    MERGE (snapshot)-[:CONTAINS]->(document)
  `,
  mergePassages: `
    UNWIND $rows AS row
    MATCH (document:DocumentVersion {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      documentId: row.documentId, documentVersion: row.documentVersion
    })
    MERGE (passage:Passage {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      passageId: row.id
    })
    ON CREATE SET passage.documentId = row.documentId,
      passage.documentVersion = row.documentVersion,
      passage.trustLevel = row.trustLevel,
      passage.content = row.content,
      passage.chunkIndex = row.index,
      passage.startOffset = row.startOffset,
      passage.endOffset = row.endOffset,
      passage.source = row.source,
      passage.page = row.page,
      passage.sectionPath = row.sectionPath,
      passage.metadataJson = row.metadataJson
    MERGE (document)-[:HAS_PASSAGE]->(passage)
  `,
  mergeEntities: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    UNWIND $rows AS row
    MERGE (entity:Entity {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      entityKey: row.id
    })
    ON CREATE SET entity.name = row.name,
      entity.normalizedName = row.normalizedName,
      entity.entityLabels = row.labels,
      entity.summary = row.summary,
      entity.description = row.summary,
      entity.aliases = row.aliases,
      entity.passageIds = row.passageIds,
      entity.attributesJson = row.attributesJson,
      entity.createdAt = row.createdAt
    MERGE (snapshot)-[:CONTAINS_ENTITY]->(entity)
    WITH entity, row
    UNWIND row.passageIds AS passageId
    MATCH (passage:Passage {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      passageId: passageId
    })
    MERGE (passage)-[:MENTIONS]->(entity)
  `,
  mergeClaims: `
    UNWIND $rows AS row
    MATCH (source:Entity {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      entityKey: row.sourceEntityId
    })
    MATCH (target:Entity {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      entityKey: row.targetEntityId
    })
    MERGE (claim:Claim {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      claimId: row.id
    })
    ON CREATE SET claim.predicate = row.predicate,
      claim.fact = row.fact,
      claim.factType = row.factType,
      claim.sourceEntityId = row.sourceEntityId,
      claim.targetEntityId = row.targetEntityId,
      claim.sourceEntityName = row.sourceEntityName,
      claim.targetEntityName = row.targetEntityName,
      claim.episodes = row.episodes,
      claim.passageIds = row.passageIds,
      claim.confidence = row.confidence,
      claim.status = row.status,
      claim.attributesJson = row.attributesJson,
      claim.createdAt = row.createdAt,
      claim.validAt = row.validAt,
      claim.invalidAt = row.invalidAt,
      claim.expiredAt = row.expiredAt
    MERGE (source)-[:SUBJECT_OF]->(claim)
    MERGE (claim)-[:OBJECT]->(target)
    WITH claim, row
    UNWIND row.passageIds AS passageId
    MATCH (passage:Passage {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      passageId: passageId
    })
    MERGE (claim)-[:SUPPORTED_BY]->(passage)
  `,
  mergeCommunities: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    UNWIND $rows AS row
    MERGE (community:Community {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      communityId: row.id
    })
    ON CREATE SET community.name = row.name,
      community.entityIds = row.entityIds,
      community.claimIds = row.claimIds,
      community.summary = row.summary,
      community.keywords = row.keywords,
      community.level = row.level,
      community.parentId = row.parentId
    MERGE (snapshot)-[:CONTAINS_COMMUNITY]->(community)
    WITH community, row
    UNWIND row.entityIds AS entityId
    MATCH (entity:Entity {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      entityKey: entityId
    })
    MERGE (entity)-[:IN_COMMUNITY]->(community)
  `,
  mergeCommunityClaims: `
    UNWIND $rows AS row
    MATCH (community:Community {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      communityId: row.id
    })
    UNWIND row.claimIds AS claimId
    MATCH (claim:Claim {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      claimId: claimId
    })
    MERGE (community)-[:HAS_CLAIM]->(claim)
  `,
  mergeCommunityParents: `
    UNWIND $rows AS row
    WITH row WHERE row.parentId IS NOT NULL
    MATCH (community:Community {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      communityId: row.id
    })
    MATCH (parent:Community {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      communityId: row.parentId
    })
    MERGE (parent)-[:PARENT_OF]->(community)
  `,
  listSnapshots: `
    MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId})
    WHERE snapshot.status IN ['staging', 'active', 'superseded']
      AND (snapshot.expiresAt IS NULL OR snapshot.expiresAt > $now)
      AND NOT EXISTS {
        MATCH (snapshot)-[:CONTAINS]->(document:DocumentVersion)
        WHERE NOT document.trustLevel IN $allowedTrustLevels
      }
    RETURN properties(snapshot) AS snapshot
    ORDER BY snapshot.createdAt DESC, snapshot.graphVersion ASC
    LIMIT toInteger($limit)
  `,
  listExpiredSnapshots: `
    MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId})
    WHERE snapshot.expiresAt IS NOT NULL
      AND snapshot.expiresAt <= $now
      AND snapshot.status <> 'active'
    RETURN properties(snapshot) AS snapshot
    ORDER BY snapshot.expiresAt ASC, snapshot.createdAt ASC, snapshot.graphVersion ASC
    LIMIT toInteger($limit)
  `,
  getCompatibilityDescriptor: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })-[:CONTAINS]->(document:DocumentVersion)
    WITH snapshot, collect(properties(document)) AS documents
    WHERE size(documents) = 1
      AND documents[0].trustLevel IN $allowedTrustLevels
      AND (
        $availability = 'all'
        OR ($availability = 'available'
          AND snapshot.status IN ['staging', 'active', 'superseded']
          AND (snapshot.expiresAt IS NULL OR snapshot.expiresAt > $now))
        OR ($availability = 'expired'
          AND snapshot.status IN ['staging', 'active', 'superseded']
          AND snapshot.expiresAt IS NOT NULL AND snapshot.expiresAt <= $now)
      )
    RETURN properties(snapshot) AS snapshot, documents[0] AS document
  `,
  snapshotExists: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    RETURN count(snapshot) > 0 AS exists
  `,
  listCompatibilityDescriptors: `
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId
    })-[:CONTAINS]->(document:DocumentVersion)
    WITH snapshot, collect(properties(document)) AS documents
    WHERE size(documents) = 1
    WITH snapshot, documents[0] AS document
    WHERE document.trustLevel IN $allowedTrustLevels
      AND snapshot.status IN ['staging', 'active', 'superseded']
      AND (
        $availability = 'all'
        OR ($availability = 'available'
          AND (snapshot.expiresAt IS NULL OR snapshot.expiresAt > $now))
        OR ($availability = 'expired'
          AND snapshot.expiresAt IS NOT NULL AND snapshot.expiresAt <= $now)
      )
    RETURN properties(snapshot) AS snapshot, document
    ORDER BY
      CASE WHEN $availability = 'expired' THEN snapshot.expiresAt END ASC,
      CASE WHEN $availability <> 'expired' THEN snapshot.createdAt END DESC,
      snapshot.graphVersion ASC
    LIMIT toInteger($limit)
  `,
  listDocuments: `
    MATCH (:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })-[:CONTAINS]->(node:DocumentVersion)
    RETURN properties(node) AS data ORDER BY node.documentId, node.documentVersion
  `,
  listPassages: `
    MATCH (node:Passage {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    RETURN properties(node) AS data ORDER BY node.chunkIndex, node.passageId
  `,
  listEntities: `
    MATCH (node:Entity {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    RETURN properties(node) AS data ORDER BY node.entityKey
  `,
  listClaims: `
    MATCH (node:Claim {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    RETURN properties(node) AS data ORDER BY node.claimId
  `,
  listCommunities: `
    MATCH (node:Community {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    RETURN properties(node) AS data ORDER BY node.communityId
  `,
  getActive: `
    OPTIONAL MATCH (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId})
    RETURN pointer.activeGraphVersion AS graphVersion,
      coalesce(pointer.revision, 0) AS revision,
      pointer.updatedAt AS updatedAt
  `,
  compareAndSetActive: `
    OPTIONAL MATCH (target:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    WITH target
    WHERE $graphVersion IS NULL OR (
      target IS NOT NULL
      AND target.status IN ['staging', 'active', 'superseded']
      AND (target.expiresAt IS NULL OR target.expiresAt > $now)
      AND NOT EXISTS {
        MATCH (target)-[:CONTAINS]->(document:DocumentVersion)
        WHERE NOT document.trustLevel IN $allowedTrustLevels
      }
    )
    MERGE (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId})
    ON CREATE SET pointer.revision = 0
    SET pointer.casLock = coalesce(pointer.casLock, 0) + 1
    WITH pointer, target
    WHERE pointer.revision = $expectedRevision
    OPTIONAL MATCH (current:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId,
      graphVersion: pointer.activeGraphVersion
    })
    FOREACH (_ IN CASE WHEN current IS NULL THEN [] ELSE [1] END |
      SET current.status = 'superseded')
    FOREACH (_ IN CASE WHEN target IS NULL THEN [] ELSE [1] END |
      SET target.status = 'active')
    SET pointer.activeGraphVersion = $graphVersion,
      pointer.revision = pointer.revision + 1,
      pointer.updatedAt = $updatedAt
    REMOVE pointer.casLock
    RETURN pointer.activeGraphVersion AS graphVersion,
      pointer.revision AS revision,
      pointer.updatedAt AS updatedAt
  `,
  deleteSnapshot: `
    OPTIONAL MATCH (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId})
    WITH pointer
    WHERE pointer IS NULL
      OR pointer.activeGraphVersion IS NULL
      OR pointer.activeGraphVersion <> $graphVersion
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    OPTIONAL MATCH (node)
    WHERE node.tenantId = $tenantId
      AND node.corpusId = $corpusId
      AND node.graphVersion = $graphVersion
      AND (node:GraphSnapshot OR node:DocumentVersion OR node:Passage
        OR node:Entity OR node:Claim OR node:Community)
    WITH collect(DISTINCT node) AS nodes
    UNWIND nodes AS node
    DETACH DELETE node
    RETURN count(*) AS deleted
  `,
  deleteSnapshotWithPostgresLease: `
    OPTIONAL MATCH (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId})
    FOREACH (_ IN CASE
      WHEN pointer.activeGraphVersion = $graphVersion THEN [1]
      ELSE []
    END |
      SET pointer.activeGraphVersion = NULL,
        pointer.revision = coalesce(pointer.revision, 0) + 1,
        pointer.updatedAt = $updatedAt)
    WITH pointer
    MATCH (snapshot:GraphSnapshot {
      tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion
    })
    OPTIONAL MATCH (node)
    WHERE node.tenantId = $tenantId
      AND node.corpusId = $corpusId
      AND node.graphVersion = $graphVersion
      AND (node:GraphSnapshot OR node:DocumentVersion OR node:Passage
        OR node:Entity OR node:Claim OR node:Community)
    WITH collect(DISTINCT node) AS nodes
    UNWIND nodes AS node
    DETACH DELETE node
    RETURN count(*) AS deleted
  `,
});

export class Neo4jKnowledgeGraphCommandStore implements KnowledgeGraphCommandStore {
  readonly coordination = 'shared' as const;
  private readonly client: Pick<Neo4jClient, 'executeRead' | 'executeWrite'>;
  private readonly now: () => Date;

  constructor(
    client: Pick<Neo4jClient, 'executeRead' | 'executeWrite'>,
    options: { now?: () => Date } = {}
  ) {
    this.client = client;
    this.now = options.now ?? (() => new Date());
  }

  async stageSnapshot(
    snapshot: KnowledgeGraphSnapshot
  ): Promise<KnowledgeGraphSnapshotDescriptor> {
    assertSnapshot(snapshot);
    const identity = createKnowledgeGraphSnapshotIdentity(snapshot);
    try {
      return await this.client.executeWrite('stage knowledge graph snapshot', async (tx) => {
        const base = { ...identity };
        const existingResult = await tx.run(CYPHER.findSnapshot, base);
        const existing = existingResult.records[0]
          ? descriptorFromProperties(existingResult.records[0].get('snapshot'))
          : null;
        if (existing) {
          if (existing.artifactDigest !== snapshot.artifactDigest) {
            throw new KnowledgeGraphError(
              'KNOWLEDGE_GRAPH_CONFLICT',
              'A graph snapshot with the same identity has a different digest.'
            );
          }
          return existing;
        }

        const descriptor = descriptorFromSnapshot(snapshot);
        const mergedResult = await tx.run(CYPHER.mergeSnapshot, {
          ...base,
          graphId: descriptor.graphId,
          graphName: descriptor.graphName ?? null,
          status: descriptor.status,
          artifactDigest: descriptor.artifactDigest,
          createdAt: descriptor.createdAt,
          expiresAt: descriptor.expiresAt ?? null,
          documentCount: descriptor.documentCount,
          passageCount: descriptor.passageCount,
          entityCount: descriptor.entityCount,
          claimCount: descriptor.claimCount,
          communityCount: descriptor.communityCount,
        });
        const persisted = mergedResult.records[0]
          ? descriptorFromProperties(mergedResult.records[0].get('snapshot'))
          : null;
        if (!persisted) {
          throw new Error('Neo4j did not return the staged graph snapshot.');
        }
        if (persisted.artifactDigest !== snapshot.artifactDigest) {
          throw new KnowledgeGraphError(
            'KNOWLEDGE_GRAPH_CONFLICT',
            'A concurrently staged graph snapshot has the same identity and a different digest.'
          );
        }
        await runBatches(tx, CYPHER.mergeDocuments, base, snapshot.documents);
        await runBatches(tx, CYPHER.mergePassages, base, snapshot.passages.map(toPassageRow));
        await runBatches(tx, CYPHER.mergeEntities, base, snapshot.entities.map(toEntityRow));
        await runBatches(tx, CYPHER.mergeClaims, base, snapshot.claims.map(toClaimRow));
        await runBatches(
          tx,
          CYPHER.mergeCommunities,
          base,
          snapshot.communities.map(toCommunityRow)
        );
        await runBatches(
          tx,
          CYPHER.mergeCommunityClaims,
          base,
          snapshot.communities.map(toCommunityRow)
        );
        await runBatches(
          tx,
          CYPHER.mergeCommunityParents,
          base,
          snapshot.communities.map(toCommunityRow)
        );
        return persisted;
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to stage the knowledge graph snapshot.');
    }
  }

  async getSnapshot(
    identityInput: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<KnowledgeGraphSnapshot | null> {
    const identity = assertScopedIdentity(identityInput, scope);
    try {
      return await this.client.executeRead('read knowledge graph snapshot', async (tx) => {
        const snapshotResult = await tx.run(CYPHER.findScopedSnapshot, {
          ...identity,
          allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
          now: this.now().toISOString(),
        });
        if (snapshotResult.records.length === 0) return null;
        const descriptor = descriptorFromProperties(snapshotResult.records[0].get('snapshot'));
        // A managed Neo4j transaction serializes result streams. Sequential reads
        // avoid interleaving statements on the same session under load.
        const documents = await readRows(tx, CYPHER.listDocuments, identity, toDocument);
        assertAllowedSnapshotTrust(documents, scope, 'document');
        const passages = await readRows(tx, CYPHER.listPassages, identity, toPassage);
        assertAllowedSnapshotTrust(passages, scope, 'passage');
        const entities = await readRows(tx, CYPHER.listEntities, identity, toEntity);
        const claims = await readRows(tx, CYPHER.listClaims, identity, toClaim);
        const communities = await readRows(tx, CYPHER.listCommunities, identity, toCommunity);
        const snapshot: KnowledgeGraphSnapshot = {
          tenantId: descriptor.tenantId,
          corpusId: descriptor.corpusId,
          graphVersion: descriptor.graphVersion,
          graphId: descriptor.graphId,
          ...(descriptor.graphName ? { graphName: descriptor.graphName } : {}),
          status: descriptor.status,
          artifactDigest: descriptor.artifactDigest,
          createdAt: descriptor.createdAt,
          ...(descriptor.expiresAt ? { expiresAt: descriptor.expiresAt } : {}),
          documents,
          passages,
          entities,
          claims,
          communities,
        };
        assertSnapshotContents(snapshot);
        return snapshot;
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to read the knowledge graph snapshot.');
    }
  }

  async listSnapshots(
    scope: RagRetrievalScope,
    options: { limit?: number } = {}
  ): Promise<KnowledgeGraphSnapshotDescriptor[]> {
    const limit = boundedLimit(options.limit, 100, 1_000);
    try {
      return await this.client.executeRead('list knowledge graph snapshots', async (tx) => {
        const result = await tx.run(CYPHER.listSnapshots, {
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: '',
          allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
          now: this.now().toISOString(),
          limit,
        });
        return result.records.map((record) => descriptorFromProperties(record.get('snapshot')));
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to list knowledge graph snapshots.');
    }
  }

  async getCompatibilityDescriptor(
    identityInput: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope,
    options: Pick<KnowledgeGraphCompatibilityListOptions, 'availability'> = {}
  ): Promise<KnowledgeGraphCompatibilitySnapshotDescriptor | null> {
    const identity = assertScopedIdentity(identityInput, scope);
    const availability = options.availability ?? 'available';
    if (availability !== 'available' && availability !== 'expired' && availability !== 'all') {
      throw new Error('Knowledge graph compatibility availability is invalid.');
    }
    try {
      return await this.client.executeRead(
        'read compatibility knowledge graph descriptor',
        async (tx) => {
          const result = await tx.run(CYPHER.getCompatibilityDescriptor, {
            ...identity,
            allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
            availability,
            now: this.now().toISOString(),
          });
          const record = result.records[0];
          return record ? compatibilityDescriptorFromRecord(record) : null;
        }
      );
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to read the compatibility graph descriptor.');
    }
  }

  async listCompatibilityDescriptors(
    scope: RagRetrievalScope,
    options: KnowledgeGraphCompatibilityListOptions = {}
  ): Promise<KnowledgeGraphCompatibilitySnapshotDescriptor[]> {
    const limit = boundedLimit(options.limit, 100, 1_000);
    const availability = options.availability ?? 'available';
    if (availability !== 'available' && availability !== 'expired' && availability !== 'all') {
      throw new Error('Knowledge graph compatibility availability is invalid.');
    }
    try {
      return await this.client.executeRead(
        'list compatibility knowledge graph descriptors',
        async (tx) => {
          const result = await tx.run(CYPHER.listCompatibilityDescriptors, {
            tenantId: scope.tenantId,
            corpusId: scope.corpusId,
            graphVersion: '',
            allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
            availability,
            now: this.now().toISOString(),
            limit,
          });
          return result.records.map(compatibilityDescriptorFromRecord);
        }
      );
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to list compatibility graph descriptors.');
    }
  }

  async deleteSnapshot(
    identityInput: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const identity = assertScopedIdentity(identityInput, scope);
    try {
      return await this.client.executeWrite('delete knowledge graph snapshot', async (tx) => {
        const result = await tx.run(CYPHER.deleteSnapshot, identity);
        return result.records.length > 0 && toNumber(result.records[0].get('deleted')) > 0;
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to delete the knowledge graph snapshot.');
    }
  }

  async snapshotExists(
    identityInput: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const identity = assertScopedIdentity(identityInput, scope);
    try {
      return await this.client.executeRead('check knowledge graph snapshot existence', async (tx) => {
        const result = await tx.run(CYPHER.snapshotExists, identity);
        return result.records[0]?.get('exists') === true;
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to check knowledge graph snapshot existence.');
    }
  }

  /**
   * Deletes a snapshot after PostgreSQL granted the caller its deletion lease.
   * PostgreSQL is authoritative in this path, so an obsolete Neo4j pointer is
   * cleared atomically with the graph data instead of vetoing the deletion.
   */
  async deleteSnapshotWithPostgresLease(
    identityInput: KnowledgeGraphSnapshotIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const identity = assertScopedIdentity(identityInput, scope);
    try {
      return await this.client.executeWrite(
        'authoritatively delete leased knowledge graph snapshot',
        async (tx) => {
          const result = await tx.run(CYPHER.deleteSnapshotWithPostgresLease, {
            ...identity,
            updatedAt: this.now().toISOString(),
          });
          return result.records.length > 0 && toNumber(result.records[0].get('deleted')) > 0;
        }
      );
    } catch (error) {
      throw mapNeo4jError(
        error,
        'Unable to authoritatively delete the leased knowledge graph snapshot.'
      );
    }
  }

  async getActive(scope: RagRetrievalScope): Promise<KnowledgeGraphActivePointer> {
    try {
      return await this.client.executeRead('read active knowledge graph snapshot', async (tx) => {
        const result = await tx.run(CYPHER.getActive, {
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: '',
        });
        const record = result.records[0];
        return {
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: optionalString(record?.get('graphVersion')),
          revision: toNumber(record?.get('revision')),
          updatedAt: optionalString(record?.get('updatedAt')) ?? new Date(0).toISOString(),
        };
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to read the active graph snapshot.');
    }
  }

  async compareAndSetActive(
    scope: RagRetrievalScope,
    graphVersionInput: string | null,
    expectedRevision: number
  ): Promise<KnowledgeGraphActivePointer> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Knowledge graph active revision must be a non-negative integer.');
    }
    const graphVersion = graphVersionInput === null
      ? null
      : createKnowledgeGraphSnapshotIdentity({
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: graphVersionInput,
        }).graphVersion;
    const updatedAt = this.now().toISOString();
    try {
      return await this.client.executeWrite('activate knowledge graph snapshot', async (tx) => {
        const result = await tx.run(CYPHER.compareAndSetActive, {
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion,
          expectedRevision,
          updatedAt,
          now: updatedAt,
          allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
        });
        const record = result.records[0];
        if (!record) {
          throw new KnowledgeGraphError(
            'KNOWLEDGE_GRAPH_CONFLICT',
            'The active graph revision changed or the requested snapshot does not exist.'
          );
        }
        return {
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: optionalString(record.get('graphVersion')),
          revision: toNumber(record.get('revision')),
          updatedAt: requiredString(record.get('updatedAt'), 'updatedAt'),
        };
      });
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to activate the knowledge graph snapshot.');
    }
  }

  async gcExpired(
    scope: RagRetrievalScope,
    options: { limit?: number } = {}
  ): Promise<number> {
    const limit = boundedLimit(options.limit, 10, 100);
    const now = this.now().toISOString();
    let snapshots: KnowledgeGraphSnapshotDescriptor[];
    try {
      snapshots = await this.client.executeRead(
        'list expired knowledge graph snapshots',
        async tx => {
          const result = await tx.run(CYPHER.listExpiredSnapshots, {
            tenantId: scope.tenantId,
            corpusId: scope.corpusId,
            graphVersion: '',
            now,
            limit,
          });
          return result.records.map(record => descriptorFromProperties(record.get('snapshot')));
        }
      );
    } catch (error) {
      throw mapNeo4jError(error, 'Unable to list expired knowledge graph snapshots.');
    }
    let deleted = 0;
    for (const snapshot of snapshots) {
      if (await this.deleteSnapshot(snapshot, scope)) deleted++;
    }
    return deleted;
  }
}

async function runBatches<T>(
  tx: ManagedTransaction,
  cypher: string,
  base: KnowledgeGraphSnapshotIdentity,
  rows: readonly T[]
): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    await tx.run(cypher, { ...base, rows: rows.slice(start, start + BATCH_SIZE) });
  }
}

async function readRows<T>(
  tx: ManagedTransaction,
  cypher: string,
  identity: KnowledgeGraphSnapshotIdentity,
  mapper: (value: unknown) => T
): Promise<T[]> {
  const result = await tx.run(cypher, identity);
  return result.records.map((record) => mapper(record.get('data')));
}

function assertSnapshot(snapshot: KnowledgeGraphSnapshot): void {
  createKnowledgeGraphSnapshotIdentity(snapshot);
  if (snapshot.status !== 'staging') {
    throw new Error('A new knowledge graph snapshot must be staged before activation.');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.artifactDigest)) {
    throw new Error('Knowledge graph artifactDigest must be a SHA-256 digest.');
  }
  assertSnapshotContents(snapshot);
}

function assertSnapshotContents(snapshot: KnowledgeGraphSnapshot): void {
  const documents = new Map<string, RagTrustLevel>();
  for (const document of snapshot.documents) {
    const key = documentVersionKey(document);
    const existingTrust = documents.get(key);
    if (existingTrust) {
      if (existingTrust !== document.trustLevel) {
        throw new Error(
          `Knowledge graph document ${document.documentId}@${document.documentVersion} has conflicting trust levels.`
        );
      }
      throw new Error('Knowledge graph contains duplicate document identities.');
    }
    documents.set(key, document.trustLevel);
  }
  const passages = new Set(snapshot.passages.map((passage) => passage.id));
  assertUnique(passages.size, snapshot.passages.length, 'passage');
  for (const passage of snapshot.passages) {
    const documentTrust = documents.get(documentVersionKey(passage));
    if (!documentTrust) {
      throw new Error(`Knowledge graph passage ${passage.id} references a missing document.`);
    }
    if (passage.trustLevel !== documentTrust) {
      throw new Error(
        `Knowledge graph passage ${passage.id} trust level does not match its document version.`
      );
    }
    if (!passage.content.trim()) {
      throw new Error(`Knowledge graph passage ${passage.id} has no source content.`);
    }
  }
  const entities = new Set(snapshot.entities.map((entity) => entity.id));
  assertUnique(entities.size, snapshot.entities.length, 'entity');
  for (const entity of snapshot.entities) assertReferences(entity.passageIds, passages, 'passage');
  const claims = new Set(snapshot.claims.map((claim) => claim.id));
  assertUnique(claims.size, snapshot.claims.length, 'claim');
  for (const claim of snapshot.claims) {
    assertReferences([claim.sourceEntityId, claim.targetEntityId], entities, 'entity');
    assertReferences(claim.passageIds, passages, 'passage');
  }
  const communities = new Set(snapshot.communities.map((community) => community.id));
  assertUnique(communities.size, snapshot.communities.length, 'community');
  for (const community of snapshot.communities) {
    assertReferences(community.entityIds, entities, 'entity');
    assertReferences(community.claimIds, claims, 'claim');
    if (community.parentId && !communities.has(community.parentId)) {
      throw new Error(`Knowledge graph community ${community.id} has a missing parent.`);
    }
  }
}

function assertAllowedSnapshotTrust(
  values: readonly { trustLevel: RagTrustLevel }[],
  scope: RagRetrievalScope,
  kind: 'document' | 'passage'
): void {
  const allowedTrustLevels = new Set(scope.allowedTrustLevels);
  if (values.some(value => !allowedTrustLevels.has(value.trustLevel))) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_SCOPE_VIOLATION',
      `Knowledge graph ${kind} trust level is outside the retrieval scope.`
    );
  }
}

function assertScopedIdentity(
  identityInput: KnowledgeGraphSnapshotIdentity,
  scope: RagRetrievalScope
): KnowledgeGraphSnapshotIdentity {
  const identity = createKnowledgeGraphSnapshotIdentity(identityInput);
  if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_SCOPE_VIOLATION',
      'Knowledge graph identity does not match the retrieval scope.'
    );
  }
  return identity;
}

function assertUnique(actual: number, expected: number, kind: string): void {
  if (actual !== expected) throw new Error(`Knowledge graph contains duplicate ${kind} identities.`);
}

function assertReferences(
  references: readonly string[],
  available: ReadonlySet<string>,
  kind: string
): void {
  for (const reference of references) {
    if (!available.has(reference)) {
      throw new Error(`Knowledge graph contains a dangling ${kind} reference: ${reference}.`);
    }
  }
}

function documentVersionKey(document: KnowledgeGraphDocumentIdentity): string {
  return JSON.stringify([document.documentId, document.documentVersion]);
}

function descriptorFromSnapshot(
  snapshot: KnowledgeGraphSnapshot
): KnowledgeGraphSnapshotDescriptor {
  return {
    tenantId: snapshot.tenantId,
    corpusId: snapshot.corpusId,
    graphVersion: snapshot.graphVersion,
    graphId: snapshot.graphId,
    ...(snapshot.graphName ? { graphName: snapshot.graphName } : {}),
    status: snapshot.status,
    artifactDigest: snapshot.artifactDigest,
    createdAt: snapshot.createdAt,
    ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
    documentCount: snapshot.documents.length,
    passageCount: snapshot.passages.length,
    entityCount: snapshot.entities.length,
    claimCount: snapshot.claims.length,
    communityCount: snapshot.communities.length,
  };
}

function descriptorFromProperties(value: unknown): KnowledgeGraphSnapshotDescriptor {
  const data = asRecord(value, 'snapshot');
  return {
    tenantId: requiredString(data.tenantId, 'tenantId'),
    corpusId: requiredString(data.corpusId, 'corpusId'),
    graphVersion: requiredString(data.graphVersion, 'graphVersion'),
    graphId: requiredString(data.graphId, 'graphId'),
    ...(optionalString(data.graphName) ? { graphName: optionalString(data.graphName)! } : {}),
    status: requiredStatus(data.status),
    artifactDigest: requiredString(data.artifactDigest, 'artifactDigest'),
    createdAt: requiredString(data.createdAt, 'createdAt'),
    ...(optionalString(data.expiresAt) ? { expiresAt: optionalString(data.expiresAt)! } : {}),
    documentCount: toNumber(data.documentCount),
    passageCount: toNumber(data.passageCount),
    entityCount: toNumber(data.entityCount),
    claimCount: toNumber(data.claimCount),
    communityCount: toNumber(data.communityCount),
  };
}

function compatibilityDescriptorFromRecord(record: {
  get(key: string): unknown;
}): KnowledgeGraphCompatibilitySnapshotDescriptor {
  return {
    ...descriptorFromProperties(record.get('snapshot')),
    document: toDocument(record.get('document')),
  };
}

function toPassageRow(passage: KnowledgeGraphPassage): Record<string, unknown> {
  return {
    ...passage,
    source: passage.source ?? null,
    page: passage.page ?? null,
    sectionPath: passage.sectionPath ?? [],
    metadataJson: JSON.stringify(passage.metadata ?? {}),
  };
}

function toEntityRow(entity: KnowledgeGraphEntity): Record<string, unknown> {
  return {
    ...entity,
    createdAt: entity.createdAt ?? null,
    attributesJson: JSON.stringify(entity.attributes),
  };
}

function toClaimRow(claim: KnowledgeGraphClaim): Record<string, unknown> {
  return {
    ...claim,
    createdAt: claim.createdAt ?? null,
    validAt: claim.validAt ?? null,
    invalidAt: claim.invalidAt ?? null,
    expiredAt: claim.expiredAt ?? null,
    attributesJson: JSON.stringify(claim.attributes),
  };
}

function toCommunityRow(community: KnowledgeGraphCommunity): Record<string, unknown> {
  return { ...community, parentId: community.parentId ?? null };
}

function toDocument(value: unknown): KnowledgeGraphDocumentIdentity {
  const data = asRecord(value, 'document');
  return {
    documentId: requiredString(data.documentId, 'documentId'),
    documentVersion: requiredString(data.documentVersion, 'documentVersion'),
    trustLevel: requiredTrustLevel(data.trustLevel),
  };
}

function toPassage(value: unknown): KnowledgeGraphPassage {
  const data = asRecord(value, 'passage');
  return {
    id: requiredString(data.passageId, 'passageId'),
    documentId: requiredString(data.documentId, 'documentId'),
    documentVersion: requiredString(data.documentVersion, 'documentVersion'),
    trustLevel: requiredTrustLevel(data.trustLevel),
    content: requiredString(data.content, 'content'),
    index: toNumber(data.chunkIndex),
    startOffset: toNumber(data.startOffset),
    endOffset: toNumber(data.endOffset),
    ...(optionalString(data.source) ? { source: optionalString(data.source)! } : {}),
    ...(data.page === null || data.page === undefined ? {} : { page: toNumber(data.page) }),
    ...(toStringArray(data.sectionPath).length > 0
      ? { sectionPath: toStringArray(data.sectionPath) }
      : {}),
    metadata: parseJsonRecord(data.metadataJson),
  };
}

function toEntity(value: unknown): KnowledgeGraphEntity {
  const data = asRecord(value, 'entity');
  return {
    id: requiredString(data.entityKey, 'entityKey'),
    name: requiredString(data.name, 'name'),
    normalizedName: requiredString(data.normalizedName, 'normalizedName'),
    labels: toStringArray(data.entityLabels),
    summary: optionalString(data.summary) ?? '',
    aliases: toStringArray(data.aliases),
    passageIds: toStringArray(data.passageIds),
    attributes: parseJsonRecord(data.attributesJson),
    ...(optionalString(data.createdAt) ? { createdAt: optionalString(data.createdAt)! } : {}),
  };
}

function toClaim(value: unknown): KnowledgeGraphClaim {
  const data = asRecord(value, 'claim');
  return {
    id: requiredString(data.claimId, 'claimId'),
    predicate: requiredString(data.predicate, 'predicate'),
    fact: requiredString(data.fact, 'fact'),
    factType: requiredString(data.factType, 'factType'),
    sourceEntityId: requiredString(data.sourceEntityId, 'sourceEntityId'),
    targetEntityId: requiredString(data.targetEntityId, 'targetEntityId'),
    sourceEntityName: requiredString(data.sourceEntityName, 'sourceEntityName'),
    targetEntityName: requiredString(data.targetEntityName, 'targetEntityName'),
    episodes: toStringArray(data.episodes),
    passageIds: toStringArray(data.passageIds),
    confidence: toNumber(data.confidence),
    status: requiredClaimStatus(data.status),
    attributes: parseJsonRecord(data.attributesJson),
    ...(optionalString(data.createdAt) ? { createdAt: optionalString(data.createdAt)! } : {}),
    ...(optionalString(data.validAt) ? { validAt: optionalString(data.validAt)! } : {}),
    ...(optionalString(data.invalidAt) ? { invalidAt: optionalString(data.invalidAt)! } : {}),
    ...(optionalString(data.expiredAt) ? { expiredAt: optionalString(data.expiredAt)! } : {}),
  };
}

function toCommunity(value: unknown): KnowledgeGraphCommunity {
  const data = asRecord(value, 'community');
  return {
    id: requiredString(data.communityId, 'communityId'),
    name: requiredString(data.name, 'name'),
    entityIds: toStringArray(data.entityIds),
    claimIds: toStringArray(data.claimIds),
    summary: optionalString(data.summary) ?? '',
    keywords: toStringArray(data.keywords),
    level: toNumber(data.level),
    ...(optionalString(data.parentId) ? { parentId: optionalString(data.parentId)! } : {}),
  };
}

function mapNeo4jError(error: unknown, message: string): Error {
  if (error instanceof KnowledgeGraphError) return error;
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof KnowledgeGraphError) return cause;
  }
  const code = readErrorCode(error);
  return new KnowledgeGraphError(
    code?.toLowerCase().includes('timeout')
      ? 'KNOWLEDGE_GRAPH_QUERY_TIMEOUT'
      : 'KNOWLEDGE_GRAPH_UNAVAILABLE',
    message,
    error
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Knowledge graph limit must be between 1 and ${maximum}.`);
  }
  return limit;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Neo4j returned an invalid ${field} record.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  const parsed = JSON.parse(value) as unknown;
  return asRecord(parsed, 'JSON property');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Neo4j ${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  if (value === null || value === undefined) return 0;
  throw new Error('Neo4j returned a non-numeric value.');
}

function requiredStatus(value: unknown): KnowledgeGraphSnapshotStatus {
  if (value === 'staging' || value === 'active' || value === 'superseded' || value === 'failed') {
    return value;
  }
  throw new Error('Neo4j returned an invalid graph snapshot status.');
}

function requiredClaimStatus(value: unknown): KnowledgeGraphClaim['status'] {
  if (value === 'active' || value === 'invalid' || value === 'expired' || value === 'superseded') {
    return value;
  }
  throw new Error('Neo4j returned an invalid graph claim status.');
}

function requiredTrustLevel(value: unknown): RagTrustLevel {
  if (value === 'trusted' || value === 'reviewed' || value === 'external' || value === 'quarantined') {
    return value;
  }
  throw new Error('Neo4j returned an invalid trust level.');
}
