import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  FileDurableCheckpointStore,
} = await import('./durable-file-checkpoint-store.ts');
const {
  buildDurableCheckpointKey,
  DurableRagWorkflowAdapter,
  DurableWorkflowBusyError,
  DurableWorkflowConflictError,
  DurableWorkflowLeaseManagementError,
} = await import('./durable-workflow.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

const INTEGRITY_KEY = 'e7-file-checkpoint-test-key-0123456789abcdef';
const TEST_GENERATION_ID = 'generation-file-checkpoint-a';
const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['reviewed', 'trusted'],
  enforceIsolation: true,
});

test('file checkpoint revisions are immutable, idempotent, and restart-persistent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-'));
  try {
    const key = buildDurableCheckpointKey('manual-workflow', 'thread-a', 'tenant-a');
    const firstStore = new FileDurableCheckpointStore(directory);
    const secondStore = new FileDurableCheckpointStore(directory);
    assert.equal(firstStore.coordination, 'process');
    assert.equal(firstStore.processPersistent, true);

    const revision0 = createCheckpoint(key, 0, 'pending');
    await firstStore.save(revision0, { expectedRevision: null, expectedGenerationId: null });
    await secondStore.save(revision0, { expectedRevision: null, expectedGenerationId: null });
    assert.deepEqual(await secondStore.load(key), revision0);

    const revision1 = createCheckpoint(key, 1, 'running', {
      activeStep: {
        stepId: 'answer',
        stepExecutionId: 'step-execution-a',
        leaseOwnerId: 'owner-a',
        leaseExpiresAt: '2026-07-17T01:00:00.000Z',
      },
    });
    await firstStore.save(revision1, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    await secondStore.save(revision1, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    assert.deepEqual(
      await new FileDurableCheckpointStore(directory).load(key),
      revision1
    );

    await assert.rejects(
      secondStore.save(
        { ...revision1, updatedAt: '2026-07-17T00:00:01.000Z' },
        { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID}
      ),
      error => error instanceof DurableWorkflowConflictError
    );
    await assert.rejects(
      secondStore.save(createCheckpoint(key, 2, 'paused'), {
        expectedRevision: 0, expectedGenerationId: TEST_GENERATION_ID,
      }),
      error => error instanceof DurableWorkflowConflictError
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file checkpoint CAS preserves active lease exclusion across store instances', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-lease-'));
  let releaseStep;
  t.after(async () => {
    releaseStep?.();
    await rm(directory, { recursive: true, force: true });
  });
  let enterStep;
  const entered = new Promise(resolve => { enterStep = resolve; });
  const release = new Promise(resolve => { releaseStep = resolve; });
  let calls = 0;
  const definition = {
    id: 'file-lease-workflow',
    version: 'v1',
    projectJobForCheckpoint(job) { return { amount: job.amount }; },
    projectStateForCheckpoint(state) { return { done: state.done }; },
    createInitialState() { return { done: false }; },
    steps: [{
      id: 'answer',
      async execute() {
        calls += 1;
        enterStep();
        await release;
        return { done: true };
      },
    }],
  };
  const invocation = {
    threadId: 'lease-thread',
    idempotencyKey: 'lease-request',
    scope,
    documentId: 'document-a',
    documentVersion: 'document-v1',
    job: { amount: 1 },
  };
  const first = new DurableRagWorkflowAdapter(
    definition,
    new FileDurableCheckpointStore(directory),
    { integrityKey: INTEGRITY_KEY, leaseDurationMs: 60_000 }
  ).invoke(invocation);
  await entered;

  await assert.rejects(
    new DurableRagWorkflowAdapter(
      definition,
      new FileDurableCheckpointStore(directory),
      { integrityKey: INTEGRITY_KEY, leaseDurationMs: 60_000 }
    ).invoke(invocation),
    error => error instanceof DurableWorkflowBusyError
  );
  assert.equal(calls, 1);
  releaseStep();
  const completed = await first;
  assert.equal(completed.checkpoint.status, 'completed');

  const replay = await new DurableRagWorkflowAdapter(
    definition,
    new FileDurableCheckpointStore(directory),
    { integrityKey: INTEGRITY_KEY }
  ).invoke(invocation);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(calls, 1);
});

