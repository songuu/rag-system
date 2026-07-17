import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const agenticStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let fixture;
let querySignals = [];
export function setAgenticFixture(value) {
  fixture = structuredClone(value);
  querySignals = [];
}
export function getAgenticQuerySignals() { return [...querySignals]; }
export class AgenticRAGSystem {
  async query(_question, options) {
    if (!fixture) throw new Error('Agentic route fixture is not configured.');
    querySignals.push(options?.signal);
    if (fixture.waitForAbort) {
      await new Promise((_resolve, reject) => {
        const rejectWithAbort = () => reject(options?.signal?.reason);
        if (options?.signal?.aborted) rejectWithAbort();
        else options?.signal?.addEventListener('abort', rejectWithAbort, { once: true });
      });
    }
    return structuredClone(fixture);
  }
}
`);
const milvusStubUrl = 'data:text/javascript,' + encodeURIComponent(`
const defaultHybridCapability = {
  nativeHybridSearch: true,
  bm25Function: true,
  schemaCompatible: true,
  provider: 'milvus-native-test',
  serverVersion: 'test',
};
let fixture = {
  orderedSchema: true,
  orderedRows: [],
  searchResults: [],
  hybridCapability: defaultHybridCapability,
  hybridHits: [],
};
let signals = {
  connect: 0,
  initialize: 0,
  query: 0,
  search: 0,
  stats: 0,
  hybridProbe: 0,
  hybridSearch: 0,
  hybridRequests: [],
};
const pendingProviderWork = {
  orderedQuery: [],
  hybridProbe: [],
  hybridSearch: [],
};
function waitForProviderRelease(kind, value) {
  const snapshot = structuredClone(value);
  return new Promise(resolve => {
    pendingProviderWork[kind].push(() => resolve(structuredClone(snapshot)));
  });
}
export function getMilvusPendingProviderWork() {
  return {
    orderedQuery: pendingProviderWork.orderedQuery.length,
    hybridProbe: pendingProviderWork.hybridProbe.length,
    hybridSearch: pendingProviderWork.hybridSearch.length,
  };
}
export function releaseMilvusProviderWork(kind) {
  const release = pendingProviderWork[kind]?.shift();
  if (!release) throw new Error('No pending Milvus provider work for ' + kind + '.');
  release();
}
export class MilvusHybridProviderUnavailableError extends Error {}
export class MilvusHybridEvidenceIntegrityError extends Error {}
export function createMilvusHybridRuntimeManifest(input) {
  return {
    version: 'milvus-hybrid-manifest/v1',
    collectionName: input.sourceCollectionName + '_hybrid_shadow',
    sourceCollectionName: input.sourceCollectionName,
    corpusVersion: 'server-test',
    embeddingModel: input.embeddingModel,
    embeddingDimension: input.embeddingDimension,
    rawTextField: 'content',
    denseVectorField: 'embedding',
    sparseVectorField: 'bm25_sparse',
    bm25OutputField: 'bm25_sparse',
    fusionVersion: 'rrf-v1',
  };
}
export function setMilvusFixture(value) {
  fixture = {
    orderedSchema: true,
    orderedRows: [],
    searchResults: [],
    hybridCapability: defaultHybridCapability,
    hybridHits: [],
    ...structuredClone(value),
  };
  signals = {
    connect: 0,
    initialize: 0,
    query: 0,
    search: 0,
    stats: 0,
    hybridProbe: 0,
    hybridSearch: 0,
    hybridRequests: [],
  };
}
export function getMilvusSignals() { return structuredClone(signals); }
const store = {
  async connect() { signals.connect += 1; },
  async initializeCollection() { signals.initialize += 1; },
  hasOrderedContextSchema() { return fixture.orderedSchema; },
  async queryOrderedCorpusRows(_scope, maxChunks) {
    signals.query += 1;
    signals.queryMaxChunks = maxChunks;
    if (fixture.hangOrderedQuery) return waitForProviderRelease('orderedQuery', fixture.orderedRows);
    if (fixture.orderedQueryError) throw new Error(fixture.orderedQueryError);
    return structuredClone(fixture.orderedRows);
  },
  async search() {
    signals.search += 1;
    return structuredClone(fixture.searchResults);
  },
  async getCollectionStats() {
    signals.stats += 1;
    return { name: 'test', rowCount: fixture.searchResults.length, embeddingDimension: 3, indexType: 'test', metricType: 'COSINE', loaded: true };
  },
  createHybridSearchPort(manifest) {
    return {
      async probe(input) {
        signals.hybridProbe += 1;
        signals.hybridProbeCollection = input.collectionName;
        if (fixture.hangHybridProbe) return waitForProviderRelease('hybridProbe', fixture.hybridCapability);
        if (fixture.hybridProbeError) throw new Error(fixture.hybridProbeError);
        return structuredClone(fixture.hybridCapability);
      },
      async search(request) {
        signals.hybridSearch += 1;
        signals.hybridRequests.push({
          collectionName: request.collectionName,
          query: request.query,
          denseEmbedding: [...request.denseEmbedding],
          topK: request.topK,
          scope: structuredClone(request.scope),
          signalIsAbortSignal: request.signal instanceof AbortSignal,
          manifestCollectionName: manifest.collectionName,
        });
        if (fixture.hangHybridSearch) return waitForProviderRelease('hybridSearch', fixture.hybridHits);
        if (fixture.hybridSearchError === 'provider') {
          throw new MilvusHybridProviderUnavailableError('provider unavailable');
        }
        if (fixture.hybridSearchError === 'integrity') {
          throw new MilvusHybridEvidenceIntegrityError('conflicting hybrid provenance');
        }
        return structuredClone(fixture.hybridHits);
      },
    };
  },
};
export function getMilvusInstance() { return store; }
`);
const modelStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let signals = { embed: 0, generate: 0, visualGenerate: 0, prompts: [] };
export function resetModelSignals() {
  signals = { embed: 0, generate: 0, visualGenerate: 0, prompts: [] };
}
export function getModelSignals() { return structuredClone(signals); }
export function createEmbedding() {
  return { async embedQuery() { signals.embed += 1; return [0.1, 0.2, 0.3]; } };
}
export function createLLM() {
  return { async invoke(prompt) {
    const isVisual = Array.isArray(prompt) && prompt.some(message =>
      Array.isArray(message?.content)
      && message.content.some(block => block?.type === 'image_url')
    );
    if (isVisual) {
      signals.visualGenerate += 1;
      return { content: 'VISUAL_PAGE_EVIDENCE' };
    }
    signals.generate += 1;
    signals.prompts.push(String(prompt));
    return { content: 'generated answer' };
  } };
}
`);
const moduleStubs = new Map([
  ['@/lib/agentic-rag', agenticStubUrl],
  ['@/lib/milvus-client', milvusStubUrl],
  ['@/lib/model-config', modelStubUrl],
  ['@/lib/rag-instance', 'data:text/javascript,' + encodeURIComponent(`
    export async function getRagSystem() { throw new Error('memory fixture not configured'); }
  `)],
  ['@/lib/adaptive-entity-rag', 'data:text/javascript,' + encodeURIComponent(`
    export class AdaptiveEntityRAGExecutionError extends Error {}
    export function createAdaptiveEntityRAG() { throw new Error('adaptive fixture not configured'); }
  `)],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === '../../model-config'
      && context.parentURL?.endsWith('/rag/multimodal/pdf-visual-lane.ts')
    ) {
      return { url: modelStubUrl, shortCircuit: true };
    }
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
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const environmentKeys = [
  'RAG_ACCESS_MODE', 'RAG_SINGLE_TENANT_TOKEN', 'RAG_SINGLE_TENANT_ROLE',
  'RAG_SINGLE_TENANT_ACTOR_ID', 'SUPABASE_DEFAULT_TENANT_ID',
  'SUPABASE_DEFAULT_CORPUS_ID', 'LANGCHAIN_TRACING_V2', 'RAG_ORDERED_CONTEXT_MODE',
  'RAG_MIROFISH_GRAPH_MODE', 'RAG_MIROFISH_GRAPH_STORE_ROOT',
  'RAG_MIROFISH_GRAPH_DOCUMENT_ID', 'RAG_MIROFISH_GRAPH_DOCUMENT_VERSION',
  'RAG_MIROFISH_GRAPH_TRUST_LEVEL', 'RAG_MIROFISH_GRAPH_MULTI_INSTANCE',
  'RAG_MIROFISH_GRAPH_REQUIRE_SHARED_CONTROL_PLANE',
  'MILVUS_HYBRID_MODE', 'MILVUS_HYBRID_ENABLED',
  'RAG_HYBRID_PROBE_TIMEOUT_MS', 'RAG_HYBRID_SEARCH_TIMEOUT_MS',
  'RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS',
  'RAG_PDF_VISUAL_MODE', 'RAG_PDF_VISUAL_MODEL',
  'RAG_PDF_VISUAL_STORE_ROOT', 'RAG_PDF_VISUAL_MULTI_INSTANCE',
  'RAG_PDF_VISUAL_REQUIRE_SHARED_CONTROL_PLANE',
  'RAG_DURABLE_ASK_MODE', 'RAG_DURABLE_WORKFLOW_STORE_ROOT',
  'RAG_DURABLE_WORKFLOW_INTEGRITY_KEY',
  'RAG_DURABLE_WORKFLOW_MULTI_INSTANCE',
  'RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE',
  'RAG_DURABLE_WORKFLOW_CONTROL_PLANE',
  'RAG_DURABLE_WORKFLOW_LEASE_MS',
  'RAG_DURABLE_WORKFLOW_MAX_THREADS',
  'RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS',
];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'ask-route-token',
  RAG_SINGLE_TENANT_ROLE: 'owner',
  RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a',
  SUPABASE_DEFAULT_TENANT_ID: 'tenant-a',
  SUPABASE_DEFAULT_CORPUS_ID: 'corpus-a',
  LANGCHAIN_TRACING_V2: 'false',
});

