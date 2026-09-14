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

const { createMiroFishGraphArtifact } = await import(
  '../mirofish/graph-artifact-store.ts'
);

const {
  createMiroFishGraphVersion,
  mapKnowledgeGraphSnapshotToMiroFishArtifact,
  mapMiroFishArtifactToKnowledgeGraphSnapshot,
} = await import('./mirofish-adapter.ts');

function artifactFixture() {
  return createMiroFishGraphArtifact({
    identity: {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      documentId: 'doc-1',
      documentVersion: 'doc-v1',
      trustLevel: 'reviewed',
    },
    graph: {
      graph_id: 'doc-1',
      artifact_version: 'mirofish-graph-v2',
      node_count: 2,
      edge_count: 1,
      nodes: [
        {
          uuid: 'entity-a',
          name: '实体 A',
          labels: ['Organization'],
          summary: 'A 的摘要',
          attributes: { aliases: ['A'], sourceChunks: ['passage-1'] },
        },
        {
          uuid: 'entity-b',
          name: '实体 B',
          labels: ['Organization'],
          summary: 'B 的摘要',
          attributes: { sourceChunks: ['passage-2'] },
        },
      ],
      edges: [
        {
          uuid: 'claim-1',
          name: '合作',
          fact: '实体 A 与实体 B 合作',
          fact_type: 'COOPERATES_WITH',
          source_node_uuid: 'entity-a',
          target_node_uuid: 'entity-b',
          source_node_name: '实体 A',
          target_node_name: '实体 B',
          attributes: { weight: 0.8, sourceChunks: ['passage-1'] },
          episodes: ['passage-2'],
        },
      ],
      passages: [
        {
          id: 'passage-1', document_id: 'doc-1', content: '实体 A 与实体 B 合作。',
          index: 0, start_offset: 0, end_offset: 14, source: 'doc.pdf', page: 1,
        },
        {
          id: 'passage-2', document_id: 'doc-1', content: '该合作开始于 2026 年。',
          index: 1, start_offset: 15, end_offset: 30, source: 'doc.pdf', page: 1,
        },
      ],
      communities: [
        {
          id: 'community-1', name: '合作方', entities: ['entity-a', 'entity-b'],
          relations: ['claim-1'], summary: '合作社区', keywords: ['合作'], level: 0,
        },
      ],
    },
  });
}

test('maps a MiroFish artifact into a source-traceable graph snapshot', () => {
  const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifactFixture(), {
    createdAt: '2026-09-07T00:00:00.000Z',
  });

  assert.equal(snapshot.graphVersion, createMiroFishGraphVersion(artifactFixture()));
  assert.match(snapshot.graphVersion, /^mirofish:[a-f0-9]{64}$/);
  assert.equal(snapshot.status, 'staging');
  assert.deepEqual(snapshot.entities[0].passageIds, ['passage-1']);
  assert.deepEqual(snapshot.claims[0].passageIds, ['passage-1', 'passage-2']);
  assert.equal(snapshot.claims[0].confidence, 0.8);
  assert.equal(snapshot.passages[0].trustLevel, 'reviewed');
  assert.match(snapshot.artifactDigest, /^sha256:[a-f0-9]{64}$/);
});

test('derives graphVersion from the complete artifact identity deterministically', () => {
  const artifact = artifactFixture();
  const sameIdentity = structuredClone(artifact);
  const differentTrust = { ...artifact, trustLevel: 'trusted' };
  const differentDocument = { ...artifact, documentId: 'doc-2' };

  assert.equal(createMiroFishGraphVersion(artifact), createMiroFishGraphVersion(sameIdentity));
  assert.notEqual(createMiroFishGraphVersion(artifact), createMiroFishGraphVersion(differentTrust));
  assert.notEqual(createMiroFishGraphVersion(artifact), createMiroFishGraphVersion(differentDocument));
});

test('round trips the compatibility artifact without losing topology or passages', () => {
  const artifact = artifactFixture();
  const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact, {
    createdAt: '2026-09-07T00:00:00.000Z',
  });
  const roundTripped = mapKnowledgeGraphSnapshotToMiroFishArtifact(snapshot, {
    tenantId: artifact.tenantId,
    corpusId: artifact.corpusId,
    documentId: artifact.documentId,
    documentVersion: artifact.documentVersion,
    trustLevel: artifact.trustLevel,
  });

  assert.deepEqual(roundTripped.graph.nodes, artifact.graph.nodes);
  assert.deepEqual(roundTripped.graph.edges, artifact.graph.edges);
  assert.deepEqual(roundTripped.graph.passages, artifact.graph.passages);
  assert.deepEqual(roundTripped.graph.communities, artifact.graph.communities);
});

test('fails closed instead of projecting a compatibility artifact from a mixed-document snapshot', () => {
  const artifact = artifactFixture();
  const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact, {
    createdAt: '2026-09-07T00:00:00.000Z',
  });
  snapshot.documents.push({
    documentId: 'doc-hidden', documentVersion: 'doc-v1', trustLevel: 'quarantined',
  });
  snapshot.passages.push({
    id: 'passage-hidden', documentId: 'doc-hidden', documentVersion: 'doc-v1',
    trustLevel: 'quarantined', content: 'hidden evidence', index: 0,
    startOffset: 0, endOffset: 15,
  });

  assert.throws(
    () => mapKnowledgeGraphSnapshotToMiroFishArtifact(snapshot, artifact),
    /exactly the requested document version/i
  );
});
