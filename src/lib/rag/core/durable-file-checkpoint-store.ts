import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { link, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  assertDurableWorkflowSerializable,
  assertDurableGenerationId,
  buildDurableCheckpointKey,
  DurableWorkflowCapacityError,
  DurableWorkflowConflictError,
  DurableWorkflowLeaseManagementError,
  DURABLE_WORKFLOW_CHECKPOINT_VERSION,
  type DurableCheckpointStore,
  type DurableJsonValue,
  type DurableWorkflowCheckpoint,
  type DurableWorkflowCheckpointStatus,
} from './durable-workflow';

export const FILE_DURABLE_CHECKPOINT_SCHEMA_VERSION =
  'rag-durable-file-checkpoint-v2' as const;
export const FILE_DURABLE_CHECKPOINT_TOMBSTONE_VERSION =
  'rag-durable-file-checkpoint-tombstone-v2' as const;
export const FILE_DURABLE_CHECKPOINT_THREAD_RESERVATION_VERSION =
  'rag-durable-file-checkpoint-thread-reservation-v2' as const;
export const FILE_DURABLE_CHECKPOINT_LATEST_POINTER_VERSION =
  'rag-durable-file-checkpoint-latest-v2' as const;
export const FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION =
  'rag-durable-file-checkpoint-current-v1' as const;
export const FILE_DURABLE_CHECKPOINT_LEDGER_VERSION =
  'rag-durable-file-checkpoint-ledger-v2' as const;
export const FILE_DURABLE_CHECKPOINT_RESERVATION_SHARD_VERSION =
  'rag-durable-file-checkpoint-reservation-shard-v2' as const;
export const FILE_DURABLE_CHECKPOINT_TOMBSTONE_SHARD_VERSION =
  'rag-durable-file-checkpoint-tombstone-shard-v2' as const;
export const FILE_DURABLE_CHECKPOINT_LEDGER_TRANSACTION_VERSION =
  'rag-durable-file-checkpoint-ledger-transaction-v2' as const;

export const FILE_DURABLE_CHECKPOINT_HARD_LIMITS = Object.freeze({
  maxSerializedBytes: 8 * 1024 * 1024,
  maxRevisionFiles: 10_000,
  maxThreads: 10_000,
  maxRetainedRevisionFiles: 256,
  maxTombstones: 10_000,
  maxRootReservedBytes: 512 * 1024 * 1024 * 1024,
  maxDirectoryEntries: 10_032,
  maxTombstoneRetentionMs: 365 * 24 * 60 * 60 * 1000,
  maxOrphanReservationTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxTemporaryFileTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxThreadDirectoryEntries: 10_032,
  maxTombstoneDirectoryEntries: 10_032,
  maxTombstoneBytes: 8 * 1024,
  maxThreadReservationBytes: 8 * 1024,
  maxEnvelopeOverheadBytes: 64 * 1024,
  maxLatestPointerBytes: 8 * 1024,
  maxLedgerBytes: 512 * 1024,
  maxLedgerShardBytes: 128 * 1024,
  maxLedgerTransactionBytes: 768 * 1024,
  maxLedgerShards: 256,
  maxLedgerShardEntries: 64,
  maxLedgerGcShardsPerPass: 4,
  maxTemporaryEntries: 2048,
  maxTemporaryGcPerPass: 64,
});

export type FileDurableCheckpointCrashPoint =
  | 'after-current-claim'
  | 'after-thread-reservation'
  | 'after-revision-publish'
  | 'after-latest-commit'
  | 'after-compaction'
  | 'after-tombstone-cleanup-ack-publish'
  | 'after-tombstone-cleanup-ack-ledger';

export type FileDurableCheckpointIoEvent =
  | 'ledger-root-read'
  | 'ledger-shard-read'
  | 'legacy-reservation-read'
  | 'legacy-tombstone-read'
  | 'revision-directory-scan'
  | 'temporary-directory-scan';

export interface FileDurableCheckpointStoreOptions {
  providerId?: string;
  maxSerializedBytes?: number;
  maxRevisionFiles?: number;
  maxThreads?: number;
  maxTombstones?: number;
  maxRetainedRevisionFiles?: number;
  tombstoneRetentionMs?: number;
  orphanReservationTtlMs?: number;
  temporaryFileTtlMs?: number;
  maxRootReservedBytes?: number;
  now?: () => Date;
  crashInjector?: (
    point: FileDurableCheckpointCrashPoint,
    checkpointKey: string
  ) => void | Promise<void>;
  ioObserver?: (event: FileDurableCheckpointIoEvent, file: string) => void;
}

export type DurableFileCheckpointStoreErrorCode =
  | 'DURABLE_CHECKPOINT_INTEGRITY'
  | 'DURABLE_CHECKPOINT_SCAN_LIMIT';

export class DurableFileCheckpointStoreError extends Error {
  readonly code: DurableFileCheckpointStoreErrorCode;

  constructor(
    code: DurableFileCheckpointStoreErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DurableFileCheckpointStoreError';
    this.code = code;
  }
}

interface FileCheckpointEnvelope {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_SCHEMA_VERSION;
  checkpointKey: string;
  generationId: string;
  revision: number;
  checkpointDigest: string;
  checkpoint: DurableWorkflowCheckpoint;
}

interface FileCheckpointTombstone {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_TOMBSTONE_VERSION;
  checkpointKey: string;
  generationId: string;
  deletedRevision: number;
  checkpointDigest: string;
  deletedAt: string;
  cleanupAcknowledgedAt?: string;
  tombstoneDigest: string;
}

interface FileCheckpointThreadReservation {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_THREAD_RESERVATION_VERSION;
  checkpointKey: string;
  generationId: string;
  checkpointKeyDigest: string;
  reservedAt: string;
  reservedBytes?: number;
  reservationDigest: string;
}

interface FileCheckpointLatestPointer {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_LATEST_POINTER_VERSION;
  checkpointKey: string;
  generationId: string;
  revision: number;
  checkpointDigest: string;
  pointerDigest: string;
}

interface FileCheckpointCurrentPointer {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION;
  checkpointKey: string;
  generationId: string;
  state: 'pending' | 'active' | 'deleted';
  revision: number;
  updatedAt: string;
  deletedAt?: string;
  pointerDigest: string;
}

interface RevisionCatalog {
  revisionCount: number;
  latest: FileCheckpointEnvelope | null;
}

type FileCheckpointLedgerEntryState = 'reserved' | 'committed';

interface FileCheckpointReservationLedgerEntry {
  checkpointKey: string;
  generationId: string;
  checkpointKeyDigest: string;
  reservedBytes: number;
  state: FileCheckpointLedgerEntryState;
  updatedAt: string;
}

interface FileCheckpointTombstoneLedgerEntry {
  checkpointKey: string;
  generationId: string;
  checkpointKeyDigest: string;
  deletedRevision: number;
  deletedAt: string;
  cleanupAcknowledgedAt?: string;
  state: FileCheckpointLedgerEntryState;
  updatedAt: string;
}

interface FileCheckpointLedgerShardSummary {
  generation: number;
  entryCount: number;
  reservedBytes: number;
  shardDigest: string;
}

interface FileCheckpointReservationLedgerShard {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_RESERVATION_SHARD_VERSION;
  shardId: string;
  generation: number;
  entries: FileCheckpointReservationLedgerEntry[];
  shardDigest: string;
}

interface FileCheckpointTombstoneLedgerShard {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_TOMBSTONE_SHARD_VERSION;
  shardId: string;
  generation: number;
  entries: FileCheckpointTombstoneLedgerEntry[];
  shardDigest: string;
}

interface FileCheckpointLedger {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_LEDGER_VERSION;
  generation: number;
  generationId: string;
  reservationCount: number;
  totalReservedBytes: number;
  tombstoneCount: number;
  reservationCursor: number;
  tombstoneCursor: number;
  reservationShards: Record<string, FileCheckpointLedgerShardSummary>;
  tombstoneShards: Record<string, FileCheckpointLedgerShardSummary>;
  updatedAt: string;
  ledgerDigest: string;
}

type FileCheckpointLedgerMutationKind = 'reservation' | 'tombstone';

interface FileCheckpointLedgerTransaction {
  schemaVersion: typeof FILE_DURABLE_CHECKPOINT_LEDGER_TRANSACTION_VERSION;
  transactionId: string;
  kind: FileCheckpointLedgerMutationKind;
  shardId: string;
  previousLedgerDigest: string | null;
  nextLedger: FileCheckpointLedger;
  nextReservationShard?: FileCheckpointReservationLedgerShard;
  nextTombstoneShard?: FileCheckpointTombstoneLedgerShard;
  transactionDigest: string;
}

interface ThreadReservationCatalog {
  reservations: FileCheckpointThreadReservation[];
  reservationCount: number;
  totalReservedBytes: number;
}

const CHECKPOINT_KEY_PATTERN =
  /^rag-durable\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[a-f0-9]{64}$/;
const REVISION_FILE_PATTERN = /^([0-9]{16})\.json$/;
const DEFAULT_LEDGER_GENERATION_ID = 'legacy';
const THREAD_RESERVATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const TOMBSTONE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TEMPORARY_FILE_PATTERN = /^[a-f0-9]{64}\.([0-9]{13})\.[a-f0-9-]{36}\.tmp$/;
const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ORPHAN_RESERVATION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TEMPORARY_FILE_TTL_MS = 60 * 60 * 1000;
const LEDGER_SHARD_ID_PATTERN = /^[a-f0-9]{2}$/;
const fileCheckpointLocks = new Map<string, Promise<void>>();

/**
 * Durable local checkpoint adapter.
 *
 * Revisions and terminal tombstones are immutable create-if-absent files.
 * A module-level lock coordinates all store instances in this Node process.
 * Atomic publication detects cross-process write conflicts, but this adapter
 * intentionally reports process coordination and is not a shared lease/CAS
 * service for multi-host deployments.
 */
export class FileDurableCheckpointStore implements DurableCheckpointStore {
  readonly providerId: string;
  readonly processPersistent = true;
  readonly coordination = 'process' as const;
  readonly maxSerializedBytes: number;
  readonly maxRevisionFiles: number;
  readonly maxThreads: number;
  readonly maxTombstones: number;
  readonly tombstoneRetentionMs: number;
  readonly orphanReservationTtlMs: number;
  readonly temporaryFileTtlMs: number;
  readonly maxRetainedRevisionFiles: number;
  private readonly rootDir: string;
  readonly maxRootReservedBytes: number;
  readonly reservedBytesPerThread: number;
  readonly reservedTombstoneBytes: number;
  private readonly now: () => Date;
  private readonly crashInjector?: FileDurableCheckpointStoreOptions['crashInjector'];
  private readonly ioObserver?: FileDurableCheckpointStoreOptions['ioObserver'];


  constructor(
    rootDir = path.join(
      process.cwd(),
      'uploads',
      'rag-durable-workflows-v1',
      'checkpoints'
    ),
    options: FileDurableCheckpointStoreOptions = {}
  ) {
    this.rootDir = path.resolve(rootDir);
    this.providerId = assertSafeProviderId(
      options.providerId ?? 'file-durable-checkpoint-store'
    );
    this.maxSerializedBytes = resolveBoundedPositiveInteger(
      options.maxSerializedBytes,
      1024 * 1024,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxSerializedBytes,
      'maxSerializedBytes'
    );
    this.maxRevisionFiles = resolveBoundedPositiveInteger(
      options.maxRevisionFiles,
      4096,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRevisionFiles,
      'maxRevisionFiles'
    );
    this.maxRetainedRevisionFiles = resolveBoundedPositiveInteger(
      options.maxRetainedRevisionFiles,
      32,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRetainedRevisionFiles,
      'maxRetainedRevisionFiles'
    );
    if (this.maxRetainedRevisionFiles > this.maxRevisionFiles) {
      throw new Error(
        'maxRetainedRevisionFiles cannot exceed maxRevisionFiles.'
      );
    }
    this.maxThreads = resolveBoundedPositiveInteger(
      options.maxThreads,
      1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreads,
      'maxThreads'
    );
    this.maxTombstones = resolveBoundedPositiveInteger(
      options.maxTombstones,
      1000,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstones,
      'maxTombstones'
    );
    this.reservedTombstoneBytes =
      this.maxTombstones
      * FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstoneBytes;
    this.maxRootReservedBytes = resolveBoundedPositiveInteger(
      options.maxRootReservedBytes,
      64 * 1024 * 1024 * 1024,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes,
      'maxRootReservedBytes'
    );
    this.reservedBytesPerThread = calculateThreadReservationBytes(
      this.maxSerializedBytes,
      this.maxRetainedRevisionFiles
    );
    if (
      this.maxRootReservedBytes
      < this.reservedTombstoneBytes + this.reservedBytesPerThread
    ) {
      throw new Error(
        'maxRootReservedBytes cannot hold tombstones and one checkpoint reservation.'
      );
    }
    this.tombstoneRetentionMs = resolveBoundedPositiveInteger(
      options.tombstoneRetentionMs,
      DEFAULT_TOMBSTONE_RETENTION_MS,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstoneRetentionMs,
      'tombstoneRetentionMs'
    );
    this.orphanReservationTtlMs = resolveBoundedPositiveInteger(
      options.orphanReservationTtlMs,
      DEFAULT_ORPHAN_RESERVATION_TTL_MS,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxOrphanReservationTtlMs,
      'orphanReservationTtlMs'
    );
    this.temporaryFileTtlMs = resolveBoundedPositiveInteger(
      options.temporaryFileTtlMs,
      DEFAULT_TEMPORARY_FILE_TTL_MS,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTemporaryFileTtlMs,
      'temporaryFileTtlMs'
    );
    this.crashInjector = options.crashInjector;
    this.ioObserver = options.ioObserver;
    this.now = options.now ?? (() => new Date());
    assertValidDate(this.now(), 'checkpoint store clock');
  }

  async load(checkpointKey: string): Promise<DurableWorkflowCheckpoint | null> {
    const normalizedKey = assertCheckpointKey(checkpointKey);
    return withFileCheckpointLock(this.lockKey(normalizedKey), async () => {
      const current = await this.readCurrentPointer(normalizedKey);
      if (!current) {
        await this.assertNoLegacyCheckpointData(normalizedKey);
        return null;
      }
      if (current.state === 'deleted') {
        const tombstone = await this.readTombstone(
          normalizedKey,
          current.generationId
        );
        if (!tombstone) {
          throw checkpointIntegrity(
            'Deleted durable checkpoint generation has no tombstone.'
          );
        }
        const catalog = await this.readPointedRevisionCatalog(
          normalizedKey,
          current.generationId
        );
        assertTombstoneBoundsCatalog(tombstone, catalog);
        return null;
      }
      const catalog = await this.readRevisionCatalog(
        normalizedKey,
        current.generationId
      );
      if (!catalog.latest) {
        if (current.state === 'pending') {
          await this.cleanupUnpublishedPendingGeneration(
            normalizedKey,
            current
          );
          return null;
        }
        throw checkpointIntegrity(
          'Active durable checkpoint generation has no revision history.'
        );
      }
      if (catalog.latest.revision !== current.revision) {
        if (current.state !== 'pending') {
          throw checkpointIntegrity(
            'Durable checkpoint current pointer revision is inconsistent.'
          );
        }
      }
      await this.assertReservationForCatalog(
        normalizedKey,
        current.generationId,
        catalog,
        false
      );
      if (current.state === 'pending') {
        await this.writeCurrentPointer(createCurrentPointer({
          schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
          checkpointKey: normalizedKey,
          generationId: current.generationId,
          state: 'active',
          revision: catalog.latest.revision,
          updatedAt: assertValidDate(
            this.now(),
            'checkpoint store clock'
          ).toISOString(),
        }));
      }
      return catalog.latest ? cloneCheckpoint(catalog.latest.checkpoint) : null;
    });
  }

