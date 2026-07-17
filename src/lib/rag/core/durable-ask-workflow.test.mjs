import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const {
  DurableAskResultUnavailableError,
  cancelDurableAsk,
  deleteDurableAsk,
  createDurableAskDigests,
  createDurableAskThreadId,
  inspectDurableAsk,
  invokeDurableAsk,
  projectDurableAskCheckpoint,
  readDurableAskResult,
  recoverDurableAsk,
  resolveDurableAskLeaseDurationMs,
} = await import('./durable-ask-workflow.ts');
const {
  InMemoryDurableAskResultArtifactStore,
} = await import('./durable-result-artifact-store.ts');
const {
  DurableWorkflowCancelledError,
  DurableWorkflowConflictError,
  InMemoryDurableCheckpointStore,
} = await import('./durable-workflow.ts');
const {
  createRetrievalScope,
} = await import('../../security/retrieval-scope.ts');

const INTEGRITY_KEY = 'durable-ask-test-integrity-key-0123456789abcdef';
test('durable ask lease duration rejects values below the heartbeat floor', () => {
  assert.equal(resolveDurableAskLeaseDurationMs({}), 30_000);
  assert.equal(resolveDurableAskLeaseDurationMs({
    RAG_DURABLE_WORKFLOW_LEASE_MS: '300',
  }), 300);
  assert.throws(
    () => resolveDurableAskLeaseDurationMs({
      RAG_DURABLE_WORKFLOW_LEASE_MS: '299',
    }),
    /outside its hard limit/
  );
});

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  enforceIsolation: true,
});

test('durable ask derives stable server identity and HMAC-only checkpoint projections', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new InMemoryDurableAskResultArtifactStore();
  const identity = durableIdentity('ask-idempotency-0001', 'private query text');
  let executions = 0;

  const first = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute({ stepExecutionId }) {
      executions += 1;
      return storedResult(stepExecutionId, 'private answer text');
    },
  });
  assert.equal(first.workflow.checkpoint.status, 'completed');
  assert.equal(first.workflow.idempotentReplay, false);
  assert.equal(first.artifact.result.body.answer, 'private answer text');
  assert.equal(executions, 1);

  const checkpointText = JSON.stringify(first.workflow.checkpoint);
  assert.doesNotMatch(checkpointText, /private query text/);
  assert.doesNotMatch(checkpointText, /private answer text/);
  assert.deepEqual(Object.keys(first.workflow.checkpoint.job).sort(), [
    'queryDigest',
    'requestDigest',
    'routingDigest',
  ]);
  assert.match(first.workflow.checkpoint.job.queryDigest, /^hmac-sha256:/);
  assert.match(first.workflow.checkpoint.state.resultArtifactId, /^sha256:/);

  const replay = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute() {
      executions += 1;
      throw new Error('completed replay must not execute');
    },
  });
  assert.equal(replay.workflow.idempotentReplay, true);
  assert.equal(replay.artifact.artifactId, first.artifact.artifactId);
  assert.equal(executions, 1);

  const publicCheckpoint = projectDurableAskCheckpoint(
    replay.workflow.checkpoint
  );
  assert.equal(publicCheckpoint.resultAvailable, true);
  assert.equal(
    publicCheckpoint.generationId,
    replay.workflow.checkpoint.generationId
  );
  assert.equal('leaseOwnerId' in publicCheckpoint, false);
  assert.equal(publicCheckpoint.deliveryGuarantee, 'at_least_once');
});

test('durable ask identity separates actor and corpus and rejects unavailable results', async () => {
  const base = createDurableAskThreadId({
    integrityKey: INTEGRITY_KEY,
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    actorId: 'actor-a',
    idempotencyKey: 'ask-idempotency-0002',
  });
  assert.notEqual(base, createDurableAskThreadId({
    integrityKey: INTEGRITY_KEY,
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    actorId: 'actor-b',
    idempotencyKey: 'ask-idempotency-0002',
  }));
  assert.notEqual(base, createDurableAskThreadId({
    integrityKey: INTEGRITY_KEY,
    tenantId: 'tenant-a',
    corpusId: 'corpus-b',
    actorId: 'actor-a',
    idempotencyKey: 'ask-idempotency-0002',
  }));

  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new InMemoryDurableAskResultArtifactStore();
  const completed = await invokeDurableAsk({
    identity: durableIdentity('ask-idempotency-0002', 'scoped query'),
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'scoped answer');
    },
  });

  await assert.rejects(
    () => readDurableAskResult({
      checkpoint: completed.workflow.checkpoint,
      resultStore,
      scope: { ...scope, corpusId: 'corpus-foreign' },
    }),
    /scope/i
  );
  await assert.rejects(
    () => readDurableAskResult({
      checkpoint: completed.workflow.checkpoint,
      resultStore: {
        providerId: 'missing-result-store',
        coordination: 'process',
        maxResultBytes: 1024,
        async put() {
          throw new Error('not used');
        },
        async get() {
          return null;
        },
      },
      scope,
    }),
    error => error instanceof DurableAskResultUnavailableError
  );
});

