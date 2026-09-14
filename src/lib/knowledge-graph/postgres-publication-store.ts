import { randomUUID } from 'node:crypto';
import type { PostgresQueryClient } from '../postgres/client';
import { queryPostgres } from '../postgres/client';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import {
  createKnowledgeGraphSnapshotIdentity,
  KnowledgeGraphError,
  type KnowledgeGraphActivePointer,
} from './contracts';

export interface KnowledgeGraphPublicationEvent {
  id: string;
  eventType: 'graph.snapshot.activated' | 'graph.snapshot.deactivated';
  graphVersion: string | null;
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ClaimedKnowledgeGraphPublicationEvent
extends KnowledgeGraphPublicationEvent {
  tenantId: string;
  corpusId: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface KnowledgeGraphSnapshotLease {
  tenantId: string;
  corpusId: string;
  graphVersion: string;
  operation: 'activate' | 'delete';
  operationId: string;
  leaseExpiresAt: string;
}

export type ExpiredKnowledgeGraphSnapshotMutation = KnowledgeGraphSnapshotLease;

export interface KnowledgeGraphPublicationStore {
  registerStagedSnapshot(
    scope: RagRetrievalScope,
    graphVersion: string
  ): Promise<void>;
  getActive(scope: RagRetrievalScope): Promise<KnowledgeGraphActivePointer>;
  compareAndSetActive(
    scope: RagRetrievalScope,
    graphVersion: string | null,
    expectedRevision: number
  ): Promise<KnowledgeGraphActivePointer>;
  listPendingEvents(
    scope: RagRetrievalScope,
    options?: { limit?: number }
  ): Promise<KnowledgeGraphPublicationEvent[]>;
  acknowledgeEvent(scope: RagRetrievalScope, eventId: string): Promise<boolean>;
  acquireSnapshotLease(
    scope: RagRetrievalScope,
    graphVersion: string,
    operation: 'activate' | 'delete',
    options?: { leaseMs?: number }
  ): Promise<KnowledgeGraphSnapshotLease>;
  compareAndSetActiveWithLease(
    scope: RagRetrievalScope,
    graphVersion: string,
    expectedRevision: number,
    lease: KnowledgeGraphSnapshotLease
  ): Promise<KnowledgeGraphActivePointer>;
  resolveSnapshotLease(
    scope: RagRetrievalScope,
    lease: KnowledgeGraphSnapshotLease,
    resolution: 'release' | 'deleted'
  ): Promise<boolean>;
}

const READ_ACTIVE_SQL = [
  'select graph_version, revision, updated_at',
  'from public.graph_active_snapshots',
  'where tenant_id = $1 and corpus_id = $2',
].join('\n');

const CAS_ACTIVE_SQL = [
  'with activated as (',
  '  insert into public.graph_active_snapshots (',
  '    tenant_id, corpus_id, graph_version, revision, updated_at',
  '  )',
  '  select $1, $2, $3, 1, now()',
  '  where ($4::bigint = 0 or exists (',
  '    select 1 from public.graph_active_snapshots current_pointer',
  '    where current_pointer.tenant_id = $1 and current_pointer.corpus_id = $2',
  '      and current_pointer.revision = $4::bigint',
  '  ))',
  '  on conflict (tenant_id, corpus_id) do update set',
  '    graph_version = excluded.graph_version,',
  '    revision = public.graph_active_snapshots.revision + 1,',
  '    updated_at = now()',
  '  where public.graph_active_snapshots.revision = $4::bigint',
  '  returning graph_version, revision, updated_at',
  '), queued as (',
  '  insert into public.graph_publication_outbox (',
  '    tenant_id, corpus_id, event_type, graph_version, revision, payload',
  '  )',
  '  select $1, $2, $5, graph_version, revision,',
  '    jsonb_build_object(',
  "      'graphVersion', graph_version, 'revision', revision,",
  "      'expectedRevision', $4::bigint",
  '    )',
  '  from activated',
  '  on conflict (tenant_id, corpus_id, revision) do nothing',
  '  returning id',
  '), published_build as (',
  '  update public.graph_build_jobs job',
  "  set status = 'published', progress = 1, lease_token = null,",
  '    lease_expires_at = null, updated_at = now()',
  '  from activated',
  '  where job.tenant_id = $1 and job.corpus_id = $2',
  '    and job.graph_version = $3',
  "    and job.status = 'validated'",
  '  returning job.id',
  ')',
  'select graph_version, revision, updated_at',
  'from activated',
].join('\n');

const CAS_ACTIVE_WITH_LEASE_SQL = CAS_ACTIVE_SQL
  .replace(
    '  where ($4::bigint = 0 or exists (\n    select 1 from public.graph_active_snapshots current_pointer\n    where current_pointer.tenant_id = $1 and current_pointer.corpus_id = $2\n      and current_pointer.revision = $4::bigint\n  ))',
    "  where ($4::bigint = 0 or exists (select 1 from public.graph_active_snapshots current_pointer where current_pointer.tenant_id = $1 and current_pointer.corpus_id = $2 and current_pointer.revision = $4::bigint)) and exists (select 1 from public.graph_snapshot_lifecycle lifecycle where lifecycle.tenant_id = $1 and lifecycle.corpus_id = $2 and lifecycle.graph_version = $3 and lifecycle.state = 'activating' and lifecycle.operation_id = $6::uuid and lifecycle.lease_expires_at > now())"
  )
  .replace(
    '  where public.graph_active_snapshots.revision = $4::bigint',
    "  where public.graph_active_snapshots.revision = $4::bigint and exists (select 1 from public.graph_snapshot_lifecycle lifecycle where lifecycle.tenant_id = $1 and lifecycle.corpus_id = $2 and lifecycle.graph_version = $3 and lifecycle.state = 'activating' and lifecycle.operation_id = $6::uuid and lifecycle.lease_expires_at > now())"
  );

const LIST_OUTBOX_SQL = [
  'select id::text, event_type, graph_version, revision, payload, created_at',
  'from public.graph_publication_outbox',
  'where tenant_id = $1 and corpus_id = $2',
  '  and published_at is null and dead_lettered_at is null',
  'order by revision asc',
  'limit $3',
].join('\n');

const ACK_OUTBOX_SQL = [
  'update public.graph_publication_outbox',
  'set published_at = now()',
  'where tenant_id = $1 and corpus_id = $2 and id = $3::uuid',
  '  and published_at is null and dead_lettered_at is null and lease_token is null',
  'returning id::text',
].join('\n');

const REGISTER_STAGED_SNAPSHOT_SQL = [
  'insert into public.graph_snapshot_lifecycle (',
  '  tenant_id, corpus_id, graph_version, state, operation_id, lease_expires_at',
  ') values ($1, $2, $3, \'staged\', null, null)',
  'on conflict (tenant_id, corpus_id, graph_version) do update set',
  '  updated_at = public.graph_snapshot_lifecycle.updated_at',
  "where public.graph_snapshot_lifecycle.state = 'staged'",
  'returning graph_version',
].join('\n');

const ACQUIRE_SNAPSHOT_LEASE_SQL = [
  'with updated as (',
  '  update public.graph_snapshot_lifecycle lifecycle set',
  '    state = $4, operation_id = $5::uuid,',
  '    lease_expires_at = now() + make_interval(secs => $6::double precision / 1000),',
  '    updated_at = now()',
  '  where lifecycle.tenant_id = $1 and lifecycle.corpus_id = $2',
  '    and lifecycle.graph_version = $3',
  "    and (lifecycle.state = 'staged'",
  "      or (lifecycle.state = 'activating' and lifecycle.lease_expires_at <= now())",
  "      or (lifecycle.state = 'deleting'",
  "        and lifecycle.lease_expires_at <= now() and $4 = 'deleting'))",
  "  and ($4 <> 'deleting' or not exists (",
  '    select 1 from public.graph_active_snapshots active',
  '    where active.tenant_id = $1 and active.corpus_id = $2 and active.graph_version = $3',
  '  ))',
  '  returning lifecycle.state, lifecycle.operation_id::text, lifecycle.lease_expires_at',
  '), inserted as (',
  '  insert into public.graph_snapshot_lifecycle (',
  '    tenant_id, corpus_id, graph_version, state, operation_id, lease_expires_at',
  '  )',
  '  select $1, $2, $3, $4, $5::uuid,',
  '    now() + make_interval(secs => $6::double precision / 1000)',
  "  where $4 = 'deleting'",
  '    and not exists (select 1 from public.graph_active_snapshots active',
  '      where active.tenant_id = $1 and active.corpus_id = $2 and active.graph_version = $3)',
  '    and not exists (select 1 from public.graph_snapshot_lifecycle lifecycle',
  '      where lifecycle.tenant_id = $1 and lifecycle.corpus_id = $2',
  '        and lifecycle.graph_version = $3)',
  '  on conflict (tenant_id, corpus_id, graph_version) do nothing',
  '  returning state, operation_id::text, lease_expires_at',
  ')',
  'select state, operation_id, lease_expires_at from updated',
  'union all',
  'select state, operation_id, lease_expires_at from inserted',
  'limit 1',
].join('\n');

const RESOLVE_SNAPSHOT_LEASE_SQL = [
  'update public.graph_snapshot_lifecycle',
  'set state = $6, operation_id = null, lease_expires_at = null, updated_at = now()',
  'where tenant_id = $1 and corpus_id = $2 and graph_version = $3',
  '  and state = $4 and operation_id = $5::uuid',
  'returning graph_version',
].join('\n');

const LIST_EXPIRED_MUTATIONS_SQL = [
  'select tenant_id, corpus_id, graph_version, state, operation_id::text, lease_expires_at',
  'from public.graph_snapshot_lifecycle',
  "where state in ('activating', 'deleting') and lease_expires_at <= now()",
  'order by lease_expires_at asc',
  'limit $1',
].join('\n');

const CLAIM_OUTBOX_SQL = [
  'with candidates as (',
  '  select candidate.id',
  '  from public.graph_publication_outbox candidate',
  '  where candidate.published_at is null and candidate.dead_lettered_at is null',
  '    and candidate.available_at <= now()',
  '    and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())',
  '    and not exists (',
  '      select 1 from public.graph_publication_outbox earlier',
  '      where earlier.tenant_id = candidate.tenant_id',
  '        and earlier.corpus_id = candidate.corpus_id',
  '        and earlier.revision < candidate.revision',
  '        and earlier.published_at is null and earlier.dead_lettered_at is null',
  '    )',
  '  order by candidate.created_at asc',
  '  limit $1',
  '  for update skip locked',
  ')',
  'update public.graph_publication_outbox event',
  'set lease_token = $2::uuid,',
  '    lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),',
  '    attempts = attempts + 1',
  'from candidates',
  'where event.id = candidates.id',
  'returning event.id::text, event.tenant_id, event.corpus_id, event.event_type,',
  '  event.graph_version, event.revision, event.payload, event.created_at,',
  '  event.attempts, event.lease_token::text, event.lease_expires_at',
].join('\n');

const ACK_CLAIM_SQL = [
  'update public.graph_publication_outbox',
  'set published_at = now(), lease_token = null, lease_expires_at = null, last_error = null',
  'where id = $1::uuid and lease_token = $2::uuid',
  '  and published_at is null and dead_lettered_at is null',
  'returning id::text',
].join('\n');

const RETRY_CLAIM_SQL = [
  'update public.graph_publication_outbox',
  'set dead_lettered_at = case when attempts >= $3 then now() else null end,',
  '    available_at = case when attempts >= $3 then available_at',
  '      else now() + make_interval(secs => $4::double precision / 1000) end,',
  '    lease_token = null, lease_expires_at = null, last_error = left($5, 2000)',
  'where id = $1::uuid and lease_token = $2::uuid',
  '  and published_at is null and dead_lettered_at is null',
  'returning dead_lettered_at is not null as dead_lettered',
].join('\n');

interface ActiveRow {
  graph_version: string | null;
  revision: string | number;
  updated_at: string | Date;
}

interface OutboxRow {
  id: string;
  event_type: string;
  graph_version: string | null;
  revision: string | number;
  payload: unknown;
  created_at: string | Date;
  tenant_id?: string;
  corpus_id?: string;
  attempts?: string | number;
  lease_token?: string;
  lease_expires_at?: string | Date;
}

interface SnapshotLeaseRow {
  state: string;
  operation_id: string;
  lease_expires_at: string | Date;
  tenant_id?: string;
  corpus_id?: string;
  graph_version?: string;
}

export class PostgresKnowledgeGraphPublicationStore
implements KnowledgeGraphPublicationStore {
  private readonly client: PostgresQueryClient;

  constructor(client: PostgresQueryClient) {
    this.client = client;
  }

  async registerStagedSnapshot(
    scope: RagRetrievalScope,
    graphVersionInput: string
  ): Promise<void> {
    const graphVersion = normalizeGraphVersion(scope, graphVersionInput);
    const result = await queryPostgres<{ graph_version: string }>(
      this.client,
      REGISTER_STAGED_SNAPSHOT_SQL,
      [scope.tenantId, scope.corpusId, graphVersion],
      'register staged knowledge graph snapshot'
    );
    if (!result.rows[0]) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        'The graph snapshot is deleted or locked by another operation.'
      );
    }
  }

