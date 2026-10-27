import { getPostgresClient, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { assertPostgresPersistenceConfigured, getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';

export async function listRetrievableDocumentIds(
  scope?: { tenantId: string; corpusId: string },
  client?: PostgresQueryClient
): Promise<string[] | null> {
  const config = getPostgresRuntimeConfig();
  if (!client && !shouldUsePostgresPersistence(config)) return null;
  if (!client) assertPostgresPersistenceConfigured(config);
  const db = client ?? getPostgresClient(config);
  if (!db) throw new Error('Document visibility requires PostgreSQL.');
  const identity = scope ?? { tenantId: config.defaultTenantId, corpusId: config.defaultCorpusId };
  // Deliberately uncached: mutations must take effect across app instances and
  // already-built graph/lexical projections without waiting for a cache TTL.
  // Positive authorization also excludes orphan projections left by older ingests.
  const result = await queryPostgres<{ document_id: string }>(db,
    `select external_document_id as document_id from public.document_assets
     where tenant_id = $1 and corpus_id = $2 and external_document_id is not null
       and metadata ? 'source_kind'
       and metadata->>'retrieval_enabled' is distinct from 'false'
       and coalesce(metadata->>'lifecycle', 'active') = 'active'`,
    [identity.tenantId, identity.corpusId], 'read document retrieval visibility');
  return result.rows.map(row => row.document_id);
}

export async function withDocumentVisibility<T extends { filter?: string; exprValues?: Record<string, unknown> }>(
  options: T, scope?: { tenantId: string; corpusId: string }, client?: PostgresQueryClient
): Promise<T> {
  const allowed = await listRetrievableDocumentIds(scope, client);
  if (allowed === null) return options;
  const config = getPostgresRuntimeConfig();
  const identity = scope ?? { tenantId: config.defaultTenantId, corpusId: config.defaultCorpusId };
  return {
    ...options,
    filter: [options.filter && `(${options.filter})`,
      'tenant_id == {visibilityTenant}',
      'corpus_id == {visibilityCorpus}',
      allowed.length ? 'document_id in {retrievableDocumentIds}' : 'document_id in []',
    ].filter(Boolean).join(' && '),
    exprValues: { ...options.exprValues, visibilityTenant: identity.tenantId, visibilityCorpus: identity.corpusId,
      ...(allowed.length ? { retrievableDocumentIds: allowed } : {}) },
  };
}
