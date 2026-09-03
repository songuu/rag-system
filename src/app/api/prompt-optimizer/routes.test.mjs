import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname);
const route = (...parts) => readFile(path.join(root, ...parts, 'route.ts'), 'utf8');

test('every prompt optimizer route resolves the standard security context', async () => {
  const sources = await Promise.all([
    route('templates'), route('models'), route('workspaces'), route('workspaces', '[workspaceId]'),
    route('workspaces', '[workspaceId]', 'versions'), route('optimize'),
  ]);
  for (const source of sources) assert.match(source, /resolveRagSecurityContext\(request/);
});

test('route capabilities separate reads, content writes, and runtime management', async () => {
  assert.match(await route('models'), /GET[\s\S]*capability: 'query'[\s\S]*POST[\s\S]*capability: 'manage-runtime'/);
  assert.match(await route('workspaces', '[workspaceId]', 'versions'), /GET[\s\S]*capability: 'query'[\s\S]*POST[\s\S]*capability: 'ingest'/);
  assert.match(await route('optimize'), /capability: 'ingest'/);
});

test('security scope is injected into every persistent store or service', async () => {
  for (const source of await Promise.all([route('models'), route('workspaces'), route('workspaces', '[workspaceId]'), route('workspaces', '[workspaceId]', 'versions'), route('optimize')])) {
    assert.match(source, /(PostgresPromptOptimizerStore\(undefined, undefined, (context|securityContext)\)|getPromptOptimizerService\(context\))/);
  }
});

test('browser client uses the nginx-authenticated /rag-api path and separates lineage from CAS', async () => {
  const client = await readFile(path.resolve(root, '..', '..', '..', 'components', 'prompt-optimizer', 'PromptOptimizerStudio.tsx'), 'utf8');
  assert.match(client, /const API_ROOT = '\/rag-api\/prompt-optimizer'/);
  assert.doesNotMatch(client, /NEXT_PUBLIC_BASE_PATH[^\n]*\/api\/prompt-optimizer/);
  assert.match(client, /parentVersion: iterate \? activeVersion\?\.versionNumber/);
  assert.match(client, /expectedCurrentVersion: workspace\?\.current_version/);
  assert.match(client, /setInstruction\(latest\?\.instruction \|\| ''\)/);
});
