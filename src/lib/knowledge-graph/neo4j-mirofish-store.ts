import {
  MIROFISH_GRAPH_ARTIFACT_LIMITS,
  MiroFishGraphStoreError,
  assertArtifactAllowed,
  type MiroFishGraphActivePointer,
  type MiroFishGraphArtifact,
  type MiroFishGraphArtifactDescriptor,
  type MiroFishGraphArtifactIdentity,
  type MiroFishGraphArtifactLifecycleOptions,
  type MiroFishGraphArtifactListOptions,
  type MiroFishGraphArtifactStore,
} from '../mirofish/graph-artifact-store';
import {
  createRetrievalScope,
  type RagRetrievalScope,
} from '../security/retrieval-scope';
import {
  KnowledgeGraphError,
  type KnowledgeGraphCommandStore,
  type KnowledgeGraphCompatibilitySnapshotDescriptor,
  type KnowledgeGraphSnapshot,
  type KnowledgeGraphSnapshotDescriptor,
} from './contracts';
import {
  createMiroFishGraphVersion,
  mapKnowledgeGraphSnapshotToMiroFishArtifact,
  mapMiroFishArtifactToKnowledgeGraphSnapshot,
} from './mirofish-adapter';
import type { KnowledgeGraphSnapshotLease } from './postgres-publication-store';

interface CoordinatedPublicationStore
extends Pick<KnowledgeGraphCommandStore, 'getActive' | 'compareAndSetActive'> {
  registerStagedSnapshot?(
    scope: RagRetrievalScope,
    graphVersion: string
  ): Promise<void>;
  acquireSnapshotLease?(
    scope: RagRetrievalScope,
    graphVersion: string,
    operation: 'activate' | 'delete',
    options?: { leaseMs?: number }
  ): Promise<KnowledgeGraphSnapshotLease>;
  compareAndSetActiveWithLease?(
    scope: RagRetrievalScope,
    graphVersion: string,
    expectedRevision: number,
    lease: KnowledgeGraphSnapshotLease
  ): Promise<Awaited<ReturnType<KnowledgeGraphCommandStore['getActive']>>>;
  resolveSnapshotLease?(
    scope: RagRetrievalScope,
    lease: KnowledgeGraphSnapshotLease,
    resolution: 'release' | 'deleted'
  ): Promise<boolean>;
}

interface AuthoritativeDeletionCommandStore extends KnowledgeGraphCommandStore {
  deleteSnapshotWithPostgresLease(
    identity: Parameters<KnowledgeGraphCommandStore['deleteSnapshot']>[0],
    scope: RagRetrievalScope
  ): Promise<boolean>;
}

export interface Neo4jMiroFishGraphStoreOptions {
  now?: () => Date;
  ensureReady?: () => Promise<void>;
  publicationStore?: CoordinatedPublicationStore;
}

/**
 * Keeps the established MiroFish API stable while moving durable graph state to
 * the shared KnowledgeGraph command store.
 */
export class Neo4jMiroFishGraphArtifactStore implements MiroFishGraphArtifactStore {
  readonly coordination = 'shared' as const;
  private readonly commandStore: KnowledgeGraphCommandStore;
  private readonly now: () => Date;
  private readonly ensureReady: () => Promise<void>;
  private readonly publicationStore: CoordinatedPublicationStore;

  constructor(
    commandStore: KnowledgeGraphCommandStore,
    options: Neo4jMiroFishGraphStoreOptions = {}
  ) {
    this.commandStore = commandStore;
    this.now = options.now ?? (() => new Date());
    this.ensureReady = options.ensureReady ?? (async () => undefined);
    this.publicationStore = options.publicationStore ?? commandStore;
  }

