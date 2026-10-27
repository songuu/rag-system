import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.includes('documents/document-visibility')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export async function listRetrievableDocumentIds() {
      if (globalThis.visibilityError) throw new Error('catalog offline');
      return globalThis.allowedDocumentIds;
    }
  `) };
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { searchElasticsearchLexical } = await import('./lexical-index.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['external'], enforceIsolation: true };
function fixture() {
  const requests = [];
  return { requests, input: { scope, indexName: 'test', query: '黑死病', topK: 10, laneId: 'lexical',
    client: { search: async request => { requests.push(request); return { hits: { hits: [] } }; } } } };
}
test('lexical retrieval positively restricts the query to enabled catalog documents, excluding orphan projections', async () => {
  globalThis.allowedDocumentIds = ['enabled-doc']; globalThis.visibilityError = false;
  const { input, requests } = fixture(); await searchElasticsearchLexical(input);
  assert.ok(requests[0].query.bool.filter.some(filter => JSON.stringify(filter) === JSON.stringify({ terms: { document_id: ['enabled-doc'] } })));
});
test('an empty catalog allowlist returns no evidence without searching a stale index', async () => {
  globalThis.allowedDocumentIds = []; globalThis.visibilityError = false;
  const { input, requests } = fixture(); assert.deepEqual(await searchElasticsearchLexical(input), []);
  assert.equal(requests.length, 0);
});
test('catalog failure cannot fall back to an unfiltered lexical query', async () => {
  globalThis.visibilityError = true;
  const { input, requests } = fixture(); await assert.rejects(searchElasticsearchLexical(input), /catalog offline/);
  assert.equal(requests.length, 0); globalThis.visibilityError = false;
});
