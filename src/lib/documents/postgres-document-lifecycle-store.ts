import { getPostgresClient, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { assertPostgresPersistenceConfigured, getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';
import { DocumentCatalogUnavailableError } from './document-catalog';
import { DocumentLifecycleError, type DocumentLifecycleStore, type DocumentMutation, type ManagedDocument } from './document-lifecycle';

export class PostgresDocumentLifecycleStore implements DocumentLifecycleStore {
  private readonly client: PostgresQueryClient;
  constructor(client?: PostgresQueryClient) {
    const config = getPostgresRuntimeConfig();
    if (!client && !shouldUsePostgresPersistence(config)) throw new DocumentCatalogUnavailableError();
    if (!client) assertPostgresPersistenceConfigured(config);
    const db = client ?? getPostgresClient(config);
    if (!db) throw new DocumentCatalogUnavailableError();
    this.client = db;
  }

  async beginDelete(input: DocumentMutation): Promise<ManagedDocument> {
    const result = await queryPostgres<{ id: string; document_id: string; metadata: Record<string, unknown> }>(this.client,
      `update public.document_assets set metadata = metadata || jsonb_build_object(
         'retrieval_enabled', false, 'lifecycle',
         case when metadata->>'lifecycle' = 'deleted' then 'deleted' else 'deleting' end), updated_at = now()
       where ${ASSET_SCOPE}
       returning id::text, external_document_id as document_id, metadata`,
      scopeValues(input), 'block document before index deletion');
    const row = result.rows[0];
    if (!row) throw missing();
    return { id: row.id, documentId: row.document_id, metadata: row.metadata,
      lifecycle: row.metadata.lifecycle === 'deleted' ? 'deleted' : 'deleting' };
  }

  async setEnabled(input: DocumentMutation & { enabled: boolean }): Promise<void> {
    const result = await queryPostgres(this.client,
      `update public.document_assets set metadata = metadata || jsonb_build_object('retrieval_enabled', $5::boolean), updated_at = now()
       where ${ASSET_SCOPE} and coalesce(metadata->>'lifecycle', 'active') = 'active'
       returning id`, [...scopeValues(input), input.enabled], 'change document retrieval visibility');
    if (!result.rowCount) throw new DocumentLifecycleError('DOCUMENT_NOT_MUTABLE', '文档不存在、无权访问或正在删除。', 409);
  }

  async completeDelete(input: DocumentMutation): Promise<void> {
    if (!this.client.withTransaction) throw new Error('Document cleanup requires PostgreSQL transactions.');
    await this.client.withTransaction('complete document deletion', async tx => {
      const result = await queryPostgres<{ raw_blob_filename: string | null; parsed_blob_filename: string | null }>(tx,
        `select raw_blob_filename, parsed_blob_filename from public.document_assets where ${ASSET_SCOPE} for update`,
        scopeValues(input), 'lock deleted document assets');
      if (!result.rows[0]) throw missing();
      const filenames = Object.values(result.rows[0]).filter((value): value is string => typeof value === 'string');
      // Retain the smallest catalog tombstone so delayed workers and graph
      // snapshots cannot resurrect deleted evidence. Raw content is removed.
      await queryPostgres(tx,
        `update public.document_assets set raw_blob_filename = null, parsed_blob_filename = null, byte_size = 0,
           source_hash = 'deleted:' || id::text,
           metadata = jsonb_build_object('source_kind', metadata->'source_kind', 'document', metadata->'document',
             'retrieval_enabled', false, 'lifecycle', 'deleted'), updated_at = now()
         where ${ASSET_SCOPE}`, scopeValues(input), 'retain document deletion tombstone');
      if (filenames.length) await queryPostgres(tx,
        `delete from public.object_blobs blob where tenant_id = $1 and corpus_id = $2 and filename = any($3::text[])
           and not exists (select 1 from public.document_assets asset where asset.tenant_id = blob.tenant_id
             and asset.corpus_id = blob.corpus_id and (asset.raw_blob_filename = blob.filename or asset.parsed_blob_filename = blob.filename))`,
        [input.scope.tenantId, input.scope.corpusId, filenames], 'delete unreferenced document source blobs');
    });
  }
}

const ASSET_SCOPE = `tenant_id = $1 and corpus_id = $2 and id::text = $3
  and external_document_id is not null and metadata ? 'source_kind'
  and coalesce(nullif(metadata #>> '{document,trustLevel}', ''), nullif(metadata #>> '{document,trust_level}', ''), 'external') = any($4::text[])`;
function scopeValues(input: DocumentMutation): unknown[] {
  return [input.scope.tenantId, input.scope.corpusId, input.id, [...input.scope.allowedTrustLevels]];
}
function missing() { return new DocumentLifecycleError('DOCUMENT_NOT_FOUND', '文档不存在或无权访问。', 404); }
