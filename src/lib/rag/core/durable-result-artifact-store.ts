import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { createRetrievalScope, type RagRetrievalScope } from '../../security/retrieval-scope';
import {
  assertDurableGenerationId,
  assertDurableWorkflowSerializable,
  type DurableJsonObject,
  type DurableJsonValue,
} from './durable-workflow';

export const DURABLE_ASK_RESULT_ARTIFACT_VERSION =
  'rag-durable-ask-result-v2' as const;
export const DURABLE_ASK_RESULT_RESERVATION_VERSION =
  'rag-durable-ask-result-reservation-v3' as const;
export const DURABLE_ASK_RESULT_ROOT_LEDGER_VERSION =
  'rag-durable-ask-result-root-ledger-v1' as const;
export const DURABLE_ASK_RESULT_SCOPE_LEDGER_VERSION =
  'rag-durable-ask-result-scope-ledger-v1' as const;
export const DURABLE_ASK_RESULT_SCOPE_MARKER_VERSION =
  'rag-durable-ask-result-scope-marker-v1' as const;
export const DURABLE_ASK_RESULT_STORE_MARKER_VERSION =
  'rag-durable-ask-result-store-marker-v1' as const;
export const DURABLE_ASK_RESULT_GC_CURSOR_VERSION =
  'rag-durable-ask-result-gc-cursor-v1' as const;

export const DURABLE_ASK_RESULT_HARD_LIMITS = Object.freeze({
  maxResultBytes: 8 * 1024 * 1024,
  maxArtifacts: 10_000,
  maxRootBytes: 128 * 1024 * 1024 * 1024,
  maxScopeArtifacts: 5_000,
  maxScopeBytes: 64 * 1024 * 1024 * 1024,
  maxReservationDirectoryEntries: 10_032,
  maxReservationBytes: 16 * 1024,
  maxEnvelopeOverheadBytes: 64 * 1024,
  maxLedgerBytes: 64 * 1024,
  maxMarkerBytes: 8 * 1024,
  maxGcCursorBytes: 8 * 1024,
  maxOrphanTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxGcEntries: 1024,
  maxGcBytes: 1024 * 1024 * 1024,
  maxGcDurationMs: 10_000,
  maxRebuildDurationMs: 30_000,
  maxTemporaryFileTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxTemporaryEntries: 2048,
});

export interface DurableAskResultIdentity {
  generationId: string;
  tenantId: string;
  corpusId: string;
  threadId: string;
  allowedTrustLevels: string[];
  enforceIsolation: boolean;
}

export interface DurableAskResultArtifact<
  TResult extends DurableJsonObject = DurableJsonObject,
> {
  schemaVersion: typeof DURABLE_ASK_RESULT_ARTIFACT_VERSION;
  artifactId: string;
  artifactDigest: string;
  identity: DurableAskResultIdentity;
  contentDigest: string;
  byteLength: number;
  createdAt: string;
  result: TResult;
}

export interface DurableAskResultPublication<
  TResult extends DurableJsonObject = DurableJsonObject,
> {
  identity: DurableAskResultIdentity;
  result: TResult;
}

export interface DurableAskResultArtifactStore {
  readonly providerId: string;
  readonly coordination: 'process' | 'shared';
  readonly maxResultBytes: number;
  readonly maxArtifacts: number;
  readonly maxRootBytes?: number;
  readonly maxScopeArtifacts?: number;
  readonly maxScopeBytes?: number;
  put<TResult extends DurableJsonObject>(
    publication: DurableAskResultPublication<TResult>
  ): Promise<DurableAskResultArtifact<TResult>>;
  get<TResult extends DurableJsonObject = DurableJsonObject>(
    identity: DurableAskResultIdentity,
    artifactId: string,
    scope: RagRetrievalScope
  ): Promise<DurableAskResultArtifact<TResult> | null>;
  delete(
    identity: DurableAskResultIdentity,
    artifactId: string,
    scope: RagRetrievalScope
  ): Promise<boolean>;
  /** Deletes every attempt artifact bound to the exact durable thread identity. */
  deleteAll?(
    identity: DurableAskResultIdentity,
    scope: RagRetrievalScope
  ): Promise<number>;
  collectGarbage?(): Promise<DurableAskResultGcReport>;
  rebuildCapacityLedger?(): Promise<DurableAskResultRebuildReport>;
}

export interface DurableAskResultStoreOptions {
  providerId?: string;
  maxResultBytes?: number;
  maxArtifacts?: number;
  maxRootBytes?: number;
  maxScopeArtifacts?: number;
  maxScopeBytes?: number;
  orphanTtlMs?: number;
  gcMaxEntries?: number;
  gcMaxBytes?: number;
  gcMaxDurationMs?: number;
  rebuildMaxDurationMs?: number;
  temporaryFileTtlMs?: number;
  now?: () => Date;
  ioObserver?(event: DurableAskResultIoEvent): void;
  lifecycleHook?(point: DurableAskResultLifecyclePoint): Promise<void> | void;
  /** @internal Fault-injection seam for temporary-file cleanup tests. */
  temporaryFileUnlink?(file: string): Promise<void>;
}

export interface DurableAskResultIoEvent {
  operation: 'read' | 'write' | 'delete' | 'list';
  target:
    | 'artifact'
    | 'reservation'
    | 'root-ledger'
    | 'scope-ledger'
    | 'cursor'
    | 'temporary';
  bytes?: number;
}

export type DurableAskResultLifecyclePoint =
  | 'after-rebuild-marker'
  | 'after-root-ledger-mutation'
  | 'after-scope-ledger-mutation'
  | 'after-capacity-reservation'
  | 'after-artifact-publication'
  | 'after-artifact-commit'
  | 'after-artifact-delete'
  | 'after-capacity-release'
  | 'after-empty-scope-ledger-delete'
  | 'after-empty-scope-marker-delete';

export interface DurableAskResultGcReport {
  scannedEntries: number;
  scannedBytes: number;
  reclaimedArtifacts: number;
  reclaimedReservations: number;
  durationMs: number;
  bounded: boolean;
}

export interface DurableAskResultRebuildReport {
  scannedEntries: number;
  scannedBytes: number;
  reservationCount: number;
  artifactCount: number;
  scopeCount: number;
  durationMs: number;
}

export type DurableAskResultStoreErrorCode =
  | 'DURABLE_ASK_RESULT_CAPACITY'
  | 'DURABLE_ASK_RESULT_CONFLICT'
  | 'DURABLE_ASK_RESULT_INTEGRITY';

export class DurableAskResultStoreError extends Error {
  readonly code: DurableAskResultStoreErrorCode;

  constructor(
    code: DurableAskResultStoreErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DurableAskResultStoreError';
    this.code = code;
  }
}

interface NormalizedResultPublication<TResult extends DurableJsonObject> {
  identity: DurableAskResultIdentity;
  result: TResult;
  contentDigest: string;
  artifactId: string;
  byteLength: number;
}

interface FileResultReservation {
  schemaVersion: typeof DURABLE_ASK_RESULT_RESERVATION_VERSION;
  reservationKey: string;
  identityDigest: string;
  scopeDigest: string;
  artifactId: string;
  reservedBytes: number;
  state: 'reserved' | 'committed';
  reservedAt: string;
  committedAt?: string;
  reservationDigest: string;
}

interface ResultCapacityCounters {
  count: number;
  bytes: number;
}

interface ResultCapacityMutation {
  mutationId: string;
  kind: 'reserve' | 'release';
  reservation: FileResultReservation;
  beforeRoot: ResultCapacityCounters;
  beforeScope: ResultCapacityCounters;
  afterScope: ResultCapacityCounters;
}

interface FileResultRootLedger {
  schemaVersion: typeof DURABLE_ASK_RESULT_ROOT_LEDGER_VERSION;
  generation: number;
  counters: ResultCapacityCounters;
  lastMutation: ResultCapacityMutation | null;
  updatedAt: string;
  ledgerDigest: string;
}

interface FileResultScopeLedger {
  schemaVersion: typeof DURABLE_ASK_RESULT_SCOPE_LEDGER_VERSION;
  scopeDigest: string;
  generation: number;
  appliedRootGeneration: number;
  counters: ResultCapacityCounters;
  updatedAt: string;
  ledgerDigest: string;
}

interface FileResultScopeMarker {
  schemaVersion: typeof DURABLE_ASK_RESULT_SCOPE_MARKER_VERSION;
  scopeDigest: string;
  createdAt: string;
  markerDigest: string;
}

interface FileResultStoreMarker {
  schemaVersion: typeof DURABLE_ASK_RESULT_STORE_MARKER_VERSION;
  createdAt: string;
  markerDigest: string;
}

interface FileResultGcCursor {
  schemaVersion: typeof DURABLE_ASK_RESULT_GC_CURSOR_VERSION;
  generation: number;
  phase: 'reservations' | 'artifacts';
  shard: number;
  identityDigest?: string;
  afterName?: string;
  cursorDigest: string;
}

interface ResultCapacityRebuildState {
  counters: ResultCapacityCounters;
  scopes: Map<string, ResultCapacityCounters>;
  knownScopeDigests: Set<string>;
  scannedEntries: number;
  scannedBytes: number;
  artifactCount: number;
}

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ARTIFACT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ARTIFACT_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESERVATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const TEMPORARY_FILE_PATTERN =
  /^[a-f0-9]{64}\.([0-9]{13})\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
const FORBIDDEN_CREDENTIAL_SEGMENTS = new Set([
  'secret',
  'secrets',
  'credential',
  'credentials',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'authorization',
  'authorisation',
  'authentication',
  'cookie',
  'cookies',
  'jwt',
  'bearer',
  'token',
  'tokens',
]);
const FORBIDDEN_COMPACT_CREDENTIAL_KEYS = new Set([
  'apikey',
  'authtoken',
  'authorizationtoken',
  'authenticationtoken',
  'apitoken',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'clientsecret',
  'sessiontoken',
]);
const resultStoreLocks = new Map<string, Promise<void>>();

export function createDurableAskResultIdentity(input: {
  generationId: string;
  threadId: string;
  scope: RagRetrievalScope;
}): DurableAskResultIdentity {
  return normalizeResultIdentity({
    generationId: input.generationId,
    threadId: input.threadId,
    tenantId: input.scope.tenantId,
    corpusId: input.scope.corpusId,
    allowedTrustLevels: input.scope.allowedTrustLevels,
    enforceIsolation: input.scope.enforceIsolation,
  });
}

