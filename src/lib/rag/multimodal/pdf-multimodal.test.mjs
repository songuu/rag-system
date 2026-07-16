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
  assertPdfAssetManifestIntegrity,
  assertPdfAssetManifestScope,
  buildPdfAssetManifest,
  isSafePdfAssetImageRef,
  sha256Hex,
} = await import('./pdf-asset-manifest.ts');
const {
  OptionalPdfVisualPageHandler,
  routePdfModality,
} = await import('./pdf-modality-router.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed'],
  enforceIsolation: true,
});

test('PDF asset manifest preserves page identity without embedding image bytes', () => {
  const source = new TextEncoder().encode('stable-pdf-source');
  const manifest = createManifest({ source });

  assert.equal(manifest.schemaVersion, 'pdf-asset-manifest-v1');
  assert.equal(manifest.sourceHash, sha256Hex(source));
  assert.equal(manifest.documentVersion, 'v3');
  assert.deepEqual(
    manifest.pages.map(page => [page.pageNumber, page.startOffset, page.endOffset]),
    [[1, 0, 10], [2, 13, 21], [3, 24, 34]]
  );
  assert.equal(manifest.pages[1].imageRef, 'pdf-assets/source/page-0002.png');
  assert.equal(manifest.pages[1].contentDigest, sha256Hex('page-2-image'));
  assert.equal(JSON.stringify(manifest).includes('data:'), false);
  assert.equal('text' in manifest.pages[0], false);
});

test('PDF asset manifest enforces scope, safe refs, page parity, and resource limits', () => {
  const manifest = createManifest();
  assert.doesNotThrow(() => assertPdfAssetManifestScope(manifest, scope));
  assert.throws(
    () => assertPdfAssetManifestScope(manifest, { ...scope, tenantId: 'tenant-b' }),
    /tenant scope mismatch/
  );
  assert.equal(isSafePdfAssetImageRef('pdf-assets/a/page-1.png'), true);
  assert.equal(isSafePdfAssetImageRef('data:image/png;base64,abc'), false);
  assert.equal(isSafePdfAssetImageRef('../secret.png'), false);

  assert.throws(
    () => createManifest({
      pageImages: [{
        pageNumber: 1,
        imageRef: 'data:image/png;base64,abc',
        contentDigest: sha256Hex('unsafe-image'),
        width: 100,
        height: 100,
        byteLength: 100,
        mimeType: 'image/png',
      }],
    }),
    /safe storage key/
  );
  assert.throws(
    () => createManifest({
      pageImages: [{
        pageNumber: 1,
        imageRef: 'pdf-assets/source/page-0001.png',
        width: 100,
        height: 100,
        byteLength: 100,
        mimeType: 'image/png',
      }],
    }),
    /image contentDigest must be a SHA-256/
  );
  assert.throws(
    () => createManifest({ limits: { maxPages: 2 } }),
    /page count exceeds/
  );
  assert.throws(
    () => createManifest({ limits: { maxPages: 101 } }),
    /cannot exceed the hard limit/
  );
  const tighterRoundTrip = createManifest({ limits: { maxPages: 3 } });
  assert.doesNotThrow(() => assertPdfAssetManifestIntegrity(tighterRoundTrip));
  assert.throws(
    () => buildPdfAssetManifest({
      source: new Uint8Array([1]),
      sourceName: 'missing-pages.pdf',
      documentId: 'missing-pages',
      documentVersion: 'v1',
      parsed: {
        text: 'all text',
        pages: 2,
        parseMethod: 'pdf-parse-v2',
      },
      scope,
      trustLevel: 'reviewed',
    }),
    /page-wise text/
  );
});

test('router and handler revalidate mutated manifests before visual analysis', async () => {
  const manifest = createManifest();
  const decision = routePdfModality({
    query: '分析第 2 页的图表', manifest, scope, mode: 'active',
    capability: { available: true, analyzerId: 'visual-test' },
  });
  manifest.pages[1].imageRef = '../secret.png';
  manifest.pages[1].width = -1;
  assert.throws(() => assertPdfAssetManifestIntegrity(manifest), /safe storage key|width/);
  assert.throws(() => routePdfModality({
    query: '分析第 2 页的图表', manifest, scope, mode: 'active',
    capability: { available: true, analyzerId: 'visual-test' },
  }), /safe storage key|width/);

  let analyzerCalled = false;
  const handler = new OptionalPdfVisualPageHandler({
    analyzer: { id: 'visual-test', async analyze() { analyzerCalled = true; return []; } },
  });
  await assert.rejects(
    () => handler.execute({ decision, manifest, scope, query: '分析第 2 页的图表' }),
    /safe storage key|width/
  );
  assert.equal(analyzerCalled, false);
});

