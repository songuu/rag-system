import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { createOwnedGenerationIndex, sealOwnedGenerationIndex, prepareGenerationIndexOperation,
  inspectGenerationIndexOperation, getGenerationSealPitCleanupDiagnostic, observeSealedGenerationIndex } = await import('./generation-seal.ts');
const identity = { tenantId: 'tenant', corpusId: 'corpus', documentId: 'document', generation: '1', documentVersion: 'v1' };
const documents = [{ tenant_id: 'tenant', corpus_id: 'corpus', document_id: 'document', document_version: 'v1',
  chunk_id: 'chunk-1', trust_level: 'external', content: 'example', metadata: {} }];

function fakeClient() {
  let created;
  let uuid = 'uuid-123';
  let blockResponse;
  let afterBlock;
  let extra = false;
  let creationUnknown = false;
  let searchFailure;
  let closeFailure = false;
  let settingsBlocked = false;
  const calls = [];
  const client = {
    indices: {
      async create(request) { calls.push('create'); created = request; if (creationUnknown) throw new Error('timeout'); return { acknowledged: true, index: request.index }; },
      async get(request) {
        calls.push('get');
        return { [request.index]: { aliases: {}, mappings: { _meta: created.mappings._meta },
          settings: { index: { uuid, blocks: { write: String(settingsBlocked) } } } } };
      },
      async addBlock(request) {
        calls.push('block'); settingsBlocked = true;
        afterBlock?.();
        return blockResponse ?? { acknowledged: true, shards_acknowledged: true, indices: [{ name: request.index, blocked: true }] };
      },
      async refresh() { calls.push('refresh'); return { _shards: { failed: 0 } }; },
    },
    async openPointInTime() { calls.push('open'); return { id: 'pit', _shards: { failed: 0 } }; },
    async search(request) {
      calls.push('search');
      if (searchFailure) throw searchFailure;
      assert.deepEqual(request.query, { match_all: {} });
      const id = createHash('sha256').update(JSON.stringify(['tenant', 'corpus', 'document', '1', 'chunk-1'])).digest('hex');
      return { pit_id: 'pit', timed_out: false, _shards: { failed: 0 },
        hits: { total: { value: extra ? 2 : 1, relation: 'eq' }, hits: [{ _id: id, _source: { ...documents[0], publication_generation: '1' }, sort: ['chunk-1', 0] }] } };
    },
    async closePointInTime() { calls.push('close'); if (closeFailure) throw new Error('secret endpoint'); return { succeeded: true }; },
  };
  return { client, calls, changeUuid(value) { uuid = value; }, block(value) { blockResponse = value; },
    afterBlock(callback) { afterBlock = callback; }, includeExtra() { extra = true; }, unknownCreate() { creationUnknown = true; },
    failSearch(error) { searchFailure = error; }, failClose() { closeFailure = true; } };
}

const create = client => createOwnedGenerationIndex({ client, operation: prepareGenerationIndexOperation(identity) });

test('read-only reconciliation verifies the complete index without refresh or writes', async () => {
  const f = fakeClient(); const operation = prepareGenerationIndexOperation(identity);
  const handle = await createOwnedGenerationIndex({ client: f.client, operation });
  await sealOwnedGenerationIndex({ client: f.client, handle, documents });
  f.calls.length = 0;
  const result = await observeSealedGenerationIndex({ client: f.client, ...handle, ownerMarker: operation.marker, identity, documents });
  assert.equal(result.count, 1);
  assert.deepEqual(f.calls, ['get', 'open', 'search', 'close', 'get']);
});

test('read-only reconciliation rejects replacement and extra physical index rows', async () => {
  const f = fakeClient(); const operation = prepareGenerationIndexOperation(identity);
  const handle = await createOwnedGenerationIndex({ client: f.client, operation });
  await sealOwnedGenerationIndex({ client: f.client, handle, documents });
  const request = { client: f.client, ...handle, ownerMarker: operation.marker, identity, documents };
  f.changeUuid('replaced');
  await assert.rejects(observeSealedGenerationIndex(request), /identity/);
  f.changeUuid(handle.indexUuid); f.includeExtra();
  await assert.rejects(observeSealedGenerationIndex(request), /contents/);
});

