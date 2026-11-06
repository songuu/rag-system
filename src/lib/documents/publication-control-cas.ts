import { PostgresQueryError, queryPostgres, type PostgresQueryClient } from '../postgres/client';

// Scope comes from the trusted application request-context. The database
// service role does not independently authenticate the end user or tenant.
export type PublicationProvider = 'milvus' | 'elasticsearch' | 'neo4j';
export interface PublicationScope { tenantId: string; corpusId: string; documentId: string }
export interface PublicationCandidate extends PublicationScope { generation: string; revision: string; manifestDigest: string; physicalCollection: string }
export interface PublicationAttempt extends PublicationCandidate { leaseToken: string }
export interface PublicationObservation extends PublicationScope { generation: string; provider: PublicationProvider; manifestDigest: string; physicalCollection: string; evidenceDigest: string }
export type PublicationObserver = (input: PublicationAttempt & { provider: PublicationProvider }) => Promise<PublicationObservation>;
type ErrorCode = 'PUBLICATION_INVALID_INPUT' | 'PUBLICATION_INVALID_PROOF' | 'PUBLICATION_CONFLICT' | 'PUBLICATION_NOT_IMPLEMENTED';
export class PublicationControlError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; this.name = 'PublicationControlError'; }
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set<PublicationProvider>(['milvus', 'elasticsearch', 'neo4j']);

export class PostgresDocumentPublicationStore {
  private readonly client: PostgresQueryClient;
  constructor(client: PostgresQueryClient) { this.client = client; }

  async begin(input: PublicationScope & { idempotencyKey: string; contentVersion: string; manifestDigest: string;
    physicalCollection: string; requiredProviders: PublicationProvider[] }): Promise<PublicationCandidate> {
    validateScope(input); bounded(input.idempotencyKey, 256); bounded(input.contentVersion, 256);
    digest(input.manifestDigest); collection(input.physicalCollection);
    if (!Array.isArray(input.requiredProviders) || input.requiredProviders.length < 1 || input.requiredProviders.length > 3
      || input.requiredProviders.some(value => !PROVIDERS.has(value)) || new Set(input.requiredProviders).size !== input.requiredProviders.length) throw invalid();
    const data = await this.call('begin', input, { idempotencyKey: input.idempotencyKey, contentVersion: input.contentVersion,
      manifestDigest: input.manifestDigest, physicalCollection: input.physicalCollection, requiredProviders: [...input.requiredProviders].sort() });
    const result: PublicationCandidate = { ...scope(input), generation: readString(data.generation), revision: readString(data.revision),
      manifestDigest: readString(data.manifestDigest), physicalCollection: readString(data.physicalCollection) };
    validateCandidate(result);
    if (result.manifestDigest !== input.manifestDigest || result.physicalCollection !== input.physicalCollection) throw conflict();
    return result;
  }

  async claim(input: PublicationCandidate, leaseMs?: number): Promise<PublicationAttempt> {
    validateCandidate(input);
    const data = await this.call('claim', input, { ...fields(input), leaseMs: duration(leaseMs) });
    const result = { ...input, leaseToken: readString(data.leaseToken) }; validateAttempt(result); return result;
  }
  async renew(input: PublicationAttempt, leaseMs?: number): Promise<void> {
    validateAttempt(input); await this.call('renew', input, { ...fields(input), leaseToken: input.leaseToken, leaseMs: duration(leaseMs) });
  }
  async abandon(input: PublicationAttempt): Promise<void> {
    validateAttempt(input); await this.call('abandon', input, { ...fields(input), leaseToken: input.leaseToken });
  }
  async revoke(input: PublicationScope & { expectedRevision: string }): Promise<void> {
    validateScope(input); if (input.expectedRevision !== '0') positive(input.expectedRevision);
    await this.call('revoke', input, { revision: input.expectedRevision });
  }
  /** Caller must first authorize restoration via the server-side request context. */
  async restore(input: PublicationScope & { expectedRevision: string }): Promise<void> {
    validateScope(input); positive(input.expectedRevision);
    await this.call('restore', input, { revision: input.expectedRevision });
  }
  async observeAndRecord(input: PublicationAttempt, provider: PublicationProvider, observer: PublicationObserver): Promise<void> {
    validateAttempt(input); if (!PROVIDERS.has(provider) || typeof observer !== 'function') throw invalid();
    const payload = { ...fields(input), leaseToken: input.leaseToken, provider };
    await this.call('check', input, payload);
    const observation = await observer({ ...input, provider });
    if (!observation || observation.tenantId !== input.tenantId || observation.corpusId !== input.corpusId
      || observation.documentId !== input.documentId || observation.generation !== input.generation || observation.provider !== provider
      || observation.manifestDigest !== input.manifestDigest || observation.physicalCollection !== input.physicalCollection
      || typeof observation.evidenceDigest !== 'string' || !DIGEST.test(observation.evidenceDigest)) {
      throw new PublicationControlError('PUBLICATION_INVALID_PROOF', 'Observation does not match the publication.');
    }
    await this.call('observe', input, { ...payload, evidenceDigest: observation.evidenceDigest });
  }
  async publish(input: PublicationAttempt): Promise<never> {
    validateAttempt(input);
    throw new PublicationControlError('PUBLICATION_NOT_IMPLEMENTED', 'Publication requires sealed generation writes and authoritative verification.');
  }

  private async call(operation: string, input: PublicationScope, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await queryPostgres<{ result: unknown }>(this.client,
        'select public.rag_publication_control($1,$2,$3,$4,$5::jsonb) as result',
        [operation, input.tenantId, input.corpusId, input.documentId, JSON.stringify(payload)], `publication ${operation}`);
      const value = response.rows[0]?.result;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw conflict();
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof PostgresQueryError && error.code === 'P0001') throw conflict();
      if (error instanceof PostgresQueryError && error.code === '22023') throw invalid();
      throw error;
    }
  }
}
function scope(value: PublicationScope): PublicationScope { return { tenantId: value.tenantId, corpusId: value.corpusId, documentId: value.documentId }; }
function fields(value: PublicationCandidate): Record<string, string> { return { generation: value.generation, revision: value.revision, manifestDigest: value.manifestDigest, physicalCollection: value.physicalCollection }; }
function validateScope(value: PublicationScope): void { bounded(value.tenantId, 128); bounded(value.corpusId, 128); bounded(value.documentId, 256); }
function validateCandidate(value: PublicationCandidate): void { validateScope(value); positive(value.generation); positive(value.revision); digest(value.manifestDigest); collection(value.physicalCollection); }
function validateAttempt(value: PublicationAttempt): void { validateCandidate(value); if (typeof value.leaseToken !== 'string' || !UUID.test(value.leaseToken)) throw invalid(); }
function bounded(value: string, limit: number): void { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(); }
function positive(value: string): void { if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || (value.length === 19 && value > '9223372036854775807')) throw invalid(); }
function digest(value: string): void { if (typeof value !== 'string' || !DIGEST.test(value)) throw invalid(); }
function collection(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(value)) throw invalid(); }
function duration(value = 60_000): number { if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000) throw invalid(); return value; }
function readString(value: unknown): string { if (typeof value !== 'string') throw conflict(); return value; }
function invalid(): PublicationControlError { return new PublicationControlError('PUBLICATION_INVALID_INPUT', 'Invalid publication input.'); }
function conflict(): PublicationControlError { return new PublicationControlError('PUBLICATION_CONFLICT', 'Publication control rejected the operation.'); }
