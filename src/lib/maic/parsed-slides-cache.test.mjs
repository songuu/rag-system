import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getMaicParsedSlidesCacheIdentity,
  loadParsedSlidesFromCache,
  saveParsedSlidesToCache,
} from './parsed-slides-cache.ts';

test('MAIC parsed slides cache identity is stable for the same file content', () => {
  const input = { buffer: Buffer.from('hello\n\nworld'), filename: 'lesson.pdf' };
  const first = getMaicParsedSlidesCacheIdentity(input);
  const second = getMaicParsedSlidesCacheIdentity(input);

  assert.equal(first.cache_key, second.cache_key);
  assert.equal(first.file_hash, second.file_hash);
});

test('MAIC parsed slides cache stores and restores parsed pages', async () => {
  const identity = getMaicParsedSlidesCacheIdentity({
    buffer: Buffer.from(`cache-test-${Date.now()}`),
    filename: 'lesson.md',
  });
  const parsed = {
    filename: 'lesson.md',
    raw_text: '# Lesson\n\nKey point',
    pages: [
      {
        index: 0,
        raw_text: '# Lesson\n\nKey point',
        description: '',
        key_points: [],
      },
    ],
  };

  assert.equal(await loadParsedSlidesFromCache(identity), null);
  assert.equal(await saveParsedSlidesToCache(identity, parsed), true);
  assert.deepEqual(await loadParsedSlidesFromCache(identity), parsed);
});
