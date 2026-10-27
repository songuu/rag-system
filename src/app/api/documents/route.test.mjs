import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const asModule = source => ({ shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(source) });
globalThis.documentMutationCalls = [];
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/documents/postgres-document-lifecycle-store') return asModule(`
    export class PostgresDocumentLifecycleStore {
      async setEnabled(input) { globalThis.documentMutationCalls.push(['toggle', input]); }
      async beginDelete(input) { globalThis.documentMutationCalls.push(['block', input]); return { id: input.id, documentId: 'doc-1', lifecycle: 'active', metadata: {} }; }
      async completeDelete(input) { globalThis.documentMutationCalls.push(['complete', input]); }
    }
  `);
  if (specifier === '@/lib/documents/document-lifecycle-runtime') return asModule(`
    import { PostgresDocumentLifecycleStore } from '@/lib/documents/postgres-document-lifecycle-store';
    export function createDocumentDeletionPorts() { return {
      store: new PostgresDocumentLifecycleStore(),
      deleteVectors: async (_document, scope) => { globalThis.documentMutationCalls.push(['vectors', scope]); },
      deleteLexical: async () => {}, deleteAssets: async () => {},
    }; }
  `);
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, context);
  if (specifier.startsWith('.')) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(target) && existsSync(new URL(target.href + '.ts'))) return next(target.href + '.ts', context);
  }
  return next(specifier, context);
} });
const { PATCH, DELETE } = await import('./route.ts');
const request = (method, body, headers = {}) => new Request('http://localhost/api/documents', { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function local(work) {
  const values = { NODE_ENV: 'development', RAG_ACCESS_MODE: 'local-dev', RAG_DEFAULT_TENANT_ID: 'tenant-a', RAG_DEFAULT_CORPUS_ID: 'corpus-a', RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_SINGLE_TENANT_TOKEN: 'document-lifecycle-fixture-token' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values); globalThis.documentMutationCalls = [];
  try { await work(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('PATCH persists false and DELETE forces server scope even in local compatibility mode', async () => local(async () => {
  const response = await PATCH(request('PATCH', { id: 'asset-1', enabled: false }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, false);
  assert.equal(globalThis.documentMutationCalls[0][1].enabled, false);
  assert.deepEqual(globalThis.documentMutationCalls[0][1].scope, { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['trusted', 'reviewed', 'external'], enforceIsolation: true });
  assert.equal((await DELETE(request('DELETE', { id: 'asset-1' }))).status, 200);
  assert.deepEqual(globalThis.documentMutationCalls.map(call => call[0]), ['toggle', 'block', 'vectors', 'complete']);
}));

test('mutations reject forged scope and malformed JSON before storage I/O', async () => local(async () => {
  assert.equal((await PATCH(request('PATCH', { id: 'asset-1', enabled: 'false' }))).status, 400);
  assert.equal((await DELETE(request('DELETE', { id: 'asset-1', tenantId: 'other' }))).status, 400);
  assert.equal((await PATCH(new Request('http://localhost/api/documents', { method: 'PATCH', body: '{' }))).status, 400);
  assert.deepEqual(globalThis.documentMutationCalls, []);
}));

test('production rejects unauthenticated mutations before storage I/O', async () => local(async () => {
  process.env.NODE_ENV = 'production';
  assert.ok((await PATCH(request('PATCH', { id: 'asset-1', enabled: true }))).status >= 400);
  assert.ok((await DELETE(request('DELETE', { id: 'asset-1' }))).status >= 400);
  assert.deepEqual(globalThis.documentMutationCalls, []);
}));

test('authenticated viewers cannot mutate documents and missing authentication returns 401', async () => local(async () => {
  process.env.NODE_ENV = 'production';
  process.env.RAG_ACCESS_MODE = 'single-tenant-token';
  assert.equal((await PATCH(request('PATCH', { id: 'asset-1', enabled: true }))).status, 401);
  const headers = { Authorization: 'Bearer document-lifecycle-fixture-token' };
  assert.equal((await PATCH(request('PATCH', { id: 'asset-1', enabled: true }, headers))).status, 403);
  assert.equal((await DELETE(request('DELETE', { id: 'asset-1' }, headers))).status, 403);
  assert.deepEqual(globalThis.documentMutationCalls, []);
}));
