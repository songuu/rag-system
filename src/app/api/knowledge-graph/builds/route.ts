import { NextResponse } from 'next/server';
import { KnowledgeGraphError } from '@/lib/knowledge-graph/contracts';
import {
  acquireKnowledgeGraphBuildPermit,
  boundedInteger,
  knowledgeGraphHttpError,
  projectKnowledgeGraphBuildJobForHttp,
  requiredString,
  requiredTrustLevel,
} from '@/lib/knowledge-graph/http';
import {
  PostgresKnowledgeGraphBuildJobStore,
  type KnowledgeGraphBuildSource,
} from '@/lib/knowledge-graph/postgres-graph-build-store';
import { getPostgresClient } from '@/lib/postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
} from '@/lib/postgres/env';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';
import {
  readJsonObjectWithLimit,
  RequestValidationError,
} from '@/lib/security/request-validation';

const BODY_LIMIT = 16 * 1024;

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const security = await resolveRagSecurityContext(request, {
      capability: 'ingest',
      requestedCorpusId: request.headers.get('x-rag-corpus-id')?.trim() || undefined,
    });
    requestId = security.requestId;
    const body = await readJsonObjectWithLimit(request, BODY_LIMIT);
    const scope = createRetrievalScope({
      tenantId: security.tenantId,
      corpusId: security.corpusId,
      allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
      enforceIsolation: security.enforceIsolation,
    });
    const metadata = optionalMetadata(body.metadata);
    const identity = {
      tenantId: security.tenantId,
      corpusId: security.corpusId,
      documentId: requiredString(body.documentId, 'documentId'),
      documentVersion: requiredString(body.documentVersion, 'documentVersion'),
      trustLevel: requiredTrustLevel(body.trustLevel),
    };
    acquireKnowledgeGraphBuildPermit(security);
    const maxPendingJobs = boundedInteger(
      process.env.RAG_KG_BUILD_MAX_PENDING_PER_SCOPE,
      'buildQueueCapacity',
      20,
      1,
      1_000
    );
    const store = requireBuildStore();
    const source = await store.findDocumentSource(scope, identity);
    if (!source) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_NOT_FOUND',
        'Vectorized document source not found in PostgreSQL.'
      );
    }
    const job = await store.enqueueDocumentBuild(
      scope,
      identity,
      {
        ...metadata,
        trigger: 'manual-console',
        postgresAssetId: source.assetId,
        actorId: security.actorId,
        chunkCount: source.chunkCount,
        sourceName: source.sourceName,
      },
      { maxPendingJobs }
    );
    return NextResponse.json({
      success: true,
      data: projectKnowledgeGraphBuildJobForHttp(job),
      requestId,
    }, { status: 202 });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const security = await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: request.headers.get('x-rag-corpus-id')?.trim() || undefined,
    });
    requestId = security.requestId;
    const scope = createRetrievalScope({
      tenantId: security.tenantId,
      corpusId: security.corpusId,
      allowedTrustLevels: ['trusted', 'reviewed', 'external'],
      enforceIsolation: security.enforceIsolation,
    });
    const searchParams = new URL(request.url).searchParams;
    const store = requireBuildStore();
    const requestedJobId = searchParams.get('jobId');
    if (!requestedJobId) {
      const limit = boundedInteger(searchParams.get('limit'), 'limit', 50, 1, 100);
      const sources = await store.listDocumentSources(scope, limit);
      return NextResponse.json({
        success: true,
        data: { sources: sources.map(projectKnowledgeGraphBuildSourceForHttp) },
        requestId,
      });
    }
    const jobId = requiredJobId(requestedJobId);
    const job = await store.get(scope, jobId);
    const trustLevel = readJobTrustLevel(job?.metadata.documentIdentity);
    if (!job || !trustLevel || !scope.allowedTrustLevels.includes(trustLevel)) {
      throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_NOT_FOUND', 'Graph build job not found.');
    }
    return NextResponse.json({
      success: true,
      data: projectKnowledgeGraphBuildJobForHttp(job),
      requestId,
    });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

function projectKnowledgeGraphBuildSourceForHttp(source: KnowledgeGraphBuildSource) {
  return {
    documentId: source.documentId,
    documentVersion: source.documentVersion,
    sourceName: source.sourceName,
    contentType: source.contentType,
    chunkCount: source.chunkCount,
    updatedAt: source.updatedAt,
  };
}

function requiredJobId(value: unknown): string {
  const jobId = requiredString(value, 'jobId', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new RequestValidationError('INVALID_JOBID', 'jobId is invalid.');
  }
  return jobId;
}

function readJobTrustLevel(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const trustLevel = (value as Record<string, unknown>).trustLevel;
  return trustLevel === 'trusted'
    || trustLevel === 'reviewed'
    || trustLevel === 'external'
    || trustLevel === 'quarantined'
    ? trustLevel
    : undefined;
}

function requireBuildStore(): PostgresKnowledgeGraphBuildJobStore {
  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_UNAVAILABLE',
      'Durable graph builds require PostgreSQL persistence.'
    );
  }
  assertPostgresPersistenceConfigured(config);
  const client = getPostgresClient(config);
  if (!client) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_UNAVAILABLE',
      'PostgreSQL graph build control is unavailable.'
    );
  }
  return new PostgresKnowledgeGraphBuildJobStore(client);
}

function optionalMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('INVALID_METADATA', 'metadata must be an object.');
  }
  const entries = Object.entries(value);
  boundedInteger(entries.length, 'metadataFields', 0, 0, 64);
  return value as Record<string, unknown>;
}