  async hasDeletionTombstone(
    checkpointKey: string,
    options: { expectedRevision: number; expectedGenerationId: string }
  ): Promise<boolean> {
    const normalizedKey = assertCheckpointKey(checkpointKey);
    if (
      !Number.isSafeInteger(options.expectedRevision)
      || options.expectedRevision < 0
    ) {
      throw new DurableWorkflowConflictError(
        'Invalid checkpoint delete revision.'
      );
    }
    const expectedGenerationId = assertDurableGenerationId(
      options.expectedGenerationId
    );
    return withFileCheckpointLock(this.lockKey(normalizedKey), async () => {
      const tombstone = await this.readTombstone(
        normalizedKey,
        expectedGenerationId
      );
      if (!tombstone) return false;
      if (tombstone.deletedRevision !== options.expectedRevision) {
        throw new DurableWorkflowConflictError();
      }
      return true;
    });
  }

  async save(
    checkpoint: DurableWorkflowCheckpoint,
    options: {
      expectedRevision: number | null;
      expectedGenerationId: string | null;
    }
  ): Promise<void> {
    const checkpointKey = assertCheckpointKey(checkpoint.checkpointKey);
    const generationId = assertDurableGenerationId(checkpoint.generationId);
    assertCheckpointForStorage(checkpoint, this.maxSerializedBytes);
    assertExpectedRevision(options.expectedRevision);
    const saveOperation = async (): Promise<void> => {
      if (options.expectedRevision === null) {
        await this.garbageCollectTemporaryFiles();
        await this.pruneOrphanReservations();
        await this.pruneExpiredTombstones();
      }
      const expectedGenerationId = options.expectedGenerationId === null
        ? null
        : assertDurableGenerationId(options.expectedGenerationId);
      if (
        options.expectedRevision === null
          ? expectedGenerationId !== null
          : expectedGenerationId !== generationId
      ) {
        throw new DurableWorkflowConflictError(
          'Durable checkpoint generation fence is invalid.'
        );
      }
      let current = await this.readCurrentPointer(checkpointKey);
      if (current?.state === 'pending') {
        await this.cleanupUnpublishedPendingGeneration(checkpointKey, current);
        current = await this.readCurrentPointer(checkpointKey);
      }
      const generationTombstone = await this.readTombstone(
        checkpointKey,
        generationId
      );
      if (generationTombstone) {
        throw new DurableWorkflowConflictError(
          'A deleted durable checkpoint generation cannot be reused.'
        );
      }
      if (options.expectedRevision === null) {
        if (!current) {
          await this.assertNoLegacyCheckpointData(checkpointKey);
        } else if (current.state === 'deleted') {
          const barrierTombstone = await this.readTombstone(
            checkpointKey,
            current.generationId
          );
          if (!barrierTombstone) {
            throw checkpointIntegrity(
              'Durable checkpoint deletion barrier has no exact tombstone.'
            );
          }
          const deletedAt = Date.parse(barrierTombstone.deletedAt);
          const nowMs = assertValidDate(
            this.now(),
            'checkpoint store clock'
          ).getTime();
          if (nowMs - deletedAt < this.tombstoneRetentionMs) {
            throw new DurableWorkflowConflictError(
              'Checkpoint identity is protected by a retained deletion tombstone.'
            );
          }
        } else if (current.generationId !== generationId) {
          throw new DurableWorkflowConflictError('Checkpoint already exists.');
        }
        if (!current || current.state === 'deleted') {
          const replacingDeletedPointer = current?.state === 'deleted';
          current = createCurrentPointer({
            schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
            checkpointKey,
            generationId,
            state: 'pending',
            revision: 0,
            updatedAt: assertValidDate(
              this.now(),
              'checkpoint store clock'
            ).toISOString(),
          });
          if (replacingDeletedPointer) {
            await this.writeCurrentPointer(current);
          } else {
            await this.claimCurrentPointer(current);
          }
          await this.injectCrash('after-current-claim', checkpointKey);
        }
      } else if (
        !current
        || current.state === 'deleted'
        || current.generationId !== generationId
      ) {
        throw new DurableWorkflowConflictError();
      }

      const catalog = await this.readRevisionCatalog(
        checkpointKey,
        generationId
      );
      await this.assertReservationForCatalog(
        checkpointKey,
        generationId,
        catalog,
        false
      );
      const existing = catalog.latest;
      const incomingDigest = createCheckpointDigest(checkpoint);

      if (existing && existing.revision === checkpoint.revision) {
        const expectedForRetry = checkpoint.revision === 0
          ? null
          : checkpoint.revision - 1;
        if (
          options.expectedRevision === expectedForRetry
          && existing.checkpointDigest === incomingDigest
        ) {
          await this.compactRevisionHistory(
            checkpointKey,
            generationId,
            existing.revision
          );
          await this.writeCurrentPointer(createCurrentPointer({
            schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
            checkpointKey,
            generationId,
            state: 'active',
            revision: existing.revision,
            updatedAt: assertValidDate(
              this.now(),
              'checkpoint store clock'
            ).toISOString(),
          }));
          return;
        }
        throw new DurableWorkflowConflictError(
          'Checkpoint revision already contains different content.'
        );
      }

      if (options.expectedRevision === null) {
        if (existing) {
          throw new DurableWorkflowConflictError('Checkpoint already exists.');
        }
        if (checkpoint.revision !== 0) {
          throw new DurableWorkflowConflictError(
            'A new checkpoint must start at revision zero.'
          );
        }
      } else {
        if (!existing || existing.revision !== options.expectedRevision) {
          throw new DurableWorkflowConflictError();
        }
        if (checkpoint.revision !== options.expectedRevision + 1) {
          throw new DurableWorkflowConflictError(
            'Checkpoint revision must increment by one.'
          );
        }
      }

      if (existing) {
        await this.compactRevisionHistory(
          checkpointKey,
          generationId,
          existing.revision
        );
      }
      let reservationCreated = false;
      try {
        if (options.expectedRevision === null) {
          reservationCreated = await this.reserveThreadCapacity(
            checkpointKey,
            generationId
          );
        }
      } catch (error) {
        if (current?.state === 'pending' && current.generationId === generationId) {
          await this.cleanupUnpublishedPendingGeneration(
            checkpointKey,
            current,
            true
          );
        }
        throw error;
      }
      if (reservationCreated) {
        await this.injectCrash('after-thread-reservation', checkpointKey);
      }
      try {
        const envelope = createCheckpointEnvelope(checkpoint);
        const serialized = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
        const maximumEnvelopeBytes = this.maxSerializedBytes
          + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxEnvelopeOverheadBytes;
        if (serialized.byteLength > maximumEnvelopeBytes) {
          throw new DurableWorkflowCapacityError();
        }
        const revisionFile = this.revisionFile(
          checkpointKey,
          generationId,
          checkpoint.revision
        );
        const created = await publishImmutableBytes(
          revisionFile,
          serialized,
          this.temporaryDirectory()
        );
        if (!created) {
          const raced = await this.readEnvelopeFile(
            revisionFile,
            checkpointKey,
            generationId,
            checkpoint.revision
          );
          if (raced.checkpointDigest !== incomingDigest) {
            throw new DurableWorkflowConflictError(
              'Checkpoint revision publication conflicted.'
            );
          }
        }
        if (created) {
          await this.injectCrash('after-revision-publish', checkpointKey);
        }
        if (checkpoint.revision === 0) {
          await this.commitThreadReservation(checkpointKey, generationId);
        }
        await this.commitLatestPointer(
          checkpointKey,
          generationId,
          envelope,
          options.expectedRevision
        );
        await this.writeCurrentPointer(createCurrentPointer({
          schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
          checkpointKey,
          generationId,
          state: 'active',
          revision: checkpoint.revision,
          updatedAt: assertValidDate(
            this.now(),
            'checkpoint store clock'
          ).toISOString(),
        }));
        await this.injectCrash('after-latest-commit', checkpointKey);
        try {
          await this.compactRevisionHistory(
            checkpointKey,
            generationId,
            checkpoint.revision
          );
        } catch {
          // A later bounded preflight retries compaction without turning a
          // committed save into a reported failure.
        }
        await this.injectCrash('after-compaction', checkpointKey);
      } catch (error) {
        if (reservationCreated) {
          await this.rollbackThreadReservationIfUnpublished(
            checkpointKey,
            generationId,
            checkpoint.revision
          );
        }
        if (current?.state === 'pending' && current.generationId === generationId) {
          await this.cleanupUnpublishedPendingGeneration(
            checkpointKey,
            current,
            true
          );
        }
        throw error;
      }
    };
    await withFileCheckpointLock(this.lockKey(checkpointKey), saveOperation);
  }

  async delete(
    checkpointKey: string,
    options: { expectedRevision: number; expectedGenerationId: string }
  ): Promise<boolean> {
    const normalizedKey = assertCheckpointKey(checkpointKey);
    if (
      !Number.isSafeInteger(options.expectedRevision)
      || options.expectedRevision < 0
    ) {
      throw new DurableWorkflowConflictError(
        'Invalid checkpoint delete revision.'
      );
    }
    const expectedGenerationId = assertDurableGenerationId(
      options.expectedGenerationId
    );
    return withFileCheckpointLock(this.lockKey(normalizedKey), async () => {
      await this.garbageCollectTemporaryFiles();
      await this.pruneExpiredTombstones();
      const current = await this.readCurrentPointer(normalizedKey);
      if (current && current.generationId !== expectedGenerationId) {
        throw new DurableWorkflowConflictError(
          'Durable checkpoint generation changed before delete.'
        );
      }

      const existingTombstone = await this.readTombstone(
        normalizedKey,
        expectedGenerationId
      );
      if (existingTombstone) {
        if (existingTombstone.deletedRevision !== options.expectedRevision) {
          throw new DurableWorkflowConflictError();
        }
        const catalog = await this.readPointedRevisionCatalog(
          normalizedKey,
          expectedGenerationId
        );
        assertTombstoneBoundsCatalog(existingTombstone, catalog);
        if (!current || current.state !== 'deleted') {
          await this.writeCurrentPointer(createCurrentPointer({
            schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
            checkpointKey: normalizedKey,
            generationId: expectedGenerationId,
            state: 'deleted',
            revision: existingTombstone.deletedRevision,
            updatedAt: existingTombstone.deletedAt,
            deletedAt: existingTombstone.deletedAt,
          }));
        }
        await this.cleanupRevisionHistory(normalizedKey, expectedGenerationId);
        await this.releaseThreadReservation(normalizedKey, expectedGenerationId);
        return false;
      }

      if (!current) return false;
      if (current.state === 'deleted') {
        throw checkpointIntegrity(
          'Deleted durable checkpoint generation has no exact tombstone.'
        );
      }
      const catalog = await this.readRevisionCatalog(
        normalizedKey,
        expectedGenerationId
      );
      await this.assertReservationForCatalog(
        normalizedKey,
        expectedGenerationId,
        catalog,
        false
      );
      const existing = catalog.latest;
      if (!existing) {
        await this.cleanupUnpublishedPendingGeneration(
          normalizedKey,
          current
        );
        return false;
      }
      if (existing.revision !== options.expectedRevision) {
        throw new DurableWorkflowConflictError();
      }
      if (!isTerminalStatus(existing.checkpoint.status)) {
        throw new DurableWorkflowLeaseManagementError(
          'Only terminal checkpoints may be deleted by the safe lifecycle port.'
        );
      }
      const tombstone = createTombstone({
        schemaVersion: FILE_DURABLE_CHECKPOINT_TOMBSTONE_VERSION,
        checkpointKey: normalizedKey,
        generationId: expectedGenerationId,
        deletedRevision: existing.revision,
        checkpointDigest: existing.checkpointDigest,
        deletedAt: assertValidDate(
          this.now(),
          'checkpoint store clock'
        ).toISOString(),
      });
      const created = await this.reserveAndPublishTombstone(tombstone);
      await this.writeCurrentPointer(createCurrentPointer({
        schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
        checkpointKey: normalizedKey,
        generationId: expectedGenerationId,
        state: 'deleted',
        revision: existing.revision,
        updatedAt: tombstone.deletedAt,
        deletedAt: tombstone.deletedAt,
      }));
      await this.cleanupRevisionHistory(normalizedKey, expectedGenerationId);
      await this.releaseThreadReservation(normalizedKey, expectedGenerationId);
      return created;
    });
  }

  async acknowledgeDeletionCleanup(
    checkpointKey: string,
    options: { expectedRevision: number; expectedGenerationId: string }
  ): Promise<void> {
    const normalizedKey = assertCheckpointKey(checkpointKey);
    const generationId = assertDurableGenerationId(
      options.expectedGenerationId
    );
    if (
      !Number.isSafeInteger(options.expectedRevision)
      || options.expectedRevision < 0
    ) {
      throw new DurableWorkflowConflictError(
        'Invalid checkpoint cleanup acknowledgement revision.'
      );
    }
    await withFileCheckpointLock(this.lockKey(normalizedKey), async () => {
      const tombstone = await this.readTombstone(normalizedKey, generationId);
      if (!tombstone || tombstone.deletedRevision !== options.expectedRevision) {
        throw new DurableWorkflowConflictError();
      }
      if (tombstone.cleanupAcknowledgedAt !== undefined) return;
      const acknowledged = createTombstone({
        schemaVersion: FILE_DURABLE_CHECKPOINT_TOMBSTONE_VERSION,
        checkpointKey: tombstone.checkpointKey,
        generationId: tombstone.generationId,
        deletedRevision: tombstone.deletedRevision,
        checkpointDigest: tombstone.checkpointDigest,
        deletedAt: tombstone.deletedAt,
        cleanupAcknowledgedAt: assertValidDate(
          this.now(),
          'checkpoint store clock'
        ).toISOString(),
      });
      await replaceBytesAtomically(
        this.tombstoneFile(normalizedKey, generationId),
        Buffer.from(JSON.stringify(acknowledged, null, 2), 'utf8'),
        this.temporaryDirectory()
      );
      await this.injectCrash(
        'after-tombstone-cleanup-ack-publish',
        normalizedKey
      );
      await this.assertTombstoneLedgerEntry(acknowledged);
      await this.injectCrash(
        'after-tombstone-cleanup-ack-ledger',
        normalizedKey
      );
    });
  }