const { NextRequest } = await import('next/server');
const { setAgenticFixture, getAgenticQuerySignals } = await import('@/lib/agentic-rag');
const { GET, PATCH, POST, invokeGenerationWithDeadline } = await import('./route.ts');
const {
  setMilvusFixture,
  getMilvusSignals,
  getMilvusPendingProviderWork,
  releaseMilvusProviderWork,
} = await import('@/lib/milvus-client');
const { resetModelSignals, getModelSignals } = await import('@/lib/model-config');
const {
  FileMiroFishGraphArtifactStore,
  createMiroFishGraphArtifact,
  createMiroFishGraphDocumentVersion,
} = await import('@/lib/mirofish/graph-artifact-store');
const { FilePdfAssetStore } = await import('@/lib/rag/multimodal/pdf-asset-store');
const {
  buildPdfAssetManifest,
  sha256Hex: sha256PdfAsset,
} = await import('@/lib/rag/multimodal/pdf-asset-manifest');

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('POST executes authenticated agentic policy through Kernel and preserves fallback success', async () => {
  setAgenticFixture(agenticFixture({
    workflowSteps: [
      { step: 'analyze_query', status: 'error', error: 'fast analyzer fallback' },
      { step: 'retrieve_original', status: 'completed' },
      { step: 'grade_retrieval', status: 'completed' },
      { step: 'generate', status: 'completed' },
    ],
  }));

  const response = await POST(askRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.answer, 'scoped answer');
  assert.equal(body.evidence[0].tenantId, 'tenant-a');
  assert.equal(body.evidence[0].corpusId, 'corpus-a');
  assert.equal(response.headers.get('x-rag-policy'), 'agentic');
  assert.equal(response.headers.get('x-rag-status'), 'completed');
  assert.equal(response.headers.get('x-rag-trace-id'), body.traceId);
  const querySignals = getAgenticQuerySignals();
  assert.equal(querySignals.length, 1);
  assert.equal(querySignals[0] instanceof AbortSignal, true);
  assert.equal(querySignals[0].aborted, false);
});

test('POST activates bounded ordered context before lane execution and skips dense search', async () => {
  process.env.RAG_ORDERED_CONTEXT_MODE = 'active';
  setMilvusFixture({ orderedRows: orderedRows(), searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请按顺序总结全部文档'));
  const body = await response.json();
  const milvusSignals = getMilvusSignals();
  const modelSignals = getModelSignals();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rag-policy'), 'milvus-2step');
  assert.equal(body.retrievalDetails.retrievalRoute.route, 'ordered-context');
  assert.equal(body.retrievalDetails.contextPacking.active, true);
  assert.equal(body.retrievalDetails.contextPacking.readerReason, 'complete');
  assert.equal(milvusSignals.query, 1);
  assert.equal(milvusSignals.search, 0);
  assert.equal(modelSignals.embed, 0);
  assert.equal(modelSignals.generate, 1);
  assert.ok(modelSignals.prompts[0].indexOf('raw-a') < modelSignals.prompts[0].indexOf('raw-b'));
  assert.deepEqual(body.laneExecutions.map(item => item.retriever), ['milvus-ordered-corpus-v1']);
});

test('POST keeps ordered shadow diagnostic-only and off mode at zero reader calls', async () => {
  process.env.RAG_ORDERED_CONTEXT_MODE = 'shadow';
  setMilvusFixture({ orderedRows: orderedRows(), searchResults: [denseResult()] });
  resetModelSignals();
  const shadowResponse = await POST(milvusAskRequest('请按顺序总结全部文档'));
  const shadowBody = await shadowResponse.json();
  assert.equal(shadowResponse.status, 200);
  assert.equal(shadowBody.retrievalDetails.retrievalRoute.route, 'dense');
  assert.equal(shadowBody.retrievalDetails.contextPacking.readerReason, 'complete');
  assert.equal(getMilvusSignals().query, 1);
  assert.equal(getMilvusSignals().search, 1);
  assert.equal(getModelSignals().embed, 1);
  assert.match(getModelSignals().prompts[0], /dense evidence/);
  assert.equal(getModelSignals().prompts[0].includes('raw-a'), false);

  process.env.RAG_ORDERED_CONTEXT_MODE = 'off';
  setMilvusFixture({ orderedRows: orderedRows(), searchResults: [denseResult()] });
  resetModelSignals();
  const offResponse = await POST(milvusAskRequest('请按顺序总结全部文档'));
  assert.equal(offResponse.status, 200);
  assert.equal(getMilvusSignals().query, 0);
  assert.equal(getMilvusSignals().search, 1);
});

test('POST records ordered provider failures and preserves dense availability in shadow and active', async () => {
  for (const mode of ['shadow', 'active']) {
    process.env.RAG_ORDERED_CONTEXT_MODE = mode;
    setMilvusFixture({
      orderedQueryError: 'ordered provider connection reset',
      searchResults: [denseResult()],
    });
    resetModelSignals();

    const response = await POST(milvusAskRequest('请按顺序总结全部文档'));
    const body = await response.json();
    const signals = getMilvusSignals();
    const prompt = getModelSignals().prompts.join('\n');

    assert.equal(response.status, 200, mode);
    assert.equal(body.retrievalDetails.retrievalRoute.route, 'dense', mode);
    assert.equal(body.retrievalDetails.contextPacking.readerReason, 'provider_unavailable', mode);
    assert.equal(body.retrievalDetails.contextPacking.active, false, mode);
    assert.equal(signals.query, 1, mode);
    assert.equal(signals.search, 1, mode);
    assert.equal(getModelSignals().embed, 1, mode);
    assert.equal(getModelSignals().generate, 1, mode);
    assert.match(prompt, /dense evidence/, mode);
    assert.equal(prompt.includes('ordered provider connection reset'), false, mode);
    assert.equal(JSON.stringify(body).includes('ordered provider connection reset'), false, mode);
  }
});

test('POST bounds hanging ordered reads and keeps dense available in shadow and active', async t => {
  const keys = [
    'RAG_ORDERED_CONTEXT_MODE',
    'RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS',
    'MILVUS_HYBRID_MODE',
  ];
  const snapshot = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.RAG_ORDERED_CONTEXT_READ_TIMEOUT_MS = '15';
  process.env.MILVUS_HYBRID_MODE = 'off';

  for (const mode of ['shadow', 'active']) {
    process.env.RAG_ORDERED_CONTEXT_MODE = mode;
    setMilvusFixture({
      hangOrderedQuery: true,
      orderedRows: orderedRows(),
      searchResults: [denseResult()],
    });
    resetModelSignals();

    const first = await POST(milvusAskRequest('请按顺序总结全部文档'));
    const firstBody = await first.json();
    assert.equal(first.status, 200, mode);
    assert.equal(firstBody.retrievalDetails.retrievalRoute.route, 'dense', mode);
    assert.equal(firstBody.retrievalDetails.contextPacking.readerReason, 'provider_unavailable', mode);
    assert.equal(getMilvusSignals().query, 1, mode);
    assert.equal(getMilvusSignals().search, 1, mode);
    assert.equal(getMilvusPendingProviderWork().orderedQuery, 1, mode);
    assert.match(getModelSignals().prompts.join('\n'), /dense evidence/, mode);

    const blocked = await POST(milvusAskRequest('请按顺序总结全部文档'));
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 200, mode);
    assert.equal(blockedBody.retrievalDetails.contextPacking.readerReason, 'provider_unavailable', mode);
    assert.equal(getMilvusSignals().query, 1, mode);
    assert.equal(getMilvusSignals().search, 2, mode);

    releaseMilvusProviderWork('orderedQuery');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getMilvusPendingProviderWork().orderedQuery, 0, mode);
  }
});

