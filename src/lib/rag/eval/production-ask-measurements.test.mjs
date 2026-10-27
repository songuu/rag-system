import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
  throw e;
} } });
const subject = await import('./production-ask-dataset-binding.ts');
const { canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { runRagEval } = await import('./runner.ts');
const { summarizeEvalCaseResults } = await import('./metrics.ts');
const { fixture, bindDataset } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const clone = x => structuredClone(x);
const create = f => subject.createReferenceProductionAskMeasurementEvaluator(f.options, f.rawDatasetJson);
function payload(f, arm = { rolloutMode: 'off', phase: 'trial', ordinal: 0 }) {
  const bindingHash = subject.createReferenceProductionAskDatasetBinding(f.options, f.rawDatasetJson).bindingProof.bindingHash;
  return { schemaVersion: 'kg-reference-ask-results/v1', bindingHash, entries: f.dataset.cases.map((c, i) => {
    const e = clone(f.dataset.corpus[0]); delete e.metadata;
    return { request: { caseId: c.id, ...arm }, result: { answer: i === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '', abstained: i !== 0,
      evidence: i === 0 ? [{ ...e, score: 1, laneId: 'dense' }] : [], citations: i === 0 ? [{ evidenceId: e.evidenceId, startOffset: 0, endOffset: 7 }] : [],
      policyId: 'strict-grounding', laneIds: ['dense'], usage: { retrievalLatencyMs: 1, generationLatencyMs: 2, totalLatencyMs: 3,
        tokenMeasurement: 'unavailable', costMeasurement: 'unavailable', embeddingCalls: 1, generationCalls: 1 } } };
  }) };
}
async function original(f, p) { let i = 0; return runRagEval(f.normalizedDataset, { id: 'measurement-oracle', async run() { return p.entries[i++].result; } }, { topK: f.options.manifest.base.parameters.topK }); }
const evaluate = (f, p = payload(f)) => create(f).evaluateReferenceMeasurements(JSON.stringify(p));
function frozen(x) { if (x && typeof x === 'object') { assert.ok(Object.isFrozen(x)); Object.values(x).forEach(frozen); } }
function fold(x) {
  if (x.status === 'failed') return { caseId: 'private-placeholder', status: 'failed', error: 'static-failure' };
  const usage = Object.fromEntries(Object.entries(x.usage).filter(([, v]) => v !== null));
  return { ...x, caseId: 'private-placeholder', usage, answer: '', evidence: [], citationDetails: [] };
}

test('existing original oracle provides two complete scores before measurement factory exists', async () => {
  const f = fixture(), report = await original(f, payload(f)); assert.equal(report.cases.length, 2); assert.equal(report.summary.failedCases, 0);
});

test('new measured population preserves the legacy evaluator surface proof and canonical hash exactly', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage), p = payload(f), legacy = subject.createReferenceProductionAskEvaluator(f.options, f.rawDatasetJson);
    assert.deepEqual(Object.keys(legacy), ['executionProfile', 'productionCapable', 'bindingProof', 'evaluateReferenceResults']);
    const oldProof = await legacy.evaluateReferenceResults(JSON.stringify(p)), proof = await evaluate(f, p);
    assert.deepEqual(proof.evaluation, oldProof); const { proofHash, ...core } = oldProof; assert.equal(proofHash, hash(core));
    assert.equal(proof.schemaVersion, 'kg-reference-ask-measurements/v1'); assert.equal(proof.machineGateComputed, false);
    for (const field of ['productionAuthorized', 'stageAcceptanceComplete', 'executionAuthorized', 'registryAuthenticated', 'networkEnforced']) assert.equal(proof[field], false);
  }
});

test('every scored field and usage value corresponds to the actual original runner in full roster order', async () => {
  const f = fixture(), p = payload(f); p.entries[1].result.usage.totalLatencyMs = 97;
  const report = await original(f, p), proof = await evaluate(f, p); assert.equal(proof.caseMeasurements.length, 2);
  for (const [i, m] of proof.caseMeasurements.entries()) {
    const r = report.cases[i]; assert.equal(m.caseIndex, i); assert.equal(m.status, r.status);
    for (const field of ['retrieval', 'citations', 'security', 'answerMetrics', 'expectedAbstain', 'abstained']) assert.deepEqual(m[field], r[field]);
    for (const [key, value] of Object.entries(r.usage)) assert.equal(m.usage[key], value);
  }
  assert.deepEqual(summarizeEvalCaseResults(proof.caseMeasurements.map(fold)), report.summary);
});

