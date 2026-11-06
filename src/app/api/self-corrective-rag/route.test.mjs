import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const routeUrl = new URL('./route.ts', import.meta.url).href;
const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  '@/lib/security/legacy-route-policy': 'export function createLegacyRagRouteResponse() {}',
  '@/lib/security/unified-publication-write-guard': 'export function getUnifiedPublicationWriteBlock() {}',
  '@/lib/embedding-index-persistence': `export async function hydrateEmbeddingIndex(_store, options) {
    const f = globalThis.__scragRouteFixture; f.events.push(['hydrate', options]);
    if (f.hydrationError) throw new Error('index unavailable');
    f.hydrated = true;
  }`,
  '@/lib/embedding-index-state': `export function getActiveEmbeddingIndex() {
    return globalThis.__scragRouteFixture.hydrated ? globalThis.__scragRouteFixture.active : undefined;
  }`,
  '@/lib/embedding-config': `export function getEmbeddingFactory() {
    return { getConfigSummary: () => ({ model: 'nomic-embed-text' }) };
  }`,
  '@/lib/milvus-config': `export function getMilvusConnectionConfig() {
    const f = globalThis.__scragRouteFixture; f.events.push(['connection']);
    const active = f.hydrated && f.active;
    return { address: 'localhost:19530', defaultCollection: active?.collection || 'rag_documents',
      defaultDimension: active?.dimension || 768, ssl: false };
  }
  export function getMilvusConfigManager() {
    return { getConnectionConfig: () => ({ defaultCollection: 'rag_documents', defaultDimension: 768 }) };
  }`,
  '@/lib/self-corrective-rag': `export async function executeSCRAG(input) {
    const f = globalThis.__scragRouteFixture; f.input = input;
    return { answer: '', originalQuery: input.query, finalQuery: input.query, wasRewritten: false,
      rewriteCount: 0, rewriteHistory: [], retrievedDocuments: [], filteredDocuments: [],
      nodeExecutions: [], decisionPath: [], totalDuration: 0 };
  }`,
};

registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === routeUrl && Object.hasOwn(mocks, specifier)) {
    return { shortCircuit: true, url: stub(mocks[specifier]) };
  }
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
  if (url !== routeUrl) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText };
} });

const { POST } = await import('./route.ts');

function setup(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const fixture = { events: [], hydrated: false, active: {
    collection: 'ragidx_active', dimension: 4096, model: 'qwen3-embedding:latest',
  } };
  globalThis.__scragRouteFixture = fixture;
  t.after(() => { delete globalThis.__scragRouteFixture; });
  return fixture;
}

function request(body) {
  return new Request('http://localhost/api/self-corrective-rag', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('refreshes the active index before pairing its collection with its model', async t => {
  const fixture = setup(t);
  const response = await POST(request({ query: '问题' }));

  assert.equal(response.status, 200);
  assert.deepEqual(fixture.events, [['hydrate', { refresh: true }], ['connection']]);
  assert.equal(fixture.input.milvusConfig.collectionName, 'ragidx_active');
  assert.equal(fixture.input.milvusConfig.embeddingDimension, 4096);
  assert.equal(fixture.input.embeddingModel, 'qwen3-embedding:latest');
});

test('a different collection uses the configured model rather than the active index model', async t => {
  const fixture = setup(t);
  await POST(request({ query: '问题', milvusConfig: { collectionName: 'rag_documents' } }));

  assert.equal(fixture.input.milvusConfig.collectionName, 'rag_documents');
  assert.equal(fixture.input.milvusConfig.embeddingDimension, 768);
  assert.equal(fixture.input.embeddingModel, 'nomic-embed-text');
});

test('an alternate Milvus address does not reuse the active index model or dimension', async t => {
  const fixture = setup(t);
  await POST(request({ query: '问题', milvusConfig: { address: 'other-host:19530' } }));

  assert.equal(fixture.input.milvusConfig.address, 'other-host:19530');
  assert.equal(fixture.input.milvusConfig.collectionName, 'rag_documents');
  assert.equal(fixture.input.milvusConfig.embeddingDimension, 768);
  assert.equal(fixture.input.embeddingModel, 'nomic-embed-text');
});

test('an index refresh failure prevents retrieval with a stale binding', async t => {
  const fixture = setup(t);
  fixture.hydrationError = true;
  const response = await POST(request({ query: '问题' }));

  assert.equal(response.status, 500);
  assert.equal(fixture.input, undefined);
  assert.match((await response.json()).error, /index unavailable/);
});