test('POST falls back to dense when active ordered corpus exceeds its chunk bound', async () => {
  process.env.RAG_ORDERED_CONTEXT_MODE = 'active';
  const rows = Array.from({ length: 257 }, (_, index) => orderedRow(
    'overflow-' + index,
    'doc-overflow',
    index,
    257,
    'overflow-' + index
  ));
  setMilvusFixture({ orderedRows: rows, searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请总结全部文档'));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.retrievalRoute.route, 'dense');
  assert.equal(body.retrievalDetails.retrievalRoute.reason, 'ordered_context_corpus_unbounded');
  assert.equal(body.retrievalDetails.contextPacking.readerReason, 'chunk_limit_exceeded');
  assert.equal(getMilvusSignals().query, 1);
  assert.equal(getMilvusSignals().search, 1);
});

test('POST fails closed before dense search or generation on ordered scalar scope violation', async t => {
  t.mock.method(console, 'error', () => {});
  process.env.RAG_ORDERED_CONTEXT_MODE = 'active';
  const foreign = orderedRow('foreign', 'doc-a', 0, 1, 'foreign');
  foreign.tenant_id = 'tenant-b';
  setMilvusFixture({ orderedRows: [foreign], searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请总结全部文档'));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.code, 'RAG_POLICY_FAILED');
  assert.equal(JSON.stringify(body).includes('tenant-b'), false);
  assert.equal(getMilvusSignals().search, 0);
  assert.equal(getModelSignals().generate, 0);
});

test('POST keeps hybrid mode off at zero hybrid I/O for identifier queries', async t => {
  configureHybridRouteEnvironment(t, 'off');
  setMilvusFixture({
    searchResults: [denseResult()],
    hybridHits: [hybridResult('HYBRID_OFF_MUST_NOT_RUN')],
  });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请查找错误码 ERR-42'));
  const body = await response.json();
  const signals = getMilvusSignals();

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.retrievalRoute.route, 'dense');
  assert.equal(body.retrievalDetails.hybrid.probed, false);
  assert.equal(signals.hybridProbe, 0);
  assert.equal(signals.hybridSearch, 0);
  assert.equal(signals.search, 1);
  assert.equal(getModelSignals().prompts.join('\n').includes('HYBRID_OFF_MUST_NOT_RUN'), false);
});

test('POST bounds hanging hybrid probes and admission-blocks retries in shadow and active', async t => {
  configureHybridRouteEnvironment(t, 'shadow');
  process.env.RAG_HYBRID_PROBE_TIMEOUT_MS = '15';
  process.env.RAG_HYBRID_SEARCH_TIMEOUT_MS = '100';

  for (const mode of ['shadow', 'active']) {
    process.env.MILVUS_HYBRID_MODE = mode;
    setMilvusFixture({
      hangHybridProbe: true,
      searchResults: [denseResult()],
    });
    resetModelSignals();

    const first = await POST(milvusAskRequest('请查找错误码 ERR-42'));
    const firstBody = await first.json();
    assert.equal(first.status, 200, mode);
    assert.equal(firstBody.retrievalDetails.retrievalRoute.route, 'dense', mode);
    assert.equal(firstBody.retrievalDetails.hybrid.capability.reason, 'capability_probe_timeout', mode);
    assert.equal(getMilvusSignals().hybridProbe, 1, mode);
    assert.equal(getMilvusSignals().hybridSearch, 0, mode);
    assert.equal(getMilvusSignals().search, 1, mode);
    assert.equal(getMilvusPendingProviderWork().hybridProbe, 1, mode);

    const blocked = await POST(milvusAskRequest('请查找错误码 ERR-43'));
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 200, mode);
    assert.equal(blockedBody.retrievalDetails.hybrid.capability.reason, 'capability_probe_busy', mode);
    assert.equal(getMilvusSignals().hybridProbe, 1, mode);
    assert.equal(getMilvusSignals().search, 2, mode);
    assert.match(getModelSignals().prompts.join('\n'), /dense evidence/, mode);

    releaseMilvusProviderWork('hybridProbe');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getMilvusPendingProviderWork().hybridProbe, 0, mode);
  }
});

test('POST keeps required dense retrieval after hanging hybrid search in shadow and active', async t => {
  configureHybridRouteEnvironment(t, 'shadow');
  process.env.RAG_HYBRID_PROBE_TIMEOUT_MS = '100';
  process.env.RAG_HYBRID_SEARCH_TIMEOUT_MS = '15';

  for (const mode of ['shadow', 'active']) {
    process.env.MILVUS_HYBRID_MODE = mode;
    setMilvusFixture({
      hangHybridSearch: true,
      hybridHits: [hybridResult('HYBRID_LATE_MUST_NOT_SURFACE')],
      searchResults: [denseResult()],
    });
    resetModelSignals();

    const first = await POST(milvusAskRequest('请查找错误码 ERR-42'));
    const firstBody = await first.json();
    assert.equal(first.status, 200, mode);
    assert.equal(getMilvusSignals().hybridSearch, 1, mode);
    assert.equal(getMilvusSignals().search, 1, mode);
    assert.equal(getMilvusPendingProviderWork().hybridSearch, 1, mode);
    assert.equal(
      firstBody.laneExecutions.some(item => (
        item.retriever === 'milvus-native-hybrid-v1'
        && item.errorCode === 'RAG_LANE_TIMEOUT'
      )),
      true,
      mode
    );
    assert.match(getModelSignals().prompts.join('\n'), /dense evidence/, mode);
    assert.equal(JSON.stringify(firstBody).includes('HYBRID_LATE_MUST_NOT_SURFACE'), false, mode);

    const blocked = await POST(milvusAskRequest('请查找错误码 ERR-43'));
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 200, mode);
    assert.equal(getMilvusSignals().hybridSearch, 1, mode);
    assert.equal(getMilvusSignals().search, 2, mode);
    assert.equal(
      blockedBody.laneExecutions.some(item => (
        item.retriever === 'milvus-native-hybrid-v1'
        && item.errorCode === 'RAG_LANE_PROVIDER_BUSY'
      )),
      true,
      mode
    );

    releaseMilvusProviderWork('hybridSearch');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getMilvusPendingProviderWork().hybridSearch, 0, mode);
  }
});

test('POST executes shadow hybrid diagnostics without leaking shadow content into generation', async t => {
  configureHybridRouteEnvironment(t, 'shadow');
  setMilvusFixture({
    searchResults: [denseResult()],
    hybridHits: [hybridResult('HYBRID_SHADOW_PRIVATE')],
  });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请查找错误码 ERR-42'));
  const body = await response.json();
  const signals = getMilvusSignals();
  const prompt = getModelSignals().prompts.join('\n');

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.retrievalRoute.route, 'dense');
  assert.equal(body.retrievalDetails.hybrid.probed, true);
  assert.equal(body.retrievalDetails.hybrid.active, false);
  assert.equal(signals.hybridProbe, 1);
  assert.equal(signals.hybridSearch, 1);
  assert.equal(signals.search, 1);
  assert.equal(getModelSignals().embed, 1);
  assert.match(prompt, /dense evidence/);
  assert.equal(prompt.includes('HYBRID_SHADOW_PRIVATE'), false);
  assert.equal(JSON.stringify(body.evidence).includes('HYBRID_SHADOW_PRIVATE'), false);
});

test('POST activates native hybrid evidence and skips the dense rollback lane', async t => {
  configureHybridRouteEnvironment(t, 'active');
  setMilvusFixture({
    searchResults: [denseResult()],
    hybridHits: [hybridResult('HYBRID_ACTIVE_EVIDENCE')],
  });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请查找错误码 ERR-42'));
  const body = await response.json();
  const signals = getMilvusSignals();
  const request = signals.hybridRequests[0];

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.retrievalRoute.route, 'hybrid');
  assert.equal(body.retrievalDetails.hybrid.active, true);
  assert.equal(signals.hybridProbe, 1);
  assert.equal(signals.hybridSearch, 1);
  assert.equal(signals.search, 0);
  assert.equal(signals.connect, 0);
  assert.equal(signals.initialize, 0);
  assert.equal(getModelSignals().embed, 1);
  assert.equal(request.collectionName, request.manifestCollectionName);
  assert.equal(request.scope.tenantId, 'tenant-a');
  assert.equal(request.scope.corpusId, 'corpus-a');
  assert.equal(request.signalIsAbortSignal, true);
  assert.equal(body.evidence.some(item => item.content === 'HYBRID_ACTIVE_EVIDENCE'), true);
  assert.match(getModelSignals().prompts.join('\n'), /HYBRID_ACTIVE_EVIDENCE/);
  assert.equal(
    body.laneExecutions.some(item => item.retriever === 'milvus-native-hybrid-v1'),
    true
  );
});

test('POST falls back to dense when active hybrid capability is unavailable', async t => {
  configureHybridRouteEnvironment(t, 'active');
  setMilvusFixture({
    hybridCapability: {
      nativeHybridSearch: true,
      bm25Function: false,
      schemaCompatible: true,
      provider: 'milvus-native-test',
      reason: 'bm25_missing',
    },
    searchResults: [denseResult()],
  });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请查找错误码 ERR-42'));
  const body = await response.json();
  const signals = getMilvusSignals();

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.retrievalRoute.route, 'dense');
  assert.equal(body.retrievalDetails.hybrid.probed, true);
  assert.equal(body.retrievalDetails.hybrid.usable, false);
  assert.equal(signals.hybridProbe, 1);
  assert.equal(signals.hybridSearch, 0);
  assert.equal(signals.search, 1);
});

test('POST uses dense rollback for empty or temporarily unavailable active hybrid results', async t => {
  configureHybridRouteEnvironment(t, 'active');
  setMilvusFixture({ hybridHits: [], searchResults: [denseResult()] });
  resetModelSignals();

  const emptyResponse = await POST(milvusAskRequest('请查找错误码 ERR-42'));
  assert.equal(emptyResponse.status, 200);
  assert.equal(getMilvusSignals().hybridSearch, 1);
  assert.equal(getMilvusSignals().search, 1);
  assert.match(getModelSignals().prompts.join('\n'), /dense evidence/);

  setMilvusFixture({ hybridSearchError: 'provider', searchResults: [denseResult()] });
  resetModelSignals();
  const unavailableResponse = await POST(milvusAskRequest('请查找错误码 ERR-43'));
  assert.equal(unavailableResponse.status, 200);
  assert.equal(getMilvusSignals().hybridSearch, 1);
  assert.equal(getMilvusSignals().search, 1);
  assert.match(getModelSignals().prompts.join('\n'), /dense evidence/);
});

test('POST fails closed before dense or generation on conflicting hybrid provenance aliases', async t => {
  t.mock.method(console, 'error', () => {});
  configureHybridRouteEnvironment(t, 'active');
  const conflicting = hybridResult('HYBRID_CONFLICT');
  conflicting.metadata.tenantId = 'tenant-b';
  setMilvusFixture({
    hybridHits: [conflicting],
    searchResults: [denseResult()],
  });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请查找错误码 ERR-42'));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.code, 'RAG_POLICY_FAILED');
  assert.equal(getMilvusSignals().hybridSearch, 1);
  assert.equal(getMilvusSignals().search, 0);
  assert.equal(getModelSignals().generate, 0);
  assert.equal(JSON.stringify(body).includes('tenant-b'), false);
});

test('POST keeps PDF visual off and pure-text active paths at zero visual work', async t => {
  configurePdfVisualRouteEnvironment(t, {
    mode: 'off',
    model: 'vision-model-a',
    multiInstance: true,
  });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const offResponse = await POST(milvusAskRequest('请分析第 1 页的图表'));
  const offBody = await offResponse.json();
  assert.equal(offResponse.status, 200);
  assert.equal(offBody.retrievalDetails.pdfVisual.requestedMode, 'off');
  assert.equal(offBody.retrievalDetails.pdfVisual.usable, false);
  assert.equal(getModelSignals().visualGenerate, 0);

  process.env.RAG_PDF_VISUAL_MODE = 'active';
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();
  const textResponse = await POST(milvusAskRequest('总结主要结论'));
  const textBody = await textResponse.json();
  assert.equal(textResponse.status, 200);
  assert.equal(textBody.retrievalDetails.pdfVisual.requestedVisual, false);
  assert.equal(textBody.retrievalDetails.pdfVisual.capabilityReason, 'text_intent');
  assert.equal(getModelSignals().visualGenerate, 0);
});