  private async reserveThreadCapacity(
    checkpointKey: string,
    generationId: string
  ): Promise<boolean> {
    return withFileCheckpointLock(this.capacityLockKey(), async () => {
      let ledger = await this.readLedgerLocked();
      const shardId = this.ledgerShardId(checkpointKey, generationId);
      const shard = await this.readReservationLedgerShardLocked(ledger, shardId);
      const checkpointKeyDigest = createGenerationStorageDigest(
        checkpointKey,
        generationId
      );
      const existing = shard.entries.find(
        entry => entry.checkpointKeyDigest === checkpointKeyDigest
      );
      if (existing) {
        if (
          existing.checkpointKey !== checkpointKey
          || existing.generationId !== generationId
        ) {
          throw checkpointIntegrity(
            'Durable checkpoint reservation ledger has a digest collision.'
          );
        }
        const reservation = await this.readThreadReservation(
          checkpointKey,
          generationId
        );
        if (!reservation) {
          const recovered = createThreadReservation({
            schemaVersion: FILE_DURABLE_CHECKPOINT_THREAD_RESERVATION_VERSION,
            checkpointKey,
            generationId,
            checkpointKeyDigest,
            reservedAt: existing.updatedAt,
            reservedBytes: existing.reservedBytes,
          });
          await publishImmutableBytes(
            this.threadReservationFile(checkpointKey, generationId),
            Buffer.from(JSON.stringify(recovered, null, 2), 'utf8'),
            this.temporaryDirectory()
          );
        }
        return existing.state === 'reserved';
      }
      if (await this.readThreadReservation(checkpointKey, generationId)) {
        throw checkpointIntegrity(
          'Durable checkpoint reservation file is absent from its ledger.'
        );
      }
      if (
        ledger.reservationCount >= this.maxThreads
        || ledger.totalReservedBytes
          > this.maxRootReservedBytes
            - this.reservedTombstoneBytes
            - this.reservedBytesPerThread
      ) {
        throw new DurableWorkflowCapacityError();
      }
      const updatedAt = assertValidDate(
        this.now(),
        'checkpoint store clock'
      ).toISOString();
      const entry: FileCheckpointReservationLedgerEntry = {
        checkpointKey,
        generationId,
        checkpointKeyDigest,
        reservedBytes: this.reservedBytesPerThread,
        state: 'reserved',
        updatedAt,
      };
      ledger = await this.mutateReservationLedgerShardLocked(
        ledger,
        shardId,
        entries => [...entries, entry]
      );
      const reservation = createThreadReservation({
        schemaVersion: FILE_DURABLE_CHECKPOINT_THREAD_RESERVATION_VERSION,
        checkpointKey,
        generationId,
        checkpointKeyDigest,
        reservedAt: updatedAt,
        reservedBytes: this.reservedBytesPerThread,
      });
      const created = await publishImmutableBytes(
        this.threadReservationFile(checkpointKey, generationId),
        Buffer.from(JSON.stringify(reservation, null, 2), 'utf8'),
        this.temporaryDirectory()
      );
      if (!created) {
        const raced = await this.readThreadReservation(checkpointKey, generationId);
        if (!raced) {
          throw checkpointIntegrity(
            'Durable checkpoint thread reservation publication disappeared.'
          );
        }
      }
      return true;
    });
  }

  private async commitThreadReservation(
    checkpointKey: string,
    generationId: string
  ): Promise<void> {
    await withFileCheckpointLock(this.capacityLockKey(), async () => {
      const ledger = await this.readLedgerLocked();
      const shardId = this.ledgerShardId(checkpointKey, generationId);
      const shard = await this.readReservationLedgerShardLocked(ledger, shardId);
      const checkpointKeyDigest = createGenerationStorageDigest(
        checkpointKey,
        generationId
      );
      const existing = shard.entries.find(
        entry => entry.checkpointKeyDigest === checkpointKeyDigest
      );
      if (
        !existing
        || existing.checkpointKey !== checkpointKey
        || existing.generationId !== generationId
      ) {
        throw checkpointIntegrity(
          'Durable checkpoint revision history has no ledger reservation.'
        );
      }
      if (!await this.readThreadReservation(checkpointKey, generationId)) {
        throw checkpointIntegrity(
          'Durable checkpoint ledger reservation has no reservation file.'
        );
      }
      if (existing.state === 'committed') return;
      const updatedAt = assertValidDate(
        this.now(),
        'checkpoint store clock'
      ).toISOString();
      await this.mutateReservationLedgerShardLocked(
        ledger,
        shardId,
        entries => entries.map(entry => (
          entry.checkpointKeyDigest === checkpointKeyDigest
            ? { ...entry, state: 'committed', updatedAt }
            : entry
        ))
      );
    });
  }

  private async releaseThreadReservation(
    checkpointKey: string,
    generationId: string
  ): Promise<void> {
    await withFileCheckpointLock(this.capacityLockKey(), async () => {
      await unlinkIfExists(this.threadReservationFile(checkpointKey, generationId));
      const ledger = await this.readLedgerLocked();
      const shardId = this.ledgerShardId(checkpointKey, generationId);
      const shard = await this.readReservationLedgerShardLocked(ledger, shardId);
      const checkpointKeyDigest = createGenerationStorageDigest(
        checkpointKey,
        generationId
      );
      const existing = shard.entries.find(
        entry => entry.checkpointKeyDigest === checkpointKeyDigest
      );
      if (!existing) return;
      if (
        existing.checkpointKey !== checkpointKey
        || existing.generationId !== generationId
      ) {
        throw checkpointIntegrity(
          'Durable checkpoint reservation ledger has a digest collision.'
        );
      }
      await this.mutateReservationLedgerShardLocked(
        ledger,
        shardId,
        entries => entries.filter(
          entry => entry.checkpointKeyDigest !== checkpointKeyDigest
        )
      );
    });
  }

  private async rollbackThreadReservationIfUnpublished(
    checkpointKey: string,
    generationId: string,
    revision: number
  ): Promise<void> {
    if (await fileExists(this.revisionFile(checkpointKey, generationId, revision))) {
      return;
    }
    await withFileCheckpointLock(this.capacityLockKey(), async () => {
      await unlinkIfExists(this.threadReservationFile(checkpointKey, generationId));
      const ledger = await this.readLedgerLocked();
      const shardId = this.ledgerShardId(checkpointKey, generationId);
      const shard = await this.readReservationLedgerShardLocked(ledger, shardId);
      const checkpointKeyDigest = createGenerationStorageDigest(
        checkpointKey,
        generationId
      );
      const existing = shard.entries.find(
        entry => entry.checkpointKeyDigest === checkpointKeyDigest
      );
      if (existing?.state === 'committed') {
        throw checkpointIntegrity(
          'Committed checkpoint reservation has no published revision.'
        );
      }
      if (existing) {
        await this.mutateReservationLedgerShardLocked(
          ledger,
          shardId,
          entries => entries.filter(
            entry => entry.checkpointKeyDigest !== checkpointKeyDigest
          )
        );
      }
    });
    await rmdirIfEmpty(this.revisionDirectory(checkpointKey, generationId));
    await rmdirIfEmpty(this.generationDirectory(checkpointKey, generationId));
    await rmdirIfEmpty(this.checkpointShardDirectory(checkpointKey));
  }

