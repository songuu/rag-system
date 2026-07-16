import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const {
  buildDurableCheckpointKey,
  createDurableRagKernelStep,
  DurableRagWorkflowAdapter,
  DurableWorkflowCapacityError,
  DurableWorkflowBusyError,
  DurableWorkflowCancelledError,
  DurableWorkflowConflictError,
  DurableWorkflowFailedError,
  DurableWorkflowLeaseManagementError,
  DurableWorkflowResumeMismatchError,
  DurableWorkflowStepError,
  DurableWorkflowTerminalStepError,
  InMemoryDurableCheckpointStore,
} = await import('./durable-workflow.ts');
const { RagKernel } = await import('./kernel.ts');
const { createRagPolicy } = await import('./policies.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['reviewed', 'trusted'],
  enforceIsolation: true,
});
const TEST_INTEGRITY_KEY = 'test-integrity-key-0123456789abcdef';

test('durable adapter checkpoints each step and completed replay is idempotent', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const calls = [];
  const adapter = createMathWorkflow(store, calls);
  const invocation = createInvocation('thread-a');

  const result = await adapter.invoke(invocation);
  assert.equal(result.checkpoint.status, 'completed');
  assert.deepEqual(result.checkpoint.state, { value: 8 });
  assert.deepEqual(result.executedStepIds, ['add', 'double']);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.processPersistent, false);
  assert.deepEqual(calls.map(call => call.step), ['add', 'double']);

  const replay = await adapter.invoke(invocation);
  assert.equal(replay.resumed, true);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.executedStepIds, []);
  assert.deepEqual(calls.map(call => call.step), ['add', 'double']);
});

test('durable adapter isolates checkpoints by tenant and thread', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const calls = [];
  const adapter = createMathWorkflow(store, calls);

  await adapter.invoke(createInvocation('thread-a'));
  await adapter.invoke(createInvocation('thread-b'));
  await adapter.invoke({
    ...createInvocation('thread-a'),
    scope: { ...scope, tenantId: 'tenant-b' },
  });

  assert.equal(store.size, 3);
  assert.notEqual(
    buildDurableCheckpointKey('math-workflow', 'thread-a', 'tenant-a'),
    buildDurableCheckpointKey('math-workflow', 'thread-b', 'tenant-a')
  );
  assert.notEqual(
    buildDurableCheckpointKey('math-workflow', 'thread-a', 'tenant-a'),
    buildDurableCheckpointKey('math-workflow', 'thread-a', 'tenant-b')
  );
  assert.equal(calls.length, 6);
});

test('in-memory checkpoint capacity retains replays, then reclaims expired terminal entries', async () => {
  let storeNow = Date.parse('2026-07-15T00:00:00.000Z');
  const store = new InMemoryDurableCheckpointStore(
    'bounded-memory-store',
    1_048_576,
    1,
    {
      terminalRetentionMs: 60_000,
      now: () => new Date(storeNow),
    }
  );
  const adapter = createMathWorkflow(store, []);

  await adapter.invoke(createInvocation('capacity-a'));
  await assert.rejects(
    () => adapter.invoke(createInvocation('capacity-b')),
    error => error instanceof DurableWorkflowCapacityError
      && error.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
  );
  assert.equal(store.size, 1);

  storeNow += 60_001;
  const replacement = await adapter.invoke(createInvocation('capacity-b'));
  assert.equal(replacement.checkpoint.status, 'completed');
  assert.equal(store.size, 1);
  assert.equal(
    await store.load(
      buildDurableCheckpointKey('math-workflow', 'capacity-a', 'tenant-a')
    ),
    null
  );
});

test('in-memory lifecycle deletion is revision-fenced and terminal-only', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const completed = await createMathWorkflow(store, [])
    .invoke(createInvocation('delete-terminal'));
  await assert.rejects(
    () => store.delete(completed.checkpoint.checkpointKey, {
      expectedRevision: completed.checkpoint.revision - 1,
    }),
    error => error instanceof DurableWorkflowConflictError
  );
  assert.equal(
    await store.delete(completed.checkpoint.checkpointKey, {
      expectedRevision: completed.checkpoint.revision,
    }),
    true
  );
  assert.equal(store.size, 0);

  let enterStep;
  let releaseStep;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const activeAdapter = new DurableRagWorkflowAdapter({
    id: 'delete-active-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'wait',
      async execute() {
        enterStep();
        await release;
        return { done: true };
      },
    }],
  }, store);
  const activeInvocation = {
    ...createInvocation('delete-active'),
    job: { amount: 1 },
  };
  const activeRun = activeAdapter.invoke(activeInvocation);
  await entered;
  const activeKey = buildDurableCheckpointKey(
    'delete-active-workflow',
    'delete-active',
    'tenant-a'
  );
  const running = await store.load(activeKey);
  await assert.rejects(
    () => store.delete(activeKey, { expectedRevision: running.revision }),
    error => error instanceof DurableWorkflowLeaseManagementError
  );
  releaseStep();
  await activeRun;
});

