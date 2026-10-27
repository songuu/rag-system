import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { resolvePartialComparisonAnswer } = await import('./partial-comparison-answer.ts');
const question = '黑死病对西欧和东欧的社会变化有什么不同影响？';
const evidence = [{ content: '疫情造成欧洲人口锐减，劳动力短缺提高了幸存农民和工人的议价能力。' }, { content: '契丹早期史料。' }];
function input(selection, overrides = {}) {
  return { question, evidence, selectEvidence: async () => selection,
    generateAnswer: async () => { throw new Error('unsupported comparison must not be generated'); }, ...overrides };
}
test('partial comparison coverage quotes only selected sources and preserves their scope', async () => {
  const answer = await resolvePartialComparisonAnswer(input({ coverage: 'partial', evidenceNumbers: [1] }));
  assert.match(answer, /^现有材料无法支持完整比较/);
  assert.ok(answer.includes(evidence[0].content));
  assert.match(answer, /有依据的事实/);
  assert.match(answer, /无法确认的部分/);
  assert.match(answer, /\[1\]/);
  assert.doesNotMatch(answer, /西欧：|契丹|\[2\]/);
});
test('ordinary questions bypass comparison assessment and complete coverage uses normal generation', async () => {
  const generateAnswer = async () => 'supported answer [1]';
  assert.equal(await resolvePartialComparisonAnswer(input(null, { question: '黑死病有哪些影响？',
    selectEvidence: async () => { throw new Error('not a comparison'); }, generateAnswer })), 'supported answer [1]');
  assert.equal(await resolvePartialComparisonAnswer(input({ coverage: 'complete', evidenceNumbers: [1, 2] }, { generateAnswer })), 'supported answer [1]');
});
test('three candidates with no relevant coverage remain a refusal', async () => {
  const answer = await resolvePartialComparisonAnswer(input({ coverage: 'none', evidenceNumbers: [] }));
  assert.match(answer, /缺少.*资料/);
  assert.ok(!answer.includes(evidence[0].content));
});
test('invalid, missing and contradictory coverage decisions fail explicitly', async () => {
  for (const selection of [null, { coverage: 'partial', evidenceNumbers: [99] },
    { coverage: 'partial', evidenceNumbers: [] }, { coverage: 'complete', evidenceNumbers: ['1'] },
    { coverage: 'none', evidenceNumbers: [1] }, { coverage: 'guessed', evidenceNumbers: [1] }]) {
    await assert.rejects(resolvePartialComparisonAnswer(input(selection)), /invalid/);
  }
});
test('excerpts are bounded and source-internal numbered markers do not create citations', async () => {
  const answer = await resolvePartialComparisonAnswer(input({ coverage: 'partial', evidenceNumbers: [1] }, {
    evidence: [{ content: 'Europe [2] ' + '事实'.repeat(1000) }],
  }));
  assert.ok(answer.length < 700);
  assert.match(answer, /［2］/);
  assert.doesNotMatch(answer, /\[2\]/);
});
test('source selection errors cannot fall back to unverified generation', async () => {
  await assert.rejects(resolvePartialComparisonAnswer(input(null, {
    selectEvidence: async () => { throw new Error('selection unavailable'); },
  })), /selection unavailable/);
});

test('near-zero bounded rerank candidates cannot enter coverage assessment or the answer', async () => {
  const scored = [{ ...evidence[0], rerankScore: 0.944 }, { ...evidence[1], rerankScore: 0.0001 }];
  const answer = await resolvePartialComparisonAnswer(input(null, { evidence: scored,
    selectEvidence: async allowed => { assert.deepEqual(allowed, [1]); return { coverage: 'partial', evidenceNumbers: [1] }; },
  }));
  assert.ok(!answer.includes(evidence[1].content));
  await assert.rejects(resolvePartialComparisonAnswer(input({ coverage: 'partial', evidenceNumbers: [2] }, { evidence: scored })), /invalid/);
});

test('out-of-range raw scores are not subjected to the bounded relevance floor', async () => {
  await resolvePartialComparisonAnswer(input(null, { evidence: [{ content: 'raw score fact', rerankScore: -4 }],
    selectEvidence: async allowed => { assert.deepEqual(allowed, [1]); return { coverage: 'partial', evidenceNumbers: [1] }; },
  }));
});
