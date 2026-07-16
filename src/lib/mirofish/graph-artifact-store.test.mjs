import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  FileMiroFishGraphArtifactStore,
  InMemoryMiroFishGraphArtifactStore,
  createMiroFishGraphArtifact,
} = await import('./graph-artifact-store.ts');

const identity = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  documentId: 'document-a',
  documentVersion: 'sha256:v1',
  trustLevel: 'reviewed',
};

test('graph artifact stamps omitted passage scope fields', () => {
  const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
  const passage = artifact.graph.passages[0];

  assert.equal(passage.tenant_id, identity.tenantId);
  assert.equal(passage.corpus_id, identity.corpusId);
  assert.equal(passage.document_version, identity.documentVersion);
  assert.equal(passage.trust_level, identity.trustLevel);
});

test('graph artifact rejects a passage with conflicting tenant scope', () => {
  const graph = createGraph();
  graph.passages[0].tenant_id = 'tenant-b';

  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph }),
    /tenant_id conflicts/
  );
});

test('graph artifact rejects graph/document identity drift', () => {
  assert.throws(
    () => createMiroFishGraphArtifact({
      identity,
      graph: { ...createGraph(), graph_id: 'document-b' },
    }),
    /does not match graph_id/
  );
});

test('graph artifact rejects legacy graphs that lost their passages', () => {
  const graph = createGraph();
  delete graph.passages;
  delete graph.artifact_version;

  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph }),
    /mirofish-graph-v2/
  );
});

test('graph artifact rejects invalid source spans', () => {
  const graph = createGraph();
  graph.passages[0].end_offset = 0;

  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph }),
    /invalid source span/
  );
});

test('graph artifact rejects duplicate topology and passage identities', () => {
  const duplicateNodeGraph = createLinkedGraph();
  duplicateNodeGraph.nodes.push({ ...duplicateNodeGraph.nodes[0] });
  duplicateNodeGraph.node_count = duplicateNodeGraph.nodes.length;
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: duplicateNodeGraph }),
    /duplicate node identity/
  );

  const duplicateEdgeGraph = createLinkedGraph();
  duplicateEdgeGraph.edges.push({ ...duplicateEdgeGraph.edges[0] });
  duplicateEdgeGraph.edge_count = duplicateEdgeGraph.edges.length;
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: duplicateEdgeGraph }),
    /duplicate edge identity/
  );

  const duplicatePassageGraph = createLinkedGraph();
  duplicatePassageGraph.passages.push({ ...duplicatePassageGraph.passages[0] });
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: duplicatePassageGraph }),
    /duplicate passage identity/
  );

  const duplicateCommunityGraph = createLinkedGraph({ includeCommunity: true });
  duplicateCommunityGraph.communities.push({
    ...duplicateCommunityGraph.communities[0],
  });
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: duplicateCommunityGraph }),
    /duplicate community identity/
  );
});

test('graph artifact rejects dangling topology and source passage references', () => {
  const danglingEndpointGraph = createLinkedGraph();
  danglingEndpointGraph.edges[0].target_node_uuid = 'missing-node';
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: danglingEndpointGraph }),
    /missing endpoint node/
  );

  const danglingNodeSourceGraph = createLinkedGraph();
  danglingNodeSourceGraph.nodes[0].attributes.sourceChunks = ['missing-passage'];
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: danglingNodeSourceGraph }),
    /node node-1 references a missing source passage/
  );

  const danglingEdgeSourceGraph = createLinkedGraph();
  danglingEdgeSourceGraph.edges[0].attributes.sourceChunks = ['missing-passage'];
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: danglingEdgeSourceGraph }),
    /edge edge-1 references a missing source passage/
  );
});

