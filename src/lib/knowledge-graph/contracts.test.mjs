import assert from 'node:assert/strict';
import test from 'node:test';

const {
  assertGraphRetrievalEvidence,
  createDeterministicKnowledgeGraphId,
  createKnowledgeGraphSnapshotIdentity,
  normalizeGraphRetrievalRequest,
} = await import('./contracts.ts');

const scope = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  enforceIsolation: true,
};

test('snapshot identity normalizes safe values and rejects unsafe scope drift', () => {
  assert.deepEqual(
    createKnowledgeGraphSnapshotIdentity({
      tenantId: ' tenant-a ',
      corpusId: 'corpus-a',
      graphVersion: 'sha256:abc123',
    }),
    {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      graphVersion: 'sha256:abc123',
    }
  );

  assert.throws(
    () => createKnowledgeGraphSnapshotIdentity({
      tenantId: 'tenant-a',
      corpusId: 'corpus-a MATCH (n)',
      graphVersion: 'v1',
    }),
    /corpusId/
  );
});

test('retrieval request enforces bounded hops, topK, and stable seed ids', () => {
  const request = normalizeGraphRetrievalRequest({
    scope,
    snapshot: {
      graphVersion: 'v1',
      documentId: 'doc-1',
      documentVersion: 'doc-v1',
      trustLevel: 'reviewed',
    },
    query: ' A 与 B 有什么关系？ ',
    laneId: 'graph',
    topK: 8,
    maxHops: 2,
    seedPassageIds: [' passage-2 ', 'passage-1', 'passage-2'],
  });

  assert.equal(request.query, 'A 与 B 有什么关系？');
  assert.deepEqual(request.seedPassageIds, ['passage-1', 'passage-2']);
  assert.throws(
    () => normalizeGraphRetrievalRequest({ ...request, maxHops: 3 }),
    /maxHops/
  );
  assert.throws(
    () => normalizeGraphRetrievalRequest({ ...request, topK: 0 }),
    /topK/
  );
});

test('graph evidence must remain passage-backed and inside retrieval scope', () => {
  const evidence = {
    id: 'graph:v1:passage-1',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-1',
    documentVersion: 'doc-v1',
    content: 'A 与 B 存在合作关系。',
    trustLevel: 'reviewed',
    laneId: 'graph',
    retrievalScore: 0.8,
    metadata: {
      graphVersion: 'v1',
      graphPassageId: 'passage-1',
      graphEntityIds: ['entity-a', 'entity-b'],
    },
  };

  assert.doesNotThrow(() => assertGraphRetrievalEvidence(evidence, scope));
  assert.throws(
    () => assertGraphRetrievalEvidence({ ...evidence, tenantId: 'tenant-b' }, scope),
    /tenantId/
  );
  assert.throws(
    () => assertGraphRetrievalEvidence({ ...evidence, metadata: {} }, scope),
    /graphPassageId/
  );
});

test('knowledge graph ids are deterministic and namespace separated', () => {
  const first = createDeterministicKnowledgeGraphId('claim', [
    'tenant-a', 'corpus-a', 'entity-a', 'works-with', 'entity-b',
  ]);
  const repeated = createDeterministicKnowledgeGraphId('claim', [
    'tenant-a', 'corpus-a', 'entity-a', 'works-with', 'entity-b',
  ]);
  const entity = createDeterministicKnowledgeGraphId('entity', [
    'tenant-a', 'corpus-a', 'entity-a', 'works-with', 'entity-b',
  ]);

  assert.equal(first, repeated);
  assert.notEqual(first, entity);
  assert.match(first, /^claim:[a-f0-9]{64}$/);
});
