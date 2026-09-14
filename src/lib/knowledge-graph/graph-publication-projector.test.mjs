import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { projectKnowledgeGraphPublicationEvent } = await import('./graph-publication-projector.ts');

function publicationEvent(overrides = {}) {
  return {
    id: '5bc631c8-4c86-4b87-af1f-055321563402',
    tenantId: 'tenant-a', corpusId: 'corpus-a',
    eventType: 'graph.snapshot.activated', graphVersion: 'graph-v1', revision: 1,
    payload: { expectedRevision: 0 }, createdAt: '2026-09-07T00:00:00Z',
    attempt: 1, leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-07T00:01:00Z',
    ...overrides,
  };
}

test('treats an exactly matching Neo4j publication revision as an idempotent retry', async () => {
  let writes = 0;
  const pointer = {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    revision: 1, updatedAt: '2026-09-07T00:00:01Z',
  };
  const result = await projectKnowledgeGraphPublicationEvent({
    async getActive() { return pointer; },
    async getCompatibilityDescriptor() { throw new Error('unexpected descriptor read'); },
    async compareAndSetActive() { writes += 1; throw new Error('unexpected write'); },
  }, publicationEvent());
  assert.equal(result, pointer);
  assert.equal(writes, 0);
});

test('projects deactivation with the exact previous revision', async () => {
  const calls = [];
  const result = await projectKnowledgeGraphPublicationEvent({
    async getActive() {
      return {
        tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
        revision: 1, updatedAt: '2026-09-07T00:00:01Z',
      };
    },
    async getCompatibilityDescriptor() { throw new Error('unexpected descriptor read'); },
    async compareAndSetActive(scope, graphVersion, expectedRevision) {
      calls.push({ graphVersion, expectedRevision, trust: scope.allowedTrustLevels });
      return {
        tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: null,
        revision: 2, updatedAt: '2026-09-07T00:00:02Z',
      };
    },
  }, publicationEvent({
    eventType: 'graph.snapshot.deactivated', graphVersion: null, revision: 2,
    payload: { expectedRevision: 1 },
  }));
  assert.equal(result.graphVersion, null);
  assert.deepEqual(calls, [{
    graphVersion: null,
    expectedRevision: 1,
    trust: ['trusted', 'reviewed', 'external', 'quarantined'],
  }]);
});

test('fails closed when Neo4j has a divergent or skipped publication revision', async () => {
  const store = {
    async getActive() {
      return {
        tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-other',
        revision: 1, updatedAt: '2026-09-07T00:00:01Z',
      };
    },
    async getCompatibilityDescriptor() { return { document: { trustLevel: 'reviewed' } }; },
    async compareAndSetActive() { throw new Error('unexpected write'); },
  };
  await assert.rejects(
    projectKnowledgeGraphPublicationEvent(store, publicationEvent()),
    error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
  await assert.rejects(
    projectKnowledgeGraphPublicationEvent(store, publicationEvent({ revision: 3 })),
    error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});

test('does not activate a quarantined Neo4j snapshot', async () => {
  await assert.rejects(
    projectKnowledgeGraphPublicationEvent({
      async getActive() {
        return {
          tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: null,
          revision: 0, updatedAt: '1970-01-01T00:00:00Z',
        };
      },
      async getCompatibilityDescriptor() { return { document: { trustLevel: 'quarantined' } }; },
      async compareAndSetActive() { throw new Error('unexpected write'); },
    }, publicationEvent()),
    error => error?.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});
