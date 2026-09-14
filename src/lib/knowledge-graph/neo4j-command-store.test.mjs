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
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { Neo4jKnowledgeGraphCommandStore } = await import('./neo4j-command-store.ts');

const scope = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  enforceIsolation: true,
};

function snapshot(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    graphVersion: 'graph-v1',
    graphId: 'doc-1',
    status: 'staging',
    artifactDigest: 'sha256:' + 'a'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z',
    documents: [{
      documentId: 'doc-1', documentVersion: 'doc-v1', trustLevel: 'reviewed',
    }],
    passages: [{
      id: 'passage-1', documentId: 'doc-1', documentVersion: 'doc-v1',
      trustLevel: 'reviewed', content: 'Alice founded Acme.', index: 0,
      startOffset: 0, endOffset: 19,
    }],
    entities: [{
      id: 'entity-1', name: 'Alice") MATCH (n) DETACH DELETE n //',
      normalizedName: 'alice', labels: ['Person'], summary: 'Founder', aliases: [],
      passageIds: ['passage-1'], attributes: {},
    }],
    claims: [],
    communities: [],
    ...overrides,
  };
}

function record(values) {
  return { get(key) { return values[key]; } };
}

function createClient(runImpl = async (cypher, parameters) => ({
  records: cypher.includes('MERGE (snapshot:GraphSnapshot')
    ? [record({ snapshot: {
        tenantId: parameters.tenantId,
        corpusId: parameters.corpusId,
        graphVersion: parameters.graphVersion,
        graphId: parameters.graphId,
        graphName: parameters.graphName,
        status: parameters.status,
        artifactDigest: parameters.artifactDigest,
        createdAt: parameters.createdAt,
        expiresAt: parameters.expiresAt,
        documentCount: parameters.documentCount,
        passageCount: parameters.passageCount,
        entityCount: parameters.entityCount,
        claimCount: parameters.claimCount,
        communityCount: parameters.communityCount,
      } })]
    : [],
})) {
  const calls = [];
  const transaction = {
    async run(cypher, parameters) {
      calls.push({ cypher, parameters });
      return runImpl(cypher, parameters, calls);
    },
  };
  return {
    calls,
    client: {
      async executeWrite(_operation, work) { return work(transaction); },
      async executeRead(_operation, work) { return work(transaction); },
    },
  };
}

test('stages a complete snapshot with fixed Cypher and parameterized model content', async () => {
  const fake = createClient();
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client);

  const descriptor = await store.stageSnapshot(snapshot());

  assert.equal(descriptor.entityCount, 1);
  assert.ok(fake.calls.length >= 5);
  assert.ok(fake.calls.every(call => !call.cypher.includes('DETACH DELETE n //')));
  assert.ok(fake.calls.some(call =>
    JSON.stringify(call.parameters).includes('DETACH DELETE n //')
  ));
  assert.ok(fake.calls.every(call => call.parameters.tenantId === 'tenant-a'));
  assert.ok(fake.calls.every(call => call.parameters.corpusId === 'corpus-a'));
  assert.ok(fake.calls.every(call => call.parameters.graphVersion === 'graph-v1'));
});

test('persists community entity, claim, and parent membership relationships', async () => {
  const fake = createClient();
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client);
  await store.stageSnapshot(snapshot({
    claims: [{
      id: 'claim-1', predicate: 'founded', fact: 'Alice founded Acme',
      factType: 'relationship', sourceEntityId: 'entity-1',
      targetEntityId: 'entity-1', sourceEntityName: 'Alice',
      targetEntityName: 'Alice', episodes: [], passageIds: ['passage-1'],
      confidence: 0.9, status: 'active', attributes: {},
    }],
    communities: [
      { id: 'community-root', name: 'Root', entityIds: [], claimIds: [], summary: '', keywords: [], level: 0 },
      { id: 'community-1', name: 'Founders', entityIds: ['entity-1'], claimIds: ['claim-1'], summary: 'Founder facts', keywords: ['founder'], level: 1, parentId: 'community-root' },
    ],
  }));

  const cypher = fake.calls.map(call => call.cypher).join('\n');
  assert.match(cypher, /\[:IN_COMMUNITY\]/);
  assert.match(cypher, /\[:HAS_CLAIM\]/);
  assert.match(cypher, /\[:PARENT_OF\]/);
});

