import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const enabled = process.env.RAG_NEO4J_INTEGRATION === '1';
const publicationEnabled = enabled && Boolean(process.env.TEST_DATABASE_URL?.trim());

test('runs the complete Neo4j snapshot, query, retrieval, CAS, and delete lifecycle', { skip: !enabled }, async () => {
  const { createNeo4jClient } = await import('../neo4j/driver.ts');
  const { initializeNeo4jSchema } = await import('../neo4j/schema.ts');
  const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
  const { Neo4jKnowledgeGraphCommandStore } = await import('./neo4j-command-store.ts');
  const { Neo4jKnowledgeGraphQueryPort } = await import('./neo4j-query-port.ts');
  const { Neo4jGraphRetrievalPort } = await import('./neo4j-retrieval-port.ts');

  const tenantId = 'codex-kg-it-' + randomUUID();
  const corpusId = 'corpus-it';
  const graphVersion = 'graph-v1';
  const client = createNeo4jClient({
    uri: process.env.RAG_NEO4J_URI || 'neo4j://127.0.0.1:7687',
    username: process.env.RAG_NEO4J_USERNAME || 'neo4j',
    password: process.env.RAG_NEO4J_PASSWORD || 'neo4j-local-dev-only',
    database: process.env.RAG_NEO4J_DATABASE || 'neo4j',
    connectionTimeoutMs: 5_000,
    queryTimeoutMs: 10_000,
    writeTimeoutMs: 120_000,
    maxTransactionRetryTimeMs: 1_000,
    maxConnectionPoolSize: 10,
  });
  const scope = createRetrievalScope({
    tenantId,
    corpusId,
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  });
  const managementScope = createRetrievalScope({
    tenantId,
    corpusId,
    allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
    enforceIsolation: true,
  });
  const commandStore = new Neo4jKnowledgeGraphCommandStore(client);
  const queryPort = new Neo4jKnowledgeGraphQueryPort(client);
  const retrievalPort = new Neo4jGraphRetrievalPort(client);

  try {
    await client.verifyConnectivity();
    assert.equal((await initializeNeo4jSchema(client)).applied, 12);

    const snapshot = createSnapshot({ tenantId, corpusId, graphVersion });
    const first = await commandStore.stageSnapshot(snapshot);
    const repeated = await commandStore.stageSnapshot(snapshot);
    assert.equal(first.artifactDigest, repeated.artifactDigest);
    assert.equal(first.entityCount, 2);

    const compatibility = await commandStore.getCompatibilityDescriptor(
      { tenantId, corpusId, graphVersion },
      scope
    );
    assert.deepEqual(compatibility?.document, {
      documentId: 'doc-it', documentVersion: 'doc-v1', trustLevel: 'reviewed',
    });
    const compatibilityList = await commandStore.listCompatibilityDescriptors(scope);
    assert.equal(compatibilityList.length, 1);
    assert.equal(compatibilityList[0].graphVersion, graphVersion);

    const active = await commandStore.compareAndSetActive(scope, graphVersion, 0);
    assert.equal(active.graphVersion, graphVersion);
    assert.equal(active.revision, 1);

    const rollbackGraphVersion = 'graph-v2';
    await commandStore.stageSnapshot({
      ...createSnapshot({ tenantId, corpusId, graphVersion: rollbackGraphVersion }),
      artifactDigest: 'sha256:' + 'd'.repeat(64),
    });
    const promoted = await commandStore.compareAndSetActive(scope, rollbackGraphVersion, 1);
    assert.equal(promoted.graphVersion, rollbackGraphVersion);
    assert.equal(promoted.revision, 2);
    const rolledBack = await commandStore.compareAndSetActive(scope, graphVersion, 2);
    assert.equal(rolledBack.graphVersion, graphVersion);
    assert.equal(rolledBack.revision, 3);

    const stored = await commandStore.getSnapshot({ tenantId, corpusId, graphVersion }, scope);
    assert.equal(stored?.claims.length, 1);
    assert.equal(stored?.communities[0].claimIds[0], 'claim-founded');

    const entities = await queryPort.searchEntities({ scope, graphVersion, query: 'Acme', limit: 10 });
    assert.equal(entities[0].entity.id, 'entity-acme');

    const neighbors = await queryPort.getNeighbors({
      scope, graphVersion, entityId: 'entity-alice', maxHops: 1, limit: 10,
    });
    assert.deepEqual(neighbors[0].entityIds, ['entity-alice', 'entity-acme']);
    assert.deepEqual(neighbors[0].claimIds, ['claim-founded']);

    const paths = await queryPort.findPaths({
      scope, graphVersion, sourceEntityId: 'entity-alice',
      targetEntityId: 'entity-acme', maxHops: 1, limit: 10,
    });
    assert.equal(paths.length, 1);

    const communities = await queryPort.searchCommunities({
      scope, graphVersion, query: 'founder', limit: 10,
    });
    assert.equal(communities[0].community.id, 'community-founders');

    const claimSources = await queryPort.getClaimSources({
      scope, graphVersion, claimId: 'claim-founded', limit: 10,
    });
    assert.equal(claimSources?.claim.fact, 'Alice founded Acme');
    assert.equal(claimSources?.passages[0].id, 'passage-founded');
    assert.equal(claimSources?.passages[0].content, 'Alice founded Acme in 2024.');

    const retrieval = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion },
      query: 'Who founded Acme?',
      laneId: 'graph-entity',
      topK: 5,
      maxHops: 1,
      seedPassageIds: ['passage-founded'],
    });
    assert.equal(retrieval.stopReason, 'sufficient');
    assert.ok(retrieval.evidence.some(item => item.id.includes('passage-founded')));
    assert.ok(retrieval.evidence.every(item => item.tenantId === tenantId));

    const isolationGraphVersion = 'graph-trust-isolation-v1';
    await commandStore.stageSnapshot(createIsolationSnapshot({
      tenantId,
      corpusId,
      graphVersion: isolationGraphVersion,
    }));
    assert.equal(
      (await commandStore.listSnapshots(scope, { limit: 100 }))
        .some(descriptor => descriptor.graphVersion === isolationGraphVersion),
      false
    );
    await assert.rejects(
      commandStore.compareAndSetActive(scope, isolationGraphVersion, 3),
      error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
    );
    const stagingRetrieval = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion: isolationGraphVersion },
      query: 'Alice',
      laneId: 'graph-staging',
      topK: 10,
      maxHops: 2,
      seedPassageIds: ['passage-founded'],
    });
    assert.equal(stagingRetrieval.stopReason, 'no_gain');
    assert.deepEqual(stagingRetrieval.evidence, []);
    const promotedIsolation = await commandStore.compareAndSetActive(
      managementScope,
      isolationGraphVersion,
      3
    );
    assert.equal(promotedIsolation.revision, 4);
    const isolatedRetrieval = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion: isolationGraphVersion },
      query: 'Alice',
      laneId: 'graph-trust-isolation',
      topK: 10,
      maxHops: 2,
      seedPassageIds: ['passage-founded'],
    });
    assert.ok(isolatedRetrieval.evidence.some(item => item.id.includes('passage-founded')));
    assert.ok(isolatedRetrieval.evidence.every(item => item.trustLevel === 'reviewed'));
    assert.ok(isolatedRetrieval.evidence.every(item => !item.id.includes('passage-hidden')));
    assert.ok(isolatedRetrieval.evidence.every(item => !item.id.includes('passage-external')));
    assert.ok(isolatedRetrieval.evidence.every(item =>
      !item.metadata.graphClaimIds.includes('claim-invalid')
      && !item.metadata.graphClaimIds.includes('claim-external')
      && !item.metadata.graphClaimIds.includes('claim-mixed')
    ));
    const restoredAfterIsolation = await commandStore.compareAndSetActive(
      managementScope,
      graphVersion,
      4
    );
    assert.equal(restoredAfterIsolation.revision, 5);
    assert.deepEqual(await queryPort.searchEntities({
      scope, graphVersion: isolationGraphVersion, query: 'External', limit: 10,
    }), []);
    assert.deepEqual(await queryPort.findPaths({
      scope, graphVersion: isolationGraphVersion,
      sourceEntityId: 'entity-alice', targetEntityId: 'entity-external',
      maxHops: 2, limit: 10,
    }), []);
    assert.equal(await queryPort.getClaimSources({
      scope, graphVersion: isolationGraphVersion, claimId: 'claim-mixed', limit: 10,
    }), null);

    const mixedEntitySourceVersion = 'graph-mixed-entity-source-v1';
    await commandStore.stageSnapshot(createMixedEntitySourceSnapshot({
      tenantId,
      corpusId,
      graphVersion: mixedEntitySourceVersion,
    }));
    assert.deepEqual(await queryPort.findPaths({
      scope,
      graphVersion: mixedEntitySourceVersion,
      sourceEntityId: 'entity-source',
      targetEntityId: 'entity-mixed-target',
      maxHops: 1,
      limit: 10,
    }), []);
    const mixedEntityRetrieval = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion: mixedEntitySourceVersion },
      query: 'MixedTarget',
      laneId: 'graph-mixed-entity-source',
      topK: 10,
      maxHops: 1,
      seedPassageIds: [],
    });
    assert.equal(mixedEntityRetrieval.stopReason, 'no_gain');
    assert.deepEqual(mixedEntityRetrieval.evidence, []);

    const raceGraphVersion = 'graph-digest-race-v1';
    const race = await Promise.allSettled([
      commandStore.stageSnapshot(createSnapshot({
        tenantId,
        corpusId,
        graphVersion: raceGraphVersion,
      })),
      commandStore.stageSnapshot({
        ...createSnapshot({ tenantId, corpusId, graphVersion: raceGraphVersion }),
        artifactDigest: 'sha256:' + 'b'.repeat(64),
      }),
    ]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected').length, 1);
    assert.equal(
      race.find(result => result.status === 'rejected')?.reason?.code,
      'KNOWLEDGE_GRAPH_CONFLICT'
    );

    const expiredGraphVersion = 'graph-expired-v1';
    await commandStore.stageSnapshot({
      ...createSnapshot({ tenantId, corpusId, graphVersion: expiredGraphVersion }),
      artifactDigest: 'sha256:' + 'f'.repeat(64),
      expiresAt: '2026-09-06T00:00:00.000Z',
    });
    const expiredDescriptors = await commandStore.listCompatibilityDescriptors(
      scope,
      { availability: 'expired', limit: 10 }
    );
    assert.deepEqual(
      expiredDescriptors.map(descriptor => descriptor.graphVersion),
      [expiredGraphVersion]
    );
    assert.equal(
      (await commandStore.listSnapshots(scope, { limit: 100 }))
        .some(descriptor => descriptor.graphVersion === expiredGraphVersion),
      false
    );
    const expiredRetrieval = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion: expiredGraphVersion },
      query: 'Who founded Acme?',
      laneId: 'graph-expired',
      topK: 5,
      maxHops: 1,
      seedPassageIds: ['passage-founded'],
    });
    assert.equal(expiredRetrieval.stopReason, 'no_gain');
    assert.deepEqual(expiredRetrieval.evidence, []);
    await assert.rejects(
      commandStore.compareAndSetActive(scope, expiredGraphVersion, 5),
      error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
    );
    assert.equal(await commandStore.gcExpired(scope, { limit: 1 }), 1);
    assert.equal(await commandStore.getSnapshot({
      tenantId, corpusId, graphVersion: expiredGraphVersion,
    }, scope), null);

    const concurrent = await Promise.allSettled([
      commandStore.compareAndSetActive(scope, null, 5),
      commandStore.compareAndSetActive(scope, null, 5),
    ]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);

    const leasedDeleteVersion = 'graph-pg-leased-delete-v1';
    await commandStore.stageSnapshot({
      ...createSnapshot({ tenantId, corpusId, graphVersion: leasedDeleteVersion }),
      artifactDigest: 'sha256:' + '9'.repeat(64),
    });
    const leasedActive = await commandStore.compareAndSetActive(
      scope,
      leasedDeleteVersion,
      6
    );
    assert.equal(leasedActive.revision, 7);
    assert.equal(
      await commandStore.deleteSnapshot(
        { tenantId, corpusId, graphVersion: leasedDeleteVersion },
        scope
      ),
      false
    );
    assert.equal(
      await commandStore.deleteSnapshotWithPostgresLease(
        { tenantId, corpusId, graphVersion: leasedDeleteVersion },
        scope
      ),
      true
    );
    const pointerAfterLeasedDelete = await commandStore.getActive(scope);
    assert.equal(pointerAfterLeasedDelete.graphVersion, null);
    assert.equal(pointerAfterLeasedDelete.revision, 8);

    assert.equal(await commandStore.deleteSnapshot({ tenantId, corpusId, graphVersion }, scope), true);
    assert.equal(await commandStore.deleteSnapshot({
      tenantId, corpusId, graphVersion: rollbackGraphVersion,
    }, scope), true);
    assert.equal(await commandStore.getSnapshot({ tenantId, corpusId, graphVersion }, scope), null);
  } finally {
    await client.executeWrite('clean integration test tenant', async transaction => {
      await transaction.run(
        'MATCH (node) WHERE node.tenantId = $tenantId DETACH DELETE node',
        { tenantId }
      );
    });
    await client.close();
  }
});

