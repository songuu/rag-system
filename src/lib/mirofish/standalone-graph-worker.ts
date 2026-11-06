import { createHash } from 'node:crypto';
import { canonicalJson } from '../rag/eval/canonical-json';
import { createEmbeddingModel } from '../embedding-config';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import { getNeo4jClient } from '../neo4j/driver';
import { getNeo4jRuntimeConfig } from '../neo4j/config';
import { KnowledgeGraphError } from '../knowledge-graph/contracts';
import { createRetrievalScope } from '../security/retrieval-scope';
import { Neo4jKnowledgeGraphCommandStore } from '../knowledge-graph/neo4j-command-store';
import { PostgresKnowledgeGraphBuildJobStore, type KnowledgeGraphBuildJob } from '../knowledge-graph/postgres-graph-build-store';
import { PostgresKnowledgeGraphPublicationStore } from '../knowledge-graph/postgres-publication-store';
import { createMiroFishGraphVersion } from '../knowledge-graph/mirofish-adapter';
import { createGraphExtractionCheckpoint } from '../knowledge-graph/graph-extraction-checkpoint';
import type { EntityExtractionCheckpoint } from '../entity-extraction';
import { extractMiroFishGraphData, filterMiroFishGraphByOntology, assertGraphHasEntities } from './graph-builder';
import { createMiroFishGraphArtifact, type MiroFishGraphArtifact, type MiroFishGraphArtifactStore } from './graph-artifact-store';
import { getMiroFishGraphArtifactRuntime } from './graph-artifact-runtime';
import { getMiroFishRuntimeStore, PostgresMiroFishRuntimeStore, type MiroFishRuntimeScope, type MiroFishRuntimeStore } from './runtime-store';
import { readStandaloneGraphRequest, standaloneGraphIdentity, standaloneGraphJobId, StandaloneGraphRequestError,
  usesDurableStandaloneGraphBuilds, type MiroFishStandaloneGraphRequest } from './standalone-graph-runtime';
import type { GraphData } from './types';
import { processNextGraphBuildJob, finalizeGraphBuildSnapshot, wrapLocalGraphBuildStore } from '../../../scripts/graph-control-worker';

const LEASE_MS = 90_000;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const preparedId = (job: KnowledgeGraphBuildJob) => `graph_prepared_${job.id}`;
interface PreparedRecord { schemaVersion: 1; recordType: 'prepared'; requestDigest: string; artifactDigest: string; artifact: MiroFishGraphArtifact }
interface PreparedStore {
  load(job: KnowledgeGraphBuildJob, request: MiroFishStandaloneGraphRequest): Promise<MiroFishGraphArtifact | null>;
  save(job: KnowledgeGraphBuildJob, request: MiroFishStandaloneGraphRequest, artifact: MiroFishGraphArtifact): Promise<MiroFishGraphArtifact>;
}
interface Dependencies {
  records?: MiroFishRuntimeStore;
  commandStore?: Pick<Neo4jKnowledgeGraphCommandStore, 'getCompatibilityDescriptor'>;
  artifactStore?: Pick<MiroFishGraphArtifactStore, 'put'>;
  checkpointStore?: Pick<PostgresKnowledgeGraphBuildJobStore, 'saveExtractionCheckpoint' | 'renewExtractionLease'>;
  prepared?: PreparedStore;
  leaseMs?: number;
  extractGraph?: (request: MiroFishStandaloneGraphRequest, checkpoint: EntityExtractionCheckpoint, signal?: AbortSignal) => Promise<GraphData>;
}
function requirePg() {
  const client = getPostgresClient();
  if (!client) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_UNAVAILABLE', 'Standalone graph persistence is unavailable.');
  return client;
}
function requireCommandStore() {
  const client = getNeo4jClient(getNeo4jRuntimeConfig());
  if (!client) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_UNAVAILABLE', 'Standalone graph storage is unavailable.');
  return new Neo4jKnowledgeGraphCommandStore(client);
}
function validateArtifact(job: KnowledgeGraphBuildJob, request: MiroFishStandaloneGraphRequest, artifact: MiroFishGraphArtifact) {
  const identity = standaloneGraphIdentity(request);
  if (artifact.tenantId !== identity.tenantId || artifact.corpusId !== identity.corpusId
    || artifact.documentId !== identity.documentId || artifact.documentVersion !== identity.documentVersion
    || artifact.trustLevel !== identity.trustLevel || artifact.graphGeneration !== undefined
    || createMiroFishGraphVersion(artifact) !== job.graphVersion) throw new StandaloneGraphRequestError();
  return createMiroFishGraphArtifact({ identity, graph: artifact.graph });
}
function decodePrepared(job: KnowledgeGraphBuildJob, request: MiroFishStandaloneGraphRequest, record: PreparedRecord | null) {
  if (!record) return null;
  if (record.schemaVersion !== 1 || record.recordType !== 'prepared' || record.requestDigest !== request.requestDigest
    || digest(record.artifact) !== record.artifactDigest) throw new StandaloneGraphRequestError();
  return validateArtifact(job, request, record.artifact);
}
function preparedStore(records: MiroFishRuntimeStore): PreparedStore {
  return {
    async load(job, request) { return decodePrepared(job, request, await records.read<PreparedRecord>('graph', preparedId(job))); },
    async save(job, request, artifact) {
      const client = requirePg();
      if (!client.withTransaction) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_UNAVAILABLE', 'Graph preparation requires a PostgreSQL transaction.');
      return client.withTransaction('save prepared standalone graph', async transaction => {
        // Hold ownership while inserting the immutable prepared result. After a
        // restart, publication reuses these exact bytes rather than generating
        // a second digest for the source row already registered in PostgreSQL.
        const owner = await queryPostgres<{ id: string }>(transaction, `with owner as materialized (
          select id, lease_expires_at from public.graph_build_jobs
          where id = $1::uuid and tenant_id = $2 and corpus_id = $3 and graph_version = $4
            and status = 'running' and lease_token = $5::uuid and lease_expires_at > clock_timestamp()
          for update
        ) select id::text from owner where lease_expires_at > clock_timestamp()`,
        [job.id, job.tenantId, job.corpusId, job.graphVersion, job.leaseToken], 'lock prepared graph owner');
        if (owner.rows.length !== 1) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'The graph build lease changed before preparing publication.');
        const transactional = new PostgresMiroFishRuntimeStore(transaction, job);
        const previous = decodePrepared(job, request, await transactional.read<PreparedRecord>('graph', preparedId(job)));
        if (previous) return previous;
        const accepted = validateArtifact(job, request, artifact);
        await transactional.write('graph', preparedId(job), { schemaVersion: 1, recordType: 'prepared',
          requestDigest: request.requestDigest, artifactDigest: digest(accepted), artifact: accepted } satisfies PreparedRecord,
        { projectId: request.projectId });
        return accepted;
      });
    },
  };
}