  private async assertReservationForCatalog(
    checkpointKey: string,
    generationId: string,
    catalog: RevisionCatalog,
    tombstoned: boolean
  ): Promise<void> {
    if (tombstoned || !catalog.latest) return;
    const reservation = await this.readThreadReservation(
      checkpointKey,
      generationId
    );
    if (!reservation) {
      throw checkpointIntegrity(
        'Durable checkpoint revision history has no thread reservation.'
      );
    }
    if (
      reservation.reservedBytes !== undefined
      && reservation.reservedBytes < this.reservedBytesPerThread
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint thread reservation is smaller than its configured bound.'
      );
    }
    await this.commitThreadReservation(checkpointKey, generationId);
  }

  private async readThreadReservation(
    checkpointKey: string,
    generationId: string
  ): Promise<FileCheckpointThreadReservation | null> {
    const checkpointKeyDigest = createGenerationStorageDigest(
      checkpointKey,
      generationId
    );
    try {
      return await this.readThreadReservationFile(
        this.threadReservationFile(checkpointKey, generationId),
        checkpointKeyDigest,
        checkpointKey,
        generationId
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint thread reservation failed integrity validation.',
        error
      );
    }
  }

  private async readThreadReservationCatalog(): Promise<ThreadReservationCatalog> {
    const directory = this.threadReservationDirectory();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { reservations: [], reservationCount: 0, totalReservedBytes: 0 };
      }
      throw checkpointIntegrity(
        'Durable checkpoint thread reservation catalog is unreadable.',
        error
      );
    }
    if (
      entries.filter(entry => !entry.name.endsWith('.tmp')).length
      > Math.min(
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreadDirectoryEntries,
        this.maxThreads + 32
      )
    ) {
      throw checkpointScanLimit(
        'Durable checkpoint thread reservation scan exceeds its configured limit.'
      );
    }
    let reservationCount = 0;
    const reservations: FileCheckpointThreadReservation[] = [];
    let totalReservedBytes = 0;
    for (const entry of entries.filter(entry => !entry.name.endsWith('.tmp'))) {
      const match = THREAD_RESERVATION_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw checkpointIntegrity(
          'Durable checkpoint thread reservation catalog contains an invalid entry.'
        );
      }
      this.ioObserver?.('legacy-reservation-read', entry.name);
      const reservation = await this.readThreadReservationFile(
        this.resolveInside(directory, entry.name),
        match[1]
      );
      const reservedBytes =
        reservation.reservedBytes ?? this.reservedBytesPerThread;
      if (
        totalReservedBytes
        > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes - reservedBytes
      ) {
        throw checkpointIntegrity(
          'Durable checkpoint thread reservations exceed the hard root byte bound.'
        );
      }
      reservationCount += 1;
      reservations.push(reservation);
      totalReservedBytes += reservedBytes;
    }
    return { reservations, reservationCount, totalReservedBytes };
  }

  private async readThreadReservationFile(
    file: string,
    checkpointKeyDigest: string,
    expectedCheckpointKey?: string,
    expectedGenerationId?: string
  ): Promise<FileCheckpointThreadReservation> {
    try {
      const bytes = await readBoundedBytes(
        file,
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreadReservationBytes
      );
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertThreadReservation(
        value,
        checkpointKeyDigest,
        expectedCheckpointKey,
        expectedGenerationId
      );
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw error;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint thread reservation failed integrity validation.',
        error
      );
    }
  }

  private ledgerShardId(checkpointKey: string, generationId: string): string {
    return createGenerationStorageDigest(checkpointKey, generationId).slice(0, 2);
  }

  private async readLedgerLocked(): Promise<FileCheckpointLedger> {
    await this.recoverLedgerTransactionLocked();
    try {
      return await this.readLedgerFileLocked();
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    if (await this.hasPersistentStateWithoutLedger()) {
      throw checkpointIntegrity(
        'Durable checkpoint ledger is missing while persistent state exists.'
      );
    }
    const ledger = createCheckpointLedger({
      schemaVersion: FILE_DURABLE_CHECKPOINT_LEDGER_VERSION,
      generation: 0,
      generationId: DEFAULT_LEDGER_GENERATION_ID,
      reservationCount: 0,
      totalReservedBytes: 0,
      tombstoneCount: 0,
      reservationCursor: 0,
      tombstoneCursor: 0,
      reservationShards: {},
      tombstoneShards: {},
      updatedAt: assertValidDate(
        this.now(),
        'checkpoint store clock'
      ).toISOString(),
    });
    const created = await publishImmutableBytes(
      this.ledgerFile(),
      serializeMetadata(ledger),
      this.temporaryDirectory()
    );
    if (!created) return this.readLedgerFileLocked();
    return ledger;
  }

  private async readLedgerFileLocked(): Promise<FileCheckpointLedger> {
    this.ioObserver?.('ledger-root-read', this.ledgerFile());
    try {
      const bytes = await readBoundedBytes(
        this.ledgerFile(),
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerBytes
      );
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertCheckpointLedger(value);
      return cloneMetadata(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw error;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint ledger root is invalid.',
        error
      );
    }
  }

  private async recoverLedgerTransactionLocked(): Promise<void> {
    let transaction: FileCheckpointLedgerTransaction;
    try {
      const bytes = await readBoundedBytes(
        this.ledgerTransactionFile(),
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerTransactionBytes
      );
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertLedgerTransaction(value);
      transaction = cloneMetadata(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint ledger transaction is invalid.',
        error
      );
    }

    let current: FileCheckpointLedger | null = null;
    try {
      current = await this.readLedgerFileLocked();
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    const currentDigest = current?.ledgerDigest ?? null;
    if (
      currentDigest !== transaction.previousLedgerDigest
      && currentDigest !== transaction.nextLedger.ledgerDigest
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint ledger transaction does not match the current root.'
      );
    }
    await this.applyLedgerTransactionLocked(transaction);
  }

  private async applyLedgerTransactionLocked(
    transaction: FileCheckpointLedgerTransaction
  ): Promise<void> {
    if (transaction.kind === 'reservation') {
      if (!transaction.nextReservationShard || transaction.nextTombstoneShard) {
        throw checkpointIntegrity(
          'Durable checkpoint reservation transaction has invalid shard data.'
        );
      }
      await replaceBytesAtomically(
        this.reservationLedgerShardFile(transaction.shardId),
        serializeMetadata(transaction.nextReservationShard),
        this.temporaryDirectory()
      );
    } else {
      if (!transaction.nextTombstoneShard || transaction.nextReservationShard) {
        throw checkpointIntegrity(
          'Durable checkpoint tombstone transaction has invalid shard data.'
        );
      }
      await replaceBytesAtomically(
        this.tombstoneLedgerShardFile(transaction.shardId),
        serializeMetadata(transaction.nextTombstoneShard),
        this.temporaryDirectory()
      );
    }
    await replaceBytesAtomically(
      this.ledgerFile(),
      serializeMetadata(transaction.nextLedger),
      this.temporaryDirectory()
    );
    const committed = await this.readLedgerFileLocked();
    if (committed.ledgerDigest !== transaction.nextLedger.ledgerDigest) {
      throw checkpointIntegrity(
        'Durable checkpoint ledger root changed during transaction commit.'
      );
    }
    await unlinkIfExists(this.ledgerTransactionFile());
  }

  private async commitLedgerTransactionLocked(
    transaction: FileCheckpointLedgerTransaction
  ): Promise<FileCheckpointLedger> {
    await replaceBytesAtomically(
      this.ledgerTransactionFile(),
      serializeMetadata(transaction),
      this.temporaryDirectory()
    );
    await this.applyLedgerTransactionLocked(transaction);
    return transaction.nextLedger;
  }

  private async readReservationLedgerShardLocked(
    ledger: FileCheckpointLedger,
    shardId: string
  ): Promise<FileCheckpointReservationLedgerShard> {
    assertLedgerShardId(shardId);
    const summary = ledger.reservationShards[shardId];
    const file = this.reservationLedgerShardFile(shardId);
    if (!summary) {
      if (await fileExists(file)) {
        throw checkpointIntegrity(
          'Durable checkpoint reservation shard is absent from the ledger root.'
        );
      }
      return createReservationLedgerShard(shardId, 0, []);
    }
    this.ioObserver?.('ledger-shard-read', file);
    const bytes = await readBoundedBytes(
      file,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardBytes
    );
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    assertReservationLedgerShard(value, summary);
    return cloneMetadata(value);
  }

  private async readTombstoneLedgerShardLocked(
    ledger: FileCheckpointLedger,
    shardId: string
  ): Promise<FileCheckpointTombstoneLedgerShard> {
    assertLedgerShardId(shardId);
    const summary = ledger.tombstoneShards[shardId];
    const file = this.tombstoneLedgerShardFile(shardId);
    if (!summary) {
      if (await fileExists(file)) {
        throw checkpointIntegrity(
          'Durable checkpoint tombstone shard is absent from the ledger root.'
        );
      }
      return createTombstoneLedgerShard(shardId, 0, []);
    }
    this.ioObserver?.('ledger-shard-read', file);
    const bytes = await readBoundedBytes(
      file,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardBytes
    );
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    assertTombstoneLedgerShard(value, summary);
    return cloneMetadata(value);
  }

  private async mutateReservationLedgerShardLocked(
    ledger: FileCheckpointLedger,
    shardId: string,
    mutate: (
      entries: FileCheckpointReservationLedgerEntry[]
    ) => FileCheckpointReservationLedgerEntry[],
    reservationCursor = ledger.reservationCursor
  ): Promise<FileCheckpointLedger> {
    const current = await this.readReservationLedgerShardLocked(ledger, shardId);
    const entries = normalizeReservationLedgerEntries(
      mutate(current.entries.map(entry => ({ ...entry })))
    );
    const nextShard = createReservationLedgerShard(
      shardId,
      current.generation + 1,
      entries
    );
    const previousSummary = ledger.reservationShards[shardId]
      ?? { generation: 0, entryCount: 0, reservedBytes: 0, shardDigest: sha256('') };
    const nextSummary = createLedgerShardSummary(nextShard);
    const nextLedger = createCheckpointLedger({
      ...omitLedgerDigest(ledger),
      generation: ledger.generation + 1,
      reservationCount:
        ledger.reservationCount
        - previousSummary.entryCount
        + nextSummary.entryCount,
      totalReservedBytes:
        ledger.totalReservedBytes
        - previousSummary.reservedBytes
        + nextSummary.reservedBytes,
      reservationCursor,
      reservationShards: {
        ...ledger.reservationShards,
        [shardId]: nextSummary,
      },
      updatedAt: assertValidDate(
        this.now(),
        'checkpoint store clock'
      ).toISOString(),
    });
    const transaction = createLedgerTransaction({
      schemaVersion: FILE_DURABLE_CHECKPOINT_LEDGER_TRANSACTION_VERSION,
      transactionId: randomUUID(),
      kind: 'reservation',
      shardId,
      previousLedgerDigest: ledger.ledgerDigest,
      nextLedger,
      nextReservationShard: nextShard,
    });
    return this.commitLedgerTransactionLocked(transaction);
  }

  private async mutateTombstoneLedgerShardLocked(
    ledger: FileCheckpointLedger,
    shardId: string,
    mutate: (
      entries: FileCheckpointTombstoneLedgerEntry[]
    ) => FileCheckpointTombstoneLedgerEntry[],
    tombstoneCursor = ledger.tombstoneCursor
  ): Promise<FileCheckpointLedger> {
    const current = await this.readTombstoneLedgerShardLocked(ledger, shardId);
    const entries = normalizeTombstoneLedgerEntries(
      mutate(current.entries.map(entry => ({ ...entry })))
    );
    const nextShard = createTombstoneLedgerShard(
      shardId,
      current.generation + 1,
      entries
    );
    const previousSummary = ledger.tombstoneShards[shardId]
      ?? { generation: 0, entryCount: 0, reservedBytes: 0, shardDigest: sha256('') };
    const nextSummary = createLedgerShardSummary(nextShard);
    const nextLedger = createCheckpointLedger({
      ...omitLedgerDigest(ledger),
      generation: ledger.generation + 1,
      tombstoneCount:
        ledger.tombstoneCount
        - previousSummary.entryCount
        + nextSummary.entryCount,
      tombstoneCursor,
      tombstoneShards: {
        ...ledger.tombstoneShards,
        [shardId]: nextSummary,
      },
      updatedAt: assertValidDate(
        this.now(),
        'checkpoint store clock'
      ).toISOString(),
    });
    const transaction = createLedgerTransaction({
      schemaVersion: FILE_DURABLE_CHECKPOINT_LEDGER_TRANSACTION_VERSION,
      transactionId: randomUUID(),
      kind: 'tombstone',
      shardId,
      previousLedgerDigest: ledger.ledgerDigest,
      nextLedger,
      nextTombstoneShard: nextShard,
    });
    return this.commitLedgerTransactionLocked(transaction);
  }

  private async hasPersistentStateWithoutLedger(): Promise<boolean> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw checkpointIntegrity(
        'Durable checkpoint root is unreadable during ledger initialization.',
        error
      );
    }
    if (
      entries.length
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards + 8
    ) {
      throw checkpointScanLimit(
        'Durable checkpoint root exceeds the bounded ledger recovery surface.'
      );
    }
    for (const entry of entries) {
      if (entry.name !== path.basename(this.metadataDirectory())) return true;
      if (!entry.isDirectory()) return true;
      let metadataEntries: Dirent<string>[];
      try {
        metadataEntries = await readdir(
          this.metadataDirectory(),
          { withFileTypes: true }
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue;
        throw checkpointIntegrity(
          'Durable checkpoint metadata root is unreadable.',
          error
        );
      }
      for (const metadataEntry of metadataEntries) {
        if (
          metadataEntry.isDirectory()
          && metadataEntry.name === path.basename(this.temporaryDirectory())
        ) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  private async pruneOrphanReservations(): Promise<void> {
    await withFileCheckpointLock(this.capacityLockKey(), async () => {
      const ledger = await this.readLedgerLocked();
      await this.pruneOrphanReservationsLocked(ledger);
    });
  }

  private async pruneOrphanReservationsLocked(
    initialLedger: FileCheckpointLedger
  ): Promise<FileCheckpointLedger> {
    let ledger = initialLedger;
    const shardIds = selectLedgerShardIds(
      Object.keys(ledger.reservationShards),
      ledger.reservationCursor,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerGcShardsPerPass
    );
    const now = assertValidDate(this.now(), 'checkpoint store clock').getTime();
    for (const shardId of shardIds) {
      const shard = await this.readReservationLedgerShardLocked(ledger, shardId);
      const nextEntries: FileCheckpointReservationLedgerEntry[] = [];
      let changed = false;
      for (const entry of shard.entries) {
        if (
          entry.state !== 'reserved'
          || Date.parse(entry.updatedAt) + this.orphanReservationTtlMs > now
        ) {
          nextEntries.push(entry);
          continue;
        }
        const hasPublishedState =
          await fileExists(this.latestPointerFile(
            entry.checkpointKey,
            entry.generationId
          ))
          || await fileExists(this.revisionFile(
            entry.checkpointKey,
            entry.generationId,
            0
          ))
          || await fileExists(this.tombstoneFile(
            entry.checkpointKey,
            entry.generationId
          ));
        if (hasPublishedState) {
          nextEntries.push(entry);
          continue;
        }
        await unlinkIfExists(this.threadReservationFile(
          entry.checkpointKey,
          entry.generationId
        ));
        changed = true;
      }
      const nextCursor = (Number.parseInt(shardId, 16) + 1)
        % FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards;
      if (changed || nextCursor !== ledger.reservationCursor) {
        ledger = await this.mutateReservationLedgerShardLocked(
          ledger,
          shardId,
          () => nextEntries,
          nextCursor
        );
      }
    }
    return ledger;
  }
  private async readRevisionCatalog(
    checkpointKey: string,
    generationId: string
  ): Promise<RevisionCatalog> {
    const pointedCatalog = await this.readPointedRevisionCatalog(
      checkpointKey,
      generationId
    );
    if (pointedCatalog.latest) {
      return this.reconcilePendingRevision(
        checkpointKey,
        generationId,
        pointedCatalog
      );
    }

    const revisions = await this.readRevisionFiles(
      checkpointKey,
      generationId,
      this.maxRevisionFiles
    );
    revisions.forEach((entry, index) => {
      if (entry.revision !== index) {
        throw checkpointIntegrity(
          'Legacy durable checkpoint revision history is not contiguous.'
        );
      }
    });
    if (revisions.length === 0) {
      return { revisionCount: 0, latest: null };
    }

    const current = revisions[revisions.length - 1];
    const latest = await this.readEnvelopeFile(
      current.file,
      checkpointKey,
      generationId,
      current.revision
    );
    const pointer = createLatestPointer(latest);
    const created = await publishImmutableBytes(
      this.latestPointerFile(checkpointKey, generationId),
      Buffer.from(JSON.stringify(pointer, null, 2), 'utf8'),
      this.temporaryDirectory()
    );
    if (!created) {
      const racedCatalog = await this.readPointedRevisionCatalog(
        checkpointKey,
        generationId
      );
      if (!racedCatalog.latest) {
        throw checkpointIntegrity(
          'Durable checkpoint latest pointer publication disappeared.'
        );
      }
      return racedCatalog;
    }
    await this.compactRevisionHistory(
      checkpointKey,
      generationId,
      latest.revision,
      this.maxRevisionFiles
    );
    return { revisionCount: latest.revision + 1, latest };
  }

  private async reconcilePendingRevision(
    checkpointKey: string,
    generationId: string,
    catalog: RevisionCatalog
  ): Promise<RevisionCatalog> {
    const current = catalog.latest;
    if (!current) return catalog;
    const pendingRevision = current.revision + 1;
    if (!Number.isSafeInteger(pendingRevision)) {
      throw checkpointIntegrity(
        'Durable checkpoint revision cannot advance beyond the safe range.'
      );
    }
    const pendingFile = this.revisionFile(
      checkpointKey,
      generationId,
      pendingRevision
    );
    if (!await fileExists(pendingFile)) return catalog;
    const pending = await this.readEnvelopeFile(
      pendingFile,
      checkpointKey,
      generationId,
      pendingRevision
    );
    if (await fileExists(this.revisionFile(
      checkpointKey,
      generationId,
      pendingRevision + 1
    ))) {
      throw checkpointIntegrity(
        'Durable checkpoint has more than one uncommitted pending revision.'
      );
    }
    await this.commitLatestPointer(
      checkpointKey,
      generationId,
      pending,
      current.revision
    );
    return { revisionCount: pending.revision + 1, latest: pending };
  }

  private async readPointedRevisionCatalog(
    checkpointKey: string,
    generationId: string
  ): Promise<RevisionCatalog> {
    const pointer = await this.readLatestPointer(checkpointKey, generationId);
    if (!pointer) return { revisionCount: 0, latest: null };
    const latest = await this.readEnvelopeFile(
      this.revisionFile(checkpointKey, generationId, pointer.revision),
      checkpointKey,
      generationId,
      pointer.revision
    );
    if (latest.checkpointDigest !== pointer.checkpointDigest) {
      throw checkpointIntegrity(
        'Durable checkpoint latest pointer digest does not match its revision.'
      );
    }
    return { revisionCount: pointer.revision + 1, latest };
  }

  private async readLatestPointer(
    checkpointKey: string,
    generationId: string
  ): Promise<FileCheckpointLatestPointer | null> {
    try {
      const bytes = await readBoundedBytes(
        this.latestPointerFile(checkpointKey, generationId),
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLatestPointerBytes
      );
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertLatestPointer(value, checkpointKey, generationId);
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint latest pointer failed integrity validation.',
        error
      );
    }
  }

  private async readCurrentPointer(
    checkpointKey: string
  ): Promise<FileCheckpointCurrentPointer | null> {
    try {
      const bytes = await readBoundedBytes(
        this.currentPointerFile(checkpointKey),
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLatestPointerBytes
      );
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertCurrentPointer(value, checkpointKey);
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint current pointer failed integrity validation.',
        error
      );
    }
  }

  private async writeCurrentPointer(
    pointer: FileCheckpointCurrentPointer
  ): Promise<void> {
    await replaceBytesAtomically(
      this.currentPointerFile(pointer.checkpointKey),
      Buffer.from(JSON.stringify(pointer, null, 2), 'utf8'),
      this.temporaryDirectory()
    );
    const committed = await this.readCurrentPointer(pointer.checkpointKey);
    if (!committed || committed.pointerDigest !== pointer.pointerDigest) {
      throw new DurableWorkflowConflictError(
        'Durable checkpoint current generation changed during commit.'
      );
    }
  }

  private async claimCurrentPointer(
    pointer: FileCheckpointCurrentPointer
  ): Promise<void> {
    const created = await publishImmutableBytes(
      this.currentPointerFile(pointer.checkpointKey),
      Buffer.from(JSON.stringify(pointer, null, 2), 'utf8'),
      this.temporaryDirectory()
    );
    const committed = await this.readCurrentPointer(pointer.checkpointKey);
    if (
      !created
      || !committed
      || committed.pointerDigest !== pointer.pointerDigest
    ) {
      throw new DurableWorkflowConflictError(
        'Durable checkpoint current generation was claimed concurrently.'
      );
    }
  }

  private async cleanupUnpublishedPendingGeneration(
    checkpointKey: string,
    pending: FileCheckpointCurrentPointer,
    force = false
  ): Promise<boolean> {
    if (pending.state !== 'pending') return false;
    const catalog = await this.readRevisionCatalog(
      checkpointKey,
      pending.generationId
    );
    if (catalog.latest) {
      await this.writeCurrentPointer(createCurrentPointer({
        schemaVersion: FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION,
        checkpointKey,
        generationId: pending.generationId,
        state: 'active',
        revision: catalog.latest.revision,
        updatedAt: assertValidDate(
          this.now(),
          'checkpoint store clock'
        ).toISOString(),
      }));
      return false;
    }

    const reservationReleased = await this.releaseOrphanReservationIfUnpublished(
      checkpointKey,
      pending.generationId,
      force
    );
    if (!reservationReleased) return false;
    const current = await this.readCurrentPointer(checkpointKey);
    if (
      !current
      || current.state !== 'pending'
      || current.pointerDigest !== pending.pointerDigest
    ) {
      return false;
    }
    await unlinkIfExists(this.currentPointerFile(checkpointKey));
    await rmdirIfEmpty(this.revisionDirectory(
      checkpointKey,
      pending.generationId
    ));
    await rmdirIfEmpty(this.generationDirectory(
      checkpointKey,
      pending.generationId
    ));
    await rmdirIfEmpty(path.dirname(this.generationDirectory(
      checkpointKey,
      pending.generationId
    )));
    await rmdirIfEmpty(this.checkpointDirectory(checkpointKey));
    await rmdirIfEmpty(this.checkpointShardDirectory(checkpointKey));
    return true;
  }

  private async releaseOrphanReservationIfUnpublished(
    checkpointKey: string,
    generationId: string,
    force: boolean
  ): Promise<boolean> {
    return withFileCheckpointLock(this.capacityLockKey(), async () => {
      const ledger = await this.readLedgerLocked();
      const shardId = this.ledgerShardId(checkpointKey, generationId);
      const shard = await this.readReservationLedgerShardLocked(ledger, shardId);
      const storageDigest = createGenerationStorageDigest(
        checkpointKey,
        generationId
      );
      const entry = shard.entries.find(
        candidate => candidate.checkpointKeyDigest === storageDigest
      );
      const reservation = await this.readThreadReservation(
        checkpointKey,
        generationId
      );
      if (!entry && !reservation) return true;
      if (!entry || !reservation) {
        throw checkpointIntegrity(
          'Pending durable checkpoint reservation is only partially published.'
        );
      }
      if (
        entry.checkpointKey !== checkpointKey
        || entry.generationId !== generationId
      ) {
        throw checkpointIntegrity(
          'Pending durable checkpoint reservation identity is inconsistent.'
        );
      }
      const hasPublishedState =
        await fileExists(this.latestPointerFile(checkpointKey, generationId))
        || await fileExists(this.revisionFile(checkpointKey, generationId, 0))
        || await fileExists(this.tombstoneFile(checkpointKey, generationId));
      if (hasPublishedState) return false;
      if (entry.state === 'committed') {
        throw checkpointIntegrity(
          'Committed durable checkpoint reservation has no published revision.'
        );
      }
      const expired = Date.parse(entry.updatedAt) + this.orphanReservationTtlMs
        <= assertValidDate(this.now(), 'checkpoint store clock').getTime();
      if (!force && !expired) return false;
      await unlinkIfExists(this.threadReservationFile(checkpointKey, generationId));
      await this.mutateReservationLedgerShardLocked(
        ledger,
        shardId,
        entries => entries.filter(
          candidate => candidate.checkpointKeyDigest !== storageDigest
        )
      );
      return true;
    });
  }

  private async assertNoLegacyCheckpointData(
    checkpointKey: string
  ): Promise<void> {
    try {
      const entries = await readdir(
        this.checkpointDirectory(checkpointKey),
        { withFileTypes: true }
      );
      if (entries.length > 0) {
        throw checkpointIntegrity(
          'Durable checkpoint data has no generation pointer; migration is required.'
        );
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity('Durable checkpoint directory is unreadable.', error);
    }
  }

  private async commitLatestPointer(
    checkpointKey: string,
    generationId: string,
    envelope: FileCheckpointEnvelope,
    expectedRevision: number | null
  ): Promise<void> {
    const current = await this.readPointedRevisionCatalog(
      checkpointKey,
      generationId
    );
    if (
      current.latest?.revision === envelope.revision
      && current.latest.checkpointDigest === envelope.checkpointDigest
    ) {
      return;
    }
    if (
      expectedRevision === null
        ? current.latest !== null
        : current.latest?.revision !== expectedRevision
    ) {
      throw new DurableWorkflowConflictError(
        'Durable checkpoint latest pointer changed before commit.'
      );
    }

    const pointer = createLatestPointer(envelope);
    await replaceBytesAtomically(
      this.latestPointerFile(checkpointKey, generationId),
      Buffer.from(JSON.stringify(pointer, null, 2), 'utf8'),
      this.temporaryDirectory()
    );
    const committed = await this.readLatestPointer(checkpointKey, generationId);
    if (
      !committed
      || committed.revision !== pointer.revision
      || committed.checkpointDigest !== pointer.checkpointDigest
    ) {
      throw new DurableWorkflowConflictError(
        'Durable checkpoint latest pointer changed during commit.'
      );
    }
  }

  private async compactRevisionHistory(
    checkpointKey: string,
    generationId: string,
    minimumLatestRevision: number,
    scanLimit = this.maxRetainedRevisionFiles + 1
  ): Promise<void> {
    const catalog = await this.readPointedRevisionCatalog(
      checkpointKey,
      generationId
    );
    if (!catalog.latest || catalog.latest.revision < minimumLatestRevision) {
      throw checkpointIntegrity(
        'Durable checkpoint latest pointer regressed during compaction.'
      );
    }
    const revisions = await this.readRevisionFiles(
      checkpointKey,
      generationId,
      scanLimit
    );
    if (
      !revisions.some(entry => entry.revision === catalog.latest?.revision)
      || revisions.some(entry => entry.revision > catalog.latest!.revision)
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint revision window conflicts with its latest pointer.'
      );
    }
    const removeCount = Math.max(
      0,
      revisions.length - this.maxRetainedRevisionFiles
    );
    for (const entry of revisions.slice(0, removeCount)) {
      if (entry.revision === catalog.latest.revision) {
        throw checkpointIntegrity(
          'Durable checkpoint compaction attempted to remove the latest revision.'
        );
      }
      await unlinkIfExists(entry.file);
    }
  }

  private async readRevisionFiles(
    checkpointKey: string,
    generationId: string,
    maximumFiles: number
  ): Promise<Array<{ revision: number; file: string }>> {
    const directory = this.revisionDirectory(checkpointKey, generationId);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
      this.ioObserver?.('revision-directory-scan', directory);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw checkpointIntegrity(
        'Durable checkpoint revision catalog is unreadable.',
        error
      );
    }
    if (
      entries.filter(entry => !entry.name.endsWith('.tmp')).length
      > Math.min(
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxDirectoryEntries,
        maximumFiles + 32
      )
    ) {
      throw checkpointScanLimit();
    }

    const revisions: Array<{ revision: number; file: string }> = [];
    for (const entry of entries.filter(entry => !entry.name.endsWith('.tmp'))) {
      const match = REVISION_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw checkpointIntegrity(
          'Durable checkpoint revision catalog contains an invalid entry.'
        );
      }
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision)) {
        throw checkpointIntegrity(
          'Durable checkpoint revision filename is outside the safe range.'
        );
      }
      revisions.push({
        revision,
        file: this.resolveInside(directory, entry.name),
      });
    }
    if (revisions.length > maximumFiles) throw checkpointScanLimit();
    revisions.sort((left, right) => left.revision - right.revision);
    return revisions;
  }

  private async readEnvelopeFile(
    file: string,
    checkpointKey: string,
    generationId: string,
    revision: number
  ): Promise<FileCheckpointEnvelope> {
    try {
      const bytes = await readBoundedBytes(
        file,
        this.maxSerializedBytes
          + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxEnvelopeOverheadBytes
      );
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertCheckpointEnvelope(
        value,
        checkpointKey,
        generationId,
        revision,
        this.maxSerializedBytes
      );
      return cloneEnvelope(value);
    } catch (error) {
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint revision failed integrity validation.',
        error
      );
    }
  }

  private async cleanupRevisionHistory(
    checkpointKey: string,
    generationId: string
  ): Promise<void> {
    await unlinkIfExists(this.latestPointerFile(checkpointKey, generationId));
    const revisions = await this.readRevisionFiles(
      checkpointKey,
      generationId,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRevisionFiles
    );
    for (const entry of revisions.reverse()) {
      await unlinkIfExists(entry.file);
    }
    await rmdirIfEmpty(this.revisionDirectory(checkpointKey, generationId));
    await rmdirIfEmpty(this.generationDirectory(checkpointKey, generationId));
    await rmdirIfEmpty(this.checkpointShardDirectory(checkpointKey));
  }

  private async reserveAndPublishTombstone(
    tombstone: FileCheckpointTombstone
  ): Promise<boolean> {
    return withFileCheckpointLock(this.capacityLockKey(), async () => {
      let ledger = await this.readLedgerLocked();
      ledger = await this.pruneExpiredTombstonesLocked(ledger);
      const shardId = this.ledgerShardId(
        tombstone.checkpointKey,
        tombstone.generationId
      );
      const checkpointKeyDigest = createGenerationStorageDigest(
        tombstone.checkpointKey,
        tombstone.generationId
      );
      let shard = await this.readTombstoneLedgerShardLocked(ledger, shardId);
      let existing = shard.entries.find(
        entry => entry.checkpointKeyDigest === checkpointKeyDigest
      );
      if (existing) {
        if (
          existing.checkpointKey !== tombstone.checkpointKey
          || existing.generationId !== tombstone.generationId
          || existing.deletedRevision !== tombstone.deletedRevision
        ) {
          throw new DurableWorkflowConflictError(
            'Durable checkpoint tombstone ledger already contains another deletion.'
          );
        }
      } else {
        if (ledger.tombstoneCount >= this.maxTombstones) {
          throw new DurableWorkflowCapacityError();
        }
        const entry: FileCheckpointTombstoneLedgerEntry = {
          checkpointKey: tombstone.checkpointKey,
          generationId: tombstone.generationId,
          checkpointKeyDigest,
          deletedRevision: tombstone.deletedRevision,
          deletedAt: tombstone.deletedAt,
          state: 'reserved',
          updatedAt: tombstone.deletedAt,
        };
        ledger = await this.mutateTombstoneLedgerShardLocked(
          ledger,
          shardId,
          entries => [...entries, entry]
        );
        shard = await this.readTombstoneLedgerShardLocked(ledger, shardId);
        existing = shard.entries.find(
          candidate => candidate.checkpointKeyDigest === checkpointKeyDigest
        );
      }

      const created = await publishImmutableBytes(
        this.tombstoneFile(tombstone.checkpointKey, tombstone.generationId),
        Buffer.from(JSON.stringify(tombstone, null, 2), 'utf8'),
        this.temporaryDirectory()
      );
      if (!created) {
        const raced = await this.readTombstoneFile(
          this.tombstoneFile(tombstone.checkpointKey, tombstone.generationId),
          checkpointKeyDigest,
          tombstone.checkpointKey,
          tombstone.generationId
        );
        if (raced.tombstoneDigest !== tombstone.tombstoneDigest) {
          throw new DurableWorkflowConflictError(
            'Durable checkpoint tombstone publication conflicted.'
          );
        }
      }
      if (existing?.state !== 'committed') {
        const updatedAt = assertValidDate(
          this.now(),
          'checkpoint store clock'
        ).toISOString();
        await this.mutateTombstoneLedgerShardLocked(
          ledger,
          shardId,
          entries => entries.map(entry => (
            entry.checkpointKeyDigest === checkpointKeyDigest
              ? { ...entry, state: 'committed', updatedAt }
              : entry
          ))
        );
      }
      return created;
    });
  }

  private async assertTombstoneLedgerEntry(
    tombstone: FileCheckpointTombstone
  ): Promise<void> {
    await withFileCheckpointLock(this.capacityLockKey(), async () => {
      const ledger = await this.readLedgerLocked();
      const shardId = this.ledgerShardId(
        tombstone.checkpointKey,
        tombstone.generationId
      );
      const shard = await this.readTombstoneLedgerShardLocked(ledger, shardId);
      const checkpointKeyDigest = createGenerationStorageDigest(
        tombstone.checkpointKey,
        tombstone.generationId
      );
      const existing = shard.entries.find(
        entry => entry.checkpointKeyDigest === checkpointKeyDigest
      );
      if (
        !existing
        || existing.checkpointKey !== tombstone.checkpointKey
        || existing.generationId !== tombstone.generationId
        || existing.deletedRevision !== tombstone.deletedRevision
        || existing.deletedAt !== tombstone.deletedAt
      ) {
        throw checkpointIntegrity(
          'Durable checkpoint tombstone is absent from its ledger.'
        );
      }
      if (
        existing.state === 'committed'
        && existing.cleanupAcknowledgedAt === tombstone.cleanupAcknowledgedAt
      ) {
        return;
      }
      const updatedAt = assertValidDate(
        this.now(),
        'checkpoint store clock'
      ).toISOString();
      await this.mutateTombstoneLedgerShardLocked(
        ledger,
        shardId,
        entries => entries.map(entry => (
          entry.checkpointKeyDigest === checkpointKeyDigest
            ? {
              ...entry,
              cleanupAcknowledgedAt: tombstone.cleanupAcknowledgedAt,
              state: 'committed',
              updatedAt,
            }
            : entry
        ))
      );
    });
  }

  private async pruneExpiredTombstonesLocked(
    initialLedger: FileCheckpointLedger
  ): Promise<FileCheckpointLedger> {
    let ledger = initialLedger;
    const shardIds = selectLedgerShardIds(
      Object.keys(ledger.tombstoneShards),
      ledger.tombstoneCursor,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerGcShardsPerPass
    );
    const now = assertValidDate(this.now(), 'checkpoint store clock').getTime();
    for (const shardId of shardIds) {
      const shard = await this.readTombstoneLedgerShardLocked(ledger, shardId);
      const nextEntries: FileCheckpointTombstoneLedgerEntry[] = [];
      let changed = false;
      for (const entry of shard.entries) {
        if (
          entry.cleanupAcknowledgedAt === undefined
          || Date.parse(entry.deletedAt) + this.tombstoneRetentionMs > now
        ) {
          nextEntries.push(entry);
          continue;
        }
        if (
          await fileExists(this.latestPointerFile(
            entry.checkpointKey,
            entry.generationId
          ))
          || await this.readThreadReservation(
            entry.checkpointKey,
            entry.generationId
          )
        ) {
          nextEntries.push(entry);
          continue;
        }
        const tombstoneFile = this.tombstoneFile(
          entry.checkpointKey,
          entry.generationId
        );
        if (await fileExists(tombstoneFile)) {
          const tombstone = await this.readTombstoneFile(
            tombstoneFile,
            entry.checkpointKeyDigest,
            entry.checkpointKey,
            entry.generationId
          );
          if (
            tombstone.deletedRevision !== entry.deletedRevision
            || tombstone.deletedAt !== entry.deletedAt
            || tombstone.cleanupAcknowledgedAt !== entry.cleanupAcknowledgedAt
          ) {
            throw checkpointIntegrity(
              'Durable checkpoint tombstone ledger conflicts with its file.'
            );
          }
        }
        await unlinkIfExists(tombstoneFile);
        const current = await this.readCurrentPointer(entry.checkpointKey);
        if (
          current?.state === 'deleted'
          && current.generationId === entry.generationId
        ) {
          await unlinkIfExists(this.currentPointerFile(entry.checkpointKey));
          await rmdirIfEmpty(path.dirname(tombstoneFile));
          await rmdirIfEmpty(path.dirname(path.dirname(tombstoneFile)));
          await rmdirIfEmpty(path.dirname(path.dirname(path.dirname(tombstoneFile))));
          await rmdirIfEmpty(path.dirname(this.generationDirectory(
            entry.checkpointKey,
            entry.generationId
          )));
          await rmdirIfEmpty(this.checkpointDirectory(entry.checkpointKey));
          await rmdirIfEmpty(this.checkpointShardDirectory(entry.checkpointKey));
        }
        changed = true;
      }
      const nextCursor = (Number.parseInt(shardId, 16) + 1)
        % FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards;
      if (changed || nextCursor !== ledger.tombstoneCursor) {
        ledger = await this.mutateTombstoneLedgerShardLocked(
          ledger,
          shardId,
          () => nextEntries,
          nextCursor
        );
      }
    }
    return ledger;
  }


  private async readTombstone(
    checkpointKey: string,
    generationId: string
  ): Promise<FileCheckpointTombstone | null> {
    const storageDigest = createGenerationStorageDigest(
      checkpointKey,
      generationId
    );
    try {
      const tombstone = await this.readTombstoneFile(
        this.tombstoneFile(checkpointKey, generationId),
        storageDigest,
        checkpointKey,
        generationId
      );
      await this.assertTombstoneLedgerEntry(tombstone);
      return tombstone;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableFileCheckpointStoreError) throw error;
      throw checkpointIntegrity(
        'Durable checkpoint tombstone failed integrity validation.',
        error
      );
    }
  }

  private async readTombstoneCatalog(): Promise<FileCheckpointTombstone[]> {
    const directory = this.tombstoneDirectory();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw checkpointIntegrity(
        'Durable checkpoint tombstone catalog is unreadable.',
        error
      );
    }
    if (
      entries.filter(entry => !entry.name.endsWith('.tmp')).length
      > Math.min(
        FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstoneDirectoryEntries,
        this.maxTombstones + 32
      )
    ) {
      throw checkpointScanLimit(
        'Durable checkpoint tombstone scan exceeds its configured limit.'
      );
    }
    const tombstones: FileCheckpointTombstone[] = [];
    for (const entry of entries.filter(entry => !entry.name.endsWith('.tmp'))) {
      const match = TOMBSTONE_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw checkpointIntegrity(
          'Durable checkpoint tombstone catalog contains an invalid entry.'
        );
      }
      this.ioObserver?.('legacy-tombstone-read', entry.name);
      tombstones.push(await this.readTombstoneFile(
        this.resolveInside(directory, entry.name),
        match[1]
      ));
    }
    if (tombstones.length > this.maxTombstones) {
      throw checkpointScanLimit(
        'Durable checkpoint tombstone scan exceeds its configured limit.'
      );
    }
    return tombstones;
  }

  private async readTombstoneFile(
    file: string,
    expectedCheckpointKeyDigest: string,
    expectedCheckpointKey?: string,
    expectedGenerationId?: string
  ): Promise<FileCheckpointTombstone> {
    const bytes = await readBoundedBytes(
      file,
      FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstoneBytes
    );
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    assertTombstone(
      value,
      expectedCheckpointKeyDigest,
      expectedCheckpointKey,
      expectedGenerationId
    );
    return { ...value };
  }

  private async pruneExpiredTombstones(): Promise<number> {
    return withFileCheckpointLock(this.capacityLockKey(), async () => {
      const ledger = await this.readLedgerLocked();
      const nextLedger = await this.pruneExpiredTombstonesLocked(ledger);
      return nextLedger.tombstoneCount;
    });
  }
  private async garbageCollectTemporaryFiles(): Promise<void> {
    const directory = this.temporaryDirectory();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
      this.ioObserver?.('temporary-directory-scan', directory);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw checkpointIntegrity(
        'Durable checkpoint temporary directory is unreadable.',
        error
      );
    }
    if (
      entries.length
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTemporaryEntries
    ) {
      throw checkpointScanLimit(
        'Durable checkpoint temporary cleanup exceeds its bounded entry limit.'
      );
    }
    const now = assertValidDate(this.now(), 'checkpoint store clock').getTime();
    const expired = entries.map(entry => {
      const match = TEMPORARY_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw checkpointIntegrity(
          'Durable checkpoint temporary directory contains an invalid entry.'
        );
      }
      return {
        file: this.resolveInside(directory, entry.name),
        createdAt: Number(match[1]),
      };
    }).filter(entry => (
      Number.isSafeInteger(entry.createdAt)
      && entry.createdAt + this.temporaryFileTtlMs <= now
    )).sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTemporaryGcPerPass);
    for (const entry of expired) {
      await unlinkIfExists(entry.file);
    }
  }


  private async injectCrash(
    point: FileDurableCheckpointCrashPoint,
    checkpointKey: string
  ): Promise<void> {
    await this.crashInjector?.(point, checkpointKey);
  }

  private lockKey(checkpointKey: string): string {
    return this.rootDir + '\u0000' + checkpointKey;
  }

  private capacityLockKey(): string {
    return this.rootDir + '\u0000__thread_capacity__';
  }

  private metadataDirectory(): string {
    return this.resolveInside(this.rootDir, '.checkpoint-metadata-v1');
  }

  private ledgerFile(): string {
    return this.resolveInside(this.metadataDirectory(), 'ledger.json');
  }

  private ledgerTransactionFile(): string {
    return this.resolveInside(this.metadataDirectory(), 'transaction.json');
  }

  private reservationLedgerDirectory(): string {
    return this.resolveInside(this.metadataDirectory(), 'reservation-shards');
  }

  private reservationLedgerShardFile(shardId: string): string {
    assertLedgerShardId(shardId);
    return this.resolveInside(this.reservationLedgerDirectory(), shardId + '.json');
  }

  private tombstoneLedgerDirectory(): string {
    return this.resolveInside(this.metadataDirectory(), 'tombstone-shards');
  }

  private tombstoneLedgerShardFile(shardId: string): string {
    assertLedgerShardId(shardId);
    return this.resolveInside(this.tombstoneLedgerDirectory(), shardId + '.json');
  }

  private temporaryDirectory(): string {
    return this.resolveInside(this.metadataDirectory(), 'tmp');
  }


  private threadReservationDirectory(): string {
    return this.resolveInside(this.rootDir, 'threads');
  }

  private threadReservationFile(
    checkpointKey: string,
    generationId: string
  ): string {
    return this.resolveInside(
      this.threadReservationDirectory(),
      createGenerationStorageDigest(checkpointKey, generationId) + '.json'
    );
  }

  private tombstoneDirectory(): string {
    return this.resolveInside(this.rootDir, 'tombstones');
  }

  private tombstoneFile(checkpointKey: string, generationId: string): string {
    const checkpointKeyDigest = sha256(checkpointKey);
    return this.resolveInside(
      this.tombstoneDirectory(),
      checkpointKeyDigest.slice(0, 2),
      checkpointKeyDigest,
      sha256(assertDurableGenerationId(generationId)) + '.json'
    );
  }

  private checkpointShardDirectory(checkpointKey: string): string {
    const digest = sha256(checkpointKey);
    return this.resolveInside(this.rootDir, digest.slice(0, 2));
  }

  private checkpointDirectory(checkpointKey: string): string {
    const digest = sha256(checkpointKey);
    return this.resolveInside(
      this.checkpointShardDirectory(checkpointKey),
      digest
    );
  }

  private currentPointerFile(checkpointKey: string): string {
    return this.resolveInside(this.checkpointDirectory(checkpointKey), 'current.json');
  }

  private generationDirectory(
    checkpointKey: string,
    generationId: string
  ): string {
    return this.resolveInside(
      this.checkpointDirectory(checkpointKey),
      'generations',
      sha256(assertDurableGenerationId(generationId))
    );
  }

  private latestPointerFile(
    checkpointKey: string,
    generationId: string
  ): string {
    return this.resolveInside(
      this.generationDirectory(checkpointKey, generationId),
      'latest.json'
    );
  }


  private revisionDirectory(
    checkpointKey: string,
    generationId: string
  ): string {
    return this.resolveInside(
      this.generationDirectory(checkpointKey, generationId),
      'revisions'
    );
  }

  private revisionFile(
    checkpointKey: string,
    generationId: string,
    revision: number
  ): string {
    const fileName = String(revision).padStart(16, '0') + '.json';
    return this.resolveInside(
      this.revisionDirectory(checkpointKey, generationId),
      fileName
    );
  }

  private resolveInside(root: string, ...segments: string[]): string {
    const candidate = path.resolve(root, ...segments);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Durable checkpoint path escaped its configured root.');
    }
    return candidate;
  }
}

