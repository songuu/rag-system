import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from './canonical-json';
import { stableStringify } from './dataset';
import { parseRagEvalDataset } from './dataset-parser';
import { reviewDraftCase } from './dataset-draft';
import type { RagEvalCase, RagEvalCorpusDocument, RagEvalDataset, RagEvalExpectedAnswer,
  RagEvalGoldEvidence, RagEvalScope, RagEvalSecurityExpectations } from './types';

type Fields = Record<string, unknown>;
export type RegressionDisposition = 'answer' | 'abstain' | 'clarify';
export interface FeedbackRegressionAnnotation {
  disposition: RegressionDisposition;
  goldEvidence: RagEvalGoldEvidence[];
  expectedAnswer?: RagEvalExpectedAnswer;
  allowedPolicies: string[];
  allowedLanes: string[];
  securityExpectations: RagEvalSecurityExpectations;
  /** Why an answer must be withheld or clarification requested. */
  reason?: string;
}
export interface FeedbackRegressionReviewer { reviewer: string; reviewedAt: string }
export interface FeedbackRegressionReview extends FeedbackRegressionReviewer { sha256: string }
export interface FeedbackRegressionCase {
  id: string;
  traceId: string;
  query: string;
  observedAnswer: string;
  scope: RagEvalScope;
  evidenceIds: string[];
  feedback: { value: number | string | boolean; comment?: string };
  configurationSha256?: string;
  modelVersion?: string;
  promptVersion?: string;
  /** Deliberately unknown until a human supplies and validates annotations. */
  annotation: unknown | null;
  review: FeedbackRegressionReview | null;
}
export interface FeedbackRegressionDraft {
  schemaVersion: 'rag-feedback-regression-draft/v1';
  datasetId: string;
  datasetVersion: string;
  snapshotId: string;
  snapshotVersion: string;
  corpus: RagEvalCorpusDocument[];
  cases: FeedbackRegressionCase[];
}
export interface ReviewedRegressionDataset extends RagEvalDataset {
  regressionProvenance: {
    schemaVersion: 'rag-feedback-regression-provenance/v1';
    draftSha256: string;
    cases: Array<FeedbackRegressionReviewer & {
      caseId: string; traceId: string; snapshotId: string; snapshotVersion: string;
      reviewSha256: string; disposition: RegressionDisposition;
      configurationSha256?: string; modelVersion?: string; promptVersion?: string;
    }>;
  };
}

/** Input is an explicit local export bound to one immutable corpus snapshot.
 * Feedback and previous answers are observations, never reference labels. */
