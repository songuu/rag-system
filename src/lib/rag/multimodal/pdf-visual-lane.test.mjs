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
  createLangChainPdfVisualAnalyzer,
  createPdfVisualLaneHandler,
} = await import('./pdf-visual-lane.ts');
const {
  buildPdfAssetManifest,
  sha256Hex,
} = await import('./pdf-asset-manifest.ts');
const {
  InMemoryPdfAssetStore,
  pdfAssetIdentityFromManifest,
} = await import('./pdf-asset-store.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['reviewed'],
  enforceIsolation: true,
});

test('off and pure-text lanes perform zero store and model work', async () => {
  const state = { getManifest: 0, readPage: 0, models: 0 };
  const store = throwingStore(state);
  const createModel = () => {
    state.models += 1;
    throw new Error('must not create model');
  };
  const off = createPdfVisualLaneHandler({
    store, mode: 'off', model: 'vision-model', createModel,
  });
  const offResult = await off.execute(context({ query: '分析第 2 页的图表' }));
  assert.deepEqual(offResult.evidence, []);
  assert.equal(offResult.metadata.reason, 'feature_off');

  const text = createPdfVisualLaneHandler({
    store, mode: 'active', model: 'vision-model', createModel,
  });
  const textResult = await text.execute(context({ query: '总结主要结论' }));
  assert.deepEqual(textResult.evidence, []);
  assert.equal(textResult.metadata.reason, 'text_intent');
  assert.deepEqual(state, { getManifest: 0, readPage: 0, models: 0 });
});

test('missing model or manifest falls back to text without model invocation', async () => {
  const bundle = createBundle();
  const state = { getManifest: 0, readPage: 0, models: 0 };
  const noModelStore = throwingStore(state);
  const noModel = createPdfVisualLaneHandler({
    store: noModelStore,
    mode: 'active',
    model: '',
    createModel() { state.models += 1; throw new Error('must not run'); },
  });
  const noModelResult = await noModel.execute(context({
    query: '解释图表', priorEvidence: [evidenceFor(bundle.manifest)],
  }));
  assert.equal(noModelResult.stopReason, 'capability_unavailable');
  assert.equal(noModelResult.metadata.reason, 'model_unavailable');
  assert.deepEqual(state, { getManifest: 0, readPage: 0, models: 0 });

  const missingState = { getManifest: 0, readPage: 0, models: 0 };
  const missingStore = {
    coordination: 'process',
    async put() { throw new Error('unused'); },
    async getManifest() { missingState.getManifest += 1; return null; },
    async readPage() { missingState.readPage += 1; throw new Error('unused'); },
  };
  const missing = createPdfVisualLaneHandler({
    store: missingStore,
    mode: 'active',
    model: 'vision-model',
    createModel() { missingState.models += 1; throw new Error('must not run'); },
  });
  const missingResult = await missing.execute(context({
    query: '解释图表', priorEvidence: [evidenceFor(bundle.manifest)],
  }));
  assert.deepEqual(missingResult.evidence, []);
  assert.equal(missingResult.metadata.reason, 'manifest_missing');
  assert.deepEqual(missingState, { getManifest: 1, readPage: 0, models: 0 });
});

test('production analyzer re-reads exact bytes and invokes one multimodal HumanMessage per page', async () => {
  const bundle = createBundle({ pageCount: 2 });
  const instrumented = await createInstrumentedStore([bundle]);
  const modelCalls = [];
  const analyzer = createLangChainPdfVisualAnalyzer({
    store: instrumented.store,
    model: 'vision-model',
    createModel(model, options) {
      const modelIndex = modelCalls.length;
      assert.equal(model, 'vision-model');
      assert.equal(options.temperature, 0);
      const call = { messages: undefined, config: undefined };
      modelCalls.push(call);
      return {
        async invoke(messages, config) {
          call.messages = messages;
          call.config = config;
          return modelIndex === 0
            ? { content: 'first visual fact' }
            : { content: [{ type: 'text', text: 'second visual fact' }] };
        },
      };
    },
  });
  const signal = new AbortController().signal;
  const analyses = await analyzer.analyze(visualRequest(bundle.manifest, signal));

  assert.deepEqual(analyses, [
    { pageNumber: 1, content: 'first visual fact' },
    { pageNumber: 2, content: 'second visual fact' },
  ]);
  assert.equal(instrumented.counts.readPage, 2);
  assert.equal(modelCalls.length, 2);
  for (const call of modelCalls) {
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].type, 'human');
    const imageBlocks = call.messages[0].content.filter(block => block.type === 'image_url');
    assert.equal(imageBlocks.length, 1);
    assert.match(imageBlocks[0].image_url.url, /^data:image\/png;base64,/);
    assert.equal(call.config.signal, signal);
  }
});

