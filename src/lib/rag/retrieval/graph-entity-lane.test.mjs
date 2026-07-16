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
  InMemoryMiroFishGraphArtifactStore,
  createMiroFishGraphArtifact,
} = await import('../../mirofish/graph-artifact-store.ts');
const {
  createGraphEntityLaneHandler,
  rankGraphArtifactPassages,
} = await import('./graph-entity-lane.ts');
const { RagLaneExecutor } = await import('./lane-executor.ts');

const identity = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  documentId: 'document-a',
  documentVersion: 'sha256:v1',
  trustLevel: 'reviewed',
};

test('entity match emits the original passage with graph provenance', async () => {
  const result = await rank('What did Alice do?', { maxHops: 1, topK: 1 });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].content, 'Alice founded Acme.');
  assert.equal(result.evidence[0].laneId, 'graph-lane');
  assert.deepEqual(result.evidence[0].metadata.graphEntityIds, ['entity-alice']);
});

test('one-hop expansion reaches a neighbor passage but not a two-hop passage', async () => {
  const result = await rank('Alice', { maxHops: 1, topK: 10 });
  const passageIds = result.evidence.map(item => item.metadata.graphPassageId);

  assert.ok(passageIds.includes('passage-alice'));
  assert.ok(passageIds.includes('passage-acme'));
  assert.ok(!passageIds.includes('passage-project'));
});

test('two-hop expansion reaches the second neighbor passage', async () => {
  const result = await rank('Alice', { maxHops: 2, topK: 10 });

  assert.ok(result.evidence.some(item => item.metadata.graphPassageId === 'passage-project'));
});

test('community ranking maps summaries back to passages instead of citing the summary', async () => {
  const artifact = createArtifact({ includeCommunity: true });
  const result = await rankGraphArtifactPassages({
    artifact,
    query: 'launch',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 1,
  });

  assert.ok(result.matchedCommunityIds.includes('community-launch'));
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.every(item => item.content !== 'Launch partnership overview.'));
  assert.ok(result.evidence.some(item => item.metadata.graphCommunityIds.includes('community-launch')));
});

test('graph summaries without a source passage produce no citable evidence', async () => {
  const artifact = createArtifact({ includeCommunity: true });
  artifact.graph.passages = [];

  const result = await rankGraphArtifactPassages({
    artifact,
    query: 'launch',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 1,
  });

  assert.equal(result.evidence.length, 0);
  assert.ok(result.matchedCommunityIds.includes('community-launch'));
});

test('ranking is deterministic and respects topK', async () => {
  const first = await rank('Alice', { maxHops: 2, topK: 2 });
  const second = await rank('Alice', { maxHops: 2, topK: 2 });

  assert.equal(first.evidence.length, 2);
  assert.deepEqual(
    first.evidence.map(item => item.id),
    second.evidence.map(item => item.id)
  );
});

test('weighted-star expansion is deterministic and bounded by explicit work budgets', async () => {
  const artifact = createStarArtifact(5_000);
  const input = {
    artifact,
    query: 'Hub Signal',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 2,
    maxSeedNodes: 1,
    maxExpansionStates: 32,
    maxExpansionEdges: 25,
  };

  const first = await rankGraphArtifactPassages(input);
  const second = await rankGraphArtifactPassages(input);

  assert.equal(first.expansionDiagnostics.seedCount, 1);
  assert.equal(first.expansionDiagnostics.inspectedEdgeCount, 25);
  assert.ok(first.expansionDiagnostics.processedStateCount <= 32);
  assert.equal(first.expansionDiagnostics.truncated, true);
  assert.deepEqual(
    first.evidence.map(item => item.id),
    second.evidence.map(item => item.id)
  );
  assert.deepEqual(first.expansionDiagnostics, second.expansionDiagnostics);
});

test('edge, reference, and operation traversal budgets truncate deterministically', async () => {
  const artifact = createStarArtifact(500);
  const edgeBounded = await rankGraphArtifactPassages({
    artifact,
    query: 'Hub Signal',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 2,
    maxTraversalEdges: 37,
  });
  assert.equal(edgeBounded.expansionDiagnostics.indexedEdgeCount, 37);
  assert.equal(edgeBounded.expansionDiagnostics.scoredEdgeCount, 37);
  assert.equal(edgeBounded.expansionDiagnostics.truncated, true);

  const referenceBounded = await rankGraphArtifactPassages({
    artifact,
    query: 'Hub Signal',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 2,
    maxTraversalEdges: 10,
    maxTraversalReferences: 21,
  });
  assert.equal(referenceBounded.expansionDiagnostics.inspectedReferenceCount, 21);
  assert.equal(referenceBounded.expansionDiagnostics.truncated, true);

  const operationBounded = await rankGraphArtifactPassages({
    artifact,
    query: 'Hub Signal',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 2,
    maxTraversalOperations: 50,
  });
  assert.equal(operationBounded.expansionDiagnostics.operationCount, 50);
  assert.equal(operationBounded.expansionDiagnostics.truncated, true);
});

