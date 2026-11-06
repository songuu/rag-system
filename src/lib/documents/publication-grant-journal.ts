import { queryPostgres, type PostgresQueryClient } from '../postgres/client';

type Identity = { collection: string; username: string; role: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHASE = /^(started|unknown|observed-no-grants|revoke:(CollectionReadWrite|CreateIndex|Load)|revoked:(CollectionReadWrite|CreateIndex|Load))$/;

/** This client must be held exclusively by the trusted publisher administrator. */
export class PublicationGrantJournal {
  private readonly client: PostgresQueryClient;
  constructor(client: PostgresQueryClient) { this.client = client; }
  async readIntent(operationId: string): Promise<Identity> {
    if (!UUID.test(operationId)) throw new Error('Invalid publication operation id.');
    const result = await queryPostgres<{ identity: unknown }>(this.client,
      'select public.rag_read_publication_grant_identity($1::uuid) as identity', [operationId], 'read publication grant identity');
    const value = result.rows[0]?.identity as Partial<Identity> | undefined;
    if (result.rows.length !== 1 || !value || typeof value.collection !== 'string'
      || !/^rag_publication_[a-f0-9]{32}$/.test(value.collection)
      || value.username !== `pgu_${value.collection.slice(-24)}` || value.role !== `pgr_${value.collection.slice(-24)}`) {
      throw new Error('Invalid persisted publication grant identity.');
    }
    return { collection: value.collection, username: value.username, role: value.role };
  }
  async recordEvent(event: { operationId: string; identity: Identity; phase: string }): Promise<void> {
    if (!UUID.test(event.operationId) || !PHASE.test(event.phase)) throw new Error('Invalid publication grant event.');
    const persisted = await this.readIntent(event.operationId);
    if (event.identity.collection !== persisted.collection || event.identity.username !== persisted.username
      || event.identity.role !== persisted.role) throw new Error('Publication grant event identity mismatch.');
    await queryPostgres(this.client, 'select public.rag_record_publication_grant_event($1::uuid,$2)',
      [event.operationId, event.phase], 'record publication grant event');
  }
  /** Trusted recovery only; repeat full scans because UUID cursors can miss concurrent inserts. */
  async listAll(after: string | null, pageSize = 100): Promise<Array<{ operationId: string; tenantId: string; corpusId: string; documentId: string }>> {
    if (after !== null && !UUID.test(after) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid recovery page.');
    const result = await queryPostgres<{ operation_id: unknown; tenant_id: unknown; corpus_id: unknown; document_id: unknown }>(this.client,
      'select operation_id::text, tenant_id, corpus_id, document_id from public.rag_list_all_publication_intents($1::uuid,$2)',
      [after, pageSize], 'list all publication operations');
    if (result.rows.length > pageSize) throw new Error('Invalid recovery page.');
    let previous = after;
    return result.rows.map(row => {
      const id = row.operation_id;
      const validText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0
        && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
      if (typeof id !== 'string' || !UUID.test(id) || previous !== null && id <= previous
        || !validText(row.tenant_id, 128) || !validText(row.corpus_id, 128) || !validText(row.document_id, 256)) throw new Error('Invalid recovery page.');
      previous = id;
      return { operationId: id, tenantId: row.tenant_id, corpusId: row.corpus_id, documentId: row.document_id };
    });
  }
  async listEvents(operationId: string, after = '0', pageSize = 100): Promise<Array<{ id: string; phase: string }>> {
    if (!UUID.test(operationId) || !/^(0|[1-9][0-9]{0,18})$/.test(after)
      || BigInt(after) > BigInt('9223372036854775807') || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid grant event page.');
    const result = await queryPostgres<{ event_id: unknown; phase: unknown }>(this.client,
      'select event_id::text, phase from public.rag_list_publication_grant_events($1::uuid,$2::bigint,$3)',
      [operationId, after, pageSize], 'list publication grant events');
    if (result.rows.length > pageSize) throw new Error('Invalid grant event page.');
    let previous = BigInt(after);
    return result.rows.map(row => {
      if (typeof row.event_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.event_id)
        || BigInt(row.event_id) <= previous || BigInt(row.event_id) > BigInt('9223372036854775807')
        || typeof row.phase !== 'string' || !PHASE.test(row.phase)) throw new Error('Invalid grant event page.');
      previous = BigInt(row.event_id);
      return { id: row.event_id, phase: row.phase };
    });
  }
}