test('POST activates exact scoped PDF page evidence after dense retrieval', async t => {
  const fixture = await createPdfVisualRouteFixture(t, 'active');
  setMilvusFixture({ searchResults: [pdfDenseResult(fixture.identity)] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请分析第 1 页的图表'));
  const body = await response.json();
  const modelSignals = getModelSignals();

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.pdfVisual.active, true);
  assert.equal(body.retrievalDetails.pdfVisual.evidenceCount, 1);
  assert.equal(body.retrievalDetails.pdfVisual.diagnostics.analysisCount, 1);
  assert.equal(
    body.evidence.some(item =>
      item.laneId === 'pdf-visual-active'
      && item.content === 'VISUAL_PAGE_EVIDENCE'
      && item.documentId === fixture.identity.documentId
    ),
    true
  );
  assert.equal(
    body.laneExecutions.some(item => item.retriever === 'pdf-visual-lane-v1'),
    true
  );
  assert.equal(modelSignals.visualGenerate, 1);
  assert.equal(modelSignals.generate, 1);
  assert.match(modelSignals.prompts.join('\n'), /VISUAL_PAGE_EVIDENCE/);
  assert.equal(JSON.stringify(body).includes('data:image'), false);
  assert.equal(JSON.stringify(body).includes(fixture.root), false);
});

test('POST executes PDF visual shadow analysis without exposing its body', async t => {
  await createPdfVisualRouteFixture(t, 'shadow');
  const identity = pdfVisualIdentity();
  setMilvusFixture({ searchResults: [pdfDenseResult(identity)] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请分析第 1 页的图表'));
  const body = await response.json();
  const modelSignals = getModelSignals();

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.pdfVisual.active, false);
  assert.equal(body.retrievalDetails.pdfVisual.evidenceCount, 0);
  assert.equal(body.retrievalDetails.pdfVisual.diagnostics.analysisCount, 1);
  assert.equal(modelSignals.visualGenerate, 1);
  assert.equal(JSON.stringify(body.evidence).includes('VISUAL_PAGE_EVIDENCE'), false);
  assert.equal(modelSignals.prompts.join('\n').includes('VISUAL_PAGE_EVIDENCE'), false);
  assert.match(modelSignals.prompts.join('\n'), /dense PDF evidence/);
});

test('POST falls back to text when PDF visual model or exact manifest is unavailable', async t => {
  const root = await configurePdfVisualRouteEnvironment(t, {
    mode: 'active',
    model: 'vision-model-a',
  });
  const identity = pdfVisualIdentity();
  setMilvusFixture({ searchResults: [pdfDenseResult(identity)] });
  resetModelSignals();

  const missingResponse = await POST(milvusAskRequest('请分析第 1 页的图表'));
  const missingBody = await missingResponse.json();
  assert.equal(missingResponse.status, 200);
  assert.equal(missingBody.retrievalDetails.pdfVisual.evidenceCount, 0);
  assert.equal(missingBody.retrievalDetails.pdfVisual.diagnostics.missingManifestCount, 1);
  assert.equal(getModelSignals().visualGenerate, 0);
  assert.match(getModelSignals().prompts.join('\n'), /dense PDF evidence/);

  delete process.env.RAG_PDF_VISUAL_MODEL;
  process.env.RAG_PDF_VISUAL_MULTI_INSTANCE = 'true';
  setMilvusFixture({ searchResults: [pdfDenseResult(identity)] });
  resetModelSignals();
  const noModelResponse = await POST(milvusAskRequest('请分析第 1 页的图表'));
  const noModelBody = await noModelResponse.json();
  assert.equal(noModelResponse.status, 200);
  assert.equal(noModelBody.retrievalDetails.pdfVisual.usable, false);
  assert.equal(noModelBody.retrievalDetails.pdfVisual.capabilityReason, 'model_unavailable');
  assert.equal(getModelSignals().visualGenerate, 0);
  assert.equal(JSON.stringify(noModelBody).includes(root), false);
});

test('POST disables PDF visual active capability on an unsupported multi-instance topology', async t => {
  await configurePdfVisualRouteEnvironment(t, {
    mode: 'active',
    model: 'vision-model-a',
    multiInstance: true,
  });
  setMilvusFixture({ searchResults: [pdfDenseResult(pdfVisualIdentity())] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('请分析第 1 页的图表'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.retrievalDetails.pdfVisual.usable, false);
  assert.equal(body.retrievalDetails.pdfVisual.capabilityReason, 'topology_unavailable');
  assert.equal(
    body.laneExecutions.some(item => item.retriever === 'pdf-visual-lane-v1'),
    false
  );
  assert.equal(getModelSignals().visualGenerate, 0);
  assert.match(getModelSignals().prompts.join('\n'), /dense PDF evidence/);
});

test('POST resolves the scoped active graph pointer into a real graph lane', async t => {
  const fixture = await createMiroFishRouteFixture(t, {
    documentId: 'graph-active-a',
    marker: 'ACTIVE_GRAPH_EVIDENCE',
    activate: true,
  });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('比较方案甲与方案乙的影响'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rag-policy'), 'mirofish-research');
  assert.equal(
    body.laneExecutions.some(item => item.retriever === 'mirofish-graph-artifact-v2'),
    true
  );
  assert.equal(
    body.evidence.some(item => item.documentId === fixture.identity.documentId),
    true
  );
  assert.match(getModelSignals().prompts.join('\n'), /ACTIVE_GRAPH_EVIDENCE/);
});

test('POST uses dense fallback when active graph mode has no pointer', async t => {
  await configureMiroFishRouteEnvironment(t);
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('比较方案甲与方案乙的影响'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rag-policy'), 'milvus-2step');
  assert.equal(
    body.laneExecutions.some(item => item.retriever === 'mirofish-graph-artifact-v2'),
    false
  );
  assert.equal(getMilvusSignals().search, 1);
});

test('POST keeps pinned graph environment identity ahead of the active pointer', async t => {
  const fixture = await createMiroFishRouteFixture(t, {
    documentId: 'graph-active-old',
    marker: 'ACTIVE_OLD_EVIDENCE',
    activate: true,
  });
  const pinnedGraph = createMiroFishRouteGraph(
    'graph-pinned-new',
    'PINNED_GRAPH_EVIDENCE'
  );
  const pinnedIdentity = {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: pinnedGraph.graph_id,
    documentVersion: createMiroFishGraphDocumentVersion(pinnedGraph),
    trustLevel: 'reviewed',
  };
  await fixture.store.put(createMiroFishGraphArtifact({
    identity: pinnedIdentity,
    graph: pinnedGraph,
  }));
  process.env.RAG_MIROFISH_GRAPH_DOCUMENT_ID = pinnedIdentity.documentId;
  process.env.RAG_MIROFISH_GRAPH_DOCUMENT_VERSION = pinnedIdentity.documentVersion;
  process.env.RAG_MIROFISH_GRAPH_TRUST_LEVEL = pinnedIdentity.trustLevel;
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('比较方案甲与方案乙的影响'));
  const body = await response.json();
  const prompts = getModelSignals().prompts.join('\n');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rag-policy'), 'mirofish-research');
  assert.equal(
    body.evidence.some(item => item.documentId === pinnedIdentity.documentId),
    true
  );
  assert.match(prompts, /PINNED_GRAPH_EVIDENCE/);
  assert.doesNotMatch(prompts, /ACTIVE_OLD_EVIDENCE/);
});

test('POST does not touch the graph runtime while MiroFish mode is off', async t => {
  await configureMiroFishRouteEnvironment(t);
  process.env.RAG_MIROFISH_GRAPH_MODE = 'off';
  process.env.RAG_MIROFISH_GRAPH_MULTI_INSTANCE = 'true';
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('比较方案甲与方案乙的影响'));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rag-policy'), 'milvus-2step');
  assert.equal(getMilvusSignals().search, 1);
});


test('POST keeps synchronous execution at zero durable filesystem I/O', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(milvusAskRequest('sync path must stay unchanged'));
  assert.equal(response.status, 200);
  assert.equal(existsSync(runtime.root), false);
  assert.equal(response.headers.get('x-rag-durable-thread-id'), null);
  assert.equal(getModelSignals().generate, 1);
});

test('POST durable execution requires runtime-management capability before I/O', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  process.env.RAG_SINGLE_TENANT_ROLE = 'viewer';
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(durableMilvusAskRequest(
    'viewer cannot allocate durable state',
    'durable-viewer-forbidden-0001'
  ));
  assert.equal(response.status, 403);
  assert.equal(getMilvusSignals().search, 0);
  assert.equal(getModelSignals().embed, 0);
  assert.equal(getModelSignals().generate, 0);
  assert.equal(existsSync(runtime.root), false);
});

test('GET durable status by idempotency key requires runtime-management capability before I/O', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  process.env.RAG_SINGLE_TENANT_ROLE = 'viewer';

  const response = await GET(durableAskStatusRequest(
    'durable-viewer-status-forbidden-0001'
  ));
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, 'RAG_CAPABILITY_FORBIDDEN');
  assert.equal(existsSync(runtime.root), false);
});

test('GET durable result by idempotency key requires runtime-management capability before I/O', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  process.env.RAG_SINGLE_TENANT_ROLE = 'viewer';

  const response = await GET(durableAskStatusRequest(
    'durable-viewer-result-forbidden-0001',
    { includeResult: true }
  ));
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, 'RAG_CAPABILITY_FORBIDDEN');
  assert.equal(existsSync(runtime.root), false);
});

test('POST rejects disabled durable execution before retrieval or model work', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'off' });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(durableMilvusAskRequest(
    'disabled durable query',
    'durable-disabled-0001'
  ));
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'DURABLE_ASK_DISABLED');
  assert.equal(getMilvusSignals().search, 0);
  assert.equal(getModelSignals().embed, 0);
  assert.equal(getModelSignals().generate, 0);
  assert.equal(existsSync(runtime.root), false);
});

