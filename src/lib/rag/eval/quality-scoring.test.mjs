import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });

const { evaluateStructuredFacts, evaluateBusinessApplicability, evaluateSemanticQuality,
  parseQualitySidecar, calibrateSemanticJudge, assessRagEvalCase } = await import('./quality-scoring.ts');

const amount = { id: 'refund', kind: 'amount', label: '退款金额', expected: 100, unit: '元' };
const semanticInput = { caseId: 'q1', question: '退款金额是多少？', answer: '退款金额100元 [e1]',
  evidence: [{ evidenceId: 'e1', content: '退款金额为100元。' }], citations: [{ evidenceId: 'e1' }],
  referenceAnswer: '退款金额100元。', requiredFacts: [['100元']] };
const verdict = () => ({ scores: { factualCorrectness: 1, relevance: 1, keyPointCoverage: 1,
  citationEntailment: 1, faithfulness: 1, businessCorrectness: 1 },
  claims: [{ claim: '退款金额100元', evidenceIds: ['e1'], supported: true }] });

test('structured amounts use complete numbers, explicit units and normalized full-width text', () => {
  assert.equal(evaluateStructuredFacts('退款金额：１００元。', [amount])[0].status, 'correct');
  assert.equal(evaluateStructuredFacts('退款金额为1000元。', [amount])[0].status, 'incorrect');
  assert.equal(evaluateStructuredFacts('退款金额为100美元。', [amount])[0].status, 'incorrect');
  assert.equal(evaluateStructuredFacts('退款金额为100。', [amount])[0].status, 'unknown');
});

test('negated and contradictory facts cannot pass through substring matches', () => {
  assert.equal(evaluateStructuredFacts('退款金额不是100元，而是200元。', [amount])[0].status, 'incorrect');
  assert.equal(evaluateStructuredFacts('退款金额100元。退款金额200元。', [amount])[0].status, 'incorrect');
  assert.equal(evaluateStructuredFacts('退款金额100元，退款金额200元。', [amount])[0].status, 'incorrect');
  assert.equal(evaluateStructuredFacts('退款金额可能为100元。', [amount])[0].status, 'unknown');
  assert.equal(evaluateStructuredFacts('其他金额100元。', [amount])[0].status, 'unknown');
});

test('bounds, conditions and subjectless corrections never prove an exact fact', () => {
  for (const answer of ['退款金额至少100元。','退款金额不少于100元。','退款金额至多100元。','退款金额超过100元。',
    '退款金额100元，不是100元。','退款金额100元，但实际上是200元。','退款金额100元到200元。']) {
    assert.notEqual(evaluateStructuredFacts(answer,[amount])[0].status,'correct',answer);
  }
});

test('dates validate the calendar and statuses use complete literal values', () => {
  const date = { id: 'date', kind: 'date', label: '生效日期', expected: '2024-02-29' };
  assert.equal(evaluateStructuredFacts('生效日期：2024年2月29日。', [date])[0].status, 'correct');
  assert.equal(evaluateStructuredFacts('生效日期：2024-02-28。', [date])[0].status, 'incorrect');
  assert.notEqual(evaluateStructuredFacts('生效日期：2024-02-290。', [date])[0].status, 'correct');
  assert.equal(evaluateStructuredFacts('生效日期未知。', [date])[0].status, 'unknown');
  assert.throws(() => evaluateStructuredFacts('生效日期2023-02-29', [{ ...date, expected: '2023-02-29' }]), /date/);
  const status = { id: 'status', kind: 'status', label: '订单状态', expected: '已完成', aliases: ['完成'] };
  assert.equal(evaluateStructuredFacts('订单状态：完成。', [status])[0].status, 'correct');
  assert.equal(evaluateStructuredFacts('订单状态：未完成。', [status])[0].status, 'incorrect');
  assert.equal(evaluateStructuredFacts('订单状态不是已完成。', [status])[0].status, 'incorrect');
});

