import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, opendir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'path';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../security/retrieval-scope';
import { createRetrievalScope } from '../security/retrieval-scope';
import type { GraphData, GraphPassage } from './types';

export const MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION = 'mirofish-graph-artifact-v2' as const;
export const MIROFISH_GRAPH_ARTIFACT_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxNodes: 25_000,
  maxEdges: 100_000,
  maxPassages: 25_000,
  maxCommunities: 10_000,
  maxPassageCharacters: 10_000_000,
  maxSourceChunkReferences: 100_000,
  maxCommunityReferences: 100_000,
  maxDescriptorBytes: 8 * 1024,
  maxListEntries: 1_000,
  maxTtlMs: 365 * 24 * 60 * 60 * 1000,
  maxGcEntries: 100,
  defaultMaxArtifacts: 1_000,
  hardMaxArtifacts: 10_000,
  defaultMaxTotalBytes: 2 * 1024 * 1024 * 1024,
  hardMaxTotalBytes: 128 * 1024 * 1024 * 1024,
  defaultMaxScopeArtifacts: 200,
  defaultMaxScopeBytes: 512 * 1024 * 1024,
  maxActiveRevisionFiles: 32,
  retainedActiveRevisionFiles: 8,
  defaultMaxTombstones: 10_000,
  hardMaxTombstones: 100_000,
  defaultStagingReservationTtlMs: 15 * 60 * 1000,
  minStagingReservationTtlMs: 60 * 1000,
  maxStagingReservationTtlMs: 24 * 60 * 60 * 1000,
  maxStagingReconciliationsPerPass: 100,
  maxMaintenanceScanEntries: 300_000,
});

export interface MiroFishGraphArtifactIdentity {
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
}

export interface MiroFishGraphArtifact extends MiroFishGraphArtifactIdentity {
  schemaVersion: typeof MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION;
  graph: GraphData & {
    artifact_version: 'mirofish-graph-v2';
    passages: GraphPassage[];
  };
}

export interface MiroFishGraphArtifactDescriptor {
  identity: MiroFishGraphArtifactIdentity;
  artifactDigest: string;
  createdAt: string;
  graphName?: string;
  expiresAt?: string;
  nodeCount: number;
  edgeCount: number;
}

interface MiroFishGraphQuotaReservation {
  identity: MiroFishGraphArtifactIdentity;
  artifactBytes: number;
  reservedAt: string;
}

export interface MiroFishGraphActivePointer {
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>;
  identity: MiroFishGraphArtifactIdentity | null;
  revision: number;
  updatedAt: string;
}

export interface MiroFishGraphArtifactLifecycleOptions {
  graphName?: string;
  ttlMs?: number;
}

export interface MiroFishGraphArtifactListOptions {
  limit?: number;
}

export interface MiroFishGraphArtifactStore {
  readonly coordination: 'process' | 'shared';
  put(
    artifact: MiroFishGraphArtifact,
    options?: MiroFishGraphArtifactLifecycleOptions
  ): Promise<MiroFishGraphArtifactDescriptor>;
  get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null>;
  list(
    scope: RagRetrievalScope,
    options?: MiroFishGraphArtifactListOptions
  ): Promise<MiroFishGraphArtifactDescriptor[]>;
  delete(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean>;
  getActive(scope: RagRetrievalScope): Promise<MiroFishGraphActivePointer>;
  compareAndSetActive(
    scope: RagRetrievalScope,
    identity: MiroFishGraphArtifactIdentity | null,
    expectedRevision: number
  ): Promise<MiroFishGraphActivePointer>;
  gcExpired(
    scope: RagRetrievalScope,
    options?: MiroFishGraphArtifactListOptions
  ): Promise<number>;
}

export type MiroFishGraphStoreErrorCode =
  | 'MIROFISH_GRAPH_ARTIFACT_CONFLICT'
  | 'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT'
  | 'MIROFISH_GRAPH_ARTIFACT_ACTIVE'
  | 'MIROFISH_GRAPH_ARTIFACT_CAPACITY'
  | 'MIROFISH_GRAPH_SHARED_STORE_REQUIRED';

export class MiroFishGraphStoreError extends Error {
  readonly code: MiroFishGraphStoreErrorCode;