test('POST durable execution persists a minimal checkpoint and replays one result', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  const idempotencyKey = 'durable-replay-0001';
  const question = 'private durable replay question';
  const resultWithPrivateQueryAliases = denseResult();
  Object.assign(resultWithPrivateQueryAliases.metadata, {
    source: 'https://files.example.test/private.pdf?X-Amz-Signature=signed-secret',
    userQuery: question,
    query_text: question,
    questionText: question,
    apiToken: 'durable-secret-token',
    input: {
      rawQuery: question,
    },
  });
  setMilvusFixture({ searchResults: [resultWithPrivateQueryAliases] });
  resetModelSignals();

  const firstResponse = await POST(durableMilvusAskRequest(
    question,
    idempotencyKey
  ));
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.answer, 'generated answer');
  assert.equal(firstBody.question, undefined);
  assert.equal(firstBody.context, undefined);
  assert.equal(firstBody.retrievalDetails, undefined);
  assert.equal(firstBody.evidence[0].content, undefined);
  assert.equal(firstBody.evidence[0].metadata, undefined);
  assert.equal(firstBody.evidence[0].source, undefined);
  assert.equal(firstBody.evidence[0].documentId, 'dense-doc-a');
  assert.equal(firstResponse.headers.get('x-rag-durable-status'), 'completed');
  assert.equal(firstResponse.headers.get('x-rag-durable-replay'), 'false');
  const threadId = firstResponse.headers.get('x-rag-durable-thread-id');
  assert.match(threadId, /^rag-ask-/);

  const firstSignals = getModelSignals();
  const replayResponse = await POST(durableMilvusAskRequest(
    question,
    idempotencyKey
  ));
  const replayBody = await replayResponse.json();
  assert.equal(replayResponse.status, 200);
  assert.deepEqual(replayBody, firstBody);
  assert.equal(replayResponse.headers.get('x-rag-durable-replay'), 'true');
  assert.deepEqual(getModelSignals(), firstSignals);

  const statusResponse = await GET(durableAskStatusRequest(
    idempotencyKey,
    { includeResult: true }
  ));
  const statusBody = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(statusBody.durable.status, 'completed');
  assert.equal(statusBody.durable.resultAvailable, true);
  assert.equal(statusBody.result.body.answer, 'generated answer');
  assert.equal(statusBody.result.body.question, undefined);
  assert.equal(getModelSignals().generate, 1);

  const checkpointText = await readTreeText(
    path.join(runtime.root, 'checkpoints')
  );
  const resultText = await readTreeText(
    path.join(runtime.root, 'ask-results')
  );
  assert.equal(checkpointText.includes(question), false);
  assert.equal(checkpointText.includes('generated answer'), false);
  assert.equal(resultText.includes(question), false);
  assert.equal(resultText.includes('durable-secret-token'), false);
  assert.equal(resultText.includes('signed-secret'), false);
  assert.equal(resultText.includes('dense evidence'), false);
  assert.equal(resultText.includes('generated answer'), true);

  const changedResponse = await POST(durableMilvusAskRequest(
    question + ' changed',
    idempotencyKey
  ));
  const changedBody = await changedResponse.json();
  assert.equal(changedResponse.status, 409);
  assert.ok([
    'DOCUMENT_VERSION_MISMATCH',
    'JOB_FINGERPRINT_MISMATCH',
  ].includes(changedBody.code));
  assert.equal(getModelSignals().generate, 1);
});

test('POST maps durable result capacity exhaustion to 503', async t => {
  await configureDurableAskRoute(t, {
    mode: 'active',
    resultMaxArtifacts: 1,
  });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const first = await POST(durableMilvusAskRequest(
    'capacity first query',
    'durable-capacity-0001'
  ));
  assert.equal(first.status, 200);

  const exhausted = await POST(durableMilvusAskRequest(
    'capacity second query',
    'durable-capacity-0002'
  ));
  const body = await exhausted.json();
  assert.equal(exhausted.status, 503);
  assert.equal(body.code, 'DURABLE_ASK_RESULT_CAPACITY');
});

test('POST preserves nested durable result integrity failures instead of reporting pause', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const first = await POST(durableMilvusAskRequest(
    'integrity fixture first query',
    'durable-integrity-0001'
  ));
  assert.equal(first.status, 200);
  const reservations = (await findTreeFiles(path.join(
    runtime.root,
    'ask-results'
  ))).filter(file => (
    file.includes(path.sep + 'reservations' + path.sep)
    && /[a-f0-9]{64}\.json$/.test(file)
  ));
  assert.equal(reservations.length, 1);
  await writeFile(
    reservations[0],
    '{"tampered":true}'
  );

  const failed = await POST(durableMilvusAskRequest(
    'integrity fixture first query',
    'durable-integrity-0001'
  ));
  const body = await failed.json();
  assert.equal(failed.status, 503);
  assert.equal(body.code, 'DURABLE_ASK_RESULT_INTEGRITY');
});

test('POST durable execution rejects unsupported multi-instance topology before work', async t => {
  const runtime = await configureDurableAskRoute(t, {
    mode: 'active',
    multiInstance: true,
  });
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const response = await POST(durableMilvusAskRequest(
    'topology guard query',
    'durable-topology-0001'
  ));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED');
  assert.equal(getMilvusSignals().search, 0);
  assert.equal(getModelSignals().generate, 0);
  assert.equal(existsSync(runtime.root), false);
});

test('PATCH delete is admin-only, revision-fenced, and purges terminal state', async t => {
  const runtime = await configureDurableAskRoute(t, {
    mode: 'active',
    checkpointMaxThreads: 1,
    resultMaxArtifacts: 1,
  });
  const idempotencyKey = 'durable-delete-0001';
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const completedResponse = await POST(durableMilvusAskRequest(
    'terminal delete query',
    idempotencyKey
  ));
  assert.equal(completedResponse.status, 200);
  const statusResponse = await GET(durableAskStatusRequest(idempotencyKey));
  const checkpoint = (await statusResponse.json()).durable;
  assert.equal(checkpoint.status, 'completed');
  const command = {
    action: 'delete',
    threadId: checkpoint.threadId,
    expectedRevision: checkpoint.revision,
    expectedGenerationId: checkpoint.generationId,
  };

  process.env.RAG_SINGLE_TENANT_ROLE = 'viewer';
  const forbidden = await PATCH(durableAskManagementRequest(command));
  assert.equal(forbidden.status, 403);
  process.env.RAG_SINGLE_TENANT_ROLE = 'owner';

  const staleFence = await PATCH(durableAskManagementRequest({
    ...command,
    expectedRevision: command.expectedRevision + 1,
  }));
  assert.equal(staleFence.status, 409);
  assert.equal((await staleFence.json()).code, 'DURABLE_CHECKPOINT_CONFLICT');

  const deletedResponse = await PATCH(durableAskManagementRequest(command));
  const deleted = await deletedResponse.json();
  assert.equal(deletedResponse.status, 200);
  assert.equal(deletedResponse.headers.get('x-rag-durable-status'), 'deleted');
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.checkpointDeleted, true);
  assert.equal(deleted.cleanupResumed, false);
  assert.equal(deleted.resultDeleted, true);
  assert.equal(deleted.resultDeletedCount, 1);
  assert.equal(deleted.generationId, checkpoint.generationId);
  assert.equal(deleted.cleanupAcknowledged, true);
  assert.equal(
    deletedResponse.headers.get('x-rag-durable-generation-id'),
    checkpoint.generationId
  );
  assert.equal(deleted.previousDurable.status, 'completed');
  assert.equal(deleted.previousDurable.resultAvailable, false);
  assert.equal(deleted.durable, undefined);

  const missing = await GET(durableAskStatusRequest(idempotencyKey));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'DURABLE_WORKFLOW_NOT_FOUND');
  const retainedResultData = (await findTreeFiles(path.join(
    runtime.root,
    'ask-results'
  ))).filter(file => (
    file.includes(path.sep + 'artifacts' + path.sep)
    || file.includes(path.sep + 'reservations' + path.sep)
  ));
  assert.equal(retainedResultData.length, 0);

  const replacement = await POST(durableMilvusAskRequest(
    'replacement after terminal delete',
    'durable-delete-0002'
  ));
  assert.equal(replacement.status, 200);
});

test('PATCH resumes exact generation A cleanup after generation B starts', async t => {
  const runtime = await configureDurableAskRoute(t, {
    mode: 'active',
    resultMaxArtifacts: 4,
    tombstoneRetentionMs: 1,
  });
  const idempotencyKey = 'durable-delete-resume-0001';
  setMilvusFixture({ searchResults: [denseResult()] });
  resetModelSignals();

  const generationAResponse = await POST(durableMilvusAskRequest(
    'generation A cleanup query',
    idempotencyKey
  ));
  assert.equal(generationAResponse.status, 200);
  const generationAStatus = await GET(durableAskStatusRequest(idempotencyKey));
  const generationA = (await generationAStatus.json()).durable;
  const generationACommand = {
    action: 'delete',
    threadId: generationA.threadId,
    expectedRevision: generationA.revision,
    expectedGenerationId: generationA.generationId,
  };
  const reservations = (await findTreeFiles(path.join(
    runtime.root,
    'ask-results'
  ))).filter(file => (
    file.includes(path.sep + 'reservations' + path.sep)
    && /[a-f0-9]{64}\.json$/.test(file)
  ));
  assert.equal(reservations.length, 1);
  const injectedInvalidEntry = path.join(
    path.dirname(reservations[0]),
    'invalid-entry'
  );
  await writeFile(injectedInvalidEntry, 'transient cleanup fault');

  const interruptedCleanupResponse = await PATCH(
    durableAskManagementRequest(generationACommand)
  );
  const interruptedCleanup = await interruptedCleanupResponse.json();
  assert.equal(interruptedCleanupResponse.status, 503);
  assert.equal(interruptedCleanup.code, 'DURABLE_ASK_RESULT_INTEGRITY');
  await rm(injectedInvalidEntry, { force: true });
  await new Promise(resolve => setTimeout(resolve, 10));

  const generationBResponse = await POST(durableMilvusAskRequest(
    'generation B replacement query',
    idempotencyKey
  ));
  assert.equal(generationBResponse.status, 200);
  const generationBStatus = await GET(durableAskStatusRequest(
    idempotencyKey,
    { includeResult: true }
  ));
  const generationBBody = await generationBStatus.json();
  const generationB = generationBBody.durable;
  assert.notEqual(generationB.generationId, generationA.generationId);
  assert.equal(generationBBody.result.body.answer, 'generated answer');

  const resumedResponse = await PATCH(
    durableAskManagementRequest(generationACommand)
  );
  const resumed = await resumedResponse.json();
  assert.equal(resumedResponse.status, 200);
  assert.equal(resumed.cleanupResumed, true);
  assert.equal(resumed.checkpointDeleted, false);
  assert.equal(resumed.resultDeleted, true);
  assert.equal(resumed.resultDeletedCount, 1);
  assert.equal(resumed.cleanupAcknowledged, true);
  assert.equal(resumed.generationId, generationA.generationId);
  assert.equal(resumed.previousDurable, undefined);

  const retainedGenerationBResponse = await GET(durableAskStatusRequest(
    idempotencyKey,
    { includeResult: true }
  ));
  const retainedGenerationB = await retainedGenerationBResponse.json();
  assert.equal(retainedGenerationBResponse.status, 200);
  assert.equal(
    retainedGenerationB.durable.generationId,
    generationB.generationId
  );
  assert.equal(retainedGenerationB.durable.resultAvailable, true);
  assert.equal(retainedGenerationB.result.body.answer, 'generated answer');
  const retainedResultData = (await findTreeFiles(path.join(
    runtime.root,
    'ask-results'
  ))).filter(file => (
    file.includes(path.sep + 'artifacts' + path.sep)
    || file.includes(path.sep + 'reservations' + path.sep)
  ));
  assert.equal(retainedResultData.length, 2);
});

