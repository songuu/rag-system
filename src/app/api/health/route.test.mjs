import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

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
let currentStatus;
export function setCurrentStatus(value) { currentStatus = value; }
export function getCurrentRagSystem() {
  return currentStatus ? { getStatus: () => currentStatus } : undefined;
}
export async function getRagSystem() {
  globalThis.healthLegacyInitializations = (globalThis.healthLegacyInitializations ?? 0) + 1;
  return { getStatus: () => ({ initialized: true, documentCount: 2, embeddingDimension: 8 }) };
}
`);
const vectorStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let backend = 'disabled';
export function setBackend(value) { backend = value; }
export function setDisabled(value) { backend = value ? 'disabled' : 'hybrid'; }
export function isVectorBackendDisabled() { return backend === 'disabled'; }
export function resolveRagVectorBackend() { return backend; }
`);
const elasticsearchClientStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let readiness = { mode: 'off', connected: null, indexReady: null, indexName: 'rag_chunks_v1' };
export function setElasticsearchReadiness(value) { readiness = value; }
export async function checkElasticsearchReadiness() {
  globalThis.healthLegacyIndexChecks = (globalThis.healthLegacyIndexChecks ?? 0) + 1;
  return readiness;
}
`);
const elasticsearchConfigStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getElasticsearchRuntimeConfig() { return { mode: 'off' }; }
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
      ['@/lib/elasticsearch/client', elasticsearchClientStubUrl],
      ['@/lib/elasticsearch/config', elasticsearchConfigStubUrl],
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
const { setCurrentStatus } = await import(ragStubUrl);
const { setDisabled, setBackend } = await import(vectorStubUrl);
const { setElasticsearchReadiness } = await import(elasticsearchClientStubUrl);

test('cold hybrid readiness remains not ready without initializing RAG, including concurrent probes', async () => {
  setReadiness({ connected: true, schemaReady: true });
  setDisabled(false);
  setCurrentStatus(undefined);
  globalThis.healthLegacyInitializations = 0;
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => GET()));
    for (const response of responses) {
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.success, false);
      assert.equal(body.status, 'not_ready');
      assert.deepEqual(body.ragSystem, { initialized: false, documentCount: 0, embeddingDimension: 8 });
      assert.equal(body.vectorBackend.disabled, false);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(globalThis.healthLegacyInitializations, 0);
  } finally { setDisabled(true); }
});

test('Milvus and Zilliz control-plane readiness never depends on an unused local corpus', async () => {
  setReadiness({ connected: true, schemaReady: true });
  setCurrentStatus(undefined);
  globalThis.healthLegacyInitializations = 0;
  try {
    for (const backend of ['milvus', 'zilliz']) {
      setBackend(backend);
      const response = await GET();
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.status, 'control_plane_ready');
      assert.equal(body.ragSystem.initialized, false);
      assert.equal(body.vectorBackend.backend, backend);
      assert.equal(globalThis.healthLegacyInitializations, 0);
    }
  } finally { setDisabled(true); }
});

test('readiness reports an existing instance without starting or restarting its initialization', async () => {
  setReadiness({ connected: true, schemaReady: true });
  setDisabled(false);
  globalThis.healthLegacyInitializations = 0;
  try {
    for (const initialized of [false, true]) {
      const status = { initialized, documentCount: 7, embeddingDimension: 16 };
      setCurrentStatus(status);
      const response = await GET();
      const body = await response.json();
      assert.equal(response.status, initialized ? 200 : 503);
      assert.equal(body.success, initialized);
      assert.deepEqual(body.ragSystem, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(globalThis.healthLegacyInitializations, 0);
  } finally { setDisabled(true); setCurrentStatus(undefined); }
});

test('an initialized instance cannot hide a failed active Elasticsearch dependency', async () => {
  setReadiness({ connected: true, schemaReady: true });
  setDisabled(false);
  setCurrentStatus({ initialized: true, documentCount: 7, embeddingDimension: 16 });
  setElasticsearchReadiness({ mode: 'active', connected: true, indexReady: false });
  try {
    const response = await GET();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'not_ready');
  } finally {
    setDisabled(true); setCurrentStatus(undefined);
    setElasticsearchReadiness({ mode: 'off', connected: null, indexReady: null, indexName: 'rag_chunks_v1' });
  }
});

test('Docker liveness calls only the lightweight endpoint for root and subpath deployments', async () => {
  const dockerfile = readFileSync(path.resolve('Dockerfile'), 'utf8');
  const script = dockerfile.match(/CMD node -e "([^"\r\n]+)"/)?.[1];
  assert.ok(script, 'Docker must provide an executable liveness probe');
  for (const base of ['', '/rag-system']) {
    let requested;
    const exitCode = await new Promise(resolve => {
      runInNewContext(script, {
        process: { env: { PORT: '4321', RAG_BASE_PATH: base }, exit: resolve },
        fetch: async url => { requested = url; return { ok: true }; },
        AbortSignal,
      });
    });
    assert.equal(exitCode, 0);
    assert.equal(requested, `http://127.0.0.1:4321${base}/api/health/live`);
  }
});

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

test('active publication health checks its control plane without opening legacy indexes', async () => {
  const previous = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  globalThis.healthLegacyIndexChecks = 0;
  globalThis.healthLegacyInitializations = 0;
  try {
    setReadiness({ connected: true, schemaReady: true });
    const result = await GET();
    const body = await result.json();
    assert.equal(result.status, 200);
    assert.equal(body.publication.mode, 'active');
    assert.equal(body.publication.check, 'control-plane');
    assert.equal(globalThis.healthLegacyIndexChecks, 0);
    assert.equal(globalThis.healthLegacyInitializations, 0);
    setReadiness({ connected: true, schemaReady: false });
    const notReady = await GET();
    assert.equal(notReady.status, 503);
    assert.equal((await notReady.json()).publication.mode, 'active');
  } finally {
    if (previous === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE;
    else process.env.RAG_UNIFIED_PUBLICATION_MODE = previous;
  }
});