function serializeMetadata(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function cloneMetadata<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type FileCheckpointLedgerPayload = Omit<FileCheckpointLedger, 'ledgerDigest'>;

function omitLedgerDigest(
  ledger: FileCheckpointLedger
): FileCheckpointLedgerPayload {
  const payload: Partial<FileCheckpointLedger> = { ...ledger };
  delete payload.ledgerDigest;
  return cloneMetadata(payload) as FileCheckpointLedgerPayload;
}

function createCheckpointLedger(
  payload: FileCheckpointLedgerPayload
): FileCheckpointLedger {
  return {
    ...payload,
    ledgerDigest: sha256(
      stableStringify(payload as unknown as DurableJsonValue)
    ),
  };
}

function assertCheckpointLedger(
  value: unknown
): asserts value is FileCheckpointLedger {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_LEDGER_VERSION
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || typeof value.generationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.generationId)
    || !Number.isSafeInteger(value.reservationCount)
    || (value.reservationCount as number) < 0
    || (value.reservationCount as number)
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreads
    || !Number.isSafeInteger(value.totalReservedBytes)
    || (value.totalReservedBytes as number) < 0
    || (value.totalReservedBytes as number)
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes
    || !Number.isSafeInteger(value.tombstoneCount)
    || (value.tombstoneCount as number) < 0
    || (value.tombstoneCount as number)
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxTombstones
    || !isLedgerCursor(value.reservationCursor)
    || !isLedgerCursor(value.tombstoneCursor)
    || !isRecord(value.reservationShards)
    || !isRecord(value.tombstoneShards)
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.ledgerDigest !== 'string'
    || !SHA256_PATTERN.test(value.ledgerDigest)
  ) {
    throw checkpointIntegrity('Durable checkpoint ledger root is invalid.');
  }
  const ledger = value as unknown as FileCheckpointLedger;
  const reservationTotals = assertLedgerShardSummaryMap(
    ledger.reservationShards,
    true
  );
  const tombstoneTotals = assertLedgerShardSummaryMap(
    ledger.tombstoneShards,
    false
  );
  if (
    reservationTotals.entryCount !== ledger.reservationCount
    || reservationTotals.reservedBytes !== ledger.totalReservedBytes
    || tombstoneTotals.entryCount !== ledger.tombstoneCount
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint ledger totals do not match its shard summaries.'
    );
  }
  const { ledgerDigest, ...payload } = ledger;
  if (
    sha256(stableStringify(payload as unknown as DurableJsonValue))
    !== ledgerDigest
  ) {
    throw checkpointIntegrity('Durable checkpoint ledger digest is invalid.');
  }
}