test('graph artifact rejects dangling community references', () => {
  const missingNodeGraph = createLinkedGraph({ includeCommunity: true });
  missingNodeGraph.communities[0].entities = ['missing-node'];
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: missingNodeGraph }),
    /community community-1 references a missing node/
  );

  const missingEdgeGraph = createLinkedGraph({ includeCommunity: true });
  missingEdgeGraph.communities[0].relations = ['missing-edge'];
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: missingEdgeGraph }),
    /community community-1 references a missing edge/
  );

  const missingParentGraph = createLinkedGraph({ includeCommunity: true });
  missingParentGraph.communities[0].parent_id = 'missing-community';
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: missingParentGraph }),
    /community community-1 references an invalid parent/
  );
});

test('graph artifact rejects malformed node and edge shapes', () => {
  const malformedNodeGraph = createLinkedGraph();
  malformedNodeGraph.nodes[0].labels = 'Entity';
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: malformedNodeGraph }),
    /labels must be an array/
  );

  const malformedEdgeGraph = createLinkedGraph();
  malformedEdgeGraph.edges[0].episodes = 'episode-1';
  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph: malformedEdgeGraph }),
    /episodes must be an array/
  );
});

test('graph artifact caps aggregate source passage references', () => {
  const graph = createGraph();
  const passageIds = Array.from(
    { length: 25_000 },
    (_, index) => `passage-${index}`
  );
  graph.passages = passageIds.map((id, index) => ({
    id,
    document_id: identity.documentId,
    content: 'x',
    index,
    start_offset: index,
    end_offset: index + 1,
  }));
  graph.nodes = Array.from({ length: 5 }, (_, index) => ({
    uuid: `node-${index}`,
    name: `Node ${index}`,
    labels: ['Entity'],
    summary: '',
    attributes: { sourceChunks: [...passageIds] },
  }));
  graph.node_count = graph.nodes.length;

  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph }),
    /source passage references exceed the configured limit/
  );
});

test('graph artifact caps aggregate community references', () => {
  const graph = createLinkedGraph();
  graph.communities = Array.from({ length: 5 }, (_, index) => ({
    id: `community-${index}`,
    name: `Community ${index}`,
    entities: Array.from({ length: 20_001 }, () => 'node-1'),
    relations: [],
    summary: '',
    keywords: [],
    level: 0,
  }));

  assert.throws(
    () => createMiroFishGraphArtifact({ identity, graph }),
    /community member references exceed the configured limit/
  );
});

test('artifact store returns only an exact scope and document version', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  await store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));

  assert.ok(await store.get(identity, createScope()));
  assert.equal(
    await store.get({ ...identity, documentVersion: 'sha256:v2' }, createScope()),
    null
  );
});

test('artifact store fails closed on tenant or corpus scope mismatch', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  await store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));

  await assert.rejects(
    store.get(identity, { ...createScope(), tenantId: 'tenant-b' }),
    /tenant scope mismatch/
  );
  await assert.rejects(
    store.get(identity, { ...createScope(), corpusId: 'corpus-b' }),
    /corpus scope mismatch/
  );
});

test('artifact store fails closed on disallowed and quarantined trust', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  await store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));

  await assert.rejects(
    store.get(identity, { ...createScope(), allowedTrustLevels: ['trusted'] }),
    /outside the retrieval scope/
  );

  const quarantinedIdentity = { ...identity, trustLevel: 'quarantined' };
  await store.put(createMiroFishGraphArtifact({
    identity: quarantinedIdentity,
    graph: createGraph(),
  }));
  await assert.rejects(
    store.get(quarantinedIdentity, {
      ...createScope(),
      allowedTrustLevels: ['quarantined'],
    }),
    /quarantined/
  );
});

test('artifact store clones writes and reads to prevent cross-request mutation', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
  await store.put(artifact);
  artifact.graph.passages[0].content = 'mutated before read';

  const first = await store.get(identity, createScope());
  first.graph.passages[0].content = 'mutated after read';
  const second = await store.get(identity, createScope());

  assert.equal(second.graph.passages[0].content, 'Alice founded Acme.');
});

