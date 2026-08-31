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
  getLangSmithClient,
  getLangSmithRuntimeConfig,
} = await import('./config.ts');
const { runWithLangSmithRootRun } = await import('./tracing.ts');
const { isPrivateLangSmithTracingClient } = await import('./private-tracing.ts');
const { RunnableLambda } = await import('@langchain/core/runnables');
const { LangChainTracer } = await import('@langchain/core/tracers/tracer_langchain');
const { FakeToolCallingModel, createAgent } = await import('langchain');
const { traceable } = await import('langsmith/traceable');

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

test('runWithLangSmithRootRun redirects legacy automatic tracing to a private client', async t => {
  const automaticTraceRuns = [];
  t.mock.method(LangChainTracer.prototype, 'onRunCreate', async function (run) {
    automaticTraceRuns.push({
      run,
      isPrivate: isPrivateLangSmithTracingClient(this.client),
    });
  });
  t.mock.method(LangChainTracer.prototype, 'onRunUpdate', async () => {});

  await withEnvAsync({
    LANGSMITH_TRACING: undefined,
    LANGSMITH_TRACING_V2: undefined,
    LANGSMITH_API_KEY: undefined,
    LANGCHAIN_TRACING: undefined,
    LANGCHAIN_TRACING_V2: 'true',
    LANGCHAIN_API_KEY: 'legacy-unit-key',
    LANGSMITH_HIDE_INPUTS: undefined,
    LANGSMITH_HIDE_OUTPUTS: undefined,
  }, async () => {
    const result = await runWithLangSmithRootRun({
      name: 'unit-legacy-private-root',
    }, async context => {
      assert.equal(context.enabled, false);
      const child = RunnableLambda.from(() => 'legacy private tenant evidence');
      return child.invoke(null, { runName: 'legacy-must-not-be-traced' });
    });

    assert.equal(result, 'legacy private tenant evidence');
    assert.equal(automaticTraceRuns.length > 0, true);
    assert.equal(automaticTraceRuns.every(item => item.isPrivate), true);
  });
});

test('runWithLangSmithRootRun prevents private LangChain child uploads by default', async () => {
  await withEnvAsync({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'unit-private-api-key',
    LANGSMITH_ENDPOINT: 'https://langsmith.invalid',
    LANGSMITH_PROJECT: 'unit-private-boundary',
    LANGSMITH_HIDE_INPUTS: undefined,
    LANGSMITH_HIDE_OUTPUTS: undefined,
  }, async () => {
    const client = getLangSmithClient(getLangSmithRuntimeConfig());
    assert.ok(client);
    const originalCreateRun = client.createRun;
    const originalUpdateRun = client.updateRun;
    const createdRuns = [];

    client.createRun = async run => {
      createdRuns.push(structuredClone(run));
    };
    client.updateRun = async () => {};

    try {
      const result = await runWithLangSmithRootRun({
        name: 'unit-private-root',
        inputs: { question: 'private root question', topK: 5 },
      }, async context => {
        assert.equal(context.enabled, true);
        assert.ok(context.privateLangChainCallbacks);
        const child = RunnableLambda.from(() => 'private tenant evidence');
        return child.invoke(null, { runName: 'must-not-be-traced' });
      });

      assert.equal(result, 'private tenant evidence');
      assert.equal(
        createdRuns.some(run => JSON.stringify(run).includes('private tenant evidence')),
        false
      );
      assert.equal(
        createdRuns.some(run => JSON.stringify(run).includes('private root question')),
        false
      );
      assert.equal(
        createdRuns.some(run => run.inputs?.topK === 5),
        true
      );
      assert.equal(createdRuns.some(run => run.name === 'must-not-be-traced'), false);
    } finally {
      client.createRun = originalCreateRun;
      client.updateRun = originalUpdateRun;
    }
  });
});

test('runWithLangSmithRootRun reroots real createAgent spans onto the discard client', async t => {
  const automaticTraceRuns = [];
  t.mock.method(LangChainTracer.prototype, 'onRunCreate', async function (run) {
    automaticTraceRuns.push({
      run,
      isPrivate: isPrivateLangSmithTracingClient(this.client),
    });
  });
  t.mock.method(LangChainTracer.prototype, 'onRunUpdate', async () => {});

  await withEnvAsync({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'unit-dual-hide-key',
    LANGSMITH_ENDPOINT: 'https://langsmith.invalid',
    LANGSMITH_PROJECT: 'unit-dual-hide-boundary',
    LANGSMITH_HIDE_INPUTS: 'true',
    LANGSMITH_HIDE_OUTPUTS: 'true',
  }, async () => {
    const client = getLangSmithClient(getLangSmithRuntimeConfig());
    assert.ok(client);
    const originalCreateRun = client.createRun;
    const originalUpdateRun = client.updateRun;
    const createdRuns = [];
    const enclosingRuns = [];
    client.createRun = async run => { createdRuns.push(structuredClone(run)); };
    client.updateRun = async () => {};

    try {
      const executeInsideUploadCapableParent = traceable(
        () => runWithLangSmithRootRun({
          name: 'unit-dual-hide-root',
        }, async context => {
          assert.equal(context.enabled, true);
          assert.ok(context.privateLangChainCallbacks);
          await RunnableLambda.from(() => 'private boundary probe').invoke(null);
          const agent = createAgent({
            model: new FakeToolCallingModel({ toolCalls: [[]] }),
            tools: [],
          });
          const workflow = RunnableLambda.from((_input, activeConfig) => {
            return agent.invoke({
              messages: [{ role: 'user', content: 'dual hide private agent question' }],
            }, {
              runName: 'dual-hide-agent-must-not-be-traced',
              callbacks: activeConfig.callbacks,
            });
          });
          return workflow.invoke(null, {
            callbacks: context.privateLangChainCallbacks,
          });
        }),
        {
          name: 'upload-capable-enclosing-parent',
          tracingEnabled: true,
          client: {
            async createRun(run) { enclosingRuns.push(structuredClone(run)); },
            async updateRun() {},
          },
          processInputs: () => ({}),
          processOutputs: () => ({}),
        }
      );
      const result = await executeInsideUploadCapableParent();

      assert.equal(Array.isArray(result.messages), true);
      assert.equal(automaticTraceRuns.length > 0, true);
      assert.equal(automaticTraceRuns.every(item => item.isPrivate), true);
      assert.equal(enclosingRuns.length, 1);
      assert.equal(
        JSON.stringify(enclosingRuns).includes('dual hide private agent question'),
        false
      );
      assert.equal(
        createdRuns.some(run => JSON.stringify(run).includes('dual hide private agent question')),
        false
      );
    } finally {
      client.createRun = originalCreateRun;
      client.updateRun = originalUpdateRun;
    }
  });
});