test('repeated staging is idempotent but rejects a digest conflict', async () => {
  const same = createClient(async (cypher) => ({
    records: cypher.includes('RETURN properties(snapshot) AS snapshot')
      ? [record({ snapshot: {
          tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
          graphId: 'doc-1', status: 'staging', artifactDigest: 'sha256:' + 'a'.repeat(64),
          createdAt: '2026-09-07T00:00:00.000Z', documentCount: 1,
          passageCount: 1, entityCount: 1, claimCount: 0, communityCount: 0,
        } })]
      : [],
  }));
  const sameStore = new Neo4jKnowledgeGraphCommandStore(same.client);
  const descriptor = await sameStore.stageSnapshot(snapshot());
  assert.equal(descriptor.artifactDigest, 'sha256:' + 'a'.repeat(64));
  assert.equal(same.calls.length, 1);

  const conflict = createClient(async (cypher) => ({
    records: cypher.includes('RETURN properties(snapshot) AS snapshot')
      ? [record({ snapshot: {
          tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
          graphId: 'doc-1', status: 'staging', artifactDigest: 'sha256:' + 'b'.repeat(64),
          createdAt: '2026-09-07T00:00:00.000Z', documentCount: 1,
          passageCount: 1, entityCount: 1, claimCount: 0, communityCount: 0,
        } })]
      : [],
  }));
  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(conflict.client).stageSnapshot(snapshot()),
    error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});

test('rejects ambiguous document trust and passage trust mismatches before writing', async () => {
  const duplicateTrust = createClient();
  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(duplicateTrust.client).stageSnapshot(snapshot({
      documents: [
        { documentId: 'doc-1', documentVersion: 'doc-v1', trustLevel: 'reviewed' },
        { documentId: 'doc-1', documentVersion: 'doc-v1', trustLevel: 'trusted' },
      ],
    })),
    /conflicting trust levels/
  );
  assert.equal(duplicateTrust.calls.length, 0);

  const passageTrust = createClient();
  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(passageTrust.client).stageSnapshot(snapshot({
      passages: [{
        id: 'passage-1', documentId: 'doc-1', documentVersion: 'doc-v1',
        trustLevel: 'trusted', content: 'Alice founded Acme.', index: 0,
        startOffset: 0, endOffset: 19,
      }],
    })),
    /trust level does not match its document version/
  );
  assert.equal(passageTrust.calls.length, 0);
});

test('revalidates the persisted digest returned by MERGE before writing graph rows', async () => {
  const conflict = createClient(async (cypher, parameters) => ({
    records: cypher.includes('MERGE (snapshot:GraphSnapshot')
      ? [record({ snapshot: {
          tenantId: parameters.tenantId,
          corpusId: parameters.corpusId,
          graphVersion: parameters.graphVersion,
          graphId: parameters.graphId,
          status: parameters.status,
          artifactDigest: 'sha256:' + 'b'.repeat(64),
          createdAt: parameters.createdAt,
          documentCount: parameters.documentCount,
          passageCount: parameters.passageCount,
          entityCount: parameters.entityCount,
          claimCount: parameters.claimCount,
          communityCount: parameters.communityCount,
        } })]
      : [],
  }));

  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(conflict.client).stageSnapshot(snapshot()),
    error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
  assert.equal(conflict.calls.length, 2);
});

test('active snapshot compare-and-set exposes revision conflicts', async () => {
  const success = createClient(async (cypher) => ({
    records: cypher.includes('RETURN pointer.activeGraphVersion AS graphVersion')
      ? [record({ graphVersion: 'graph-v1', revision: 2, updatedAt: '2026-09-07T01:00:00.000Z' })]
      : [],
  }));
  const pointer = await new Neo4jKnowledgeGraphCommandStore(success.client, {
    now: () => new Date('2026-09-07T00:00:00.000Z'),
  }).compareAndSetActive(scope, 'graph-v1', 1);
  assert.deepEqual(pointer, {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    revision: 2, updatedAt: '2026-09-07T01:00:00.000Z',
  });
  assert.match(success.calls[0].cypher, /SET pointer\.casLock/);
  assert.match(success.calls[0].cypher, /REMOVE pointer\.casLock/);
  assert.deepEqual(success.calls[0].parameters.allowedTrustLevels, ['external', 'reviewed', 'trusted']);
  assert.equal(success.calls[0].parameters.now, '2026-09-07T00:00:00.000Z');
  assert.match(success.calls[0].cypher, /document\.trustLevel IN \$allowedTrustLevels/);
  assert.match(success.calls[0].cypher, /target\.expiresAt > \$now/);
  assert.match(success.calls[0].cypher, /target\.status IN \['staging', 'active', 'superseded'\]/);

  const conflict = createClient();
  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(conflict.client)
      .compareAndSetActive(scope, 'graph-v1', 7),
    error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});