export class InMemoryDurableAskResultArtifactStore
implements DurableAskResultArtifactStore {
  readonly providerId: string;
  readonly coordination = 'process' as const;
  readonly maxResultBytes: number;
  readonly maxArtifacts: number;
  readonly maxRootBytes: number;
  readonly maxScopeArtifacts: number;
  readonly maxScopeBytes: number;
  private readonly now: () => Date;
  private readonly artifacts = new Map<string, DurableAskResultArtifact>();
  private readonly artifactBytes = new Map<string, number>();
  private readonly scopeUsage = new Map<string, ResultCapacityCounters>();
  private rootBytes = 0;

  constructor(options: DurableAskResultStoreOptions = {}) {
    this.providerId = assertSafeProviderId(
      options.providerId ?? 'in-memory-durable-ask-result-store'
    );
    this.maxResultBytes = resolveMaxResultBytes(options.maxResultBytes);
    this.maxArtifacts = resolveMaxArtifacts(options.maxArtifacts);
    this.maxRootBytes = resolveMaxRootBytes(options.maxRootBytes);
    this.maxScopeArtifacts = resolveMaxScopeArtifacts(
      options.maxScopeArtifacts,
      this.maxArtifacts
    );
    this.maxScopeBytes = resolveMaxScopeBytes(
      options.maxScopeBytes,
      this.maxRootBytes
    );
    this.now = options.now ?? (() => new Date());
    assertValidDate(this.now());
  }

  async put<TResult extends DurableJsonObject>(
    publication: DurableAskResultPublication<TResult>
  ): Promise<DurableAskResultArtifact<TResult>> {
    const normalized = normalizePublication(publication, this.maxResultBytes);
    const key = createArtifactKey(normalized.identity, normalized.artifactId);
    const existing = this.artifacts.get(key);
    if (existing) {
      assertResultArtifact(
        existing,
        normalized.identity,
        normalized.artifactId,
        this.maxResultBytes
      );
      if (existing.contentDigest !== normalized.contentDigest) {
        throw resultConflict(
          'Ask result artifact identity already contains different content.'
        );
      }
      return cloneArtifact(existing) as DurableAskResultArtifact<TResult>;
    }
    const artifact = createArtifact(normalized, this.now);
    const serializedBytes = serializeArtifact(artifact, this.maxResultBytes).byteLength;
    const scopeDigest = createScopeDigest(normalized.identity);
    const scopeUsage = this.scopeUsage.get(scopeDigest) ?? emptyCounters();
    if (
      this.artifacts.size + 1 > this.maxArtifacts
      || this.rootBytes + serializedBytes > this.maxRootBytes
      || scopeUsage.count + 1 > this.maxScopeArtifacts
      || scopeUsage.bytes + serializedBytes > this.maxScopeBytes
    ) {
      throw resultCapacity();
    }
    this.artifacts.set(key, cloneArtifact(artifact));
    this.artifactBytes.set(key, serializedBytes);
    this.rootBytes += serializedBytes;
    this.scopeUsage.set(scopeDigest, {
      count: scopeUsage.count + 1,
      bytes: scopeUsage.bytes + serializedBytes,
    });
    return cloneArtifact(artifact);
  }

  async get<TResult extends DurableJsonObject = DurableJsonObject>(
    identity: DurableAskResultIdentity,
    artifactId: string,
    scope: RagRetrievalScope
  ): Promise<DurableAskResultArtifact<TResult> | null> {
    const normalizedIdentity = normalizeResultIdentity(identity);
    assertResultIdentityWithinScope(normalizedIdentity, scope);
    const normalizedArtifactId = assertArtifactId(artifactId);
    const existing = this.artifacts.get(
      createArtifactKey(normalizedIdentity, normalizedArtifactId)
    );
    if (!existing) return null;
    assertResultArtifact(
      existing,
      normalizedIdentity,
      normalizedArtifactId,
      this.maxResultBytes
    );
    return cloneArtifact(existing) as DurableAskResultArtifact<TResult>;
  }

  async delete(
    identity: DurableAskResultIdentity,
    artifactId: string,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const normalizedIdentity = normalizeResultIdentity(identity);
    assertResultIdentityWithinScope(normalizedIdentity, scope);
    const normalizedArtifactId = assertArtifactId(artifactId);
    const key = createArtifactKey(normalizedIdentity, normalizedArtifactId);
    const existing = this.artifacts.get(key);
    if (!existing) return false;
    assertResultArtifact(
      existing,
      normalizedIdentity,
      normalizedArtifactId,
      this.maxResultBytes
    );
    const deleted = this.artifacts.delete(key);
    if (deleted) this.releaseInMemoryCapacity(normalizedIdentity, key);
    return deleted;
  }

  async deleteAll(
    identity: DurableAskResultIdentity,
    scope: RagRetrievalScope
  ): Promise<number> {
    const normalizedIdentity = normalizeResultIdentity(identity);
    assertResultIdentityWithinScope(normalizedIdentity, scope);
    const keyPrefix = createIdentityDigest(normalizedIdentity) + '\u0000';
    let deleted = 0;
    for (const [key, artifact] of this.artifacts) {
      if (!key.startsWith(keyPrefix)) continue;
      assertResultArtifact(
        artifact,
        normalizedIdentity,
        artifact.artifactId,
        this.maxResultBytes
      );
      if (this.artifacts.delete(key)) {
        this.releaseInMemoryCapacity(normalizedIdentity, key);
        deleted += 1;
      }
    }
    return deleted;
  }

  private releaseInMemoryCapacity(
    identity: DurableAskResultIdentity,
    key: string
  ): void {
    const bytes = this.artifactBytes.get(key) ?? 0;
    this.artifactBytes.delete(key);
    this.rootBytes = Math.max(0, this.rootBytes - bytes);
    const scopeDigest = createScopeDigest(identity);
    const usage = this.scopeUsage.get(scopeDigest);
    if (!usage) return;
    const next = {
      count: Math.max(0, usage.count - 1),
      bytes: Math.max(0, usage.bytes - bytes),
    };
    if (next.count === 0) this.scopeUsage.delete(scopeDigest);
    else this.scopeUsage.set(scopeDigest, next);
  }
}

/**
 * Immutable local result-artifact adapter. Artifact and identity digests are
 * used for every path component. Atomic create-if-absent publication detects
 * races, while coordination remains honestly process-scoped.
 */