  async put(
    artifact: MiroFishGraphArtifact,
    options: MiroFishGraphArtifactLifecycleOptions = {}
  ): Promise<MiroFishGraphArtifactDescriptor> {
    await this.ensureReady();
    const createdAt = this.now();
    assertValidDate(createdAt);
    const graphName = normalizeGraphName(options.graphName);
    const expiresAt = resolveExpiry(createdAt, options.ttlMs);
    const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact, {
      ...(graphName ? { graphName } : {}),
      createdAt: createdAt.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    });
    if (supportsSnapshotStageCoordination(this.publicationStore)) {
      const graphVersion = createMiroFishGraphVersion(artifact);
      const managementScope = createRetrievalScope({
        tenantId: artifact.tenantId,
        corpusId: artifact.corpusId,
        allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
        enforceIsolation: true,
      });
      try {
        await this.publicationStore.registerStagedSnapshot(managementScope, graphVersion);
      } catch (error) {
        throw mapStoreError(error, 'Unable to store the graph artifact.');
      }
      const lease = await this.publicationStore.acquireSnapshotLease(
        managementScope,
        graphVersion,
        'activate',
        { leaseMs: 600_000 }
      );
      try {
        const descriptor = await this.commandStore.stageSnapshot(snapshot);
        await requireLeaseResolution(this.publicationStore, managementScope, lease, 'release');
        return toArtifactDescriptor(descriptor, artifact);
      } catch (error) {
        await this.publicationStore.resolveSnapshotLease(
          managementScope,
          lease,
          'release'
        ).catch(() => false);
        throw mapStoreError(error, 'Unable to store the graph artifact.');
      }
    }
    try {
      return toArtifactDescriptor(
        await this.commandStore.stageSnapshot(snapshot),
        artifact
      );
    } catch (error) {
      throw mapStoreError(error, 'Unable to store the graph artifact.');
    }
  }

  async get(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<MiroFishGraphArtifact | null> {
    await this.ensureReady();
    assertRetrievalIdentity(identity, scope);
    const snapshot = await this.commandStore.getSnapshot(toSnapshotIdentity(identity), scope);
    if (!snapshot || isExpired(snapshot, this.now())) return null;
    if (!hasDocument(snapshot, identity)) return null;
    const artifact = mapKnowledgeGraphSnapshotToMiroFishArtifact(snapshot, identity);
    assertArtifactAllowed(artifact, identity, scope);
    return artifact;
  }

  async list(
    scope: RagRetrievalScope,
    options: MiroFishGraphArtifactListOptions = {}
  ): Promise<MiroFishGraphArtifactDescriptor[]> {
    await this.ensureReady();
    const limit = resolveListLimit(options.limit);
    const candidates = await this.commandStore.listCompatibilityDescriptors(
      scope,
      { limit: 1_000 }
    );
    const results: MiroFishGraphArtifactDescriptor[] = [];
    for (const descriptor of candidates) {
      if (results.length >= limit) break;
      if (isExpired(descriptor, this.now())) continue;
      if (!scope.allowedTrustLevels.includes(descriptor.document.trustLevel)) continue;
      const identity: MiroFishGraphArtifactIdentity = {
        tenantId: descriptor.tenantId,
        corpusId: descriptor.corpusId,
        ...descriptor.document,
      };
      if (createMiroFishGraphVersion(identity) !== descriptor.graphVersion) continue;
      results.push(toArtifactDescriptor(descriptor, identity));
    }
    return results;
  }

  async delete(
    identity: MiroFishGraphArtifactIdentity,
    scope: RagRetrievalScope
  ): Promise<boolean> {
    await this.ensureReady();
    assertManagementIdentity(identity, scope);
    if (!scope.allowedTrustLevels.includes(identity.trustLevel)) {
      throw new Error('Graph artifact trust level is outside the deletion scope.');
    }
    const graphVersion = createMiroFishGraphVersion(identity);
    if (supportsLifecycleCoordination(this.publicationStore)) {
      let lease: KnowledgeGraphSnapshotLease;
      try {
        lease = await this.publicationStore.acquireSnapshotLease(
          scope,
          graphVersion,
          'delete'
        );
      } catch (error) {
        throw mapDeleteLeaseError(error);
      }
      try {
        const descriptor = await this.commandStore.getCompatibilityDescriptor(
          toSnapshotIdentity(identity),
          scope,
          { availability: 'all' }
        );
        if (!descriptor) {
          await requireLeaseResolution(this.publicationStore, scope, lease, 'deleted');
          return false;
        }
        if (!matchesCompatibilityDescriptor(descriptor, identity)) {
          throw new KnowledgeGraphError(
            'KNOWLEDGE_GRAPH_CONFLICT',
            'The graph snapshot descriptor does not match the deletion identity.'
          );
        }
        const authoritativeStore = requireAuthoritativeDeletionStore(this.commandStore);
        const deleted = await authoritativeStore.deleteSnapshotWithPostgresLease(
          toSnapshotIdentity(identity),
          scope
        );
        if (await this.commandStore.snapshotExists(toSnapshotIdentity(identity), scope)) {
          throw new KnowledgeGraphError(
            'KNOWLEDGE_GRAPH_CONFLICT',
            'Neo4j still contains the graph snapshot after the delete attempt.'
          );
        }
        await requireLeaseResolution(this.publicationStore, scope, lease, 'deleted');
        return deleted;
      } catch (error) {
        // Keep the deleting lease for recovery. Releasing it would allow an
        // activation to race an ambiguous Neo4j delete outcome.
        throw error;
      }
    }
    const active = await this.getActive(scope);
    if (active.identity && sameIdentity(active.identity, identity)) {
      throw new MiroFishGraphStoreError(
        'MIROFISH_GRAPH_ARTIFACT_ACTIVE',
        'Active graph artifacts must be deactivated before deletion.'
      );
    }
    const descriptor = await this.commandStore.getCompatibilityDescriptor(
      toSnapshotIdentity(identity),
      scope,
      { availability: 'all' }
    );
    if (!descriptor || !matchesCompatibilityDescriptor(descriptor, identity)) return false;
    return this.commandStore.deleteSnapshot(toSnapshotIdentity(identity), scope);
  }

  async getActive(scope: RagRetrievalScope): Promise<MiroFishGraphActivePointer> {
    await this.ensureReady();
    const pointer = await this.publicationStore.getActive(scope);
    if (!pointer.graphVersion) {
      return {
        scope: { tenantId: scope.tenantId, corpusId: scope.corpusId },
        identity: null,
        revision: pointer.revision,
        updatedAt: pointer.updatedAt,
      };
    }
    const descriptor = await this.commandStore.getCompatibilityDescriptor({
      tenantId: scope.tenantId,
      corpusId: scope.corpusId,
      graphVersion: pointer.graphVersion,
    }, scope);
    if (!descriptor) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_NOT_FOUND',
        'The active graph pointer does not resolve to one compatibility artifact.'
      );
    }
    if (isExpired(descriptor, this.now())
      || !scope.allowedTrustLevels.includes(descriptor.document.trustLevel)) {
      return {
        scope: { tenantId: scope.tenantId, corpusId: scope.corpusId },
        identity: null,
        revision: pointer.revision,
        updatedAt: pointer.updatedAt,
      };
    }
    const identity: MiroFishGraphArtifactIdentity = {
      tenantId: scope.tenantId,
      corpusId: scope.corpusId,
      ...descriptor.document,
    };
    if (createMiroFishGraphVersion(identity) !== pointer.graphVersion) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_NOT_FOUND',
        'The active graph pointer identity is inconsistent.'
      );
    }
    return {
      scope: { tenantId: scope.tenantId, corpusId: scope.corpusId },
      identity,
      revision: pointer.revision,
      updatedAt: pointer.updatedAt,
    };
  }

  async compareAndSetActive(
    scope: RagRetrievalScope,
    identity: MiroFishGraphArtifactIdentity | null,
    expectedRevision: number
  ): Promise<MiroFishGraphActivePointer> {
    await this.ensureReady();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Graph active pointer revision must be a non-negative safe integer.');
    }
    if (identity) {
      assertManagementIdentity(identity, scope);
      if (identity.trustLevel === 'quarantined') {
        throw new Error('Quarantined graph artifacts cannot be activated.');
      }
      if (!scope.allowedTrustLevels.includes(identity.trustLevel)) {
        throw new Error('Graph artifact trust level is outside the activation scope.');
      }
      const graphVersion = createMiroFishGraphVersion(identity);
      if (supportsLifecycleCoordination(this.publicationStore)) {
        const lease = await this.publicationStore.acquireSnapshotLease(
          scope,
          graphVersion,
          'activate'
        );
        try {
          const descriptor = await this.commandStore.getCompatibilityDescriptor(
            toSnapshotIdentity(identity),
            scope
          );
          if (!descriptor
            || isExpired(descriptor, this.now())
            || !matchesCompatibilityDescriptor(descriptor, identity)) {
            throw new Error('Graph artifact is not available for activation.');
          }
          const pointer = await this.publicationStore.compareAndSetActiveWithLease(
            scope,
            graphVersion,
            expectedRevision,
            lease
          );
          await requireLeaseResolution(this.publicationStore, scope, lease, 'release');
          return toMiroFishPointer(scope, identity, pointer);
        } catch (error) {
          await this.publicationStore.resolveSnapshotLease(scope, lease, 'release').catch(() => false);
          throw mapStoreError(error, 'Unable to update the active graph artifact.');
        }
      }
      const descriptor = await this.commandStore.getCompatibilityDescriptor(
        toSnapshotIdentity(identity),
        scope
      );
      if (!descriptor
        || isExpired(descriptor, this.now())
        || !matchesCompatibilityDescriptor(descriptor, identity)) {
        throw new Error('Graph artifact is not available for activation.');
      }
    }
    try {
      const pointer = await this.publicationStore.compareAndSetActive(
        scope,
        identity ? createMiroFishGraphVersion(identity) : null,
        expectedRevision
      );
      return {
        scope: { tenantId: scope.tenantId, corpusId: scope.corpusId },
        identity,
        revision: pointer.revision,
        updatedAt: pointer.updatedAt,
      };
    } catch (error) {
      throw mapStoreError(error, 'Unable to update the active graph artifact.');
    }
  }

  async gcExpired(
    scope: RagRetrievalScope,
    options: MiroFishGraphArtifactListOptions = {}
  ): Promise<number> {
    await this.ensureReady();
    const limit = Math.min(
      resolveListLimit(options.limit),
      MIROFISH_GRAPH_ARTIFACT_LIMITS.maxGcEntries
    );
    const snapshots = await this.commandStore.listCompatibilityDescriptors(
      scope,
      { limit, availability: 'expired' }
    );
    let deleted = 0;
    for (const snapshot of snapshots) {
      if (deleted >= limit || !isExpired(snapshot, this.now())) continue;
      const identity: MiroFishGraphArtifactIdentity = {
        tenantId: snapshot.tenantId,
        corpusId: snapshot.corpusId,
        ...snapshot.document,
      };
      if (createMiroFishGraphVersion(identity) !== snapshot.graphVersion) continue;
      try {
        if (await this.delete(identity, scope)) deleted += 1;
      } catch (error) {
        if (errorCode(error) !== 'MIROFISH_GRAPH_ARTIFACT_ACTIVE') throw error;
      }
    }
    return deleted;
  }
}

