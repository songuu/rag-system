import { randomUUID } from 'node:crypto';
import type { PostgresQueryClient } from '../postgres/client';
import { queryPostgres } from '../postgres/client';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import type { MiroFishGraphArtifactIdentity } from '../mirofish/graph-artifact-store';
import { createKnowledgeGraphSnapshotIdentity, KnowledgeGraphError } from './contracts';
import { createMiroFishGraphVersion } from './mirofish-adapter';

export type KnowledgeGraphBuildStatus =
  | 'queued'
  | 'running'
  | 'staged'
  | 'validated'
  | 'published'
  | 'failed'
  | 'cancelled';

export interface KnowledgeGraphBuildJob {
  id: string;
  tenantId: string;
  corpusId: string;
  graphVersion: string;
  status: KnowledgeGraphBuildStatus;
  progress: number;
  artifactDigest: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeGraphBuildSource {
  assetId: string;
  documentId: string;
  documentVersion: string;
  sourceName: string;
  contentType: string;
  chunkCount: number;
  updatedAt: string;
}

const JOB_FIELDS = [
  'id::text, tenant_id, corpus_id, graph_version, status, progress, artifact_digest,',
  'error_code, error_message, metadata, attempts, lease_token::text, lease_expires_at,',
  'created_at, updated_at',
].join(' ');

const LOCK_SCOPE_SQL =
  "select pg_advisory_xact_lock(hashtextextended($1 || chr(31) || $2, 0))";

const ENQUEUE_SQL = [
  'with existing as materialized (',
  '  select job.id from public.graph_build_jobs job',
  '  where job.tenant_id = $1 and job.corpus_id = $2 and job.graph_version = $3',
  '), capacity as materialized (',
  '  select count(*)::integer as pending from public.graph_build_jobs job',
  "  where job.tenant_id = $1 and job.corpus_id = $2 and job.status in ('queued', 'running', 'staged', 'validated')",
  '), candidate as (',
  '  select $1::text as tenant_id, $2::text as corpus_id, $3::text as graph_version, $4::jsonb as metadata',
  '  where exists (select 1 from existing) or (select pending from capacity) < $5',
  ')',
  'insert into public.graph_build_jobs (tenant_id, corpus_id, graph_version, metadata)',
  'select tenant_id, corpus_id, graph_version, metadata from candidate',
  'on conflict (tenant_id, corpus_id, graph_version) do update',
  "set status = case when public.graph_build_jobs.status = 'failed' then 'queued' else public.graph_build_jobs.status end,",
  "    progress = case when public.graph_build_jobs.status = 'failed' then 0 else public.graph_build_jobs.progress end,",
  "    artifact_digest = case when public.graph_build_jobs.status = 'failed' then null else public.graph_build_jobs.artifact_digest end,",
  "    error_code = case when public.graph_build_jobs.status = 'failed' then null else public.graph_build_jobs.error_code end,",
  "    error_message = case when public.graph_build_jobs.status = 'failed' then null else public.graph_build_jobs.error_message end,",
  "    metadata = case when public.graph_build_jobs.status = 'failed' then excluded.metadata else public.graph_build_jobs.metadata end,",
  "    attempts = case when public.graph_build_jobs.status = 'failed' then 0 else public.graph_build_jobs.attempts end,",
  "    lease_token = case when public.graph_build_jobs.status = 'failed' then null else public.graph_build_jobs.lease_token end,",
  "    lease_expires_at = case when public.graph_build_jobs.status = 'failed' then null else public.graph_build_jobs.lease_expires_at end,",
  "    updated_at = case when public.graph_build_jobs.status = 'failed' then now() else public.graph_build_jobs.updated_at end",
  "where public.graph_build_jobs.status <> 'failed' or (select pending from capacity) < $5",
  `returning ${JOB_FIELDS}`,
].join('\n');

const COMPLETE_VALIDATED_SQL = [
  'update public.graph_build_jobs',
  "set status = 'validated', progress = 1, artifact_digest = $3,",
  '    lease_token = null, lease_expires_at = null, updated_at = now()',
  "where id = $1::uuid and status = 'running' and lease_token = $4::uuid",
  '  and $2 >= progress',
  `returning ${JOB_FIELDS}`,
].join('\n');

const GET_SQL = [
  `select ${JOB_FIELDS}`,
  'from public.graph_build_jobs',
  'where id = $1::uuid and tenant_id = $2 and corpus_id = $3',
].join('\n');

const DOCUMENT_SOURCE_FIELDS = [
  'id::text as asset_id, external_document_id as document_id,',
  'source_hash as document_version, original_name as source_name, content_type,',
  "(metadata->>'chunks')::integer as chunk_count, updated_at",
].join(' ');

const LIST_DOCUMENT_SOURCES_SQL = [
  `select ${DOCUMENT_SOURCE_FIELDS}`,
  'from public.document_assets',
  'where tenant_id = $1 and corpus_id = $2',
  '  and external_document_id is not null',
  "  and btrim(external_document_id) <> ''",
  "  and btrim(source_hash) <> ''",
  "  and metadata->>'persistence_status' = 'ready'",
  "  and metadata->>'chunks' ~ '^[1-9][0-9]{0,5}$'",
  'order by updated_at desc',
  'limit $3',
].join('\n');

const FIND_DOCUMENT_SOURCE_SQL = [
  `select ${DOCUMENT_SOURCE_FIELDS}`,
  'from public.document_assets',
  'where tenant_id = $1 and corpus_id = $2',
  '  and external_document_id = $3 and source_hash = $4',
  "  and metadata->>'persistence_status' = 'ready'",
  "  and metadata->>'chunks' ~ '^[1-9][0-9]{0,5}$'",
  'limit 1',
].join('\n');

const CLAIM_SQL = [
  'with candidate as (',
  '  select id as candidate_id from public.graph_build_jobs',
  "  where status = 'queued' or (status = 'running' and lease_expires_at <= now())",
  '  order by created_at asc',
  '  limit 1 for update skip locked',
  ')',
  'update public.graph_build_jobs job',
  "set status = 'running', attempts = attempts + 1, lease_token = $1::uuid,",
  '    lease_expires_at = now() + make_interval(secs => $2::double precision / 1000),',
  '    error_code = null, error_message = null, updated_at = now()',
  'from candidate where job.id = candidate.candidate_id',
  `returning ${JOB_FIELDS}`,
].join('\n');

const TRANSITION_SQL = [
  'update public.graph_build_jobs',
  'set status = $3, progress = $4, artifact_digest = coalesce($5, artifact_digest),',
  "    error_code = case when $3 = 'failed' then $6 else null end,",
  "    error_message = case when $3 = 'failed' then $7 else null end,",
  '    metadata = metadata || $8::jsonb,',
  "    lease_token = case when $3 = 'running' then lease_token else null end,",
  "    lease_expires_at = case when $3 = 'running' then lease_expires_at else null end,",
  '    updated_at = now()',
  'where id = $1::uuid and status = $2',
  "  and ($2 <> 'running' or lease_token = $9::uuid)",
  "  and ($3 = 'queued' or $4 >= progress)",
  `returning ${JOB_FIELDS}`,
].join('\n');

const TRANSITIONS: Readonly<Record<KnowledgeGraphBuildStatus, readonly KnowledgeGraphBuildStatus[]>> = {
  queued: ['cancelled'],
  // A webhook delivery failure returns the leased job to the queue. The
  // running lease token still guards the transition, so another worker cannot
  // concurrently retry the same attempt.
  running: ['queued', 'staged', 'failed', 'cancelled'],
  staged: ['validated', 'failed', 'cancelled'],
  validated: ['published', 'failed', 'cancelled'],
  published: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

interface BuildJobRow {
  id: string;
  tenant_id: string;
  corpus_id: string;
  graph_version: string;
  status: string;
  progress: string | number;
  artifact_digest: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata: unknown;
  attempts: string | number;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface BuildSourceRow {
  asset_id: string;
  document_id: string;
  document_version: string;
  source_name: string;
  content_type: string;
  chunk_count: string | number;
  updated_at: string | Date;
}

export class PostgresKnowledgeGraphBuildJobStore {
  private readonly client: PostgresQueryClient;

  constructor(client: PostgresQueryClient) {
    this.client = client;
  }

  async enqueue(
    scope: RagRetrievalScope,
    graphVersionInput: string,
    metadata: Record<string, unknown> = {},
    options: { maxPendingJobs?: number } = {}
  ): Promise<KnowledgeGraphBuildJob> {
    const graphVersion = normalizeVersion(scope, graphVersionInput);
    const normalizedMetadata = normalizeMetadata(metadata);
    return this.enqueueNormalized(
      scope,
      graphVersion,
      normalizedMetadata,
      boundedPendingJobs(options.maxPendingJobs)
    );
  }

  private async enqueueNormalized(
    scope: RagRetrievalScope,
    graphVersion: string,
    metadata: Record<string, unknown>,
    maxPendingJobs: number
  ): Promise<KnowledgeGraphBuildJob> {
    const runTransaction = this.client.withTransaction?.bind(this.client);
    if (!runTransaction) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_UNAVAILABLE',
        'Knowledge graph build enqueue requires a transactional PostgreSQL client.'
      );
    }
    return runTransaction('enqueue knowledge graph build job', async transaction => {
      // The lock must be acquired in an earlier statement so a waiter receives a
      // fresh READ COMMITTED snapshot before checking this scope's queue capacity.
      await queryPostgres(
        transaction,
        LOCK_SCOPE_SQL,
        [scope.tenantId, scope.corpusId],
        'lock knowledge graph build scope'
      );
      const result = await queryPostgres<BuildJobRow>(
        transaction,
        ENQUEUE_SQL,
        [scope.tenantId, scope.corpusId, graphVersion, JSON.stringify(metadata), maxPendingJobs],
        'enqueue knowledge graph build job'
      );
      if (!result.rows[0]) {
        throw new KnowledgeGraphError(
          'KNOWLEDGE_GRAPH_CAPACITY',
          'The knowledge graph build queue is full for this corpus.'
        );
      }
      return toJob(result.rows[0]);
    });
  }

  async enqueueDocumentBuild(
    scope: RagRetrievalScope,
    identity: MiroFishGraphArtifactIdentity,
    metadata: Record<string, unknown> = {},
    options: { maxPendingJobs?: number } = {}
  ): Promise<KnowledgeGraphBuildJob> {
    if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_SCOPE_VIOLATION',
        'The graph build document identity is outside the authenticated scope.'
      );
    }
    if (!scope.allowedTrustLevels.includes(identity.trustLevel)) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_SCOPE_VIOLATION',
        'The graph build trust level is outside the authenticated scope.'
      );
    }
    const normalizedMetadata = normalizeMetadata(metadata);
    return this.enqueueNormalized(
      scope,
      createMiroFishGraphVersion(identity),
      { ...normalizedMetadata, documentIdentity: { ...identity } },
      boundedPendingJobs(options.maxPendingJobs)
    );
  }

  async get(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
    jobId: string
  ): Promise<KnowledgeGraphBuildJob | null> {
    const result = await queryPostgres<BuildJobRow>(
      this.client,
      GET_SQL,
      [requiredUuid(jobId), scope.tenantId, scope.corpusId],
      'read knowledge graph build job'
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async listDocumentSources(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
    limit = 50
  ): Promise<KnowledgeGraphBuildSource[]> {
    const boundedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;
    const result = await queryPostgres<BuildSourceRow>(
      this.client,
      LIST_DOCUMENT_SOURCES_SQL,
      [scope.tenantId, scope.corpusId, boundedLimit],
      'list knowledge graph document sources'
    );
    return result.rows.map(toBuildSource);
  }

  async findDocumentSource(
    scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
    identity: Pick<MiroFishGraphArtifactIdentity, 'documentId' | 'documentVersion'>
  ): Promise<KnowledgeGraphBuildSource | null> {
    const result = await queryPostgres<BuildSourceRow>(
      this.client,
      FIND_DOCUMENT_SOURCE_SQL,
      [scope.tenantId, scope.corpusId, identity.documentId, identity.documentVersion],
      'find knowledge graph document source'
    );
    return result.rows[0] ? toBuildSource(result.rows[0]) : null;
  }

  async claimNext(options: { leaseMs?: number } = {}): Promise<KnowledgeGraphBuildJob | null> {
    const leaseMs = boundedLeaseMs(options.leaseMs);
    const result = await queryPostgres<BuildJobRow>(
      this.client,
      CLAIM_SQL,
      [randomUUID(), leaseMs],
      'claim knowledge graph build job'
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async transition(input: {
    jobId: string;
    expectedStatus: KnowledgeGraphBuildStatus;
    status: KnowledgeGraphBuildStatus;
    progress: number;
    artifactDigest?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
    leaseToken?: string;
  }): Promise<KnowledgeGraphBuildJob> {
    if (!TRANSITIONS[input.expectedStatus].includes(input.status)) {
      throw new Error(`Invalid graph build transition: ${input.expectedStatus} -> ${input.status}.`);
    }
    if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
      throw new Error('Graph build progress must be between 0 and 1.');
    }
    if (input.expectedStatus === 'running' && !input.leaseToken) {
      throw new Error('A running graph build transition requires its lease token.');
    }
    if (input.status === 'failed' && (!input.errorCode || !input.errorMessage)) {
      throw new Error('A failed graph build transition requires an error code and message.');
    }
    const result = await queryPostgres<BuildJobRow>(
      this.client,
      TRANSITION_SQL,
      [
        requiredUuid(input.jobId),
        input.expectedStatus,
        input.status,
        input.progress,
        normalizeDigest(input.artifactDigest),
        boundedOptionalText(input.errorCode, 128),
        boundedOptionalText(input.errorMessage, 2_000),
        JSON.stringify(input.metadata ?? {}),
        input.leaseToken ? requiredUuid(input.leaseToken) : null,
      ],
      'transition knowledge graph build job'
    );
    if (!result.rows[0]) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        'The graph build status or lease changed before the transition.'
      );
    }
    return toJob(result.rows[0]);
  }

  async completeValidated(input: {
    jobId: string;
    progress: number;
    artifactDigest: string;
    leaseToken: string;
  }): Promise<KnowledgeGraphBuildJob> {
    if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
      throw new Error('Graph build progress must be between 0 and 1.');
    }
    const result = await queryPostgres<BuildJobRow>(
      this.client,
      COMPLETE_VALIDATED_SQL,
      [
        requiredUuid(input.jobId),
        input.progress,
        normalizeDigest(input.artifactDigest),
        requiredUuid(input.leaseToken),
      ],
      'atomically validate knowledge graph build job'
    );
    if (!result.rows[0]) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        'The graph build status or lease changed before validation.'
      );
    }
    return toJob(result.rows[0]);
  }
}

