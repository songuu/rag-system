import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  FILE_DURABLE_CHECKPOINT_HARD_LIMITS,
  FileDurableCheckpointStore,
} from './durable-file-checkpoint-store';
import {
  DURABLE_ASK_RESULT_HARD_LIMITS,
  FileDurableAskResultArtifactStore,
} from './durable-result-artifact-store';

export type DurableWorkflowCoordination = 'process' | 'shared';

export interface DurableWorkflowRuntimeConfig {
  rootDir: string;
  checkpointMaxSerializedBytes: number;
  checkpointMaxRevisionFiles: number;
  checkpointMaxRetainedRevisionFiles: number;
  checkpointMaxThreads: number;
  checkpointMaxRootReservedBytes: number;
  checkpointMaxTombstones: number;
  checkpointTombstoneRetentionMs: number;
  checkpointOrphanReservationTtlMs: number;
  checkpointTemporaryFileTtlMs: number;
  resultMaxBytes: number;
  resultMaxArtifacts: number;
  resultMaxRootBytes: number;
  resultMaxScopeArtifacts: number;
  resultMaxScopeBytes: number;
  resultOrphanTtlMs: number;
  resultTemporaryFileTtlMs: number;
  resultGcMaxEntries: number;
  resultGcMaxBytes: number;
  resultGcMaxDurationMs: number;
  resultRebuildMaxDurationMs: number;
  multiInstance: boolean;
  requireSharedControlPlane: boolean;
  requestedControlPlane: 'file' | 'shared';
}

export interface DurableWorkflowRuntime {
  config: Readonly<DurableWorkflowRuntimeConfig>;
  integrityKey: string;
  checkpointStore: FileDurableCheckpointStore;
  resultStore: FileDurableAskResultArtifactStore;
}

export interface DurableWorkflowTopologyStore {
  providerId: string;
  coordination: DurableWorkflowCoordination;
}

export type DurableWorkflowRuntimeErrorCode =
  | 'DURABLE_WORKFLOW_CONFIGURATION_INVALID'
  | 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED';

export class DurableWorkflowRuntimeError extends Error {
  readonly code: DurableWorkflowRuntimeErrorCode;

  constructor(code: DurableWorkflowRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'DurableWorkflowRuntimeError';
    this.code = code;
  }
}

const runtimeCache = new Map<string, DurableWorkflowRuntime>();