export class FileDurableAskResultArtifactStore
implements DurableAskResultArtifactStore {
  readonly providerId: string;
  readonly coordination = 'process' as const;
  readonly maxResultBytes: number;
  readonly maxArtifacts: number;
  readonly maxRootBytes: number;
  readonly maxScopeArtifacts: number;
  readonly maxScopeBytes: number;
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly orphanTtlMs: number;
  private readonly gcMaxEntries: number;
  private readonly gcMaxBytes: number;
  private readonly gcMaxDurationMs: number;
  private readonly rebuildMaxDurationMs: number;
  private readonly temporaryFileTtlMs: number;
  private readonly ioObserver?: DurableAskResultStoreOptions['ioObserver'];
  private readonly lifecycleHook?: DurableAskResultStoreOptions['lifecycleHook'];
  private readonly temporaryFileUnlink: (file: string) => Promise<void>;
  private temporaryPreflightComplete = false;

  constructor(
    rootDir = path.join(
      process.cwd(),
      'uploads',
      'rag-durable-workflows-v1',
      'ask-results'
    ),
    options: DurableAskResultStoreOptions = {}
  ) {
    this.rootDir = path.resolve(rootDir);
    this.providerId = assertSafeProviderId(
      options.providerId ?? 'file-durable-ask-result-store'
    );
    this.maxResultBytes = resolveMaxResultBytes(options.maxResultBytes);
    this.maxArtifacts = resolveMaxArtifacts(options.maxArtifacts);
    this.maxRootBytes = resolveMaxRootBytes(options.maxRootBytes);
    this.maxScopeArtifacts = resolveMaxScopeArtifacts(
      options.maxScopeArtifacts,
      this.maxArtifacts
    );
    this.maxScopeBytes = resolveMaxScopeBytes(
      options.maxScopeBytes,
      this.maxRootBytes
    );
    this.orphanTtlMs = resolveBoundedPositiveInteger(
      options.orphanTtlMs,
      60 * 60 * 1000,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxOrphanTtlMs,
      'orphanTtlMs'
    );
    this.gcMaxEntries = resolveBoundedPositiveInteger(
      options.gcMaxEntries,
      64,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxGcEntries,
      'gcMaxEntries'
    );
    this.gcMaxBytes = resolveBoundedPositiveInteger(
      options.gcMaxBytes,
      64 * 1024 * 1024,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxGcBytes,
      'gcMaxBytes'
    );
    if (
      this.gcMaxBytes
      < this.maxResultBytes
        + DURABLE_ASK_RESULT_HARD_LIMITS.maxEnvelopeOverheadBytes
    ) {
      throw new Error(
        'gcMaxBytes must cover maxResultBytes plus the artifact envelope.'
      );
    }
    this.gcMaxDurationMs = resolveBoundedPositiveInteger(
      options.gcMaxDurationMs,
      50,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxGcDurationMs,
      'gcMaxDurationMs'
    );
    this.rebuildMaxDurationMs = resolveBoundedPositiveInteger(
      options.rebuildMaxDurationMs,
      5000,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxRebuildDurationMs,
      'rebuildMaxDurationMs'
    );
    this.temporaryFileTtlMs = resolveBoundedPositiveInteger(
      options.temporaryFileTtlMs,
      60 * 60 * 1000,
      DURABLE_ASK_RESULT_HARD_LIMITS.maxTemporaryFileTtlMs,
      'temporaryFileTtlMs'
    );
    this.now = options.now ?? (() => new Date());
    this.ioObserver = options.ioObserver;
    this.lifecycleHook = options.lifecycleHook;
    this.temporaryFileUnlink = options.temporaryFileUnlink ?? unlink;
    assertValidDate(this.now());
  }

  async put<TResult extends DurableJsonObject>(
    publication: DurableAskResultPublication<TResult>
  ): Promise<DurableAskResultArtifact<TResult>> {
    const normalized = normalizePublication(publication, this.maxResultBytes);
    const artifact = createArtifact(normalized, this.now);
    const serialized = serializeArtifact(artifact, this.maxResultBytes);
    const reservation = createResultReservation({
      schemaVersion: DURABLE_ASK_RESULT_RESERVATION_VERSION,
      reservationKey: createReservationKey(
        normalized.identity,
        normalized.artifactId
      ),
      identityDigest: createIdentityDigest(normalized.identity),
      scopeDigest: createScopeDigest(normalized.identity),
      artifactId: normalized.artifactId,
      reservedBytes: serialized.byteLength,
      state: 'reserved',
      reservedAt: assertValidDate(this.now()).toISOString(),
    });

    return withResultStoreLock(
      this.maintenanceLockKey(),
      async () => {
        await this.garbageCollectTemporaryFiles();
        return withResultStoreLock(
          this.identityLockKey(normalized.identity),
          async () => {
        const file = this.artifactFile(
          normalized.identity,
          normalized.artifactId
        );
        const existing = await this.readOptionalArtifact<TResult>(
          file,
          normalized.identity,
          normalized.artifactId
        );
        if (existing) {
          const existingReservation = await this.assertArtifactReservation(
            normalized.identity,
            normalized.artifactId,
            serialized.byteLength
          );
          if (existing.contentDigest !== normalized.contentDigest) {
            throw resultConflict(
              'Ask result artifact identity already contains different content.'
            );
          }
          if (existingReservation.state === 'reserved') {
            await this.assertMutationMaintenanceReady();
            await this.commitArtifactReservation(existingReservation);
          }
          return existing;
        }

        const activeReservation = await this.reserveArtifactCapacity(reservation);
        await this.emitLifecycle('after-capacity-reservation');

        const created = await this.publishImmutableBytes(file, serialized);
        this.observeIo('write', 'artifact', serialized.byteLength);
        await this.emitLifecycle('after-artifact-publication');
        if (!created) {
          const raced = await this.readOptionalArtifact<TResult>(
            file,
            normalized.identity,
            normalized.artifactId
          );
          if (!raced || raced.contentDigest !== normalized.contentDigest) {
            throw resultConflict('Ask result artifact publication conflicted.');
          }
        }
        await this.commitArtifactReservation(activeReservation);
        await this.emitLifecycle('after-artifact-commit');
        return cloneArtifact(artifact);
          }
        );
      }
    );
  }

  async get<TResult extends DurableJsonObject = DurableJsonObject>(
    identity: DurableAskResultIdentity,
    artifactId: string,
    scope: RagRetrievalScope
  ): Promise<DurableAskResultArtifact<TResult> | null> {
    const normalizedIdentity = normalizeResultIdentity(identity);
    assertResultIdentityWithinScope(normalizedIdentity, scope);
    const normalizedArtifactId = assertArtifactId(artifactId);
    return withResultStoreLock(
      this.identityLockKey(normalizedIdentity),
      async () => {
        const reservation = await this.readArtifactReservation(
          normalizedIdentity,
          normalizedArtifactId
        );
        const artifact = await this.readOptionalArtifact<TResult>(
          this.artifactFile(normalizedIdentity, normalizedArtifactId),
          normalizedIdentity,
          normalizedArtifactId
        );
        if (!artifact) {
          if (reservation?.state === 'committed') {
            throw resultIntegrity(
              'Committed ask result reservation has no artifact.'
            );
          }
          return null;
        }
        if (!reservation || reservation.state !== 'committed') {
          throw resultIntegrity(
            'Ask result artifact has no committed capacity reservation.'
          );
        }
        return artifact;
      }
    );
  }

  async delete(
    identity: DurableAskResultIdentity,
    artifactId: string,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const normalizedIdentity = normalizeResultIdentity(identity);
    assertResultIdentityWithinScope(normalizedIdentity, scope);
    const normalizedArtifactId = assertArtifactId(artifactId);
    return withResultStoreLock(
      this.maintenanceLockKey(),
      async () => {
        await this.garbageCollectTemporaryFiles();
        return withResultStoreLock(
          this.identityLockKey(normalizedIdentity),
          async () => {
        await this.assertMutationMaintenanceReady();
        const file = this.artifactFile(normalizedIdentity, normalizedArtifactId);
        const reservation = await this.readArtifactReservation(
          normalizedIdentity,
          normalizedArtifactId
        );
        const existing = await this.readOptionalArtifact(
          file,
          normalizedIdentity,
          normalizedArtifactId
        );
        if (existing && !reservation) {
          throw resultIntegrity('Ask result artifact has no capacity reservation.');
        }
        const deleted = existing ? await unlinkIfExists(file) : false;
        if (deleted) this.observeIo('delete', 'artifact');
        await this.emitLifecycle('after-artifact-delete');
        if (reservation) await this.releaseArtifactCapacity(reservation);
        await this.cleanupArtifactDirectories(normalizedIdentity);
        return deleted;
          }
        );
      }
    );
  }

  async deleteAll(
    identity: DurableAskResultIdentity,
    scope: RagRetrievalScope
  ): Promise<number> {
    const normalizedIdentity = normalizeResultIdentity(identity);
    assertResultIdentityWithinScope(normalizedIdentity, scope);
    return withResultStoreLock(
      this.maintenanceLockKey(),
      async () => {
        await this.garbageCollectTemporaryFiles();
        return withResultStoreLock(
          this.identityLockKey(normalizedIdentity),
          async () => {
          await this.assertMutationMaintenanceReady();
          const identityDigest = createIdentityDigest(normalizedIdentity);
          let deleted = 0;
          const reservations = await this.readIdentityReservationCatalog(
            identityDigest,
            this.maxArtifacts + 1
          );
          for (const entry of reservations) {
            const artifactFile = this.artifactFile(
              normalizedIdentity,
              entry.reservation.artifactId
            );
            const existing = await this.readOptionalArtifact(
              artifactFile,
              normalizedIdentity,
              entry.reservation.artifactId
            );
            if (await unlinkIfExists(artifactFile)) {
              this.observeIo('delete', 'artifact');
              if (existing) deleted += 1;
            }
            await this.emitLifecycle('after-artifact-delete');
            await this.releaseArtifactCapacity(entry.reservation);
          }

          const artifactDirectory = this.artifactDirectory(normalizedIdentity);
          const artifacts = await this.readDirectoryEntries(
            artifactDirectory,
            'artifact',
            this.maxArtifacts + 32
          );
          for (const entry of artifacts) {
            const file = this.resolveInside(artifactDirectory, entry.name);
            const match = ARTIFACT_FILE_PATTERN.exec(entry.name);
            if (!entry.isFile() || !match) {
              throw resultIntegrity(
                'Ask result artifact identity catalog contains an invalid entry.'
              );
            }
            const artifactId = 'sha256:' + match[1];
            const existing = await this.readOptionalArtifact(
              file,
              normalizedIdentity,
              artifactId
            );
            if (existing && await unlinkIfExists(file)) {
              this.observeIo('delete', 'artifact');
              deleted += 1;
            }
          }
          await this.cleanupArtifactDirectories(normalizedIdentity);
          return deleted;
          }
        );
      }
    );
  }

  async collectGarbage(): Promise<DurableAskResultGcReport> {
    return withResultStoreLock(this.maintenanceLockKey(), async () => {
      await this.garbageCollectTemporaryFiles(true);
      await withResultStoreLock(this.capacityLockKey(), async () => {
        await this.loadRootLedger();
      });
      const startedAt = Date.now();
      let cursor = await this.readOptionalGcCursor() ?? createGcCursor({
        generation: 0,
        phase: 'reservations',
        shard: 0,
      });
      let scannedEntries = 0;
      let scannedBytes = 0;
      let reclaimedArtifacts = 0;
      let reclaimedReservations = 0;
      let reachedBound = false;
      let completedCycle = false;

      phaseLoop: while (!completedCycle) {
        for (let shard = cursor.shard; shard < 256; shard += 1) {
          if (Date.now() - startedAt >= this.gcMaxDurationMs) {
            reachedBound = true;
            break phaseLoop;
          }
          const shardName = shard.toString(16).padStart(2, '0');
          const shardDirectory = this.resolveInside(this.rootDir, shardName);
          const identities = await this.readDirectoryEntries(
            shardDirectory,
            cursor.phase === 'reservations' ? 'reservation' : 'artifact',
            this.maxArtifacts + 32
          );
          for (const identityEntry of identities.sort(compareDirentNames)) {
            if (
              !identityEntry.isDirectory()
              || !SHA256_PATTERN.test(identityEntry.name)
              || !identityEntry.name.startsWith(shardName)
            ) {
              throw resultIntegrity(
                'Ask result garbage collection found an invalid identity entry.'
              );
            }
            if (
              shard === cursor.shard
              && cursor.identityDigest
              && identityEntry.name < cursor.identityDigest
            ) {
              continue;
            }
            const identityDigest = identityEntry.name;
            const directory = cursor.phase === 'reservations'
              ? this.artifactReservationDirectory(identityDigest)
              : this.artifactDirectoryByDigest(identityDigest);
            const entries = await this.readDirectoryEntries(
              directory,
              cursor.phase === 'reservations' ? 'reservation' : 'artifact',
              cursor.phase === 'reservations'
                ? DURABLE_ASK_RESULT_HARD_LIMITS.maxReservationDirectoryEntries
                : this.maxArtifacts + 32
            );
            for (const entry of entries.sort(compareDirentNames)) {
              const match = cursor.phase === 'reservations'
                ? RESERVATION_FILE_PATTERN.exec(entry.name)
                : ARTIFACT_FILE_PATTERN.exec(entry.name);
              if (!entry.isFile() || !match) {
                throw resultIntegrity(
                  'Ask result garbage collection found an invalid catalog entry.'
                );
              }
              if (
                shard === cursor.shard
                && cursor.identityDigest === identityDigest
                && cursor.afterName
                && entry.name <= cursor.afterName
              ) {
                continue;
              }
              if (
                scannedEntries >= this.gcMaxEntries
                || Date.now() - startedAt >= this.gcMaxDurationMs
              ) {
                reachedBound = true;
                break phaseLoop;
              }
              const file = this.resolveInside(directory, entry.name);
              const fileStats = await stat(file);
              if (!fileStats.isFile()) {
                throw resultIntegrity(
                  'Ask result garbage collection candidate is not a regular file.'
                );
              }
              if (scannedBytes + fileStats.size > this.gcMaxBytes) {
                reachedBound = true;
                break phaseLoop;
              }
              scannedEntries += 1;
              scannedBytes += fileStats.size;
              if (cursor.phase === 'reservations') {
                const reclaimed = await this.collectReservationCandidate(
                  identityDigest,
                  file,
                  match[1]
                );
                reclaimedArtifacts += reclaimed.artifacts;
                reclaimedReservations += reclaimed.reservations;
              } else {
                const reclaimed = await this.collectArtifactCandidate(
                  identityDigest,
                  file,
                  'sha256:' + match[1],
                  fileStats.mtimeMs
                );
                reclaimedArtifacts += reclaimed;
              }
              cursor = createGcCursor({
                generation: cursor.generation,
                phase: cursor.phase,
                shard,
                identityDigest,
                afterName: entry.name,
              });
            }
            cursor = createGcCursor({
              generation: cursor.generation,
              phase: cursor.phase,
              shard,
              identityDigest,
              afterName: '\uffff',
            });
          }
          cursor = createGcCursor({
            generation: cursor.generation,
            phase: cursor.phase,
            shard: Math.min(255, shard + 1),
          });
        }

        if (cursor.phase === 'reservations') {
          cursor = createGcCursor({
            generation: cursor.generation,
            phase: 'artifacts',
            shard: 0,
          });
        } else {
          cursor = createGcCursor({
            generation: cursor.generation + 1,
            phase: 'reservations',
            shard: 0,
          });
          completedCycle = true;
        }
      }

      await this.writeGcCursor(cursor);
      return {
        scannedEntries,
        scannedBytes,
        reclaimedArtifacts,
        reclaimedReservations,
        durationMs: Date.now() - startedAt,
        bounded: reachedBound,
      };
    });
  }

  private async collectReservationCandidate(
    identityDigest: string,
    file: string,
    reservationKey: string
  ): Promise<{ artifacts: number; reservations: number }> {
    const candidate = await this.readArtifactReservationFile(
      file,
      reservationKey
    );
    if (candidate.identityDigest !== identityDigest) {
      throw resultIntegrity(
        'Ask result garbage collection reservation identity is invalid.'
      );
    }
    if (!this.isReservationExpired(candidate)) {
      return { artifacts: 0, reservations: 0 };
    }
    return withResultStoreLock(
      this.identityLockKeyByDigest(identityDigest),
      async () => {
        const current = await this.readArtifactReservationByKey(
          identityDigest,
          reservationKey
        );
        if (!current || !this.isReservationExpired(current)) {
          return { artifacts: 0, reservations: 0 };
        }
        assertSameReservation(current, candidate);
        const artifactFile = this.artifactFileByDigest(
          identityDigest,
          current.artifactId
        );
        if (current.state === 'committed' && await fileExists(artifactFile)) {
          return { artifacts: 0, reservations: 0 };
        }
        const artifactDeleted = current.state === 'reserved'
          ? await unlinkIfExists(artifactFile)
          : false;
        if (artifactDeleted) this.observeIo('delete', 'artifact');
        await this.releaseArtifactCapacity(current);
        await this.cleanupArtifactDirectoriesByDigest(identityDigest);
        return {
          artifacts: artifactDeleted ? 1 : 0,
          reservations: 1,
        };
      }
    );
  }

  private async collectArtifactCandidate(
    identityDigest: string,
    file: string,
    artifactId: string,
    modifiedAtMs: number
  ): Promise<number> {
    const nowMs = assertValidDate(this.now()).getTime();
    if (nowMs - modifiedAtMs < this.orphanTtlMs) return 0;
    return withResultStoreLock(
      this.identityLockKeyByDigest(identityDigest),
      async () => {
        const reservationKey = createReservationKeyFromDigests(
          identityDigest,
          artifactId
        );
        if (await this.readArtifactReservationByKey(
          identityDigest,
          reservationKey
        )) {
          return 0;
        }
        const deleted = await unlinkIfExists(file);
        if (deleted) this.observeIo('delete', 'artifact');
        await this.cleanupArtifactDirectoriesByDigest(identityDigest);
        return deleted ? 1 : 0;
      }
    );
  }

  private isReservationExpired(reservation: FileResultReservation): boolean {
    const timestamp = reservation.state === 'committed'
      ? reservation.committedAt
      : reservation.reservedAt;
    if (!timestamp) return false;
    return assertValidDate(this.now()).getTime() - Date.parse(timestamp)
      >= this.orphanTtlMs;
  }

  async rebuildCapacityLedger(): Promise<DurableAskResultRebuildReport> {
    return withResultStoreLock(this.maintenanceLockKey(), async () => {
      await this.garbageCollectTemporaryFiles(true);
      const startedAt = Date.now();
      await withResultStoreLock(this.capacityLockKey(), async () => {
        const rebuildMarker = Buffer.from(JSON.stringify({
          schemaVersion: 'rag-durable-ask-result-rebuild-v1',
          rebuildId: randomUUID(),
          startedAt: assertValidDate(this.now()).toISOString(),
        }), 'utf8');
        await this.replaceBytesAtomically(this.rebuildMarkerFile(), rebuildMarker);
        this.observeIo('write', 'root-ledger', rebuildMarker.byteLength);
      });
      await this.emitLifecycle('after-rebuild-marker');

      const rebuilt = await this.scanCapacityStateForRebuild(startedAt);
      const rootGeneration = Math.max(
        1,
        assertValidDate(this.now()).getTime()
      );
      const updatedAt = assertValidDate(this.now()).toISOString();
      await withResultStoreLock(this.capacityLockKey(), async () => {
        for (const scopeDigest of rebuilt.knownScopeDigests) {
          const counters = rebuilt.scopes.get(scopeDigest) ?? emptyCounters();
          if (counters.count === 0 && counters.bytes === 0) {
            await this.cleanupEmptyScopeControlFiles(scopeDigest, false);
            continue;
          }
          await this.writeScopeMarker(createScopeMarker({
            schemaVersion: DURABLE_ASK_RESULT_SCOPE_MARKER_VERSION,
            scopeDigest,
            createdAt: updatedAt,
          }));
          await this.writeScopeLedger(createScopeLedger({
            scopeDigest,
            generation: rootGeneration,
            appliedRootGeneration: rootGeneration,
            counters,
            updatedAt,
          }));
        }
        await this.writeRootLedger(createRootLedger({
          generation: rootGeneration,
          counters: rebuilt.counters,
          lastMutation: null,
          updatedAt,
        }));
        await this.writeStoreMarker(createStoreMarker({
          schemaVersion: DURABLE_ASK_RESULT_STORE_MARKER_VERSION,
          createdAt: updatedAt,
        }));
        if (await unlinkIfExists(this.rebuildMarkerFile())) {
          this.observeIo('delete', 'root-ledger');
        }
      });
      return {
        scannedEntries: rebuilt.scannedEntries,
        scannedBytes: rebuilt.scannedBytes,
        reservationCount: rebuilt.counters.count,
        artifactCount: rebuilt.artifactCount,
        scopeCount: rebuilt.scopes.size,
        durationMs: Date.now() - startedAt,
      };
    });
  }

  private async scanCapacityStateForRebuild(
    startedAt: number
  ): Promise<ResultCapacityRebuildState> {
    const counters = emptyCounters();
    const scopes = new Map<string, ResultCapacityCounters>();
    const knownScopeDigests = new Set<string>();
    let scannedEntries = 0;
    let scannedBytes = 0;
    let artifactCount = 0;
    const maximumScannedEntries = this.maxArtifacts * 4 + 1024;
    const assertBounded = (): void => {
      if (
        scannedEntries > maximumScannedEntries
        || Date.now() - startedAt > this.rebuildMaxDurationMs
      ) {
        throw resultCapacity(
          'Ask result capacity rebuild exceeded its bounded scan.'
        );
      }
    };

    const rootEntries = await this.readDirectoryEntries(
      this.rootDir,
      'reservation',
      this.maxArtifacts + 257
    );
    const shards: Dirent<string>[] = [];
    for (const entry of rootEntries.sort(compareDirentNames)) {
      if (entry.isDirectory() && entry.name === 'ledgers') continue;
      if (!entry.isDirectory() || !/^[a-f0-9]{2}$/.test(entry.name)) {
        throw resultIntegrity(
          'Ask result store contains an invalid root entry during rebuild.'
        );
      }
      shards.push(entry);
    }

    for (const shard of shards) {
      const shardDirectory = this.resolveInside(this.rootDir, shard.name);
      const identities = await this.readDirectoryEntries(
        shardDirectory,
        'reservation',
        this.maxArtifacts + 32
      );
      for (const identityEntry of identities.sort(compareDirentNames)) {
        scannedEntries += 1;
        assertBounded();
        const identityDigest = identityEntry.name;
        if (
          !identityEntry.isDirectory()
          || !SHA256_PATTERN.test(identityDigest)
          || !identityDigest.startsWith(shard.name)
        ) {
          throw resultIntegrity(
            'Ask result store contains an invalid identity entry during rebuild.'
          );
        }
        const identityDirectory = this.identityDirectoryByDigest(identityDigest);
        const identityChildren = await this.readDirectoryEntries(
          identityDirectory,
          'reservation',
          4
        );
        for (const child of identityChildren) {
          if (
            !child.isDirectory()
            || (child.name !== 'artifacts' && child.name !== 'reservations')
          ) {
            throw resultIntegrity(
              'Ask result identity directory contains an invalid entry during rebuild.'
            );
          }
        }

        const reservationKeys = new Set<string>();
        const reservationEntries = await this.readDirectoryEntries(
          this.artifactReservationDirectory(identityDigest),
          'reservation',
          Math.min(
            this.maxArtifacts + 1,
            DURABLE_ASK_RESULT_HARD_LIMITS.maxReservationDirectoryEntries
          )
        );
        for (const entry of reservationEntries.sort(compareDirentNames)) {
          const match = RESERVATION_FILE_PATTERN.exec(entry.name);
          if (!entry.isFile() || !match) {
            throw resultIntegrity(
              'Ask result reservation directory contains an invalid entry during rebuild.'
            );
          }
          scannedEntries += 1;
          assertBounded();
          const file = this.resolveInside(
            this.artifactReservationDirectory(identityDigest),
            entry.name
          );
          const fileStats = await stat(file);
          if (
            !fileStats.isFile()
            || fileStats.size > DURABLE_ASK_RESULT_HARD_LIMITS.maxReservationBytes
          ) {
            throw resultIntegrity(
              'Ask result reservation exceeds its rebuild byte limit.'
            );
          }
          scannedBytes += fileStats.size;
          const reservation = await this.readArtifactReservationFile(
            file,
            match[1]
          );
          if (reservation.identityDigest !== identityDigest) {
            throw resultIntegrity(
              'Ask result reservation identity does not match its rebuild path.'
            );
          }
          reservationKeys.add(reservation.reservationKey);
          counters.count += 1;
          counters.bytes += reservation.reservedBytes;
          const scopeCounters = scopes.get(reservation.scopeDigest)
            ?? emptyCounters();
          scopeCounters.count += 1;
          scopeCounters.bytes += reservation.reservedBytes;
          scopes.set(reservation.scopeDigest, scopeCounters);
          knownScopeDigests.add(reservation.scopeDigest);
          if (
            counters.count > this.maxArtifacts
            || counters.bytes > this.maxRootBytes
            || scopeCounters.count > this.maxScopeArtifacts
            || scopeCounters.bytes > this.maxScopeBytes
          ) {
            throw resultCapacity(
              'Ask result capacity rebuild exceeds the configured quota.'
            );
          }
        }

        const artifactEntries = await this.readDirectoryEntries(
          this.artifactDirectoryByDigest(identityDigest),
          'artifact',
          this.maxArtifacts + 32
        );
        for (const entry of artifactEntries.sort(compareDirentNames)) {
          const match = ARTIFACT_FILE_PATTERN.exec(entry.name);
          if (!entry.isFile() || !match) {
            throw resultIntegrity(
              'Ask result artifact directory contains an invalid entry during rebuild.'
            );
          }
          scannedEntries += 1;
          artifactCount += 1;
          assertBounded();
          if (artifactCount > this.maxArtifacts) {
            throw resultCapacity(
              'Ask result capacity rebuild exceeds the artifact count quota.'
            );
          }
          const artifactId = 'sha256:' + match[1];
          const reservationKey = createReservationKeyFromDigests(
            identityDigest,
            artifactId
          );
          if (!reservationKeys.has(reservationKey)) {
            throw resultIntegrity(
              'Ask result rebuild found an artifact without a reservation; garbage collection is required first.'
            );
          }
        }
      }
    }

    const scopeRoot = this.resolveInside(this.ledgerDirectory(), 'scopes');
    const scopeShards = await this.readDirectoryEntries(
      scopeRoot,
      'scope-ledger',
      256
    );
    for (const shard of scopeShards.sort(compareDirentNames)) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) {
        throw resultIntegrity(
          'Ask result scope ledger catalog contains an invalid shard.'
        );
      }
      const scopeDirectory = this.resolveInside(scopeRoot, shard.name);
      const entries = await this.readDirectoryEntries(
        scopeDirectory,
        'scope-ledger',
        this.maxArtifacts * 2 + 32
      );
      for (const entry of entries.sort(compareDirentNames)) {
        const match = /^([a-f0-9]{64})\.(?:marker|ledger)\.json$/.exec(
          entry.name
        );
        if (
          !entry.isFile()
          || !match
          || !match[1].startsWith(shard.name)
        ) {
          throw resultIntegrity(
            'Ask result scope ledger catalog contains an invalid entry.'
          );
        }
        scannedEntries += 1;
        assertBounded();
        knownScopeDigests.add(match[1]);
      }
    }

    return {
      counters,
      scopes,
      knownScopeDigests,
      scannedEntries,
      scannedBytes,
      artifactCount,
    };
  }

  private async reserveArtifactCapacity(
    reservation: FileResultReservation
  ): Promise<FileResultReservation> {
    return withResultStoreLock(this.capacityLockKey(), async () => {
      const rootLedger = await this.loadRootLedger();
      const existing = await this.readArtifactReservationByKey(
        reservation.identityDigest,
        reservation.reservationKey
      );
      if (existing) {
        assertSameReservation(existing, reservation);
        return existing;
      }
      if (
        rootLedger.counters.count + 1 > this.maxArtifacts
        || rootLedger.counters.bytes + reservation.reservedBytes > this.maxRootBytes
        || reservation.reservedBytes > this.maxScopeBytes
      ) {
        throw resultCapacity();
      }
      const scopeLedger = await this.loadScopeLedger(reservation.scopeDigest);
      if (
        scopeLedger.counters.count + 1 > this.maxScopeArtifacts
        || scopeLedger.counters.bytes + reservation.reservedBytes > this.maxScopeBytes
      ) {
        throw resultCapacity();
      }
      await this.applyCapacityMutation(
        rootLedger,
        scopeLedger,
        'reserve',
        reservation
      );
      const committed = await this.readArtifactReservationByKey(
        reservation.identityDigest,
        reservation.reservationKey
      );
      if (!committed) {
        throw resultIntegrity(
          'Ask result artifact capacity reservation publication disappeared.'
        );
      }
      assertSameReservation(committed, reservation);
      return committed;
    });
  }

  private async assertMutationMaintenanceReady(): Promise<void> {
    await withResultStoreLock(this.capacityLockKey(), async () => {
      await this.loadRootLedger();
    });
  }

  private async commitArtifactReservation(
    reservation: FileResultReservation
  ): Promise<FileResultReservation> {
    const current = await this.readArtifactReservationByKey(
      reservation.identityDigest,
      reservation.reservationKey
    );
    if (!current) {
      throw resultIntegrity('Ask result artifact reservation disappeared before commit.');
    }
    assertSameReservation(current, reservation);
    if (current.state === 'committed') return current;
    const committed = createResultReservation({
      schemaVersion: DURABLE_ASK_RESULT_RESERVATION_VERSION,
      reservationKey: current.reservationKey,
      identityDigest: current.identityDigest,
      scopeDigest: current.scopeDigest,
      artifactId: current.artifactId,
      reservedBytes: current.reservedBytes,
      state: 'committed',
      reservedAt: current.reservedAt,
      committedAt: assertValidDate(this.now()).toISOString(),
    });
    await this.writeReservation(committed);
    return committed;
  }

  private async releaseArtifactCapacity(
    reservation: FileResultReservation
  ): Promise<void> {
    await withResultStoreLock(this.capacityLockKey(), async () => {
      const rootLedger = await this.loadRootLedger();
      const current = await this.readArtifactReservationByKey(
        reservation.identityDigest,
        reservation.reservationKey
      );
      if (!current) return;
      assertSameReservation(current, reservation);
      const scopeLedger = await this.loadScopeLedger(current.scopeDigest);
      if (
        rootLedger.counters.count < 1
        || rootLedger.counters.bytes < current.reservedBytes
        || scopeLedger.counters.count < 1
        || scopeLedger.counters.bytes < current.reservedBytes
      ) {
        throw resultIntegrity('Ask result capacity ledger would underflow.');
      }
      await this.applyCapacityMutation(
        rootLedger,
        scopeLedger,
        'release',
        current
      );
    });
    await this.emitLifecycle('after-capacity-release');
  }

  private async applyCapacityMutation(
    rootLedger: FileResultRootLedger,
    scopeLedger: FileResultScopeLedger,
    kind: 'reserve' | 'release',
    reservation: FileResultReservation
  ): Promise<void> {
    if (rootLedger.lastMutation) {
      throw resultIntegrity('Ask result root ledger retained an unreconciled mutation.');
    }
    const delta = kind === 'reserve' ? 1 : -1;
    const afterRoot = addCounters(
      rootLedger.counters,
      delta,
      delta * reservation.reservedBytes
    );
    const afterScope = addCounters(
      scopeLedger.counters,
      delta,
      delta * reservation.reservedBytes
    );
    assertNonNegativeCounters(afterRoot);
    assertNonNegativeCounters(afterScope);
    const mutation: ResultCapacityMutation = {
      mutationId: sha256(stableStringify({
        generation: rootLedger.generation + 1,
        kind,
        reservationKey: reservation.reservationKey,
      } as unknown as DurableJsonValue)),
      kind,
      reservation: cloneReservation(reservation),
      beforeRoot: cloneCounters(rootLedger.counters),
      beforeScope: cloneCounters(scopeLedger.counters),
      afterScope: cloneCounters(afterScope),
    };
    const pending = createRootLedger({
      generation: rootLedger.generation + 1,
      counters: afterRoot,
      lastMutation: mutation,
      updatedAt: assertValidDate(this.now()).toISOString(),
    });
    await this.writeRootLedger(pending);
    await this.emitLifecycle('after-root-ledger-mutation');

    const nextScope = createScopeLedger({
      scopeDigest: reservation.scopeDigest,
      generation: scopeLedger.generation + 1,
      appliedRootGeneration: pending.generation,
      counters: afterScope,
      updatedAt: assertValidDate(this.now()).toISOString(),
    });
    await this.ensureScopeMarker(reservation.scopeDigest);
    await this.writeScopeLedger(nextScope);
    await this.emitLifecycle('after-scope-ledger-mutation');

    if (kind === 'reserve') {
      const created = await this.publishImmutableBytes(
        this.artifactReservationFileForKey(
          reservation.identityDigest,
          reservation.reservationKey
        ),
        serializeReservation(reservation)
      );
      this.observeIo('write', 'reservation');
      if (!created) {
        const existing = await this.readArtifactReservationByKey(
          reservation.identityDigest,
          reservation.reservationKey
        );
        if (!existing) {
          throw resultIntegrity(
            'Ask result reservation publication disappeared during mutation.'
          );
        }
        assertSameReservation(existing, reservation);
      }
    } else {
      if (await unlinkIfExists(
        this.artifactReservationFileForKey(
          reservation.identityDigest,
          reservation.reservationKey
        )
      )) {
        this.observeIo('delete', 'reservation');
      }
    }

    if (
      kind === 'release'
      && afterScope.count === 0
      && afterScope.bytes === 0
    ) {
      await this.cleanupEmptyScopeControlFiles(reservation.scopeDigest);
    }

    await this.writeRootLedger(createRootLedger({
      generation: pending.generation + 1,
      counters: afterRoot,
      lastMutation: null,
      updatedAt: assertValidDate(this.now()).toISOString(),
    }));
  }

  private async loadRootLedger(): Promise<FileResultRootLedger> {
    if (await fileExists(this.rebuildMarkerFile())) {
      throw resultIntegrity(
        'Ask result capacity ledger rebuild is incomplete; explicit recovery is required.'
      );
    }
    const marker = await this.readOptionalStoreMarker();
    let ledger = await this.readOptionalRootLedger();
    if (!marker && !ledger) {
      if (!await this.isBrandNewStore()) {
        throw resultIntegrity(
          'Ask result capacity ledger is missing while persisted data exists; explicit recovery is required.'
        );
      }
      const newMarker = createStoreMarker({
        schemaVersion: DURABLE_ASK_RESULT_STORE_MARKER_VERSION,
        createdAt: assertValidDate(this.now()).toISOString(),
      });
      const created = await this.publishImmutableBytes(
        this.storeMarkerFile(),
        serializeStoreMarker(newMarker)
      );
      this.observeIo('write', 'root-ledger');
      if (!created && !await this.readOptionalStoreMarker()) {
        throw resultIntegrity('Ask result store marker publication disappeared.');
      }
      ledger = createRootLedger({
        generation: 0,
        counters: emptyCounters(),
        lastMutation: null,
        updatedAt: assertValidDate(this.now()).toISOString(),
      });
      await this.writeRootLedger(ledger);
    } else if (!marker || !ledger) {
      throw resultIntegrity(
        'Ask result capacity ledger is incomplete; explicit recovery is required.'
      );
    }
    const activeLedger = ledger;
    if (!activeLedger) {
      throw resultIntegrity('Ask result root capacity ledger is unavailable.');
    }
    if (!activeLedger.lastMutation) return activeLedger;
    return this.reconcileRootMutation(activeLedger);
  }

  private async reconcileRootMutation(
    ledger: FileResultRootLedger
  ): Promise<FileResultRootLedger> {
    const mutation = ledger.lastMutation;
    if (!mutation) return ledger;
    assertPendingCapacityMutation(ledger, mutation);
    const scopeMarker = await this.readOptionalScopeMarker(
      mutation.reservation.scopeDigest
    );
    const scopeLedger = await this.readOptionalScopeLedger(
      mutation.reservation.scopeDigest
    );
    if (scopeLedger && !scopeMarker) {
      throw resultIntegrity(
        'Ask result scope ledger has no integrity marker during recovery.'
      );
    }
    if (
      scopeLedger
      && !sameCounters(scopeLedger.counters, mutation.beforeScope)
      && !(
        sameCounters(scopeLedger.counters, mutation.afterScope)
        && scopeLedger.appliedRootGeneration === ledger.generation
      )
    ) {
      throw resultIntegrity(
        'Ask result scope ledger conflicts with the pending root mutation.'
      );
    }
    await this.ensureScopeMarker(mutation.reservation.scopeDigest);
    const nextScope = createScopeLedger({
      scopeDigest: mutation.reservation.scopeDigest,
      generation: (scopeLedger?.generation ?? 0) + 1,
      appliedRootGeneration: ledger.generation,
      counters: mutation.afterScope,
      updatedAt: assertValidDate(this.now()).toISOString(),
    });
    await this.writeScopeLedger(nextScope);

    if (mutation.kind === 'reserve') {
      const created = await this.publishImmutableBytes(
        this.artifactReservationFileForKey(
          mutation.reservation.identityDigest,
          mutation.reservation.reservationKey
        ),
        serializeReservation(mutation.reservation)
      );
      this.observeIo('write', 'reservation');
      if (!created) {
        const existing = await this.readArtifactReservationByKey(
          mutation.reservation.identityDigest,
          mutation.reservation.reservationKey
        );
        if (!existing) {
          throw resultIntegrity('Pending result reservation disappeared.');
        }
        assertSameReservation(existing, mutation.reservation);
      }
    } else {
      if (await unlinkIfExists(
        this.artifactReservationFileForKey(
          mutation.reservation.identityDigest,
          mutation.reservation.reservationKey
        )
      )) {
        this.observeIo('delete', 'reservation');
      }
    }
    if (
      mutation.kind === 'release'
      && mutation.afterScope.count === 0
      && mutation.afterScope.bytes === 0
    ) {
      await this.cleanupEmptyScopeControlFiles(
        mutation.reservation.scopeDigest
      );
    }
    const reconciled = createRootLedger({
      generation: ledger.generation + 1,
      counters: ledger.counters,
      lastMutation: null,
      updatedAt: assertValidDate(this.now()).toISOString(),
    });
    await this.writeRootLedger(reconciled);
    return reconciled;
  }

  private async loadScopeLedger(
    scopeDigest: string
  ): Promise<FileResultScopeLedger> {
    const marker = await this.readOptionalScopeMarker(scopeDigest);
    const existing = await this.readOptionalScopeLedger(scopeDigest);
    if (marker && existing) return existing;
    if (marker || existing) {
      throw resultIntegrity(
        'Ask result scope capacity ledger is incomplete; explicit recovery is required.'
      );
    }
    return createScopeLedger({
      scopeDigest,
      generation: 0,
      appliedRootGeneration: -1,
      counters: emptyCounters(),
      updatedAt: assertValidDate(this.now()).toISOString(),
    });
  }

  private async cleanupEmptyScopeControlFiles(
    scopeDigest: string,
    emitLifecycle = true
  ): Promise<void> {
    if (await unlinkIfExists(this.scopeLedgerFile(scopeDigest))) {
      this.observeIo('delete', 'scope-ledger');
    }
    if (emitLifecycle) {
      await this.emitLifecycle('after-empty-scope-ledger-delete');
    }
    if (await unlinkIfExists(this.scopeMarkerFile(scopeDigest))) {
      this.observeIo('delete', 'scope-ledger');
    }
    if (emitLifecycle) {
      await this.emitLifecycle('after-empty-scope-marker-delete');
    }
    await rmdirIfEmpty(this.scopeLedgerDirectory(scopeDigest));
    await rmdirIfEmpty(this.scopeLedgerRootDirectory());
  }

  private async ensureScopeMarker(scopeDigest: string): Promise<void> {
    const existing = await this.readOptionalScopeMarker(scopeDigest);
    if (existing) return;
    const marker = createScopeMarker({
      schemaVersion: DURABLE_ASK_RESULT_SCOPE_MARKER_VERSION,
      scopeDigest,
      createdAt: assertValidDate(this.now()).toISOString(),
    });
    const created = await this.publishImmutableBytes(
      this.scopeMarkerFile(scopeDigest),
      Buffer.from(JSON.stringify(marker, null, 2), 'utf8')
    );
    this.observeIo('write', 'scope-ledger');
    if (!created && !await this.readOptionalScopeMarker(scopeDigest)) {
      throw resultIntegrity('Ask result scope marker publication disappeared.');
    }
  }

  private async readOptionalRootLedger(): Promise<FileResultRootLedger | null> {
    try {
      const bytes = await readBoundedBytes(
        this.rootLedgerFile(),
        DURABLE_ASK_RESULT_HARD_LIMITS.maxLedgerBytes
      );
      this.observeIo('read', 'root-ledger', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertRootLedger(value);
      return cloneRootLedger(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity('Ask result root ledger failed validation.', error);
    }
  }

  private async readOptionalScopeLedger(
    scopeDigest: string
  ): Promise<FileResultScopeLedger | null> {
    try {
      const bytes = await readBoundedBytes(
        this.scopeLedgerFile(scopeDigest),
        DURABLE_ASK_RESULT_HARD_LIMITS.maxLedgerBytes
      );
      this.observeIo('read', 'scope-ledger', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertScopeLedger(value, scopeDigest);
      return cloneScopeLedger(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity('Ask result scope ledger failed validation.', error);
    }
  }

  private async readOptionalScopeMarker(
    scopeDigest: string
  ): Promise<FileResultScopeMarker | null> {
    try {
      const bytes = await readBoundedBytes(
        this.scopeMarkerFile(scopeDigest),
        DURABLE_ASK_RESULT_HARD_LIMITS.maxMarkerBytes
      );
      this.observeIo('read', 'scope-ledger', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertScopeMarker(value, scopeDigest);
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity('Ask result scope marker failed validation.', error);
    }
  }

  private async readOptionalStoreMarker(): Promise<FileResultStoreMarker | null> {
    try {
      const bytes = await readBoundedBytes(
        this.storeMarkerFile(),
        DURABLE_ASK_RESULT_HARD_LIMITS.maxMarkerBytes
      );
      this.observeIo('read', 'root-ledger', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertStoreMarker(value);
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity('Ask result store marker failed validation.', error);
    }
  }

  private async readOptionalGcCursor(): Promise<FileResultGcCursor | null> {
    try {
      const bytes = await readBoundedBytes(
        this.gcCursorFile(),
        DURABLE_ASK_RESULT_HARD_LIMITS.maxGcCursorBytes
      );
      this.observeIo('read', 'cursor', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertGcCursor(value);
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity('Ask result garbage collection cursor is invalid.', error);
    }
  }

  private async isBrandNewStore(): Promise<boolean> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      if (entries.length === 0) return true;
      if (
        entries.length !== 1
        || !entries[0].isDirectory()
        || entries[0].name !== path.basename(this.ledgerDirectory())
      ) {
        return false;
      }
      const ledgerEntries = await readdir(
        this.ledgerDirectory(),
        { withFileTypes: true }
      );
      return ledgerEntries.length === 0 || (
        ledgerEntries.length === 1
        && ledgerEntries[0].isDirectory()
        && ledgerEntries[0].name === path.basename(this.temporaryDirectory())
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return true;
      throw resultIntegrity('Ask result store root is unreadable.', error);
    }
  }

  private async garbageCollectTemporaryFiles(force = false): Promise<void> {
    if (this.temporaryPreflightComplete && !force) return;
    const directory = this.temporaryDirectory();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
      this.observeIo('list', 'temporary');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.temporaryPreflightComplete = true;
        return;
      }
      throw resultIntegrity(
        'Ask result temporary directory is unreadable.',
        error
      );
    }
    if (entries.length > DURABLE_ASK_RESULT_HARD_LIMITS.maxTemporaryEntries) {
      throw resultCapacity(
        'Ask result temporary cleanup exceeded its bounded entry limit.'
      );
    }
    const nowMs = assertValidDate(this.now()).getTime();
    const candidates = entries.map(entry => {
      const match = TEMPORARY_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw resultIntegrity(
          'Ask result temporary directory contains an invalid entry.'
        );
      }
      const createdAt = Number(match[1]);
      if (!Number.isSafeInteger(createdAt) || createdAt > nowMs) {
        throw resultIntegrity('Ask result temporary file timestamp is invalid.');
      }
      return {
        createdAt,
        file: this.resolveInside(directory, entry.name),
      };
    }).sort((left, right) => left.createdAt - right.createdAt);
    const startedAt = Date.now();
    const maximumTemporaryFileBytes = this.maxResultBytes
      + DURABLE_ASK_RESULT_HARD_LIMITS.maxEnvelopeOverheadBytes;
    let scannedEntries = 0;
    let scannedBytes = 0;
    let reachedBound = false;
    let retainedActiveFile = false;
    for (const candidate of candidates) {
      if (
        scannedEntries >= this.gcMaxEntries
        || Date.now() - startedAt >= this.gcMaxDurationMs
      ) {
        reachedBound = true;
        break;
      }
      const fileStats = await stat(candidate.file);
      if (
        !fileStats.isFile()
        || fileStats.size > maximumTemporaryFileBytes
      ) {
        throw resultIntegrity(
          'Ask result temporary file exceeds its bounded byte limit.'
        );
      }
      if (scannedBytes + fileStats.size > this.gcMaxBytes) {
        reachedBound = true;
        break;
      }
      scannedEntries += 1;
      scannedBytes += fileStats.size;
      if (candidate.createdAt + this.temporaryFileTtlMs > nowMs) {
        retainedActiveFile = true;
        continue;
      }
      if (await unlinkIfExists(candidate.file)) {
        this.observeIo('delete', 'temporary', fileStats.size);
      }
    }
    this.temporaryPreflightComplete = !reachedBound && !retainedActiveFile;
  }

  private async readDirectoryEntries(
    directory: string,
    target: DurableAskResultIoEvent['target'],
    maximumEntries: number
  ): Promise<Dirent<string>[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      this.observeIo('list', target);
      if (entries.length > maximumEntries) {
        throw resultCapacity(
          'Ask result directory exceeded its bounded entry limit.'
        );
      }
      return entries;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity('Ask result directory is unreadable.', error);
    }
  }

  private async writeRootLedger(ledger: FileResultRootLedger): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(ledger, null, 2), 'utf8');
    if (bytes.byteLength > DURABLE_ASK_RESULT_HARD_LIMITS.maxLedgerBytes) {
      throw resultIntegrity('Ask result root ledger exceeds its byte limit.');
    }
    await this.replaceBytesAtomically(this.rootLedgerFile(), bytes);
    this.observeIo('write', 'root-ledger', bytes.byteLength);
  }

  private async writeScopeLedger(ledger: FileResultScopeLedger): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(ledger, null, 2), 'utf8');
    if (bytes.byteLength > DURABLE_ASK_RESULT_HARD_LIMITS.maxLedgerBytes) {
      throw resultIntegrity('Ask result scope ledger exceeds its byte limit.');
    }
    await this.replaceBytesAtomically(
      this.scopeLedgerFile(ledger.scopeDigest),
      bytes
    );
    this.observeIo('write', 'scope-ledger', bytes.byteLength);
  }

  private async writeScopeMarker(marker: FileResultScopeMarker): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(marker, null, 2), 'utf8');
    if (bytes.byteLength > DURABLE_ASK_RESULT_HARD_LIMITS.maxMarkerBytes) {
      throw resultIntegrity('Ask result scope marker exceeds its byte limit.');
    }
    await this.replaceBytesAtomically(
      this.scopeMarkerFile(marker.scopeDigest),
      bytes
    );
    this.observeIo('write', 'scope-ledger', bytes.byteLength);
  }

  private async writeStoreMarker(marker: FileResultStoreMarker): Promise<void> {
    const bytes = serializeStoreMarker(marker);
    await this.replaceBytesAtomically(this.storeMarkerFile(), bytes);
    this.observeIo('write', 'root-ledger', bytes.byteLength);
  }

  private async writeGcCursor(cursor: FileResultGcCursor): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(cursor, null, 2), 'utf8');
    if (bytes.byteLength > DURABLE_ASK_RESULT_HARD_LIMITS.maxGcCursorBytes) {
      throw resultIntegrity('Ask result garbage collection cursor is too large.');
    }
    await this.replaceBytesAtomically(this.gcCursorFile(), bytes);
    this.observeIo('write', 'cursor', bytes.byteLength);
  }

  private async writeReservation(reservation: FileResultReservation): Promise<void> {
    const bytes = serializeReservation(reservation);
    await this.replaceBytesAtomically(
      this.artifactReservationFileForKey(
        reservation.identityDigest,
        reservation.reservationKey
      ),
      bytes
    );
    this.observeIo('write', 'reservation', bytes.byteLength);
  }

  private async readArtifactReservationByKey(
    identityDigest: string,
    reservationKey: string
  ): Promise<FileResultReservation | null> {
    try {
      return await this.readArtifactReservationFile(
        this.artifactReservationFileForKey(identityDigest, reservationKey),
        reservationKey
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async assertArtifactReservation(
    identity: DurableAskResultIdentity,
    artifactId: string,
    expectedBytes?: number
  ): Promise<FileResultReservation> {
    const reservation = await this.readArtifactReservation(identity, artifactId);
    if (!reservation) {
      throw resultIntegrity('Ask result artifact has no capacity reservation.');
    }
    if (expectedBytes !== undefined && reservation.reservedBytes !== expectedBytes) {
      throw resultIntegrity('Ask result reservation byte count is inconsistent.');
    }
    return reservation;
  }

  private async readArtifactReservation(
    identity: DurableAskResultIdentity,
    artifactId: string
  ): Promise<FileResultReservation | null> {
    const reservationKey = createReservationKey(identity, artifactId);
    try {
      return await this.readArtifactReservationFile(
        this.artifactReservationFile(identity, artifactId),
        reservationKey
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity(
        'Ask result artifact capacity reservation failed validation.',
        error
      );
    }
  }

  private async readIdentityReservationCatalog(
    identityDigest: string,
    maximumEntries: number
  ): Promise<Array<{
    file: string;
    reservation: FileResultReservation;
  }>> {
    const directory = this.artifactReservationDirectory(identityDigest);
    const reservations: Array<{
      file: string;
      reservation: FileResultReservation;
    }> = [];
    const entries = await this.readDirectoryEntries(
      directory,
      'reservation',
      Math.min(
        maximumEntries,
        DURABLE_ASK_RESULT_HARD_LIMITS.maxReservationDirectoryEntries
      )
    );
    for (const entry of entries.sort(compareDirentNames)) {
      const match = RESERVATION_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw resultIntegrity(
          'Ask result identity reservation catalog contains an invalid entry.'
        );
      }
      if (reservations.length >= maximumEntries) {
        throw resultCapacity(
          'Ask result identity reservation catalog exceeded its bounded scan.'
        );
      }
      const file = this.resolveInside(directory, entry.name);
      const reservation = await this.readArtifactReservationFile(file, match[1]);
      if (reservation.identityDigest !== identityDigest) {
        throw resultIntegrity(
          'Ask result reservation identity does not match its directory.'
        );
      }
      reservations.push({ file, reservation });
    }
    return reservations;
  }

  private async readArtifactReservationFile(
    file: string,
    expectedReservationKey: string
  ): Promise<FileResultReservation> {
    try {
      const bytes = await readBoundedBytes(
        file,
        DURABLE_ASK_RESULT_HARD_LIMITS.maxReservationBytes
      );
      this.observeIo('read', 'reservation', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertResultReservation(value, expectedReservationKey);
      return { ...value };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw error;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity(
        'Ask result artifact capacity reservation failed validation.',
        error
      );
    }
  }

  private async readOptionalArtifact<TResult extends DurableJsonObject>(
    file: string,
    identity: DurableAskResultIdentity,
    artifactId: string
  ): Promise<DurableAskResultArtifact<TResult> | null> {
    try {
      const bytes = await readBoundedBytes(
        file,
        this.maxResultBytes
          + DURABLE_ASK_RESULT_HARD_LIMITS.maxEnvelopeOverheadBytes
      );
      this.observeIo('read', 'artifact', bytes.byteLength);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      assertResultArtifact(value, identity, artifactId, this.maxResultBytes);
      return cloneArtifact(value) as DurableAskResultArtifact<TResult>;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof DurableAskResultStoreError) throw error;
      throw resultIntegrity(
        'Ask result artifact failed integrity validation.',
        error
      );
    }
  }

  private artifactReservationDirectory(identityDigest: string): string {
    return this.resolveInside(
      this.identityDirectoryByDigest(identityDigest),
      'reservations'
    );
  }

  private artifactReservationFile(
    identity: DurableAskResultIdentity,
    artifactId: string
  ): string {
    return this.artifactReservationFileForKey(
      createIdentityDigest(identity),
      createReservationKey(identity, artifactId)
    );
  }

  private artifactReservationFileForKey(
    identityDigest: string,
    reservationKey: string
  ): string {
    if (!SHA256_PATTERN.test(identityDigest)) {
      throw new Error('identityDigest must be a SHA-256 identifier.');
    }
    if (!SHA256_PATTERN.test(reservationKey)) {
      throw new Error('reservationKey must be a SHA-256 identifier.');
    }
    return this.resolveInside(
      this.artifactReservationDirectory(identityDigest),
      reservationKey + '.json'
    );
  }

  private capacityLockKey(): string {
    return this.rootDir + '\u0000__artifact_capacity__';
  }

  private maintenanceLockKey(): string {
    return this.rootDir + '\u0000__artifact_maintenance__';
  }

  private ledgerDirectory(): string {
    return this.resolveInside(this.rootDir, 'ledgers');
  }

  private temporaryDirectory(): string {
    return this.resolveInside(this.ledgerDirectory(), 'tmp');
  }

  private rootLedgerFile(): string {
    return this.resolveInside(this.ledgerDirectory(), 'root.json');
  }

  private scopeLedgerDirectory(scopeDigest: string): string {
    if (!SHA256_PATTERN.test(scopeDigest)) {
      throw new Error('scopeDigest must be a SHA-256 identifier.');
    }
    return this.resolveInside(
      this.scopeLedgerRootDirectory(),
      scopeDigest.slice(0, 2)
    );
  }

  private scopeLedgerRootDirectory(): string {
    return this.resolveInside(this.ledgerDirectory(), 'scopes');
  }

  private scopeLedgerFile(scopeDigest: string): string {
    return this.resolveInside(
      this.scopeLedgerDirectory(scopeDigest),
      scopeDigest + '.ledger.json'
    );
  }

  private scopeMarkerFile(scopeDigest: string): string {
    return this.resolveInside(
      this.scopeLedgerDirectory(scopeDigest),
      scopeDigest + '.marker.json'
    );
  }

  private gcCursorFile(): string {
    return this.resolveInside(this.ledgerDirectory(), 'gc-cursor.json');
  }

  private storeMarkerFile(): string {
    return this.resolveInside(this.ledgerDirectory(), 'store.marker.json');
  }

  private rebuildMarkerFile(): string {
    return this.resolveInside(this.ledgerDirectory(), 'rebuild.pending.json');
  }

  private identityShardDirectory(identity: DurableAskResultIdentity): string {
    return this.identityShardDirectoryByDigest(createIdentityDigest(identity));
  }

  private identityShardDirectoryByDigest(identityDigest: string): string {
    if (!SHA256_PATTERN.test(identityDigest)) {
      throw new Error('identityDigest must be a SHA-256 identifier.');
    }
    return this.resolveInside(this.rootDir, identityDigest.slice(0, 2));
  }

  private identityDirectory(identity: DurableAskResultIdentity): string {
    return this.identityDirectoryByDigest(createIdentityDigest(identity));
  }

  private identityDirectoryByDigest(identityDigest: string): string {
    return this.resolveInside(
      this.identityShardDirectoryByDigest(identityDigest),
      identityDigest
    );
  }

  private artifactDirectory(identity: DurableAskResultIdentity): string {
    return this.resolveInside(this.identityDirectory(identity), 'artifacts');
  }

  private artifactDirectoryByDigest(identityDigest: string): string {
    return this.resolveInside(
      this.identityDirectoryByDigest(identityDigest),
      'artifacts'
    );
  }

  private async cleanupArtifactDirectories(
    identity: DurableAskResultIdentity
  ): Promise<void> {
    await this.cleanupArtifactDirectoriesByDigest(createIdentityDigest(identity));
  }

  private async cleanupArtifactDirectoriesByDigest(
    identityDigest: string
  ): Promise<void> {
    await rmdirIfEmpty(this.artifactDirectoryByDigest(identityDigest));
    await rmdirIfEmpty(this.artifactReservationDirectory(identityDigest));
    await rmdirIfEmpty(this.identityDirectoryByDigest(identityDigest));
    await rmdirIfEmpty(this.identityShardDirectoryByDigest(identityDigest));
  }

  private artifactFile(
    identity: DurableAskResultIdentity,
    artifactId: string
  ): string {
    const artifactDigest = assertArtifactId(artifactId).slice('sha256:'.length);
    return this.resolveInside(
      this.artifactDirectory(identity),
      artifactDigest + '.json'
    );
  }

  private artifactFileByDigest(
    identityDigest: string,
    artifactId: string
  ): string {
    const artifactDigest = assertArtifactId(artifactId).slice('sha256:'.length);
    return this.resolveInside(
      this.artifactDirectoryByDigest(identityDigest),
      artifactDigest + '.json'
    );
  }

  private identityLockKey(identity: DurableAskResultIdentity): string {
    return this.identityLockKeyByDigest(createIdentityDigest(identity));
  }

  private identityLockKeyByDigest(identityDigest: string): string {
    if (!SHA256_PATTERN.test(identityDigest)) {
      throw new Error('identityDigest must be a SHA-256 identifier.');
    }
    return this.rootDir + '\u0000identity\u0000' + identityDigest;
  }

  private observeIo(
    operation: DurableAskResultIoEvent['operation'],
    target: DurableAskResultIoEvent['target'],
    bytes?: number
  ): void {
    this.ioObserver?.({
      operation,
      target,
      ...(bytes === undefined ? {} : { bytes }),
    });
  }

  private async emitLifecycle(
    point: DurableAskResultLifecyclePoint
  ): Promise<void> {
    await this.lifecycleHook?.(point);
  }

  private publishImmutableBytes(
    file: string,
    bytes: Uint8Array
  ): Promise<boolean> {
    return publishImmutableBytes(
      file,
      bytes,
      this.temporaryDirectory(),
      assertValidDate(this.now()).getTime(),
      this.temporaryFileUnlink,
      () => {
        this.temporaryPreflightComplete = false;
      }
    );
  }

  private replaceBytesAtomically(
    file: string,
    bytes: Uint8Array
  ): Promise<void> {
    return replaceBytesAtomically(
      file,
      bytes,
      this.temporaryDirectory(),
      assertValidDate(this.now()).getTime(),
      this.temporaryFileUnlink,
      () => {
        this.temporaryPreflightComplete = false;
      }
    );
  }

  private resolveInside(root: string, ...segments: string[]): string {
    const candidate = path.resolve(root, ...segments);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Ask result artifact path escaped its configured root.');
    }
    return candidate;
  }
}

function normalizePublication<TResult extends DurableJsonObject>(
  publication: DurableAskResultPublication<TResult>,
  maxResultBytes: number
): NormalizedResultPublication<TResult> {
  if (!publication || typeof publication !== 'object') {
    throw new Error('Ask result publication must be an object.');
  }
  const identity = normalizeResultIdentity(publication.identity);
  assertDurableWorkflowSerializable(publication.result, {
    label: 'ask result artifact',
    maxBytes: maxResultBytes,
    allowSensitiveFields: true,
  });
  assertNoCredentialFields(publication.result);
  if (
    !publication.result
    || typeof publication.result !== 'object'
    || Array.isArray(publication.result)
  ) {
    throw new Error('Ask result artifact must contain a JSON object.');
  }
  const result = cloneJson(publication.result);
  const serializedResult = stableStringify(result);
  const byteLength = Buffer.byteLength(serializedResult, 'utf8');
  const contentDigest = sha256(serializedResult);
  const artifactId = 'sha256:' + sha256(stableStringify({
    identity,
    contentDigest,
  } as unknown as DurableJsonValue));
  return {
    identity,
    result,
    byteLength,
    contentDigest,
    artifactId,
  };
}

type ArtifactDigestPayload<TResult extends DurableJsonObject = DurableJsonObject> =
  Omit<DurableAskResultArtifact<TResult>, 'artifactDigest'>;

function createArtifact<TResult extends DurableJsonObject>(
  publication: NormalizedResultPublication<TResult>,
  now: () => Date
): DurableAskResultArtifact<TResult> {
  const payload: ArtifactDigestPayload<TResult> = {
    schemaVersion: DURABLE_ASK_RESULT_ARTIFACT_VERSION,
    artifactId: publication.artifactId,
    identity: cloneJson(publication.identity),
    contentDigest: publication.contentDigest,
    byteLength: publication.byteLength,
    createdAt: assertValidDate(now()).toISOString(),
    result: cloneJson(publication.result),
  };
  return {
    ...payload,
    artifactDigest: createArtifactDigest(payload),
  };
}

function createArtifactDigest(payload: ArtifactDigestPayload): string {
  return sha256(stableStringify(payload as unknown as DurableJsonValue));
}

function assertResultArtifact(
  value: unknown,
  expectedIdentity: DurableAskResultIdentity,
  expectedArtifactId: string,
  maxResultBytes: number
): asserts value is DurableAskResultArtifact {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_ARTIFACT_VERSION
    || value.artifactId !== expectedArtifactId
    || typeof value.artifactDigest !== 'string'
    || !SHA256_PATTERN.test(value.artifactDigest)
    || typeof value.contentDigest !== 'string'
    || !SHA256_PATTERN.test(value.contentDigest)
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 2
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw resultIntegrity('Ask result artifact has an invalid persisted shape.');
  }
  const identity = normalizeResultIdentity(
    value.identity as unknown as DurableAskResultIdentity
  );
  if (!sameResultIdentity(identity, expectedIdentity)) {
    throw resultIntegrity(
      'Ask result artifact identity does not match its storage key.'
    );
  }
  assertDurableWorkflowSerializable(value.result, {
    label: 'stored ask result artifact',
    maxBytes: maxResultBytes,
    allowSensitiveFields: true,
  });
  assertNoCredentialFields(value.result);
  if (!isRecord(value.result)) {
    throw resultIntegrity('Stored ask result artifact must be a JSON object.');
  }
  const serializedResult = stableStringify(value.result as DurableJsonValue);
  const byteLength = Buffer.byteLength(serializedResult, 'utf8');
  const contentDigest = sha256(serializedResult);
  if (
    byteLength !== value.byteLength
    || contentDigest !== value.contentDigest
  ) {
    throw resultIntegrity(
      'Ask result artifact content digest or byte length is invalid.'
    );
  }
  const artifactId = 'sha256:' + sha256(stableStringify({
    identity,
    contentDigest,
  } as unknown as DurableJsonValue));
  if (artifactId !== value.artifactId) {
    throw resultIntegrity(
      'Ask result artifact ID does not match its identity and content.'
    );
  }
  const { artifactDigest, ...payload } =
    value as unknown as DurableAskResultArtifact;
  if (createArtifactDigest(payload) !== artifactDigest) {
    throw resultIntegrity('Ask result artifact envelope digest is invalid.');
  }
}

