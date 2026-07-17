import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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
  createDurableAskResultIdentity,
  FileDurableAskResultArtifactStore,
  InMemoryDurableAskResultArtifactStore,
} = await import('./durable-result-artifact-store.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

test('in-memory result artifacts are identity-bound, content-addressed, and clone-safe', async () => {
  let now = Date.parse('2026-07-17T00:00:00.000Z');
  const store = new InMemoryDurableAskResultArtifactStore({
    now: () => new Date(now),
  });
  const identity = createIdentity();
  const first = await store.put({
    identity,
    result: createResult(),
  });
  assert.match(first.artifactId, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.contentDigest, /^[a-f0-9]{64}$/);
  assert.match(first.artifactDigest, /^[a-f0-9]{64}$/);
  assert.ok(first.byteLength > 0);
  assert.equal(first.createdAt, '2026-07-17T00:00:00.000Z');

  now += 60_000;
  const reordered = await store.put({
    identity,
    result: {
      citations: [{ evidenceId: 'chunk-1' }],
      answer: 'The complete model response.',
    },
  });
  assert.equal(reordered.artifactId, first.artifactId);
  assert.equal(reordered.createdAt, first.createdAt);

  first.result.answer = 'mutated';
  const reread = await store.get(identity, first.artifactId, createScope());
  assert.equal(reread.result.answer, 'The complete model response.');

  const otherThread = await store.put({
    identity: createIdentity({ threadId: 'thread-b' }),
    result: createResult(),
  });
  assert.notEqual(otherThread.artifactId, first.artifactId);
});

test('file result artifacts survive restart and same-process instance races', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-'));
  try {
    const identity = createIdentity();
    const firstStore = new FileDurableAskResultArtifactStore(directory, {
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    });
    const secondStore = new FileDurableAskResultArtifactStore(directory, {
      now: () => new Date('2026-07-17T01:00:00.000Z'),
    });
    assert.equal(firstStore.coordination, 'process');

    const [first, second] = await Promise.all([
      firstStore.put({ identity, result: createResult() }),
      secondStore.put({ identity, result: createResult() }),
    ]);
    assert.equal(first.artifactId, second.artifactId);
    assert.equal(first.createdAt, second.createdAt);

    const restarted = new FileDurableAskResultArtifactStore(directory);
    const loaded = await restarted.get(
      identity,
      first.artifactId,
      createScope({ allowedTrustLevels: ['trusted', 'reviewed'] })
    );
    assert.deepEqual(loaded.result, createResult());
    assert.equal(
      await restarted.get(
        createIdentity({ threadId: 'thread-b' }),
        first.artifactId,
        createScope()
      ),
      null
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exact artifact delete is scope-bound, idempotent, and survives restart', async () => {
  const identity = createIdentity();
  const scope = createScope();
  const memoryStore = new InMemoryDurableAskResultArtifactStore();
  const memoryArtifact = await memoryStore.put({ identity, result: createResult() });
  await assert.rejects(
    memoryStore.delete(
      identity,
      memoryArtifact.artifactId,
      createScope({ tenantId: 'tenant-b' })
    ),
    /tenant scope mismatch/
  );
  assert.equal(
    await memoryStore.delete(identity, memoryArtifact.artifactId, scope),
    true
  );
  assert.equal(
    await memoryStore.delete(identity, memoryArtifact.artifactId, scope),
    false
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-delete-'));
  try {
    const fileStore = new FileDurableAskResultArtifactStore(directory);
    const artifact = await fileStore.put({ identity, result: createResult() });
    assert.equal(
      await fileStore.delete(identity, 'sha256:' + '0'.repeat(64), scope),
      false
    );
    assert.equal(await fileStore.delete(identity, artifact.artifactId, scope), true);
    assert.equal(await fileStore.delete(identity, artifact.artifactId, scope), false);
    assert.equal(
      await new FileDurableAskResultArtifactStore(directory).get(
        identity,
        artifact.artifactId,
        scope
      ),
      null
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exact identity delete sweeps every attempt and orphan reservation only in scope', async () => {
  const identity = createIdentity({ threadId: 'thread-delete-all' });
  const otherIdentity = createIdentity({ threadId: 'thread-delete-other' });
  const scope = createScope();
  const memoryStore = new InMemoryDurableAskResultArtifactStore();
  const memoryArtifacts = await Promise.all([
    memoryStore.put({
      identity,
      result: { ...createResult(), answer: 'attempt one' },
    }),
    memoryStore.put({
      identity,
      result: { ...createResult(), answer: 'attempt two' },
    }),
  ]);
  const memoryOther = await memoryStore.put({
    identity: otherIdentity,
    result: createResult(),
  });
  await assert.rejects(
    memoryStore.deleteAll(identity, createScope({ corpusId: 'corpus-b' })),
    /corpus scope mismatch/
  );
  assert.equal(await memoryStore.deleteAll(identity, scope), 2);
  assert.equal(await memoryStore.deleteAll(identity, scope), 0);
  for (const artifact of memoryArtifacts) {
    assert.equal(
      await memoryStore.get(identity, artifact.artifactId, scope),
      null
    );
  }
  assert.ok(await memoryStore.get(
    otherIdentity,
    memoryOther.artifactId,
    scope
  ));

  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-delete-all-'));
  try {
    const fileStore = new FileDurableAskResultArtifactStore(directory);
    const first = await fileStore.put({
      identity,
      result: { ...createResult(), answer: 'file attempt one' },
    });
    const orphaned = await fileStore.put({
      identity,
      result: { ...createResult(), answer: 'file attempt two' },
    });
    const other = await fileStore.put({
      identity: otherIdentity,
      result: createResult(),
    });
    const files = await findFiles(directory);
    const orphanFile = files.find(file => (
      file.endsWith(orphaned.artifactId.slice('sha256:'.length) + '.json')
      && !file.includes(path.join(directory, 'reservations'))
    ));
    await rm(orphanFile);

    assert.equal(await fileStore.deleteAll(identity, scope), 1);
    assert.equal(
      await fileStore.get(identity, first.artifactId, scope),
      null
    );
    assert.equal(
      await fileStore.get(identity, orphaned.artifactId, scope),
      null
    );
    assert.ok(await fileStore.get(otherIdentity, other.artifactId, scope));
    const remainingReservations = (await findFiles(directory))
      .filter(file => /[\\/]reservations[\\/][a-f0-9]{64}\.json$/.test(file));
    assert.equal(remainingReservations.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('result identity isolates generations of the same durable thread', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-generation-'));
  try {
    const scope = createScope();
    const generationA = createIdentity({
      generationId: 'generation-result-isolation-a',
    });
    const generationB = createIdentity({
      generationId: 'generation-result-isolation-b',
    });
    const store = new FileDurableAskResultArtifactStore(directory);
    const artifactA = await store.put({
      identity: generationA,
      result: createResult(),
    });
    const artifactB = await store.put({
      identity: generationB,
      result: createResult(),
    });
    assert.notEqual(artifactA.artifactId, artifactB.artifactId);
    assert.equal(await store.deleteAll(generationA, scope), 1);
    assert.equal(await store.get(generationA, artifactA.artifactId, scope), null);
    assert.deepEqual(
      await store.get(generationB, artifactB.artifactId, scope),
      artifactB
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy result artifacts without a generation fail closed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-legacy-'));
  try {
    const identity = createIdentity();
    const scope = createScope();
    const store = new FileDurableAskResultArtifactStore(directory);
    const artifact = await store.put({ identity, result: createResult() });
    const artifactFile = (await findFiles(directory)).find(file => (
      file.includes(path.sep + 'artifacts' + path.sep)
      && /[a-f0-9]{64}\.json$/.test(file)
    ));
    const persisted = JSON.parse(await readFile(artifactFile, 'utf8'));
    persisted.schemaVersion = 'rag-durable-ask-result-v1';
    delete persisted.identity.generationId;
    await writeFile(artifactFile, JSON.stringify(persisted));
    await assert.rejects(
      store.get(identity, artifact.artifactId, scope),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('result artifact reads fail closed on tenant, corpus, trust, and isolation drift', async () => {
  const store = new InMemoryDurableAskResultArtifactStore();
  const identity = createIdentity();
  const artifact = await store.put({ identity, result: createResult() });

  await assert.rejects(
    store.get(identity, artifact.artifactId, createScope({ tenantId: 'tenant-b' })),
    /tenant scope mismatch/
  );
  await assert.rejects(
    store.get(identity, artifact.artifactId, createScope({ corpusId: 'corpus-b' })),
    /corpus scope mismatch/
  );
  await assert.rejects(
    store.get(
      identity,
      artifact.artifactId,
      createScope({ allowedTrustLevels: ['reviewed'] })
    ),
    /trust scope mismatch/
  );
  await assert.rejects(
    store.get(
      identity,
      artifact.artifactId,
      createScope({ enforceIsolation: false })
    ),
    /isolation mode mismatch/
  );
});

test('result artifacts reject credentials and envelope metadata tampering', async () => {
  const memoryStore = new InMemoryDurableAskResultArtifactStore();
  await assert.rejects(
    memoryStore.put({
      identity: createIdentity(),
      result: { answer: 'ok', metadata: { apiKey: 'must-not-persist' } },
    }),
    /forbidden credential field/
  );
  await assert.rejects(
    memoryStore.put({
      identity: createIdentity(),
      result: { answer: 'ok', metadata: { token: 'must-not-persist' } },
    }),
    /forbidden credential field/
  );
  await memoryStore.put({
    identity: createIdentity(),
    result: { answer: 'ok', usage: { completionTokenCount: 12 } },
  });

  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-envelope-'));
  try {
    const identity = createIdentity({ threadId: 'thread-envelope' });
    const store = new FileDurableAskResultArtifactStore(directory);
    const artifact = await store.put({ identity, result: createResult() });
    const artifactFile = (await findFiles(directory))
      .find(file => file.endsWith('.json'));
    const stored = JSON.parse(await readFile(artifactFile, 'utf8'));
    stored.createdAt = '2026-07-18T00:00:00.000Z';
    await writeFile(artifactFile, JSON.stringify(stored));
    await assert.rejects(
      store.get(identity, artifact.artifactId, createScope()),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file result reads detect payload, digest, length, and identity tampering', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-tamper-'));
  try {
    const identity = createIdentity();
    const store = new FileDurableAskResultArtifactStore(directory);
    const artifact = await store.put({ identity, result: createResult() });
    const artifactFile = (await findFiles(directory))
      .find(file => file.endsWith('.json'));
    const stored = JSON.parse(await readFile(artifactFile, 'utf8'));
    stored.result.answer = 'forged response';
    await writeFile(artifactFile, JSON.stringify(stored));

    await assert.rejects(
      new FileDurableAskResultArtifactStore(directory).get(
        identity,
        artifact.artifactId,
        createScope()
      ),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
    await assert.rejects(
      store.delete(identity, artifact.artifactId, createScope()),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
    await assert.rejects(
      store.put({ identity, result: createResult() }),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root artifact capacity is concurrent, restart-persistent, and delete-reclaimable', async () => {
  const memory = new InMemoryDurableAskResultArtifactStore({ maxArtifacts: 1 });
  const memoryIdentity = createIdentity({ threadId: 'memory-capacity-a' });
  const memoryArtifact = await memory.put({
    identity: memoryIdentity,
    result: createResult(),
  });
  await assert.rejects(
    memory.put({
      identity: createIdentity({ threadId: 'memory-capacity-b' }),
      result: createResult(),
    }),
    error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
  );
  await memory.delete(memoryIdentity, memoryArtifact.artifactId, createScope());

  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-capacity-'));
  try {
    const identities = [
      createIdentity({ threadId: 'artifact-capacity-a' }),
      createIdentity({ threadId: 'artifact-capacity-b' }),
    ];
    const stores = [
      new FileDurableAskResultArtifactStore(directory, { maxArtifacts: 1 }),
      new FileDurableAskResultArtifactStore(directory, { maxArtifacts: 1 }),
    ];
    const settled = await Promise.allSettled(identities.map((identity, index) => (
      stores[index].put({ identity, result: createResult() })
    )));
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
    const rejected = settled.find(result => result.status === 'rejected');
    assert.equal(rejected.reason?.code, 'DURABLE_ASK_RESULT_CAPACITY');

    const winnerIndex = settled.findIndex(result => result.status === 'fulfilled');
    const winnerArtifact = settled[winnerIndex].value;
    const restarted = new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 1,
    });
    await assert.rejects(
      restarted.put({
        identity: createIdentity({ threadId: 'artifact-capacity-c' }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );
    assert.equal(
      await restarted.delete(
        identities[winnerIndex],
        winnerArtifact.artifactId,
        createScope()
      ),
      true
    );
    const replacementIdentity = createIdentity({ threadId: 'artifact-capacity-c' });
    const replacement = await new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 1,
    }).put({ identity: replacementIdentity, result: createResult() });
    assert.ok(replacement);
    const reservations = (await findFiles(directory))
      .filter(file => /[\\/]reservations[\\/][a-f0-9]{64}\.json$/.test(file));
    assert.equal(reservations.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact envelopes are compactly serialized before capacity reservation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-serialize-'));
  try {
    const values = Array.from({ length: 20_000 }, () => '');
    const result = { answer: 'compact-envelope', values };
    const compactBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const store = new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 1,
      maxResultBytes: compactBytes + 64,
    });
    const validIdentity = createIdentity({ threadId: 'compact-result-valid' });
    const artifact = await store.put({
      identity: validIdentity,
      result,
    });
    assert.deepEqual(
      (await store.get(validIdentity, artifact.artifactId, createScope())).result,
      result
    );
    const files = await findFiles(directory);
    assert.equal(
      files.filter(file => /[\\/]reservations[\\/][a-f0-9]{64}\.json$/.test(file)).length,
      1
    );
    assert.equal(
      files.filter(file => /[\\/]artifacts[\\/][a-f0-9]{64}\.json$/.test(file)).length,
      1
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root and scope ledgers enforce exact count quotas without cross-scope starvation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-scope-quota-'));
  try {
    const store = new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 2,
      maxScopeArtifacts: 1,
      maxRootBytes: 8 * 1024 * 1024,
      maxScopeBytes: 4 * 1024 * 1024,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    });
    const scopeAIdentity = createIdentity({ threadId: 'scope-quota-a' });
    const scopeAArtifact = await store.put({
      identity: scopeAIdentity,
      result: createResult(),
    });
    await assert.rejects(
      store.put({
        identity: createIdentity({ threadId: 'scope-quota-b' }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );

    const scopeBIdentity = createIdentity({
      corpusId: 'corpus-b',
      threadId: 'scope-quota-c',
    });
    const scopeBArtifact = await store.put({
      identity: scopeBIdentity,
      result: createResult(),
    });
    await assert.rejects(
      store.put({
        identity: createIdentity({
          corpusId: 'corpus-c',
          threadId: 'scope-quota-d',
        }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );

    const files = await findFiles(directory);
    const rootLedger = JSON.parse(await readFile(
      files.find(file => file.endsWith(path.join('ledgers', 'root.json'))),
      'utf8'
    ));
    assert.equal(rootLedger.schemaVersion, 'rag-durable-ask-result-root-ledger-v1');
    assert.equal(rootLedger.counters.count, 2);
    assert.ok(rootLedger.counters.bytes > 0);
    assert.ok(Number.isSafeInteger(rootLedger.generation));
    assert.match(rootLedger.ledgerDigest, /^[a-f0-9]{64}$/);

    const reservations = await readJsonFiles(
      files.filter(file => /[\\/]reservations[\\/][a-f0-9]{64}\.json$/.test(file))
    );
    assert.equal(reservations.length, 2);
    for (const reservation of reservations) {
      assert.equal(
        reservation.schemaVersion,
        'rag-durable-ask-result-reservation-v3'
      );
      assert.ok(reservation.reservedBytes > 0);
      assert.match(reservation.scopeDigest, /^[a-f0-9]{64}$/);
      assert.equal(reservation.state, 'committed');
    }
    const scopeLedgers = await readJsonFiles(
      files.filter(file => file.endsWith('.ledger.json'))
    );
    assert.equal(scopeLedgers.length, 2);
    assert.ok(scopeLedgers.every(ledger => (
      ledger.counters.count === 1
      && Number.isSafeInteger(ledger.generation)
      && /^[a-f0-9]{64}$/.test(ledger.ledgerDigest)
    )));

    assert.equal(
      await store.delete(scopeAIdentity, scopeAArtifact.artifactId, createScope()),
      true
    );
    const replacement = await store.put({
      identity: createIdentity({
        corpusId: 'corpus-c',
        threadId: 'scope-quota-d',
      }),
      result: createResult(),
    });
    assert.ok(replacement);
    assert.ok(await store.get(
      scopeBIdentity,
      scopeBArtifact.artifactId,
      createScope({ corpusId: 'corpus-b' })
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root and scope byte quotas reject the exact next serialized artifact', async () => {
  const calibrationDirectory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-result-byte-calibration-')
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-byte-quota-'));
  try {
    const now = () => new Date('2026-07-17T00:00:00.000Z');
    const calibration = new FileDurableAskResultArtifactStore(
      calibrationDirectory,
      { now }
    );
    await calibration.put({
      identity: createIdentity({ threadId: 'byte-quota-a' }),
      result: createResult(),
    });
    const [calibrationReservation] = await readJsonFiles(
      (await findFiles(calibrationDirectory)).filter(file => (
        /[\\/]reservations[\\/][a-f0-9]{64}\.json$/.test(file)
      ))
    );
    const artifactBytes = calibrationReservation.reservedBytes;
    const store = new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 3,
      maxScopeArtifacts: 3,
      maxRootBytes: artifactBytes * 2,
      maxScopeBytes: artifactBytes * 2,
      now,
    });
    await store.put({
      identity: createIdentity({ threadId: 'byte-quota-a' }),
      result: createResult(),
    });
    await store.put({
      identity: createIdentity({ threadId: 'byte-quota-b' }),
      result: createResult(),
    });
    await assert.rejects(
      store.put({
        identity: createIdentity({ threadId: 'byte-quota-c' }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );

    const otherScope = new FileDurableAskResultArtifactStore(
      path.join(directory, 'other-scope'),
      {
        maxArtifacts: 3,
        maxScopeArtifacts: 3,
        maxRootBytes: artifactBytes * 3,
        maxScopeBytes: artifactBytes,
        now,
      }
    );
    await otherScope.put({
      identity: createIdentity({ threadId: 'byte-scope-a' }),
      result: createResult(),
    });
    await assert.rejects(
      otherScope.put({
        identity: createIdentity({ threadId: 'byte-scope-b' }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );
    assert.ok(await otherScope.put({
      identity: createIdentity({
        corpusId: 'corpus-b',
        threadId: 'byte-scope-c',
      }),
      result: createResult(),
    }));
  } finally {
    await rm(calibrationDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing or corrupt capacity ledgers fail closed until an explicit bounded rebuild', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-rebuild-'));
  try {
    const options = {
      maxArtifacts: 2,
      maxScopeArtifacts: 2,
      maxRootBytes: 8 * 1024 * 1024,
      maxScopeBytes: 8 * 1024 * 1024,
      rebuildMaxDurationMs: 5_000,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    };
    const identity = createIdentity({ threadId: 'rebuild-ledger-a' });
    const store = new FileDurableAskResultArtifactStore(directory, options);
    const artifact = await store.put({ identity, result: createResult() });
    let files = await findFiles(directory);
    const rootLedgerFile = files.find(file => (
      file.endsWith(path.join('ledgers', 'root.json'))
    ));
    await rm(rootLedgerFile);

    const missingRoot = new FileDurableAskResultArtifactStore(directory, options);
    await assert.rejects(
      missingRoot.put({
        identity: createIdentity({ threadId: 'rebuild-ledger-b' }),
        result: createResult(),
      }),
      error => (
        error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
        && /explicit recovery is required/.test(error.message)
      )
    );
    assert.equal((await findFiles(directory)).includes(rootLedgerFile), false);

    const rebuiltRoot = await missingRoot.rebuildCapacityLedger();
    assert.equal(rebuiltRoot.reservationCount, 1);
    assert.equal(rebuiltRoot.artifactCount, 1);
    assert.ok(rebuiltRoot.scannedEntries >= 2);
    assert.ok(await missingRoot.get(identity, artifact.artifactId, createScope()));

    files = await findFiles(directory);
    const scopeLedgerFile = files.find(file => file.endsWith('.ledger.json'));
    await writeFile(scopeLedgerFile, '{}');
    const corruptScope = new FileDurableAskResultArtifactStore(directory, options);
    await assert.rejects(
      corruptScope.put({
        identity: createIdentity({ threadId: 'rebuild-ledger-b' }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );

    const rebuiltScope = await corruptScope.rebuildCapacityLedger();
    assert.equal(rebuiltScope.reservationCount, 1);
    await corruptScope.put({
      identity: createIdentity({ threadId: 'rebuild-ledger-b' }),
      result: createResult(),
    });
    const repairedRootFile = (await findFiles(directory)).find(file => (
      file.endsWith(path.join('ledgers', 'root.json'))
    ));
    await writeFile(repairedRootFile, '{}');
    await assert.rejects(
      corruptScope.put({
        identity: createIdentity({
          corpusId: 'corpus-b',
          threadId: 'rebuild-ledger-c',
        }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
    const rebuiltCorruptRoot = await corruptScope.rebuildCapacityLedger();
    assert.equal(rebuiltCorruptRoot.reservationCount, 2);
    await assert.rejects(
      corruptScope.put({
        identity: createIdentity({
          corpusId: 'corpus-b',
          threadId: 'rebuild-ledger-c',
        }),
        result: createResult(),
      }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );
    const finalRoot = JSON.parse(await readFile(
      (await findFiles(directory)).find(file => (
        file.endsWith(path.join('ledgers', 'root.json'))
      )),
      'utf8'
    ));
    assert.equal(finalRoot.counters.count, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capacity rebuild blocks concurrent put and delete mutations until commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-rebuild-fence-'));
  let releaseRebuild;
  let rebuildPromise;
  let deletePromise;
  let putPromise;
  try {
    const options = {
      maxArtifacts: 2,
      maxScopeArtifacts: 2,
      maxRootBytes: 8 * 1024 * 1024,
      maxScopeBytes: 8 * 1024 * 1024,
      rebuildMaxDurationMs: 5000,
    };
    const existingIdentity = createIdentity({ threadId: 'rebuild-fence-a' });
    const existing = await new FileDurableAskResultArtifactStore(
      directory,
      options
    ).put({ identity: existingIdentity, result: createResult() });

    let signalMarker;
    const markerPublished = new Promise(resolve => {
      signalMarker = resolve;
    });
    const rebuildingStore = new FileDurableAskResultArtifactStore(directory, {
      ...options,
      lifecycleHook(point) {
        if (point === 'after-rebuild-marker') {
          signalMarker();
          return new Promise(resolve => {
            releaseRebuild = resolve;
          });
        }
      },
    });
    rebuildPromise = rebuildingStore.rebuildCapacityLedger();
    await markerPublished;

    const mutatingStore = new FileDurableAskResultArtifactStore(
      directory,
      options
    );
    let deleteSettled = false;
    let putSettled = false;
    deletePromise = mutatingStore.delete(
      existingIdentity,
      existing.artifactId,
      createScope()
    ).then(value => {
      deleteSettled = true;
      return value;
    });
    const nextIdentity = createIdentity({ threadId: 'rebuild-fence-b' });
    putPromise = mutatingStore.put({
      identity: nextIdentity,
      result: createResult(),
    }).then(value => {
      putSettled = true;
      return value;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deleteSettled, false);
    assert.equal(putSettled, false);
    assert.ok(await mutatingStore.get(
      existingIdentity,
      existing.artifactId,
      createScope()
    ));

    releaseRebuild();
    const rebuild = await rebuildPromise;
    assert.equal(rebuild.reservationCount, 1);
    assert.equal(await deletePromise, true);
    const next = await putPromise;
    assert.equal(next.identity.generationId, nextIdentity.generationId);
  } finally {
    releaseRebuild?.();
    await Promise.allSettled(
      [rebuildPromise, deletePromise, putPromise].filter(Boolean)
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('crashed rebuild marker fails closed before any later mutation', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-result-rebuild-crash-fence-')
  );
  try {
    const options = {
      maxArtifacts: 2,
      maxScopeArtifacts: 2,
      maxRootBytes: 8 * 1024 * 1024,
      maxScopeBytes: 8 * 1024 * 1024,
      rebuildMaxDurationMs: 5000,
    };
    const identity = createIdentity({ threadId: 'rebuild-crash-fence-a' });
    const initial = new FileDurableAskResultArtifactStore(directory, options);
    const artifact = await initial.put({ identity, result: createResult() });
    const crashing = new FileDurableAskResultArtifactStore(directory, {
      ...options,
      lifecycleHook(point) {
        if (point === 'after-rebuild-marker') {
          throw new Error('simulated rebuild crash after marker');
        }
      },
    });
    await assert.rejects(
      crashing.rebuildCapacityLedger(),
      /simulated rebuild crash after marker/
    );

    const fenced = new FileDurableAskResultArtifactStore(directory, options);
    await assert.rejects(
      fenced.delete(identity, artifact.artifactId, createScope()),
      error => (
        error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
        && /rebuild is incomplete/.test(error.message)
      )
    );
    assert.ok(await fenced.get(identity, artifact.artifactId, createScope()));
    await assert.rejects(
      fenced.put({
        identity: createIdentity({ threadId: 'rebuild-crash-fence-b' }),
        result: createResult(),
      }),
      error => (
        error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
        && /rebuild is incomplete/.test(error.message)
      )
    );

    const rebuilt = await fenced.rebuildCapacityLedger();
    assert.equal(rebuilt.reservationCount, 1);
    assert.equal(
      await fenced.delete(identity, artifact.artifactId, createScope()),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hard-crash reservation phases reconcile on restart and TTL GC reclaims capacity', async () => {
  for (const crashPoint of [
    'after-root-ledger-mutation',
    'after-scope-ledger-mutation',
    'after-capacity-reservation',
    'after-artifact-publication',
  ]) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'rag-e7-result-crash-reserve-')
    );
    try {
      let nowMs = Date.parse('2026-07-17T00:00:00.000Z');
      let injected = false;
      const options = {
        maxArtifacts: 1,
        maxScopeArtifacts: 1,
        maxRootBytes: 8 * 1024 * 1024,
        maxScopeBytes: 8 * 1024 * 1024,
        orphanTtlMs: 1,
        now: () => new Date(nowMs),
      };
      const crashing = new FileDurableAskResultArtifactStore(directory, {
        ...options,
        lifecycleHook(point) {
          if (!injected && point === crashPoint) {
            injected = true;
            throw new Error('simulated hard crash at ' + point);
          }
        },
      });
      await assert.rejects(
        crashing.put({
          identity: createIdentity({ threadId: 'crash-reserve-a' }),
          result: createResult(),
        }),
        /simulated hard crash/
      );
      assert.equal(injected, true);

      nowMs += 60_000;
      const restarted = new FileDurableAskResultArtifactStore(
        directory,
        options
      );
      const report = await restarted.collectGarbage();
      assert.equal(
        report.reclaimedReservations,
        1,
        crashPoint + ' should reclaim its reservation'
      );
      assert.equal(
        report.reclaimedArtifacts,
        crashPoint === 'after-artifact-publication' ? 1 : 0
      );
      assert.ok(await restarted.put({
        identity: createIdentity({ threadId: 'crash-reserve-b' }),
        result: createResult(),
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('expired generation A reservation never blocks generation B on a reused thread', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'rag-e7-result-generation-reuse-')
  );
  try {
    let nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    const identityA = createIdentity({
      generationId: 'generation-orphan-a',
      threadId: 'generation-reused-thread',
    });
    const identityB = createIdentity({
      generationId: 'generation-active-b',
      threadId: 'generation-reused-thread',
    });
    assert.equal(identityA.threadId, identityB.threadId);
    assert.notEqual(identityA.generationId, identityB.generationId);
    const options = {
      maxArtifacts: 1,
      maxScopeArtifacts: 1,
      maxRootBytes: 8 * 1024 * 1024,
      maxScopeBytes: 8 * 1024 * 1024,
      orphanTtlMs: 1000,
      gcMaxEntries: 4,
      gcMaxDurationMs: 5000,
      now: () => new Date(nowMs),
    };
    let injected = false;
    const crashing = new FileDurableAskResultArtifactStore(directory, {
      ...options,
      lifecycleHook(point) {
        if (!injected && point === 'after-capacity-reservation') {
          injected = true;
          throw new Error('simulated generation A reservation crash');
        }
      },
    });
    await assert.rejects(
      crashing.put({ identity: identityA, result: createResult() }),
      /simulated generation A reservation crash/
    );

    const persistedReservations = (await readJsonFiles(await findFiles(directory)))
      .filter(value => (
        value.schemaVersion === 'rag-durable-ask-result-reservation-v3'
      ));
    assert.equal(persistedReservations.length, 1);
    assert.match(persistedReservations[0].identityDigest, /^[a-f0-9]{64}$/);

    nowMs += 1001;
    const restarted = new FileDurableAskResultArtifactStore(directory, options);
    await assert.rejects(
      restarted.put({ identity: identityB, result: createResult() }),
      error => error?.code === 'DURABLE_ASK_RESULT_CAPACITY'
    );
    const report = await restarted.collectGarbage();
    assert.equal(report.scannedEntries <= options.gcMaxEntries, true);
    assert.equal(report.reclaimedReservations, 1);

    const artifactB = await restarted.put({
      identity: identityB,
      result: createResult(),
    });
    assert.equal(artifactB.identity.generationId, identityB.generationId);
    assert.equal(
      await restarted.get(identityA, artifactB.artifactId, createScope()),
      null
    );
    assert.equal(
      (await restarted.get(identityB, artifactB.artifactId, createScope()))
        .identity.generationId,
      identityB.generationId
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hard crash after artifact deletion retains accounting until restart GC releases it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-crash-delete-'));
  try {
    let nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    const options = {
      maxArtifacts: 1,
      maxScopeArtifacts: 1,
      maxRootBytes: 8 * 1024 * 1024,
      maxScopeBytes: 8 * 1024 * 1024,
      orphanTtlMs: 1,
      gcMaxDurationMs: 5000,
      now: () => new Date(nowMs),
    };
    const identity = createIdentity({ threadId: 'crash-delete-a' });
    const created = await new FileDurableAskResultArtifactStore(
      directory,
      options
    ).put({ identity, result: createResult() });
    let injected = false;
    const crashing = new FileDurableAskResultArtifactStore(directory, {
      ...options,
      lifecycleHook(point) {
        if (!injected && point === 'after-artifact-delete') {
          injected = true;
          throw new Error('simulated hard crash after artifact delete');
        }
      },
    });
    await assert.rejects(
      crashing.delete(identity, created.artifactId, createScope()),
      /simulated hard crash/
    );
    nowMs += 60_000;
    const restarted = new FileDurableAskResultArtifactStore(directory, options);
    const report = await restarted.collectGarbage();
    assert.equal(report.reclaimedReservations, 1);
    assert.equal(report.reclaimedArtifacts, 0);
    assert.ok(await restarted.put({
      identity: createIdentity({ threadId: 'crash-delete-b' }),
      result: createResult(),
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('orphan GC persists a digest cursor and obeys entry and byte budgets across batches', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-gc-cursor-'));
  try {
    let nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    const baseOptions = {
      maxArtifacts: 3,
      maxScopeArtifacts: 3,
      maxResultBytes: 128 * 1024,
      maxRootBytes: 16 * 1024 * 1024,
      maxScopeBytes: 16 * 1024 * 1024,
      orphanTtlMs: 1,
      now: () => new Date(nowMs),
    };
    const crashing = new FileDurableAskResultArtifactStore(directory, {
      ...baseOptions,
      lifecycleHook(point) {
        if (point === 'after-capacity-reservation') {
          throw new Error('simulated abandoned reservation');
        }
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(
        crashing.put({
          identity: createIdentity({ threadId: 'gc-cursor-' + index }),
          result: createResult(),
        }),
        /simulated abandoned reservation/
      );
    }

    nowMs += 60_000;
    const gcMaxBytes = 1024 * 1024;
    const collector = new FileDurableAskResultArtifactStore(directory, {
      ...baseOptions,
      gcMaxEntries: 1,
      gcMaxBytes,
      gcMaxDurationMs: 5_000,
    });
    let reclaimedReservations = 0;
    for (let pass = 0; pass < 8 && reclaimedReservations < 3; pass += 1) {
      const report = await collector.collectGarbage();
      assert.ok(report.scannedEntries <= 1);
      assert.ok(report.scannedBytes <= gcMaxBytes);
      reclaimedReservations += report.reclaimedReservations;
    }
    assert.equal(reclaimedReservations, 3);
    assert.equal(
      (await findFiles(directory)).filter(file => (
        /[\\/]reservations[\\/][a-f0-9]{64}\.json$/.test(file)
      )).length,
      0
    );
    const cursor = JSON.parse(await readFile(
      (await findFiles(directory)).find(file => file.endsWith('gc-cursor.json')),
      'utf8'
    ));
    assert.equal(cursor.schemaVersion, 'rag-durable-ask-result-gc-cursor-v1');
    assert.ok(Number.isSafeInteger(cursor.generation));
    assert.ok(cursor.phase === 'reservations' || cursor.phase === 'artifacts');
    assert.match(cursor.cursorDigest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hard-crash temporary files use one strict root and TTL GC is bounded without deleting active files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-temp-gc-'));
  try {
    let nowMs = Date.parse('2026-07-17T00:00:10.000Z');
    const options = {
      maxArtifacts: 2,
      maxScopeArtifacts: 2,
      temporaryFileTtlMs: 1000,
      gcMaxEntries: 2,
      gcMaxDurationMs: 5000,
      now: () => new Date(nowMs),
    };
    const store = new FileDurableAskResultArtifactStore(directory, options);
    const identity = createIdentity({ threadId: 'temporary-root-seed' });
    const artifact = await store.put({ identity, result: createResult() });
    await store.delete(identity, artifact.artifactId, createScope());

    const temporaryDirectory = path.join(directory, 'ledgers', 'tmp');
    await mkdir(temporaryDirectory, { recursive: true });
    const expiredAt = nowMs - 2000;
    const activeAt = nowMs;
    const uuids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ];
    for (let index = 0; index < uuids.length; index += 1) {
      await writeFile(
        path.join(
          temporaryDirectory,
          String(index + 1).padStart(64, '0')
            + '.' + expiredAt + '.' + uuids[index] + '.tmp'
        ),
        'hard-crash-orphan-' + index
      );
    }
    const activeFile = path.join(
      temporaryDirectory,
      'f'.repeat(64) + '.' + activeAt
        + '.00000000-0000-4000-8000-000000000005.tmp'
    );
    await writeFile(activeFile, 'active-writer');

    const restartedStore = new FileDurableAskResultArtifactStore(
      directory,
      options
    );
    await restartedStore.delete(
      identity,
      artifact.artifactId,
      createScope()
    );
    assert.equal((await readdir(temporaryDirectory)).length, 3);
    await restartedStore.delete(
      identity,
      artifact.artifactId,
      createScope()
    );
    assert.deepEqual(await readdir(temporaryDirectory), [path.basename(activeFile)]);
    await restartedStore.delete(
      identity,
      artifact.artifactId,
      createScope()
    );
    assert.deepEqual(await readdir(temporaryDirectory), [path.basename(activeFile)]);

    nowMs += 1001;
    await restartedStore.delete(
      identity,
      artifact.artifactId,
      createScope()
    );
    assert.deepEqual(await readdir(temporaryDirectory), []);
    assert.equal(
      (await findFiles(directory))
        .filter(file => file.endsWith('.tmp'))
        .every(file => path.dirname(file) === temporaryDirectory),
      true
    );

    await writeFile(path.join(temporaryDirectory, 'untrusted.tmp'), 'invalid');
    await assert.rejects(
      new FileDurableAskResultArtifactStore(directory, options).collectGarbage(),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
    await rm(path.join(temporaryDirectory, 'untrusted.tmp'), { force: true });

    const futureFile = path.join(
      temporaryDirectory,
      'e'.repeat(64) + '.' + (nowMs + 1)
        + '.00000000-0000-4000-8000-000000000006.tmp'
    );
    await writeFile(futureFile, 'future-timestamp');
    await assert.rejects(
      new FileDurableAskResultArtifactStore(directory, options).collectGarbage(),
      error => error?.code === 'DURABLE_ASK_RESULT_INTEGRITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('temporary unlink failures preserve commits and force the next mutation preflight', async () => {
  for (const cleanupKind of ['publication', 'replacement']) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'rag-e7-result-temp-unlink-' + cleanupKind + '-')
    );
    try {
      let nowMs = Date.parse('2026-07-17T00:00:00.000Z');
      let injectedFailure = false;
      const ioEvents = [];
      const store = new FileDurableAskResultArtifactStore(directory, {
        temporaryFileTtlMs: 1,
        now: () => new Date(nowMs),
        ioObserver(event) {
          ioEvents.push(event);
        },
        async temporaryFileUnlink(file) {
          if (cleanupKind === 'publication' && !injectedFailure) {
            injectedFailure = true;
            throw Object.assign(new Error('injected temporary unlink failure'), {
              code: 'EPERM',
            });
          }
          try {
            await rm(file);
          } catch (error) {
            if (
              cleanupKind === 'replacement'
              && !injectedFailure
              && error?.code === 'ENOENT'
            ) {
              injectedFailure = true;
              throw Object.assign(
                new Error('injected replacement cleanup failure'),
                { code: 'EPERM' }
              );
            }
            throw error;
          }
        },
      });
      const identity = createIdentity({
        threadId: 'temporary-unlink-' + cleanupKind,
      });
      const artifact = await store.put({ identity, result: createResult() });
      assert.ok(await store.get(identity, artifact.artifactId, createScope()));
      assert.equal(injectedFailure, true);

      const temporaryDirectory = path.join(directory, 'ledgers', 'tmp');
      assert.equal(
        (await readdir(temporaryDirectory)).length,
        cleanupKind === 'publication' ? 1 : 0
      );

      nowMs += 2;
      ioEvents.length = 0;
      assert.equal(
        await store.delete(identity, artifact.artifactId, createScope()),
        true
      );
      assert.deepEqual(await readdir(temporaryDirectory), []);
      assert.ok(ioEvents.some(event => (
        event.operation === 'list' && event.target === 'temporary'
      )));
      if (cleanupKind === 'publication') {
        assert.ok(ioEvents.some(event => (
          event.operation === 'delete' && event.target === 'temporary'
        )));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('empty scope controls are crash-safe, reclaimed under churn, and rebuild stays bounded', async () => {
  for (const crashPoint of [
    'after-empty-scope-ledger-delete',
    'after-empty-scope-marker-delete',
  ]) {
    const crashDirectory = await mkdtemp(
      path.join(tmpdir(), 'rag-e7-result-scope-cleanup-crash-')
    );
    try {
      const options = {
        maxArtifacts: 1,
        maxScopeArtifacts: 1,
        rebuildMaxDurationMs: 5000,
      };
      const identity = createIdentity({
        corpusId: 'scope-cleanup-crash',
        threadId: 'scope-cleanup-crash',
      });
      const initial = new FileDurableAskResultArtifactStore(
        crashDirectory,
        options
      );
      const artifact = await initial.put({ identity, result: createResult() });
      let injected = false;
      const crashing = new FileDurableAskResultArtifactStore(crashDirectory, {
        ...options,
        lifecycleHook(point) {
          if (!injected && point === crashPoint) {
            injected = true;
            throw new Error('simulated empty scope cleanup crash');
          }
        },
      });
      await assert.rejects(
        crashing.delete(
          identity,
          artifact.artifactId,
          createScope({ corpusId: 'scope-cleanup-crash' })
        ),
        /simulated empty scope cleanup crash/
      );
      const restarted = new FileDurableAskResultArtifactStore(
        crashDirectory,
        options
      );
      assert.equal(
        await restarted.delete(
          identity,
          artifact.artifactId,
          createScope({ corpusId: 'scope-cleanup-crash' })
        ),
        false
      );
      assert.equal(
        (await findFiles(path.join(crashDirectory, 'ledgers', 'scopes'))).length,
        0
      );
    } finally {
      await rm(crashDirectory, { recursive: true, force: true });
    }
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-scope-churn-'));
  try {
    const store = new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 1,
      maxScopeArtifacts: 1,
      rebuildMaxDurationMs: 5000,
    });
    for (let index = 0; index < 24; index += 1) {
      const corpusId = 'scope-churn-' + index;
      const identity = createIdentity({
        corpusId,
        threadId: 'scope-churn-thread-' + index,
      });
      const artifact = await store.put({ identity, result: createResult() });
      assert.equal(
        await store.delete(
          identity,
          artifact.artifactId,
          createScope({ corpusId })
        ),
        true
      );
    }
    assert.equal(
      (await findFiles(path.join(directory, 'ledgers', 'scopes'))).length,
      0
    );
    const rebuilt = await store.rebuildCapacityLedger();
    assert.equal(rebuilt.reservationCount, 0);
    assert.equal(rebuilt.artifactCount, 0);
    assert.equal(rebuilt.scopeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GC byte budget must cover the largest accepted artifact envelope', () => {
  assert.throws(
    () => new FileDurableAskResultArtifactStore('unused-result-root', {
      maxResultBytes: 1024 * 1024,
      gcMaxBytes: 1024 * 1024,
    }),
    /must cover maxResultBytes plus the artifact envelope/
  );
  assert.doesNotThrow(
    () => new FileDurableAskResultArtifactStore('unused-result-root', {
      maxResultBytes: 1024 * 1024,
      gcMaxBytes: 1024 * 1024 + 64 * 1024,
    })
  );
});

test('slow artifact publication does not block unrelated reads and hot-path IO stays constant', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-hot-path-'));
  try {
    const options = {
      maxArtifacts: 20,
      maxScopeArtifacts: 20,
      maxResultBytes: 2 * 1024 * 1024,
      maxRootBytes: 64 * 1024 * 1024,
      maxScopeBytes: 64 * 1024 * 1024,
    };
    const base = new FileDurableAskResultArtifactStore(directory, options);
    const readableIdentity = createIdentity({ threadId: 'hot-path-readable' });
    const readable = await base.put({
      identity: readableIdentity,
      result: createResult(),
    });

    let signalBlocked;
    let releaseBlocked;
    let didBlock = false;
    const blocked = new Promise(resolve => {
      signalBlocked = resolve;
    });
    const events = [];
    const blockingStore = new FileDurableAskResultArtifactStore(directory, {
      ...options,
      ioObserver(event) {
        events.push(event);
      },
      lifecycleHook(point) {
        if (!didBlock && point === 'after-capacity-reservation') {
          didBlock = true;
          signalBlocked();
          return new Promise(resolve => {
            releaseBlocked = resolve;
          });
        }
      },
    });
    const slowPut = blockingStore.put({
      identity: createIdentity({ threadId: 'hot-path-slow-write' }),
      result: { answer: 'x'.repeat(1024 * 1024) },
    });
    await blocked;
    events.length = 0;
    let timeout;
    try {
      const loaded = await Promise.race([
        blockingStore.get(
          readableIdentity,
          readable.artifactId,
          createScope()
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('unrelated read was blocked by publication')),
            1_000
          );
        }),
      ]);
      assert.deepEqual(loaded.result, createResult());
      assert.deepEqual(
        events.map(event => [event.operation, event.target]),
        [['read', 'reservation'], ['read', 'artifact']]
      );
    } finally {
      clearTimeout(timeout);
      releaseBlocked();
    }
    await slowPut;

    for (let index = 0; index < 8; index += 1) {
      await base.put({
        identity: createIdentity({ threadId: 'hot-path-fill-' + index }),
        result: createResult(),
      });
    }
    events.length = 0;
    const hotArtifact = await blockingStore.put({
      identity: createIdentity({ threadId: 'hot-path-constant' }),
      result: createResult(),
    });
    assert.equal(events.some(event => event.operation === 'list'), false);
    assert.ok(events.length <= 16);

    events.length = 0;
    assert.equal(
      await blockingStore.deleteAll(readableIdentity, createScope()),
      1
    );
    assert.ok(events.filter(event => event.operation === 'list').length <= 2);
    assert.ok(await blockingStore.get(
      createIdentity({ threadId: 'hot-path-constant' }),
      hotArtifact.artifactId,
      createScope()
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact delete reclaims empty identity and shard directories under churn', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-directory-churn-'));
  try {
    const store = new FileDurableAskResultArtifactStore(directory, {
      maxArtifacts: 1,
    });
    for (let index = 0; index < 12; index += 1) {
      const identity = createIdentity({ threadId: 'directory-churn-' + index });
      const artifact = await store.put({
        identity,
        result: { answer: 'response-' + index },
      });
      assert.equal(
        await store.delete(identity, artifact.artifactId, createScope()),
        true
      );
    }
    assert.ok((await findFiles(directory)).every(file => (
      file.includes(path.join(directory, 'ledgers'))
    )));
    assert.ok((await findDirectories(directory)).every(value => (
      path.relative(directory, value).startsWith('ledgers')
    )));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('result path, artifact ID, identity shape, and byte limits are bounded', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-result-limit-'));
  try {
    const store = new FileDurableAskResultArtifactStore(directory, {
      maxResultBytes: 64,
    });
    await assert.rejects(
      store.put({
        identity: { ...createIdentity(), threadId: '../escape' },
        result: createResult(),
      }),
      /safe ask result identifier/
    );
    await assert.rejects(
      store.get(createIdentity(), '../../escape', createScope()),
      /SHA-256 ask result identifier/
    );
    await assert.rejects(
      store.put({
        identity: { ...createIdentity(), enforceIsolation: 'true' },
        result: createResult(),
      }),
      /isolation flag must be boolean/
    );
    await assert.rejects(
      store.put({
        identity: createIdentity(),
        result: { answer: 'x'.repeat(256) },
      }),
      /serialized byte limit/
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createResult() {
  return {
    answer: 'The complete model response.',
    citations: [{ evidenceId: 'chunk-1' }],
  };
}

function createIdentity(overrides = {}) {
  return createDurableAskResultIdentity({
    generationId: overrides.generationId ?? 'generation-result-a',
    threadId: overrides.threadId ?? 'thread-a',
    scope: createScope(overrides),
  });
}

function createScope(overrides = {}) {
  return createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['reviewed', 'trusted'],
    enforceIsolation: true,
    ...overrides,
  });
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

async function readJsonFiles(files) {
  return Promise.all(files.map(async file => (
    JSON.parse(await readFile(file, 'utf8'))
  )));
}

async function findDirectories(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory()) return [];
      const value = path.join(directory, entry.name);
      return [value, ...await findDirectories(value)];
    }))).flat();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
