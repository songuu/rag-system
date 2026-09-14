import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('splitDocument preserves separator gaps and records verifiable source identity', async () => {
  const content = `${'A'.repeat(120)}\n\n${'B'.repeat(120)}`;
  const expectedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const chunks = await splitDocument(
    { content, metadata: { source: 'separator-gap.txt', type: 'raw' } },
    { chunkSize: 100, chunkOverlap: 10 }
  );

  assert.equal(chunks[0].metadata.startOffset, 0);
  assert.equal(chunks.at(-1).metadata.endOffset, content.length);
  assert.ok(chunks.some(chunk => chunk.content.startsWith('\n\nB')));
  for (const chunk of chunks) {
    const { startOffset, endOffset, sourceTextLength, sourceTextHash } = chunk.metadata;
    assert.equal(chunk.content, content.slice(startOffset, endOffset));
    assert.equal(sourceTextLength, content.length);
    assert.equal(sourceTextHash, expectedHash);
  }
  assert.equal(reconstructChunks(chunks), content);
});

function reconstructChunks(chunks) {
  let text = '';
  let coveredEnd = 0;
  for (const chunk of chunks) {
    const { startOffset, endOffset } = chunk.metadata;
    assert.ok(startOffset <= coveredEnd, 'chunks must not contain uncovered gaps');
    text += chunk.content.slice(Math.max(0, coveredEnd - startOffset));
    coveredEnd = endOffset;
  }
  return text;
}
