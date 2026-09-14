import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const { createLocalGraphBuildHandler } = await import('./local-graph-build-executor.ts');
const { createMiroFishGraphVersion } = await import('./mirofish-adapter.ts');

test('local graph build reconstructs exact scoped Milvus chunks and stages the job identity', async () => {
  const identity = documentIdentity();
  const graphVersion = createMiroFishGraphVersion(identity);
  const observed = { reads: [], extractions: [], writes: [] };
  const handler = createLocalGraphBuildHandler({
    milvus: {
      async queryDocumentRows(scope, requestedIdentity, expectedChunks) {
        observed.reads.push({ scope, requestedIdentity, expectedChunks });
        return [
          milvusRow(identity, 0, 2, 'Alpha Beta', 0, 10, 'Alpha Beta Gamma'),
          milvusRow(identity, 1, 2, 'Beta Gamma', 6, 16, 'Alpha Beta Gamma'),
        ];
      },
    },
    commandStore: { async getCompatibilityDescriptor() { return null; } },
    artifactStore: {
      async put(artifact, options) {
        observed.writes.push({ artifact, options });
        return {
          identity: { ...identity }, artifactDigest: `sha256:${'a'.repeat(64)}`,
          createdAt: '2026-09-08T00:00:00.000Z', nodeCount: 0, edgeCount: 0,
        };
      },
    },
    async extractGraph(text, documentId) {
      observed.extractions.push({ text, documentId });
      return graphData(documentId, text);
    },
  });

  const result = await handler(buildJob(identity, graphVersion));

  assert.deepEqual(result, {
    status: 'staged', progress: 1, artifactDigest: `sha256:${'a'.repeat(64)}`,
  });
  assert.deepEqual(observed.extractions, [{ text: 'Alpha Beta Gamma', documentId: identity.documentId }]);
  assert.equal(observed.reads[0].expectedChunks, 2);
  assert.deepEqual(observed.reads[0].scope.allowedTrustLevels, ['reviewed']);
  assert.deepEqual(observed.reads[0].requestedIdentity, identity);
  assert.deepEqual(
    {
      schemaVersion: observed.writes[0].artifact.schemaVersion,
      tenantId: observed.writes[0].artifact.tenantId,
      corpusId: observed.writes[0].artifact.corpusId,
      documentId: observed.writes[0].artifact.documentId,
      documentVersion: observed.writes[0].artifact.documentVersion,
      trustLevel: observed.writes[0].artifact.trustLevel,
    },
    { schemaVersion: 'mirofish-graph-artifact-v2', ...identity }
  );
  assert.deepEqual(observed.writes[0].artifact.graph.passages[0], {
    ...graphData(identity.documentId, 'Alpha Beta Gamma').passages[0],
    tenant_id: identity.tenantId,
    corpus_id: identity.corpusId,
    document_version: identity.documentVersion,
    trust_level: identity.trustLevel,
  });
  assert.deepEqual(observed.writes[0].options, { graphName: 'example.md' });
});

test('local graph build reuses an existing staged snapshot without another model call', async () => {
  const identity = documentIdentity();
  const graphVersion = createMiroFishGraphVersion(identity);
  let externalCalls = 0;
  const handler = createLocalGraphBuildHandler({
    milvus: { async queryDocumentRows() { externalCalls += 1; return []; } },
    commandStore: {
      async getCompatibilityDescriptor() {
        return {
          tenantId: identity.tenantId, corpusId: identity.corpusId, graphVersion,
          graphId: identity.documentId, status: 'staging',
          artifactDigest: `sha256:${'b'.repeat(64)}`, createdAt: '2026-09-08T00:00:00.000Z',
          documentCount: 1, passageCount: 1, entityCount: 1, claimCount: 0,
          communityCount: 0, document: {
            documentId: identity.documentId, documentVersion: identity.documentVersion,
            trustLevel: identity.trustLevel,
          },
        };
      },
    },
    artifactStore: { async put() { externalCalls += 1; throw new Error('unexpected write'); } },
    async extractGraph() { externalCalls += 1; throw new Error('unexpected extraction'); },
  });

  assert.deepEqual(await handler(buildJob(identity, graphVersion)), {
    status: 'staged', progress: 1, artifactDigest: `sha256:${'b'.repeat(64)}`,
  });
  assert.equal(externalCalls, 0);
});