export function createFeedbackRegressionDraft(value: unknown): FeedbackRegressionDraft {
  const input = record(value, 'export');
  if (input.schemaVersion !== 'rag-feedback-export/v1') fail('unsupported feedback export version');
  const datasetId = text(input.datasetId, 'datasetId');
  const datasetVersion = text(input.datasetVersion, 'datasetVersion');
  const snapshotId = text(input.snapshotId, 'snapshotId');
  const snapshotVersion = text(input.snapshotVersion, 'snapshotVersion');
  const corpus = parseRagEvalDataset({ schemaVersion: 'rag-eval-dataset/v2', datasetId, datasetVersion,
    corpus: input.corpus, cases: [{ id: 'snapshot-validation', query: 'Validate snapshot', tags: [],
      expectedAbstain: true, goldEvidence: [], scope: { tenantId: 'validation', corpusId: 'validation',
        allowedTrustLevels: ['reviewed'] }, ...validationOnlySecurity() }] }).corpus;
  const corpusById = new Map(corpus.map(item => [item.evidenceId, item]));
  const traces = nonEmptyArray(input.traces, 'traces');
  const unique = new Map<string, FeedbackRegressionCase>();
  for (const raw of traces) {
    const trace = record(raw, 'trace');
    const traceId = text(trace.traceId, 'traceId');
    if (trace.snapshotId !== snapshotId || trace.snapshotVersion !== snapshotVersion) fail('trace snapshot does not match supplied corpus snapshot');
    const feedback = record(trace.feedback, 'feedback');
    const feedbackValue = feedback.value;
    if (!['number', 'string', 'boolean'].includes(typeof feedbackValue)
      || (typeof feedbackValue === 'number' && !Number.isFinite(feedbackValue))
      || (typeof feedbackValue === 'string' && !feedbackValue.trim())) fail('feedback value must be a finite score, boolean or nonempty label');
    const scope = parseRagEvalDataset({ schemaVersion: 'rag-eval-dataset/v2', datasetId, datasetVersion, corpus,
      cases: [{ id: 'scope-validation', query: text(trace.query, 'query'), tags: [], expectedAbstain: true,
        goldEvidence: [], scope: trace.scope, ...validationOnlySecurity() }] }).cases[0].scope!;
    const evidenceIds = array(trace.evidenceIds, 'evidenceIds').map(item => text(item, 'evidenceId'));
    if (new Set(evidenceIds).size !== evidenceIds.length) fail('duplicate observed evidence ID');
    for (const id of evidenceIds) {
      const item = corpusById.get(id);
      if (!item || item.tenantId !== scope.tenantId || item.corpusId !== scope.corpusId
        || item.trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(item.trustLevel!)) {
        fail('observed evidence is absent from the supplied scoped snapshot');
      }
    }
    if (typeof trace.answer !== 'string') fail('trace answer must be a string, including an explicit empty string');
    const entry: FeedbackRegressionCase = {
      id: 'feedback-' + canonicalJsonSha256(traceId).slice(0, 20), traceId,
      query: text(trace.query, 'query'), observedAnswer: trace.answer, scope, evidenceIds,
      feedback: { value: feedbackValue as number | string | boolean,
        ...(feedback.comment === undefined ? {} : { comment: string(feedback.comment, 'feedback comment') }) },
      ...optionalVersions(trace), annotation: null, review: null,
    };
    const prior = unique.get(traceId);
    if (prior && fullJsonDigest(prior) !== fullJsonDigest(entry)) fail('conflicting duplicate traceId');
    unique.set(traceId, entry);
  }
  // A detached copy keeps subsequent caller mutations out of the audit record.
  return detached({ schemaVersion: 'rag-feedback-regression-draft/v1', datasetId, datasetVersion,
    snapshotId, snapshotVersion, corpus, cases: [...unique.values()] });
}

/** Human review is an explicit attestation, not inferred from a feedback score. */
export function reviewFeedbackRegressionCase(value: unknown, caseId: string, annotationInput: unknown,
  reviewerInput: unknown): FeedbackRegressionDraft {
  const draft = parseDraft(value);
  const index = draft.cases.findIndex(item => item.id === caseId);
  if (index < 0) fail('case to review does not exist');
  const annotation = validateAnnotation(draft, draft.cases[index], annotationInput);
  const reviewer = parseReviewer(reviewerInput);
  const entry = { ...draft.cases[index], annotation, review: null };
  const review = { ...reviewer, sha256: reviewDigest(draft, entry, reviewer) };
  draft.cases[index] = { ...entry, review };
  return draft;
}

