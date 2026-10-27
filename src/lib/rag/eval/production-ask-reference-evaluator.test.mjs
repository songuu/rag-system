import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const subject = await import('./production-ask-dataset-binding.ts');
const { canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { runRagEval } = await import('./runner.ts');
const { fixture, bindDataset, rebindExecution } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const bind = f => subject.createReferenceProductionAskDatasetBinding(f.options, f.rawDatasetJson);
const create = f => subject.createReferenceProductionAskEvaluator(f.options, f.rawDatasetJson);
const request = (f, index, changes = {}) => ({ caseId: f.dataset.cases[index].id, rolloutMode: 'off', phase: 'trial', ordinal: 0, ...changes });
function result(f, index) {
  const evidence = clone(f.dataset.corpus[0]); delete evidence.metadata;
  return { answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '', abstained: index !== 0,
    evidence: index === 0 ? [{ ...evidence, score: 1, laneId: 'dense' }] : [],
    citations: index === 0 ? [{ evidenceId: evidence.evidenceId, startOffset: 0, endOffset: 7 }] : [],
    policyId: 'strict-grounding', laneIds: ['dense'],
    usage: { retrievalLatencyMs: 1, generationLatencyMs: 2, totalLatencyMs: 3,
      tokenMeasurement: 'unavailable', costMeasurement: 'unavailable', embeddingCalls: 1, generationCalls: 1 } };
}
const payload = (f, changes = {}) => ({ schemaVersion: 'kg-reference-ask-results/v1', bindingHash: bind(f).bindingProof.bindingHash,
  entries: f.dataset.cases.map((_, i) => ({ request: request(f, i), result: result(f, i) })), ...changes });
const evaluate = (f, p = payload(f)) => create(f).evaluateReferenceResults(JSON.stringify(p));
async function oracle(f, p = payload(f)) {
  let index = 0;
  return runRagEval(f.normalizedDataset, { id: 'offline-reference', async run() { return p.entries[index++].result; } },
    { topK: f.options.manifest.base.parameters.topK, runId: 'synthetic-original-oracle' });
}
const safeFailure = code => error => typeof subject.ProductionAskReferenceEvaluationError === 'function'
  && error instanceof subject.ProductionAskReferenceEvaluationError && error.code === code
  && error.productionAuthorized === false && error.automaticRetryAllowed === false
  && Object.isFrozen(error) && !Object.hasOwn(error, 'cause') && !/RAW_|secret-token|fixture:|CANARY/.test(error.message);
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); for (const item of Object.values(value)) frozen(item); }
}

test('existing complete dataset fixture actually runs through original evaluator for both stages', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); const report = await oracle(f);
    assert.equal(report.dataset.sha256, bind(f).bindingProof.dataset.normalizedSha256);
    assert.equal(report.summary.completedCases, f.dataset.cases.length);
    assert.equal(report.summary.meanRequiredFactCoverage, 1);
    assert.equal(report.summary.citation.meanSpanIou, 1);
  }
});

test('separate evaluator factory preserves the original exact four-key binding surface', () => {
  const f = fixture();
  assert.deepEqual(Object.keys(bind(f)), ['executionProfile', 'productionCapable', 'bindingProof', 'planRequest']);
  assert.equal(typeof subject.createReferenceProductionAskEvaluator, 'function');
  const evaluator = create(f); frozen(evaluator);
  assert.deepEqual(Object.keys(evaluator), ['executionProfile', 'productionCapable', 'bindingProof', 'evaluateReferenceResults']);
  assert.deepEqual(evaluator.bindingProof, bind(f).bindingProof);
});

test('complete original runner summary and frozen manifest topK enter confidential proof without report contents', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); f.options.manifest.base.parameters.topK = 1; rebindExecution(f);
    const p = payload(f), proof = await evaluate(f, p), original = await oracle(f, p);
    assert.deepEqual(proof.summary, original.summary);
    assert.equal(proof.topK, 1); assert.equal(proof.datasetSha256, original.dataset.sha256);
    assert.equal(proof.resultsSha256, sha(JSON.stringify(p)));
    assert.equal(proof.bindingHash, p.bindingHash); assert.equal(proof.runnerConsumed, true);
    assert.equal(proof.resultSource, 'offline-reference'); frozen(proof);
    for (const k of ['productionAuthorized','stageAcceptanceComplete','executionAuthorized','registryAuthenticated','networkEnforced']) assert.equal(proof[k], false);
    for (const k of ['requestPlanSetSha256','caseOutcomeSha256','proofHash']) assert.match(proof[k], /^[a-f0-9]{64}$/);
    const { proofHash, ...core } = proof; assert.equal(proofHash, hash(core));
    assert.equal(/RAW_|FOREIGN_|QUARANTINED_|fixture:\/\/|answer"|evidence"|error"|traceId"/.test(JSON.stringify(proof)), false);
  }
});

