import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  MiroFishGraphBuilder,
  MiroFishGraphOntologyValidationError,
  convertKnowledgeGraphToGraphData,
  createPublicGraphProjection,
  createMiroFishGraphExtractionConfig,
  normalizeMiroFishGraphOntology,
} = await import('./graph-builder.ts');
const {
  EntityExtractor,
  EntityExtractionOutputBudgetError,
} = await import('../entity-extraction.ts');
const { MIROFISH_GRAPH_ARTIFACT_LIMITS } = await import('./graph-artifact-store.ts');
const { getTaskManager } = await import('./task-manager.ts');

test('MiroFish graph builder uses a fast extraction profile by default', () => {
  const builder = new MiroFishGraphBuilder();

  assert.equal(builder.config.chunkSize, 5000);
  assert.equal(builder.config.chunkOverlap, 300);
  assert.equal(builder.config.batchSize, 1);
});

test('MiroFish graph extraction disables gleaning to avoid doubling LLM calls', () => {
  const config = createMiroFishGraphExtractionConfig({
    chunkSize: 5000,
    chunkOverlap: 300,
  });

  assert.equal(config.chunkSize, 5000);
  assert.equal(config.chunkOverlap, 300);
  assert.equal(config.enableGleaning, false);
  assert.equal(config.maxChunkTimeout, 45000);
});

test('MiroFish graph builder preserves an explicit zero-overlap budget', () => {
  const builder = new MiroFishGraphBuilder({
    chunkSize: 100,
    chunkOverlap: 0,
    batchSize: 1,
  });

  assert.equal(builder.config.chunkSize, 100);
  assert.equal(builder.config.chunkOverlap, 0);
});

test('MiroFish graph ontology validation normalizes legacy optional summary', () => {
  const ontology = normalizeMiroFishGraphOntology({
    entity_types: [{
      name: ' Person ',
      description: ' A person ',
      attributes: [],
      examples: [],
    }],
    edge_types: [],
  });

  assert.equal(ontology.entity_types[0].name, 'Person');
  assert.equal(ontology.entity_types[0].description, 'A person');
  assert.equal(ontology.analysis_summary, '');
});

test('invalid ontology fails before allocating a graph task', async () => {
  const taskManager = getTaskManager();
  const taskCount = taskManager.getAllTasks().length;
  const builder = new MiroFishGraphBuilder();

  await assert.rejects(
    builder.buildGraphAsync({ text: 'source', ontology: {} }),
    MiroFishGraphOntologyValidationError
  );
  assert.equal(taskManager.getAllTasks().length, taskCount);
});

test('graph builds purge legacy raw cache and never write a replacement', async t => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'mirofish-builder-cache-'));
  const cacheDirectory = path.join(root, 'uploads', 'mirofish-cache');
  const graphCacheFile = path.join(cacheDirectory, 'graph.json');
  const ontologyCacheFile = path.join(cacheDirectory, 'ontology.json');
  const originalWorker = MiroFishGraphBuilder.prototype.buildGraphWorker;
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(graphCacheFile, legacyCacheRecord('graph', {
    graph_id: 'graph-private',
    passages: [{ content: 'raw private source' }],
  }));
  await writeFile(ontologyCacheFile, legacyCacheRecord('ontology', {
    entity_types: [],
    edge_types: [],
  }));
  MiroFishGraphBuilder.prototype.buildGraphWorker = async taskId => {
    getTaskManager().completeTask(taskId, {
      graphId: 'graph-new',
      graphData: { graph_id: 'graph-new', nodes: [], edges: [] },
    });
  };
  process.chdir(root);
  t.after(async () => {
    process.chdir(originalCwd);
    MiroFishGraphBuilder.prototype.buildGraphWorker = originalWorker;
    await rm(root, { recursive: true, force: true });
  });

  const taskId = await new MiroFishGraphBuilder().buildGraphAsync({
    text: 'source',
    ontology: { entity_types: [], edge_types: [] },
  });
  t.after(() => getTaskManager().deleteTask(taskId));

  await assert.rejects(readFile(graphCacheFile), { code: 'ENOENT' });
  assert.match(await readFile(ontologyCacheFile, 'utf8'), /"artifact": "ontology"/);
  assert.deepEqual(await readdir(cacheDirectory), ['ontology.json']);
  assert.equal(getTaskManager().getTask(taskId)?.status, 'completed');
});