test('projects runtime publication outbox events before graph retrieval', {
  skip: publicationEnabled ? false : 'RAG_NEO4J_INTEGRATION and TEST_DATABASE_URL are required',
}, async () => {
  const pg = (await import('pg')).default;
  const { createNeo4jClient } = await import('../neo4j/driver.ts');
  const { initializeNeo4jSchema } = await import('../neo4j/schema.ts');
  const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
  const { createMiroFishGraphArtifact } = await import('../mirofish/graph-artifact-store.ts');
  const { dispatchKnowledgeGraphOutbox } = await import('./graph-outbox-dispatcher.ts');
  const { projectKnowledgeGraphPublicationEvent } = await import('./graph-publication-projector.ts');
  const { createMiroFishGraphVersion } = await import('./mirofish-adapter.ts');
  const { Neo4jKnowledgeGraphCommandStore } = await import('./neo4j-command-store.ts');
  const { Neo4jMiroFishGraphArtifactStore } = await import('./neo4j-mirofish-store.ts');
  const { Neo4jGraphRetrievalPort } = await import('./neo4j-retrieval-port.ts');
  const { PostgresKnowledgeGraphPublicationStore } = await import('./postgres-publication-store.ts');

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenantId = `codex-kg-publish-${suffix}`;
  const corpusId = `corpus-${suffix}`;
  const identity = {
    tenantId,
    corpusId,
    documentId: `doc-${suffix}`,
    documentVersion: `sha256:${'f'.repeat(64)}`,
    trustLevel: 'reviewed',
  };
  const graphVersion = createMiroFishGraphVersion(identity);
  const postgres = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL.trim(),
    ssl: false,
  });
  const neo4j = createNeo4jClient({
    uri: process.env.RAG_NEO4J_URI || 'neo4j://127.0.0.1:7687',
    username: process.env.RAG_NEO4J_USERNAME || 'neo4j',
    password: process.env.RAG_NEO4J_PASSWORD || 'neo4j-local-dev-only',
    database: process.env.RAG_NEO4J_DATABASE || 'neo4j',
    connectionTimeoutMs: 5_000,
    queryTimeoutMs: 10_000,
    writeTimeoutMs: 120_000,
    maxTransactionRetryTimeMs: 1_000,
    maxConnectionPoolSize: 5,
  });
  const scope = createRetrievalScope({
    tenantId,
    corpusId,
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  });
  const managementScope = createRetrievalScope({
    tenantId,
    corpusId,
    allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
    enforceIsolation: true,
  });
  const commandStore = new Neo4jKnowledgeGraphCommandStore(neo4j);
  const publicationStore = new PostgresKnowledgeGraphPublicationStore(postgres);
  const runtimeStore = new Neo4jMiroFishGraphArtifactStore(commandStore, { publicationStore });
  const retrievalPort = new Neo4jGraphRetrievalPort(neo4j);
  let postgresConnected = false;

  try {
    await postgres.connect();
    postgresConnected = true;
    await postgres.query(
      'insert into public.tenants (id, name) values ($1, $2)',
      [tenantId, 'Knowledge graph publication integration']
    );
    await postgres.query(
      "insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, $3, 'integration')",
      [corpusId, tenantId, 'Knowledge graph publication corpus']
    );
    await neo4j.verifyConnectivity();
    await initializeNeo4jSchema(neo4j);

    await runtimeStore.put(createMiroFishGraphArtifact({
      identity,
      graph: {
        graph_id: identity.documentId,
        artifact_version: 'mirofish-graph-v2',
        nodes: [{
          uuid: 'entity-publication',
          name: 'Publication Entity',
          labels: ['Entity'],
          summary: 'Entity used to prove publication visibility.',
          attributes: { sourceChunks: ['passage-publication'] },
        }],
        edges: [],
        passages: [{
          id: 'passage-publication',
          document_id: identity.documentId,
          content: 'Publication Entity is visible after outbox projection.',
          index: 0,
          start_offset: 0,
          end_offset: 54,
        }],
        communities: [],
        node_count: 1,
        edge_count: 0,
      },
    }));
    const activated = await runtimeStore.compareAndSetActive(scope, identity, 0);
    assert.equal(activated.revision, 1);
    assert.equal((await commandStore.getActive(scope)).revision, 0);

    const beforeProjection = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion, ...identity },
      query: 'Publication Entity',
      laneId: 'graph-publication-before',
      topK: 5,
      maxHops: 1,
      seedPassageIds: ['passage-publication'],
    });
    assert.equal(beforeProjection.stopReason, 'no_gain');

    const dispatch = await dispatchKnowledgeGraphOutbox({
      store: publicationStore,
      publish: event => projectKnowledgeGraphPublicationEvent(commandStore, event).then(() => undefined),
      limit: 10,
    });
    assert.deepEqual(dispatch, {
      claimed: 1, published: 1, retried: 0, deadLettered: 0, lostLease: 0,
    });
    const projectedPointer = await commandStore.getActive(scope);
    assert.equal(projectedPointer.tenantId, tenantId);
    assert.equal(projectedPointer.corpusId, corpusId);
    assert.equal(projectedPointer.graphVersion, graphVersion);
    assert.equal(projectedPointer.revision, 1);

    const afterProjection = await retrievalPort.retrieve({
      scope,
      snapshot: { graphVersion, ...identity },
      query: 'Publication Entity',
      laneId: 'graph-publication-after',
      topK: 5,
      maxHops: 1,
      seedPassageIds: ['passage-publication'],
    });
    assert.equal(afterProjection.stopReason, 'sufficient');
    assert.ok(afterProjection.evidence.some(item => item.id.includes('passage-publication')));

    await runtimeStore.compareAndSetActive(scope, null, 1);
    const deactivation = await dispatchKnowledgeGraphOutbox({
      store: publicationStore,
      publish: event => projectKnowledgeGraphPublicationEvent(commandStore, event).then(() => undefined),
      limit: 10,
    });
    assert.equal(deactivation.published, 1);
    assert.equal((await commandStore.getActive(scope)).graphVersion, null);
  } finally {
    const pointer = await commandStore.getActive(managementScope).catch(() => null);
    if (pointer && pointer.graphVersion !== null) {
      await commandStore.compareAndSetActive(managementScope, null, pointer.revision).catch(() => {});
    }
    await commandStore.deleteSnapshot({ tenantId, corpusId, graphVersion }, managementScope).catch(() => {});
    if (postgresConnected) {
      await postgres.query('delete from public.tenants where id = $1', [tenantId]).catch(() => {});
      await postgres.end().catch(() => {});
    }
    await neo4j.close().catch(() => {});
  }
});

