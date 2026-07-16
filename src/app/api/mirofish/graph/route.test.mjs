import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') {
      return nextResolve('next/server.js', context);
    }
    if (specifier.startsWith('@/')) {
      const target = path.resolve(process.cwd(), 'src', `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }
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

const originalEnvironment = captureEnvironment([
  'RAG_ACCESS_MODE',
  'RAG_AUTH_MODE',
  'RAG_SINGLE_TENANT_TOKEN',
  'RAG_SINGLE_TENANT_ROLE',
  'RAG_SINGLE_TENANT_ACTOR_ID',
  'SUPABASE_DEFAULT_TENANT_ID',
  'SUPABASE_DEFAULT_CORPUS_ID',
]);

configureSingleTenant('owner');

const { NextRequest } = await import('next/server');
const { MiroFishGraphBuilder } = await import('@/lib/mirofish/graph-builder');
const { getTaskManager } = await import('@/lib/mirofish/task-manager');
const { createMiroFishGraphTaskScopeMetadata } = await import(
  '@/lib/mirofish/graph-api-scope'
);
const {
  POST,
  GET,
  DELETE,
  calculateMiroFishGraphChunkUpperBound,
} = await import('./route.ts');

after(() => restoreEnvironment(originalEnvironment));

test('POST authorizes ingest and binds tenant, corpus, and actor to the new task', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => reservedTaskId;
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'A bounded graph source.',
      ontology: { entity_types: [], edge_types: [] },
      corpusId: 'corpus-a',
    }),
  }));
  const body = await response.json();
  t.after(() => taskManager.deleteTask(body.taskId));

  assert.equal(response.status, 200);
  assert.deepEqual(taskManager.getTask(body.taskId)?.metadata?.ragScope, {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    actorId: 'actor-a',
  });
});

test('POST rejects a viewer through the stable RagSecurityError contract', async () => {
  configureSingleTenant('viewer');
  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: {} }),
  }));
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, 'RAG_CAPABILITY_FORBIDDEN');
  assert.equal(body.error, 'The authenticated actor is not allowed to perform this operation.');
  assert.equal(body.requestId, 'graph-api-test');
});

test('GET requires authentication through the stable RagSecurityError contract', async () => {
  configureSingleTenant('owner');
  const response = await GET(request('?action=list', { authenticated: false }));
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.code, 'RAG_AUTH_REQUIRED');
  assert.equal(body.error, 'Authentication is required.');
  assert.equal(body.requestId, 'graph-api-test');
});

test('status allows the current corpus and hides raw worker errors', async t => {
  configureSingleTenant('owner');
  const taskId = createTask(t, currentScope());
  getTaskManager().failTask(taskId, 'provider secret: sk-do-not-leak');

  const response = await GET(request(`?action=status&taskId=${taskId}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'failed');
  assert.equal(body.error, '图谱构建失败');
  assert.doesNotMatch(JSON.stringify(body), /sk-do-not-leak/);
});

test('status returns the same not-found response for foreign and missing tasks', async t => {
  configureSingleTenant('owner');
  const foreignTaskId = createTask(t, { ...currentScope(), tenantId: 'tenant-b' });

  const foreign = await GET(request(`?action=status&taskId=${foreignTaskId}`));
  const missing = await GET(request('?action=status&taskId=task-missing'));

  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), await missing.json());
});

test('status and delete hide legacy unscoped tasks when isolation is enforced', async t => {
  configureSingleTenant('owner');
  const legacyTaskId = createTask(t, undefined);
  const legacyGraphId = getTaskManager().getTask(legacyTaskId).result.graphId;

  const statusResponse = await GET(request(`?action=status&taskId=${legacyTaskId}`));
  const deleteResponse = await DELETE(request(`?graphId=${legacyGraphId}`, {
    method: 'DELETE',
  }));

  assert.equal(statusResponse.status, 404);
  assert.equal(deleteResponse.status, 404);
  assert.ok(getTaskManager().getTask(legacyTaskId));
});

test('data hides foreign, legacy, and malformed-scope graph results', async t => {
  configureSingleTenant('owner');
  const foreignTask = createTask(t, { ...currentScope(), corpusId: 'corpus-b' });
  const legacyTask = createTask(t, undefined);
  const malformedTask = createTask(t, null);

  for (const taskId of [foreignTask, legacyTask, malformedTask]) {
    const graphId = getTaskManager().getTask(taskId).result.graphId;
    const response = await GET(request(`?action=data&graphId=${graphId}`));
    assert.equal(response.status, 404);
  }
});

