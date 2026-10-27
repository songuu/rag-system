import { createHash } from 'node:crypto';
import type { RagEvidence } from '../core/types';
import type { RagSecurityContext } from '../../security/request-context';
import { citationPartition, createCitationLocatorCodec } from './locator-codec';
import { parseCitationReferences } from './reference-parser';
import { createMiroFishGraphVersion } from '../../knowledge-graph/mirofish-adapter';
import { readGraphEvidencePaths } from '../../knowledge-graph/graph-evidence';
import type { RagCitations } from './types';

/** Only the final prompt-visible snapshot can assign source numbers. Never use retrieval candidates. */
export function issueAnswerCitations(input: {
  answer: string;
  servedEvidence: readonly RagEvidence[];
  security: RagSecurityContext;
  /** IDs come from server-owned completed active Graph Lanes, never evidence metadata. */
  graphLaneIds?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
}): RagCitations {
  const parsed = parseCitationReferences(input.answer, Math.min(input.servedEvidence.length, 1000));
  const numbers = [...new Set(parsed.ranges.flatMap(range => range.numbers))].filter(number => number >= 1 && number <= input.servedEvidence.length);
  const result: RagCitations = {
    version: 'rag-citations/v1', status: 'missing', partition: citationPartition(input.security), items: [],
    diagnostics: { reason: 'no-numbered-citations', citationCount: parsed.citationCount, invalidCitationCount: parsed.invalidCitationCount, unavailableCitationCount: 0 },
  };
  if (!parsed.citationCount) return result;
  result.status = 'unavailable';
  result.diagnostics.reason = 'sources-unavailable';
  let codec: ReturnType<typeof createCitationLocatorCodec>;
  try { codec = createCitationLocatorCodec(input.env); }
  catch { result.diagnostics.reason = 'configuration-unavailable'; result.diagnostics.unavailableCitationCount = numbers.length; return result; }
  const seen = new Set<string>();
  const graphLaneIds = new Set(input.graphLaneIds ?? []);
  for (const number of numbers) {
    const evidence = input.servedEvidence[number - 1];
    try {
      if (!graphLaneIds.has(evidence.laneId) || seen.has(evidence.id) || evidence.tenantId !== input.security.tenantId || evidence.corpusId !== input.security.corpusId || evidence.trustLevel === 'quarantined') throw new Error();
      seen.add(evidence.id);
      const metadata = evidence.metadata ?? {};
      const graphVersion = metadata.graphVersion;
      const passageId = metadata.graphPassageId;
      if (typeof graphVersion !== 'string' || typeof passageId !== 'string' || createMiroFishGraphVersion(evidence) !== graphVersion) throw new Error();
      // File GraphLane's public ID predates canonical snapshot hashes; retain both server-issued formats.
      if (evidence.id !== 'graph:' + graphVersion + ':' + passageId && evidence.id !== 'graph:' + evidence.documentVersion + ':' + passageId) throw new Error();
      if (!evidence.content || evidence.startOffset === undefined || evidence.endOffset === undefined || evidence.endOffset - evidence.startOffset !== evidence.content.length) throw new Error();
      // A File lane has paths but no legacy claim list. Bind only this passage's bounded path sources.
      const claimIds = [...new Set(readGraphEvidencePaths(metadata.graphPaths).flatMap(path => (
        path.filter(relation => relation.passageIds.includes(passageId)).map(relation => relation.claimId)
      )))];
      const encoded = codec.encode({
        actorId: input.security.actorId, tenantId: evidence.tenantId, corpusId: evidence.corpusId,
        graphVersion, documentId: evidence.documentId, documentVersion: evidence.documentVersion, trustLevel: evidence.trustLevel,
        passageId, claimIds, startOffset: evidence.startOffset, endOffset: evidence.endOffset,
        contentHash: createHash('sha256').update(evidence.content).digest('hex'),
      }, input.now);
      // Source labels may contain signed URLs or credentials; return them only in an authorized preview.
      result.items.push({ number, ...encoded,
        ...(Number.isSafeInteger(evidence.page) && Number(evidence.page) >= 0 ? { page: evidence.page } : {}),
      });
    } catch { result.diagnostics.unavailableCitationCount += 1; }
  }
  if (result.items.length) { result.status = 'available'; result.diagnostics.reason = 'ready'; }
  return result;
}