test('local graph build fails closed on incomplete or misaligned Milvus inventories', async () => {
  const identity = documentIdentity();
  const graphVersion = createMiroFishGraphVersion(identity);
  let extractionCalls = 0;
  const handler = createLocalGraphBuildHandler({
    milvus: {
      async queryDocumentRows() {
        return [milvusRow(identity, 0, 2, 'Alpha', 0, 5, 'Alpha')];
      },
    },
    commandStore: { async getCompatibilityDescriptor() { return null; } },
    artifactStore: { async put() { throw new Error('unexpected write'); } },
    async extractGraph() { extractionCalls += 1; return graphData(identity.documentId, 'Alpha'); },
  });

  await assert.rejects(
    () => handler(buildJob(identity, graphVersion)),
    /expected 2 chunks, received 1/
  );
  assert.equal(extractionCalls, 0);
});

test('local graph build rejects unverified source prefix, internal gaps, tail, and digest', async () => {
  const identity = documentIdentity();
  const graphVersion = createMiroFishGraphVersion(identity);
  const cases = [
    {
      name: 'prefix',
      rows: [
        milvusRow(identity, 0, 2, 'Alpha', 1, 6, ' AlphaBeta'),
        milvusRow(identity, 1, 2, 'Beta', 6, 10, ' AlphaBeta'),
      ],
      expected: /must start at offset 0/,
    },
    {
      name: 'internal gap',
      rows: [
        milvusRow(identity, 0, 2, 'Alpha', 0, 5, 'Alpha  Gamma'),
        milvusRow(identity, 1, 2, 'Gamma', 7, 12, 'Alpha  Gamma'),
      ],
      expected: /contains an unverified gap/,
    },
    {
      name: 'tail',
      rows: [
        milvusRow(identity, 0, 2, 'Alpha', 0, 5, 'AlphaBeta!'),
        milvusRow(identity, 1, 2, 'Beta', 5, 9, 'AlphaBeta!'),
      ],
      expected: /does not cover the source tail/,
    },
    {
      name: 'digest',
      rows: [
        milvusRow(identity, 0, 2, 'Alpha', 0, 5, 'AlphaBeta', `sha256:${'0'.repeat(64)}`),
        milvusRow(identity, 1, 2, 'Beta', 5, 9, 'AlphaBeta', `sha256:${'0'.repeat(64)}`),
      ],
      expected: /source text digest does not match/,
    },
  ];

  for (const scenario of cases) {
    let extractionCalls = 0;
    const handler = createLocalGraphBuildHandler({
      milvus: { async queryDocumentRows() { return scenario.rows; } },
      commandStore: { async getCompatibilityDescriptor() { return null; } },
      artifactStore: { async put() { throw new Error('unexpected write'); } },
      async extractGraph() {
        extractionCalls += 1;
        return graphData(identity.documentId, 'unexpected');
      },
    });

    await assert.rejects(
      () => handler(buildJob(identity, graphVersion)),
      scenario.expected,
      scenario.name
    );
    assert.equal(extractionCalls, 0, scenario.name);
  }
});

function documentIdentity() {
  return {
    tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'document-a',
    documentVersion: `sha256:${'d'.repeat(64)}`, trustLevel: 'reviewed',
  };
}

function buildJob(identity, graphVersion) {
  return {
    id: '5bc631c8-4c86-4b87-af1f-055321563402',
    tenantId: identity.tenantId, corpusId: identity.corpusId, graphVersion,
    status: 'running', progress: 0, artifactDigest: null, errorCode: null,
    errorMessage: null, attempts: 1,
    metadata: { documentIdentity: identity, chunkCount: 2, sourceName: 'example.md' },
    leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-08T00:10:00.000Z',
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  };
}

function milvusRow(
  identity,
  chunkIndex,
  totalChunks,
  content,
  startOffset,
  endOffset,
  sourceText,
  sourceTextHash = `sha256:${createHash('sha256').update(sourceText).digest('hex')}`
) {
  return {
    id: `chunk-${chunkIndex}`, content, source: 'example.md',
    tenant_id: identity.tenantId, corpus_id: identity.corpusId,
    document_id: identity.documentId, document_version: identity.documentVersion,
    trust_level: identity.trustLevel, chunk_index: chunkIndex, total_chunks: totalChunks,
    metadata_json: JSON.stringify({
      startOffset,
      endOffset,
      sourceTextLength: sourceText.length,
      sourceTextHash,
    }),
  };
}

function graphData(documentId, content) {
  return {
    graph_id: documentId, artifact_version: 'mirofish-graph-v2',
    nodes: [], edges: [], communities: [], node_count: 0, edge_count: 0,
    passages: [{
      id: `${documentId}_chunk_0`, document_id: documentId, content,
      index: 0, start_offset: 0, end_offset: content.length,
    }],
  };
}
