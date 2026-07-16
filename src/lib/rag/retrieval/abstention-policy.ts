import type { RagEvidence } from '../core/types';
import type { RetrievalQueryKind } from './retrieval-router';

export const RAG_ABSTENTION_POLICY_VERSION = 'rag-abstention/per-lane-v1' as const;

export type AbstentionLaneKind =
  | 'dense'
  | 'lexical'
  | 'hybrid'
  | 'graph'
  | 'ordered'
  | 'visual';

export interface LaneScoreCalibration {
  minimumScore: number;
  scoreField?: 'retrieval' | 'rerank' | 'best';
  allowMissingScore?: boolean;
}

export interface AbstentionCalibration {
  version: string;
  lanes: Record<string, LaneScoreCalibration>;
}

export interface AbstentionDecisionInput {
  queryKind: RetrievalQueryKind;
  evidence: readonly RagEvidence[];
  laneKinds: Readonly<Record<string, AbstentionLaneKind>>;
  calibration: AbstentionCalibration;
  minimumDistinctDocuments?: number;
}

export interface AbstentionLaneSummary {
  laneId: string;
  kind?: AbstentionLaneKind;
  threshold?: number;
  total: number;
  qualified: number;
  maximumScore?: number;
}

export interface AbstentionDecision {
  version: typeof RAG_ABSTENTION_POLICY_VERSION;
  calibrationVersion: string;
  abstain: boolean;
  reason:
    | 'no_evidence'
    | 'unsafe_evidence'
    | 'invalid_evidence_score'
    | 'uncalibrated_lane_evidence'
    | 'all_evidence_below_lane_threshold'
    | 'identifier_requires_lexical_evidence'
    | 'insufficient_distinct_documents'
    | 'sufficient_evidence';
  qualifiedEvidenceIds: string[];
  distinctDocumentCount: number;
  laneSummaries: AbstentionLaneSummary[];
}

export function decideRagAbstention(
  input: AbstentionDecisionInput
): AbstentionDecision {
  const calibrationVersion = required(input.calibration.version, 'calibration.version');
  validateCalibrations(input.calibration.lanes);
  const duplicateId = findDuplicateEvidenceId(input.evidence);
  if (duplicateId) throw new Error('Abstention evidence IDs must be unique: ' + duplicateId);
  if (input.evidence.length === 0) {
    return result(input, calibrationVersion, true, 'no_evidence', [], []);
  }
  if (
    input.evidence.some(
      item => !['trusted', 'reviewed', 'external'].includes(item.trustLevel)
    )
  ) {
    return result(input, calibrationVersion, true, 'unsafe_evidence', [], summarizeLanes(input, []));
  }
  if (input.evidence.some(hasInvalidScore)) {
    return result(
      input,
      calibrationVersion,
      true,
      'invalid_evidence_score',
      [],
      summarizeLanes(input, [])
    );
  }

  const calibratedEvidence = input.evidence.filter(
    item => input.calibration.lanes[item.laneId] !== undefined
  );
  if (calibratedEvidence.length === 0) {
    return result(
      input,
      calibrationVersion,
      true,
      'uncalibrated_lane_evidence',
      [],
      summarizeLanes(input, [])
    );
  }
  const qualified = calibratedEvidence.filter(item => qualifies(item, input.calibration.lanes[item.laneId]));
  const laneSummaries = summarizeLanes(input, qualified);
  if (qualified.length === 0) {
    return result(
      input,
      calibrationVersion,
      true,
      'all_evidence_below_lane_threshold',
      [],
      laneSummaries
    );
  }

  if (
    input.queryKind === 'identifier' &&
    !qualified.some(item => hasLexicalProof(item, input.laneKinds[item.laneId]))
  ) {
    return result(
      input,
      calibrationVersion,
      true,
      'identifier_requires_lexical_evidence',
      qualified,
      laneSummaries
    );
  }

  if (input.queryKind === 'global' || input.queryKind === 'multi-hop') {
    const minimumDistinctDocuments = input.minimumDistinctDocuments ?? 2;
    if (!Number.isInteger(minimumDistinctDocuments) || minimumDistinctDocuments < 1) {
      throw new Error('Abstention minimumDistinctDocuments must be a positive integer.');
    }
    if (distinctDocuments(qualified).size < minimumDistinctDocuments) {
      return result(
        input,
        calibrationVersion,
        true,
        'insufficient_distinct_documents',
        qualified,
        laneSummaries
      );
    }
  }

  return result(
    input,
    calibrationVersion,
    false,
    'sufficient_evidence',
    qualified,
    laneSummaries
  );
}

