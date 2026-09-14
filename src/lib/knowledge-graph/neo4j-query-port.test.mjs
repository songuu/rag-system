import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && specifier.startsWith('.')
        && !specifier.endsWith('.ts')
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
const { Neo4jKnowledgeGraphQueryPort } = await import('./neo4j-query-port.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed'],
  enforceIsolation: true,
});

function record(values) {
  return { get: key => values[key] };
}

function fakeClient(result) {
  const calls = [];
  return {
    calls,
    async executeRead(_operation, work) {
      return work({
        async run(cypher, parameters) {
          calls.push({ cypher, parameters });
          return result;
        },
      });
    },
  };
}

test('searches entities with fixed scoped Cypher and parameterized user text', async () => {
  const injection = "Acme' DETACH DELETE secret //";
  const client = fakeClient({
    records: [record({
      entity: {
        entityKey: 'entity-a',
        name: 'Acme',
        normalizedName: 'acme',
        entityLabels: ['Organization'],
        summary: '摘要',
        aliases: ['A'],
        passageIds: ['passage-a'],
        attributesJson: '{}',
      },
      score: 1,
    })],
  });
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  const entities = await port.searchEntities({
    scope,
    graphVersion: 'graph-v1',
    query: injection,
    limit: 20,
  });

  assert.equal(entities[0].entity.id, 'entity-a');
  assert.equal(client.calls[0].cypher.includes(injection), false);
  assert.equal(client.calls[0].parameters.tenantId, 'tenant-a');
  assert.equal(client.calls[0].parameters.graphVersion, 'graph-v1');
  assert.deepEqual(client.calls[0].parameters.allowedTrustLevels, ['reviewed', 'trusted']);
  assert.match(client.calls[0].cypher, /allowedPassageIds\[0\.\.\$maxReferenceIds\]/);
  assert.match(client.calls[0].cypher, /aliases:\s*coalesce\(entity\.aliases/);
  assert.match(client.calls[0].cypher, /NOT restrictedPassage\.trustLevel IN \$allowedTrustLevels/);
  assert.equal((client.calls[0].cypher.match(/MATCH \(restrictedPassage:Passage/g) ?? []).length, 1);
  assert.doesNotMatch(client.calls[0].cypher, /RETURN properties\(entity\) AS entity/);
  assert.doesNotMatch(client.calls[0].cypher, /entity \{\.\*/);
  assert.equal(client.calls[0].parameters.maxReferenceIds, 64);
});

test('uses bounded fixed templates for one-hop and two-hop neighbor queries', async () => {
  const client = fakeClient({
    records: [record({
      entityIds: ['entity-a', 'entity-b'],
      claimIds: ['claim-a'],
      passageIds: ['passage-a'],
      score: 0.5,
    })],
  });
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  const paths = await port.getNeighbors({
    scope,
    graphVersion: 'graph-v1',
    entityId: 'entity-a',
    maxHops: 2,
    limit: 10,
  });

  assert.deepEqual(paths[0].claimIds, ['claim-a']);
  assert.match(client.calls[0].cypher, /\*1\.\.4/);
  assert.match(client.calls[0].cypher, /all\(node IN nodes\(path\)/);
  assert.match(client.calls[0].cypher, /all\(claim IN claims WHERE EXISTS/);
  assert.match(client.calls[0].cypher, /SUPPORTED_BY/);
  assert.match(client.calls[0].cypher, /all\(claim IN claims WHERE NOT EXISTS/);
  assert.match(client.calls[0].cypher, /all\(entity IN entities WHERE EXISTS/);
  assert.match(client.calls[0].cypher, /allowedEntitySource/);
  assert.match(client.calls[0].cypher, /all\(entity IN entities WHERE NOT EXISTS/);
  assert.match(client.calls[0].cypher, /restrictedEntitySource/);
  assert.doesNotMatch(client.calls[0].cypher, /claim\.passageIds/);
  assert.match(client.calls[0].cypher, /\[0\.\.\$maxReferenceIds\] AS passageIds/);
});

test('finds paths without interpolating either endpoint into Cypher', async () => {
  const client = fakeClient({ records: [] });
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  await port.findPaths({
    scope,
    graphVersion: 'graph-v1',
    sourceEntityId: "source' //",
    targetEntityId: 'target',
    maxHops: 1,
    limit: 5,
  });

  assert.equal(client.calls[0].cypher.includes("source' //"), false);
  assert.equal(client.calls[0].parameters.sourceEntityId, "source' //");
  assert.equal(client.calls[0].parameters.targetEntityId, 'target');
  assert.match(client.calls[0].cypher, /\*1\.\.2/);
});

test('lists scoped communities without loading the complete graph', async () => {
  const client = fakeClient({
    records: [record({
      community: {
        communityId: 'community-a',
        name: '合作网络',
        entityIds: ['entity-a'],
        claimIds: ['claim-a'],
        summary: '合作关系社区',
        keywords: ['合作'],
        level: 0,
      },
      score: 1,
    })],
  });
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  const communities = await port.searchCommunities({
    scope,
    graphVersion: 'graph-v1',
    query: '合作',
    limit: 10,
  });

  assert.equal(communities[0].community.id, 'community-a');
  assert.match(client.calls[0].cypher, /LIMIT toInteger\(\$limit\)/);
  assert.equal(client.calls[0].parameters.corpusId, 'corpus-a');
  assert.match(client.calls[0].cypher, /allowedEntityIds\[0\.\.\$maxReferenceIds\]/);
  assert.match(client.calls[0].cypher, /allowedClaimIds\[0\.\.\$maxReferenceIds\]/);
  assert.match(client.calls[0].cypher, /restrictedClaimPassage/);
  assert.equal((client.calls[0].cypher.match(/restrictedClaimPassage:Passage/g) ?? []).length, 1);
  assert.equal((client.calls[0].cypher.match(/restrictedPassage:Passage/g) ?? []).length, 1);
  assert.doesNotMatch(client.calls[0].cypher, /RETURN properties\(community\) AS community/);
  assert.doesNotMatch(client.calls[0].cypher, /community \{\.\*/);
});

test('rejects an empty community query before issuing a broad graph scan', async () => {
  const client = fakeClient({ records: [] });
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  await assert.rejects(
    port.searchCommunities({ scope, graphVersion: 'graph-v1', query: '   ', limit: 10 }),
    /community query.*non-empty/i
  );
  await assert.rejects(
    port.searchCommunities({ scope, graphVersion: 'graph-v1', limit: 10 }),
    /community query.*non-empty/i
  );
  assert.equal(client.calls.length, 0);
});

test('resolves a claim only through trusted source passages in the active scope', async () => {
  const client = fakeClient({
    records: [record({
      claim: {
        claimId: 'claim-a',
        predicate: 'founded',
        fact: 'Alice founded Acme',
        factType: 'relationship',
        sourceEntityId: 'entity-alice',
        targetEntityId: 'entity-acme',
        sourceEntityName: 'Alice',
        targetEntityName: 'Acme',
        episodes: [],
        passageIds: ['passage-a'],
        confidence: 0.98,
        status: 'active',
        attributesJson: '{}',
      },
      passages: [{
        passageId: 'passage-a',
        documentId: 'doc-a',
        documentVersion: 'doc-v1',
        trustLevel: 'reviewed',
        content: 'Alice founded Acme.',
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 19,
        source: 'facts.md',
        sectionPath: ['Founders'],
        metadataJson: '{"fixture":true}',
      }],
    })],
  });
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  const result = await port.getClaimSources({
    scope,
    graphVersion: 'graph-v1',
    claimId: "claim-a' RETURN secret //",
    limit: 10,
  });

  assert.equal(result.claim.id, 'claim-a');
  assert.equal(result.passages[0].id, 'passage-a');
  assert.equal(result.passages[0].metadata.fixture, true);
  assert.equal(client.calls[0].cypher.includes("claim-a' RETURN secret //"), false);
  assert.match(client.calls[0].cypher, /SUPPORTED_BY/);
  assert.match(client.calls[0].cypher, /passage\.trustLevel IN \$allowedTrustLevels/);
  assert.match(client.calls[0].cypher, /NOT restrictedPassage\.trustLevel IN \$allowedTrustLevels/);
  assert.equal((client.calls[0].cypher.match(/MATCH \(claim\)-\[:SUPPORTED_BY\]->\(restrictedPassage/g) ?? []).length, 1);
  assert.match(client.calls[0].cypher, /passageIds:\s*\[passage IN allowedPassages/);
  assert.equal(client.calls[0].parameters.claimId, "claim-a' RETURN secret //");
});

test('classifies Neo4j query timeout failures distinctly from unavailability', async () => {
  const client = {
    async executeRead() {
      const error = new Error('transaction exceeded deadline');
      error.code = 'Neo.ClientError.Transaction.TransactionTimedOut';
      throw error;
    },
  };
  const port = new Neo4jKnowledgeGraphQueryPort(client);

  await assert.rejects(
    port.searchEntities({ scope, graphVersion: 'graph-v1', query: 'Acme', limit: 10 }),
    error => error.code === 'KNOWLEDGE_GRAPH_QUERY_TIMEOUT'
  );
});
