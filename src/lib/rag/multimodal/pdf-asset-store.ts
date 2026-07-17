import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  assertPdfAssetManifestIntegrity,
  DEFAULT_PDF_ASSET_LIMITS,
  sha256Hex,
  type PdfAssetImageMimeType,
  type PdfAssetManifest,
  type PdfAssetManifestPage,
} from './pdf-asset-manifest';
import {
  createRetrievalScope,
  type RagRetrievalScope,
  type RagTrustLevel,
} from '../../security/retrieval-scope';

export const PDF_ASSET_STORE_SCHEMA_VERSION = 'pdf-asset-store-v1' as const;

export const PDF_ASSET_STORE_DEFAULT_LIMITS = Object.freeze({
  maxPages: DEFAULT_PDF_ASSET_LIMITS.maxPages,
  maxImageBytes: DEFAULT_PDF_ASSET_LIMITS.maxImageBytes,
  maxTotalImageBytes: DEFAULT_PDF_ASSET_LIMITS.maxTotalImageBytes,
  maxManifestBytes: 1024 * 1024,
  maxRootAssetCount: 10_000,
  maxRootTotalBytes: 32 * 1024 * 1024 * 1024,
  maxScopeAssetCount: 2_000,
  maxScopeTotalBytes: 8 * 1024 * 1024 * 1024,
});

export const PDF_ASSET_STORE_HARD_LIMITS = Object.freeze({
  maxPages: DEFAULT_PDF_ASSET_LIMITS.maxPages,
  maxImageBytes: DEFAULT_PDF_ASSET_LIMITS.maxImageBytes,
  maxTotalImageBytes: DEFAULT_PDF_ASSET_LIMITS.maxTotalImageBytes,
  maxManifestBytes: 1024 * 1024,
  maxRootAssetCount: 100_000,
  maxRootTotalBytes: 512 * 1024 * 1024 * 1024,
  maxScopeAssetCount: 50_000,
  maxScopeTotalBytes: 128 * 1024 * 1024 * 1024,
});

export const PDF_ASSET_STORE_DEFAULT_RETENTION = Object.freeze({
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  orphanRetentionMs: 60 * 60 * 1000,
  gcMaxEntries: 64,
  gcMaxBytes: 64 * 1024 * 1024,
  gcMaxDurationMs: 50,
  gcMaxShardEntries: 2_048,
  gcMaxInvalidEntries: 16,
});

export const PDF_ASSET_STORE_HARD_RETENTION = Object.freeze({
  retentionMs: 365 * 24 * 60 * 60 * 1000,
  orphanRetentionMs: 7 * 24 * 60 * 60 * 1000,
  gcMaxEntries: 4096,
  gcMaxBytes: 1024 * 1024 * 1024,
  gcMaxDurationMs: 5_000,
  gcMaxShardEntries: 100_000,
  gcMaxInvalidEntries: 1_024,
});

export const PDF_ASSET_STORE_DEFAULT_CONTROL = Object.freeze({
  maxLedgerBytes: 1024 * 1024,
  maxInflightReservations: 64,
  reservationOverheadBytes: 4 * 1024,
  recoveryMaxShardsPerBatch: 4,
  maxScopeLedgers: 4_096,
});

export const PDF_ASSET_STORE_HARD_CONTROL = Object.freeze({
  maxLedgerBytes: 16 * 1024 * 1024,
  maxInflightReservations: 1_024,
  reservationOverheadBytes: 1024 * 1024,
  recoveryMaxShardsPerBatch: 256,
  maxScopeLedgers: 100_000,
});

export interface PdfAssetIdentity {
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
}

export interface PdfAssetPageWrite {
  pageNumber: number;
  bytes: Uint8Array;
}

export interface PdfAssetPublication {
  manifest: PdfAssetManifest;
  pageImages: readonly PdfAssetPageWrite[];
}

export interface PdfStoredPageAsset {
  manifest: PdfAssetManifest;
  page: PdfAssetImageManifestPage;
  bytes: Uint8Array;
}

export interface PdfAssetStore {
  /**
   * Both adapters coordinate callers in one Node.js process. The file adapter
   * uses immutable bundle publication for cross-process conflict detection, but
   * it is not a distributed transaction or lease service.
   */
  readonly coordination: 'process';
  put(publication: PdfAssetPublication): Promise<PdfAssetManifest>;
  getManifest(
    identity: PdfAssetIdentity,
    scope: RagRetrievalScope
  ): Promise<PdfAssetManifest | null>;
  readPage(
    identity: PdfAssetIdentity,
    pageNumber: number,
    scope: RagRetrievalScope
  ): Promise<PdfStoredPageAsset | null>;
  /** Deletes only the exact tenant/corpus/document/version/trust identity. */
  delete(identity: PdfAssetIdentity, scope: RagRetrievalScope): Promise<boolean>;
}

export interface PdfAssetStoreLimits {
  maxPages: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxManifestBytes: number;
  maxRootAssetCount: number;
  maxRootTotalBytes: number;
  maxScopeAssetCount: number;
  maxScopeTotalBytes: number;
}

export interface PdfAssetStoreRetention {
  retentionMs: number;
  orphanRetentionMs: number;
  gcMaxEntries: number;
  gcMaxBytes: number;
  gcMaxDurationMs: number;
  gcMaxShardEntries: number;
  gcMaxInvalidEntries: number;
}

export interface PdfAssetStoreControlLimits {
  maxLedgerBytes: number;
  maxInflightReservations: number;
  reservationOverheadBytes: number;
  recoveryMaxShardsPerBatch: number;
  maxScopeLedgers: number;
}

export type PdfAssetStoreReadKind = 'manifest' | 'page';

export type PdfAssetStoreIoKind =
  | 'root-ledger-read'
  | 'scope-ledger-read'
  | 'reservation-read'
  | 'manifest-read'
  | 'directory-entry';

export type PdfAssetPublicationPhase =
  | 'reservation-journal-written'
  | 'root-reserved'
  | 'scope-reserved'
  | 'bundle-published'
  | 'scope-committed'
  | 'root-committed';

export interface PdfAssetStoreOptions {
  limits?: Partial<PdfAssetStoreLimits>;
  retention?: Partial<PdfAssetStoreRetention>;
  control?: Partial<PdfAssetStoreControlLimits>;
  clock?: () => Date;
  onRead?: (kind: PdfAssetStoreReadKind) => void;
  onIo?: (kind: PdfAssetStoreIoKind) => void;
  onPublicationPhase?: (
    phase: PdfAssetPublicationPhase,
    reservationId: string
  ) => void | Promise<void>;
  processEpoch?: string;
}

export type PdfAssetStoreErrorCode =
  | 'PDF_ASSET_CONFLICT'
  | 'PDF_ASSET_INTEGRITY'
  | 'PDF_ASSET_CAPACITY'
  | 'PDF_ASSET_RECOVERY_REQUIRED'
  | 'PDF_ASSET_GC_BUDGET';

export class PdfAssetStoreError extends Error {
  readonly code: PdfAssetStoreErrorCode;

  constructor(code: PdfAssetStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PdfAssetStoreError';
    this.code = code;
  }
}

type PdfAssetImageManifestPage = PdfAssetManifestPage & Required<Pick<
  PdfAssetManifestPage,
  'imageRef' | 'contentDigest' | 'width' | 'height' | 'byteLength' | 'mimeType'
>>;

interface NormalizedPublication {
  identity: PdfAssetIdentity;
  manifest: PdfAssetManifest;
  publicationDigest: string;
  totalImageBytes: number;
  pages: Map<number, { page: PdfAssetImageManifestPage; bytes: Uint8Array }>;
}

interface StoredPdfAssetManifest {
  schemaVersion: typeof PDF_ASSET_STORE_SCHEMA_VERSION;
  publicationDigest: string;
  envelopeDigest: string;
  scopeDigest: string;
  totalImageBytes: number;
  publishedAt: string;
  expiresAt: string;
  manifest: PdfAssetManifest;
}

interface InMemoryEntry {
  envelope: StoredPdfAssetManifest;
  pages: Map<number, Uint8Array>;
}

interface ScopeUsage {
  count: number;
  totalBytes: number;
}

interface StoreUsage extends ScopeUsage {
  scopes: Map<string, ScopeUsage>;
}

type LedgerOperation = 'put' | 'delete';
type LedgerSettlement = 'commit' | 'release';
type GcPhase =
  | 'bundles'
  | 'reservations'
  | 'staging'
  | 'scope-control'
  | 'control-root-temps'
  | 'recovery-root-temps'
  | 'recovery-scope-temps';
type RecoveryPhase = 'bundles' | 'reservations' | 'scopes';
type ScopeLifecycle = 'creating' | 'active' | 'reclaiming';

interface LedgerCounters {
  committedCount: number;
  committedBytes: number;
  reservedCount: number;
  reservedBytes: number;
}

interface ActiveReservation {
  reservationId: string;
  operation: LedgerOperation;
  identityDigest: string;
  scopeDigest: string;
  publicationDigest: string;
  processEpoch: string;
  createdAtMs: number;
  committedBytes: number;
  reservedBytes: number;
}

interface PdfAssetGcCursor {
  phase: GcPhase;
  shard: number;
  lastName: string | null;
}

interface RootLedger extends LedgerCounters {
  schemaVersion: typeof ROOT_LEDGER_SCHEMA_VERSION;
  generation: number;
  recoveryRequired: boolean;
  activeReservations: Record<string, ActiveReservation>;
  scopeLifecycles: Record<string, ScopeLifecycle>;
  gcCursor: PdfAssetGcCursor;
  digest: string;
}

interface ScopeLedger extends LedgerCounters {
  schemaVersion: typeof SCOPE_LEDGER_SCHEMA_VERSION;
  generation: number;
  scopeDigest: string;
  recoveryRequired: boolean;
  activeReservations: Record<string, ActiveReservation>;
  settledReservations: Record<string, LedgerSettlement>;
  digest: string;
}

interface ReservationJournal {
  schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
  generation: number;
  reservation: ActiveReservation;
  state: 'prepared' | 'reserved' | 'published' | 'scope-settled' | 'root-settled';
  digest: string;
}

interface RecoveryLedger extends ScopeUsage {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  generation: number;
  target: 'root' | 'scope';
  scopeDigest: string | null;
  phase: RecoveryPhase;
  shard: number;
  lastName: string | null;
  liveScopeDigests: Record<string, true>;
  digest: string;
}

export interface PdfAssetLedgerRecoveryResult {
  target: 'root' | 'scope';
  complete: boolean;
  shardsScanned: number;
  entriesScanned: number;
}

export interface PdfAssetGcResult {
  entriesScanned: number;
  manifestBytesRead: number;
  invalidEntries: number;
  cursor: Readonly<PdfAssetGcCursor>;
}

const ROOT_LEDGER_SCHEMA_VERSION = 'pdf-asset-root-ledger-v2' as const;
const SCOPE_LEDGER_SCHEMA_VERSION = 'pdf-asset-scope-ledger-v1' as const;
const RESERVATION_SCHEMA_VERSION = 'pdf-asset-reservation-v1' as const;
const RECOVERY_SCHEMA_VERSION = 'pdf-asset-recovery-v3' as const;
const CONTROL_MARKER_SCHEMA_VERSION = 'pdf-asset-control-marker-v1' as const;
const SAFE_DOCUMENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_PROCESS_EPOCH = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const IDENTITY_DIRECTORY = /^[a-f0-9]{64}$/;
const RESERVATION_ID = /^[0-9a-f-]{36}$/;
const SCOPE_LEDGER_FILE = /^([a-f0-9]{64})\.json$/;
interface AtomicTempName {
  baseName: string;
  createdAtMs: number | null;
  writeId: string;
}

const ATOMIC_TEMP_FILE = /^(.+?)(?:[.]([0-9]{1,16}))?[.]([0-9a-f-]{36})[.]tmp$/;
const PROCESS_EPOCH = randomUUID();
const SIMULATED_HARD_CRASH_CODE = 'PDF_ASSET_SIMULATED_HARD_CRASH';
const fileStoreLocks = new Map<string, Promise<void>>();

export function pdfAssetIdentityFromManifest(
  manifest: PdfAssetManifest
): PdfAssetIdentity {
  return normalizeIdentity({
    tenantId: manifest.tenantId,
    corpusId: manifest.corpusId,
    documentId: manifest.documentId,
    documentVersion: manifest.documentVersion,
    trustLevel: manifest.trustLevel,
  });
}

export class InMemoryPdfAssetStore implements PdfAssetStore {
  readonly coordination = 'process' as const;
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly limits: PdfAssetStoreLimits;
  private readonly retention: PdfAssetStoreRetention;
  private readonly clock: () => Date;

  constructor(options: PdfAssetStoreOptions = {}) {
    this.limits = resolveStoreLimits(options.limits);
    this.retention = resolveStoreRetention(options.retention);
    assertGcManifestBudget(this.limits, this.retention);
    this.clock = options.clock ?? (() => new Date());
  }

  async put(publication: PdfAssetPublication): Promise<PdfAssetManifest> {
    const normalized = normalizePublication(publication, this.limits);
    const now = readClock(this.clock);
    this.collectExpired(now);
    const key = createIdentityKey(normalized.identity);
    const existing = this.entries.get(key);
    if (existing) {
      if (isExpired(existing.envelope, now)) {
        this.entries.delete(key);
      } else {
        assertStoredEnvelope(existing.envelope, normalized.identity, this.limits);
        if (existing.envelope.publicationDigest !== normalized.publicationDigest) {
          throw assetConflict('PDF asset identity already contains different content.');
        }
        return cloneManifest(existing.envelope.manifest);
      }
    }

    assertCapacity(this.createUsage(), normalized, this.limits);
    const pages = new Map<number, Uint8Array>();
    for (const [pageNumber, value] of normalized.pages) {
      pages.set(pageNumber, Uint8Array.from(value.bytes));
    }
    const envelope = createStoredEnvelope(normalized, now, this.retention.retentionMs);
    // Publishing this map entry last keeps partially cloned pages invisible.
    this.entries.set(key, { envelope, pages });
    return cloneManifest(envelope.manifest);
  }