test('creates its own unpredictable physical index and seals after identity check', async () => {
  const f = fakeClient();
  const handle = await create(f.client);
  assert.match(handle.indexName, /^codex-generation-seal-[0-9a-f]{32}$/);
  const result = await sealOwnedGenerationIndex({ client: f.client, handle, documents });
  assert.equal(result.indexUuid, 'uuid-123');
  assert.equal(result.productionAuthorized, false);
  assert.equal(result.observation.kind, 'point-in-time-observation');
  assert.deepEqual(f.calls, ['create', 'get', 'get', 'block', 'get', 'refresh', 'open', 'search', 'close', 'get']);
});

test('rejects forged handles and a handle used with another client before mutation', async () => {
  const f = fakeClient(); const other = fakeClient();
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle: { indexName: 'existing-index', indexUuid: 'u' }, documents }));
  const handle = await create(f.client);
  await assert.rejects(sealOwnedGenerationIndex({ client: other.client, handle, documents }));
  assert.equal(other.calls.length, 0);
  assert.equal(f.calls.includes('block'), false);
});

test('refuses to block when the owned index UUID changed', async () => {
  const f = fakeClient(); const handle = await create(f.client);
  f.changeUuid('recreated');
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), /identity/i);
  assert.equal(f.calls.includes('block'), false);
});

test('fails closed on unacknowledged block and never reuses the handle', async () => {
  const f = fakeClient(); const handle = await create(f.client);
  f.block({ acknowledged: false, shards_acknowledged: true, indices: [{ name: handle.indexName, blocked: true }] });
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), /block/i);
  assert.equal(f.calls.includes('open'), false);
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), /handle/i);
});

test('detects index replacement after blocking and refuses observation', async () => {
  const f = fakeClient(); const handle = await create(f.client);
  f.afterBlock(() => f.changeUuid('replacement'));
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), /identity/i);
  assert.equal(f.calls.includes('refresh'), false);
});

test('pre-aborted sealing does not block the owned index', async () => {
  const f = fakeClient(); const handle = await create(f.client);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents, signal: controller.signal }), /cancelled/);
  assert.equal(f.calls.includes('block'), false);
});

test('rejects extra documents anywhere in the physical index, including other scope or generation', async () => {
  const f = fakeClient(); const handle = await create(f.client); f.includeExtra();
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), /contents/i);
  assert.equal(f.calls.at(-1), 'close');
});

test('persisted create identity supports inspection after unknown outcome without enabling destructive operations', async () => {
  const f = fakeClient(); f.unknownCreate();
  const operation = JSON.parse(JSON.stringify(prepareGenerationIndexOperation(identity)));
  await assert.rejects(createOwnedGenerationIndex({ client: f.client, operation }), /timeout/);
  assert.deepEqual(await inspectGenerationIndexOperation({ client: f.client, operation }),
    { kind: 'matching-marker', indexName: operation.indexName, indexUuid: 'uuid-123' });
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle: operation, documents }), /handle/i);
  assert.equal(f.calls.includes('block'), false);
});

test('preserves primary failure with redacted cleanup diagnostic when PIT close also fails', async () => {
  const f = fakeClient(); const handle = await create(f.client);
  const original = Object.freeze(new Error('primary query failure'));
  f.failSearch(original); f.failClose();
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), error => error === original);
  assert.equal(getGenerationSealPitCleanupDiagnostic(original), 'Generation seal PIT close failed.');
});

test('reports redacted close failure when the observation otherwise succeeded', async () => {
  const f = fakeClient(); const handle = await create(f.client); f.failClose();
  await assert.rejects(sealOwnedGenerationIndex({ client: f.client, handle, documents }), error =>
    error.message === 'Generation seal PIT close failed.' && !error.message.includes('secret'));
});
