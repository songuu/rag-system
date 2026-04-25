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

const {
  createMaicSourceHash,
  getMaicPrepareCacheIdentity,
} = await import('./prepare-cache.ts');

test('MAIC source hash preserves slide page boundaries', () => {
  const sourceText = '第一页内容\n\n第二页内容';
  const splitPagesHash = createMaicSourceHash({
    sourceText,
    pages: [
      { index: 0, raw_text: '第一页内容', description: '', key_points: [] },
      { index: 1, raw_text: '第二页内容', description: '', key_points: [] },
    ],
  });
  const mergedPageHash = createMaicSourceHash({
    sourceText,
    pages: [{ index: 0, raw_text: sourceText, description: '', key_points: [] }],
  });

  assert.notEqual(splitPagesHash, mergedPageHash);
});

test('MAIC prepare cache identity is stable for the same source and model config', () => {
  const input = {
    sourceText: '稳定缓存内容',
    pages: [{ index: 0, raw_text: '稳定缓存内容', description: '', key_points: [] }],
  };

  const first = getMaicPrepareCacheIdentity(input);
  const second = getMaicPrepareCacheIdentity(input);

  assert.equal(first.cache_key, second.cache_key);
  assert.equal(first.source_hash, second.source_hash);
  assert.match(first.cache_file, /maic-cache[/\\][a-f0-9]{32}\.json$/);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
