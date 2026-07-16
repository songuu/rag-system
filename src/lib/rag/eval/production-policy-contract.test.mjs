import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  parseProductionPolicyContractFixture,
  runProductionPolicyContractEval,
} = await import('./production-policy-contract.ts');
const { productionPolicyContractTarget } = await import('./production-policy-target.ts');
const fixtureUrl = new URL('./fixtures/production-policy-contract-v1.json', import.meta.url);
const executionProfile = {
  executionMode: 'hermetic-in-process',
  externalServicePolicy: 'disabled',
  qualityScope: 'control-plane-contract-only',
  productionQualityMeasured: false,
};

test('production policy control-plane fixture passes hermetically and deterministically', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const first = await runProductionPolicyContractEval(
    fixture,
    productionPolicyContractTarget
  );
  const second = await runProductionPolicyContractEval(
    fixture,
    productionPolicyContractTarget
  );

  assert.equal(first.passed, true);
  assert.equal(first.totalCases, 23);
  assert.equal(first.passedCases, 23);
  assert.equal(first.failedCases, 0);
  assert.equal(first.target.executionMode, 'hermetic-in-process');
  assert.equal(first.target.externalServicePolicy, 'disabled');
  assert.equal(first.target.qualityScope, 'control-plane-contract-only');
  assert.equal(first.target.productionQualityMeasured, false);
  assert.match(first.suite.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, second);
});

test('contract target receives inputs without case labels or expectations', async () => {
  let observedInput;
  const fixture = fixtureWithCase({
    id: 'label-blind-probe',
    input: { kind: 'probe', payload: 'visible' },
    expected: { result: 'ok' },
  });
  const report = await runProductionPolicyContractEval(fixture, {
    id: 'label-blind-target',
    executionProfile,
    async run(input) {
      observedInput = input;
      return { result: 'ok' };
    },
  });

  assert.equal(report.passed, true);
  assert.deepEqual(observedInput, { kind: 'probe', payload: 'visible' });
  assert.equal('expected' in observedInput, false);
  assert.equal('id' in observedInput, false);
});

test('contract gate reports mismatches and non-deterministic targets', async () => {
  const mismatch = await runProductionPolicyContractEval(
    fixtureWithCase({
      id: 'mismatch',
      input: { kind: 'probe' },
      expected: { value: 1 },
    }),
    {
      id: 'mismatch-target',
      executionProfile,
      async run() {
        return { value: 2 };
      },
    }
  );
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.cases[0].status, 'mismatch');

  let invocation = 0;
  const nonDeterministic = await runProductionPolicyContractEval(
    fixtureWithCase({
      id: 'non-deterministic',
      input: { kind: 'probe' },
      expected: { value: 1 },
    }),
    {
      id: 'non-deterministic-target',
      executionProfile,
      async run() {
        invocation += 1;
        return { value: invocation };
      },
    }
  );
  assert.equal(nonDeterministic.passed, false);
  assert.equal(nonDeterministic.cases[0].status, 'non-deterministic');
});

test('contract gate bounds pending initial and repeated executions', async () => {
  const fixture = fixtureWithCase({
    id: 'pending-target',
    input: { kind: 'probe' },
    expected: { value: 1 },
  });

  let initialInvocations = 0;
  const initialTimeout = await runProductionPolicyContractEval(
    fixture,
    {
      id: 'pending-initial-target',
      executionProfile,
      async run() {
        initialInvocations += 1;
        return new Promise(() => {});
      },
    },
    { caseTimeoutMs: 10 }
  );
  assert.equal(initialInvocations, 1);
  assert.deepEqual(initialTimeout.cases[0], {
    caseId: 'pending-target',
    status: 'error',
    error:
      '[rag production contract] target initial execution timed out after 10ms.',
  });

  let repeatedInvocations = 0;
  const repeatedTimeout = await runProductionPolicyContractEval(
    fixture,
    {
      id: 'pending-repeated-target',
      executionProfile,
      async run() {
        repeatedInvocations += 1;
        if (repeatedInvocations === 1) {
          return { value: 1 };
        }
        return new Promise(() => {});
      },
    },
    { caseTimeoutMs: 10 }
  );
  assert.equal(repeatedInvocations, 2);
  assert.deepEqual(repeatedTimeout.cases[0], {
    caseId: 'pending-target',
    status: 'error',
    error:
      '[rag production contract] target repeated execution timed out after 10ms.',
  });
});

test('contract gate clears execution timers and rejects invalid timeout options', async () => {
  const fixture = fixtureWithCase({
    id: 'timer-cleanup',
    input: { kind: 'probe' },
    expected: { value: 1 },
  });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  const cleared = [];

  globalThis.setTimeout = ((handler, delay, ...args) => {
    const timeout = originalSetTimeout(handler, delay, ...args);
    scheduled.push(timeout);
    return timeout;
  });
  globalThis.clearTimeout = timeout => {
    cleared.push(timeout);
    return originalClearTimeout(timeout);
  };

  try {
    const report = await runProductionPolicyContractEval(
      fixture,
      {
        id: 'timer-cleanup-target',
        executionProfile,
        async run() {
          return { value: 1 };
        },
      },
      { caseTimeoutMs: 1_000 }
    );
    assert.equal(report.passed, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.equal(scheduled.length, 2);
  assert.deepEqual(cleared, scheduled);

  for (const caseTimeoutMs of [0, -1, 1.5, Number.NaN, 300_001]) {
    await assert.rejects(
      runProductionPolicyContractEval(
        fixture,
        {
          id: 'invalid-timeout-target',
          executionProfile,
          async run() {
            return { value: 1 };
          },
        },
        { caseTimeoutMs }
      ),
      /caseTimeoutMs must be an integer between 1 and 300000/
    );
  }
});

test('contract fixture parser rejects duplicate case identities', () => {
  const fixture = fixtureWithCase({
    id: 'duplicate',
    input: { kind: 'probe' },
    expected: true,
  });
  fixture.cases.push(structuredClone(fixture.cases[0]));

  assert.throws(
    () => parseProductionPolicyContractFixture(fixture),
    /is duplicated/
  );
});

test('contract fixture parser rejects evaluator labels hidden inside target input', () => {
  for (const input of [
    { kind: 'probe', id: 'case-label' },
    { kind: 'probe', tags: ['gold'] },
    { kind: 'probe', expected: { answer: 'leaked' } },
    { kind: 'probe', payload: { goldEvidence: ['leaked'] } },
  ]) {
    assert.throws(
      () =>
        parseProductionPolicyContractFixture(
          fixtureWithCase({
            id: 'oracle-leak',
            input,
            expected: true,
          })
        ),
      /reserved evaluator-only field/
    );
  }
});

function fixtureWithCase(contractCase) {
  return {
    schemaVersion: 'rag-production-policy-contract/v1',
    suiteId: 'unit-contract',
    suiteVersion: 'v1',
    cases: [contractCase],
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
