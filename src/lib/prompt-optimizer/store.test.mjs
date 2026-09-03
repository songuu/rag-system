import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });

const { PostgresPromptOptimizerStore } = await import('./store.ts');

const config = {
  databaseUrl: 'postgresql://test', defaultTenantId: 'tenant-a', defaultCorpusId: 'corpus-a',
  sslMode: 'disable', maxConnections: 2, idleTimeoutMs: 1000, connectionTimeoutMs: 1000,
  persistenceBackend: 'postgres', vectorBackend: 'milvus',
};

test('appendVersion atomically increments workspace and inserts an immutable version', async () => {
  const calls = [];
  const client = { async query(text, values) {
    calls.push({ text, values });
    return { rows: [{ workspace_id: 'ws-1', version_number: 3, prompt: 'optimized' }], rowCount: 1 };
  } };
  const store = new PostgresPromptOptimizerStore(config, client);
  const saved = await store.appendVersion({
    workspaceId: 'ws-1', kind: 'optimized', prompt: 'optimized', instruction: '',
    analysis: { summary: 'clear', improvements: [] }, variables: {}, modelProfileId: null,
    templateId: 'general-v1', expectedCurrentVersion: 2,
  });
  assert.equal(saved.versionNumber, 3);
  assert.match(calls[0].text, /with advanced as[\s\S]*update public\.prompt_optimizer_workspaces/i);
  assert.match(calls[0].text, /insert into public\.prompt_optimizer_versions/i);
  assert.match(calls[0].text, /current_version = \$4/i);
  assert.deepEqual(calls[0].values.slice(0, 4), ['tenant-a', 'corpus-a', 'ws-1', 2]);
  assert.equal(calls[0].values[4], 2);
});

test('appendVersion can branch from an older parent while CAS protects the current head', async () => {
  const calls = [];
  const store = new PostgresPromptOptimizerStore(config, { async query(text, values) {
    calls.push({ text, values });
    return { rows: [{ workspace_id: 'ws-1', version_number: 5, parent_version: 1, kind: 'iterated', prompt: 'branch', instruction: null, analysis: {}, variables_snapshot: {}, model_profile_id: null, template_id: 'general-v1', created_at: new Date(0) }], rowCount: 1 };
  } });
  const saved = await store.appendVersion({ workspaceId: 'ws-1', kind: 'iterated', prompt: 'branch', instruction: '', analysis: {}, variables: {}, modelProfileId: null, templateId: 'general-v1', expectedCurrentVersion: 4, parentVersion: 1 });
  assert.equal(saved.parentVersion, 1);
  assert.deepEqual(calls[0].values.slice(3, 6), [4, 1, 'iterated']);
});

test('appendVersion reports optimistic concurrency conflicts without leaking SQL', async () => {
  const store = new PostgresPromptOptimizerStore(config, { async query() { return { rows: [], rowCount: 0 }; } });
  await assert.rejects(() => store.appendVersion({
    workspaceId: 'ws-1', kind: 'manual', prompt: 'draft', instruction: '', analysis: {}, variables: {},
    modelProfileId: null, templateId: 'general-v1', expectedCurrentVersion: 4,
  }), /workspace version conflict/i);
});

test('listVersions keeps tenant and corpus scope in parameterized SQL', async () => {
  const calls = [];
  const store = new PostgresPromptOptimizerStore(config, { async query(text, values) {
    calls.push({ text, values }); return { rows: [], rowCount: 0 };
  } });
  await store.listVersions('ws-1');
  assert.match(calls[0].text, /tenant_id = \$1 and corpus_id = \$2 and workspace_id = \$3/i);
  assert.deepEqual(calls[0].values, ['tenant-a', 'corpus-a', 'ws-1']);
});
