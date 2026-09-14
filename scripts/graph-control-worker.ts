import { dispatchKnowledgeGraphOutbox } from '../src/lib/knowledge-graph/graph-outbox-dispatcher';
import {
  projectKnowledgeGraphPublicationEvent,
  supportsKnowledgeGraphPublicationProjection,
} from '../src/lib/knowledge-graph/graph-publication-projector';
import { recoverExpiredKnowledgeGraphMutations } from '../src/lib/knowledge-graph/graph-snapshot-recovery';
import { Neo4jKnowledgeGraphCommandStore } from '../src/lib/knowledge-graph/neo4j-command-store';
import {
  PostgresKnowledgeGraphBuildJobStore,
  type KnowledgeGraphBuildJob,
} from '../src/lib/knowledge-graph/postgres-graph-build-store';
import {
  PostgresKnowledgeGraphPublicationStore,
  type ClaimedKnowledgeGraphPublicationEvent,
} from '../src/lib/knowledge-graph/postgres-publication-store';
import { getNeo4jRuntimeConfig } from '../src/lib/neo4j/config';
import { closeNeo4jDriver, getNeo4jClient } from '../src/lib/neo4j/driver';
import { initializeNeo4jSchema } from '../src/lib/neo4j/schema';
import { closePostgresPool, getPostgresClient } from '../src/lib/postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
} from '../src/lib/postgres/env';
import { createRetrievalScope } from '../src/lib/security/retrieval-scope';

export interface GraphControlWorkerOptions {
  once: boolean;
  intervalMs: number;
  batchSize: number;
  buildMaxAttempts: number;
}

export function parseGraphControlWorkerOptions(
  args: readonly string[]
): GraphControlWorkerOptions {
  let once = false;
  let intervalMs = 5_000;
  let batchSize = 100;
  let buildMaxAttempts = 5;
  for (const rawArgument of args) {
    const argument = normalizeGraphControlWorkerArgument(rawArgument);
    if (argument === '--') {
      continue;
    }
    if (argument === '--once') {
      once = true;
      continue;
    }
    if (argument.startsWith('--interval-ms=')) {
      intervalMs = boundedInteger(argument.slice('--interval-ms='.length), 100, 60_000, 'interval');
      continue;
    }
    if (argument.startsWith('--batch-size=')) {
      batchSize = boundedInteger(argument.slice('--batch-size='.length), 1, 1_000, 'batch size');
      continue;
    }
    if (argument.startsWith('--build-max-attempts=')) {
      buildMaxAttempts = boundedInteger(
        argument.slice('--build-max-attempts='.length),
        1,
        100,
        'build max attempts'
      );
      continue;
    }
    throw new Error(`Unknown graph control worker argument: ${argument}.`);
  }
  return { once, intervalMs, batchSize, buildMaxAttempts };
}

function normalizeGraphControlWorkerArgument(argument: string): string {
  // Chat clients and rich-text editors frequently replace CLI hyphens with typographic dashes.
  const typographicPrefix = argument.match(/^[–—−－]+/u)?.[0];
  return typographicPrefix
    ? '--' + argument.slice(typographicPrefix.length)
    : argument;
}

export type GraphBuildWebhookResult =
  | { status: 'staged'; progress: number; artifactDigest: string }
  | { status: 'failed'; progress: number; errorCode: string; errorMessage: string };

export type GraphBuildExecutorMode = 'disabled' | 'webhook' | 'local';

interface BuildJobWorkerStore {
  claimNext(options?: { leaseMs?: number }): Promise<KnowledgeGraphBuildJob | null>;
  completeValidated?(input: {
    jobId: string;
    progress: number;
    artifactDigest: string;
    leaseToken: string;
  }): Promise<KnowledgeGraphBuildJob>;
  transition(input: {
    jobId: string;
    expectedStatus: 'running' | 'staged';
    status: 'queued' | 'staged' | 'validated' | 'failed';
    progress: number;
    artifactDigest?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
    leaseToken?: string;
  }): Promise<KnowledgeGraphBuildJob>;
}