function normalizeResultIdentity(
  identity: DurableAskResultIdentity
): DurableAskResultIdentity {
  if (!identity || typeof identity !== 'object') {
    throw new Error('Ask result identity must be an object.');
  }
  if (typeof identity.enforceIsolation !== 'boolean') {
    throw new Error('Ask result identity isolation flag must be boolean.');
  }
  const scope = createRetrievalScope({
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    allowedTrustLevels: identity.allowedTrustLevels as RagRetrievalScope['allowedTrustLevels'],
    enforceIsolation: identity.enforceIsolation,
  });
  const threadId = identity.threadId?.trim();
  if (!threadId || !SAFE_THREAD_ID.test(threadId)) {
    throw new Error('threadId must be a safe ask result identifier.');
  }
  const generationId = assertDurableGenerationId(identity.generationId);
  return {
    generationId,
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    threadId,
    allowedTrustLevels: [...scope.allowedTrustLevels].sort(),
    enforceIsolation: scope.enforceIsolation,
  };
}

function assertResultIdentityWithinScope(
  identity: DurableAskResultIdentity,
  scope: RagRetrievalScope
): void {
  const normalizedScope = createRetrievalScope({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    allowedTrustLevels: scope.allowedTrustLevels,
    enforceIsolation: scope.enforceIsolation,
  });
  if (identity.tenantId !== normalizedScope.tenantId) {
    throw new Error('Ask result artifact tenant scope mismatch.');
  }
  if (identity.corpusId !== normalizedScope.corpusId) {
    throw new Error('Ask result artifact corpus scope mismatch.');
  }
  if (identity.enforceIsolation !== normalizedScope.enforceIsolation) {
    throw new Error('Ask result artifact isolation mode mismatch.');
  }
  const allowedTrustLevels = [...normalizedScope.allowedTrustLevels].sort();
  if (
    identity.allowedTrustLevels.join('\u0000')
    !== allowedTrustLevels.join('\u0000')
  ) {
    throw new Error('Ask result artifact trust scope mismatch.');
  }
}