/** Executable export is all-or-nothing; incomplete drafts remain draft artifacts. */
export function exportReviewedRegressionDataset(value: unknown): ReviewedRegressionDataset {
  const draft = parseDraft(value);
  const cases: RagEvalCase[] = [];
  const provenance: ReviewedRegressionDataset['regressionProvenance']['cases'] = [];
  for (const entry of draft.cases) {
    if (!entry.review || !entry.annotation) fail('every case needs explicit human review before executable export');
    if (reviewDigest(draft, entry, entry.review) !== entry.review.sha256) fail('review is stale after editing draft content');
    const annotation = validateAnnotation(draft, entry, entry.annotation);
    cases.push(toEvalCase(entry, annotation));
    provenance.push({ caseId: entry.id, traceId: entry.traceId, snapshotId: draft.snapshotId,
      snapshotVersion: draft.snapshotVersion, reviewer: entry.review.reviewer, reviewedAt: entry.review.reviewedAt,
      reviewSha256: entry.review.sha256, disposition: annotation.disposition, ...optionalVersions(entry) });
  }
  const dataset = parseRagEvalDataset({ schemaVersion: 'rag-eval-dataset/v2', datasetId: draft.datasetId,
    datasetVersion: draft.datasetVersion, corpus: draft.corpus, cases });
  return { ...dataset, regressionProvenance: { schemaVersion: 'rag-feedback-regression-provenance/v1',
    draftSha256: fullJsonDigest(draft), cases: provenance } };
}

export function serializeFeedbackRegressionDraft(value: unknown): string {
  return JSON.stringify(parseDraft(value), null, 2);
}

function parseDraft(value: unknown): FeedbackRegressionDraft {
  const input = record(value, 'draft');
  if (input.schemaVersion !== 'rag-feedback-regression-draft/v1') fail('unsupported regression draft version');
  const entries = nonEmptyArray(input.cases, 'cases').map(value => record(value, 'case'));
  const draft = createFeedbackRegressionDraft({ ...input, schemaVersion: 'rag-feedback-export/v1',
    traces: entries.map(entry => ({ ...entry, answer: entry.observedAnswer,
      snapshotId: input.snapshotId, snapshotVersion: input.snapshotVersion })) });
  if (draft.cases.length !== entries.length) fail('duplicate draft case');
  draft.cases = draft.cases.map((entry, index) => {
    const raw = entries[index];
    if (raw.id !== entry.id) fail('draft case ID does not match trace identity');
    if (raw.annotation === undefined || raw.review === undefined) fail('draft annotation and review must be explicit, use null while pending');
    const annotation = raw.annotation === null ? null : detached(record(raw.annotation, 'annotation'));
    const review = raw.review === null ? null : { ...parseReviewer(raw.review), sha256: sha256(record(raw.review, 'review').sha256, 'review sha256') };
    return { ...entry, annotation, review };
  });
  return draft;
}

function validateAnnotation(draft: FeedbackRegressionDraft, entry: FeedbackRegressionCase, value: unknown): FeedbackRegressionAnnotation {
  const input = record(value, 'annotation');
  const disposition = input.disposition;
  if (disposition !== 'answer' && disposition !== 'abstain' && disposition !== 'clarify') fail('annotation disposition must be answer, abstain or clarify');
  let reason: string | undefined;
  if (disposition !== 'answer') {
    if (input.expectedAnswer !== undefined) fail('abstention and clarification must not carry answer labels');
    if (array(input.goldEvidence, 'goldEvidence').length) fail('abstention and clarification must have empty gold evidence');
    reason = text(input.reason, 'reason for withholding an answer');
  }
  const candidate = { disposition, goldEvidence: input.goldEvidence, expectedAnswer: input.expectedAnswer,
    allowedPolicies: input.allowedPolicies, allowedLanes: input.allowedLanes,
    securityExpectations: input.securityExpectations } as FeedbackRegressionAnnotation;
  const dataset = parseRagEvalDataset({ schemaVersion: 'rag-eval-dataset/v2', datasetId: draft.datasetId,
    datasetVersion: draft.datasetVersion, corpus: draft.corpus, cases: [toEvalCase(entry, candidate)] });
  // Reuse the existing answer/evidence review checks rather than maintaining a second validator.
  const reviewed = disposition === 'answer' ? reviewDraftCase(dataset, entry.id).cases[0] : dataset.cases[0];
  return { disposition, goldEvidence: reviewed.goldEvidence,
    ...(reviewed.expectedAnswer === undefined ? {} : { expectedAnswer: reviewed.expectedAnswer }),
    allowedPolicies: reviewed.allowedPolicies!, allowedLanes: reviewed.allowedLanes!,
    securityExpectations: reviewed.securityExpectations!, ...(reason === undefined ? {} : { reason }) };
}