test('descriptor reads and lists enforce trust, non-expiry, and usable status in Cypher', async () => {
  const fake = createClient(async () => ({ records: [] }));
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client, {
    now: () => new Date('2026-09-07T01:00:00.000Z'),
  });

  await store.listSnapshots(scope, { limit: 5 });
  await store.getSnapshot(
    { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
    scope
  );
  await store.getCompatibilityDescriptor(
    { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
    scope
  );

  for (const call of fake.calls) {
    assert.deepEqual(call.parameters.allowedTrustLevels, ['external', 'reviewed', 'trusted']);
    assert.equal(call.parameters.now, '2026-09-07T01:00:00.000Z');
    assert.match(call.cypher, /trustLevel IN \$allowedTrustLevels/);
    assert.match(call.cypher, /snapshot\.expiresAt > \$now/);
    assert.match(call.cypher, /snapshot\.status IN \['staging', 'active', 'superseded'\]/);
  }
});

test('internal deletion inspection can include expired snapshots and checks physical existence', async () => {
  const fake = createClient(async cypher => ({
    records: cypher.includes('count(snapshot) > 0 AS exists')
      ? [record({ exists: true })]
      : [],
  }));
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client, {
    now: () => new Date('2026-09-07T01:00:00.000Z'),
  });

  await store.getCompatibilityDescriptor(
    { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
    scope,
    { availability: 'all' }
  );
  assert.equal(await store.snapshotExists(
    { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
    scope
  ), true);

  assert.equal(fake.calls[0].parameters.availability, 'all');
  assert.match(fake.calls[0].cypher, /\$availability = 'all'/);
  assert.match(fake.calls[1].cypher, /count\(snapshot\) > 0 AS exists/);
});

test('allows deletion when an existing pointer is explicitly deactivated', async () => {
  const fake = createClient(async cypher => ({
    records: cypher.includes('RETURN count(*) AS deleted')
      ? [record({ deleted: 6 })]
      : [],
  }));
  const deleted = await new Neo4jKnowledgeGraphCommandStore(fake.client)
    .deleteSnapshot({ tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' }, scope);

  assert.equal(deleted, true);
  assert.match(fake.calls[0].cypher, /pointer\.activeGraphVersion IS NULL/);
});

test('authoritative deletion clears an obsolete Neo4j pointer before deleting the leased snapshot', async () => {
  const fake = createClient(async cypher => ({
    records: cypher.includes('RETURN count(*) AS deleted')
      ? [record({ deleted: 6 })]
      : [],
  }));
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client);

  const deleted = await store.deleteSnapshotWithPostgresLease(
    { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
    scope
  );

  assert.equal(deleted, true);
  assert.match(fake.calls[0].cypher, /pointer\.activeGraphVersion = \$graphVersion/);
  assert.match(fake.calls[0].cypher, /SET pointer\.activeGraphVersion = NULL/);
  assert.ok(fake.calls[0].cypher.indexOf('SET pointer.activeGraphVersion = NULL')
    < fake.calls[0].cypher.indexOf('DETACH DELETE node'));
});

test('fails closed before returning graph payload when snapshot trust is outside the scope', async () => {
  const snapshotProperties = {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    graphId: 'doc-1', status: 'active', artifactDigest: 'sha256:' + 'a'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z', documentCount: 1,
    passageCount: 1, entityCount: 1, claimCount: 0, communityCount: 0,
  };
  const fake = createClient(async cypher => ({
    records: cypher.includes('RETURN properties(snapshot) AS snapshot')
      ? [record({ snapshot: snapshotProperties })]
      : cypher.includes('node:DocumentVersion')
        ? [record({ data: {
            documentId: 'doc-1', documentVersion: 'doc-v1', trustLevel: 'quarantined',
          } })]
        : [],
  }));

  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(fake.client).getSnapshot(
      { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
      scope
    ),
    error => error?.code === 'KNOWLEDGE_GRAPH_SCOPE_VIOLATION'
  );

  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls.some(call => call.cypher.includes('node:Passage')), false);
  assert.equal(fake.calls.some(call => call.cypher.includes('node:Entity')), false);
});

test('fails closed before returning graph topology when passage trust is outside the scope', async () => {
  const snapshotProperties = {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    graphId: 'doc-1', status: 'active', artifactDigest: 'sha256:' + 'a'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z', documentCount: 1,
    passageCount: 1, entityCount: 1, claimCount: 0, communityCount: 0,
  };
  const fake = createClient(async cypher => ({
    records: cypher.includes('RETURN properties(snapshot) AS snapshot')
      ? [record({ snapshot: snapshotProperties })]
      : cypher.includes('node:DocumentVersion')
        ? [record({ data: {
            documentId: 'doc-1', documentVersion: 'doc-v1', trustLevel: 'reviewed',
          } })]
        : cypher.includes('node:Passage')
          ? [record({ data: {
              passageId: 'passage-1', documentId: 'doc-1', documentVersion: 'doc-v1',
              trustLevel: 'quarantined', content: 'hidden', chunkIndex: 0,
              startOffset: 0, endOffset: 6,
            } })]
          : [],
  }));

  await assert.rejects(
    new Neo4jKnowledgeGraphCommandStore(fake.client).getSnapshot(
      { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
      scope
    ),
    error => error?.code === 'KNOWLEDGE_GRAPH_SCOPE_VIOLATION'
  );

  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls.some(call => call.cypher.includes('node:Entity')), false);
  assert.equal(fake.calls.some(call => call.cypher.includes('node:Claim')), false);
});

test('reads compatibility descriptors without loading graph payloads or issuing N+1 queries', async () => {
  const snapshotProperties = {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    graphId: 'doc-1', status: 'staging', artifactDigest: 'sha256:' + 'a'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z', documentCount: 1,
    passageCount: 1, entityCount: 1, claimCount: 0, communityCount: 0,
  };
  const document = {
    documentId: 'doc-1', documentVersion: 'doc-v1', trustLevel: 'reviewed',
  };
  const fake = createClient(async cypher => ({
    records: cypher.includes('documents[0] AS document')
      ? [record({ snapshot: snapshotProperties, document })]
      : [],
  }));
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client, {
    now: () => new Date('2026-09-07T01:00:00.000Z'),
  });

  const one = await store.getCompatibilityDescriptor(
    { tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1' },
    scope
  );
  const listed = await store.listCompatibilityDescriptors(scope, { limit: 20 });

  assert.deepEqual(one?.document, document);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].document, document);
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every(call => call.cypher.includes('size(documents) = 1')));
  assert.ok(fake.calls.every(call => !call.cypher.includes(':Passage')));
  assert.ok(fake.calls.every(call => !call.cypher.includes(':Entity')));
  assert.ok(fake.calls.every(call => !call.cypher.includes(':Claim')));
  assert.ok(fake.calls.every(call => !call.cypher.includes(':Community')));
  const listCall = fake.calls[1];
  assert.deepEqual(listCall.parameters.allowedTrustLevels, ['external', 'reviewed', 'trusted']);
  assert.equal(listCall.parameters.availability, 'available');
  assert.equal(listCall.parameters.now, '2026-09-07T01:00:00.000Z');
  assert.match(listCall.cypher, /document\.trustLevel IN \$allowedTrustLevels/);
  assert.match(listCall.cypher, /snapshot\.expiresAt > \$now/);
  assert.ok(listCall.cypher.indexOf('snapshot.expiresAt > $now') < listCall.cypher.indexOf('LIMIT toInteger($limit)'));
});