  async getActive(scope: RagRetrievalScope): Promise<KnowledgeGraphActivePointer> {
    const result = await queryPostgres<ActiveRow>(
      this.client,
      READ_ACTIVE_SQL,
      [scope.tenantId, scope.corpusId],
      'read active knowledge graph snapshot'
    );
    const row = result.rows[0];
    return row
      ? toPointer(scope, row)
      : {
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: null,
          revision: 0,
          updatedAt: new Date(0).toISOString(),
        };
  }

  async compareAndSetActive(
    scope: RagRetrievalScope,
    graphVersionInput: string | null,
    expectedRevision: number
  ): Promise<KnowledgeGraphActivePointer> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Knowledge graph active revision must be a non-negative integer.');
    }
    if (graphVersionInput !== null) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        'PostgreSQL graph activation requires an acquired snapshot lease.'
      );
    }
    const graphVersion = graphVersionInput === null
      ? null
      : createKnowledgeGraphSnapshotIdentity({
          tenantId: scope.tenantId,
          corpusId: scope.corpusId,
          graphVersion: graphVersionInput,
        }).graphVersion;
    const eventType = graphVersion
      ? 'graph.snapshot.activated'
      : 'graph.snapshot.deactivated';
    const result = await queryPostgres<ActiveRow>(
      this.client,
      CAS_ACTIVE_SQL,
      [scope.tenantId, scope.corpusId, graphVersion, expectedRevision, eventType],
      'compare and set active knowledge graph snapshot'
    );
    const row = result.rows[0];
    if (!row) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        'The active graph revision changed before publication.'
      );
    }
    return toPointer(scope, row);
  }

  async acquireSnapshotLease(
    scope: RagRetrievalScope,
    graphVersionInput: string,
    operation: 'activate' | 'delete',
    options: { leaseMs?: number } = {}
  ): Promise<KnowledgeGraphSnapshotLease> {
    const graphVersion = normalizeGraphVersion(scope, graphVersionInput);
    const leaseMs = boundedMilliseconds(options.leaseMs, 30_000, 'Snapshot lease');
    const operationId = randomUUID();
    const state = operation === 'activate' ? 'activating' : 'deleting';
    const result = await queryPostgres<SnapshotLeaseRow>(
      this.client,
      ACQUIRE_SNAPSHOT_LEASE_SQL,
      [scope.tenantId, scope.corpusId, graphVersion, state, operationId, leaseMs],
      `acquire knowledge graph ${operation} lease`
    );
    const row = result.rows[0];
    if (!row) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        operation === 'delete'
          ? 'The graph snapshot is active, deleted, or locked by another operation.'
          : 'The graph snapshot is deleted or locked by another operation.'
      );
    }
    return {
      tenantId: scope.tenantId,
      corpusId: scope.corpusId,
      graphVersion,
      operation,
      operationId: requiredUuid(row.operation_id),
      leaseExpiresAt: toIsoString(row.lease_expires_at),
    };
  }

  async compareAndSetActiveWithLease(
    scope: RagRetrievalScope,
    graphVersionInput: string,
    expectedRevision: number,
    lease: KnowledgeGraphSnapshotLease
  ): Promise<KnowledgeGraphActivePointer> {
    const graphVersion = normalizeGraphVersion(scope, graphVersionInput);
    assertMatchingLease(scope, graphVersion, lease, 'activate');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Knowledge graph active revision must be a non-negative integer.');
    }
    const result = await queryPostgres<ActiveRow>(
      this.client,
      CAS_ACTIVE_WITH_LEASE_SQL,
      [
        scope.tenantId,
        scope.corpusId,
        graphVersion,
        expectedRevision,
        'graph.snapshot.activated',
        lease.operationId,
      ],
      'compare and set active knowledge graph snapshot with lease'
    );
    const row = result.rows[0];
    if (!row) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_CONFLICT',
        'The active graph revision or activation lease changed before publication.'
      );
    }
    return toPointer(scope, row);
  }

  async resolveSnapshotLease(
    scope: RagRetrievalScope,
    lease: KnowledgeGraphSnapshotLease,
    resolution: 'release' | 'deleted'
  ): Promise<boolean> {
    assertMatchingLease(scope, lease.graphVersion, lease, lease.operation);
    if (resolution === 'deleted' && lease.operation !== 'delete') {
      throw new Error('Only a delete lease can create a graph snapshot tombstone.');
    }
    if (resolution === 'release' && lease.operation === 'delete') {
      throw new Error('A delete lease must resolve to a graph snapshot tombstone.');
    }
    const state = lease.operation === 'activate' ? 'activating' : 'deleting';
    const targetState = resolution === 'deleted' ? 'deleted' : 'staged';
    const result = await queryPostgres<{ graph_version: string }>(
      this.client,
      RESOLVE_SNAPSHOT_LEASE_SQL,
      [
        scope.tenantId,
        scope.corpusId,
        lease.graphVersion,
        state,
        lease.operationId,
        targetState,
      ],
      `resolve knowledge graph ${lease.operation} lease`
    );
    return result.rows.length > 0;
  }

  async listExpiredSnapshotMutations(
    options: { limit?: number } = {}
  ): Promise<ExpiredKnowledgeGraphSnapshotMutation[]> {
    const limit = boundedLimit(options.limit);
    const result = await queryPostgres<SnapshotLeaseRow>(
      this.client,
      LIST_EXPIRED_MUTATIONS_SQL,
      [limit],
      'list expired knowledge graph snapshot mutations'
    );
    return result.rows.map(row => {
      const operation = row.state === 'activating'
        ? 'activate'
        : row.state === 'deleting'
          ? 'delete'
          : invalidSnapshotState();
      const tenantId = requiredScopePart(row.tenant_id, 'tenant');
      const corpusId = requiredScopePart(row.corpus_id, 'corpus');
      const graphVersion = normalizeGraphVersion({ tenantId, corpusId }, row.graph_version);
      return {
        tenantId,
        corpusId,
        graphVersion,
        operation,
        operationId: requiredUuid(row.operation_id),
        leaseExpiresAt: toIsoString(row.lease_expires_at),
      };
    });
  }

  async listPendingEvents(
    scope: RagRetrievalScope,
    options: { limit?: number } = {}
  ): Promise<KnowledgeGraphPublicationEvent[]> {
    const limit = boundedLimit(options.limit);
    const result = await queryPostgres<OutboxRow>(
      this.client,
      LIST_OUTBOX_SQL,
      [scope.tenantId, scope.corpusId, limit],
      'list pending knowledge graph publication events'
    );
    return result.rows.map(row => ({
      id: requiredUuid(row.id),
      eventType: requiredEventType(row.event_type),
      graphVersion: optionalGraphVersion(row.graph_version, scope),
      revision: requiredRevision(row.revision),
      payload: requiredRecord(row.payload),
      createdAt: toIsoString(row.created_at),
    }));
  }

  async acknowledgeEvent(scope: RagRetrievalScope, eventId: string): Promise<boolean> {
    const result = await queryPostgres<{ id: string }>(
      this.client,
      ACK_OUTBOX_SQL,
      [scope.tenantId, scope.corpusId, requiredUuid(eventId)],
      'acknowledge knowledge graph publication event'
    );
    return result.rows.length > 0;
  }

  async claimPendingEvents(
    options: { limit?: number; leaseMs?: number } = {}
  ): Promise<ClaimedKnowledgeGraphPublicationEvent[]> {
    const limit = boundedLimit(options.limit);
    const leaseMs = boundedMilliseconds(options.leaseMs, 30_000, 'Outbox lease');
    const leaseToken = randomUUID();
    const result = await queryPostgres<OutboxRow>(
      this.client,
      CLAIM_OUTBOX_SQL,
      [limit, leaseToken, leaseMs],
      'claim knowledge graph publication events'
    );
    return result.rows.map(row => toClaimedEvent(row));
  }

  async acknowledgeClaim(eventId: string, leaseToken: string): Promise<boolean> {
    const result = await queryPostgres<{ id: string }>(
      this.client,
      ACK_CLAIM_SQL,
      [requiredUuid(eventId), requiredUuid(leaseToken)],
      'acknowledge claimed knowledge graph publication event'
    );
    return result.rows.length > 0;
  }

  async retryClaim(
    eventId: string,
    leaseToken: string,
    options: { maxAttempts?: number; retryDelayMs?: number; error: unknown }
  ): Promise<'retry' | 'dead-letter' | 'lost-lease'> {
    const maxAttempts = boundedAttempts(options.maxAttempts);
    const retryDelayMs = boundedMilliseconds(
      options.retryDelayMs,
      5_000,
      'Outbox retry delay',
      86_400_000
    );
    const result = await queryPostgres<{ dead_lettered: boolean }>(
      this.client,
      RETRY_CLAIM_SQL,
      [
        requiredUuid(eventId),
        requiredUuid(leaseToken),
        maxAttempts,
        retryDelayMs,
        safeErrorMessage(options.error),
      ],
      'retry claimed knowledge graph publication event'
    );
    const row = result.rows[0];
    if (!row) return 'lost-lease';
    return row.dead_lettered ? 'dead-letter' : 'retry';
  }
}

