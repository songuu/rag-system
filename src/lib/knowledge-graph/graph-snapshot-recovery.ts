import { createRetrievalScope } from '../security/retrieval-scope';
import type {
  ExpiredKnowledgeGraphSnapshotMutation,
  KnowledgeGraphSnapshotLease,
} from './postgres-publication-store';

export interface KnowledgeGraphSnapshotRecoveryStore {
  listExpiredSnapshotMutations(options?: {
    limit?: number;
  }): Promise<ExpiredKnowledgeGraphSnapshotMutation[]>;
  resolveSnapshotLease(
    scope: ReturnType<typeof createRetrievalScope>,
    lease: KnowledgeGraphSnapshotLease,
    resolution: 'release' | 'deleted'
  ): Promise<boolean>;
}

export async function recoverExpiredKnowledgeGraphMutations(input: {
  store: KnowledgeGraphSnapshotRecoveryStore;
  inspect: (
    mutation: ExpiredKnowledgeGraphSnapshotMutation
  ) => Promise<'release' | 'deleted'>;
  limit?: number;
}): Promise<{ inspected: number; resolved: number; failed: number }> {
  const mutations = await input.store.listExpiredSnapshotMutations(
    input.limit === undefined ? {} : { limit: input.limit }
  );
  let resolved = 0;
  let failed = 0;
  for (const mutation of mutations) {
    try {
      const resolution = await input.inspect(mutation);
      if (mutation.operation === 'delete' && resolution !== 'deleted') {
        throw new Error('Expired delete mutations must resolve to a tombstone.');
      }
      const scope = createRetrievalScope({
        tenantId: mutation.tenantId,
        corpusId: mutation.corpusId,
        allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'],
        enforceIsolation: true,
      });
      if (await input.store.resolveSnapshotLease(scope, mutation, resolution)) {
        resolved += 1;
      } else {
        failed += 1;
      }
    } catch {
      // Leave the expired lease visible so a later operator/worker can retry it.
      failed += 1;
    }
  }
  return { inspected: mutations.length, resolved, failed };
}
