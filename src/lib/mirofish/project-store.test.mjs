import assert from 'node:assert/strict';
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

const { PostgresMiroFishProjectStore } = await import('./project-store.ts');

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
  };
}

function project(overrides = {}) {
  return {
    id: 'proj_00000000-0000-4000-8000-000000000001',
    name: 'Persistent project',
    description: '',
    status: 'created',
    current_step: 0,
    simulation_requirement: 'simulate',
    texts: [],
    created_at: '2026-09-09T00:00:00.000Z',
    updated_at: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

test('PostgreSQL project CRUD is isolated by tenant and corpus', async () => {
  const saved = project();
  const client = fakeClient([
    { rows: [{ project_data: saved }], rowCount: 1 },
    { rows: [{ project_data: saved }], rowCount: 1 },
    { rows: [{ project_data: saved }], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const store = new PostgresMiroFishProjectStore(client, {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
  });

  assert.equal((await store.create({ name: 'Persistent project', simulation_requirement: 'simulate' })).id, saved.id);
  assert.equal((await store.get(saved.id))?.name, saved.name);
  assert.equal((await store.update(saved.id, { current_step: 1 }))?.current_step, 0);
  assert.equal(await store.delete(saved.id), true);

  for (const call of client.calls) {
    assert.deepEqual(call.values.slice(0, 2), ['tenant-a', 'corpus-a']);
  }
  assert.match(client.calls[0].text, /insert into public\.mirofish_projects/i);
  assert.match(client.calls[1].text, /tenant_id = \$1 and corpus_id = \$2/i);
  assert.match(client.calls[2].text, /project_data \|\|/i);
  assert.match(client.calls[3].text, /delete from public\.mirofish_projects/i);
});

test('project reset removes generated workflow state in PostgreSQL', async () => {
  const client = fakeClient([{
    rows: [{ project_data: project({ status: 'created' }) }],
    rowCount: 1,
  }]);
  const store = new PostgresMiroFishProjectStore(client, {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
  });

  await store.reset(project().id);

  assert.match(client.calls[0].text, /project_data - array\[/i);
  assert.match(client.calls[0].text, /ontology/i);
  assert.match(client.calls[0].text, /graph_data/i);
});
