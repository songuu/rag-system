import { createHash } from 'node:crypto';
import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { validatePublicationAsset, type PreparedPublicationAsset } from './publication-asset-store';
import type { PublicationScope } from './publication-control-cas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An empty claim can race an uncommitted claim with the same operation ID. */
export class PublicationClaimUnknownError extends Error {
  readonly code = 'PUBLICATION_CLAIM_UNKNOWN';
  readonly operationId: string;
  constructor(operationId: string) {
    super('Publication claim outcome is unknown; inspect and reconcile before reuse.');
    this.name = 'PublicationClaimUnknownError';
    this.operationId = operationId;
  }
}

/** Server-derived scope is authorized before calling this internal adapter. */
export class PublicationRequestQueue {
  private readonly client: PostgresQueryClient;
  constructor(client: PostgresQueryClient) { this.client = client; }

  async enqueue(requestId: string, asset: PreparedPublicationAsset): Promise<void> {
    if (!UUID.test(requestId)) throw new Error('Invalid publication request identity.');
    validatePublicationAsset(asset, asset);
    await queryPostgres(this.client,
      'select public.rag_enqueue_publication_request($1::uuid,$2,$3,$4,$5,$6::bytea,$7::bytea,$8::jsonb)',
      [requestId, asset.tenantId, asset.corpusId, asset.documentId, asset.manifestJson,
        Buffer.from(asset.sourceBytes), Buffer.from(asset.sourceIdentityBytes), asset.chunksJson], 'enqueue publication request');
  }

  async state(requestId: string, scope: PublicationScope): Promise<'queued' | 'claimed' | 'not_observed'> {
    if (!UUID.test(requestId)) throw new Error('Invalid publication request identity.');
    const result = await queryPostgres<{ state: unknown }>(this.client,
      'select public.rag_read_publication_request_state($1::uuid,$2,$3,$4) as state',
      [requestId, scope.tenantId, scope.corpusId, scope.documentId], 'read publication request');
    const value = result.rows[0]?.state;
    if (value === null) return 'not_observed';
    if (value === 'queued' || value === 'claimed') return value;
    throw new Error('Invalid publication request state.');
  }

  /** This is a snapshot of the control plane, not an independent backend check. */
  async result(requestId: string, scope: PublicationScope): Promise<PublicationRequestResult | undefined> {
    if (!UUID.test(requestId)) throw new Error('Invalid publication request identity.');
    const response = await queryPostgres<{ result: unknown }>(this.client,
      'select public.rag_read_publication_request_result($1::uuid,$2,$3,$4) as result',
      [requestId, scope.tenantId, scope.corpusId, scope.documentId], 'read publication request result');
    const value = response.rows[0]?.result;
    if (value === null) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publication request result.');
    const result = value as Record<string, unknown>;
    if (result.requestId !== requestId || !['queued','claimed'].includes(String(result.queueState))
      || result.operationId !== null && (typeof result.operationId !== 'string' || !UUID.test(result.operationId))
      || result.attemptState !== null && !['queued','staging','published','failed','superseded','revoked'].includes(String(result.attemptState))
      || typeof result.currentlyActive !== 'boolean'
      || result.generation !== null && (typeof result.generation !== 'string' || !/^[1-9][0-9]*$/.test(result.generation))
      || result.headRevision !== null && (typeof result.headRevision !== 'string' || !/^[0-9]+$/.test(result.headRevision))
      || result.currentlyActive && (result.attemptState !== 'published' || result.generation === null)) {
      throw new Error('Invalid publication request result.');
    }
    return result as unknown as PublicationRequestResult;
  }

  /** Only a separately authenticated publisher may call this method. */
  async claim(operationId: string): Promise<{ requestId: string; asset: PreparedPublicationAsset }> {
    if (!UUID.test(operationId)) throw new Error('Invalid publication operation identity.');
    const result = await queryPostgres<{ request_id: string; tenant_id: string; corpus_id: string; document_id: string;
      manifest_json: string; source_bytes: Buffer; source_identity_bytes: Buffer; chunks_json: unknown }>(this.client,
      'select * from public.rag_claim_publication_request($1::uuid)', [operationId], 'claim publication request');
    if (result.rows.length === 0) throw new PublicationClaimUnknownError(operationId);
    if (result.rows.length !== 1) throw new Error('Invalid publication claim.');
    const row = result.rows[0];
    if (!UUID.test(row.request_id) || typeof row.manifest_json !== 'string') throw new Error('Invalid publication claim.');
    const manifest = JSON.parse(row.manifest_json) as { contentVersion?: unknown };
    const asset = { tenantId: row.tenant_id, corpusId: row.corpus_id, documentId: row.document_id,
      contentVersion: typeof manifest.contentVersion === 'string' ? manifest.contentVersion : '',
      manifestDigest: `sha256:${createHash('sha256').update(row.manifest_json).digest('hex')}`,
      manifestJson: row.manifest_json, chunksJson: JSON.stringify(row.chunks_json),
      sourceBytes: Buffer.from(row.source_bytes), sourceIdentityBytes: Buffer.from(row.source_identity_bytes) };
    validatePublicationAsset(asset, asset);
    return { requestId: row.request_id, asset };
  }

  /** A missing claim can still commit later; callers must treat it as unknown. */
  async inspectClaim(operationId: string): Promise<PublicationClaimIdentity | undefined> {
    if (!UUID.test(operationId)) throw new Error('Invalid publication operation identity.');
    const result = await queryPostgres<ClaimRow>(this.client,
      'select * from public.rag_inspect_publication_claim($1::uuid)', [operationId], 'inspect publication claim');
    if (result.rows.length > 1) throw new Error('Invalid publication claim identity.');
    return result.rows.length ? readClaim(result.rows[0]) : undefined;
  }

  /** Repeat complete scans to discover claims that committed behind a cursor. */
  async listClaims(after: string | null, limit: number): Promise<PublicationClaimIdentity[]> {
    if (after !== null && !UUID.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid publication claim page.');
    const result = await queryPostgres<ClaimRow>(this.client,
      'select * from public.rag_list_publication_claims($1::uuid,$2)', [after, limit], 'list publication claims');
    if (result.rows.length > limit) throw new Error('Invalid publication claim page.');
    return result.rows.map(readClaim);
  }
}

export interface PublicationClaimIdentity extends PublicationScope { requestId: string; operationId: string | null; claimedAt: string }
export interface PublicationRequestResult { requestId: string; queueState: 'queued' | 'claimed'; operationId: string | null;
  attemptState: 'queued' | 'staging' | 'published' | 'failed' | 'superseded' | 'revoked' | null;
  currentlyActive: boolean; generation: string | null; headRevision: string | null }
interface ClaimRow { request_id: string; operation_id: string | null; tenant_id: string; corpus_id: string; document_id: string; claimed_at: string | Date }
function readClaim(row: ClaimRow): PublicationClaimIdentity {
  if (!UUID.test(row.request_id) || row.operation_id !== null && !UUID.test(row.operation_id)
    || ![row.tenant_id,row.corpus_id,row.document_id].every(value => typeof value === 'string' && value.length > 0)
    || Number.isNaN(new Date(row.claimed_at).getTime())) throw new Error('Invalid publication claim identity.');
  return {requestId:row.request_id,operationId:row.operation_id,tenantId:row.tenant_id,corpusId:row.corpus_id,
    documentId:row.document_id,claimedAt:new Date(row.claimed_at).toISOString()};
}