function assertLedgerShardSummaryMap(
  summaries: Record<string, FileCheckpointLedgerShardSummary>,
  reservation: boolean
): { entryCount: number; reservedBytes: number } {
  const entries = Object.entries(summaries);
  if (entries.length > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards) {
    throw checkpointIntegrity(
      'Durable checkpoint ledger has too many shard summaries.'
    );
  }
  let entryCount = 0;
  let reservedBytes = 0;
  for (const [shardId, summary] of entries) {
    assertLedgerShardId(shardId);
    if (
      !isRecord(summary)
      || !Number.isSafeInteger(summary.generation)
      || (summary.generation as number) < 1
      || !Number.isSafeInteger(summary.entryCount)
      || (summary.entryCount as number) < 0
      || (summary.entryCount as number)
        > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardEntries
      || !Number.isSafeInteger(summary.reservedBytes)
      || (summary.reservedBytes as number) < 0
      || (summary.reservedBytes as number)
        > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes
      || (!reservation && summary.reservedBytes !== 0)
      || typeof summary.shardDigest !== 'string'
      || !SHA256_PATTERN.test(summary.shardDigest)
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint ledger shard summary is invalid.'
      );
    }
    entryCount += summary.entryCount as number;
    reservedBytes += summary.reservedBytes as number;
    if (
      !Number.isSafeInteger(entryCount)
      || !Number.isSafeInteger(reservedBytes)
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint ledger shard totals are unsafe.'
      );
    }
  }
  return { entryCount, reservedBytes };
}

function isLedgerCursor(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number)
      < FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards;
}

function assertLedgerShardId(shardId: string): void {
  if (!LEDGER_SHARD_ID_PATTERN.test(shardId)) {
    throw checkpointIntegrity('Durable checkpoint ledger shard id is invalid.');
  }
}

type ReservationLedgerShardPayload = Omit<
  FileCheckpointReservationLedgerShard,
  'shardDigest'
>;
type TombstoneLedgerShardPayload = Omit<
  FileCheckpointTombstoneLedgerShard,
  'shardDigest'
>;

function createReservationLedgerShard(
  shardId: string,
  generation: number,
  entries: FileCheckpointReservationLedgerEntry[]
): FileCheckpointReservationLedgerShard {
  const payload: ReservationLedgerShardPayload = {
    schemaVersion: FILE_DURABLE_CHECKPOINT_RESERVATION_SHARD_VERSION,
    shardId,
    generation,
    entries: normalizeReservationLedgerEntries(entries),
  };
  return {
    ...payload,
    shardDigest: sha256(
      stableStringify(payload as unknown as DurableJsonValue)
    ),
  };
}

function createTombstoneLedgerShard(
  shardId: string,
  generation: number,
  entries: FileCheckpointTombstoneLedgerEntry[]
): FileCheckpointTombstoneLedgerShard {
  const payload: TombstoneLedgerShardPayload = {
    schemaVersion: FILE_DURABLE_CHECKPOINT_TOMBSTONE_SHARD_VERSION,
    shardId,
    generation,
    entries: normalizeTombstoneLedgerEntries(entries),
  };
  return {
    ...payload,
    shardDigest: sha256(
      stableStringify(payload as unknown as DurableJsonValue)
    ),
  };
}

function normalizeReservationLedgerEntries(
  entries: FileCheckpointReservationLedgerEntry[]
): FileCheckpointReservationLedgerEntry[] {
  if (
    entries.length
    > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardEntries
  ) {
    throw new DurableWorkflowCapacityError();
  }
  const sorted = entries.map(entry => ({ ...entry })).sort(
    (left, right) => left.checkpointKeyDigest.localeCompare(
      right.checkpointKeyDigest
    )
  );
  for (let index = 0; index < sorted.length; index += 1) {
    assertReservationLedgerEntry(sorted[index]);
    if (
      index > 0
      && sorted[index - 1].checkpointKeyDigest
        === sorted[index].checkpointKeyDigest
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint reservation shard contains duplicate identities.'
      );
    }
  }
  return sorted;
}

function normalizeTombstoneLedgerEntries(
  entries: FileCheckpointTombstoneLedgerEntry[]
): FileCheckpointTombstoneLedgerEntry[] {
  if (
    entries.length
    > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardEntries
  ) {
    throw new DurableWorkflowCapacityError();
  }
  const sorted = entries.map(entry => ({ ...entry })).sort(
    (left, right) => left.checkpointKeyDigest.localeCompare(
      right.checkpointKeyDigest
    )
  );
  for (let index = 0; index < sorted.length; index += 1) {
    assertTombstoneLedgerEntry(sorted[index]);
    if (
      index > 0
      && sorted[index - 1].checkpointKeyDigest
        === sorted[index].checkpointKeyDigest
    ) {
      throw checkpointIntegrity(
        'Durable checkpoint tombstone shard contains duplicate identities.'
      );
    }
  }
  return sorted;
}