export function resolveDurableWorkflowRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): DurableWorkflowRuntimeConfig {
  const rootValue = env.RAG_DURABLE_WORKFLOW_STORE_ROOT?.trim();
  if (rootValue && /[\u0000-\u001f]/.test(rootValue)) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_STORE_ROOT contains control characters.'
    );
  }
  readIntegrityKey(env);
  const rootDir = rootValue
    ? path.resolve(/*turbopackIgnore: true*/ rootValue)
    : path.join(process.cwd(), 'uploads', 'rag-durable-workflows-v1');
  const requestedControlPlane = parseControlPlane(
    env.RAG_DURABLE_WORKFLOW_CONTROL_PLANE
  );
  const resultMaxBytes = parseBoundedInteger(
    env.RAG_DURABLE_WORKFLOW_RESULT_MAX_BYTES,
    4 * 1024 * 1024,
    DURABLE_ASK_RESULT_HARD_LIMITS.maxResultBytes,
    'RAG_DURABLE_WORKFLOW_RESULT_MAX_BYTES'
  );
  const resultMaxArtifacts = parseBoundedInteger(
    env.RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS,
    2000,
    DURABLE_ASK_RESULT_HARD_LIMITS.maxArtifacts,
    'RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS'
  );
  const resultMaxRootBytes = parseBoundedInteger(
    env.RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES,
    16 * 1024 * 1024 * 1024,
    DURABLE_ASK_RESULT_HARD_LIMITS.maxRootBytes,
    'RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES'
  );
  const config: DurableWorkflowRuntimeConfig = {
    rootDir,
    checkpointMaxSerializedBytes: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_BYTES,
      1024 * 1024,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxSerializedBytes,
      'RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_BYTES'
    ),
    checkpointMaxRevisionFiles: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS,
      4096,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRevisionFiles,
      'RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS'
    ),
    checkpointMaxRetainedRevisionFiles: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS,
      32,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRetainedRevisionFiles,
      'RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS'
    ),
    checkpointMaxThreads: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_MAX_THREADS,
      1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreads,
      'RAG_DURABLE_WORKFLOW_MAX_THREADS'
    ),
    checkpointMaxRootReservedBytes: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_ROOT_BYTES,
      64 * 1024 * 1024 * 1024,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes,
      'RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_ROOT_BYTES'
    ),
    checkpointMaxTombstones: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_MAX_TOMBSTONES,
      1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstones,
      'RAG_DURABLE_WORKFLOW_MAX_TOMBSTONES'
    ),
    checkpointTombstoneRetentionMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS,
      7 * 24 * 60 * 60 * 1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstoneRetentionMs,
      'RAG_DURABLE_WORKFLOW_TOMBSTONE_RETENTION_MS'
    ),
    checkpointOrphanReservationTtlMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS,
      60 * 60 * 1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxOrphanReservationTtlMs,
      'RAG_DURABLE_WORKFLOW_ORPHAN_RESERVATION_TTL_MS'
    ),
    checkpointTemporaryFileTtlMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_TEMP_TTL_MS,
      60 * 60 * 1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTemporaryFileTtlMs,
      'RAG_DURABLE_WORKFLOW_TEMP_TTL_MS'
    ),
    resultMaxBytes,
    resultMaxArtifacts,
    resultMaxRootBytes,
    resultMaxScopeArtifacts: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_ARTIFACTS,
      Math.max(1, Math.min(200, Math.floor(resultMaxArtifacts / 2))),
      DURABLE_ASK_RESULT_HARD_LIMITS.maxScopeArtifacts,
      'RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_ARTIFACTS'
    ),
    resultMaxScopeBytes: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_BYTES,
      Math.min(512 * 1024 * 1024, resultMaxRootBytes),
      DURABLE_ASK_RESULT_HARD_LIMITS.maxScopeBytes,
      'RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_BYTES'
    ),
    resultOrphanTtlMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_ORPHAN_TTL_MS,
      60 * 60 * 1000,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxOrphanTtlMs,
      'RAG_DURABLE_WORKFLOW_RESULT_ORPHAN_TTL_MS'
    ),
    resultTemporaryFileTtlMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_TEMP_TTL_MS,
      60 * 60 * 1000,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxTemporaryFileTtlMs,
      'RAG_DURABLE_WORKFLOW_RESULT_TEMP_TTL_MS'
    ),
    resultGcMaxEntries: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_ENTRIES,
      64,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxGcEntries,
      'RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_ENTRIES'
    ),
    resultGcMaxBytes: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES,
      64 * 1024 * 1024,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxGcBytes,
      'RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES'
    ),
    resultGcMaxDurationMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_DURATION_MS,
      50,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxGcDurationMs,
      'RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_DURATION_MS'
    ),
    resultRebuildMaxDurationMs: parseBoundedInteger(
      env.RAG_DURABLE_WORKFLOW_RESULT_REBUILD_MAX_DURATION_MS,
      5000,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxRebuildDurationMs,
      'RAG_DURABLE_WORKFLOW_RESULT_REBUILD_MAX_DURATION_MS'
    ),
    multiInstance: parseStrictBoolean(
      env.RAG_DURABLE_WORKFLOW_MULTI_INSTANCE,
      'RAG_DURABLE_WORKFLOW_MULTI_INSTANCE'
    ),
    requireSharedControlPlane: parseStrictBoolean(
      env.RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE,
      'RAG_DURABLE_WORKFLOW_REQUIRE_SHARED_CONTROL_PLANE'
    ),
    requestedControlPlane,
  };
  if (
    config.checkpointMaxRetainedRevisionFiles
    > config.checkpointMaxRevisionFiles
  ) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_CHECKPOINT_RETAINED_REVISIONS cannot exceed '
        + 'RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_REVISIONS.'
    );
  }
  if (config.resultMaxScopeArtifacts > config.resultMaxArtifacts) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_ARTIFACTS cannot exceed '
        + 'RAG_DURABLE_WORKFLOW_RESULT_MAX_ARTIFACTS.'
    );
  }
  if (config.resultMaxScopeBytes > config.resultMaxRootBytes) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_RESULT_MAX_SCOPE_BYTES cannot exceed '
        + 'RAG_DURABLE_WORKFLOW_RESULT_MAX_ROOT_BYTES.'
    );
  }
  if (
    config.resultGcMaxBytes
    < config.resultMaxBytes
      + DURABLE_ASK_RESULT_HARD_LIMITS.maxEnvelopeOverheadBytes
  ) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_RESULT_GC_MAX_BYTES must cover '
        + 'RAG_DURABLE_WORKFLOW_RESULT_MAX_BYTES plus 65536 envelope bytes.'
    );
  }
  const reservedThreadBytes =
    (config.checkpointMaxRetainedRevisionFiles + 1)
      * (
        config.checkpointMaxSerializedBytes
        + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxEnvelopeOverheadBytes
      )
    + 2 * FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLatestPointerBytes
    + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreadReservationBytes;
  const reservedTombstoneBytes =
    config.checkpointMaxTombstones
    * FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstoneBytes;
  if (
    config.checkpointMaxRootReservedBytes
    < reservedThreadBytes + reservedTombstoneBytes
  ) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_CHECKPOINT_MAX_ROOT_BYTES cannot hold '
        + 'tombstones and one checkpoint reservation.'
    );
  }
  return config;
}

