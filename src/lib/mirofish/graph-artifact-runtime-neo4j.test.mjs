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
  createNeo4jMiroFishGraphArtifactRuntime,
  getMiroFishGraphArtifactRuntime,
} = await import('./graph-artifact-runtime.ts');

function fakeClient() {
  return {
    async verifyConnectivity() {},
    async executeRead() { throw new Error('not used'); },
    async executeWrite() { throw new Error('not used'); },
    async close() {},
  };
}

test('keeps the file backend as the default for existing deployments', () => {
  const runtime = getMiroFishGraphArtifactRuntime({});

  assert.equal(runtime.backend, 'file');
  assert.equal(runtime.store.coordination, 'process');
  assert.equal(runtime.retrievalPort, undefined);
});

test('constructs a shared Neo4j store and graph retrieval port', () => {
  const runtime = createNeo4jMiroFishGraphArtifactRuntime(fakeClient(), {
    RAG_MIROFISH_GRAPH_INGEST_TRUST_LEVEL: 'reviewed',
  });

  assert.equal(runtime.backend, 'neo4j');
  assert.equal(runtime.store.coordination, 'shared');
  assert.equal(runtime.retrievalPort.retriever, 'neo4j-knowledge-graph-v1');
  assert.equal(typeof runtime.queryPort.searchEntities, 'function');
  assert.equal(runtime.trustLevel, 'reviewed');
});

test('rejects an unsupported graph backend instead of silently falling back', () => {
  assert.throws(
    () => getMiroFishGraphArtifactRuntime({ RAG_GRAPH_BACKEND: 'unknown' }),
    /must be file or neo4j/
  );
});

test('requires complete Neo4j credentials when the backend is selected', () => {
  assert.throws(
    () => getMiroFishGraphArtifactRuntime({ RAG_GRAPH_BACKEND: 'neo4j' }),
    error => error.code === 'KNOWLEDGE_GRAPH_UNAVAILABLE'
  );
});
