import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });

const { deleteManagedDocument, setManagedDocumentEnabled, parseDocumentMutation } = await import('./document-lifecycle.ts');
const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['external'], enforceIsolation: true };
const asset = { id: 'asset-1', documentId: 'doc-1', metadata: {}, lifecycle: 'active' };

function fixture(failingStage) {
  const calls = [];
  const step = name => async (...args) => { calls.push([name, ...args]); if (name === failingStage) throw new Error('backend unavailable'); };
  return { calls, ports: {
    store: {
      beginDelete: async input => { calls.push(['block', input]); return asset; },
      completeDelete: step('complete'),
      setEnabled: step('toggle'),
    },
    deleteVectors: step('vectors'),
    deleteLexical: step('lexical'),
    deleteAssets: step('assets'),
  } };
}

test('delete commits a retrieval block before scoped cleanup and only completes afterwards', async () => {
  const { calls, ports } = fixture();
  await deleteManagedDocument({ id: asset.id, scope }, ports);
  assert.deepEqual(calls.map(call => call[0]), ['block', 'vectors', 'lexical', 'assets', 'complete']);
  assert.equal(calls[1][2], scope);
  assert.equal(calls[1][1].documentId, asset.documentId);
});

for (const stage of ['vectors', 'lexical', 'assets']) {
  test(`failed ${stage} cleanup leaves document blocked and supports retry`, async () => {
    const { calls, ports } = fixture(stage);
    await assert.rejects(deleteManagedDocument({ id: asset.id, scope }, ports), error => error.code === 'DOCUMENT_DELETE_INCOMPLETE' && error.status === 503);
    assert.equal(calls.some(call => call[0] === 'complete'), false);
    await deleteManagedDocument({ id: asset.id, scope }, fixture().ports);
  });
}

test('already deleted documents can be deleted again without touching indexes', async () => {
  const { calls, ports } = fixture();
  ports.store.beginDelete = async () => ({ ...asset, lifecycle: 'deleted' });
  await deleteManagedDocument({ id: asset.id, scope }, ports);
  assert.deepEqual(calls, []);
});

test('enable/disable persists a boolean without deleting any vector', async () => {
  const { calls, ports } = fixture();
  await setManagedDocumentEnabled({ id: asset.id, scope, enabled: false }, ports.store);
  await setManagedDocumentEnabled({ id: asset.id, scope, enabled: true }, ports.store);
  assert.deepEqual(calls.map(call => [call[0], call[1].enabled]), [['toggle', false], ['toggle', true]]);
});

test('mutation input rejects ambiguous identifiers, truthy strings and extra scope fields', () => {
  assert.deepEqual(parseDocumentMutation({ id: asset.id, enabled: false }, 'PATCH'), { id: asset.id, enabled: false });
  for (const value of [{ id: '' }, { id: 'x', enabled: 'false' }, { id: 'x', enabled: true, tenantId: 'other' }]) {
    assert.throws(() => parseDocumentMutation(value, 'PATCH'), error => error.status === 400);
  }
  assert.throws(() => parseDocumentMutation({ id: '../x' }, 'DELETE'));
});
