import { createHash } from 'node:crypto';
import type { PostgresQueryClient } from '../../postgres/client';
import { queryPostgres } from '../../postgres/client';
import type { MiroFishGraphArtifactStore } from '../../mirofish/graph-artifact-store';
import type { MilvusVectorStore } from '../../milvus-client';
import { reconstructDocument } from '../../knowledge-graph/local-graph-build-executor';
import type { CitationSourceDependencies } from './preview';
import { CitationError } from './locator-codec';
import type { Neo4jClient } from '../../neo4j/driver';
import { Neo4jKnowledgeGraphCommandStore } from '../../knowledge-graph/neo4j-command-store';
import { Neo4jMiroFishGraphArtifactStore } from '../../knowledge-graph/neo4j-mirofish-store';

interface AuthorityRow { asset_id: string; document_version: string; trust_level: string; chunk_count: number | string; state: string }

/** A cold preview must not inherit the writer runtime's schema-initialization hook. */
export function createReadOnlyCitationNeo4jStore(client: Pick<Neo4jClient, 'executeRead'>): Pick<MiroFishGraphArtifactStore, 'get'> {
  const commands = new Neo4jKnowledgeGraphCommandStore({
    executeRead: client.executeRead.bind(client),
    async executeWrite() { throw new CitationError('RAG_CITATION_UNAVAILABLE', 503); },
  });
  // The adapter's default ensureReady is a no-op. Expose no mutation methods to the preview.
  const store = new Neo4jMiroFishGraphArtifactStore(commands);
  return { get: store.get.bind(store) };
}

/** PG authorizes the current asset; strong Milvus readback also catches vector-only legacy deletion. */
export function createCitationSourceDependencies(input: {
  client: PostgresQueryClient;
  store: Pick<MiroFishGraphArtifactStore, 'get'>;
  milvus: Pick<MilvusVectorStore, 'queryDocumentRows'>;
  /** File tombstones are authoritative only for the explicit local development backend. */
  localFileAuthority?: boolean;
}): CitationSourceDependencies {
  return {
    async readAuthority(source) {
      const result = await queryPostgres<AuthorityRow>(input.client,
        `select asset.id::text as asset_id, asset.source_hash as document_version,
                coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                         nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') as trust_level,
                asset.metadata->>'chunks' as chunk_count, coalesce(lifecycle.state, 'file-authority') as state
         from public.document_assets asset
         left join public.graph_snapshot_lifecycle lifecycle
           on lifecycle.tenant_id = asset.tenant_id and lifecycle.corpus_id = asset.corpus_id
          and lifecycle.graph_version = $5
         where asset.tenant_id = $1 and asset.corpus_id = $2
           and asset.external_document_id = $3 and asset.source_hash = $4
           and asset.metadata->>'persistence_status' = 'ready'
           and asset.metadata->>'retrieval_enabled' is distinct from 'false'
           and coalesce(asset.metadata->>'lifecycle', 'active') = 'active'
           and (lifecycle.state = 'staged' or ($6::boolean = false and lifecycle.graph_version is null))
         limit 2`,
        [source.tenantId, source.corpusId, source.documentId, source.documentVersion, source.graphVersion, !input.localFileAuthority], 'read current citation source authority');
      if (result.rows.length !== 1) return null;
      const row = result.rows[0]; const chunkCount = Number(row.chunk_count);
      if (row.document_version !== source.documentVersion || row.trust_level !== source.trustLevel || (row.state !== 'staged' && !(input.localFileAuthority && row.state === 'file-authority')) || !row.asset_id || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 1000) return null;
      return { chunkCount, revision: createHash('sha256').update(JSON.stringify([row.asset_id, row.document_version, row.trust_level, chunkCount, row.state])).digest('hex') };
    },
    readArtifact(source, scope) {
      return input.store.get({ tenantId: source.tenantId, corpusId: source.corpusId, documentId: source.documentId, documentVersion: source.documentVersion, trustLevel: source.trustLevel }, scope);
    },
    async readIndexedSource(source, state, scope) {
      const identity = { tenantId: source.tenantId, corpusId: source.corpusId, documentId: source.documentId, documentVersion: source.documentVersion, trustLevel: source.trustLevel };
      const rows = await input.milvus.queryDocumentRows(scope, identity, state.chunkCount, { readOnly: true, consistencyLevel: 'Strong' });
      if (rows.reduce((total, row) => total + (typeof row.content === 'string' ? row.content.length : 0), 0) > 10_000_000) throw new CitationError('RAG_CITATION_SOURCE_UNAVAILABLE');
      return reconstructDocument(rows, identity, state.chunkCount);
    },
  };
}