function assertNoCredentialFields(value: DurableJsonValue): void {
  function visit(item: DurableJsonValue, valuePath: string): void {
    if (item === null || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, valuePath + '[' + index + ']'));
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (isCredentialField(key, child)) {
        throw new Error(
          'Ask result artifact contains forbidden credential field '
            + valuePath + '.' + key + '.'
        );
      }
      visit(child, valuePath + '.' + key);
    }
  }
  visit(value, '$');
}

function isCredentialField(key: string, value: DurableJsonValue): boolean {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const segments = normalized.split('_').filter(Boolean);
  if (
    typeof value === 'number'
    && segments.length > 1
    && segments.at(-1) === 'count'
    && segments.includes('token')
  ) {
    return false;
  }
  if (segments.some(segment => FORBIDDEN_CREDENTIAL_SEGMENTS.has(segment))) {
    return true;
  }
  const compact = segments.join('');
  if (FORBIDDEN_COMPACT_CREDENTIAL_KEYS.has(compact)) return true;
  return (
    segments.includes('api') && segments.includes('key')
    || segments.includes('private') && segments.includes('key')
    || segments.includes('client') && segments.includes('secret')
  );
}

function sameResultIdentity(
  left: DurableAskResultIdentity,
  right: DurableAskResultIdentity
): boolean {
  return stableStringify(
    normalizeResultIdentity(left) as unknown as DurableJsonValue
  ) === stableStringify(
    normalizeResultIdentity(right) as unknown as DurableJsonValue
  );
}

