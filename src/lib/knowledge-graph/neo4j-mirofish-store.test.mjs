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

const { createMiroFishGraphArtifact } = await import('../mirofish/graph-artifact-store.ts');
const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
const { Neo4jMiroFishGraphArtifactStore } = await import('./neo4j-mirofish-store.ts');
const { createMiroFishGraphVersion } = await import('./mirofish-adapter.ts');

const identity = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  documentId: 'doc-a',
  documentVersion: 'sha256:graph-v1',
  trustLevel: 'reviewed',
};

function scope(overrides = {}) {
  return createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
    ...overrides,
  });
}

function artifact() {
  return createMiroFishGraphArtifact({
    identity,
    graph: {
      graph_id: 'doc-a',
      artifact_version: 'mirofish-graph-v2',
      nodes: [{
        uuid: 'entity-a',
        name: '实体 A',
        labels: ['Entity'],
        summary: '实体摘要',
        attributes: { sourceChunks: ['passage-a'] },
      }],
      edges: [],
      passages: [{
        id: 'passage-a',
        document_id: 'doc-a',
        content: '实体 A 的原文证据。',
        index: 0,
        start_offset: 0,
        end_offset: 11,
      }],
      communities: [],
      node_count: 1,
      edge_count: 0,
    },
  });
}

class FakeKnowledgeGraphCommandStore {
  coordination = 'shared';
  snapshots = new Map();
  getSnapshotCalls = 0;
  listCompatibilityDescriptorCalls = 0;
  pointer = {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    graphVersion: null,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  };

  async stageSnapshot(snapshot) {
    const existing = this.snapshots.get(snapshot.graphVersion);
    if (existing && existing.artifactDigest !== snapshot.artifactDigest) {
      const error = new Error('digest conflict');
      error.code = 'KNOWLEDGE_GRAPH_CONFLICT';
      throw error;
    }
    this.snapshots.set(snapshot.graphVersion, structuredClone(snapshot));
    return descriptor(snapshot);
  }

  async getSnapshot(snapshotIdentity) {
    this.getSnapshotCalls += 1;
    return structuredClone(this.snapshots.get(snapshotIdentity.graphVersion) ?? null);
  }

  async listSnapshots(_scope, options = {}) {
    return [...this.snapshots.values()].slice(0, options.limit ?? 100).map(descriptor);
  }

  async getCompatibilityDescriptor(snapshotIdentity) {
    const snapshot = this.snapshots.get(snapshotIdentity.graphVersion);
    if (!snapshot || snapshot.documents.length !== 1) return null;
    return { ...descriptor(snapshot), document: structuredClone(snapshot.documents[0]) };
  }

  async listCompatibilityDescriptors(_scope, options = {}) {
    this.listCompatibilityDescriptorCalls += 1;
    return [...this.snapshots.values()].slice(0, options.limit ?? 100).flatMap(snapshot =>
      snapshot.documents.length === 1
        ? [{ ...descriptor(snapshot), document: structuredClone(snapshot.documents[0]) }]
        : []
    );
  }

  async deleteSnapshot(snapshotIdentity) {
    return this.snapshots.delete(snapshotIdentity.graphVersion);
  }

  async deleteSnapshotWithPostgresLease(snapshotIdentity) {
    this.authoritativeDeleteCalls = (this.authoritativeDeleteCalls ?? 0) + 1;
    return this.snapshots.delete(snapshotIdentity.graphVersion);
  }

  async snapshotExists(snapshotIdentity) {
    return this.snapshots.has(snapshotIdentity.graphVersion);
  }

  async getActive() {
    return structuredClone(this.pointer);
  }

  async compareAndSetActive(activeScope, graphVersion, expectedRevision) {
    if (expectedRevision !== this.pointer.revision) {
      const error = new Error('revision conflict');
      error.code = 'KNOWLEDGE_GRAPH_CONFLICT';
      throw error;
    }
    this.pointer = {
      tenantId: activeScope.tenantId,
      corpusId: activeScope.corpusId,
      graphVersion,
      revision: expectedRevision + 1,
      updatedAt: '2026-09-07T01:00:00.000Z',
    };
    return structuredClone(this.pointer);
  }

  async gcExpired() {
    return 0;
  }
}

class CoordinatedPublicationStore extends FakeKnowledgeGraphCommandStore {
  lease = null;
  tombstones = new Set();