export async function runGraphControlIteration(input: {
  publicationStore: PostgresKnowledgeGraphPublicationStore;
  commandStore: Pick<
    Neo4jKnowledgeGraphCommandStore,
    'deleteSnapshotWithPostgresLease' | 'snapshotExists' | 'getCompatibilityDescriptor'
  > & Partial<Pick<Neo4jKnowledgeGraphCommandStore, 'getActive' | 'compareAndSetActive'>>;
  publish?: (event: ClaimedKnowledgeGraphPublicationEvent) => Promise<void>;
  buildStore?: BuildJobWorkerStore;
  handleBuild?: (job: KnowledgeGraphBuildJob) => Promise<GraphBuildWebhookResult>;
  buildMaxAttempts?: number;
  buildLeaseMs?: number;
  batchSize: number;
}) {
  const recovery = await recoverExpiredKnowledgeGraphMutations({
    store: input.publicationStore,
    limit: input.batchSize,
    inspect: async mutation => {
      if (mutation.operation === 'activate') return 'release';
      const scope = createRetrievalScope({
        tenantId: mutation.tenantId,
        corpusId: mutation.corpusId,
        allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
        enforceIsolation: true,
      });
      await input.commandStore.deleteSnapshotWithPostgresLease(mutation, scope);
      if (await input.commandStore.snapshotExists(mutation, scope)) {
        throw new Error('Neo4j still contains the graph snapshot after recovery deletion.');
      }
      return 'deleted';
    },
  });
  const publicationProjectionStore = supportsKnowledgeGraphPublicationProjection(input.commandStore)
    ? input.commandStore
    : null;
  const outbox = publicationProjectionStore
    ? await dispatchKnowledgeGraphOutbox({
        store: input.publicationStore,
        publish: async event => {
          await projectKnowledgeGraphPublicationEvent(publicationProjectionStore, event);
          await input.publish?.(event);
        },
        limit: input.batchSize,
        onDeadLetter: async event => {
          console.error(JSON.stringify({
            type: 'knowledge_graph_publication_dead_letter',
            eventId: event.id,
            eventType: event.eventType,
            tenantId: event.tenantId,
            corpusId: event.corpusId,
            revision: event.revision,
          }));
        },
      })
    : { claimed: 0, published: 0, retried: 0, deadLettered: 0, lostLease: 0 };
  const build = input.buildStore && input.handleBuild
    ? await processNextGraphBuildJob({
        store: input.buildStore,
        handle: input.handleBuild,
        maxAttempts: input.buildMaxAttempts,
        leaseMs: input.buildLeaseMs,
        finalizeStaged: async (job, result) => {
          const scope = createRetrievalScope({
            tenantId: job.tenantId,
            corpusId: job.corpusId,
            allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
            enforceIsolation: true,
          });
          const descriptor = await input.commandStore.getCompatibilityDescriptor({
            tenantId: job.tenantId,
            corpusId: job.corpusId,
            graphVersion: job.graphVersion,
          }, scope);
          assertCompletedBuildDescriptor(job, result.artifactDigest, descriptor);
          await input.publicationStore.registerStagedSnapshot(scope, job.graphVersion);
        },
      })
    : { claimed: 0, validated: 0, failed: 0, retried: 0 };
  return { recovery, outbox, build };
}

export async function processNextGraphBuildJob(input: {
  store: BuildJobWorkerStore;
  handle: (job: KnowledgeGraphBuildJob) => Promise<GraphBuildWebhookResult>;
  finalizeStaged?: (
    job: KnowledgeGraphBuildJob,
    result: Extract<GraphBuildWebhookResult, { status: 'staged' }>
  ) => Promise<void>;
  maxAttempts?: number;
  leaseMs?: number;
}): Promise<{ claimed: number; validated: number; failed: number; retried: number }> {
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('Graph build max attempts must be between 1 and 100.');
  }
  const leaseMs = input.leaseMs ?? 150_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new Error('Graph build lease must be between 1000 and 3600000 milliseconds.');
  }
  const job = await input.store.claimNext({ leaseMs });
  if (!job) return { claimed: 0, validated: 0, failed: 0, retried: 0 };
  if (!job.leaseToken) throw new Error('Claimed graph build job is missing its lease token.');
  try {
    const result = await input.handle(job);
    if (result.status === 'staged') {
      if (!input.finalizeStaged) {
        throw new Error('Graph build staged completion requires durable snapshot validation.');
      }
      if (!input.store.completeValidated) {
        throw new Error('Graph build store requires atomic staged validation support.');
      }
      await input.finalizeStaged(job, result);
      await input.store.completeValidated({
        jobId: job.id,
        progress: result.progress,
        artifactDigest: result.artifactDigest,
        leaseToken: job.leaseToken,
      });
      return { claimed: 1, validated: 1, failed: 0, retried: 0 };
    }
    await input.store.transition({
      jobId: job.id,
      expectedStatus: 'running',
      status: 'failed',
      progress: result.progress,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      leaseToken: job.leaseToken,
    });
    return { claimed: 1, validated: 0, failed: 1, retried: 0 };
  } catch (error) {
    const message = boundedErrorMessage(error);
    if (job.attempts >= maxAttempts) {
      await input.store.transition({
        jobId: job.id,
        expectedStatus: 'running',
        status: 'failed',
        progress: job.progress,
        errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
        errorMessage: message,
        leaseToken: job.leaseToken,
      });
      return { claimed: 1, validated: 0, failed: 1, retried: 0 };
    }
    await input.store.transition({
      jobId: job.id,
      expectedStatus: 'running',
      status: 'queued',
      progress: job.progress,
      metadata: { lastDeliveryError: message },
      leaseToken: job.leaseToken,
    });
    return { claimed: 1, validated: 0, failed: 0, retried: 1 };
  }
}