test('numeric tolerance is explicit and unrelated clauses cannot supply a value', () => {
  const check = { ...amount, expected: 100.01, tolerance: 0.02 };
  assert.equal(evaluateStructuredFacts('退款金额100元。联系电话123456。', [check])[0].status, 'correct');
  assert.equal(evaluateStructuredFacts('退款金额100元，联系电话123456。', [check])[0].status, 'unknown');
  assert.equal(evaluateStructuredFacts('退款金额不明，其他金额100元。', [check])[0].status, 'unknown');
  assert.throws(() => evaluateStructuredFacts('退款金额100元', [{ ...check, tolerance: -1 }]), /tolerance/);
});

test('business applicability keeps missing conditions unknown and detects expired or inapplicable documents', () => {
  const policy = { validFrom: '2026-01-01', validUntil: '2026-12-31', attributes: { region: ['CN'] } };
  assert.equal(evaluateBusinessApplicability({}, policy).status, 'unknown');
  assert.equal(evaluateBusinessApplicability({ asOf: '2026-06-01', userAttributes: { region: 'CN' } }, policy).status, 'applicable');
  assert.equal(evaluateBusinessApplicability({ asOf: '2027-01-01', userAttributes: { region: 'CN' } }, policy).status, 'inapplicable');
  assert.equal(evaluateBusinessApplicability({ asOf: '2026-06-01', userAttributes: { region: 'US' } }, policy).status, 'inapplicable');
  assert.equal(evaluateBusinessApplicability({ asOf: '2026-06-01', userAttributes: {} }, policy).status, 'unknown');
  assert.equal(evaluateBusinessApplicability({ asOf: '2026-06-01' }).status, 'unknown');
});

test('semantic scoring requires a judge and separately gates business truth', async () => {
  const unmeasured = await evaluateSemanticQuality(semanticInput);
  assert.equal(unmeasured.status, 'unavailable');
  assert.ok(Object.values(unmeasured.scores).every(value => value === null));
  const measured = await evaluateSemanticQuality(semanticInput, async () => verdict());
  assert.equal(measured.scores.factualCorrectness, 1);
  assert.equal(measured.scores.businessCorrectness, null);
  const business = await evaluateSemanticQuality({ ...semanticInput, businessReferenceAnswer: '退款金额100元。',
    applicability: { status: 'applicable', reasons: [] } }, async () => verdict());
  assert.equal(business.scores.businessCorrectness, 1);
});

test('semantic verdict rejects unknown evidence, impossible scores and unsupported positive entailment', async () => {
  await assert.rejects(evaluateSemanticQuality(semanticInput, async () => ({ ...verdict(),
    claims: [{ claim: 'claim', evidenceIds: ['foreign'], supported: true }] })), /evidence/);
  await assert.rejects(evaluateSemanticQuality(semanticInput, async () => ({ ...verdict(), scores: { relevance: 2 } })), /score/);
  await assert.rejects(evaluateSemanticQuality(semanticInput, async () => ({ ...verdict(), claims: [] })), /claim/);
  await assert.rejects(evaluateSemanticQuality({ ...semanticInput, citations: [] }, async () => verdict()), /citat/);
  await assert.rejects(evaluateSemanticQuality(semanticInput, async () => ({ ...verdict(),
    claims: [{ claim: 'unsupported', evidenceIds: [], supported: false }] })), /contradicts/);
});

test('missing semantic dimensions and missing external truth stay unmeasured', async () => {
  const partial = await evaluateSemanticQuality({ ...semanticInput, referenceAnswer: undefined, requiredFacts: undefined },
    async () => ({ scores: { factualCorrectness: 1, relevance: 0.8 }, claims: [] }));
  assert.equal(partial.scores.factualCorrectness, null);
  assert.equal(partial.scores.relevance, 0.8);
  assert.equal(partial.scores.faithfulness, null);
  assert.equal((await evaluateSemanticQuality(semanticInput, async () => ({ scores: {}, claims: [] }))).status, 'unavailable');
});

test('judge input is detached so mutation cannot change frozen evidence or labels', async () => {
  const input = structuredClone(semanticInput);
  await evaluateSemanticQuality(input, async data => {
    assert.throws(() => { data.evidence[0].content = 'tampered'; }, TypeError);
    return verdict();
  });
  assert.equal(input.evidence[0].content, semanticInput.evidence[0].content);
});