  async getManifest(
    identity: PdfAssetIdentity,
    scope: RagRetrievalScope
  ): Promise<PdfAssetManifest | null> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    const now = readClock(this.clock);
    this.collectExpired(now);
    const key = createIdentityKey(normalized);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (isExpired(entry.envelope, now)) {
      this.entries.delete(key);
      return null;
    }
    assertStoredEnvelope(entry.envelope, normalized, this.limits);
    // Manifest reads intentionally validate only the signed envelope. Page
    // digests are verified lazily and exactly when readPage is called.
    return cloneManifest(entry.envelope.manifest);
  }

  async readPage(
    identity: PdfAssetIdentity,
    pageNumber: number,
    scope: RagRetrievalScope
  ): Promise<PdfStoredPageAsset | null> {
    assertPageNumber(pageNumber);
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    const now = readClock(this.clock);
    this.collectExpired(now);
    const key = createIdentityKey(normalized);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (isExpired(entry.envelope, now)) {
      this.entries.delete(key);
      return null;
    }
    assertStoredEnvelope(entry.envelope, normalized, this.limits);
    const page = findImagePage(entry.envelope.manifest, pageNumber);
    if (!page) return null;
    const bytes = entry.pages.get(pageNumber);
    if (!bytes) {
      throw assetIntegrity('Visible PDF asset manifest references a missing page image.');
    }
    assertPageBytes(page, bytes, this.limits);
    return {
      manifest: cloneManifest(entry.envelope.manifest),
      page: { ...page },
      bytes: Uint8Array.from(bytes),
    };
  }

  async delete(
    identity: PdfAssetIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope, true);
    const now = readClock(this.clock);
    this.collectExpired(now);
    const key = createIdentityKey(normalized);
    const entry = this.entries.get(key);
    if (!entry) return false;
    assertStoredEnvelope(entry.envelope, normalized, this.limits);
    if (isExpired(entry.envelope, now)) {
      this.entries.delete(key);
      return false;
    }
    return this.entries.delete(key);
  }

  private collectExpired(now: number): void {
    let examined = 0;
    for (const [key, entry] of this.entries) {
      if (examined >= this.retention.gcMaxEntries) break;
      examined += 1;
      if (isExpired(entry.envelope, now)) this.entries.delete(key);
    }
  }

  private createUsage(): StoreUsage {
    const usage = emptyUsage();
    for (const entry of this.entries.values()) {
      addUsage(
        usage,
        entry.envelope.scopeDigest,
        entry.envelope.totalImageBytes
      );
    }
    return usage;
  }
}

/**
 * Durable local adapter with bundle-level manifest-last visibility. Each writer
 * owns a unique staging directory and atomically renames the complete bundle
 * into place. Rollback therefore removes only that writer's files and cannot
 * unlink a concurrent winner's committed pages.
 */
export class FilePdfAssetStore implements PdfAssetStore {
  readonly coordination = 'process' as const;
  private readonly rootDir: string;
  private readonly limits: PdfAssetStoreLimits;
  private readonly retention: PdfAssetStoreRetention;
  private readonly control: PdfAssetStoreControlLimits;
  private readonly clock: () => Date;
  private readonly onRead?: (kind: PdfAssetStoreReadKind) => void;
  private readonly onIo?: (kind: PdfAssetStoreIoKind) => void;
  private readonly onPublicationPhase?: PdfAssetStoreOptions['onPublicationPhase'];
  private readonly processEpoch: string;

  constructor(
    rootDir = path.join(process.cwd(), 'uploads', 'pdf-visual-assets-v1'),
    options: PdfAssetStoreOptions = {}
  ) {
    this.rootDir = path.resolve(rootDir);
    this.limits = resolveStoreLimits(options.limits);
    this.retention = resolveStoreRetention(options.retention);
    assertGcManifestBudget(this.limits, this.retention);
    this.control = resolveStoreControl(options.control);
    this.clock = options.clock ?? (() => new Date());
    this.onRead = options.onRead;
    this.onIo = options.onIo;
    this.onPublicationPhase = options.onPublicationPhase;
    this.processEpoch = options.processEpoch ?? PROCESS_EPOCH;
    if (!SAFE_PROCESS_EPOCH.test(this.processEpoch)) {
      throw new Error('PDF asset store process epoch is invalid.');
    }
  }

  async put(publication: PdfAssetPublication): Promise<PdfAssetManifest> {
    const normalized = normalizePublication(publication, this.limits);
    await this.ensureControlPlane();
    await this.runGarbageCollectionBatch();
    const identityDigest = createIdentityDigest(normalized.identity);
    return withFileStoreLock(this.identityLockKey(identityDigest), async () => {
      const now = readClock(this.clock);
      let existing = await this.readStoredEnvelope(normalized.identity);
      if (existing && isExpired(existing, now)) {
        await this.deleteCommittedBundle(normalized.identity, existing);
        existing = null;
      }
      if (existing) {
        if (existing.publicationDigest !== normalized.publicationDigest) {
          throw assetConflict('PDF asset identity already contains different content.');
        }
        return cloneManifest(existing.manifest);
      }

      await this.removeIncompleteExactBundle(normalized.identity);
      const envelope = createStoredEnvelope(
        normalized,
        now,
        this.retention.retentionMs
      );
      const serialized = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
      if (serialized.byteLength > this.limits.maxManifestBytes) {
        throw new Error('PDF asset manifest exceeds the configured byte limit.');
      }
      const reservation: ActiveReservation = {
        reservationId: randomUUID(),
        operation: 'put',
        identityDigest,
        scopeDigest: envelope.scopeDigest,
        publicationDigest: envelope.publicationDigest,
        processEpoch: this.processEpoch,
        createdAtMs: now,
        committedBytes: normalized.totalImageBytes + serialized.byteLength,
        reservedBytes:
          normalized.totalImageBytes
          + serialized.byteLength
          + this.control.reservationOverheadBytes,
      };
      const stagingDirectory = this.stagingDirectory(reservation);
      let simulatedCrash = false;
      try {
        await this.beginReservation(reservation);
        await mkdir(path.join(stagingDirectory, 'pages'), { recursive: true });
        for (const { page, bytes } of normalized.pages.values()) {
          await writeExclusiveBytes(
            this.pageFileWithin(stagingDirectory, page),
            bytes
          );
        }
        await writeExclusiveBytes(
          path.join(stagingDirectory, 'manifest.json'),
          serialized
        );
        const finalDirectory = this.bundleDirectory(normalized.identity);
        await mkdir(path.dirname(finalDirectory), { recursive: true });
        await rename(stagingDirectory, finalDirectory);
        await this.updateReservationJournal(reservation, 'published');
        await this.emitPublicationPhase('bundle-published', reservation.reservationId);
        await this.settleReservation(reservation, 'commit');
        return cloneManifest(envelope.manifest);
      } catch (error) {
        simulatedCrash = isSimulatedHardCrash(error);
        if (!simulatedCrash
          && await this.hasActiveRootReservation(reservation.reservationId)) {
          await this.reconcileReservation(reservation);
        }
        throw error;
      } finally {
        if (!simulatedCrash) {
          await rm(stagingDirectory, { recursive: true, force: true });
          await rm(this.reservationFile(reservation.reservationId), {
            force: true,
          });
        }
      }
    });
  }

