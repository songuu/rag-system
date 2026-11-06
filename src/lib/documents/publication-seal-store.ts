import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import type { PublicationAttempt } from './publication-control-cas';
import type { RuntimeMaterialized, RuntimeProviderSeal } from './publication-runtime-publisher';

/**
 * Restricted database adapter for the independently authenticated publisher.
 * A seal must be produced by trusted backend verification; this function does
 * not convert an observation or an HTTP-supplied value into a seal.
 */
export async function recordVerifiedPublicationSeal(client: PostgresQueryClient, attempt: PublicationAttempt,
  materialized: RuntimeMaterialized, seal: RuntimeProviderSeal): Promise<void> {
  const identity = materialized?.identity;
  if (!attempt || !identity || !seal || !['milvus', 'elasticsearch'].includes(seal.provider)
    || 'productionAuthorized' in seal || identity.tenantId !== attempt.tenantId || identity.corpusId !== attempt.corpusId
    || identity.documentId !== attempt.documentId || identity.generation !== attempt.generation
    || identity.revision !== attempt.revision || identity.physicalCollection !== attempt.physicalCollection
    || identity.manifestDigest !== attempt.manifestDigest || seal.tenantId !== attempt.tenantId
    || seal.corpusId !== attempt.corpusId || seal.documentId !== attempt.documentId || seal.generation !== attempt.generation
    || seal.revision !== attempt.revision || seal.physicalCollection !== attempt.physicalCollection
    || seal.manifestDigest !== attempt.manifestDigest || seal.contentVersion !== identity.contentVersion
    || !/^sha256:[a-f0-9]{64}$/.test(seal.configurationDigest) || !/^sha256:[a-f0-9]{64}$/.test(seal.evidenceDigest)
    || (seal.provider === 'milvus' && (seal.resourceName !== attempt.physicalCollection || !/^[1-9][0-9]{0,18}$/.test(seal.resourceId)
      || seal.manifestJson !== materialized.milvusManifestJson))
    || (seal.provider === 'elasticsearch' && (!/^codex-generation-seal-[a-f0-9]{32}$/.test(seal.resourceName)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(seal.resourceId) || seal.manifestJson !== materialized.elasticsearchManifestJson))) {
    throw new Error('Verified publication seal identity is inconsistent.');
  }
  const profile = seal.provider === 'milvus' ? 'milvus-exclusive-strong-v1' : 'elasticsearch-write-block-pit-v1';
  const result = await queryPostgres<{ recorded: boolean }>(client,
    'select public.rag_record_publication_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14) as recorded',
    [attempt.tenantId, attempt.corpusId, attempt.documentId, attempt.generation, attempt.revision, attempt.leaseToken,
      attempt.physicalCollection, seal.provider, seal.resourceName, seal.resourceId, profile,
      seal.configurationDigest, seal.evidenceDigest, seal.manifestJson], 'record verified publication seal');
  if (result.rows.length !== 1 || result.rows[0].recorded !== true) throw new Error('Publication seal was not recorded.');
}
