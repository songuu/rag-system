import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { extractYouTubeId, splitDocument } = await import('./document-pipeline.ts');

test('extractYouTubeId accepts exact YouTube watch, short, embed, shorts, and raw IDs', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(extractYouTubeId(id), id);
  assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(extractYouTubeId(`https://youtu.be/${id}?t=4`), id);
  assert.equal(extractYouTubeId(`https://youtube.com/embed/${id}`), id);
  assert.equal(extractYouTubeId(`https://m.youtube.com/shorts/${id}`), id);
});

test('extractYouTubeId rejects hostname spoofing and unsupported schemes', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(extractYouTubeId(`https://youtube.com.attacker.example/watch?v=${id}`), null);
  assert.equal(extractYouTubeId(`https://attacker.example/youtube.com/watch?v=${id}`), null);
  assert.equal(extractYouTubeId(`javascript:https://youtube.com/watch?v=${id}`), null);
  assert.equal(extractYouTubeId(`https://www.youtube.com.evil.test/embed/${id}`), null);
});

test('extractYouTubeId rejects malformed IDs and unrelated YouTube paths', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(extractYouTubeId('https://www.youtube.com/channel/dQw4w9WgXcQ'), null);
  assert.equal(extractYouTubeId('not-a-youtube-url'), null);
});

test('splitDocument rejects unsafe overlap even when called outside the route', async () => {
  await assert.rejects(
    () => splitDocument(
      { content: 'a'.repeat(300), metadata: { source: 'doc', type: 'raw' } },
      { chunkSize: 100, chunkOverlap: 51 }
    ),
    /safe processing bounds/
  );
});

test('splitDocument rejects documents that exceed the request chunk budget', async () => {
  await assert.rejects(
    () => splitDocument(
      { content: 'a'.repeat(400), metadata: { source: 'doc', type: 'raw' } },
      { chunkSize: 100, chunkOverlap: 50, maxChunks: 2 }
    ),
    /exceeding the limit of 2/
  );
});