function createIdentityDigest(identity: DurableAskResultIdentity): string {
  return sha256(stableStringify(
    normalizeResultIdentity(identity) as unknown as DurableJsonValue
  ));
}

function createArtifactKey(
  identity: DurableAskResultIdentity,
  artifactId: string
): string {
  return createIdentityDigest(identity) + '\u0000' + assertArtifactId(artifactId);
}

function createReservationKey(
  identity: DurableAskResultIdentity,
  artifactId: string
): string {
  return sha256(createArtifactKey(identity, artifactId));
}

type FileResultReservationPayload = Omit<
  FileResultReservation,
  'reservationDigest'
>;

function createResultReservation(
  payload: FileResultReservationPayload
): FileResultReservation {
  return {
    ...payload,
    reservationDigest: createResultReservationDigest(payload),
  };
}

function createResultReservationDigest(
  payload: FileResultReservationPayload
): string {
  return sha256(stableStringify(payload as unknown as DurableJsonValue));
}

function assertResultReservation(
  value: unknown,
  expectedReservationKey: string
): asserts value is FileResultReservation {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_RESERVATION_VERSION
    || value.reservationKey !== expectedReservationKey
    || !SHA256_PATTERN.test(expectedReservationKey)
    || typeof value.identityDigest !== 'string'
    || !SHA256_PATTERN.test(value.identityDigest)
    || typeof value.scopeDigest !== 'string'
    || !SHA256_PATTERN.test(value.scopeDigest)
    || typeof value.artifactId !== 'string'
    || !ARTIFACT_ID_PATTERN.test(value.artifactId)
    || !Number.isSafeInteger(value.reservedBytes)
    || (value.reservedBytes as number) < 1
    || (value.reservedBytes as number) > DURABLE_ASK_RESULT_HARD_LIMITS.maxRootBytes
    || (value.state !== 'reserved' && value.state !== 'committed')
    || typeof value.reservedAt !== 'string'
    || !Number.isFinite(Date.parse(value.reservedAt))
    || typeof value.reservationDigest !== 'string'
    || !SHA256_PATTERN.test(value.reservationDigest)
  ) {
    throw resultIntegrity('Ask result artifact capacity reservation is invalid.');
  }
  if (
    (value.state === 'committed'
      && (
        typeof value.committedAt !== 'string'
        || !Number.isFinite(Date.parse(value.committedAt))
      ))
    || (value.state === 'reserved' && value.committedAt !== undefined)
  ) {
    throw resultIntegrity(
      'Ask result artifact reservation state timestamps are invalid.'
    );
  }
  if (
    sha256(value.identityDigest + '\u0000' + value.artifactId)
    !== expectedReservationKey
  ) {
    throw resultIntegrity(
      'Ask result artifact capacity reservation does not match its storage path.'
    );
  }
  const { reservationDigest, ...payload } =
    value as unknown as FileResultReservation;
  if (createResultReservationDigest(payload) !== reservationDigest) {
    throw resultIntegrity(
      'Ask result artifact capacity reservation digest is invalid.'
    );
  }
}

