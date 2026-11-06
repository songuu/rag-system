import type {
  PublicationAttempt, PublicationCandidate, PublicationObservation, PublicationProvider, PublicationScope,
} from './publication-control-cas';

/** This is an isolated rehearsal, not a verified publication or a live write path. */
type Request = PublicationScope & {
  idempotencyKey: string;
  contentVersion: string;
  manifestDigest: string;
  physicalCollection: string;
  requiredProviders: PublicationProvider[];
};
type Observation = PublicationObservation & { contentVersion: string; productionAuthorized: false };
type ElasticsearchIdentity = { indexName: string; ownerMarker: string; contentVersion: string };
type PersistedOperation = PublicationCandidate & ElasticsearchIdentity & { operationId: string; persisted: true };
type CreatedIndex = PublicationCandidate & ElasticsearchIdentity & { indexUuid: string; productionAuthorized: false };
type ElasticsearchObservation = Observation & ElasticsearchIdentity & { indexUuid: string };
type Phase = 'begin' | 'claim' | 'persist-elasticsearch-operation' | 'create-elasticsearch-index' | 'milvus' | 'elasticsearch' | 'neo4j' | 'finalize';
type Failure = 'cancelled' | 'timeout' | 'stage-failed';

export interface PublicationRehearsalPorts {
  store: {
    begin(input: Request): Promise<PublicationCandidate>;
    claim(candidate: PublicationCandidate): Promise<PublicationAttempt>;
    renew(attempt: PublicationAttempt): Promise<void>;
    abandon(attempt: PublicationAttempt): Promise<void>;
    observeAndRecord(attempt: PublicationAttempt, provider: PublicationProvider,
      observer: (input: PublicationAttempt & { provider: PublicationProvider }) => Promise<PublicationObservation>): Promise<void>;
  };
  /** Must persist ES's prepared operation before attempting external creation. */
  persistElasticsearchOperation(candidate: PublicationCandidate & { contentVersion: string }): Promise<PersistedOperation>;
  createElasticsearchIndex(candidate: PublicationCandidate, operation: PersistedOperation): Promise<CreatedIndex>;
  observeMilvus(attempt: PublicationAttempt): Promise<Observation>;
  observeElasticsearch(attempt: PublicationAttempt, operation: PersistedOperation, index: CreatedIndex): Promise<ElasticsearchObservation>;
  /** Neo4j is optional; this is a diagnostic observation, never a ready status. */
  observeGraph?(attempt: PublicationAttempt): Promise<{ status: 'unavailable' } | { status: 'observed'; observation: Observation }>;
}

export type PublicationRehearsalResult =
  | { status: 'observed'; graph: 'not-requested' | 'unavailable' | 'observed'; disposition: 'abandoned'; productionAuthorized: false }
  | { status: 'failed'; phase: Phase; failure: Failure; disposition: 'not-started' | 'abandoned' | 'unknown'; productionAuthorized: false };

class RehearsalFailure extends Error {
  readonly kind: Failure;
  constructor(kind: Failure) { super(kind); this.kind = kind; }
}

/**
 * A completed rehearsal is deliberately abandoned: snapshots and readbacks do
 * not prove sealed writes, and no production publish operation is available.
 * An effect that times out may still complete remotely; this generation must
 * never be reused even when abandoning its control record is unsuccessful.
 */
