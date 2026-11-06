import { createHash } from 'node:crypto';
import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { KnowledgeGraphError, type KnowledgeGraphSnapshot } from '../knowledge-graph/contracts';
import { createMiroFishGraphVersion, mapMiroFishArtifactToKnowledgeGraphSnapshot, mapKnowledgeGraphSnapshotToMiroFishArtifact } from '../knowledge-graph/mirofish-adapter';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import { createMiroFishGraphArtifact, type MiroFishGraphArtifact, type MiroFishGraphArtifactDescriptor, type MiroFishGraphArtifactLifecycleOptions } from './graph-artifact-store';

const STANDALONE_DOCUMENT_ID = /^mirofish_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID = /^proj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUILD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A console graph has its own accepted source, rather than a document-library
 * asset. Persist that authority before publication so the ordinary PG source
 * visibility and revocation checks apply unchanged to its Neo4j readback.
 */
export async function registerStandaloneMiroFishGraphSource(
  client: PostgresQueryClient,
  artifact: MiroFishGraphArtifact,
  options: Pick<MiroFishGraphArtifactLifecycleOptions, 'graphName' | 'buildLease'> = {}
): Promise<void> {
  validateBuildLease(options.buildLease);
  if (!isStandaloneArtifact(artifact)) return;
  await persistStandaloneSource(client, artifact, options.graphName, undefined, undefined, options.buildLease);
}

/** Explicit, project-bound repair for artifacts built before source registration. */
export async function repairStandaloneMiroFishGraphSource(
  client: PostgresQueryClient,
  scope: RagRetrievalScope,
  projectId: string,
  snapshot: KnowledgeGraphSnapshot,
  descriptor: MiroFishGraphArtifactDescriptor
): Promise<void> {
  if (!PROJECT_ID.test(projectId) || descriptor.identity.graphGeneration !== undefined
    || !STANDALONE_DOCUMENT_ID.test(descriptor.identity.documentId)
    || snapshot.tenantId !== scope.tenantId || snapshot.corpusId !== scope.corpusId
    || descriptor.identity.tenantId !== scope.tenantId || descriptor.identity.corpusId !== scope.corpusId
    || !scope.allowedTrustLevels.includes(descriptor.identity.trustLevel)
    || descriptor.graphName !== `Project ${projectId} Graph`
    || snapshot.graphName !== descriptor.graphName || snapshot.graphId !== descriptor.identity.documentId
    || createMiroFishGraphVersion(descriptor.identity) !== snapshot.graphVersion
    || descriptor.artifactDigest !== snapshot.artifactDigest
    || !Number.isFinite(Date.parse(descriptor.createdAt))
    || (descriptor.expiresAt !== undefined && !(Date.parse(descriptor.expiresAt) > Date.now()))) {
    throw sourceConflict();
  }
  // Neo4j stores a normalized snapshot, not the original GraphData JSON. Its
  // immutable stage digest must be checked before reconstructing the readback.
  const artifact = mapKnowledgeGraphSnapshotToMiroFishArtifact(snapshot, descriptor.identity);
  await persistStandaloneSource(client, artifact, descriptor.graphName, projectId, snapshot.artifactDigest);
}

function isStandaloneArtifact(artifact: MiroFishGraphArtifact): boolean {
  return artifact.graphGeneration === undefined && STANDALONE_DOCUMENT_ID.test(artifact.documentId);
}

