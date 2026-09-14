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

const {
  InMemoryMiroFishGraphArtifactStore,
  createMiroFishGraphArtifact,
} = await import('../mirofish/graph-artifact-store.ts');
const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
const { importMiroFishGraphArtifacts } = await import('./artifact-importer.ts');
const { createMiroFishGraphVersion } = await import('./mirofish-adapter.ts');

const identity = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  documentId: 'doc-a',
  documentVersion: 'graph-v1',
  trustLevel: 'reviewed',
};
const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  enforceIsolation: true,
});

function artifact() {
  return createMiroFishGraphArtifact({
    identity,
    graph: {
      graph_id: 'doc-a',
      artifact_version: 'mirofish-graph-v2',
      nodes: [],
      edges: [],
      passages: [{
        id: 'passage-a',
        document_id: 'doc-a',
        content: 'source evidence',
        index: 0,
        start_offset: 0,
        end_offset: 15,
      }],
      communities: [],
      node_count: 0,
      edge_count: 0,
    },
  });
}

class TargetStore {
  coordination = 'shared';
  snapshots = new Map();
  writes = 0;
  async getSnapshot(key) { return this.snapshots.get(key.graphVersion) ?? null; }
  async stageSnapshot(snapshot) {
    this.writes += 1;
    this.snapshots.set(snapshot.graphVersion, structuredClone(snapshot));
    return {};
  }
}

test('imports each historical artifact once and skips an identical replay', async () => {
  const source = new InMemoryMiroFishGraphArtifactStore({
    now: () => Date.parse('2026-09-07T00:00:00.000Z'),
  });
  await source.put(artifact(), { graphName: '历史图谱' });
  const target = new TargetStore();

  const first = await importMiroFishGraphArtifacts({ source, target, scope });
  const replay = await importMiroFishGraphArtifacts({ source, target, scope });

  assert.deepEqual(first, { discovered: 1, imported: 1, skipped: 0, dryRun: false });
  assert.deepEqual(replay, { discovered: 1, imported: 0, skipped: 1, dryRun: false });
  assert.equal(target.writes, 1);
  const graphVersion = createMiroFishGraphVersion(identity);
  assert.equal(target.snapshots.get(graphVersion).graphName, '历史图谱');
});

test('dry-run validates and reports without writing Neo4j', async () => {
  const source = new InMemoryMiroFishGraphArtifactStore();
  await source.put(artifact());
  const target = new TargetStore();

  const summary = await importMiroFishGraphArtifacts({
    source,
    target,
    scope,
    dryRun: true,
  });

  assert.deepEqual(summary, { discovered: 1, imported: 1, skipped: 0, dryRun: true });
  assert.equal(target.writes, 0);
});

test('fails closed before writing when the source reaches its non-pageable list limit', async () => {
  const descriptor = {
    identity,
    graphName: '历史图谱',
    createdAt: '2026-09-07T00:00:00.000Z',
  };
  const source = {
    coordination: 'process',
    async list() { return Array.from({ length: 1_000 }, () => descriptor); },
    async get() { throw new Error('get must not run after a truncated list'); },
  };
  const target = new TargetStore();

  await assert.rejects(
    importMiroFishGraphArtifacts({ source, target, scope }),
    /reached the non-pageable list limit/i
  );
  assert.equal(target.writes, 0);
});
