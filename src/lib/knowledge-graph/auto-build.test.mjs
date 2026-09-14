import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  KnowledgeGraphAutoBuildEnqueueError,
  enqueueKnowledgeGraphBuildAfterVectorization,
} = await import('./auto-build.ts');

const INPUT = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  actorId: 'actor-a',
  documentId: 'document-a',
  documentVersion: `sha256:${'a'.repeat(64)}`,
  trustLevel: 'external',
  postgresAssetId: 'asset-a',
  chunkCount: 3,
  sourceName: '知识库.txt',
};

test('Milvus completion enqueues one server-owned document build for Neo4j', async () => {
  const calls = [];
  const result = await enqueueKnowledgeGraphBuildAfterVectorization(INPUT, {
    env: {
      RAG_GRAPH_BACKEND: 'neo4j',
      RAG_GRAPH_AUTO_BUILD: 'true',
      RAG_KG_BUILD_MAX_PENDING_PER_SCOPE: '7',
    },
    store: {
      async enqueueDocumentBuild(scope, identity, metadata, options) {
        calls.push({ scope, identity, metadata, options });
        return {
          id: '11111111-1111-4111-8111-111111111111',
          graphVersion: 'kgv1:auto-build-test',
          status: 'queued',
        };
      },
    },
  });

  assert.deepEqual(result, {
    enabled: true,
    job: {
      id: '11111111-1111-4111-8111-111111111111',
      graphVersion: 'kgv1:auto-build-test',
      status: 'queued',
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope.tenantId, 'tenant-a');
  assert.equal(calls[0].scope.corpusId, 'corpus-a');
  assert.deepEqual(calls[0].identity, {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'document-a',
    documentVersion: `sha256:${'a'.repeat(64)}`,
    trustLevel: 'external',
  });
  assert.deepEqual(calls[0].metadata, {
    trigger: 'milvus-vectorization',
    postgresAssetId: 'asset-a',
    actorId: 'actor-a',
    chunkCount: 3,
    sourceName: '知识库.txt',
  });
  assert.deepEqual(calls[0].options, { maxPendingJobs: 7 });
});

test('non-Neo4j graph backends do not allocate a BuildJob', async () => {
  const result = await enqueueKnowledgeGraphBuildAfterVectorization(INPUT, {
    env: { RAG_GRAPH_BACKEND: 'file' },
    store: {
      async enqueueDocumentBuild() {
        throw new Error('must not enqueue');
      },
    },
  });

  assert.deepEqual(result, {
    enabled: false,
    reason: 'graph_backend_disabled',
  });
});

test('Neo4j auto-build can be explicitly disabled', async () => {
  const result = await enqueueKnowledgeGraphBuildAfterVectorization(INPUT, {
    env: {
      RAG_GRAPH_BACKEND: 'neo4j',
      RAG_GRAPH_AUTO_BUILD: 'false',
    },
    store: {
      async enqueueDocumentBuild() {
        throw new Error('must not enqueue');
      },
    },
  });

  assert.deepEqual(result, {
    enabled: false,
    reason: 'auto_build_disabled',
  });
});

test('enqueue failures expose a stable reconciliation identity without leaking the cause', async () => {
  await assert.rejects(
    () => enqueueKnowledgeGraphBuildAfterVectorization(INPUT, {
      env: { RAG_GRAPH_BACKEND: 'neo4j' },
      store: {
        async enqueueDocumentBuild() {
          throw new Error('postgres password must stay private');
        },
      },
    }),
    error => {
      assert.equal(error instanceof KnowledgeGraphAutoBuildEnqueueError, true);
      assert.equal(error.code, 'KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED');
      assert.equal(error.status, 503);
      assert.match(error.message, /reconciliationId=[0-9a-f]{24}/);
      assert.equal(error.message.includes('postgres password'), false);
      return true;
    }
  );
});

test('terminal BuildJobs are never reported as newly submitted work', async () => {
  for (const status of ['failed', 'cancelled']) {
    await assert.rejects(
      () => enqueueKnowledgeGraphBuildAfterVectorization(INPUT, {
        env: { RAG_GRAPH_BACKEND: 'neo4j' },
        store: {
          async enqueueDocumentBuild() {
            return {
              id: '11111111-1111-4111-8111-111111111111',
              graphVersion: 'kgv1:terminal-test',
              status,
            };
          },
        },
      }),
      error => {
        assert.equal(error instanceof KnowledgeGraphAutoBuildEnqueueError, true);
        assert.equal(error.code, 'KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED');
        assert.equal(error.message.includes(status), false);
        return true;
      }
    );
  }
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