test('resume revalidates workflow version, scope, document version, and job identity', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const invocation = createInvocation('resume-guard');
  await createMathWorkflow(store, []).invoke(invocation);

  await assert.rejects(
    () => createMathWorkflow(store, [], 'v2').invoke(invocation),
    error => mismatch(error, 'WORKFLOW_VERSION_MISMATCH')
  );
  await assert.rejects(
    () => createMathWorkflow(store, []).invoke({
      ...invocation,
      scope: { ...scope, corpusId: 'corpus-b' },
    }),
    error => mismatch(error, 'SCOPE_MISMATCH')
  );
  await assert.rejects(
    () => createMathWorkflow(store, []).invoke({
      ...invocation,
      documentId: 'document-b',
    }),
    error => mismatch(error, 'DOCUMENT_ID_MISMATCH')
  );
  await assert.rejects(
    () => createMathWorkflow(store, []).invoke({
      ...invocation,
      documentVersion: 'document-v2',
    }),
    error => mismatch(error, 'DOCUMENT_VERSION_MISMATCH')
  );
  await assert.rejects(
    () => createMathWorkflow(store, []).invoke({
      ...invocation,
      job: { amount: 99 },
    }),
    error => mismatch(error, 'JOB_FINGERPRINT_MISMATCH')
  );

  const renamedStepAdapter = new DurableRagWorkflowAdapter({
    id: 'math-workflow',
    version: 'v2',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { value: state.value }; },
    createInitialState() {
      return { value: 1 };
    },
    steps: [{
      id: 'renamed-step',
      async execute(context) {
        return context.state;
      },
    }],
  }, store, { integrityKey: TEST_INTEGRITY_KEY });
  await assert.rejects(
    () => renamedStepAdapter.invoke(invocation),
    error => mismatch(error, 'WORKFLOW_VERSION_MISMATCH')
  );
});

test('checkpoint projectors exclude unapproved data and serialization rejects unsafe shapes', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const adapter = createMathWorkflow(store, []);
  const projected = await adapter.invoke({
    ...createInvocation('projected-secret-job'),
    job: {
      amount: 3,
      apiKey: 'do-not-store',
      credentials: { value: 'do-not-store' },
      privateKeyMaterial: 'do-not-store',
      embedding: [0.1, 0.2],
    },
  });
  assert.deepEqual(projected.checkpoint.job, { amount: 3 });
  assert.equal(JSON.stringify(projected.checkpoint).includes('do-not-store'), false);
  await assert.rejects(
    () => adapter.invoke({
      ...createInvocation('error-job'),
      job: { amount: 3, failure: new Error('boom') },
    }),
    /non-plain object/
  );
  await assert.rejects(
    () => adapter.invoke({
      ...createInvocation('signal-job'),
      job: { amount: 3, signal: new AbortController().signal },
    }),
    /non-plain object/
  );
  await assert.rejects(
    () => adapter.invoke(createInvocation('../unsafe-thread')),
    /threadId must be a safe identifier/
  );

  const unsafeProjector = new DurableRagWorkflowAdapter({
    id: 'unsafe-projector-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { credentials: job.credentials }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{ id: 'noop', async execute(context) { return context.state; } }],
  }, new InMemoryDurableCheckpointStore());
  await assert.rejects(
    () => unsafeProjector.invoke({
      ...createInvocation('unsafe-projector'),
      job: { credentials: { value: 'do-not-store' } },
    }),
    /forbidden field.*credentials/
  );

  const toJsonArray = [];
  Object.defineProperty(toJsonArray, 'toJSON', {
    value() {
      return [{ apiKey: 'do-not-store' }];
    },
  });
  await assert.rejects(
    () => adapter.invoke({
      ...createInvocation('decorated-array-job'),
      job: { amount: 3, values: toJsonArray },
    }),
    /sparse or decorated array/
  );

  const accessorArray = [];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      return 'hidden';
    },
  });
  await assert.rejects(
    () => adapter.invoke({
      ...createInvocation('accessor-array-job'),
      job: { amount: 3, values: accessorArray },
    }),
    /sparse or decorated array/
  );
});