function createIsolationSnapshot({ tenantId, corpusId, graphVersion }) {
  const snapshot = createSnapshot({ tenantId, corpusId, graphVersion });
  return {
    ...snapshot,
    artifactDigest: 'sha256:' + 'c'.repeat(64),
    documents: [
      ...snapshot.documents,
      { documentId: 'doc-external', documentVersion: 'doc-v1', trustLevel: 'external' },
    ],
    passages: [
      ...snapshot.passages,
      {
        id: 'passage-hidden', documentId: 'doc-it', documentVersion: 'doc-v1',
        trustLevel: 'reviewed', content: 'Hidden topology must not be retrieved.', index: 1,
        startOffset: 28, endOffset: 66, source: 'integration-test.md',
      },
      {
        id: 'passage-external', documentId: 'doc-external', documentVersion: 'doc-v1',
        trustLevel: 'external', content: 'External topology must not be traversed.', index: 0,
        startOffset: 0, endOffset: 40, source: 'external.md',
      },
    ],
    entities: [
      ...snapshot.entities,
      {
        id: 'entity-hidden', name: 'Hidden', normalizedName: 'hidden', labels: ['Secret'],
        summary: 'Invalid relationship target', aliases: [],
        passageIds: ['passage-hidden'], attributes: {},
      },
      {
        id: 'entity-external', name: 'External', normalizedName: 'external', labels: ['Secret'],
        summary: 'Disallowed trust relationship target', aliases: [],
        passageIds: ['passage-external'], attributes: {},
      },
    ],
    claims: [
      ...snapshot.claims,
      {
        id: 'claim-invalid', predicate: 'invalid-link', fact: 'Acme has an invalid hidden link',
        factType: 'relationship', sourceEntityId: 'entity-acme',
        targetEntityId: 'entity-hidden', sourceEntityName: 'Acme', targetEntityName: 'Hidden',
        episodes: [], passageIds: ['passage-hidden'], confidence: 0.8,
        status: 'invalid', attributes: {}, invalidAt: '2026-09-07T00:00:00.000Z',
      },
      {
        id: 'claim-external', predicate: 'external-link', fact: 'Acme has an external link',
        factType: 'relationship', sourceEntityId: 'entity-acme',
        targetEntityId: 'entity-external', sourceEntityName: 'Acme', targetEntityName: 'External',
        episodes: [], passageIds: ['passage-external'], confidence: 0.8,
        status: 'active', attributes: {},
      },
      {
        id: 'claim-mixed', predicate: 'mixed-link', fact: 'Acme has a mixed-source link',
        factType: 'relationship', sourceEntityId: 'entity-acme',
        targetEntityId: 'entity-external', sourceEntityName: 'Acme', targetEntityName: 'External',
        episodes: [], passageIds: ['passage-founded', 'passage-external'], confidence: 0.8,
        status: 'active', attributes: {},
      },
    ],
  };
}

