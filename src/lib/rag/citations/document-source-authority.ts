import { createHash } from 'node:crypto';
import { queryPostgres, type PostgresQueryClient } from '../../postgres/client';
import type { MilvusVectorStore } from '../../milvus-client';
import type { DocumentCitationDependencies } from './document-citations';

interface AuthorityRow {
  asset_id: string; document_version: string; trust_level: string;
  chunk_count: string | number; source: string; row_revision: string;
}

/** Only canonical, currently enabled assets may authorize an existing vector projection. */
export function createDocumentCitationDependencies(input: {
  client: PostgresQueryClient;
  milvus: Pick<MilvusVectorStore, 'queryDocumentRows'>;
}): DocumentCitationDependencies {
  return {
    async readAuthority(source) {
      const result = await queryPostgres<AuthorityRow>(input.client,
        `select asset.id::text as asset_id, asset.xmin::text as row_revision,
                asset.original_name as source, asset.metadata->>'chunks' as chunk_count,
                coalesce(nullif(asset.metadata #>> '{document,documentVersion}', ''),
                         nullif(asset.metadata #>> '{document,document_version}', ''),
                         nullif(asset.metadata #>> '{document,sourceHash}', ''),
                         nullif(asset.metadata #>> '{document,source_hash}', '')) as document_version,
                coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                         nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') as trust_level
         from public.document_assets asset
         where asset.tenant_id = $1 and asset.corpus_id = $2 and asset.external_document_id = $3
           and coalesce(nullif(asset.metadata #>> '{document,documentVersion}', ''),
                        nullif(asset.metadata #>> '{document,document_version}', ''),
                        nullif(asset.metadata #>> '{document,sourceHash}', ''),
                        nullif(asset.metadata #>> '{document,source_hash}', '')) = $4
           and coalesce(nullif(asset.metadata #>> '{document,trustLevel}', ''),
                        nullif(asset.metadata #>> '{document,trust_level}', ''), 'external') = $5
           and asset.metadata ? 'source_kind' and asset.metadata->>'persistence_status' = 'ready'
           and asset.metadata->>'retrieval_enabled' is distinct from 'false'
           and coalesce(asset.metadata->>'lifecycle', 'active') = 'active'
         limit 2`,
        [source.tenantId, source.corpusId, source.documentId, source.documentVersion, source.trustLevel], 'authorize current document citation');
      if (result.rows.length !== 1) return null;
      const row = result.rows[0]; const chunkCount = integer(row.chunk_count);
      if (!row.asset_id || !row.row_revision || typeof row.source !== 'string' || row.document_version !== source.documentVersion || row.trust_level !== source.trustLevel || chunkCount === undefined || chunkCount < 1 || chunkCount > 100_000) return null;
      // xmin catches an off/on or content update during a read, even within the same millisecond.
      return { chunkCount, source: row.source, revision: createHash('sha256').update(JSON.stringify([row.asset_id, row.row_revision, row.document_version, row.trust_level, chunkCount])).digest('hex') };
    },
    async readChunk(source, state, scope, chunkIndex) {
      if (chunkIndex !== undefined && (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= state.chunkCount)) return null;
      if (chunkIndex === undefined && state.chunkCount > 1000) return null;
      const rows = await input.milvus.queryDocumentRows(scope, source, state.chunkCount, {
        readOnly: true, consistencyLevel: 'Strong', ...(chunkIndex !== undefined ? { chunkIndices: [chunkIndex] } : {}),
      });
      if (rows.length !== (chunkIndex !== undefined ? 1 : state.chunkCount)) return null;
      const matches = rows.filter(row => row.id === source.chunkId);
      if (matches.length !== 1) return null;
      const row = matches[0];
      const index = integer(row.chunk_index);
      if (row.tenant_id !== source.tenantId || row.corpus_id !== source.corpusId || row.document_id !== source.documentId
        || row.document_version !== source.documentVersion || row.trust_level !== source.trustLevel
        || integer(row.total_chunks) !== state.chunkCount || index === undefined || index < 0 || index >= state.chunkCount
        || (chunkIndex !== undefined && index !== chunkIndex) || typeof row.content !== 'string') return null;
      let metadata: Record<string, unknown>;
      try {
        const parsed: unknown = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json ?? {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        metadata = parsed as Record<string, unknown>;
      } catch { return null; }
      const aliases: Array<[string[], unknown, boolean?]> = [
        [['tenantId', 'tenant_id'], source.tenantId], [['corpusId', 'corpus_id'], source.corpusId],
        [['documentId', 'document_id'], source.documentId], [['documentVersion', 'document_version'], source.documentVersion],
        [['trustLevel', 'trust_level'], source.trustLevel], [['chunkIndex', 'chunk_index'], index, true], [['totalChunks', 'total_chunks'], state.chunkCount, true],
      ];
      if (aliases.some(([names, expected, numeric]) => names.some(name => metadata[name] !== undefined && (numeric ? integer(metadata[name]) : metadata[name]) !== expected))) return null;
      // Enriched vector text may include a contextual heading; preview only the stored original.
      const content = metadata.originalContent ?? row.content;
      if (typeof content !== 'string' || !content || content.length > 120_000) return null;
      const page = integer(metadata.page);
      return { id: source.chunkId, chunkIndex: index, content, ...(page !== undefined && page >= 0 ? { page } : {}) };
    },
  };
}

function integer(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}
