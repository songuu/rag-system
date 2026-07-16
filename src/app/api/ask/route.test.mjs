import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const agenticStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let fixture;
let querySignals = [];
export function setAgenticFixture(value) {
  fixture = structuredClone(value);
  querySignals = [];
}
export function getAgenticQuerySignals() { return [...querySignals]; }
export class AgenticRAGSystem {
  async query(_question, options) {
    if (!fixture) throw new Error('Agentic route fixture is not configured.');
    querySignals.push(options?.signal);
    if (fixture.waitForAbort) {
      await new Promise((_resolve, reject) => {
        const rejectWithAbort = () => reject(options?.signal?.reason);
        if (options?.signal?.aborted) rejectWithAbort();
        else options?.signal?.addEventListener('abort', rejectWithAbort, { once: true });
      });
    }
    return structuredClone(fixture);
  }
}
`);
const moduleStubs = new Map([
  ['@/lib/agentic-rag', agenticStubUrl],
  ['@/lib/rag-instance', 'data:text/javascript,' + encodeURIComponent(`
    export async function getRagSystem() { throw new Error('memory fixture not configured'); }
  `)],
  ['@/lib/adaptive-entity-rag', 'data:text/javascript,' + encodeURIComponent(`
    export class AdaptiveEntityRAGExecutionError extends Error {}
    export function createAdaptiveEntityRAG() { throw new Error('adaptive fixture not configured'); }
  `)],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (moduleStubs.has(specifier)) {
      return { url: moduleStubs.get(specifier), shortCircuit: true };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(`${modulePath}.ts`)
        ? `${modulePath}.ts`
        : path.join(modulePath, 'index.ts');
      return nextResolve(pathToFileURL(target).href, context);
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const environmentKeys = [
  'RAG_ACCESS_MODE', 'RAG_SINGLE_TENANT_TOKEN', 'RAG_SINGLE_TENANT_ROLE',
  'RAG_SINGLE_TENANT_ACTOR_ID', 'SUPABASE_DEFAULT_TENANT_ID',
  'SUPABASE_DEFAULT_CORPUS_ID', 'LANGCHAIN_TRACING_V2',
];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'ask-route-token',
  RAG_SINGLE_TENANT_ROLE: 'owner',
  RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a',
  SUPABASE_DEFAULT_TENANT_ID: 'tenant-a',
  SUPABASE_DEFAULT_CORPUS_ID: 'corpus-a',
  LANGCHAIN_TRACING_V2: 'false',
});

const { NextRequest } = await import('next/server');
const { setAgenticFixture, getAgenticQuerySignals } = await import('@/lib/agentic-rag');
const { POST, invokeGenerationWithDeadline } = await import('./route.ts');

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('POST executes authenticated agentic policy through Kernel and preserves fallback success', async () => {
  setAgenticFixture(agenticFixture({
    workflowSteps: [
      { step: 'analyze_query', status: 'error', error: 'fast analyzer fallback' },
      { step: 'retrieve_original', status: 'completed' },
      { step: 'grade_retrieval', status: 'completed' },
      { step: 'generate', status: 'completed' },
    ],
  }));

  const response = await POST(askRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.answer, 'scoped answer');
  assert.equal(body.evidence[0].tenantId, 'tenant-a');
  assert.equal(body.evidence[0].corpusId, 'corpus-a');
  assert.equal(response.headers.get('x-rag-policy'), 'agentic');
  assert.equal(response.headers.get('x-rag-status'), 'completed');
  assert.equal(response.headers.get('x-rag-trace-id'), body.traceId);
  const querySignals = getAgenticQuerySignals();
  assert.equal(querySignals.length, 1);
  assert.equal(querySignals[0] instanceof AbortSignal, true);
  assert.equal(querySignals[0].aborted, false);
});

test('generation deadline admission-blocks non-cooperative work until it settles', async () => {
  let releaseTimedOutWork;
  const timedOutWork = new Promise(resolve => { releaseTimedOutWork = resolve; });
  const modelKey = `test-non-cooperative-${Date.now()}`;

  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 10,
      invoke: async signal => {
        assert.equal(signal.aborted, false);
        await timedOutWork;
        return 'late';
      },
    }),
    error => error?.code === 'RAG_GENERATION_TIMEOUT'
  );

  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 10,
      invoke: async () => 'must not start',
    }),
    error => error?.code === 'RAG_GENERATION_PROVIDER_BUSY'
  );

  releaseTimedOutWork();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    await invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 50,
      invoke: async signal => {
        assert.equal(signal.aborted, false);
        return 'recovered';
      },
    }),
    'recovered'
  );
});

test('generation admission remains blocked until every concurrent timed-out call settles', async () => {
  const releases = [];
  let calls = 0;
  const modelKey = `test-concurrent-non-cooperative-${Date.now()}`;
  const invoke = async () => {
    calls++;
    if (calls <= 2) {
      return new Promise(resolve => {
        releases.push(() => resolve(`late-${calls}`));
      });
    }
    return 'recovered';
  };

  const timedOutCalls = await Promise.allSettled([
    invokeGenerationWithDeadline({ modelKey, timeoutMs: 10, invoke }),
    invokeGenerationWithDeadline({ modelKey, timeoutMs: 10, invoke }),
  ]);
  assert.deepEqual(
    timedOutCalls.map(result => result.status === 'rejected' ? result.reason.code : 'fulfilled'),
    ['RAG_GENERATION_TIMEOUT', 'RAG_GENERATION_TIMEOUT']
  );
  assert.equal(calls, 2);
  assert.equal(releases.length, 2);

  releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    invokeGenerationWithDeadline({ modelKey, timeoutMs: 50, invoke }),
    error => error?.code === 'RAG_GENERATION_PROVIDER_BUSY'
  );
  assert.equal(calls, 2);

  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    await invokeGenerationWithDeadline({ modelKey, timeoutMs: 50, invoke }),
    'recovered'
  );
  assert.equal(calls, 3);
});

test('generation deadline keeps a stable timeout error when the provider rejects on abort', async () => {
  const modelKey = `test-cooperative-${Date.now()}`;
  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 10,
      invoke: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException(
          'provider observed abort',
          'AbortError'
        )), { once: true });
      }),
    }),
    error => error?.code === 'RAG_GENERATION_TIMEOUT'
  );
});

test('generation request cancellation stays distinct from timeout and tracks non-cooperative work', async () => {
  const controller = new AbortController();
  let releaseCancelledWork;
  const cancelledWork = new Promise(resolve => { releaseCancelledWork = resolve; });
  const modelKey = `test-request-cancel-${Date.now()}`;
  const cancelled = invokeGenerationWithDeadline({
    modelKey,
    timeoutMs: 1000,
    signal: controller.signal,
    invoke: async signal => {
      assert.equal(signal.aborted, false);
      await cancelledWork;
      return 'late';
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('private disconnect reason'));

  await assert.rejects(cancelled, error => {
    assert.equal(error?.code, 'RAG_REQUEST_ABORTED');
    assert.equal(error.message.includes('private disconnect reason'), false);
    return true;
  });
  await assert.rejects(
    invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 1000,
      invoke: async () => 'must not start',
    }),
    error => error?.code === 'RAG_GENERATION_PROVIDER_BUSY'
  );

  releaseCancelledWork();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    await invokeGenerationWithDeadline({
      modelKey,
      timeoutMs: 1000,
      invoke: async () => 'recovered',
    }),
    'recovered'
  );
});

test('POST propagates NextRequest.signal and returns a stable cancellation envelope', async t => {
  const errorLogs = [];
  t.mock.method(console, 'error', (...values) => errorLogs.push(values));
  setAgenticFixture(agenticFixture({ waitForAbort: true }));
  const controller = new AbortController();
  const pendingResponse = POST(askRequest(controller.signal));

  for (let attempt = 0; attempt < 100 && getAgenticQuerySignals().length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(getAgenticQuerySignals().length, 1);
  controller.abort(new Error('private HTTP disconnect'));

  const response = await pendingResponse;
  const body = await response.json();
  const serialized = JSON.stringify({ body, errorLogs });
  assert.equal(response.status, 499);
  assert.equal(body.code, 'RAG_REQUEST_ABORTED');
  assert.equal(body.rag.error.code, 'RAG_REQUEST_ABORTED');
  assert.equal(response.headers.get('x-rag-status'), 'failed');
  assert.equal(serialized.includes('private HTTP disconnect'), false);
  assert.equal(getAgenticQuerySignals()[0].aborted, true);
});

test('POST maps terminal agentic failure to a content-free partial Kernel envelope', async t => {
  const errorLogs = [];
  t.mock.method(console, 'error', (...values) => errorLogs.push(values));
  setAgenticFixture(agenticFixture({
    error: 'private provider failure: sk-do-not-leak',
    workflowSteps: [
      { step: 'retrieve_original', status: 'completed' },
      { step: 'generate', status: 'error', error: 'private generation failure' },
    ],
  }));

  const response = await POST(askRequest());
  const body = await response.json();
  const serialized = JSON.stringify(body);
  const serializedLogs = JSON.stringify(errorLogs);

  assert.equal(response.status, 502);
  assert.equal(body.code, 'AGENTIC_QUERY_FAILED');
  assert.equal(body.rag.status, 'failed');
  assert.equal(body.rag.evidence[0].id.startsWith('legacy-policy-'), true);
  assert.equal(response.headers.get('x-rag-policy'), 'agentic');
  assert.equal(response.headers.get('x-rag-status'), 'failed');
  for (const privateValue of [
    'private evidence content',
    'private provider failure',
    'private generation failure',
    'sk-do-not-leak',
    'private_metadata',
  ]) {
    assert.equal(serialized.includes(privateValue), false);
    assert.equal(serializedLogs.includes(privateValue), false);
  }
  assert.match(serializedLogs, /RAG_POLICY_EXECUTION_FAILED/);
});

function askRequest(signal) {
  return new NextRequest('http://localhost/api/ask', {
    method: 'POST',
    signal,
    headers: {
      authorization: 'Bearer ask-route-token',
      'content-type': 'application/json',
      'x-request-id': 'ask-route-test',
    },
    body: JSON.stringify({
      question: 'What is scoped?',
      storageBackend: 'milvus',
      useAgenticRAG: true,
      corpusId: 'corpus-a',
      topK: 2,
    }),
  });
}

function agenticFixture(overrides = {}) {
  return {
    query: 'What is scoped?',
    originalQuery: 'What is scoped?',
    processedQuery: 'What is scoped?',
    topK: 2,
    similarityThreshold: 0,
    maxRetries: 2,
    gradePassThreshold: 0.5,
    retrievedDocuments: [{
      content: 'private evidence content',
      metadata: {
        tenant_id: 'tenant-a', corpus_id: 'corpus-a', trust_level: 'reviewed',
        document_id: 'document-a', document_version: 'v1',
        private_metadata: 'must not leak on failure',
      },
      score: 0.9,
      relevanceScore: 0.9,
    }],
    originalQueryResults: [],
    processedQueryResults: [],
    context: 'private evidence content',
    answer: 'scoped answer',
    currentStep: 'completed',
    retryCount: 0,
    shouldRewrite: false,
    shouldRetrieve: true,
    workflowSteps: [],
    startTime: 1,
    endTime: 2,
    totalDuration: 1,
    retrievalQuality: { overallScore: 0.9 },
    ...overrides,
  };
}