function requireAuthoritativeDeletionStore(
  store: KnowledgeGraphCommandStore
): AuthoritativeDeletionCommandStore {
  const candidate = store as Partial<AuthoritativeDeletionCommandStore>;
  if (typeof candidate.deleteSnapshotWithPostgresLease !== 'function') {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_UNAVAILABLE',
      'Coordinated graph deletion requires the PostgreSQL lease-aware Neo4j command.'
    );
  }
  return candidate as AuthoritativeDeletionCommandStore;
}

function toSnapshotIdentity(identity: MiroFishGraphArtifactIdentity) {
  return {
    tenantId: identity.tenantId,
    corpusId: identity.corpusId,
    graphVersion: createMiroFishGraphVersion(identity),
  };
}

function supportsLifecycleCoordination(
  store: CoordinatedPublicationStore
): store is Required<CoordinatedPublicationStore> {
  return typeof store.acquireSnapshotLease === 'function'
    && typeof store.compareAndSetActiveWithLease === 'function'
    && typeof store.resolveSnapshotLease === 'function';
}

function supportsSnapshotStageCoordination(
  store: CoordinatedPublicationStore
): store is Required<CoordinatedPublicationStore> {
  return supportsLifecycleCoordination(store)
    && typeof store.registerStagedSnapshot === 'function';
}