function toEvalCase(entry: FeedbackRegressionCase, annotation: FeedbackRegressionAnnotation): RagEvalCase {
  return { id: entry.id, query: entry.query, scope: entry.scope,
    tags: ['feedback-regression', 'human-reviewed', 'expected-disposition:' + annotation.disposition],
    expectedAbstain: annotation.disposition !== 'answer', expectedDisposition: annotation.disposition,
    goldEvidence: annotation.goldEvidence,
    allowedPolicies: annotation.allowedPolicies, allowedLanes: annotation.allowedLanes,
    securityExpectations: annotation.securityExpectations,
    ...(annotation.expectedAnswer === undefined ? {} : { expectedAnswer: annotation.expectedAnswer }) };
}

// These sentinels validate only corpus/scope structure in pending drafts. They
// never become regression labels; export requires explicit human restrictions.
function validationOnlySecurity() {
  return { allowedPolicies: ['validation-only'], allowedLanes: ['validation-only'],
    securityExpectations: { forbiddenEvidenceIds: [], forbiddenAnswerPatterns: ['validation-only'] } };
}

function reviewDigest(draft: FeedbackRegressionDraft, entry: FeedbackRegressionCase, reviewer: FeedbackRegressionReviewer): string {
  const observations = { ...entry, review: null };
  // Corpus and answers can exceed the bounded canonical contract budget.
  // Digest their complete normalized JSON, then bind those digests into the
  // small review contract; no original content is truncated or omitted.
  return canonicalJsonSha256({ datasetId: draft.datasetId, datasetVersion: draft.datasetVersion,
    snapshotId: draft.snapshotId, snapshotVersion: draft.snapshotVersion, corpusSha256: fullJsonDigest(draft.corpus),
    caseSha256: fullJsonDigest(observations), reviewer: { reviewer: reviewer.reviewer, reviewedAt: reviewer.reviewedAt } });
}
function parseReviewer(value: unknown): FeedbackRegressionReviewer {
  const input = record(value, 'reviewer');
  const reviewedAt = text(input.reviewedAt, 'reviewedAt');
  if (!Number.isFinite(Date.parse(reviewedAt)) || new Date(reviewedAt).toISOString() !== reviewedAt) fail('reviewedAt must be a canonical UTC ISO timestamp');
  return { reviewer: text(input.reviewer, 'reviewer'), reviewedAt };
}
function optionalVersions(value: Fields | FeedbackRegressionCase) {
  return { ...(value.configurationSha256 === undefined ? {} : { configurationSha256: sha256(value.configurationSha256, 'configurationSha256') }),
    ...(value.modelVersion === undefined ? {} : { modelVersion: text(value.modelVersion, 'modelVersion') }),
    ...(value.promptVersion === undefined ? {} : { promptVersion: text(value.promptVersion, 'promptVersion') }) };
}
function sha256(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) fail(label + ' must be a lowercase SHA-256');
  return result;
}
function record(value: unknown, label: string): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
  return value as Fields;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(label + ' must be a string');
  return value;
}
function text(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result.trim()) fail(label + ' must not be empty');
  return result;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(label + ' must be an array');
  return value;
}
function nonEmptyArray(value: unknown, label: string): unknown[] {
  const result = array(value, label);
  if (!result.length) fail(label + ' must not be empty');
  return result;
}
function fullJsonDigest(value: unknown): string { return createHash('sha256').update(stableStringify(value)).digest('hex'); }
function detached<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
        || (typeof item === 'number' && !Number.isFinite(item))) fail('draft contains unsupported JSON values');
      return item;
    })) as T;
  } catch { fail('draft contains unsupported JSON values'); }
}
function fail(message: string): never { throw new Error('[feedback-regression] ' + message); }
