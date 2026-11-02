import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { listDocumentIdsForFileType, applyDocumentTypeToMilvusOptions } = await import('./document-type-filter.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['trusted', 'reviewed', 'external'] };

test('type filtering finds matching documents before any retrieval candidate limit', async () => {
  let call;
  const rows = Array.from({ length: 120 }, (_, index) => ({ document_id: `other-${index}`, source: `other-${index}.txt` }));
  rows.push({ document_id: 'target', source: 'REPORT.PDF' });
  const db = { query: async (sql, values) => { call = { sql, values }; return { rows, rowCount: rows.length }; } };
  assert.deepEqual(await listDocumentIdsForFileType(scope, 'pdf', { client: db }), ['target']);
  assert.deepEqual(call.values, ['tenant-a', 'corpus-a', scope.allowedTrustLevels, null]);
  assert.match(call.sql, /retrieval_enabled/);
  assert.match(call.sql, /lifecycle/);
  assert.doesNotMatch(call.sql, /\blimit\b/i);
});

test('file type and explicit document filters compose with the existing scope safely', () => {
  const ids = ['doc" || true || "'];
  const options = { filter: 'tenant_id == {tenant}', exprValues: { tenant: 'a' } };
  const filtered = applyDocumentTypeToMilvusOptions(options, ids);
  assert.match(filtered.filter, /document_id in \{fileTypeDocumentIds\}/);
  assert.equal(filtered.filter.includes(ids[0]), false);
  assert.deepEqual(filtered.exprValues, { tenant: 'a', fileTypeDocumentIds: ids });
  assert.match(applyDocumentTypeToMilvusOptions(options, []).filter, /document_id in \[\]/);
});

test('refuses to silently omit legacy documents whose source is unknown', async () => {
  const db = { query: async () => ({ rows: [
    { document_id: 'fallback.PDF', source: null },
    { document_id: 'misleading.pdf', source: 'actual.txt' },
  ], rowCount: 2 }) };
  await assert.rejects(listDocumentIdsForFileType(scope, 'pdf', { client: db }),
    error => error.code === 'DOCUMENT_TYPE_FILTER_UNAVAILABLE');
});

test('source checks only the requested document and allowed trust levels', async () => {
  const assets = [
    { document_id: 'target', source: 'target.pdf', trust: 'reviewed' },
    { document_id: 'other', source: null, trust: 'reviewed' },
    { document_id: 'restricted', source: null, trust: 'quarantined' },
  ];
  let query;
  const db = { query: async (sql, values) => {
    query = { sql, values };
    const rows = assets.filter(row => values[2].includes(row.trust) && (!values[3] || row.document_id === values[3]));
    return { rows, rowCount: rows.length };
  } };
  assert.deepEqual(await listDocumentIdsForFileType(scope, 'pdf', { client: db, documentId:'target' }), ['target']);
  assert.deepEqual(query.values, ['tenant-a', 'corpus-a', scope.allowedTrustLevels, 'target']);
  assert.match(query.sql, /metadata #>> '\{document,trustLevel\}'/);
  assert.match(query.sql, /metadata #>> '\{document,trust_level\}'/);
  assert.match(query.sql, /'external'[\s\S]*any\(\$3::text\[\]\)/);
  assert.match(query.sql, /external_document_id = \$4/);
  await assert.rejects(listDocumentIdsForFileType(scope, 'pdf', { client: db }),
    error => error.code === 'DOCUMENT_TYPE_FILTER_UNAVAILABLE');
  assert.deepEqual(await listDocumentIdsForFileType(scope, 'pdf', { client: db, documentId:'restricted' }), []);
});
