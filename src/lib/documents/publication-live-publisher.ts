import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import type { PublicationAttempt } from './publication-control-cas';

export interface PublishedGeneration {
  tenantId: string;
  corpusId: string;
  documentId: string;
  generation: string;
  revision: string;
  manifestDigest: string;
  physicalCollection: string;
  assetId: string;
}

/**
 * Call only from the separately authenticated trusted publisher after it has
 * verified both actual backend seals. The database function also checks their
 * immutable identities and atomically advances the active source and head.
 * This operation does not make an observation into a backend seal.
 */
export async function publishVerifiedGeneration(client: PostgresQueryClient, attempt: PublicationAttempt): Promise<PublishedGeneration> {
  validateAttempt(attempt);
  const result = await queryPostgres<{ publication: unknown }>(client,
    'select public.rag_publish_document_generation($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8) as publication',
    [attempt.tenantId, attempt.corpusId, attempt.documentId, attempt.generation, attempt.revision,
      attempt.leaseToken, attempt.physicalCollection, attempt.manifestDigest], 'publish verified document generation');
  const value = result.rows[0]?.publication;
  if (result.rows.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Publication did not return a valid identity.');
  }
  const row = value as Record<string, unknown>;
  const nextRevision = (BigInt(attempt.revision) + BigInt(1)).toString();
  if (row.tenantId !== attempt.tenantId || row.corpusId !== attempt.corpusId || row.documentId !== attempt.documentId
    || row.generation !== attempt.generation || row.revision !== nextRevision
    || row.manifestDigest !== attempt.manifestDigest || row.physicalCollection !== attempt.physicalCollection
    || typeof row.assetId !== 'string' || !UUID.test(row.assetId)) {
    throw new Error('Publication returned an inconsistent identity.');
  }
  return { tenantId: attempt.tenantId, corpusId: attempt.corpusId, documentId: attempt.documentId,
    generation: attempt.generation, revision: nextRevision, manifestDigest: attempt.manifestDigest,
    physicalCollection: attempt.physicalCollection, assetId: row.assetId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateAttempt(value: PublicationAttempt): void {
  const scalar = (item: unknown, max: number) => typeof item === 'string' && item.length > 0 && item.length <= max
    && item === item.trim() && !/[\u0000-\u001f\u007f]/.test(item);
  const decimal = (item: unknown) => typeof item === 'string' && /^[1-9][0-9]{0,18}$/.test(item)
    && (item.length < 19 || item <= '9223372036854775806');
  if (!value || !scalar(value.tenantId, 128) || !scalar(value.corpusId, 128) || !scalar(value.documentId, 256)
    || !decimal(value.generation) || !decimal(value.revision) || !UUID.test(value.leaseToken)
    || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(value.physicalCollection)
    || !/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest)) throw new Error('Invalid publication attempt.');
}