function toClaimedEvent(row: OutboxRow): ClaimedKnowledgeGraphPublicationEvent {
  const tenantId = requiredScopePart(row.tenant_id, 'tenant');
  const corpusId = requiredScopePart(row.corpus_id, 'corpus');
  return {
    id: requiredUuid(row.id),
    tenantId,
    corpusId,
    eventType: requiredEventType(row.event_type),
    graphVersion: row.graph_version === null
      ? null
      : normalizeGraphVersion({ tenantId, corpusId }, row.graph_version),
    revision: requiredRevision(row.revision),
    payload: requiredRecord(row.payload),
    createdAt: toIsoString(row.created_at),
    attempt: requiredPositiveInteger(row.attempts, 'Outbox attempt'),
    leaseToken: requiredUuid(row.lease_token),
    leaseExpiresAt: toIsoString(row.lease_expires_at as string | Date),
  };
}

function toPointer(
  scope: RagRetrievalScope,
  row: ActiveRow
): KnowledgeGraphActivePointer {
  return {
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    graphVersion: optionalGraphVersion(row.graph_version, scope),
    revision: requiredRevision(row.revision),
    updatedAt: toIsoString(row.updated_at),
  };
}

function optionalGraphVersion(
  value: unknown,
  scope: RagRetrievalScope
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Graph publication version is malformed.');
  return createKnowledgeGraphSnapshotIdentity({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    graphVersion: value,
  }).graphVersion;
}