  async getManifest(
    identity: PdfAssetIdentity,
    scope: RagRetrievalScope
  ): Promise<PdfAssetManifest | null> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    const identityDigest = createIdentityDigest(normalized);
    return withFileStoreLock(this.identityLockKey(identityDigest), async () => {
      const envelope = await this.readStoredEnvelope(normalized, true);
      if (!envelope) return null;
      if (isExpired(envelope, readClock(this.clock))) {
        await this.ensureControlPlane();
        await this.deleteCommittedBundle(normalized, envelope);
        return null;
      }
      return cloneManifest(envelope.manifest);
    });
  }

  async readPage(
    identity: PdfAssetIdentity,
    pageNumber: number,
    scope: RagRetrievalScope
  ): Promise<PdfStoredPageAsset | null> {
    assertPageNumber(pageNumber);
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    const identityDigest = createIdentityDigest(normalized);
    return withFileStoreLock(this.identityLockKey(identityDigest), async () => {
      const envelope = await this.readStoredEnvelope(normalized, true);
      if (!envelope) return null;
      if (isExpired(envelope, readClock(this.clock))) {
        await this.ensureControlPlane();
        await this.deleteCommittedBundle(normalized, envelope);
        return null;
      }
      const page = findImagePage(envelope.manifest, pageNumber);
      if (!page) return null;
      let bytes: Uint8Array;
      try {
        this.onRead?.('page');
        bytes = await readBoundedBytes(
          this.pageFile(normalized, page),
          this.limits.maxImageBytes
        );
        assertPageBytes(page, bytes, this.limits);
      } catch (error) {
        throw assetIntegrity('PDF page image failed integrity validation.', error);
      }
      return {
        manifest: cloneManifest(envelope.manifest),
        page: { ...page },
        bytes: Uint8Array.from(bytes),
      };
    });
  }

  async delete(
    identity: PdfAssetIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope, true);
    const identityDigest = createIdentityDigest(normalized);
    return withFileStoreLock(this.identityLockKey(identityDigest), async () => {
      let envelope: StoredPdfAssetManifest | null;
      try {
        envelope = await this.readStoredEnvelope(normalized);
      } catch (error) {
        if (!(error instanceof PdfAssetStoreError)
          || error.code !== 'PDF_ASSET_INTEGRITY') {
          throw error;
        }
        const existed = await pathExists(this.bundleDirectory(normalized));
        if (existed) {
          await this.markRecoveryRequired(createScopeDigest(normalized));
          await this.removeBundle(normalized);
        }
        return existed;
      }
      if (!envelope) {
        await this.removeIncompleteExactBundle(normalized);
        return false;
      }
      await this.ensureControlPlane();
      const expired = isExpired(envelope, readClock(this.clock));
      await this.deleteCommittedBundle(normalized, envelope);
      return !expired;
    });
  }

  async runGarbageCollectionBatch(): Promise<PdfAssetGcResult> {
    return withFileStoreLock(
      this.gcLockKey(),
      async () => this.runGarbageCollectionBatchLocked()
    );
  }

  private async runGarbageCollectionBatchLocked(): Promise<PdfAssetGcResult> {
    await this.ensureControlPlane();
    const startedAt = Date.now();
    const initial = await withFileStoreLock(
      this.controlLockKey(),
      async () => cloneGcCursor((await this.readRootLedger()).gcCursor)
    );
    let cursor = initial;
    let entriesScanned = 0;
    let manifestBytesRead = 0;
    let invalidEntries = 0;
    let shardsScanned = 0;
    let stop = false;

    while (!stop && shardsScanned < 4) {
      if (Date.now() - startedAt >= this.retention.gcMaxDurationMs) break;
      const directory = this.gcShardDirectory(cursor);
      const entries = await listDirectoryEntriesBounded(
        directory,
        this.retention.gcMaxShardEntries,
        kind => this.onIo?.(kind)
      );
      const remaining = entries.filter(entry =>
        cursor.lastName === null || entry.name > cursor.lastName!
      );
      for (const entry of remaining) {
        if (entriesScanned >= this.retention.gcMaxEntries
          || Date.now() - startedAt >= this.retention.gcMaxDurationMs) {
          stop = true;
          break;
        }
        const result = await this.processGcEntry(
          cursor.phase,
          directory,
          entry,
          this.retention.gcMaxBytes - manifestBytesRead
        );
        if (!result.processed) {
          stop = true;
          break;
        }
        manifestBytesRead += result.bytesInspected;
        invalidEntries += result.invalidEntries;
        if (invalidEntries > this.retention.gcMaxInvalidEntries) {
          throw assetGcBudget(
            'PDF asset GC encountered too many invalid shard entries.'
          );
        }
        entriesScanned += 1;
        cursor = { ...cursor, lastName: entry.name };
      }
      if (!stop) {
        cursor = advanceGcCursor(cursor);
        shardsScanned += 1;
      }
    }

    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.readRootLedger();
      root.gcCursor = cloneGcCursor(cursor);
      root.generation += 1;
      await this.writeRootLedger(root);
    });
    return {
      entriesScanned,
      manifestBytesRead,
      invalidEntries,
      cursor: cloneGcCursor(cursor),
    };
  }

  private async processGcEntry(
    phase: GcPhase,
    directory: string,
    entry: BoundedDirectoryEntry,
    remainingBytes: number
  ): Promise<{ processed: boolean; bytesInspected: number; invalidEntries: number }> {
    if (phase === 'bundles') {
      if (!entry.isDirectory || !IDENTITY_DIRECTORY.test(entry.name)) {
        return { processed: true, bytesInspected: 0, invalidEntries: 1 };
      }
      const manifestFile = path.join(directory, entry.name, 'manifest.json');
      const manifestSize = await readFileSize(manifestFile);
      if (manifestSize < 1 || manifestSize > this.limits.maxManifestBytes) {
        return { processed: true, bytesInspected: 0, invalidEntries: 1 };
      }
      if (manifestSize > remainingBytes) {
        return { processed: false, bytesInspected: 0, invalidEntries: 0 };
      }
      let invalidEntries = 0;
      try {
        const envelope = await this.readStoredEnvelopeAt(
          path.join(directory, entry.name)
        );
        if (envelope && isExpired(envelope, readClock(this.clock))) {
          const identity = pdfAssetIdentityFromManifest(envelope.manifest);
          await withFileStoreLock(
            this.identityLockKey(entry.name),
            async () => {
              const current = await this.readStoredEnvelope(identity);
              if (current && isExpired(current, readClock(this.clock))) {
                await this.deleteCommittedBundle(identity, current);
              }
            }
          );
        }
      } catch {
        invalidEntries = 1;
      }
      return { processed: true, bytesInspected: manifestSize, invalidEntries };
    }

    const temporary = entry.isFile ? parseAtomicTempName(entry.name) : null;
    const expectedTemporary = temporary
      && isAtomicTempExpectedForPhase(phase, temporary.baseName);
    if (expectedTemporary) {
      const size = await readFileSize(path.join(directory, entry.name));
      const invalidEntries = size > this.control.maxLedgerBytes ? 1 : 0;
      await this.removeExpiredAtomicTemp(
        phase,
        path.join(directory, entry.name),
        temporary
      );
      return {
        processed: true,
        bytesInspected: 0,
        invalidEntries,
      };
    }

    if (phase === 'reservations' || phase === 'staging') {
      if (!RESERVATION_ID.test(entry.name)) {
        return { processed: true, bytesInspected: 0, invalidEntries: 1 };
      }
      const active = await withFileStoreLock(
        this.controlLockKey(),
        async () => Boolean(
          (await this.readRootLedger()).activeReservations[entry.name]
        )
      );
      if (!active) {
        const target = path.join(directory, entry.name);
        const modifiedAt = await readModifiedTime(target);
        if (readClock(this.clock) - modifiedAt >= this.retention.orphanRetentionMs) {
          await rm(target, { recursive: true, force: true });
        }
      }
      return { processed: true, bytesInspected: 0, invalidEntries: 0 };
    }

    if (phase === 'scope-control' || phase === 'recovery-scope-temps') {
      const match = SCOPE_LEDGER_FILE.exec(entry.name);
      const valid = entry.isFile && match
        && path.basename(directory) === match[1].slice(0, 2);
      return { processed: true, bytesInspected: 0, invalidEntries: valid ? 0 : 1 };
    }

    const knownRootEntry = phase === 'control-root-temps'
      ? ['root-ledger.json', 'root.marker.json', 'reservations', 'scopes',
        'scope-markers', 'recovery'].includes(entry.name)
      : entry.name === 'root.json' || entry.name === 'scopes';
    return {
      processed: true,
      bytesInspected: 0,
      invalidEntries: knownRootEntry ? 0 : 1,
    };
  }

  private async removeExpiredAtomicTemp(
    phase: GcPhase,
    file: string,
    temporary: AtomicTempName
  ): Promise<void> {
    const lock = phase === 'recovery-root-temps'
      || phase === 'recovery-scope-temps'
      ? this.recoveryLockKey()
      : this.controlLockKey();
    await withFileStoreLock(lock, async () => {
      if (phase === 'reservations' && RESERVATION_ID.test(temporary.baseName)) {
        const root = await this.readRootLedger();
        if (root.activeReservations[temporary.baseName]) return;
      }
      const modifiedAt = await readModifiedTime(file);
      const now = readClock(this.clock);
      const createdAt = temporary.createdAtMs !== null
        && temporary.createdAtMs <= now
        ? temporary.createdAtMs
        : modifiedAt;
      const newestEvidence = Math.max(createdAt, modifiedAt);
      if (now - newestEvidence < this.retention.orphanRetentionMs) {
        return;
      }
      await rm(file, { force: true });
    });
  }

  async recoverLedgerBatch(
    scope?: Pick<PdfAssetIdentity, 'tenantId' | 'corpusId'>
  ): Promise<PdfAssetLedgerRecoveryResult> {
    const scopeDigest = scope
      ? createScopeDigest({
        tenantId: scope.tenantId,
        corpusId: scope.corpusId,
        documentId: 'recovery',
        documentVersion: 'recovery',
        trustLevel: 'reviewed',
      })
      : null;
    const target = scopeDigest ? 'scope' : 'root';
    return withFileStoreLock(this.recoveryLockKey(), async () => {
      await mkdir(this.controlDirectory(), { recursive: true });
      await this.prepareLedgerRecovery(target, scopeDigest);
      const recovery = await this.readRecoveryLedger(target, scopeDigest);
      let entriesScanned = 0;
      let shardsScanned = 0;
      const startedAt = Date.now();
      let manifestBytesRead = 0;

      while (
        !isRecoveryScanComplete(recovery)
        && shardsScanned < this.control.recoveryMaxShardsPerBatch
        && entriesScanned < this.retention.gcMaxEntries
        && Date.now() - startedAt < this.retention.gcMaxDurationMs
      ) {
        const directory = this.recoveryShardDirectory(recovery);
        const entries = await listDirectoryEntriesBounded(
          directory,
          this.retention.gcMaxShardEntries,
          kind => this.onIo?.(kind)
        );
        const remaining = entries.filter(entry =>
          recovery.lastName === null || entry.name > recovery.lastName!
        );
        let completedShard = true;
        for (const entry of remaining) {
          if (
            entriesScanned >= this.retention.gcMaxEntries
            || Date.now() - startedAt >= this.retention.gcMaxDurationMs
          ) {
            completedShard = false;
            break;
          }
          if (recovery.phase === 'bundles') {
            if (!entry.isDirectory || !IDENTITY_DIRECTORY.test(entry.name)) {
              throw assetIntegrity(
                'PDF asset ledger recovery encountered invalid bundle debris.'
              );
            }
            const manifestFile = path.join(directory, entry.name, 'manifest.json');
            const manifestSize = await readFileSize(manifestFile);
            if (manifestSize < 1
              || manifestSize > this.limits.maxManifestBytes) {
              throw assetIntegrity(
                'PDF asset ledger recovery encountered an invalid manifest size.'
              );
            }
            if (manifestBytesRead + manifestSize > this.retention.gcMaxBytes) {
              completedShard = false;
              break;
            }
            const envelope = await this.readStoredEnvelopeAt(
              path.join(directory, entry.name)
            );
            if (!envelope) {
              throw assetIntegrity(
                'PDF asset ledger recovery encountered an incomplete bundle.'
              );
            }
            manifestBytesRead += manifestSize;
            if (!scopeDigest || envelope.scopeDigest === scopeDigest) {
              recovery.count += 1;
              recovery.totalBytes += envelope.totalImageBytes + manifestSize;
              if (target === 'root') {
                if (recovery.liveScopeDigests[envelope.scopeDigest] !== true
                  && Object.keys(recovery.liveScopeDigests).length
                    >= this.control.maxScopeLedgers) {
                  throw assetCapacity('PDF asset recovery scope capacity is exhausted.');
                }
                recovery.liveScopeDigests[envelope.scopeDigest] = true;
              }
            }
          } else if (recovery.phase === 'reservations') {
            await this.reconcileRecoveryJournalEntry(
              directory,
              entry,
              target,
              scopeDigest
            );
          } else {
            await this.reconcileRecoveryScopeEntry(directory, entry);
          }
          entriesScanned += 1;
          recovery.lastName = entry.name;
        }
        if (!completedShard) break;
        advanceRecoveryCursor(recovery);
        shardsScanned += 1;
      }

      recovery.generation += 1;
      if (!isRecoveryScanComplete(recovery)) {
        await this.writeRecoveryLedger(recovery);
        return { target, complete: false, shardsScanned, entriesScanned };
      }

      await this.completeLedgerRecovery(recovery);
      await rm(this.recoveryFile(target, scopeDigest), { force: true });
      return { target, complete: true, shardsScanned, entriesScanned };
    });
  }

  private async prepareLedgerRecovery(
    target: 'root' | 'scope',
    scopeDigest: string | null
  ): Promise<void> {
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.tryReadRootLedgerForRecovery();
      if (target === 'root') {
        if (!root) {
          await this.writeControlMarker(this.rootMarkerFile(), 'root');
          return;
        }
        this.assertNoCurrentProcessReservations(
          Object.values(root.activeReservations),
          'root'
        );
        if (!root.recoveryRequired) {
          root.recoveryRequired = true;
          root.generation += 1;
          await this.writeRootLedger(root);
        }
        return;
      }

      const rootReservations = root
        ? Object.values(root.activeReservations).filter(
          reservation => reservation.scopeDigest === scopeDigest
        )
        : [];
      this.assertNoCurrentProcessReservations(rootReservations, 'scope');
      const existingScope = await this.tryReadScopeLedgerForRecovery(scopeDigest!);
      if (!existingScope) {
        await this.writeControlMarker(this.scopeMarkerFile(scopeDigest!), scopeDigest!);
        return;
      }
      this.assertNoCurrentProcessReservations(
        Object.values(existingScope.activeReservations),
        'scope'
      );
      if (!existingScope.recoveryRequired) {
        existingScope.recoveryRequired = true;
        existingScope.generation += 1;
        await this.writeScopeLedger(existingScope);
      }
    });
  }

  private assertNoCurrentProcessReservations(
    reservations: readonly ActiveReservation[],
    target: 'root' | 'scope'
  ): void {
    if (reservations.some(
      reservation => reservation.processEpoch === this.processEpoch
    )) {
      throw assetRecovery(
        `PDF asset ${target} ledger cannot recover a current-process reservation.`
      );
    }
  }

  private recoveryShardDirectory(recovery: RecoveryLedger): string {
    const shard = recovery.shard.toString(16).padStart(2, '0');
    if (recovery.phase === 'bundles') return this.resolvePath(shard);
    if (recovery.phase === 'reservations') {
      return this.resolvePath('.control', 'reservations', shard);
    }
    return this.resolvePath('.control', 'scopes', shard);
  }

  private async reconcileRecoveryJournalEntry(
    directory: string,
    entry: BoundedDirectoryEntry,
    target: 'root' | 'scope',
    scopeDigest: string | null
  ): Promise<void> {
    if (entry.isFile && isReservationTemporaryFile(entry.name)) {
      if (target === 'root') {
        await rm(path.join(directory, entry.name), { force: true });
      }
      return;
    }
    if (!entry.isFile || !RESERVATION_ID.test(entry.name)) {
      throw assetIntegrity(
        'PDF asset ledger recovery encountered invalid reservation debris.'
      );
    }
    const journalFile = path.join(directory, entry.name);
    let value: unknown;
    try {
      this.onIo?.('reservation-read');
      value = await readBoundedJson(journalFile, this.control.maxLedgerBytes);
      assertReservationJournal(value, entry.name);
    } catch (error) {
      throw assetIntegrity(
        'PDF asset ledger recovery encountered an invalid reservation journal.',
        error
      );
    }
    const journal = value as ReservationJournal;
    const reservation = journal.reservation;
    if (target === 'scope' && reservation.scopeDigest !== scopeDigest) return;
    this.assertNoCurrentProcessReservations([reservation], target);
    const settlement = await this.resolveRecoverySettlement(reservation);
    let scopeSettlementPersisted = false;
    if (target === 'root') {
      scopeSettlementPersisted = await this.settleRecoveredScopeReservation(
        reservation,
        settlement,
        journal.state
      );
    } else {
      await this.settleRecoveredRootReservation(reservation, settlement);
    }

    await rm(journalFile, { force: true });
    await rm(this.stagingDirectory(reservation), {
      recursive: true,
      force: true,
    });
    if (scopeSettlementPersisted) {
      await this.clearRecoveredScopeSettlement(reservation, settlement);
    }
  }

  private async resolveRecoverySettlement(
    reservation: ActiveReservation
  ): Promise<LedgerSettlement> {
    const envelope = await this.readStoredEnvelopeAt(
      this.bundleDirectoryFromDigest(reservation.identityDigest)
    );
    if (reservation.operation === 'put') {
      return envelope?.publicationDigest === reservation.publicationDigest
        ? 'commit'
        : 'release';
    }
    return envelope ? 'release' : 'commit';
  }

  private async settleRecoveredScopeReservation(
    reservation: ActiveReservation,
    settlement: LedgerSettlement,
    journalState: ReservationJournal['state']
  ): Promise<boolean> {
    return withFileStoreLock(this.controlLockKey(), async () => {
      const scope = await this.tryReadScopeLedgerForRecovery(
        reservation.scopeDigest
      );
      // A root-settled journal is written only after the root reservation is
      // durably removed. The zero scope may then be reclaimed before a later
      // root-ledger rebuild sees this journal. Absence is safe only when the
      // durable bundle state proves the operation left no committed asset;
      // otherwise a missing scope ledger could hide live capacity.
      const settlementLeavesNoBundle =
        (reservation.operation === 'put' && settlement === 'release') ||
        (reservation.operation === 'delete' && settlement === 'commit');
      if (
        !scope &&
        journalState === 'root-settled' &&
        settlementLeavesNoBundle
      ) {
        return false;
      }
      if (!scope || scope.recoveryRequired) {
        throw assetRecovery(
          'PDF asset root recovery requires explicit recovery of a damaged scope ledger.'
        );
      }
      const hasActive = Boolean(
        scope.activeReservations[reservation.reservationId]
      );
      const hasSettlement = Boolean(
        scope.settledReservations[reservation.reservationId]
      );
      if (!hasActive && !hasSettlement && journalState === 'root-settled') {
        return false;
      }
      settleScopeReservation(scope, reservation, settlement);
      scope.generation += 1;
      await this.writeScopeLedger(scope);
      return true;
    });
  }

  private async clearRecoveredScopeSettlement(
    reservation: ActiveReservation,
    settlement: LedgerSettlement
  ): Promise<void> {
    await withFileStoreLock(this.controlLockKey(), async () => {
      const scope = await this.tryReadScopeLedgerForRecovery(
        reservation.scopeDigest
      );
      if (!scope || scope.recoveryRequired) {
        throw assetRecovery(
          'PDF asset recovery lost its repaired scope ledger.'
        );
      }
      const recorded = scope.settledReservations[reservation.reservationId];
      if (recorded === undefined) return;
      if (recorded !== settlement) {
        throw assetIntegrity(
          'PDF asset recovery observed a conflicting scope settlement.'
        );
      }
      delete scope.settledReservations[reservation.reservationId];
      scope.generation += 1;
      await this.writeScopeLedger(scope);
    });
  }

  private async settleRecoveredRootReservation(
    reservation: ActiveReservation,
    settlement: LedgerSettlement
  ): Promise<void> {
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.tryReadRootLedgerForRecovery();
      if (!root || root.recoveryRequired) return;
      const active = root.activeReservations[reservation.reservationId];
      if (!active) return;
      this.assertNoCurrentProcessReservations([active], 'scope');
      settleRootReservation(root, reservation, settlement);
      root.generation += 1;
      await this.writeRootLedger(root);
    });
  }

  private async reconcileRecoveryScopeEntry(
    directory: string,
    entry: BoundedDirectoryEntry
  ): Promise<void> {
    const temporary = parseAtomicTempName(entry.name);
    const temporaryScopeMatch = temporary
      ? SCOPE_LEDGER_FILE.exec(temporary.baseName)
      : null;
    if (entry.isFile && temporaryScopeMatch
      && path.basename(directory) === temporaryScopeMatch[1].slice(0, 2)) {
      await rm(path.join(directory, entry.name), { force: true });
      return;
    }
    const match = SCOPE_LEDGER_FILE.exec(entry.name);
    if (!entry.isFile || !match || path.basename(directory) !== match[1].slice(0, 2)) {
      throw assetIntegrity(
        'PDF asset root recovery encountered invalid scope-ledger debris.'
      );
    }
    const scopeDigest = match[1];
    let scope: ScopeLedger;
    try {
      const value = await readBoundedJson(
        path.join(directory, entry.name),
        this.control.maxLedgerBytes
      );
      assertScopeLedger(value, scopeDigest, this.control);
      scope = cloneScopeLedger(value);
    } catch (error) {
      throw assetRecovery(
        'PDF asset root recovery requires explicit recovery of a scope ledger.',
        error
      );
    }
    if (scope.recoveryRequired) {
      throw assetRecovery(
        'PDF asset root recovery requires explicit recovery of a scope ledger.'
      );
    }
    const reservations = Object.values(scope.activeReservations);
    this.assertNoCurrentProcessReservations(reservations, 'scope');
    const identities = new Set<string>();
    for (const reservation of reservations) {
      if (identities.has(reservation.identityDigest)) {
        throw assetRecovery(
          'PDF asset scope contains ambiguous duplicate identity reservations.'
        );
      }
      identities.add(reservation.identityDigest);
      const settlement = await this.resolveRecoverySettlement(reservation);
      settleScopeReservation(scope, reservation, settlement);
    }
    const changed = reservations.length > 0
      || Object.keys(scope.settledReservations).length > 0;
    if (changed) {
      scope.settledReservations = {};
      scope.generation += 1;
      await withFileStoreLock(this.controlLockKey(), async () => {
        await this.writeScopeLedger(scope);
      });
    }
    if (isScopeReadyForReclaim(scope)) {
      await rm(this.scopeMarkerFile(scopeDigest), { force: true });
      await rm(path.join(directory, entry.name), { force: true });
      return;
    }
    await this.writeControlMarker(
      this.scopeMarkerFile(scopeDigest),
      scopeDigest
    );
  }

  private async completeLedgerRecovery(
    recovery: RecoveryLedger
  ): Promise<void> {
    if (recovery.target === 'root') {
      await this.assertRootRecoveryScopesSettled();
      await withFileStoreLock(this.controlLockKey(), async () => {
        await this.writeControlMarker(this.rootMarkerFile(), 'root');
        await this.writeRootLedger(
          createRootLedger(
            recovery.count,
            recovery.totalBytes,
            Object.fromEntries(
              Object.keys(recovery.liveScopeDigests).map(digest => [digest, 'active'])
            )
          )
        );
      });
      return;
    }

    const scopeDigest = recovery.scopeDigest!;
    const rootSnapshot = await this.tryReadRootLedgerForRecovery();
    const rootReservations = rootSnapshot
      ? Object.values(rootSnapshot.activeReservations).filter(
        reservation => reservation.scopeDigest === scopeDigest
      )
      : [];
    this.assertNoCurrentProcessReservations(rootReservations, 'scope');
    const settlements: Array<{
      reservation: ActiveReservation;
      settlement: LedgerSettlement;
    }> = [];
    for (const reservation of rootReservations) {
      settlements.push({
        reservation,
        settlement: await this.resolveRecoverySettlement(reservation),
      });
    }
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.tryReadRootLedgerForRecovery();
      let reclaimWithoutHealthyRoot = false;
      if (root && !root.recoveryRequired) {
        for (const { reservation, settlement } of settlements) {
          settleRootReservation(root, reservation, settlement);
        }
        root.scopeLifecycles[scopeDigest] = recovery.count === 0
          ? 'reclaiming'
          : 'active';
        root.generation += 1;
        await this.writeRootLedger(root);
      } else if (recovery.count === 0) {
        reclaimWithoutHealthyRoot = true;
      }
      await this.writeControlMarker(
        this.scopeMarkerFile(scopeDigest),
        scopeDigest
      );
      await this.writeScopeLedger(
        createScopeLedger(scopeDigest, recovery.count, recovery.totalBytes)
      );
      if (root && !root.recoveryRequired && recovery.count === 0) {
        await this.reclaimScopeLifecycle(root, scopeDigest);
      } else if (reclaimWithoutHealthyRoot) {
        await rm(this.scopeMarkerFile(scopeDigest), { force: true });
        await rm(this.scopeLedgerFile(scopeDigest), { force: true });
      }
    });
    for (const { reservation } of settlements) {
      await rm(this.reservationFile(reservation.reservationId), { force: true });
      await rm(this.stagingDirectory(reservation), {
        recursive: true,
        force: true,
      });
    }
  }

  private async assertRootRecoveryScopesSettled(): Promise<void> {
    const root = await this.tryReadRootLedgerForRecovery();
    if (!root) return;
    this.assertNoCurrentProcessReservations(
      Object.values(root.activeReservations),
      'root'
    );
    for (const reservation of Object.values(root.activeReservations)) {
      const scope = await this.tryReadScopeLedgerForRecovery(
        reservation.scopeDigest
      );
      if (!scope || scope.recoveryRequired
        || scope.activeReservations[reservation.reservationId]) {
        throw assetRecovery(
          'PDF asset root recovery could not prove scope reservation settlement.'
        );
      }
    }
  }

  private async tryReadRootLedgerForRecovery(): Promise<RootLedger | null> {
    try {
      return await this.readRootLedger();
    } catch (error) {
      if (isRecoverableLedgerReadFailure(error)) return null;
      throw error;
    }
  }

  private async tryReadScopeLedgerForRecovery(
    scopeDigest: string
  ): Promise<ScopeLedger | null> {
    try {
      return await this.tryReadScopeLedger(scopeDigest);
    } catch (error) {
      if (isRecoverableLedgerReadFailure(error)) return null;
      throw error;
    }
  }

  private async ensureControlPlane(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.loadOrCreateRootLedger();
      await this.reconcileStaleReservations(root);
      await this.reconcileReclaimingScopes(root);
    });
  }

  private async beginReservation(
    reservation: ActiveReservation
  ): Promise<void> {
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.readRootLedger();
      if (root.recoveryRequired) {
        throw assetRecovery('PDF asset root ledger requires explicit recovery.');
      }
      if (
        Object.keys(root.activeReservations).length
        >= this.control.maxInflightReservations
      ) {
        throw assetCapacity('PDF asset in-flight reservation capacity is exhausted.');
      }
      let scope = await this.tryReadScopeLedger(reservation.scopeDigest);
      const createsScope = scope === null;
      if (scope) {
        if (root.scopeLifecycles[reservation.scopeDigest] !== 'active') {
          throw assetRecovery(
            'PDF asset scope ledger is not registered as an active scope.'
          );
        }
        if (!(await pathExists(this.scopeMarkerFile(reservation.scopeDigest)))) {
          throw assetRecovery(
            'PDF asset scope marker is missing for an active scope ledger.'
          );
        }
        if (scope.recoveryRequired) {
          throw assetRecovery('PDF asset scope ledger requires explicit recovery.');
        }
        pruneSettledReservations(scope, root);
      } else {
        if (root.scopeLifecycles[reservation.scopeDigest] !== undefined
          || await pathExists(this.scopeMarkerFile(reservation.scopeDigest))) {
          throw assetRecovery(
            'PDF asset scope ledger is missing while persistent scope state exists.'
          );
        }
        if (Object.keys(root.scopeLifecycles).length
          >= this.control.maxScopeLedgers) {
          throw assetCapacity('PDF asset scope-ledger capacity is exhausted.');
        }
        scope = createScopeLedger(reservation.scopeDigest);
      }
      if (reservation.operation === 'put') {
        assertLedgerCapacity(root, scope, reservation, this.limits);
      }
      // The signed prepared journal is the creation WAL. It must exist before
      // a new scope consumes a persistent registry slot.
      await this.writeReservationJournal({
        schemaVersion: RESERVATION_SCHEMA_VERSION,
        generation: 0,
        reservation,
        state: 'prepared',
        digest: '',
      });
      await this.emitPublicationPhase(
        'reservation-journal-written',
        reservation.reservationId
      );

      if (createsScope) {
        root.scopeLifecycles[reservation.scopeDigest] = 'creating';
      }
      root.activeReservations[reservation.reservationId] = reservation;
      if (reservation.operation === 'put') {
        root.reservedCount += 1;
        root.reservedBytes += reservation.reservedBytes;
      }
      root.generation += 1;
      await this.writeRootLedger(root);
      await this.emitPublicationPhase('root-reserved', reservation.reservationId);

      if (createsScope) {
        await this.writeControlMarker(
          this.scopeMarkerFile(reservation.scopeDigest), reservation.scopeDigest
        );
      }
      scope.activeReservations[reservation.reservationId] = reservation;
      if (reservation.operation === 'put') {
        scope.reservedCount += 1;
        scope.reservedBytes += reservation.reservedBytes;
      }
      scope.generation += 1;
      await this.writeScopeLedger(scope);
      if (createsScope) {
        root.scopeLifecycles[reservation.scopeDigest] = 'active';
        root.generation += 1;
        await this.writeRootLedger(root);
      }
      await this.updateReservationJournal(reservation, 'reserved');
      await this.emitPublicationPhase('scope-reserved', reservation.reservationId);
    });
  }

  private async hasActiveRootReservation(
    reservationId: string
  ): Promise<boolean> {
    return withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.readRootLedger();
      return Boolean(root.activeReservations[reservationId]);
    });
  }

  private async settleReservation(
    reservation: ActiveReservation,
    settlement: LedgerSettlement
  ): Promise<void> {
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.readRootLedger();
      const scope = await this.loadOrCreateScopeLedger(
        reservation.scopeDigest,
        root
      );
      settleScopeReservation(scope, reservation, settlement);
      scope.generation += 1;
      await this.writeScopeLedger(scope);
      await this.updateReservationJournal(reservation, 'scope-settled');
      if (settlement === 'commit' && reservation.operation === 'put') {
        await this.emitPublicationPhase(
          'scope-committed',
          reservation.reservationId
        );
      }

      settleRootReservation(root, reservation, settlement);
      if (isScopeReadyForReclaim(scope)) {
        root.scopeLifecycles[reservation.scopeDigest] = 'reclaiming';
      }
      root.generation += 1;
      await this.writeRootLedger(root);
      await this.updateReservationJournal(reservation, 'root-settled');
      if (settlement === 'commit' && reservation.operation === 'put') {
        await this.emitPublicationPhase(
          'root-committed',
          reservation.reservationId
        );
      }

      delete scope.settledReservations[reservation.reservationId];
      scope.generation += 1;
      await this.writeScopeLedger(scope);
      await this.reclaimScopeLifecycle(root, reservation.scopeDigest);
    });
    await rm(this.reservationFile(reservation.reservationId), { force: true });
  }

  private async reconcileReservation(
    reservation: ActiveReservation
  ): Promise<void> {
    const envelope = await this.readStoredEnvelopeAt(
      this.bundleDirectoryFromDigest(reservation.identityDigest)
    );
    const shouldCommit = reservation.operation === 'put'
      ? envelope?.publicationDigest === reservation.publicationDigest
      : envelope === null;
    await this.settleReservation(
      reservation,
      shouldCommit ? 'commit' : 'release'
    );
  }

  private async reconcileStaleReservations(root: RootLedger): Promise<void> {
    const stale = Object.values(root.activeReservations).filter(
      reservation => reservation.processEpoch !== this.processEpoch
    );
    for (const reservation of stale) {
      const scope = await this.loadOrCreateScopeLedger(
        reservation.scopeDigest,
        root
      );
      const envelope = await this.readStoredEnvelopeAt(
        this.bundleDirectoryFromDigest(reservation.identityDigest)
      );
      const settlement: LedgerSettlement = reservation.operation === 'put'
        ? (
          envelope?.publicationDigest === reservation.publicationDigest
            ? 'commit'
            : 'release'
        )
        : (envelope ? 'release' : 'commit');
      settleScopeReservation(scope, reservation, settlement);
      scope.generation += 1;
      await this.writeScopeLedger(scope);
      settleRootReservation(root, reservation, settlement);
      if (isScopeReadyForReclaim(scope)) {
        root.scopeLifecycles[reservation.scopeDigest] = 'reclaiming';
      }
      root.generation += 1;
      await this.writeRootLedger(root);
      delete scope.settledReservations[reservation.reservationId];
      scope.generation += 1;
      await this.writeScopeLedger(scope);
      await this.reclaimScopeLifecycle(root, reservation.scopeDigest);
      await rm(this.reservationFile(reservation.reservationId), { force: true });
      await rm(this.stagingDirectory(reservation), {
        recursive: true,
        force: true,
      });
    }
  }

  private async deleteCommittedBundle(
    identity: PdfAssetIdentity,
    envelope: StoredPdfAssetManifest
  ): Promise<void> {
    const manifestSize = await readFileSize(
      path.join(this.bundleDirectory(identity), 'manifest.json')
    );
    if (manifestSize < 1) {
      throw assetIntegrity('PDF asset bundle manifest disappeared during deletion.');
    }
    const now = readClock(this.clock);
    const reservation: ActiveReservation = {
      reservationId: randomUUID(),
      operation: 'delete',
      identityDigest: createIdentityDigest(identity),
      scopeDigest: envelope.scopeDigest,
      publicationDigest: envelope.publicationDigest,
      processEpoch: this.processEpoch,
      createdAtMs: now,
      committedBytes: envelope.totalImageBytes + manifestSize,
      reservedBytes: 0,
    };
    await this.beginReservation(reservation);
    let simulatedCrash = false;
    try {
      await this.removeBundle(identity);
      await this.settleReservation(reservation, 'commit');
    } catch (error) {
      simulatedCrash = isSimulatedHardCrash(error);
      if (!simulatedCrash) await this.reconcileReservation(reservation);
      throw error;
    } finally {
      if (!simulatedCrash) {
        await rm(this.reservationFile(reservation.reservationId), { force: true });
      }
    }
  }

  private async markRecoveryRequired(scopeDigest: string): Promise<void> {
    await this.ensureControlPlane();
    await withFileStoreLock(this.controlLockKey(), async () => {
      const root = await this.readRootLedger();
      root.recoveryRequired = true;
      root.generation += 1;
      await this.writeRootLedger(root);
      try {
        const scope = await this.loadOrCreateScopeLedger(scopeDigest, root);
        scope.recoveryRequired = true;
        scope.generation += 1;
        await this.writeScopeLedger(scope);
      } catch {
        // The root flag is sufficient to keep all future mutations fail closed.
      }
    });
  }

  private async loadOrCreateRootLedger(): Promise<RootLedger> {
    const existing = await this.tryReadRootLedger();
    if (existing) {
      if (existing.recoveryRequired) {
        throw assetRecovery('PDF asset root ledger requires explicit recovery.');
      }
      return existing;
    }
    if (await pathExists(this.rootMarkerFile())
      || await this.rootContainsUnaccountedData()) {
      throw assetRecovery(
        'PDF asset root ledger is missing while stored data exists.'
      );
    }
    await this.writeControlMarker(this.rootMarkerFile(), 'root');
    const created = createRootLedger();
    await this.writeRootLedger(created);
    return created;
  }

  private async loadOrCreateScopeLedger(
    scopeDigest: string,
    root: RootLedger
  ): Promise<ScopeLedger> {
    const existing = await this.tryReadScopeLedger(scopeDigest);
    if (existing) {
      const lifecycle = root.scopeLifecycles[scopeDigest];
      if (lifecycle !== 'active' && lifecycle !== 'creating') {
        throw assetRecovery(
          'PDF asset scope ledger is not registered as an active scope.'
        );
      }
      if (lifecycle === 'creating'
        && !Object.values(root.activeReservations).some(
          reservation => reservation.scopeDigest === scopeDigest
        )) {
        throw assetRecovery(
          'PDF asset creating scope lost its root reservation.'
        );
      }
      if (!(await pathExists(this.scopeMarkerFile(scopeDigest)))) {
        throw assetRecovery(
          'PDF asset scope marker is missing for a registered scope ledger.'
        );
      }
      pruneSettledReservations(existing, root);
      return existing;
    }
    if (root.scopeLifecycles[scopeDigest] === 'creating') {
      const creatingReservations = Object.values(root.activeReservations).filter(
        reservation => reservation.scopeDigest === scopeDigest
          && reservation.operation === 'put'
      );
      if (creatingReservations.length !== 1) {
        throw assetRecovery(
          'PDF asset creating scope lost its unique root reservation.'
        );
      }
      await this.writeControlMarker(this.scopeMarkerFile(scopeDigest), scopeDigest);
      const created = createScopeLedger(scopeDigest);
      await this.writeScopeLedger(created);
      return created;
    }
    if (root.scopeLifecycles[scopeDigest] !== undefined
      || await pathExists(this.scopeMarkerFile(scopeDigest))) {
      throw assetRecovery(
        'PDF asset scope ledger is missing while persistent scope state exists.'
      );
    }
    if (Object.keys(root.scopeLifecycles).length >= this.control.maxScopeLedgers) {
      throw assetCapacity('PDF asset scope-ledger capacity is exhausted.');
    }
    root.scopeLifecycles[scopeDigest] = 'active';
    root.generation += 1;
    await this.writeRootLedger(root);
    await this.writeControlMarker(this.scopeMarkerFile(scopeDigest), scopeDigest);
    const created = createScopeLedger(scopeDigest);
    await this.writeScopeLedger(created);
    return created;
  }

  private async reconcileReclaimingScopes(root: RootLedger): Promise<void> {
    for (const [scopeDigest, lifecycle] of Object.entries(root.scopeLifecycles)) {
      if (lifecycle !== 'reclaiming') continue;
      await this.reclaimScopeLifecycle(root, scopeDigest);
    }
  }

  private async reclaimScopeLifecycle(
    root: RootLedger,
    scopeDigest: string
  ): Promise<void> {
    if (root.scopeLifecycles[scopeDigest] !== 'reclaiming') return;
    if (Object.values(root.activeReservations).some(
      reservation => reservation.scopeDigest === scopeDigest
    )) {
      throw assetRecovery(
        'PDF asset scope reclamation encountered an active root reservation.'
      );
    }
    const scope = await this.tryReadScopeLedgerForRecovery(scopeDigest);
    if (scope && !isScopeReadyForReclaim(scope)) {
      throw assetRecovery(
        'PDF asset scope reclamation encountered non-empty scope state.'
      );
    }
    // Root `reclaiming` is the durable transaction fence. Marker-first removal
    // keeps a surviving ledger discoverable by explicit root recovery.
    await rm(this.scopeMarkerFile(scopeDigest), { force: true });
    await rm(this.scopeLedgerFile(scopeDigest), { force: true });
    delete root.scopeLifecycles[scopeDigest];
    root.generation += 1;
    await this.writeRootLedger(root);
  }

  private async rootContainsUnaccountedData(): Promise<boolean> {
    try {
      const directory = await opendir(this.rootDir);
      try {
        for await (const entry of directory) {
          this.onIo?.('directory-entry');
          if (entry.name !== '.control') return true;
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      return false;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  private async tryReadRootLedger(): Promise<RootLedger | null> {
    try {
      return await this.readRootLedger();
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof PdfAssetStoreError
        && error.code === 'PDF_ASSET_RECOVERY_REQUIRED') {
        throw error;
      }
      throw assetRecovery(
        'PDF asset root ledger failed integrity validation.',
        error
      );
    }
  }

  private async readRootLedger(): Promise<RootLedger> {
    try {
      this.onIo?.('root-ledger-read');
      const value = await readBoundedJson(
        this.rootLedgerFile(),
        this.control.maxLedgerBytes
      );
      assertRootLedger(value, this.control);
      return cloneRootLedger(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw error;
      if (error instanceof PdfAssetStoreError) throw error;
      throw assetIntegrity('PDF asset root ledger is invalid.', error);
    }
  }

  private async tryReadScopeLedger(
    scopeDigest: string
  ): Promise<ScopeLedger | null> {
    try {
      this.onIo?.('scope-ledger-read');
      const value = await readBoundedJson(
        this.scopeLedgerFile(scopeDigest),
        this.control.maxLedgerBytes
      );
      assertScopeLedger(value, scopeDigest, this.control);
      return cloneScopeLedger(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw assetRecovery(
        'PDF asset scope ledger failed integrity validation.',
        error
      );
    }
  }

  private async writeRootLedger(ledger: RootLedger): Promise<void> {
    await writeAtomicJson(
      this.rootLedgerFile(),
      signRootLedger(ledger),
      this.control.maxLedgerBytes
    );
  }

  private async writeScopeLedger(ledger: ScopeLedger): Promise<void> {
    await writeAtomicJson(
      this.scopeLedgerFile(ledger.scopeDigest),
      signScopeLedger(ledger),
      this.control.maxLedgerBytes
    );
  }

  private async writeReservationJournal(
    journal: ReservationJournal
  ): Promise<void> {
    await writeAtomicJson(
      this.reservationFile(journal.reservation.reservationId),
      signReservationJournal(journal),
      this.control.maxLedgerBytes
    );
  }

  private async updateReservationJournal(
    reservation: ActiveReservation,
    state: ReservationJournal['state']
  ): Promise<void> {
    let generation = 0;
    try {
      this.onIo?.('reservation-read');
      const current = await readBoundedJson(
        this.reservationFile(reservation.reservationId),
        this.control.maxLedgerBytes
      );
      assertReservationJournal(current, reservation.reservationId);
      generation = current.generation + 1;
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
    }
    await this.writeReservationJournal({
      schemaVersion: RESERVATION_SCHEMA_VERSION,
      generation,
      reservation,
      state,
      digest: '',
    });
  }

  private async readRecoveryLedger(
    target: 'root' | 'scope',
    scopeDigest: string | null
  ): Promise<RecoveryLedger> {
    try {
      const value = await readBoundedJson(
        this.recoveryFile(target, scopeDigest),
        this.control.maxLedgerBytes
      );
      assertRecoveryLedger(value, target, scopeDigest, this.control);
      return { ...value };
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        throw assetIntegrity('PDF asset recovery cursor is invalid.', error);
      }
      return createRecoveryLedger(target, scopeDigest);
    }
  }

  private async writeRecoveryLedger(ledger: RecoveryLedger): Promise<void> {
    await writeAtomicJson(
      this.recoveryFile(ledger.target, ledger.scopeDigest),
      signRecoveryLedger(ledger),
      this.control.maxLedgerBytes
    );
  }

  private async writeControlMarker(
    file: string,
    identity: string
  ): Promise<void> {
    if (await pathExists(file)) return;
    const marker = {
      schemaVersion: CONTROL_MARKER_SCHEMA_VERSION,
      identity,
      digest: sha256Hex(stableStringify({
        schemaVersion: CONTROL_MARKER_SCHEMA_VERSION,
        identity,
      })),
    };
    try {
      await writeAtomicJson(file, marker, this.control.maxLedgerBytes, false);
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'EEXIST')) throw error;
    }
  }

  private async readStoredEnvelope(
    identity: PdfAssetIdentity,
    observeRead = false
  ): Promise<StoredPdfAssetManifest | null> {
    return this.readStoredEnvelopeAt(
      this.bundleDirectory(identity),
      identity,
      observeRead
    );
  }

  private async readStoredEnvelopeAt(
    bundleDirectory: string,
    expectedIdentity?: PdfAssetIdentity,
    observeRead = false
  ): Promise<StoredPdfAssetManifest | null> {
    try {
      if (observeRead) this.onRead?.('manifest');
      this.onIo?.('manifest-read');
      const serialized = await readBoundedBytes(
        path.join(bundleDirectory, 'manifest.json'),
        this.limits.maxManifestBytes
      );
      const envelope = JSON.parse(Buffer.from(serialized).toString('utf8')) as unknown;
      const identity = expectedIdentity ?? identityFromUnknownEnvelope(envelope);
      assertStoredEnvelope(envelope, identity, this.limits);
      if (path.basename(bundleDirectory) !== createIdentityDigest(identity)) {
        throw assetIntegrity('PDF asset bundle path does not match its exact identity.');
      }
      return cloneEnvelope(envelope);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (error instanceof PdfAssetStoreError) throw error;
      throw assetIntegrity('PDF asset manifest failed integrity validation.', error);
    }
  }

  private async removeIncompleteExactBundle(
    identity: PdfAssetIdentity
  ): Promise<void> {
    const directory = this.bundleDirectory(identity);
    const envelope = await this.readStoredEnvelope(identity);
    if (!envelope && await pathExists(directory)) {
      await this.markRecoveryRequired(createScopeDigest(identity));
      throw assetRecovery(
        'PDF asset final bundle exists without its immutable manifest; '
        + 'explicit ledger recovery is required.'
      );
    }
  }

  private async removeBundle(identity: PdfAssetIdentity): Promise<void> {
    await rm(this.bundleDirectory(identity), { recursive: true, force: true });
  }

  private async emitPublicationPhase(
    phase: PdfAssetPublicationPhase,
    reservationId: string
  ): Promise<void> {
    await this.onPublicationPhase?.(phase, reservationId);
  }

  private gcShardDirectory(cursor: PdfAssetGcCursor): string {
    const shard = cursor.shard.toString(16).padStart(2, '0');
    if (cursor.phase === 'bundles') return this.resolvePath(shard);
    if (cursor.phase === 'reservations') {
      return this.resolvePath('.control', 'reservations', shard);
    }
    if (cursor.phase === 'staging') return this.resolvePath('.staging', shard);
    if (cursor.phase === 'scope-control') {
      return this.resolvePath('.control', 'scopes', shard);
    }
    if (cursor.phase === 'control-root-temps') {
      return this.resolvePath('.control');
    }
    if (cursor.phase === 'recovery-root-temps') {
      return this.resolvePath('.control', 'recovery');
    }
    return this.resolvePath('.control', 'recovery', 'scopes', shard);
  }

  private stagingDirectory(reservation: ActiveReservation): string {
    return this.resolvePath(
      '.staging',
      reservation.reservationId.slice(0, 2),
      reservation.reservationId
    );
  }

  private reservationFile(reservationId: string): string {
    return this.resolvePath(
      '.control',
      'reservations',
      reservationId.slice(0, 2),
      reservationId
    );
  }

  private rootLedgerFile(): string {
    return this.resolvePath('.control', 'root-ledger.json');
  }

  private rootMarkerFile(): string {
    return this.resolvePath('.control', 'root.marker.json');
  }

  private scopeLedgerFile(scopeDigest: string): string {
    return this.resolvePath(
      '.control',
      'scopes',
      scopeDigest.slice(0, 2),
      scopeDigest + '.json'
    );
  }

  private scopeMarkerFile(scopeDigest: string): string {
    return this.resolvePath(
      '.control',
      'scope-markers',
      scopeDigest.slice(0, 2),
      scopeDigest + '.json'
    );
  }

  private recoveryFile(
    target: 'root' | 'scope',
    scopeDigest: string | null
  ): string {
    return target === 'root'
      ? this.resolvePath('.control', 'recovery', 'root.json')
      : this.resolvePath(
        '.control',
        'recovery',
        'scopes',
        scopeDigest!.slice(0, 2),
        scopeDigest! + '.json'
      );
  }

  private controlDirectory(): string {
    return this.resolvePath('.control');
  }

  private bundleDirectory(identity: PdfAssetIdentity): string {
    return this.bundleDirectoryFromDigest(createIdentityDigest(identity));
  }

  private bundleDirectoryFromDigest(identityDigest: string): string {
    return this.resolvePath(identityDigest.slice(0, 2), identityDigest);
  }

  private pageFile(
    identity: PdfAssetIdentity,
    page: PdfAssetImageManifestPage
  ): string {
    return this.pageFileWithin(this.bundleDirectory(identity), page);
  }

  private pageFileWithin(
    directory: string,
    page: PdfAssetImageManifestPage
  ): string {
    const refDigest = sha256Hex(page.imageRef);
    const pageName = String(page.pageNumber).padStart(4, '0')
      + '-' + refDigest + '.bin';
    const candidate = path.resolve(directory, 'pages', pageName);
    assertPathWithinRoot(this.rootDir, candidate);
    return candidate;
  }

  private controlLockKey(): string {
    return this.rootDir + ':control';
  }

  private gcLockKey(): string {
    return this.rootDir + ':gc';
  }

  private identityLockKey(identityDigest: string): string {
    return this.rootDir + ':identity:' + identityDigest;
  }

  private recoveryLockKey(): string {
    return this.rootDir + ':recovery';
  }

  private resolvePath(...segments: string[]): string {
    const candidate = path.resolve(this.rootDir, ...segments);
    assertPathWithinRoot(this.rootDir, candidate);
    return candidate;
  }
}
function normalizePublication(
  publication: PdfAssetPublication,
  limits: PdfAssetStoreLimits
): NormalizedPublication {
  if (!publication || typeof publication !== 'object') {
    throw new Error('PDF asset publication must be an object.');
  }
  assertPdfAssetManifestIntegrity(publication.manifest);
  assertManifestLimits(publication.manifest, limits);
  const manifest = cloneManifest(publication.manifest);
  const identity = pdfAssetIdentityFromManifest(manifest);
  const imagePages = getImagePages(manifest);
  const pages = new Map<number, { page: PdfAssetImageManifestPage; bytes: Uint8Array }>();
  if (!Array.isArray(publication.pageImages)) {
    throw new Error('PDF asset publication pageImages must be an array.');
  }
  for (const input of publication.pageImages) {
    assertPageNumber(input?.pageNumber);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error('PDF page image bytes must be a Uint8Array.');
    }
    if (pages.has(input.pageNumber)) {
      throw new Error('PDF asset publication contains a duplicate page image.');
    }
    const page = imagePages.find(candidate => candidate.pageNumber === input.pageNumber);
    if (!page) {
      throw new Error('PDF asset publication contains an unreferenced page image.');
    }
    const bytes = Uint8Array.from(input.bytes);
    assertPageBytes(page, bytes, limits);
    pages.set(input.pageNumber, { page, bytes });
  }
  if (pages.size !== imagePages.length) {
    throw new Error('PDF asset publication is missing a referenced page image.');
  }
  const totalImageBytes = [...pages.values()].reduce(
    (total, value) => total + value.bytes.byteLength,
    0
  );
  if (totalImageBytes > limits.maxTotalImageBytes) {
    throw new Error('PDF asset publication exceeds the configured total byte limit.');
  }
  return {
    identity,
    manifest,
    publicationDigest: createPublicationDigest(manifest),
    totalImageBytes,
    pages,
  };
}