test('durable ask management cancellation fences late result publication', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new TrackingResultStore();
  const identity = durableIdentity('ask-idempotency-0003', 'cancel query');
  let enteredStep;
  let releaseStep;
  const entered = new Promise(resolve => { enteredStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });

  const active = invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute({ stepExecutionId }) {
      enteredStep();
      await release;
      return storedResult(stepExecutionId, 'late answer');
    },
  }).catch(error => error);
  await entered;

  const running = await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(running.status, 'running');
  const cancelled = await cancelDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: running.revision,
    expectedGenerationId: running.generationId,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(cancelled.status, 'cancelled');

  releaseStep();
  assert.ok(await active instanceof DurableWorkflowConflictError);
  assert.equal(resultStore.publishedArtifacts.length, 0);
  assert.equal(resultStore.deletedArtifactIds.length, 0);
  await assert.rejects(
    () => invokeDurableAsk({
      identity,
      checkpointStore,
      resultStore,
      integrityKey: INTEGRITY_KEY,
      async execute() {
        throw new Error('cancelled work must not replay');
      },
    }),
    error => error instanceof DurableWorkflowCancelledError
  );
});

test('durable ask heartbeat keeps a healthy long-running lease current', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new InMemoryDurableAskResultArtifactStore();
  const identity = durableIdentity('ask-idempotency-heartbeat', 'heartbeat query');
  let enteredStep;
  let releaseStep;
  const entered = new Promise(resolve => { enteredStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });

  const active = invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: {
      leaseDurationMs: 300,
    },
    async execute({ stepExecutionId }) {
      enteredStep();
      await release;
      return storedResult(stepExecutionId, 'heartbeat answer');
    },
  });
  await entered;
  await new Promise(resolve => setTimeout(resolve, 350));

  const running = await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(running.status, 'running');
  assert.ok(running.revision >= 4);
  assert.ok(Date.parse(running.activeStep.leaseExpiresAt) > Date.now());

  releaseStep();
  const completed = await active;
  assert.equal(completed.workflow.checkpoint.status, 'completed');
  assert.equal(completed.artifact.result.body.answer, 'heartbeat answer');
});

test('heartbeat covers a result publication blocked beyond one lease', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new BlockingAfterPublishResultStore();
  const identity = durableIdentity(
    'ask-idempotency-blocked-publication',
    'blocked publication query'
  );

  const active = invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: { leaseDurationMs: 300 },
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'blocked publication answer');
    },
  });
  await resultStore.publishObserved;
  await new Promise(resolve => setTimeout(resolve, 650));

  const running = await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(running.status, 'running');
  assert.ok(Date.parse(running.activeStep.leaseExpiresAt) > Date.now());
  await assert.rejects(
    () => recoverDurableAsk({
      threadId: identity.threadId,
      scope,
      expectedRevision: running.revision,
      expectedGenerationId: running.generationId,
      checkpointStore,
      resultStore,
      integrityKey: INTEGRITY_KEY,
    }),
    /live durable workflow lease/i
  );

  resultStore.releasePublication();
  const completed = await active;
  assert.equal(completed.workflow.checkpoint.status, 'completed');
  assert.equal(resultStore.publishedArtifacts.length, 1);
  assert.equal(
    completed.workflow.checkpoint.state.resultArtifactId,
    resultStore.publishedArtifacts[0].artifactId
  );
  assert.equal(resultStore.deletedArtifactIds.length, 0);
  assert.ok(await resultStore.get(
    completed.artifact.identity,
    completed.artifact.artifactId,
    scope
  ));
});