test('checkpoint sensitive-key policy rejects credential variants before load, save, or provider execution', async () => {
  const backingStore = new InMemoryDurableCheckpointStore(
    'sensitive-key-backing-store'
  );
  let loadCalls = 0;
  let saveCalls = 0;
  let providerCalls = 0;
  const recordingStore = {
    providerId: 'sensitive-key-recording-store',
    processPersistent: false,
    maxSerializedBytes: backingStore.maxSerializedBytes,
    async load(checkpointKey) {
      loadCalls += 1;
      return backingStore.load(checkpointKey);
    },
    async save(checkpoint, options) {
      saveCalls += 1;
      return backingStore.save(checkpoint, options);
    },
  };
  const adapter = new DurableRagWorkflowAdapter({
    id: 'sensitive-key-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return job; },
    projectStateForCheckpoint(state) { return state; },
    createInitialState(job) {
      return { done: false, tokenCount: job.tokenCount ?? 0 };
    },
    steps: [{
      id: 'provider-call',
      async execute(context) {
        providerCalls += 1;
        return { ...context.state, done: true };
      },
    }],
  }, recordingStore, { integrityKey: TEST_INTEGRITY_KEY });

  const forbiddenJobs = [
    ['camel auth token', { authToken: 'do-not-store' }],
    ['upper snake auth token', { AUTH_TOKEN: 'do-not-store' }],
    ['kebab auth token', { 'auth-token': 'do-not-store' }],
    ['camel session token', { sessionToken: 'do-not-store' }],
    ['snake session token', { session_token: 'do-not-store' }],
    ['kebab session token', { 'session-token': 'do-not-store' }],
    ['camel API token', { apiToken: 'do-not-store' }],
    ['upper snake API token', { API_TOKEN: 'do-not-store' }],
    ['kebab API token', { 'api-token': 'do-not-store' }],
    ['camel ID token', { idToken: 'do-not-store' }],
    ['upper snake ID token', { ID_TOKEN: 'do-not-store' }],
    ['kebab ID token', { 'id-token': 'do-not-store' }],
    ['lower JWT', { jwt: 'do-not-store' }],
    ['upper JWT', { JWT: 'do-not-store' }],
    ['JWT token', { jwtToken: 'do-not-store' }],
    ['credential singular', { credential: 'do-not-store' }],
    ['credential camel plural', { clientCredentials: 'do-not-store' }],
    ['credential kebab plural', { 'service-credentials': 'do-not-store' }],
    ['auth object', { auth: { scheme: 'bearer' } }],
    ['authentication object', { authentication: { value: 'do-not-store' } }],
    ['authorization uppercase', { AUTHORIZATION: 'do-not-store' }],
    ['session identifier', { sessionId: 'do-not-store' }],
    ['cookie jar', { cookieJar: 'do-not-store' }],
    ['set cookie snake', { set_cookie: 'do-not-store' }],
    ['cookie kebab', { 'cookie-value': 'do-not-store' }],
    ['private key camel', { privateKey: 'do-not-store' }],
    ['private key upper snake', { PRIVATE_KEY: 'do-not-store' }],
    ['private key kebab', { 'private-key': 'do-not-store' }],
    ['private key compact', { privatekey: 'do-not-store' }],
    ['nested sensitive key', {
      safe: { deeper: { metadata: { bearerToken: 'do-not-store' } } },
    }],
    ['token count string smuggling', { tokenCount: 'do-not-store' }],
  ];

  for (const [index, [label, job]] of forbiddenJobs.entries()) {
    await assert.rejects(
      () => adapter.invoke({
        ...createInvocation('sensitive-key-' + index),
        job,
      }),
      /forbidden field/,
      label
    );
    assert.equal(loadCalls, 0, label + ' must fail before checkpoint load');
    assert.equal(saveCalls, 0, label + ' must fail before checkpoint save');
    assert.equal(providerCalls, 0, label + ' must fail before provider call');
  }

  const allowed = await adapter.invoke({
    ...createInvocation('safe-token-counts'),
    job: {
      tokenCount: 8,
      totalTokenCount: 13,
      nested: {
        input_token_count: 5,
        'output-token-count': 3,
      },
    },
  });
  assert.deepEqual(allowed.checkpoint.job, {
    tokenCount: 8,
    totalTokenCount: 13,
    nested: {
      input_token_count: 5,
      'output-token-count': 3,
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(loadCalls, 1);
  assert.ok(saveCalls > 0);
});

test('pre-aborted invocation persists terminal cancellation and never runs a step', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const calls = [];
  const adapter = createMathWorkflow(store, calls);
  const controller = new AbortController();
  controller.abort();
  const invocation = {
    ...createInvocation('cancel-before-run'),
    signal: controller.signal,
  };

  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowCancelledError
  );
  const checkpoint = await store.load(
    buildDurableCheckpointKey('math-workflow', 'cancel-before-run', 'tenant-a')
  );
  assert.equal(checkpoint.status, 'cancelled');
  assert.equal(checkpoint.lastFailureCode, 'INVOCATION_ABORTED');
  assert.equal(JSON.stringify(checkpoint).includes('signal'), false);
  assert.deepEqual(calls, []);

  await assert.rejects(
    () => adapter.invoke(createInvocation('cancel-before-run')),
    error => error instanceof DurableWorkflowCancelledError
  );
  assert.deepEqual(calls, []);
});

test('in-step cancellation is terminal and AbortSignal stays runtime-only', async () => {
  const store = new InMemoryDurableCheckpointStore();
  const controller = new AbortController();
  let calls = 0;
  const adapter = new DurableRagWorkflowAdapter({
    id: 'cancel-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() {
      return { done: false };
    },
    steps: [{
      id: 'cancelled-step',
      async execute(context) {
        calls += 1;
        assert.equal(context.signal, controller.signal);
        controller.abort();
        return { done: true };
      },
    }],
  }, store);
  const invocation = {
    ...createInvocation('cancel-during-step'),
    signal: controller.signal,
  };

  await assert.rejects(
    () => adapter.invoke(invocation),
    error => (
      error instanceof DurableWorkflowCancelledError
      && error.stepId === 'cancelled-step'
    )
  );
  const checkpoint = await store.load(
    buildDurableCheckpointKey('cancel-workflow', 'cancel-during-step', 'tenant-a')
  );
  assert.equal(checkpoint.status, 'cancelled');
  assert.equal(checkpoint.nextStepIndex, 0);
  assert.equal('activeStep' in checkpoint, false);
  assert.equal(calls, 1);

  await assert.rejects(
    () => adapter.invoke(createInvocation('cancel-during-step')),
    error => error instanceof DurableWorkflowCancelledError
  );
  assert.equal(calls, 1);
});