function assertReservationLedgerEntry(
  entry: unknown
): asserts entry is FileCheckpointReservationLedgerEntry {
  if (
    !isRecord(entry)
    || typeof entry.checkpointKey !== 'string'
    || !isSafeIdentifier(entry.generationId, 128)
    || typeof entry.checkpointKeyDigest !== 'string'
    || !SHA256_PATTERN.test(entry.checkpointKeyDigest)
    || createGenerationStorageDigest(
      entry.checkpointKey,
      entry.generationId as string
    ) !== entry.checkpointKeyDigest
    || !Number.isSafeInteger(entry.reservedBytes)
    || (entry.reservedBytes as number) < 1
    || (entry.reservedBytes as number)
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes
    || (entry.state !== 'reserved' && entry.state !== 'committed')
    || typeof entry.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(entry.updatedAt))
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint reservation ledger entry is invalid.'
    );
  }
  try {
    assertCheckpointKey(entry.checkpointKey);
  } catch (error) {
    throw checkpointIntegrity(
      'Durable checkpoint reservation ledger identity is invalid.',
      error
    );
  }
}

function assertTombstoneLedgerEntry(
  entry: unknown
): asserts entry is FileCheckpointTombstoneLedgerEntry {
  if (
    !isRecord(entry)
    || typeof entry.checkpointKey !== 'string'
    || !isSafeIdentifier(entry.generationId, 128)
    || typeof entry.checkpointKeyDigest !== 'string'
    || !SHA256_PATTERN.test(entry.checkpointKeyDigest)
    || createGenerationStorageDigest(
      entry.checkpointKey,
      entry.generationId as string
    ) !== entry.checkpointKeyDigest
    || !Number.isSafeInteger(entry.deletedRevision)
    || (entry.deletedRevision as number) < 0
    || typeof entry.deletedAt !== 'string'
    || !Number.isFinite(Date.parse(entry.deletedAt))
    || (
      entry.cleanupAcknowledgedAt !== undefined
      && (
        typeof entry.cleanupAcknowledgedAt !== 'string'
        || !Number.isFinite(Date.parse(entry.cleanupAcknowledgedAt))
      )
    )
    || (entry.state !== 'reserved' && entry.state !== 'committed')
    || typeof entry.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(entry.updatedAt))
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint tombstone ledger entry is invalid.'
    );
  }
  try {
    assertCheckpointKey(entry.checkpointKey);
  } catch (error) {
    throw checkpointIntegrity(
      'Durable checkpoint tombstone ledger identity is invalid.',
      error
    );
  }
}

function assertReservationLedgerShard(
  value: unknown,
  summary: FileCheckpointLedgerShardSummary
): asserts value is FileCheckpointReservationLedgerShard {
  if (
    !isRecord(value)
    || value.schemaVersion
      !== FILE_DURABLE_CHECKPOINT_RESERVATION_SHARD_VERSION
    || typeof value.shardId !== 'string'
    || !LEDGER_SHARD_ID_PATTERN.test(value.shardId)
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || !Array.isArray(value.entries)
    || value.entries.length
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardEntries
    || typeof value.shardDigest !== 'string'
    || !SHA256_PATTERN.test(value.shardDigest)
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint reservation ledger shard is invalid.'
    );
  }
  const shard = value as unknown as FileCheckpointReservationLedgerShard;
  const normalized = normalizeReservationLedgerEntries(shard.entries);
  if (
    JSON.stringify(normalized) !== JSON.stringify(shard.entries)
    || shard.generation !== summary.generation
    || shard.entries.length !== summary.entryCount
    || shard.shardDigest !== summary.shardDigest
    || createLedgerShardSummary(shard).reservedBytes !== summary.reservedBytes
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint reservation ledger shard conflicts with its summary.'
    );
  }
  const { shardDigest, ...payload } = shard;
  if (
    sha256(stableStringify(payload as unknown as DurableJsonValue))
    !== shardDigest
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint reservation ledger shard digest is invalid.'
    );
  }
}

function assertTombstoneLedgerShard(
  value: unknown,
  summary: FileCheckpointLedgerShardSummary
): asserts value is FileCheckpointTombstoneLedgerShard {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_TOMBSTONE_SHARD_VERSION
    || typeof value.shardId !== 'string'
    || !LEDGER_SHARD_ID_PATTERN.test(value.shardId)
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || !Array.isArray(value.entries)
    || value.entries.length
      > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShardEntries
    || typeof value.shardDigest !== 'string'
    || !SHA256_PATTERN.test(value.shardDigest)
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint tombstone ledger shard is invalid.'
    );
  }
  const shard = value as unknown as FileCheckpointTombstoneLedgerShard;
  const normalized = normalizeTombstoneLedgerEntries(shard.entries);
  if (
    JSON.stringify(normalized) !== JSON.stringify(shard.entries)
    || shard.generation !== summary.generation
    || shard.entries.length !== summary.entryCount
    || shard.shardDigest !== summary.shardDigest
    || summary.reservedBytes !== 0
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint tombstone ledger shard conflicts with its summary.'
    );
  }
  const { shardDigest, ...payload } = shard;
  if (
    sha256(stableStringify(payload as unknown as DurableJsonValue))
    !== shardDigest
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint tombstone ledger shard digest is invalid.'
    );
  }
}

function createLedgerShardSummary(
  shard:
    | FileCheckpointReservationLedgerShard
    | FileCheckpointTombstoneLedgerShard
): FileCheckpointLedgerShardSummary {
  const reservedBytes = shard.schemaVersion
    === FILE_DURABLE_CHECKPOINT_RESERVATION_SHARD_VERSION
    ? shard.entries.reduce((sum, entry) => sum + entry.reservedBytes, 0)
    : 0;
  return {
    generation: shard.generation,
    entryCount: shard.entries.length,
    reservedBytes,
    shardDigest: shard.shardDigest,
  };
}

type LedgerTransactionPayload = Omit<
  FileCheckpointLedgerTransaction,
  'transactionDigest'
>;

function createLedgerTransaction(
  payload: LedgerTransactionPayload
): FileCheckpointLedgerTransaction {
  return {
    ...payload,
    transactionDigest: sha256(
      stableStringify(payload as unknown as DurableJsonValue)
    ),
  };
}

function assertLedgerTransaction(
  value: unknown
): asserts value is FileCheckpointLedgerTransaction {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_LEDGER_TRANSACTION_VERSION
    || typeof value.transactionId !== 'string'
    || !/^[a-f0-9-]{36}$/.test(value.transactionId)
    || (value.kind !== 'reservation' && value.kind !== 'tombstone')
    || typeof value.shardId !== 'string'
    || !LEDGER_SHARD_ID_PATTERN.test(value.shardId)
    || (
      value.previousLedgerDigest !== null
      && (
        typeof value.previousLedgerDigest !== 'string'
        || !SHA256_PATTERN.test(value.previousLedgerDigest)
      )
    )
    || typeof value.transactionDigest !== 'string'
    || !SHA256_PATTERN.test(value.transactionDigest)
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint ledger transaction is invalid.'
    );
  }
  assertCheckpointLedger(value.nextLedger);
  const transaction = value as unknown as FileCheckpointLedgerTransaction;
  if (transaction.kind === 'reservation') {
    const summary = transaction.nextLedger.reservationShards[
      transaction.shardId
    ];
    if (!summary || !transaction.nextReservationShard) {
      throw checkpointIntegrity(
        'Durable checkpoint reservation transaction is incomplete.'
      );
    }
    assertReservationLedgerShard(transaction.nextReservationShard, summary);
    if (transaction.nextTombstoneShard !== undefined) {
      throw checkpointIntegrity(
        'Durable checkpoint reservation transaction has an extra shard.'
      );
    }
  } else {
    const summary = transaction.nextLedger.tombstoneShards[
      transaction.shardId
    ];
    if (!summary || !transaction.nextTombstoneShard) {
      throw checkpointIntegrity(
        'Durable checkpoint tombstone transaction is incomplete.'
      );
    }
    assertTombstoneLedgerShard(transaction.nextTombstoneShard, summary);
    if (transaction.nextReservationShard !== undefined) {
      throw checkpointIntegrity(
        'Durable checkpoint tombstone transaction has an extra shard.'
      );
    }
  }
  const { transactionDigest, ...payload } = transaction;
  if (
    sha256(stableStringify(payload as unknown as DurableJsonValue))
    !== transactionDigest
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint ledger transaction digest is invalid.'
    );
  }
}

function selectLedgerShardIds(
  shardIds: string[],
  cursor: number,
  maximum: number
): string[] {
  if (!isLedgerCursor(cursor)) {
    throw checkpointIntegrity('Durable checkpoint ledger cursor is invalid.');
  }
  const unique = new Set(shardIds);
  if (
    unique.size !== shardIds.length
    || unique.size > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards
  ) {
    throw checkpointIntegrity('Durable checkpoint ledger shard list is invalid.');
  }
  return [...unique].map(shardId => {
    assertLedgerShardId(shardId);
    return shardId;
  }).sort((left, right) => {
    const leftDistance = (
      Number.parseInt(left, 16) - cursor
      + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards
    ) % FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards;
    const rightDistance = (
      Number.parseInt(right, 16) - cursor
      + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards
    ) % FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLedgerShards;
    return leftDistance - rightDistance;
  }).slice(0, maximum);
}


function createCheckpointEnvelope(
  checkpoint: DurableWorkflowCheckpoint
): FileCheckpointEnvelope {
  return {
    schemaVersion: FILE_DURABLE_CHECKPOINT_SCHEMA_VERSION,
    checkpointKey: checkpoint.checkpointKey,
    generationId: checkpoint.generationId,
    revision: checkpoint.revision,
    checkpointDigest: createCheckpointDigest(checkpoint),
    checkpoint: cloneCheckpoint(checkpoint),
  };
}
type FileCheckpointLatestPointerPayload = Omit<
  FileCheckpointLatestPointer,
  'pointerDigest'
>;

function createLatestPointer(
  envelope: FileCheckpointEnvelope
): FileCheckpointLatestPointer {
  const payload: FileCheckpointLatestPointerPayload = {
    schemaVersion: FILE_DURABLE_CHECKPOINT_LATEST_POINTER_VERSION,
    checkpointKey: envelope.checkpointKey,
    generationId: envelope.generationId,
    revision: envelope.revision,
    checkpointDigest: envelope.checkpointDigest,
  };
  return {
    ...payload,
    pointerDigest: createLatestPointerDigest(payload),
  };
}

function createLatestPointerDigest(
  payload: FileCheckpointLatestPointerPayload
): string {
  return sha256(stableStringify(payload as unknown as DurableJsonValue));
}

type FileCheckpointCurrentPointerPayload = Omit<
  FileCheckpointCurrentPointer,
  'pointerDigest'
>;

function createCurrentPointer(
  payload: FileCheckpointCurrentPointerPayload
): FileCheckpointCurrentPointer {
  return {
    ...payload,
    pointerDigest: sha256(stableStringify(
      payload as unknown as DurableJsonValue
    )),
  };
}

function assertCurrentPointer(
  value: unknown,
  expectedCheckpointKey: string
): asserts value is FileCheckpointCurrentPointer {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_CURRENT_POINTER_VERSION
    || value.checkpointKey !== expectedCheckpointKey
    || typeof value.generationId !== 'string'
    || assertDurableGenerationId(value.generationId) !== value.generationId
    || !['pending', 'active', 'deleted'].includes(String(value.state))
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || (
      value.state === 'deleted'
        ? typeof value.deletedAt !== 'string'
          || !Number.isFinite(Date.parse(value.deletedAt))
        : value.deletedAt !== undefined
    )
    || typeof value.pointerDigest !== 'string'
    || !SHA256_PATTERN.test(value.pointerDigest)
  ) {
    throw checkpointIntegrity('Durable checkpoint current pointer is invalid.');
  }
  const { pointerDigest, ...payload } =
    value as unknown as FileCheckpointCurrentPointer;
  if (
    sha256(stableStringify(payload as unknown as DurableJsonValue))
    !== pointerDigest
  ) {
    throw checkpointIntegrity('Durable checkpoint current pointer digest is invalid.');
  }
}

function assertLatestPointer(
  value: unknown,
  expectedCheckpointKey: string,
  expectedGenerationId: string
): asserts value is FileCheckpointLatestPointer {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_LATEST_POINTER_VERSION
    || value.checkpointKey !== expectedCheckpointKey
    || value.generationId !== expectedGenerationId
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || (value.revision as number) >= Number.MAX_SAFE_INTEGER
    || typeof value.checkpointDigest !== 'string'
    || !SHA256_PATTERN.test(value.checkpointDigest)
    || typeof value.pointerDigest !== 'string'
    || !SHA256_PATTERN.test(value.pointerDigest)
  ) {
    throw checkpointIntegrity('Durable checkpoint latest pointer is invalid.');
  }
  const { pointerDigest, ...payload } =
    value as unknown as FileCheckpointLatestPointer;
  if (createLatestPointerDigest(payload) !== pointerDigest) {
    throw checkpointIntegrity(
      'Durable checkpoint latest pointer digest is invalid.'
    );
  }
}


function assertCheckpointEnvelope(
  value: unknown,
  expectedKey: string,
  expectedGenerationId: string,
  expectedRevision: number,
  maxSerializedBytes: number
): asserts value is FileCheckpointEnvelope {
  if (!isRecord(value) || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_SCHEMA_VERSION) {
    throw checkpointIntegrity('Unsupported durable checkpoint file schema.');
  }
  if (
    value.checkpointKey !== expectedKey
    || value.generationId !== expectedGenerationId
    || value.revision !== expectedRevision
    || typeof value.checkpointDigest !== 'string'
    || !SHA256_PATTERN.test(value.checkpointDigest)
  ) {
    throw checkpointIntegrity('Durable checkpoint file identity is invalid.');
  }
  assertCheckpointForStorage(
    value.checkpoint as DurableWorkflowCheckpoint,
    maxSerializedBytes
  );
  const checkpoint = value.checkpoint as DurableWorkflowCheckpoint;
  if (
    checkpoint.checkpointKey !== expectedKey
    || checkpoint.generationId !== expectedGenerationId
    || checkpoint.revision !== expectedRevision
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint content does not match its storage path.'
    );
  }
  if (createCheckpointDigest(checkpoint) !== value.checkpointDigest) {
    throw checkpointIntegrity(
      'Durable checkpoint content digest does not match its envelope.'
    );
  }
}

