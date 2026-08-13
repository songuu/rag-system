import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { PostgresBlobStore } = await import('./postgres-blob-store.ts');

const CONFIG = {
  databaseUrl: 'postgresql://rag:secret@db/rag',
  defaultTenantId: 'tenant-a',
  defaultCorpusId: 'corpus-a',
  sslMode: 'disable',
  maxConnections: 5,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  persistenceBackend: 'postgres',
  vectorBackend: 'milvus',
};

test('PostgreSQL blob store parameterizes binary writes and implements the full blob contract', async () => {
  const calls = [];
  const responses = [
    { rows: [], rowCount: 1 },
    { rows: [{ exists: true }], rowCount: 1 },
    { rows: [{ data: Buffer.from('hello') }], rowCount: 1 },
    { rows: [{ filename: 'a.txt' }, { filename: 'b.txt' }], rowCount: 2 },
    { rows: [{ size: '5', modified: '2026-08-13T00:00:00.000Z' }], rowCount: 1 },
    { rows: [{ filename: 'a.txt' }], rowCount: 1 },
  ];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return responses.shift();
    },
  };
  const store = new PostgresBlobStore(CONFIG, client);

  await store.write('a.txt', new Uint8Array([104, 101, 108, 108, 111]), {
    kind: 'parsed',
    contentType: 'text/plain',
    metadata: { source: 'test' },
  });
  assert.equal(await store.exists('a.txt'), true);
  assert.equal(await store.readText('a.txt'), 'hello');
  assert.deepEqual(await store.list(), ['a.txt', 'b.txt']);
  assert.deepEqual(await store.stat('a.txt'), {
    size: 5,
    modified: '2026-08-13T00:00:00.000Z',
  });
  assert.equal(await store.delete('a.txt'), true);

  assert.match(calls[0].text, /insert into object_blobs/i);
  assert.match(calls[0].text, /on conflict/i);
  assert.deepEqual(calls[0].values.slice(0, 4), ['tenant-a', 'corpus-a', 'parsed', 'a.txt']);
  assert.ok(Buffer.isBuffer(calls[0].values[4]));
  assert.equal(calls[0].text.includes('a.txt'), false);
  assert.match(calls[3].text, /order by filename/i);
  assert.match(calls[5].text, /delete from object_blobs/i);
});

test('PostgreSQL blob store fails explicitly when persistence scope is incomplete', () => {
  assert.throws(
    () => new PostgresBlobStore({ ...CONFIG, defaultCorpusId: '' }, { query: async () => ({ rows: [], rowCount: 0 }) }),
    /POSTGRES_DEFAULT_CORPUS_ID/
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