async function requireLeaseResolution(
  store: Required<CoordinatedPublicationStore>,
  scope: RagRetrievalScope,
  lease: KnowledgeGraphSnapshotLease,
  resolution: 'release' | 'deleted'
): Promise<void> {
  if (!await store.resolveSnapshotLease(scope, lease, resolution)) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_CONFLICT',
      'The knowledge graph snapshot mutation lease was lost before completion.'
    );
  }
}

function mapDeleteLeaseError(error: unknown): unknown {
  if (errorCode(error) === 'KNOWLEDGE_GRAPH_CONFLICT') {
    return new MiroFishGraphStoreError(
      'MIROFISH_GRAPH_ARTIFACT_ACTIVE',
      'Active, deleted, or concurrently changing graph artifacts cannot be deleted.',
      error
    );
  }
  return error;
}

function toMiroFishPointer(
  scope: RagRetrievalScope,
  identity: MiroFishGraphArtifactIdentity,
  pointer: Awaited<ReturnType<KnowledgeGraphCommandStore['getActive']>>
): MiroFishGraphActivePointer {
  return {
    scope: { tenantId: scope.tenantId, corpusId: scope.corpusId },
    identity,
    revision: pointer.revision,
    updatedAt: pointer.updatedAt,
  };
}

function toArtifactDescriptor(
  descriptor: KnowledgeGraphSnapshotDescriptor,
  identity: MiroFishGraphArtifactIdentity
): MiroFishGraphArtifactDescriptor {
  return {
    identity: { ...identity },
    artifactDigest: descriptor.artifactDigest,
    createdAt: descriptor.createdAt,
    ...(descriptor.graphName ? { graphName: descriptor.graphName } : {}),
    ...(descriptor.expiresAt ? { expiresAt: descriptor.expiresAt } : {}),
    nodeCount: descriptor.entityCount,
    edgeCount: descriptor.claimCount,
  };
}