test('lists expired compatibility descriptors oldest-first before applying the limit', async () => {
  const fake = createClient(async () => ({ records: [] }));
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client, {
    now: () => new Date('2026-09-07T01:00:00.000Z'),
  });

  await store.listCompatibilityDescriptors(scope, { limit: 7, availability: 'expired' });

  assert.equal(fake.calls[0].parameters.availability, 'expired');
  assert.equal(fake.calls[0].parameters.limit, 7);
  assert.match(fake.calls[0].cypher, /snapshot\.expiresAt <= \$now/);
  assert.match(fake.calls[0].cypher, /CASE WHEN \$availability = 'expired' THEN snapshot\.expiresAt END ASC/);
  assert.ok(fake.calls[0].cypher.indexOf('snapshot.expiresAt <= $now') < fake.calls[0].cypher.indexOf('LIMIT toInteger($limit)'));
});

test('garbage collection selects expired non-active snapshots in the database without recent-list starvation', async () => {
  const expired = {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-old',
    graphId: 'doc-old', status: 'superseded', artifactDigest: 'sha256:' + 'c'.repeat(64),
    createdAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-02T00:00:00.000Z',
    documentCount: 1, passageCount: 1, entityCount: 0, claimCount: 0, communityCount: 0,
  };
  const fake = createClient(async cypher => ({
    records: cypher.includes('snapshot.expiresAt <= $now')
      ? [record({ snapshot: expired })]
      : cypher.includes('RETURN count(*) AS deleted')
        ? [record({ deleted: 2 })]
        : [],
  }));
  const store = new Neo4jKnowledgeGraphCommandStore(fake.client, {
    now: () => new Date('2026-09-07T01:00:00.000Z'),
  });

  assert.equal(await store.gcExpired(scope, { limit: 3 }), 1);

  assert.match(fake.calls[0].cypher, /snapshot\.expiresAt <= \$now/);
  assert.match(fake.calls[0].cypher, /snapshot\.status <> 'active'/);
  assert.match(fake.calls[0].cypher, /ORDER BY snapshot\.expiresAt ASC/);
  assert.equal(fake.calls[0].parameters.limit, 3);
  assert.equal(fake.calls.some(call => /ORDER BY snapshot\.createdAt DESC/.test(call.cypher)), false);
});