test('background graph failures store a stable code and never log provider content', async t => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'mirofish-builder-error-'));
  const originalWorker = MiroFishGraphBuilder.prototype.buildGraphWorker;
  const originalConsoleError = console.error;
  const logged = [];
  MiroFishGraphBuilder.prototype.buildGraphWorker = async () => {
    const error = new Error(
      'confidential-passage provider api_key=sk-do-not-store'
    );
    error.name = 'ProviderError';
    error.code = 'PROVIDER_TIMEOUT';
    throw error;
  };
  console.error = (...values) => logged.push(values);
  process.chdir(root);
  t.after(async () => {
    process.chdir(originalCwd);
    MiroFishGraphBuilder.prototype.buildGraphWorker = originalWorker;
    console.error = originalConsoleError;
    await rm(root, { recursive: true, force: true });
  });

  const taskId = await new MiroFishGraphBuilder().buildGraphAsync({
    text: 'source',
    ontology: { entity_types: [], edge_types: [] },
  });
  t.after(() => getTaskManager().deleteTask(taskId));
  await new Promise(resolve => setImmediate(resolve));

  const task = getTaskManager().getTask(taskId);
  assert.equal(task?.status, 'failed');
  assert.equal(task?.error, 'MIROFISH_GRAPH_BUILD_FAILED');
  assert.doesNotMatch(JSON.stringify(task), /sk-do-not-store|confidential-passage/);
  assert.doesNotMatch(JSON.stringify(logged), /sk-do-not-store|confidential-passage/);
  assert.match(JSON.stringify(logged), /ProviderError/);
  assert.match(JSON.stringify(logged), /PROVIDER_TIMEOUT/);
});

test('artifact-limit worker failure keeps its stable code and stores no graphData', async t => {
  const originalExtract = EntityExtractor.prototype.extract;
  const originalFilter = MiroFishGraphBuilder.prototype.applyOntologyFilter;
  const exactSource = '  source with leading spaces\n\nline with trailing spaces  ';
  let observedSource;
  EntityExtractor.prototype.extract = async (text, documentId) => {
    observedSource = text;
    return {
      entities: new Map(),
      relations: new Map(),
      communities: new Map(),
      chunks: new Map(),
      metadata: {
        documentId,
        createdAt: new Date(),
        entityCount: 0,
        relationCount: 0,
        communityCount: 0,
      },
    };
  };
  MiroFishGraphBuilder.prototype.applyOntologyFilter = graphData => ({
    ...graphData,
    passages: [{
      id: 'oversized-passage',
      document_id: graphData.graph_id,
      content: 'x'.repeat(
        MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassageCharacters + 1
      ),
      index: 0,
      start_offset: 0,
      end_offset: MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassageCharacters + 1,
    }],
  });
  t.after(() => {
    EntityExtractor.prototype.extract = originalExtract;
    MiroFishGraphBuilder.prototype.applyOntologyFilter = originalFilter;
  });

  const taskId = await new MiroFishGraphBuilder().buildGraphAsync({
    text: exactSource,
    ontology: { entity_types: [], edge_types: [] },
  });
  t.after(() => getTaskManager().deleteTask(taskId));
  const task = await waitForTerminalTask(taskId);

  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'MIROFISH_GRAPH_ARTIFACT_LIMIT_EXCEEDED');
  assert.equal(task.result, undefined);
  assert.equal(JSON.stringify(task).includes('graphData'), false);
  assert.equal(observedSource, exactSource);
});