test('runWithLangSmithRootRun publishes only a stable root error for private child failures', async t => {
  const automaticTraceRuns = [];
  t.mock.method(LangChainTracer.prototype, 'onRunCreate', async function (run) {
    automaticTraceRuns.push({
      run,
      isPrivate: isPrivateLangSmithTracingClient(this.client),
    });
  });
  t.mock.method(LangChainTracer.prototype, 'onRunUpdate', async () => {});

  await withEnvAsync({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'unit-private-error-key',
    LANGSMITH_ENDPOINT: 'https://langsmith.invalid',
    LANGSMITH_PROJECT: 'unit-private-error-boundary',
    LANGSMITH_HIDE_INPUTS: 'true',
    LANGSMITH_HIDE_OUTPUTS: 'true',
  }, async () => {
    const client = getLangSmithClient(getLangSmithRuntimeConfig());
    assert.ok(client);
    const originalCreateRun = client.createRun;
    const originalUpdateRun = client.updateRun;
    const createdRuns = [];
    const updatedRuns = [];

    client.createRun = async run => {
      createdRuns.push(structuredClone(run));
    };
    client.updateRun = async (...args) => {
      updatedRuns.push(structuredClone(args));
    };

    try {
      const privateError = 'private endpoint=https://tenant.invalid token=secret evidence body';
      await assert.rejects(
        () => runWithLangSmithRootRun({
          name: 'unit-private-error-root',
          inputs: { question: 'public input' },
        }, async context => {
          assert.equal(context.enabled, true);
          assert.ok(context.privateLangChainCallbacks);
          const child = RunnableLambda.from(() => {
            throw new Error(privateError);
          });
          return child.invoke(null, { runName: 'private-error-must-not-be-traced' });
        }),
        error => error instanceof Error && error.message === privateError
      );

      const serializedRuns = JSON.stringify({ createdRuns, updatedRuns });
      assert.equal(automaticTraceRuns.length > 0, true);
      assert.equal(automaticTraceRuns.every(item => item.isPrivate), true);
      assert.equal(serializedRuns.includes(privateError), false);
      assert.equal(serializedRuns.includes('private-error-must-not-be-traced'), false);
      assert.equal(serializedRuns.includes('RAG_EXECUTION_FAILED'), true);
    } finally {
      client.createRun = originalCreateRun;
      client.updateRun = originalUpdateRun;
    }
  });
});

test('runWithLangSmithRootRun preserves execution when client initialization fails', async t => {
  const automaticTraceRuns = [];
  t.mock.method(console, 'warn', () => {});
  t.mock.method(LangChainTracer.prototype, 'onRunCreate', async function (run) {
    automaticTraceRuns.push({
      run,
      isPrivate: isPrivateLangSmithTracingClient(this.client),
    });
  });
  t.mock.method(LangChainTracer.prototype, 'onRunUpdate', async () => {});

  await withEnvAsync({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'unit-invalid-sampling-key',
    LANGSMITH_ENDPOINT: 'https://langsmith.invalid',
    LANGSMITH_PROJECT: 'unit-client-init-failure',
    LANGSMITH_TRACING_SAMPLE_RATE: '2',
  }, async () => {
    const result = await runWithLangSmithRootRun({
      name: 'unit-client-init-failure-root',
    }, async context => {
      assert.equal(context.enabled, false);
      assert.ok(context.privateLangChainCallbacks);
      const child = RunnableLambda.from(() => 'business result after telemetry failure');
      return child.invoke(null, {
        callbacks: context.privateLangChainCallbacks,
      });
    });

    assert.equal(result, 'business result after telemetry failure');
    assert.equal(automaticTraceRuns.length > 0, true);
    assert.equal(automaticTraceRuns.every(item => item.isPrivate), true);
  });
});

test('runWithLangSmithRootRun keeps a successful result when completion telemetry fails', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});

  await withEnvAsync({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'unit-completion-failure-key',
    LANGSMITH_ENDPOINT: 'https://langsmith.invalid',
    LANGSMITH_PROJECT: 'unit-completion-failure',
  }, async () => {
    const client = getLangSmithClient(getLangSmithRuntimeConfig());
    assert.ok(client);
    const originalCreateRun = client.createRun;
    const originalUpdateRun = client.updateRun;

    client.createRun = async () => {};
    client.updateRun = async () => {
      throw new Error('temporary LangSmith update failure');
    };

    try {
      const result = await runWithLangSmithRootRun({
        name: 'unit-successful-business-root',
      }, async () => ({ answer: 'business result' }));

      assert.deepEqual(result, { answer: 'business result' });
    } finally {
      client.createRun = originalCreateRun;
      client.updateRun = originalUpdateRun;
    }
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
