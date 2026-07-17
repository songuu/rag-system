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
  PdfVisualSharedStoreRequiredError,
  assertPdfVisualControlPlaneTopology,
  getPdfVisualAssetRuntime,
  resolvePdfVisualModel,
} = await import('./pdf-visual-runtime.ts');

test('PDF visual runtime rejects a multi-instance topology before store use', () => {
  for (const key of [
    'RAG_PDF_VISUAL_MULTI_INSTANCE',
    'RAG_PDF_VISUAL_REQUIRE_SHARED_CONTROL_PLANE',
  ]) {
    assert.throws(
      () => assertPdfVisualControlPlaneTopology({ [key]: 'true' }),
      error => error instanceof PdfVisualSharedStoreRequiredError
        && error.code === 'RAG_PDF_VISUAL_SHARED_STORE_REQUIRED'
        && error.status === 503
    );
  }
  assert.doesNotThrow(() => assertPdfVisualControlPlaneTopology({
    RAG_PDF_VISUAL_MULTI_INSTANCE: 'false',
  }));
});

test('PDF visual runtime resolves bounded server configuration and reuses one process store', () => {
  const env = {
    RAG_PDF_VISUAL_STORE_ROOT: 'C:/tmp/pdf-runtime-a',
    RAG_PDF_VISUAL_RENDER_WIDTH: '1024',
    RAG_PDF_VISUAL_MAX_RENDER_PAGES: '7',
    RAG_PDF_VISUAL_MAX_ROOT_ASSETS: '17',
    RAG_PDF_VISUAL_MAX_ROOT_BYTES: '8192',
    RAG_PDF_VISUAL_MAX_SCOPE_ASSETS: '5',
    RAG_PDF_VISUAL_MAX_SCOPE_BYTES: '4096',
    RAG_PDF_VISUAL_RETENTION_MS: '60000',
    RAG_PDF_VISUAL_ORPHAN_RETENTION_MS: '1000',
    RAG_PDF_VISUAL_GC_MAX_ENTRIES: '8',
    RAG_PDF_VISUAL_GC_MAX_BYTES: '1048576',
    RAG_PDF_VISUAL_GC_MAX_DURATION_MS: '250',
    RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES: '32',
    RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES: '4',
    RAG_PDF_VISUAL_LEDGER_MAX_BYTES: '131072',
    RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS: '11',
    RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS: '7',
    RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES: '1024',
    RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS: '9',
    RAG_PDF_VISUAL_MAX_CONCURRENT_RENDERS: '2',
    RAG_PDF_VISUAL_MAX_IN_FLIGHT_SOURCE_BYTES: '2048',
  };
  const first = getPdfVisualAssetRuntime(env);
  const second = getPdfVisualAssetRuntime(env);

  assert.equal(first.store, second.store);
  assert.equal(first.renderer, second.renderer);
  assert.equal(first.store.coordination, 'process');
  assert.equal(first.renderWidth, 1024);
  assert.equal(first.maxRenderPages, 7);
  assert.equal(first.storeLimits.maxRootAssetCount, 17);
  assert.equal(first.storeLimits.maxRootTotalBytes, 8192);
  assert.equal(first.storeLimits.maxScopeAssetCount, 5);
  assert.equal(first.storeLimits.maxScopeTotalBytes, 4096);
  assert.deepEqual(first.storeRetention, {
    retentionMs: 60000,
    orphanRetentionMs: 1000,
    gcMaxEntries: 8,
    gcMaxBytes: 1048576,
    gcMaxDurationMs: 250,
    gcMaxShardEntries: 32,
    gcMaxInvalidEntries: 4,
  });
  assert.deepEqual(first.storeControl, {
    maxLedgerBytes: 131072,
    maxScopeLedgers: 11,
    maxInflightReservations: 7,
    reservationOverheadBytes: 1024,
    recoveryMaxShardsPerBatch: 9,
  });
  assert.equal(first.maxConcurrentRenders, 2);
  assert.equal(first.maxInFlightSourceBytes, 2048);
  assert.notEqual(
    getPdfVisualAssetRuntime({ ...env, RAG_PDF_VISUAL_MAX_ROOT_ASSETS: '18' }).store,
    first.store
  );
  assert.notEqual(
    getPdfVisualAssetRuntime({ ...env, RAG_PDF_VISUAL_MAX_CONCURRENT_RENDERS: '3' }).renderer,
    first.renderer
  );

  assert.throws(
    () => getPdfVisualAssetRuntime({
      ...env,
      RAG_PDF_VISUAL_RENDER_WIDTH: '2049',
    }),
    /between 1 and 2048/
  );
  assert.throws(
    () => getPdfVisualAssetRuntime({
      ...env,
      RAG_PDF_VISUAL_MAX_RENDER_PAGES: '101',
    }),
    /between 1 and 100/
  );
});

test('PDF visual runtime rejects quota, retention, and renderer admission above hard bounds', () => {
  const invalid = [
    ['RAG_PDF_VISUAL_MAX_ROOT_ASSETS', '100001'],
    ['RAG_PDF_VISUAL_MAX_ROOT_BYTES', String(512 * 1024 * 1024 * 1024 + 1)],
    ['RAG_PDF_VISUAL_MAX_SCOPE_ASSETS', '50001'],
    ['RAG_PDF_VISUAL_MAX_SCOPE_BYTES', String(128 * 1024 * 1024 * 1024 + 1)],
    ['RAG_PDF_VISUAL_RETENTION_MS', String(365 * 24 * 60 * 60 * 1000 + 1)],
    ['RAG_PDF_VISUAL_ORPHAN_RETENTION_MS', String(7 * 24 * 60 * 60 * 1000 + 1)],
    ['RAG_PDF_VISUAL_GC_MAX_ENTRIES', '4097'],
    ['RAG_PDF_VISUAL_GC_MAX_BYTES', String(1024 * 1024 - 1)],
    ['RAG_PDF_VISUAL_GC_MAX_BYTES', String(1024 * 1024 * 1024 + 1)],
    ['RAG_PDF_VISUAL_GC_MAX_DURATION_MS', '5001'],
    ['RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES', '100001'],
    ['RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES', '1025'],
    ['RAG_PDF_VISUAL_LEDGER_MAX_BYTES', String(16 * 1024 * 1024 + 1)],
    ['RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS', '1025'],
    ['RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES', String(1024 * 1024 + 1)],
    ['RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS', '257'],
    ['RAG_PDF_VISUAL_MAX_CONCURRENT_RENDERS', '65'],
    ['RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS', '100001'],
    ['RAG_PDF_VISUAL_MAX_IN_FLIGHT_SOURCE_BYTES', String(2 * 1024 * 1024 * 1024 + 1)],
  ];
  for (const [field, value] of invalid) {
    assert.throws(
      () => getPdfVisualAssetRuntime({ [field]: value }),
      new RegExp(field + ' must be between')
    );
  }
});
test('PDF visual model capability is server-owned and bounded', () => {
  assert.equal(resolvePdfVisualModel({}), undefined);
  assert.equal(
    resolvePdfVisualModel({ RAG_PDF_VISUAL_MODEL: ' vision-model-a ' }),
    'vision-model-a'
  );
  assert.throws(
    () => resolvePdfVisualModel({ RAG_PDF_VISUAL_MODEL: 'x'.repeat(129) }),
    /invalid/
  );
});