test('output-budget worker failure keeps its stable code and stores no graphData', async t => {
  const originalExtract = EntityExtractor.prototype.extract;
  EntityExtractor.prototype.extract = async () => {
    throw new EntityExtractionOutputBudgetError();
  };
  t.after(() => {
    EntityExtractor.prototype.extract = originalExtract;
  });

  const taskId = await new MiroFishGraphBuilder().buildGraphAsync({
    text: 'bounded source',
    ontology: { entity_types: [], edge_types: [] },
  });
  t.after(() => getTaskManager().deleteTask(taskId));
  const task = await waitForTerminalTask(taskId);

  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'MIROFISH_GRAPH_OUTPUT_BUDGET_EXCEEDED');
  assert.equal(task.result, undefined);
  assert.equal(JSON.stringify(task).includes('graphData'), false);
});

test('durable graph publication completes only after the store commit barrier', async t => {
  const originalExtract = EntityExtractor.prototype.extract;
  const publicationEvents = [];
  let releasePublication;
  let publishedArtifact;
  EntityExtractor.prototype.extract = async (_text, documentId) =>
    createExtractedGraph(documentId, {
      tenantId: 'forged-tenant',
      tenant_id: 'forged-tenant',
      safeLabel: 'retained',
    });
  const store = {
    coordination: 'process',
    async put(artifact) {
      publicationEvents.push('put-started');
      publishedArtifact = artifact;
      await new Promise(resolve => {
        releasePublication = resolve;
      });
      publicationEvents.push('put-committed');
      return {
        identity: {
          tenantId: artifact.tenantId,
          corpusId: artifact.corpusId,
          documentId: artifact.documentId,
          documentVersion: artifact.documentVersion,
          trustLevel: artifact.trustLevel,
        },
        artifactDigest: `sha256:${'0'.repeat(64)}`,
        createdAt: '2026-07-16T00:00:00.000Z',
        nodeCount: artifact.graph.node_count,
        edgeCount: artifact.graph.edge_count,
      };
    },
    async delete() {
      return true;
    },
  };
  t.after(() => {
    EntityExtractor.prototype.extract = originalExtract;
  });

  const taskId = await new MiroFishGraphBuilder().buildGraphAsync(
    {
      text: 'Alice founded Acme.',
      ontology: { entity_types: [], edge_types: [] },
      graphName: 'Published graph',
    },
    undefined,
    { publicationTrustLevel: 'trusted' },
    undefined,
    {
      store,
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      trustLevel: 'external',
      graphName: 'Published graph',
    }
  );
  t.after(() => getTaskManager().deleteTask(taskId));
  await waitForCondition(() => publicationEvents.includes('put-started'));

  assert.notEqual(getTaskManager().getTask(taskId)?.status, 'completed');
  releasePublication();
  const task = await waitForTerminalTask(taskId);

  assert.equal(task.status, 'completed');
  assert.deepEqual(publicationEvents, ['put-started', 'put-committed']);
  assert.equal(task.metadata.publicationTrustLevel, 'external');
  assert.equal(task.result.artifactIdentity.tenantId, 'tenant-a');
  assert.equal(task.result.artifactIdentity.corpusId, 'corpus-a');
  assert.equal(task.result.artifactIdentity.trustLevel, 'external');
  assert.match(task.result.artifactIdentity.documentVersion, /^sha256:[a-f0-9]{64}$/);
  assert.equal('graphData' in task.result, false);
  assert.equal(JSON.stringify(task.result).includes('Alice founded Acme.'), false);
  assert.deepEqual(publishedArtifact.graph.passages[0].metadata, {
    safeLabel: 'retained',
  });
});

test('durable graph publication failure is terminal and retains no raw result', async t => {
  const originalExtract = EntityExtractor.prototype.extract;
  EntityExtractor.prototype.extract = async (_text, documentId) =>
    createExtractedGraph(documentId);
  const store = {
    coordination: 'process',
    async put() {
      throw new Error('simulated durable store outage with private source');
    },
    async delete() {
      return true;
    },
  };
  t.after(() => {
    EntityExtractor.prototype.extract = originalExtract;
  });

  const taskId = await new MiroFishGraphBuilder().buildGraphAsync(
    {
      text: 'private source',
      ontology: { entity_types: [], edge_types: [] },
    },
    undefined,
    undefined,
    undefined,
    {
      store,
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      trustLevel: 'external',
    }
  );
  t.after(() => getTaskManager().deleteTask(taskId));
  const task = await waitForTerminalTask(taskId);

  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'MIROFISH_GRAPH_ARTIFACT_PUBLISH_FAILED');
  assert.equal(task.result, undefined);
  assert.equal(JSON.stringify(task).includes('private source'), false);
});