export function getDurableWorkflowRuntime(
  env: NodeJS.ProcessEnv = process.env
): DurableWorkflowRuntime {
  const config = resolveDurableWorkflowRuntimeConfig(env);
  const integrityKey = readIntegrityKey(env);
  const cacheKey = createRuntimeCacheKey(config, integrityKey);
  const existing = runtimeCache.get(cacheKey);
  if (existing) return existing;
  const checkpointStore = new FileDurableCheckpointStore(
    path.join(config.rootDir, 'checkpoints'),
    {
      maxSerializedBytes: config.checkpointMaxSerializedBytes,
      maxRevisionFiles: config.checkpointMaxRevisionFiles,
      maxRetainedRevisionFiles: config.checkpointMaxRetainedRevisionFiles,
      maxThreads: config.checkpointMaxThreads,
      maxRootReservedBytes: config.checkpointMaxRootReservedBytes,
      maxTombstones: config.checkpointMaxTombstones,
      tombstoneRetentionMs: config.checkpointTombstoneRetentionMs,
      orphanReservationTtlMs: config.checkpointOrphanReservationTtlMs,
      temporaryFileTtlMs: config.checkpointTemporaryFileTtlMs,
    }
  );
  const resultStore = new FileDurableAskResultArtifactStore(
    path.join(config.rootDir, 'ask-results'),
    {
      maxResultBytes: config.resultMaxBytes,
      maxArtifacts: config.resultMaxArtifacts,
      maxRootBytes: config.resultMaxRootBytes,
      maxScopeArtifacts: config.resultMaxScopeArtifacts,
      maxScopeBytes: config.resultMaxScopeBytes,
      orphanTtlMs: config.resultOrphanTtlMs,
      temporaryFileTtlMs: config.resultTemporaryFileTtlMs,
      gcMaxEntries: config.resultGcMaxEntries,
      gcMaxBytes: config.resultGcMaxBytes,
      gcMaxDurationMs: config.resultGcMaxDurationMs,
      rebuildMaxDurationMs: config.resultRebuildMaxDurationMs,
    }
  );
  assertDurableWorkflowTopology({
    checkpointStore,
    resultStore,
    multiInstance: config.multiInstance,
    requireSharedControlPlane: config.requireSharedControlPlane,
    requestedControlPlane: config.requestedControlPlane,
  });
  const runtime = {
    config: Object.freeze({ ...config }),
    checkpointStore,
    resultStore,
  } as DurableWorkflowRuntime;
  Object.defineProperty(runtime, 'integrityKey', {
    value: integrityKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

export function assertDurableWorkflowTopology(input: {
  checkpointStore: DurableWorkflowTopologyStore;
  resultStore: DurableWorkflowTopologyStore;
  multiInstance?: boolean;
  requireSharedControlPlane?: boolean;
  requestedControlPlane?: 'file' | 'shared';
}): void {
  const sharedRequired = input.multiInstance === true
    || input.requireSharedControlPlane === true
    || input.requestedControlPlane === 'shared';
  if (!sharedRequired) return;
  if (
    input.checkpointStore.coordination !== 'shared'
    || input.resultStore.coordination !== 'shared'
  ) {
    throw new DurableWorkflowRuntimeError(
      'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED',
      'Durable workflow multi-instance mode requires shared transactional '
        + 'checkpoint CAS, leases, and result artifact publication.'
    );
  }
}

function createRuntimeCacheKey(
  config: DurableWorkflowRuntimeConfig,
  integrityKey: string
): string {
  return JSON.stringify([
    config.rootDir,
    config.checkpointMaxSerializedBytes,
    config.checkpointMaxRevisionFiles,
    config.checkpointMaxRetainedRevisionFiles,
    config.checkpointMaxThreads,
    config.checkpointMaxRootReservedBytes,
    config.checkpointMaxTombstones,
    config.checkpointTombstoneRetentionMs,
    config.resultMaxBytes,
    config.resultMaxArtifacts,
    config.resultMaxRootBytes,
    config.resultMaxScopeArtifacts,
    config.resultMaxScopeBytes,
    config.resultOrphanTtlMs,
    config.resultTemporaryFileTtlMs,
    config.resultGcMaxEntries,
    config.resultGcMaxBytes,
    config.resultGcMaxDurationMs,
    config.resultRebuildMaxDurationMs,
    config.multiInstance,
    config.checkpointOrphanReservationTtlMs,
    config.checkpointTemporaryFileTtlMs,
    config.requireSharedControlPlane,
    config.requestedControlPlane,
    sha256(integrityKey),
  ]);
}

function readIntegrityKey(env: NodeJS.ProcessEnv): string {
  const integrityKey = env.RAG_DURABLE_WORKFLOW_INTEGRITY_KEY?.trim() ?? '';
  if (integrityKey.length < 32 || integrityKey.length > 4096) {
    throw configurationError(
      'RAG_DURABLE_WORKFLOW_INTEGRITY_KEY must contain 32 to 4096 characters.'
    );
  }
  return integrityKey;
}

function parseStrictBoolean(
  value: string | undefined,
  field: string
): boolean {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw configurationError(field + ' must be true or false.');
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
  field: string
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(value.trim())) {
    throw configurationError(field + ' must be a positive integer.');
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw configurationError(field + ' is outside its hard limit.');
  }
  return parsed;
}

function parseControlPlane(
  value: string | undefined
): 'file' | 'shared' {
  const normalized = value?.trim().toLowerCase() || 'file';
  if (normalized === 'file' || normalized === 'shared') return normalized;
  throw configurationError(
    'RAG_DURABLE_WORKFLOW_CONTROL_PLANE must be file or shared.'
  );
}

function configurationError(message: string): DurableWorkflowRuntimeError {
  return new DurableWorkflowRuntimeError(
    'DURABLE_WORKFLOW_CONFIGURATION_INVALID',
    message
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
