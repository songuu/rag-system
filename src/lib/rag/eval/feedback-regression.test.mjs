import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('./')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { createFeedbackRegressionDraft, reviewFeedbackRegressionCase, exportReviewedRegressionDataset,
  serializeFeedbackRegressionDraft } = await import('./feedback-regression.ts');
const { parseRagEvalDataset } = await import('./dataset-parser.ts');

function input() {
  return { schemaVersion: 'rag-feedback-export/v1', datasetId: 'support-feedback', datasetVersion: '1',
    snapshotId: 'kb-support', snapshotVersion: '2026-11-05',
    corpus: [{ evidenceId: 'e1', documentId: 'd1', documentVersion: 'v3', tenantId: 'tenant', corpusId: 'kb',
      trustLevel: 'reviewed', source: 'support.txt', content: 'Refunds are available within 30 days.' }],
    traces: [{ traceId: 'trace-1', query: 'When can I request a refund?', answer: 'Within 60 days.',
      snapshotId: 'kb-support', snapshotVersion: '2026-11-05', evidenceIds: ['e1'],
      scope: { tenantId: 'tenant', corpusId: 'kb', allowedTrustLevels: ['reviewed'] },
      feedback: { value: -1, comment: 'Please check the period.' } }],
  };
}
function annotation() {
  return { ...restrictions(), disposition: 'answer', goldEvidence: [{ evidenceId: 'e1', relevance: 3,
    spans: [{ startOffset: 0, endOffset: 36 }] }],
    expectedAnswer: { referenceAnswer: 'Within 30 days.', requiredFacts: [['30 days']] } };
}
function restrictions() { return { allowedPolicies: ['milvus-2step'], allowedLanes: ['dense-vector-required'],
  securityExpectations: { forbiddenEvidenceIds: [], forbiddenAnswerPatterns: ['private-account-secret'] } }; }
const review = { reviewer: 'reviewer-a', reviewedAt: '2026-11-05T09:00:00.000Z' };

test('feedback becomes an immutable unreviewed draft and never becomes automatic gold', () => {
  const source = input();
  source.traces.push(structuredClone(source.traces[0]));
  const original = structuredClone(source);
  const draft = createFeedbackRegressionDraft(source);
  assert.deepEqual(source, original);
  assert.equal(draft.cases.length, 1);
  assert.equal(draft.cases[0].annotation, null);
  assert.equal(draft.cases[0].review, null);
  assert.equal(draft.cases[0].observedAnswer, 'Within 60 days.');
  assert.equal(draft.cases[0].feedback.value, -1);
  assert.equal(draft.cases[0].traceId, 'trace-1');
  source.corpus[0].content = 'changed';
  assert.equal(draft.corpus[0].content, original.corpus[0].content);
  assert.throws(() => exportReviewedRegressionDataset(draft), /review/i);
  assert.equal(JSON.parse(serializeFeedbackRegressionDraft(draft)).schemaVersion, 'rag-feedback-regression-draft/v1');
});

test('human annotations export a valid scoped dataset with trace and review provenance', () => {
  const draft = createFeedbackRegressionDraft(input());
  const reviewed = reviewFeedbackRegressionCase(draft, draft.cases[0].id, annotation(), review);
  assert.equal(draft.cases[0].review, null);
  const exported = exportReviewedRegressionDataset(reviewed);
  const dataset = parseRagEvalDataset(exported);
  assert.equal(dataset.schemaVersion, 'rag-eval-dataset/v2');
  assert.equal(dataset.cases[0].expectedAnswer.referenceAnswer, 'Within 30 days.');
  assert.equal(dataset.cases[0].expectedAbstain, false);
  assert.equal(dataset.cases[0].expectedDisposition, 'answer');
  assert.ok(dataset.cases[0].tags.includes('human-reviewed'));
  assert.ok(dataset.cases[0].tags.includes('feedback-regression'));
  const provenance = exported.regressionProvenance.cases[0];
  assert.equal(provenance.traceId, 'trace-1');
  assert.equal(provenance.reviewer, 'reviewer-a');
  assert.equal(provenance.snapshotVersion, '2026-11-05');
  assert.match(provenance.reviewSha256, /^[a-f0-9]{64}$/);
});

test('abstention and clarification require explicit human decisions, not generated answer labels', () => {
  for (const disposition of ['abstain', 'clarify']) {
    const draft = createFeedbackRegressionDraft(input());
    const reviewed = reviewFeedbackRegressionCase(draft, draft.cases[0].id,
      { ...restrictions(), disposition, goldEvidence: [], reason: 'Required conditions are missing.' }, review);
    const dataset = exportReviewedRegressionDataset(reviewed);
    assert.equal(dataset.cases[0].expectedAbstain, true);
    assert.equal(dataset.cases[0].expectedDisposition, disposition);
    assert.deepEqual(dataset.cases[0].goldEvidence, []);
    assert.ok(dataset.cases[0].tags.includes('expected-disposition:' + disposition));
    assert.equal(dataset.regressionProvenance.cases[0].disposition, disposition);
  }
});

