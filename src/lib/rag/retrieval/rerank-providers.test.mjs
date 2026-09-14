import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context); throw error; } } });
const { SiliconFlowReranker, CohereReranker, VoyageReranker } = await import('./rerank-providers.ts');
const docs = [{ id: 'a', content: 'private first document' }, { id: 'b', content: 'private second document' }];
for (const Provider of [SiliconFlowReranker, CohereReranker, VoyageReranker]) {
  const provider = new Provider({ apiKey: 'private-key' });
  const responseKey = provider.name === 'voyage' ? 'data' : 'results';
  const validResults = [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.6 }];
  test(`${provider.name} forwards cancellation and maps only original documents`, async t => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      assert.deepEqual(JSON.parse(init.body).documents, docs.map(doc => doc.content));
      return Response.json({ [responseKey]: validResults });
    });
    assert.deepEqual(await provider.rerank('query', docs, 2, { signal: controller.signal }), [{ ...docs[1], relevanceScore: 0.8, originalIndex: 1 }, { ...docs[0], relevanceScore: 0.6, originalIndex: 0 }]);
  });
  test(`${provider.name} rejects pre-cancelled and late non-cooperative responses`, async t => {
    const controller = new AbortController();
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { controller.abort(new Error('private cancellation reason')); return Response.json({ [responseKey]: validResults }); });
    await assert.rejects(provider.rerank('query', docs, 2, { signal: controller.signal }), error => error.code === 'RAG_REQUEST_ABORTED');
    await assert.rejects(provider.rerank('query', docs, 2, { signal: controller.signal }), error => error.code === 'RAG_REQUEST_ABORTED');
    assert.equal(fetchMock.mock.callCount(), 1);
  });
  test(`${provider.name} checks cancellation after response parsing`, async t => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, async json() { controller.abort(new Error('private parse abort')); return { [responseKey]: validResults }; } }));
    await assert.rejects(provider.rerank('query', docs, 2, { signal: controller.signal }), error => error.code === 'RAG_REQUEST_ABORTED');
  });
  test(`${provider.name} errors never expose provider bodies or network details`, async t => {
    for (const fetchResponse of [async () => new Response('private echoed query and api key', { status: 429 }), async () => { throw new Error('private-network-query'); }, async () => ({ ok: true, async json() { throw new SyntaxError('private malformed body'); } })]) {
      const mock = t.mock.method(globalThis, 'fetch', fetchResponse);
      await assert.rejects(provider.rerank('query', docs), error => { assert.match(error.message, new RegExp(provider.name)); assert.doesNotMatch(error.message, /private/); assert.equal(error.cause, undefined); return true; });
      mock.mock.restore();
    }
  });
  test(`${provider.name} cancels HTTP error bodies and waits for cleanup`, async t => {
    let cancelled = 0;
    let settled = false;
    let releaseCleanup;
    const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
    t.after(() => releaseCleanup());
    const response = new Response(new ReadableStream({
      cancel() { cancelled += 1; return cleanup; },
    }), { status: 503 });
    const readBody = t.mock.method(response, 'text');
    t.mock.method(globalThis, 'fetch', async () => response);
    const operation = provider.rerank('query', docs).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1);
    assert.equal(settled, false);
    assert.equal(readBody.mock.callCount(), 0);
    releaseCleanup();
    const error = await operation;
    assert.equal(error?.message, `Reranker provider=${provider.name} HTTP status=503.`);
    assert.equal(error?.cause, undefined);
  });
  test(`${provider.name} preserves safe HTTP errors when body cleanup fails`, async t => {
    let cancelled = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      cancel() { cancelled += 1; throw new Error('private cleanup failure with provider body'); },
    }), { status: 429 }));
    await assert.rejects(provider.rerank('query', docs), error => {
      assert.equal(error.message, `Reranker provider=${provider.name} HTTP status=429.`);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(cancelled, 1);
  });
  test(`${provider.name} preserves cancellation during failing body cleanup`, async t => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      cancel() {
        controller.abort(new Error('private cancellation reason'));
        return Promise.reject(new Error('private cleanup rejection'));
      },
    }), { status: 503 }));
    await assert.rejects(provider.rerank('query', docs, 2, { signal: controller.signal }), error => {
      assert.equal(error.code, 'RAG_REQUEST_ABORTED');
      assert.doesNotMatch(error.message, /private/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
  test(`${provider.name} rejects malformed output without leaking it`, async t => {
    for (const payload of [null, {}, { [responseKey]: 'private' }, { [responseKey]: [null] }, ...[[{ index: -1, relevance_score: 0.1 }], [{ index: 2, relevance_score: 0.1 }], [{ index: 0.5, relevance_score: 0.1 }], [{ index: '0', relevance_score: 0.1 }], [{ index: 0, relevance_score: 'private' }], [{ index: 0, relevance_score: Number.NaN }], [{ index: 0, relevance_score: Infinity }], [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }]].map(results => ({ [responseKey]: results }))]) {
      const mock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => payload }));
      await assert.rejects(provider.rerank('query', docs), error => { assert.match(error.message, /invalid response/); assert.doesNotMatch(error.message, /private/); return true; });
      mock.mock.restore();
    }
  });
}
