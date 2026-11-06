import { queryPostgres, type PostgresQueryClient } from '../postgres/client';

export interface PublicationOperationIntent {
  operationId: string; tenantId: string; corpusId: string; documentId: string;
  contentVersion: string; manifestDigest: string; physicalCollection: string;
}
export interface PublicationOperationStatus extends PublicationOperationIntent {
  state: 'not_observed' | 'queued' | 'staging' | 'published' | 'failed' | 'superseded' | 'revoked';
  generation: string | null; attemptRevision: string | null; headRevision: string | null;
  headRevoked: boolean | null; currentlyActive: boolean;
}
const states = new Set(['not_observed', 'queued', 'staging', 'published', 'failed', 'superseded', 'revoked']);
const fields = ['operationId', 'tenantId', 'corpusId', 'documentId', 'contentVersion', 'manifestDigest', 'physicalCollection'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class PostgresPublicationIntentStore {
  private readonly client: PostgresQueryClient;
  constructor(client: PostgresQueryClient) { this.client = client; }
  async prepare(intent: PublicationOperationIntent): Promise<void> {
    validate(intent);
    await queryPostgres(this.client, 'select public.rag_prepare_publication_intent($1::uuid,$2,$3,$4,$5,$6,$7)',
      fields.map(key => intent[key]), 'prepare publication operation intent');
  }
  async read(intent: PublicationOperationIntent): Promise<PublicationOperationStatus> {
    validate(intent);
    const result = await this.inspect(intent, intent.operationId);
    if (fields.some(key => result[key] !== intent[key])) throw new Error('Publication operation identity mismatch.');
    return result;
  }
  async inspect(scope: Pick<PublicationOperationIntent, 'tenantId' | 'corpusId' | 'documentId'>, operationId: string): Promise<PublicationOperationStatus> {
    const scopeCheck = (v: unknown, n: number) => typeof v === 'string' && v.length > 0 && v.length <= n && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
    if (!scope || !scopeCheck(scope.tenantId, 128) || !scopeCheck(scope.corpusId, 128) || !scopeCheck(scope.documentId, 256)
      || typeof operationId !== 'string' || !uuid.test(operationId)) throw new Error('Invalid publication operation identity.');
    const data = await queryPostgres<{ result: unknown }>(this.client,
      'select public.rag_read_publication_intent($1::uuid,$2,$3,$4) as result',
      [operationId, scope.tenantId, scope.corpusId, scope.documentId], 'read publication operation intent');
    const value = data.rows[0]?.result;
    if (data.rows.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publication operation result.');
    const result = value as Record<string, unknown>;
    if (Object.keys(result).length !== fields.length + 6 || result.operationId !== operationId || result.tenantId !== scope.tenantId
      || result.corpusId !== scope.corpusId || result.documentId !== scope.documentId
      || typeof result.state !== 'string' || !states.has(result.state)) throw new Error('Publication operation identity mismatch.');
    validate(result as unknown as PublicationOperationIntent);
    const decimal = (x: unknown) => typeof x === 'string' && /^[1-9][0-9]{0,18}$/.test(x);
    if ((result.state === 'not_observed' ? result.generation !== null || result.attemptRevision !== null
      : !decimal(result.generation) || !decimal(result.attemptRevision))
      || !(result.headRevision === null || typeof result.headRevision === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(result.headRevision))
      || !(result.headRevoked === null || typeof result.headRevoked === 'boolean')
      || typeof result.currentlyActive !== 'boolean' || (result.currentlyActive && (result.state !== 'published' || result.headRevoked !== false || result.headRevision === null))) {
      throw new Error('Invalid publication operation state.');
    }
    return result as unknown as PublicationOperationStatus;
  }
  /** Repeat complete scans: concurrent inserts can sort before a prior cursor. */
  async list(scope: Pick<PublicationOperationIntent, 'tenantId' | 'corpusId' | 'documentId'>, after: string | null, pageSize = 100): Promise<string[]> {
    const bounded = (v: unknown, n: number) => typeof v === 'string' && v.length > 0 && v.length <= n && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
    if (!scope || !bounded(scope.tenantId, 128) || !bounded(scope.corpusId, 128) || !bounded(scope.documentId, 256)
      || after !== null && !uuid.test(after) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid publication intent discovery.');
    const result = await queryPostgres<{ operation_id: unknown }>(this.client,
      'select operation_id::text from public.rag_list_publication_intents($1,$2,$3,$4::uuid,$5)',
      [scope.tenantId, scope.corpusId, scope.documentId, after, pageSize], 'list publication operation intents');
    if (result.rows.length > pageSize) throw new Error('Invalid publication intent page.');
    let previous = after;
    return result.rows.map(row => {
      const id = row.operation_id;
      if (typeof id !== 'string' || !uuid.test(id) || previous !== null && id <= previous) throw new Error('Invalid publication intent page.');
      previous = id;
      return id;
    });
  }
}
function validate(intent: PublicationOperationIntent): void {
  const bounded = (v: unknown, n: number) => typeof v === 'string' && v.length > 0 && v.length <= n && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
  if (!intent || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.operationId)
    || !bounded(intent.tenantId, 128) || !bounded(intent.corpusId, 128) || !bounded(intent.documentId, 256)
    || !/^sha256:[0-9a-f]{64}$/.test(intent.contentVersion) || !/^sha256:[0-9a-f]{64}$/.test(intent.manifestDigest)
    || !/^rag_publication_[0-9a-f]{32}$/.test(intent.physicalCollection)) throw new Error('Invalid publication operation intent.');
}
