import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
  assertDurableWorkflowTopology,
  getDurableWorkflowRuntime,
  resolveDurableWorkflowRuntimeConfig,
} = await import('./durable-workflow-runtime.ts');

const INTEGRITY_KEY = 'e7-runtime-integrity-key-0123456789abcdef';

test('runtime env parsing is bounded and the same config reuses one process singleton', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-runtime-'));
  try {
    const env = {
      RAG_DURABLE_WORKFLOW_STORE_ROOT: directory,
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_BYTES: '2097152',
      RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS: '128',
      RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS: '16',
      RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_ROOT_BYTES: '536870912',
      RAG_DURABLE_WORKFLOW_MAX_THREADS: '7',
      RAG_DURABLE_WORKFLOW_MAX_TOMBSTONES: '5',
      RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS: '60000',
      RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS: '120000',
      RAG_DURABLE_WORKFLOW_TEMP_TTL_MS: '180000',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_BYTES: '1048576',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS: '11',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES: '134217728',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_ARTIFACTS: '5',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_BYTES: '67108864',
      RAG_DURABLE_WORKFLOW_RESULT_ORPHAN_TTL_MS: '240000',
      RAG_DURABLE_WORKFLOW_RESULT_TEMP_TTL_MS: '300000',
      RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_ENTRIES: '17',
      RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES: '2097152',
      RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_DURATION_MS: '250',
      RAG_DURABLE_WORKFLOW_RESULT_REBUILD_MAX_DURATION_MS: '1000',
      RAG_DURABLE_WORKFLOW_MULTI_INSTANCE: 'false',
      RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE: 'false',
      RAG_DURABLE_WORKFLOW_CONTROL_PLANE: 'file',
    };
    const config = resolveDurableWorkflowRuntimeConfig(env);
    assert.equal(config.rootDir, path.resolve(directory));
    assert.equal(config.checkpointMaxSerializedBytes, 2097152);
    assert.equal(config.checkpointMaxRevisionFiles, 128);
    assert.equal(config.checkpointMaxRetainedRevisionFiles, 16);
    assert.equal(config.checkpointMaxRootReservedBytes, 536870912);
    assert.equal(config.checkpointMaxThreads, 7);
    assert.equal(config.checkpointMaxTombstones, 5);
    assert.equal(config.checkpointTombstoneRetentionMs, 60000);
    assert.equal(config.checkpointOrphanReservationTtlMs, 120000);
    assert.equal(config.checkpointTemporaryFileTtlMs, 180000);
    assert.equal(config.resultMaxBytes, 1048576);
    assert.equal(config.resultMaxArtifacts, 11);
    assert.equal(config.resultMaxRootBytes, 134217728);
    assert.equal(config.resultMaxScopeArtifacts, 5);
    assert.equal(config.resultMaxScopeBytes, 67108864);
    assert.equal(config.resultOrphanTtlMs, 240000);
    assert.equal(config.resultTemporaryFileTtlMs, 300000);
    assert.equal(config.resultGcMaxEntries, 17);
    assert.equal(config.resultGcMaxBytes, 2097152);
    assert.equal(config.resultGcMaxDurationMs, 250);
    assert.equal(config.resultRebuildMaxDurationMs, 1000);
    assert.equal('integrityKey' in config, false);
    assert.equal(JSON.stringify(config).includes(INTEGRITY_KEY), false);

    const first = getDurableWorkflowRuntime(env);
    const second = getDurableWorkflowRuntime({ ...env });
    assert.equal(first, second);
    assert.equal(first.checkpointStore, second.checkpointStore);
    assert.equal(first.resultStore, second.resultStore);
    assert.equal(first.integrityKey, INTEGRITY_KEY);
    assert.equal(first.checkpointStore.maxThreads, 7);
    assert.equal(first.checkpointStore.maxRetainedRevisionFiles, 16);
    assert.equal(first.checkpointStore.maxRootReservedBytes, 536870912);
    assert.equal(first.checkpointStore.maxTombstones, 5);
    assert.equal(first.checkpointStore.tombstoneRetentionMs, 60000);
    assert.equal(first.checkpointStore.orphanReservationTtlMs, 120000);
    assert.equal(first.checkpointStore.temporaryFileTtlMs, 180000);
    assert.equal(first.resultStore.maxArtifacts, 11);
    assert.equal(first.resultStore.maxRootBytes, 134217728);
    assert.equal(first.resultStore.maxScopeArtifacts, 5);
    assert.equal(first.resultStore.maxScopeBytes, 67108864);
    assert.equal(first.resultStore.orphanTtlMs, 240000);
    assert.equal(first.resultStore.temporaryFileTtlMs, 300000);
    assert.equal(first.resultStore.gcMaxEntries, 17);
    assert.equal(first.resultStore.gcMaxBytes, 2097152);
    assert.equal(first.resultStore.gcMaxDurationMs, 250);
    assert.equal(first.resultStore.rebuildMaxDurationMs, 1000);
    assert.equal(JSON.stringify(first.config).includes(INTEGRITY_KEY), false);
    assert.equal(JSON.stringify(first).includes(INTEGRITY_KEY), false);
    assert.equal(Object.keys(first).includes('integrityKey'), false);
    assert.equal(first.checkpointStore.coordination, 'process');
    assert.equal(first.resultStore.coordination, 'process');
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime rejects missing secrets, malformed env, and values beyond hard limits', () => {
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({}),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_MULTI_INSTANCE: 'yes',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS: '10001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_MAX_THREADS: '10001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS: '10001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES: '137438953473',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS: '2',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_ARTIFACTS: '3',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES: '1048576',
      RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_BYTES: '1048577',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  for (const [name, value] of [
    ['RAG_DURABLE_WORKFLOW_RESULT_ORPHAN_TTL_MS', '2592000001'],
    ['RAG_DURABLE_WORKFLOW_RESULT_TEMP_TTL_MS', '2592000001'],
    ['RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_ENTRIES', '1025'],
    ['RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES', '1073741825'],
    ['RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_DURATION_MS', '10001'],
    ['RAG_DURABLE_WORKFLOW_RESULT_REBUILD_MAX_DURATION_MS', '30001'],
  ]) {
    assert.throws(
      () => resolveDurableWorkflowRuntimeConfig({
        RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
        [name]: value,
      }),
      error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
    );
  }
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_RESULT_MAX_BYTES: '1048576',
      RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES: '1048576',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_CONTROL_PLANE: 'unknown',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS: '257',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_MAX_TOMBSTONES: '10001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS: '31536000001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS: '8',
      RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS: '9',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS: '2592000001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => resolveDurableWorkflowRuntimeConfig({
      RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
      RAG_DURABLE_WORKFLOW_TEMP_TTL_MS: '2592000001',
    }),
    error => error?.code === 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  );
});