function assertCompletedBuildDescriptor(
  job: KnowledgeGraphBuildJob,
  artifactDigest: string,
  descriptor: Awaited<ReturnType<Neo4jKnowledgeGraphCommandStore['getCompatibilityDescriptor']>>
): void {
  if (!descriptor) {
    throw new Error('Neo4j does not contain the completed graph build snapshot.');
  }
  if (descriptor.graphVersion !== job.graphVersion) {
    throw new Error('Neo4j graph build version does not match the durable job.');
  }
  if (descriptor.artifactDigest !== artifactDigest) {
    throw new Error('Neo4j graph build artifact digest does not match the webhook result.');
  }
  const expected = requiredBuildDocumentIdentity(job.metadata.documentIdentity);
  if (expected.tenantId !== job.tenantId || expected.corpusId !== job.corpusId) {
    throw new Error('Graph build job document identity is outside the durable job scope.');
  }
  const actual = descriptor.document;
  if (
    actual.documentId !== expected.documentId
    || actual.documentVersion !== expected.documentVersion
    || actual.trustLevel !== expected.trustLevel
  ) {
    throw new Error('Neo4j graph build document identity does not match the durable job.');
  }
}

function requiredBuildDocumentIdentity(value: unknown): {
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: 'trusted' | 'reviewed' | 'external' | 'quarantined';
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Graph build job is missing its server-owned document identity.');
  }
  const identity = value as Record<string, unknown>;
  if (
    typeof identity.tenantId !== 'string'
    || typeof identity.corpusId !== 'string'
    || typeof identity.documentId !== 'string'
    || typeof identity.documentVersion !== 'string'
    || !['trusted', 'reviewed', 'external', 'quarantined'].includes(String(identity.trustLevel))
  ) {
    throw new Error('Graph build job document identity is malformed.');
  }
  return identity as ReturnType<typeof requiredBuildDocumentIdentity>;
}