test('request abort cleans an artifact published by late non-cooperative work', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new BlockingAfterPublishResultStore();
  const identity = durableIdentity('ask-idempotency-late-abort', 'late abort query');
  const controller = new AbortController();

  const active = invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    signal: controller.signal,
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'late abort answer');
    },
  }).catch(error => error);

  await resultStore.publishObserved;
  controller.abort(new Error('request disconnected'));
  assert.ok(await active instanceof DurableWorkflowCancelledError);
  resultStore.releasePublication();

  for (
    let attempt = 0;
    attempt < 100 && resultStore.deletedArtifactIds.length === 0;
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(resultStore.publishedArtifacts.length, 1);
  assert.deepEqual(resultStore.deletedArtifactIds, [
    resultStore.publishedArtifacts[0].artifactId,
  ]);
  assert.equal(await resultStore.get(
    resultStore.publishedArtifacts[0].identity,
    resultStore.publishedArtifacts[0].artifactId,
    scope
  ), null);
});
test('durable ask recovers an expired lease without persisting the original query', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new TrackingResultStore();
  const identity = durableIdentity('ask-idempotency-0004', 'restart query');
  let enteredStep;
  let releaseStep;
  const entered = new Promise(resolve => { enteredStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  const executionIds = [];

  const stale = invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: {
      leaseDurationMs: 300,
      now: () => new Date(Date.now() - 60_000),
    },
    async execute({ stepExecutionId }) {
      executionIds.push(stepExecutionId);
      enteredStep();
      await release;
      return storedResult(stepExecutionId, 'stale answer');
    },
  }).catch(error => error);
  await entered;

  const running = await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  const recovered = await recoverDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: running.revision,
    expectedGenerationId: running.generationId,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(recovered.checkpoint.status, 'paused');
  assert.equal(recovered.deliveryGuarantee, 'at_least_once');

  const resumed = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute({ stepExecutionId }) {
      executionIds.push(stepExecutionId);
      return storedResult(stepExecutionId, 'resumed answer');
    },
  });
  assert.equal(resumed.artifact.result.body.answer, 'resumed answer');
  assert.equal(executionIds[0], executionIds[1]);

  releaseStep();
  const staleError = await stale;
  assert.ok(
    staleError instanceof DurableWorkflowConflictError
    || staleError?.code === 'DURABLE_WORKFLOW_STEP_FAILED'
  );
  const winnerArtifactId = resumed.artifact.artifactId;
  assert.equal(resultStore.publishedArtifacts.length, 1);
  assert.equal(resultStore.publishedArtifacts[0].artifactId, winnerArtifactId);
  assert.ok(await resultStore.get(
    resumed.artifact.identity,
    winnerArtifactId,
    scope
  ));
  assert.equal(resultStore.deletedArtifactIds.length, 0);
});

test('terminal delete fences revision and removes the exact result artifact', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new TrackingResultStore();
  const identity = durableIdentity('ask-idempotency-delete', 'delete query');
  const completed = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'delete answer');
    },
  });

  await assert.rejects(
    () => deleteDurableAsk({
      threadId: identity.threadId,
      scope,
      expectedRevision: completed.workflow.checkpoint.revision + 1,
      expectedGenerationId: completed.workflow.checkpoint.generationId,
      checkpointStore,
      resultStore,
      integrityKey: INTEGRITY_KEY,
    }),
    error => error instanceof DurableWorkflowConflictError
  );
  const deleted = await deleteDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: completed.workflow.checkpoint.revision,
    expectedGenerationId: completed.workflow.checkpoint.generationId,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(deleted.previousCheckpoint.status, 'completed');
  assert.equal(deleted.checkpointDeleted, true);
  assert.equal(deleted.cleanupResumed, false);
  assert.equal(deleted.resultDeleted, true);
  assert.equal(deleted.resultDeletedCount, 1);
  assert.equal(await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  }), null);
  assert.equal(await resultStore.get(
    completed.artifact.identity,
    completed.artifact.artifactId,
    scope
  ), null);
});

test('terminal delete resumes exact result cleanup after a post-tombstone failure', async () => {
  const checkpointStore = new InMemoryDurableCheckpointStore();
  const resultStore = new FailOnceDeleteAllResultStore();
  const identity = durableIdentity(
    'ask-idempotency-delete-retry',
    'delete retry query'
  );
  const completed = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'delete retry answer');
    },
  });
  const expectedRevision = completed.workflow.checkpoint.revision;

  await assert.rejects(
    () => deleteDurableAsk({
      threadId: identity.threadId,
      scope,
      expectedRevision,
      expectedGenerationId: completed.workflow.checkpoint.generationId,
      checkpointStore,
      resultStore,
      integrityKey: INTEGRITY_KEY,
    }),
    /injected result cleanup failure/
  );
  assert.equal(await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  }), null);
  assert.ok(await resultStore.get(
    completed.artifact.identity,
    completed.artifact.artifactId,
    scope
  ));

  const resumed = await deleteDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision,
    expectedGenerationId: completed.workflow.checkpoint.generationId,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(resumed.previousCheckpoint, undefined);
  assert.equal(resumed.checkpointDeleted, false);
  assert.equal(resumed.cleanupResumed, true);
  assert.equal(resumed.resultDeleted, true);
  assert.equal(resumed.resultDeletedCount, 1);
  assert.equal(await resultStore.get(
    completed.artifact.identity,
    completed.artifact.artifactId,
    scope
  ), null);
  await assert.rejects(
    () => deleteDurableAsk({
      threadId: identity.threadId,
      scope,
      expectedRevision: expectedRevision + 1,
      expectedGenerationId: completed.workflow.checkpoint.generationId,
      checkpointStore,
      resultStore,
      integrityKey: INTEGRITY_KEY,
    }),
    error => error instanceof DurableWorkflowConflictError
  );
});

