import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', `${specifier.slice(2)}.ts`)).href, context);
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

process.env.RAG_PERSISTENCE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
const { NextRequest } = await import('next/server');
const { getProjectStore } = await import('@/lib/mirofish/project-store');
const { GET, PUT, POST, DELETE } = await import('./[id]/route.ts');
const { getMiroFishRuntimeStore } = await import('@/lib/mirofish/runtime-store');

test('project API persists, validates and clears graph task recovery state', async () => {
  const store = getProjectStore();
  const project = await store.create({ name: 'Recovery test', simulation_requirement: 'test' });
  const context = { params: Promise.resolve({ id: project.id }) };
  const taskId = 'task_00000000-0000-4000-8000-000000000001';
  const put = value => PUT(new NextRequest(`http://localhost/api/mirofish/project/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ graph_task_id: value }),
  }), context);
  try {
    assert.equal((await put(taskId)).status, 200);
    assert.equal((await store.get(project.id)).graph_task_id, taskId);
    for (const invalid of [123, {}, 'task_not-a-uuid', 'task_------------------------------------']) {
      assert.equal((await put(invalid)).status, 400);
      assert.equal((await store.get(project.id)).graph_task_id, taskId);
    }
    assert.equal((await put(null)).status, 200);
    assert.equal((await store.get(project.id)).graph_task_id, null);
    await put(taskId);
    await store.reset(project.id);
    assert.equal((await store.get(project.id)).graph_task_id, undefined);
  } finally { await store.delete(project.id); }
});

test('project state preserves seed provenance and exact graph/prepare identity with strict validation', async () => {
  const store = getProjectStore();
  const project = await store.create({ name: 'Provenance', simulation_requirement: 'test' });
  const context = { params: Promise.resolve({ id: project.id }) };
  const put = updates => PUT(new NextRequest(`http://localhost/api/mirofish/project/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates),
  }), context);
  const identity = { documentId: 'graph-a', documentVersion: 'v-a', trustLevel: 'external', graphGeneration: 'generation-a' };
  try {
    assert.equal((await put({ seed_files: [{ filename: 'research.md', size: 30, encoding: 'utf-8' }], graph_id: 'graph-a',
      graph_identity: identity, prepare_task_id: 'prepare-a', selected_entity_ids: ['node-a'] })).status, 200);
    assert.deepEqual((await store.get(project.id)).graph_identity, identity);
    for (const invalid of [
      { seed_files: [{ filename: '../private.txt', size: 1 }] },
      { seed_files: [{ filename: 'large.txt', size: 51 * 1024 * 1024 }] },
      { graph_identity: { ...identity, tenantId: 'foreign' } },
      { graph_identity: identity, graph_id: 'different-graph' },
      { prepare_task_id: '../escape' }, { selected_entity_ids: ['duplicate', 'duplicate'] },
    ]) assert.equal((await put(invalid)).status, 400);
    await store.reset(project.id);
    const reset = await store.get(project.id);
    assert.equal(reset.graph_identity, undefined);
    assert.equal(reset.prepare_task_id, undefined);
    assert.equal(reset.seed_files[0].filename, 'research.md');
  } finally { await store.delete(project.id); }
});

test('project API rejects a requested foreign corpus and local project stores are scoped', async () => {
  const local = getProjectStore();
  const project = await local.create({ name: 'Scoped', simulation_requirement: 'test' });
  try {
    const response = await GET(new NextRequest('http://localhost/api/mirofish/project/' + project.id,
      { headers: { 'x-rag-corpus-id': 'foreign-corpus' } }), { params: Promise.resolve({ id: project.id }) });
    assert.equal(response.status, 403);
    assert.equal(await getProjectStore({ tenantId: 'foreign-tenant', corpusId: 'foreign-corpus' }).get(project.id), null);
  } finally { await local.delete(project.id); }
});

test('project reset/delete rejects paused consumers and recovers abandoned report/preparation jobs', async () => {
  const store = getProjectStore(); const runtime = getMiroFishRuntimeStore();
  const project = await store.create({ name: 'Lifecycle', simulation_requirement: 'test' });
  const context = { params: Promise.resolve({ id: project.id }) };
  const reset = () => POST(new NextRequest(`http://localhost/api/mirofish/project/${project.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset' }),
  }), context);
  try {
    await store.update(project.id, { texts: ['retained source'], seed_files: [{ filename: 'seed.txt', size: 15 }], current_step: 2 });
    await runtime.write('simulation', 'lifecycle-run', { info: { status: 'paused' } }, { projectId: project.id });
    assert.equal((await reset()).status, 409);
    assert.equal((await DELETE(new NextRequest('http://localhost/api/mirofish/project/' + project.id, { method: 'DELETE' }), context)).status, 409);
    await runtime.delete('simulation', 'lifecycle-run');
    await runtime.write('report', 'lifecycle-report', { report_id: 'lifecycle-report', project_id: project.id, status: 'generating', events: [] }, { projectId: project.id });
    await runtime.write('prepare', 'lifecycle-prepare', { id: 'lifecycle-prepare', projectId: project.id, status: 'processing' }, { projectId: project.id });
    assert.equal((await reset()).status, 200);
    const reloaded = await store.get(project.id);
    assert.equal(reloaded.current_step, 0);
    assert.deepEqual(reloaded.texts, ['retained source']);
    assert.equal(reloaded.seed_files[0].filename, 'seed.txt');
    assert.equal((await runtime.read('report', 'lifecycle-report')).status, 'failed');
    assert.equal((await runtime.read('prepare', 'lifecycle-prepare')).status, 'failed');
  } finally {
    for (const [kind,id] of [['simulation','lifecycle-run'],['report','lifecycle-report'],['prepare','lifecycle-prepare']]) await runtime.delete(kind,id);
    await store.delete(project.id);
  }
});