test('visual handler rejects forged routing decisions', async () => {
  const manifest = createManifest();
  let analyzerCalled = false;
  const handler = new OptionalPdfVisualPageHandler({
    analyzer: {
      id: 'visual-test',
      async analyze() { analyzerCalled = true; return []; },
    },
  });
  const pageTwoDecision = routePdfModality({
    query: '分析第 2 页的图表', manifest, scope, mode: 'active',
    capability: { available: true, analyzerId: 'visual-test' },
  });
  await assert.rejects(
    () => handler.execute({
      decision: pageTwoDecision,
      manifest, scope, query: '普通文本问题',
    }),
    /canonical active decision/
  );
  await assert.rejects(
    () => handler.execute({
      decision: { ...pageTwoDecision, selectedPageNumbers: [3] },
      manifest, scope, query: '分析第 2 页的图表',
    }),
    /canonical active decision/
  );
  assert.equal(analyzerCalled, false);
});

test('modality router keeps pure text on text and gates visual routing by mode and capability', () => {
  const manifest = createManifest();
  assert.deepEqual(
    routePdfModality({
      query: '总结第二页的主要结论',
      manifest,
      scope,
      mode: 'active',
      capability: { available: true, analyzerId: 'visual-test' },
    }),
    {
      version: 'pdf-modality-router-v1',
      route: 'text',
      requestedVisual: false,
      reason: 'text_intent',
      selectedPageNumbers: [],
      missingPageNumbers: [],
    }
  );
  assert.equal(
    routePdfModality({
      query: 'Which answer is suitable for this policy?',
      manifest,
      scope,
      mode: 'active',
      capability: { available: true, analyzerId: 'visual-test' },
    }).route,
    'text'
  );

  const shadow = routePdfModality({
    query: '解释第 2 页和 page 3 的图表',
    manifest,
    scope,
    mode: 'shadow',
    capability: { available: true, analyzerId: 'visual-test' },
  });
  assert.equal(shadow.route, 'text');
  assert.equal(shadow.shadowRoute, 'visual-page');
  assert.deepEqual(shadow.selectedPageNumbers, [2, 3]);

  const unavailable = routePdfModality({
    query: '解释第 2 页的图表',
    manifest,
    scope,
    mode: 'active',
    capability: { available: false },
  });
  assert.equal(unavailable.route, 'text');
  assert.equal(unavailable.reason, 'visual_capability_unavailable');
  assert.equal(unavailable.fallbackRoute, 'text');

  const active = routePdfModality({
    query: '比较 page 3 和第 2 页的图表',
    manifest,
    scope,
    mode: 'active',
    capability: { available: true, analyzerId: 'visual-test' },
  });
  assert.equal(active.route, 'visual-page');
  assert.deepEqual(active.selectedPageNumbers, [2, 3]);
  assert.equal(
    routePdfModality({
      query: 'Read the table on page 2',
      manifest,
      scope,
      mode: 'active',
      capability: { available: true, analyzerId: 'visual-test' },
    }).route,
    'visual-page'
  );

  const quarantineScope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['quarantined'],
    enforceIsolation: true,
  });
  const quarantinedManifest = buildPdfAssetManifest({
    source: new Uint8Array([1, 2, 3]),
    sourceName: 'quarantined.pdf',
    documentId: 'quarantined-document',
    documentVersion: 'v1',
    parsed: {
      text: 'page',
      pages: 1,
      pageTexts: ['page'],
      parseMethod: 'pdf-parse-v2',
    },
    scope: quarantineScope,
    trustLevel: 'quarantined',
    pageImages: [{
      pageNumber: 1,
      imageRef: 'pdf-assets/quarantine/page-0001.png',
      contentDigest: sha256Hex('quarantine-image'),
      width: 100,
      height: 100,
      byteLength: 100,
      mimeType: 'image/png',
    }],
  });
  const quarantined = routePdfModality({
    query: '分析图片',
    manifest: quarantinedManifest,
    scope: quarantineScope,
    mode: 'active',
    capability: { available: true, analyzerId: 'visual-test' },
  });
  assert.equal(quarantined.route, 'text');
  assert.equal(quarantined.reason, 'visual_asset_quarantined');
});