  constructor(code: MiroFishGraphStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MiroFishGraphStoreError';
    this.code = code;
  }
}

/**
 * Resource gate shared by durable artifacts and the legacy TaskManager result.
 * It intentionally runs before either store retains the graph, including for
 * direct library callers that do not yet have a full retrieval identity.
 */
export function assertMiroFishGraphDataResourceLimits(graph: GraphData): void {
  if (!isRecord(graph)) {
    throw new Error('Graph artifact must contain a graph object.');
  }
  if (!Array.isArray(graph.nodes)
    || graph.nodes.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes) {
    throw new Error('Graph artifact node count exceeds the configured limit.');
  }
  if (!Array.isArray(graph.edges)
    || graph.edges.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges) {
    throw new Error('Graph artifact edge count exceeds the configured limit.');
  }
  if (!Array.isArray(graph.passages)) {
    throw new Error('Graph artifact is missing source passages.');
  }
  if (graph.passages.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages) {
    throw new Error('Graph artifact passage count exceeds the configured limit.');
  }
  if (graph.communities !== undefined && !Array.isArray(graph.communities)) {
    throw new Error('Graph artifact communities must be an array.');
  }
  if ((graph.communities?.length ?? 0) > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunities) {
    throw new Error('Graph artifact community count exceeds the configured limit.');
  }

  let passageCharacters = 0;
  for (const passage of graph.passages) {
    if (!isRecord(passage) || typeof passage.content !== 'string') {
      throw new Error('Graph artifact contains a malformed passage.');
    }
    passageCharacters += passage.content.length;
    assertAggregateReferenceBudget(
      passageCharacters,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassageCharacters,
      'passage text'
    );
  }

  let sourceChunkReferenceCount = 0;
  for (const item of [...graph.nodes, ...graph.edges]) {
    if (!isRecord(item) || !isRecord(item.attributes)) {
      throw new Error('Graph artifact contains malformed source passage references.');
    }
    const sourceChunks = item.attributes.sourceChunks;
    if (sourceChunks === undefined) continue;
    if (!Array.isArray(sourceChunks)) {
      throw new Error('Graph artifact contains malformed source passage references.');
    }
    sourceChunkReferenceCount += sourceChunks.length;
    assertAggregateReferenceBudget(
      sourceChunkReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxSourceChunkReferences,
      'source passage'
    );
  }

  let communityReferenceCount = 0;
  for (const community of graph.communities ?? []) {
    if (!isRecord(community)
      || !Array.isArray(community.entities)
      || !Array.isArray(community.relations)) {
      throw new Error('Graph artifact contains malformed community references.');
    }
    communityReferenceCount += community.entities.length + community.relations.length;
    assertAggregateReferenceBudget(
      communityReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunityReferences,
      'community member'
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(graph);
  } catch (error) {
    throw new Error('Graph artifact cannot be safely serialized.', { cause: error });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes) {
    throw new Error('Graph artifact serialized bytes exceed the configured limit.');
  }
}

/**
 * Converts the compatibility GraphData object into a scope-bound retrieval artifact.
 * Missing security fields are stamped; conflicting fields are rejected rather than overwritten.
 */
export function createMiroFishGraphArtifact(input: {
  identity: MiroFishGraphArtifactIdentity;
  graph: GraphData;
}): MiroFishGraphArtifact {
  const identity = normalizeIdentity(input.identity);
  if (input.graph.graph_id !== identity.documentId) {
    throw new Error('Graph artifact document identity does not match graph_id.');
  }
  if (input.graph.artifact_version !== 'mirofish-graph-v2') {
    throw new Error('Graph artifact must use the mirofish-graph-v2 graph format.');
  }
  if (!Array.isArray(input.graph.passages)) {
    throw new Error('Graph artifact must retain source passages.');
  }

  const passages = input.graph.passages.map(passage =>
    bindPassageToIdentity(passage, identity)
  );
  const artifact: MiroFishGraphArtifact = {
    schemaVersion: MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION,
    ...identity,
    graph: {
      ...clone(input.graph),
      artifact_version: 'mirofish-graph-v2',
      passages,
    },
  };
  assertGraphArtifact(artifact);
  return artifact;
}

/**
 * Hermetic store for lane wiring and tests. Production persistence can implement
 * the same port without weakening the exact scope + version lookup contract.
 */
export class InMemoryMiroFishGraphArtifactStore implements MiroFishGraphArtifactStore {
  readonly coordination = 'process' as const;
  private readonly artifacts = new Map<
    string,
    { artifact: MiroFishGraphArtifact; descriptor: MiroFishGraphArtifactDescriptor }
  >();
  private readonly tombstones = new Set<string>();
  private readonly activePointers = new Map<string, MiroFishGraphActivePointer>();
  private readonly now: () => number;
  private readonly maxTombstones: number;

  constructor(options: { now?: () => number; maxTombstones?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxTombstones = options.maxTombstones
      ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxTombstones;
    assertGraphCapacityLimit(
      this.maxTombstones,
      1,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTombstones,
      'tombstone count'
    );
  }

  async put(
    artifact: MiroFishGraphArtifact,
    options: MiroFishGraphArtifactLifecycleOptions = {}
  ): Promise<MiroFishGraphArtifactDescriptor> {
    assertGraphArtifact(artifact);
    const normalized = clone(artifact);
    const key = createArtifactKey(normalized);
    if (this.tombstones.has(key)) {
      throw graphStoreConflict('A tombstoned graph artifact identity cannot be reused.');
    }
    const descriptor = createArtifactDescriptor(normalized, options, this.now());
    const existing = this.artifacts.get(key);
    if (existing) {
      if (existing.descriptor.artifactDigest !== descriptor.artifactDigest) {
        throw graphStoreConflict('Graph artifact identity already contains different content.');
      }
      return clone(existing.descriptor);
    }
    assertGraphTombstoneCapacity(this.tombstones.size, this.maxTombstones);
    this.artifacts.set(key, { artifact: normalized, descriptor });
    return clone(descriptor);
  }

  async get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null> {
    const normalized = normalizeIdentity(identity);
    return this.readAvailableArtifact(normalized, scope);
  }

  private readAvailableArtifact(
    normalized: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): MiroFishGraphArtifact | null {
    assertIdentityWithinScope(normalized, scope);
    const key = createArtifactKey(normalized);
    if (this.tombstones.has(key)) return null;
    const entry = this.artifacts.get(key);
    if (!entry || isDescriptorExpired(entry.descriptor, this.now())) return null;
    assertArtifactAllowed(entry.artifact, normalized, scope);
    return clone(entry.artifact);
  }

  async list(
    scope: RagRetrievalScope,
    options: MiroFishGraphArtifactListOptions = {}
  ): Promise<MiroFishGraphArtifactDescriptor[]> {
    const limit = resolveGraphListLimit(options.limit);
    return [...this.artifacts.values()]
      .map(entry => entry.descriptor)
      .filter(descriptor =>
        descriptor.identity.tenantId === scope.tenantId
        && descriptor.identity.corpusId === scope.corpusId
        && scope.allowedTrustLevels.includes(descriptor.identity.trustLevel)
        && !this.tombstones.has(createArtifactKey(descriptor.identity))
        && !isDescriptorExpired(descriptor, this.now())
      )
      .sort(compareGraphDescriptors)
      .slice(0, limit)
      .map(clone);
  }

  async delete(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const normalized = normalizeIdentity(identity);
    assertManagementIdentityWithinScope(normalized, scope);
    // Keep management mutations synchronous until their state transition is
    // committed. Awaiting an already-resolved helper here would still yield a
    // microtask and let CAS activation race past the delete fence.
    const active = this.readActivePointer(scope);
    if (active.identity && sameArtifactIdentity(active.identity, normalized)) {
      throw new MiroFishGraphStoreError(
        'MIROFISH_GRAPH_ARTIFACT_ACTIVE',
        'Active graph artifacts must be deactivated before deletion.'
      );
    }
    const key = createArtifactKey(normalized);
    if (!this.artifacts.has(key) || this.tombstones.has(key)) return false;
    assertGraphTombstoneCapacity(this.tombstones.size, this.maxTombstones);
    this.tombstones.add(key);
    this.artifacts.delete(key);
    return true;
  }

  async getActive(scope: RagRetrievalScope): Promise<MiroFishGraphActivePointer> {
    return this.readActivePointer(scope);
  }

  private readActivePointer(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
  ): MiroFishGraphActivePointer {
    const key = createScopeKey(scope);
    return clone(this.activePointers.get(key) ?? createEmptyActivePointer(scope));
  }

  async compareAndSetActive(
    scope: RagRetrievalScope,
    identity: MiroFishGraphArtifactIdentity | null,
    expectedRevision: number
  ): Promise<MiroFishGraphActivePointer> {
    assertActiveRevision(expectedRevision);
    const current = this.readActivePointer(scope);
    if (current.revision !== expectedRevision) {
      throw activeRevisionConflict();
    }
    let normalizedIdentity: MiroFishGraphArtifactIdentity | null = null;
    if (identity) {
      normalizedIdentity = normalizeIdentity(identity);
      assertManagementIdentityWithinScope(normalizedIdentity, scope);
      if (normalizedIdentity.trustLevel === 'quarantined') {
        throw new Error('Quarantined graph artifacts cannot be activated.');
      }
      const artifact = this.readAvailableArtifact(normalizedIdentity, scope);
      if (!artifact) {
        throw new Error('Graph artifact is not available for activation.');
      }
    }
    const pointer: MiroFishGraphActivePointer = {
      scope: normalizeScopeIdentity(scope),
      identity: normalizedIdentity,
      revision: current.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.activePointers.set(createScopeKey(scope), pointer);
    return clone(pointer);
  }

  async gcExpired(
    scope: RagRetrievalScope,
    options: MiroFishGraphArtifactListOptions = {}
  ): Promise<number> {
    const limit = Math.min(
      resolveGraphListLimit(options.limit),
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxGcEntries
    );
    const expired = [...this.artifacts.values()]
      .map(entry => entry.descriptor)
      .filter(descriptor =>
        descriptor.identity.tenantId === scope.tenantId
        && descriptor.identity.corpusId === scope.corpusId
        && isDescriptorExpired(descriptor, this.now())
      )
      .sort(compareGraphDescriptors)
      .slice(0, limit);
    let deleted = 0;
    for (const descriptor of expired) {
      const active = await this.getActive(scope);
      if (active.identity && sameArtifactIdentity(active.identity, descriptor.identity)) {
        await this.compareAndSetActive(scope, null, active.revision);
      }
      if (await this.delete(descriptor.identity, scope)) deleted += 1;
    }
    return deleted;
  }
}

/** Durable local adapter. Keys are hashed before path construction to prevent path traversal. */
export class FileMiroFishGraphArtifactStore implements MiroFishGraphArtifactStore {
  readonly coordination = 'process' as const;
  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly maxArtifacts: number;
  private readonly maxTotalBytes: number;
  private readonly maxScopeArtifacts: number;
  private readonly maxScopeBytes: number;
  private readonly maxTombstones: number;
  private readonly stagingReservationTtlMs: number;
  private readonly cleanupFile: (file: string) => Promise<void>;
  private readonly now: () => number;

  constructor(
    rootDir = path.join(process.cwd(), 'uploads', 'mirofish-graph-artifacts-v2'),
    options: {
      maxFileBytes?: number;
      maxArtifacts?: number;
      maxTotalBytes?: number;
      maxScopeArtifacts?: number;
      maxScopeBytes?: number;
      maxTombstones?: number;
      stagingReservationTtlMs?: number;
      cleanupFile?: (file: string) => Promise<void>;
      now?: () => number;
    } = {}
  ) {
    this.rootDir = path.resolve(rootDir);
    this.maxFileBytes = options.maxFileBytes ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes;
    this.maxArtifacts = options.maxArtifacts
      ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxArtifacts;
    this.maxTotalBytes = options.maxTotalBytes
      ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxTotalBytes;
    this.maxScopeArtifacts = options.maxScopeArtifacts
      ?? Math.min(
        MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxScopeArtifacts,
        this.maxArtifacts
      );
    this.maxScopeBytes = options.maxScopeBytes
      ?? Math.min(
        MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxScopeBytes,
        this.maxTotalBytes
      );
    this.maxTombstones = options.maxTombstones
      ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultMaxTombstones;
    this.stagingReservationTtlMs = options.stagingReservationTtlMs
      ?? MIROFISH_GRAPH_ARTIFACT_LIMITS.defaultStagingReservationTtlMs;
    this.cleanupFile = options.cleanupFile ?? safeUnlink;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxFileBytes) || this.maxFileBytes < 1
      || this.maxFileBytes > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes) {
      throw new Error('Graph artifact file limit is outside the allowed range.');
    }
    assertGraphCapacityLimit(
      this.maxArtifacts,
      1,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxArtifacts,
      'artifact count'
    );
    assertGraphCapacityLimit(
      this.maxTotalBytes,
      1,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTotalBytes,
      'total byte'
    );
    assertGraphCapacityLimit(
      this.maxScopeArtifacts,
      1,
      Math.min(this.maxArtifacts, MIROFISH_GRAPH_ARTIFACT_LIMITS.maxListEntries),
      'scope artifact count'
    );
    assertGraphCapacityLimit(
      this.maxScopeBytes,
      1,
      this.maxTotalBytes,
      'scope byte'
    );
    assertGraphCapacityLimit(
      this.maxTombstones,
      this.maxArtifacts,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTombstones,
      'tombstone count'
    );
    assertGraphCapacityLimit(
      this.stagingReservationTtlMs,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.minStagingReservationTtlMs,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxStagingReservationTtlMs,
      'staging reservation TTL'
    );
  }

  async put(
    artifact: MiroFishGraphArtifact,
    options: MiroFishGraphArtifactLifecycleOptions = {}
  ): Promise<MiroFishGraphArtifactDescriptor> {
    assertGraphArtifact(artifact);
    const normalized = clone(artifact);
    const descriptor = createArtifactDescriptor(normalized, options, this.now());
    const artifactFile = this.getArtifactFile(normalized);
    const descriptorFile = this.getDescriptorFile(normalized);
    const serialized = JSON.stringify(normalized, null, 2);
    const artifactBytes = Buffer.byteLength(serialized, 'utf8');
    if (artifactBytes > this.maxFileBytes) {
      throw new Error('Graph artifact exceeds the configured file byte limit.');
    }

    const writerKey = createGraphWriterKey(this.rootDir, normalized);
    retainActiveGraphWriter(writerKey);
    try {
      return await withFileGraphStoreLock(this.getRootLockKey(), async () => {
        if (await fileExists(this.getTombstoneFile(normalized))) {
          throw graphStoreConflict('A tombstoned graph artifact identity cannot be reused.');
        }
        await this.reconcileStaleStaging();

      let reservationCreated = false;
      let artifactCreated = false;
      try {
        reservationCreated = await this.reserveCapacity(normalized, artifactBytes);
        artifactCreated = await this.publishImmutableFile(artifactFile, serialized);
        if (!artifactCreated) {
          const existing = JSON.parse(
            await readBoundedArtifactFile(artifactFile, this.maxFileBytes)
          ) as MiroFishGraphArtifact;
          assertGraphArtifact(existing);
          if (createArtifactDigest(existing) !== descriptor.artifactDigest) {
            throw graphStoreConflict(
              'Graph artifact identity already contains different content.'
            );
          }
        }

        const existingDescriptor = await readOptionalGraphDescriptor(descriptorFile);
        if (existingDescriptor) {
          if (
            !sameArtifactIdentity(existingDescriptor.identity, normalized)
            || existingDescriptor.artifactDigest !== descriptor.artifactDigest
          ) {
            throw graphStoreConflict('Graph artifact catalog contains conflicting content.');
          }
          return clone(existingDescriptor);
        }

        const descriptorCreated = await this.publishImmutableFile(
          descriptorFile,
          JSON.stringify(descriptor, null, 2)
        );
        if (!descriptorCreated) {
          const racedDescriptor = await readOptionalGraphDescriptor(descriptorFile);
          if (
            !racedDescriptor
            || !sameArtifactIdentity(racedDescriptor.identity, normalized)
            || racedDescriptor.artifactDigest !== descriptor.artifactDigest
          ) {
            throw graphStoreConflict('Graph artifact catalog publication conflicted.');
          }
          return clone(racedDescriptor);
        }
        return clone(descriptor);
      } catch (error) {
        let committedDescriptor: MiroFishGraphArtifactDescriptor | null = null;
        try {
          committedDescriptor = await readOptionalGraphDescriptor(descriptorFile);
        } catch {
          // The original publication error remains authoritative.
        }
        if (
          committedDescriptor
          && sameArtifactIdentity(committedDescriptor.identity, normalized)
          && committedDescriptor.artifactDigest === descriptor.artifactDigest
        ) {
          return clone(committedDescriptor);
        }

        // Only remove files this invocation won. A pre-existing artifact may be a
        // concurrent winner and must never be unlinked by a failed descriptor publish.
        if (artifactCreated) await safeUnlink(artifactFile);
        if (reservationCreated) {
          await safeUnlink(this.getQuotaReservationFile(normalized));
        }
        throw error;
      }
      });
    } finally {
      releaseActiveGraphWriter(writerKey);
    }
  }

  async get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null> {
    const normalized = normalizeIdentity(identity);
    assertIdentityWithinScope(normalized, scope);
    try {
      if (await fileExists(this.getTombstoneFile(normalized))) return null;
      const descriptor = await readOptionalGraphDescriptor(
        this.getDescriptorFile(normalized)
      );
      if (!descriptor) return null;
      assertManagementIdentityWithinScope(descriptor.identity, scope);
      if (!sameArtifactIdentity(descriptor.identity, normalized)) {
        throw new Error('Graph artifact descriptor identity does not match its path.');
      }
      if (isDescriptorExpired(descriptor, this.now())) return null;
      const value = JSON.parse(
        await readBoundedArtifactFile(this.getArtifactFile(normalized), this.maxFileBytes)
      ) as MiroFishGraphArtifact;
      assertArtifactAllowed(value, normalized, scope);
      if (descriptor.artifactDigest !== createArtifactDigest(value)) {
        throw new Error('Graph artifact digest does not match its catalog descriptor.');
      }
      return clone(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw new Error('Graph artifact store rejected an unreadable or invalid artifact.', {
        cause: error,
      });
    }
  }

  async list(
    scope: RagRetrievalScope,
    options: MiroFishGraphArtifactListOptions = {}
  ): Promise<MiroFishGraphArtifactDescriptor[]> {
    return this.readDescriptors(scope, {
      limit: resolveGraphListLimit(options.limit),
      includeExpired: false,
    });
  }

  async delete(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    const normalized = normalizeIdentity(identity);
    assertManagementIdentityWithinScope(normalized, scope);
    return withFileGraphStoreLock(this.getRootLockKey(), () =>
      withFileGraphStoreLock(this.getLockKey(normalized), async () => {
        const active = await this.getActive(scope);
        if (active.identity && sameArtifactIdentity(active.identity, normalized)) {
          throw new MiroFishGraphStoreError(
            'MIROFISH_GRAPH_ARTIFACT_ACTIVE',
            'Active graph artifacts must be deactivated before deletion.'
          );
        }
        const artifactFile = this.getArtifactFile(normalized);
        const descriptorFile = this.getDescriptorFile(normalized);
        const quotaFile = this.getQuotaReservationFile(normalized);
        const tombstoneFile = this.getTombstoneFile(normalized);
        const hasRetainedFiles = await fileExists(artifactFile)
          || await fileExists(descriptorFile)
          || await fileExists(quotaFile);
        const hasTombstone = await fileExists(tombstoneFile);
        if (!hasRetainedFiles && !hasTombstone) return false;

        if (!hasTombstone) {
          await this.assertTombstoneCapacityAvailable();
          const tombstone = JSON.stringify({
            identity: normalized,
            deletedAt: new Date(this.now()).toISOString(),
          });
          await this.publishImmutableFile(tombstoneFile, tombstone);
        }
        // A tombstone is the durable delete intent. Retrying after a partial
        // cleanup must continue releasing bytes and the capacity reservation.
        await safeUnlink(descriptorFile);
        await safeUnlink(artifactFile);
        await safeUnlink(quotaFile);
        return hasRetainedFiles;
      })
    );
  }
  async getActive(scope: RagRetrievalScope): Promise<MiroFishGraphActivePointer> {
    const directory = this.getActiveDirectory(scope);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return createEmptyActivePointer(scope);
      }
      throw error;
    }
    const revisionFiles = entries.filter(entry => /^\d{16}\.json$/.test(entry));
    if (revisionFiles.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxActiveRevisionFiles) {
      throw new Error('Graph active pointer history exceeds the bounded scan limit.');
    }
    revisionFiles.sort().reverse();
    if (revisionFiles.length === 0) return createEmptyActivePointer(scope);
    const pointer = await readGraphActivePointer(
      path.join(directory, revisionFiles[0])
    );
    const expectedScope = normalizeScopeIdentity(scope);
    if (
      pointer.scope.tenantId !== expectedScope.tenantId
      || pointer.scope.corpusId !== expectedScope.corpusId
    ) {
      throw new Error('Graph active pointer scope does not match its catalog path.');
    }
    if (pointer.identity) {
      assertManagementIdentityWithinScope(pointer.identity, scope);
    }
    return pointer;
  }

  async compareAndSetActive(
    scope: RagRetrievalScope,
    identity: MiroFishGraphArtifactIdentity | null,
    expectedRevision: number
  ): Promise<MiroFishGraphActivePointer> {
    assertActiveRevision(expectedRevision);
    return withFileGraphStoreLock(this.getLockKey(scope), async () => {
      const current = await this.getActive(scope);
      if (current.revision !== expectedRevision) {
        throw activeRevisionConflict();
      }
      let normalizedIdentity: MiroFishGraphArtifactIdentity | null = null;
      if (identity) {
        normalizedIdentity = normalizeIdentity(identity);
        assertManagementIdentityWithinScope(normalizedIdentity, scope);
        if (normalizedIdentity.trustLevel === 'quarantined') {
          throw new Error('Quarantined graph artifacts cannot be activated.');
        }
        const artifact = await this.get(normalizedIdentity, scope);
        if (!artifact) {
          throw new Error('Graph artifact is not available for activation.');
        }
      }
      const pointer: MiroFishGraphActivePointer = {
        scope: normalizeScopeIdentity(scope),
        identity: normalizedIdentity,
        revision: current.revision + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      const created = await this.publishImmutableFile(
        this.getActiveFile(scope, pointer.revision),
        JSON.stringify(pointer, null, 2)
      );
      if (!created) throw activeRevisionConflict();
      try {
        await this.compactActiveRevisions(scope);
      } catch {
        // The revision file is already the committed pointer.
      }
      return clone(pointer);
    });
  }

  async gcExpired(
    scope: RagRetrievalScope,
    options: MiroFishGraphArtifactListOptions = {}
  ): Promise<number> {
    const limit = Math.min(
      resolveGraphListLimit(options.limit),
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxGcEntries
    );
    const descriptors = await this.readDescriptors(scope, {
      limit: MIROFISH_GRAPH_ARTIFACT_LIMITS.maxListEntries,
      includeExpired: true,
    });
    const expired = descriptors
      .filter(descriptor => isDescriptorExpired(descriptor, this.now()))
      .slice(0, limit);
    let deleted = 0;
    for (const descriptor of expired) {
      const active = await this.getActive(scope);
      if (active.identity && sameArtifactIdentity(active.identity, descriptor.identity)) {
        await this.compareAndSetActive(scope, null, active.revision);
      }
      if (await this.delete(descriptor.identity, scope)) deleted += 1;
    }
    return deleted;
  }

  private async readDescriptors(
    scope: RagRetrievalScope,
    options: { limit: number; includeExpired: boolean }
  ): Promise<MiroFishGraphArtifactDescriptor[]> {
    const directory = this.getCatalogDirectory(scope);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    if (entries.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxListEntries) {
      throw new Error('Graph artifact catalog exceeds the bounded scan limit.');
    }
    const descriptors: MiroFishGraphArtifactDescriptor[] = [];
    for (const entry of entries.filter(value => value.endsWith('.json'))) {
      const descriptor = await readOptionalGraphDescriptor(path.join(directory, entry));
      if (!descriptor) continue;
      assertManagementIdentityWithinScope(descriptor.identity, scope);
      if (await fileExists(this.getTombstoneFile(descriptor.identity))) continue;
      if (!scope.allowedTrustLevels.includes(descriptor.identity.trustLevel)) continue;
      if (!options.includeExpired && isDescriptorExpired(descriptor, this.now())) continue;
      descriptors.push(descriptor);
    }
    return descriptors.sort(compareGraphDescriptors).slice(0, options.limit).map(clone);
  }

  private async compactActiveRevisions(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
  ): Promise<void> {
    const directory = this.getActiveDirectory(scope);
    const entries = (await readdir(directory))
      .filter(entry => /^\d{16}\.json$/.test(entry))
      .sort()
      .reverse();
    for (
      const entry of entries.slice(
        MIROFISH_GRAPH_ARTIFACT_LIMITS.retainedActiveRevisionFiles
      )
    ) {
      await bestEffortCleanupFile(path.join(directory, entry), this.cleanupFile);
    }
  }


  private publishImmutableFile(
    file: string,
    serialized: string
  ): Promise<boolean> {
    return publishImmutableFile(file, serialized, {
      now: this.now,
      cleanupFile: this.cleanupFile,
    });
  }

  private async assertTombstoneCapacityAvailable(): Promise<void> {
    assertGraphTombstoneCapacity(
      await this.countTombstones(),
      this.maxTombstones
    );
  }

  private async countTombstones(): Promise<number> {
    let scopeEntries;
    try {
      scopeEntries = await readdir(
        path.join(this.rootDir, 'tombstones'),
        { withFileTypes: true }
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return 0;
      throw error;
    }

    const scopeDirectories = scopeEntries.filter(entry =>
      /^[a-f0-9]{64}$/.test(entry.name)
    );
    if (scopeDirectories.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTombstones) {
      throw graphStoreCapacity('Graph tombstone catalog exceeds its hard scan limit.');
    }

    let tombstoneCount = 0;
    for (const scopeEntry of scopeDirectories) {
      let entries;
      try {
        entries = await readdir(
          path.join(this.rootDir, 'tombstones', scopeEntry.name),
          { withFileTypes: true }
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        tombstoneCount += 1;
        if (
          tombstoneCount
          > MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxTombstones
        ) {
          throw graphStoreCapacity(
            'Graph tombstone catalog exceeds its hard scan limit.'
          );
        }
      }
    }
    return tombstoneCount;
  }

  private async reconcileStaleStaging(): Promise<void> {
    const reservations = await this.readQuotaReservations();
    let reconciled = 0;
    for (const reservation of reservations) {
      if (
        reconciled
        >= MIROFISH_GRAPH_ARTIFACT_LIMITS.maxStagingReconciliationsPerPass
      ) {
        break;
      }
      const ageMs = this.now() - Date.parse(reservation.reservedAt);
      if (!Number.isFinite(ageMs) || ageMs < this.stagingReservationTtlMs) {
        continue;
      }
      const writerKey = createGraphWriterKey(this.rootDir, reservation.identity);
      if (isActiveGraphWriter(writerKey)) continue;
      if (await fileExists(this.getDescriptorFile(reservation.identity))) continue;

      try {
        // Reservation removal is last: a partial cleanup remains fail-closed and
        // is retried on the next bounded reconciliation pass.
        await safeUnlink(this.getArtifactFile(reservation.identity));
        await safeUnlink(this.getQuotaReservationFile(reservation.identity));
        reconciled += 1;
      } catch {
        // A retained reservation continues to account for capacity.
      }
    }
    await this.reconcileStaleTemporaryFiles();
  }

  private async reconcileStaleTemporaryFiles(): Promise<void> {
    const pending = [{ directory: this.rootDir, depth: 0 }];
    let scannedEntries = 0;
    let reconciled = 0;

    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      let directoryHandle: Awaited<ReturnType<typeof opendir>>;
      try {
        directoryHandle = await opendir(current.directory);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue;
        throw error;
      }

      for await (const entry of directoryHandle) {
        scannedEntries += 1;
        if (
          scannedEntries
          > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxMaintenanceScanEntries
        ) {
          throw graphStoreCapacity(
            'Graph artifact maintenance scan exceeds its hard limit.'
          );
        }
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < 4) {
            pending.push({ directory: entryPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
        const resolvedPath = path.resolve(entryPath);
        if (activeGraphTemporaryFiles.has(resolvedPath)) continue;

        let fileStat;
        try {
          fileStat = await stat(resolvedPath);
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') continue;
          throw error;
        }
        const ageMs = this.now() - fileStat.mtimeMs;
        if (!Number.isFinite(ageMs) || ageMs < this.stagingReservationTtlMs) {
          continue;
        }
        await bestEffortCleanupFile(resolvedPath, safeUnlink);
        reconciled += 1;
        if (
          reconciled
          >= MIROFISH_GRAPH_ARTIFACT_LIMITS.maxStagingReconciliationsPerPass
        ) {
          return;
        }
      }
    }
  }

  private async reserveCapacity(
    identity: MiroFishGraphArtifactIdentity,
    artifactBytes: number
  ): Promise<boolean> {
    const reservationFile = this.getQuotaReservationFile(identity);
    const existing = await readOptionalGraphQuotaReservation(reservationFile);
    if (existing) {
      assertMatchingQuotaReservation(existing, identity, artifactBytes);
      return false;
    }

    await this.assertTombstoneCapacityAvailable();
    const reservations = await this.readQuotaReservations();
    const scopeReservations = reservations.filter(reservation =>
      reservation.identity.tenantId === identity.tenantId
      && reservation.identity.corpusId === identity.corpusId
    );
    const totalBytes = reservations.reduce(
      (total, reservation) => total + reservation.artifactBytes,
      0
    );
    const scopeBytes = scopeReservations.reduce(
      (total, reservation) => total + reservation.artifactBytes,
      0
    );
    if (
      reservations.length + 1 > this.maxArtifacts
      || totalBytes + artifactBytes > this.maxTotalBytes
      || scopeReservations.length + 1 > this.maxScopeArtifacts
      || scopeBytes + artifactBytes > this.maxScopeBytes
    ) {
      throw new MiroFishGraphStoreError(
        'MIROFISH_GRAPH_ARTIFACT_CAPACITY',
        'Graph artifact storage capacity is exhausted.'
      );
    }

    const reservation: MiroFishGraphQuotaReservation = {
      identity: normalizeIdentity(identity),
      artifactBytes,
      reservedAt: new Date(this.now()).toISOString(),
    };
    const created = await this.publishImmutableFile(
      reservationFile,
      JSON.stringify(reservation, null, 2)
    );
    if (!created) {
      const raced = await readOptionalGraphQuotaReservation(reservationFile);
      if (!raced) {
        throw graphStoreConflict('Graph artifact capacity reservation conflicted.');
      }
      assertMatchingQuotaReservation(raced, identity, artifactBytes);
    }
    return created;
  }

  private async readQuotaReservations(): Promise<MiroFishGraphQuotaReservation[]> {
    let entries: string[];
    try {
      entries = await readdir(this.getQuotaReservationDirectory());
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const reservationFiles = entries.filter(entry => entry.endsWith('.json'));
    if (reservationFiles.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.hardMaxArtifacts) {
      throw new MiroFishGraphStoreError(
        'MIROFISH_GRAPH_ARTIFACT_CAPACITY',
        'Graph artifact capacity index exceeds its hard scan limit.'
      );
    }
    const reservations: MiroFishGraphQuotaReservation[] = [];
    for (const entry of reservationFiles) {
      const reservation = await readOptionalGraphQuotaReservation(
        path.join(this.getQuotaReservationDirectory(), entry)
      );
      if (reservation) reservations.push(reservation);
    }
    return reservations;
  }

  private getQuotaReservationDirectory(): string {
    return path.join(this.rootDir, 'quota', 'entries');
  }

  private getQuotaReservationFile(identity: MiroFishGraphArtifactIdentity): string {
    return path.join(
      this.getQuotaReservationDirectory(),
      `${createIdentityDigest(identity)}.json`
    );
  }

  private getRootLockKey(): string {
    return `${this.rootDir}:root`;
  }

  private getArtifactFile(identity: MiroFishGraphArtifactIdentity): string {
    const digest = createIdentityDigest(identity);
    return path.join(this.rootDir, digest.slice(0, 2), `${digest}.json`);
  }

  private getCatalogDirectory(scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>): string {
    return path.join(this.rootDir, 'index', createScopeDigest(scope));
  }

  private getDescriptorFile(identity: MiroFishGraphArtifactIdentity): string {
    return path.join(
      this.getCatalogDirectory(identity),
      `${createIdentityDigest(identity)}.json`
    );
  }

  private getTombstoneDirectory(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
  ): string {
    return path.join(this.rootDir, 'tombstones', createScopeDigest(scope));
  }

  private getTombstoneFile(identity: MiroFishGraphArtifactIdentity): string {
    return path.join(
      this.getTombstoneDirectory(identity),
      `${createIdentityDigest(identity)}.json`
    );
  }

  private getActiveDirectory(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
  ): string {
    return path.join(this.rootDir, 'active', createScopeDigest(scope));
  }

  private getActiveFile(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
    revision: number
  ): string {
    return path.join(
      this.getActiveDirectory(scope),
      `${String(revision).padStart(16, '0')}.json`
    );
  }

  private getLockKey(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
  ): string {
    return `${this.rootDir}:${createScopeDigest(scope)}`;
  }
}
export function assertArtifactAllowed(
  artifact: MiroFishGraphArtifact,
  identity: MiroFishGraphArtifactIdentity,
  scope: RagRetrievalScope
): void {
  assertGraphArtifact(artifact);
  assertIdentityWithinScope(identity, scope);
  for (const field of [
    'tenantId',
    'corpusId',
    'documentId',
    'documentVersion',
    'trustLevel',
  ] as const) {
    if (artifact[field] !== identity[field]) {
      throw new Error(`Graph artifact ${field} does not match the requested identity.`);
    }
  }
  if (artifact.trustLevel === 'quarantined') {
    throw new Error('Graph artifact is quarantined.');
  }
  if (!scope.allowedTrustLevels.includes(artifact.trustLevel)) {
    throw new Error('Graph artifact trust level is outside the retrieval scope.');
  }
}

function assertGraphArtifact(artifact: MiroFishGraphArtifact): void {
  if (!isRecord(artifact) || !isRecord(artifact.graph)) {
    throw new Error('Graph artifact must contain a graph object.');
  }
  if (artifact.schemaVersion !== MIROFISH_GRAPH_ARTIFACT_SCHEMA_VERSION) {
    throw new Error('Unsupported graph artifact schema version.');
  }
  const identity = normalizeIdentity(artifact);
  if (artifact.graph.graph_id !== identity.documentId) {
    throw new Error('Graph artifact document identity does not match graph_id.');
  }
  if (artifact.graph.artifact_version !== 'mirofish-graph-v2') {
    throw new Error('Graph artifact has an unsupported graph format.');
  }
  assertMiroFishGraphDataResourceLimits(artifact.graph);
  if (!Array.isArray(artifact.graph.nodes)
    || artifact.graph.nodes.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes) {
    throw new Error('Graph artifact node count exceeds the configured limit.');
  }
  if (!Array.isArray(artifact.graph.edges)
    || artifact.graph.edges.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges) {
    throw new Error('Graph artifact edge count exceeds the configured limit.');
  }
  if (!Array.isArray(artifact.graph.passages)) {
    throw new Error('Graph artifact is missing source passages.');
  }
  if (artifact.graph.passages.length > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages) {
    throw new Error('Graph artifact passage count exceeds the configured limit.');
  }
  if ((artifact.graph.communities?.length ?? 0) > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunities) {
    throw new Error('Graph artifact community count exceeds the configured limit.');
  }

  if (!Number.isInteger(artifact.graph.node_count)
    || artifact.graph.node_count !== artifact.graph.nodes.length) {
    throw new Error('Graph artifact node_count does not match its nodes.');
  }
  if (!Number.isInteger(artifact.graph.edge_count)
    || artifact.graph.edge_count !== artifact.graph.edges.length) {
    throw new Error('Graph artifact edge_count does not match its edges.');
  }

  const passageIds = new Set<string>();
  let passageCharacters = 0;
  for (const passage of artifact.graph.passages) {
    assertPassageShape(passage, identity);
    addUniqueId(passageIds, passage.id, 'passage');
    passageCharacters += passage.content.length;
    if (passageCharacters > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassageCharacters) {
      throw new Error('Graph artifact passage text exceeds the configured limit.');
    }
  }

  const nodesById = new Map<string, (typeof artifact.graph.nodes)[number]>();
  let sourceChunkReferenceCount = 0;
  for (const node of artifact.graph.nodes) {
    assertNodeShape(node);
    addUniqueId(nodesById, node.uuid, 'node', node);
    sourceChunkReferenceCount += assertSourceChunkReferences(
      node.attributes,
      passageIds,
      `node ${node.uuid}`
    );
    assertAggregateReferenceBudget(
      sourceChunkReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxSourceChunkReferences,
      'source passage'
    );
  }

  const edgesById = new Map<string, (typeof artifact.graph.edges)[number]>();
  for (const edge of artifact.graph.edges) {
    assertEdgeShape(edge);
    addUniqueId(edgesById, edge.uuid, 'edge', edge);
    if (!nodesById.has(edge.source_node_uuid) || !nodesById.has(edge.target_node_uuid)) {
      throw new Error(`Graph edge ${edge.uuid} references a missing endpoint node.`);
    }
    sourceChunkReferenceCount += assertSourceChunkReferences(
      edge.attributes,
      passageIds,
      `edge ${edge.uuid}`
    );
    assertAggregateReferenceBudget(
      sourceChunkReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxSourceChunkReferences,
      'source passage'
    );
  }

  const communities = artifact.graph.communities ?? [];
  if (!Array.isArray(communities)) {
    throw new Error('Graph artifact communities must be an array.');
  }
  const communityIds = new Set<string>();
  for (const community of communities) {
    assertCommunityShape(community);
    addUniqueId(communityIds, community.id, 'community');
  }
  let communityReferenceCount = 0;
  for (const community of communities) {
    communityReferenceCount += community.entities.length + community.relations.length;
    assertAggregateReferenceBudget(
      communityReferenceCount,
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxCommunityReferences,
      'community member'
    );
    for (const nodeId of community.entities) {
      if (!nodesById.has(nodeId)) {
        throw new Error(`Graph community ${community.id} references a missing node.`);
      }
    }
    for (const edgeId of community.relations) {
      if (!edgesById.has(edgeId)) {
        throw new Error(`Graph community ${community.id} references a missing edge.`);
      }
    }
    if (community.parent_id !== undefined) {
      if (community.parent_id === community.id || !communityIds.has(community.parent_id)) {
        throw new Error(`Graph community ${community.id} references an invalid parent.`);
      }
    }
  }
}

function bindPassageToIdentity(
  passage: GraphPassage,
  identity: MiroFishGraphArtifactIdentity
): GraphPassage {
  if (!isRecord(passage)) {
    throw new Error('Graph passage must be an object.');
  }
  if (!isNonEmptyIdentifier(passage.id)
    || typeof passage.content !== 'string'
    || !passage.content.trim()) {
    throw new Error('Graph passage must contain a non-empty identity and content.');
  }
  if (
    !Number.isInteger(passage.start_offset) ||
    !Number.isInteger(passage.end_offset) ||
    passage.start_offset < 0 ||
    passage.end_offset <= passage.start_offset
  ) {
    throw new Error('Graph passage contains an invalid source span.');
  }
  const fields = {
    document_id: identity.documentId,
    tenant_id: identity.tenantId,
    corpus_id: identity.corpusId,
    document_version: identity.documentVersion,
    trust_level: identity.trustLevel,
  } as const;
  for (const [field, expected] of Object.entries(fields)) {
    const actual = passage[field as keyof GraphPassage];
    if (actual !== undefined && actual !== expected) {
      throw new Error(`Graph passage ${field} conflicts with its artifact identity.`);
    }
  }
  const boundPassage = clone(passage);
  if (boundPassage.metadata) {
    const sanitizedMetadata = { ...boundPassage.metadata };
    for (const key of [
      'tenantId',
      'tenant_id',
      'corpusId',
      'corpus_id',
      'documentId',
      'document_id',
      'documentVersion',
      'document_version',
      'trustLevel',
      'trust_level',
      'ragScope',
      'actorId',
      'userId',
    ]) {
      delete sanitizedMetadata[key];
    }
    boundPassage.metadata = sanitizedMetadata;
  }
  return { ...boundPassage, ...fields };
}

function assertPassageShape(
  passage: GraphPassage,
  identity: MiroFishGraphArtifactIdentity
): void {
  bindPassageToIdentity(passage, identity);
  if (!Number.isInteger(passage.index) || passage.index < 0) {
    throw new Error(`Graph passage ${passage.id} contains an invalid index.`);
  }
  if (passage.document_id !== identity.documentId
    || passage.tenant_id !== identity.tenantId
    || passage.corpus_id !== identity.corpusId
    || passage.document_version !== identity.documentVersion
    || passage.trust_level !== identity.trustLevel) {
    throw new Error(`Graph passage ${passage.id} is missing its exact artifact identity.`);
  }
  if (passage.source !== undefined && !isNonEmptyString(passage.source)) {
    throw new Error(`Graph passage ${passage.id} contains an invalid source.`);
  }
  if (passage.page !== undefined
    && (!Number.isInteger(passage.page) || passage.page < 1)) {
    throw new Error(`Graph passage ${passage.id} contains an invalid page.`);
  }
  if (passage.section_path !== undefined) {
    assertStringArray(passage.section_path, `passage ${passage.id} section_path`);
  }
  if (passage.metadata !== undefined && !isRecord(passage.metadata)) {
    throw new Error(`Graph passage ${passage.id} contains invalid metadata.`);
  }
}

function assertNodeShape(node: MiroFishGraphArtifact['graph']['nodes'][number]): void {
  if (!isRecord(node)
    || !isNonEmptyIdentifier(node.uuid)
    || !isNonEmptyString(node.name)
    || typeof node.summary !== 'string'
    || !isRecord(node.attributes)) {
    throw new Error('Graph artifact contains a malformed node.');
  }
  assertStringArray(node.labels, `node ${node.uuid} labels`);
  assertOptionalString(node.created_at, `node ${node.uuid} created_at`);
}

function assertEdgeShape(edge: MiroFishGraphArtifact['graph']['edges'][number]): void {
  if (!isRecord(edge)
    || !isNonEmptyIdentifier(edge.uuid)
    || !isNonEmptyString(edge.name)
    || typeof edge.fact !== 'string'
    || !isNonEmptyString(edge.fact_type)
    || !isNonEmptyIdentifier(edge.source_node_uuid)
    || !isNonEmptyIdentifier(edge.target_node_uuid)
    || !isNonEmptyString(edge.source_node_name)
    || !isNonEmptyString(edge.target_node_name)
    || !isRecord(edge.attributes)) {
    throw new Error('Graph artifact contains a malformed edge.');
  }
  assertStringArray(edge.episodes, `edge ${edge.uuid} episodes`);
  for (const field of ['created_at', 'valid_at', 'invalid_at', 'expired_at'] as const) {
    assertOptionalString(edge[field], `edge ${edge.uuid} ${field}`);
  }
}

function assertCommunityShape(
  community: NonNullable<MiroFishGraphArtifact['graph']['communities']>[number]
): void {
  if (!isRecord(community)
    || !isNonEmptyIdentifier(community.id)
    || !isNonEmptyString(community.name)
    || typeof community.summary !== 'string'
    || !Number.isInteger(community.level)
    || community.level < 0) {
    throw new Error('Graph artifact contains a malformed community.');
  }
  assertIdentifierArray(
    community.entities,
    `community ${community.id} entities`,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes
  );
  assertIdentifierArray(
    community.relations,
    `community ${community.id} relations`,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges
  );
  assertStringArray(community.keywords, `community ${community.id} keywords`);
  assertOptionalIdentifier(community.parent_id, `community ${community.id} parent_id`);
}

function assertSourceChunkReferences(
  attributes: Record<string, unknown>,
  passageIds: ReadonlySet<string>,
  owner: string
): number {
  const sourceChunks = attributes.sourceChunks;
  if (sourceChunks === undefined) return 0;
  assertIdentifierArray(
    sourceChunks,
    `${owner} sourceChunks`,
    MIROFISH_GRAPH_ARTIFACT_LIMITS.maxPassages
  );
  const seen = new Set<string>();
  for (const passageId of sourceChunks) {
    if (seen.has(passageId)) {
      throw new Error(`Graph ${owner} contains a duplicate sourceChunks reference.`);
    }
    seen.add(passageId);
    if (!passageIds.has(passageId)) {
      throw new Error(`Graph ${owner} references a missing source passage.`);
    }
  }
  return sourceChunks.length;
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => !isNonEmptyString(item))) {
    throw new Error(`Graph ${field} must be an array of non-empty strings.`);
  }
}

function assertIdentifierArray(
  value: unknown,
  field: string,
  maxEntries = Number.MAX_SAFE_INTEGER
): asserts value is string[] {
  if (!Array.isArray(value)
    || value.length > maxEntries
    || value.some(item => !isNonEmptyIdentifier(item))) {
    throw new Error(`Graph ${field} must be an array of valid identifiers.`);
  }
}

function assertAggregateReferenceBudget(
  count: number,
  limit: number,
  kind: string
): void {
  if (count > limit) {
    throw new Error(`Graph artifact ${kind} references exceed the configured limit.`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new Error(`Graph ${field} must be a non-empty string when provided.`);
  }
}

function assertOptionalIdentifier(value: unknown, field: string): void {
  if (value !== undefined && !isNonEmptyIdentifier(value)) {
    throw new Error(`Graph ${field} must be a valid identifier when provided.`);
  }
}

function addUniqueId(
  collection: Set<string> | Map<string, unknown>,
  id: string,
  kind: string,
  value: unknown = true
): void {
  if (collection.has(id)) {
    throw new Error(`Graph artifact contains a duplicate ${kind} identity.`);
  }
  if (collection instanceof Map) collection.set(id, value);
  else collection.add(id);
}

const fileGraphStoreLocks = new Map<string, Promise<void>>();
const activeGraphWriters = new Map<string, number>();
const activeGraphTemporaryFiles = new Set<string>();
function createGraphWriterKey(
  rootDir: string,
  identity: MiroFishGraphArtifactIdentity
): string {
  return `${path.resolve(rootDir)}:${createIdentityDigest(identity)}`;
}

function retainActiveGraphWriter(key: string): void {
  activeGraphWriters.set(key, (activeGraphWriters.get(key) ?? 0) + 1);
}

function releaseActiveGraphWriter(key: string): void {
  const remaining = (activeGraphWriters.get(key) ?? 1) - 1;
  if (remaining <= 0) activeGraphWriters.delete(key);
  else activeGraphWriters.set(key, remaining);
}

function isActiveGraphWriter(key: string): boolean {
  return (activeGraphWriters.get(key) ?? 0) > 0;
}


export function createMiroFishGraphDocumentVersion(graph: GraphData): string {
  assertMiroFishGraphDataResourceLimits(graph);
  return `sha256:${createHash('sha256').update(stableStringify(graph)).digest('hex')}`;
}

function createArtifactDescriptor(
  artifact: MiroFishGraphArtifact,
  options: MiroFishGraphArtifactLifecycleOptions,
  now: number
): MiroFishGraphArtifactDescriptor {
  if (!Number.isFinite(now)) {
    throw new Error('Graph artifact clock returned an invalid timestamp.');
  }
  if (
    options.graphName !== undefined
    && (
      !options.graphName.trim()
      || options.graphName.length > 200
      || /[\u0000-\u001f\u007f]/.test(options.graphName)
    )
  ) {
    throw new Error('Graph artifact name is invalid.');
  }
  let expiresAt: string | undefined;
  if (options.ttlMs !== undefined) {
    if (
      !Number.isInteger(options.ttlMs)
      || options.ttlMs < 1
      || options.ttlMs > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxTtlMs
    ) {
      throw new Error('Graph artifact TTL is outside the allowed range.');
    }
    expiresAt = new Date(now + options.ttlMs).toISOString();
  }
  return {
    identity: normalizeIdentity(artifact),
    artifactDigest: createArtifactDigest(artifact),
    createdAt: new Date(now).toISOString(),
    ...(options.graphName ? { graphName: options.graphName } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    nodeCount: artifact.graph.node_count,
    edgeCount: artifact.graph.edge_count,
  };
}

function createArtifactDigest(artifact: MiroFishGraphArtifact): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(artifact))
    .digest('hex')}`;
}

function assertGraphDescriptor(value: unknown): asserts value is MiroFishGraphArtifactDescriptor {
  if (!isRecord(value) || !isRecord(value.identity)) {
    throw new Error('Graph artifact descriptor is malformed.');
  }
  const identity = normalizeIdentity(
    value.identity as unknown as MiroFishGraphArtifactIdentity
  );
  if (
    typeof value.artifactDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.artifactDigest)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || (value.graphName !== undefined && (
      typeof value.graphName !== 'string'
      || value.graphName.length > 200
      || /[\u0000-\u001f\u007f]/.test(value.graphName)
    ))
    || typeof value.nodeCount !== 'number'
    || !Number.isInteger(value.nodeCount)
    || value.nodeCount < 0
    || value.nodeCount > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxNodes
    || typeof value.edgeCount !== 'number'
    || !Number.isInteger(value.edgeCount)
    || value.edgeCount < 0
    || value.edgeCount > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxEdges
  ) {
    throw new Error('Graph artifact descriptor is malformed.');
  }
  if (
    value.expiresAt !== undefined
    && (
      typeof value.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    )
  ) {
    throw new Error('Graph artifact descriptor expiry is malformed.');
  }
  value.identity = identity;
}

function assertGraphActivePointer(value: unknown): asserts value is MiroFishGraphActivePointer {
  if (
    !isRecord(value)
    || !isRecord(value.scope)
    || typeof value.scope.tenantId !== 'string'
    || typeof value.scope.corpusId !== 'string'
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.identity !== null && !isRecord(value.identity))
  ) {
    throw new Error('Graph active pointer is malformed.');
  }
  value.scope = normalizeScopeIdentity(
    value.scope as unknown as Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
  );
  if (value.identity) {
    value.identity = normalizeIdentity(
      value.identity as unknown as MiroFishGraphArtifactIdentity
    );
  }
}

function assertGraphCapacityLimit(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Graph artifact ${label} capacity is outside the allowed range.`);
  }
}
function assertGraphTombstoneCapacity(
  tombstoneCount: number,
  maximum: number
): void {
  if (!Number.isSafeInteger(tombstoneCount) || tombstoneCount >= maximum) {
    throw graphStoreCapacity('Graph tombstone catalog capacity is exhausted.');
  }
}

function graphStoreCapacity(message: string): MiroFishGraphStoreError {
  return new MiroFishGraphStoreError(
    'MIROFISH_GRAPH_ARTIFACT_CAPACITY',
    message
  );
}


function assertMatchingQuotaReservation(
  reservation: MiroFishGraphQuotaReservation,
  identity: MiroFishGraphArtifactIdentity,
  artifactBytes: number
): void {
  if (
    !sameArtifactIdentity(reservation.identity, identity)
    || reservation.artifactBytes !== artifactBytes
  ) {
    throw graphStoreConflict('Graph artifact capacity reservation contains conflicting data.');
  }
}

async function readOptionalGraphQuotaReservation(
  file: string
): Promise<MiroFishGraphQuotaReservation | null> {
  try {
    const value = JSON.parse(
      await readBoundedArtifactFile(
        file,
        MIROFISH_GRAPH_ARTIFACT_LIMITS.maxDescriptorBytes
      )
    ) as unknown;
    if (
      !isRecord(value)
      || !isRecord(value.identity)
      || !Number.isSafeInteger(value.artifactBytes)
      || (value.artifactBytes as number) < 1
      || (value.artifactBytes as number) > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxFileBytes
      || typeof value.reservedAt !== 'string'
      || !Number.isFinite(Date.parse(value.reservedAt))
    ) {
      throw new Error('Graph artifact capacity reservation is malformed.');
    }
    return {
      identity: normalizeIdentity(
        value.identity as unknown as MiroFishGraphArtifactIdentity
      ),
      artifactBytes: value.artifactBytes as number,
      reservedAt: value.reservedAt,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw new Error('Graph artifact capacity index contains an invalid reservation.', {
      cause: error,
    });
  }
}
async function readOptionalGraphDescriptor(
  file: string
): Promise<MiroFishGraphArtifactDescriptor | null> {
  try {
    const value = JSON.parse(
      await readBoundedArtifactFile(
        file,
        MIROFISH_GRAPH_ARTIFACT_LIMITS.maxDescriptorBytes
      )
    ) as unknown;
    assertGraphDescriptor(value);
    return clone(value);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw new Error('Graph artifact catalog contains an invalid descriptor.', {
      cause: error,
    });
  }
}

async function readGraphActivePointer(file: string): Promise<MiroFishGraphActivePointer> {
  try {
    const value = JSON.parse(
      await readBoundedArtifactFile(
        file,
        MIROFISH_GRAPH_ARTIFACT_LIMITS.maxDescriptorBytes
      )
    ) as unknown;
    assertGraphActivePointer(value);
    return clone(value);
  } catch (error) {
    throw new Error('Graph artifact catalog contains an invalid active pointer.', {
      cause: error,
    });
  }
}

async function publishImmutableFile(
  file: string,
  serialized: string,
  options: {
    now?: () => number;
    cleanupFile?: (file: string) => Promise<void>;
  } = {}
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  const timestamp = options.now?.() ?? Date.now();
  const temporaryFile = path.resolve(
    `${file}.${process.pid}.${timestamp}.${randomUUID()}.tmp`
  );
  activeGraphTemporaryFiles.add(temporaryFile);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx');
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryFile, file);
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
        // The original publication error remains authoritative.
      }
    }
    await bestEffortCleanupFile(
      temporaryFile,
      options.cleanupFile ?? safeUnlink
    );
    activeGraphTemporaryFiles.delete(temporaryFile);
  }
}

