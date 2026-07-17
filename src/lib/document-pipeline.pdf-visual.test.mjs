import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const runtimeStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let calls = 0;
const store = { id: 'store-test' };
const renderer = { id: 'renderer-test' };
export function resetRuntimeSignals() { calls = 0; }
export function getRuntimeSignals() { return { calls }; }
export function getPdfVisualAssetRuntime() {
  calls += 1;
  return {
    store,
    renderer,
    maxRenderPages: 7,
  };
}
`);
const ingestStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let calls = [];
let failure = false;
export function resetIngestSignals() { calls = []; failure = false; }
export function setIngestFailure(value) { failure = value; }
export function getIngestSignals() { return structuredClone(calls); }
export async function publishPdfVisualSidecar(input) {
  calls.push({
    mode: input.mode,
    source: [...input.source],
    sourceName: input.sourceName,
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    parsedPages: input.parsed.pages,
    tenantId: input.scope.tenantId,
    corpusId: input.scope.corpusId,
    trustLevel: input.trustLevel,
    maxRenderPages: input.maxRenderPages,
    hasStore: input.store?.id === 'store-test',
    hasRenderer: input.renderer?.id === 'renderer-test',
  });
  if (failure) throw new Error('private visual storage path');
  return {
    version: 'pdf-visual-ingest-v1',
    mode: input.mode,
    status: 'published',
    manifestVersion: 'pdf-asset-manifest-v1',
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    pageCount: input.parsed.pages,
    visualPageCount: 2,
  };
}
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === './rag/multimodal/pdf-visual-runtime'
      && context.parentURL?.endsWith('/document-pipeline.ts')
    ) {
      return { url: runtimeStubUrl, shortCircuit: true };
    }
    if (
      specifier === './rag/multimodal/pdf-visual-ingest'
      && context.parentURL?.endsWith('/document-pipeline.ts')
    ) {
      return { url: ingestStubUrl, shortCircuit: true };
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

const { publishPipelinePdfVisualSidecar } = await import('./document-pipeline.ts');
const { getRuntimeSignals, resetRuntimeSignals } = await import(runtimeStubUrl);
const {
  getIngestSignals,
  resetIngestSignals,
  setIngestFailure,
} = await import(ingestStubUrl);

test('pipeline visual caller keeps off and non-PDF paths at zero runtime I/O', async () => {
  resetRuntimeSignals();
  resetIngestSignals();

  const disabled = await publishPipelinePdfVisualSidecar({
    document: pdfDocument(),
    documentId: 'pdf:sha256:a',
    documentVersion: 'sha256:a',
    mode: 'off',
  });
  const nonPdf = await publishPipelinePdfVisualSidecar({
    document: {
      content: 'text',
      metadata: { source: 'text.txt', type: 'text' },
    },
    documentId: 'text.txt',
    documentVersion: 'sha256:text',
    mode: 'active',
  });

  assert.equal(disabled.status, 'disabled');
  assert.equal(nonPdf.status, 'not_applicable');
  assert.equal(getRuntimeSignals().calls, 0);
  assert.equal(getIngestSignals().length, 0);
});

test('pipeline visual caller binds raw PDF identity and server scope after text persistence', async () => {
  resetRuntimeSignals();
  resetIngestSignals();

  const result = await publishPipelinePdfVisualSidecar({
    document: pdfDocument(),
    documentId: 'pdf:sha256:a',
    documentVersion: 'sha256:a',
    mode: 'active',
  });
  const call = getIngestSignals()[0];

  assert.equal(result.status, 'published');
  assert.equal(result.visualPageCount, 2);
  assert.equal(getRuntimeSignals().calls, 1);
  assert.deepEqual(call.source, [37, 80, 68, 70]);
  assert.equal(call.documentId, 'pdf:sha256:a');
  assert.equal(call.documentVersion, 'sha256:a');
  assert.equal(call.tenantId, 'tenant-a');
  assert.equal(call.corpusId, 'corpus-a');
  assert.equal(call.trustLevel, 'external');
  assert.equal(call.maxRenderPages, 7);
  assert.equal(call.hasStore, true);
  assert.equal(call.hasRenderer, true);
});

test('pipeline visual caller keeps dense success and emits a bounded fallback on sidecar failure', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', (...values) => warnings.push(values));
  resetRuntimeSignals();
  resetIngestSignals();
  setIngestFailure(true);

  const result = await publishPipelinePdfVisualSidecar({
    document: pdfDocument(),
    documentId: 'pdf:sha256:a',
    documentVersion: 'sha256:a',
    mode: 'shadow',
  });

  assert.equal(result.status, 'fallback');
  assert.equal(result.fallbackReason, 'visual_sidecar_unavailable');
  assert.equal(result.visualPageCount, 0);
  assert.equal(JSON.stringify({ result, warnings }).includes('private visual storage path'), false);
  assert.equal(getRuntimeSignals().calls, 1);
  assert.equal(getIngestSignals().length, 1);
});

function pdfDocument() {
  return {
    content: 'first\n\f\nsecond',
    metadata: {
      source: 'document.pdf',
      type: 'pdf',
      pageCount: 2,
      tenantId: 'tenant-a',
      tenant_id: 'tenant-a',
      corpusId: 'corpus-a',
      corpus_id: 'corpus-a',
      trustLevel: 'external',
      trust_level: 'external',
    },
    pdfAssetSource: new Uint8Array([37, 80, 68, 70]),
    pdfParsed: {
      text: 'first\n\f\nsecond',
      pages: 2,
      pageTexts: ['first', 'second'],
      parseMethod: 'pdf-parse-v2',
    },
  };
}
