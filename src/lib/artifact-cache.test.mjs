import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const {
  createArtifactCacheIdentity,
  createStableHash,
  loadArtifactFromCache,
  saveArtifactToCache,
} = await import('./artifact-cache.ts');

test('stable artifact hash ignores object key insertion order', () => {
  assert.equal(
    createStableHash({ b: 2, a: { d: 4, c: 3 } }),
    createStableHash({ a: { c: 3, d: 4 }, b: 2 })
  );
});

test('artifact cache writes and validates typed artifacts atomically', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'rag-artifact-cache-'));
  const identity = createArtifactCacheIdentity({
    cacheDir,
    version: 'test-v1',
    source: { text: 'same source' },
    modelSignature: { provider: 'test', model: 'unit', temperature: 0 },
  });

  const saved = await saveArtifactToCache(identity, { value: 42 });
  const hit = await loadArtifactFromCache(identity, isValueArtifact);

  assert.equal(saved, true);
  assert.equal(hit?.artifact.value, 42);
  assert.match(identity.cache_file, /[a-f0-9]{32}\.json$/);
});

function isValueArtifact(value) {
  return !!value && typeof value === 'object' && typeof value.value === 'number';
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