async function bestEffortCleanupFile(
  file: string,
  cleanupFile: (file: string) => Promise<void>
): Promise<void> {
  try {
    await cleanupFile(file);
  } catch {
    // Cleanup is reconciled lazily; it cannot reverse an immutable commit.
  }
}


async function fileExists(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'r');
    await handle.close();
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    if (isNodeError(error) && ['EISDIR', 'EPERM', 'EACCES'].includes(error.code ?? '')) {
      return true;
    }
    throw error;
  }
}

async function safeUnlink(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

async function withFileGraphStoreLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fileGraphStoreLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  fileGraphStoreLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (fileGraphStoreLocks.get(key) === tail) {
      fileGraphStoreLocks.delete(key);
    }
  }
}

function createEmptyActivePointer(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
): MiroFishGraphActivePointer {
  return {
    scope: normalizeScopeIdentity(scope),
    identity: null,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeScopeIdentity(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
): Pick<RagRetrievalScope, 'tenantId' | 'corpusId'> {
  const normalized = createRetrievalScope({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    allowedTrustLevels: ['trusted'],
    enforceIsolation: true,
  });
  return {
    tenantId: normalized.tenantId,
    corpusId: normalized.corpusId,
  };
}

function createScopeKey(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
): string {
  const normalized = normalizeScopeIdentity(scope);
  return JSON.stringify([normalized.tenantId, normalized.corpusId]);
}

function createScopeDigest(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
): string {
  return createHash('sha256').update(createScopeKey(scope)).digest('hex');
}

function createIdentityDigest(identity: MiroFishGraphArtifactIdentity): string {
  return createHash('sha256').update(createArtifactKey(normalizeIdentity(identity))).digest('hex');
}

function assertManagementIdentityWithinScope(
  identity: MiroFishGraphArtifactIdentity,
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
): void {
  const normalizedScope = normalizeScopeIdentity(scope);
  if (identity.tenantId !== normalizedScope.tenantId) {
    throw new Error('Graph artifact tenant scope mismatch.');
  }
  if (identity.corpusId !== normalizedScope.corpusId) {
    throw new Error('Graph artifact corpus scope mismatch.');
  }
}

function sameArtifactIdentity(
  left: MiroFishGraphArtifactIdentity,
  right: MiroFishGraphArtifactIdentity
): boolean {
  return createArtifactKey(normalizeIdentity(left)) === createArtifactKey(normalizeIdentity(right));
}

function isDescriptorExpired(
  descriptor: MiroFishGraphArtifactDescriptor,
  now: number
): boolean {
  return descriptor.expiresAt !== undefined && Date.parse(descriptor.expiresAt) <= now;
}

function compareGraphDescriptors(
  left: MiroFishGraphArtifactDescriptor,
  right: MiroFishGraphArtifactDescriptor
): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || createArtifactKey(right.identity).localeCompare(createArtifactKey(left.identity));
}

function resolveGraphListLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (
    !Number.isInteger(value)
    || value < 1
    || value > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxListEntries
  ) {
    throw new Error('Graph artifact list limit is outside the allowed range.');
  }
  return value;
}

function assertActiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Graph active pointer revision must be a non-negative safe integer.');
  }
}

function activeRevisionConflict(): MiroFishGraphStoreError {
  return new MiroFishGraphStoreError(
    'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT',
    'Graph active pointer revision is stale.'
  );
}

function graphStoreConflict(message: string): MiroFishGraphStoreError {
  return new MiroFishGraphStoreError('MIROFISH_GRAPH_ARTIFACT_CONFLICT', message);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sortCanonicalValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, sortCanonicalValue(value[key])])
    );
  }
  return value;
}


async function readBoundedArtifactFile(
  file: string,
  maxFileBytes: number
): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new Error('Graph artifact path is not a regular file.');
    }

    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal <= maxFileBytes) {
      const bytesRemaining = maxFileBytes + 1 - bytesReadTotal;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, bytesRemaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal > maxFileBytes) {
      throw new Error('Graph artifact exceeds the configured file byte limit.');
    }
    return Buffer.concat(chunks, bytesReadTotal).toString('utf8');
  } finally {
    await handle.close();
  }
}

function assertIdentityWithinScope(
  identity: MiroFishGraphArtifactIdentity,
  scope: RagRetrievalScope
): void {
  if (identity.tenantId !== scope.tenantId) {
    throw new Error('Graph artifact tenant scope mismatch.');
  }
  if (identity.corpusId !== scope.corpusId) {
    throw new Error('Graph artifact corpus scope mismatch.');
  }
  if (identity.trustLevel === 'quarantined') {
    throw new Error('Graph artifact is quarantined.');
  }
  if (!scope.allowedTrustLevels.includes(identity.trustLevel)) {
    throw new Error('Graph artifact trust level is outside the retrieval scope.');
  }
}

function normalizeIdentity(
  identity: MiroFishGraphArtifactIdentity
): MiroFishGraphArtifactIdentity {
  const scope = createRetrievalScope({
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    allowedTrustLevels: [identity.trustLevel],
    enforceIsolation: true,
  });
  const documentId = normalizeDocumentField(identity.documentId, 'documentId');
  const documentVersion = normalizeDocumentField(
    identity.documentVersion,
    'documentVersion'
  );
  return {
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    documentId,
    documentVersion,
    trustLevel: identity.trustLevel,
  };
}

function normalizeDocumentField(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${field} must be a non-empty identifier without control characters.`);
  }
  return normalized;
}

function createArtifactKey(identity: MiroFishGraphArtifactIdentity): string {
  return JSON.stringify([
    identity.tenantId,
    identity.corpusId,
    identity.documentId,
    identity.documentVersion,
    identity.trustLevel,
  ]);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return isNonEmptyString(value)
    && value.length <= 512
    && !/[\u0000-\u001f]/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