/** The queue owns leases; source requests and prepared artifacts live outside Next's process. */
export function createStandaloneGraphBuildHandler(dependencies: Dependencies = {}) {
  return async (job: KnowledgeGraphBuildJob, signal?: AbortSignal): Promise<{ status: 'staged'; progress: 1; artifactDigest: string }> => {
    signal?.throwIfAborted();
    if (!job.leaseToken) throw new StandaloneGraphRequestError();
    const records = dependencies.records ?? getMiroFishRuntimeStore(job);
    const request = await readStandaloneGraphRequest(job, records);
    const command = dependencies.commandStore ?? requireCommandStore();
    const scope = createRetrievalScope({ tenantId: job.tenantId, corpusId: job.corpusId,
      allowedTrustLevels: [request.trustLevel], enforceIsolation: true });
    const existing = await command.getCompatibilityDescriptor({ tenantId: job.tenantId, corpusId: job.corpusId, graphVersion: job.graphVersion }, scope);
    signal?.throwIfAborted();
    if (existing) {
      if (existing.tenantId !== job.tenantId || existing.corpusId !== job.corpusId || existing.graphVersion !== job.graphVersion
        || existing.document.documentId !== request.documentId || existing.document.documentVersion !== request.documentVersion
        || existing.document.trustLevel !== request.trustLevel) throw new StandaloneGraphRequestError();
      return { status: 'staged', progress: 1, artifactDigest: existing.artifactDigest };
    }
    const checkpointStore = dependencies.checkpointStore ?? new PostgresKnowledgeGraphBuildJobStore(requirePg());
    const leaseMs = dependencies.leaseMs ?? LEASE_MS;
    const checkpoint = createGraphExtractionCheckpoint(job, checkpointStore, request.profileHash, leaseMs);
    const prepared = dependencies.prepared ?? preparedStore(records);
    let artifact = await prepared.load(job, request);
    if (!artifact) {
      const graph = dependencies.extractGraph
        ? await dependencies.extractGraph(request, checkpoint, signal)
        : await extractMiroFishGraphData({ text: request.text, documentId: request.documentId,
          chunkSize: request.chunkSize, chunkOverlap: request.chunkOverlap, modelOverride: request.modelOverride,
          checkpoint, signal, embeddingInstance: createEmbeddingModel(request.embeddingModel,
            { provider: request.embeddingProvider, requestTimeoutMs: 300_000 }) });
      signal?.throwIfAborted();
      const filtered = filterMiroFishGraphByOntology(graph, request.ontology);
      assertGraphHasEntities(filtered);
      await checkpointStore.renewExtractionLease({ jobId: job.id, tenantId: job.tenantId, corpusId: job.corpusId,
        graphVersion: job.graphVersion, leaseToken: job.leaseToken, leaseMs });
      artifact = await prepared.save(job, request, createMiroFishGraphArtifact({ identity: standaloneGraphIdentity(request), graph: filtered }));
    }
    validateArtifact(job, request, artifact);
    await checkpointStore.renewExtractionLease({ jobId: job.id, tenantId: job.tenantId, corpusId: job.corpusId,
      graphVersion: job.graphVersion, leaseToken: job.leaseToken, leaseMs });
    signal?.throwIfAborted();
    const artifacts = dependencies.artifactStore ?? getMiroFishGraphArtifactRuntime().store;
    const descriptor = await artifacts.put(artifact, { graphName: request.graphName, ttlMs: request.ttlMs,
      buildLease: { jobId: job.id, leaseToken: job.leaseToken } });
    if (descriptor.identity.tenantId !== job.tenantId || descriptor.identity.corpusId !== job.corpusId
      || createMiroFishGraphVersion(descriptor.identity) !== job.graphVersion) throw new StandaloneGraphRequestError();
    return { status: 'staged', progress: 1, artifactDigest: descriptor.artifactDigest };
  };
}