test('multi-instance and shared-control-plane requests reject process-only stores stably', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-e7-runtime-topology-'));
  try {
    for (const overrides of [
      { RAG_DURABLE_WORKFLOW_MULTI_INSTANCE: 'true' },
      { RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE: 'true' },
      { RAG_DURABLE_WORKFLOW_CONTROL_PLANE: 'shared' },
    ]) {
      assert.throws(
        () => getDurableWorkflowRuntime({
          RAG_DURABLE_WORKFLOW_STORE_ROOT: directory,
          RAG_DURABLE_WORKFLOW_INTEGRITY_KEY: INTEGRITY_KEY,
          ...overrides,
        }),
        error => error?.code === 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED'
      );
    }

    assert.doesNotThrow(() => assertDurableWorkflowTopology({
      checkpointStore: {
        providerId: 'shared-checkpoints',
        coordination: 'shared',
      },
      resultStore: {
        providerId: 'shared-results',
        coordination: 'shared',
      },
      multiInstance: true,
    }));
    assert.throws(
      () => assertDurableWorkflowTopology({
        checkpointStore: {
          providerId: 'shared-checkpoints',
          coordination: 'shared',
        },
        resultStore: {
          providerId: 'process-results',
          coordination: 'process',
        },
        requireSharedControlPlane: true,
      }),
      error => error?.code === 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