test('active lane returns canonical scoped visual evidence for the requested page', async () => {
  const bundle = createBundle({ pageCount: 2 });
  const instrumented = await createInstrumentedStore([bundle]);
  let modelCalls = 0;
  const handler = createPdfVisualLaneHandler({
    store: instrumented.store,
    mode: 'active',
    model: 'vision-model',
    createModel() {
      return {
        async invoke() {
          modelCalls += 1;
          return { content: 'The page 2 chart shows 42.' };
        },
      };
    },
  });
  const result = await handler.execute(context({
    query: '分析第 2 页的图表',
    priorEvidence: [evidenceFor(bundle.manifest)],
  }));

  assert.equal(result.stopReason, 'sufficient');
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(
    pick(result.evidence[0], [
      'tenantId', 'corpusId', 'documentId', 'documentVersion',
      'trustLevel', 'laneId', 'page', 'content',
    ]),
    {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      documentId: 'doc-1',
      documentVersion: 'v1',
      trustLevel: 'reviewed',
      laneId: 'pdf-visual-active',
      page: 2,
      content: 'The page 2 chart shows 42.',
    }
  );
  assert.equal(result.evidence[0].metadata.modality, 'visual-page');
  assert.equal(JSON.stringify(result.evidence[0].metadata).includes('data:image'), false);
  assert.equal(instrumented.counts.getManifest, 1);
  assert.equal(instrumented.counts.readPage, 1);
  assert.equal(modelCalls, 1);
  assert.equal(result.metadata.analysisCount, 1);
});

test('shadow lane executes analysis but exposes only bounded counts and reasons', async () => {
  const bundle = createBundle({ pageCount: 2 });
  const instrumented = await createInstrumentedStore([bundle]);
  let modelCalls = 0;
  const handler = createPdfVisualLaneHandler({
    store: instrumented.store,
    mode: 'shadow',
    model: 'vision-model',
    createModel() {
      return {
        async invoke() {
          modelCalls += 1;
          return { content: 'TOP SECRET VISUAL BODY' };
        },
      };
    },
  });
  const result = await handler.execute(context({
    query: '解释这些图表',
    mode: 'shadow',
    priorEvidence: [evidenceFor(bundle.manifest)],
  }));

  assert.deepEqual(result.evidence, []);
  assert.equal(result.stopReason, 'no_gain');
  assert.equal(result.metadata.reason, 'shadow_completed');
  assert.equal(result.metadata.analysisCount, 2);
  assert.equal(result.metadata.analyzedPageCount, 2);
  assert.equal(result.metadata.participatesInGeneration, false);
  const serialized = JSON.stringify(result.metadata);
  assert.equal(serialized.includes('TOP SECRET'), false);
  assert.equal(serialized.includes('data:image'), false);
  assert.equal(modelCalls, 2);
});

test('prior-evidence scope or alias conflicts fail closed before store/model work', async () => {
  const bundle = createBundle();
  for (const mutated of [
    { ...evidenceFor(bundle.manifest), tenantId: 'tenant-b' },
    evidenceFor(bundle.manifest, { metadata: { tenant_id: 'tenant-b' } }),
    evidenceFor(bundle.manifest, { metadata: { document_version: 'v2' } }),
  ]) {
    const state = { getManifest: 0, readPage: 0, models: 0 };
    const handler = createPdfVisualLaneHandler({
      store: throwingStore(state),
      mode: 'active',
      model: 'vision-model',
      createModel() { state.models += 1; throw new Error('must not run'); },
    });
    await assert.rejects(
      () => handler.execute(context({
        query: '解释图表', priorEvidence: [mutated],
      })),
      error => {
        assert.equal(error.name, 'RagLaneEvidenceValidationError');
        assert.match(error.message, /scope mismatch|conflicting/);
        return true;
      }
    );
    assert.deepEqual(state, { getManifest: 0, readPage: 0, models: 0 });
  }
});