const workerGlobal = globalThis as typeof globalThis & { __miroFishStandaloneGraphWorkersV1?: Map<string, Promise<unknown>>;
  __miroFishStandaloneGraphQueueV1?: { tail: Promise<unknown> } };
const workers = workerGlobal.__miroFishStandaloneGraphWorkersV1 ??= new Map<string, Promise<unknown>>();
const queue = workerGlobal.__miroFishStandaloneGraphQueueV1 ??= { tail: Promise.resolve() };

/** A status poll only wakes this exact scoped job; it never drains another document's queue. */
export function wakeStandaloneGraphBuild(taskId: string, scope: MiroFishRuntimeScope): void {
  const jobId = standaloneGraphJobId(taskId);
  if (!jobId || !usesDurableStandaloneGraphBuilds()) return;
  const key = JSON.stringify([scope.tenantId, scope.corpusId, jobId]);
  if (workers.has(key)) return;
  // Serialize console jobs so large chat/embedding models are not continually
  // evicted by another graph. Waiting jobs have no lease or loaded source body.
  const work = queue.tail.then(async () => {
    const client = requirePg();
    const jobs = new PostgresKnowledgeGraphBuildJobStore(client);
    const stored = await jobs.get(scope, jobId);
    if (!stored || !['queued', 'running', 'validated'].includes(stored.status)) return;
    await readStandaloneGraphRequest(stored, getMiroFishRuntimeStore(scope));
    if (stored.status === 'validated') {
      await jobs.transition({ jobId, expectedStatus: 'validated', status: 'published', progress: 1 });
      return;
    }
    const commandStore = requireCommandStore();
    const publicationStore = new PostgresKnowledgeGraphPublicationStore(client);
    return processNextGraphBuildJob({
      store: wrapLocalGraphBuildStore({ claimNext: options => jobs.claimSpecific(scope, jobId, options),
        transition: jobs.transition.bind(jobs), completeValidated: jobs.completeValidated.bind(jobs) }),
      handle: createStandaloneGraphBuildHandler({ checkpointStore: jobs, leaseMs: LEASE_MS }),
      renewLease: (job, leaseMs) => jobs.renewExtractionLease({ jobId: job.id, tenantId: job.tenantId,
        corpusId: job.corpusId, graphVersion: job.graphVersion, leaseToken: job.leaseToken!, leaseMs }),
      finalizeStaged: (job, result) => finalizeGraphBuildSnapshot({ job, result, commandStore, publicationStore }),
      maxAttempts: 3, leaseMs: LEASE_MS,
    });
  }).catch(error => {
    console.error('[MiroFish durable graph]', { taskId, code: error instanceof KnowledgeGraphError ? error.code : 'MIROFISH_GRAPH_WORKER_FAILED' });
  }).finally(() => { if (workers.get(key) === work) workers.delete(key); });
  workers.set(key, work);
  queue.tail = work;
}
