import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const postgresStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let readiness = { connected: true, schemaReady: true };
export function setReadiness(value) { readiness = value; }
export async function checkPostgresReadiness() { return readiness; }
`);
const postgresEnvStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getPostgresRuntimeConfig() {
  return { persistenceBackend: 'postgres', databaseUrl: 'postgres://redacted' };
}
export function shouldUsePostgresPersistence() { return true; }
export function assertPostgresPersistenceConfigured() {}
export function getPostgresConfigSummary() {
  return { persistenceBackend: 'postgres', configured: true, persistenceReady: true };
}
`);
const modelStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getConfigSummary() { return { provider: 'test', llmModel: 'llm-test' }; }
`);
const embeddingStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getEmbeddingConfigSummary() {
  return { provider: 'test', model: 'embedding-test', dimension: 8 };
}
`);
const ragStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function getRagSystem() {
  return { getStatus: () => ({ initialized: true, documentCount: 2, embeddingDimension: 8 }) };
}
`);
const vectorStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function isVectorBackendDisabled() { return true; }
export function resolveRagVectorBackend() { return 'disabled'; }
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = new Map([
      ['@/lib/postgres/client', postgresStubUrl],
      ['@/lib/postgres/env', postgresEnvStubUrl],
      ['@/lib/model-config', modelStubUrl],
      ['@/lib/embedding-config', embeddingStubUrl],
      ['@/lib/rag-instance', ragStubUrl],
      ['@/lib/rag/vector-backend', vectorStubUrl],
    ]);
    if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(modulePath + '.ts')
        ? modulePath + '.ts'
        : path.join(modulePath, 'index.ts');
      return nextResolve(pathToFileURL(target).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { GET } = await import('./route.ts');
const { setReadiness } = await import(postgresStubUrl);

test('readiness returns 503 when PostgreSQL schema is not ready', async () => {
  setReadiness({ connected: true, schemaReady: false });
  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.status, 'not_ready');
  assert.deepEqual(body.persistence, {
    backend: 'postgres',
    connected: true,
    schemaReady: false,
  });
  assert.equal(JSON.stringify(body).includes('postgres://redacted'), false);
});

test('readiness reports PostgreSQL state when the schema is ready', async () => {
  setReadiness({ connected: true, schemaReady: true });
  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.persistence, {
    backend: 'postgres',
    connected: true,
    schemaReady: true,
  });
});