function createStoredEnvelope(
  publication: NormalizedPublication,
  now: number,
  retentionMs: number
): StoredPdfAssetManifest {
  const envelope = {
    schemaVersion: PDF_ASSET_STORE_SCHEMA_VERSION,
    publicationDigest: publication.publicationDigest,
    scopeDigest: createScopeDigest(publication.identity),
    totalImageBytes: publication.totalImageBytes,
    publishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + retentionMs).toISOString(),
    manifest: cloneManifest(publication.manifest),
  };
  return {
    ...envelope,
    envelopeDigest: createEnvelopeDigest(envelope),
  };
}

function assertStoredEnvelope(
  value: unknown,
  expectedIdentity: PdfAssetIdentity,
  limits: PdfAssetStoreLimits
): asserts value is StoredPdfAssetManifest {
  if (!isRecord(value) || value.schemaVersion !== PDF_ASSET_STORE_SCHEMA_VERSION) {
    throw assetIntegrity('PDF asset store manifest schema is unsupported.');
  }
  if (typeof value.publicationDigest !== 'string' || !SHA256_HEX.test(value.publicationDigest)) {
    throw assetIntegrity('PDF asset store publication digest is invalid.');
  }
  if (typeof value.envelopeDigest !== 'string' || !SHA256_HEX.test(value.envelopeDigest)) {
    throw assetIntegrity('PDF asset store envelope digest is invalid.');
  }
  if (typeof value.scopeDigest !== 'string' || !SHA256_HEX.test(value.scopeDigest)) {
    throw assetIntegrity('PDF asset store scope digest is invalid.');
  }
  if (typeof value.totalImageBytes !== 'number'
    || !Number.isSafeInteger(value.totalImageBytes)
    || value.totalImageBytes < 0) {
    throw assetIntegrity('PDF asset store total byte accounting is invalid.');
  }
  const publishedAt = Date.parse(String(value.publishedAt));
  const expiresAt = Date.parse(String(value.expiresAt));
  if (!Number.isFinite(publishedAt) || !Number.isFinite(expiresAt) || expiresAt <= publishedAt) {
    throw assetIntegrity('PDF asset store retention timestamps are invalid.');
  }
  assertPdfAssetManifestIntegrity(value.manifest as PdfAssetManifest);
  const manifest = value.manifest as PdfAssetManifest;
  assertManifestLimits(manifest, limits);
  const storedIdentity = pdfAssetIdentityFromManifest(manifest);
  if (!sameIdentity(storedIdentity, expectedIdentity)) {
    throw assetIntegrity('PDF asset manifest identity does not match its storage key.');
  }
  if (createPublicationDigest(manifest) !== value.publicationDigest) {
    throw assetIntegrity('PDF asset manifest content does not match its publication digest.');
  }
  if (createScopeDigest(storedIdentity) !== value.scopeDigest) {
    throw assetIntegrity('PDF asset manifest scope does not match its quota scope.');
  }
  if (totalManifestImageBytes(manifest) !== value.totalImageBytes) {
    throw assetIntegrity('PDF asset manifest byte accounting is invalid.');
  }
  if (createEnvelopeDigest(value as unknown as StoredPdfAssetManifest) !== value.envelopeDigest) {
    throw assetIntegrity('PDF asset store envelope content failed integrity validation.');
  }
}