function hasDocument(
  snapshot: KnowledgeGraphSnapshot,
  identity: MiroFishGraphArtifactIdentity
): boolean {
  return snapshot.documents.some(document =>
    document.documentId === identity.documentId
    && document.documentVersion === identity.documentVersion
    && document.trustLevel === identity.trustLevel
  );
}

function matchesCompatibilityDescriptor(
  descriptor: KnowledgeGraphCompatibilitySnapshotDescriptor,
  identity: MiroFishGraphArtifactIdentity
): boolean {
  return descriptor.tenantId === identity.tenantId
    && descriptor.corpusId === identity.corpusId
    && descriptor.document.documentId === identity.documentId
    && descriptor.document.documentVersion === identity.documentVersion
    && descriptor.document.trustLevel === identity.trustLevel
    && descriptor.graphVersion === createMiroFishGraphVersion(identity);
}

function assertRetrievalIdentity(
  identity: MiroFishGraphArtifactIdentity,
  scope: RagRetrievalScope
): void {
  assertManagementIdentity(identity, scope);
  if (identity.trustLevel === 'quarantined') {
    throw new Error('Graph artifact is quarantined.');
  }
  if (!scope.allowedTrustLevels.includes(identity.trustLevel)) {
    throw new Error('Graph artifact trust level is outside the retrieval scope.');
  }
}

function assertManagementIdentity(
  identity: MiroFishGraphArtifactIdentity,
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>
): void {
  if (identity.tenantId !== scope.tenantId) {
    throw new Error('Graph artifact tenant scope mismatch.');
  }
  if (identity.corpusId !== scope.corpusId) {
    throw new Error('Graph artifact corpus scope mismatch.');
  }
}

function sameIdentity(
  left: MiroFishGraphArtifactIdentity,
  right: MiroFishGraphArtifactIdentity
): boolean {
  return left.tenantId === right.tenantId
    && left.corpusId === right.corpusId
    && left.documentId === right.documentId
    && left.documentVersion === right.documentVersion
    && left.trustLevel === right.trustLevel;
}

function normalizeGraphName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Graph artifact name is invalid.');
  }
  return normalized;
}

function resolveExpiry(createdAt: Date, ttlMs: number | undefined): string | undefined {
  if (ttlMs === undefined) return undefined;
  if (
    !Number.isInteger(ttlMs)
    || ttlMs < 1
    || ttlMs > MIROFISH_GRAPH_ARTIFACT_LIMITS.maxTtlMs
  ) {
    throw new Error('Graph artifact TTL is outside the allowed range.');
  }
  return new Date(createdAt.getTime() + ttlMs).toISOString();
}

function resolveListLimit(value: number | undefined): number {
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

function isExpired(
  snapshot: Pick<KnowledgeGraphSnapshotDescriptor, 'expiresAt'>,
  now: Date
): boolean {
  return snapshot.expiresAt !== undefined && Date.parse(snapshot.expiresAt) <= now.getTime();
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('Graph artifact clock returned an invalid timestamp.');
  }
}

function mapStoreError(error: unknown, message: string): unknown {
  const code = errorCode(error);
  if (code === 'KNOWLEDGE_GRAPH_CONFLICT') {
    const conflictCode = errorMessage(error).toLowerCase().includes('revision')
      ? 'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT'
      : 'MIROFISH_GRAPH_ARTIFACT_CONFLICT';
    return new MiroFishGraphStoreError(conflictCode, message, error);
  }
  return error;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}