test('MiroFish graph adapter retains source passages and communities', () => {
  const graph = convertKnowledgeGraphToGraphData({
    entities: new Map([['entity-1', {
      id: 'entity-1',
      name: 'Alice',
      type: 'PERSON',
      description: 'Founder',
      aliases: [],
      mentions: 1,
      sourceChunks: ['chunk-1'],
      metadata: {
        aliases: ['forged'],
        mentions: 999,
        sourceChunks: ['forged-chunk'],
      },
    }]]),
    relations: new Map([['relation-1', {
      id: 'relation-1',
      source: 'entity-1',
      target: 'entity-1',
      type: 'FOUNDED',
      description: 'Alice founded the company.',
      weight: 0.7,
      sourceChunks: ['chunk-1'],
      metadata: { weight: 99, sourceChunks: ['forged-chunk'] },
    }]]),
    communities: new Map([['community-1', {
      id: 'community-1',
      name: 'Founders',
      entities: ['entity-1'],
      relations: [],
      summary: 'Founder community',
      keywords: ['founder'],
      level: 0,
    }]]),
    chunks: new Map([['chunk-1', {
      id: 'chunk-1',
      content: 'Alice is a founder.',
      index: 0,
      startChar: 0,
      endChar: 19,
      overlap: { previous: null, next: null },
      metadata: { source: 'source.txt', page: 1 },
    }]]),
    metadata: {
      documentId: 'document-1',
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      entityCount: 1,
      relationCount: 0,
      communityCount: 1,
    },
  });

  assert.equal(graph.artifact_version, 'mirofish-graph-v2');
  assert.equal(graph.passages[0].id, 'chunk-1');
  assert.equal(graph.passages[0].source, 'source.txt');
  assert.equal(graph.communities[0].id, 'community-1');
  assert.deepEqual(graph.nodes[0].attributes.sourceChunks, ['chunk-1']);
  assert.deepEqual(graph.nodes[0].attributes.aliases, []);
  assert.equal(graph.nodes[0].attributes.mentions, 1);
  assert.deepEqual(graph.edges[0].attributes.sourceChunks, ['chunk-1']);
  assert.equal(graph.edges[0].attributes.weight, 0.7);

  const publicGraph = createPublicGraphProjection(graph);
  assert.equal('passages' in publicGraph, false);
  assert.equal(JSON.stringify(publicGraph).includes('Alice is a founder.'), false);
});

function createExtractedGraph(documentId, chunkMetadata = {}) {
  return {
    entities: new Map(),
    relations: new Map(),
    communities: new Map(),
    chunks: new Map([['chunk-1', {
      id: 'chunk-1',
      content: 'Alice founded Acme.',
      index: 0,
      startChar: 0,
      endChar: 19,
      overlap: { previous: null, next: null },
      metadata: chunkMetadata,
    }]]),
    metadata: {
      documentId,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      entityCount: 0,
      relationCount: 0,
      communityCount: 0,
    },
  };
}

async function waitForCondition(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Condition did not become true.');
}


function legacyCacheRecord(artifact, value) {
  return JSON.stringify({
    version: 'mirofish-llm-artifact-v1',
    cache_key: `${artifact}-key`,
    source_hash: `${artifact}-source`,
    model_signature: {
      version: 'mirofish-llm-artifact-v1',
      artifact,
      provider: 'ollama',
      model_name: 'test',
      base_url: '',
      temperature: 0.1,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    artifact: value,
  }, null, 2);
}

async function waitForTerminalTask(taskId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = getTaskManager().getTask(taskId);
    if (task?.status === 'completed' || task?.status === 'failed') {
      return task;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state.`);
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
