import { createHash } from 'node:crypto';
import { getPostgresClient, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { assertPostgresPersistenceConfigured, getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';
import type { MiroFishGraphActivePointer, MiroFishGraphArtifactDescriptor, MiroFishGraphArtifactIdentity } from '../mirofish/graph-artifact-store';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import { KnowledgeGraphError } from './contracts';
import { createMiroFishGraphVersion } from './mirofish-adapter';

interface AuthorityRow {
  asset_id: string;
  asset_revision: string;
  graph_revision: string;
  document_version: string;
  trust_level: string;
}

/** A snapshot authorizes content only while its exact source remains current and visible. */
export async function readGraphQueryAuthority(
  client: PostgresQueryClient,
  scope: RagRetrievalScope,
  identity: MiroFishGraphArtifactIdentity,
  graphVersion: string
): Promise<string | null> {
  if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId
    || !scope.allowedTrustLevels.includes(identity.trustLevel)) return null;
  const result = await queryPostgres<AuthorityRow>(client,
    `select asset.id::text as asset_id, asset.xmin::text as asset_revision,
            lifecycle.xmin::text as graph_revision, asset.source_hash as document_version,
            coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                     nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') as trust_level
     from public.document_assets asset
     join public.graph_snapshot_lifecycle lifecycle
       on lifecycle.tenant_id = asset.tenant_id and lifecycle.corpus_id = asset.corpus_id
      and lifecycle.graph_version = $6 and lifecycle.state = 'staged'
     where asset.tenant_id = $1 and asset.corpus_id = $2
       and asset.external_document_id = $3 and asset.source_hash = $4
       and coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                    nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') = $5
       and asset.metadata ? 'source_kind' and asset.metadata->>'persistence_status' = 'ready'
       and asset.metadata->>'retrieval_enabled' is distinct from 'false'
       and coalesce(asset.metadata->>'lifecycle', 'active') = 'active'
       and (not $7::boolean or exists (
         select 1 from public.graph_build_jobs job
         where job.tenant_id = $1 and job.corpus_id = $2 and job.graph_version = $6
           and job.status in ('validated', 'published')
       ))
     limit 2`,
    [identity.tenantId, identity.corpusId, identity.documentId, identity.documentVersion, identity.trustLevel, graphVersion, Boolean(identity.graphGeneration)],
    'authorize graph query source');
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  if (!row.asset_id || !row.asset_revision || !row.graph_revision
    || row.document_version !== identity.documentVersion || row.trust_level !== identity.trustLevel) return null;
  // xmin detects disable/enable or delete/recreate between the two reads.
  return createHash('sha256').update(JSON.stringify([row.asset_id, row.asset_revision, row.graph_revision])).digest('hex');
}

/** Batch the bounded snapshot listing so authority checks use two DB round trips, not two per item. */
export async function readGraphQueryAuthorities(
  client: PostgresQueryClient,
  scope: RagRetrievalScope,
  identities: readonly MiroFishGraphArtifactIdentity[]
): Promise<Array<string | null>> {
  const answers = identities.map(() => null as string | null);
  const sources = identities.flatMap((identity, index) => {
    if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId
      || !scope.allowedTrustLevels.includes(identity.trustLevel)) return [];
    return [{ source_index: index, document_id: identity.documentId, document_version: identity.documentVersion,
      trust_level: identity.trustLevel, graph_version: createMiroFishGraphVersion(identity), generated: Boolean(identity.graphGeneration) }];
  });
  if (!sources.length) return answers;
  const result = await queryPostgres<AuthorityRow & { source_index: number }>(client,
    `select source.source_index, asset.id::text as asset_id, asset.xmin::text as asset_revision,
            lifecycle.xmin::text as graph_revision, asset.source_hash as document_version,
            coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                     nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') as trust_level
     from jsonb_to_recordset($3::jsonb) as source(source_index integer, document_id text,
          document_version text, trust_level text, graph_version text, generated boolean)
     join public.document_assets asset on asset.tenant_id = $1 and asset.corpus_id = $2
      and asset.external_document_id = source.document_id and asset.source_hash = source.document_version
     join public.graph_snapshot_lifecycle lifecycle on lifecycle.tenant_id = asset.tenant_id
      and lifecycle.corpus_id = asset.corpus_id and lifecycle.graph_version = source.graph_version
      and lifecycle.state = 'staged'
     where coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                    nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') = source.trust_level
       and asset.metadata ? 'source_kind' and asset.metadata->>'persistence_status' = 'ready'
       and asset.metadata->>'retrieval_enabled' is distinct from 'false'
       and coalesce(asset.metadata->>'lifecycle', 'active') = 'active'
       and (not source.generated or exists (
         select 1 from public.graph_build_jobs job
         where job.tenant_id = $1 and job.corpus_id = $2 and job.graph_version = source.graph_version
           and job.status in ('validated', 'published')
       ))`,
    [scope.tenantId, scope.corpusId, JSON.stringify(sources)], 'authorize graph snapshot listing');
  const counts = new Map<number, number>();
  for (const row of result.rows) {
    const index = Number(row.source_index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= identities.length) continue;
    counts.set(index, (counts.get(index) ?? 0) + 1);
    const identity = identities[index];
    if (!row.asset_id || !row.asset_revision || !row.graph_revision
      || row.document_version !== identity.documentVersion || row.trust_level !== identity.trustLevel) continue;
    answers[index] = createHash('sha256').update(JSON.stringify([row.asset_id, row.asset_revision, row.graph_revision])).digest('hex');
  }
  for (const [index, count] of counts) if (count !== 1) answers[index] = null;
  return answers;
}

