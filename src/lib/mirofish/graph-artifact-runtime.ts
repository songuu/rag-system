import path from 'node:path';
import {
  FileMiroFishGraphArtifactStore,
  MIROFISH_GRAPH_ARTIFACT_LIMITS,
  MiroFishGraphStoreError,
  type MiroFishGraphArtifactStore,
} from './graph-artifact-store';
import type { RagTrustLevel } from '../security/retrieval-scope';

export interface MiroFishGraphArtifactRuntime {
  store: MiroFishGraphArtifactStore;
  trustLevel: RagTrustLevel;
  ttlMs?: number;
}

const runtimeStores = new Map<string, FileMiroFishGraphArtifactStore>();

export function getMiroFishGraphArtifactRuntime(
  env: NodeJS.ProcessEnv = process.env
): MiroFishGraphArtifactRuntime {
  const configuredRoot = env.RAG_MIROFISH_GRAPH_STORE_ROOT?.trim();
  const rootDir = configuredRoot
    ? path.resolve(/*turbopackIgnore: true*/ configuredRoot)
    : path.join(process.cwd(), 'uploads', 'mirofish-graph-artifacts-v2');
  const capacity = resolveMiroFishGraphStoreCapacity(env);
  const storeKey = JSON.stringify([rootDir, capacity]);
  let store = runtimeStores.get(storeKey);
  if (!store) {
    store = new FileMiroFishGraphArtifactStore(rootDir, capacity);
    runtimeStores.set(storeKey, store);
  }
  assertMiroFishGraphControlPlaneTopology(store, env);
  return {
    store,
    trustLevel: resolveMiroFishGraphIngestTrustLevel(env),
    ...resolveMiroFishGraphTtl(env),
  };
}

export function assertMiroFishGraphControlPlaneTopology(
  store: Pick<MiroFishGraphArtifactStore, 'coordination'>,
  env: NodeJS.ProcessEnv = process.env
): void {
  const requiresSharedControlPlane =
    readBooleanFlag(env.RAG_MIROFISH_GRAPH_MULTI_INSTANCE, 'RAG_MIROFISH_GRAPH_MULTI_INSTANCE')
    || readBooleanFlag(
      env.RAG_MIROFISH_GRAPH_REQUIRE_SHARED_CONTROL_PLANE,
      'RAG_MIROFISH_GRAPH_REQUIRE_SHARED_CONTROL_PLANE'
    );
  if (requiresSharedControlPlane && store.coordination !== 'shared') {
    throw new MiroFishGraphStoreError(
      'MIROFISH_GRAPH_SHARED_STORE_REQUIRED',
      'MiroFish graph multi-instance mode requires a shared transactional control plane.'
    );
  }
}

export function resolveMiroFishGraphIngestTrustLevel(
  env: NodeJS.ProcessEnv = process.env
): RagTrustLevel {
  const value = env.RAG_MIROFISH_GRAPH_INGEST_TRUST_LEVEL?.trim() || 'external';
  if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(value)) {
    throw new Error('RAG_MIROFISH_GRAPH_INGEST_TRUST_LEVEL is invalid.');
  }
  return value as RagTrustLevel;
}

function resolveMiroFishGraphTtl(
  env: NodeJS.ProcessEnv
): { ttlMs?: number } {
  const value = env.RAG_MIROFISH_GRAPH_ARTIFACT_TTL_MS?.trim();
  if (!value) return {};
  const ttlMs = Number(value);
  if (
    !Number.isInteger(ttlMs)
    || ttlMs < 1
    || ttlMs > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxTtlMs
  ) {
    throw new Error('RAG_MIROFISH_GRAPH_ARTIFACT_TTL_MS is invalid.');
  }
  return { ttlMs };
}

export function resolveMiroFishGraphStoreCapacity(
  env: NodeJS.ProcessEnv = process.env
): {
  maxArtifacts: number;
  maxTotalBytes: number;
  maxScopeArtifacts: number;
  maxScopeBytes: number;
  maxTombstones: number;
  stagingReservationTtlMs: number;
} {
  const maxArtifacts = readCapacityInteger(
    env.RAG_MIROFISH_GRAPH_MAX_ARTIFACTS,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxArtifacts,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxArtifacts,
    'RAG_MIROFISH_GRAPH_MAX_ARTIFACTS'
  );
  const maxTotalBytes = readCapacityInteger(
    env.RAG_MIROFISH_GRAPH_MAX_TOTAL_BYTES,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxTotalBytes,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTotalBytes,
    'RAG_MIROFISH_GRAPH_MAX_TOTAL_BYTES'
  );
  const maxScopeArtifacts = readCapacityInteger(
    env.RAG_MIROFISH_GRAPH_MAX_SCOPE_ARTIFACTS,
    Math.min(MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxScopeArtifacts, maxArtifacts),
    Math.min(maxArtifacts, MIROFISH_GRAPH_ARTIFACT_LIMITS.maxListEntries),
    'RAG_MIROFISH_GRAPH_MAX_SCOPE_ARTIFACTS'
  );
  const maxScopeBytes = readCapacityInteger(
    env.RAG_MIROFISH_GRAPH_MAX_SCOPE_BYTES,
    Math.min(MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxScopeBytes, maxTotalBytes),
    maxTotalBytes,
    'RAG_MIROFISH_GRAPH_MAX_SCOPE_BYTES'
  );
  const maxTombstones = readCapacityInteger(
    env.RAG_MIROFISH_GRAPH_MAX_TOMBSTONES,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxTombstones,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTombstones,
    'RAG_MIROFISH_GRAPH_MAX_TOMBSTONES'
  );
  if (maxTombstones < maxArtifacts) {
    throw new Error('RAG_MIROFISH_GRAPH_MAX_TOMBSTONES is invalid.');
  }
  const stagingReservationTtlMs = readCapacityInteger(
    env.RAG_MIROFISH_GRAPH_STAGING_TTL_MS,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultStagingReservationTtlMs,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxStagingReservationTtlMs,
    'RAG_MIROFISH_GRAPH_STAGING_TTL_MS'
  );
  if (
    stagingReservationTtlMs
    < MIROFISH_GRAPH_ARTIFACT_LIMITS.minStagingReservationTtlMs
  ) {
    throw new Error('RAG_MIROFISH_GRAPH_STAGING_TTL_MS is invalid.');
  }
  return {
    maxArtifacts,
    maxTotalBytes,
    maxScopeArtifacts,
    maxScopeBytes,
    maxTombstones,
    stagingReservationTtlMs,
  };
}

function readCapacityInteger(
  rawValue: string | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const value = rawValue?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return parsed;
}

function readBooleanFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be true or false.`);
}
