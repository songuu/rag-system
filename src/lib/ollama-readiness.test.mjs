import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './rag/core/request-budgets' && context.parentURL === new URL('./ollama-readiness.ts', import.meta.url).href) {
    return nextResolve(new URL('./rag/core/request-budgets.ts', import.meta.url).href, context);
  }
  return nextResolve(specifier, context);
} });
const readiness = await import('./ollama-readiness.ts');
const { warmOllamaModel, resolveOllamaRuntimeSettings, beginOllamaModelWarmup, getOllamaModelReadiness } = readiness;

test('background loading returns immediately, deduplicates and exposes completion or failure for polling', async () => {
  let finish;
  let calls = 0;
  const options = { baseUrl: 'http://fixture-background.invalid', fetch: async () => {
    calls++; await new Promise(resolve => { finish = resolve; }); return Response.json({ done: true });
  } };
  assert.equal(beginOllamaModelWarmup('background', options).phase, 'loading');
  assert.equal(beginOllamaModelWarmup('background', options).phase, 'loading');
  assert.equal(calls, 1);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getOllamaModelReadiness('background', options).phase, 'ready');
  beginOllamaModelWarmup('background', { ...options, fetch: async () => { throw new Error('private internal failure'); } });
  await new Promise(resolve => setImmediate(resolve));
  const failed = getOllamaModelReadiness('background', options);
  assert.equal(failed.phase, 'failed');
  assert.doesNotMatch(failed.detail, /private/);
});

test('warmup uses an empty prompt, the same context and finite residency as generation', async () => {
  let call;
  const result = await warmOllamaModel('fixture-model', {
    fetch: async (url, options) => {
      call = { url, body: JSON.parse(options.body), signal: options.signal };
      return Response.json({ done: true, load_duration: 20_000_000 });
    }, baseUrl: 'http://127.0.0.1:11434',
  });
  assert.equal(call.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(call.body.prompt, '');
  assert.equal(call.body.keep_alive, '15m');
  assert.equal(call.body.options.num_ctx, 8192);
  assert.equal(result.phase, 'ready');
  assert.equal(result.loadDurationMs, 20);
  assert.ok(call.signal instanceof AbortSignal);
});

test('prepares the lightweight router before the selected model can occupy the provider queue', async () => {
  const events = [];
  let release;
  const options = { prepare: async () => { events.push('prepare'); await new Promise(resolve => { release = resolve; }); },
    fetch: async () => { events.push('load'); return Response.json({ done: true }); } };
  assert.equal(beginOllamaModelWarmup('ordered-preload', options).phase, 'loading');
  assert.deepEqual(events, ['prepare']);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['prepare', 'load']);
  assert.equal(getOllamaModelReadiness('ordered-preload', options).phase, 'ready');
});

test('deduplicates simultaneous loads, releases failed loads, and never reports an error as ready', async () => {
  let count = 0;
  let finish;
  const fetch = async () => { count++; await new Promise(resolve => { finish = resolve; }); return Response.json({ done: true }); };
  const first = warmOllamaModel('deduplicated', { fetch });
  const second = warmOllamaModel('deduplicated', { fetch });
  await Promise.resolve();
  finish();
  assert.equal((await first).phase, 'ready');
  assert.equal((await second).phase, 'ready');
  assert.equal(count, 1);
  await assert.rejects(warmOllamaModel('failure', { fetch: async () => Response.json({ error: 'internal detail' }, { status: 500 }) }), /MODEL_PRELOAD_FAILED/);
  assert.equal((await warmOllamaModel('failure', { fetch: async () => Response.json({ done: true }) })).phase, 'ready');
});

test('runtime settings bound context and keep-alive configuration', () => {
  assert.deepEqual(resolveOllamaRuntimeSettings({}), { numCtx: 8192, keepAlive: '15m' });
  assert.deepEqual(resolveOllamaRuntimeSettings({ OLLAMA_NUM_CTX: '4096', OLLAMA_KEEP_ALIVE: '30m' }), { numCtx: 4096, keepAlive: '30m' });
  assert.deepEqual(resolveOllamaRuntimeSettings({ OLLAMA_NUM_CTX: '-1', OLLAMA_KEEP_ALIVE: '-1' }), { numCtx: 8192, keepAlive: '15m' });
});

