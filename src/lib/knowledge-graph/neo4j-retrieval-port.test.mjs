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
const { Neo4jGraphRetrievalPort } = await import('./neo4j-retrieval-port.ts');

function relation(claimId, sourceEntityId, targetEntityId, passageIds) {
  return { claimId, sourceEntityId, sourceEntityName: sourceEntityId,
    predicate: 'RELATED_TO', targetEntityId, targetEntityName: targetEntityId, passageIds };
}

function sourcePassage(passageId) {
  return { passageId, documentId: 'doc-a', documentVersion: 'graph-v1', trustLevel: 'reviewed',
    content: 'Original source for ' + passageId, startOffset: 0, endOffset: 40 };
}

test('preserves ordered two-hop claim direction only on its supporting source passages', async () => {
  const first = relation('claim-1', 'entity-b', 'entity-a', ['passage-1']);
  const second = relation('claim-2', 'entity-b', 'entity-c', ['passage-2']);
  const client = fakeClient([
    { records: [record({ seedId: 'entity-a', entityId: 'entity-c', hop: 2,
      entityPassageIds: ['unrelated'], claimPassageIds: ['passage-1', 'passage-2'],
      claimIds: ['claim-1', 'claim-2'], communityIds: [], relations: [first, second] })] },
    { records: ['passage-1', 'passage-2', 'unrelated'].map(id => record({ passage: sourcePassage(id) })) },
  ]);
  const result = await new Neo4jGraphRetrievalPort(client).retrieve(request());
  for (const evidence of result.evidence.slice(0, 2)) assert.deepEqual(evidence.metadata.graphPaths, [[first, second]]);
  assert.deepEqual(result.evidence[2].metadata.graphPaths, []);
  assert.match(client.calls[0].cypher, /sourceEntityId: claim\.sourceEntityId/);
  assert.match(client.calls[0].cypher, /targetEntityId: claim\.targetEntityId/);
  assert.match(client.calls[0].cypher, /pathSource\.trustLevel IN \$allowedTrustLevels/);
});

test('does not emit unsupported, disconnected or over-budget relationship paths', async () => {
  for (const relations of [
    [relation('claim-empty', 'a', 'b', [])],
    [relation('claim-1', 'a', 'b', ['passage-1']), relation('claim-2', 'c', 'd', ['passage-1'])],
    [relation('claim-1', 'a', 'b', ['passage-1']), relation('claim-2', 'b', 'c', ['passage-1'])],
  ]) {
    const client = fakeClient([
      { records: [record({ seedId: 'a', entityId: 'b', hop: 1,
        entityPassageIds: ['passage-1'], claimPassageIds: ['passage-1'],
        claimIds: relations.map(item => item.claimId), communityIds: [], relations })] },
      { records: [record({ passage: { ...sourcePassage('passage-1'), metadataJson: JSON.stringify({ graphPaths: [[relation('spoof', 'a', 'b', ['passage-1'])]] }) } })] },
    ]);
    const result = await new Neo4jGraphRetrievalPort(client).retrieve(request({ maxHops: 1 }));
    assert.deepEqual(result.evidence[0].metadata.graphPaths, []);
  }
});

test('only emits complete relationship paths whose sources survived the passage budget', async () => {
  const relations = [relation('claim-1', 'a', 'b', ['passage-1']), relation('claim-2', 'b', 'c', ['not-delivered'])];
  const client = fakeClient([
    { records: [record({ seedId: 'a', entityId: 'c', hop: 2,
      entityPassageIds: [], claimPassageIds: ['passage-1', 'not-delivered'],
      claimIds: ['claim-1', 'claim-2'], communityIds: [], relations })] },
    { records: [record({ passage: sourcePassage('passage-1') })] },
  ]);
  const result = await new Neo4jGraphRetrievalPort(client).retrieve(request({ topK: 1 }));
  assert.deepEqual(result.evidence[0].metadata.graphPaths, []);
});

test('bounds per-passage relationship paths and reports truncation without changing the hop limit', async () => {
  const client = fakeClient([
    { records: Array.from({ length: 12 }, (_, index) => record({
      seedId: 'a', entityId: 'b', hop: 1, entityPassageIds: [], claimPassageIds: ['passage-1'],
      claimIds: ['claim-' + index], communityIds: [], relations: [relation('claim-' + index, 'a', 'b', ['passage-1'])],
    })) },
    { records: [record({ passage: sourcePassage('passage-1') })] },
  ]);
  const result = await new Neo4jGraphRetrievalPort(client).retrieve(request({ maxHops: 1 }));
  assert.equal(result.evidence[0].metadata.graphPaths.length, 8);
  assert.equal(result.diagnostics.truncated, true);
  assert.ok(result.evidence[0].metadata.graphPaths.every(path => path.length === 1));
});

function record(values) {
  return { get: key => values[key] };
}

function request(overrides = {}) {
  return {
    scope: createRetrievalScope({
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['trusted', 'reviewed'],
      enforceIsolation: true,
    }),
    snapshot: {
      graphVersion: 'graph-v1',
      documentId: 'doc-a',
      documentVersion: 'graph-v1',
      trustLevel: 'reviewed',
    },
    query: '实体 A 有什么合作关系？',
    laneId: 'graph-lane',
    topK: 3,
    maxHops: 2,
    seedPassageIds: ['dense-passage'],
    ...overrides,
  };
}

