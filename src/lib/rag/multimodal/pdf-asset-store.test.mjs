import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
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
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  buildPdfAssetManifest,
  sha256Hex,
} = await import('./pdf-asset-manifest.ts');
const {
  FilePdfAssetStore,
  InMemoryPdfAssetStore,
  pdfAssetIdentityFromManifest,
} = await import('./pdf-asset-store.ts');
const { createRetrievalScope } = await import('../../security/retrieval-scope.ts');

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03, 0x04,
]);
const DIFFERENT_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x05, 0x06, 0x07, 0x08,
]);

test('in-memory publication is immutable, clone-safe, and content-idempotent', async () => {
  const store = new InMemoryPdfAssetStore();
  const firstPublication = createPublication({
    now: new Date('2026-07-17T00:00:00.000Z'),
  });
  const identity = pdfAssetIdentityFromManifest(firstPublication.manifest);
  const first = await store.put(firstPublication);

  firstPublication.pageImages[0].bytes[9] = 0xff;
  first.pages[0].textLength = 999;

  const sameContent = createPublication({
    now: new Date('2026-07-17T01:00:00.000Z'),
  });
  const idempotent = await store.put(sameContent);
  assert.equal(idempotent.createdAt, '2026-07-17T00:00:00.000Z');

  const page = await store.readPage(identity, 1, createScope());
  assert.deepEqual(page.bytes, PNG_BYTES);
  page.bytes[8] = 0xee;
  const reread = await store.readPage(identity, 1, createScope());
  assert.deepEqual(reread.bytes, PNG_BYTES);
  assert.equal((await store.getManifest(identity, createScope())).pages[0].textLength, 8);
});

test('same identity rejects different content and validates MIME magic before retention', async () => {
  const store = new InMemoryPdfAssetStore();
  await store.put(createPublication());

  await assert.rejects(
    store.put(createPublication({ bytes: DIFFERENT_PNG_BYTES })),
    error => error?.code === 'PDF_ASSET_CONFLICT'
  );

  const invalidMagic = Uint8Array.from({ length: PNG_BYTES.length }, (_, index) => index);
  await assert.rejects(
    new InMemoryPdfAssetStore().put(createPublication({ bytes: invalidMagic })),
    /MIME signature/
  );
});

test('manifest and page reads require exact tenant, corpus, version, and trust scope', async () => {
  const publication = createPublication();
  const identity = pdfAssetIdentityFromManifest(publication.manifest);
  const store = new InMemoryPdfAssetStore();
  await store.put(publication);

  assert.equal(
    await store.getManifest({ ...identity, documentVersion: 'sha256:v2' }, createScope()),
    null
  );
  await assert.rejects(
    store.getManifest(identity, { ...createScope(), tenantId: 'tenant-b' }),
    /tenant scope mismatch/
  );
  await assert.rejects(
    store.readPage(identity, 1, { ...createScope(), corpusId: 'corpus-b' }),
    /corpus scope mismatch/
  );
  await assert.rejects(
    store.getManifest(identity, { ...createScope(), allowedTrustLevels: ['trusted'] }),
    /outside the retrieval scope/
  );

  const quarantined = createPublication({ trustLevel: 'quarantined' });
  const quarantinedIdentity = pdfAssetIdentityFromManifest(quarantined.manifest);
  await store.put(quarantined);
  await assert.rejects(
    store.readPage(quarantinedIdentity, 1, createScope({
      allowedTrustLevels: ['quarantined'],
    })),
    /quarantined/
  );
});