test('PATCH cancellation is admin-only and fences a running durable ask', async t => {
  const runtime = await configureDurableAskRoute(t, { mode: 'active' });
  const idempotencyKey = 'durable-cancel-0001';
  setAgenticFixture(agenticFixture({ waitForAbort: true }));
  const controller = new AbortController();
  const pending = POST(durableAgenticAskRequest(
    idempotencyKey,
    controller.signal
  ));

  const queryStarted = await waitForAgenticQuerySignal();
  if (!queryStarted) {
    controller.abort(new Error('test query-start timeout cleanup'));
    await pending;
  }
  assert.equal(queryStarted, true);
  assert.equal(getAgenticQuerySignals().length, 1);
  const runningResponse = await GET(durableAskStatusRequest(idempotencyKey));
  const runningBody = await runningResponse.json();
  assert.equal(runningBody.durable.status, 'running');
  const command = {
    action: 'cancel',
    threadId: runningBody.durable.threadId,
    expectedRevision: runningBody.durable.revision,
    expectedGenerationId: runningBody.durable.generationId,
  };

  const activeDelete = await PATCH(durableAskManagementRequest({
    ...command,
    action: 'delete',
  }));
  assert.equal(activeDelete.status, 409);
  assert.equal(
    (await activeDelete.json()).code,
    'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED'
  );

  process.env.RAG_SINGLE_TENANT_ROLE = 'viewer';
  const forbidden = await PATCH(durableAskManagementRequest(command));
  assert.equal(forbidden.status, 403);
  process.env.RAG_SINGLE_TENANT_ROLE = 'owner';

  const cancelledResponse = await PATCH(durableAskManagementRequest(command));
  const cancelledBody = await cancelledResponse.json();
  assert.equal(cancelledResponse.status, 200);
  assert.equal(cancelledBody.durable.status, 'cancelled');

  controller.abort(new Error('test release'));
  const pendingResponse = await pending;
  assert.equal(pendingResponse.status, 499);
  const finalStatus = await GET(durableAskStatusRequest(idempotencyKey));
  assert.equal((await finalStatus.json()).durable.status, 'cancelled');
  assert.equal(
    (await readTreeText(path.join(runtime.root, 'ask-results'))).length,
    0
  );
});

test('PATCH recovery releases an explicitly expired crashed-owner lease', async t => {
  await configureDurableAskRoute(t, { mode: 'active' });
  const durable = await import('@/lib/rag/core/durable-ask-workflow');
  const runtimeModule = await import('@/lib/rag/core/durable-workflow-runtime');
  const { createRetrievalScope } = await import(
    '@/lib/security/retrieval-scope'
  );
  const durableRuntime = runtimeModule.getDurableWorkflowRuntime();
  const durableScope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    enforceIsolation: true,
  });
  const idempotencyKey = 'durable-recover-0001';
  const digests = durable.createDurableAskDigests({
    integrityKey: durableRuntime.integrityKey,
    query: 'crashed owner query',
    requestProjection: { kind: 'route-recovery-fixture' },
    routingProjection: { policyId: 'agentic' },
  });
  const identity = {
    threadId: durable.createDurableAskThreadId({
      integrityKey: durableRuntime.integrityKey,
      tenantId: durableScope.tenantId,
      corpusId: durableScope.corpusId,
      actorId: 'actor-a',
      idempotencyKey,
    }),
    idempotencyKey,
    scope: durableScope,
    ...digests,
  };
  let enteredStep;
  let releaseStep;
  const entered = new Promise(resolve => { enteredStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const stale = durable.invokeDurableAsk({
    identity,
    checkpointStore: durableRuntime.checkpointStore,
    resultStore: durableRuntime.resultStore,
    integrityKey: durableRuntime.integrityKey,
    adapterOptions: {
      leaseDurationMs: 900_000,
      now: () => new Date(Date.now() - 86_400_000),
    },
    async execute({ stepExecutionId }) {
      enteredStep();
      await release;
      return storedDurableRouteResult(stepExecutionId, 'stale answer');
    },
  }).catch(error => error);
  await entered;

  const running = await durable.inspectDurableAsk({
    threadId: identity.threadId,
    scope: durableScope,
    checkpointStore: durableRuntime.checkpointStore,
    resultStore: durableRuntime.resultStore,
    integrityKey: durableRuntime.integrityKey,
  });
  assert.equal(running.status, 'running');
  assert.ok(Date.parse(running.activeStep.leaseExpiresAt) < Date.now());

  const recoveredResponse = await PATCH(durableAskManagementRequest({
    action: 'recover',
    threadId: running.identity.threadId,
    expectedRevision: running.revision,
    expectedGenerationId: running.generationId,
  }));
  const recoveredBody = await recoveredResponse.json();
  assert.equal(recoveredResponse.status, 200);
  assert.equal(recoveredBody.durable.status, 'paused');
  assert.equal(recoveredBody.durable.lastFailureCode, 'EXPIRED_LEASE_RELEASED');

  releaseStep();
  assert.equal((await stale)?.code, 'DURABLE_CHECKPOINT_CONFLICT');
  const resumed = await durable.invokeDurableAsk({
    identity,
    checkpointStore: durableRuntime.checkpointStore,
    resultStore: durableRuntime.resultStore,
    integrityKey: durableRuntime.integrityKey,
    async execute({ stepExecutionId }) {
      return storedDurableRouteResult(stepExecutionId, 'resumed answer');
    },
  });
  assert.equal(resumed.workflow.resumed, true);
  assert.equal(resumed.artifact.result.body.answer, 'resumed answer');
});
test('generation deadline admission-blocks non-cooperative work until it settles', async () => {
  let releaseTimedOutWork;
  const timedOutWork = new Promise(resolve => { releaseTimedOutWork = resolve; });
  const modelKey = `test-non-cooperative-${Date.now()}`;

  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 10,
      invoke: async signal => {
        assert.equal(signal.aborted, false);
        await timedOutWork;
        return 'late';
      },
    }),
    error => error?.code === 'RAG_GENERATION_TIMEOUT'
  );

  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 10,
      invoke: async () => 'must not start',
    }),
    error => error?.code === 'RAG_GENERATION_PROVIDER_BUSY'
  );

  releaseTimedOutWork();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    await invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 50,
      invoke: async signal => {
        assert.equal(signal.aborted, false);
        return 'recovered';
      },
    }),
    'recovered'
  );
});

test('generation admission remains blocked until every concurrent timed-out call settles', async () => {
  const releases = [];
  let calls = 0;
  const modelKey = `test-concurrent-non-cooperative-${Date.now()}`;
  const invoke = async () => {
    calls++;
    if (calls <= 2) {
      return new Promise(resolve => {
        releases.push(() => resolve(`late-${calls}`));
      });
    }
    return 'recovered';
  };

  const timedOutCalls = await Promise.allSettled([
    invokeGenerationWithDeadline({ modelKey, timeoutMs: 10, invoke }),
    invokeGenerationWithDeadline({ modelKey, timeoutMs: 10, invoke }),
  ]);
  assert.deepEqual(
    timedOutCalls.map(result => result.status === 'rejected' ? result.reason.code : 'fulfilled'),
    ['RAG_GENERATION_TIMEOUT', 'RAG_GENERATION_TIMEOUT']
  );
  assert.equal(calls, 2);
  assert.equal(releases.length, 2);

  releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    invokeGenerationWithDeadline({ modelKey, timeoutMs: 50, invoke }),
    error => error?.code === 'RAG_GENERATION_PROVIDER_BUSY'
  );
  assert.equal(calls, 2);

  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    await invokeGenerationWithDeadline({ modelKey, timeoutMs: 50, invoke }),
    'recovered'
  );
  assert.equal(calls, 3);
});

test('generation deadline keeps a stable timeout error when the provider rejects on abort', async () => {
  const modelKey = `test-cooperative-${Date.now()}`;
  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 10,
      invoke: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException(
          'provider observed abort',
          'AbortError'
        )), { once: true });
      }),
    }),
    error => error?.code === 'RAG_GENERATION_TIMEOUT'
  );
});

