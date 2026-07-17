import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  PdfPageImageRenderer,
  renderPdfPageImages,
} = await import('./pdf-page-image-renderer.ts');

test('renderer calls getScreenshot once per page with bounded canonical parameters', async () => {
  const harness = createRendererHarness({ total: 3 });
  const source = new TextEncoder().encode('immutable-pdf-source');
  const result = await renderPdfPageImages(
    { source, pageCount: 3 },
    {
      rendererFactory: harness.factory,
      clock: () => new Date('2026-07-17T01:02:03.000Z'),
    }
  );

  assert.equal(result.rendererVersion, 'pdf-page-image-renderer-v1');
  assert.equal(result.sourceHash, sha256(source));
  assert.equal(result.totalPages, 3);
  assert.equal(result.renderedAt, '2026-07-17T01:02:03.000Z');
  assert.deepEqual(result.pages.map(page => page.pageNumber), [1, 2, 3]);
  assert.deepEqual(result.pages.map(page => page.mimeType), [
    'image/png', 'image/png', 'image/png',
  ]);
  assert.deepEqual(harness.calls.map(call => call.partial), [[1], [2], [3]]);
  for (const call of harness.calls) {
    assert.equal(call.partial.length, 1);
    assert.equal(call.desiredWidth, 1_280);
    assert.equal(call.imageBuffer, true);
    assert.equal(call.imageDataUrl, false);
  }
  assert.equal(harness.destroyCount(), 1);
});

test('renderer canonicalizes selected pages and accepts matching JPEG bytes', async () => {
  const harness = createRendererHarness({
    total: 4,
    imageForPage(pageNumber) {
      return {
        data: createJpegHeader(640, 480),
        pageNumber,
        width: 640,
        height: 480,
        mimeType: 'image/jpeg',
      };
    },
  });
  const result = await new PdfPageImageRenderer({
    desiredWidth: 900,
    rendererFactory: harness.factory,
  }).render({
    source: new Uint8Array([1, 2, 3]),
    pageCount: 4,
    pageNumbers: [4, 2],
  });

  assert.deepEqual(harness.calls.map(call => call.partial), [[2], [4]]);
  assert.deepEqual(result.pages.map(page => [page.pageNumber, page.mimeType]), [
    [2, 'image/jpeg'],
    [4, 'image/jpeg'],
  ]);
  assert.equal(result.pages[0].width, 640);
  assert.equal(result.pages[0].height, 480);
});

test('renderer enforces page and desired-width hard limits before native work', async () => {
  let factoryCalls = 0;
  const rendererFactory = () => {
    factoryCalls += 1;
    return createRendererHarness({ total: 1 }).factory(new Uint8Array([1]));
  };
  assert.throws(
    () => new PdfPageImageRenderer({ desiredWidth: 2_049, rendererFactory }),
    /desiredWidth/
  );
  assert.throws(
    () => new PdfPageImageRenderer({ limits: { maxPages: 101 }, rendererFactory }),
    /hard limit/
  );
  assert.throws(
    () => new PdfPageImageRenderer({ maxConcurrentRenders: 65, rendererFactory }),
    /maxConcurrentRenders/
  );
  assert.throws(
    () => new PdfPageImageRenderer({
      maxInFlightSourceBytes: 2 * 1024 * 1024 * 1024 + 1,
      rendererFactory,
    }),
    /maxInFlightSourceBytes/
  );
  await assert.rejects(
    () => new PdfPageImageRenderer({
      limits: { maxPages: 1 }, rendererFactory,
    }).render({ source: new Uint8Array([1]), pageCount: 2 }),
    /page count/
  );
  await assert.rejects(
    () => new PdfPageImageRenderer({ rendererFactory }).render({
      source: new Uint8Array([1]),
      pageCount: 2,
      pageNumbers: [1, 1],
    }),
    /unique valid pages/
  );
  assert.equal(factoryCalls, 0);
});

test('renderer enforces per-page and aggregate byte and pixel limits', async () => {
  await assertRenderRejected(
    { maxImageBytes: 23 },
    { total: 1 },
    /per-page byte limit/
  );
  await assertRenderRejected(
    { maxTotalImageBytes: 47 },
    { total: 2 },
    /total byte limit/
  );
  await assertRenderRejected(
    { maxPixelsPerPage: 9_999 },
    { total: 1, width: 100, height: 100 },
    /per-page pixel limit/
  );
  await assertRenderRejected(
    { maxTotalPixels: 19_999 },
    { total: 2, width: 100, height: 100 },
    /total pixel limit/
  );
  await assertRenderRejected(
    { maxPageHeight: 99 },
    { total: 1, width: 100, height: 100 },
    /dimensions/
  );
});