test('missing optional tokens partial counters and cost remain null while observed zero is retained', async () => {
  const f = fixture(), p = payload(f);
  Object.assign(p.entries[0].result.usage, { tokenMeasurement: 'provider', inputTokens: 10, outputTokens: 0, costMeasurement: 'provider', costUsd: 0 });
  const proof = await evaluate(f, p), [a, b] = proof.caseMeasurements;
  assert.equal(a.usage.inputTokens, 10); assert.equal(a.usage.outputTokens, 0); assert.equal(a.usage.costUsd, 0);
  for (const key of ['inputTokens', 'outputTokens', 'partialInputTokens', 'partialOutputTokens', 'costUsd']) assert.equal(b.usage[key], null);
  assert.equal(b.retrieval.recallAtK, null); assert.equal(b.citations.coverage, null); assert.equal(b.answerMetrics.requiredFactCoverage, null);
  assert.deepEqual(summarizeEvalCaseResults(proof.caseMeasurements.map(fold)), proof.evaluation.summary);
});

test('actual partial token counts never become fabricated complete token measurements', async () => {
  const f = fixture(), p = payload(f);
  Object.assign(p.entries[0].result.usage, { tokenMeasurement: 'partial', partialInputTokens: 4, partialOutputTokens: 0 });
  const proof = await evaluate(f, p), usage = proof.caseMeasurements[0].usage;
  assert.equal(usage.tokenMeasurement, 'partial'); assert.equal(usage.partialInputTokens, 4); assert.equal(usage.partialOutputTokens, 0);
  assert.equal(usage.inputTokens, null); assert.equal(usage.outputTokens, null); assert.equal(proof.evaluation.summary.tokens.inputTotal, null);
  assert.deepEqual(summarizeEvalCaseResults(proof.caseMeasurements.map(fold)), proof.evaluation.summary);
});

test('original failed provenance becomes one static failed record with no unsafe runner error payload', async () => {
  const f = fixture(), p = payload(f); p.entries[0].result.evidence[0].content = 'RAW_SECRET_BAD_PROVENANCE';
  const proof = await evaluate(f, p); assert.deepEqual(proof.caseMeasurements[0], { caseIndex: 0, status: 'failed', failureCode: 'runner-case-failed' });
  assert.equal(proof.evaluation.summary.failedCases, 1); assert.equal(JSON.stringify(proof).includes('RAW_SECRET'), false);
});

test('actual security canaries remain individual nonzero measurements and are not coerced into a passing gate', async () => {
  const f = fixture(), p = payload(f), foreign = clone(f.dataset.corpus[2]); delete foreign.metadata;
  p.entries[0].result.evidence = [{ ...foreign, score: 1, laneId: 'dense' }]; p.entries[0].result.citations = [];
  p.entries[0].result.answer = 'RAW_SECURITY_PATTERN_CANARY';
  const proof = await evaluate(f, p); assert.equal(proof.caseMeasurements[0].security.crossTenantHits, 1);
  assert.equal(proof.caseMeasurements[0].security.forbiddenEvidenceHits, 1); assert.equal(proof.caseMeasurements[0].security.forbiddenAnswerPatternHits, 1);
  assert.equal(proof.machineGateComputed, false); assert.equal(JSON.stringify(proof).includes('RAW_SECURITY'), false);
});

test('complete trial population recomputes original P95 rather than averaging arm or trial P95', async () => {
  const f = fixture(), e = create(f), left = payload(f), right = payload(f, { rolloutMode: 'off', phase: 'trial', ordinal: 1 });
  left.entries[1].result.usage.totalLatencyMs = 100; right.entries.forEach(v => { v.result.usage.totalLatencyMs = 10; });
  const [a, b] = await Promise.all([e.evaluateReferenceMeasurements(JSON.stringify(left)), e.evaluateReferenceMeasurements(JSON.stringify(right))]);
  const full = summarizeEvalCaseResults([...a.caseMeasurements, ...b.caseMeasurements].map(fold));
  assert.equal(full.latencyMs.p95, 100); assert.notEqual(full.latencyMs.p95, (a.evaluation.summary.latencyMs.p95 + b.evaluation.summary.latencyMs.p95) / 2);
  assert.equal(a.evaluation.arm.ordinal, 0); assert.equal(b.evaluation.arm.ordinal, 1);
});

