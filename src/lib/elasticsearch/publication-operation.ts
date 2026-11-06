import { randomUUID } from 'node:crypto';
import { PostgresQueryError, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import type { PublicationAttempt, PublicationScope } from '../documents/publication-control-cas';
import {
  createOwnedGenerationIndex,
  inspectGenerationIndexOperation,
  prepareGenerationIndexOperation,
  type GenerationIndexOperation,
  type OwnedGenerationIndex,
} from './generation-seal';

type Client = Parameters<typeof inspectGenerationIndexOperation>[0]['client'];
type Status = 'prepared' | 'creating' | 'bound';
export type DurableElasticsearchOperation = GenerationIndexOperation & {
  readonly operationId: string;
  readonly status: Status;
  readonly indexUuid: string | null;
};

export class ElasticsearchPublicationOperationError extends Error {
  readonly code: string;
  readonly operationId?: string;
  constructor(code: string, message: string, operationId?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ElasticsearchPublicationOperationError';
    this.code = code;
    this.operationId = operationId;
  }
}

/** Scope must already be authorized by the server request context. */
export class PostgresElasticsearchPublicationOperations {
  private readonly client: PostgresQueryClient;
  constructor(client: PostgresQueryClient) { this.client = client; }

  async prepare(attempt: PublicationAttempt, contentVersion: string): Promise<DurableElasticsearchOperation> {
    validateAttempt(attempt);
    scalar(contentVersion, 256);
    const proposed = prepareGenerationIndexOperation({ tenantId: attempt.tenantId, corpusId: attempt.corpusId,
      documentId: attempt.documentId, generation: attempt.generation, documentVersion: contentVersion });
    const result = await this.call('prepare', attempt, { ...attemptFields(attempt), contentVersion,
      operationId: randomUUID(), indexName: proposed.indexName, marker: proposed.marker });
    return readOperation(result, attempt, contentVersion);
  }

  /** Consumed before sending create; a lost response is never retried on this operation. */
  async startCreate(attempt: PublicationAttempt, operation: DurableElasticsearchOperation): Promise<DurableElasticsearchOperation> {
    validateAttempt(attempt);
    validateOperation(operation, attempt, operation.identity.documentVersion);
    const result = await this.call('start', attempt, { ...attemptFields(attempt), operationId: operation.operationId });
    const returned = readOperation(result, attempt, operation.identity.documentVersion);
    if (returned.operationId !== operation.operationId || returned.indexName !== operation.indexName || returned.marker !== operation.marker
      || returned.status !== 'creating') throw conflict();
    return returned;
  }

  /** Only observed marker ownership can bind the immutable physical index UUID. */
  async bindObserved(attempt: PublicationAttempt, operation: DurableElasticsearchOperation, client: Client): Promise<DurableElasticsearchOperation> {
    validateAttempt(attempt);
    validateOperation(operation, attempt, operation.identity.documentVersion);
    // Never use caller-supplied ES coordinates until compared against the
    // durable server-owned operation. A later CAS handles concurrent revocation.
    const authority = await this.read(attempt, operation.operationId);
    validateOperation(authority, attempt, operation.identity.documentVersion);
    if (authority.operationId !== operation.operationId || authority.indexName !== operation.indexName
      || authority.marker !== operation.marker || !['creating', 'bound'].includes(authority.status)) throw conflict();
    const observed = await inspectGenerationIndexOperation({ client, operation: authority });
    if (observed.kind !== 'matching-marker' || observed.indexName !== authority.indexName
      || (authority.status === 'bound' && authority.indexUuid !== observed.indexUuid)) throw conflict();
    const result = await this.call('bind', attempt, { ...attemptFields(attempt), operationId: authority.operationId,
      indexName: authority.indexName, marker: authority.marker, contentVersion: authority.identity.documentVersion,
      indexUuid: observed.indexUuid });
    const returned = readOperation(result, attempt, authority.identity.documentVersion);
    if (returned.operationId !== authority.operationId || returned.indexName !== authority.indexName || returned.marker !== authority.marker
      || returned.status !== 'bound' || returned.indexUuid !== observed.indexUuid) throw conflict();
    return returned;
  }

  /** Inspection may outlive a lease. It never creates, deletes or unblocks an index. */
  async read(scope: PublicationScope, operationId: string): Promise<DurableElasticsearchOperation> {
    validateScope(scope);
    uuid(operationId);
    const result = await this.call('read', scope, { operationId });
    const operation = readOperation(result, scope);
    if (operation.operationId !== operationId) throw conflict();
    return operation;
  }

  private async call(action: string, scope: PublicationScope, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const result = await queryPostgres<{ result: unknown }>(this.client,
        'select public.rag_elasticsearch_publication_operation($1,$2,$3,$4,$5::jsonb) as result',
        [action, scope.tenantId, scope.corpusId, scope.documentId, JSON.stringify(args)], `Elasticsearch publication ${action}`);
      const value = result.rows[0]?.result;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw conflict();
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof PostgresQueryError && (error.code === 'P0001' || error.code === '23505')) throw conflict();
      throw error;
    }
  }
}

