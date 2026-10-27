import type { RagEvidence, RagLaneExecution } from '../core/types';

export interface RetrievalDiagnosticRow {
  evidenceId: string;
  source: string;
  laneId: string;
  retrievalScore?: number;
  rerankScore?: number;
  beforeRerankRank?: number;
  afterRerankRank?: number;
  rerankLaneId?: string;
  inContext: boolean;
  cited: boolean | null;
}

export interface RetrievalDiagnostics {
  version: 'retrieval-diagnostics/v1';
  qualityMeasurement: 'unmeasured';
  candidateCount: number;
  contextCount: number;
  citedCount: number | null;
  rows: RetrievalDiagnosticRow[];
}

export function createRetrievalDiagnostics(input: {
  evidence: readonly Pick<RagEvidence, 'id' | 'source' | 'laneId' | 'retrievalScore' | 'rerankScore'>[];
  laneExecutions: readonly Pick<RagLaneExecution, 'laneId' | 'status' | 'reranking'>[];
  includedEvidenceIds: readonly string[];
  citedEvidenceIds?: readonly string[];
}): RetrievalDiagnostics {
  const includedIds = new Set(input.includedEvidenceIds);
  const citedIds = input.citedEvidenceIds === undefined ? null : new Set(input.citedEvidenceIds);
  const positions = new Map<string, Pick<RetrievalDiagnosticRow, 'beforeRerankRank' | 'afterRerankRank' | 'rerankLaneId'>>();
  for (const lane of input.laneExecutions) {
    if (lane.status !== 'completed' || !lane.reranking) continue;
    const before = new Map(lane.reranking.beforeEvidenceIds.map((id, index) => [id, index + 1]));
    lane.reranking.afterEvidenceIds.forEach((id, index) => {
      const rank = before.get(id);
      if (rank !== undefined) positions.set(id, {
        beforeRerankRank: rank, afterRerankRank: index + 1, rerankLaneId: lane.laneId,
      });
    });
  }
  const uniqueEvidence = new Map(input.evidence.map(item => [item.id, item]));
  const rows = [...uniqueEvidence.values()].map(item => ({
    evidenceId: item.id,
    source: item.source || item.id,
    laneId: item.laneId,
    ...(item.retrievalScore === undefined ? {} : { retrievalScore: item.retrievalScore }),
    ...(item.rerankScore === undefined ? {} : { rerankScore: item.rerankScore }),
    ...positions.get(item.id),
    inContext: includedIds.has(item.id),
    cited: citedIds === null ? null : includedIds.has(item.id) && citedIds.has(item.id),
  }));
  return {
    version: 'retrieval-diagnostics/v1',
    // Rank movement is an observation; relevance requires independently labeled cases.
    qualityMeasurement: 'unmeasured',
    candidateCount: rows.length,
    contextCount: rows.filter(row => row.inContext).length,
    citedCount: citedIds === null ? null : rows.filter(row => row.cited).length,
    rows,
  };
}