  async registerStagedSnapshot(_activeScope, graphVersion) {
    if (this.tombstones.has(graphVersion)) {
      const error = new Error('snapshot deleted');
      error.code = 'KNOWLEDGE_GRAPH_CONFLICT';
      throw error;
    }
  }

  async acquireSnapshotLease(activeScope, graphVersion, operation) {
    if (this.lease || (operation === 'delete' && this.pointer.graphVersion === graphVersion)) {
      const error = new Error('snapshot locked or active');
      error.code = 'KNOWLEDGE_GRAPH_CONFLICT';
      throw error;
    }
    this.lease = {
      tenantId: activeScope.tenantId,
      corpusId: activeScope.corpusId,
      graphVersion,
      operation,
      operationId: '5bc631c8-4c86-4b87-af1f-055321563402',
      leaseExpiresAt: '2026-09-07T01:01:00.000Z',
    };
    return structuredClone(this.lease);
  }

  async compareAndSetActiveWithLease(activeScope, graphVersion, expectedRevision, lease) {
    assert.equal(lease.operationId, this.lease?.operationId);
    return super.compareAndSetActive(activeScope, graphVersion, expectedRevision);
  }

  async resolveSnapshotLease(_activeScope, lease, resolution) {
    if (lease.operationId !== this.lease?.operationId) return false;
    this.lease = null;
    this.lastResolution = resolution;
    if (resolution === 'deleted') this.tombstones.add(lease.graphVersion);
    return true;
  }
}

function descriptor(snapshot) {
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

test('stores and reads a MiroFish graph through the shared snapshot contract', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  let schemaReadyCalls = 0;
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, {
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    ensureReady: async () => { schemaReadyCalls += 1; },
  });

  const saved = await store.put(artifact(), { graphName: '知识图谱 A', ttlMs: 60_000 });
  const loaded = await store.get(identity, scope());

  assert.equal(store.coordination, 'shared');
  assert.equal(saved.graphName, '知识图谱 A');
  assert.equal(saved.expiresAt, '2026-09-07T00:01:00.000Z');
  assert.deepEqual(loaded, artifact());
  assert.equal(schemaReadyCalls, 2);
});

test('lists only artifacts whose trust level is allowed by the retrieval scope', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore);
  await store.put(artifact());

  assert.equal((await store.list(scope())).length, 1);
  assert.deepEqual(
    await store.list(scope({ allowedTrustLevels: ['trusted'] })),
    []
  );
  assert.equal(commandStore.getSnapshotCalls, 0);
  assert.equal(commandStore.listCompatibilityDescriptorCalls, 2);
});

test('maps active snapshot compare-and-set to the original artifact identity', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore);
  await store.put(artifact());

  const active = await store.compareAndSetActive(scope(), identity, 0);
  assert.deepEqual(active.identity, identity);
  assert.equal(active.revision, 1);
  assert.deepEqual((await store.getActive(scope())).identity, identity);
  assert.equal(
    (await store.getActive(scope({ allowedTrustLevels: ['trusted'] }))).identity,
    null
  );

  await assert.rejects(
    store.compareAndSetActive(scope(), identity, 0),
    error => error.code === 'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT'
  );
});

test('treats an expired active descriptor as unavailable without loading graph payload', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  let now = new Date('2026-09-07T00:00:00.000Z');
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, { now: () => now });
  await store.put(artifact(), { ttlMs: 1_000 });
  await store.compareAndSetActive(scope(), identity, 0);
  commandStore.getSnapshotCalls = 0;
  now = new Date('2026-09-07T00:00:02.000Z');

  const active = await store.getActive(scope());

  assert.equal(active.identity, null);
  assert.equal(active.revision, 1);
  assert.equal(commandStore.getSnapshotCalls, 0);
});

test('fails closed for scope and trust mismatches', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore);
  await store.put(artifact());

  await assert.rejects(
    store.get(identity, scope({ tenantId: 'tenant-b' })),
    /tenant scope mismatch/
  );
  await assert.rejects(
    store.get({ ...identity, trustLevel: 'quarantined' }, scope()),
    /quarantined/
  );
  await assert.rejects(
    store.compareAndSetActive(
      scope({ allowedTrustLevels: ['trusted'] }),
      identity,
      0
    ),
    /outside the activation scope/
  );
  await assert.rejects(
    store.delete(identity, scope({ allowedTrustLevels: ['trusted'] })),
    /outside the deletion scope/
  );
});