function identityFromUnknownEnvelope(value: unknown): PdfAssetIdentity {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    throw assetIntegrity('PDF asset store manifest envelope is invalid.');
  }
  return pdfAssetIdentityFromManifest(value.manifest as unknown as PdfAssetManifest);
}

function assertManifestLimits(
  manifest: PdfAssetManifest,
  limits: PdfAssetStoreLimits
): void {
  let serializedBytes: number;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  } catch (error) {
    throw new Error('PDF asset manifest cannot be safely serialized.', { cause: error });
  }
  if (serializedBytes > limits.maxManifestBytes) {
    throw new Error('PDF asset manifest exceeds the configured byte limit.');
  }
  if (manifest.pageCount > limits.maxPages) {
    throw new Error('PDF asset page count exceeds the configured store limit.');
  }
  let totalBytes = 0;
  const seenRefs = new Set<string>();
  for (const page of getImagePages(manifest)) {
    if (page.byteLength > limits.maxImageBytes) {
      throw new Error('PDF page image exceeds the configured store byte limit.');
    }
    totalBytes += page.byteLength;
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error('PDF asset images exceed the configured store total byte limit.');
    }
    if (seenRefs.has(page.imageRef)) {
      throw new Error('PDF asset manifest image references must be unique per page.');
    }
    seenRefs.add(page.imageRef);
  }
}