function qualifies(evidence: RagEvidence, calibration: LaneScoreCalibration): boolean {
  const score = evidenceScore(evidence, calibration.scoreField ?? 'best');
  if (score === undefined) return calibration.allowMissingScore === true;
  return score >= calibration.minimumScore;
}

function evidenceScore(
  evidence: RagEvidence,
  field: NonNullable<LaneScoreCalibration['scoreField']>
): number | undefined {
  if (field === 'retrieval') return evidence.retrievalScore ?? evidence.score;
  if (field === 'rerank') return evidence.rerankScore;
  return evidence.rerankScore ?? evidence.retrievalScore ?? evidence.score;
}

function hasLexicalProof(evidence: RagEvidence, kind?: AbstentionLaneKind): boolean {
  if (kind === 'lexical') return true;
  if (kind !== 'hybrid') return false;
  return evidence.metadata?.lexicalMatch === true;
}

function summarizeLanes(
  input: AbstentionDecisionInput,
  qualified: readonly RagEvidence[]
): AbstentionLaneSummary[] {
  const qualifiedIds = new Set(qualified.map(item => item.id));
  const laneIds = [...new Set(input.evidence.map(item => item.laneId))];
  return laneIds.map(laneId => {
    const items = input.evidence.filter(item => item.laneId === laneId);
    const calibration = input.calibration.lanes[laneId];
    const scores = items
      .map(item => evidenceScore(item, calibration?.scoreField ?? 'best'))
      .filter((score): score is number => score !== undefined && Number.isFinite(score));
    return {
      laneId,
      kind: input.laneKinds[laneId],
      threshold: calibration?.minimumScore,
      total: items.length,
      qualified: items.filter(item => qualifiedIds.has(item.id)).length,
      ...(scores.length > 0 ? { maximumScore: Math.max(...scores) } : {}),
    };
  });
}

function result(
  input: AbstentionDecisionInput,
  calibrationVersion: string,
  abstain: boolean,
  reason: AbstentionDecision['reason'],
  qualified: readonly RagEvidence[],
  laneSummaries: AbstentionLaneSummary[]
): AbstentionDecision {
  return {
    version: RAG_ABSTENTION_POLICY_VERSION,
    calibrationVersion,
    abstain,
    reason,
    qualifiedEvidenceIds: qualified.map(item => item.id),
    distinctDocumentCount: distinctDocuments(qualified).size,
    laneSummaries,
  };
}

function distinctDocuments(evidence: readonly RagEvidence[]): Set<string> {
  return new Set(evidence.map(item => item.documentId));
}

function hasInvalidScore(evidence: RagEvidence): boolean {
  return [evidence.rerankScore, evidence.retrievalScore, evidence.score].some(
    score => score !== undefined && !Number.isFinite(score)
  );
}

function validateCalibrations(calibrations: AbstentionCalibration['lanes']): void {
  for (const [laneId, calibration] of Object.entries(calibrations)) {
    required(laneId, 'calibration laneId');
    if (!calibration || typeof calibration !== 'object') {
      throw new Error('Abstention lane calibration must be an object: ' + laneId);
    }
    if (!Number.isFinite(calibration.minimumScore)) {
      throw new Error('Abstention lane threshold must be finite: ' + laneId);
    }
    if (
      calibration.scoreField !== undefined &&
      !['retrieval', 'rerank', 'best'].includes(calibration.scoreField)
    ) {
      throw new Error('Abstention lane scoreField is invalid: ' + laneId);
    }
  }
}

function findDuplicateEvidenceId(evidence: readonly RagEvidence[]): string | undefined {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.id)) return item.id;
    seen.add(item.id);
  }
  return undefined;
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Abstention ' + field + ' is required.');
  }
  return value.trim();
}
