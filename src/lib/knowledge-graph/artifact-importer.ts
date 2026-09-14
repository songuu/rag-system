import type {
  MiroFishGraphArtifactStore,
} from '../mirofish/graph-artifact-store';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import type { KnowledgeGraphCommandStore } from './contracts';
import { mapMiroFishArtifactToKnowledgeGraphSnapshot } from './mirofish-adapter';

export interface MiroFishGraphImportSummary {
  discovered: number;
  imported: number;
  skipped: number;
  dryRun: boolean;
}

export async function importMiroFishGraphArtifacts(input: {
  source: MiroFishGraphArtifactStore;
  target: Pick<KnowledgeGraphCommandStore, 'getSnapshot' | 'stageSnapshot'>;
  coordinatedTarget?: Pick<MiroFishGraphArtifactStore, 'get' | 'put'>;
  scope: RagRetrievalScope;
  limit?: number;
  dryRun?: boolean;
}): Promise<MiroFishGraphImportSummary> {
  const limit = resolveLimit(input.limit);
  const descriptors = await input.source.list(input.scope, { limit });
  if (descriptors.length >= limit) {
    throw new Error(
      `Historical graph import reached the non-pageable list limit (${limit}); `
      + 'the source result may be truncated, so no snapshots were written.'
    );
  }
  let imported = 0;
  let skipped = 0;
  for (const descriptor of descriptors) {
    if (descriptor.identity.trustLevel === 'quarantined') {
      skipped += 1;
      continue;
    }
    const artifact = await input.source.get(descriptor.identity, input.scope);
    if (!artifact) {
      skipped += 1;
      continue;
    }
    const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact, {
      ...(descriptor.graphName ? { graphName: descriptor.graphName } : {}),
      createdAt: descriptor.createdAt,
      ...(descriptor.expiresAt ? { expiresAt: descriptor.expiresAt } : {}),
    });
    const existingArtifact = input.coordinatedTarget
      ? await input.coordinatedTarget.get(descriptor.identity, input.scope)
      : null;
    const existing = existingArtifact
      ? mapMiroFishArtifactToKnowledgeGraphSnapshot(existingArtifact)
      : await input.target.getSnapshot(snapshot, input.scope);
    if (existing) {
      if (existing.artifactDigest !== snapshot.artifactDigest) {
        throw new Error(
          'Historical graph import found a conflicting snapshot for '
          + snapshot.graphVersion
          + '.'
        );
      }
      skipped += 1;
      continue;
    }
    if (!input.dryRun) {
      if (input.coordinatedTarget) {
        const remainingTtlMs = descriptor.expiresAt
          ? Math.max(1, Date.parse(descriptor.expiresAt) - Date.now())
          : undefined;
        await input.coordinatedTarget.put(artifact, {
          ...(descriptor.graphName ? { graphName: descriptor.graphName } : {}),
          ...(remainingTtlMs ? { ttlMs: remainingTtlMs } : {}),
        });
      } else {
        await input.target.stageSnapshot(snapshot);
      }
    }
    imported += 1;
  }
  return {
    discovered: descriptors.length,
    imported,
    skipped,
    dryRun: input.dryRun === true,
  };
}

function resolveLimit(value: number | undefined): number {
  const limit = value ?? 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Historical graph import limit must be between 1 and 1000.');
  }
  return limit;
}
