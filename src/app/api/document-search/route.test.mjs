import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const asModule = source => ({ shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(source) });
globalThis.documentSearchCalls = [];
const evidence = (id, source) => ({ id, documentId:id, source, tenantId:'tenant-a', corpusId:'corpus-a',
  documentVersion:'v1', trustLevel:'external', content:'matching text', retrievalScore:1, laneId:'document-search', metadata:{} });
globalThis.documentSearchRows = Array.from({ length: 8 }, (_, index) =>
  evidence(`other-${index}`, `other-${index}.txt`)).concat(evidence('target', 'REPORT.PDF'));
const mocks = {
  '@/lib/rag': `export function adaptMilvusSearchResultsToEvidence(results) { return results; }`,
  '@/lib/documents/document-type-filter': `
    export class DocumentTypeFilterUnavailableError extends Error { constructor() { super('unavailable'); this.status=503; this.code='DOCUMENT_TYPE_FILTER_UNAVAILABLE'; } }
    export async function listDocumentIdsForFileType(scope, type) { globalThis.documentSearchCalls.push(['catalog', scope, type]); return ['target']; }
    export function applyDocumentTypeToMilvusOptions(options, ids) { return { ...options, exprValues: { ...options.exprValues, fileTypeDocumentIds: ids } }; }
  `,
  '@/lib/elasticsearch/client': `export async function getElasticsearchClient() { return {}; }`,
  '@/lib/elasticsearch/config': `export function getElasticsearchRuntimeConfig() { return { mode:'active', indexName:'test', rrfRankConstant:60 }; } export function assertElasticsearchConfigured() {}`,
  '@/lib/elasticsearch/lexical-index': `export async function searchElasticsearchLexical(input) { globalThis.documentSearchCalls.push(['lexical', input]); return globalThis.documentSearchRows.filter(row => !input.documentIds || input.documentIds.includes(row.documentId)).slice(0,input.topK); }`,
  '@/lib/embedding-config': `export function getEmbeddingConfigSummary() { return { model:'test' }; }`,
  '@/lib/milvus-client': `export function getMilvusInstance() { return { async connect(){}, async initializeCollection(){}, getConfig(){ return { embeddingDimension:2 }; }, async search(vector, topK, options) { globalThis.documentSearchCalls.push(['dense', options]); return globalThis.documentSearchRows.filter(row => !options.exprValues.fileTypeDocumentIds || options.exprValues.fileTypeDocumentIds.includes(row.documentId)).slice(0,topK); } }; }`,
  '@/lib/milvus-config': `export function getMilvusConnectionConfig() { return {}; }`,
  '@/lib/vectorization-utils': `export function selectModelForCollection() { return 'test'; } export async function generateQueryEmbedding() { return [1,0]; }`,
  '@/lib/rag/vector-backend': `export function isVectorBackendDisabled() { return false; } export const VECTOR_BACKEND_DISABLED_CODE='disabled', VECTOR_BACKEND_DISABLED_MESSAGE='disabled';`,
  '@/lib/rag/vector-ingest-state': `export function assertVectorSearchReady() {} export class VectorIndexBuildingError extends Error {}`,
  '@/lib/security/request-context': `export class RagSecurityError extends Error {} export async function resolveRagSecurityContext() { return { tenantId:'tenant-a', corpusId:'corpus-a', enforceIsolation:true }; }`,
};
registerHooks({ resolve(specifier, context, next) {
  if (mocks[specifier]) return asModule(mocks[specifier]);
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, context);
  if (specifier.startsWith('.')) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(target) && existsSync(new URL(target.href + '.ts'))) return next(target.href + '.ts', context);
  }
  return next(specifier, context);
} });
const { POST } = await import('./route.ts');

for (const strategy of ['semantic', 'keyword', 'hybrid']) {
  test(`${strategy} applies type selection before candidates are truncated`, async () => {
    globalThis.documentSearchCalls = [];
    const request = new Request('http://localhost/api/document-search', { method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ query:'test', topK:1, fileType:'pdf', strategy }) });
    const response = await POST(request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.results.map(item => item.documentId), ['target']);
    const calls = globalThis.documentSearchCalls;
    assert.equal(calls[0][0], 'catalog');
    if (strategy !== 'keyword') assert.deepEqual(calls.find(call => call[0] === 'dense')[1].exprValues.fileTypeDocumentIds, ['target']);
    if (strategy !== 'semantic') assert.deepEqual(calls.find(call => call[0] === 'lexical')[1].documentIds, ['target']);
  });
}