test('rebinding changed gold spans actually changes citation oracle rather than merely rejecting a hash', async () => {
  const a = fixture(), b = fixture(); b.dataset.cases[0].goldEvidence[0].spans = [{ startOffset: 8, endOffset: 15 }]; bindDataset(b, b.dataset);
  const x = await evaluate(a), y = await evaluate(b);
  assert.equal(x.summary.citation.meanSpanIou, 1); assert.equal(y.summary.citation.meanSpanIou, 0);
  assert.notEqual(x.datasetSha256, y.datasetSha256);
});

test('rebinding changed required facts actually changes answer coverage', async () => {
  const a = fixture(), b = fixture(); b.dataset.cases[0].expectedAnswer.requiredFacts = [['UNMATCHED_FACT_CANARY']]; bindDataset(b, b.dataset);
  assert.equal((await evaluate(a)).summary.meanRequiredFactCoverage, 1);
  assert.equal((await evaluate(b)).summary.meanRequiredFactCoverage, 0);
});

test('two relevance levels under frozen topK actually affect original nDCG', async () => {
  const a = fixture(), b = fixture();
  for (const f of [a,b]) {
    f.options.manifest.base.parameters.topK = 1;
    f.dataset.cases[0].goldEvidence = f.dataset.corpus.slice(0,2).map((v,i) => ({ evidenceId: v.evidenceId,
      relevance: i === 0 ? 3 : 1, spans: [{ startOffset: 0, endOffset: 7 }] }));
  }
  b.dataset.cases[0].goldEvidence.forEach(v => { v.relevance = v.relevance === 3 ? 1 : 3; });
  for (const f of [a,b]) bindDataset(f, f.dataset);
  const x = await evaluate(a), y = await evaluate(b);
  assert.equal(x.summary.meanNdcgAtK, 1); assert.ok(y.summary.meanNdcgAtK < x.summary.meanNdcgAtK);
});

test('complete security canaries and forbidden patterns are consumed by original security oracle', async () => {
  const f = fixture(); f.dataset.cases[0].securityExpectations.forbiddenAnswerPatterns.push('RAW_EXPECTED_FACT_CANARY'); bindDataset(f, f.dataset);
  const p = payload(f); const foreign = clone(f.dataset.corpus[2]); delete foreign.metadata;
  p.entries[0].result.evidence = [{ ...foreign, score: 1, laneId: 'dense' }]; p.entries[0].result.citations = [];
  const proof = await evaluate(f,p);
  assert.equal(proof.summary.security.crossTenantHits, 1);
  assert.equal(proof.summary.security.forbiddenEvidenceHits, 1);
  assert.equal(proof.summary.security.forbiddenAnswerPatternHits, 1);
  assert.equal(proof.stageAcceptanceComplete, false);
});

test('fake canonical provenance becomes a failed case and never leaks original runner errors', async () => {
  for (const field of ['content','documentVersion','evidenceId']) {
    const f = fixture(), p = payload(f); p.entries[0].result.evidence[0][field] = 'secret-token-RAW_FAKE';
    const proof = await evaluate(f,p), original = await oracle(f,p);
    assert.deepEqual(proof.summary, original.summary); assert.equal(proof.summary.failedCases, 1);
    assert.equal(/secret-token|RAW_FAKE|"error":|answer"|evidence"/.test(JSON.stringify(proof)), false);
  }
});

test('missing duplicate and permuted full roster results are rejected', async () => {
  for (const change of [p=>p.entries.pop(), p=>p.entries.push(clone(p.entries[0])), p=>p.entries.reverse(),
    p=>{p.entries[1].request.caseId=p.entries[0].request.caseId;}]) {
    const f=fixture(),p=payload(f); change(p);
    await assert.rejects(evaluate(f,p),safeFailure('invalid-results'));
  }
});

test('mixed arms phases or ordinals do not produce a combined summary', async () => {
  for (const change of [{rolloutMode:'shadow'},{phase:'warmup'},{ordinal:1}]) {
    const f=fixture(),p=payload(f); Object.assign(p.entries[1].request,change);
    await assert.rejects(evaluate(f,p),safeFailure('invalid-results'));
  }
});

test('T17 off and active each consume the complete frozen roster separately', async () => {
  const f=fixture('T17'),p=payload(f); p.entries.forEach(v=>{v.request.rolloutMode='active';});
  const off=await evaluate(f),active=await evaluate(f,p);
  assert.equal(off.arm.rolloutMode,'off'); assert.equal(active.arm.rolloutMode,'active');
  assert.notEqual(off.requestPlanSetSha256,active.requestPlanSetSha256);
  assert.deepEqual(off.summary,active.summary); assert.equal(active.executionAuthorized,false);
});

test('foreign binding identities unknown request fields and nonlocal factory configuration fail closed', async () => {
  const f=fixture();
  for(const change of [p=>{p.bindingHash='f'.repeat(64);},p=>{p.entries[0].request.topK=99;},
    p=>{p.entries[0].request.caseId='f'.repeat(32);},p=>{p.entries[0].request.ordinal=9999;}]) {
    const p=payload(f);change(p);await assert.rejects(evaluate(f,p),safeFailure('invalid-results'));
  }
  const o=clone(f.options);o.executionProfile='production';
  assert.throws(()=>subject.createReferenceProductionAskEvaluator(o,f.rawDatasetJson),safeFailure('invalid-config'));
});

