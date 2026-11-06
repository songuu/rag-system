import { evaluateRetrieval } from './metrics';
import type { RagEvalGoldEvidence, RagEvalRetrievalMetrics, RagEvalRetrievedEvidence } from './types';

export interface RagEvalRetrievalStages {
  candidates?: string[];
  reranked?: string[];
  context?: string[];
}
export interface RagEvalStageMetrics extends RagEvalRetrievalMetrics {
  requiredEvidenceComplete: boolean | null;
}
export type RagEvalRetrievalStageMetrics = Record<keyof RagEvalRetrievalStages, RagEvalStageMetrics | null>;

export function evaluateRetrievalStages(gold: readonly RagEvalGoldEvidence[], stages: RagEvalRetrievalStages,
  topK: number, requiredEvidenceGroups?: readonly (readonly string[])[], servedEvidence?: readonly RagEvalRetrievedEvidence[]): RagEvalRetrievalStageMetrics {
  if (!Number.isInteger(topK) || topK < 1) throw new Error('[rag-eval stages] topK must be a positive integer');
  const evaluate = (ids: string[] | undefined): RagEvalStageMetrics | null => {
    if (ids === undefined) return null;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('[rag-eval stages] invalid evidence ID');
    if (new Set(ids).size !== ids.length) throw new Error('[rag-eval stages] duplicate evidence ID');
    const selected = new Set(ids.slice(0, topK));
    return { ...evaluateRetrieval(gold, ids, topK), requiredEvidenceComplete: requiredEvidenceGroups?.length
      ? requiredEvidenceGroups.every(group => group.some(id => selected.has(id))) : null };
  };
  const context = evaluate(stages.context);
  if (context && requiredEvidenceGroups?.length) {
    const present = new Set(stages.context), served = new Map(servedEvidence?.map(item => [item.evidenceId,item]));
    const groups = requiredEvidenceGroups.map(group => group.map(id => {
      if (!present.has(id)) return false;
      const span = served.get(id)?.servedSpan;
      if (!span) return true;
      const spans = gold.find(item => item.evidenceId === id)?.spans;
      return spans?.length ? spans.every(goldSpan => goldSpan.startOffset >= span.startOffset && goldSpan.endOffset <= span.endOffset) : null;
    })).map(values => values.some(value => value === true) ? true : values.some(value => value === null) ? null : false);
    context.requiredEvidenceComplete = groups.some(value => value === false) ? false : groups.some(value => value === null) ? null : true;
  }
  return { candidates: evaluate(stages.candidates), reranked: evaluate(stages.reranked), context };
}