test('embedding warmup uses the embedding endpoint and an explicit bounded context', async () => {
  let call;
  const result = await readiness.warmOllamaEmbeddingModel('fixture-embedding', {
    baseUrl: 'http://embedding.invalid/',
    fetch: async (url, options) => {
      call = { url, body: JSON.parse(options.body), signal: options.signal };
      return Response.json({ embeddings: [], load_duration: 31_000_000_000 });
    },
  });
  assert.equal(call.url, 'http://embedding.invalid/api/embed');
  assert.deepEqual(call.body, { model: 'fixture-embedding', input: [], keep_alive: '15m', options: { num_ctx: 8192 } });
  assert.equal(readiness.OLLAMA_EMBEDDING_NUM_CTX, 8192);
  assert.equal(readiness.OLLAMA_EMBEDDING_WARMUP_TIMEOUT_MS, 90_000);
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(result.phase, 'ready');
  assert.equal(result.loadDurationMs, 31_000);
});

test('embedding warmup deduplicates cold loads while each caller can cancel its own wait', async () => {
  let finish;
  let calls = 0;
  let providerSignal;
  const controller = new AbortController();
  const options = { baseUrl: 'http://embedding-shared.invalid', fetch: async (_url, request) => {
    calls++;
    providerSignal = request.signal;
    await new Promise(resolve => { finish = resolve; });
    return Response.json({ embeddings: [] });
  } };
  const cancelled = readiness.warmOllamaEmbeddingModel('shared-embedding', { ...options, signal: controller.signal });
  const survivor = readiness.warmOllamaEmbeddingModel('shared-embedding', options);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(providerSignal.aborted, false);
  finish();
  assert.equal((await survivor).phase, 'ready');
  assert.equal(calls, 1);
  // A previous ready state cannot prove the provider still has the model loaded.
  const next = readiness.warmOllamaEmbeddingModel('shared-embedding', options);
  finish();
  await next;
  assert.equal(calls, 2);
});

test('embedding and generation preloads for the same model never share readiness', async () => {
  const urls = [];
  const options = { baseUrl: 'http://both-model-types.invalid', fetch: async url => {
    urls.push(url);
    return Response.json(url.endsWith('/api/embed') ? { embeddings: [] } : { done: true });
  } };
  await Promise.all([warmOllamaModel('same-name', options), readiness.warmOllamaEmbeddingModel('same-name', options)]);
  assert.deepEqual(urls.sort(), ['http://both-model-types.invalid/api/embed', 'http://both-model-types.invalid/api/generate']);
});

test('embedding warmup releases failed loads and reports safe contextual error codes', async () => {
  await assert.rejects(readiness.warmOllamaEmbeddingModel('failure-embedding', {
    fetch: async () => Response.json({ error: 'private provider detail' }, { status: 500 }),
  }), error => error.code === 'EMBEDDING_PRELOAD_FAILED' && !error.message.includes('private'));
  await assert.rejects(readiness.warmOllamaEmbeddingModel('failure-embedding', {
    fetch: async () => { throw new DOMException('private timeout detail', 'TimeoutError'); },
  }), { code: 'EMBEDDING_PRELOAD_TIMEOUT' });
  assert.equal((await readiness.warmOllamaEmbeddingModel('failure-embedding', {
    fetch: async () => Response.json({ embeddings: [] }),
  })).phase, 'ready');
  await assert.rejects(readiness.warmOllamaEmbeddingModel('malformed-embedding', {
    fetch: async () => Response.json({ done: true }),
  }), { code: 'EMBEDDING_PRELOAD_FAILED' });
});

test('background readiness is scoped to the embedding preparation identity', async () => {
  let finish;
  const options = { baseUrl: 'http://embedding-identity.invalid', preparationKey: 'embedding:ollama:model-a',
    prepare: () => new Promise(resolve => { finish = resolve; }),
    fetch: async () => Response.json({ done: true }) };
  beginOllamaModelWarmup('identity-llm', options);
  assert.equal(getOllamaModelReadiness('identity-llm', options).phase, 'loading');
  assert.equal(getOllamaModelReadiness('identity-llm', { ...options, preparationKey: 'embedding:ollama:model-b' }), null);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getOllamaModelReadiness('identity-llm', options).phase, 'ready');
});

test('an already cancelled embedding waiter never starts provider work', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readiness.warmOllamaEmbeddingModel('cancelled-before-load', {
    signal: controller.signal,
    fetch: async () => { assert.fail('cancelled caller must not load a model'); },
  }), { name: 'AbortError' });
});
