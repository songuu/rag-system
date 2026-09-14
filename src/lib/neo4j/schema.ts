import type { Neo4jClient } from './driver';

export interface Neo4jSchemaStatement {
  readonly name: string;
  readonly cypher: string;
}

function fixedStatement(name: string, cypher: string): Neo4jSchemaStatement {
  return Object.freeze({ name, cypher });
}

// Keep schema tokens code-owned and reviewable. Tenant data is always supplied as
// parameters by repository adapters; model output must never become a label or key.
export const NEO4J_SCHEMA_STATEMENTS: readonly Neo4jSchemaStatement[] = Object.freeze([
  fixedStatement(
    'kg_graph_pointer_identity',
    'CREATE CONSTRAINT kg_graph_pointer_identity IF NOT EXISTS FOR (node:GraphPointer) REQUIRE (node.tenantId, node.corpusId) IS UNIQUE'
  ),
  fixedStatement(
    'kg_snapshot_identity',
    'CREATE CONSTRAINT kg_snapshot_identity IF NOT EXISTS FOR (node:GraphSnapshot) REQUIRE (node.tenantId, node.corpusId, node.graphVersion) IS UNIQUE'
  ),
  fixedStatement(
    'kg_document_version_identity',
    'CREATE CONSTRAINT kg_document_version_identity IF NOT EXISTS FOR (node:DocumentVersion) REQUIRE (node.tenantId, node.corpusId, node.graphVersion, node.documentId, node.documentVersion) IS UNIQUE'
  ),
  fixedStatement(
    'kg_passage_identity',
    'CREATE CONSTRAINT kg_passage_identity IF NOT EXISTS FOR (node:Passage) REQUIRE (node.tenantId, node.corpusId, node.graphVersion, node.passageId) IS UNIQUE'
  ),
  fixedStatement(
    'kg_entity_identity',
    'CREATE CONSTRAINT kg_entity_identity IF NOT EXISTS FOR (node:Entity) REQUIRE (node.tenantId, node.corpusId, node.graphVersion, node.entityKey) IS UNIQUE'
  ),
  fixedStatement(
    'kg_claim_identity',
    'CREATE CONSTRAINT kg_claim_identity IF NOT EXISTS FOR (node:Claim) REQUIRE (node.tenantId, node.corpusId, node.graphVersion, node.claimId) IS UNIQUE'
  ),
  fixedStatement(
    'kg_community_identity',
    'CREATE CONSTRAINT kg_community_identity IF NOT EXISTS FOR (node:Community) REQUIRE (node.tenantId, node.corpusId, node.graphVersion, node.communityId) IS UNIQUE'
  ),
  fixedStatement(
    'kg_snapshot_status',
    'CREATE RANGE INDEX kg_snapshot_status IF NOT EXISTS FOR (node:GraphSnapshot) ON (node.tenantId, node.corpusId, node.status)'
  ),
  fixedStatement(
    'kg_document_status',
    'CREATE RANGE INDEX kg_document_status IF NOT EXISTS FOR (node:DocumentVersion) ON (node.tenantId, node.corpusId, node.graphVersion, node.status)'
  ),
  fixedStatement(
    'kg_passage_document',
    'CREATE RANGE INDEX kg_passage_document IF NOT EXISTS FOR (node:Passage) ON (node.tenantId, node.corpusId, node.graphVersion, node.documentId, node.documentVersion)'
  ),
  fixedStatement(
    'kg_entity_normalized_name',
    'CREATE RANGE INDEX kg_entity_normalized_name IF NOT EXISTS FOR (node:Entity) ON (node.tenantId, node.corpusId, node.graphVersion, node.normalizedName)'
  ),
  fixedStatement(
    'kg_entity_fulltext',
    'CREATE FULLTEXT INDEX kg_entity_fulltext IF NOT EXISTS FOR (node:Entity) ON EACH [node.name, node.aliases, node.description]'
  ),
]);

export async function initializeNeo4jSchema(
  client: Pick<Neo4jClient, 'executeWrite'>
): Promise<{ applied: number }> {
  for (const statement of NEO4J_SCHEMA_STATEMENTS) {
    await client.executeWrite(
      `initialize Neo4j schema: ${statement.name}`,
      async transaction => {
        await transaction.run(statement.cypher, {});
      }
    );
  }
  return { applied: NEO4J_SCHEMA_STATEMENTS.length };
}