test('warmup and active concurrent populations keep separate original arm phase and complete observations', async () => {
  const f = fixture('T17'), e = create(f), warm = payload(f, { rolloutMode: 'off', phase: 'warmup', ordinal: 0 }), active = payload(f, { rolloutMode: 'active', phase: 'trial', ordinal: 0 });
  warm.entries.forEach(v => { v.result.usage.totalLatencyMs = 1; }); active.entries.forEach(v => { v.result.usage.totalLatencyMs = 200; });
  const [a, b] = await Promise.all([e.evaluateReferenceMeasurements(JSON.stringify(warm)), e.evaluateReferenceMeasurements(JSON.stringify(active))]);
  assert.equal(a.evaluation.arm.phase, 'warmup'); assert.equal(b.evaluation.arm.phase, 'trial'); assert.equal(b.evaluation.arm.rolloutMode, 'active');
  assert.equal(a.caseMeasurements[0].usage.totalLatencyMs, 1); assert.equal(b.caseMeasurements[0].usage.totalLatencyMs, 200);
});

test('the full approved 1000-case population exceeds control JSON budget without truncation or hash alias', async () => {
  const f = fixture(), data = clone(f.dataset), template = data.cases[1];
  data.cases = Array.from({ length: 1000 }, (_, i) => ({ ...clone(i === 0 ? data.cases[0] : template), id: (i + 1).toString(16).padStart(32, '0') }));
  bindDataset(f, data, { updateRoster: true }); const proof = await evaluate(f);
  assert.equal(proof.caseMeasurements.length, 1000); assert.equal(proof.caseMeasurements[999].caseIndex, 999); assert.ok(Buffer.byteLength(JSON.stringify(proof)) > 256 * 1024);
  const hashes = proof.caseMeasurements.map(hash), root = createHash('sha256').update('kg-reference-ask-case-measurements/v1').update('\0').update(proof.evaluation.bindingHash).update('\0').update('1000').update('\0');
  hashes.forEach(h => root.update(h)); assert.equal(proof.measurementsRootSha256, root.digest('hex'));
});

test('primitive results and exact config remain the only input and all public measurements are deeply immutable', async () => {
  const f = fixture(), e = create(f), raw = JSON.stringify(payload(f)); let hooks = 0;
  const trap = () => { hooks++; throw Error('RAW_SECRET'); }, carrier = { get value() { return trap(); }, toJSON: trap };
  for (const value of [carrier, new Proxy({}, { get: trap, ownKeys: trap }), new String(raw), null, 3]) await assert.rejects(e.evaluateReferenceMeasurements(value), x => x.code === 'invalid-results');
  await assert.rejects(e.evaluateReferenceMeasurements(raw, trap), x => x.code === 'invalid-results'); assert.equal(hooks, 0);
  const proof = await e.evaluateReferenceMeasurements(raw); frozen(proof);
  assert.equal(/RAW_|fixture:|"answer":|"evidence":|"caseId":|"tags":|"traceId":|"trajectory":|"error":/.test(JSON.stringify(proof)), false);
  assert.throws(() => { proof.caseMeasurements[0].usage.totalLatencyMs = 0; }, TypeError);
});

test('new measurement enums reject arbitrary JSON without changing legacy acceptance or leaking the rejected payload', async () => {
  const f = fixture(), e = create(f), legacy = subject.createReferenceProductionAskEvaluator(f.options, f.rawDatasetJson);
  for (const field of ['tokenMeasurement', 'costMeasurement']) for (const value of ['RAW_PRIVATE_ENUM_CANARY', { answer: 'RAW_PRIVATE_ENUM_CANARY' }, ['RAW_PRIVATE_ENUM_CANARY'], null, 7, true]) {
    const p = payload(f); p.entries[0].result.usage[field] = value; const raw = JSON.stringify(p);
    assert.equal((await legacy.evaluateReferenceResults(raw)).summary.completedCases, 2);
    await assert.rejects(e.evaluateReferenceMeasurements(raw), error => error instanceof subject.ProductionAskReferenceEvaluationError
      && error.code === 'evaluation-failed' && error.productionAuthorized === false && error.automaticRetryAllowed === false
      && Object.isFrozen(error) && !Object.hasOwn(error, 'cause') && !/RAW_|CANARY|answer/.test(error.message));
  }
});