function assertTombstone(
  value: unknown,
  expectedStorageDigest: string,
  expectedCheckpointKey?: string,
  expectedGenerationId?: string
): asserts value is FileCheckpointTombstone {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_TOMBSTONE_VERSION
    || typeof value.checkpointKey !== 'string'
    || !CHECKPOINT_KEY_PATTERN.test(value.checkpointKey)
    || typeof value.generationId !== 'string'
    || createGenerationStorageDigest(
      value.checkpointKey,
      value.generationId
    ) !== expectedStorageDigest
    || (
      expectedCheckpointKey !== undefined
      && value.checkpointKey !== expectedCheckpointKey
    )
    || (
      expectedGenerationId !== undefined
      && value.generationId !== expectedGenerationId
    )
    || !Number.isSafeInteger(value.deletedRevision)
    || (value.deletedRevision as number) < 0
    || typeof value.checkpointDigest !== 'string'
    || !SHA256_PATTERN.test(value.checkpointDigest)
    || typeof value.deletedAt !== 'string'
    || !Number.isFinite(Date.parse(value.deletedAt))
    || (
      value.cleanupAcknowledgedAt !== undefined
      && (
        typeof value.cleanupAcknowledgedAt !== 'string'
        || !Number.isFinite(Date.parse(value.cleanupAcknowledgedAt))
      )
    )
    || typeof value.tombstoneDigest !== 'string'
    || !SHA256_PATTERN.test(value.tombstoneDigest)
  ) {
    throw checkpointIntegrity('Durable checkpoint tombstone is invalid.');
  }
  const { tombstoneDigest, ...payload } = value as unknown as FileCheckpointTombstone;
  if (createTombstoneDigest(payload) !== tombstoneDigest) {
    throw checkpointIntegrity('Durable checkpoint tombstone digest is invalid.');
  }
}

type FileCheckpointTombstonePayload = Omit<
  FileCheckpointTombstone,
  'tombstoneDigest'
>;

function createTombstone(
  payload: FileCheckpointTombstonePayload
): FileCheckpointTombstone {
  return {
    ...payload,
    tombstoneDigest: createTombstoneDigest(payload),
  };
}

function createTombstoneDigest(
  payload: FileCheckpointTombstonePayload
): string {
  return sha256(stableStringify(payload as unknown as DurableJsonValue));
}

function assertTombstoneBoundsCatalog(
  tombstone: FileCheckpointTombstone,
  catalog: RevisionCatalog
): void {
  if (!catalog.latest) return;
  if (
    catalog.latest.revision > tombstone.deletedRevision
    || (
      catalog.latest.revision === tombstone.deletedRevision
      && catalog.latest.checkpointDigest !== tombstone.checkpointDigest
    )
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint tombstone conflicts with immutable revision history.'
    );
  }
}


type FileCheckpointThreadReservationPayload = Omit<
  FileCheckpointThreadReservation,
  'reservationDigest'
>;

function createThreadReservation(
  payload: FileCheckpointThreadReservationPayload
): FileCheckpointThreadReservation {
  return {
    ...payload,
    reservationDigest: createThreadReservationDigest(payload),
  };
}

function createThreadReservationDigest(
  payload: FileCheckpointThreadReservationPayload
): string {
  return sha256(stableStringify(payload as unknown as DurableJsonValue));
}

function assertThreadReservation(
  value: unknown,
  expectedStorageDigest: string,
  expectedCheckpointKey?: string,
  expectedGenerationId?: string
): asserts value is FileCheckpointThreadReservation {
  if (
    !isRecord(value)
    || value.schemaVersion !== FILE_DURABLE_CHECKPOINT_THREAD_RESERVATION_VERSION
    || typeof value.checkpointKey !== 'string'
    || typeof value.generationId !== 'string'
    || typeof value.checkpointKeyDigest !== 'string'
    || !SHA256_PATTERN.test(value.checkpointKeyDigest)
    || typeof value.reservedAt !== 'string'
    || !Number.isFinite(Date.parse(value.reservedAt))
    || (
      value.reservedBytes !== undefined
      && (
        !Number.isSafeInteger(value.reservedBytes)
        || (value.reservedBytes as number) < 1
        || (value.reservedBytes as number)
          > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes
      )
    )
    || typeof value.reservationDigest !== 'string'
    || !SHA256_PATTERN.test(value.reservationDigest)
  ) {
    throw checkpointIntegrity('Durable checkpoint thread reservation is invalid.');
  }
  let checkpointKey: string;
  try {
    checkpointKey = assertCheckpointKey(value.checkpointKey);
  } catch (error) {
    throw checkpointIntegrity(
      'Durable checkpoint thread reservation identity is invalid.',
      error
    );
  }
  if (
    createGenerationStorageDigest(checkpointKey, value.generationId)
      !== expectedStorageDigest
    || value.checkpointKeyDigest !== expectedStorageDigest
    || (expectedCheckpointKey !== undefined && checkpointKey !== expectedCheckpointKey)
    || (
      expectedGenerationId !== undefined
      && value.generationId !== expectedGenerationId
    )
  ) {
    throw checkpointIntegrity(
      'Durable checkpoint thread reservation does not match its storage path.'
    );
  }
  const { reservationDigest, ...payload } =
    value as unknown as FileCheckpointThreadReservation;
  if (createThreadReservationDigest(payload) !== reservationDigest) {
    throw checkpointIntegrity(
      'Durable checkpoint thread reservation digest is invalid.'
    );
  }
}

function assertCheckpointForStorage(
  checkpoint: DurableWorkflowCheckpoint,
  maxSerializedBytes: number
): void {
  assertDurableWorkflowSerializable(checkpoint, {
    label: 'file checkpoint',
    maxBytes: maxSerializedBytes,
  });
  if (
    checkpoint.schemaVersion !== DURABLE_WORKFLOW_CHECKPOINT_VERSION
    || assertCheckpointKey(checkpoint.checkpointKey) !== checkpoint.checkpointKey
    || assertDurableGenerationId(checkpoint.generationId) !== checkpoint.generationId
    || !Number.isSafeInteger(checkpoint.revision)
    || checkpoint.revision < 0
    || !isCheckpointStatus(checkpoint.status)
    || typeof checkpoint.integrityTag !== 'string'
    || !/^(?:sha256|hmac-sha256):[a-f0-9]{64}$/.test(checkpoint.integrityTag)
    || typeof checkpoint.createdAt !== 'string'
    || !Number.isFinite(Date.parse(checkpoint.createdAt))
    || typeof checkpoint.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(checkpoint.updatedAt))
  ) {
    throw checkpointIntegrity('Durable checkpoint has an invalid persisted shape.');
  }
  const workflowId = checkpoint.checkpointKey.split('/')[1];
  if (checkpoint.workflowId !== workflowId) {
    throw checkpointIntegrity(
      'Durable checkpoint workflow does not match its checkpoint key.'
    );
  }
  assertCheckpointIdentityAndLease(checkpoint);
}

function assertCheckpointKey(value: string): string {
  const normalized = value?.trim();
  if (!normalized || !CHECKPOINT_KEY_PATTERN.test(normalized)) {
    throw new Error('checkpointKey must be a canonical durable checkpoint key.');
  }
  return normalized;
}

function assertExpectedRevision(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new DurableWorkflowConflictError('Invalid expected checkpoint revision.');
  }
}

function assertCheckpointIdentityAndLease(
  checkpoint: DurableWorkflowCheckpoint
): void {
  const identity = checkpoint.identity as unknown;
  if (!isRecord(identity)) {
    throw checkpointIntegrity('Durable checkpoint identity is invalid.');
  }
  const allowedTrustLevels = identity.allowedTrustLevels;
  if (
    !Array.isArray(allowedTrustLevels)
    || allowedTrustLevels.length < 1
    || allowedTrustLevels.some(level => (
      typeof level !== 'string'
      || !['trusted', 'reviewed', 'external', 'quarantined'].includes(level)
    ))
    || [...new Set(allowedTrustLevels)].sort().join('\u0000')
      !== allowedTrustLevels.join('\u0000')
    || typeof identity.enforceIsolation !== 'boolean'
    || !isSafeIdentifier(identity.threadId, 256)
    || !isSafeIdentifier(identity.tenantId, 128)
    || !isSafeIdentifier(identity.corpusId, 128)
    || !isSafeIdentifier(identity.documentId, 256)
    || !isSafeIdentifier(identity.documentVersion, 256)
    || !isSafeIdentifier(checkpoint.workflowId, 128)
    || !isSafeIdentifier(checkpoint.workflowVersion, 128)
    || !isSafeIdentifier(checkpoint.idempotencyKey, 256)
    || !SHA256_PATTERN.test(checkpoint.jobFingerprint)
    || !Number.isSafeInteger(checkpoint.nextStepIndex)
    || checkpoint.nextStepIndex < 0
    || !Array.isArray(checkpoint.completedStepIds)
    || checkpoint.completedStepIds.some(stepId => !isSafeIdentifier(stepId, 128))
    || new Set(checkpoint.completedStepIds).size !== checkpoint.completedStepIds.length
  ) {
    throw checkpointIntegrity('Durable checkpoint identity or progress is invalid.');
  }
  let expectedKey: string;
  try {
    expectedKey = buildDurableCheckpointKey(
      checkpoint.workflowId,
      identity.threadId as string,
      identity.tenantId as string
    );
  } catch (error) {
    throw checkpointIntegrity('Durable checkpoint identity is invalid.', error);
  }
  if (expectedKey !== checkpoint.checkpointKey) {
    throw checkpointIntegrity(
      'Durable checkpoint key does not match its workflow, tenant, and thread.'
    );
  }
  const activeStep = checkpoint.activeStep as unknown;
  if (checkpoint.status === 'running') {
    if (
      !isRecord(activeStep)
      || !isSafeIdentifier(activeStep.stepId, 128)
      || !isSafeIdentifier(activeStep.stepExecutionId, 256)
      || !isSafeIdentifier(activeStep.leaseOwnerId, 256)
      || typeof activeStep.leaseExpiresAt !== 'string'
      || !Number.isFinite(Date.parse(activeStep.leaseExpiresAt))
    ) {
      throw checkpointIntegrity('Durable checkpoint active lease is invalid.');
    }
  } else if (activeStep !== undefined) {
    throw checkpointIntegrity(
      'A non-running durable checkpoint cannot retain an active lease.'
    );
  }
  if (
    checkpoint.lastFailureCode !== undefined
    && ![
      'STEP_EXECUTION_FAILED',
      'TERMINAL_STEP_FAILURE',
      'INVOCATION_ABORTED',
      'EXPIRED_LEASE_RELEASED',
    ].includes(checkpoint.lastFailureCode)
  ) {
    throw checkpointIntegrity('Durable checkpoint failure code is invalid.');
  }
  if (Date.parse(checkpoint.updatedAt) < Date.parse(checkpoint.createdAt)) {
    throw checkpointIntegrity('Durable checkpoint timestamps are inconsistent.');
  }
}

function isSafeIdentifier(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false;
  const pattern = new RegExp(
    '^[A-Za-z0-9][A-Za-z0-9._:-]{0,' + (maxLength - 1) + '}$'
  );
  return pattern.test(value);
}



function createCheckpointDigest(checkpoint: DurableWorkflowCheckpoint): string {
  return sha256(stableStringify(checkpoint as unknown as DurableJsonValue));
}

function stableStringify(value: DurableJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  return '{' + Object.keys(value)
    .sort()
    .map(key => JSON.stringify(key) + ':' + stableStringify(value[key]))
    .join(',') + '}';
}

function isCheckpointStatus(value: unknown): value is DurableWorkflowCheckpointStatus {
  return typeof value === 'string' && [
    'pending',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ].includes(value);
}

function isTerminalStatus(status: DurableWorkflowCheckpointStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function calculateThreadReservationBytes(
  maxSerializedBytes: number,
  maxRetainedRevisionFiles: number
): number {
  const maximumEnvelopeBytes = maxSerializedBytes
    + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxEnvelopeOverheadBytes;
  const reservedBytes =
    (maxRetainedRevisionFiles + 1) * maximumEnvelopeBytes
    + 2 * FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxLatestPointerBytes
    + FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxThreadReservationBytes;
  if (
    !Number.isSafeInteger(reservedBytes)
    || reservedBytes > FILE_DURABLE_CHECKPOINT_HARD_LIMITS.maxRootReservedBytes
  ) {
    throw new Error(
      'Durable checkpoint reservation exceeds the root byte hard limit.'
    );
  }
  return reservedBytes;
}

function resolveBoundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(field + ' is outside the durable checkpoint hard limit.');
  }
  return resolved;
}

function assertSafeProviderId(value: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error('providerId must be a safe identifier.');
  }
  return normalized;
}

function assertValidDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(label + ' must return a valid Date.');
  }
  return value;
}

function cloneCheckpoint(
  checkpoint: DurableWorkflowCheckpoint
): DurableWorkflowCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as DurableWorkflowCheckpoint;
}

function cloneEnvelope(envelope: FileCheckpointEnvelope): FileCheckpointEnvelope {
  return {
    schemaVersion: envelope.schemaVersion,
    checkpointKey: envelope.checkpointKey,
    generationId: envelope.generationId,
    revision: envelope.revision,
    checkpointDigest: envelope.checkpointDigest,
    checkpoint: cloneCheckpoint(envelope.checkpoint),
  };
}

async function publishImmutableBytes(
  file: string,
  bytes: Uint8Array,
  temporaryDirectory: string
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = path.join(
    temporaryDirectory,
    sha256(file) + '.' + Date.now() + '.' + randomUUID() + '.tmp'
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, file);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original publication error.
      }
    }
    try {
      await unlink(temporary);
    } catch {
      // The immutable target may already be committed. Temporary cleanup must
      // never turn a successful publication into a reported failure.
    }
  }
}

async function replaceBytesAtomically(
  file: string,
  bytes: Uint8Array,
  temporaryDirectory: string
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = path.join(
    temporaryDirectory,
    sha256(file) + '.' + Date.now() + '.' + randomUUID() + '.tmp'
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original pointer publication error.
      }
    }
    try {
      await unlink(temporary);
    } catch {
      // Pointer publication outcome must not be hidden by temp cleanup failure.
    }
  }
}

async function unlinkIfExists(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'r');
    await handle.close();
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function rmdirIfEmpty(directory: string): Promise<boolean> {
  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if (
      isNodeError(error)
      && (
        error.code === 'ENOENT'
        || error.code === 'ENOTEMPTY'
        || error.code === 'EEXIST'
      )
    ) {
      return false;
    }
    throw error;
  }
}

async function readBoundedBytes(
  file: string,
  maxBytes: number
): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('Durable checkpoint storage path is not a regular file.');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new Error('Durable checkpoint file exceeds its byte limit.');
    }
    return Uint8Array.from(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

async function withFileCheckpointLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fileCheckpointLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  fileCheckpointLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (fileCheckpointLocks.get(key) === tail) fileCheckpointLocks.delete(key);
  }
}

function checkpointIntegrity(
  message: string,
  cause?: unknown
): DurableFileCheckpointStoreError {
  return new DurableFileCheckpointStoreError(
    'DURABLE_CHECKPOINT_INTEGRITY',
    message,
    cause
  );
}

function checkpointScanLimit(
  message = 'Durable checkpoint revision scan exceeds its configured limit.'
): DurableFileCheckpointStoreError {
  return new DurableFileCheckpointStoreError(
    'DURABLE_CHECKPOINT_SCAN_LIMIT',
    message
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createGenerationStorageDigest(
  checkpointKey: string,
  generationId: string
): string {
  return sha256(
    assertCheckpointKey(checkpointKey)
      + '\u0000'
      + assertDurableGenerationId(generationId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
