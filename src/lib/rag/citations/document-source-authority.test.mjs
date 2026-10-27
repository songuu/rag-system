import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const source = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'external', chunkId: 'chunk-a' };
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', enforceIsolation: true, allowedTrustLevels: ['external'] };
const authority = { asset_id: 'asset-a', document_version: 'v1', trust_level: 'external', chunk_count: '2', source: '资料.txt', row_revision: '42' };
const chunk = { id: 'chunk-a', tenant_id: 'tenant-a', corpus_id: 'corpus-a', document_id: 'doc-a', document_version: 'v1', trust_level: 'external', chunk_index: '1', total_chunks: '2', content: '原始证据', metadata_json: '{}' };
async function fixture(rows = [chunk], assets = [authority]) {
  const { createDocumentCitationDependencies } = await import('./document-source-authority.ts');
  const calls = [];
  const dependencies = createDocumentCitationDependencies({ client: { async query(sql, params) { calls.push({ sql, params }); return { rows: assets, rowCount: assets.length }; } }, milvus: { async queryDocumentRows(...args) { calls.push({ args }); return rows; } } });
  return { dependencies, calls };
}
test('asset authority binds canonical version and live enabled lifecycle with transaction revision', async () => {
  const { dependencies, calls } = await fixture();
  const state = await dependencies.readAuthority(source);
  assert.equal(state.chunkCount, 2); assert.equal(state.source, '资料.txt');
  assert.match(calls[0].sql, /retrieval_enabled.*distinct from 'false'/s);
  assert.match(calls[0].sql, /lifecycle.*'active'/s);
  assert.match(calls[0].sql, /xmin/);
  assert.deepEqual(calls[0].params, ['tenant-a', 'corpus-a', 'doc-a', 'v1', 'external']);
  for (const assets of [[], [authority, authority], [{ ...authority, document_version: 'other' }]]) {
    assert.equal(await (await fixture([chunk], assets)).dependencies.readAuthority(source), null);
  }
});
test('chunk preview uses bounded strong read only and verifies exact scalar identities', async () => {
  const { dependencies, calls } = await fixture();
  const state = await dependencies.readAuthority(source);
  assert.equal((await dependencies.readChunk(source, state, scope, 1)).content, chunk.content);
  assert.deepEqual(calls[1].args[3], { readOnly: true, consistencyLevel: 'Strong', chunkIndices: [1] });
  for (const patch of [{ tenant_id: 'other' }, { corpus_id: 'other' }, { document_version: 'v2' }, { trust_level: 'quarantined' }, { id: 'other' }, { chunk_index: '1.5' }, { total_chunks: 3 }, { metadata_json: '{bad' }, { metadata_json: '{"chunkIndex":0}' }]) {
    assert.equal(await (await fixture([{ ...chunk, ...patch }])).dependencies.readChunk(source, state, scope, 1), null);
  }
  assert.equal(await (await fixture([chunk, chunk])).dependencies.readChunk(source, state, scope, 1), null);
});