test('pure graph ranking honors an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    rankGraphArtifactPassages({
      artifact: createArtifact(),
      query: 'Alice',
      laneId: 'graph-lane',
      topK: 10,
      maxHops: 2,
      signal: controller.signal,
    }),
    error => error?.name === 'AbortError'
  );
});

test('timer-driven abort preempts an in-progress large graph traversal', async () => {
  const controller = new AbortController();
  const pending = rankGraphArtifactPassages({
    artifact: createStarArtifact(5_000),
    query: 'Hub Signal',
    laneId: 'graph-lane',
    topK: 10,
    maxHops: 2,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 0);

  await assert.rejects(pending, error => error?.name === 'AbortError');
});

test('empty or stop-word-only queries produce no graph gain', async () => {
  assert.equal((await rank('', { maxHops: 1, topK: 10 })).evidence.length, 0);
  assert.equal((await rank('what is the', { maxHops: 1, topK: 10 })).evidence.length, 0);
});

test('handler returns no_gain when the exact graph version is missing', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  await store.put(createArtifact());
  const handler = createGraphEntityLaneHandler({ store });

  const result = await handler.execute(createContext({ documentVersion: 'sha256:v2' }));

  assert.equal(result.stopReason, 'no_gain');
  assert.equal(result.metadata.reason, 'graph_artifact_missing');
  assert.deepEqual(result.evidence, []);
});

test('handler returns no_gain when graph lane identity is not configured', async () => {
  const handler = createGraphEntityLaneHandler({
    store: new InMemoryMiroFishGraphArtifactStore(),
  });
  const context = createContext();
  context.lane.parameters = undefined;

  const result = await handler.execute(context);

  assert.equal(result.stopReason, 'no_gain');
  assert.equal(result.metadata.reason, 'graph_lane_not_configured');
});

test('handler fails closed when retrieval scope is absent', async () => {
  const handler = createGraphEntityLaneHandler({
    store: new InMemoryMiroFishGraphArtifactStore(),
  });
  const context = createContext();
  context.request.retrievalScope = undefined;

  await assert.rejects(handler.execute(context), /explicit retrieval scope/);
});

test('handler fails closed when requested trust is not allowed', async () => {
  const handler = createGraphEntityLaneHandler({
    store: new InMemoryMiroFishGraphArtifactStore(),
  });
  const context = createContext();
  context.request.retrievalScope.allowedTrustLevels = ['trusted'];

  await assert.rejects(handler.execute(context), /outside the retrieval scope/);
});

test('handler revalidates artifacts returned by a custom store', async () => {
  const foreignArtifact = createMiroFishGraphArtifact({
    identity: { ...identity, tenantId: 'tenant-b' },
    graph: createGraph(),
  });
  const handler = createGraphEntityLaneHandler({
    store: {
      async put() {},
      async get() { return foreignArtifact; },
    },
  });

  await assert.rejects(handler.execute(createContext()), /tenantId does not match/);
});

test('handler rejects invalid hop configuration', async () => {
  const handler = createGraphEntityLaneHandler({
    store: new InMemoryMiroFishGraphArtifactStore(),
  });

  await assert.rejects(
    handler.execute(createContext({ maxHops: 3 })),
    /maxHops must be 1 or 2/
  );
});

