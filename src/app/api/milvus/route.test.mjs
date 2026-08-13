import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const milvusStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getMilvusInstance() {
  throw new Error('Milvus must not be constructed while maintenance is enabled.');
}
export function resetMilvusInstance() {}
export function getModelDimension() { return 1024; }
`);
const vectorizationStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export class DocumentInput {}
export function getEmbeddingModel() { return 'test-embedding'; }
export async function generateQueryEmbedding() {
  throw new Error('Embedding must not run while maintenance is enabled.');
}
export function selectModelForCollection() { return 'test-embedding'; }
export async function vectorizeAndInsert() {
  throw new Error('Vector insertion must not run while maintenance is enabled.');
}
`);
const milvusConfigStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getMilvusConnectionConfig() { return {}; }
export function getMilvusConfigSummary() { return {}; }
export function getMilvusProvider() { return 'local'; }
export function isZillizCloud() { return false; }
`);
const embeddingConfigStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export function getEmbeddingConfigSummary() {
  return { provider: 'test', model: 'test-embedding', dimension: 1024 };
}
`);
const moduleStubs = new Map([
  ['@/lib/milvus-client', milvusStubUrl],
  ['@/lib/vectorization-utils', vectorizationStubUrl],
  ['@/lib/milvus-config', milvusConfigStubUrl],
  ['@/lib/embedding-config', embeddingConfigStubUrl],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (moduleStubs.has(specifier)) {
      return { url: moduleStubs.get(specifier), shortCircuit: true };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(`${modulePath}.ts`)
        ? `${modulePath}.ts`
        : path.join(modulePath, 'index.ts');
      return nextResolve(pathToFileURL(target).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const environmentKeys = [
  'RAG_ACCESS_MODE',
  'RAG_SINGLE_TENANT_TOKEN',
  'RAG_SINGLE_TENANT_ROLE',
  'RAG_SINGLE_TENANT_ACTOR_ID',
  'RAG_DEFAULT_TENANT_ID',
  'RAG_DEFAULT_CORPUS_ID',
  'RAG_TENANT_ISOLATION_REQUIRED',
  'RAG_VECTOR_BACKEND',
];
const originalEnvironment = Object.fromEntries(
  environmentKeys.map(key => [key, process.env[key]])
);
Object.assign(process.env, {
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'milvus-route-token',
  RAG_SINGLE_TENANT_ROLE: 'owner',
  RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a',
  RAG_DEFAULT_TENANT_ID: 'tenant-a',
  RAG_DEFAULT_CORPUS_ID: 'corpus-a',
  RAG_TENANT_ISOLATION_REQUIRED: 'true',
  RAG_VECTOR_BACKEND: 'disabled',
});

const { NextRequest } = await import('next/server');
const { GET, POST } = await import('./route.ts');

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('Milvus API reports maintenance without connecting and blocks mutations', async () => {
  const headers = {
    authorization: 'Bearer milvus-route-token',
    'x-rag-corpus-id': 'corpus-a',
  };
  const statusResponse = await GET(new NextRequest(
    'http://localhost/api/milvus?action=status',
    { headers }
  ));
  const status = await statusResponse.json();

  assert.equal(statusResponse.status, 200);
  assert.equal(status.success, true);
  assert.equal(status.connected, false);
  assert.equal(status.disabled, true);
  assert.equal(status.config.provider, 'disabled');

  const mutationResponse = await POST(new NextRequest('http://localhost/api/milvus', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      'x-request-id': 'milvus-route-maintenance-test',
    },
    body: JSON.stringify({ action: 'health', corpusId: 'corpus-a' }),
  }));
  const mutation = await mutationResponse.json();

  assert.equal(mutationResponse.status, 503);
  assert.equal(mutation.success, false);
  assert.equal(mutation.code, 'VECTOR_BACKEND_DISABLED');
  assert.equal(mutation.requestId, 'milvus-route-maintenance-test');
});