test('optional visual handler emits scoped canonical evidence and caps analyzer output', async () => {
  const manifest = createManifest();
  let receivedRequest;
  const handler = new OptionalPdfVisualPageHandler({
    analyzer: {
      id: 'visual-test',
      async analyze(request) {
        receivedRequest = request;
        return [
          { pageNumber: 2, content: 'A'.repeat(20), confidence: 0.8 },
          { pageNumber: 3, content: 'B'.repeat(20), confidence: 0.7 },
        ];
      },
    },
    maxOutputCharactersPerPage: 12,
    maxTotalOutputCharacters: 18,
  });
  const decision = routePdfModality({
    query: '比较第 2 页和第 3 页的图表',
    manifest,
    scope,
    mode: 'active',
    capability: { available: true, analyzerId: 'visual-test' },
  });
  const result = await handler.execute({
    decision,
    manifest,
    scope,
    query: '比较第 2 页和第 3 页的图表',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, 'sufficient');
  assert.deepEqual(result.evidence.map(item => item.page), [2, 3]);
  assert.deepEqual(result.evidence.map(item => item.content.length), [12, 6]);
  assert.ok(result.evidence.every(item => item.tenantId === scope.tenantId));
  assert.ok(result.evidence.every(item => item.corpusId === scope.corpusId));
  assert.ok(result.evidence.every(item => item.laneId === 'visual-page'));
  assert.deepEqual(
    receivedRequest.pages.map(page => page.imageRef),
    ['pdf-assets/source/page-0002.png', 'pdf-assets/source/page-0003.png']
  );
  assert.deepEqual(
    receivedRequest.pages.map(page => [page.expectedContentDigest, page.byteLength]),
    [
      [sha256Hex('page-2-image'), 2_048],
      [sha256Hex('page-3-image'), 2_048],
    ]
  );
  assert.deepEqual(
    result.evidence.map(item => item.metadata.imageContentDigest),
    [sha256Hex('page-2-image'), sha256Hex('page-3-image')]
  );
  assert.deepEqual(
    result.evidence.map(item => item.metadata.imageByteLength),
    [2_048, 2_048]
  );
  assert.equal(JSON.stringify(receivedRequest).includes('base64'), false);
});

test('optional visual handler falls back safely when no analyzer exists or output is invalid', async () => {
  const manifest = createManifest();
  const unavailableDecision = routePdfModality({
    query: '分析第 2 页的图表',
    manifest,
    scope,
    mode: 'active',
    capability: { available: false },
  });
  const unavailable = await new OptionalPdfVisualPageHandler().execute({
    decision: unavailableDecision,
    manifest,
    scope,
    query: '分析第 2 页的图表',
  });
  assert.equal(unavailable.route, 'text');
  assert.equal(unavailable.errorCode, 'VISUAL_ANALYZER_UNAVAILABLE');

  const invalid = await new OptionalPdfVisualPageHandler({
    analyzer: {
      id: 'invalid-test',
      async analyze() {
        return [{ pageNumber: 1, content: 'unrequested page' }];
      },
    },
  }).execute({
    decision: routePdfModality({
      query: '分析第 2 页的图表',
      manifest,
      scope,
      mode: 'active',
      capability: { available: true, analyzerId: 'invalid-test' },
    }),
    manifest,
    scope,
    query: '分析第 2 页的图表',
  });
  assert.equal(invalid.route, 'text');
  assert.equal(invalid.errorCode, 'VISUAL_ANALYZER_FAILED');
  assert.deepEqual(invalid.evidence, []);

  const limited = new OptionalPdfVisualPageHandler({
    analyzer: { id: 'limit-test', async analyze() { return []; } },
    maxPages: 1,
  });
  await assert.rejects(
    () => limited.execute({
      decision: routePdfModality({
        query: '比较图表',
        manifest,
        scope,
        mode: 'active',
        capability: { available: true, analyzerId: 'limit-test' },
      }),
      manifest,
      scope,
      query: '比较图表',
    }),
    /canonical active decision/
  );
});

test('manifest and analyzer boundary bind visual pages to content digests', async () => {
  const manifest = createManifest();
  const mutated = structuredClone(manifest);
  mutated.pages[1].contentDigest = 'not-a-sha256';
  assert.throws(
    () => assertPdfAssetManifestIntegrity(mutated),
    /image contentDigest must be a SHA-256/
  );

  const decision = routePdfModality({
    query: '分析第 2 页的图表',
    manifest,
    scope,
    mode: 'active',
    capability: { available: true, analyzerId: 'digest-verifier' },
  });
  const expectedDigestByRef = new Map([
    ['pdf-assets/source/page-0002.png', sha256Hex('page-3-image')],
  ]);
  const result = await new OptionalPdfVisualPageHandler({
    analyzer: {
      id: 'digest-verifier',
      async analyze(request) {
        const page = request.pages[0];
        if (expectedDigestByRef.get(page.imageRef) !== page.expectedContentDigest) {
          throw new Error('storage object content digest mismatch');
        }
        return [{ pageNumber: page.pageNumber, content: 'must not escape' }];
      },
    },
  }).execute({ decision, manifest, scope, query: '分析第 2 页的图表' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.errorCode, 'VISUAL_ANALYZER_FAILED');
  assert.deepEqual(result.evidence, []);
  assert.equal(JSON.stringify(result).includes('storage object content digest mismatch'), false);
});

test('visual analyzer timeout keeps its admission slot until the non-cooperative operation settles', async () => {
  const manifest = createManifest();
  const query = '分析第 2 页的图表';
  const analyzerId = 'orphan-admission-test';
  const decision = routePdfModality({
    query,
    manifest,
    scope,
    mode: 'active',
    capability: { available: true, analyzerId },
  });
  let blockingInvocationCount = 0;
  let permissiveInvocationCount = 0;
  let settleFirstAnalysis;
  let firstOperationSignal;
  const blockingAnalyzer = {
    id: analyzerId,
    analyze(request) {
      blockingInvocationCount += 1;
      firstOperationSignal = request.signal;
      return new Promise(resolve => {
        settleFirstAnalysis = resolve;
      });
    },
  };
  const permissiveAnalyzer = {
    id: analyzerId,
    analyze() {
      permissiveInvocationCount += 1;
      return Promise.resolve([{
        pageNumber: 2,
        content: 'recovered visual analysis',
        confidence: 0.9,
      }]);
    },
  };
  const timingOutHandler = new OptionalPdfVisualPageHandler({
    analyzer: blockingAnalyzer,
    analyzerTimeoutMs: 10,
    maxConcurrentAnalyses: 1,
  });
  const waitingHandler = new OptionalPdfVisualPageHandler({
    analyzer: permissiveAnalyzer,
    analyzerTimeoutMs: 500,
    maxConcurrentAnalyses: 8,
  });

  const timedOut = await timingOutHandler.execute({ decision, manifest, scope, query });
  assert.equal(timedOut.status, 'skipped');
  assert.equal(timedOut.errorCode, 'VISUAL_ANALYZER_TIMEOUT');
  assert.equal(firstOperationSignal.aborted, true);

  const busy = await waitingHandler.execute({ decision, manifest, scope, query });
  assert.equal(busy.status, 'skipped');
  assert.equal(busy.errorCode, 'VISUAL_ANALYZER_BUSY');
  assert.equal(blockingInvocationCount, 1);
  assert.equal(permissiveInvocationCount, 0);

  settleFirstAnalysis([]);
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await waitingHandler.execute({ decision, manifest, scope, query });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.evidence[0].content, 'recovered visual analysis');
  assert.equal(blockingInvocationCount, 1);
  assert.equal(permissiveInvocationCount, 1);
});

test('visual handler rejects an externally pre-aborted request without analyzer admission', async () => {
  const manifest = createManifest();
  const query = '分析第 2 页的图表';
  const analyzerId = 'external-pre-abort-test';
  let invocationCount = 0;
  const handler = new OptionalPdfVisualPageHandler({
    analyzer: {
      id: analyzerId,
      async analyze() {
        invocationCount += 1;
        return [];
      },
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));

  await assert.rejects(
    () => handler.execute({
      decision: routePdfModality({
        query,
        manifest,
        scope,
        mode: 'active',
        capability: { available: true, analyzerId },
      }),
      manifest,
      scope,
      query,
      signal: controller.signal,
    }),
    error => error?.name === 'AbortError'
      && error.message === 'Visual page analysis was aborted.'
  );
  assert.equal(invocationCount, 0);
});

test('visual analyzer timeout and concurrency options enforce hard bounds', () => {
  assert.throws(
    () => new OptionalPdfVisualPageHandler({ analyzerTimeoutMs: 120_001 }),
    /analyzerTimeoutMs must be an integer between 1 and 120000/
  );
  assert.throws(
    () => new OptionalPdfVisualPageHandler({ maxConcurrentAnalyses: 9 }),
    /maxConcurrentAnalyses must be an integer between 1 and 8/
  );
});

function createManifest(overrides = {}) {
  return buildPdfAssetManifest({
    source: overrides.source ?? new TextEncoder().encode('pdf-source'),
    sourceName: 'source.pdf',
    documentId: 'source-document',
    documentVersion: 'v3',
    parsed: {
      text: 'first page\n\f\npage two\n\f\nthird page',
      pages: 3,
      pageTexts: ['first page', 'page two', 'third page'],
      parseMethod: 'pdf-parse-v2',
    },
    scope,
    trustLevel: 'reviewed',
    pageImages: overrides.pageImages ?? [
      {
        pageNumber: 2,
        imageRef: 'pdf-assets/source/page-0002.png',
        contentDigest: sha256Hex('page-2-image'),
        width: 1024,
        height: 768,
        byteLength: 2_048,
        mimeType: 'image/png',
      },
      {
        pageNumber: 3,
        imageRef: 'pdf-assets/source/page-0003.png',
        contentDigest: sha256Hex('page-3-image'),
        width: 1024,
        height: 768,
        byteLength: 2_048,
        mimeType: 'image/png',
      },
    ],
    limits: overrides.limits,
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
