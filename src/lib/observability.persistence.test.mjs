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

const { ObservabilityEngine } = await import('./observability.ts');

test('terminal trace update exposes its async persistence completion', async () => {
  let releaseTerminal;
  let terminalStarted;
  const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
  const terminalStartedGate = new Promise((resolve) => { terminalStarted = resolve; });
  const engine = new ObservabilityEngine({
    onTraceUpdate(trace) {
      if (trace.status !== 'SUCCESS') return undefined;
      terminalStarted();
      return terminalGate;
    },
  });
  const traceId = engine.createTrace({ name: 'durable request' });

  let settled = false;
  const terminalUpdate = engine.updateTrace(traceId, {
    status: 'SUCCESS',
    endTime: new Date(),
  });
  void terminalUpdate.then(() => { settled = true; });

  await terminalStartedGate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseTerminal();
  await terminalUpdate;
  assert.equal(settled, true);
});

test('terminal trace update propagates an async persistence failure', async () => {
  const persistenceFailure = new Error('postgres trace write failed');
  const engine = new ObservabilityEngine({
    onTraceUpdate(trace) {
      return trace.status === 'ERROR'
        ? Promise.reject(persistenceFailure)
        : undefined;
    },
  });
  const traceId = engine.createTrace({ name: 'failed request' });

  await assert.rejects(
    engine.updateTrace(traceId, {
      status: 'ERROR',
      endTime: new Date(),
    }),
    (error) => error === persistenceFailure
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