test('generation A cleanup resumes after generation B starts without touching B', async () => {
  let now = Date.parse('2026-07-17T00:00:00.000Z');
  const checkpointStore = new InMemoryDurableCheckpointStore(
    'generation-checkpoint-store',
    1_048_576,
    1000,
    {
      terminalRetentionMs: 1000,
      now: () => new Date(now),
    }
  );
  const resultStore = new FailOnceGenerationDeleteAllResultStore(
    'generation-ask-a'
  );
  const identity = durableIdentity(
    'ask-idempotency-generation-reuse',
    'generation reuse query'
  );
  const generationA = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: {
      generationIdFactory: () => 'generation-ask-a',
      now: () => new Date(now),
    },
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'generation A answer');
    },
  });
  const revisionA = generationA.workflow.checkpoint.revision;
  await assert.rejects(
    deleteDurableAsk({
      threadId: identity.threadId,
      scope,
      expectedRevision: revisionA,
      expectedGenerationId: 'generation-ask-a',
      checkpointStore,
      resultStore,
      integrityKey: INTEGRITY_KEY,
    }),
    /injected generation A cleanup failure/
  );
  assert.ok(await resultStore.get(
    generationA.artifact.identity,
    generationA.artifact.artifactId,
    scope
  ));

  now += 1001;
  const generationB = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: {
      generationIdFactory: () => 'generation-ask-b',
      now: () => new Date(now),
    },
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'generation B answer');
    },
  });
  assert.notEqual(
    generationA.artifact.artifactId,
    generationB.artifact.artifactId
  );
  const resumedA = await deleteDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: revisionA,
    expectedGenerationId: 'generation-ask-a',
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(resumedA.previousCheckpoint, undefined);
  assert.equal(resumedA.checkpointDeleted, false);
  assert.equal(resumedA.cleanupResumed, true);
  assert.equal(resumedA.resultDeletedCount, 1);
  assert.equal(await resultStore.get(
    generationA.artifact.identity,
    generationA.artifact.artifactId,
    scope
  ), null);
  assert.ok(await resultStore.get(
    generationB.artifact.identity,
    generationB.artifact.artifactId,
    scope
  ));

  const deletedB = await deleteDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: generationB.workflow.checkpoint.revision,
    expectedGenerationId: 'generation-ask-b',
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  assert.equal(deletedB.resultDeletedCount, 1);
  assert.equal(await resultStore.get(
    generationB.artifact.identity,
    generationB.artifact.artifactId,
    scope
  ), null);
  assert.equal(await resultStore.get(
    generationA.artifact.identity,
    generationA.artifact.artifactId,
    scope
  ), null);
});

test('late generation A publication cleanup leaves completed generation B intact', async () => {
  let now = Date.parse('2026-07-17T00:00:00.000Z');
  const checkpointStore = new InMemoryDurableCheckpointStore(
    'late-generation-checkpoint-store',
    1_048_576,
    1000,
    {
      terminalRetentionMs: 1000,
      now: () => new Date(now),
    }
  );
  const resultStore = new BlockFirstAfterPublishResultStore();
  const identity = durableIdentity(
    'ask-idempotency-late-generation',
    'late generation query'
  );
  const activeA = invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: {
      generationIdFactory: () => 'generation-late-a',
      now: () => new Date(now),
    },
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'late generation A answer');
    },
  }).catch(error => error);
  await resultStore.firstPublicationObserved;
  const runningA = await inspectDurableAsk({
    threadId: identity.threadId,
    scope,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  const cancelledA = await cancelDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: runningA.revision,
    expectedGenerationId: runningA.generationId,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });
  await deleteDurableAsk({
    threadId: identity.threadId,
    scope,
    expectedRevision: cancelledA.revision,
    expectedGenerationId: cancelledA.generationId,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
  });

  now += 1001;
  const generationB = await invokeDurableAsk({
    identity,
    checkpointStore,
    resultStore,
    integrityKey: INTEGRITY_KEY,
    adapterOptions: {
      generationIdFactory: () => 'generation-late-b',
      now: () => new Date(now),
    },
    async execute({ stepExecutionId }) {
      return storedResult(stepExecutionId, 'generation B survives');
    },
  });
  resultStore.releaseFirstPublication();
  const staleResult = await activeA;
  assert.ok(
    staleResult instanceof DurableWorkflowConflictError
    || staleResult?.code === 'DURABLE_WORKFLOW_STEP_FAILED'
  );
  assert.ok(await resultStore.get(
    generationB.artifact.identity,
    generationB.artifact.artifactId,
    scope
  ));
  assert.equal(
    resultStore.deletedArtifactIds.includes(generationB.artifact.artifactId),
    false
  );
});

