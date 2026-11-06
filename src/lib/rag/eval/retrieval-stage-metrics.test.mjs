import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s,c,next) { try { return next(s,c); } catch(e) { if(e.code==='ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s+'.ts',c); throw e; } } });
const { evaluateRetrievalStages } = await import('./retrieval-stage-metrics.ts');
const gold = [{ evidenceId: 'a', relevance: 3 }, { evidenceId: 'b', relevance: 2 }];
test('measures candidate, rerank and delivered context independently', () => {
  const result = evaluateRetrievalStages(gold, { candidates: ['noise','a','b'], reranked: ['a','b','noise'], context: ['a'] }, 2, [['a'],['b']]);
  assert.equal(result.candidates.recallAtK, 0.5);
  assert.equal(result.reranked.recallAtK, 1);
  assert.equal(result.context.recallAtK, 0.5);
  assert.equal(result.reranked.requiredEvidenceComplete, true);
  assert.equal(result.context.requiredEvidenceComplete, false);
});
test('missing snapshots and unannotated necessary evidence remain unknown', () => {
  const result = evaluateRetrievalStages(gold, { context: ['a','b'] }, 2);
  assert.equal(result.candidates, null); assert.equal(result.reranked, null);
  assert.equal(result.context.requiredEvidenceComplete, null);
});
test('evidence groups permit alternate sources without treating every relevant passage as necessary', () => {
  const result = evaluateRetrievalStages(gold, { context: ['alternative','b'] }, 2, [['a','alternative'],['b']]);
  assert.equal(result.context.requiredEvidenceComplete, true);
  assert.throws(() => evaluateRetrievalStages(gold, { context: ['a','a'] }, 2), /duplicate/i);
  assert.throws(() => evaluateRetrievalStages(gold, {}, 0), /topK/i);
});
test('context completeness uses delivered text, not just an ID or a topK cutoff',()=>{
  const labelled=[{evidenceId:'a',relevance:3,spans:[{startOffset:100,endOffset:120}]}];
  const result=evaluateRetrievalStages(labelled,{context:['a']},1,[['a']],[{evidenceId:'a',servedSpan:{startOffset:0,endOffset:20}}]);
  assert.equal(result.context.requiredEvidenceComplete,false);
  const all=evaluateRetrievalStages(gold,{context:['noise','a','b']},1,[['a'],['b']]);
  assert.equal(all.context.requiredEvidenceComplete,true);
});