test('data returns only the public graph projection in the current scope', async t => {
  configureSingleTenant('owner');
  const taskId = createTask(t, currentScope());
  const graphId = getTaskManager().getTask(taskId).result.graphId;

  const response = await GET(request(`?action=data&graphId=${graphId}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.graph.graph_id, graphId);
  assert.equal('passages' in body.graph, false);
});

test('list includes only tasks in the authenticated tenant and corpus', async t => {
  configureSingleTenant('owner');
  const currentTask = createTask(t, currentScope());
  createTask(t, { ...currentScope(), tenantId: 'tenant-b' });
  createTask(t, { ...currentScope(), corpusId: 'corpus-b' });
  createTask(t, undefined);

  const response = await GET(request('?action=list'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.graphs.map(graph => graph.graphId), [
    getTaskManager().getTask(currentTask).result.graphId,
  ]);
});

test('DELETE removes a graph only from the current corpus', async t => {
  configureSingleTenant('owner');
  const currentTask = createTask(t, currentScope());
  const foreignTask = createTask(t, { ...currentScope(), corpusId: 'corpus-b' });
  const currentGraphId = getTaskManager().getTask(currentTask).result.graphId;
  const foreignGraphId = getTaskManager().getTask(foreignTask).result.graphId;

  const foreignResponse = await DELETE(request(`?graphId=${foreignGraphId}`, {
    method: 'DELETE',
  }));
  assert.equal(foreignResponse.status, 404);
  assert.ok(getTaskManager().getTask(foreignTask));

  const currentResponse = await DELETE(request(`?graphId=${currentGraphId}`, {
    method: 'DELETE',
  }));
  assert.equal(currentResponse.status, 200);
  assert.equal(getTaskManager().getTask(currentTask), null);
});

test('DELETE removes legacy raw graph cache, preserves ontology cache, and prevents readback', async t => {
  configureSingleTenant('owner');
  const taskId = createTask(t, currentScope());
  const graphId = getTaskManager().getTask(taskId).result.graphId;
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'mirofish-route-delete-'));
  const cacheDirectory = path.join(root, 'uploads', 'mirofish-cache');
  const graphCacheFile = path.join(cacheDirectory, 'graph.json');
  const ontologyCacheFile = path.join(cacheDirectory, 'ontology.json');
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(graphCacheFile, legacyCacheRecord('graph', {
    graph_id: graphId,
    passages: [{ content: 'raw private source' }],
  }));
  await writeFile(ontologyCacheFile, legacyCacheRecord('ontology', {
    entity_types: [],
    edge_types: [],
  }));

  process.chdir(root);
  try {
    const deleteResponse = await DELETE(request(`?graphId=${graphId}`, {
      method: 'DELETE',
    }));
    const readbackResponse = await GET(request(`?action=data&graphId=${graphId}`));

    assert.equal(deleteResponse.status, 200);
    assert.equal(readbackResponse.status, 404);
    await assert.rejects(readFile(graphCacheFile), { code: 'ENOENT' });
    assert.match(await readFile(ontologyCacheFile, 'utf8'), /"artifact": "ontology"/);
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('DELETE rejects a viewer before revealing whether a graph exists', async () => {
  configureSingleTenant('viewer');
  const response = await DELETE(request('?graphId=graph-secret', { method: 'DELETE' }));
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, 'RAG_CAPABILITY_FORBIDDEN');
});

test('POST rejects an oversized declared body before JSON parsing', async () => {
  configureSingleTenant('owner');
  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: {} }),
    headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
  }));
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.code, 'REQUEST_BODY_TOO_LARGE');
});

test('POST rejects unsafe graph chunking and batch sizes', async () => {
  configureSingleTenant('owner');
  const invalidChunk = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'source',
      ontology: {},
      chunkSize: 50_000,
    }),
  }));
  const invalidBatch = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'source',
      ontology: {},
      batchSize: 21,
    }),
  }));

  assert.equal(invalidChunk.status, 400);
  assert.equal((await invalidChunk.json()).code, 'INVALID_INTEGER');
  assert.equal(invalidBatch.status, 400);
  assert.equal((await invalidBatch.json()).code, 'INVALID_GRAPH_BATCH_SIZE');
});

test('graph chunk upper bound is exact at the provider-call budget boundary', () => {
  assert.equal(calculateMiroFishGraphChunkUpperBound(0, 100, 50), 0);
  assert.equal(calculateMiroFishGraphChunkUpperBound(100, 100, 50), 1);
  assert.equal(calculateMiroFishGraphChunkUpperBound(50_050, 100, 50), 1_000);
  assert.equal(calculateMiroFishGraphChunkUpperBound(50_051, 100, 50), 1_001);
});

test('POST rejects amplified graph extraction before task allocation', async () => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const taskIdsBefore = taskManager.getAllTasks().map(task => task.task_id);

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'x'.repeat(2_000_000),
      ontology: minimalOntology(),
      chunkSize: 100,
      chunkOverlap: 50,
    }),
  }));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.code, 'MIROFISH_GRAPH_PROVIDER_CALL_LIMIT');
  assert.deepEqual(
    taskManager.getAllTasks().map(task => task.task_id),
    taskIdsBefore
  );
});

test('POST admits the exact graph extraction budget boundary', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => reservedTaskId;
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'x'.repeat(50_050),
      ontology: minimalOntology(),
      chunkSize: 100,
      chunkOverlap: 50,
    }),
  }));
  const body = await response.json();
  t.after(() => taskManager.deleteTask(body.taskId));

  assert.equal(response.status, 200);
  assert.equal(typeof body.taskId, 'string');
});

test('POST rejects non-string and oversized graph names before task allocation', async () => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const taskIdsBefore = taskManager.getAllTasks().map(task => task.task_id);
  const invalidType = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'source',
      ontology: minimalOntology(),
      graphName: { private: 'metadata' },
    }),
  }));
  const oversized = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'source',
      ontology: minimalOntology(),
      graphName: 'x'.repeat(201),
    }),
  }));

  assert.equal(invalidType.status, 400);
  assert.equal((await invalidType.json()).code, 'INVALID_GRAPH_NAME');
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).code, 'INVALID_GRAPH_NAME');
  assert.deepEqual(
    taskManager.getAllTasks().map(task => task.task_id),
    taskIdsBefore
  );
});

test('POST rejects malformed ontology without allocating a graph task', async () => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const taskIdsBefore = taskManager.getAllTasks().map(task => task.task_id);

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: {} }),
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_GRAPH_ONTOLOGY');
  assert.deepEqual(
    taskManager.getAllTasks().map(task => task.task_id),
    taskIdsBefore
  );
});

test('POST rejects every client-supplied model baseUrl before builder work or task allocation', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  let builderCalls = 0;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async () => {
    builderCalls += 1;
    throw new Error('builder must not run for a client-supplied baseUrl');
  };
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const taskIdsBefore = taskManager.getAllTasks().map(task => task.task_id);
  const untrustedBaseUrls = [
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/v1',
    'http://172.16.0.1/v1',
    'http://192.168.1.1/v1',
    'http://localhost:11434',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://127.0.0.1.nip.io/v1',
    'https://api.openai.com/v1',
  ];

  for (const baseUrl of untrustedBaseUrls) {
    const response = await POST(request('', {
      method: 'POST',
      body: JSON.stringify({
        text: 'source',
        ontology: minimalOntology(),
        modelOverride: {
          provider: 'openai',
          modelName: 'gpt-test',
          baseUrl,
        },
      }),
    }));
    const body = await response.json();

    assert.equal(response.status, 400, baseUrl);
    assert.equal(body.code, 'MIROFISH_HTTP_MODEL_OVERRIDE_FORBIDDEN', baseUrl);
  }

  const credentialResponse = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'source',
      ontology: minimalOntology(),
      modelOverride: {
        provider: 'openai',
        modelName: 'gpt-test',
        apiKey: 'must-not-be-used',
      },
    }),
  }));
  assert.equal(credentialResponse.status, 400);
  assert.equal(
    (await credentialResponse.json()).code,
    'MIROFISH_HTTP_MODEL_OVERRIDE_FORBIDDEN'
  );

  assert.equal(builderCalls, 0);
  assert.deepEqual(
    taskManager.getAllTasks().map(task => task.task_id),
    taskIdsBefore
  );
});

test('POST keeps model overrides without baseUrl compatible with server-selected endpoints', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  let builderCalls = 0;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => {
    builderCalls += 1;
    return reservedTaskId;
  };
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({
      text: 'source',
      ontology: minimalOntology(),
      modelOverride: {
        provider: 'openai',
        modelName: 'gpt-test',
      },
    }),
  }));
  const body = await response.json();
  t.after(() => taskManager.deleteTask(body.taskId));

  assert.equal(response.status, 200);
  assert.equal(builderCalls, 1);
});

test('POST enforces the active graph-job limit within the authenticated scope', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const taskIds = Array.from({ length: 4 }, () => {
    const taskId = taskManager.createTask(
      'graph_build',
      createMiroFishGraphTaskScopeMetadata(currentScope())
    );
    t.after(() => taskManager.deleteTask(taskId));
    return taskId;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
  }));
  const body = await response.json();

  assert.equal(taskIds.length, 4);
  assert.equal(response.status, 429);
  assert.equal(body.code, 'MIROFISH_GRAPH_ACTIVE_JOB_LIMIT');
});

test('POST atomically caps concurrent graph-job admissions within one scope', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  let admittedBuilders = 0;
  let releaseBuilders;
  const builderBarrier = new Promise(resolve => {
    releaseBuilders = resolve;
  });
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => {
    admittedBuilders += 1;
    if (admittedBuilders === 4) {
      releaseBuilders();
    }
    await builderBarrier;
    return reservedTaskId;
  };
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => POST(request('', {
      method: 'POST',
      body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
    })))
  );
  const bodies = await Promise.all(responses.map(response => response.json()));
  for (const body of bodies) {
    if (typeof body.taskId === 'string') {
      t.after(() => taskManager.deleteTask(body.taskId));
    }
  }

  assert.equal(responses.filter(response => response.status === 200).length, 4);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(
    bodies.filter(body => body.code === 'MIROFISH_GRAPH_ACTIVE_JOB_LIMIT').length,
    1
  );
  assert.equal(admittedBuilders, 4);
});

test('POST does not count active jobs from a foreign scope', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  for (let index = 0; index < 4; index += 1) {
    const taskId = taskManager.createTask(
      'graph_build',
      createMiroFishGraphTaskScopeMetadata({
        ...currentScope(),
        corpusId: 'corpus-b',
      })
    );
    t.after(() => taskManager.deleteTask(taskId));
  }

  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => reservedTaskId;
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
  }));
  const body = await response.json();
  t.after(() => taskManager.deleteTask(body.taskId));

  assert.equal(response.status, 200);
});

test('POST keeps terminal graph retention bounded within the current scope', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const seededTaskIds = Array.from({ length: 21 }, () => createTask(t, currentScope()));
  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => reservedTaskId;
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
  }));
  const body = await response.json();
  t.after(() => taskManager.deleteTask(body.taskId));

  const retainedTerminalTasks = taskManager.getAllTasks().filter(candidate =>
    candidate.task_type === 'graph_build'
    && candidate.status === 'completed'
    && candidate.metadata?.ragScope?.tenantId === 'tenant-a'
    && candidate.metadata?.ragScope?.corpusId === 'corpus-a'
  );
  assert.equal(response.status, 200);
  assert.equal(seededTaskIds.length, 21);
  assert.equal(retainedTerminalTasks.length, 20);
});

test('POST globally reclaims terminal graph tasks without deleting active work', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const terminalTaskIds = Array.from({ length: 120 }, (_, index) => createTask(t, {
    ...currentScope(),
    tenantId: `terminal-foreign-tenant-${index}`,
    corpusId: `terminal-foreign-corpus-${index}`,
  }));
  const activeTaskId = taskManager.createTask(
    'graph_build',
    createMiroFishGraphTaskScopeMetadata({
      ...currentScope(),
      tenantId: 'active-retention-tenant',
      corpusId: 'active-retention-corpus',
    })
  );
  t.after(() => taskManager.deleteTask(activeTaskId));

  const originalBuild = MiroFishGraphBuilder.prototype.buildGraphAsync;
  MiroFishGraphBuilder.prototype.buildGraphAsync = async (
    _request,
    _onProgress,
    _taskMetadata,
    reservedTaskId
  ) => reservedTaskId;
  t.after(() => {
    MiroFishGraphBuilder.prototype.buildGraphAsync = originalBuild;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
  }));
  const body = await response.json();
  t.after(() => taskManager.deleteTask(body.taskId));

  const retainedTerminalTasks = taskManager.getAllTasks().filter(candidate =>
    candidate.task_type === 'graph_build'
    && (candidate.status === 'completed' || candidate.status === 'failed')
  );
  assert.equal(response.status, 200);
  assert.equal(terminalTaskIds.length, 120);
  assert.equal(retainedTerminalTasks.length, 100);
  assert.notEqual(taskManager.getTask(activeTaskId), null);
});

test('POST applies a process-wide hard cap without deleting foreign tasks', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const foreignTaskIds = Array.from({ length: 200 }, (_, index) => {
    const taskId = taskManager.createTask(
      'graph_build',
      createMiroFishGraphTaskScopeMetadata({
        ...currentScope(),
        tenantId: `foreign-tenant-${index}`,
        corpusId: `foreign-corpus-${index}`,
      })
    );
    t.after(() => taskManager.deleteTask(taskId));
    return taskId;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
  }));
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(body.code, 'MIROFISH_GRAPH_GLOBAL_TASK_LIMIT');
  assert.equal(
    foreignTaskIds.every(taskId => taskManager.getTask(taskId) !== null),
    true
  );
});

test('POST enforces a process-wide active worker cap across foreign scopes', async t => {
  configureSingleTenant('owner');
  const taskManager = getTaskManager();
  const foreignTaskIds = Array.from({ length: 16 }, (_, index) => {
    const taskId = taskManager.createTask(
      'graph_build',
      createMiroFishGraphTaskScopeMetadata({
        ...currentScope(),
        tenantId: `active-foreign-tenant-${index}`,
        corpusId: `active-foreign-corpus-${index}`,
      })
    );
    t.after(() => taskManager.deleteTask(taskId));
    return taskId;
  });

  const response = await POST(request('', {
    method: 'POST',
    body: JSON.stringify({ text: 'source', ontology: minimalOntology() }),
  }));
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(body.code, 'MIROFISH_GRAPH_GLOBAL_ACTIVE_JOB_LIMIT');
  assert.equal(
    foreignTaskIds.every(taskId => taskManager.getTask(taskId) !== null),
    true
  );
});

function createTask(t, scope) {
  const taskManager = getTaskManager();
  const metadata = scope === undefined
    ? undefined
    : scope === null
      ? { ragScope: { tenantId: 'tenant-a', corpusId: 'corpus-a' } }
      : createMiroFishGraphTaskScopeMetadata(scope);
  const taskId = taskManager.createTask('graph_build', metadata);
  taskManager.completeTask(taskId, {
    graphId: `graph-${taskId}`,
    graphData: graph(`graph-${taskId}`),
  });
  t.after(() => taskManager.deleteTask(taskId));
  return taskId;
}

function graph(graphId) {
  return {
    graph_id: graphId,
    nodes: [],
    edges: [],
    node_count: 0,
    edge_count: 0,
    artifact_version: 'mirofish-graph-v2',
    passages: [{
      id: 'private-passage',
      document_id: graphId,
      content: 'private source text',
      index: 0,
      start_offset: 0,
      end_offset: 19,
    }],
  };
}

function minimalOntology() {
  return { entity_types: [], edge_types: [] };
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

function currentScope() {
  return {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    actorId: 'actor-a',
    enforceIsolation: true,
  };
}

function request(search = '', options = {}) {
  const headers = new Headers({
    'x-request-id': 'graph-api-test',
    ...options.headers,
  });
  if (options.authenticated !== false) {
    headers.set('authorization', 'Bearer graph-secret');
  }
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new NextRequest(`http://localhost/api/mirofish/graph${search}`, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
}

function configureSingleTenant(role) {
  process.env.RAG_ACCESS_MODE = 'single-tenant-token';
  delete process.env.RAG_AUTH_MODE;
  process.env.RAG_SINGLE_TENANT_TOKEN = 'graph-secret';
  process.env.RAG_SINGLE_TENANT_ROLE = role;
  process.env.RAG_SINGLE_TENANT_ACTOR_ID = 'actor-a';
  process.env.SUPABASE_DEFAULT_TENANT_ID = 'tenant-a';
  process.env.SUPABASE_DEFAULT_CORPUS_ID = 'corpus-a';
}

function captureEnvironment(keys) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
