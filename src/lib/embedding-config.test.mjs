import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('./embedding-config.ts', import.meta.url).href;
const stateUrl = new URL('./embedding-index-state.ts', import.meta.url).href;
const readinessUrl = new URL('./ollama-readiness.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sourceUrl && specifier === './embedding-index-state') {
      return { url: stateUrl, shortCircuit: true };
    }
    if (context.parentURL === sourceUrl && specifier === './ollama-readiness') {
      return { url: readinessUrl, shortCircuit: true };
    }
    if (context.parentURL === readinessUrl && specifier === './rag/core/request-budgets') {
      return { url: new URL('./rag/core/request-budgets.ts', import.meta.url).href, shortCircuit: true };
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (![sourceUrl, stateUrl].includes(url)) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
  },
});

const { EmbeddingFactory } = await import('./embedding-config.ts');

function fixture(t, overrides = {}) {
  t.mock.method(console, 'log', () => {});
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://embedding.invalid/v1/embeddings');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-offline-key');
    const body = JSON.parse(request.body);
    requests.push(body);
    // Reverse provider order to verify the original index-based reordering.
    return { ok: true, json: async () => ({ data: body.input.map((text, index) => (
      { index, embedding: [text.length, index] }
    )).reverse() }) };
  });
  const factory = EmbeddingFactory.getInstance();
  factory.clearCache();
  t.after(() => factory.clearCache());
  const options = { provider: 'siliconflow', apiKey: 'synthetic-offline-key',
    baseUrl: 'https://embedding.invalid/v1', batchSize: 2, ...overrides };
  return { requests, factory, options,
    embedding: factory.createEmbedding(overrides.modelName ?? 'BAAI/bge-m3', options) };
}

test('SiliconFlow batches offline requests and preserves input vector order', async t => {
  const { embedding, requests } = fixture(t);
  assert.deepEqual(await embedding.embedDocuments(['a', 'bb', 'ccc']), [[1, 0], [2, 1], [3, 0]]);
  assert.deepEqual(requests, [
    { model: 'BAAI/bge-m3', input: ['a', 'bb'], encoding_format: 'float' },
    { model: 'BAAI/bge-m3', input: ['ccc'], encoding_format: 'float' },
  ]);
});

test('SiliconFlow adds dimensions only for Qwen3 and returns a single query vector', async t => {
  const { embedding, requests } = fixture(t, { modelName: 'Qwen/Qwen3-Embedding-0.6B', dimension: 512 });
  assert.deepEqual(await embedding.embedQuery('query'), [5, 0]);
  assert.equal(requests[0].dimensions, 512);
  assert.equal(requests[0].model, 'Qwen/Qwen3-Embedding-0.6B');
});

test('SiliconFlow omits unsupported dimensions and skips requests for empty input', async t => {
  const { embedding, requests } = fixture(t, { dimension: 512 });
  assert.deepEqual(await embedding.embedDocuments([]), []);
  assert.equal(requests.length, 0);
  await embedding.embedQuery('query');
  assert.equal(Object.hasOwn(requests[0], 'dimensions'), false);
});

test('EmbeddingFactory retains equivalent-configuration caching without network calls', t => {
  const { embedding, factory, options, requests } = fixture(t);
  assert.equal(factory.createEmbedding('BAAI/bge-m3', options), embedding);
  assert.notEqual(factory.createEmbedding('BAAI/bge-m3', { ...options, batchSize: 1 }), embedding);
  assert.equal(requests.length, 0);
});

test('Ollama Embedding requests use 8192 context and finite shared residency despite provider defaults', async t => {
  t.mock.method(console, 'log', () => {});
  const previous = new Map(['OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE'].map(key => [key, process.env[key]]));
  process.env.OLLAMA_NUM_CTX = '262144';
  process.env.OLLAMA_KEEP_ALIVE = '15m';
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const requests = [];
  const fetch = async (url, request) => {
    assert.equal(new URL(url).href, 'http://embedding-context.invalid/api/embed');
    requests.push(JSON.parse(request.body));
    return Response.json({ embeddings: [[1, 2, 3]] });
  };
  const factory = EmbeddingFactory.getInstance();
  factory.clearCache();
  t.after(() => factory.clearCache());
  const embedding = factory.createEmbedding('context-fixture', {
    provider: 'ollama', baseUrl: 'http://embedding-context.invalid',
    options: { fetch, maxRetries: 0, keepAlive: '5m', requestOptions: { numCtx: 262144, num_ctx: 40960, temperature: 0 } },
  });
  assert.deepEqual(await embedding.embedQuery('short query'), [1, 2, 3]);
  assert.equal(requests[0].options.num_ctx, 8192);
  assert.equal(requests[0].options.temperature, 0);
  assert.equal(requests[0].keep_alive, '15m');
  assert.equal(requests[0].truncate, false);
});