test('partial reviews and editing any reviewed content invalidate executable export', () => {
  const source = input();
  source.traces.push({ ...structuredClone(source.traces[0]), traceId: 'trace-2', query: 'Can I get a refund?' });
  const draft = createFeedbackRegressionDraft(source);
  const oneReviewed = reviewFeedbackRegressionCase(draft, draft.cases[0].id, annotation(), review);
  assert.throws(() => exportReviewedRegressionDataset(oneReviewed), /review/i);
  const complete = reviewFeedbackRegressionCase(oneReviewed, draft.cases[1].id, annotation(), review);
  for (const mutate of [
    d => { d.cases[0].query = 'Different question'; },
    d => { d.cases[0].annotation.expectedAnswer.requiredFacts = [['60 days']]; },
    d => { d.corpus[0].content = 'changed'; },
    d => { d.snapshotVersion = 'different'; },
    d => { d.cases[0].scope.corpusId = 'foreign'; },
    d => { d.cases[0].feedback.comment = 'different'; },
    d => { d.cases[0].observedAnswer = 'different'; },
    d => { d.cases[0].review.reviewer = 'different'; },
  ]) {
    const edited = structuredClone(complete); mutate(edited);
    assert.throws(() => exportReviewedRegressionDataset(edited));
  }
});

test('reject incomplete exports, stale snapshots, conflicting duplicate trace IDs and unknown evidence', () => {
  for (const mutate of [
    x => { x.traces[0].snapshotVersion = 'old'; },
    x => { x.traces[0].snapshotId = 'other'; },
    x => { delete x.traces[0].feedback; },
    x => { x.traces[0].feedback.value = Number.NaN; },
    x => { x.traces[0].evidenceIds = ['unknown']; },
    x => { x.traces[0].evidenceIds = ['e1', 'e1']; },
    x => { x.traces[0].scope.corpusId = 'foreign'; },
    x => { delete x.corpus[0].documentVersion; },
    x => { x.traces = []; },
    x => { x.traces.push({ ...structuredClone(x.traces[0]), query: 'conflict' }); },
  ]) { const source = input(); mutate(source); assert.throws(() => createFeedbackRegressionDraft(source)); }
});

test('review rejects incomplete gold, unsupported evidence, unknown case and missing audit identity', () => {
  const draft = createFeedbackRegressionDraft(input());
  for (const change of [
    a => { a.goldEvidence = []; },
    a => { a.goldEvidence[0].evidenceId = 'unknown'; },
    a => { a.goldEvidence[0].spans = []; },
    a => { a.expectedAnswer.referenceAnswer = ''; },
    a => { a.expectedAnswer.requiredFacts = []; },
    a => { a.disposition = 'unknown'; },
    a => { delete a.allowedPolicies; },
    a => { delete a.allowedLanes; },
    a => { delete a.securityExpectations; },
  ]) { const a = annotation(); change(a); assert.throws(() => reviewFeedbackRegressionCase(draft, draft.cases[0].id, a, review)); }
  assert.throws(() => reviewFeedbackRegressionCase(draft, 'unknown', annotation(), review));
  assert.throws(() => reviewFeedbackRegressionCase(draft, draft.cases[0].id, annotation(), { ...review, reviewer: '' }));
  assert.throws(() => reviewFeedbackRegressionCase(draft, draft.cases[0].id, annotation(), { ...review, reviewedAt: 'not-date' }));
  assert.throws(() => reviewFeedbackRegressionCase(draft, draft.cases[0].id,
    { disposition: 'abstain', goldEvidence: [], reason: '' }, review));
});

test('multi-document snapshots above the small contract budget retain full review and export binding', () => {
  const source = input();
  source.corpus[0].content += ' supporting context'.repeat(20000);
  source.corpus.push({ ...structuredClone(source.corpus[0]), evidenceId: 'e2', documentId: 'd2',
    source: 'second-policy.txt', content: 'Second refund policy. ' + 'second document context'.repeat(20000) });
  source.traces.push({ ...structuredClone(source.traces[0]), traceId: 'trace-2',
    query: 'What is the second refund policy?', evidenceIds: ['e2'] });
  const draft = createFeedbackRegressionDraft(source);
  assert.ok(Buffer.byteLength(serializeFeedbackRegressionDraft(draft)) > 256 * 1024);
  const first = reviewFeedbackRegressionCase(draft, draft.cases[0].id, annotation(), review);
  const secondAnnotation = { ...annotation(), goldEvidence: [{ evidenceId: 'e2', relevance: 3,
    spans: [{ startOffset: 0, endOffset: 21 }] }],
    expectedAnswer: { referenceAnswer: 'Second refund policy.', requiredFacts: [['Second refund policy']] } };
  const both = reviewFeedbackRegressionCase(first, draft.cases[1].id, secondAnnotation, review);
  const exported = exportReviewedRegressionDataset(both);
  assert.equal(exported.cases.length, 2);
  assert.equal(exported.corpus[1].content, source.corpus[1].content);
  assert.match(exported.regressionProvenance.draftSha256, /^[a-f0-9]{64}$/);
  both.corpus[1].content += ' changed after review';
  assert.throws(() => exportReviewedRegressionDataset(both), /stale/);
});
