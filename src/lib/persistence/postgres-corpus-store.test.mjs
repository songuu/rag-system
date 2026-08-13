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

const { PostgresUploadManifestStore } = await import('./postgres-corpus-store.ts');

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

test('manifest reads and removals are restricted to legacy manifest assets', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
  const store = new PostgresUploadManifestStore(CONFIG, client);

  await store.loadManifest();
  await store.removeUpload('guide.pdf');

  assert.match(calls[0].text, /metadata\s*\?\s*'manifest_id'/i);
  assert.match(calls[1].text, /metadata\s*\?\s*'manifest_id'/i);
  assert.deepEqual(calls.map(({ values }) => values.slice(0, 2)), [
    ['tenant-a', 'corpus-a'],
    ['tenant-a', 'corpus-a'],
  ]);
});

test('empty manifest replacement prunes only legacy manifest assets in the configured scope', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
  const store = new PostgresUploadManifestStore(CONFIG, client);

  await store.saveManifest({});

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /existing\.metadata\s*\?\s*'manifest_id'/i);
  assert.match(calls[0].text, /count\(\*\) as removed_count from removed/i);
  assert.deepEqual(JSON.parse(calls[0].values[2]), []);
  assert.equal(calls[0].text.includes('tenant-a'), false);
  assert.match(calls[0].text, /on conflict \(tenant_id, corpus_id, external_document_id\)/i);
});

test('recordUpload uses manifest id as the stable external document key', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new PostgresUploadManifestStore(CONFIG, client);

  await store.recordUpload({
    id: 'manifest-1',
    originalName: 'guide-v2.pdf',
    originalExtension: '.pdf',
    storedFilename: 'guide-v2.pdf',
    parsedFilename: 'guide-v2.txt',
    size: 20,
    contentLength: 40,
    uploadedAt: '2026-08-13T00:00:00.000Z',
    parseMethod: 'pdf',
  });

  assert.equal(calls[0].values[2], 'manifest-1');
  assert.match(calls[0].text, /on conflict \(tenant_id, corpus_id, external_document_id\)/i);
  assert.match(calls[0].text, /source_hash = excluded\.source_hash/i);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
