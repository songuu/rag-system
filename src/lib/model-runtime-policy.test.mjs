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
  createModelRequestTimeoutFetch,
  loadEnvConfig,
  resolveModelRequestPolicy,
} = await import('./model-config.ts');
const {
  RAG_CLIENT_REQUEST_TIMEOUT_MS,
  RAG_GENERATION_EXECUTION_BUDGET_MS,
  RAG_RETRIEVAL_EXECUTION_BUDGET_MS,
} = await import('./rag/core/request-budgets.ts');

const ENV_KEYS = [
  'MODEL_PROVIDER',
  'REASONING_PROVIDER',
  'FAST_LLM_MODEL',
  'RERANKER_MODEL',
  'MODEL_REQUEST_TIMEOUT_MS',
  'MODEL_MAX_RETRIES',
  'REASONING_REQUEST_TIMEOUT_MS',
  'REASONING_MAX_RETRIES',
];

test('Ollama defaults latency-sensitive Agentic tasks to a small model', () => {
  withEnv({ MODEL_PROVIDER: 'ollama' }, () => {
    const config = loadEnvConfig();
    assert.equal(config.FAST_LLM_MODEL, 'qwen2.5:0.5b');
    assert.equal(config.RERANKER_MODEL, 'qwen2.5:0.5b');
    assert.notEqual(config.RERANKER_MODEL, config.OLLAMA_REASONING_MODEL);
  });
});

test('request policy has bounded normal and reasoning defaults', () => {
  withEnv({}, () => {
    const config = loadEnvConfig();
    assert.deepEqual(
      {
        timeoutMs: config.MODEL_REQUEST_TIMEOUT_MS,
        maxRetries: config.MODEL_MAX_RETRIES,
      },
      { timeoutMs: 30_000, maxRetries: 0 }
    );
    assert.deepEqual(
      {
        timeoutMs: config.REASONING_REQUEST_TIMEOUT_MS,
        maxRetries: config.REASONING_MAX_RETRIES,
      },
      { timeoutMs: 90_000, maxRetries: 0 }
    );
  });
});

test('request policy accepts overrides and clamps unsafe values', () => {
  withEnv(
    {
      FAST_LLM_MODEL: 'fast-custom',
      RERANKER_MODEL: 'rerank-custom',
      MODEL_REQUEST_TIMEOUT_MS: '20',
      MODEL_MAX_RETRIES: '99',
      REASONING_REQUEST_TIMEOUT_MS: '999999',
      REASONING_MAX_RETRIES: '-2',
    },
    () => {
      const config = loadEnvConfig();
      assert.equal(config.FAST_LLM_MODEL, 'fast-custom');
      assert.equal(config.RERANKER_MODEL, 'rerank-custom');
      assert.equal(config.MODEL_REQUEST_TIMEOUT_MS, 1_000);
      assert.equal(config.MODEL_MAX_RETRIES, 5);
      assert.equal(config.REASONING_REQUEST_TIMEOUT_MS, 300_000);
      assert.equal(config.REASONING_MAX_RETRIES, 0);
    }
  );
});

test('per-call request policy bounds each attempt and the logical retry budget', () => {
  assert.deepEqual(
    resolveModelRequestPolicy(
      { requestTimeoutMs: 900_000, maxRetries: 100 },
      { timeoutMs: 30_000, maxRetries: 1 }
    ),
    { timeoutMs: 300_000, maxRetries: 0 }
  );
  assert.deepEqual(
    resolveModelRequestPolicy(
      { requestTimeoutMs: 10, maxRetries: -4 },
      { timeoutMs: 30_000, maxRetries: 1 }
    ),
    { timeoutMs: 1_000, maxRetries: 0 }
  );
  assert.deepEqual(
    resolveModelRequestPolicy({}, { timeoutMs: 0, maxRetries: 99 }),
    { timeoutMs: 1_000, maxRetries: 5 }
  );
});

test('browser request deadline covers the full retrieval and generation budget', () => {
  assert.equal(RAG_CLIENT_REQUEST_TIMEOUT_MS, 75_000);
  assert(
    RAG_CLIENT_REQUEST_TIMEOUT_MS
      > RAG_RETRIEVAL_EXECUTION_BUDGET_MS + RAG_GENERATION_EXECUTION_BUDGET_MS
  );
});

test('timeout fetch aborts a hung provider body within the configured deadline', async () => {
  const timedFetch = createModelRequestTimeoutFetch(1_000, hangingFetch);
  const startedAt = Date.now();
  // Node 24 intentionally unrefs AbortSignal.timeout's internal timer. A real
  // fetch keeps the event loop alive; this synthetic hanging fetch does not.
  const keepAlive = setTimeout(() => {}, 1_500);
  try {
    await assert.rejects(
      timedFetch('http://provider.invalid'),
      error => error?.name === 'TimeoutError'
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert(Date.now() - startedAt < 2_000);
});

test('timeout fetch preserves caller cancellation instead of remapping it', async () => {
  const timedFetch = createModelRequestTimeoutFetch(30_000, hangingFetch);
  const controller = new AbortController();
  const callerReason = new Error('caller cancelled');
  const pending = timedFetch('http://provider.invalid', {
    signal: controller.signal,
  });
  controller.abort(callerReason);
  await assert.rejects(pending, error => error === callerReason);
});

function hangingFetch(_input, init) {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error('timeout fetch must provide a signal');
    const rejectAbort = () => reject(signal.reason);
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

function withEnv(vars, callback) {
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    return callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
