import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { publishPdfVisualSidecar } = await import('./pdf-visual-ingest.ts');
const { sha256Hex } = await import('./pdf-asset-manifest.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['external'],
  enforceIsolation: true,
});

test('PDF visual ingest off mode performs zero renderer and store work', async () => {
  const input = fixtureInput('off');
  const result = await publishPdfVisualSidecar(input);

  assert.equal(result.status, 'disabled');
  assert.equal(result.visualPageCount, 0);
});

test('PDF visual ingest publishes a scoped manifest and exact rendered bytes in shadow and active modes', async () => {
  for (const mode of ['shadow', 'active']) {
    const publications = [];
    const rendererCalls = [];
    const input = fixtureInput(mode, {
      renderer: {
        async render(request) {
          rendererCalls.push(request);
          return renderedFixture(request.source);
        },
      },
      store: {
        coordination: 'process',
        async put(publication) {
          publications.push(structuredClone(publication));
          return publication.manifest;
        },
        async getManifest() { return null; },
        async readPage() { return null; },
      },
    });

    const result = await publishPdfVisualSidecar(input);
    const publication = publications[0];

    assert.equal(result.status, 'published');
    assert.equal(result.mode, mode);
    assert.equal(result.visualPageCount, 2);
    assert.deepEqual(rendererCalls[0].pageNumbers, [1, 2]);
    assert.equal(publication.manifest.tenantId, 'tenant-a');
    assert.equal(publication.manifest.corpusId, 'corpus-a');
    assert.equal(publication.manifest.documentId, 'pdf:sha256:fixture');
    assert.equal(publication.manifest.documentVersion, 'sha256:fixture');
    assert.deepEqual(
      publication.manifest.pages.map(page => page.imageRef),
      ['pages/page-0001.png', 'pages/page-0002.jpg']
    );
    assert.deepEqual(
      publication.pageImages.map(page => [...page.bytes]),
      [[1, 2, 3], [4, 5, 6]]
    );
  }
});

test('PDF visual ingest limits rendered pages while retaining the full page manifest', async () => {
  const publications = [];
  const input = fixtureInput('active', {
    parsed: {
      text: 'one\n\f\ntwo\n\f\nthree',
      pages: 3,
      pageTexts: ['one', 'two', 'three'],
      parseMethod: 'pdf-parse-v2',
    },
    maxRenderPages: 2,
    renderer: {
      async render(request) {
        assert.deepEqual(request.pageNumbers, [1, 2]);
        return renderedFixture(request.source);
      },
    },
    store: fakeStore(publications),
  });

  const result = await publishPdfVisualSidecar(input);

  assert.equal(result.pageCount, 3);
  assert.equal(result.visualPageCount, 2);
  assert.equal(publications[0].manifest.pages.length, 3);
  assert.equal(publications[0].manifest.pages[2].imageRef, undefined);
});

test('PDF visual ingest rejects renderer identity drift and invalid work bounds before publish', async () => {
  let storeCalls = 0;
  const store = fakeStore([], () => { storeCalls += 1; });
  const renderer = {
    async render(request) {
      return { ...renderedFixture(request.source), sourceHash: '0'.repeat(64) };
    },
  };
  await assert.rejects(
    () => publishPdfVisualSidecar(fixtureInput('active', { renderer, store })),
    /source identity/
  );
  assert.equal(storeCalls, 0);

  await assert.rejects(
    () => publishPdfVisualSidecar(fixtureInput('active', {
      renderer,
      store,
      maxRenderPages: 101,
    })),
    /between 1 and 100/
  );
  assert.equal(storeCalls, 0);
});

function fixtureInput(mode, overrides = {}) {
  const source = new Uint8Array([37, 80, 68, 70, 45, 49]);
  return {
    mode,
    source,
    sourceName: '测试 document.pdf',
    documentId: 'pdf:sha256:fixture',
    documentVersion: 'sha256:fixture',
    parsed: overrides.parsed ?? {
      text: 'first\n\f\nsecond',
      pages: 2,
      pageTexts: ['first', 'second'],
      parseMethod: 'pdf-parse-v2',
    },
    scope,
    trustLevel: 'external',
    store: overrides.store,
    renderer: overrides.renderer,
    maxRenderPages: overrides.maxRenderPages,
  };
}

function renderedFixture(source) {
  return {
    rendererVersion: 'pdf-page-image-renderer-v1',
    sourceHash: sha256Hex(source),
    totalPages: 2,
    renderedAt: '2026-07-16T00:00:00.000Z',
    pages: [{
      pageNumber: 1,
      data: new Uint8Array([1, 2, 3]),
      contentDigest: sha256Hex(new Uint8Array([1, 2, 3])),
      width: 100,
      height: 100,
      byteLength: 3,
      mimeType: 'image/png',
    }, {
      pageNumber: 2,
      data: new Uint8Array([4, 5, 6]),
      contentDigest: sha256Hex(new Uint8Array([4, 5, 6])),
      width: 100,
      height: 100,
      byteLength: 3,
      mimeType: 'image/jpeg',
    }],
  };
}

function fakeStore(publications, onPut = () => {}) {
  return {
    coordination: 'process',
    async put(publication) {
      onPut();
      publications.push(structuredClone(publication));
      return publication.manifest;
    },
    async getManifest() { return null; },
    async readPage() { return null; },
  };
}