test('non-cooperative step cancellation settles immediately and cannot replay', async t => {
  const store = new InMemoryDurableCheckpointStore();
  const controller = new AbortController();
  let enterStep;
  let releaseStep;
  let calls = 0;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const blocked = new Promise(resolve => { releaseStep = resolve; });
  const adapter = new DurableRagWorkflowAdapter({
    id: 'non-cooperative-cancel-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'blocked-step',
      async execute() {
        calls += 1;
        enterStep();
        await blocked;
        return { done: true };
      },
    }],
  }, store);
  t.after(() => releaseStep());
  const invocation = {
    ...createInvocation('non-cooperative-cancel'),
    signal: controller.signal,
  };

  const running = adapter.invoke(invocation);
  await entered;
  controller.abort(new Error('private disconnect reason'));
  await assert.rejects(
    running,
    error => (
      error instanceof DurableWorkflowCancelledError
      && error.stepId === 'blocked-step'
      && !error.message.includes('private disconnect reason')
    )
  );

  const checkpointKey = buildDurableCheckpointKey(
    'non-cooperative-cancel-workflow',
    'non-cooperative-cancel',
    'tenant-a'
  );
  const cancelled = await store.load(checkpointKey);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.lastFailureCode, 'INVOCATION_ABORTED');
  assert.equal('activeStep' in cancelled, false);
  await assert.rejects(
    () => adapter.invoke(createInvocation('non-cooperative-cancel')),
    error => error instanceof DurableWorkflowCancelledError
  );
  assert.equal(calls, 1);

  releaseStep();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.load(checkpointKey)).status, 'cancelled');
  assert.equal(calls, 1);
});

test('typed terminal step failures cannot be retried', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let calls = 0;
  const adapter = new DurableRagWorkflowAdapter({
    id: 'terminal-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() {
      return { done: false };
    },
    steps: [{
      id: 'terminal-step',
      async execute() {
        calls += 1;
        throw new DurableWorkflowTerminalStepError(
          'INVALID_SOURCE_ARTIFACT',
          'Source artifact can never satisfy this workflow.'
        );
      },
    }],
  }, store);
  const invocation = createInvocation('terminal-thread');

  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowFailedError
  );
  const checkpoint = await store.load(
    buildDurableCheckpointKey('terminal-workflow', 'terminal-thread', 'tenant-a')
  );
  assert.equal(checkpoint.status, 'failed');
  assert.equal(checkpoint.lastFailureCode, 'TERMINAL_STEP_FAILURE');

  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowFailedError
  );
  assert.equal(calls, 1);
});