test('forged manifest identity or page bytes fail closed through the optional handler', async () => {
  const bundle = createBundle();
  let modelCalls = 0;
  const forgedManifestStore = {
    coordination: 'process',
    async put() { throw new Error('unused'); },
    async getManifest() {
      return { ...bundle.manifest, corpusId: 'corpus-b' };
    },
    async readPage() { throw new Error('must not run'); },
  };
  const manifestHandler = createPdfVisualLaneHandler({
    store: forgedManifestStore,
    mode: 'active',
    model: 'vision-model',
    createModel() { modelCalls += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    () => manifestHandler.execute(context({
      query: '解释图表', priorEvidence: [evidenceFor(bundle.manifest)],
    })),
    error => error.name === 'RagLaneEvidenceValidationError'
      && /scope|identity/.test(error.message)
  );
  assert.equal(modelCalls, 0);

  const inner = new InMemoryPdfAssetStore();
  await inner.put(bundle.publication);
  const corruptPageStore = {
    coordination: 'process',
    put: publication => inner.put(publication),
    getManifest: (identity, requestedScope) => inner.getManifest(identity, requestedScope),
    async readPage(identity, pageNumber, requestedScope) {
      const stored = await inner.readPage(identity, pageNumber, requestedScope);
      stored.bytes[0] = 0;
      return stored;
    },
  };
  const pageHandler = createPdfVisualLaneHandler({
    store: corruptPageStore,
    mode: 'active',
    model: 'vision-model',
    createModel() { modelCalls += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    () => pageHandler.execute(context({
      query: '解释图表', priorEvidence: [evidenceFor(bundle.manifest)],
    })),
    error => error.name === 'RagLaneEvidenceValidationError'
      && /exact manifest provenance/.test(error.message)
  );
  assert.equal(modelCalls, 0);
});

test('ordinary model failure falls back to text instead of leaking partial visual output', async () => {
  const bundle = createBundle();
  const instrumented = await createInstrumentedStore([bundle]);
  const handler = createPdfVisualLaneHandler({
    store: instrumented.store,
    mode: 'active',
    model: 'vision-model',
    createModel() {
      return { async invoke() { throw new Error('provider unavailable'); } };
    },
  });
  const result = await handler.execute(context({
    query: '解释图表', priorEvidence: [evidenceFor(bundle.manifest)],
  }));
  assert.deepEqual(result.evidence, []);
  assert.equal(result.stopReason, 'capability_unavailable');
  assert.equal(result.metadata.reason, 'visual_provider_failed');
  assert.equal(result.metadata.providerFailureCount, 1);
  assert.equal(JSON.stringify(result.metadata).includes('provider unavailable'), false);
});

test('document, page, evidence, and output budgets bound query-side visual work', async () => {
  const first = createBundle({ documentId: 'doc-1', pageCount: 2 });
  const second = createBundle({ documentId: 'doc-2', pageCount: 2 });
  const instrumented = await createInstrumentedStore([first, second]);
  let models = 0;
  const handler = createPdfVisualLaneHandler({
    store: instrumented.store,
    mode: 'active',
    model: 'vision-model',
    maxDocuments: 1,
    maxPagesPerDocument: 1,
    maxEvidence: 1,
    maxOutputCharactersPerPage: 5,
    maxTotalOutputCharacters: 5,
    createModel() {
      models += 1;
      return { async invoke() { return { content: '1234567890' }; } };
    },
  });
  const result = await handler.execute(context({
    query: '分析图表',
    priorEvidence: [evidenceFor(first.manifest), evidenceFor(second.manifest)],
  }));

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].content, '12345');
  assert.equal(instrumented.counts.getManifest, 1);
  assert.equal(instrumented.counts.readPage, 1);
  assert.equal(models, 1);
  assert.equal(result.metadata.candidateDocumentCount, 1);
  assert.throws(
    () => createPdfVisualLaneHandler({
      store: instrumented.store, maxDocuments: 21,
    }),
    /maxDocuments/
  );
});

test('AbortSignal stops visual work before store or model access', async () => {
  const bundle = createBundle();
  const state = { getManifest: 0, readPage: 0, models: 0 };
  const controller = new AbortController();
  controller.abort();
  const handler = createPdfVisualLaneHandler({
    store: throwingStore(state),
    mode: 'active',
    model: 'vision-model',
    createModel() { state.models += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    () => handler.execute(context({
      query: '解释图表',
      priorEvidence: [evidenceFor(bundle.manifest)],
      signal: controller.signal,
    })),
    error => error.name === 'AbortError'
  );
  assert.deepEqual(state, { getManifest: 0, readPage: 0, models: 0 });
});

async function createInstrumentedStore(bundles) {
  const inner = new InMemoryPdfAssetStore();
  for (const bundle of bundles) await inner.put(bundle.publication);
  const counts = { getManifest: 0, readPage: 0 };
  return {
    counts,
    store: {
      coordination: 'process',
      put: publication => inner.put(publication),
      async getManifest(identity, requestedScope) {
        counts.getManifest += 1;
        return inner.getManifest(identity, requestedScope);
      },
      async readPage(identity, pageNumber, requestedScope) {
        counts.readPage += 1;
        return inner.readPage(identity, pageNumber, requestedScope);
      },
    },
  };
}

function createBundle({ documentId = 'doc-1', pageCount = 1 } = {}) {
  const source = new TextEncoder().encode(`pdf-source:${documentId}`);
  const pageBytes = Array.from(
    { length: pageCount },
    (_, index) => createPngBytes(index + 1)
  );
  const pageImages = pageBytes.map((bytes, index) => ({
    pageNumber: index + 1,
    imageRef: `pdf-assets/${documentId}/page-${index + 1}.png`,
    contentDigest: sha256Hex(bytes),
    width: 100,
    height: 80,
    byteLength: bytes.byteLength,
    mimeType: 'image/png',
  }));
  const manifest = buildPdfAssetManifest({
    source,
    sourceName: `${documentId}.pdf`,
    documentId,
    documentVersion: 'v1',
    parsed: {
      text: Array.from({ length: pageCount }, (_, index) => `page ${index + 1}`).join('\n\f\n'),
      pages: pageCount,
      pageTexts: Array.from({ length: pageCount }, (_, index) => `page ${index + 1}`),
      parseMethod: 'pdf-parse-v2',
    },
    scope,
    trustLevel: 'reviewed',
    pageImages,
    now: new Date(0),
  });
  return {
    manifest,
    publication: {
      manifest,
      pageImages: pageBytes.map((bytes, index) => ({
        pageNumber: index + 1,
        bytes,
      })),
    },
  };
}

function evidenceFor(manifest, overrides = {}) {
  return {
    id: `dense:${manifest.documentId}`,
    tenantId: manifest.tenantId,
    corpusId: manifest.corpusId,
    documentId: manifest.documentId,
    documentVersion: manifest.documentVersion,
    content: 'prior text evidence',
    source: manifest.sourceName,
    trustLevel: manifest.trustLevel,
    laneId: 'dense-vector',
    ...overrides,
  };
}

function visualRequest(manifest, signal) {
  const identity = pdfAssetIdentityFromManifest(manifest);
  return {
    ...identity,
    sourceHash: manifest.sourceHash,
    query: '解释图表',
    pages: manifest.pages.map(page => ({
      pageNumber: page.pageNumber,
      imageRef: page.imageRef,
      expectedContentDigest: page.contentDigest,
      width: page.width,
      height: page.height,
      byteLength: page.byteLength,
      mimeType: page.mimeType,
    })),
    signal,
  };
}

function context({
  query,
  priorEvidence = [],
  mode = 'active',
  signal = new AbortController().signal,
}) {
  return {
    request: {
      question: query,
      topK: 5,
      similarityThreshold: 0.3,
      llmModel: 'vision-model',
      embeddingModel: 'embed-model',
      storageBackend: 'milvus',
      retrievalScope: scope,
    },
    plan: {
      id: 'plan',
      policy_id: 'reasoning',
      query,
      lanes: [],
      top_k: 5,
      similarity_threshold: 0.3,
      created_at: new Date(0).toISOString(),
    },
    lane: {
      id: mode === 'shadow' ? 'pdf-visual-shadow' : 'pdf-visual-active',
      type: 'visual-page',
      required: false,
      description: 'fixture',
      parameters: { mode },
    },
    priorEvidence,
    signal,
  };
}

function throwingStore(state) {
  return {
    coordination: 'process',
    async put() { throw new Error('unused'); },
    async getManifest() { state.getManifest += 1; throw new Error('must not read'); },
    async readPage() { state.readPage += 1; throw new Error('must not read'); },
  };
}

function createPngBytes(marker) {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    marker,
  ]);
}

function pick(value, keys) {
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
