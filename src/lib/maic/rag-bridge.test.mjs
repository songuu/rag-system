import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

const { mirrorMaicCourseToRagUploads } = await import('./rag-bridge.ts');
const { createUploadPersistence } = await import('../persistence/upload-store.ts');

test('MAIC bridge writes one parsed blob before recording its manifest item', async () => {
  const events = [];
  const writes = [];
  const records = [];
  const persistence = createPersistenceDouble({ events, writes, records });

  const asset = await mirrorMaicCourseToRagUploads(
    {
      sourceText: 'Slide one\nSlide two',
      sourceFilename: '课程 介绍.pptx',
      sourceHash: 'abcdef1234567890',
      pageCount: 2,
    },
    {
      createPersistence: () => persistence,
      invalidateRagInstance: () => events.push('invalidate'),
      now: () => new Date('2026-08-14T01:02:03.000Z'),
    }
  );

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    filename: 'maic_abcdef123456_课程_介绍_parsed.txt',
    data: 'Slide one\nSlide two',
    options: {
      kind: 'parsed',
      contentType: 'text/plain; charset=utf-8',
      metadata: { source: 'maic', source_hash: 'abcdef1234567890' },
    },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].storedFilename, writes[0].filename);
  assert.equal(records[0].parsedFilename, writes[0].filename);
  assert.equal(records[0].source, 'maic');
  assert.equal(records[0].sourceHash, 'abcdef1234567890');
  assert.deepEqual(events, ['ensureRoot', 'exists', 'write', 'recordUpload', 'invalidate']);
  assert.deepEqual(asset, {
    source_hash: 'abcdef1234567890',
    parsed_filename: writes[0].filename,
    manifest_id: 'maic_abcdef123456',
    mirrored_at: '2026-08-14T01:02:03.000Z',
  });
});

test('MAIC bridge skips an unchanged blob but still upserts the manifest item', async () => {
  const events = [];
  const writes = [];
  const records = [];
  const persistence = createPersistenceDouble({
    events,
    writes,
    records,
    existingText: 'same text',
  });

  await mirrorMaicCourseToRagUploads(
    {
      sourceText: 'same text',
      sourceFilename: 'same.pptx',
      sourceHash: '1111111111112222',
    },
    {
      createPersistence: () => persistence,
      invalidateRagInstance: () => events.push('invalidate'),
    }
  );

  assert.equal(writes.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(events, ['ensureRoot', 'exists', 'readText', 'recordUpload', 'invalidate']);
});

test('MAIC bridge propagates PostgreSQL blob failures without a local fallback', async () => {
  const events = [];
  const persistence = createPersistenceDouble({
    events,
    writeError: new Error('postgres blob unavailable'),
  });

  await assert.rejects(
    mirrorMaicCourseToRagUploads(
      {
        sourceText: 'content',
        sourceFilename: 'failure.pptx',
        sourceHash: '2222222222223333',
      },
      {
        createPersistence: () => persistence,
        invalidateRagInstance: () => events.push('invalidate'),
      }
    ),
    /同步 MAIC 课程到 RAG uploads 失败: postgres blob unavailable/
  );

  assert.deepEqual(events, ['ensureRoot', 'exists', 'write']);
});

test('MAIC bridge propagates PostgreSQL manifest failures after the blob write', async () => {
  const events = [];
  const persistence = createPersistenceDouble({
    events,
    recordError: new Error('postgres manifest unavailable'),
  });

  await assert.rejects(
    mirrorMaicCourseToRagUploads(
      {
        sourceText: 'content',
        sourceFilename: 'failure.pptx',
        sourceHash: '3333333333334444',
      },
      {
        createPersistence: () => persistence,
        invalidateRagInstance: () => events.push('invalidate'),
      }
    ),
    /同步 MAIC 课程到 RAG uploads 失败: postgres manifest unavailable/
  );

  assert.deepEqual(events, ['ensureRoot', 'exists', 'write', 'recordUpload']);
});

test('MAIC bridge keeps local development on the shared upload persistence seam', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maic-rag-bridge-'));
  const previousBackend = process.env.RAG_PERSISTENCE_BACKEND;
  process.env.RAG_PERSISTENCE_BACKEND = 'local';
  t.after(async () => {
    if (previousBackend === undefined) delete process.env.RAG_PERSISTENCE_BACKEND;
    else process.env.RAG_PERSISTENCE_BACKEND = previousBackend;
    await rm(root, { recursive: true, force: true });
  });

  const asset = await mirrorMaicCourseToRagUploads(
    {
      sourceText: 'local course',
      sourceFilename: 'local.pptx',
      sourceHash: '4444444444445555',
    },
    {
      createPersistence: () => createUploadPersistence({ uploadDir: root }),
      invalidateRagInstance: () => {},
    }
  );

  assert.equal(await readFile(path.join(root, asset.parsed_filename), 'utf8'), 'local course');
  const manifest = JSON.parse(await readFile(path.join(root, 'file-manifest.json'), 'utf8'));
  assert.equal(manifest[asset.manifest_id].source, 'maic');
  assert.equal(manifest[asset.manifest_id].sourceHash, '4444444444445555');
});

function createPersistenceDouble({
  events,
  writes = [],
  records = [],
  existingText,
  writeError,
  recordError,
}) {
  return {
    blobStore: {
      async ensureRoot() {
        events.push('ensureRoot');
      },
      async exists() {
        events.push('exists');
        return existingText !== undefined;
      },
      async readText() {
        events.push('readText');
        return existingText;
      },
      async write(filename, data, options) {
        events.push('write');
        if (writeError) throw writeError;
        writes.push({ filename, data, options });
      },
      async list() {
        return [];
      },
      async stat() {
        throw new Error('not used');
      },
      async delete() {
        return false;
      },
    },
    manifestStore: {
      async loadManifest() {
        throw new Error('bridge should use recordUpload directly');
      },
      async saveManifest() {
        throw new Error('bridge should use recordUpload directly');
      },
      async recordUpload(item) {
        events.push('recordUpload');
        if (recordError) throw recordError;
        records.push(item);
      },
      async removeUpload() {
        return null;
      },
    },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