export function getGraphQueryAuthorityClient(): PostgresQueryClient {
  const config = getPostgresRuntimeConfig();
  if (!shouldUsePostgresPersistence(config)) {
    throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_UNAVAILABLE', 'Graph source authorization is unavailable.');
  }
  assertPostgresPersistenceConfigured(config);
  const client = getPostgresClient(config);
  if (!client) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_UNAVAILABLE', 'Graph source authorization is unavailable.');
  return client;
}

export async function withAuthorizedGraphQuery<T>(
  scope: RagRetrievalScope,
  dependencies: {
    getActive(): Promise<Pick<MiroFishGraphActivePointer, 'identity' | 'revision'>>;
    readAuthority(identity: MiroFishGraphArtifactIdentity, graphVersion: string): Promise<string | null>;
  },
  work: (graphVersion: string) => Promise<T>
): Promise<T> {
  const pointer = await dependencies.getActive();
  if (!pointer.identity) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_NOT_FOUND', 'No active knowledge graph snapshot is available.');
  if (pointer.identity.tenantId !== scope.tenantId || pointer.identity.corpusId !== scope.corpusId
    || !scope.allowedTrustLevels.includes(pointer.identity.trustLevel)) {
    throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_NOT_FOUND', 'No accessible knowledge graph snapshot is available.');
  }
  const graphVersion = createMiroFishGraphVersion(pointer.identity);
  const before = await dependencies.readAuthority(pointer.identity, graphVersion);
  if (!before) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_NOT_FOUND', 'No accessible knowledge graph snapshot is available.');
  const result = await work(graphVersion);
  const [after, current] = await Promise.all([
    dependencies.readAuthority(pointer.identity, graphVersion),
    dependencies.getActive(),
  ]);
  if (!after || before !== after || !current.identity || current.revision !== pointer.revision
    || createMiroFishGraphVersion(current.identity) !== graphVersion) {
    throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'Graph source changed during the query. Retry the request.');
  }
  return result;
}

export async function withAuthorizedGraphSnapshots(
  scope: RagRetrievalScope,
  dependencies: {
    getActive(): Promise<MiroFishGraphActivePointer>;
    list(): Promise<MiroFishGraphArtifactDescriptor[]>;
    readAuthorities(identities: readonly MiroFishGraphArtifactIdentity[]): Promise<Array<string | null>>;
  }
): Promise<{ snapshots: MiroFishGraphArtifactDescriptor[]; active: MiroFishGraphActivePointer }> {
  const [active, descriptors] = await Promise.all([dependencies.getActive(), dependencies.list()]);
  const candidates = [...descriptors.map(item => item.identity), ...(active.identity ? [active.identity] : [])];
  const before = await dependencies.readAuthorities(candidates);
  const after = await dependencies.readAuthorities(candidates);
  if (before.length !== candidates.length || after.length !== candidates.length) {
    throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_UNAVAILABLE', 'Graph source authorization is unavailable.');
  }
  for (const [index, identity] of candidates.entries()) {
    if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId
      || !scope.allowedTrustLevels.includes(identity.trustLevel)) before[index] = after[index] = null;
  }
  const current = await dependencies.getActive();
  if (current.revision !== active.revision
    || Boolean(current.identity) !== Boolean(active.identity)
    || (current.identity && active.identity
      && createMiroFishGraphVersion(current.identity) !== createMiroFishGraphVersion(active.identity))
    || candidates.some((_, index) => before[index] && before[index] !== after[index])) {
    throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'Graph source changed during the query. Retry the request.');
  }
  return {
    snapshots: descriptors.filter((_, index) => Boolean(before[index])),
    active: active.identity && !before[descriptors.length] ? { ...active, identity: null } : active,
  };
}