test('holds a lifecycle lease across validation and active pointer CAS', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  const publicationStore = new CoordinatedPublicationStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, { publicationStore });
  await store.put(artifact());

  const active = await store.compareAndSetActive(scope(), identity, 0);
  assert.equal(active.revision, 1);
  assert.equal(publicationStore.pointer.graphVersion, createMiroFishGraphVersion(identity));
  assert.equal(publicationStore.lastResolution, 'release');
  assert.equal(publicationStore.lease, null);
  assert.equal(commandStore.getSnapshotCalls, 0);
});

test('delete cannot race an active pointer and successful delete leaves a tombstone', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  const publicationStore = new CoordinatedPublicationStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, { publicationStore });
  await store.put(artifact());
  await store.compareAndSetActive(scope(), identity, 0);

  await assert.rejects(
    store.delete(identity, scope()),
    error => error.code === 'MIROFISH_GRAPH_ARTIFACT_ACTIVE'
  );
  assert.notEqual(await store.get(identity, scope()), null);

  await store.compareAndSetActive(scope(), null, 1);
  commandStore.getSnapshotCalls = 0;
  assert.equal(await store.delete(identity, scope()), true);
  assert.equal(publicationStore.lastResolution, 'deleted');
  assert.equal(commandStore.getSnapshotCalls, 0);
  assert.equal(commandStore.snapshots.size, 0);
  assert.equal(commandStore.authoritativeDeleteCalls, 1);
  await assert.rejects(
    store.put(artifact()),
    error => error.code === 'MIROFISH_GRAPH_ARTIFACT_CONFLICT'
  );
});

test('does not tombstone when Neo4j reports false and the snapshot still exists', async () => {
  class StalePointerCommandStore extends FakeKnowledgeGraphCommandStore {
    async deleteSnapshotWithPostgresLease() {
      this.authoritativeDeleteCalls = (this.authoritativeDeleteCalls ?? 0) + 1;
      return false;
    }
  }
  const commandStore = new StalePointerCommandStore();
  const publicationStore = new CoordinatedPublicationStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, { publicationStore });
  await store.put(artifact());

  await assert.rejects(
    store.delete(identity, scope()),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
  assert.equal(publicationStore.tombstones.size, 0);
  assert.equal(publicationStore.lastResolution, 'release');
  assert.equal(publicationStore.lease?.operation, 'delete');
  assert.notEqual(await commandStore.getCompatibilityDescriptor({
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    graphVersion: createMiroFishGraphVersion(identity),
  }), null);
});

test('garbage collects expired compatibility descriptors without loading graph payloads', async () => {
  const commandStore = new FakeKnowledgeGraphCommandStore();
  const publicationStore = new CoordinatedPublicationStore();
  let now = new Date('2026-09-07T00:00:00.000Z');
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, {
    publicationStore,
    now: () => now,
  });
  await store.put(artifact(), { ttlMs: 1_000 });
  now = new Date('2026-09-07T00:00:02.000Z');

  assert.equal(await store.gcExpired(scope()), 1);
  assert.equal(commandStore.getSnapshotCalls, 0);
  assert.equal(commandStore.snapshots.size, 0);
});

test('coordinated deletion can inspect expired snapshots and verifies physical removal', async () => {
  class AvailabilityAwareCommandStore extends FakeKnowledgeGraphCommandStore {
    async getCompatibilityDescriptor(snapshotIdentity, retrievalScope, options = {}) {
      if (options.availability !== 'all') return null;
      return super.getCompatibilityDescriptor(snapshotIdentity, retrievalScope);
    }

    async snapshotExists(snapshotIdentity) {
      return this.snapshots.has(snapshotIdentity.graphVersion);
    }
  }

  const commandStore = new AvailabilityAwareCommandStore();
  const publicationStore = new CoordinatedPublicationStore();
  const store = new Neo4jMiroFishGraphArtifactStore(commandStore, {
    publicationStore,
    now: () => new Date('2026-09-07T00:00:02.000Z'),
  });
  const expired = artifact();
  expired.expiresAt = '2026-09-07T00:00:01.000Z';
  await commandStore.stageSnapshot((await import('./mirofish-adapter.ts'))
    .mapMiroFishArtifactToKnowledgeGraphSnapshot(expired));
  await publicationStore.registerStagedSnapshot(scope(), createMiroFishGraphVersion(identity));

  assert.equal(await store.delete(identity, scope()), true);
  assert.equal(commandStore.snapshots.size, 0);
  assert.equal(publicationStore.tombstones.has(createMiroFishGraphVersion(identity)), true);
});