function fakeClient(results) {
  const calls = [];
  return {
    calls,
    async executeRead(_operation, work) {
      let index = 0;
      return work({
        async run(cypher, parameters) {
          calls.push({ cypher, parameters });
          return results[index++];
        },
      });
    },
  };
}

test('retrieves only source passages from a scoped two-hop graph query', async () => {
  const client = fakeClient([
    {
      records: [record({
        seedId: 'entity-a',
        entityId: 'entity-a',
        hop: 1,
        entityPassageIds: ['passage-a'],
        claimPassageIds: ['passage-b'],
        claimIds: ['claim-a'],
        communityIds: ['community-a'],
      })],
    },
    {
      records: [
        record({
          passage: {
            passageId: 'passage-a',
            documentId: 'doc-a',
            documentVersion: 'graph-v1',
            trustLevel: 'reviewed',
            content: '实体 A 与实体 B 合作。',
            source: 'source.pdf',
            page: 2,
            chunkIndex: 0,
            startOffset: 0,
            endOffset: 14,
            sectionPath: ['第二章'],
            metadataJson: '{"kind":"paragraph"}',
          },
          rank: 0,
        }),
      ],
    },
  ]);
  const port = new Neo4jGraphRetrievalPort(client);

  const result = await port.retrieve(request());

  assert.equal(result.stopReason, 'sufficient');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].content, '实体 A 与实体 B 合作。');
  assert.equal(result.evidence[0].metadata.graphPassageId, 'passage-a');
  assert.equal(result.evidence[0].metadata.graphVersion, 'graph-v1');
  assert.deepEqual(result.evidence[0].metadata.graphEntityIds, ['entity-a']);
  assert.equal(result.diagnostics.inspectedClaimCount, 1);
  assert.equal(result.diagnostics.matchedCommunityCount, 1);
  assert.match(client.calls[1].cypher, /snapshot\.status IN \['active', 'superseded'\]/);
  assert.match(client.calls[1].cypher, /snapshot\.expiresAt IS NULL OR snapshot\.expiresAt > \$now/);
});

test('keeps query text parameterized and constrains every lookup by graph scope', async () => {
  const injection = "实体 A' MATCH (secret) DETACH DELETE secret //";
  const client = fakeClient([{ records: [] }]);
  const port = new Neo4jGraphRetrievalPort(client);

  await port.retrieve(request({ query: injection, maxHops: 1 }));

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].cypher.includes(injection), false);
  assert.equal(client.calls[0].parameters.tenantId, 'tenant-a');
  assert.equal(client.calls[0].parameters.corpusId, 'corpus-a');
  assert.equal(client.calls[0].parameters.graphVersion, 'graph-v1');
  assert.deepEqual(client.calls[0].parameters.allowedTrustLevels, ['reviewed', 'trusted']);
  assert.match(client.calls[0].cypher, /\*0\.\.2/);
  assert.match(client.calls[0].cypher, /tenantId: \$tenantId/);
  assert.match(client.calls[0].cypher, /corpusId: \$corpusId/);
  assert.match(client.calls[0].cypher, /graphVersion: \$graphVersion/);
  assert.match(client.calls[0].cypher, /snapshot\.status IN \['active', 'superseded'\]/);
  assert.match(client.calls[0].cypher, /snapshot\.expiresAt IS NULL OR snapshot\.expiresAt > \$now/);
  assert.equal(typeof client.calls[0].parameters.now, 'string');
  assert.match(client.calls[0].cypher, /all\(claim IN \[pathNode IN nodes\(path\) WHERE pathNode:Claim\]/);
  assert.match(client.calls[0].cypher, /claim\.status = 'active'/);
  assert.match(client.calls[0].cypher, /MATCH \(claim\)-\[:SUPPORTED_BY\]->\(claimSource:Passage/);
  assert.match(client.calls[0].cypher, /claimSource\.trustLevel IN \$allowedTrustLevels/);
  assert.match(client.calls[0].cypher, /restrictedClaimSource/);
  assert.match(client.calls[0].cypher, /restrictedSeedSource/);
  assert.match(client.calls[0].cypher, /all\(entity IN \[pathNode IN nodes\(path\) WHERE pathNode:Entity\] WHERE/);
  assert.match(client.calls[0].cypher, /allowedEntitySource/);
  assert.match(client.calls[0].cypher, /restrictedEntitySource/);
});

test('returns no gain when no entity or dense passage seed can reach source evidence', async () => {
  const port = new Neo4jGraphRetrievalPort(fakeClient([{ records: [] }]));
  const result = await port.retrieve(request());

  assert.deepEqual(result.evidence, []);
  assert.equal(result.stopReason, 'no_gain');
  assert.equal(result.diagnostics.matchedEntityCount, 0);
});

test('maps Neo4j failures to an explicit degradable backend error', async () => {
  const port = new Neo4jGraphRetrievalPort({
    async executeRead() {
      const error = new Error('connection refused');
      error.code = 'ServiceUnavailable';
      throw error;
    },
  });

  await assert.rejects(
    port.retrieve(request()),
    error => error.code === 'KNOWLEDGE_GRAPH_UNAVAILABLE'
  );
});