test('failed steps resume with the same downstream idempotency key', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let attempts = 0;
  const executionIds = [];
  const createAdapter = () => new DurableRagWorkflowAdapter({
    id: 'retry-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { completed: state.completed }; },
    createInitialState() {
      return { completed: false };
    },
    steps: [{
      id: 'unstable-step',
      async execute(context) {
        attempts += 1;
        executionIds.push(context.stepExecutionId);
        if (attempts === 1) throw new Error('transient');
        return { completed: true };
      },
    }],
  }, store);
  const adapter = createAdapter();
  const invocation = {
    ...createInvocation('retry-thread'),
    job: { amount: 1 },
  };

  await assert.rejects(
    () => adapter.invoke(invocation),
    error => (
      error instanceof DurableWorkflowStepError
      && error.stepId === 'unstable-step'
    )
  );
  const paused = await store.load(
    buildDurableCheckpointKey('retry-workflow', 'retry-thread', 'tenant-a')
  );
  assert.equal(paused.status, 'paused');
  assert.equal(paused.lastFailureCode, 'STEP_EXECUTION_FAILED');
  assert.equal('error' in paused, false);

  const resumed = await createAdapter().invoke(invocation);
  assert.equal(resumed.checkpoint.status, 'completed');
  assert.deepEqual(executionIds, [executionIds[0], executionIds[0]]);
});

test('loaded checkpoints reject job, state, fingerprint, and progress corruption', async () => {
  const invocation = createInvocation('tamper-thread');
  const sourceStore = new InMemoryDurableCheckpointStore();
  const original = (
    await createMathWorkflow(sourceStore, []).invoke(invocation)
  ).checkpoint;

  await assert.rejects(
    () => createMathWorkflow(checkpointStore({
      ...original,
      job: { amount: 99 },
    }), []).invoke(invocation),
    /checkpoint integrity validation failed/
  );
  await assert.rejects(
    () => createMathWorkflow(checkpointStore({
      ...original,
      jobFingerprint: '0'.repeat(64),
    }), []).invoke(invocation),
    /checkpoint integrity validation failed/
  );

  const alternateInvocation = {
    ...createInvocation('fingerprint-template'),
    job: { amount: 99 },
  };
  const alternateFingerprint = (
    await createMathWorkflow(new InMemoryDurableCheckpointStore(), [])
      .invoke(alternateInvocation)
  ).checkpoint.jobFingerprint;
  await assert.rejects(
    () => createMathWorkflow(checkpointStore({
      ...original,
      job: { amount: 99 },
      jobFingerprint: alternateFingerprint,
    }), []).invoke(invocation),
    /checkpoint integrity validation failed/
  );

  await assert.rejects(
    () => createMathWorkflow(checkpointStore({
      ...original,
      state: { value: 999 },
    }), []).invoke(invocation),
    /checkpoint integrity validation failed/
  );

  await assert.rejects(
    () => createMathWorkflow(checkpointStore({
      ...original,
      status: 'pending',
    }), []).invoke(invocation),
    /checkpoint integrity validation failed/
  );
});

test('process-persistent stores require an integrity key before any load', () => {
  const persistentStore = {
    providerId: 'persistent-without-key',
    processPersistent: true,
    async load() {
      throw new Error('constructor must fail before load');
    },
    async save() {
      throw new Error('constructor must fail before save');
    },
  };

  assert.throws(
    () => createMathWorkflow(persistentStore, [], 'v1', null),
    /Process-persistent checkpoint stores require an integrityKey/
  );
});

test('process-persistent checkpoints reject a valid tag produced with a different key', async () => {
  const invocation = createInvocation('wrong-integrity-key-thread');
  const sourceStore = new InMemoryDurableCheckpointStore();
  const original = (
    await createMathWorkflow(sourceStore, []).invoke(invocation)
  ).checkpoint;

  await assert.rejects(
    () => createMathWorkflow(
      checkpointStore(original),
      [],
      'v1',
      'different-integrity-key-0123456789abcdef'
    ).invoke(invocation),
    /checkpoint integrity validation failed/
  );
});