test('file artifact store persists an exact scoped version across instances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-'));
  try {
    await new FileMiroFishGraphArtifactStore(directory).put(
      createMiroFishGraphArtifact({ identity, graph: createGraph() })
    );

    const reader = new FileMiroFishGraphArtifactStore(directory);
    assert.ok(await reader.get(identity, createScope()));
    assert.equal(
      await reader.get({ ...identity, documentVersion: 'sha256:v2' }, createScope()),
      null
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file artifact store rejects artifacts above its hard byte budget', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-limit-'));
  try {
    const store = new FileMiroFishGraphArtifactStore(directory, {
      maxFileBytes: 256,
    });
    await assert.rejects(
      store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() })),
      /file byte limit/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file artifact store enforces the byte cap while reading one opened file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-read-limit-'));
  try {
    const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
    await new FileMiroFishGraphArtifactStore(directory).put(artifact);
    const artifactFile = getArtifactFile(directory);
    const initialBytes = (await readFile(artifactFile)).byteLength;
    await appendFile(artifactFile, 'x');

    const reader = new FileMiroFishGraphArtifactStore(directory, {
      maxFileBytes: initialBytes,
    });
    await assert.rejects(
      reader.get(identity, createScope()),
      error => error?.cause?.message === 'Graph artifact exceeds the configured file byte limit.'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file artifact store removes its temporary file when rename fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-rename-'));
  try {
    const artifactFile = getArtifactFile(directory);
    await mkdir(artifactFile, { recursive: true });
    const store = new FileMiroFishGraphArtifactStore(directory);

    await assert.rejects(
      store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }))
    );
    const siblings = await readdir(path.dirname(artifactFile));
    assert.deepEqual(siblings.filter(file => file.endsWith('.tmp')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createGraph() {
  return {
    graph_id: identity.documentId,
    nodes: [],
    edges: [],
    node_count: 0,
    edge_count: 0,
    artifact_version: 'mirofish-graph-v2',
    passages: [{
      id: 'passage-1',
      document_id: identity.documentId,
      content: 'Alice founded Acme.',
      index: 0,
      start_offset: 0,
      end_offset: 19,
    }],
    communities: [],
  };
}

function createLinkedGraph({ includeCommunity = false } = {}) {
  const graph = createGraph();
  graph.nodes = [{
    uuid: 'node-1',
    name: 'Alice',
    labels: ['Person'],
    summary: 'Founder',
    attributes: { sourceChunks: ['passage-1'] },
  }, {
    uuid: 'node-2',
    name: 'Acme',
    labels: ['Organization'],
    summary: 'Company',
    attributes: { sourceChunks: ['passage-1'] },
  }];
  graph.edges = [{
    uuid: 'edge-1',
    name: 'FOUNDED',
    fact: 'Alice founded Acme.',
    fact_type: 'FOUNDED',
    source_node_uuid: 'node-1',
    target_node_uuid: 'node-2',
    source_node_name: 'Alice',
    target_node_name: 'Acme',
    attributes: { sourceChunks: ['passage-1'] },
    episodes: [],
  }];
  graph.node_count = graph.nodes.length;
  graph.edge_count = graph.edges.length;
  graph.communities = includeCommunity ? [{
    id: 'community-1',
    name: 'Founders',
    entities: ['node-1', 'node-2'],
    relations: ['edge-1'],
    summary: 'Founding relationships.',
    keywords: ['founder'],
    level: 0,
  }] : [];
  return graph;
}

function getArtifactFile(directory) {
  const key = JSON.stringify([
    identity.tenantId,
    identity.corpusId,
    identity.documentId,
    identity.documentVersion,
    identity.trustLevel,
  ]);
  const digest = createHash('sha256').update(key).digest('hex');
  return path.join(directory, digest.slice(0, 2), `${digest}.json`);
}

function createScope() {
  return {
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