test('terminal deletion is revision-fenced, persisted, and prevents resurrection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-delete-'));
  try {
    const key = buildDurableCheckpointKey('manual-workflow', 'thread-a', 'tenant-a');
    const store = new FileDurableCheckpointStore(directory, {
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    });
    const pending = createCheckpoint(key, 0, 'pending');
    await store.save(pending, { expectedRevision: null, expectedGenerationId: null });
    await assert.rejects(
      store.delete(key, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID}),
      error => error instanceof DurableWorkflowLeaseManagementError
    );

    const completed = createCheckpoint(key, 1, 'completed', {
      nextStepIndex: 1,
      completedStepIds: ['answer'],
    });
    await store.save(completed, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    await assert.rejects(
      store.delete(key, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID}),
      error => error instanceof DurableWorkflowConflictError
    );
    assert.equal(await store.delete(key, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}), true);
    const retainedFiles = await findFiles(directory);
    assert.equal(
      retainedFiles.filter(file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file)).length,
      0
    );
    assert.equal(
      retainedFiles.filter(file => (
        file.includes(path.sep + 'tombstones' + path.sep)
        && /[a-f0-9]{64}\.json$/.test(file)
      )).length,
      1
    );
    assert.equal(await new FileDurableCheckpointStore(directory).load(key), null);
    assert.equal(
      await store.hasDeletionTombstone(key, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}),
      true
    );
    await assert.rejects(
      store.hasDeletionTombstone(key, { expectedRevision: 2 , expectedGenerationId: TEST_GENERATION_ID}),
      error => error instanceof DurableWorkflowConflictError
    );
    assert.equal(await store.delete(key, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}), false);
    await assert.rejects(
      store.save(completed, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID}),
      error => error instanceof DurableWorkflowConflictError
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file checkpoint load fails closed on revision content tampering', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-tamper-'));
  try {
    const key = buildDurableCheckpointKey('manual-workflow', 'thread-a', 'tenant-a');
    const store = new FileDurableCheckpointStore(directory);
    await store.save(createCheckpoint(key, 0, 'pending'), {
      expectedRevision: null, expectedGenerationId: null,
    });
    const revisionFile = (await findFiles(directory))
      .find(file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file));
    const envelope = JSON.parse(await readFile(revisionFile, 'utf8'));
    envelope.checkpoint.state = { done: true };
    await writeFile(revisionFile, JSON.stringify(envelope));

    await assert.rejects(
      new FileDurableCheckpointStore(directory).load(key),
      error => error?.code === 'DURABLE_CHECKPOINT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy checkpoint envelopes without a generation fail closed', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-legacy-generation-')
  );
  try {
    const key = buildDurableCheckpointKey(
      'manual-workflow',
      'thread-a',
      'tenant-a'
    );
    const store = new FileDurableCheckpointStore(directory);
    await store.save(createCheckpoint(key, 0, 'pending'), {
      expectedRevision: null,
      expectedGenerationId: null,
    });
    const revisionFile = (await findFiles(directory))
      .find(file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file));
    const envelope = JSON.parse(await readFile(revisionFile, 'utf8'));
    envelope.schemaVersion = 'rag-durable-file-checkpoint-v1';
    delete envelope.generationId;
    envelope.checkpoint.schemaVersion = 'rag-durable-checkpoint-v2';
    delete envelope.checkpoint.generationId;
    await writeFile(revisionFile, JSON.stringify(envelope));

    await assert.rejects(
      new FileDurableCheckpointStore(directory).load(key),
      error => error?.code === 'DURABLE_CHECKPOINT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('latest pointer migrates legacy history and bounds high-churn revisions across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-churn-'));
  const options = {
    maxRevisionFiles: 64,
    maxRetainedRevisionFiles: 3,
  };
  try {
    const key = buildDurableCheckpointKey('manual-workflow', 'thread-a', 'tenant-a');
    let store = new FileDurableCheckpointStore(directory, options);
    let latest = createCheckpoint(key, 0, 'pending');
    await store.save(latest, { expectedRevision: null, expectedGenerationId: null });
    for (let revision = 1; revision <= 2; revision += 1) {
      latest = createCheckpoint(key, revision, 'paused');
      await store.save(latest, { expectedRevision: revision - 1 , expectedGenerationId: TEST_GENERATION_ID});
    }

    const originalPointer = (await findFiles(directory))
      .find(file => file.endsWith(path.sep + 'latest.json'));
    await unlink(originalPointer);
    store = new FileDurableCheckpointStore(directory, options);
    assert.deepEqual(await store.load(key), latest);
    assert.ok(
      (await findFiles(directory)).some(file => file.endsWith(path.sep + 'latest.json'))
    );

    for (let revision = 3; revision <= 50; revision += 1) {
      latest = createCheckpoint(key, revision, 'paused');
      await store.save(latest, { expectedRevision: revision - 1 , expectedGenerationId: TEST_GENERATION_ID});
    }

    const restarted = new FileDurableCheckpointStore(directory, options);
    assert.deepEqual(await restarted.load(key), latest);
    const files = await findFiles(directory);
    const revisionFiles = files
      .filter(file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file))
      .sort();
    assert.deepEqual(
      revisionFiles.map(file => path.basename(file)),
      [
        '0000000000000048.json',
        '0000000000000049.json',
        '0000000000000050.json',
      ]
    );
    const pointer = JSON.parse(
      await readFile(files.find(file => file.endsWith(path.sep + 'latest.json')), 'utf8')
    );
    assert.equal(pointer.revision, 50);

    await unlink(revisionFiles.at(-1));
    await assert.rejects(
      restarted.load(key),
      error => error?.code === 'DURABLE_CHECKPOINT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root thread capacity serializes concurrent creation and persists across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-capacity-'));
  try {
    const stores = [
      new FileDurableCheckpointStore(directory, { maxThreads: 1 }),
      new FileDurableCheckpointStore(directory, { maxThreads: 1 }),
    ];
    assert.equal(stores[0].maxThreads, 1);
    const checkpoints = [
      createThreadCheckpoint('capacity-thread-a'),
      createThreadCheckpoint('capacity-thread-b'),
    ];
    const settled = await Promise.allSettled(checkpoints.map((checkpoint, index) => (
      stores[index].save(checkpoint, { expectedRevision: null, expectedGenerationId: null })
    )));
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
    const rejected = settled.find(result => result.status === 'rejected');
    assert.match(String(rejected.reason?.message), /capacity exceeded/i);

    const winnerIndex = settled.findIndex(result => result.status === 'fulfilled');
    const restarted = new FileDurableCheckpointStore(directory, { maxThreads: 1 });
    assert.deepEqual(
      await restarted.load(checkpoints[winnerIndex].checkpointKey),
      checkpoints[winnerIndex]
    );
    await assert.rejects(
      restarted.save(createThreadCheckpoint('capacity-thread-c'), {
        expectedRevision: null, expectedGenerationId: null,
      }),
      /capacity exceeded/i
    );
    const winner = checkpoints[winnerIndex];
    const completed = {
      ...winner,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    };
    await restarted.save(completed, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    assert.equal(
      await restarted.delete(winner.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}),
      true
    );
    const replacement = createThreadCheckpoint('capacity-thread-c');
    const afterDelete = new FileDurableCheckpointStore(directory, { maxThreads: 1 });
    await afterDelete.save(replacement, { expectedRevision: null, expectedGenerationId: null });
    assert.deepEqual(await afterDelete.load(replacement.checkpointKey), replacement);
    const reservations = (await findFiles(directory))
      .filter(file => /[\\/]threads[\\/][a-f0-9]{64}\.json$/.test(file));
    assert.equal(reservations.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistent byte reservations enforce the root quota across restart and release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-bytes-'));
  const baseOptions = {
    maxSerializedBytes: 4096,
    maxRevisionFiles: 2,
    maxRetainedRevisionFiles: 1,
    maxThreads: 10,
    maxTombstones: 1,
  };
  try {
    const sizingStore = new FileDurableCheckpointStore(directory, baseOptions);
    const maxRootReservedBytes =
      sizingStore.reservedBytesPerThread + sizingStore.reservedTombstoneBytes;
    const options = { ...baseOptions, maxRootReservedBytes };
    const store = new FileDurableCheckpointStore(directory, options);
    const first = createThreadCheckpoint('byte-capacity-a');
    const second = createThreadCheckpoint('byte-capacity-b');

    await store.save(first, { expectedRevision: null, expectedGenerationId: null });
    await assert.rejects(
      store.save(second, { expectedRevision: null, expectedGenerationId: null }),
      error => error?.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
    );
    await assert.rejects(
      new FileDurableCheckpointStore(directory, options)
        .save(second, { expectedRevision: null, expectedGenerationId: null }),
      error => error?.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
    );

    await store.save({
      ...first,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    }, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    await store.delete(first.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID});

    const restarted = new FileDurableCheckpointStore(directory, options);
    await restarted.save(second, { expectedRevision: null, expectedGenerationId: null });
    assert.deepEqual(await restarted.load(second.checkpointKey), second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed first revisions roll back only their new capacity reservations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-rollback-'));
  try {
    const values = Array.from({ length: 20_000 }, () => '');
    const oversized = {
      ...createThreadCheckpoint('rollback-fail-a'),
      state: { values },
    };
    const compactBytes = Buffer.byteLength(JSON.stringify(oversized), 'utf8');
    const store = new FileDurableCheckpointStore(directory, {
      maxThreads: 1,
      maxSerializedBytes: compactBytes + 64,
    });

    for (const suffix of ['a', 'b', 'c']) {
      await assert.rejects(
        store.save({
          ...createThreadCheckpoint('rollback-fail-' + suffix),
          state: { values },
        }, { expectedRevision: null, expectedGenerationId: null }),
        error => error?.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
      );
    }

    const valid = createThreadCheckpoint('rollback-valid');
    await store.save(valid, { expectedRevision: null, expectedGenerationId: null });
    assert.deepEqual(await store.load(valid.checkpointKey), valid);
    const files = await findFiles(directory);
    assert.equal(
      files.filter(file => /[\\/]threads[\\/][a-f0-9]{64}\.json$/.test(file)).length,
      1
    );
    assert.equal(
      files.filter(file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file)).length,
      1
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capacity rejection removes its pending generation so the same thread can retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-pending-capacity-'));
  try {
    const store = new FileDurableCheckpointStore(directory, { maxThreads: 1 });
    const occupied = createThreadCheckpoint('pending-capacity-occupied');
    await store.save(occupied, {
      expectedRevision: null,
      expectedGenerationId: null,
    });
    const target = createThreadCheckpoint('pending-capacity-target');
    await assert.rejects(
      store.save(target, {
        expectedRevision: null,
        expectedGenerationId: null,
      }),
      error => error?.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
    );
    assert.equal(await store.load(target.checkpointKey), null);

    const completed = {
      ...occupied,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    };
    await store.save(completed, {
      expectedRevision: 0,
      expectedGenerationId: occupied.generationId,
    });
    await store.delete(occupied.checkpointKey, {
      expectedRevision: 1,
      expectedGenerationId: occupied.generationId,
    });
    await store.save(target, {
      expectedRevision: null,
      expectedGenerationId: null,
    });
    assert.deepEqual(await store.load(target.checkpointKey), target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending generation recovery handles current-only and stale-reservation hard crashes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-pending-recovery-'));
  let now = Date.parse('2026-07-17T00:00:00.000Z');
  try {
    const options = {
      orphanReservationTtlMs: 1000,
      now: () => new Date(now),
    };
    const currentOnly = createThreadCheckpoint(
      'pending-current-only',
      'generation-current-only-a'
    );
    const crashAfterCurrent = new FileDurableCheckpointStore(directory, {
      ...options,
      crashInjector(point) {
        if (point === 'after-current-claim') {
          throw new Error('simulated hard crash after current claim');
        }
      },
    });
    await assert.rejects(
      crashAfterCurrent.save(currentOnly, {
        expectedRevision: null,
        expectedGenerationId: null,
      }),
      /simulated hard crash after current claim/
    );
    const restarted = new FileDurableCheckpointStore(directory, options);
    assert.equal(await restarted.load(currentOnly.checkpointKey), null);
    const currentReplacement = createThreadCheckpoint(
      'pending-current-only',
      'generation-current-only-b'
    );
    await restarted.save(currentReplacement, {
      expectedRevision: null,
      expectedGenerationId: null,
    });

    const reserved = createThreadCheckpoint(
      'pending-stale-reservation',
      'generation-stale-reservation-a'
    );
    let crashed = false;
    const crashAfterReservation = new FileDurableCheckpointStore(directory, {
      ...options,
      crashInjector(point) {
        if (!crashed && point === 'after-thread-reservation') {
          crashed = true;
          throw new Error('simulated hard crash after reservation');
        }
      },
    });
    await assert.rejects(
      crashAfterReservation.save(reserved, {
        expectedRevision: null,
        expectedGenerationId: null,
      }),
      /simulated hard crash after reservation/
    );
    assert.equal(await restarted.load(reserved.checkpointKey), null);
    const reservedReplacement = createThreadCheckpoint(
      'pending-stale-reservation',
      'generation-stale-reservation-b'
    );
    await assert.rejects(
      restarted.save(reservedReplacement, {
        expectedRevision: null,
        expectedGenerationId: null,
      }),
      error => error instanceof DurableWorkflowConflictError
    );
    now += 1001;
    assert.equal(await restarted.load(reserved.checkpointKey), null);
    await restarted.save(reservedReplacement, {
      expectedRevision: null,
      expectedGenerationId: null,
    });
    assert.deepEqual(
      await restarted.load(reserved.checkpointKey),
      reservedReplacement
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a concurrent writer holding the thread lock is not mistaken for stale pending state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-pending-concurrent-'));
  try {
    let releaseClaim;
    let reportClaimed;
    const claimed = new Promise(resolve => {
      reportClaimed = resolve;
    });
    const release = new Promise(resolve => {
      releaseClaim = resolve;
    });
    const checkpoint = createThreadCheckpoint('pending-concurrent-writer');
    const writer = new FileDurableCheckpointStore(directory, {
      async crashInjector(point) {
        if (point === 'after-current-claim') {
          reportClaimed();
          await release;
        }
      },
    });
    const write = writer.save(checkpoint, {
      expectedRevision: null,
      expectedGenerationId: null,
    });
    await claimed;
    let readSettled = false;
    const read = new FileDurableCheckpointStore(directory)
      .load(checkpoint.checkpointKey)
      .then(value => {
        readSettled = true;
        return value;
      });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(readSettled, false);
    releaseClaim();
    await write;
    assert.deepEqual(await read, checkpoint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup acknowledgement crash recovery repairs its ledger and eventually prunes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-ack-recovery-'));
  try {
    for (const [index, crashPoint] of [
      'after-tombstone-cleanup-ack-publish',
      'after-tombstone-cleanup-ack-ledger',
    ].entries()) {
      const caseDirectory = path.join(directory, String(index));
      let now = Date.parse('2026-07-17T00:00:00.000Z');
      let crashed = false;
      const options = {
        tombstoneRetentionMs: 1000,
        now: () => new Date(now),
      };
      const generationId = 'generation-ack-recovery-' + index;
      const checkpoint = createThreadCheckpoint(
        'ack-recovery-' + index,
        generationId
      );
      const crashing = new FileDurableCheckpointStore(caseDirectory, {
        ...options,
        crashInjector(point) {
          if (!crashed && point === crashPoint) {
            crashed = true;
            throw new Error('simulated acknowledgement crash');
          }
        },
      });
      await crashing.save(checkpoint, {
        expectedRevision: null,
        expectedGenerationId: null,
      });
      await crashing.save({
        ...checkpoint,
        status: 'completed',
        nextStepIndex: 1,
        completedStepIds: ['answer'],
        revision: 1,
      }, {
        expectedRevision: 0,
        expectedGenerationId: generationId,
      });
      await crashing.delete(checkpoint.checkpointKey, {
        expectedRevision: 1,
        expectedGenerationId: generationId,
      });
      await assert.rejects(
        crashing.acknowledgeDeletionCleanup(checkpoint.checkpointKey, {
          expectedRevision: 1,
          expectedGenerationId: generationId,
        }),
        /simulated acknowledgement crash/
      );

      const restarted = new FileDurableCheckpointStore(caseDirectory, options);
      await restarted.acknowledgeDeletionCleanup(checkpoint.checkpointKey, {
        expectedRevision: 1,
        expectedGenerationId: generationId,
      });
      now += 1001;
      await restarted.save(createThreadCheckpoint(
        'ack-recovery-gc-' + index,
        'generation-ack-recovery-gc-' + index
      ), {
        expectedRevision: null,
        expectedGenerationId: null,
      });
      assert.equal(
        await restarted.hasDeletionTombstone(checkpoint.checkpointKey, {
          expectedRevision: 1,
          expectedGenerationId: generationId,
        }),
        false
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generation tombstones block early reuse, preserve unacked cleanup, and GC only after acknowledgement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-retention-'));
  let now = Date.parse('2026-07-17T00:00:00.000Z');
  try {
    const store = new FileDurableCheckpointStore(directory, {
      maxThreads: 2,
      maxTombstones: 1,
      tombstoneRetentionMs: 1000,
      now: () => new Date(now),
    });
    const first = createThreadCheckpoint('retention-thread-a');
    await store.save(first, { expectedRevision: null, expectedGenerationId: null });
    await store.save({
      ...first,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    }, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    await store.delete(first.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID});

    const replacementGeneration = 'generation-file-checkpoint-b';
    const replacement = createThreadCheckpoint(
      'retention-thread-a',
      replacementGeneration
    );
    await assert.rejects(
      store.save(replacement, {
        expectedRevision: null,
        expectedGenerationId: null,
      }),
      error => error instanceof DurableWorkflowConflictError
    );

    now += 1001;
    await store.save(replacement, {
      expectedRevision: null,
      expectedGenerationId: null,
    });
    assert.deepEqual(await store.load(first.checkpointKey), replacement);
    assert.equal(
      await store.hasDeletionTombstone(first.checkpointKey, {
        expectedRevision: 1,
        expectedGenerationId: TEST_GENERATION_ID,
      }),
      true
    );
    await assert.rejects(
      store.delete(first.checkpointKey, {
        expectedRevision: 1,
        expectedGenerationId: TEST_GENERATION_ID,
      }),
      error => error instanceof DurableWorkflowConflictError
    );

    const second = createThreadCheckpoint('retention-thread-b');
    await store.save(second, { expectedRevision: null, expectedGenerationId: null });
    await store.save({
      ...second,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    }, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    await assert.rejects(
      store.delete(second.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}),
      error => error?.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
    );

    await store.acknowledgeDeletionCleanup(first.checkpointKey, {
      expectedRevision: 1,
      expectedGenerationId: TEST_GENERATION_ID,
    });
    assert.equal(
      await store.delete(second.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}),
      true
    );
    const afterGc = await findFiles(directory);
    assert.equal(
      afterGc.filter(file => (
        file.includes(path.sep + 'tombstones' + path.sep)
        && /[a-f0-9]{64}\.json$/.test(file)
      )).length,
      1
    );
    assert.equal(
      afterGc.filter(file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file)).length,
      1
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checkpoint key and byte limits reject traversal and oversized state before I/O', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-checkpoint-limit-'));
  try {
    const store = new FileDurableCheckpointStore(directory, {
      maxSerializedBytes: 256,
    });
    await assert.rejects(
      store.save(createCheckpoint('../../outside', 0, 'pending'), {
        expectedRevision: null, expectedGenerationId: null,
      }),
      /canonical durable checkpoint key/
    );
    const key = buildDurableCheckpointKey('manual-workflow', 'thread-a', 'tenant-a');
    await assert.rejects(
      store.save(createCheckpoint(key, 0, 'pending', {
        state: { value: 'x'.repeat(512) },
      }), { expectedRevision: null, expectedGenerationId: null }),
      /serialized byte limit/
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('revision publication crash boundaries recover exact winners without advancing latest', async () => {
  for (const crashPoint of [
    'after-revision-publish',
    'after-latest-commit',
    'after-compaction',
  ]) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'rag-e7-checkpoint-crash-')
    );
    try {
      const revision0 = createThreadCheckpoint('crash-' + crashPoint);
      const key = revision0.checkpointKey;
      const options = {
        maxRevisionFiles: 16,
        maxRetainedRevisionFiles: 2,
      };
      await new FileDurableCheckpointStore(directory, options)
        .save(revision0, { expectedRevision: null, expectedGenerationId: null });
      const revision1 = {
        ...revision0,
        revision: 1,
        status: 'running',
        activeStep: {
          stepId: 'answer',
          stepExecutionId: 'step-execution-crash',
          leaseOwnerId: 'owner-a',
          leaseExpiresAt: '2026-07-17T01:00:00.000Z',
        },
      };
      let injected = false;
      const crashing = new FileDurableCheckpointStore(directory, {
        ...options,
        crashInjector(point) {
          if (!injected && point === crashPoint) {
            injected = true;
            throw new Error('simulated checkpoint crash at ' + point);
          }
        },
      });
      await assert.rejects(
        crashing.save(revision1, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID}),
        /simulated checkpoint crash/
      );
      assert.equal(injected, true);
      const crashWindow = (await findFiles(directory)).filter(
        file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file)
      );
      assert.ok(crashWindow.length <= options.maxRetainedRevisionFiles + 1);

      const restarted = new FileDurableCheckpointStore(directory, options);
      await restarted.save(revision1, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
      const differentRetry = {
        ...revision1,
        updatedAt: '2026-07-17T00:00:01.000Z',
        activeStep: {
          ...revision1.activeStep,
          leaseOwnerId: 'owner-b',
        },
      };
      await assert.rejects(
        restarted.save(differentRetry, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID}),
        error => error instanceof DurableWorkflowConflictError
      );
      assert.deepEqual(await restarted.load(key), revision1);
      const files = await findFiles(directory);
      const pointer = JSON.parse(await readFile(
        files.find(file => file.endsWith(path.sep + 'latest.json')),
        'utf8'
      ));
      assert.equal(pointer.revision, 1);
      assert.ok(
        files.filter(
          file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file)
        ).length <= options.maxRetainedRevisionFiles
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('checkpoint ledger fails closed when its root is missing or a shard is corrupt', async () => {
  const missingRoot = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-ledger-missing-')
  );
  const corruptShard = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-ledger-corrupt-')
  );
  try {
    const missingCheckpoint = createThreadCheckpoint('ledger-missing');
    const missingStore = new FileDurableCheckpointStore(missingRoot);
    await missingStore.save(missingCheckpoint, { expectedRevision: null, expectedGenerationId: null });
    const ledgerFile = (await findFiles(missingRoot)).find(
      file => file.endsWith(path.sep + 'ledger.json')
    );
    await unlink(ledgerFile);
    await assert.rejects(
      new FileDurableCheckpointStore(missingRoot)
        .load(missingCheckpoint.checkpointKey),
      error => error?.code === 'DURABLE_CHECKPOINT_INTEGRITY'
    );

    const corruptCheckpoint = createThreadCheckpoint('ledger-corrupt');
    const corruptStore = new FileDurableCheckpointStore(corruptShard);
    await corruptStore.save(corruptCheckpoint, { expectedRevision: null, expectedGenerationId: null });
    const reservationShard = (await findFiles(corruptShard)).find(
      file => file.includes(path.sep + 'reservation-shards' + path.sep)
        && file.endsWith('.json')
    );
    const shard = JSON.parse(await readFile(reservationShard, 'utf8'));
    shard.entries[0].reservedBytes += 1;
    await writeFile(reservationShard, JSON.stringify(shard));
    await assert.rejects(
      new FileDurableCheckpointStore(corruptShard)
        .load(corruptCheckpoint.checkpointKey),
      error => error?.code === 'DURABLE_CHECKPOINT_INTEGRITY'
    );
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
    await rm(corruptShard, { recursive: true, force: true });
  }
});

test('new-thread ledger I/O stays bounded and never scans legacy per-thread files', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-ledger-io-')
  );
  try {
    const options = { maxThreads: 100 };
    const seedStore = new FileDurableCheckpointStore(directory, options);
    for (let index = 0; index < 48; index += 1) {
      await seedStore.save(createThreadCheckpoint('ledger-seed-' + index), {
        expectedRevision: null, expectedGenerationId: null,
      });
    }
    const events = [];
    const observed = new FileDurableCheckpointStore(directory, {
      ...options,
      ioObserver(event, file) {
        events.push({ event, file });
      },
    });
    await observed.save(createThreadCheckpoint('ledger-observed'), {
      expectedRevision: null, expectedGenerationId: null,
    });
    assert.equal(
      events.filter(({ event }) => event === 'legacy-reservation-read').length,
      0
    );
    assert.equal(
      events.filter(({ event }) => event === 'legacy-tombstone-read').length,
      0
    );
    assert.ok(
      events.filter(({ event }) => event === 'ledger-shard-read').length <= 16
    );
    assert.ok(
      events.filter(({ event }) => event === 'ledger-root-read').length <= 24
    );
    const ledgerFile = (await findFiles(directory)).find(
      file => file.endsWith(path.sep + 'ledger.json')
    );
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
    assert.equal(ledger.reservationCount, 49);
    assert.equal('entries' in ledger, false);
    assert.ok(Object.keys(ledger.reservationShards).length <= 49);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capacity plus one concurrent new threads admits exactly the configured bound', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-capacity-plus-one-')
  );
  try {
    const maxThreads = 8;
    const settled = await Promise.allSettled(
      Array.from({ length: maxThreads + 1 }, (_, index) => (
        new FileDurableCheckpointStore(directory, { maxThreads }).save(
          createThreadCheckpoint('capacity-plus-one-' + index),
          { expectedRevision: null, expectedGenerationId: null }
        )
      ))
    );
    assert.equal(
      settled.filter(result => result.status === 'fulfilled').length,
      maxThreads
    );
    assert.equal(
      settled.filter(result => result.status === 'rejected').length,
      1
    );
    const ledgerFile = (await findFiles(directory)).find(
      file => file.endsWith(path.sep + 'ledger.json')
    );
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
    assert.equal(ledger.reservationCount, maxThreads);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('temporary and orphan cleanup is dedicated, bounded, and ignores revision debris', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-temp-gc-')
  );
  let now = Date.parse('2026-07-17T00:00:00.000Z');
  try {
    const options = {
      maxThreads: 4,
      maxRevisionFiles: 16,
      maxRetainedRevisionFiles: 2,
      temporaryFileTtlMs: 1000,
      orphanReservationTtlMs: 1000,
      now: () => new Date(now),
    };
    const checkpoint = createThreadCheckpoint('temp-debris');
    const store = new FileDurableCheckpointStore(directory, options);
    await store.save(checkpoint, { expectedRevision: null, expectedGenerationId: null });
    let latest = checkpoint;
    for (let revision = 1; revision <= 2; revision += 1) {
      latest = {
        ...checkpoint,
        revision,
        status: 'paused',
        updatedAt: new Date(now + revision).toISOString(),
      };
      await store.save(latest, { expectedRevision: revision - 1 , expectedGenerationId: TEST_GENERATION_ID});
    }
    const revisionFile = (await findFiles(directory)).find(
      file => /[\\/]revisions[\\/][0-9]{16}\.json$/.test(file)
    );
    const revisionDirectory = path.dirname(revisionFile);
    for (let index = 0; index < 80; index += 1) {
      await writeFile(
        path.join(revisionDirectory, 'hard-crash-' + index + '.tmp'),
        'debris'
      );
    }
    assert.deepEqual(await store.load(checkpoint.checkpointKey), latest);

    const temporaryDirectory = path.join(
      directory,
      '.checkpoint-metadata-v1',
      'tmp'
    );
    await mkdir(temporaryDirectory, { recursive: true });
    const expiredTimestamp = String(now - 2000);
    for (let index = 0; index < 70; index += 1) {
      await writeFile(
        path.join(
          temporaryDirectory,
          createHash('sha256').update(String(index)).digest('hex')
            + '.' + expiredTimestamp + '.' + randomUUID() + '.tmp'
        ),
        'expired'
      );
    }
    await store.save(createThreadCheckpoint('temp-gc-trigger'), {
      expectedRevision: null, expectedGenerationId: null,
    });
    const retainedTemporaryFiles = (await readdir(temporaryDirectory))
      .filter(file => file.endsWith('.tmp'));
    assert.equal(retainedTemporaryFiles.length, 6);

    const orphan = createThreadCheckpoint('orphan-reservation');
    let crashed = false;
    const crashing = new FileDurableCheckpointStore(directory, {
      ...options,
      crashInjector(point) {
        if (!crashed && point === 'after-revision-publish') {
          crashed = true;
          throw new Error('simulated orphan crash');
        }
      },
    });
    await assert.rejects(
      crashing.save(orphan, { expectedRevision: null, expectedGenerationId: null }),
      /simulated orphan crash/
    );
    const orphanRevision = (await findFiles(directory)).find(file => (
      file.includes(createHash('sha256').update(orphan.checkpointKey).digest('hex'))
      && /[\\/]revisions[\\/]0000000000000000\.json$/.test(file)
    ));
    await unlink(orphanRevision);
    now += 1001;
    await new FileDurableCheckpointStore(directory, options)
      .save(createThreadCheckpoint('orphan-replacement'), {
        expectedRevision: null, expectedGenerationId: null,
      });
    const reservationFiles = (await findFiles(directory)).filter(
      file => /[\\/]threads[\\/][a-f0-9]{64}\.json$/.test(file)
    );
    assert.equal(
      reservationFiles.some(
        file => path.basename(file) === createHash('sha256')
          .update(orphan.checkpointKey).digest('hex') + '.json'
      ),
      false
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('tombstone ledger create, prune cursor, and full capacity stay on bounded I/O', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-tombstone-io-')
  );
  try {
    const options = {
      maxThreads: 2,
      maxTombstones: 12,
      tombstoneRetentionMs: 60 * 60 * 1000,
    };
    const seedStore = new FileDurableCheckpointStore(directory, options);
    const deleteTerminal = async (store, threadId) => {
      const pending = createThreadCheckpoint(threadId);
      await store.save(pending, { expectedRevision: null, expectedGenerationId: null });
      const completed = {
        ...pending,
        status: 'completed',
        nextStepIndex: 1,
        completedStepIds: ['answer'],
        revision: 1,
      };
      await store.save(completed, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
      return store.delete(pending.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID});
    };
    for (let index = 0; index < 11; index += 1) {
      assert.equal(
        await deleteTerminal(seedStore, 'tombstone-io-seed-' + index),
        true
      );
    }

    const events = [];
    const observed = new FileDurableCheckpointStore(directory, {
      ...options,
      ioObserver(event, file) {
        events.push({ event, file });
      },
    });
    const target = createThreadCheckpoint('tombstone-io-target');
    await observed.save(target, { expectedRevision: null, expectedGenerationId: null });
    await observed.save({
      ...target,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    }, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    events.length = 0;
    assert.equal(
      await observed.delete(target.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}),
      true
    );
    assert.equal(
      events.filter(({ event }) => event === 'legacy-tombstone-read').length,
      0
    );
    assert.ok(
      events.filter(({ event }) => event === 'ledger-shard-read').length <= 24
    );
    assert.ok(
      events.filter(({ event }) => event === 'ledger-root-read').length <= 24
    );

    const ledgerFile = (await findFiles(directory)).find(
      file => file.endsWith(path.sep + 'ledger.json')
    );
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
    assert.equal(ledger.tombstoneCount, options.maxTombstones);

    const overflow = createThreadCheckpoint('tombstone-io-overflow');
    await observed.save(overflow, { expectedRevision: null, expectedGenerationId: null });
    await observed.save({
      ...overflow,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    }, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    await assert.rejects(
      observed.delete(overflow.checkpointKey, { expectedRevision: 1 , expectedGenerationId: TEST_GENERATION_ID}),
      error => error?.code === 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('post-latest compaction failure does not turn a committed save into failure', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-checkpoint-post-commit-')
  );
  try {
    const checkpoint = createThreadCheckpoint('post-commit-compaction');
    const store = new FileDurableCheckpointStore(directory, {
      maxRetainedRevisionFiles: 2,
    });
    await store.save(checkpoint, { expectedRevision: null, expectedGenerationId: null });
    const originalCompact = store.compactRevisionHistory.bind(store);
    let compactCalls = 0;
    store.compactRevisionHistory = async (...args) => {
      compactCalls += 1;
      if (compactCalls === 2) {
        throw new Error('simulated post-commit maintenance failure');
      }
      return originalCompact(...args);
    };
    const completed = {
      ...checkpoint,
      status: 'completed',
      nextStepIndex: 1,
      completedStepIds: ['answer'],
      revision: 1,
    };
    await store.save(completed, { expectedRevision: 0 , expectedGenerationId: TEST_GENERATION_ID});
    assert.equal(compactCalls, 2);
    assert.deepEqual(
      await new FileDurableCheckpointStore(directory, {
        maxRetainedRevisionFiles: 2,
      }).load(
        checkpoint.checkpointKey
      ),
      completed
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


function createThreadCheckpoint(threadId, generationId = TEST_GENERATION_ID) {
  const checkpointKey = buildDurableCheckpointKey(
    'manual-workflow',
    threadId,
    'tenant-a'
  );
  return createCheckpoint(checkpointKey, 0, 'pending', {
    generationId,
    identity: {
      threadId,
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['reviewed', 'trusted'],
      enforceIsolation: true,
      documentId: 'document-a',
      documentVersion: 'document-v1',
    },
  });
}

function createCheckpoint(checkpointKey, revision, status, overrides = {}) {
  return {
    schemaVersion: 'rag-durable-checkpoint-v3',
    checkpointKey,
    generationId: TEST_GENERATION_ID,
    workflowId: 'manual-workflow',
    workflowVersion: 'v1',
    identity: {
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      allowedTrustLevels: ['reviewed', 'trusted'],
      enforceIsolation: true,
      documentId: 'document-a',
      documentVersion: 'document-v1',
    },
    idempotencyKey: 'request-a',
    jobFingerprint: 'a'.repeat(64),
    integrityTag: 'sha256:' + 'b'.repeat(64),
    job: { requestFingerprint: 'c'.repeat(64) },
    state: { done: false },
    status,
    nextStepIndex: 0,
    completedStepIds: [],
    revision,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

async function findFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => {
      const value = path.join(directory, entry.name);
      return entry.isDirectory() ? findFiles(value) : [value];
    }))).flat();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