test('renderer rejects MIME spoofing, malformed magic, and reported dimension forgery', async () => {
  const spoofed = createRendererHarness({
    total: 1,
    imageForPage(pageNumber) {
      return {
        data: createPngHeader(20, 10),
        pageNumber,
        width: 20,
        height: 10,
        mimeType: 'image/jpeg',
      };
    },
  });
  await assert.rejects(
    () => new PdfPageImageRenderer({ rendererFactory: spoofed.factory }).render({
      source: new Uint8Array([1]), pageCount: 1,
    }),
    /does not match its magic bytes/
  );

  const malformed = createRendererHarness({
    total: 1,
    imageForPage(pageNumber) {
      return {
        data: new Uint8Array([1, 2, 3, 4]),
        pageNumber,
        width: 1,
        height: 1,
      };
    },
  });
  await assert.rejects(
    () => new PdfPageImageRenderer({ rendererFactory: malformed.factory }).render({
      source: new Uint8Array([1]), pageCount: 1,
    }),
    /PNG or JPEG magic bytes/
  );

  const forgedDimensions = createRendererHarness({
    total: 1,
    imageForPage(pageNumber) {
      return {
        data: createPngHeader(20, 10),
        pageNumber,
        width: 2,
        height: 10,
      };
    },
  });
  await assert.rejects(
    () => new PdfPageImageRenderer({
      rendererFactory: forgedDimensions.factory,
    }).render({ source: new Uint8Array([1]), pageCount: 1 }),
    /reported width/
  );
});

test('renderer rejects batched or mismatched page results', async () => {
  const batched = createRendererHarness({
    total: 2,
    resultForPage(pageNumber) {
      const page = createPngScreenshot(pageNumber, 10, 10);
      return { total: 2, pages: [page, createPngScreenshot(2, 10, 10)] };
    },
  });
  await assert.rejects(
    () => new PdfPageImageRenderer({ rendererFactory: batched.factory }).render({
      source: new Uint8Array([1]), pageCount: 2, pageNumbers: [1],
    }),
    /exactly the requested page/
  );

  const wrongTotal = createRendererHarness({ total: 3 });
  await assert.rejects(
    () => new PdfPageImageRenderer({ rendererFactory: wrongTotal.factory }).render({
      source: new Uint8Array([1]), pageCount: 2, pageNumbers: [1],
    }),
    /total count/
  );
});

test('renderer propagates AbortSignal and destroys the document session', async () => {
  const controller = new AbortController();
  let observedSignal;
  let destroyCount = 0;
  const screenshot = createDeferred();
  const renderer = new PdfPageImageRenderer({
    rendererFactory: async () => ({
      async getScreenshot(parameters) {
        observedSignal = parameters.signal;
        queueMicrotask(() => controller.abort());
        return screenshot.promise;
      },
      async destroy() { destroyCount += 1; },
    }),
  });
  await assert.rejects(
    () => renderer.render({
      source: new Uint8Array([1]),
      pageCount: 1,
      signal: controller.signal,
    }),
    error => {
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /rendering was aborted/);
      return true;
    }
  );
  assert.equal(observedSignal, controller.signal);
  assert.equal(destroyCount, 1);
  screenshot.resolve({ total: 1, pages: [createPngScreenshot(1, 10, 10)] });
  await waitForAdmissionRelease();

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let factoryCalled = false;
  await assert.rejects(
    () => new PdfPageImageRenderer({
      rendererFactory: async () => {
        factoryCalled = true;
        throw new Error('must not run');
      },
    }).render({
      source: new Uint8Array([1]),
      pageCount: 1,
      signal: alreadyAborted.signal,
    }),
    error => error.name === 'AbortError'
  );
  assert.equal(factoryCalled, false);
});

test('ordinary renderer failures destroy the session and release admission', async () => {
  let destroys = 0;
  const failing = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: async () => ({
      async getScreenshot() { throw new Error('provider offline'); },
      async destroy() { destroys += 1; },
    }),
  });
  await assert.rejects(
    failing.render({ source: new Uint8Array([1]), pageCount: 1 }),
    /provider offline/
  );
  assert.equal(destroys, 1);
  await waitForAdmissionRelease();

  const harness = createRendererHarness({ total: 1 });
  await new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: harness.factory,
  }).render({ source: new Uint8Array([1]), pageCount: 1 });
});

test('process-wide concurrency admission spans renderer instances', async () => {
  const nativeWork = createDeferred();
  const started = createDeferred();
  const first = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: async () => ({
      async getScreenshot() {
        started.resolve();
        return nativeWork.promise;
      },
      async destroy() {},
    }),
  });
  const firstRender = first.render({ source: new Uint8Array([1]), pageCount: 1 });
  await started.promise;

  const secondHarness = createRendererHarness({ total: 1 });
  const second = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: secondHarness.factory,
  });
  await assert.rejects(
    second.render({ source: new Uint8Array([2]), pageCount: 1 }),
    error => error?.code === 'PDF_PAGE_RENDER_CAPACITY' && /concurrency/.test(error.message)
  );

  nativeWork.resolve({ total: 1, pages: [createPngScreenshot(1, 10, 10)] });
  await firstRender;
  await waitForAdmissionRelease();
  await second.render({ source: new Uint8Array([2]), pageCount: 1 });
});