export function createPublicationWebhookPublisher(input: {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): (event: ClaimedKnowledgeGraphPublicationEvent) => Promise<void> {
  const url = requiredHttpsWebhookUrl(input.url);
  const secret = requiredWebhookSecret(input.secret);
  return async event => {
    await postWebhook({
      url,
      secret,
      idempotencyKey: event.id,
      body: {
        id: event.id,
        eventType: event.eventType,
        tenantId: event.tenantId,
        corpusId: event.corpusId,
        graphVersion: event.graphVersion,
        revision: event.revision,
        payload: event.payload,
        createdAt: event.createdAt,
      },
      timeoutMs: input.timeoutMs,
      fetchImpl: input.fetchImpl,
      expectJson: false,
      maxTimeoutMs: 60_000,
    });
  };
}

export function createBuildWebhookHandler(input: {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): (job: KnowledgeGraphBuildJob) => Promise<GraphBuildWebhookResult> {
  const url = requiredHttpsWebhookUrl(input.url);
  const secret = requiredWebhookSecret(input.secret);
  return async job => {
    const payload = await postWebhook({
      url,
      secret,
      idempotencyKey: job.id,
      body: { job },
      timeoutMs: input.timeoutMs,
      fetchImpl: input.fetchImpl,
      expectJson: true,
      maxTimeoutMs: 600_000,
    });
    return parseBuildWebhookResult(payload);
  };
}

export function resolveGraphBuildExecutorMode(
  env: Partial<NodeJS.ProcessEnv>
): GraphBuildExecutorMode {
  const configured = env.RAG_GRAPH_BUILD_EXECUTOR?.trim().toLowerCase();
  const hasWebhook = Boolean(optionalWebhook(env.RAG_GRAPH_BUILD_WEBHOOK_URL));
  const hasSecret = Boolean(optionalWebhook(env.RAG_GRAPH_WEBHOOK_SECRET));
  if (!configured) return hasWebhook && hasSecret ? 'webhook' : 'disabled';
  if (configured === 'local' || configured === 'disabled') return configured;
  if (configured === 'webhook') {
    if (!hasWebhook || !hasSecret) {
      throw new Error(
        'RAG_GRAPH_BUILD_EXECUTOR=webhook requires RAG_GRAPH_BUILD_WEBHOOK_URL and RAG_GRAPH_WEBHOOK_SECRET.'
      );
    }
    return 'webhook';
  }
  throw new Error('RAG_GRAPH_BUILD_EXECUTOR must be local, webhook, or disabled.');
}

export function resolveLocalGraphBuildLeaseMs(
  env: Partial<NodeJS.ProcessEnv>
): number {
  const raw = env.RAG_GRAPH_LOCAL_BUILD_LEASE_MS?.trim();
  if (!raw) return 3_600_000;
  return boundedInteger(raw, 60_000, 3_600_000, 'local build lease');
}

export async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm graph:control-worker:local --once --interval-ms=5000 --batch-size=100 --build-max-attempts=5');
    return;
  }
  const options = parseGraphControlWorkerOptions(process.argv.slice(2));
  assertGraphControlWorkerBackend(process.env);
  const buildTiming = resolveGraphBuildDeliveryTiming(process.env);
  const postgresConfig = getPostgresRuntimeConfig();
  assertPostgresPersistenceConfigured(postgresConfig);
  const postgresClient = getPostgresClient(postgresConfig);
  if (!postgresClient) throw new Error('PostgreSQL is required for the graph control worker.');
  const neo4jClient = getNeo4jClient(getNeo4jRuntimeConfig());
  if (!neo4jClient) throw new Error('Neo4j is required for the graph control worker.');

  const publicationStore = new PostgresKnowledgeGraphPublicationStore(postgresClient);
  const buildStore = new PostgresKnowledgeGraphBuildJobStore(postgresClient);
  const commandStore = new Neo4jKnowledgeGraphCommandStore(neo4jClient);
  const publicationWebhook = optionalWebhook(process.env.RAG_GRAPH_PUBLICATION_WEBHOOK_URL);
  const buildWebhook = optionalWebhook(process.env.RAG_GRAPH_BUILD_WEBHOOK_URL);
  const webhookSecret = optionalWebhook(process.env.RAG_GRAPH_WEBHOOK_SECRET);
  const buildExecutorMode = resolveGraphBuildExecutorMode(process.env);
  const publish = publicationWebhook && webhookSecret
    ? createPublicationWebhookPublisher({ url: publicationWebhook, secret: webhookSecret })
    : undefined;
  let handleBuild: ((job: KnowledgeGraphBuildJob) => Promise<GraphBuildWebhookResult>) | undefined;
  let closeBuildResources = async (): Promise<void> => {};
  if (buildExecutorMode === 'webhook') {
    if (!buildWebhook || !webhookSecret) {
      throw new Error('Webhook graph build executor configuration is incomplete.');
    }
    handleBuild = createBuildWebhookHandler({
        url: buildWebhook,
        secret: webhookSecret,
        timeoutMs: buildTiming.timeoutMs,
      });
  } else if (buildExecutorMode === 'local') {
    // Load model and Milvus dependencies only when the local executor is enabled.
    const [localExecutorModule, milvusModule, neo4jStoreModule] = await Promise.all([
      import('../src/lib/knowledge-graph/local-graph-build-executor'),
      import('../src/lib/milvus-client'),
      import('../src/lib/knowledge-graph/neo4j-mirofish-store'),
    ]);
    const milvus = milvusModule.getMilvusInstance();
    const artifactStore = new neo4jStoreModule.Neo4jMiroFishGraphArtifactStore(commandStore);
    handleBuild = localExecutorModule.createLocalGraphBuildHandler({
      milvus,
      commandStore,
      artifactStore,
    });
    closeBuildResources = () => milvus.disconnect();
  }
  if (!publish) {
    console.warn('Publication webhook URL or RAG_GRAPH_WEBHOOK_SECRET is unset; publication events will be projected to Neo4j without external forwarding.');
  }
  if (buildExecutorMode === 'disabled') {
    console.warn('Graph build executor is disabled; graph build jobs will not be claimed.');
  } else if (buildExecutorMode === 'local') {
    console.log('Local graph build executor enabled; BuildJobs will read exact Milvus document revisions.');
  }
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await initializeNeo4jSchema(neo4jClient);
    do {
      const summary = await runGraphControlIteration({
        publicationStore,
        commandStore,
        batchSize: options.batchSize,
        ...(publish ? { publish } : {}),
        ...(handleBuild ? { buildStore, handleBuild } : {}),
        buildMaxAttempts: options.buildMaxAttempts,
        buildLeaseMs: buildExecutorMode === 'local'
          ? resolveLocalGraphBuildLeaseMs(process.env)
          : buildTiming.leaseMs,
      });
      console.log(JSON.stringify({ type: 'knowledge_graph_control_iteration', ...summary }));
      if (!options.once && !stopping) await delay(options.intervalMs);
    } while (!options.once && !stopping);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled([
      closeBuildResources(),
      closeNeo4jDriver(),
      closePostgresPool(),
    ]);
  }
}