test('generation request cancellation stays distinct from timeout and tracks non-cooperative work', async () => {
  const controller = new AbortController();
  let releaseCancelledWork;
  const cancelledWork = new Promise(resolve => { releaseCancelledWork = resolve; });
  const modelKey = `test-request-cancel-${Date.now()}`;
  const cancelled = invokeGenerationWithDeadline({
    modelKey,
    timeoutMs: 1000,
    signal: controller.signal,
    invoke: async signal => {
      assert.equal(signal.aborted, false);
      await cancelledWork;
      return 'late';
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('private disconnect reason'));

  await assert.rejects(cancelled, error => {
    assert.equal(error?.code, 'RAG_REQUEST_ABORTED');
    assert.equal(error.message.includes('private disconnect reason'), false);
    return true;
  });
  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 1000,
      invoke: async () => 'must not start',
    }),
    error => error?.code === 'RAG_GENERATION_PROVIDER_BUSY'
  );

  releaseCancelledWork();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    await invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 1000,
      invoke: async () => 'recovered',
    }),
    'recovered'
  );
});

test('POST propagates NextRequest.signal and returns a stable cancellation envelope', async t => {
  const errorLogs = [];
  t.mock.method(console, 'error', (...values) => errorLogs.push(values));
  setAgenticFixture(agenticFixture({ waitForAbort: true }));
  const controller = new AbortController();
  const pendingResponse = POST(askRequest(controller.signal));

  const queryStarted = await waitForAgenticQuerySignal();
  if (!queryStarted) {
    controller.abort(new Error('test query-start timeout cleanup'));
    await pendingResponse;
  }
  assert.equal(queryStarted, true);
  assert.equal(getAgenticQuerySignals().length, 1);
  controller.abort(new Error('private HTTP disconnect'));

  const response = await pendingResponse;
  const body = await response.json();
  const serialized = JSON.stringify({ body, errorLogs });
  assert.equal(response.status, 499);
  assert.equal(body.code, 'RAG_REQUEST_ABORTED');
  assert.equal(body.rag.error.code, 'RAG_REQUEST_ABORTED');
  assert.equal(response.headers.get('x-rag-status'), 'failed');
  assert.equal(serialized.includes('private HTTP disconnect'), false);
  assert.equal(getAgenticQuerySignals()[0].aborted, true);
});

test('POST maps terminal agentic failure to a content-free partial Kernel envelope', async t => {
  const errorLogs = [];
  t.mock.method(console, 'error', (...values) => errorLogs.push(values));
  setAgenticFixture(agenticFixture({
    error: 'private provider failure: sk-do-not-leak',
    workflowSteps: [
      { step: 'retrieve_original', status: 'completed' },
      { step: 'generate', status: 'error', error: 'private generation failure' },
    ],
  }));

  const response = await POST(askRequest());
  const body = await response.json();
  const serialized = JSON.stringify(body);
  const serializedLogs = JSON.stringify(errorLogs);

  assert.equal(response.status, 502);
  assert.equal(body.code, 'AGENTIC_QUERY_FAILED');
  assert.equal(body.rag.status, 'failed');
  assert.equal(body.rag.evidence[0].id.startsWith('legacy-policy-'), true);
  assert.equal(response.headers.get('x-rag-policy'), 'agentic');
  assert.equal(response.headers.get('x-rag-status'), 'failed');
  for (const privateValue of [
    'private evidence content',
    'private provider failure',
    'private generation failure',
    'sk-do-not-leak',
    'private_metadata',
  ]) {
    assert.equal(serialized.includes(privateValue), false);
    assert.equal(serializedLogs.includes(privateValue), false);
  }
  assert.match(serializedLogs, /RAG_POLICY_EXECUTION_FAILED/);
});

async function waitForAgenticQuerySignal(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (
    getAgenticQuerySignals().length === 0
    && Date.now() < deadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return getAgenticQuerySignals().length > 0;
}

const durableAskRouteEnvironmentKeys = [
  'RAG_DURABLE_ASK_MODE',
  'RAG_DURABLE_WORKFLOW_STORE_ROOT',
  'RAG_DURABLE_WORKFLOW_INTEGRITY_KEY',
  'RAG_DURABLE_WORKFLOW_MULTI_INSTANCE',
  'RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE',
  'RAG_DURABLE_WORKFLOW_CONTROL_PLANE',
  'RAG_DURABLE_WORKFLOW_LEASE_MS',
  'RAG_DURABLE_WORKFLOW_MAX_THREADS',
  'RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS',
  'RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS',
  'RAG_ORDERED_CONTEXT_MODE',
  'MILVUS_HYBRID_MODE',
  'MILVUS_HYBRID_ENABLED',
  'RAG_MIROFISH_GRAPH_MODE',
  'RAG_PDF_VISUAL_MODE',
  'RAG_SINGLE_TENANT_ROLE',
];

async function configureDurableAskRoute(
  t,
  {
    mode,
    multiInstance = false,
    leaseDurationMs,
    checkpointMaxThreads = 64,
    resultMaxArtifacts,
    tombstoneRetentionMs,
  } = {}
) {
  const parent = await mkdtemp(path.join(tmpdir(), 'ask-durable-route-'));
  const root = path.join(parent, 'runtime');
  const snapshot = Object.fromEntries(
    durableAskRouteEnvironmentKeys.map(key => [key, process.env[key]])
  );
  for (const key of durableAskRouteEnvironmentKeys) delete process.env[key];
  Object.assign(process.env, {
    RAG_DURABLE_ASK_MODE: mode ?? 'active',
    RAG_DURABLE_WORKFLOW_STORE_ROOT: root,
    RAG_DURABLE_WORKFLOW_INTEGRITY_KEY:
      'ask-route-durable-integrity-key-0123456789abcdef',
    RAG_DURABLE_WORKFLOW_CONTROL_PLANE: 'file',
    RAG_DURABLE_WORKFLOW_MAX_THREADS: String(checkpointMaxThreads),
    RAG_ORDERED_CONTEXT_MODE: 'off',
    MILVUS_HYBRID_MODE: 'off',
    RAG_MIROFISH_GRAPH_MODE: 'off',
    RAG_PDF_VISUAL_MODE: 'off',
    RAG_SINGLE_TENANT_ROLE: 'owner',
  });
  if (multiInstance) {
    process.env.RAG_DURABLE_WORKFLOW_MULTI_INSTANCE = 'true';
  }
  if (leaseDurationMs !== undefined) {
    process.env.RAG_DURABLE_WORKFLOW_LEASE_MS = String(leaseDurationMs);
  }
  if (resultMaxArtifacts !== undefined) {
    process.env.RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS = String(
      resultMaxArtifacts
    );
  }
  if (tombstoneRetentionMs !== undefined) {
    process.env.RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS = String(
      tombstoneRetentionMs
    );
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root };
}

function storedDurableRouteResult(traceId, answer) {
  return {
    schemaVersion: 'rag-durable-ask-http-v1',
    status: 200,
    headers: {
      'x-rag-status': 'completed',
      'x-rag-trace-id': traceId,
    },
    body: { success: true, answer },
  };
}

function durableMilvusAskRequest(question, idempotencyKey, signal) {
  return new NextRequest('http://localhost/api/ask', {
    method: 'POST',
    signal,
    headers: {
      authorization: 'Bearer ask-route-token',
      'content-type': 'application/json',
      'x-request-id': 'ask-route-durable-test',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      question,
      executionMode: 'durable',
      storageBackend: 'milvus',
      corpusId: 'corpus-a',
      topK: 2,
    }),
  });
}

function durableAgenticAskRequest(idempotencyKey, signal) {
  return new NextRequest('http://localhost/api/ask', {
    method: 'POST',
    signal,
    headers: {
      authorization: 'Bearer ask-route-token',
      'content-type': 'application/json',
      'x-request-id': 'ask-route-durable-agentic-test',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      question: 'What is scoped?',
      executionMode: 'durable',
      storageBackend: 'milvus',
      useAgenticRAG: true,
      corpusId: 'corpus-a',
      topK: 2,
    }),
  });
}

function durableAskStatusRequest(
  idempotencyKey,
  { includeResult = false, threadId } = {}
) {
  const query = new URLSearchParams({ corpusId: 'corpus-a' });
  if (includeResult) query.set('includeResult', 'true');
  if (threadId) query.set('threadId', threadId);
  return new NextRequest('http://localhost/api/ask?' + query, {
    method: 'GET',
    headers: {
      authorization: 'Bearer ask-route-token',
      'x-request-id': 'ask-route-durable-status-test',
      'idempotency-key': idempotencyKey,
    },
  });
}

function durableAskManagementRequest(command) {
  return new NextRequest('http://localhost/api/ask?corpusId=corpus-a', {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer ask-route-token',
      'content-type': 'application/json',
      'x-request-id': 'ask-route-durable-management-test',
    },
    body: JSON.stringify(command),
  });
}

async function readTreeText(root) {
  if (!existsSync(root)) return '';
  const entries = await readdir(root, { withFileTypes: true });
  const parts = [];
  for (const entry of entries.sort((left, right) => (
    left.name.localeCompare(right.name)
  ))) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) parts.push(await readTreeText(target));
    else if (entry.isFile()) parts.push(await readFile(target, 'utf8'));
  }
  return parts.join('\n');
}

async function findTreeFiles(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? findTreeFiles(target) : [target];
  }))).flat();
}

const pdfVisualRouteEnvironmentKeys = [
  'RAG_PDF_VISUAL_MODE',
  'RAG_PDF_VISUAL_MODEL',
  'RAG_PDF_VISUAL_STORE_ROOT',
  'RAG_PDF_VISUAL_MULTI_INSTANCE',
  'RAG_PDF_VISUAL_REQUIRE_SHARED_CONTROL_PLANE',
  'RAG_ORDERED_CONTEXT_MODE',
  'MILVUS_HYBRID_MODE',
  'MILVUS_HYBRID_ENABLED',
  'RAG_MIROFISH_GRAPH_MODE',
];