test('handler honors an already-aborted request', async () => {
  const handler = createGraphEntityLaneHandler({
    store: new InMemoryMiroFishGraphArtifactStore(),
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    handler.execute(createContext({}, controller.signal)),
    error => error?.name === 'AbortError'
  );
});

test('optional missing graph records no_gain without replacing dense evidence', async () => {
  const context = createContext({ documentVersion: 'sha256:missing' });
  const denseEvidence = {
    id: 'dense-1',
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    documentId: identity.documentId,
    documentVersion: identity.documentVersion,
    content: 'Dense fallback evidence.',
    trustLevel: 'reviewed',
    laneId: 'dense-lane',
  };
  const denseLane = {
    id: 'dense-lane',
    type: 'dense-vector',
    required: true,
    description: 'dense fallback',
  };
  context.plan.lanes = [denseLane, context.lane];
  const executor = new RagLaneExecutor([
    {
      type: 'dense-vector',
      retriever: 'test-dense',
      async execute() { return { evidence: [denseEvidence] }; },
    },
    createGraphEntityLaneHandler({ store: new InMemoryMiroFishGraphArtifactStore() }),
  ]);

  const result = await executor.execute({
    request: context.request,
    plan: context.plan,
    budget: { maxLanes: 2, maxEvidence: 10, maxDurationMs: 1000 },
  });

  assert.deepEqual(result.evidence.map(item => item.id), ['dense-1']);
  assert.equal(result.laneExecutions[1].stopReason, 'no_gain');
  assert.equal(result.stopReason, 'sufficient');
});

function rank(query, options) {
  return rankGraphArtifactPassages({
    artifact: createArtifact(),
    query,
    laneId: 'graph-lane',
    ...options,
  });
}

function createArtifact(options = {}) {
  return createMiroFishGraphArtifact({
    identity,
    graph: createGraph(options),
  });
}

function createGraph({ includeCommunity = false } = {}) {
  const node = (uuid, name, passageId) => ({
    uuid,
    name,
    labels: ['Entity'],
    summary: `${name} graph entity`,
    attributes: { aliases: [], sourceChunks: [passageId] },
  });
  const edge = (uuid, source, target, passageId) => ({
    uuid,
    name: 'RELATED_TO',
    fact: `${source} is related to ${target}`,
    fact_type: 'RELATED_TO',
    source_node_uuid: source,
    target_node_uuid: target,
    source_node_name: source,
    target_node_name: target,
    attributes: { weight: 1, sourceChunks: [passageId] },
    episodes: [],
  });
  const passage = (id, index, content) => ({
    id,
    document_id: identity.documentId,
    content,
    index,
    start_offset: index * 100,
    end_offset: index * 100 + content.length,
  });
  return {
    graph_id: identity.documentId,
    nodes: [
      node('entity-alice', 'Alice', 'passage-alice'),
      node('entity-acme', 'Acme', 'passage-acme'),
      node('entity-project', 'Project Orion', 'passage-project'),
    ],
    edges: [
      edge('edge-1', 'entity-alice', 'entity-acme', 'passage-acme'),
      edge('edge-2', 'entity-acme', 'entity-project', 'passage-project'),
    ],
    node_count: 3,
    edge_count: 2,
    artifact_version: 'mirofish-graph-v2',
    passages: [
      passage('passage-alice', 0, 'Alice founded Acme.'),
      passage('passage-acme', 1, 'Acme sponsors Project Orion.'),
      passage('passage-project', 2, 'Project Orion launches tomorrow.'),
    ],
    communities: includeCommunity ? [{
      id: 'community-launch',
      name: 'Launch group',
      entities: ['entity-acme', 'entity-project'],
      relations: ['edge-2'],
      summary: 'Launch partnership overview.',
      keywords: ['launch'],
      level: 0,
    }] : [],
  };
}

function createStarArtifact(neighborCount) {
  const node = (uuid, name, passageId) => ({
    uuid,
    name,
    labels: ['Entity'],
    summary: `${name} graph entity`,
    attributes: { aliases: [], sourceChunks: [passageId] },
  });
  const passage = (id, index, content) => ({
    id,
    document_id: identity.documentId,
    content,
    index,
    start_offset: index * 100,
    end_offset: index * 100 + content.length,
  });
  const hubPassage = passage('passage-hub', 0, 'Hub Signal coordinates the graph.');
  const neighbors = Array.from({ length: neighborCount }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    return {
      node: node(`entity-neighbor-${suffix}`, `Neighbor ${suffix}`, `passage-${suffix}`),
      passage: passage(`passage-${suffix}`, index + 1, `Neighbor ${suffix} evidence.`),
      edge: {
        uuid: `edge-${suffix}`,
        name: 'RELATED_TO',
        fact: `Hub relates to neighbor ${suffix}`,
        fact_type: 'RELATED_TO',
        source_node_uuid: 'entity-hub',
        target_node_uuid: `entity-neighbor-${suffix}`,
        source_node_name: 'Hub Signal',
        target_node_name: `Neighbor ${suffix}`,
        attributes: {
          weight: 1 - index / (neighborCount * 2),
          sourceChunks: [`passage-${suffix}`],
        },
        episodes: [],
      },
    };
  });

  return createMiroFishGraphArtifact({
    identity,
    graph: {
      graph_id: identity.documentId,
      nodes: [
        node('entity-hub', 'Hub Signal', hubPassage.id),
        ...neighbors.map(item => item.node),
      ],
      edges: neighbors.map(item => item.edge),
      node_count: neighborCount + 1,
      edge_count: neighborCount,
      artifact_version: 'mirofish-graph-v2',
      passages: [hubPassage, ...neighbors.map(item => item.passage)],
      communities: [],
    },
  });
}

function createContext(parameterOverrides = {}, signal = new AbortController().signal) {
  const lane = {
    id: 'graph-lane',
    type: 'graph-entity',
    required: false,
    description: 'test graph lane',
    parameters: {
      documentId: identity.documentId,
      documentVersion: identity.documentVersion,
      trustLevel: identity.trustLevel,
      maxHops: 2,
      ...parameterOverrides,
    },
  };
  return {
    request: {
      question: 'Alice',
      topK: 10,
      similarityThreshold: 0,
      llmModel: 'test',
      embeddingModel: 'test',
      storageBackend: 'milvus',
      retrievalScope: {
        tenantId: identity.tenantId,
        corpusId: identity.corpusId,
        allowedTrustLevels: ['trusted', 'reviewed'],
        enforceIsolation: true,
      },
    },
    plan: {
      id: 'test-plan',
      policy_id: 'mirofish-research',
      query: 'Alice',
      lanes: [lane],
      top_k: 10,
      similarity_threshold: 0,
      created_at: '2026-07-15T00:00:00.000Z',
    },
    lane,
    priorEvidence: [],
    signal,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
