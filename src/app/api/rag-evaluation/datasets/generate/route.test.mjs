import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.resolve('src/lib/rag/eval/dataset-generation.ts')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/rag/eval/dataset-generation') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      import { generateRagEvalDataset as generate } from ${JSON.stringify(moduleUrl)};
      import { generateRagEvalDatasetFromCorpus as generateCorpus } from ${JSON.stringify(moduleUrl)};
      export { validateDatasetGenerationSettings, withDatasetCancellation } from ${JSON.stringify(moduleUrl)};
      export function generateRagEvalDataset(input, options) { return generate(input, { ...options, generateCandidates: globalThis.__datasetCandidates }); }
      export function generateRagEvalDatasetFromCorpus(input, corpus, options) { return generateCorpus(input, corpus, { ...options, generateCandidates: globalThis.__datasetCandidates }); }
    `) };
    if (specifier === '@/lib/rag/eval/knowledge-dataset-sources') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export function loadKnowledgeDatasetSources(input) { return globalThis.__knowledgeDatasetSources(input); }
    `) };
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, context);
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(target) && existsSync(new URL(target.href + '.ts'))) return nextResolve(target.href + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const { POST } = await import('./route.ts');
const input = { datasetId: 'dataset', datasetVersion: '1', count: 1, sources: [{ source: 'notes.txt', content: '平台支持中文。' }] };
const request = (body = input, headers = {}) => new Request('http://localhost/api/rag-evaluation/datasets/generate', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('knowledge generation resolves selected assets inside server scope and includes fixed source coverage', async () => {
  const env = { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'fixture-token',
    RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_DEFAULT_TENANT_ID: 'tenant-a', RAG_DEFAULT_CORPUS_ID: 'corpus-a' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const authorized = { authorization: 'Bearer fixture-token' };
  const selection = { datasetId: '知识库', datasetVersion: '1', count: 1, documentAssetIds: ['asset-1'] };
  let loads = 0; let calls = 0;
  const corpus = [{ evidenceId: 'real-chunk-1', documentId: 'real-doc', documentVersion: 'revision-1',
    tenantId: 'tenant-a', corpusId: 'corpus-a', trustLevel: 'external', source: '资料.pdf', content: '平台支持中文。',
    metadata: { documentAssetId: 'asset-1', chunkIndex: 9, totalChunks: 10, selectedChunks: 1, sampled: true } }];
  const sourceCoverage = [{ documentAssetId: 'asset-1', source: '资料.pdf', documentVersion: 'revision-1',
    totalChunks: 10, selectedChunks: 1, characterCount: 7, sampled: true }];
  globalThis.__knowledgeDatasetSources = async input => {
    loads++; assert.deepEqual(input.documentAssetIds, ['asset-1']);
    assert.deepEqual({ ...input.scope }, { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['trusted', 'reviewed', 'external'], enforceIsolation: true });
    assert.ok(input.signal instanceof AbortSignal);
    return { corpus, sourceCoverage };
  };
  globalThis.__datasetCandidates = async () => { calls++; return { cases: [{ query: '支持什么语言？', referenceAnswer: '中文', requiredFacts: [['中文']],
    evidence: [{ sourceIndex: 0, quote: '平台支持中文。', relevance: 3 }] }] }; };
  try {
    assert.equal((await POST(request(selection))).status, 401);
    assert.equal(loads, 0);
    assert.equal((await POST(request({ ...selection, count: 0 }, authorized))).status, 400);
    assert.equal(loads, 0);
    for (const extra of [{ sources: input.sources }, { tenantId: 'tenant-b' }, { model: 'evil' }]) {
      assert.equal((await POST(request({ ...selection, ...extra }, authorized))).status, 400);
    }
    const response = await POST(request(selection, authorized));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.dataset.corpus, corpus);
    assert.deepEqual(body.sourceCoverage, sourceCoverage);
    assert.equal(body.dataset.cases[0].goldEvidence[0].evidenceId, 'real-chunk-1');
    assert.equal(calls, 1); assert.equal(loads, 1);
    globalThis.__knowledgeDatasetSources = async () => { throw new Error('postgres password secret'); };
    const failed = await POST(request(selection, authorized));
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(await failed.json()), /password|secret/);
    assert.equal(calls, 1);
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.__knowledgeDatasetSources = async () => { started(); return new Promise(() => {}); };
    const controller = new AbortController();
    const pending = POST(new Request('http://localhost/api/rag-evaluation/datasets/generate', {
      method: 'POST', headers: authorized, body: JSON.stringify(selection), signal: controller.signal,
    }));
    await ready; controller.abort();
    assert.equal((await pending).status, 499);
  } finally {
    delete globalThis.__datasetCandidates; delete globalThis.__knowledgeDatasetSources;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test('generation route authenticates, validates body, redacts provider errors and enforces cancellation/deadline', async t => {
  const env = { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'fixture-token',
    RAG_SINGLE_TENANT_ACTOR_ID: 'viewer', RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_DEFAULT_TENANT_ID: 'tenant-a', RAG_DEFAULT_CORPUS_ID: 'corpus-a' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let calls = 0;
  globalThis.__datasetCandidates = async (_input, signal) => { calls++; assert.ok(signal instanceof AbortSignal); return { cases: [{
    query: '平台支持什么？', referenceAnswer: '平台支持中文。', requiredFacts: [['中文']], evidence: [{ sourceIndex: 0, quote: '平台支持中文。', relevance: 3 }],
  }] }; };
  const authorized = { authorization: 'Bearer fixture-token' };
  try {
    assert.equal((await POST(request())).status, 401);
    assert.equal(calls, 0);
    const response = await POST(request(input, authorized));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.dataset.cases[0].expectedAnswer.referenceAnswer, '平台支持中文。');
    assert.equal((await POST(request('{', authorized))).status, 400);
    assert.equal((await POST(request({ ...input, count: 21 }, authorized))).status, 400);
    assert.equal((await POST(request(input, { ...authorized, 'content-length': String(128 * 1024 + 1) }))).status, 413);
    assert.equal(calls, 1);
    globalThis.__datasetCandidates = async () => { throw new Error('secret provider token=sk-private https://secret.example.com'); };
    const failed = await POST(request(input, authorized));
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(await failed.json()), /sk-private|secret\.example/);
    const controller = new AbortController();
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    let providerSignal;
    globalThis.__datasetCandidates = async (_input, signal) => {
      providerSignal = signal; markStarted();
      return new Promise(() => {});
    };
    const pending = POST(new Request('http://localhost/api/rag-evaluation/datasets/generate', {
      method: 'POST', headers: authorized, body: JSON.stringify(input), signal: controller.signal,
    }));
    await started;
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, 499);
    assert.equal(providerSignal.aborted, true);
    assert.equal((await cancelled.json()).error.code, 'DATASET_GENERATION_CANCELLED');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let markDeadlineStarted;
    const deadlineStarted = new Promise(resolve => { markDeadlineStarted = resolve; });
    globalThis.__datasetCandidates = async () => { markDeadlineStarted(); return new Promise(() => {}); };
    const timed = POST(request(input, authorized));
    await deadlineStarted;
    t.mock.timers.tick(270_000);
    const timedOut = await timed;
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error.code, 'DATASET_GENERATION_TIMEOUT');
  } finally {
    delete globalThis.__datasetCandidates;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('generation preserves validated questions when top-up exhausts or the provider fails', async () => {
  const env = { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'fixture-token',
    RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_DEFAULT_TENANT_ID: 'tenant-a', RAG_DEFAULT_CORPUS_ID: 'corpus-a' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const authorized = { authorization: 'Bearer fixture-token' };
  const oneCase = { query: '平台支持什么语言？', referenceAnswer: '中文', requiredFacts: [['中文']],
    evidence: [{ sourceIndex: 0, quote: '平台支持中文。', relevance: 3 }] };
  try {
    let calls = 0;
    globalThis.__datasetCandidates = async () => {
      calls++; return { cases: calls === 1 ? [oneCase] : [] };
    };
    const partial = await POST(request({ ...input, count: 3 }, authorized));
    assert.equal(partial.status, 200);
    const body = await partial.json();
    assert.equal(body.success, true);
    assert.equal(body.dataset.cases.length, 1);
    assert.equal(body.dataset.cases[0].query, oneCase.query);
    assert.deepEqual({ ...body.generation, attempts: 0, message: '' }, {
      requestedCount: 3, generatedCount: 1, complete: false, attempts: 0, reason: 'attempt_limit', message: '',
    });
    assert.match(body.generation.message, /1.*3|3.*1/);
    assert.ok(calls <= 6);
    calls = 0;
    globalThis.__datasetCandidates = async () => {
      if (++calls === 1) return { cases: [oneCase] };
      throw new Error('provider password=sk-secret https://private.example');
    };
    const interrupted = await POST(request({ ...input, count: 3 }, authorized));
    assert.equal(interrupted.status, 200);
    const interruptedBody = await interrupted.json();
    assert.equal(interruptedBody.generation.reason, 'provider_error');
    assert.equal(interruptedBody.generation.complete, false);
    assert.equal(interruptedBody.dataset.cases[0].query, oneCase.query);
    assert.doesNotMatch(JSON.stringify(interruptedBody), /sk-secret|private\.example/);
  } finally {
    delete globalThis.__datasetCandidates;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('server deadline returns accepted questions and their knowledge coverage', async t => {
  const env = { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'fixture-token',
    RAG_SINGLE_TENANT_ROLE: 'viewer', RAG_DEFAULT_TENANT_ID: 'tenant-a', RAG_DEFAULT_CORPUS_ID: 'corpus-a' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const corpus = [{ evidenceId: 'real-chunk', documentId: 'real-doc', documentVersion: 'rev-1', source: '资料.pdf', content: '平台支持中文。' }];
  const coverage = [{ documentAssetId: 'asset-1', source: '资料.pdf', documentVersion: 'rev-1', totalChunks: 4, selectedChunks: 1, characterCount: 7, sampled: true }];
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  let calls = 0;
  globalThis.__knowledgeDatasetSources = async () => ({ corpus, sourceCoverage: coverage });
  globalThis.__datasetCandidates = async () => {
    if (++calls === 1) return { cases: [{ query: '平台支持什么语言？', referenceAnswer: '中文', requiredFacts: [['中文']],
      evidence: [{ sourceIndex: 0, quote: '平台支持中文。', relevance: 3 }] }] };
    started(); return new Promise(() => {});
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = POST(request({ datasetId: '知识库', datasetVersion: '1', count: 10, documentAssetIds: ['asset-1'] }, { authorization: 'Bearer fixture-token' }));
    await waiting;
    t.mock.timers.tick(270_000);
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dataset.cases.length, 1);
    assert.deepEqual(body.sourceCoverage, coverage);
    assert.equal(body.generation.reason, 'timeout');
    assert.equal(body.generation.requestedCount, 10);
    assert.equal(body.generation.generatedCount, 1);
    assert.equal(body.generation.complete, false);
  } finally {
    delete globalThis.__datasetCandidates; delete globalThis.__knowledgeDatasetSources;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
