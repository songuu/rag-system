import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

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
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const source = readFileSync(new URL(url), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    };
  },
});

const [{ AIMessage }, { RunnableLambda }, { ObservabilityEngine }, { LocalRAGSystem }] =
  await Promise.all([
    import('@langchain/core/messages'),
    import('@langchain/core/runnables'),
    import('./observability.ts'),
    import('./rag-system.ts'),
  ]);

test('successful RAG request waits for its terminal trace persistence', async () => {
  let releaseTerminal;
  let terminalStarted;
  const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
  const terminalStartedGate = new Promise((resolve) => { terminalStarted = resolve; });
  const instance = createTestRagSystem({
    onTraceUpdate(trace) {
      if (trace.status !== 'SUCCESS') return undefined;
      terminalStarted();
      return terminalGate;
    },
  });

  let settled = false;
  const request = instance.askWithDetails('What is durable?');
  void request.then(() => { settled = true; });

  await terminalStartedGate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseTerminal();
  const response = await request;
  assert.equal(response.answer, 'durable answer');
  assert.equal(settled, true);
});

test('failed RAG request exposes terminal PostgreSQL trace failure', async () => {
  const queryFailure = new Error('model request failed');
  const persistenceFailure = new Error('postgres trace write failed');
  const instance = createTestRagSystem({
    queryFailure,
    onTraceUpdate(trace) {
      return trace.status === 'ERROR'
        ? Promise.reject(persistenceFailure)
        : undefined;
    },
  });

  await assert.rejects(
    instance.askWithDetails('What failed?'),
    (error) => {
      assert.match(error.message, /persist terminal RAG trace to PostgreSQL/i);
      assert.equal(error.cause, persistenceFailure);
      return true;
    }
  );
});

function createTestRagSystem({ onTraceUpdate, queryFailure } = {}) {
  const instance = Object.create(LocalRAGSystem.prototype);
  instance.isInitialized = true;
  instance.config = {};
  instance.observabilityEngine = new ObservabilityEngine({ onTraceUpdate });
  instance.llm = RunnableLambda.from(async () => new AIMessage('durable answer'));
  instance.vectorStore = {
    async similaritySearchWithDetails() {
      if (queryFailure) throw queryFailure;
      return {
        searchResults: [],
        totalDocuments: 0,
        searchTime: 1,
      };
    },
  };
  return instance;
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