function assertPageBytes(
  page: PdfAssetImageManifestPage,
  bytes: Uint8Array,
  limits: PdfAssetStoreLimits
): void {
  if (bytes.byteLength < 1 || bytes.byteLength > limits.maxImageBytes) {
    throw new Error('PDF page image bytes are outside the configured limit.');
  }
  if (bytes.byteLength !== page.byteLength) {
    throw new Error('PDF page image byte length does not match its manifest.');
  }
  if (sha256Hex(bytes) !== page.contentDigest) {
    throw new Error('PDF page image digest does not match its manifest.');
  }
  if (!matchesMimeMagic(bytes, page.mimeType)) {
    throw new Error('PDF page image MIME signature does not match its manifest.');
  }
}

function matchesMimeMagic(
  bytes: Uint8Array,
  mimeType: PdfAssetImageMimeType
): boolean {
  if (mimeType === 'image/png') {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 4
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff
      && bytes[bytes.length - 1] === 0xd9;
  }
  return bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
}

function getImagePages(manifest: PdfAssetManifest): PdfAssetImageManifestPage[] {
  return manifest.pages.filter(
    (page): page is PdfAssetImageManifestPage => page.imageRef !== undefined
  );
}

function totalManifestImageBytes(manifest: PdfAssetManifest): number {
  return getImagePages(manifest).reduce((total, page) => total + page.byteLength, 0);
}

function findImagePage(
  manifest: PdfAssetManifest,
  pageNumber: number
): PdfAssetImageManifestPage | null {
  const page = manifest.pages[pageNumber - 1];
  if (!page || page.pageNumber !== pageNumber || page.imageRef === undefined) return null;
  return page as PdfAssetImageManifestPage;
}

function normalizeIdentity(identity: PdfAssetIdentity): PdfAssetIdentity {
  if (!identity || typeof identity !== 'object') {
    throw new Error('PDF asset identity must be an object.');
  }
  const normalizedScope = createRetrievalScope({
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    allowedTrustLevels: [identity.trustLevel],
    enforceIsolation: true,
  });
  return {
    tenantId: normalizedScope.tenantId,
    corpusId: normalizedScope.corpusId,
    documentId: normalizeDocumentIdentifier(identity.documentId, 'documentId'),
    documentVersion: normalizeDocumentIdentifier(identity.documentVersion, 'documentVersion'),
    trustLevel: identity.trustLevel,
  };
}

function normalizeDocumentIdentifier(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_DOCUMENT_IDENTIFIER.test(normalized)
    || normalized.split('/').includes('..')) {
    throw new Error(field + ' must be a safe PDF asset identifier.');
  }
  return normalized;
}

function assertIdentityWithinScope(
  identity: PdfAssetIdentity,
  scope: RagRetrievalScope,
  allowQuarantined = false
): void {
  const normalizedScope = createRetrievalScope({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    allowedTrustLevels: scope.allowedTrustLevels,
    enforceIsolation: true,
  });
  if (identity.tenantId !== normalizedScope.tenantId) {
    throw new Error('PDF asset tenant scope mismatch.');
  }
  if (identity.corpusId !== normalizedScope.corpusId) {
    throw new Error('PDF asset corpus scope mismatch.');
  }
  if (identity.trustLevel === 'quarantined' && !allowQuarantined) {
    throw new Error('PDF asset is quarantined.');
  }
  if (!normalizedScope.allowedTrustLevels.includes(identity.trustLevel)) {
    throw new Error('PDF asset trust level is outside the retrieval scope.');
  }
}

function createIdentityKey(identity: PdfAssetIdentity): string {
  const normalized = normalizeIdentity(identity);
  return JSON.stringify([
    normalized.tenantId,
    normalized.corpusId,
    normalized.documentId,
    normalized.documentVersion,
    normalized.trustLevel,
  ]);
}

function createIdentityDigest(identity: PdfAssetIdentity): string {
  return createHash('sha256').update(createIdentityKey(identity)).digest('hex');
}

