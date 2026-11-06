import type { RagRetrievalScope } from '../security/retrieval-scope';
import type { PublicationAttempt } from './publication-control-cas';
import { createGenerationAccess } from './publication-generation-access';
import { loadPublicationManifests } from './publication-publisher';
import { verifyRuntimeMilvusReadback } from './publication-runtime-publisher-milvus';

type AccessInput = Parameters<typeof createGenerationAccess>[0];
type ReadbackInput = Parameters<typeof verifyRuntimeMilvusReadback>[0];
type Assets = Parameters<typeof loadPublicationManifests>[2];

/**
 * Isolated end-to-end observation for one generation. This deliberately does
 * not issue a seal: administrator exclusivity and drainage of old RPCs must
 * be established separately by deployment before a production transition.
 */
export async function rehearseGenerationWrite(input: {
  scope: RagRetrievalScope;
  attempt: PublicationAttempt;
  assets: Assets;
  access: Omit<AccessInput, 'collection' | 'dimension'>;
  reader: ReadbackInput['client'];
  assertLease: ReadbackInput['assertLease'];
  timeoutMs: number;
}): Promise<{ collectionId: string; evidenceDigest: string; count: number; productionAuthorized: false }> {
  // Recompute every row from the lease-bound source, not a caller manifest.
  const materialized = await loadPublicationManifests(input.scope, input.attempt, input.assets);
  const dimension = materialized.rows[0]?.embedding.length;
  if (!dimension || materialized.rows.some(row => row.embedding.length !== dimension)) {
    throw new Error('Publication vector dimensions are inconsistent.');
  }
  const actor = await createGenerationAccess({ ...input.access, collection: input.attempt.physicalCollection, dimension });
  // A failure or unknown result must end this generation; never retry it.
  await actor.createIndex();
  await actor.insert(materialized.rows.map(row => ({ ...row, embedding: [...row.embedding] })));
  await actor.flush();
  await actor.load();
  await actor.revoke();
  const readback = await verifyRuntimeMilvusReadback({ client: input.reader, collection: input.attempt.physicalCollection,
    expectedRows: materialized.rows, assertLease: input.assertLease, timeoutMs: input.timeoutMs });
  return { collectionId: readback.collectionId, evidenceDigest: readback.evidenceDigest,
    count: materialized.rows.length, productionAuthorized: false };
}
