import { createRetrievalScope } from '../security/retrieval-scope';
import {
  KnowledgeGraphError,
  type KnowledgeGraphActivePointer,
  type KnowledgeGraphCommandStore,
} from './contracts';
import type { ClaimedKnowledgeGraphPublicationEvent } from './postgres-publication-store';

const INSPECTION_TRUST_LEVELS = [
  'trusted',
  'reviewed',
  'external',
  'quarantined',
] as const;

export type KnowledgeGraphPublicationProjectionStore = Pick<
  KnowledgeGraphCommandStore,
  'getActive' | 'getCompatibilityDescriptor' | 'compareAndSetActive'
>;

/**
 * Applies the durable PostgreSQL publication revision to Neo4j before the
 * outbox event is acknowledged. Retried events are a no-op only when the
 * exact revision and graph version are already visible in Neo4j.
 */
export async function projectKnowledgeGraphPublicationEvent(
  store: KnowledgeGraphPublicationProjectionStore,
  event: ClaimedKnowledgeGraphPublicationEvent
): Promise<KnowledgeGraphActivePointer> {
  assertPublicationEvent(event);
  const inspectionScope = createRetrievalScope({
    tenantId: event.tenantId,
    corpusId: event.corpusId,
    allowedTrustLevels: [...INSPECTION_TRUST_LEVELS],
    enforceIsolation: true,
  });
  const current = await store.getActive(inspectionScope);
  assertScopedPointer(current, event);

  if (current.revision === event.revision) {
    if (current.graphVersion !== event.graphVersion) {
      throw projectionConflict(event, 'Neo4j already contains a different graph for this revision.');
    }
    return current;
  }
  if (current.revision !== event.revision - 1) {
    throw projectionConflict(
      event,
      `Neo4j revision ${current.revision} cannot apply publication revision ${event.revision}.`
    );
  }

  let activationScope = inspectionScope;
  if (event.graphVersion !== null) {
    const descriptor = await store.getCompatibilityDescriptor({
      tenantId: event.tenantId,
      corpusId: event.corpusId,
      graphVersion: event.graphVersion,
    }, inspectionScope);
    if (!descriptor || descriptor.document.trustLevel === 'quarantined') {
      throw projectionConflict(event, 'The published graph is unavailable or quarantined in Neo4j.');
    }
    activationScope = createRetrievalScope({
      tenantId: event.tenantId,
      corpusId: event.corpusId,
      allowedTrustLevels: [descriptor.document.trustLevel],
      enforceIsolation: true,
    });
  }

  const projected = await store.compareAndSetActive(
    activationScope,
    event.graphVersion,
    event.revision - 1
  );
  assertScopedPointer(projected, event);
  if (projected.revision !== event.revision || projected.graphVersion !== event.graphVersion) {
    throw projectionConflict(event, 'Neo4j returned a publication pointer that does not match the event.');
  }
  return projected;
}

export function supportsKnowledgeGraphPublicationProjection(
  store: object
): store is KnowledgeGraphPublicationProjectionStore {
  const candidate = store as Partial<KnowledgeGraphPublicationProjectionStore>;
  return typeof candidate.getActive === 'function'
    && typeof candidate.getCompatibilityDescriptor === 'function'
    && typeof candidate.compareAndSetActive === 'function';
}

function assertPublicationEvent(event: ClaimedKnowledgeGraphPublicationEvent): void {
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) {
    throw projectionConflict(event, 'The publication revision must be a positive safe integer.');
  }
  if (event.eventType === 'graph.snapshot.activated' && event.graphVersion === null) {
    throw projectionConflict(event, 'An activation event must identify a graph version.');
  }
  if (event.eventType === 'graph.snapshot.deactivated' && event.graphVersion !== null) {
    throw projectionConflict(event, 'A deactivation event cannot identify a graph version.');
  }
}

function assertScopedPointer(
  pointer: KnowledgeGraphActivePointer,
  event: ClaimedKnowledgeGraphPublicationEvent
): void {
  if (pointer.tenantId !== event.tenantId || pointer.corpusId !== event.corpusId) {
    throw projectionConflict(event, 'Neo4j returned an active pointer for a different scope.');
  }
}

function projectionConflict(
  event: ClaimedKnowledgeGraphPublicationEvent,
  detail: string
): KnowledgeGraphError {
  return new KnowledgeGraphError(
    'KNOWLEDGE_GRAPH_CONFLICT',
    `Unable to project publication event ${event.id}: ${detail}`
  );
}