function boundedInteger(raw: string, minimum: number, maximum: number, label: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Graph control worker ${label} is invalid.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Graph control worker ${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalWebhook(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function requiredHttpsWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Graph control webhook URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Graph control webhook URL must use HTTPS without embedded credentials.');
  }
  return url.href;
}

function requiredWebhookSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 32 || secret.length > 512 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error('Graph control webhook secret must contain at least 32 safe characters.');
  }
  return secret;
}

export function assertGraphControlWorkerBackend(
  env: Record<string, string | undefined>
): void {
  if (env.RAG_GRAPH_BACKEND?.trim().toLowerCase() !== 'neo4j') {
    throw new Error('Graph control worker requires RAG_GRAPH_BACKEND=neo4j.');
  }
}

export function resolveGraphBuildDeliveryTiming(
  env: Record<string, string | undefined>
): { timeoutMs: number; leaseMs: number } {
  const raw = env.RAG_GRAPH_BUILD_WEBHOOK_TIMEOUT_MS?.trim();
  const timeoutMs = raw === undefined || raw === ''
    ? 120_000
    : boundedInteger(raw, 1_000, 600_000, 'build webhook timeout');
  return { timeoutMs, leaseMs: timeoutMs + 30_000 };
}

async function postWebhook(input: {
  url: string;
  secret: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  expectJson: boolean;
  maxTimeoutMs: number;
}): Promise<unknown> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > input.maxTimeoutMs) {
    throw new Error(`Graph control webhook timeout must be between 100 and ${input.maxTimeoutMs} milliseconds.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
        authorization: `Bearer ${input.secret}`,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`Graph control webhook returned HTTP ${response.status}.`);
    }
    if (!input.expectJson) return undefined;
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 65_536) throw new Error('Graph build webhook response is too large.');
    const text = await response.text();
    if (text.length > 65_536) throw new Error('Graph build webhook response is too large.');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Graph build webhook returned malformed JSON.');
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseBuildWebhookResult(value: unknown): GraphBuildWebhookResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Graph build webhook result is malformed.');
  }
  const result = value as Record<string, unknown>;
  const progress = Number(result.progress);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Graph build webhook progress is malformed.');
  }
  if (result.status === 'staged'
    && typeof result.artifactDigest === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(result.artifactDigest)) {
    return { status: 'staged', progress, artifactDigest: result.artifactDigest };
  }
  if (result.status === 'failed'
    && typeof result.errorCode === 'string'
    && result.errorCode.trim()
    && result.errorCode.length <= 128
    && typeof result.errorMessage === 'string'
    && result.errorMessage.trim()
    && result.errorMessage.length <= 2_000) {
    return {
      status: 'failed',
      progress,
      errorCode: result.errorCode.trim(),
      errorMessage: result.errorMessage.trim(),
    };
  }
  throw new Error('Graph build webhook result is malformed.');
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Graph build webhook failed.';
  return message.slice(0, 2_000) || 'Graph build webhook failed.';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