/** An uncertain outcome remains reconcilable by operationId and cannot be recreated. */
export async function createPersistedElasticsearchIndex(input: {
  store: Pick<PostgresElasticsearchPublicationOperations, 'prepare' | 'startCreate' | 'bindObserved'>;
  client: Client;
  attempt: PublicationAttempt;
  contentVersion: string;
  create?: typeof createOwnedGenerationIndex;
}): Promise<{ operation: DurableElasticsearchOperation; handle: OwnedGenerationIndex }> {
  const prepared = await input.store.prepare(input.attempt, input.contentVersion);
  try {
    // A database timeout here may mean the transition committed; expose the
    // durable ID so callers inspect it before deciding how to recover.
    const creating = await input.store.startCreate(input.attempt, prepared);
    const handle = await (input.create ?? createOwnedGenerationIndex)({ client: input.client, operation: creating });
    const bound = await input.store.bindObserved(input.attempt, creating, input.client);
    if (handle.indexName !== bound.indexName || handle.indexUuid !== bound.indexUuid) throw conflict();
    return { operation: bound, handle };
  } catch (error) {
    throw new ElasticsearchPublicationOperationError('ELASTICSEARCH_CREATE_OUTCOME_UNKNOWN',
      'Index creation or binding could not be confirmed; inspect the persisted operation before recovery.', prepared.operationId, error);
  }
}

function attemptFields(value: PublicationAttempt): Record<string, string> {
  return { generation: value.generation, revision: value.revision, manifestDigest: value.manifestDigest,
    physicalCollection: value.physicalCollection, leaseToken: value.leaseToken };
}
function readOperation(value: Record<string, unknown>, scope: PublicationScope & { generation?: string }, version?: string): DurableElasticsearchOperation {
  const identity = value.identity as GenerationIndexOperation['identity'];
  const result = { operationId: value.operationId, version: value.version, indexName: value.indexName, marker: value.marker,
    identity, status: value.status, indexUuid: value.indexUuid } as DurableElasticsearchOperation;
  validateOperation(result, scope, version);
  return result;
}
function validateOperation(value: DurableElasticsearchOperation, scope: PublicationScope & { generation?: string }, version?: string): void {
  if (!value || value.version !== 1 || !value.identity || value.identity.tenantId !== scope.tenantId
    || value.identity.corpusId !== scope.corpusId || value.identity.documentId !== scope.documentId
    || (scope.generation !== undefined && value.identity.generation !== scope.generation)
    || (version !== undefined && value.identity.documentVersion !== version)
    || typeof value.indexName !== 'string' || !/^codex-generation-seal-[0-9a-f]{32}$/.test(value.indexName)
    || typeof value.marker !== 'string' || !/^[0-9a-f]{64}$/.test(value.marker)
    || !['prepared', 'creating', 'bound'].includes(value.status)
    || (value.status === 'bound' ? typeof value.indexUuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.indexUuid) : value.indexUuid !== null)) throw conflict();
  scalar(value.identity.documentVersion, 256);
  positive(value.identity.generation);
  uuid(value.operationId);
}
function validateScope(value: PublicationScope): void { scalar(value.tenantId, 128); scalar(value.corpusId, 128); scalar(value.documentId, 256); }
function validateAttempt(value: PublicationAttempt): void {
  validateScope(value); positive(value.generation); positive(value.revision); uuid(value.leaseToken);
  if (!/^sha256:[0-9a-f]{64}$/.test(value.manifestDigest) || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(value.physicalCollection)) throw invalid();
}
function scalar(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
}
function uuid(value: unknown): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw invalid();
}
function positive(value: unknown): void {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || (value.length === 19 && value > '9223372036854775807')) throw invalid();
}
function invalid(): ElasticsearchPublicationOperationError { return new ElasticsearchPublicationOperationError('ELASTICSEARCH_PUBLICATION_INVALID', 'Invalid Elasticsearch publication operation.'); }
function conflict(): ElasticsearchPublicationOperationError { return new ElasticsearchPublicationOperationError('ELASTICSEARCH_PUBLICATION_CONFLICT', 'Elasticsearch publication operation is unavailable or inconsistent.'); }