test('quality sidecar binds annotations to one dataset and rejects malformed or foreign cases', () => {
  const digest = 'a'.repeat(64);
  const sidecar = { schemaVersion: 'rag-eval-quality/v1', datasetSha256: digest,
    cases: { q1: { facts: [amount], expectedDisposition: 'answer' } } };
  assert.equal(parseQualitySidecar(sidecar, { datasetSha256: digest, caseIds: ['q1'] }).cases.q1.facts[0].expected, 100);
  assert.throws(() => parseQualitySidecar(sidecar, { datasetSha256: 'b'.repeat(64), caseIds: ['q1'] }), /dataset/);
  assert.throws(() => parseQualitySidecar(sidecar, { datasetSha256: digest, caseIds: ['q2'] }), /case/);
  assert.throws(() => parseQualitySidecar({ ...sidecar, cases: { q1: { facts: [{ ...amount, expected: NaN }] } } },
    { datasetSha256: digest, caseIds: ['q1'] }), /expected/);
  assert.throws(() => parseQualitySidecar({ ...sidecar, cases: JSON.parse('{"__proto__":{}}') },
    { datasetSha256: digest, caseIds: ['__proto__'] }), /unsafe/);
  assert.throws(() => parseQualitySidecar({ ...sidecar, cases: Object.create({ q1: {} }) },
    { datasetSha256: digest, caseIds: ['q1'] }), /unsafe/);
});

test('calibration measures paired annotations only and prevents holdout leakage', () => {
  const options = { calibrationCaseIds: ['a', 'b'], evaluationCaseIds: ['holdout'], tolerance: 0.1,
    judgeScores: [{ caseId: 'a', dimension: 'relevance', score: 0.7 }, { caseId: 'b', dimension: 'relevance', score: 1 }],
    humanScores: [{ caseId: 'a', dimension: 'relevance', score: 0.9 }, { caseId: 'b', dimension: 'relevance', score: 1 }] };
  const result = calibrateSemanticJudge(options);
  assert.ok(Math.abs(result.meanAbsoluteError - 0.1) < 1e-10);
  assert.equal(result.agreementWithinTolerance, 0.5);
  assert.equal(result.coverage, 1);
  assert.throws(() => calibrateSemanticJudge({ ...options, evaluationCaseIds: ['b'] }), /overlap/);
  assert.throws(() => calibrateSemanticJudge({ ...options, humanScores: [...options.humanScores, options.humanScores[0]] }), /duplicate/);
});

test('assessment keeps abstain and clarify distinct and combines rule and semantic checks', async () => {
  const sample = { id: 'q1', query: semanticInput.question, expectedAnswer: { requiredFacts: [['100元']] } };
  const result = { answer: semanticInput.answer, abstained: false, disposition: 'answer', evidence: semanticInput.evidence, citations: semanticInput.citations };
  const quality = await assessRagEvalCase(sample, result, { facts: [amount], expectedDisposition: 'answer' });
  assert.equal(quality.structuredFacts[0].status, 'correct');
  assert.equal(quality.disposition.correct, true);
  const clarification = await assessRagEvalCase(sample, { ...result, disposition: 'abstain', abstained: true }, { expectedDisposition: 'clarify' });
  assert.equal(clarification.disposition.correct, false);
  const missing = await assessRagEvalCase(sample, { ...result, disposition: undefined }, { expectedDisposition: 'answer' });
  assert.equal(missing.disposition.correct, null);
  assert.equal(missing.disposition.observed, 'unknown');
});
test('optional judge categorization can expose wrong refusal without pretending it is a structured runtime decision',async()=>{
  const sample={id:'q1',query:'退款金额？',expectedAbstain:false,expectedAnswer:{requiredFacts:[['100元']]}};
  const result={answer:'我无法回答。',abstained:false,evidence:[],citations:[]};
  const quality=await assessRagEvalCase(sample,result,{}, {judge:async()=>({scores:{relevance:0},claims:[],observedDisposition:'abstain'})});
  assert.equal(quality.disposition.expected,'answer');assert.equal(quality.disposition.correct,false);
  assert.equal(quality.disposition.source,'judge');
  await assert.rejects(evaluateSemanticQuality(semanticInput,async()=>({scores:{},claims:[],observedDisposition:'unknown-value'})),/disposition/);
});