test('durable kernel seam invokes the real RagKernel and checkpoints only a scoped projection', async () => {
  let kernelCalls = 0;
  const kernel = new RagKernel([createRagPolicy({
    id: 'milvus-2step',
    description: 'Hermetic durable Kernel boundary policy.',
    async execute(context) {
      kernelCalls += 1;
      return {
        output: { success: true },
        evidence: [{
          id: 'chunk-1',
          tenantId: 'tenant-a',
          corpusId: 'corpus-a',
          documentId: 'document-a',
          documentVersion: 'document-v1',
          content: 'prompt-visible content must not enter the durable checkpoint',
          trustLevel: 'reviewed',
          laneId: 'dense-main',
          retrievalScore: 0.9,
        }],
        laneExecutions: [{
          laneId: 'dense-main',
          retriever: 'hermetic-dense',
          status: 'completed',
          retrievedEvidenceIds: ['chunk-1'],
          latencyMs: 1,
          stopReason: 'sufficient',
        }],
        execution: {
          state: 'completed',
          transitions: [{
            from: 'planned',
            to: 'completed',
            at: '2026-07-15T00:00:00.000Z',
            reason: 'hermetic_kernel_contract',
          }],
          stopReason: 'sufficient',
        },
        metadata: { fixture: true, traceId: context.traceId },
      };
    },
  })]);
  const step = createDurableRagKernelStep({
    id: 'kernel-answer',
    async executeKernel({ job, identity, traceId, signal }) {
      assert.equal(signal.aborted, false);
      const result = await kernel.execute({
        question: job.question,
        topK: 1,
        similarityThreshold: 0,
        llmModel: 'hermetic-llm',
        embeddingModel: 'hermetic-embedding',
        storageBackend: 'milvus',
        retrievalScope: {
          tenantId: identity.tenantId,
          corpusId: identity.corpusId,
          allowedTrustLevels: identity.allowedTrustLevels,
          enforceIsolation: identity.enforceIsolation,
        },
      }, 'milvus-2step', {
        now: new Date('2026-07-15T00:00:00.000Z'),
        traceId,
      });
      return result.envelope;
    },
    reduceState(_state, snapshot) {
      return { kernel: structuredClone(snapshot) };
    },
  });
  const store = new InMemoryDurableCheckpointStore();
  const adapter = new DurableRagWorkflowAdapter({
    id: 'kernel-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { question: job.question }; },
    projectStateForCheckpoint(state) { return { kernel: state.kernel }; },
    createInitialState() {
      return { kernel: null };
    },
    steps: [step],
  }, store);
  const invocation = {
    ...createInvocation('kernel-thread'),
    job: { question: 'What does the canonical evidence say?' },
  };

  const first = await adapter.invoke(invocation);
  assert.equal(first.checkpoint.status, 'completed');
  assert.deepEqual(first.checkpoint.state.kernel.evidenceIds, ['chunk-1']);
  assert.deepEqual(first.checkpoint.state.kernel.laneIds, ['dense-main']);
  assert.match(first.checkpoint.state.kernel.traceId, /^rag-step-/);
  assert.equal(
    JSON.stringify(first.checkpoint).includes('prompt-visible content'),
    false
  );

  const replay = await adapter.invoke(invocation);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(kernelCalls, 1);

  const failingKernel = new RagKernel([createRagPolicy({
    id: 'milvus-2step',
    description: 'Hermetic failed Kernel policy.',
    async execute() {
      return new Response('private upstream failure', { status: 502 });
    },
  })]);
  const failedStore = new InMemoryDurableCheckpointStore();
  const failedAdapter = new DurableRagWorkflowAdapter({
    id: 'failed-kernel-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { question: job.question }; },
    projectStateForCheckpoint(state) { return { kernel: state.kernel }; },
    createInitialState() {
      return { kernel: null };
    },
    steps: [createDurableRagKernelStep({
      id: 'kernel-answer',
      async executeKernel({ job, identity, traceId }) {
        return (
          await failingKernel.execute({
            question: job.question,
            topK: 1,
            similarityThreshold: 0,
            llmModel: 'hermetic-llm',
            embeddingModel: 'hermetic-embedding',
            storageBackend: 'milvus',
            retrievalScope: {
              tenantId: identity.tenantId,
              corpusId: identity.corpusId,
              allowedTrustLevels: identity.allowedTrustLevels,
              enforceIsolation: identity.enforceIsolation,
            },
          }, 'milvus-2step', { traceId })
        ).envelope;
      },
      reduceState(_state, snapshot) {
        return { kernel: structuredClone(snapshot) };
      },
    })],
  }, failedStore);
  const failedInvocation = {
    ...createInvocation('failed-kernel-thread'),
    job: { question: 'fail safely' },
  };
  await assert.rejects(
    () => failedAdapter.invoke(failedInvocation),
    error => error instanceof DurableWorkflowStepError
  );
  const failedCheckpoint = await failedStore.load(
    buildDurableCheckpointKey(
      'failed-kernel-workflow',
      'failed-kernel-thread',
      'tenant-a'
    )
  );
  assert.equal(failedCheckpoint.status, 'paused');
  assert.equal(JSON.stringify(failedCheckpoint).includes('private upstream failure'), false);
});

