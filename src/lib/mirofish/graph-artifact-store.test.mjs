import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
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
  createMiroFishGraphDocumentVersion,
} = await import('./graph-artifact-store.ts');
const { resolveMiroFishGraphStoreCapacity } = await import(
  './graph-artifact-runtime.ts'
);

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

test('graph artifact strips forged scope aliases from passage metadata', () => {
  const graph = createGraph();
  graph.passages[0].metadata = {
    tenantId: 'forged',
    tenant_id: 'forged',
    corpusId: 'forged',
    corpus_id: 'forged',
    documentId: 'forged',
    document_id: 'forged',
    documentVersion: 'forged',
    document_version: 'forged',
    trustLevel: 'trusted',
    trust_level: 'trusted',
    ragScope: { tenantId: 'forged' },
    actorId: 'forged',
    userId: 'forged',
    safeLabel: 'kept',
  };

  const artifact = createMiroFishGraphArtifact({ identity, graph });
  assert.deepEqual(artifact.graph.passages[0].metadata, { safeLabel: 'kept' });
});

test('graph document versions use a canonical content digest', () => {
  const graph = createGraph();
  const reordered = Object.fromEntries(Object.entries(graph).reverse());

  const first = createMiroFishGraphDocumentVersion(graph);
  const second = createMiroFishGraphDocumentVersion(reordered);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('in-memory artifact publication is immutable and idempotent', async () => {
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  const store = new InMemoryMiroFishGraphArtifactStore({ now: () => now });
  const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
  const first = await store.put(artifact);
  now += 1_000;
  const second = await store.put(artifact);
  assert.deepEqual(second, first);

  const conflictingGraph = createGraph();
  conflictingGraph.passages[0].content = 'Different retained evidence.';
  await assert.rejects(
    store.put(createMiroFishGraphArtifact({ identity, graph: conflictingGraph })),
    error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CONFLICT'
  );
});

test('file artifact publication is immutable and idempotent across instances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-immutable-'));
  try {
    const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
    const first = await new FileMiroFishGraphArtifactStore(directory).put(artifact);
    const second = await new FileMiroFishGraphArtifactStore(directory).put(artifact);
    assert.deepEqual(second, first);

    const conflictingGraph = createGraph();
    conflictingGraph.passages[0].content = 'Different retained evidence.';
    await assert.rejects(
      new FileMiroFishGraphArtifactStore(directory).put(
        createMiroFishGraphArtifact({ identity, graph: conflictingGraph })
      ),
      error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CONFLICT'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('active pointer uses CAS and blocks deletion until explicitly deactivated', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
  await store.put(artifact);

  const active = await store.compareAndSetActive(createScope(), identity, 0);
  assert.equal(active.revision, 1);
  assert.deepEqual(active.identity, identity);
  await assert.rejects(
    store.compareAndSetActive(createScope(), identity, 0),
    error => error?.code === 'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT'
  );
  await assert.rejects(
    store.delete(identity, createScope()),
    error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_ACTIVE'
  );

  const inactive = await store.compareAndSetActive(createScope(), null, 1);
  assert.equal(inactive.revision, 2);
  assert.equal(inactive.identity, null);
  assert.equal(await store.delete(identity, createScope()), true);
  assert.equal(await store.get(identity, createScope()), null);
  assert.equal(await store.delete(identity, createScope()), false);
});

test('in-memory active CAS and delete cannot both commit concurrently', async () => {
  const store = new InMemoryMiroFishGraphArtifactStore();
  const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
  await store.put(artifact);

  const [activation, deletion] = await Promise.allSettled([
    store.compareAndSetActive(createScope(), identity, 0),
    store.delete(identity, createScope()),
  ]);

  assert.equal(activation.status, 'fulfilled');
  assert.equal(deletion.status, 'rejected');
  assert.equal(
    deletion.reason?.code,
    'MIROFISH_GRAPH_ARTIFACT_ACTIVE'
  );
  assert.deepEqual((await store.getActive(createScope())).identity, identity);
  assert.deepEqual(await store.get(identity, createScope()), artifact);
});

test('file catalog, active pointer, and deletion persist across store instances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-lifecycle-'));
  try {
    const writer = new FileMiroFishGraphArtifactStore(directory);
    await writer.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));
    await writer.compareAndSetActive(createScope(), identity, 0);

    const reader = new FileMiroFishGraphArtifactStore(directory);
    assert.equal((await reader.list(createScope())).length, 1);
    assert.deepEqual((await reader.getActive(createScope())).identity, identity);

    await reader.compareAndSetActive(createScope(), null, 1);
    assert.equal(await reader.delete(identity, createScope()), true);

    const restarted = new FileMiroFishGraphArtifactStore(directory);
    assert.equal((await restarted.list(createScope())).length, 0);
    assert.equal(await restarted.get(identity, createScope()), null);
    assert.equal((await restarted.getActive(createScope())).revision, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TTL hides expired artifacts and bounded GC removes them', async () => {
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  const store = new InMemoryMiroFishGraphArtifactStore({ now: () => now });
  await store.put(
    createMiroFishGraphArtifact({ identity, graph: createGraph() }),
    { ttlMs: 1_000 }
  );
  await store.compareAndSetActive(createScope(), identity, 0);
  now += 1_001;

  assert.equal(await store.get(identity, createScope()), null);
  assert.deepEqual(await store.list(createScope()), []);
  assert.equal(await store.gcExpired(createScope(), { limit: 1 }), 1);
  assert.equal((await store.getActive(createScope())).identity, null);
});