export async function observePublication(
  request: Request,
  ports: PublicationRehearsalPorts,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<PublicationRehearsalResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000
    || !Array.isArray(request.requiredProviders) || request.requiredProviders.length !== 2
    || !request.requiredProviders.includes('milvus') || !request.requiredProviders.includes('elasticsearch')) {
    throw new Error('Invalid publication rehearsal configuration.');
  }
  let phase: Phase = 'begin';
  let attempt: PublicationAttempt | undefined;
  let started = false;
  try {
    if (options.signal?.aborted) throw new RehearsalFailure('cancelled');
    started = true;
    const candidate = await bounded(() => ports.store.begin(request), options);
    assertCandidate(request, candidate);
    phase = 'claim';
    const claimed = await bounded(() => ports.store.claim(candidate), options);
    assertCandidate(candidate, claimed);
    if (typeof claimed.leaseToken !== 'string' || !claimed.leaseToken) throw new Error('Invalid rehearsal claim.');
    attempt = claimed;
    phase = 'persist-elasticsearch-operation';
    await bounded(() => ports.store.renew(claimed), options);
    const operation = await bounded(() => ports.persistElasticsearchOperation({ ...candidate, contentVersion: request.contentVersion }), options);
    assertCandidate(claimed, operation);
    if (Object.hasOwn(operation, 'leaseToken') || operation.persisted !== true
      || typeof operation.operationId !== 'string' || !operation.operationId.trim() || operation.operationId.length > 512) {
      throw new Error('Elasticsearch operation was not persisted for this attempt.');
    }
    if (typeof operation.indexName !== 'string' || !/^codex-generation-seal-[a-f0-9]{32}$/.test(operation.indexName)
      || typeof operation.ownerMarker !== 'string' || !/^[a-f0-9]{64}$/.test(operation.ownerMarker)
      || operation.contentVersion !== request.contentVersion) throw new Error('Invalid Elasticsearch operation identity.');
    phase = 'create-elasticsearch-index';
    await bounded(() => ports.store.renew(claimed), options);
    const index = await bounded(() => ports.createElasticsearchIndex(candidate, operation), options);
    assertCandidate(candidate, index);
    if (Object.hasOwn(index, 'leaseToken') || index.productionAuthorized !== false
      || index.indexName !== operation.indexName || index.ownerMarker !== operation.ownerMarker
      || index.contentVersion !== operation.contentVersion || typeof index.indexUuid !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(index.indexUuid)) throw new Error('Created Elasticsearch index identity mismatch.');
    phase = 'milvus';
    await observeRequired(claimed, request.contentVersion, 'milvus', () => ports.observeMilvus(claimed), ports, options);
    phase = 'elasticsearch';
    await observeRequired(claimed, request.contentVersion, 'elasticsearch', async () => {
      const observation = await ports.observeElasticsearch(claimed, operation, index);
      if (observation?.indexName !== index.indexName || observation.ownerMarker !== index.ownerMarker
        || observation.contentVersion !== index.contentVersion || observation.indexUuid !== index.indexUuid) {
        throw new Error('Elasticsearch observation identity mismatch.');
      }
      return observation;
    }, ports, options);
    let graph: 'not-requested' | 'unavailable' | 'observed' = 'not-requested';
    if (ports.observeGraph) {
      phase = 'neo4j';
      await bounded(() => ports.store.renew(claimed), options);
      const observed = await bounded(() => ports.observeGraph!(claimed), options);
      if (observed?.status === 'unavailable') graph = 'unavailable';
      else if (observed?.status === 'observed') { assertObservation(claimed, request.contentVersion, 'neo4j', observed.observation); graph = 'observed'; }
      else throw new Error('Invalid optional graph observation.');
      await bounded(() => ports.store.renew(claimed), options);
    }
    phase = 'finalize';
    await bounded(() => ports.store.abandon(claimed), options);
    attempt = undefined;
    return { status: 'observed', graph, disposition: 'abandoned', productionAuthorized: false };
  } catch (error) {
    const failure = error instanceof RehearsalFailure ? error.kind : 'stage-failed';
    if (!attempt) return { status: 'failed', phase, failure, disposition: started ? 'unknown' : 'not-started', productionAuthorized: false };
    // Cleanup gets a separate bounded attempt even if the caller cancelled.
    try {
      await bounded(() => ports.store.abandon(attempt!), { timeoutMs: options.timeoutMs });
      return { status: 'failed', phase, failure, disposition: 'abandoned', productionAuthorized: false };
    } catch {
      return { status: 'failed', phase, failure, disposition: 'unknown', productionAuthorized: false };
    }
  }
}

async function observeRequired(
  attempt: PublicationAttempt,
  contentVersion: string,
  provider: 'milvus' | 'elasticsearch',
  work: () => Promise<Observation>,
  ports: PublicationRehearsalPorts,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  await bounded(() => ports.store.renew(attempt), options);
  let observations = 0;
  await bounded(() => ports.store.observeAndRecord(attempt, provider, async () => {
    observations += 1;
    if (observations !== 1) throw new Error('Publication observer was invoked more than once.');
    const observed = await work();
    assertObservation(attempt, contentVersion, provider, observed);
    return observed;
  }), options);
  if (observations !== 1) throw new Error('Publication observer was not invoked.');
  await bounded(() => ports.store.renew(attempt), options);
}

function assertCandidate(expected: PublicationScope & { manifestDigest: string; physicalCollection: string; generation?: string; revision?: string }, actual: PublicationCandidate): void {
  if (!actual || actual.tenantId !== expected.tenantId || actual.corpusId !== expected.corpusId
    || actual.documentId !== expected.documentId || actual.manifestDigest !== expected.manifestDigest
    || actual.physicalCollection !== expected.physicalCollection
    || typeof actual.generation !== 'string' || !/^[1-9][0-9]*$/.test(actual.generation)
    // The current Milvus adapter accepts only JavaScript-safe integer generations.
    || actual.generation.length > 16 || (actual.generation.length === 16 && actual.generation > '9007199254740991')
    || typeof actual.revision !== 'string' || !/^[1-9][0-9]*$/.test(actual.revision)
    || (expected.generation !== undefined && actual.generation !== expected.generation)
    || (expected.revision !== undefined && actual.revision !== expected.revision)) {
    throw new Error('Publication identity mismatch.');
  }
}

function assertObservation(attempt: PublicationAttempt, contentVersion: string, provider: PublicationProvider, value: Observation): void {
  if (!value || value.productionAuthorized !== false || value.tenantId !== attempt.tenantId
    || value.corpusId !== attempt.corpusId || value.documentId !== attempt.documentId
    || value.generation !== attempt.generation || value.manifestDigest !== attempt.manifestDigest
    || value.physicalCollection !== attempt.physicalCollection || value.provider !== provider || value.contentVersion !== contentVersion
    || typeof value.evidenceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.evidenceDigest)) {
    throw new Error('Publication observation identity mismatch.');
  }
}

async function bounded<T>(work: () => Promise<T>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<T> {
  if (options.signal?.aborted) throw new RehearsalFailure('cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RehearsalFailure('timeout')), options.timeoutMs);
      if (options.signal) {
        onAbort = () => reject(new RehearsalFailure('cancelled'));
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      }
    });
    return await Promise.race([Promise.resolve().then(() => {
      if (options.signal?.aborted) throw new RehearsalFailure('cancelled');
      return work();
    }), cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