function createMixedEntitySourceSnapshot({ tenantId, corpusId, graphVersion }) {
  return {
    tenantId,
    corpusId,
    graphVersion,
    graphId: 'graph-mixed-entity-source-it',
    graphName: 'Mixed entity source isolation fixture',
    status: 'staging',
    artifactDigest: 'sha256:' + 'e'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z',
    documents: [
      { documentId: 'doc-reviewed', documentVersion: 'doc-v1', trustLevel: 'reviewed' },
      { documentId: 'doc-external', documentVersion: 'doc-v1', trustLevel: 'external' },
    ],
    passages: [
      {
        id: 'passage-reviewed-link', documentId: 'doc-reviewed', documentVersion: 'doc-v1',
        trustLevel: 'reviewed', content: 'Source links to MixedTarget.', index: 0,
        startOffset: 0, endOffset: 28, source: 'reviewed.md',
      },
      {
        id: 'passage-external-target', documentId: 'doc-external', documentVersion: 'doc-v1',
        trustLevel: 'external', content: 'MixedTarget has an external annotation.', index: 0,
        startOffset: 0, endOffset: 39, source: 'external.md',
      },
    ],
    entities: [
      {
        id: 'entity-source', name: 'Source', normalizedName: 'source', labels: ['Node'],
        summary: 'Reviewed source', aliases: [], passageIds: ['passage-reviewed-link'],
        attributes: {},
      },
      {
        id: 'entity-mixed-target', name: 'MixedTarget', normalizedName: 'mixedtarget',
        labels: ['Node'], summary: 'Target with reviewed and external sources', aliases: [],
        passageIds: ['passage-reviewed-link', 'passage-external-target'], attributes: {},
      },
    ],
    claims: [{
      id: 'claim-reviewed-only', predicate: 'links', fact: 'Source links to MixedTarget',
      factType: 'relationship', sourceEntityId: 'entity-source',
      targetEntityId: 'entity-mixed-target', sourceEntityName: 'Source',
      targetEntityName: 'MixedTarget', episodes: [], passageIds: ['passage-reviewed-link'],
      confidence: 0.9, status: 'active', attributes: {},
    }],
    communities: [],
  };
}