function normalizeGraphVersion(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
  value: unknown
): string {
  if (typeof value !== 'string') throw new Error('Graph publication version is malformed.');
  return createKnowledgeGraphSnapshotIdentity({
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    graphVersion: value,
  }).graphVersion;
}

function requiredRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Graph publication revision is malformed.');
  }
  return revision;
}

function requiredUuid(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('Graph publication event id is malformed.');
  }
  return value;
}

function requiredEventType(
  value: unknown
): KnowledgeGraphPublicationEvent['eventType'] {
  if (value === 'graph.snapshot.activated' || value === 'graph.snapshot.deactivated') {
    return value;
  }
  throw new Error('Graph publication event type is malformed.');
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Graph publication event payload is malformed.');
  }
  return value as Record<string, unknown>;
}

function toIsoString(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Graph publication timestamp is malformed.');
  }
  return date.toISOString();
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Graph publication event limit must be between 1 and 1000.');
  }
  return limit;
}

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
  label: string,
  max = 600_000
): number {
  const milliseconds = value ?? fallback;
  if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > max) {
    throw new Error(`${label} must be between 100 and ${max} milliseconds.`);
  }
  return milliseconds;
}

function boundedAttempts(value: number | undefined): number {
  const attempts = value ?? 5;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error('Outbox max attempts must be between 1 and 100.');
  }
  return attempts;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${label} is malformed.`);
  }
  return result;
}

function requiredScopePart(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Graph publication ${label} scope is malformed.`);
  }
  return value;
}

function assertMatchingLease(
  scope: Pick<RagRetrievalScope, 'tenantId' | 'corpusId'>,
  graphVersion: string,
  lease: KnowledgeGraphSnapshotLease,
  operation: KnowledgeGraphSnapshotLease['operation']
): void {
  if (
    lease.tenantId !== scope.tenantId
    || lease.corpusId !== scope.corpusId
    || lease.graphVersion !== graphVersion
    || lease.operation !== operation
  ) {
    throw new Error('Knowledge graph snapshot lease does not match the requested operation.');
  }
  requiredUuid(lease.operationId);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Publication handler failed.';
  return message.replace(/(?:postgres(?:ql)?|neo4j):\/\/[^\s]+/gi, '[redacted]').slice(0, 2_000);
}

function invalidSnapshotState(): never {
  throw new Error('Knowledge graph snapshot lifecycle state is malformed.');
}
