import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const pipelineStubUrl = 'data:text/javascript,' + encodeURIComponent(`
import { EmbeddingOutputValidationError } from '@/lib/embedding-batch';
let calls = [];
let failure;
let waitForRelease = false;
let releasePending;
export function resetPipelineCalls() {
  calls = [];
  failure = undefined;
  waitForRelease = false;
  releasePending = undefined;
}
export function getPipelineCalls() { return structuredClone(calls); }
export function setPipelineFailure(value) { failure = value; }
export function setPipelinePending() { waitForRelease = true; }
export function releasePipeline() {
  waitForRelease = false;
  releasePending?.();
  releasePending = undefined;
}
export const DataSourceType = undefined;
export class MilvusHybridIngestOperationalError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export class MilvusHybridIngestReconciliationRequiredError
  extends MilvusHybridIngestOperationalError {}
export class DocumentPipeline {
  constructor(config) { this.config = config; }
  async processDocument(input, options) {
    calls.push({
      inputIsBuffer: input instanceof Uint8Array,
      inputBytes: [...input],
      filename: options.filename,
      type: options.type,
      metadata: structuredClone(options.metadata),
      signalIsAbortSignal: options.signal instanceof AbortSignal,
      config: structuredClone(this.config),
    });
    if (waitForRelease) {
      await new Promise(resolve => { releasePending = resolve; });
    }
    if (failure === 'reconciliation') {
      throw new MilvusHybridIngestReconciliationRequiredError(
        'MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED',
        503,
        'Milvus hybrid ingest requires reconciliation. reconciliationId=audit-test'
      );
    }
    if (failure === 'embedding-output') {
      throw new EmbeddingOutputValidationError('private invalid vector detail');
    }
    if (failure === 'rolled_back') {
      throw new MilvusHybridIngestOperationalError(
        'MILVUS_HYBRID_ACTIVE_WRITE_FAILED_ROLLED_BACK',
        502,
        'Active Milvus hybrid write failed; exact compensation completed. reconciliationId=audit-test'
      );
    }
    return {
      documentId: 'pdf:sha256:route-test',
      chunks: 2,
      ids: ['chunk-a', 'chunk-b'],
      metadata: {
        source: options.filename,
        type: 'pdf',
        sourceHash: 'sha256:route-test',
      },
      contextualRetrieval: {
        version: 'contextual-retrieval/v2',
        mode: 'off',
        fallbackCount: 0,
        generatedCharacters: 0,
      },
      pdfVisual: {
        mode: 'active',
        status: 'published',
        manifestVersion: 'pdf-asset-manifest-v1',
        documentId: 'pdf:sha256:route-test',
        documentVersion: 'sha256:route-test',
        pageCount: 2,
        visualPageCount: 2,
      },
    };
  }
}
export async function loadDocument() { throw new Error('preview not expected'); }
export async function splitDocument() { throw new Error('preview not expected'); }
`);

const persistenceStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let calls = [];
let failure;
export function resetPersistenceCalls() { calls = []; failure = undefined; }
export function getPersistenceCalls() { return structuredClone(calls); }
export function setPersistenceFailure(value) { failure = value; }
export async function recordPipelineDocumentIfConfigured(input) {
  calls.push({
    ...input,
    source: input.source instanceof Uint8Array ? [...input.source] : input.source,
  });
  if (failure) throw new Error('database detail must stay private');
  return 'asset-route-test';
}
`);

const graphBuildStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let calls = [];
let failure;
export class KnowledgeGraphAutoBuildEnqueueError extends Error {
  constructor(reconciliationId, cause) {
    super(
      'Knowledge graph build enqueue requires reconciliation. reconciliationId=' + reconciliationId,
      { cause }
    );
    this.name = 'KnowledgeGraphAutoBuildEnqueueError';
    this.code = 'KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED';
    this.status = 503;
  }
}
export function resetGraphBuildCalls() { calls = []; failure = undefined; }
export function getGraphBuildCalls() { return structuredClone(calls); }
export function setGraphBuildFailure(value) { failure = value; }
export async function enqueueKnowledgeGraphBuildAfterVectorization(input) {
  calls.push(structuredClone(input));
  if (failure) {
    throw new KnowledgeGraphAutoBuildEnqueueError(
      'graph-route-test',
      new Error('private graph queue detail')
    );
  }
  return {
    enabled: true,
    job: {
      id: '11111111-1111-4111-8111-111111111111',
      graphVersion: 'kgv1:route-test',
      status: 'queued',
    },
  };
}
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/document-pipeline') {
      return { url: pipelineStubUrl, shortCircuit: true };
    }
    if (specifier === '@/lib/persistence/postgres-pipeline-store') {
      return { url: persistenceStubUrl, shortCircuit: true };
    }
    if (specifier === '@/lib/knowledge-graph/auto-build') {
      return { url: graphBuildStubUrl, shortCircuit: true };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(modulePath + '.ts')
        ? modulePath + '.ts'
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
        return nextResolve(specifier + '.ts', context);
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
  'RAG_PDF_VISUAL_MODE',
  'RAG_VECTOR_BACKEND',
  'RAG_GRAPH_BACKEND',
];
const originalEnvironment = Object.fromEntries(
  environmentKeys.map(key => [key, process.env[key]])
);
Object.assign(process.env, {
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'pipeline-route-token',
  RAG_SINGLE_TENANT_ROLE: 'owner',
  RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a',
  RAG_DEFAULT_TENANT_ID: 'tenant-a',
  RAG_DEFAULT_CORPUS_ID: 'corpus-a',
  RAG_PDF_VISUAL_MODE: 'active',
  RAG_GRAPH_BACKEND: 'neo4j',
});

const { NextRequest } = await import('next/server');
const { POST } = await import('./route.ts');
const {
  getPipelineCalls,
  releasePipeline,
  resetPipelineCalls,
  setPipelineFailure,
  setPipelinePending,
} = await import(pipelineStubUrl);
const {
  getPersistenceCalls,
  resetPersistenceCalls,
  setPersistenceFailure,
} = await import(persistenceStubUrl);
const {
  getGraphBuildCalls,
  resetGraphBuildCalls,
  setGraphBuildFailure,
} = await import(graphBuildStubUrl);
const {
  getVectorIngestSnapshot,
  resetVectorIngestStateForTests,
} = await import('@/lib/rag/vector-ingest-state');

after(() => {
  resetVectorIngestStateForTests();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('text ingest reserves one build slot and rejects concurrent ingestion', async () => {
  resetPipelineCalls();
  resetVectorIngestStateForTests();
  setPipelinePending();
  const first = POST(pipelineTextRequest('pipeline-ingest-first'));

  try {
    await waitForVectorIngestStatus('building');
    assert.equal(getVectorIngestSnapshot().activeOperations, 1);

    const second = await POST(pipelineTextRequest('pipeline-ingest-second'));
    const body = await second.json();
    assert.equal(second.status, 429);
    assert.equal(body.code, 'VECTOR_INGEST_BUSY');
    assert.equal(body.requestId, 'pipeline-ingest-second');
    assert.equal(second.headers.get('Retry-After'), '2');
  } finally {
    releasePipeline();
    await first;
    assert.equal(getVectorIngestSnapshot().status, 'ready');
    resetVectorIngestStateForTests();
  }
});

test('text ingest maps invalid embedding output to a stable 502 response', async () => {
  resetPipelineCalls();
  resetVectorIngestStateForTests();
  setPipelineFailure('embedding-output');

  const response = await POST(pipelineTextRequest('pipeline-invalid-embedding'));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.code, 'EMBEDDING_OUTPUT_INVALID');
  assert.equal(body.error, 'Embedding provider returned invalid vectors.');
  assert.equal(JSON.stringify(body).includes('private invalid vector detail'), false);
  assert.equal(getVectorIngestSnapshot().status, 'ready');
});

test('authenticated multipart PDF reaches the production pipeline seam with server scope', async () => {
  resetPipelineCalls();
  resetPersistenceCalls();
  resetGraphBuildCalls();
  const form = new FormData();
  form.append(
    'files',
    new File([new TextEncoder().encode('%PDF-1.7 route fixture')], '测试 visual.pdf', {
      type: 'application/pdf',
    })
  );
  form.append('chunkSize', '500');
  form.append('chunkOverlap', '50');

  const request = new NextRequest('http://localhost/api/pipeline', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pipeline-route-token',
      'x-rag-corpus-id': 'corpus-a',
      'x-request-id': 'pipeline-route-pdf-test',
      'content-length': '2048',
    },
    body: form,
  });
  const response = await POST(request);
  const body = await response.json();
  const call = getPipelineCalls()[0];
  const persistenceCall = getPersistenceCalls()[0];
  const graphBuildCall = getGraphBuildCalls()[0];

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.successful, 1);
  assert.equal(body.results[0].pdfVisual.status, 'published');
  assert.equal(body.results[0].pdfVisual.visualPageCount, 2);
  assert.equal(body.results[0].postgresAssetId, 'asset-route-test');
  assert.equal(body.results[0].graphBuild.status, 'queued');
  assert.equal(body.results[0].graphBuild.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(call.inputIsBuffer, true);
  assert.equal(new TextDecoder().decode(new Uint8Array(call.inputBytes)).startsWith('%PDF-1.7'), true);
  assert.equal(call.filename, '测试 visual.pdf');
  assert.equal(call.type, 'pdf');
  assert.equal(call.metadata.tenantId, 'tenant-a');
  assert.equal(call.metadata.corpusId, 'corpus-a');
  assert.equal(call.metadata.trustLevel, 'external');
  assert.equal(call.signalIsAbortSignal, true);
  assert.equal(persistenceCall.tenantId, 'tenant-a');
  assert.equal(persistenceCall.corpusId, 'corpus-a');
  assert.equal(persistenceCall.actorId, 'actor-a');
  assert.equal(persistenceCall.documentId, 'pdf:sha256:route-test');
  assert.equal(persistenceCall.sourceHash, 'sha256:route-test');
  assert.equal(new TextDecoder().decode(new Uint8Array(persistenceCall.source)).startsWith('%PDF-1.7'), true);
  assert.equal(graphBuildCall.tenantId, 'tenant-a');
  assert.equal(graphBuildCall.corpusId, 'corpus-a');
  assert.equal(graphBuildCall.actorId, 'actor-a');
  assert.equal(graphBuildCall.documentId, 'pdf:sha256:route-test');
  assert.equal(graphBuildCall.documentVersion, 'sha256:route-test');
  assert.equal(graphBuildCall.trustLevel, 'external');
  assert.equal(graphBuildCall.postgresAssetId, 'asset-route-test');
  assert.equal(graphBuildCall.chunkCount, 2);
  assert.equal('tenantId' in body.results[0].pdfVisual, false);
  assert.equal('rootDir' in body.results[0].pdfVisual, false);
});

test('authenticated multipart ingest fails closed before pipeline construction when vectors are disabled', async () => {
  process.env.RAG_VECTOR_BACKEND = 'disabled';
  resetPipelineCalls();
  const form = new FormData();
  form.append(
    'files',
    new File([new TextEncoder().encode('%PDF-1.7 maintenance fixture')], 'maintenance.pdf', {
      type: 'application/pdf',
    })
  );

  try {
    const response = await POST(new NextRequest('http://localhost/api/pipeline', {
      method: 'POST',
      headers: {
        authorization: 'Bearer pipeline-route-token',
        'x-rag-corpus-id': 'corpus-a',
        'x-request-id': 'pipeline-route-maintenance-test',
        'content-length': '1024',
      },
      body: form,
    }));
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.code, 'VECTOR_BACKEND_DISABLED');
    assert.equal(body.requestId, 'pipeline-route-maintenance-test');
    assert.equal(getPipelineCalls().length, 0);
  } finally {
    delete process.env.RAG_VECTOR_BACKEND;
  }
});

test('multipart ingest exposes a stable reconciliation-required failure', async t => {
  t.mock.method(console, 'error', () => {});
  resetPipelineCalls();
  setPipelineFailure('reconciliation');
  const form = new FormData();
  form.append(
    'files',
    new File([new TextEncoder().encode('%PDF-1.7 failed write')], 'failed.pdf', {
      type: 'application/pdf',
    })
  );
  const response = await POST(new NextRequest('http://localhost/api/pipeline', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pipeline-route-token',
      'x-rag-corpus-id': 'corpus-a',
      'x-request-id': 'pipeline-route-reconciliation-test',
      'content-length': '1024',
    },
    body: form,
  }));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.code, 'MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED');
  assert.match(body.error, /reconciliationId=audit-test/);
  assert.equal(body.requestId, 'pipeline-route-reconciliation-test');
});

test('text ingest exposes the stable active-hybrid rolled-back failure', async t => {
  t.mock.method(console, 'error', () => {});
  resetPipelineCalls();
  setPipelineFailure('rolled_back');
  const response = await POST(new NextRequest('http://localhost/api/pipeline', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pipeline-route-token',
      'content-type': 'application/json',
      'x-request-id': 'pipeline-route-rolled-back-test',
    },
    body: JSON.stringify({
      action: 'process-text',
      text: 'safe retry fixture',
      source: 'fixture.txt',
      corpusId: 'corpus-a',
    }),
  }));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.success, false);
  assert.equal(body.code, 'MILVUS_HYBRID_ACTIVE_WRITE_FAILED_ROLLED_BACK');
  assert.match(body.error, /exact compensation completed/);
  assert.match(body.error, /reconciliationId=audit-test/);
  assert.equal(body.requestId, 'pipeline-route-rolled-back-test');
});

test('completed vector ingest exposes PostgreSQL reconciliation-required failure', async t => {
  t.mock.method(console, 'error', () => {});
  resetPipelineCalls();
  resetPersistenceCalls();
  setPersistenceFailure(true);
  const response = await POST(new NextRequest('http://localhost/api/pipeline', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pipeline-route-token',
      'content-type': 'application/json',
      'x-request-id': 'pipeline-route-postgres-reconciliation-test',
    },
    body: JSON.stringify({
      action: 'process-text',
      text: 'persist me',
      source: 'fixture.txt',
      corpusId: 'corpus-a',
    }),
  }));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.code, 'POSTGRES_INGEST_RECONCILIATION_REQUIRED');
  assert.match(body.error, /reconciliationId=[0-9a-f]{24}/);
  assert.equal(body.error.includes('database detail'), false);
  assert.equal(body.requestId, 'pipeline-route-postgres-reconciliation-test');
  assert.equal(getPipelineCalls().length, 1);
  assert.equal(getPersistenceCalls().length, 1);
});

test('completed vector ingest exposes graph BuildJob reconciliation-required failure', async t => {
  t.mock.method(console, 'error', () => {});
  resetPipelineCalls();
  resetPersistenceCalls();
  resetGraphBuildCalls();
  setGraphBuildFailure(true);
  const response = await POST(pipelineTextRequest('pipeline-route-graph-enqueue-test'));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.code, 'KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED');
  assert.match(body.error, /reconciliationId=graph-route-test/);
  assert.equal(body.error.includes('private graph queue detail'), false);
  assert.equal(body.requestId, 'pipeline-route-graph-enqueue-test');
  assert.equal(getPipelineCalls().length, 1);
  assert.equal(getPersistenceCalls().length, 1);
  assert.equal(getGraphBuildCalls().length, 1);
});

function pipelineTextRequest(requestId) {
  return new NextRequest('http://localhost/api/pipeline', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pipeline-route-token',
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({
      action: 'process-text',
      text: 'bounded vector ingest fixture',
      source: 'fixture.txt',
      corpusId: 'corpus-a',
    }),
  });
}

async function waitForVectorIngestStatus(expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getVectorIngestSnapshot().status === expected) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for vector ingest status: ' + expected);
}
