import { createHash } from 'node:crypto';
import type { MiroFishGraphArtifactIdentity } from '../mirofish/graph-artifact-store';
import { getPostgresClient } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
} from '../postgres/env';
import {
  createRetrievalScope,
  type RagRetrievalScope,
  type RagTrustLevel,
} from '../security/retrieval-scope';
import {
  PostgresKnowledgeGraphBuildJobStore,
  type KnowledgeGraphBuildJob,
} from './postgres-graph-build-store';

export interface KnowledgeGraphAutoBuildInput {
  tenantId: string;
  corpusId: string;
  actorId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  postgresAssetId: string | null;
  chunkCount: number;
  sourceName: string;
}

export type KnowledgeGraphAutoBuildResult =
  | {
      enabled: false;
      reason: 'graph_backend_disabled' | 'auto_build_disabled';
    }
  | {
      enabled: true;
      job: Pick<KnowledgeGraphBuildJob, 'id' | 'graphVersion' | 'status'>;
    };

interface KnowledgeGraphBuildEnqueuePort {
  enqueueDocumentBuild(
    scope: RagRetrievalScope,
    identity: MiroFishGraphArtifactIdentity,
    metadata: Record<string, unknown>,
    options: { maxPendingJobs: number }
  ): Promise<Pick<KnowledgeGraphBuildJob, 'id' | 'graphVersion' | 'status'>>;
}

interface KnowledgeGraphAutoBuildDependencies {
  env?: Partial<NodeJS.ProcessEnv>;
  store?: KnowledgeGraphBuildEnqueuePort;
}

export class KnowledgeGraphAutoBuildEnqueueError extends Error {
  readonly code = 'KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED';
  readonly status = 503;
  readonly reconciliationId: string;

  constructor(reconciliationId: string, cause: unknown) {
    super(
      `Knowledge graph build enqueue requires reconciliation. reconciliationId=${reconciliationId}`,
      { cause }
    );
    this.name = 'KnowledgeGraphAutoBuildEnqueueError';
    this.reconciliationId = reconciliationId;
  }
}

/**
 * Submit exactly one durable graph build after the authoritative Milvus write.
 *
 * WHY: Milvus and PostgreSQL cannot share a transaction. A stable graphVersion
 * makes retries idempotent, while enqueue failure remains explicit instead of
 * reporting a fully successful ingest with no graph build behind it.
 */
export async function enqueueKnowledgeGraphBuildAfterVectorization(
  input: KnowledgeGraphAutoBuildInput,
  dependencies: KnowledgeGraphAutoBuildDependencies = {}
): Promise<KnowledgeGraphAutoBuildResult> {
  const env = dependencies.env ?? process.env;
  if (env.RAG_GRAPH_BACKEND?.trim().toLowerCase() !== 'neo4j') {
    return { enabled: false, reason: 'graph_backend_disabled' };
  }

  const reconciliationId = createGraphBuildReconciliationId(input);
  try {
    if (!resolveAutoBuildEnabled(env)) {
      return { enabled: false, reason: 'auto_build_disabled' };
    }
    if (!input.postgresAssetId?.trim()) {
      throw new Error('Automatic graph builds require a persisted document asset.');
    }
    if (!Number.isSafeInteger(input.chunkCount) || input.chunkCount < 1) {
      throw new Error('Automatic graph builds require a positive chunk count.');
    }

    const scope = createRetrievalScope({
      tenantId: input.tenantId,
      corpusId: input.corpusId,
      allowedTrustLevels: [input.trustLevel],
      enforceIsolation: true,
    });
    const identity: MiroFishGraphArtifactIdentity = {
      tenantId: input.tenantId,
      corpusId: input.corpusId,
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      trustLevel: input.trustLevel,
    };
    const store = dependencies.store ?? createBuildStore(env);
    const job = await store.enqueueDocumentBuild(
      scope,
      identity,
      {
        trigger: 'milvus-vectorization',
        postgresAssetId: input.postgresAssetId,
        actorId: input.actorId,
        chunkCount: input.chunkCount,
        sourceName: input.sourceName,
      },
      { maxPendingJobs: resolveMaxPendingJobs(env) }
    );
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error('Automatic graph build returned a terminal job.');
    }

    return {
      enabled: true,
      job: {
        id: job.id,
        graphVersion: job.graphVersion,
        status: job.status,
      },
    };
  } catch (error) {
    if (error instanceof KnowledgeGraphAutoBuildEnqueueError) throw error;
    throw new KnowledgeGraphAutoBuildEnqueueError(reconciliationId, error);
  }
}

function createBuildStore(env: Partial<NodeJS.ProcessEnv>): KnowledgeGraphBuildEnqueuePort {
  const config = getPostgresRuntimeConfig(env as NodeJS.ProcessEnv);
  if (!shouldUsePostgresPersistence(config)) {
    throw new Error('Automatic Neo4j builds require PostgreSQL persistence.');
  }
  assertPostgresPersistenceConfigured(config);
  const client = getPostgresClient(config);
  if (!client) throw new Error('PostgreSQL graph build control is unavailable.');
  return new PostgresKnowledgeGraphBuildJobStore(client);
}

function resolveAutoBuildEnabled(env: Partial<NodeJS.ProcessEnv>): boolean {
  const value = env.RAG_GRAPH_AUTO_BUILD?.trim().toLowerCase();
  if (!value) return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('RAG_GRAPH_AUTO_BUILD must be true or false.');
}

function resolveMaxPendingJobs(env: Partial<NodeJS.ProcessEnv>): number {
  const raw = env.RAG_KG_BUILD_MAX_PENDING_PER_SCOPE?.trim();
  if (!raw) return 20;
  if (!/^\d+$/.test(raw)) throw new Error('Graph build queue capacity is invalid.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error('Graph build queue capacity must be between 1 and 1000.');
  }
  return value;
}

function createGraphBuildReconciliationId(input: KnowledgeGraphAutoBuildInput): string {
  return createHash('sha256')
    .update([
      input.tenantId,
      input.corpusId,
      input.documentId,
      input.documentVersion,
    ].join('\0'))
    .digest('hex')
    .slice(0, 24);
}