test('active leases prevent concurrent execution of the same thread', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let enterStep;
  let releaseStep;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const adapter = new DurableRagWorkflowAdapter({
    id: 'lease-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() {
      return { done: false };
    },
    steps: [{
      id: 'wait',
      async execute() {
        enterStep();
        await release;
        return { done: true };
      },
    }],
  }, store, {
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    leaseDurationMs: 60_000,
  });
  const invocation = {
    ...createInvocation('lease-thread'),
    job: { amount: 1 },
  };
  const first = adapter.invoke(invocation);
  await entered;
  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowBusyError
  );
  releaseStep();
  const result = await first;
  assert.equal(result.checkpoint.status, 'completed');
});

test('pre-aborted contender cannot cancel another invocation active lease', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let enterStep;
  let releaseStep;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const adapter = new DurableRagWorkflowAdapter({
    id: 'pre-aborted-contender-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() {
      return { done: false };
    },
    steps: [{
      id: 'wait',
      async execute() {
        enterStep();
        await release;
        return { done: true };
      },
    }],
  }, store, {
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    leaseDurationMs: 60_000,
  });
  const invocation = {
    ...createInvocation('pre-aborted-contender-thread'),
    job: { amount: 1 },
  };
  const first = adapter.invoke(invocation);
  await entered;

  const checkpointKey = buildDurableCheckpointKey(
    'pre-aborted-contender-workflow',
    'pre-aborted-contender-thread',
    'tenant-a'
  );
  const beforeContender = await store.load(checkpointKey);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => adapter.invoke({ ...invocation, signal: controller.signal }),
    error => error instanceof DurableWorkflowBusyError
  );
  const afterContender = await store.load(checkpointKey);
  assert.equal(afterContender.status, 'running');
  assert.deepEqual(afterContender.activeStep, beforeContender.activeStep);
  assert.equal(afterContender.revision, beforeContender.revision);

  releaseStep();
  const result = await first;
  assert.equal(result.checkpoint.status, 'completed');
  assert.equal(result.checkpoint.completedStepIds.length, 1);
});

test('expired running leases do not auto-take over or duplicate side effects', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  let releaseStep;
  let enterStep;
  let calls = 0;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const adapter = new DurableRagWorkflowAdapter({
    id: 'expired-lease-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'external-side-effect',
      async execute() {
        calls += 1;
        enterStep();
        await release;
        return { done: true };
      },
    }],
  }, store, {
    now: () => new Date(now),
    leaseDurationMs: 1,
  });
  const invocation = { ...createInvocation('expired-lease-thread'), job: { amount: 1 } };
  const first = adapter.invoke(invocation);
  await entered;
  now += 10_000;
  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowBusyError
  );
  assert.equal(calls, 1);
  releaseStep();
  assert.equal((await first).checkpoint.status, 'completed');
});

test('long-running steps can renew their fenced lease before it expires', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  let enterStep;
  let allowRenewal;
  let reportRenewal;
  let releaseStep;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const renewalGate = new Promise(resolve => { allowRenewal = resolve; });
  const renewed = new Promise(resolve => { reportRenewal = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const adapter = new DurableRagWorkflowAdapter({
    id: 'renewal-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'heartbeat-step',
      async execute(context) {
        enterStep();
        await renewalGate;
        reportRenewal(await context.renewLease());
        await release;
        return { done: true };
      },
    }],
  }, store, {
    now: () => new Date(now),
    leaseDurationMs: 10,
    allowExpiredLeaseTakeover: true,
  });
  const invocation = {
    ...createInvocation('renewal-thread'),
    job: { amount: 1 },
  };
  const first = adapter.invoke(invocation);
  await entered;
  now += 8;
  allowRenewal();
  const renewal = await renewed;
  assert.equal(
    renewal.leaseExpiresAt,
    new Date(Date.parse('2026-07-15T00:00:00.000Z') + 18).toISOString()
  );
  assert.equal(renewal.revision, 2);

  now += 4;
  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowBusyError
  );
  releaseStep();
  const result = await first;
  assert.equal(result.checkpoint.status, 'completed');
  assert.equal(result.checkpoint.revision, 3);
});