function createSnapshot({ tenantId, corpusId, graphVersion }) {
  return {
    tenantId,
    corpusId,
    graphVersion,
    graphId: 'graph-it',
    graphName: 'Neo4j integration test',
    status: 'staging',
    artifactDigest: 'sha256:' + 'a'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z',
    documents: [{ documentId: 'doc-it', documentVersion: 'doc-v1', trustLevel: 'reviewed' }],
    passages: [{
      id: 'passage-founded', documentId: 'doc-it', documentVersion: 'doc-v1',
      trustLevel: 'reviewed', content: 'Alice founded Acme in 2024.', index: 0,
      startOffset: 0, endOffset: 27, source: 'integration-test.md',
      sectionPath: ['Founders'], metadata: { fixture: true },
    }],
    entities: [
      {
        id: 'entity-alice', name: 'Alice', normalizedName: 'alice',
        labels: ['Person'], summary: 'Founder of Acme', aliases: [],
        passageIds: ['passage-founded'], attributes: {},
      },
      {
        id: 'entity-acme', name: 'Acme', normalizedName: 'acme',
        labels: ['Organization'], summary: 'Company founded by Alice', aliases: ['ACME'],
        passageIds: ['passage-founded'], attributes: {},
      },
    ],
    claims: [{
      id: 'claim-founded', predicate: 'founded', fact: 'Alice founded Acme',
      factType: 'relationship', sourceEntityId: 'entity-alice',
      targetEntityId: 'entity-acme', sourceEntityName: 'Alice',
      targetEntityName: 'Acme', episodes: [], passageIds: ['passage-founded'],
      confidence: 0.98, status: 'active', attributes: {},
    }],
    communities: [{
      id: 'community-founders', name: 'Founder network',
      entityIds: ['entity-alice', 'entity-acme'], claimIds: ['claim-founded'],
      summary: 'Founder and company relationships', keywords: ['founder', 'company'], level: 0,
    }],
  };
}