test('file publication survives restart and serializes same-process store instances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-store-'));
  try {
    const publication = createPublication();
    const identity = pdfAssetIdentityFromManifest(publication.manifest);
    const firstStore = new FilePdfAssetStore(directory);
    const secondStore = new FilePdfAssetStore(directory);
    assert.equal(firstStore.coordination, 'process');
    assert.equal(secondStore.coordination, 'process');

    const [first, second] = await Promise.all([
      firstStore.put(publication),
      secondStore.put(createPublication({
        now: new Date('2026-07-17T02:00:00.000Z'),
      })),
    ]);
    assert.equal(first.createdAt, second.createdAt);

    const restarted = new FilePdfAssetStore(directory);
    const page = await restarted.readPage(identity, 1, createScope());
    assert.deepEqual(page.bytes, PNG_BYTES);
    assert.equal((await restarted.getManifest(identity, createScope())).documentVersion, 'sha256:v1');

    await assert.rejects(
      restarted.put(createPublication({ bytes: DIFFERENT_PNG_BYTES })),
      error => error?.code === 'PDF_ASSET_CONFLICT'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing final manifests fence put and delete without double quota', async () => {
  for (const operation of ['put', 'delete']) {
    const directory = await mkdtemp(
      path.join(tmpdir(), `rag-e6-pdf-missing-manifest-${operation}-`)
    );
    const publication = createPublication();
    const identity = pdfAssetIdentityFromManifest(publication.manifest);
    try {
      const store = new FilePdfAssetStore(directory);
      await store.put(publication);
      const pageFile = createExpectedPageFile(
        directory,
        identity,
        publication.manifest.pages[0]
      );
      const manifestFile = path.join(
        path.dirname(path.dirname(pageFile)),
        'manifest.json'
      );
      await rm(manifestFile, { force: true });

      await assert.rejects(
        operation === 'put'
          ? store.put(publication)
          : store.delete(identity, createScope()),
        error => error?.code === 'PDF_ASSET_RECOVERY_REQUIRED'
      );
      const rootLedger = JSON.parse(await readFile(
        path.join(directory, '.control', 'root-ledger.json'),
        'utf8'
      ));
      const scopeLedger = await readOnlyScopeLedger(directory);
      assert.equal(rootLedger.committedCount, 1);
      assert.equal(rootLedger.recoveryRequired, true);
      assert.equal(scopeLedger.committedCount, 1);
      assert.equal(scopeLedger.recoveryRequired, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
test('file reads detect post-publication byte tampering after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-tamper-'));
  try {
    const publication = createPublication();
    const identity = pdfAssetIdentityFromManifest(publication.manifest);
    await new FilePdfAssetStore(directory).put(publication);
    const pageFiles = (await findFiles(directory)).filter(file => file.endsWith('.bin'));
    assert.equal(pageFiles.length, 1);
    const tampered = Uint8Array.from(await readFile(pageFiles[0]));
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(pageFiles[0], tampered);

    const reads = { manifest: 0, page: 0 };
    const restarted = new FilePdfAssetStore(directory, {
      onRead(kind) { reads[kind] += 1; },
    });
    const visibleManifest = await restarted.getManifest(identity, createScope());
    assert.equal(visibleManifest.documentId, identity.documentId);
    assert.deepEqual(reads, { manifest: 1, page: 0 });
    await assert.rejects(
      restarted.readPage(identity, 1, createScope()),
      error => error?.code === 'PDF_ASSET_INTEGRITY'
    );
    assert.deepEqual(reads, { manifest: 2, page: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file reads detect manifest tampering independently from page bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-manifest-tamper-'));
  try {
    const publication = createPublication();
    const identity = pdfAssetIdentityFromManifest(publication.manifest);
    await new FilePdfAssetStore(directory).put(publication);
    const manifestFile = (await findFiles(directory)).find(file => file.endsWith('manifest.json'));
    const envelope = JSON.parse(await readFile(manifestFile, 'utf8'));
    envelope.manifest.sourceName = 'forged.pdf';
    await writeFile(manifestFile, JSON.stringify(envelope));

    const restarted = new FilePdfAssetStore(directory);
    await assert.rejects(
      restarted.getManifest(identity, createScope()),
      error => error?.code === 'PDF_ASSET_INTEGRITY'
    );
    await assert.rejects(
      restarted.delete(identity, createScope({ corpusId: 'corpus-b' })),
      /corpus scope mismatch/
    );
    assert.equal(await restarted.delete(identity, createScope()), true);
    assert.equal(await restarted.getManifest(identity, createScope()), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest envelope digest rejects retention-field tampering without page I/O', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-envelope-tamper-'));
  try {
    const publication = createPublication();
    const identity = pdfAssetIdentityFromManifest(publication.manifest);
    await new FilePdfAssetStore(directory).put(publication);
    const manifestFile = (await findFiles(directory)).find(file => file.endsWith('manifest.json'));
    const envelope = JSON.parse(await readFile(manifestFile, 'utf8'));
    envelope.expiresAt = '2099-01-01T00:00:00.000Z';
    await writeFile(manifestFile, JSON.stringify(envelope));

    const reads = { manifest: 0, page: 0 };
    await assert.rejects(
      new FilePdfAssetStore(directory, {
        onRead(kind) { reads[kind] += 1; },
      }).getManifest(identity, createScope()),
      error => error?.code === 'PDF_ASSET_INTEGRITY'
        && /envelope content/.test(error.message)
    );
    assert.deepEqual(reads, { manifest: 1, page: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('path traversal and hard resource-limit attempts fail before publication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-path-'));
  try {
    const store = new FilePdfAssetStore(directory);
    const unsafeRef = createPublication();
    unsafeRef.manifest.pages[0].imageRef = '../escape.png';
    await assert.rejects(store.put(unsafeRef), /safe storage key/);

    const unsafeIdentity = createPublication({ documentId: 'document/../../escape' });
    await assert.rejects(store.put(unsafeIdentity), /safe PDF asset identifier/);
    await assert.rejects(access(path.join(path.dirname(directory), 'escape.png')));

    const tooSmall = new FilePdfAssetStore(directory, {
      limits: { maxImageBytes: PNG_BYTES.length - 1 },
    });
    await assert.rejects(tooSmall.put(createPublication()), /store byte limit/);

    const tinyManifest = new InMemoryPdfAssetStore({
      limits: { maxManifestBytes: 64 },
    });
    await assert.rejects(tinyManifest.put(createPublication()), /manifest exceeds/);

    const onePageOnly = new FilePdfAssetStore(directory, {
      limits: { maxPages: 1 },
    });
    await assert.rejects(
      onePageOnly.put(createPublication({ pageCount: 2 })),
      /page count exceeds the configured store limit/
    );
    assert.equal((await findFiles(directory)).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exact-scope delete releases root and scope count capacity across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-delete-quota-'));
  const limits = { maxRootAssetCount: 2, maxScopeAssetCount: 1 };
  try {
    const first = createPublication({ documentId: 'doc-a' });
    const sameScope = createPublication({ documentId: 'doc-b' });
    const otherScope = createPublication({ documentId: 'doc-c', corpusId: 'corpus-b' });
    const thirdScope = createPublication({ documentId: 'doc-d', corpusId: 'corpus-c' });
    const firstIdentity = pdfAssetIdentityFromManifest(first.manifest);
    const store = new FilePdfAssetStore(directory, { limits });

    await store.put(first);
    await assert.rejects(
      store.put(sameScope),
      error => error?.code === 'PDF_ASSET_CAPACITY' && /scope count/.test(error.message)
    );
    await store.put(otherScope);
    await assert.rejects(
      store.put(thirdScope),
      error => error?.code === 'PDF_ASSET_CAPACITY' && /root count/.test(error.message)
    );
    await assert.rejects(
      store.delete(firstIdentity, createScope({ corpusId: 'corpus-b' })),
      /corpus scope mismatch/
    );
    assert.equal(await store.delete(firstIdentity, createScope()), true);
    assert.equal(await store.delete(firstIdentity, createScope()), false);

    const restarted = new FilePdfAssetStore(directory, { limits });
    await restarted.put(sameScope);
    assert.equal(
      (await restarted.getManifest(
        pdfAssetIdentityFromManifest(sameScope.manifest),
        createScope()
      )).documentId,
      'doc-b'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('in-memory scope and root byte reservations reject overcommit and recover on delete', async () => {
  const store = new InMemoryPdfAssetStore({
    limits: {
      maxRootAssetCount: 10,
      maxScopeAssetCount: 10,
      maxRootTotalBytes: PNG_BYTES.length * 2,
      maxScopeTotalBytes: PNG_BYTES.length,
    },
  });
  const first = createPublication({ documentId: 'bytes-a' });
  const sameScope = createPublication({ documentId: 'bytes-b' });
  const otherScope = createPublication({ documentId: 'bytes-c', corpusId: 'corpus-b' });
  const thirdScope = createPublication({ documentId: 'bytes-d', corpusId: 'corpus-c' });

  await store.put(first);
  await assert.rejects(
    store.put(sameScope),
    error => error?.code === 'PDF_ASSET_CAPACITY' && /scope byte/.test(error.message)
  );
  await store.put(otherScope);
  await assert.rejects(
    store.put(thirdScope),
    error => error?.code === 'PDF_ASSET_CAPACITY' && /root byte/.test(error.message)
  );
  assert.equal(
    await store.delete(pdfAssetIdentityFromManifest(first.manifest), createScope()),
    true
  );
  await store.put(sameScope);
});

test('same-process concurrent file writers reserve capacity before publication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-reservation-'));
  try {
    const storeA = new FilePdfAssetStore(directory, {
      limits: { maxRootAssetCount: 1 },
    });
    const storeB = new FilePdfAssetStore(directory, {
      limits: { maxRootAssetCount: 1 },
    });
    const results = await Promise.allSettled([
      storeA.put(createPublication({ documentId: 'reservation-a' })),
      storeB.put(createPublication({ documentId: 'reservation-b' })),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason?.code, 'PDF_ASSET_CAPACITY');
    assert.equal((await findFiles(directory)).filter(file => file.endsWith('manifest.json')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest-last failure returns reservation without leaving bundle or staging payloads', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-rollback-'));
  try {
    const publication = createPublication({ documentId: 'rollback-a' });
    const compactManifestBytes = Buffer.byteLength(JSON.stringify(publication.manifest), 'utf8');
    const failing = new FilePdfAssetStore(directory, {
      limits: {
        maxManifestBytes: compactManifestBytes + 1,
        maxRootAssetCount: 1,
      },
    });
    await assert.rejects(failing.put(publication), /manifest exceeds/);
    const remaining = await findFiles(directory);
    assert.equal(remaining.some(file => file.endsWith('.bin')), false);
    assert.equal(remaining.some(file => file.includes('.staging')), false);
    assert.equal(remaining.some(file => file.includes('reservations')), false);

    const recovered = new FilePdfAssetStore(directory, {
      limits: { maxRootAssetCount: 1 },
    });
    await recovered.put(publication);
    assert.deepEqual(
      (await recovered.readPage(
        pdfAssetIdentityFromManifest(publication.manifest),
        1,
        createScope()
      )).bytes,
      PNG_BYTES
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('TTL expiry reclaims exact committed capacity while GC cursor remains bounded', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-ttl-'));
  let now = 1_000;
  const retention = {
    retentionMs: 500,
    orphanRetentionMs: 100,
    gcMaxEntries: 1,
    gcMaxBytes: 1024 * 1024,
    gcMaxDurationMs: 1000,
    gcMaxShardEntries: 8,
    gcMaxInvalidEntries: 2,
  };
  const clock = () => new Date(now);
  try {
    const first = createPublication({ documentId: 'ttl-a' });
    const store = new FilePdfAssetStore(directory, {
      retention,
      clock,
      limits: { maxRootAssetCount: 1 },
    });
    await store.put(first);

    now = 1_600;
    const restarted = new FilePdfAssetStore(directory, {
      retention,
      clock,
      limits: { maxRootAssetCount: 1 },
    });
    assert.equal(
      await restarted.getManifest(pdfAssetIdentityFromManifest(first.manifest), createScope()),
      null
    );
    const firstGc = await restarted.runGarbageCollectionBatch();
    const secondGc = await new FilePdfAssetStore(directory, {
      retention,
      clock,
      limits: { maxRootAssetCount: 1 },
    }).runGarbageCollectionBatch();
    assert.ok(firstGc.entriesScanned <= 1);
    assert.ok(secondGc.entriesScanned <= 1);
    assert.notDeepEqual(secondGc.cursor, firstGc.cursor);

    const second = createPublication({ documentId: 'ttl-b' });
    await restarted.put(second);
    assert.equal(
      (await restarted.getManifest(
        pdfAssetIdentityFromManifest(second.manifest),
        createScope()
      )).documentId,
      'ttl-b'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('hot put uses bounded control I/O instead of rescanning prior manifests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-io-'));
  const retention = {
    gcMaxEntries: 1,
    gcMaxBytes: 1024 * 1024,
    gcMaxDurationMs: 1000,
    gcMaxShardEntries: 16,
    gcMaxInvalidEntries: 2,
  };
  try {
    const seed = new FilePdfAssetStore(directory, { retention });
    for (let index = 0; index < 12; index += 1) {
      await seed.put(createPublication({ documentId: 'io-' + index }));
    }

    const io = {};
    const observed = new FilePdfAssetStore(directory, {
      retention,
      onIo(kind) {
        io[kind] = (io[kind] ?? 0) + 1;
      },
    });
    await observed.put(createPublication({ documentId: 'io-final' }));

    assert.ok((io['manifest-read'] ?? 0) <= 3, JSON.stringify(io));
    assert.ok((io['root-ledger-read'] ?? 0) <= 12, JSON.stringify(io));
    assert.ok((io['scope-ledger-read'] ?? 0) <= 4, JSON.stringify(io));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('slow unrelated put does not block immutable manifest reads', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-short-lock-'));
  let releaseSlowPut;
  let reportReserved;
  const slowGate = new Promise(resolve => {
    releaseSlowPut = resolve;
  });
  const reserved = new Promise(resolve => {
    reportReserved = resolve;
  });
  try {
    const existing = createPublication({ documentId: 'readable' });
    const identity = pdfAssetIdentityFromManifest(existing.manifest);
    await new FilePdfAssetStore(directory).put(existing);

    const slowStore = new FilePdfAssetStore(directory, {
      async onPublicationPhase(phase) {
        if (phase === 'scope-reserved') {
          reportReserved();
          await slowGate;
        }
      },
    });
    const slowPut = slowStore.put(createPublication({ documentId: 'slow' }));
    await reserved;

    const visible = await Promise.race([
      slowStore.getManifest(identity, createScope()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('unrelated read was blocked')), 250);
      }),
    ]);
    assert.equal(visible.documentId, 'readable');

    releaseSlowPut();
    await slowPut;
  } finally {
    releaseSlowPut?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test('hard-crash publication boundaries reconcile reservations exactly once', async () => {
  const phases = [
    'reservation-journal-written',
    'root-reserved',
    'scope-reserved',
    'bundle-published',
    'scope-committed',
    'root-committed',
  ];
  for (const [index, crashPhase] of phases.entries()) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-crash-'));
    const limits = { maxRootAssetCount: 1 };
    const publication = createPublication({ documentId: 'crash-' + index });
    try {
      const crashing = new FilePdfAssetStore(directory, {
        limits,
        processEpoch: 'writer-' + index,
        onPublicationPhase(phase) {
          if (phase !== crashPhase) return;
          throw Object.assign(new Error('simulated hard crash'), {
            code: 'PDF_ASSET_SIMULATED_HARD_CRASH',
          });
        },
      });
      await assert.rejects(crashing.put(publication), /simulated hard crash/);

      const restarted = new FilePdfAssetStore(directory, {
        limits,
        processEpoch: 'restart-' + index,
      });
      await restarted.put(publication);
      assert.equal(
        (await restarted.getManifest(
          pdfAssetIdentityFromManifest(publication.manifest),
          createScope()
        )).documentId,
        'crash-' + index
      );
      await assert.rejects(
        restarted.put(createPublication({ documentId: 'overflow-' + index })),
        error => error?.code === 'PDF_ASSET_CAPACITY'
          && /root count/.test(error.message)
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('new-scope creation crashes release scope quota and keep orphan journals fail-closed', async () => {
  for (const [index, crashPhase] of [
    'reservation-journal-written',
    'root-reserved',
  ].entries()) {
    const directory = await mkdtemp(
      path.join(tmpdir(), `rag-e6-pdf-scope-creation-crash-${index}-`)
    );
    const options = {
      control: { maxScopeLedgers: 1, recoveryMaxShardsPerBatch: 256 },
    };
    const abandoned = createPublication({
      tenantId: `tenant-abandoned-${index}`,
      corpusId: `corpus-abandoned-${index}`,
      documentId: `scope-creation-crash-${index}`,
    });
    const replacement = createPublication({
      tenantId: `tenant-replacement-${index}`,
      corpusId: `corpus-replacement-${index}`,
      documentId: `scope-creation-replacement-${index}`,
    });
    const replacementScope = createScope({
      tenantId: `tenant-replacement-${index}`,
      corpusId: `corpus-replacement-${index}`,
    });
    try {
      const crashing = new FilePdfAssetStore(directory, {
        ...options,
        processEpoch: `scope-creation-writer-${index}`,
        onPublicationPhase(phase) {
          if (phase === crashPhase) throw simulatedHardCrash();
        },
      });
      await assert.rejects(crashing.put(abandoned), /simulated hard crash/);

      const restarted = new FilePdfAssetStore(directory, {
        ...options,
        processEpoch: `scope-creation-restart-${index}`,
      });
      await restarted.put(replacement);
      assert.equal(
        (await restarted.getManifest(
          pdfAssetIdentityFromManifest(replacement.manifest),
          replacementScope
        )).documentId,
        `scope-creation-replacement-${index}`
      );
      const repairedRoot = JSON.parse(await readFile(
        path.join(directory, '.control', 'root-ledger.json'),
        'utf8'
      ));
      assert.equal(Object.keys(repairedRoot.scopeLifecycles).length, 1);
      assert.deepEqual(Object.values(repairedRoot.scopeLifecycles), ['active']);

      if (crashPhase === 'reservation-journal-written') {
        await rm(path.join(directory, '.control', 'root-ledger.json'));
        const recovering = new FilePdfAssetStore(directory, {
          ...options,
          processEpoch: 'orphan-prepared-root-rebuild',
        });
        assert.equal((await recovering.recoverLedgerBatch()).complete, false);
        await assert.rejects(
          recovering.recoverLedgerBatch(),
          /requires explicit recovery of a damaged scope ledger/
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('ledger digest corruption fails closed and recovers in bounded shard batches', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-ledger-recovery-'));
  const control = { recoveryMaxShardsPerBatch: 8 };
  const retention = {
    gcMaxEntries: 64,
    gcMaxBytes: 8 * 1024 * 1024,
    gcMaxDurationMs: 5000,
    gcMaxShardEntries: 64,
    gcMaxInvalidEntries: 4,
  };
  try {
    const store = new FilePdfAssetStore(directory, { control, retention });
    await store.put(createPublication({ documentId: 'ledger-a' }));

    const rootLedgerFile = (await findFiles(directory))
      .find(file => file.endsWith('root-ledger.json'));
    const forgedRoot = JSON.parse(await readFile(rootLedgerFile, 'utf8'));
    forgedRoot.committedCount += 1;
    await writeFile(rootLedgerFile, JSON.stringify(forgedRoot));

    const recovering = new FilePdfAssetStore(directory, { control, retention });
    await assert.rejects(
      recovering.put(createPublication({ documentId: 'ledger-b' })),
      error => error?.code === 'PDF_ASSET_RECOVERY_REQUIRED'
    );
    let rootRecovery;
    let rootBatches = 0;
    do {
      rootRecovery = await recovering.recoverLedgerBatch();
      rootBatches += 1;
      assert.ok(rootRecovery.shardsScanned <= 8);
    } while (!rootRecovery.complete);
    assert.ok(rootBatches > 1);

    const scopeLedgerFile = (await findFiles(directory))
      .find(file => file.includes(path.sep + 'scopes' + path.sep));
    const forgedScope = JSON.parse(await readFile(scopeLedgerFile, 'utf8'));
    forgedScope.generation += 1;
    await writeFile(scopeLedgerFile, JSON.stringify(forgedScope));

    await assert.rejects(
      recovering.put(createPublication({ documentId: 'ledger-b' })),
      error => error?.code === 'PDF_ASSET_RECOVERY_REQUIRED'
    );
    let scopeRecovery;
    do {
      scopeRecovery = await recovering.recoverLedgerBatch({
        tenantId: 'tenant-a',
        corpusId: 'corpus-a',
      });
      assert.ok(scopeRecovery.shardsScanned <= 8);
    } while (!scopeRecovery.complete);

    await recovering.put(createPublication({ documentId: 'ledger-b' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reservation overhead is included in in-flight byte admission', async () => {
  const probeDirectory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-bytes-probe-'));
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-bytes-limit-'));
  try {
    const publication = createPublication({ documentId: 'byte-accounting' });
    await new FilePdfAssetStore(probeDirectory).put(publication);
    const manifestFile = (await findFiles(probeDirectory))
      .find(file => file.endsWith('manifest.json'));
    const committedBytes = PNG_BYTES.length + (await readFile(manifestFile)).byteLength;

    const constrained = new FilePdfAssetStore(directory, {
      limits: {
        maxRootTotalBytes: committedBytes + 4095,
        maxScopeTotalBytes: committedBytes + 4095,
      },
      control: { reservationOverheadBytes: 4096 },
    });
    await assert.rejects(
      constrained.put(publication),
      error => error?.code === 'PDF_ASSET_CAPACITY'
        && /root byte/.test(error.message)
    );
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized GC shard debris fails before unbounded materialization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-gc-debris-'));
  const retention = {
    gcMaxEntries: 8,
    gcMaxBytes: 1024 * 1024,
    gcMaxDurationMs: 1000,
    gcMaxShardEntries: 2,
    gcMaxInvalidEntries: 1,
  };
  try {
    const store = new FilePdfAssetStore(directory, { retention });
    const initialized = await store.runGarbageCollectionBatch();
    assert.equal(initialized.cursor.phase, 'bundles');
    const shard = initialized.cursor.shard.toString(16).padStart(2, '0');
    for (const name of ['debris-a', 'debris-b', 'debris-c']) {
      await mkdir(path.join(directory, shard, name), { recursive: true });
    }
    await assert.rejects(
      store.runGarbageCollectionBatch(),
      error => error?.code === 'PDF_ASSET_GC_BUDGET'
        && /bounded directory-entry/.test(error.message)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GC byte budget cannot be configured below the readable manifest bound', () => {
  const options = {
    limits: { maxManifestBytes: 4096 },
    retention: { gcMaxBytes: 4095 },
  };
  assert.throws(
    () => new FilePdfAssetStore(path.join(tmpdir(), 'pdf-invalid-gc-budget'), options),
    /GC byte budget must be at least the manifest byte limit/
  );
  assert.throws(
    () => new InMemoryPdfAssetStore(options),
    /GC byte budget must be at least the manifest byte limit/
  );
});

test('root recovery rejects an oversized corrupt manifest instead of deferring forever', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-recovery-oversized-'));
  const limits = { maxManifestBytes: 4096 };
  try {
    const seed = new FilePdfAssetStore(directory, { limits });
    await seed.put(createPublication({ documentId: 'oversized-recovery' }));
    const manifestFiles = (await findFiles(directory))
      .filter(file => file.endsWith('manifest.json'));
    assert.equal(manifestFiles.length, 1);
    await writeFile(
      manifestFiles[0],
      Buffer.alloc(limits.maxManifestBytes + 1, 0x20)
    );
    await corruptRootLedger(directory);

    const recovering = new FilePdfAssetStore(directory, {
      limits,
      retention: {
        gcMaxBytes: limits.maxManifestBytes,
        gcMaxDurationMs: 1000,
      },
      control: { recoveryMaxShardsPerBatch: 256 },
      processEpoch: 'oversized-recovery-reader',
    });
    let rejected = false;
    for (let batch = 0; batch < 10 && !rejected; batch += 1) {
      try {
        await recovering.recoverLedgerBatch();
      } catch (error) {
        assert.equal(error?.code, 'PDF_ASSET_INTEGRITY');
        assert.match(error.message, /invalid manifest size/);
        rejected = true;
      }
    }
    assert.equal(rejected, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GC byte exhaustion preserves the first unprocessed bundle in its shard cursor', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-gc-cursor-'));
  let now = 1_000;
  const clock = () => new Date(now);
  const retention = {
    retentionMs: 100,
    orphanRetentionMs: 100,
    gcMaxEntries: 8,
    gcMaxBytes: 1024 * 1024,
    gcMaxDurationMs: 1000,
    gcMaxShardEntries: 16,
    gcMaxInvalidEntries: 2,
  };
  try {
    const [firstId, secondId] = findSameShardDocumentIds();
    const seed = new FilePdfAssetStore(directory, { retention, clock });
    await seed.put(createPublication({ documentId: firstId }));
    await seed.put(createPublication({ documentId: secondId }));
    const manifestFiles = (await findFiles(directory))
      .filter(file => file.endsWith('manifest.json'));
    assert.equal(manifestFiles.length, 2);
    const manifestSizes = await Promise.all(
      manifestFiles.map(async file => (await readFile(file)).byteLength)
    );
    const oneManifestBudget = Math.max(...manifestSizes);
    now = 2_000;
    const collecting = new FilePdfAssetStore(directory, {
      limits: { maxManifestBytes: oneManifestBudget },
      retention: { ...retention, gcMaxBytes: oneManifestBudget },
      clock,
    });

    let observedDeferredBundle = false;
    for (let batch = 0; batch < 200; batch += 1) {
      const before = (await findFiles(directory))
        .filter(file => file.endsWith('manifest.json')).length;
      const result = await collecting.runGarbageCollectionBatch();
      const after = (await findFiles(directory))
        .filter(file => file.endsWith('manifest.json')).length;
      if (before === 2 && after === 1) {
        observedDeferredBundle = true;
        assert.equal(result.entriesScanned, 1);
        assert.ok(result.cursor.lastName);
        await collecting.runGarbageCollectionBatch();
        assert.equal(
          (await findFiles(directory))
            .filter(file => file.endsWith('manifest.json')).length,
          0
        );
        break;
      }
    }
    assert.equal(observedDeferredBundle, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing root and scope ledgers fence first writes across recovery batches', async () => {
  for (const target of ['root', 'scope']) {
    const directory = await mkdtemp(path.join(
      tmpdir(),
      'rag-e6-pdf-missing-' + target + '-fence-'
    ));
    const limits = { maxRootAssetCount: 1, maxScopeAssetCount: 1 };
    const recoveryScope = target === 'scope'
      ? { tenantId: 'tenant-a', corpusId: 'corpus-a' }
      : undefined;
    try {
      const recovering = new FilePdfAssetStore(directory, {
        limits,
        control: { recoveryMaxShardsPerBatch: 16 },
        processEpoch: 'missing-' + target + '-recovery',
      });
      const firstBatch = await recovering.recoverLedgerBatch(recoveryScope);
      assert.equal(firstBatch.complete, false);
      assert.ok(firstBatch.shardsScanned > 0);

      await assert.rejects(
        recovering.put(createPublication({
          documentId: 'write-during-' + target + '-recovery',
        })),
        error => error?.code === 'PDF_ASSET_RECOVERY_REQUIRED'
      );

      let complete = false;
      for (let batch = 0; batch < 64 && !complete; batch += 1) {
        complete = (await recovering.recoverLedgerBatch(recoveryScope)).complete;
      }
      assert.equal(complete, true);

      await recovering.put(createPublication({
        documentId: 'write-after-' + target + '-recovery',
      }));
      await assert.rejects(
        recovering.put(createPublication({
          documentId: 'overflow-after-' + target + '-recovery',
        })),
        error => error?.code === 'PDF_ASSET_CAPACITY'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('root and scope recovery share one lock so a stale scope clone cannot clear its fence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-recovery-lock-'));
  const limits = { maxRootAssetCount: 1, maxScopeAssetCount: 1 };
  const scope = { tenantId: 'tenant-a', corpusId: 'corpus-a' };
  try {
    const seed = new FilePdfAssetStore(directory, { limits });
    await seed.put(createPublication({ documentId: 'recovery-lock-seed' }));

    const rootRecovery = new FilePdfAssetStore(directory, {
      limits,
      control: { recoveryMaxShardsPerBatch: 256 },
      processEpoch: 'root-lock-recovery',
    });
    const scopeRecovery = new FilePdfAssetStore(directory, {
      limits,
      control: { recoveryMaxShardsPerBatch: 256 },
      processEpoch: 'scope-lock-recovery',
    });
    const rootRecoveryFile = path.join(
      directory,
      '.control',
      'recovery',
      'root.json'
    );
    let reachedScopes = false;
    for (let batch = 0; batch < 10 && !reachedScopes; batch += 1) {
      await rootRecovery.recoverLedgerBatch();
      const cursor = JSON.parse(await readFile(rootRecoveryFile, 'utf8'));
      reachedScopes = cursor.phase === 'scopes';
    }
    assert.equal(reachedScopes, true);

    const originalRootScopeEntry =
      rootRecovery.reconcileRecoveryScopeEntry.bind(rootRecovery);
    let releaseRootScopeEntry;
    const rootScopeEntryGate = new Promise(resolve => {
      releaseRootScopeEntry = resolve;
    });
    let signalRootScopeEntry;
    const rootScopeEntryStarted = new Promise(resolve => {
      signalRootScopeEntry = resolve;
    });
    rootRecovery.reconcileRecoveryScopeEntry = async (...args) => {
      signalRootScopeEntry();
      await rootScopeEntryGate;
      return originalRootScopeEntry(...args);
    };

    const originalScopePrepare =
      scopeRecovery.prepareLedgerRecovery.bind(scopeRecovery);
    let scopePrepareEntered = false;
    scopeRecovery.prepareLedgerRecovery = async (...args) => {
      scopePrepareEntered = true;
      return originalScopePrepare(...args);
    };

    const rootBatchPromise = rootRecovery.recoverLedgerBatch();
    await rootScopeEntryStarted;
    const scopeBatchPromise = scopeRecovery.recoverLedgerBatch(scope);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scopePrepareEntered, false);

    releaseRootScopeEntry();
    assert.equal((await rootBatchPromise).complete, true);
    const firstScopeBatch = await scopeBatchPromise;
    assert.equal(scopePrepareEntered, true);
    assert.equal(firstScopeBatch.complete, false);

    let scopeComplete = false;
    for (let batch = 0; batch < 10 && !scopeComplete; batch += 1) {
      scopeComplete = (await scopeRecovery.recoverLedgerBatch(scope)).complete;
    }
    assert.equal(scopeComplete, true);
    await assert.rejects(
      scopeRecovery.put(createPublication({ documentId: 'recovery-lock-overflow' })),
      error => error?.code === 'PDF_ASSET_CAPACITY'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root recovery removes bounded atomic-write temp debris without stalling', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-recovery-temp-'));
  try {
    const seed = new FilePdfAssetStore(directory);
    await seed.put(createPublication({ documentId: 'recovery-temp' }));

    const reservationId = 'aa000000-0000-4000-8000-000000000000';
    const temporaryId = 'bb000000-0000-4000-8000-000000000000';
    const reservationTemporaryFile = path.join(
      directory,
      '.control',
      'reservations',
      reservationId.slice(0, 2),
      reservationId + '.' + temporaryId + '.tmp'
    );
    await mkdir(path.dirname(reservationTemporaryFile), { recursive: true });
    await writeFile(reservationTemporaryFile, '{');

    const scopeFile = (await findFiles(path.join(directory, '.control', 'scopes')))
      .find(file => file.endsWith('.json'));
    assert.ok(scopeFile);
    const scopeTemporaryFile =
      scopeFile + '.cc000000-0000-4000-8000-000000000000.tmp';
    await writeFile(scopeTemporaryFile, '{');
    await corruptRootLedger(directory);

    const recovering = new FilePdfAssetStore(directory, {
      control: { recoveryMaxShardsPerBatch: 256 },
      processEpoch: 'temp-debris-recovery',
    });
    await completeRootRecovery(recovering);
    assert.equal(
      (await findFiles(directory)).filter(file => file.endsWith('.tmp')).length,
      0
    );
    const rootLedger = JSON.parse(await readFile(
      path.join(directory, '.control', 'root-ledger.json'),
      'utf8'
    ));
    assert.equal(rootLedger.committedCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root recovery resumes the first same-shard manifest deferred by its byte budget', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-recovery-cursor-'));
  try {
    const [firstId, secondId] = findSameShardDocumentIds();
    const seed = new FilePdfAssetStore(directory);
    await seed.put(createPublication({ documentId: firstId }));
    await seed.put(createPublication({ documentId: secondId }));

    const manifestFiles = (await findFiles(directory))
      .filter(file => file.endsWith('manifest.json'));
    assert.equal(manifestFiles.length, 2);
    const manifestSizes = await Promise.all(
      manifestFiles.map(async file => (await readFile(file)).byteLength)
    );
    const oneManifestBudget = Math.max(...manifestSizes);
    await corruptRootLedger(directory);

    const recovering = new FilePdfAssetStore(directory, {
      limits: { maxManifestBytes: oneManifestBudget },
      retention: {
        gcMaxEntries: 8,
        gcMaxBytes: oneManifestBudget,
        gcMaxDurationMs: 1000,
        gcMaxShardEntries: 16,
        gcMaxInvalidEntries: 2,
      },
      control: { recoveryMaxShardsPerBatch: 256 },
      processEpoch: 'byte-recovery-reader',
    });

    const firstBatch = await recovering.recoverLedgerBatch();
    assert.equal(firstBatch.complete, false);
    assert.equal(firstBatch.entriesScanned, 1);
    const recoveryFile = path.join(
      directory,
      '.control',
      'recovery',
      'root.json'
    );
    const firstCursor = JSON.parse(await readFile(recoveryFile, 'utf8'));
    assert.equal(firstCursor.phase, 'bundles');
    assert.ok(firstCursor.lastName);

    const secondBatch = await recovering.recoverLedgerBatch();
    assert.equal(secondBatch.complete, false);
    assert.equal(secondBatch.entriesScanned, 1);
    const secondCursor = JSON.parse(await readFile(recoveryFile, 'utf8'));
    assert.notDeepEqual(
      {
        phase: secondCursor.phase,
        shard: secondCursor.shard,
        lastName: secondCursor.lastName,
      },
      {
        phase: firstCursor.phase,
        shard: firstCursor.shard,
        lastName: firstCursor.lastName,
      }
    );

    await completeRootRecovery(recovering);
    const rootLedger = JSON.parse(await readFile(
      path.join(directory, '.control', 'root-ledger.json'),
      'utf8'
    ));
    assert.equal(rootLedger.committedCount, 2);
    assert.equal(rootLedger.reservedCount, 0);
    assert.equal(Object.keys(rootLedger.activeReservations).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root recovery reconciles published and unpublished put journals without double quota', async () => {
  for (const [index, scenario] of [
    { crashPhase: 'scope-reserved', published: false },
    { crashPhase: 'bundle-published', published: true },
  ].entries()) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-root-recovery-'));
    const limits = { maxRootAssetCount: 1, maxScopeAssetCount: 1 };
    const publication = createPublication({ documentId: 'root-recovery-' + index });
    const identity = pdfAssetIdentityFromManifest(publication.manifest);
    try {
      const crashing = new FilePdfAssetStore(directory, {
        limits,
        processEpoch: 'root-recovery-writer-' + index,
        onPublicationPhase(phase) {
          if (phase !== scenario.crashPhase) return;
          throw simulatedHardCrash();
        },
      });
      await assert.rejects(crashing.put(publication), /simulated hard crash/);
      await corruptRootLedger(directory);

      const recovering = new FilePdfAssetStore(directory, {
        limits,
        processEpoch: 'root-recovery-reader-' + index,
        control: { recoveryMaxShardsPerBatch: 256 },
      });
      await completeRootRecovery(recovering);
      const restarted = new FilePdfAssetStore(directory, { limits });
      if (scenario.published) {
        assert.equal(
          (await restarted.getManifest(identity, createScope())).documentId,
          publication.manifest.documentId
        );
        await restarted.put(publication);
        await assert.rejects(
          restarted.put(createPublication({ documentId: 'root-overflow-' + index })),
          error => error?.code === 'PDF_ASSET_CAPACITY'
        );
      } else {
        assert.equal(await restarted.getManifest(identity, createScope()), null);
        await restarted.put(publication);
        assert.equal(
          (await restarted.getManifest(identity, createScope())).documentId,
          publication.manifest.documentId
        );
      }
      const scopeLedger = await readOnlyScopeLedger(directory);
      assert.equal(scopeLedger.reservedCount, 0);
      assert.equal(Object.keys(scopeLedger.activeReservations).length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('root recovery accounts a delete that crashed after removing its bundle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-delete-recovery-'));
  const limits = { maxRootAssetCount: 1, maxScopeAssetCount: 1 };
  const publication = createPublication({ documentId: 'delete-recovery' });
  const identity = pdfAssetIdentityFromManifest(publication.manifest);
  try {
    const crashing = new FilePdfAssetStore(directory, {
      limits,
      processEpoch: 'delete-recovery-writer',
    });
    await crashing.put(publication);
    crashing.settleReservation = async () => {
      throw simulatedHardCrash();
    };
    await assert.rejects(
      crashing.delete(identity, createScope()),
      /simulated hard crash/
    );
    assert.equal(await crashing.getManifest(identity, createScope()), null);
    await corruptRootLedger(directory);

    const recovering = new FilePdfAssetStore(directory, {
      limits,
      processEpoch: 'delete-recovery-reader',
      control: { recoveryMaxShardsPerBatch: 256 },
    });
    await completeRootRecovery(recovering);
    const restarted = new FilePdfAssetStore(directory, { limits });
    await restarted.put(createPublication({ documentId: 'delete-replacement' }));
    const scopeLedger = await readOnlyScopeLedger(directory);
    assert.equal(scopeLedger.committedCount, 1);
    assert.equal(scopeLedger.reservedCount, 0);
    assert.equal(Object.keys(scopeLedger.activeReservations).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope recovery reconciles a published journal against the healthy root ledger', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-scope-recovery-'));
  const limits = { maxRootAssetCount: 1, maxScopeAssetCount: 1 };
  const publication = createPublication({ documentId: 'scope-recovery' });
  const identity = pdfAssetIdentityFromManifest(publication.manifest);
  try {
    const crashing = new FilePdfAssetStore(directory, {
      limits,
      processEpoch: 'scope-recovery-writer',
      onPublicationPhase(phase) {
        if (phase === 'bundle-published') throw simulatedHardCrash();
      },
    });
    await assert.rejects(crashing.put(publication), /simulated hard crash/);
    const scopeFile = (await findFiles(path.join(directory, '.control', 'scopes')))
      .find(file => file.endsWith('.json'));
    const forgedScope = JSON.parse(await readFile(scopeFile, 'utf8'));
    forgedScope.generation += 1;
    await writeFile(scopeFile, JSON.stringify(forgedScope));

    const recovering = new FilePdfAssetStore(directory, {
      limits,
      processEpoch: 'scope-recovery-reader',
      control: { recoveryMaxShardsPerBatch: 256 },
    });
    let complete = false;
    for (let batch = 0; batch < 10 && !complete; batch += 1) {
      complete = (await recovering.recoverLedgerBatch({
        tenantId: 'tenant-a',
        corpusId: 'corpus-a',
      })).complete;
    }
    assert.equal(complete, true);
    const restarted = new FilePdfAssetStore(directory, { limits });
    assert.equal(
      (await restarted.getManifest(identity, createScope())).documentId,
      'scope-recovery'
    );
    await restarted.put(publication);
    await assert.rejects(
      restarted.put(createPublication({ documentId: 'scope-overflow' })),
      error => error?.code === 'PDF_ASSET_CAPACITY'
    );
    const scopeLedger = await readOnlyScopeLedger(directory);
    assert.equal(scopeLedger.committedCount, 1);
    assert.equal(scopeLedger.reservedCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope lifecycle reclaims zero scopes and remains bounded across churn and rebuild', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-scope-churn-'));
  const options = {
    limits: { maxRootAssetCount: 2, maxScopeAssetCount: 1 },
    control: { maxScopeLedgers: 2, recoveryMaxShardsPerBatch: 256 },
  };
  try {
    const store = new FilePdfAssetStore(directory, options);
    for (let index = 0; index < 8; index += 1) {
      const tenantId = `tenant-churn-${index}`;
      const corpusId = `corpus-churn-${index}`;
      const publication = createPublication({
        tenantId,
        corpusId,
        documentId: `scope-churn-${index}`,
      });
      const scope = createScope({ tenantId, corpusId });
      await store.put(publication);
      assert.equal(
        await store.delete(pdfAssetIdentityFromManifest(publication.manifest), scope),
        true
      );
      assert.equal(
        (await findFiles(path.join(directory, '.control', 'scopes'))).length,
        0
      );
      assert.equal(
        (await findFiles(path.join(directory, '.control', 'scope-markers'))).length,
        0
      );
      const root = JSON.parse(await readFile(
        path.join(directory, '.control', 'root-ledger.json'),
        'utf8'
      ));
      assert.deepEqual(root.scopeLifecycles, {});
    }

    const live = createPublication({
      tenantId: 'tenant-live',
      corpusId: 'corpus-live',
      documentId: 'scope-live',
    });
    const liveScope = createScope({ tenantId: 'tenant-live', corpusId: 'corpus-live' });
    await store.put(live);
    await corruptRootLedger(directory);
    const recovering = new FilePdfAssetStore(directory, {
      ...options,
      processEpoch: 'scope-churn-recovery',
    });
    await completeRootRecovery(recovering);
    const restarted = new FilePdfAssetStore(directory, options);
    assert.equal(
      (await restarted.getManifest(
        pdfAssetIdentityFromManifest(live.manifest),
        liveScope
      )).documentId,
      'scope-live'
    );
    assert.equal(
      await restarted.delete(pdfAssetIdentityFromManifest(live.manifest), liveScope),
      true
    );
    assert.equal(
      (await findFiles(path.join(directory, '.control', 'scopes'))).length,
      0
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope reclaim transaction resumes after a hard crash without leaking its slot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-scope-reclaim-crash-'));
  const options = { control: { maxScopeLedgers: 1 } };
  const publication = createPublication({ documentId: 'scope-reclaim-crash' });
  const identity = pdfAssetIdentityFromManifest(publication.manifest);
  try {
    const crashing = new FilePdfAssetStore(directory, options);
    await crashing.put(publication);
    crashing.reclaimScopeLifecycle = async () => {
      throw simulatedHardCrash();
    };
    await assert.rejects(
      crashing.delete(identity, createScope()),
      /simulated hard crash/
    );
    const crashedRoot = JSON.parse(await readFile(
      path.join(directory, '.control', 'root-ledger.json'),
      'utf8'
    ));
    assert.deepEqual(Object.values(crashedRoot.scopeLifecycles), ['reclaiming']);

    const restarted = new FilePdfAssetStore(directory, options);
    await restarted.put(publication);
    const repairedRoot = JSON.parse(await readFile(
      path.join(directory, '.control', 'root-ledger.json'),
      'utf8'
    ));
    assert.deepEqual(Object.values(repairedRoot.scopeLifecycles), ['active']);
    assert.equal(repairedRoot.committedCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root rebuild accepts a root-settled journal after its zero scope was reclaimed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-reclaim-root-rebuild-'));
  const options = {
    control: { maxScopeLedgers: 2, recoveryMaxShardsPerBatch: 256 },
  };
  const deleted = createPublication({ documentId: 'reclaimed-before-rebuild' });
  const deletedIdentity = pdfAssetIdentityFromManifest(deleted.manifest);
  const live = createPublication({
    tenantId: 'tenant-live-after-reclaim',
    corpusId: 'corpus-live-after-reclaim',
    documentId: 'live-during-root-rebuild',
  });
  const liveScope = createScope({
    tenantId: 'tenant-live-after-reclaim',
    corpusId: 'corpus-live-after-reclaim',
  });
  try {
    const crashing = new FilePdfAssetStore(directory, options);
    await crashing.put(deleted);
    crashing.reclaimScopeLifecycle = async () => {
      throw simulatedHardCrash();
    };
    await assert.rejects(
      crashing.delete(deletedIdentity, createScope()),
      /simulated hard crash/
    );

    const restarted = new FilePdfAssetStore(directory, {
      ...options,
      processEpoch: 'reclaim-before-root-rebuild',
    });
    await restarted.put(live);
    await rm(path.join(directory, '.control', 'root-ledger.json'));

    const recovering = new FilePdfAssetStore(directory, {
      ...options,
      processEpoch: 'root-rebuild-after-reclaim',
    });
    await completeRootRecovery(recovering);

    assert.equal(
      (await recovering.getManifest(
        pdfAssetIdentityFromManifest(live.manifest),
        liveScope
      )).documentId,
      'live-during-root-rebuild'
    );
    assert.deepEqual(
      await findFiles(path.join(directory, '.control', 'reservations')),
      []
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root-settled journals cannot mask a missing scope with a live bundle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-live-scope-missing-'));
  const options = {
    control: { recoveryMaxShardsPerBatch: 256 },
  };
  const publication = createPublication({ documentId: 'live-scope-missing' });
  try {
    const crashing = new FilePdfAssetStore(directory, {
      ...options,
      processEpoch: 'live-scope-missing-writer',
      onPublicationPhase(phase) {
        if (phase === 'root-committed') throw simulatedHardCrash();
      },
    });
    await assert.rejects(crashing.put(publication), /simulated hard crash/);

    const scopeLedgers = (await findFiles(
      path.join(directory, '.control', 'scopes')
    )).filter(file => file.endsWith('.json'));
    const scopeMarkers = (await findFiles(
      path.join(directory, '.control', 'scope-markers')
    )).filter(file => file.endsWith('.json'));
    assert.equal(scopeLedgers.length, 1);
    assert.equal(scopeMarkers.length, 1);
    await rm(scopeLedgers[0]);
    await rm(scopeMarkers[0]);
    await rm(path.join(directory, '.control', 'root-ledger.json'));

    const recovering = new FilePdfAssetStore(directory, {
      ...options,
      processEpoch: 'live-scope-missing-recovery',
    });
    assert.equal((await recovering.recoverLedgerBatch()).complete, false);
    await assert.rejects(
      recovering.recoverLedgerBatch(),
      /requires explicit recovery of a damaged scope ledger/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent GC batches serialize the persistent cursor without regression', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-gc-serialize-'));
  let now = 0;
  const retention = {
    retentionMs: 1_000,
    gcMaxEntries: 64,
    gcMaxDurationMs: 50,
  };
  const [firstDocumentId, secondDocumentId] = findDocumentIdsForShard('08', 2);
  try {
    const seed = new FilePdfAssetStore(directory, {
      retention,
      clock: () => new Date(now),
    });
    await seed.put(createPublication({ documentId: firstDocumentId, now: new Date(0) }));
    await seed.put(createPublication({ documentId: secondDocumentId, now: new Date(0) }));
    now = 2_000;

    const slow = new FilePdfAssetStore(directory, {
      retention,
      clock: () => new Date(now),
    });
    const fast = new FilePdfAssetStore(directory, {
      retention,
      clock: () => new Date(now),
    });
    const originalRead = slow.readStoredEnvelopeAt.bind(slow);
    let releaseSlow;
    let notifyEntered;
    const entered = new Promise(resolve => { notifyEntered = resolve; });
    const gate = new Promise(resolve => { releaseSlow = resolve; });
    let paused = false;
    slow.readStoredEnvelopeAt = async (...args) => {
      if (!paused) {
        paused = true;
        notifyEntered();
        await gate;
      }
      return originalRead(...args);
    };

    const slowRun = slow.runGarbageCollectionBatch();
    await entered;
    let fastSettled = false;
    const fastRun = fast.runGarbageCollectionBatch().then(result => {
      fastSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(fastSettled, false);
    releaseSlow();
    await slowRun;
    const fastResult = await fastRun;
    const root = JSON.parse(await readFile(
      path.join(directory, '.control', 'root-ledger.json'),
      'utf8'
    ));
    assert.deepEqual(root.gcCursor, fastResult.cursor);
    assert.equal(root.committedCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded GC removes every expired atomic temp family and preserves fresh or active temps', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-control-temp-gc-'));
  const publication = createPublication({ documentId: 'control-temp-gc' });
  const oldTimestamp = Date.now() - 2 * 60 * 60 * 1_000;
  const writeId = 'bb000000-0000-4000-8000-000000000000';
  try {
    const seed = new FilePdfAssetStore(directory);
    await seed.put(publication);
    const scopeFile = (await findFiles(path.join(directory, '.control', 'scopes')))
      .find(file => file.endsWith('.json'));
    assert.ok(scopeFile);
    const scopeDigest = path.basename(scopeFile, '.json');
    const reservationId = 'aa000000-0000-4000-8000-000000000000';
    const expiredTemps = [
      {
        phase: 'reservations',
        shard: Number.parseInt(reservationId.slice(0, 2), 16),
        file: path.join(
          directory,
          '.control',
          'reservations',
          reservationId.slice(0, 2),
          `${reservationId}.${oldTimestamp}.${writeId}.tmp`
        ),
      },
      {
        phase: 'scope-control',
        shard: Number.parseInt(scopeDigest.slice(0, 2), 16),
        file: `${scopeFile}.${oldTimestamp}.${writeId}.tmp`,
      },
      {
        phase: 'control-root-temps',
        shard: 0,
        file: path.join(
          directory,
          '.control',
          `root-ledger.json.${oldTimestamp}.${writeId}.tmp`
        ),
      },
      {
        phase: 'recovery-root-temps',
        shard: 0,
        file: path.join(
          directory,
          '.control',
          'recovery',
          `root.json.${oldTimestamp}.${writeId}.tmp`
        ),
      },
      {
        phase: 'recovery-scope-temps',
        shard: Number.parseInt(scopeDigest.slice(0, 2), 16),
        file: path.join(
          directory,
          '.control',
          'recovery',
          'scopes',
          scopeDigest.slice(0, 2),
          `${scopeDigest}.json.${oldTimestamp}.${writeId}.tmp`
        ),
      },
    ];
    for (const temporary of expiredTemps) {
      await mkdir(path.dirname(temporary.file), { recursive: true });
      await writeFile(temporary.file, '{');
    }
    const cleaner = new FilePdfAssetStore(directory, {
      clock: () => new Date(Date.now() + 2 * 60 * 60 * 1_000),
    });
    for (const temporary of expiredTemps) {
      await setGcCursor(directory, {
        phase: temporary.phase,
        shard: temporary.shard,
        lastName: null,
      });
      await cleaner.runGarbageCollectionBatch();
    }
    const remaining = new Set(await findFiles(directory));
    for (const temporary of expiredTemps) assert.equal(remaining.has(temporary.file), false);

    const freshFile = path.join(
      directory,
      '.control',
      `root-ledger.json.${Date.now()}.${writeId}.tmp`
    );
    await writeFile(freshFile, '{');
    await setGcCursor(directory, {
      phase: 'control-root-temps',
      shard: 0,
      lastName: null,
    });
    await new FilePdfAssetStore(directory).runGarbageCollectionBatch();
    assert.equal((await findFiles(directory)).includes(freshFile), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('atomic reservation temp GC preserves a current-process active writer', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e6-pdf-active-temp-'));
  let reservationId;
  const processEpoch = 'active-temp-process';
  try {
    const crashing = new FilePdfAssetStore(directory, {
      processEpoch,
      onPublicationPhase(phase, id) {
        if (phase !== 'root-reserved') return;
        reservationId = id;
        throw simulatedHardCrash();
      },
    });
    await assert.rejects(
      crashing.put(createPublication({ documentId: 'active-temp' })),
      /simulated hard crash/
    );
    assert.ok(reservationId);
    const oldTimestamp = Date.now() - 2 * 60 * 60 * 1_000;
    const temporary = path.join(
      directory,
      '.control',
      'reservations',
      reservationId.slice(0, 2),
      `${reservationId}.${oldTimestamp}.bb000000-0000-4000-8000-000000000000.tmp`
    );
    await writeFile(temporary, '{');
    await setGcCursor(directory, {
      phase: 'reservations',
      shard: Number.parseInt(reservationId.slice(0, 2), 16),
      lastName: null,
    });
    const cleaner = new FilePdfAssetStore(directory, {
      processEpoch,
      clock: () => new Date(Date.now() + 2 * 60 * 60 * 1_000),
    });
    await cleaner.runGarbageCollectionBatch();
    assert.equal((await findFiles(directory)).includes(temporary), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function findSameShardDocumentIds() {
  const firstByShard = new Map();
  for (let index = 0; index < 10_000; index += 1) {
    const documentId = 'same-shard-' + index;
    const identityKey = JSON.stringify([
      'tenant-a',
      'corpus-a',
      documentId,
      'sha256:v1',
      'reviewed',
    ]);
    const digest = createHash('sha256').update(identityKey).digest('hex');
    const shard = digest.slice(0, 2);
    const first = firstByShard.get(shard);
    if (first) return [first.documentId, documentId];
    firstByShard.set(shard, { documentId, digest });
  }
  throw new Error('Unable to find two deterministic PDF identities in one shard.');
}

function findDocumentIdsForShard(targetShard, count) {
  const documentIds = [];
  for (let index = 0; index < 100_000 && documentIds.length < count; index += 1) {
    const documentId = `target-shard-${targetShard}-${index}`;
    const identityKey = JSON.stringify([
      'tenant-a',
      'corpus-a',
      documentId,
      'sha256:v1',
      'reviewed',
    ]);
    const digest = createHash('sha256').update(identityKey).digest('hex');
    if (digest.startsWith(targetShard)) documentIds.push(documentId);
  }
  if (documentIds.length === count) return documentIds;
  throw new Error(`Unable to find ${count} identities in shard ${targetShard}.`);
}

function simulatedHardCrash() {
  return Object.assign(new Error('simulated hard crash'), {
    code: 'PDF_ASSET_SIMULATED_HARD_CRASH',
  });
}

async function corruptRootLedger(directory) {
  const ledgerFile = path.join(directory, '.control', 'root-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  ledger.generation += 1;
  await writeFile(ledgerFile, JSON.stringify(ledger));
}

async function completeRootRecovery(store) {
  for (let batch = 0; batch < 10; batch += 1) {
    const result = await store.recoverLedgerBatch();
    assert.ok(result.shardsScanned <= 256);
    if (result.complete) return;
  }
  assert.fail('PDF root ledger recovery did not complete within bounded phases.');
}

async function readOnlyScopeLedger(directory) {
  const files = (await findFiles(path.join(directory, '.control', 'scopes')))
    .filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(files[0], 'utf8'));
}

async function setGcCursor(directory, cursor) {
  const ledgerFile = path.join(directory, '.control', 'root-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  ledger.gcCursor = cursor;
  const { digest: _digest, ...payload } = ledger;
  void _digest;
  ledger.digest = createHash('sha256')
    .update(JSON.stringify(sortCanonical(payload)))
    .digest('hex');
  await writeFile(ledgerFile, JSON.stringify(ledger));
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, sortCanonical(value[key])])
    );
  }
  return value;
}

function createPublication({
  bytes = PNG_BYTES,
  pageCount = 1,
  documentId = 'document-a',
  documentVersion = 'sha256:v1',
  tenantId = 'tenant-a',
  corpusId = 'corpus-a',
  trustLevel = 'reviewed',
  now = new Date('2026-07-17T00:00:00.000Z'),
} = {}) {
  const scope = createScope({
    tenantId,
    corpusId,
    allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
  });
  const pageTexts = Array.from({ length: pageCount }, (_, index) => `page ${index + 1}!!`);
  const manifest = buildPdfAssetManifest({
    source: new TextEncoder().encode('stable-pdf-source'),
    sourceName: 'source.pdf',
    documentId,
    documentVersion,
    parsed: {
      text: pageTexts.join('\n\f\n'),
      pages: pageCount,
      pageTexts,
      parseMethod: 'pdf-parse-v2',
    },
    scope,
    trustLevel,
    pageImages: [{
      pageNumber: 1,
      imageRef: 'pdf-assets/source/page-0001.png',
      contentDigest: sha256Hex(bytes),
      width: 1,
      height: 1,
      byteLength: bytes.byteLength,
      mimeType: 'image/png',
    }],
    now,
  });
  return {
    manifest,
    pageImages: [{ pageNumber: 1, bytes: Uint8Array.from(bytes) }],
  };
}

function createScope(overrides = {}) {
  return createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted', 'reviewed', 'external'],
    enforceIsolation: true,
    ...overrides,
  });
}

function createExpectedPageFile(directory, identity, page) {
  const identityKey = JSON.stringify([
    identity.tenantId,
    identity.corpusId,
    identity.documentId,
    identity.documentVersion,
    identity.trustLevel,
  ]);
  const identityDigest = createHash('sha256').update(identityKey).digest('hex');
  const refDigest = createHash('sha256').update(page.imageRef).digest('hex');
  return path.join(
    directory,
    identityDigest.slice(0, 2),
    identityDigest,
    'pages',
    `${String(page.pageNumber).padStart(4, '0')}-${refDigest}.bin`
  );
}

async function findFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => {
      const value = path.join(directory, entry.name);
      return entry.isDirectory() ? findFiles(value) : [value];
    }));
    return nested.flat();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
