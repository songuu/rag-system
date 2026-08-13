import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeRetiredVendorSourceMaps } from './sanitize-build-sourcemaps.mjs';

const RETIRED_VENDOR = ['supa', 'base'].join('');

test('removes only source maps containing retired persistence vendor code', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-build-maps-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const chunks = path.join(root, 'server', 'chunks');
  await mkdir(chunks, { recursive: true });

  const retiredMap = path.join(chunks, 'retired.js.map');
  const cleanMap = path.join(chunks, 'clean.js.map');
  const runtimeFile = path.join(chunks, 'runtime.js');
  await writeFile(retiredMap, JSON.stringify({ sourcesContent: [RETIRED_VENDOR] }));
  await writeFile(cleanMap, JSON.stringify({ sourcesContent: ['postgres'] }));
  await writeFile(runtimeFile, RETIRED_VENDOR);

  const removed = await removeRetiredVendorSourceMaps(root);

  assert.deepEqual(removed, [retiredMap]);
  await assert.rejects(access(retiredMap), { code: 'ENOENT' });
  await access(cleanMap);
  await access(runtimeFile);
});

test('missing build directory is a no-op', async () => {
  const root = path.join(os.tmpdir(), `rag-missing-maps-${process.pid}`);
  assert.deepEqual(await removeRetiredVendorSourceMaps(root), []);
});