test('unknown gold query metadata callback and credentials carriers are never accepted as result protocol', async () => {
  for(const change of [p=>{p.query='RAW_SECRET';},p=>{p.entries[0].gold={raw:'RAW_SECRET'};},
    p=>{p.entries[0].result.metadata={secret:'RAW_SECRET'};},p=>{p.entries[0].result.evidence[0].gold='RAW_SECRET';},
    p=>{p.entries[0].result.usage.callback='secret-token';}]) {
    const f=fixture(),p=payload(f);change(p);await assert.rejects(evaluate(f,p),safeFailure('invalid-results'));
  }
});

test('primitive JSON boundary rejects getters Proxy boxed string and extra arguments without hooks', async () => {
  const f=fixture(),e=create(f),raw=JSON.stringify(payload(f));let hooks=0;const hook=()=>{hooks++;throw Error('secret-token');};
  const carrier={get data(){return hook();},toJSON:hook,then:hook};
  const proxy=new Proxy({}, {get:hook,ownKeys:hook,getOwnPropertyDescriptor:hook,getPrototypeOf:hook});
  for(const input of [carrier,proxy,new String(raw),null,42]) await assert.rejects(e.evaluateReferenceResults(input),safeFailure('invalid-results'));
  await assert.rejects(e.evaluateReferenceResults(raw,hook),safeFailure('invalid-results'));assert.equal(hooks,0);
  assert.throws(()=>subject.createReferenceProductionAskEvaluator(f.options,f.rawDatasetJson,hook),safeFailure('invalid-config'));assert.equal(hooks,0);
});

test('malformed nonfinite deeply nested node-heavy and UTF8 oversized results have static errors', async () => {
  const f=fixture(),e=create(f),p=payload(f);
  const raw=JSON.stringify(p);const nonfinite=raw.replace('"totalLatencyMs":3','"totalLatencyMs":1e400');
  let deep=null;for(let i=0;i<66;i++)deep={next:deep};
  for(const input of ['{"answer":"secret-token"',nonfinite,JSON.stringify({...p,extra:deep}),
    JSON.stringify({...p,extra:Array(200001).fill(null)}),JSON.stringify({...p,extra:'中'.repeat(3*1024*1024)})]) {
    await assert.rejects(e.evaluateReferenceResults(input),safeFailure('invalid-results'));
  }
});

test('legal dataset and offline results larger than the small canonical object budget are fully consumed', async () => {
  const f=fixture();f.dataset.corpus[0].content='x'.repeat(300*1024);bindDataset(f,f.dataset);
  const p=payload(f);assert.ok(Buffer.byteLength(f.rawDatasetJson)>256*1024);assert.ok(Buffer.byteLength(JSON.stringify(p))>256*1024);
  const proof=await evaluate(f,p);assert.equal(proof.summary.completedCases,f.dataset.cases.length);
  assert.equal(proof.datasetSha256,bind(f).bindingProof.dataset.normalizedSha256);
});

test('factory snapshots cannot drift after caller mutates options dataset or result objects', async () => {
  const f=fixture(),e=create(f),p=payload(f),raw=JSON.stringify(p);const first=await e.evaluateReferenceResults(raw);
  f.options.manifest.base.parameters.topK=99;f.dataset.cases[0].query='RAW_MUTATED';p.entries[0].result.answer='RAW_MUTATED';
  assert.deepEqual(await e.evaluateReferenceResults(raw),first);
});

test('independent concurrent evaluations never share offline target cursors or request state', async () => {
  const f=fixture('T17'),e=create(f),off=payload(f),active=payload(f);active.entries.forEach(v=>{v.request.rolloutMode='active';});
  const rows=await Promise.all([e.evaluateReferenceResults(JSON.stringify(off)),e.evaluateReferenceResults(JSON.stringify(active))]);
  assert.equal(rows[0].arm.rolloutMode,'off');assert.equal(rows[1].arm.rolloutMode,'active');
  assert.equal(rows[0].summary.completedCases,f.dataset.cases.length);assert.equal(rows[1].summary.completedCases,f.dataset.cases.length);
});

test('case failure identity enters outcome proof while ordinary output has no unsafe trajectory or trace', async () => {
  const f=fixture(),good=payload(f),bad=payload(f);bad.entries[0].result.answer='secret-token';
  bad.entries[0].result.traceId='secret-token';bad.entries[0].result.trajectory={mode:'snapshot',searchStopReason:'secret-token'};
  const a=await evaluate(f,good),b=await evaluate(f,bad);
  assert.notEqual(a.caseOutcomeSha256,b.caseOutcomeSha256);
  assert.equal(JSON.stringify(b).includes('secret-token'),false);
});