async function persistStandaloneSource(
  client: PostgresQueryClient,
  input: MiroFishGraphArtifact,
  graphName?: string,
  repairProjectId?: string,
  originalArtifactDigest?: string,
  buildLease?: MiroFishGraphArtifactLifecycleOptions['buildLease']
): Promise<void> {
  const artifact = createMiroFishGraphArtifact({ identity: input, graph: input.graph });
  const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact);
  const passages = artifact.graph.passages.map(passage => ({
    id: passage.id, start_offset: passage.start_offset, end_offset: passage.end_offset,
    content_digest: `sha256:${createHash('sha256').update(passage.content).digest('hex')}`,
  }));
  const metadata = {
    source_kind: 'mirofish-graph', persistence_status: 'ready', retrieval_enabled: true, lifecycle: 'active',
    document: { id: artifact.documentId, trustLevel: artifact.trustLevel },
    standalone_graph: { graph_version: snapshot.graphVersion, artifact_digest: originalArtifactDigest ?? snapshot.artifactDigest,
      readback_digest: snapshot.artifactDigest, passages,
      ...(graphName ? { graph_name: graphName } : {}), ...(repairProjectId ? { repaired_project_id: repairProjectId } : {}) },
  };
  // INSERT-only is deliberate: retrying publication must never re-enable a
  // revoked source or replace another source's version/trust/provenance.
  // Keep ownership inside this write: an earlier lease read/renewal can race
  // a replacement worker. Legacy registration does not require the job table.
  const jobOwner = buildLease ? `job_owner as materialized (
      select id, lease_expires_at from public.graph_build_jobs
      where id = $10::uuid and lease_token = $11::uuid
        and tenant_id = $1 and corpus_id = $2 and graph_version = $7
        and status = 'running' and lease_expires_at > clock_timestamp()
      for update
    ), ` : '';
  const result = await queryPostgres<{ id: string }>(client, `
    with ${jobOwner}repair_project as materialized (
      select project_id from public.mirofish_projects
      where tenant_id = $1 and corpus_id = $2 and project_id = $8
        and project_data->>'id' = $8
      for update
    ), eligible as (
      select 1 where ($8::text is null or exists (select 1 from repair_project))
        ${buildLease ? 'and exists (select 1 from job_owner where lease_expires_at > clock_timestamp())' : ''}
        and not exists (
          select 1 from public.graph_snapshot_lifecycle
          where tenant_id = $1 and corpus_id = $2 and graph_version = $7 and state <> 'staged'
        )
        and ($8::text is null or exists (
          select 1 from public.graph_snapshot_lifecycle
          where tenant_id = $1 and corpus_id = $2 and graph_version = $7 and state = 'staged'
        ))
    ), inserted as (
      insert into public.document_assets (
        tenant_id, corpus_id, external_document_id, source_hash, original_name, content_type,
        byte_size, parse_method, metadata
      ) select $1, $2, $3, $4, $5, 'text/plain', $9, 'mirofish-graph', $6::jsonb from eligible
      where $8::text is not null or not exists (
        select 1 from public.graph_snapshot_lifecycle
        where tenant_id = $1 and corpus_id = $2 and graph_version = $7
      )
      on conflict do nothing returning id::text
    )
    select id from inserted
    union all
    select asset.id::text from public.document_assets asset cross join eligible
    where asset.tenant_id = $1 and asset.corpus_id = $2 and asset.external_document_id = $3
      and asset.source_hash = $4 and asset.metadata->>'source_kind' = 'mirofish-graph'
      and asset.metadata #>> '{document,trustLevel}' = $6::jsonb #>> '{document,trustLevel}'
      and asset.metadata #>> '{standalone_graph,graph_version}' = $7
      and asset.metadata #>> '{standalone_graph,artifact_digest}' = $6::jsonb #>> '{standalone_graph,artifact_digest}'
      and asset.metadata->>'persistence_status' = 'ready'
      and asset.metadata->>'retrieval_enabled' is distinct from 'false'
      and coalesce(asset.metadata->>'lifecycle', 'active') = 'active'
    limit 1`,
  [artifact.tenantId, artifact.corpusId, artifact.documentId, artifact.documentVersion,
    graphName || 'MiroFish Graph', JSON.stringify(metadata), snapshot.graphVersion, repairProjectId ?? null,
    artifact.graph.passages.reduce((size, passage) => size + Buffer.byteLength(passage.content, 'utf8'), 0),
    ...(buildLease ? [buildLease.jobId, buildLease.leaseToken] : [])],
  'register standalone MiroFish graph source');
  if (result.rows.length !== 1 || !result.rows[0].id) throw sourceConflict();
}

function validateBuildLease(lease: MiroFishGraphArtifactLifecycleOptions['buildLease']): void {
  if (lease === undefined) return;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)
    || typeof lease.jobId !== 'string' || !BUILD_UUID.test(lease.jobId)
    || typeof lease.leaseToken !== 'string' || !BUILD_UUID.test(lease.leaseToken)) throw sourceConflict();
}

function sourceConflict(): KnowledgeGraphError {
  return new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'Standalone graph source is unavailable or has changed.');
}