const RESERVED_METADATA_KEYS = new Set([
  'tenantId', 'corpusId', 'graphVersion', 'documentIdentity',
]);
const MAX_METADATA_BYTES = 16 * 1024;

function normalizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const normalized = requiredRecord(metadata);
  for (const key of Object.keys(normalized)) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new Error(`Graph build metadata key ${key} is reserved.`);
    }
  }
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('Graph build metadata is too large.');
  }
  return structuredClone(normalized);
}

function toJob(row: BuildJobRow): KnowledgeGraphBuildJob {
  return {
    id: requiredUuid(row.id),
    tenantId: requiredText(row.tenant_id, 'tenant'),
    corpusId: requiredText(row.corpus_id, 'corpus'),
    graphVersion: normalizeVersion(
      { tenantId: row.tenant_id, corpusId: row.corpus_id },
      row.graph_version
    ),
    status: requiredStatus(row.status),
    progress: requiredProgress(row.progress),
    artifactDigest: normalizeDigest(row.artifact_digest),
    errorCode: boundedOptionalText(row.error_code, 128),
    errorMessage: boundedOptionalText(row.error_message, 2_000),
    metadata: requiredRecord(row.metadata),
    attempts: requiredAttempts(row.attempts),
    leaseToken: row.lease_token === null ? null : requiredUuid(row.lease_token),
    leaseExpiresAt: row.lease_expires_at === null ? null : toIso(row.lease_expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toBuildSource(row: BuildSourceRow): KnowledgeGraphBuildSource {
  const chunkCount = Number(row.chunk_count);
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 999_999) {
    throw new Error('Knowledge graph build source chunk count is malformed.');
  }
  return {
    assetId: requiredText(row.asset_id, 'source asset'),
    documentId: requiredText(row.document_id, 'source document'),
    documentVersion: requiredText(row.document_version, 'source version'),
    sourceName: requiredText(row.source_name, 'source name'),
    contentType: requiredText(row.content_type, 'source content type'),
    chunkCount,
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeVersion(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
  graphVersion: string
): string {
  return createKnowledgeGraphSnapshotIdentity({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    graphVersion,
  }).graphVersion;
}

function requiredStatus(value: string): KnowledgeGraphBuildStatus {
  if (Object.hasOwn(TRANSITIONS, value)) return value as KnowledgeGraphBuildStatus;
  throw new Error('Graph build status is malformed.');
}

function requiredUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Graph build identifier is malformed.');
  }
  return value;
}

function requiredText(value: string, label: string): string {
  if (!value?.trim()) throw new Error(`Graph build ${label} is malformed.`);
  return value;
}

function requiredProgress(value: string | number): number {
  const progress = Number(value);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Graph build progress is malformed.');
  }
  return progress;
}

function requiredAttempts(value: string | number): number {
  const attempts = Number(value);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error('Graph build attempts are malformed.');
  }
  return attempts;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Graph build metadata is malformed.');
  }
  return value as Record<string, unknown>;
}

function normalizeDigest(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('Graph artifact digest is malformed.');
  return value;
}

function boundedOptionalText(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error('Graph build error detail is malformed.');
  return normalized;
}

function boundedLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? 60_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new Error('Graph build lease must be between 1000 and 3600000 milliseconds.');
  }
  return leaseMs;
}

function boundedPendingJobs(value: number | undefined): number {
  const maximum = value ?? 20;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000) {
    throw new Error('Graph build pending capacity must be between 1 and 1000.');
  }
  return maximum;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Graph build timestamp is malformed.');
  return date.toISOString();
}