class TrackingResultStore extends InMemoryDurableAskResultArtifactStore {
  publishedArtifacts = [];
  deletedArtifactIds = [];

  async put(publication) {
    const artifact = await super.put(publication);
    this.publishedArtifacts.push(artifact);
    return artifact;
  }

  async delete(identity, artifactId, retrievalScope) {
    const deleted = await super.delete(identity, artifactId, retrievalScope);
    if (deleted) this.deletedArtifactIds.push(artifactId);
    return deleted;
  }
}

class FailOnceDeleteAllResultStore extends TrackingResultStore {
  failed = false;

  async deleteAll(identity, retrievalScope) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('injected result cleanup failure');
    }
    return super.deleteAll(identity, retrievalScope);
  }
}

class FailOnceGenerationDeleteAllResultStore extends TrackingResultStore {
  constructor(failedGenerationId) {
    super();
    this.failedGenerationId = failedGenerationId;
    this.failed = false;
  }

  async deleteAll(identity, retrievalScope) {
    if (
      identity.generationId === this.failedGenerationId
      && !this.failed
    ) {
      this.failed = true;
      throw new Error('injected generation A cleanup failure');
    }
    return super.deleteAll(identity, retrievalScope);
  }
}

class BlockFirstAfterPublishResultStore extends TrackingResultStore {
  constructor() {
    super();
    this.putCount = 0;
    this.firstPublicationObserved = new Promise(resolve => {
      this.resolveFirstPublicationObserved = resolve;
    });
    this.firstPublicationRelease = new Promise(resolve => {
      this.resolveFirstPublicationRelease = resolve;
    });
  }

  async put(publication) {
    this.putCount += 1;
    const putNumber = this.putCount;
    const artifact = await super.put(publication);
    if (putNumber === 1) {
      this.resolveFirstPublicationObserved();
      await this.firstPublicationRelease;
    }
    return artifact;
  }

  releaseFirstPublication() {
    this.resolveFirstPublicationRelease();
  }
}

class BlockingAfterPublishResultStore extends TrackingResultStore {
  constructor() {
    super();
    this.publishObserved = new Promise(resolve => {
      this.resolvePublishObserved = resolve;
    });
    this.publicationRelease = new Promise(resolve => {
      this.resolvePublicationRelease = resolve;
    });
  }

  async put(publication) {
    const artifact = await super.put(publication);
    this.resolvePublishObserved();
    await this.publicationRelease;
    return artifact;
  }

  releasePublication() {
    this.resolvePublicationRelease();
  }
}
function durableIdentity(idempotencyKey, query) {
  const digests = createDurableAskDigests({
    integrityKey: INTEGRITY_KEY,
    query,
    requestProjection: {
      question: query,
      topK: 3,
      storageBackend: 'milvus',
    },
    routingProjection: {
      policyId: 'milvus-2step',
      hybridMode: 'off',
    },
  });
  return {
    threadId: createDurableAskThreadId({
      integrityKey: INTEGRITY_KEY,
      tenantId: scope.tenantId,
      corpusId: scope.corpusId,
      actorId: 'actor-a',
      idempotencyKey,
    }),
    idempotencyKey,
    scope,
    ...digests,
  };
}

function storedResult(traceId, answer) {
  return {
    schemaVersion: 'rag-durable-ask-http-v1',
    status: 200,
    headers: {
      'x-rag-policy': 'milvus-2step',
      'x-rag-status': 'completed',
      'x-rag-trace-id': traceId,
    },
    body: {
      success: true,
      answer,
    },
  };
}