function serializeArtifact(
  artifact: DurableAskResultArtifact,
  maxResultBytes: number
): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(artifact), 'utf8');
  if (
    bytes.byteLength
    > maxResultBytes + DURABLE_ASK_RESULT_HARD_LIMITS.maxEnvelopeOverheadBytes
  ) {
    throw new Error('Ask result artifact exceeds its file byte limit.');
  }
  return Uint8Array.from(bytes);
}

function serializeReservation(reservation: FileResultReservation): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(reservation), 'utf8');
  if (bytes.byteLength > DURABLE_ASK_RESULT_HARD_LIMITS.maxReservationBytes) {
    throw resultIntegrity('Ask result reservation exceeds its byte limit.');
  }
  return Uint8Array.from(bytes);
}

function createScopeDigest(identity: DurableAskResultIdentity): string {
  const normalized = normalizeResultIdentity(identity);
  return sha256(stableStringify({
    tenantId: normalized.tenantId,
    corpusId: normalized.corpusId,
  } as unknown as DurableJsonValue));
}

function createReservationKeyFromDigests(
  identityDigest: string,
  artifactId: string
): string {
  if (!SHA256_PATTERN.test(identityDigest)) {
    throw new Error('identityDigest must be a SHA-256 identifier.');
  }
  return sha256(identityDigest + '\u0000' + assertArtifactId(artifactId));
}

function emptyCounters(): ResultCapacityCounters {
  return { count: 0, bytes: 0 };
}

function cloneCounters(
  counters: ResultCapacityCounters
): ResultCapacityCounters {
  return { count: counters.count, bytes: counters.bytes };
}

function addCounters(
  counters: ResultCapacityCounters,
  countDelta: number,
  byteDelta: number
): ResultCapacityCounters {
  const next = {
    count: counters.count + countDelta,
    bytes: counters.bytes + byteDelta,
  };
  if (!Number.isSafeInteger(next.count) || !Number.isSafeInteger(next.bytes)) {
    throw resultIntegrity('Ask result capacity counters overflowed.');
  }
  return next;
}

function assertNonNegativeCounters(counters: ResultCapacityCounters): void {
  if (
    !Number.isSafeInteger(counters.count)
    || counters.count < 0
    || !Number.isSafeInteger(counters.bytes)
    || counters.bytes < 0
  ) {
    throw resultIntegrity('Ask result capacity counters are invalid.');
  }
}

function assertCounterShape(
  value: unknown,
  label: string
): asserts value is ResultCapacityCounters {
  if (!isRecord(value)) {
    throw resultIntegrity(label + ' counters are missing.');
  }
  const counters = value as unknown as ResultCapacityCounters;
  try {
    assertNonNegativeCounters(counters);
  } catch (error) {
    throw resultIntegrity(label + ' counters are invalid.', error);
  }
}

function sameCounters(
  left: ResultCapacityCounters,
  right: ResultCapacityCounters
): boolean {
  return left.count === right.count && left.bytes === right.bytes;
}

function cloneReservation(
  reservation: FileResultReservation
): FileResultReservation {
  return { ...reservation };
}

function assertSameReservation(
  left: FileResultReservation,
  right: FileResultReservation
): void {
  if (
    left.reservationKey !== right.reservationKey
    || left.identityDigest !== right.identityDigest
    || left.scopeDigest !== right.scopeDigest
    || left.artifactId !== right.artifactId
    || left.reservedBytes !== right.reservedBytes
  ) {
    throw resultConflict(
      'Ask result capacity reservation contains conflicting immutable data.'
    );
  }
}

type RootLedgerPayload = Omit<
  FileResultRootLedger,
  'schemaVersion' | 'ledgerDigest'
>;

function createRootLedger(payload: RootLedgerPayload): FileResultRootLedger {
  const unsigned = {
    schemaVersion: DURABLE_ASK_RESULT_ROOT_LEDGER_VERSION,
    ...payload,
    counters: cloneCounters(payload.counters),
    lastMutation: payload.lastMutation
      ? cloneCapacityMutation(payload.lastMutation)
      : null,
  };
  return {
    ...unsigned,
    ledgerDigest: sha256(stableStringify(
      unsigned as unknown as DurableJsonValue
    )),
  };
}

function cloneRootLedger(ledger: FileResultRootLedger): FileResultRootLedger {
  return {
    ...ledger,
    counters: cloneCounters(ledger.counters),
    lastMutation: ledger.lastMutation
      ? cloneCapacityMutation(ledger.lastMutation)
      : null,
  };
}

function cloneCapacityMutation(
  mutation: ResultCapacityMutation
): ResultCapacityMutation {
  return {
    ...mutation,
    reservation: cloneReservation(mutation.reservation),
    beforeRoot: cloneCounters(mutation.beforeRoot),
    beforeScope: cloneCounters(mutation.beforeScope),
    afterScope: cloneCounters(mutation.afterScope),
  };
}

