import path from 'node:path';
import {
  FilePdfAssetStore,
  PDF_ASSET_STORE_DEFAULT_CONTROL,
  PDF_ASSET_STORE_DEFAULT_LIMITS,
  PDF_ASSET_STORE_DEFAULT_RETENTION,
  PDF_ASSET_STORE_HARD_CONTROL,
  PDF_ASSET_STORE_HARD_LIMITS,
  PDF_ASSET_STORE_HARD_RETENTION,
  type PdfAssetStore,
  type PdfAssetStoreControlLimits,
  type PdfAssetStoreLimits,
  type PdfAssetStoreRetention,
} from './pdf-asset-store';
import {
  DEFAULT_PDF_PAGE_IMAGE_DESIRED_WIDTH,
  DEFAULT_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS,
  DEFAULT_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES,
  MAX_PDF_PAGE_IMAGE_DESIRED_WIDTH,
  MAX_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS,
  MAX_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES,
  PdfPageImageRenderer,
} from './pdf-page-image-renderer';

export const PDF_VISUAL_RUNTIME_VERSION = 'pdf-visual-runtime-v1' as const;

export class PdfVisualSharedStoreRequiredError extends Error {
  readonly code = 'RAG_PDF_VISUAL_SHARED_STORE_REQUIRED';
  readonly status = 503;

  constructor() {
    super(
      'The local PDF visual asset store is process-coordinated and cannot '
      + 'satisfy a shared multi-instance topology.'
    );
    this.name = 'PdfVisualSharedStoreRequiredError';
  }
}

export interface PdfVisualAssetRuntime {
  version: typeof PDF_VISUAL_RUNTIME_VERSION;
  store: PdfAssetStore;
  renderer: PdfPageImageRenderer;
  rootDir: string;
  renderWidth: number;
  maxRenderPages: number;
  storeLimits: PdfAssetStoreLimits;
  storeRetention: PdfAssetStoreRetention;
  storeControl: PdfAssetStoreControlLimits;
  maxConcurrentRenders: number;
  maxInFlightSourceBytes: number;
}

const stores = new Map<string, FilePdfAssetStore>();
const renderers = new Map<string, PdfPageImageRenderer>();

export function assertPdfVisualControlPlaneTopology(
  env: Record<string, string | undefined> = process.env
): void {
  if (
    readBoolean(env.RAG_PDF_VISUAL_MULTI_INSTANCE)
    || readBoolean(env.RAG_PDF_VISUAL_REQUIRE_SHARED_CONTROL_PLANE)
  ) {
    throw new PdfVisualSharedStoreRequiredError();
  }
}

