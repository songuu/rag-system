import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { loadKnowledgeDatasetSources } = await import('./knowledge-dataset-sources.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['trusted', 'reviewed', 'external'], enforceIsolation: true };
function document(id = 'asset-a', chunks = 2) { return {
  id, documentId: 'doc-' + id, name: id + '.pdf', documentVersion: 'sha256:version-' + id,
  trustLevel: 'reviewed', chunkCount: chunks, milvusStatus: 'ready', enabled: true, lifecycle: 'active',
}; }
function row(doc, index, content = '第' + index + '块资料') { return {
  id: doc.documentId + '-chunk-' + index, content, source: 'untrusted-source',
  tenant_id: scope.tenantId, corpus_id: scope.corpusId, document_id: doc.documentId,
  document_version: doc.documentVersion, trust_level: doc.trustLevel, chunk_index: index, total_chunks: doc.chunkCount,
  metadata_json: JSON.stringify({ originalContent: content, startOffset: index * 20, page: index + 1, arbitrary: 'do not copy' }),
}; }
function ports(documents, makeRows = (doc, indices) => indices.map(index => row(doc, index))) {
  const calls = { catalogs: 0, reads: [] };
  return { calls,
    async listDocuments(actualScope) { calls.catalogs++; assert.deepEqual(actualScope, scope); return documents; },
    async queryDocumentRows(actualScope, identity, chunks, options) {
      assert.deepEqual(actualScope, scope);
      assert.equal(options.readOnly, true); assert.equal(options.consistencyLevel, 'Strong');
      const doc = documents.find(value => value.documentId === identity.documentId);
      assert.equal(chunks, doc.chunkCount);
      calls.reads.push({ identity, chunks, options });
      return makeRows(doc, options.chunkIndices);
    },
  };
}
const load = (documentAssetIds, injected, extra = {}) => loadKnowledgeDatasetSources({ documentAssetIds, scope, ...extra }, injected);

test('loads authorized canonical source chunks without sending forged provider metadata onward', async () => {
  const doc = document(); const injected = ports([doc], (doc, indices) => indices.map(index => ({ ...row(doc, index), content: 'contextual expansion', metadata_json: JSON.stringify({ originalContent: '  原始正文' + index + '\n', page: index + 1, documentId: doc.documentId, arbitrary: 'private' }) })));
  const result = await load([doc.id], injected);
  assert.equal(injected.calls.catalogs, 2);
  assert.equal(result.corpus.length, 2);
  assert.equal(result.corpus[0].evidenceId, doc.documentId + '-chunk-0');
  assert.equal(result.corpus[0].documentId, doc.documentId);
  assert.equal(result.corpus[0].documentVersion, doc.documentVersion);
  assert.equal(result.corpus[0].tenantId, scope.tenantId);
  assert.equal(result.corpus[0].trustLevel, doc.trustLevel);
  assert.equal(result.corpus[0].source, doc.name);
  assert.equal(result.corpus[0].content, '  原始正文0\n');
  assert.equal(result.corpus[0].metadata.documentAssetId, doc.id);
  assert.equal(result.corpus[0].metadata.chunkIndex, 0);
  assert.equal(result.corpus[0].metadata.arbitrary, undefined);
  assert.deepEqual(result.sourceCoverage, [{ documentAssetId: doc.id, source: doc.name, documentVersion: doc.documentVersion,
    totalChunks: 2, selectedChunks: 2, characterCount: result.corpus.reduce((sum, value) => sum + value.content.length, 0), sampled: false }]);
});

test('accepts Milvus Int64 strings and normalizes equivalent numeric metadata aliases', async () => {
  const doc = document();
  const actual = await load([doc.id], ports([doc], (doc, indices) => indices.map(index => {
    const value = row(doc, index);
    return { ...value, chunk_index: String(index), total_chunks: String(doc.chunkCount),
      metadata_json: JSON.stringify({ ...JSON.parse(value.metadata_json), chunkIndex: index,
        chunk_index: String(index), totalChunks: String(doc.chunkCount), total_chunks: doc.chunkCount }),
    };
  })));
  const expected = await load([doc.id], ports([doc]));
  assert.deepEqual(actual, expected);
  assert.equal(typeof actual.corpus[0].metadata.chunkIndex, 'number');
  assert.equal(typeof actual.corpus[0].metadata.totalChunks, 'number');
});

test('rejects malformed and unsafe Int64 values in scalar fields and metadata', async () => {
  const doc = document();
  for (const value of ['1e0', '0.5', '', ' ', '-1', '9007199254740992', 0.5, null, true]) {
    for (const field of ['chunk_index', 'total_chunks']) {
      await assert.rejects(load([doc.id], ports([doc], (doc, indices) => indices.map(index => ({
        ...row(doc, index), [field]: value,
      })))), error => error.status === 503);
    }
    await assert.rejects(load([doc.id], ports([doc], (doc, indices) => indices.map(index => ({
      ...row(doc, index), metadata_json: JSON.stringify({ chunkIndex: value }),
    })))), error => error.status === 503);
  }
});

test('numeric normalization still rejects duplicate indices, wrong counts and conflicting aliases', async () => {
  const doc = document();
  for (const patch of [
    () => ({ chunk_index: '0', total_chunks: '2' }),
    index => ({ chunk_index: String(index), total_chunks: '3' }),
    index => ({ chunk_index: String(index), total_chunks: '2', metadata_json: JSON.stringify({ chunkIndex: '99' }) }),
    index => ({ chunk_index: String(index), total_chunks: '2', metadata_json: JSON.stringify({ totalChunks: '3' }) }),
  ]) {
    await assert.rejects(load([doc.id], ports([doc], (doc, indices) => indices.map(index => ({
      ...row(doc, index), ...patch(index),
    })))), error => error.status === 503);
  }
});

test('rejects invalid selections and unisolated/quarantined scopes before any provider IO', async () => {
  const injected = ports([document()]);
  for (const ids of [[], ['a', 'a'], [' a ', 'a'], Array.from({ length: 9 }, (_, i) => 'a' + i), ['../a'], ['a'.repeat(129)]]) await assert.rejects(load(ids, injected));
  await assert.rejects(loadKnowledgeDatasetSources({ documentAssetIds: ['asset-a'], scope: { ...scope, enforceIsolation: false } }, injected));
  await assert.rejects(loadKnowledgeDatasetSources({ documentAssetIds: ['asset-a'], scope: { ...scope, allowedTrustLevels: ['quarantined'] } }, injected));
  assert.equal(injected.calls.catalogs, 0);
});

test('missing selections fail uniformly; disabled, deleting, stale and unready documents are rejected before reads', async () => {
  const injected = ports([document()]);
  await assert.rejects(load(['foreign-asset'], injected), error => error.status === 404);
  assert.equal(injected.calls.reads.length, 0);
  for (const patch of [{ enabled: false }, { lifecycle: 'deleting' }, { milvusStatus: 'unknown' }, { chunkCount: 0 }, { documentVersion: 'unknown' }, { documentVersion: 'unversioned' }, { trustLevel: 'quarantined' }]) {
    const doc = { ...document(), ...patch }; const p = ports([doc]);
    await assert.rejects(load([doc.id], p), error => error.status === 409);
    assert.equal(p.calls.reads.length, 0);
  }
});

test('large documents sample deterministic evenly distributed indices including first and last', async () => {
  const doc = document('large', 100_000); const injected = ports([doc]);
  const result = await load([doc.id], injected);
  const indices = injected.calls.reads[0].options.chunkIndices;
  assert.equal(indices.length, 6); assert.equal(indices[0], 0); assert.equal(indices[5], 99_999);
  assert.ok(indices.every((value, index) => index === 0 || value > indices[index - 1]));
  assert.equal(result.sourceCoverage[0].sampled, true);
  assert.equal(result.sourceCoverage[0].totalChunks, 100_000);
  assert.equal(result.sourceCoverage[0].selectedChunks, 6);
  assert.deepEqual((await load([doc.id], ports([doc]))).corpus, result.corpus);
});

test('missing, duplicate, forged and malformed indexed chunks fail closed', async () => {
  const doc = document();
  for (const mutate of [
    rows => rows.slice(1), rows => [rows[0], rows[0]],
    rows => rows.map((r, i) => i ? r : { ...r, tenant_id: 'foreign' }),
    rows => rows.map((r, i) => i ? r : { ...r, corpus_id: 'foreign' }),
    rows => rows.map((r, i) => i ? r : { ...r, document_id: 'foreign' }),
    rows => rows.map((r, i) => i ? r : { ...r, document_version: 'stale' }),
    rows => rows.map((r, i) => i ? r : { ...r, trust_level: 'trusted' }),
    rows => rows.map((r, i) => i ? r : { ...r, chunk_index: 20 }),
    rows => rows.map((r, i) => i ? r : { ...r, total_chunks: 20 }),
    rows => rows.map((r, i) => i ? r : { ...r, id: '' }),
    rows => rows.map((r, i) => i ? r : { ...r, metadata_json: '{invalid' }),
    rows => rows.map((r, i) => i ? r : { ...r, metadata_json: JSON.stringify({ documentId: 'foreign' }) }),
  ]) {
    await assert.rejects(load([doc.id], ports([doc], (doc, indices) => mutate(indices.map(index => row(doc, index))))), error => error.status === 503);
  }
});

test('budget keeps whole chunks and covers every selected document or fails explicitly', async () => {
  const docs = [document('a', 6), document('b', 6), document('c', 6)];
  const result = await load(docs.map(doc => doc.id), ports(docs, (doc, indices) => indices.map(index => row(doc, index, 'x'.repeat(index === 3 ? 1000 : 6000)))));
  assert.ok(result.corpus.reduce((sum, value) => sum + value.content.length, 0) <= 24_000);
  assert.equal(new Set(result.corpus.map(value => value.documentId)).size, 3);
  assert.ok(result.sourceCoverage.every(value => value.selectedChunks >= 1 && value.sampled));
  assert.ok(result.corpus.every(value => value.content.length === 6000 || value.content.length === 1000));
  const tooLarge = [document('a', 1), document('b', 1)];
  await assert.rejects(load(tooLarge.map(doc => doc.id), ports(tooLarge, (doc, indices) => indices.map(index => row(doc, index, 'x'.repeat(13000))))), error => error.status === 413);
});

test('rechecks authority after reading; disappearance, disabling and changed versions discard all sources', async () => {
  for (const patch of [null, { enabled: false }, { documentVersion: 'new-revision' }, { chunkCount: 3 }]) {
    const doc = document(); const injected = ports([doc]);
    injected.listDocuments = async () => ++injected.calls.catalogs === 1 ? [doc] : patch ? [{ ...doc, ...patch }] : [];
    await assert.rejects(load([doc.id], injected), error => error.status === 409);
  }
});

test('provider failures are sanitized; cancellation remains cancellation', async () => {
  const doc = document(); const injected = ports([doc]);
  injected.queryDocumentRows = async () => { throw new Error('SECRET provider endpoint'); };
  await assert.rejects(load([doc.id], injected), error => error.status === 503 && !error.message.includes('SECRET'));
  const controller = new AbortController(); controller.abort();
  const canceled = ports([doc]);
  await assert.rejects(load([doc.id], canceled, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(canceled.calls.catalogs, 0);
});
