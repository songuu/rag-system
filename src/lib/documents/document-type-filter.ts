import { getPostgresClient, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { assertPostgresPersistenceConfigured, getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';
import { matchesDocumentSourceFileType, type DocumentFileType } from './document-search-contract';
import type { RagRetrievalScope } from '../security/retrieval-scope';

export class DocumentTypeFilterUnavailableError extends Error {
  readonly code = 'DOCUMENT_TYPE_FILTER_UNAVAILABLE';
  readonly status = 503;

  constructor(message = '文件类型筛选需要可用的文档目录。') {
    super(message);
    this.name = 'DocumentTypeFilterUnavailableError';
  }
}

/** Resolve the complete set before either backend applies its candidate limit. */
export async function listDocumentIdsForFileType(
  scope: RagRetrievalScope,
  fileType: DocumentFileType,
  options: { client?: PostgresQueryClient; documentId?: string } = {}
): Promise<string[]> {
  const config = getPostgresRuntimeConfig();
  if (!options.client && !shouldUsePostgresPersistence(config)) throw new DocumentTypeFilterUnavailableError();
  if (!options.client) assertPostgresPersistenceConfigured(config);
  const db = options.client ?? getPostgresClient(config);
  if (!db) throw new DocumentTypeFilterUnavailableError();
  const result = await queryPostgres<{ document_id: string; source: string | null }>(db,
    `select external_document_id as document_id, metadata #>> '{document,source}' as source
     from public.document_assets
     where tenant_id = $1 and corpus_id = $2 and external_document_id is not null
       and metadata ? 'source_kind'
       and metadata->>'retrieval_enabled' is distinct from 'false'
       and coalesce(metadata->>'lifecycle', 'active') = 'active'
       and coalesce(nullif(metadata #>> '{document,trustLevel}', ''),
                    nullif(metadata #>> '{document,trust_level}', ''), 'external') = any($3::text[])
       and ($4::text is null or external_document_id = $4)`,
    [scope.tenantId, scope.corpusId, [...scope.allowedTrustLevels], options.documentId ?? null],
    'resolve document file type candidates');
  // A missing canonical source cannot be equated with an absent indexed source:
  // doing so would silently omit matching legacy documents before retrieval.
  if (result.rows.some(row => typeof row.source !== 'string' || !row.source.trim())) {
    throw new DocumentTypeFilterUnavailableError('文档目录缺少来源信息，请先修复索引后重试文件类型筛选。');
  }
  return result.rows.filter(row => matchesDocumentSourceFileType(row.source!, fileType))
    .map(row => row.document_id);
}

export function applyDocumentTypeToMilvusOptions<T extends { filter?: string; exprValues?: Record<string, unknown> }>(
  options: T,
  documentIds: string[] | undefined
): T {
  if (documentIds === undefined) return options;
  return {
    ...options,
    filter: [options.filter && `(${options.filter})`, documentIds.length
      ? 'document_id in {fileTypeDocumentIds}' : 'document_id in []'].filter(Boolean).join(' && '),
    exprValues: { ...options.exprValues, ...(documentIds.length ? { fileTypeDocumentIds: documentIds } : {}) },
  };
}
