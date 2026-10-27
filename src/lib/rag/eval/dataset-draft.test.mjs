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
const { validateDatasetDraft, updateDraftCase, reviewDraftCase, serializeDatasetDraft } = await import('./dataset-draft.ts');
const { parseRagEvalDataset } = await import('./dataset.ts');
function draft() { return {
  schemaVersion: 'rag-eval-dataset/v1', datasetId: '历史资料', datasetVersion: '1',
  corpus: [{ evidenceId: 'e1', documentId: 'd1', source: '资料.txt', content: '印刷术推动了知识传播。' }],
  cases: [{ id: 'q1', query: '印刷术有何影响？', tags: ['ai-generated', 'needs-review'], expectedAbstain: false,
    goldEvidence: [{ evidenceId: 'e1', relevance: 3, spans: [{ startOffset: 0, endOffset: 10 }] }],
    expectedAnswer: { referenceAnswer: '印刷术推动了知识传播。', requiredFacts: [['知识传播', '知识的传播']] },
  }],
}; }

test('review and editing are immutable; edits invalidate prior review and preserve source annotations', () => {
  const original = draft();
  const reviewed = reviewDraftCase(original, 'q1');
  assert.deepEqual(original.cases[0].tags, ['ai-generated', 'needs-review']);
  assert.deepEqual(reviewed.cases[0].tags, ['ai-generated', 'human-reviewed']);
  const edited = updateDraftCase(reviewed, 'q1', { query: '如何推动知识传播？', tags: ['human-reviewed'] });
  assert.deepEqual(edited.cases[0].tags, ['ai-generated', 'needs-review']);
  assert.equal(edited.cases[0].id, 'q1');
  assert.equal(reviewed.cases[0].query, original.cases[0].query);
  assert.deepEqual(edited.cases[0].goldEvidence, original.cases[0].goldEvidence);
});

test('download is valid for existing parser and retains reference answer, review tags and exact spans', () => {
  const reviewed = reviewDraftCase(draft(), 'q1');
  const exported = JSON.parse(serializeDatasetDraft(reviewed));
  assert.deepEqual(parseRagEvalDataset(exported), reviewed);
});

test('incomplete edits and broken evidence cannot be reviewed or exported', () => {
  for (const mutate of [
    d => { d.cases[0].query = ''; },
    d => { d.cases[0].expectedAnswer.requiredFacts = [[]]; },
    d => { d.cases[0].expectedAnswer.referenceAnswer = ' '; },
    d => { d.cases[0].goldEvidence[0].spans[0].endOffset = 1000; },
    d => { d.cases[0].goldEvidence[0].evidenceId = 'unknown'; },
    d => { d.cases[0].goldEvidence[0].relevance = 0; },
    d => { d.cases.push(structuredClone(d.cases[0])); },
    d => { d.cases = []; },
  ]) {
    const invalid = draft(); mutate(invalid);
    assert.ok(validateDatasetDraft(invalid).length > 0);
    assert.throws(() => serializeDatasetDraft(invalid));
  }
  const invalid = draft(); invalid.cases[0].query = '';
  assert.throws(() => reviewDraftCase(invalid, 'q1'));
  assert.match(validateDatasetDraft(invalid)[0], /第 1 题.*请填写问题/);
  assert.doesNotMatch(validateDatasetDraft(invalid)[0], /\$\.cases|rag-eval dataset/);
  const secondInvalid = draft();
  secondInvalid.cases.push({ ...structuredClone(secondInvalid.cases[0]), id: 'q2', query: '' });
  assert.throws(() => reviewDraftCase(secondInvalid, 'q2'), /第 2 题.*请填写问题/);
});