function createScopeDigest(identity: PdfAssetIdentity): string {
  const normalized = normalizeIdentity(identity);
  return createHash('sha256').update(JSON.stringify([
    normalized.tenantId,
    normalized.corpusId,
  ])).digest('hex');
}

function sameIdentity(left: PdfAssetIdentity, right: PdfAssetIdentity): boolean {
  return createIdentityKey(left) === createIdentityKey(right);
}

function createEnvelopeDigest(
  envelope: Omit<StoredPdfAssetManifest, 'envelopeDigest'> | StoredPdfAssetManifest
): string {
  const { envelopeDigest: _envelopeDigest, ...payload } = envelope as StoredPdfAssetManifest;
  void _envelopeDigest;
  return sha256Hex(stableStringify(payload));
}

function createPublicationDigest(manifest: PdfAssetManifest): string {
  const { createdAt: _createdAt, ...semanticManifest } = manifest;
  void _createdAt;
  return sha256Hex(stableStringify(semanticManifest));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, sortCanonical(value[key])])
    );
  }
  return value;
}

function resolveStoreLimits(
  overrides: Partial<PdfAssetStoreLimits> | undefined
): PdfAssetStoreLimits {
  const limits = { ...PDF_ASSET_STORE_DEFAULT_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    const hardLimit = PDF_ASSET_STORE_HARD_LIMITS[
      name as keyof PdfAssetStoreLimits
    ];
    if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
      throw new Error('PDF asset store limit ' + name + ' is outside the hard limit.');
    }
  }
  return limits;
}

function resolveStoreRetention(
  overrides: Partial<PdfAssetStoreRetention> | undefined
): PdfAssetStoreRetention {
  const retention = { ...PDF_ASSET_STORE_DEFAULT_RETENTION, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(retention)) {
    const hardLimit = PDF_ASSET_STORE_HARD_RETENTION[
      name as keyof PdfAssetStoreRetention
    ];
    if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
      throw new Error('PDF asset store retention ' + name + ' is outside the hard limit.');
    }
  }
  return retention;
}
function assertGcManifestBudget(
  limits: PdfAssetStoreLimits,
  retention: PdfAssetStoreRetention
): void {
  if (retention.gcMaxBytes < limits.maxManifestBytes) {
    throw new Error(
      'PDF asset store GC byte budget must be at least the manifest byte limit.'
    );
  }
}



function resolveStoreControl(
  overrides: Partial<PdfAssetStoreControlLimits> | undefined
): PdfAssetStoreControlLimits {
  const control = { ...PDF_ASSET_STORE_DEFAULT_CONTROL, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(control)) {
    const hardLimit = PDF_ASSET_STORE_HARD_CONTROL[
      name as keyof PdfAssetStoreControlLimits
    ];
    if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
      throw new Error('PDF asset store control limit ' + name + ' is outside the hard limit.');
    }
  }
  return control;
}

function emptyLedgerCounters(): LedgerCounters {
  return {
    committedCount: 0,
    committedBytes: 0,
    reservedCount: 0,
    reservedBytes: 0,
  };
}

function createRootLedger(
  committedCount = 0,
  committedBytes = 0,
  scopeLifecycles: Record<string, ScopeLifecycle> = {}
): RootLedger {
  return {
    schemaVersion: ROOT_LEDGER_SCHEMA_VERSION,
    generation: 0,
    recoveryRequired: false,
    ...emptyLedgerCounters(),
    committedCount,
    committedBytes,
    activeReservations: {},
    scopeLifecycles: { ...scopeLifecycles },
    gcCursor: { phase: 'bundles', shard: 0, lastName: null },
    digest: '',
  };
}

function createScopeLedger(
  scopeDigest: string,
  committedCount = 0,
  committedBytes = 0
): ScopeLedger {
  return {
    schemaVersion: SCOPE_LEDGER_SCHEMA_VERSION,
    generation: 0,
    scopeDigest,
    recoveryRequired: false,
    ...emptyLedgerCounters(),
    committedCount,
    committedBytes,
    activeReservations: {},
    settledReservations: {},
    digest: '',
  };
}

function createRecoveryLedger(
  target: 'root' | 'scope',
  scopeDigest: string | null
): RecoveryLedger {
  return {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    generation: 0,
    target,
    scopeDigest,
    phase: 'bundles',
    shard: 0,
    lastName: null,
    count: 0,
    totalBytes: 0,
    liveScopeDigests: {},
    digest: '',
  };
}

function signRootLedger(ledger: RootLedger): RootLedger {
  const unsigned = { ...ledger, digest: '' };
  return { ...unsigned, digest: createSignedDigest(unsigned) };
}

function signScopeLedger(ledger: ScopeLedger): ScopeLedger {
  const unsigned = { ...ledger, digest: '' };
  return { ...unsigned, digest: createSignedDigest(unsigned) };
}

function signReservationJournal(
  journal: ReservationJournal
): ReservationJournal {
  const unsigned = { ...journal, digest: '' };
  return { ...unsigned, digest: createSignedDigest(unsigned) };
}

function signRecoveryLedger(ledger: RecoveryLedger): RecoveryLedger {
  const unsigned = { ...ledger, digest: '' };
  return { ...unsigned, digest: createSignedDigest(unsigned) };
}

function createSignedDigest(value: Record<string, unknown>): string {
  const { digest: _digest, ...payload } = value;
  void _digest;
  return sha256Hex(stableStringify(payload));
}

function cloneRootLedger(ledger: RootLedger): RootLedger {
  return {
    ...ledger,
    activeReservations: Object.fromEntries(
      Object.entries(ledger.activeReservations).map(
        ([key, value]) => [key, { ...value }]
      )
    ),
    scopeLifecycles: { ...ledger.scopeLifecycles },
    gcCursor: cloneGcCursor(ledger.gcCursor),
  };
}

function cloneScopeLedger(ledger: ScopeLedger): ScopeLedger {
  return {
    ...ledger,
    activeReservations: Object.fromEntries(
      Object.entries(ledger.activeReservations).map(
        ([key, value]) => [key, { ...value }]
      )
    ),
    settledReservations: { ...ledger.settledReservations },
  };
}

function cloneGcCursor(cursor: PdfAssetGcCursor): PdfAssetGcCursor {
  return { phase: cursor.phase, shard: cursor.shard, lastName: cursor.lastName };
}

function assertRootLedger(
  value: unknown,
  control: PdfAssetStoreControlLimits
): asserts value is RootLedger {
  if (!isRecord(value) || value.schemaVersion !== ROOT_LEDGER_SCHEMA_VERSION) {
    throw new Error('PDF asset root ledger schema is unsupported.');
  }
  assertLedgerGenerationAndDigest(value);
  assertLedgerCounters(value);
  if (typeof value.recoveryRequired !== 'boolean') {
    throw new Error('PDF asset root ledger recovery flag is invalid.');
  }
  assertGcCursor(value.gcCursor);
  assertScopeLifecycleMap(value.scopeLifecycles, control.maxScopeLedgers);
  const active = assertActiveReservationMap(
    value.activeReservations,
    control.maxInflightReservations
  );
  const putReservations = Object.values(active).filter(
    reservation => reservation.operation === 'put'
  );
  const reservedBytes = putReservations.reduce(
    (total, reservation) => total + reservation.reservedBytes,
    0
  );
  if (value.reservedCount !== putReservations.length
    || value.reservedBytes !== reservedBytes) {
    throw new Error('PDF asset root ledger reservation totals are invalid.');
  }
}

function assertScopeLedger(
  value: unknown,
  expectedScopeDigest: string,
  control: PdfAssetStoreControlLimits
): asserts value is ScopeLedger {
  if (!isRecord(value) || value.schemaVersion !== SCOPE_LEDGER_SCHEMA_VERSION) {
    throw new Error('PDF asset scope ledger schema is unsupported.');
  }
  assertLedgerGenerationAndDigest(value);
  assertLedgerCounters(value);
  if (value.scopeDigest !== expectedScopeDigest
    || !SHA256_HEX.test(expectedScopeDigest)) {
    throw new Error('PDF asset scope ledger identity is invalid.');
  }
  if (typeof value.recoveryRequired !== 'boolean') {
    throw new Error('PDF asset scope ledger recovery flag is invalid.');
  }
  const active = assertActiveReservationMap(
    value.activeReservations,
    control.maxInflightReservations
  );
  if (!isRecord(value.settledReservations)
    || Object.keys(value.settledReservations).length
      > control.maxInflightReservations) {
    throw new Error('PDF asset scope ledger settlement map is invalid.');
  }
  for (const settlement of Object.values(value.settledReservations)) {
    if (settlement !== 'commit' && settlement !== 'release') {
      throw new Error('PDF asset scope ledger settlement is invalid.');
    }
  }
  const putReservations = Object.values(active).filter(
    reservation => reservation.operation === 'put'
  );
  const reservedBytes = putReservations.reduce(
    (total, reservation) => total + reservation.reservedBytes,
    0
  );
  if (value.reservedCount !== putReservations.length
    || value.reservedBytes !== reservedBytes) {
    throw new Error('PDF asset scope ledger reservation totals are invalid.');
  }
}

function assertScopeLifecycleMap(
  value: unknown,
  maxEntries: number
): Record<string, ScopeLifecycle> {
  if (!isRecord(value) || Object.keys(value).length > maxEntries) {
    throw new Error('PDF asset scope lifecycle registry is invalid.');
  }
  for (const [scopeDigest, lifecycle] of Object.entries(value)) {
    if (!SHA256_HEX.test(scopeDigest)
      || (lifecycle !== 'creating'
        && lifecycle !== 'active'
        && lifecycle !== 'reclaiming')) {
      throw new Error('PDF asset scope lifecycle entry is invalid.');
    }
  }
  return value as Record<string, ScopeLifecycle>;
}

function assertLiveScopeDigestMap(
  value: unknown,
  maxEntries: number
): Record<string, true> {
  if (!isRecord(value) || Object.keys(value).length > maxEntries
    || Object.entries(value).some(([digest, live]) => !SHA256_HEX.test(digest) || live !== true)) {
    throw new Error('PDF asset recovery live-scope registry is invalid.');
  }
  return value as Record<string, true>;
}

function assertLedgerGenerationAndDigest(
  value: Record<string, unknown>
): void {
  if (!Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || typeof value.digest !== 'string'
    || !SHA256_HEX.test(value.digest)
    || createSignedDigest(value) !== value.digest) {
    throw new Error('PDF asset ledger generation or digest is invalid.');
  }
}

function assertLedgerCounters(
  value: Record<string, unknown>
): void {
  for (const key of [
    'committedCount',
    'committedBytes',
    'reservedCount',
    'reservedBytes',
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new Error('PDF asset ledger counters are invalid.');
    }
  }
}

function assertActiveReservationMap(
  value: unknown,
  maxEntries: number
): Record<string, ActiveReservation> {
  if (!isRecord(value) || Object.keys(value).length > maxEntries) {
    throw new Error('PDF asset active reservation map is invalid.');
  }
  for (const [reservationId, reservation] of Object.entries(value)) {
    assertActiveReservation(reservation, reservationId);
  }
  return value as Record<string, ActiveReservation>;
}

function assertActiveReservation(
  value: unknown,
  expectedReservationId?: string
): asserts value is ActiveReservation {
  if (!isRecord(value)
    || typeof value.reservationId !== 'string'
    || !RESERVATION_ID.test(value.reservationId)
    || (expectedReservationId !== undefined
      && value.reservationId !== expectedReservationId)
    || (value.operation !== 'put' && value.operation !== 'delete')
    || typeof value.identityDigest !== 'string'
    || !SHA256_HEX.test(value.identityDigest)
    || typeof value.scopeDigest !== 'string'
    || !SHA256_HEX.test(value.scopeDigest)
    || typeof value.publicationDigest !== 'string'
    || !SHA256_HEX.test(value.publicationDigest)
    || typeof value.processEpoch !== 'string'
    || !SAFE_PROCESS_EPOCH.test(value.processEpoch)
    || !Number.isSafeInteger(value.createdAtMs)
    || (value.createdAtMs as number) < 0
    || !Number.isSafeInteger(value.committedBytes)
    || (value.committedBytes as number) < 1
    || !Number.isSafeInteger(value.reservedBytes)
    || (value.reservedBytes as number) < 0) {
    throw new Error('PDF asset reservation record is invalid.');
  }
  if (value.operation === 'put'
    && (value.reservedBytes as number) < (value.committedBytes as number)) {
    throw new Error('PDF asset reservation byte accounting is invalid.');
  }
  if (value.operation === 'delete' && value.reservedBytes !== 0) {
    throw new Error('PDF asset deletion reservation accounting is invalid.');
  }
}

function assertGcCursor(value: unknown): asserts value is PdfAssetGcCursor {
  if (!isRecord(value)
    || ![
      'bundles',
      'reservations',
      'staging',
      'scope-control',
      'control-root-temps',
      'recovery-root-temps',
      'recovery-scope-temps',
    ].includes(String(value.phase))
    || !Number.isInteger(value.shard)
    || (value.shard as number) < 0
    || (value.shard as number) > gcPhaseMaxShard(value.phase as GcPhase)
    || (value.lastName !== null && typeof value.lastName !== 'string')) {
    throw new Error('PDF asset GC cursor is invalid.');
  }
}

function assertReservationJournal(
  value: unknown,
  expectedReservationId: string
): asserts value is ReservationJournal {
  if (!isRecord(value)
    || value.schemaVersion !== RESERVATION_SCHEMA_VERSION
    || !['prepared', 'reserved', 'published', 'scope-settled', 'root-settled']
      .includes(String(value.state))) {
    throw new Error('PDF asset reservation journal is invalid.');
  }
  assertLedgerGenerationAndDigest(value);
  assertActiveReservation(value.reservation, expectedReservationId);
}