async function configurePdfVisualRouteEnvironment(
  t,
  { mode, model, multiInstance = false }
) {
  const root = await mkdtemp(path.join(tmpdir(), 'ask-pdf-visual-route-'));
  const snapshot = Object.fromEntries(
    pdfVisualRouteEnvironmentKeys.map(key => [key, process.env[key]])
  );
  for (const key of pdfVisualRouteEnvironmentKeys) delete process.env[key];
  Object.assign(process.env, {
    RAG_PDF_VISUAL_MODE: mode,
    RAG_PDF_VISUAL_STORE_ROOT: root,
    RAG_ORDERED_CONTEXT_MODE: 'off',
    MILVUS_HYBRID_MODE: 'off',
    RAG_MIROFISH_GRAPH_MODE: 'off',
  });
  if (model) process.env.RAG_PDF_VISUAL_MODEL = model;
  if (multiInstance) process.env.RAG_PDF_VISUAL_MULTI_INSTANCE = 'true';
  t.after(async () => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function createPdfVisualRouteFixture(t, mode) {
  const root = await configurePdfVisualRouteEnvironment(t, {
    mode,
    model: 'vision-model-a',
  });
  const source = new TextEncoder().encode('%PDF-1.7 visual route fixture');
  const imageBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x01, 0x02, 0x03, 0x04,
  ]);
  const identity = pdfVisualIdentity();
  const manifest = buildPdfAssetManifest({
    source,
    sourceName: 'visual.pdf',
    documentId: identity.documentId,
    documentVersion: identity.documentVersion,
    parsed: {
      text: 'page one chart',
      pages: 1,
      pageTexts: ['page one chart'],
      parseMethod: 'pdf-parse-v2',
    },
    scope: miroFishRouteScope(),
    trustLevel: identity.trustLevel,
    pageImages: [{
      pageNumber: 1,
      imageRef: 'pages/page-0001.png',
      contentDigest: sha256PdfAsset(imageBytes),
      width: 1,
      height: 1,
      byteLength: imageBytes.byteLength,
      mimeType: 'image/png',
    }],
  });
  const store = new FilePdfAssetStore(root);
  await store.put({
    manifest,
    pageImages: [{ pageNumber: 1, bytes: imageBytes }],
  });
  return { root, store, manifest, identity };
}

function pdfVisualIdentity() {
  return {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'pdf:sha256:route-a',
    documentVersion: 'sha256:pdf-route-a',
    trustLevel: 'external',
  };
}

function pdfDenseResult(identity) {
  return {
    id: 'pdf-dense-a',
    content: 'dense PDF evidence',
    metadata: {
      tenant_id: identity.tenantId,
      corpus_id: identity.corpusId,
      document_id: identity.documentId,
      document_version: identity.documentVersion,
      trust_level: identity.trustLevel,
      source: 'visual.pdf',
      type: 'pdf',
    },
    score: 0.95,
    distance: 0.05,
  };
}

const miroFishRouteEnvironmentKeys = [
  'RAG_MIROFISH_GRAPH_MODE',
  'RAG_MIROFISH_GRAPH_STORE_ROOT',
  'RAG_MIROFISH_GRAPH_DOCUMENT_ID',
  'RAG_MIROFISH_GRAPH_DOCUMENT_VERSION',
  'RAG_MIROFISH_GRAPH_TRUST_LEVEL',
  'RAG_MIROFISH_GRAPH_MULTI_INSTANCE',
  'RAG_MIROFISH_GRAPH_REQUIRE_SHARED_CONTROL_PLANE',
  'RAG_ORDERED_CONTEXT_MODE',
];

async function configureMiroFishRouteEnvironment(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ask-mirofish-route-'));
  const snapshot = Object.fromEntries(
    miroFishRouteEnvironmentKeys.map(key => [key, process.env[key]])
  );
  for (const key of miroFishRouteEnvironmentKeys) delete process.env[key];
  Object.assign(process.env, {
    RAG_MIROFISH_GRAPH_MODE: 'active',
    RAG_MIROFISH_GRAPH_STORE_ROOT: root,
    RAG_ORDERED_CONTEXT_MODE: 'off',
  });
  t.after(async () => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function createMiroFishRouteFixture(
  t,
  { documentId, marker, activate }
) {
  const root = await configureMiroFishRouteEnvironment(t);
  const store = new FileMiroFishGraphArtifactStore(root);
  const graph = createMiroFishRouteGraph(documentId, marker);
  const identity = {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId,
    documentVersion: createMiroFishGraphDocumentVersion(graph),
    trustLevel: 'reviewed',
  };
  await store.put(createMiroFishGraphArtifact({ identity, graph }));
  if (activate) {
    await store.compareAndSetActive(miroFishRouteScope(), identity, 0);
  }
  return { root, store, graph, identity };
}

function createMiroFishRouteGraph(documentId, marker) {
  const content = `${marker}: 方案甲提升召回，方案乙降低延迟。`;
  return {
    graph_id: documentId,
    nodes: [{
      uuid: `${documentId}-node-a`,
      name: '方案甲',
      labels: ['方案'],
      summary: '提升召回',
      attributes: { sourceChunks: [`${documentId}-passage`] },
    }, {
      uuid: `${documentId}-node-b`,
      name: '方案乙',
      labels: ['方案'],
      summary: '降低延迟',
      attributes: { sourceChunks: [`${documentId}-passage`] },
    }],
    edges: [{
      uuid: `${documentId}-edge`,
      name: 'COMPARES_WITH',
      fact: content,
      fact_type: 'COMPARES_WITH',
      source_node_uuid: `${documentId}-node-a`,
      target_node_uuid: `${documentId}-node-b`,
      source_node_name: '方案甲',
      target_node_name: '方案乙',
      attributes: { sourceChunks: [`${documentId}-passage`] },
      episodes: [],
    }],
    node_count: 2,
    edge_count: 1,
    artifact_version: 'mirofish-graph-v2',
    passages: [{
      id: `${documentId}-passage`,
      document_id: documentId,
      content,
      index: 0,
      start_offset: 0,
      end_offset: content.length,
    }],
    communities: [],
  };
}

function miroFishRouteScope() {
  return {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed', 'external'],
    enforceIsolation: true,
  };
}


function configureHybridRouteEnvironment(t, mode) {
  const keys = [
    'MILVUS_HYBRID_MODE',
    'MILVUS_HYBRID_ENABLED',
    'RAG_HYBRID_PROBE_TIMEOUT_MS',
    'RAG_HYBRID_SEARCH_TIMEOUT_MS',
    'RAG_ORDERED_CONTEXT_MODE',
    'RAG_MIROFISH_GRAPH_MODE',
  ];
  const snapshot = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.MILVUS_HYBRID_ENABLED;
  Object.assign(process.env, {
    MILVUS_HYBRID_MODE: mode,
    RAG_ORDERED_CONTEXT_MODE: 'off',
    RAG_MIROFISH_GRAPH_MODE: 'off',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function askRequest(signal) {
  return new NextRequest('http://localhost/api/ask', {
    method: 'POST',
    signal,
    headers: {
      authorization: 'Bearer ask-route-token',
      'content-type': 'application/json',
      'x-request-id': 'ask-route-test',
    },
    body: JSON.stringify({
      question: 'What is scoped?',
      storageBackend: 'milvus',
      useAgenticRAG: true,
      corpusId: 'corpus-a',
      topK: 2,
    }),
  });
}


function milvusAskRequest(question) {
  return new NextRequest('http://localhost/api/ask', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ask-route-token',
      'content-type': 'application/json',
      'x-request-id': 'ask-route-ordered-test',
    },
    body: JSON.stringify({
      question,
      storageBackend: 'milvus',
      corpusId: 'corpus-a',
      topK: 2,
    }),
  });
}

function orderedRows() {
  return [
    orderedRow('ordered-b', 'doc-b', 0, 1, 'raw-b'),
    orderedRow('ordered-a', 'doc-a', 0, 1, 'raw-a'),
  ];
}

function orderedRow(id, documentId, chunkIndex, totalChunks, originalContent) {
  return {
    id,
    content: 'contextual-' + originalContent,
    source: documentId + '.md',
    metadata_json: JSON.stringify({
      originalContent,
      startOffset: chunkIndex * 10,
      endOffset: chunkIndex * 10 + originalContent.length,
    }),
    tenant_id: 'tenant-a',
    corpus_id: 'corpus-a',
    document_id: documentId,
    trust_level: 'reviewed',
    document_version: 'sha256:' + documentId,
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
  };
}

function hybridResult(content) {
  return {
    id: 'hybrid-a',
    content,
    source: 'hybrid.md',
    metadata: {
      tenant_id: 'tenant-a',
      corpus_id: 'corpus-a',
      document_id: 'hybrid-doc-a',
      document_version: 'hybrid-v1',
      trust_level: 'reviewed',
      lexicalMatch: true,
    },
    score: 0.97,
  };
}

function denseResult() {
  return {
    id: 'dense-a',
    content: 'dense evidence',
    metadata: {
      tenant_id: 'tenant-a',
      corpus_id: 'corpus-a',
      document_id: 'dense-doc-a',
      document_version: 'dense-v1',
      trust_level: 'reviewed',
      source: 'dense.md',
    },
    score: 0.9,
    distance: 0.1,
  };
}
function agenticFixture(overrides = {}) {
  return {
    query: 'What is scoped?',
    originalQuery: 'What is scoped?',
    processedQuery: 'What is scoped?',
    topK: 2,
    similarityThreshold: 0,
    maxRetries: 2,
    gradePassThreshold: 0.5,
    retrievedDocuments: [{
      content: 'private evidence content',
      metadata: {
        tenant_id: 'tenant-a', corpus_id: 'corpus-a', trust_level: 'reviewed',
        document_id: 'document-a', document_version: 'v1',
        private_metadata: 'must not leak on failure',
      },
      score: 0.9,
      relevanceScore: 0.9,
    }],
    originalQueryResults: [],
    processedQueryResults: [],
    context: 'private evidence content',
    answer: 'scoped answer',
    currentStep: 'completed',
    retryCount: 0,
    shouldRewrite: false,
    shouldRetrieve: true,
    workflowSteps: [],
    startTime: 1,
    endTime: 2,
    totalDuration: 1,
    retrievalQuality: { overallScore: 0.9 },
    ...overrides,
  };
}