test('quarantined artifacts can be retained but never activated', async () => {
  const quarantinedIdentity = { ...identity, trustLevel: 'quarantined' };
  const store = new InMemoryMiroFishGraphArtifactStore();
  await store.put(createMiroFishGraphArtifact({
    identity: quarantinedIdentity,
    graph: createGraph(),
  }));

  await assert.rejects(
    store.compareAndSetActive(
      { ...createScope(), allowedTrustLevels: ['quarantined'] },
      quarantinedIdentity,
      0
    ),
    /cannot be activated/
  );
});


test('artifact list applies the exact allowed trust set for memory and file stores', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-trust-list-'));
  try {
    for (const store of [
      new InMemoryMiroFishGraphArtifactStore(),
      new FileMiroFishGraphArtifactStore(directory),
    ]) {
      for (const trustLevel of ['trusted', 'reviewed', 'external', 'quarantined']) {
        const scopedIdentity = {
          ...identity,
          documentId: `document-${trustLevel}`,
          trustLevel,
        };
        await store.put(createArtifactForIdentity(scopedIdentity));
      }
      const publicDescriptors = await store.list({
        ...createScope(),
        allowedTrustLevels: ['trusted', 'external'],
      });
      assert.deepEqual(
        publicDescriptors.map(item => item.identity.trustLevel).sort(),
        ['external', 'trusted']
      );
      const quarantineDescriptors = await store.list({
        ...createScope(),
        allowedTrustLevels: ['quarantined'],
      });
      assert.deepEqual(
        quarantineDescriptors.map(item => item.identity.trustLevel),
        ['quarantined']
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file capacity reservations persist global and per-scope count and byte quotas', async () => {
  const countRoot = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-count-quota-'));
  const bytesRoot = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-byte-quota-'));
  try {
    const firstIdentity = {
      ...identity,
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      documentId: 'doc-a',
    };
    const secondIdentity = {
      ...identity,
      tenantId: 'tenant-b',
      corpusId: 'corpus-b',
      documentId: 'doc-b',
    };
    const thirdIdentity = {
      ...identity,
      tenantId: 'tenant-c',
      corpusId: 'corpus-c',
      documentId: 'doc-c',
    };
    const firstArtifact = createArtifactForIdentity(firstIdentity);
    const secondArtifact = createArtifactForIdentity(secondIdentity);
    const thirdArtifact = createArtifactForIdentity(thirdIdentity);
    const artifactBytes = Buffer.byteLength(JSON.stringify(firstArtifact, null, 2));
    assert.equal(
      Buffer.byteLength(JSON.stringify(secondArtifact, null, 2)),
      artifactBytes
    );

    const countOptions = {
      maxArtifacts: 2,
      maxTotalBytes: artifactBytes * 10,
      maxScopeArtifacts: 1,
      maxScopeBytes: artifactBytes * 10,
    };
    const countWriter = new FileMiroFishGraphArtifactStore(countRoot, countOptions);
    await countWriter.put(firstArtifact);
    await countWriter.put(secondArtifact);
    const countRestarted = new FileMiroFishGraphArtifactStore(countRoot, countOptions);
    await assert.rejects(
      countRestarted.put(thirdArtifact),
      error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
    );
    assert.equal(
      (await countRestarted.list(scopeForIdentity(firstIdentity))).length,
      1
    );
    assert.equal(
      await countRestarted.gcExpired(scopeForIdentity(firstIdentity)),
      0
    );
    assert.equal(
      await countRestarted.delete(firstIdentity, scopeForIdentity(firstIdentity)),
      true
    );
    await countRestarted.put(thirdArtifact);

    const scopeBytesOptions = {
      maxArtifacts: 10,
      maxTotalBytes: artifactBytes * 2,
      maxScopeArtifacts: 10,
      maxScopeBytes: artifactBytes,
    };
    const bytesWriter = new FileMiroFishGraphArtifactStore(
      bytesRoot,
      scopeBytesOptions
    );
    await bytesWriter.put(firstArtifact);
    await assert.rejects(
      bytesWriter.put(createArtifactForIdentity({
        ...firstIdentity,
        documentId: 'doc-z',
      })),
      error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
    );
    await bytesWriter.put(secondArtifact);
    const bytesRestarted = new FileMiroFishGraphArtifactStore(
      bytesRoot,
      scopeBytesOptions
    );
    await assert.rejects(
      bytesRestarted.put(thirdArtifact),
      error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
    );
    assert.equal((await bytesRestarted.list(scopeForIdentity(secondIdentity))).length, 1);
  } finally {
    await rm(countRoot, { recursive: true, force: true });
    await rm(bytesRoot, { recursive: true, force: true });
  }
});

test('runtime parses bounded graph capacity configuration', () => {
  assert.deepEqual(resolveMiroFishGraphStoreCapacity({
    RAG_MIROFISH_GRAPH_MAX_ARTIFACTS: '12',
    RAG_MIROFISH_GRAPH_MAX_TOTAL_BYTES: '12000',
    RAG_MIROFISH_GRAPH_MAX_SCOPE_ARTIFACTS: '3',
    RAG_MIROFISH_GRAPH_MAX_SCOPE_BYTES: '3000',
    RAG_MIROFISH_GRAPH_MAX_TOMBSTONES: '20',
    RAG_MIROFISH_GRAPH_STAGING_TTL_MS: '60000',
  }), {
    maxArtifacts: 12,
    maxTotalBytes: 12000,
    maxScopeArtifacts: 3,
    maxScopeBytes: 3000,
    maxTombstones: 20,
    stagingReservationTtlMs: 60000,
  });
  assert.throws(
    () => resolveMiroFishGraphStoreCapacity({
      RAG_MIROFISH_GRAPH_MAX_ARTIFACTS: '10001',
    }),
    /MAX_ARTIFACTS is invalid/
  );
  assert.throws(
    () => resolveMiroFishGraphStoreCapacity({
      RAG_MIROFISH_GRAPH_MAX_ARTIFACTS: '2',
      RAG_MIROFISH_GRAPH_MAX_SCOPE_ARTIFACTS: '3',
    }),
    /MAX_SCOPE_ARTIFACTS is invalid/
  );
  assert.throws(
    () => resolveMiroFishGraphStoreCapacity({
      RAG_MIROFISH_GRAPH_MAX_ARTIFACTS: '2000',
      RAG_MIROFISH_GRAPH_MAX_SCOPE_ARTIFACTS: '1001',
    }),
    /MAX_SCOPE_ARTIFACTS is invalid/
  );
  assert.throws(
    () => resolveMiroFishGraphStoreCapacity({
      RAG_MIROFISH_GRAPH_MAX_ARTIFACTS: '12',
      RAG_MIROFISH_GRAPH_MAX_TOMBSTONES: '11',
    }),
    /MAX_TOMBSTONES is invalid/
  );
  assert.throws(
    () => resolveMiroFishGraphStoreCapacity({
      RAG_MIROFISH_GRAPH_MAX_TOMBSTONES: '100001',
    }),
    /MAX_TOMBSTONES is invalid/
  );
  assert.throws(
    () => resolveMiroFishGraphStoreCapacity({
      RAG_MIROFISH_GRAPH_STAGING_TTL_MS: '59999',
    }),
    /STAGING_TTL_MS is invalid/
  );
});

test('file get hides an artifact until its descriptor is committed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-half-commit-'));
  try {
    const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });
    const artifactFile = getArtifactFile(directory, identity);
    await mkdir(path.dirname(artifactFile), { recursive: true });
    await writeFile(artifactFile, JSON.stringify(artifact, null, 2));

    const store = new FileMiroFishGraphArtifactStore(directory);
    assert.equal(await store.get(identity, createScope()), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('descriptor failure rolls back only files created by the failed publication', async () => {
  const rollbackRoot = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-rollback-'));
  const winnerRoot = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-winner-'));
  try {
    const artifact = createMiroFishGraphArtifact({ identity, graph: createGraph() });

    const rollbackDescriptor = getDescriptorFile(rollbackRoot, identity);
    await mkdir(rollbackDescriptor, { recursive: true });
    const rollbackStore = new FileMiroFishGraphArtifactStore(rollbackRoot);
    await assert.rejects(rollbackStore.put(artifact));
    await assert.rejects(readFile(getArtifactFile(rollbackRoot, identity)), {
      code: 'ENOENT',
    });
    assert.deepEqual(await readdir(getQuotaDirectory(rollbackRoot)), []);

    const winnerArtifactFile = getArtifactFile(winnerRoot, identity);
    await mkdir(path.dirname(winnerArtifactFile), { recursive: true });
    const winnerBytes = JSON.stringify(artifact, null, 2);
    await writeFile(winnerArtifactFile, winnerBytes);
    await mkdir(getDescriptorFile(winnerRoot, identity), { recursive: true });
    const winnerStore = new FileMiroFishGraphArtifactStore(winnerRoot);
    await assert.rejects(winnerStore.put(artifact));
    assert.equal(await readFile(winnerArtifactFile, 'utf8'), winnerBytes);
    assert.deepEqual(await readdir(getQuotaDirectory(winnerRoot)), []);
    await assert.rejects(
      winnerStore.get(identity, createScope()),
      /rejected an unreadable or invalid artifact/
    );
  } finally {
    await rm(rollbackRoot, { recursive: true, force: true });
    await rm(winnerRoot, { recursive: true, force: true });
  }
});

test('delete resumes capacity cleanup from an existing tombstone', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-delete-retry-'));
  try {
    const store = new FileMiroFishGraphArtifactStore(directory, {
      maxArtifacts: 1,
      maxTotalBytes: 1024 * 1024,
      maxScopeArtifacts: 1,
      maxScopeBytes: 1024 * 1024,
    });
    await store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));
    const tombstoneFile = getTombstoneFile(directory, identity);
    await mkdir(path.dirname(tombstoneFile), { recursive: true });
    await writeFile(tombstoneFile, JSON.stringify({
      identity,
      deletedAt: new Date().toISOString(),
    }));

    assert.equal(await store.delete(identity, createScope()), true);
    assert.deepEqual(await readdir(getQuotaDirectory(directory)), []);
    assert.deepEqual(await store.list(createScope()), []);
    await store.put(createArtifactForIdentity({
      ...identity,
      documentId: 'delete-retry-successor',
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('active pointer history compacts under high churn and survives restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-active-churn-'));
  try {
    const store = new FileMiroFishGraphArtifactStore(directory);
    await store.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));
    let revision = 0;
    for (let index = 0; index < 100; index += 1) {
      const pointer = await store.compareAndSetActive(
        createScope(),
        index % 2 === 0 ? identity : null,
        revision
      );
      revision = pointer.revision;
    }
    const activeFiles = (await readdir(getActiveDirectory(directory)))
      .filter(entry => entry.endsWith('.json'));
    assert.ok(activeFiles.length <= 8);

    const restarted = new FileMiroFishGraphArtifactStore(directory);
    const pointer = await restarted.getActive(createScope());
    assert.equal(pointer.revision, 100);
    assert.equal(pointer.identity, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('active pointer rejects history beyond the hard scan bound', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-active-bound-'));
  try {
    const activeDirectory = getActiveDirectory(directory);
    await mkdir(activeDirectory, { recursive: true });
    await Promise.all(Array.from({ length: 33 }, (_, index) =>
      writeFile(
        path.join(activeDirectory, `${String(index + 1).padStart(16, '0')}.json`),
        '{}'
      )
    ));
    await assert.rejects(
      new FileMiroFishGraphArtifactStore(directory).getActive(createScope()),
      /bounded scan limit/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('post-commit temporary cleanup failure cannot turn a committed put into failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-temp-cleanup-'));
  let now = Date.now();
  try {
    const writer = new FileMiroFishGraphArtifactStore(directory, {
      now: () => now,
      stagingReservationTtlMs: 60_000,
      cleanupFile: async () => {
        throw new Error('injected temporary cleanup failure');
      },
    });
    const descriptor = await writer.put(
      createMiroFishGraphArtifact({ identity, graph: createGraph() })
    );
    assert.equal(descriptor.identity.documentId, identity.documentId);
    assert.notEqual(await writer.get(identity, createScope()), null);
    assert.ok((await listTemporaryFiles(directory)).length > 0);

    now += 120_000;
    const nextIdentity = { ...identity, documentId: 'after-temp-cleanup' };
    const restarted = new FileMiroFishGraphArtifactStore(directory, {
      now: () => now,
      stagingReservationTtlMs: 60_000,
    });
    await restarted.put(createArtifactForIdentity(nextIdentity));
    assert.deepEqual(await listTemporaryFiles(directory), []);
    assert.notEqual(await restarted.get(identity, createScope()), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('active-pointer compaction failure is post-commit best effort', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-active-cleanup-'));
  try {
    const seed = new FileMiroFishGraphArtifactStore(directory);
    await seed.put(createMiroFishGraphArtifact({ identity, graph: createGraph() }));
    let pointer = await seed.getActive(createScope());
    for (let index = 0; index < 8; index += 1) {
      pointer = await seed.compareAndSetActive(
        createScope(),
        index % 2 === 0 ? identity : null,
        pointer.revision
      );
    }

    const injected = new FileMiroFishGraphArtifactStore(directory, {
      cleanupFile: async file => {
        if (file.endsWith('.tmp')) {
          await rm(file, { force: true });
          return;
        }
        throw new Error('injected active compaction failure');
      },
    });
    const committed = await injected.compareAndSetActive(
      createScope(),
      identity,
      pointer.revision
    );
    assert.equal(committed.revision, 9);
    assert.equal((await injected.getActive(createScope())).revision, 9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restart lazily reconciles an expired hard-crash reservation without deleting committed data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-stale-stage-'));
  const now = Date.now();
  const staleIdentity = { ...identity, documentId: 'stale-stage' };
  const replacementIdentity = { ...identity, documentId: 'replacement-stage' };
  const staleArtifact = createArtifactForIdentity(staleIdentity);
  const serialized = JSON.stringify(staleArtifact, null, 2);
  try {
    const artifactFile = getArtifactFile(directory, staleIdentity);
    const quotaFile = getQuotaFile(directory, staleIdentity);
    await mkdir(path.dirname(artifactFile), { recursive: true });
    await mkdir(path.dirname(quotaFile), { recursive: true });
    await writeFile(artifactFile, serialized);
    await writeFile(quotaFile, JSON.stringify({
      identity: staleIdentity,
      artifactBytes: Buffer.byteLength(serialized),
      reservedAt: new Date(now - 60_001).toISOString(),
    }));

    const options = {
      maxArtifacts: 1,
      maxTotalBytes: 1024 * 1024,
      maxScopeArtifacts: 1,
      maxScopeBytes: 1024 * 1024,
      stagingReservationTtlMs: 60_000,
      now: () => now,
    };
    const restarted = new FileMiroFishGraphArtifactStore(directory, options);
    await restarted.put(createArtifactForIdentity(replacementIdentity));

    await assert.rejects(readFile(artifactFile), { code: 'ENOENT' });
    await assert.rejects(readFile(quotaFile), { code: 'ENOENT' });
    assert.notEqual(
      await new FileMiroFishGraphArtifactStore(directory, options)
        .get(replacementIdentity, createScope()),
      null
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tombstone fences survive churn and restart without identity resurrection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-delete-churn-'));
  const churnIdentities = Array.from({ length: 80 }, (_, index) => ({
    ...identity,
    documentId: `churn-${String(index).padStart(3, '0')}`,
  }));
  const options = {
    maxArtifacts: 1,
    maxTotalBytes: 1024 * 1024,
    maxScopeArtifacts: 1,
    maxScopeBytes: 1024 * 1024,
    maxTombstones: churnIdentities.length,
  };

  try {
    for (const store of [
      new InMemoryMiroFishGraphArtifactStore({
        maxTombstones: churnIdentities.length,
      }),
      new FileMiroFishGraphArtifactStore(directory, options),
    ]) {
      for (const churnIdentity of churnIdentities) {
        await store.put(createArtifactForIdentity(churnIdentity));
        assert.equal(await store.delete(churnIdentity, createScope()), true);
      }
      for (const churnIdentity of churnIdentities) {
        await assert.rejects(
          store.put(createArtifactForIdentity(churnIdentity)),
          error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CONFLICT'
        );
      }
      await assert.rejects(
        store.put(createArtifactForIdentity({
          ...identity,
          documentId: 'after-churn',
        })),
        error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
      );
    }

    const tombstones = (await readdir(getTombstoneDirectory(directory)))
      .filter(entry => entry.endsWith('.json'));
    assert.equal(tombstones.length, churnIdentities.length);
    assert.deepEqual(await readdir(getQuotaDirectory(directory)), []);

    const restarted = new FileMiroFishGraphArtifactStore(directory, options);
    for (const churnIdentity of churnIdentities) {
      await assert.rejects(
        restarted.put(createArtifactForIdentity(churnIdentity)),
        error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CONFLICT'
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('full tombstone catalog rejects delete and new publication without erasing live data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-tombstone-cap-'));
  const identities = ['a', 'b', 'c', 'd'].map(documentId => ({
    ...identity,
    documentId: `capacity-${documentId}`,
  }));
  const options = {
    maxArtifacts: 2,
    maxTotalBytes: 2 * 1024 * 1024,
    maxScopeArtifacts: 2,
    maxScopeBytes: 2 * 1024 * 1024,
    maxTombstones: 2,
  };

  try {
    for (const store of [
      new InMemoryMiroFishGraphArtifactStore({ maxTombstones: 2 }),
      new FileMiroFishGraphArtifactStore(directory, options),
    ]) {
      await store.put(createArtifactForIdentity(identities[0]));
      await store.put(createArtifactForIdentity(identities[1]));
      assert.equal(await store.delete(identities[0], createScope()), true);
      await store.put(createArtifactForIdentity(identities[2]));
      assert.equal(await store.delete(identities[1], createScope()), true);

      await assert.rejects(
        store.delete(identities[2], createScope()),
        error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
      );
      assert.notEqual(await store.get(identities[2], createScope()), null);
      await assert.rejects(
        store.put(createArtifactForIdentity(identities[3])),
        error => error?.code === 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
      );
    }

    const restarted = new FileMiroFishGraphArtifactStore(directory, options);
    assert.notEqual(await restarted.get(identities[2], createScope()), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent publication never lets temporary cleanup overwrite the winner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e5-graph-concurrent-'));
  try {
    const first = createMiroFishGraphArtifact({ identity, graph: createGraph() });
    const second = createArtifactForIdentity(identity, 'Different winner content.');
    const outcomes = await Promise.allSettled([
      new FileMiroFishGraphArtifactStore(directory).put(first),
      new FileMiroFishGraphArtifactStore(directory).put(second),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);

    const committed = await new FileMiroFishGraphArtifactStore(directory)
      .get(identity, createScope());
    assert.ok([
      'Alice founded Acme.',
      'Different winner content.',
    ].includes(committed.graph.passages[0].content));
    const directories = [
      path.dirname(getArtifactFile(directory, identity)),
      path.dirname(getDescriptorFile(directory, identity)),
      getQuotaDirectory(directory),
    ];
    for (const candidate of directories) {
      assert.deepEqual(
        (await readdir(candidate)).filter(entry => entry.endsWith('.tmp')),
        []
      );
    }
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

function createArtifactForIdentity(
  artifactIdentity,
  content = 'Alice founded Acme.'
) {
  const value = createGraph();
  value.graph_id = artifactIdentity.documentId;
  value.passages[0].document_id = artifactIdentity.documentId;
  value.passages[0].content = content;
  value.passages[0].end_offset = content.length;
  return createMiroFishGraphArtifact({
    identity: artifactIdentity,
    graph: value,
  });
}

function createIdentityDigest(artifactIdentity) {
  const key = JSON.stringify([
    artifactIdentity.tenantId,
    artifactIdentity.corpusId,
    artifactIdentity.documentId,
    artifactIdentity.documentVersion,
    artifactIdentity.trustLevel,
  ]);
  return createHash('sha256').update(key).digest('hex');
}

function createScopeDigest(scope) {
  return createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.corpusId]))
    .digest('hex');
}

function getArtifactFile(directory, artifactIdentity = identity) {
  const digest = createIdentityDigest(artifactIdentity);
  return path.join(directory, digest.slice(0, 2), `${digest}.json`);
}

function getDescriptorFile(directory, artifactIdentity = identity) {
  return path.join(
    directory,
    'index',
    createScopeDigest(artifactIdentity),
    `${createIdentityDigest(artifactIdentity)}.json`
  );
}

function getQuotaDirectory(directory) {
  return path.join(directory, 'quota', 'entries');
}
function getQuotaFile(directory, artifactIdentity = identity) {
  return path.join(
    getQuotaDirectory(directory),
    `${createIdentityDigest(artifactIdentity)}.json`
  );
}


function getActiveDirectory(directory) {
  return path.join(directory, 'active', createScopeDigest(identity));
}

function getTombstoneDirectory(directory) {
  return path.join(directory, 'tombstones', createScopeDigest(identity));
}

function getTombstoneFile(directory, artifactIdentity = identity) {
  return path.join(
    directory,
    'tombstones',
    createScopeDigest(artifactIdentity),
    `${createIdentityDigest(artifactIdentity)}.json`
  );
}

function scopeForIdentity(artifactIdentity) {
  return {
    tenantId: artifactIdentity.tenantId,
    corpusId: artifactIdentity.corpusId,
    allowedTrustLevels: [artifactIdentity.trustLevel],
    enforceIsolation: true,
  };
}

function createScope() {
  return {
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  };
}

async function listTemporaryFiles(directory) {
  return (await readdir(directory, { recursive: true }))
    .map(entry => String(entry))
    .filter(entry => entry.endsWith('.tmp'))
    .sort();
}
function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
