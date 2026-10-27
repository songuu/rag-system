import type { RagEvidence } from '../core/types';
import { readGraphEvidencePaths } from '../../knowledge-graph/graph-evidence';

/** Only complete, prompt-visible sources may explain a graph path. */
export function formatSupportedGraphContext(
  evidence: readonly RagEvidence[],
  options: { maxCharacters?: number; graphLaneIds?: readonly string[] } = {}
): string {
  const maxCharacters = options.maxCharacters ?? 4_000;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 4_000) {
    throw new Error('Graph explanation character budget must be between 1 and 4000.');
  }
  // Document metadata is user-influenced. Only execution-owned graph lane IDs
  // may elevate it into a relationship explanation or support another hop.
  const graphLaneIds = new Set(options.graphLaneIds ?? []);
  if (graphLaneIds.size === 0) return '';
  const paths: Array<{ relations: Array<{
    subject: string; predicate: string; object: string; citations: number[];
  }> }> = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!graphLaneIds.has(item.laneId)) continue;
    const graphVersion = item.metadata?.graphVersion;
    if (typeof graphVersion !== 'string' || !graphVersion) continue;
    for (const path of readGraphEvidencePaths(item.metadata?.graphPaths)) {
      const relations = path.map(relation => ({
        subject: relation.sourceEntityName,
        predicate: relation.predicate,
        object: relation.targetEntityName,
        citations: evidence.flatMap((source, index) => (
          graphLaneIds.has(source.laneId)
          && source.tenantId === item.tenantId && source.corpusId === item.corpusId
          && source.documentId === item.documentId && source.documentVersion === item.documentVersion
          && source.metadata?.graphVersion === graphVersion
          && source.metadata?.contextTruncated !== true
          && typeof source.metadata?.graphPassageId === 'string'
          && relation.passageIds.includes(source.metadata.graphPassageId)
        ) ? [index + 1] : []),
      }));
      if (relations.some(relation => relation.citations.length === 0)) continue;
      const key = JSON.stringify([graphVersion, item.tenantId, item.corpusId, path.map(relation => relation.claimId)]);
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = { relations };
      if (JSON.stringify({ paths: [...paths, candidate] }).length > maxCharacters) continue;
      paths.push(candidate);
      if (paths.length === 8) return JSON.stringify({ paths });
    }
  }
  return paths.length ? JSON.stringify({ paths }) : '';
}