function assertRootLedger(value: unknown): asserts value is FileResultRootLedger {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_ROOT_LEDGER_VERSION
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.ledgerDigest !== 'string'
    || !SHA256_PATTERN.test(value.ledgerDigest)
    || (value.lastMutation !== null && !isRecord(value.lastMutation))
  ) {
    throw resultIntegrity('Ask result root capacity ledger has an invalid shape.');
  }
  assertCounterShape(value.counters, 'Ask result root ledger');
  if (value.lastMutation) {
    assertCapacityMutation(
      value.lastMutation,
      value.generation as number
    );
  }
  const { ledgerDigest, ...unsigned } = value as unknown as FileResultRootLedger;
  if (
    sha256(stableStringify(unsigned as unknown as DurableJsonValue))
    !== ledgerDigest
  ) {
    throw resultIntegrity('Ask result root capacity ledger digest is invalid.');
  }
  if (value.lastMutation) {
    assertPendingCapacityMutation(
      value as unknown as FileResultRootLedger,
      value.lastMutation as unknown as ResultCapacityMutation
    );
  }
}

function assertCapacityMutation(
  value: Record<string, unknown>,
  rootGeneration: number
): void {
  if (
    typeof value.mutationId !== 'string'
    || !SHA256_PATTERN.test(value.mutationId)
    || (value.kind !== 'reserve' && value.kind !== 'release')
    || !isRecord(value.reservation)
  ) {
    throw resultIntegrity('Ask result root capacity mutation is invalid.');
  }
  assertResultReservation(
    value.reservation,
    String(value.reservation.reservationKey ?? '')
  );
  assertCounterShape(value.beforeRoot, 'Ask result mutation root-before');
  assertCounterShape(value.beforeScope, 'Ask result mutation scope-before');
  assertCounterShape(value.afterScope, 'Ask result mutation scope-after');
  const expectedMutationId = sha256(stableStringify({
    generation: rootGeneration,
    kind: value.kind,
    reservationKey: value.reservation.reservationKey,
  } as unknown as DurableJsonValue));
  if (expectedMutationId !== value.mutationId) {
    throw resultIntegrity('Ask result root capacity mutation ID is invalid.');
  }
}

function assertPendingCapacityMutation(
  ledger: FileResultRootLedger,
  mutation: ResultCapacityMutation
): void {
  const delta = mutation.kind === 'reserve' ? 1 : -1;
  const expectedRoot = addCounters(
    mutation.beforeRoot,
    delta,
    delta * mutation.reservation.reservedBytes
  );
  const expectedScope = addCounters(
    mutation.beforeScope,
    delta,
    delta * mutation.reservation.reservedBytes
  );
  assertNonNegativeCounters(expectedRoot);
  assertNonNegativeCounters(expectedScope);
  if (
    !sameCounters(ledger.counters, expectedRoot)
    || !sameCounters(mutation.afterScope, expectedScope)
  ) {
    throw resultIntegrity(
      'Ask result root capacity mutation counters are inconsistent.'
    );
  }
}

type ScopeLedgerPayload = Omit<
  FileResultScopeLedger,
  'schemaVersion' | 'ledgerDigest'
>;

function createScopeLedger(
  payload: ScopeLedgerPayload
): FileResultScopeLedger {
  const unsigned = {
    schemaVersion: DURABLE_ASK_RESULT_SCOPE_LEDGER_VERSION,
    ...payload,
    counters: cloneCounters(payload.counters),
  };
  return {
    ...unsigned,
    ledgerDigest: sha256(stableStringify(
      unsigned as unknown as DurableJsonValue
    )),
  };
}

function cloneScopeLedger(ledger: FileResultScopeLedger): FileResultScopeLedger {
  return { ...ledger, counters: cloneCounters(ledger.counters) };
}

function assertScopeLedger(
  value: unknown,
  expectedScopeDigest: string
): asserts value is FileResultScopeLedger {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_SCOPE_LEDGER_VERSION
    || value.scopeDigest !== expectedScopeDigest
    || !SHA256_PATTERN.test(expectedScopeDigest)
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || !Number.isSafeInteger(value.appliedRootGeneration)
    || (value.appliedRootGeneration as number) < -1
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.ledgerDigest !== 'string'
    || !SHA256_PATTERN.test(value.ledgerDigest)
  ) {
    throw resultIntegrity('Ask result scope capacity ledger has an invalid shape.');
  }
  assertCounterShape(value.counters, 'Ask result scope ledger');
  const { ledgerDigest, ...unsigned } = value as unknown as FileResultScopeLedger;
  if (
    sha256(stableStringify(unsigned as unknown as DurableJsonValue))
    !== ledgerDigest
  ) {
    throw resultIntegrity('Ask result scope capacity ledger digest is invalid.');
  }
}

type ScopeMarkerPayload = Omit<FileResultScopeMarker, 'markerDigest'>;

function createScopeMarker(
  payload: ScopeMarkerPayload
): FileResultScopeMarker {
  return {
    ...payload,
    markerDigest: sha256(stableStringify(
      payload as unknown as DurableJsonValue
    )),
  };
}

function assertScopeMarker(
  value: unknown,
  expectedScopeDigest: string
): asserts value is FileResultScopeMarker {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_SCOPE_MARKER_VERSION
    || value.scopeDigest !== expectedScopeDigest
    || !SHA256_PATTERN.test(expectedScopeDigest)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.markerDigest !== 'string'
    || !SHA256_PATTERN.test(value.markerDigest)
  ) {
    throw resultIntegrity('Ask result scope marker has an invalid shape.');
  }
  const { markerDigest, ...unsigned } = value as unknown as FileResultScopeMarker;
  if (
    sha256(stableStringify(unsigned as unknown as DurableJsonValue))
    !== markerDigest
  ) {
    throw resultIntegrity('Ask result scope marker digest is invalid.');
  }
}

type StoreMarkerPayload = Omit<FileResultStoreMarker, 'markerDigest'>;

function createStoreMarker(
  payload: StoreMarkerPayload
): FileResultStoreMarker {
  return {
    ...payload,
    markerDigest: sha256(stableStringify(
      payload as unknown as DurableJsonValue
    )),
  };
}

function assertStoreMarker(value: unknown): asserts value is FileResultStoreMarker {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_STORE_MARKER_VERSION
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.markerDigest !== 'string'
    || !SHA256_PATTERN.test(value.markerDigest)
  ) {
    throw resultIntegrity('Ask result store marker has an invalid shape.');
  }
  const { markerDigest, ...unsigned } = value as unknown as FileResultStoreMarker;
  if (
    sha256(stableStringify(unsigned as unknown as DurableJsonValue))
    !== markerDigest
  ) {
    throw resultIntegrity('Ask result store marker digest is invalid.');
  }
}

function serializeStoreMarker(marker: FileResultStoreMarker): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(marker), 'utf8');
  if (bytes.byteLength > DURABLE_ASK_RESULT_HARD_LIMITS.maxMarkerBytes) {
    throw resultIntegrity('Ask result store marker exceeds its byte limit.');
  }
  return Uint8Array.from(bytes);
}

type GcCursorPayload = Omit<
  FileResultGcCursor,
  'schemaVersion' | 'cursorDigest'
>;

function createGcCursor(payload: GcCursorPayload): FileResultGcCursor {
  const unsigned = {
    schemaVersion: DURABLE_ASK_RESULT_GC_CURSOR_VERSION,
    ...payload,
  };
  return {
    ...unsigned,
    cursorDigest: sha256(stableStringify(
      unsigned as unknown as DurableJsonValue
    )),
  };
}

function assertGcCursor(value: unknown): asserts value is FileResultGcCursor {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_RESULT_GC_CURSOR_VERSION
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || (value.phase !== 'reservations' && value.phase !== 'artifacts')
    || !Number.isInteger(value.shard)
    || (value.shard as number) < 0
    || (value.shard as number) > 255
    || (value.identityDigest !== undefined
      && (typeof value.identityDigest !== 'string'
        || !SHA256_PATTERN.test(value.identityDigest)))
    || (value.afterName !== undefined
      && (typeof value.afterName !== 'string' || value.afterName.length > 128))
    || (value.afterName !== undefined && value.identityDigest === undefined)
    || typeof value.cursorDigest !== 'string'
    || !SHA256_PATTERN.test(value.cursorDigest)
  ) {
    throw resultIntegrity('Ask result garbage collection cursor has an invalid shape.');
  }
  const { cursorDigest, ...unsigned } = value as unknown as FileResultGcCursor;
  if (
    sha256(stableStringify(unsigned as unknown as DurableJsonValue))
    !== cursorDigest
  ) {
    throw resultIntegrity('Ask result garbage collection cursor digest is invalid.');
  }
}

function assertArtifactId(value: string): string {
  const normalized = value?.trim();
  if (!normalized || !ARTIFACT_ID_PATTERN.test(normalized)) {
    throw new Error('artifactId must be a SHA-256 ask result identifier.');
  }
  return normalized;
}

function resolveMaxResultBytes(value: number | undefined): number {
  const resolved = value ?? 4 * 1024 * 1024;
  if (
    !Number.isInteger(resolved)
    || resolved < 1
    || resolved > DURABLE_ASK_RESULT_HARD_LIMITS.maxResultBytes
  ) {
    throw new Error('maxResultBytes is outside the ask result hard limit.');
  }
  return resolved;
}

function resolveMaxArtifacts(value: number | undefined): number {
  const resolved = value ?? 2000;
  if (
    !Number.isInteger(resolved)
    || resolved < 1
    || resolved > DURABLE_ASK_RESULT_HARD_LIMITS.maxArtifacts
  ) {
    throw new Error('maxArtifacts is outside the ask result hard limit.');
  }
  return resolved;
}

function resolveMaxRootBytes(value: number | undefined): number {
  const resolved = value ?? 16 * 1024 * 1024 * 1024;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > DURABLE_ASK_RESULT_HARD_LIMITS.maxRootBytes
  ) {
    throw new Error('maxRootBytes is outside the ask result hard limit.');
  }
  return resolved;
}

function resolveMaxScopeArtifacts(
  value: number | undefined,
  maxArtifacts: number
): number {
  const resolved = value
    ?? Math.min(200, Math.max(1, Math.floor(maxArtifacts / 2)));
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > maxArtifacts
    || resolved > DURABLE_ASK_RESULT_HARD_LIMITS.maxScopeArtifacts
  ) {
    throw new Error('maxScopeArtifacts is outside the ask result hard limit.');
  }
  return resolved;
}

function resolveMaxScopeBytes(
  value: number | undefined,
  maxRootBytes: number
): number {
  const resolved = value ?? Math.min(512 * 1024 * 1024, maxRootBytes);
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > maxRootBytes
    || resolved > DURABLE_ASK_RESULT_HARD_LIMITS.maxScopeBytes
  ) {
    throw new Error('maxScopeBytes is outside the ask result hard limit.');
  }
  return resolved;
}

function resolveBoundedPositiveInteger(
  value: number | undefined,
  defaultValue: number,
  hardMaximum: number,
  label: string
): number {
  const resolved = value ?? defaultValue;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > hardMaximum
  ) {
    throw new Error(label + ' is outside the ask result hard limit.');
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

function assertValidDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Ask result store clock must return a valid Date.');
  }
  return value;
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneArtifact<T extends DurableJsonObject>(
  artifact: DurableAskResultArtifact<T>
): DurableAskResultArtifact<T> {
  return cloneJson(artifact);
}

async function publishImmutableBytes(
  file: string,
  bytes: Uint8Array,
  temporaryDirectory: string,
  createdAtMs: number,
  temporaryFileUnlink: (file: string) => Promise<void>,
  markTemporaryCleanupPending: () => void
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = path.join(
    temporaryDirectory,
    sha256(file) + '.' + createdAtMs + '.' + randomUUID() + '.tmp'
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
      await temporaryFileUnlink(temporary);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        markTemporaryCleanupPending();
      }
      // The immutable target may already be committed. Temporary cleanup must
      // never turn a successful publication into a reported failure.
    }
  }
}

async function replaceBytesAtomically(
  file: string,
  bytes: Uint8Array,
  temporaryDirectory: string,
  createdAtMs: number,
  temporaryFileUnlink: (file: string) => Promise<void>,
  markTemporaryCleanupPending: () => void
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = path.join(
    temporaryDirectory,
    sha256(file) + '.' + createdAtMs + '.' + randomUUID() + '.tmp'
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
        // Preserve the original atomic replacement error.
      }
    }
    try {
      await temporaryFileUnlink(temporary);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        markTemporaryCleanupPending();
      }
      // Preserve the replacement result while ensuring the next ordinary
      // mutation retries cleanup under the process maintenance lock.
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
      throw new Error('Ask result artifact path is not a regular file.');
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
      throw new Error('Ask result artifact file exceeds its byte limit.');
    }
    return Uint8Array.from(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

async function withResultStoreLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = resultStoreLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  resultStoreLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (resultStoreLocks.get(key) === tail) resultStoreLocks.delete(key);
  }
}

function resultCapacity(
  message = 'Ask result artifact capacity exceeded.'
): DurableAskResultStoreError {
  return new DurableAskResultStoreError(
    'DURABLE_ASK_RESULT_CAPACITY',
    message
  );
}

function resultConflict(message: string): DurableAskResultStoreError {
  return new DurableAskResultStoreError('DURABLE_ASK_RESULT_CONFLICT', message);
}

function resultIntegrity(
  message: string,
  cause?: unknown
): DurableAskResultStoreError {
  return new DurableAskResultStoreError(
    'DURABLE_ASK_RESULT_INTEGRITY',
    message,
    cause
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function compareDirentNames(left: Dirent<string>, right: Dirent<string>): number {
  return left.name.localeCompare(right.name);
}