test('explicit management recovery releases only an expired fenced lease', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  let firstEntered;
  let releaseFirst;
  let calls = 0;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const release = new Promise(resolve => { releaseFirst = resolve; });
  const executionIds = [];
  const adapter = new DurableRagWorkflowAdapter({
    id: 'managed-recovery-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'idempotent-managed-step',
      async execute(context) {
        calls += 1;
        executionIds.push(context.stepExecutionId);
        if (calls === 1) {
          firstEntered();
          await release;
        }
        return { done: true };
      },
    }],
  }, store, {
    now: () => new Date(now),
    leaseDurationMs: 1,
  });
  const invocation = {
    ...createInvocation('managed-recovery-thread'),
    job: { amount: 1 },
  };
  const firstOutcome = adapter.invoke(invocation).catch(error => error);
  await entered;
  const checkpointKey = buildDurableCheckpointKey(
    'managed-recovery-workflow',
    'managed-recovery-thread',
    'tenant-a'
  );
  const running = await store.load(checkpointKey);
  await assert.rejects(
    () => adapter.releaseExpiredLeaseForRecovery(invocation, {
      expectedRevision: running.revision,
      leaseOwnerId: running.activeStep.leaseOwnerId,
    }),
    error => error instanceof DurableWorkflowLeaseManagementError
  );

  now += 10_000;
  await assert.rejects(
    () => adapter.invoke(invocation),
    error => error instanceof DurableWorkflowBusyError
  );
  await assert.rejects(
    () => adapter.releaseExpiredLeaseForRecovery(invocation, {
      expectedRevision: running.revision + 1,
      leaseOwnerId: running.activeStep.leaseOwnerId,
    }),
    error => error instanceof DurableWorkflowConflictError
  );
  const recovered = await adapter.releaseExpiredLeaseForRecovery(invocation, {
    expectedRevision: running.revision,
    leaseOwnerId: running.activeStep.leaseOwnerId,
  });
  assert.equal(recovered.deliveryGuarantee, 'at_least_once');
  assert.equal(recovered.checkpoint.status, 'paused');
  assert.equal(recovered.checkpoint.lastFailureCode, 'EXPIRED_LEASE_RELEASED');
  assert.equal(recovered.stepExecutionId, executionIds[0]);

  const resumed = await adapter.invoke(invocation);
  assert.equal(resumed.checkpoint.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(executionIds[0], executionIds[1]);
  releaseFirst();
  assert.ok(await firstOutcome instanceof DurableWorkflowConflictError);
});

test('explicit expired-lease takeover is at-least-once with a stable execution ID', async () => {
  const store = new InMemoryDurableCheckpointStore();
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  let firstEntered;
  let releaseFirst;
  let calls = 0;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const release = new Promise(resolve => { releaseFirst = resolve; });
  const executionIds = [];
  const adapter = new DurableRagWorkflowAdapter({
    id: 'takeover-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'idempotent-external-step',
      async execute(context) {
        calls += 1;
        executionIds.push(context.stepExecutionId);
        if (calls === 1) {
          firstEntered();
          await release;
        }
        return { done: true };
      },
    }],
  }, store, {
    now: () => new Date(now),
    leaseDurationMs: 1,
    allowExpiredLeaseTakeover: true,
  });
  const invocation = { ...createInvocation('takeover-thread'), job: { amount: 1 } };
  const first = adapter.invoke(invocation);
  await entered;
  now += 10_000;
  const recovered = await adapter.invoke(invocation);
  assert.equal(recovered.checkpoint.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(executionIds[0], executionIds[1]);
  releaseFirst();
  await assert.rejects(first, /checkpoint revision conflict/i);
});

function createMathWorkflow(
  store,
  calls,
  version = 'v1',
  integrityKey = TEST_INTEGRITY_KEY
) {
  return new DurableRagWorkflowAdapter({
    id: 'math-workflow',
    version,
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { value: state.value }; },
    createInitialState() {
      return { value: 1 };
    },
    steps: [
      {
        id: 'add',
        async execute(context) {
          calls.push({ step: 'add', executionId: context.stepExecutionId });
          return { value: context.state.value + context.job.amount };
        },
      },
      {
        id: 'double',
        async execute(context) {
          calls.push({ step: 'double', executionId: context.stepExecutionId });
          return { value: context.state.value * 2 };
        },
      },
    ],
  }, store, {
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    integrityKey,
  });
}

function checkpointStore(checkpoint) {
  return {
    providerId: 'tampered-checkpoint-store',
    processPersistent: true,
    async load(checkpointKey) {
      assert.equal(checkpointKey, checkpoint.checkpointKey);
      return structuredClone(checkpoint);
    },
    async save() {
      throw new Error('Corrupted checkpoint must fail before any save.');
    },
  };
}

function createInvocation(threadId) {
  return {
    threadId,
    idempotencyKey: 'job-' + threadId.replace(/[^A-Za-z0-9]/g, '-'),
    scope,
    documentId: 'document-a',
    documentVersion: 'document-v1',
    job: { amount: 3 },
  };
}

function mismatch(error, code) {
  return (
    error instanceof DurableWorkflowResumeMismatchError
    && error.code === code
  );
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
