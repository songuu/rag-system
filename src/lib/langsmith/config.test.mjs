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
  buildLangSmithMetadata,
  createLangSmithThreadId,
  getLangSmithRuntimeConfig,
} = await import('./config.ts');
const { runWithLangSmithRootRun } = await import('./tracing.ts');

test('LangSmith config stays disabled without an API key', () => {
  withEnv({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: undefined,
    LANGSMITH_PROJECT: 'unit-project',
  }, () => {
    const config = getLangSmithRuntimeConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.projectName, 'unit-project');
  });
});

test('LangSmith thread metadata prefers existing session identity', () => {
  const threadId = createLangSmithThreadId({ sessionId: 'session-123' });
  const metadata = buildLangSmithMetadata({
    threadId,
    sessionId: 'session-123',
    userId: 'user-1',
    route: '/api/ask',
    policyId: 'agentic',
  });

  assert.equal(threadId, 'session-123');
  assert.equal(metadata.thread_id, 'session-123');
  assert.equal(metadata.session_id, 'session-123');
  assert.equal(metadata.conversation_id, 'session-123');
  assert.equal(metadata.rag_policy, 'agentic');
});

test('runWithLangSmithRootRun preserves execution when tracing is disabled', async () => {
  await withEnvAsync({
    LANGSMITH_TRACING: undefined,
    LANGSMITH_API_KEY: undefined,
  }, async () => {
    const result = await runWithLangSmithRootRun({
      name: 'unit',
      fallbackRunId: 'fallback-run',
      inputs: { question: 'hello' },
    }, async (context) => ({
      enabled: context.enabled,
      runId: context.runId,
      ok: true,
    }));

    assert.deepEqual(result, {
      enabled: false,
      runId: 'fallback-run',
      ok: true,
    });
  });
});

function withEnv(updates, fn) {
  const previous = snapshotEnv(updates);
  try {
    applyEnv(updates);
    fn();
  } finally {
    applyEnv(previous);
  }
}

async function withEnvAsync(updates, fn) {
  const previous = snapshotEnv(updates);
  try {
    applyEnv(updates);
    await fn();
  } finally {
    applyEnv(previous);
  }
}

function snapshotEnv(updates) {
  return Object.fromEntries(
    Object.keys(updates).map(key => [key, process.env[key]])
  );
}

function applyEnv(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