test('a stalled Ollama embedding has a finite transport deadline, no retries, and releases capacity', async t => {
  const { createProviderAdmissionFetch } = await import('./models/provider-admission.ts');
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 30_000); return timeout.signal; });
  let calls=0;
  const baseUrl='http://embedding-deadline.invalid';
  const native=(_url,init)=>{ calls++; return new Promise((_,reject)=>{
    init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }); };
  const factory=EmbeddingFactory.getInstance();factory.clearCache();t.after(()=>factory.clearCache());
  const embedding=factory.createEmbedding('deadline-fixture',{provider:'ollama',baseUrl,options:{fetch:native,maxRetries:5}});
  assert.equal(embedding.caller.maxRetries,0);
  const pending=embedding.embedQuery('stalled');
  const failed=assert.rejects(pending,e=>e.name==='TimeoutError');
  await new Promise(resolve=>setImmediate(resolve));
  let nextStarted=false;
  const next=createProviderAdmissionFetch(async()=>{nextStarted=true;return new Response('next');},{provider:'ollama',baseUrl})('http://unused');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(nextStarted,false);
  timeout.abort(new DOMException('deadline','TimeoutError'));await failed;
  assert.equal(await(await next).text(),'next');assert.equal(calls,1);
});

test('cached embedding transports resolve the current Ask signal for each invocation', async t => {
  const { captureAskProviderUsage } = await import('./rag/core/provider-usage-observer.ts');
  const first=new AbortController();const second=new AbortController();let calls=0;
  const factory=EmbeddingFactory.getInstance();factory.clearCache();t.after(()=>factory.clearCache());
  const embedding=factory.createEmbedding('scope-fixture',{provider:'ollama',baseUrl:'http://embedding-scope.invalid',options:{
    fetch:async(_url,init)=>{calls++;if(calls===1)return new Promise((_,reject)=>{
      init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
    });assert.equal(init.signal.aborted,false);return Response.json({embeddings:[[1,2,3]]});},
  }});
  const a=captureAskProviderUsage(async()=>Response.json(await embedding.embedQuery('first')),{signal:first.signal});
  const rejected=assert.rejects(a,e=>e.name==='AbortError');
  await new Promise(resolve=>setImmediate(resolve));
  const b=captureAskProviderUsage(async()=>Response.json(await embedding.embedQuery('second')),{signal:second.signal});
  first.abort();await rejected;assert.deepEqual(await(await b).json(),[1,2,3]);assert.equal(second.signal.aborted,false);
});

test('graph clients can allow a longer Ollama cold start without changing ordinary embedding deadlines', async t => {
  t.mock.method(console, 'log', () => {});
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const previous = process.env.EMBEDDING_PROVIDER;
  const previousTimeout = process.env.OLLAMA_EMBEDDING_REQUEST_TIMEOUT_MS;
  process.env.EMBEDDING_PROVIDER = 'ollama';
  delete process.env.OLLAMA_EMBEDDING_REQUEST_TIMEOUT_MS;
  const factory = EmbeddingFactory.getInstance();
  factory.reloadConfig();
  t.after(() => {
    if (previous === undefined) delete process.env.EMBEDDING_PROVIDER; else process.env.EMBEDDING_PROVIDER = previous;
    if (previousTimeout === undefined) delete process.env.OLLAMA_EMBEDDING_REQUEST_TIMEOUT_MS; else process.env.OLLAMA_EMBEDDING_REQUEST_TIMEOUT_MS = previousTimeout;
    factory.reloadConfig();
  });
  const { createEmbedding } = await import('./model-config.ts');
  const options = { baseUrl: 'http://embedding-cold-start.invalid', options: {
    fetch: async () => Response.json({ embeddings: [[1, 2, 3]] }),
  } };
  const graph = createEmbedding('cold-start-fixture', { ...options, requestTimeoutMs: 300_000 });
  const ordinary = createEmbedding('cold-start-fixture', options);
  assert.notEqual(graph, ordinary);
  assert.deepEqual(await graph.embedQuery('graph entity'), [1, 2, 3]);
  assert.deepEqual(await ordinary.embedQuery('interactive query'), [1, 2, 3]);
  assert.deepEqual(deadlines, [300_000, 30_000]);
});
