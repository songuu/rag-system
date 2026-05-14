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

const { MemoryCorpusStore } = await import('./corpus-store.ts');

test('MemoryCorpusStore creates stable document and manifest identities', () => {
  const store = new MemoryCorpusStore();
  store.upsertCorpus({
    id: 'course:demo',
    name: 'Demo Course',
    sourceKind: 'maic-course',
  });

  const first = store.upsertDocument({
    corpusId: 'course:demo',
    source: 'slides.pptx',
    contentType: 'text/plain',
    content: '第一页\n第二页',
  });
  const second = store.upsertDocument({
    corpusId: 'course:demo',
    source: 'slides.pptx',
    contentType: 'text/plain',
    content: '第一页\n第二页',
  });
  const manifest = store.updateManifest({
    corpusId: 'course:demo',
    documentIds: [first.id],
    embeddingModel: 'nomic-embed-text',
  });

  assert.equal(first.id, second.id);
  assert.equal(store.getCorpus('course:demo')?.sourceKind, 'maic-course');
  assert.equal(store.getManifest('course:demo')?.versionHash, manifest.versionHash);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