function assertRecoveryLedger(
  value: unknown,
  target: 'root' | 'scope',
  scopeDigest: string | null,
  control: PdfAssetStoreControlLimits
): asserts value is RecoveryLedger {
  if (!isRecord(value)
    || value.schemaVersion !== RECOVERY_SCHEMA_VERSION
    || value.target !== target
    || value.scopeDigest !== scopeDigest
    || !['bundles', 'reservations', 'scopes'].includes(String(value.phase))
    || (target === 'scope' && value.phase === 'scopes')
    || (value.phase !== 'scopes' && value.shard === 256 && target === 'root')
    || !Number.isInteger(value.shard)
    || (value.shard as number) < 0
    || (value.shard as number) > 256
    || (value.lastName !== null && typeof value.lastName !== 'string')
    || !Number.isSafeInteger(value.count)
    || (value.count as number) < 0
    || !Number.isSafeInteger(value.totalBytes)
    || (value.totalBytes as number) < 0) {
    throw new Error('PDF asset recovery ledger is invalid.');
  }
  assertLiveScopeDigestMap(value.liveScopeDigests, control.maxScopeLedgers);
  assertLedgerGenerationAndDigest(value);
}

function assertLedgerCapacity(
  root: RootLedger,
  scope: ScopeLedger,
  reservation: ActiveReservation,
  limits: PdfAssetStoreLimits
): void {
  if (root.committedCount + root.reservedCount + 1
    > limits.maxRootAssetCount) {
    throw assetCapacity('PDF asset root count capacity is exhausted.');
  }
  if (root.committedBytes + root.reservedBytes + reservation.reservedBytes
    > limits.maxRootTotalBytes) {
    throw assetCapacity('PDF asset root byte capacity is exhausted.');
  }
  if (scope.committedCount + scope.reservedCount + 1
    > limits.maxScopeAssetCount) {
    throw assetCapacity('PDF asset scope count capacity is exhausted.');
  }
  if (scope.committedBytes + scope.reservedBytes + reservation.reservedBytes
    > limits.maxScopeTotalBytes) {
    throw assetCapacity('PDF asset scope byte capacity is exhausted.');
  }
}

function settleScopeReservation(
  scope: ScopeLedger,
  reservation: ActiveReservation,
  settlement: LedgerSettlement
): void {
  const settled = scope.settledReservations[reservation.reservationId];
  if (settled) {
    if (settled !== settlement) {
      throw assetIntegrity('PDF asset scope reservation settlement conflicted.');
    }
    return;
  }
  const active = scope.activeReservations[reservation.reservationId];
  if (!active) {
    if (settlement === 'release') {
      scope.settledReservations[reservation.reservationId] = settlement;
      return;
    }
    throw assetRecovery(
      'PDF asset scope reservation is missing during commit.'
    );
  }
  assertSameActiveReservation(active, reservation);
  if (reservation.operation === 'put') {
    scope.reservedCount -= 1;
    scope.reservedBytes -= reservation.reservedBytes;
    if (settlement === 'commit') {
      scope.committedCount += 1;
      scope.committedBytes += reservation.committedBytes;
    }
  } else if (settlement === 'commit') {
    scope.committedCount -= 1;
    scope.committedBytes -= reservation.committedBytes;
  }
  assertNonNegativeLedgerCounters(scope);
  delete scope.activeReservations[reservation.reservationId];
  scope.settledReservations[reservation.reservationId] = settlement;
}

function settleRootReservation(
  root: RootLedger,
  reservation: ActiveReservation,
  settlement: LedgerSettlement
): void {
  const active = root.activeReservations[reservation.reservationId];
  if (!active) return;
  assertSameActiveReservation(active, reservation);
  if (reservation.operation === 'put') {
    root.reservedCount -= 1;
    root.reservedBytes -= reservation.reservedBytes;
    if (settlement === 'commit') {
      root.committedCount += 1;
      root.committedBytes += reservation.committedBytes;
    }
  } else if (settlement === 'commit') {
    root.committedCount -= 1;
    root.committedBytes -= reservation.committedBytes;
  }
  assertNonNegativeLedgerCounters(root);
  delete root.activeReservations[reservation.reservationId];
}

function assertSameActiveReservation(
  left: ActiveReservation,
  right: ActiveReservation
): void {
  if (stableStringify(left) !== stableStringify(right)) {
    throw assetIntegrity('PDF asset reservation identity changed during settlement.');
  }
}

function assertNonNegativeLedgerCounters(counters: LedgerCounters): void {
  if ([
    counters.committedCount,
    counters.committedBytes,
    counters.reservedCount,
    counters.reservedBytes,
  ].some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw assetRecovery('PDF asset ledger counters would become negative.');
  }
}

function isScopeReadyForReclaim(scope: ScopeLedger): boolean {
  return scope.committedCount === 0
    && scope.committedBytes === 0
    && scope.reservedCount === 0
    && scope.reservedBytes === 0
    && Object.keys(scope.activeReservations).length === 0;
}

function pruneSettledReservations(
  scope: ScopeLedger,
  root: RootLedger
): void {
  for (const reservationId of Object.keys(scope.settledReservations)) {
    if (!root.activeReservations[reservationId]) {
      delete scope.settledReservations[reservationId];
    }
  }
}
function isRecoveryScanComplete(recovery: RecoveryLedger): boolean {
  return recovery.shard === 256
    && (
      (recovery.target === 'root' && recovery.phase === 'scopes')
      || (recovery.target === 'scope' && recovery.phase === 'reservations')
    );
}

function advanceRecoveryCursor(recovery: RecoveryLedger): void {
  if (recovery.shard < 255) {
    recovery.shard += 1;
    recovery.lastName = null;
    return;
  }
  if (recovery.phase === 'bundles') {
    recovery.phase = 'reservations';
    recovery.shard = 0;
  } else if (recovery.phase === 'reservations' && recovery.target === 'root') {
    recovery.phase = 'scopes';
    recovery.shard = 0;
  } else {
    recovery.shard = 256;
  }
  recovery.lastName = null;
}

function isReservationTemporaryFile(name: string): boolean {
  const temporary = parseAtomicTempName(name);
  return Boolean(temporary && RESERVATION_ID.test(temporary.baseName));
}

function parseAtomicTempName(name: string): AtomicTempName | null {
  const match = ATOMIC_TEMP_FILE.exec(name);
  if (!match || !RESERVATION_ID.test(match[3])) return null;
  const createdAtMs = match[2] === undefined ? null : Number(match[2]);
  if (createdAtMs !== null
    && (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)) {
    return null;
  }
  return {
    baseName: match[1],
    createdAtMs,
    writeId: match[3],
  };
}

function isAtomicTempExpectedForPhase(
  phase: GcPhase,
  baseName: string
): boolean {
  if (phase === 'reservations') return RESERVATION_ID.test(baseName);
  if (phase === 'scope-control' || phase === 'recovery-scope-temps') {
    return SCOPE_LEDGER_FILE.test(baseName);
  }
  if (phase === 'control-root-temps') return baseName === 'root-ledger.json';
  if (phase === 'recovery-root-temps') return baseName === 'root.json';
  return false;
}

function isRecoverableLedgerReadFailure(error: unknown): boolean {
  return (isNodeError(error) && error.code === 'ENOENT')
    || (error instanceof PdfAssetStoreError
      && (error.code === 'PDF_ASSET_INTEGRITY'
        || error.code === 'PDF_ASSET_RECOVERY_REQUIRED'));
}


function advanceGcCursor(cursor: PdfAssetGcCursor): PdfAssetGcCursor {
  if (cursor.shard < gcPhaseMaxShard(cursor.phase)) {
    return { ...cursor, shard: cursor.shard + 1, lastName: null };
  }
  const phases: readonly GcPhase[] = [
    'bundles',
    'reservations',
    'staging',
    'scope-control',
    'control-root-temps',
    'recovery-root-temps',
    'recovery-scope-temps',
  ];
  const index = phases.indexOf(cursor.phase);
  const phase = phases[(index + 1) % phases.length];
  return { phase, shard: 0, lastName: null };
}

function gcPhaseMaxShard(phase: GcPhase): number {
  return phase === 'control-root-temps' || phase === 'recovery-root-temps'
    ? 0
    : 255;
}

function isSimulatedHardCrash(error: unknown): boolean {
  return isRecord(error) && error.code === SIMULATED_HARD_CRASH_CODE;
}
function readClock(clock: () => Date): number {
  const value = clock();
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('PDF asset store clock must return a valid Date.');
  }
  return timestamp;
}

function isExpired(envelope: StoredPdfAssetManifest, now: number): boolean {
  return Date.parse(envelope.expiresAt) <= now;
}

function emptyUsage(): StoreUsage {
  return { count: 0, totalBytes: 0, scopes: new Map() };
}

function addUsage(
  usage: StoreUsage,
  scopeDigest: string,
  totalImageBytes: number
): void {
  usage.count += 1;
  usage.totalBytes += totalImageBytes;
  const current = usage.scopes.get(scopeDigest) ?? { count: 0, totalBytes: 0 };
  current.count += 1;
  current.totalBytes += totalImageBytes;
  usage.scopes.set(scopeDigest, current);
}

function assertCapacity(
  usage: StoreUsage,
  publication: NormalizedPublication,
  limits: PdfAssetStoreLimits
): void {
  const scope = usage.scopes.get(createScopeDigest(publication.identity))
    ?? { count: 0, totalBytes: 0 };
  if (usage.count + 1 > limits.maxRootAssetCount) {
    throw assetCapacity('PDF asset root count capacity is exhausted.');
  }
  if (usage.totalBytes + publication.totalImageBytes > limits.maxRootTotalBytes) {
    throw assetCapacity('PDF asset root byte capacity is exhausted.');
  }
  if (scope.count + 1 > limits.maxScopeAssetCount) {
    throw assetCapacity('PDF asset scope count capacity is exhausted.');
  }
  if (scope.totalBytes + publication.totalImageBytes > limits.maxScopeTotalBytes) {
    throw assetCapacity('PDF asset scope byte capacity is exhausted.');
  }
}

function assertPageNumber(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > PDF_ASSET_STORE_HARD_LIMITS.maxPages) {
    throw new Error('PDF asset page number is outside the hard limit.');
  }
}

async function readBoundedBytes(file: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('PDF asset storage path is not a regular file.');
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
    if (total > maxBytes) throw new Error('PDF asset file exceeds its configured byte limit.');
    return Uint8Array.from(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

async function writeExclusiveBytes(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface BoundedDirectoryEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

async function readBoundedJson(
  file: string,
  maxBytes: number
): Promise<unknown> {
  const bytes = await readBoundedBytes(file, maxBytes);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
}

async function writeAtomicJson(
  file: string,
  value: unknown,
  maxBytes: number,
  replaceExisting = true
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.byteLength > maxBytes) {
    throw assetCapacity('PDF asset control record exceeds its byte limit.');
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (!replaceExisting) {
    await writeExclusiveBytes(file, bytes);
    return;
  }
  const temporary = file + '.' + Date.now() + '.' + randomUUID() + '.tmp';
  try {
    await writeExclusiveBytes(temporary, bytes);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function listDirectoryEntriesBounded(
  directoryPath: string,
  maxEntries: number,
  observe: (kind: PdfAssetStoreIoKind) => void
): Promise<BoundedDirectoryEntry[]> {
  const entries: BoundedDirectoryEntry[] = [];
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    for await (const entry of directory) {
      observe('directory-entry');
      if (entries.length >= maxEntries) {
        throw assetGcBudget(
          'PDF asset shard exceeds the bounded directory-entry budget.'
        );
      }
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      });
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function readFileSize(file: string): Promise<number> {
  try {
    const value = await stat(file);
    return value.isFile() && Number.isSafeInteger(value.size) ? value.size : 0;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}
async function readModifiedTime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertPathWithinRoot(rootDir: string, candidate: string): void {
  const relative = path.relative(rootDir, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('PDF asset storage path escaped its configured root.');
  }
}

async function withFileStoreLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fileStoreLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  fileStoreLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (fileStoreLocks.get(key) === tail) fileStoreLocks.delete(key);
  }
}

function cloneManifest(manifest: PdfAssetManifest): PdfAssetManifest {
  return JSON.parse(JSON.stringify(manifest)) as PdfAssetManifest;
}

function cloneEnvelope(envelope: StoredPdfAssetManifest): StoredPdfAssetManifest {
  return {
    schemaVersion: envelope.schemaVersion,
    publicationDigest: envelope.publicationDigest,
    envelopeDigest: envelope.envelopeDigest,
    scopeDigest: envelope.scopeDigest,
    totalImageBytes: envelope.totalImageBytes,
    publishedAt: envelope.publishedAt,
    expiresAt: envelope.expiresAt,
    manifest: cloneManifest(envelope.manifest),
  };
}

function assetConflict(message: string, cause?: unknown): PdfAssetStoreError {
  return new PdfAssetStoreError('PDF_ASSET_CONFLICT', message, cause);
}

function assetIntegrity(message: string, cause?: unknown): PdfAssetStoreError {
  return new PdfAssetStoreError('PDF_ASSET_INTEGRITY', message, cause);
}

function assetCapacity(message: string, cause?: unknown): PdfAssetStoreError {
  return new PdfAssetStoreError('PDF_ASSET_CAPACITY', message, cause);
}

function assetRecovery(message: string, cause?: unknown): PdfAssetStoreError {
  return new PdfAssetStoreError('PDF_ASSET_RECOVERY_REQUIRED', message, cause);
}

function assetGcBudget(message: string, cause?: unknown): PdfAssetStoreError {
  return new PdfAssetStoreError('PDF_ASSET_GC_BUDGET', message, cause);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
