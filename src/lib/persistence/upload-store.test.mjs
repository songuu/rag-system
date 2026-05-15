import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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

const { LocalBlobStore, LocalUploadManifestStore } = await import('./local-dev-store.ts');
const { createUploadPersistence } = await import('./upload-store.ts');
const { getSupabaseConfigSummary } = await import('../supabase/env.ts');

test('local blob store writes, reads, lists, stats, and deletes files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-upload-store-'));
  try {
    const store = new LocalBlobStore(root);
    await store.write('sample.txt', 'hello', { kind: 'parsed', contentType: 'text/plain' });

    assert.equal(await store.exists('sample.txt'), true);
    assert.equal(await store.readText('sample.txt'), 'hello');
    assert.deepEqual(await store.list(), ['sample.txt']);
    assert.equal((await store.stat('sample.txt')).size, 5);
    assert.equal(await store.delete('sample.txt'), true);
    assert.equal(await store.exists('sample.txt'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

test('local upload manifest store records and removes manifest items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-upload-manifest-'));
  try {
    const manifestFile = path.join(root, 'file-manifest.json');
    const store = new LocalUploadManifestStore(manifestFile);
    const item = {
      id: 'manifest-1',
      originalName: 'Guide.pdf',
      originalExtension: '.pdf',
      storedFilename: '1_Guide.pdf',
      parsedFilename: '1_Guide_parsed.txt',
      size: 1024,
      contentLength: 512,
      uploadedAt: '2026-05-15T00:00:00.000Z',
      parseMethod: 'pdf',
      pages: 2,
    };

    await store.recordUpload(item);
    assert.deepEqual(await store.loadManifest(), { 'manifest-1': item });
    assert.deepEqual(await store.removeUpload('Guide.pdf'), item);
    assert.deepEqual(await store.loadManifest(), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upload persistence defaults to local mode when Supabase is not enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-upload-persistence-'));
  try {
    delete process.env.RAG_PERSISTENCE_BACKEND;
    const persistence = createUploadPersistence({ uploadDir: root });
    await persistence.blobStore.write('local.txt', 'ok', { kind: 'parsed' });
    assert.equal(await persistence.blobStore.readText('local.txt'), 'ok');
    assert.equal(getSupabaseConfigSummary().persistenceBackend, 'local');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