test('aborted non-cooperative native work retains admission until it settles', async () => {
  const controller = new AbortController();
  const nativeWork = createDeferred();
  const started = createDeferred();
  let destroys = 0;
  const first = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: async () => ({
      async getScreenshot() {
        started.resolve();
        return nativeWork.promise;
      },
      async destroy() { destroys += 1; },
    }),
  });
  const firstRender = first.render({
    source: new Uint8Array([1]), pageCount: 1, signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await assert.rejects(firstRender, error => error?.name === 'AbortError');
  assert.equal(destroys, 1);

  const second = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: createRendererHarness({ total: 1 }).factory,
  });
  await assert.rejects(
    second.render({ source: new Uint8Array([2]), pageCount: 1 }),
    error => error?.code === 'PDF_PAGE_RENDER_CAPACITY'
  );
  nativeWork.resolve({ total: 1, pages: [createPngScreenshot(1, 10, 10)] });
  await waitForAdmissionRelease();
  await second.render({ source: new Uint8Array([2]), pageCount: 1 });
});

test('process-wide in-flight source byte admission spans renderer instances', async () => {
  const nativeWork = createDeferred();
  const started = createDeferred();
  const first = new PdfPageImageRenderer({
    maxConcurrentRenders: 2,
    maxInFlightSourceBytes: 3,
    rendererFactory: async () => ({
      async getScreenshot() { started.resolve(); return nativeWork.promise; },
      async destroy() {},
    }),
  });
  const firstRender = first.render({ source: new Uint8Array([1, 2]), pageCount: 1 });
  await started.promise;
  const second = new PdfPageImageRenderer({
    maxConcurrentRenders: 2,
    maxInFlightSourceBytes: 3,
    rendererFactory: createRendererHarness({ total: 1 }).factory,
  });
  await assert.rejects(
    second.render({ source: new Uint8Array([3, 4]), pageCount: 1 }),
    error => error?.code === 'PDF_PAGE_RENDER_CAPACITY' && /source byte/.test(error.message)
  );
  nativeWork.resolve({ total: 1, pages: [createPngScreenshot(1, 10, 10)] });
  await firstRender;
  await waitForAdmissionRelease();
  await second.render({ source: new Uint8Array([3, 4]), pageCount: 1 });
});

test('aborted late renderer factory is destroyed before admission is released', async () => {
  const controller = new AbortController();
  const factoryWork = createDeferred();
  let destroys = 0;
  const first = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: () => factoryWork.promise,
  });
  const firstRender = first.render({
    source: new Uint8Array([1]), pageCount: 1, signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(firstRender, error => error?.name === 'AbortError');

  const second = new PdfPageImageRenderer({
    maxConcurrentRenders: 1,
    rendererFactory: createRendererHarness({ total: 1 }).factory,
  });
  await assert.rejects(
    second.render({ source: new Uint8Array([2]), pageCount: 1 }),
    error => error?.code === 'PDF_PAGE_RENDER_CAPACITY'
  );
  factoryWork.resolve({
    async getScreenshot() { throw new Error('must not render'); },
    async destroy() { destroys += 1; },
  });
  await waitForAdmissionRelease();
  assert.equal(destroys, 1);
  await second.render({ source: new Uint8Array([2]), pageCount: 1 });
});
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForAdmissionRelease() {
  await new Promise(resolve => setImmediate(resolve));
}

function createRendererHarness(options) {
  const calls = [];
  let destroys = 0;
  return {
    calls,
    destroyCount: () => destroys,
    factory: async () => ({
      async getScreenshot(parameters) {
        calls.push(parameters);
        const pageNumber = parameters.partial[0];
        if (options.resultForPage) return options.resultForPage(pageNumber);
        const image = options.imageForPage?.(pageNumber)
          ?? createPngScreenshot(
            pageNumber,
            options.width ?? 1_280,
            options.height ?? 720
          );
        return { total: options.total, pages: [image] };
      },
      async destroy() { destroys += 1; },
    }),
  };
}

async function assertRenderRejected(limits, harnessOptions, pattern) {
  const harness = createRendererHarness(harnessOptions);
  await assert.rejects(
    () => new PdfPageImageRenderer({
      limits,
      rendererFactory: harness.factory,
    }).render({
      source: new Uint8Array([1]),
      pageCount: harnessOptions.total,
    }),
    pattern
  );
  assert.equal(harness.destroyCount(), 1);
}

function createPngScreenshot(pageNumber, width, height) {
  return {
    data: createPngHeader(width, height),
    pageNumber,
    width,
    height,
    mimeType: 'image/png',
  };
}

function createPngHeader(width, height) {
  const data = new Uint8Array(24);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  data.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  writeUint32BigEndian(data, 16, width);
  writeUint32BigEndian(data, 20, height);
  return data;
}

function createJpegHeader(width, height) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function writeUint32BigEndian(data, offset, value) {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