export function getPdfVisualAssetRuntime(
  env: Record<string, string | undefined> = process.env
): PdfVisualAssetRuntime {
  assertPdfVisualControlPlaneTopology(env);
  const configuredRoot = env.RAG_PDF_VISUAL_STORE_ROOT?.trim();
  const rootDir = configuredRoot
    ? path.resolve(/*turbopackIgnore: true*/ configuredRoot)
    : path.join(process.cwd(), 'uploads', 'pdf-visual-assets-v1');
  const renderWidth = readBoundedInteger(
    env.RAG_PDF_VISUAL_RENDER_WIDTH,
    DEFAULT_PDF_PAGE_IMAGE_DESIRED_WIDTH,
    1,
    MAX_PDF_PAGE_IMAGE_DESIRED_WIDTH,
    'RAG_PDF_VISUAL_RENDER_WIDTH'
  );
  const maxRenderPages = readBoundedInteger(
    env.RAG_PDF_VISUAL_MAX_RENDER_PAGES,
    20,
    1,
    100,
    'RAG_PDF_VISUAL_MAX_RENDER_PAGES'
  );
  const storeLimits: PdfAssetStoreLimits = {
    ...PDF_ASSET_STORE_DEFAULT_LIMITS,
    maxRootAssetCount: readBoundedInteger(
      env.RAG_PDF_VISUAL_MAX_ROOT_ASSETS,
      PDF_ASSET_STORE_DEFAULT_LIMITS.maxRootAssetCount,
      1,
      PDF_ASSET_STORE_HARD_LIMITS.maxRootAssetCount,
      'RAG_PDF_VISUAL_MAX_ROOT_ASSETS'
    ),
    maxRootTotalBytes: readBoundedInteger(
      env.RAG_PDF_VISUAL_MAX_ROOT_BYTES,
      PDF_ASSET_STORE_DEFAULT_LIMITS.maxRootTotalBytes,
      1,
      PDF_ASSET_STORE_HARD_LIMITS.maxRootTotalBytes,
      'RAG_PDF_VISUAL_MAX_ROOT_BYTES'
    ),
    maxScopeAssetCount: readBoundedInteger(
      env.RAG_PDF_VISUAL_MAX_SCOPE_ASSETS,
      PDF_ASSET_STORE_DEFAULT_LIMITS.maxScopeAssetCount,
      1,
      PDF_ASSET_STORE_HARD_LIMITS.maxScopeAssetCount,
      'RAG_PDF_VISUAL_MAX_SCOPE_ASSETS'
    ),
    maxScopeTotalBytes: readBoundedInteger(
      env.RAG_PDF_VISUAL_MAX_SCOPE_BYTES,
      PDF_ASSET_STORE_DEFAULT_LIMITS.maxScopeTotalBytes,
      1,
      PDF_ASSET_STORE_HARD_LIMITS.maxScopeTotalBytes,
      'RAG_PDF_VISUAL_MAX_SCOPE_BYTES'
    ),
  };
  const storeRetention: PdfAssetStoreRetention = {
    retentionMs: readBoundedInteger(
      env.RAG_PDF_VISUAL_RETENTION_MS,
      PDF_ASSET_STORE_DEFAULT_RETENTION.retentionMs,
      1,
      PDF_ASSET_STORE_HARD_RETENTION.retentionMs,
      'RAG_PDF_VISUAL_RETENTION_MS'
    ),
    orphanRetentionMs: readBoundedInteger(
      env.RAG_PDF_VISUAL_ORPHAN_RETENTION_MS,
      PDF_ASSET_STORE_DEFAULT_RETENTION.orphanRetentionMs,
      1,
      PDF_ASSET_STORE_HARD_RETENTION.orphanRetentionMs,
      'RAG_PDF_VISUAL_ORPHAN_RETENTION_MS'
    ),
    gcMaxEntries: readBoundedInteger(
      env.RAG_PDF_VISUAL_GC_MAX_ENTRIES,
      PDF_ASSET_STORE_DEFAULT_RETENTION.gcMaxEntries,
      1,
      PDF_ASSET_STORE_HARD_RETENTION.gcMaxEntries,
      'RAG_PDF_VISUAL_GC_MAX_ENTRIES'
    ),
    gcMaxBytes: readBoundedInteger(
      env.RAG_PDF_VISUAL_GC_MAX_BYTES,
      PDF_ASSET_STORE_DEFAULT_RETENTION.gcMaxBytes,
      storeLimits.maxManifestBytes,
      PDF_ASSET_STORE_HARD_RETENTION.gcMaxBytes,
      'RAG_PDF_VISUAL_GC_MAX_BYTES'
    ),
    gcMaxDurationMs: readBoundedInteger(
      env.RAG_PDF_VISUAL_GC_MAX_DURATION_MS,
      PDF_ASSET_STORE_DEFAULT_RETENTION.gcMaxDurationMs,
      1,
      PDF_ASSET_STORE_HARD_RETENTION.gcMaxDurationMs,
      'RAG_PDF_VISUAL_GC_MAX_DURATION_MS'
    ),
    gcMaxShardEntries: readBoundedInteger(
      env.RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES,
      PDF_ASSET_STORE_DEFAULT_RETENTION.gcMaxShardEntries,
      1,
      PDF_ASSET_STORE_HARD_RETENTION.gcMaxShardEntries,
      'RAG_PDF_VISUAL_GC_MAX_SHARD_ENTRIES'
    ),
    gcMaxInvalidEntries: readBoundedInteger(
      env.RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES,
      PDF_ASSET_STORE_DEFAULT_RETENTION.gcMaxInvalidEntries,
      1,
      PDF_ASSET_STORE_HARD_RETENTION.gcMaxInvalidEntries,
      'RAG_PDF_VISUAL_GC_MAX_INVALID_ENTRIES'
    ),
  };
  const storeControl: PdfAssetStoreControlLimits = {
    maxLedgerBytes: readBoundedInteger(
      env.RAG_PDF_VISUAL_LEDGER_MAX_BYTES,
      PDF_ASSET_STORE_DEFAULT_CONTROL.maxLedgerBytes,
      1,
      PDF_ASSET_STORE_HARD_CONTROL.maxLedgerBytes,
      'RAG_PDF_VISUAL_LEDGER_MAX_BYTES'
    ),
    maxInflightReservations: readBoundedInteger(
      env.RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS,
      PDF_ASSET_STORE_DEFAULT_CONTROL.maxInflightReservations,
      1,
      PDF_ASSET_STORE_HARD_CONTROL.maxInflightReservations,
      'RAG_PDF_VISUAL_MAX_INFLIGHT_PUBLICATIONS'
    ),
    reservationOverheadBytes: readBoundedInteger(
      env.RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES,
      PDF_ASSET_STORE_DEFAULT_CONTROL.reservationOverheadBytes,
      1,
      PDF_ASSET_STORE_HARD_CONTROL.reservationOverheadBytes,
      'RAG_PDF_VISUAL_RESERVATION_OVERHEAD_BYTES'
    ),
    recoveryMaxShardsPerBatch: readBoundedInteger(
      env.RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS,
      PDF_ASSET_STORE_DEFAULT_CONTROL.recoveryMaxShardsPerBatch,
      1,
      PDF_ASSET_STORE_HARD_CONTROL.recoveryMaxShardsPerBatch,
      'RAG_PDF_VISUAL_RECOVERY_MAX_SHARDS'
    ),
    maxScopeLedgers: readBoundedInteger(
      env.RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS,
      PDF_ASSET_STORE_DEFAULT_CONTROL.maxScopeLedgers,
      1,
      PDF_ASSET_STORE_HARD_CONTROL.maxScopeLedgers,
      'RAG_PDF_VISUAL_MAX_SCOPE_LEDGERS'
    ),
  };
  const maxConcurrentRenders = readBoundedInteger(
    env.RAG_PDF_VISUAL_MAX_CONCURRENT_RENDERS,
    DEFAULT_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS,
    1,
    MAX_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS,
    'RAG_PDF_VISUAL_MAX_CONCURRENT_RENDERS'
  );
  const maxInFlightSourceBytes = readBoundedInteger(
    env.RAG_PDF_VISUAL_MAX_IN_FLIGHT_SOURCE_BYTES,
    DEFAULT_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES,
    1,
    MAX_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES,
    'RAG_PDF_VISUAL_MAX_IN_FLIGHT_SOURCE_BYTES'
  );

  const storeKey = JSON.stringify([
    rootDir,
    storeLimits,
    storeRetention,
    storeControl,
  ]);
  let store = stores.get(storeKey);
  if (!store) {
    store = new FilePdfAssetStore(rootDir, {
      limits: storeLimits,
      retention: storeRetention,
      control: storeControl,
    });
    stores.set(storeKey, store);
  }
  const rendererKey = JSON.stringify([
    renderWidth,
    maxRenderPages,
    maxConcurrentRenders,
    maxInFlightSourceBytes,
  ]);
  let renderer = renderers.get(rendererKey);
  if (!renderer) {
    renderer = new PdfPageImageRenderer({
      desiredWidth: renderWidth,
      maxConcurrentRenders,
      maxInFlightSourceBytes,
    });
    renderers.set(rendererKey, renderer);
  }
  return {
    version: PDF_VISUAL_RUNTIME_VERSION,
    store,
    renderer,
    rootDir,
    renderWidth,
    maxRenderPages,
    storeLimits: { ...storeLimits },
    storeRetention: { ...storeRetention },
    storeControl: { ...storeControl },
    maxConcurrentRenders,
    maxInFlightSourceBytes,
  };
}
export function resolvePdfVisualModel(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const model = env.RAG_PDF_VISUAL_MODEL?.trim();
  if (!model) return undefined;
  if (model.length > 128 || /[\u0000-\u001f]/.test(model)) {
    throw new Error('RAG_PDF_VISUAL_MODEL is invalid.');
  }
  return model;
}

function readBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('PDF visual boolean configuration is invalid.');
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(field + ' must be an integer.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      field + ' must be between ' + minimum + ' and ' + maximum + '.'
    );
  }
  return parsed;
}
