import { throwIfRagRequestAborted } from '../core/cancellation';
import {
  RagLaneEvidenceValidationError,
  type RagLaneHandler,
  type RagLaneHandlerContext,
} from './lane-executor';
import { buildReranker, isRerankerConfigured, type RerankerInput, type RerankerProvider } from './rerank-providers';

/** Reranking changes order and relevance only; canonical provenance stays executor-owned. */
export function createRerankLaneHandler(
  options: { provider?: RerankerProvider } = {}
): RagLaneHandler {
  const provider = options.provider ?? (isRerankerConfigured() ? buildReranker() : undefined);
  return {
    type: 'rerank',
    // Stable across requests so timed-out, non-cooperative work remains admission-fenced.
    retriever: provider ? `rerank:${provider.name}:${provider.model}` : 'rerank:unavailable',
    async execute(context) {
      throwIfRagRequestAborted(context.signal);
      const snapshot = snapshotScopedEvidence(context);
      if (!provider) {
        return { evidence: [], stopReason: 'capability_unavailable', metadata: { reason: 'reranker_not_configured' } };
      }
      if (snapshot.length === 0) {
        return { evidence: [], stopReason: 'no_gain', metadata: { reason: 'no_candidates' } };
      }
      // The provider receives separate primitive copies, never canonical evidence or validation state.
      const outputs = await provider.rerank(
        context.plan.query,
        snapshot.map(document => ({ ...document })),
        snapshot.length,
        { signal: context.signal }
      );
      throwIfRagRequestAborted(context.signal);
      if (!Array.isArray(outputs) || outputs.length !== snapshot.length) {
        throw new Error('Reranker returned an invalid response.');
      }
      const seen = new Set<number>();
      const orderedEvidenceIds: string[] = [];
      const rerankScores: Record<string, number> = Object.create(null);
      for (const output of outputs) {
        if (!output || typeof output !== 'object') throw new Error('Reranker returned an invalid response.');
        const { originalIndex, id, content, relevanceScore } = output;
        if (!Number.isInteger(originalIndex) || originalIndex < 0 || originalIndex >= snapshot.length
          || seen.has(originalIndex) || !Number.isFinite(relevanceScore)
          || id !== snapshot[originalIndex].id || content !== snapshot[originalIndex].content) {
          throw new Error('Reranker returned an invalid response.');
        }
        seen.add(originalIndex);
        orderedEvidenceIds.push(id);
        rerankScores[id] = relevanceScore;
      }
      return { evidence: [], transform: { orderedEvidenceIds, rerankScores }, stopReason: 'sufficient' };
    },
  };
}

function snapshotScopedEvidence(context: RagLaneHandlerContext): RerankerInput[] {
  const scope = context.request.retrievalScope;
  if (!scope || !scope.tenantId || !scope.corpusId || !Array.isArray(scope.allowedTrustLevels)) {
    throw new RagLaneEvidenceValidationError('Reranking requires a server-derived retrieval scope.');
  }
  const seen = new Set<string>();
  return context.priorEvidence.map(evidence => {
    for (const field of ['id', 'content', 'documentId', 'documentVersion', 'laneId'] as const) {
      if (typeof evidence[field] !== 'string' || !evidence[field].trim()) {
        throw new RagLaneEvidenceValidationError('Reranking evidence is missing identity, content or provenance.');
      }
    }
    if (seen.has(evidence.id)) {
      throw new RagLaneEvidenceValidationError('Reranking evidence contains duplicate identities.');
    }
    if (evidence.tenantId !== scope.tenantId || evidence.corpusId !== scope.corpusId) {
      throw new RagLaneEvidenceValidationError('Reranking evidence is outside the authenticated retrieval scope.');
    }
    if (evidence.trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(evidence.trustLevel)) {
      throw new RagLaneEvidenceValidationError('Reranking evidence is outside the allowed trust scope.');
    }
    seen.add(evidence.id);
    return { id: evidence.id, content: evidence.content };
  });
}
