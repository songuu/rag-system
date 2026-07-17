import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const pipelineStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let calls = [];
let failure;
export function resetPipelineCalls() { calls = []; failure = undefined; }
export function getPipelineCalls() { return structuredClone(calls); }
export function setPipelineFailure(value) { failure = value; }
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
    if (failure === 'reconciliation') {
      throw new MilvusHybridIngestReconciliationRequiredError(
        'MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED',
        503,
        'Milvus hybrid ingest requires reconciliation. reconciliationId=audit-test'
      );
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
      metadata: { source: options.filename, type: 'pdf' },
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/document-pipeline') {
      return { url: pipelineStubUrl, shortCircuit: true };
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
  'SUPABASE_DEFAULT_TENANT_ID',
  'SUPABASE_DEFAULT_CORPUS_ID',
  'RAG_PDF_VISUAL_MODE',
];
const originalEnvironment = Object.fromEntries(
  environmentKeys.map(key => [key, process.env[key]])
);
Object.assign(process.env, {
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'pipeline-route-token',
  RAG_SINGLE_TENANT_ROLE: 'owner',
  RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a',
  SUPABASE_DEFAULT_TENANT_ID: 'tenant-a',
  SUPABASE_DEFAULT_CORPUS_ID: 'corpus-a',
  RAG_PDF_VISUAL_MODE: 'active',
});

const { NextRequest } = await import('next/server');
const { POST } = await import('./route.ts');
const {
  getPipelineCalls,
  resetPipelineCalls,
  setPipelineFailure,
} = await import(pipelineStubUrl);

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('authenticated multipart PDF reaches the production pipeline seam with server scope', async () => {
  resetPipelineCalls();
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

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.successful, 1);
  assert.equal(body.results[0].pdfVisual.status, 'published');
  assert.equal(body.results[0].pdfVisual.visualPageCount, 2);
  assert.equal(call.inputIsBuffer, true);
  assert.equal(new TextDecoder().decode(new Uint8Array(call.inputBytes)).startsWith('%PDF-1.7'), true);
  assert.equal(call.filename, '测试 visual.pdf');
  assert.equal(call.type, 'pdf');
  assert.equal(call.metadata.tenantId, 'tenant-a');
  assert.equal(call.metadata.corpusId, 'corpus-a');
  assert.equal(call.metadata.trustLevel, 'external');
  assert.equal(call.signalIsAbortSignal, true);
  assert.equal('tenantId' in body.results[0].pdfVisual, false);
  assert.equal('rootDir' in body.results[0].pdfVisual, false);
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
