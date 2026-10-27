import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
  throw e;
} } });
const { fixture, bindDataset, rebindExecution } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const { canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { createReferenceProductionAskDatasetBinding } = await import('./production-ask-dataset-binding.ts');
const { createReferenceProductionAskProducer } = await import('./production-ask-producer.ts');
const { createReferenceAuthorityClock } = await import('./production-authority-ports.ts');
const { createReferenceKmsEnvelope, createReferenceArtifactStore } = await import('./production-controlled-artifacts.ts');
let subject; try { subject = await import('./production-ask-runner.ts'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; subject = {}; }
let gateSubject; try { gateSubject = await import('./production-stage-gate.ts'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; gateSubject = {}; }
let effectsSubject; try { effectsSubject = await import('./production-shadow-side-effects.ts'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; effectsSubject = {}; }
let shadowFramer; try { shadowFramer = await import('./production-shadow-artifact-framing.ts'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; shadowFramer = {}; }
const shadowWriter = await import('./production-ask-artifact-writer.ts');
const clone = x => structuredClone(x), sha = x => createHash('sha256').update(x).digest('hex');
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const flags = { executionProfile: 'local-reference', productionCapable: false };
const turn = () => new Promise(resolve => setImmediate(resolve));
const make = f => subject.createReferenceProductionAskRunner(f.options, f.base.rawDatasetJson, f.ports);
const gate = f => gateSubject.createReferenceProductionStageQualityCollector(f.options.askOptions, f.base.rawDatasetJson);
const posts = f => f.calls.filter(c => c.name === 'post');
const safeError = code => e => e instanceof subject.ProductionAskRunnerError && e.code === code
  && e.productionAccepted === false && e.automaticRetryAllowed === false && !Object.hasOwn(e, 'cause')
  && !/RAW_|secret-token|CANARY|fixture:/.test(e.message) && Object.isFrozen(e);
function frozen(x) { if (x && typeof x === 'object') { assert.ok(Object.isFrozen(x)); for (const v of Object.values(x)) frozen(v); } }
function response(f, request) {
  const body = JSON.parse(Buffer.from(request.bodyBase64url, 'base64url').toString('utf8'));
  const index = f.base.dataset.cases.findIndex(c => c.id === request.requestPlan.requestIdentity.caseId);
  const e = clone(f.base.dataset.corpus[0]); delete e.metadata;
  const payload = { success: true, question: body.question, answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '',
    models: { llm: body.llmModel, embedding: body.embeddingModel }, storageBackend: 'milvus', traceId: 'runner-' + index,
    evidence: index === 0 ? [{ ...e, id: e.evidenceId, retrievalScore: 1, laneId: 'dense' }] : [],
    citations: index === 0 ? [{ evidenceId: e.evidenceId, startOffset: 0, endOffset: 7 }] : [],
    laneExecutions: [{ laneId: 'dense', status: 'completed' }],
    retrievalDetails: { graph: { requestedMode: request.requestPlan.requestIdentity.rolloutMode }, abstention: { mode: 'active', abstain: index !== 0 } } };
  f.changeResponse?.(payload, request);
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({ schemaVersion: 'kg-reference-ask-response/v1', requestPlanHash: request.requestPlan.planHash,
    requestBodySha256: request.bodySha256, deploymentHash: request.deploymentHash, url: request.requestPlan.target.url, status: 200,
    headers: { 'x-rag-policy': 'strict-grounding', 'x-rag-trace-id': payload.traceId, 'x-rag-status': 'completed' }, bodyBase64url: bytes.toString('base64url'),
    measurement: { schemaVersion: 'kg-reference-ask-measurement/v1', requestPlanHash: request.requestPlan.planHash,
      requestBodySha256: request.bodySha256, responseBodySha256: sha(bytes), abstained: index !== 0,
      usage: { retrievalLatencyMs: 1, generationLatencyMs: 2, totalLatencyMs: 3, tokenMeasurement: 'unavailable', costMeasurement: 'unavailable', embeddingCalls: 1, generationCalls: 1 } } });
}
async function setup(stage = 'T16', change) {
  const base = fixture(stage); if (change) { change(base); rebindExecution(base); }
  const binding = createReferenceProductionAskDatasetBinding(base.options, base.rawDatasetJson).bindingProof.binding;
  const p = base.options.expectedExecutionPayload, at = new Date(Date.parse(p.notBefore) + 60000).toISOString();
  const common = { executionProfile: 'local-reference', binding, actors: { executorId: p.participants.executorId, readOnlyId: p.participants.readOnlyId },
    validFrom: p.notBefore, validUntil: p.expiresAt, maxObjects: 10000 };
  const kms = createReferenceKmsEnvelope({ ...common, keyPolicyRef: base.options.manifest.base.artifactPolicy.keyPolicyRef, maxPlaintextBytes: 65536 });
  const expectedKeyRef = await kms.rotateKey({ context: { executionProfile: 'local-reference', binding, actorId: p.participants.executorId,
    authorizationDigest: base.options.executionAuthorizationRef.sha256, observedAt: at } });
  const storeRef = ref('paired-store'), clockRef = ref('paired-clock');
  const store = createReferenceArtifactStore({ ...common, storeIdentityRef: storeRef, maxObjectBytes: 256 * 1024 });
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: p.scope,
    allowedActorIds: [p.participants.executorId, p.participants.readOnlyId], sourceIdentityRef: clockRef,
    initialObservedAt: at, uncertaintyMs: 1, maxReadings: 10000, maxAdvanceMs: 86400000 });
  const f = { base, calls: [] };
  const own = (native, names) => ({ ...flags, ...Object.fromEntries(names.map(name => [name, function (request) {
    f.calls.push({ name, request }); return Reflect.apply(native[name], native, [request]);
  }])) });
  f.ports = { clock: own(clock, ['readTime']), kms: own(kms, ['encryptArtifact', 'decryptArtifact']), store: own(store, ['sealEncryptedArtifact', 'readExact']),
    transport: { ...flags, readDeployment(plan) { f.calls.push({ name: 'readDeployment', request: plan }); const b = base.options.manifest.base, r = plan.requestIdentity;
      return Promise.resolve(JSON.stringify({ schemaVersion: 'kg-reference-ask-deployment/v1', requestPlanHash: plan.planHash, origin: plan.target.origin,
        providerRegistrationHash: plan.providerRegistrationHash, scope: clone(plan.binding), rolloutMode: r.rolloutMode,
        sharedConfigHash: r.sharedConfigHash, armConfigHash: r.armConfigHash, models: { llm: b.models.llm.id, embedding: b.models.embedding.id }, parameters: clone(b.parameters) })); },
      post(request) { f.calls.push({ name: 'post', request }); return Promise.resolve(response(f, request)); },
      close() { f.calls.push({ name: 'close' }); } } };
  f.options = { executionProfile: 'local-reference', askOptions: clone(base.options), artifacts: { expectedKeyRef: clone(expectedKeyRef), storeIdentityRef: storeRef,
    clockIdentityRef: clockRef, maxClockUncertaintyMs: 10, retainUntil: new Date(Date.parse(p.window.endsAt) + 3600000).toISOString(), operationTimeoutMs: 10000 } };
  return f;
}

test('unchanged original producer writer and oracle are valid before paired runner exists', async () => {
  const f = await setup(), producer = createReferenceProductionAskProducer(f.options, f.base.rawDatasetJson, f.ports);
  const proof = await producer.runArm({ rolloutMode: 'off', phase: 'trial', ordinal: 0 }); producer.close();
  assert.equal(proof.cases.length, 2); assert.equal(proof.evaluation.summary.failedCases, 0);
  assert.equal(proof.cases.every(c => c.artifacts.every(a => a.observation.encryptedReadbackMatched)), true);
});

test('complete frozen schedule owns both arms all warmups then trials and original full indices', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = await setup(stage), runner = make(f); frozen(runner); assert.equal(f.calls.length, 0);
    const out = await runner.run({}); frozen(out); const treatment = stage === 'T16' ? 'shadow' : 'active';
    const sampling = f.base.options.manifest[stage === 'T16' ? 't16' : 't17'].sampling;
    assert.equal(out.stage, stage); assert.deepEqual(out.sampling, sampling);
    assert.equal(out.qualityReport.qualityComparisonsComputed, true); assert.equal(out.qualityReport.machineGateComputed, false);
    assert.equal(out.qualityReport.stageAcceptanceComplete, false); assert.equal(out.qualityReport.populationCaseCount, expectedPopulation(stage));
    assert.equal(out.warmups.length, sampling.warmupCount); assert.equal(out.trials.length, sampling.trialCount);
    const expected = [];
    for (const phase of ['warmup', 'trial']) for (let ordinal = 0; ordinal < sampling[phase === 'trial' ? 'trialCount' : 'warmupCount']; ordinal++) {
      for (const rolloutMode of ['off', treatment]) for (const c of f.base.dataset.cases) expected.push({ caseId: c.id, rolloutMode, phase, ordinal });
    }
    assert.deepEqual(posts(f).map(x => Object.fromEntries(['caseId', 'rolloutMode', 'phase', 'ordinal'].map(k => [k, x.request.requestPlan.requestIdentity[k]]))), expected);
    assert.equal(out.transportCalls, expected.length); assert.equal(out.trialTransportCalls, 2 * sampling.trialCount * f.base.dataset.cases.length);
    const binder = createReferenceProductionAskDatasetBinding(f.base.options, f.base.rawDatasetJson);
    for (const pair of [...out.warmups, ...out.trials]) {
      assert.equal(pair.off.cases.length, 2); assert.equal(pair.treatment.cases.length, 2); assert.equal(pair.cases.length, 2);
      assert.equal(pair.off.evaluation.summary.completedCases, 2); assert.equal(pair.treatment.evaluation.summary.completedCases, 2);
      for (const [index, c] of pair.cases.entries()) {
        assert.equal(c.caseIndex, index); assert.equal(c.offRequestPlanHash, binder.planRequest({ caseId: f.base.dataset.cases[index].id, rolloutMode: 'off', phase: pair.phase, ordinal: pair.ordinal }).requestPlan.planHash);
        assert.equal(c.treatmentRequestPlanHash, binder.planRequest({ caseId: f.base.dataset.cases[index].id, rolloutMode: treatment, phase: pair.phase, ordinal: pair.ordinal }).requestPlan.planHash);
        assert.equal(pair.off.cases[index].requestBodySha256, pair.treatment.cases[index].requestBodySha256);
        for (const arm of [pair.off, pair.treatment]) assert.deepEqual(arm.cases[index].artifacts.map(a => a.artifactType), ['request', 'gold', 'response', 'telemetry']);
      }
    }
    for (const key of ['productionAccepted', 'stageAcceptanceComplete', 'executionAuthorized', 'sideEffectPolicyVerified', 'machineGateComputed']) assert.equal(out[key], false);
    for (const marker of ['RAW_QUERY_CANARY', 'RAW_EXPECTED_FACT_CANARY', 'RAW_SECURITY_PATTERN_CANARY', 'fixture://', 'secret-token']) assert.equal(JSON.stringify(out).includes(marker), false);
    assert.equal(f.calls.filter(c => c.name === 'close').length, 1);
  }
});

function expectedPopulation(stage) { return stage === 'T16' ? 12 : 16; }
async function observedArms(f) {
  const producer = createReferenceProductionAskProducer(f.options, f.base.rawDatasetJson, f.ports), out = [];
  try {
    const policy = f.base.options.manifest[f.base.stage === 'T16' ? 't16' : 't17'];
    for (const phase of ['warmup', 'trial']) for (let ordinal = 0; ordinal < policy.sampling[phase === 'warmup' ? 'warmupCount' : 'trialCount']; ordinal++) {
      for (const rolloutMode of ['off', f.base.stage === 'T16' ? 'shadow' : 'active']) out.push(await producer.runArm({ phase, ordinal, rolloutMode }));
    }
    return out;
  } finally { producer.close(); }
}
const check = (r, phase, mode, metric) => r.populations.find(p => p.phase === phase && p.rolloutMode === mode).qualityChecks.find(c => c.metric === metric);

test('stage collector consumes actual producer full schedule and original metrics but cannot manufacture full-stage acceptance', async () => {
  const f = await setup(), g = gate(f), arms = await observedArms(f); arms.forEach(a => g.observeArm(a)); const r = g.finish({}); frozen(r);
  assert.equal(r.populationCaseCount, 12); assert.equal(r.qualityComparisonsComputed, true); assert.equal(r.machineGateComputed, false);
  assert.equal(r.productionAccepted, false); assert.equal(r.stageAcceptanceComplete, false); assert.equal(r.sideEffectPolicyVerified, false);
  assert.equal(check(r, 'trial', 'shadow', 'meanRecallAtK').status, 'passed'); assert.equal(check(r, 'trial', 'shadow', 'citation.metricCoverageRatio').status, 'failed');
  assert.equal(check(r, 'trial', 'shadow', 'timeoutRate').actual, null); assert.equal(check(r, 'trial', 'shadow', 'semanticDegradation').status, 'unavailable');
  assert.equal(r.populations.every(p => p.securityChecks.length === 11 && p.securityChecks.filter(c => c.status === 'not-run').length === 4), true);
  assert.equal(/RAW_|fixture:|"answer":|"evidence":|"caseId":|"error":/.test(JSON.stringify(r)), false);
});

test('stage collector threshold equality and missing sources cannot become passed overall verdict', async () => {
  const f = await setup('T16', b => { b.options.manifest.t16.quality['citation.metricCoverageRatio'].min = 0.5; b.options.manifest.t16.quality.retrievalMetricCoverageRatio.min = 0.5; });
  const g = gate(f), arms = await observedArms(f); arms.forEach(a => g.observeArm(a)); const r = g.finish({});
  assert.equal(check(r, 'trial', 'shadow', 'citation.metricCoverageRatio').status, 'passed'); assert.equal(check(r, 'trial', 'shadow', 'citation.metricCoverageRatio').actual, 0.5);
  assert.equal(r.verdict, 'incomplete'); assert.equal(r.machineGateComputed, false); assert.ok(r.blockers.includes('side-effect-readback-unavailable'));
});

test('stage collector fully aggregates trial latencies instead of averaging P95 or mixing warmup', async () => {
  const f = await setup('T16', b => { b.options.manifest.t16.quality['latencyMs.p95'].max = 100; });
  const rawPost = f.ports.transport.post; f.ports.transport.post = async request => {
    const r = JSON.parse(await rawPost(request)), identity = request.requestPlan.requestIdentity;
    r.measurement.usage.totalLatencyMs = identity.phase === 'warmup' ? 1 : identity.ordinal === 0 ? (request.requestPlan.requestIdentity.caseId === f.base.dataset.cases[0].id ? 3 : 100) : 10;
    return JSON.stringify(r);
  };
  const g = gate(f); (await observedArms(f)).forEach(a => g.observeArm(a)); const r = g.finish({});
  assert.equal(check(r, 'trial', 'shadow', 'latencyMs.p95').actual, 100); assert.equal(check(r, 'trial', 'shadow', 'latencyMs.p95').status, 'passed');
  assert.equal(r.populations.find(p => p.phase === 'warmup' && p.rolloutMode === 'shadow').summary.latencyMs.p95, 1);
});

test('stage collector rejects forged clones proxies and getter proofs before reading any caller property', async () => {
  const f = await setup(), proof = (await observedArms(f))[0]; let hooks = 0; const trap = () => { hooks++; throw Error('RAW_SECRET'); };
  const fake = {}; Object.defineProperty(fake, 'arm', { enumerable: true, get: trap });
  for (const value of [fake, clone(proof), JSON.stringify(proof), new Proxy(proof, { get: trap, ownKeys: trap }), null]) {
    const g = gate(f); assert.throws(() => g.observeArm(value), e => e.code === 'invalid-proof');
  }
  assert.equal(hooks, 0);
});

test('stage collector rejects foreign binding real proofs out-of-order duplicate and incomplete schedules', async () => {
  const f = await setup(), arms = await observedArms(f), foreign = await setup('T17');
  const alien = (await observedArms(foreign))[0]; assert.throws(() => gate(f).observeArm(alien), e => e.code === 'invalid-proof');
  assert.throws(() => gate(f).observeArm(arms[1]), e => e.code === 'invalid-proof');
  const duplicate = gate(f); duplicate.observeArm(arms[0]); assert.throws(() => duplicate.observeArm(arms[0]), e => e.code === 'invalid-proof');
  const partial = gate(f); partial.observeArm(arms[0]); assert.throws(() => partial.finish({}), e => e.code === 'incomplete-population');
});

test('stage collector constructor freezes approved thresholds and never accepts caller quality or hard-gate relaxations', async () => {
  const f = await setup(), g = gate(f), arms = await observedArms(f); f.options.askOptions.manifest.t16.quality['citation.metricCoverageRatio'].min = 0.1;
  arms.forEach(a => g.observeArm(a)); assert.equal(check(g.finish({}), 'trial', 'shadow', 'citation.metricCoverageRatio').status, 'failed');
  const options = clone(f.base.options); options.manifest.base.hardGates.crossTenantHits = 1;
  assert.throws(() => gateSubject.createReferenceProductionStageQualityCollector(options, f.base.rawDatasetJson), e => e.code === 'invalid-config');
});

test('stage collector empty final selector and closed single-use lifetime reject injected verdicts and replay', async () => {
  const f = await setup(), arms = await observedArms(f), g = gate(f); arms.forEach(a => g.observeArm(a));
  assert.throws(() => g.finish({ passed: true }), e => e.code === 'invalid-request'); const r = g.finish({}); assert.equal(r.machineGateComputed, false);
  assert.throws(() => g.finish({}), e => e.code === 'already-completed'); const stopped = gate(f); stopped.close();
  assert.throws(() => stopped.observeArm(arms[0]), e => e.code === 'halted'); assert.throws(() => stopped.finish({}), e => e.code === 'halted');
});

test('stage collector T17 preserves off active and undefined multi-hop measurement rather than inferring label membership', async () => {
  const f = await setup('T17'), g = gate(f); (await observedArms(f)).forEach(a => g.observeArm(a)); const r = g.finish({});
  assert.equal(r.stage, 'T17'); assert.equal(r.populationCaseCount, 16); assert.equal(r.populations.find(p => p.phase === 'trial' && p.rolloutMode === 'active').summary.totalCases, 6);
  assert.equal(check(r, 'trial', 'active', 'multiHop.meanRequiredFactCoverage').status, 'unavailable'); assert.equal(r.stageAcceptanceComplete, false);
});

test('stage collector missing recall and answer scores stay unavailable even when their frozen minima are zero', async () => {
  const f = await setup('T16', b => {
    b.dataset.cases.forEach(c => { c.goldEvidence = []; delete c.expectedAnswer; c.expectedAbstain = true; });
    bindDataset(b, b.dataset); b.options.manifest.t16.quality.meanRecallAtK.min = 0; b.options.manifest.t16.quality.meanRequiredFactCoverage.min = 0;
  });
  f.changeResponse = p => { p.answer = ''; p.evidence = []; p.citations = []; p.retrievalDetails.abstention.abstain = true; };
  const raw = f.ports.transport.post; f.ports.transport.post = async input => { const r = JSON.parse(await raw(input)); r.measurement.abstained = true; return JSON.stringify(r); };
  const g = gate(f); (await observedArms(f)).forEach(a => g.observeArm(a)); const r = g.finish({});
  for (const metric of ['meanRecallAtK', 'meanRequiredFactCoverage']) { const c = check(r, 'trial', 'shadow', metric); assert.equal(c.limit, 0); assert.equal(c.actual, null); assert.equal(c.status, 'unavailable'); }
  assert.notEqual(r.verdict, 'passed');
});

test('stage collector latency just beyond frozen max fails without changing thresholds or dropping samples', async () => {
  const f = await setup('T16', b => { b.options.manifest.t16.quality['latencyMs.p95'].max = 99; });
  const raw = f.ports.transport.post; f.ports.transport.post = async input => { const r = JSON.parse(await raw(input)); r.measurement.usage.totalLatencyMs = 100; return JSON.stringify(r); };
  const runner = make(f), r = await runner.run({}); assert.equal(r.transportCalls, 12);
  assert.equal(check(r.qualityReport, 'trial', 'shadow', 'latencyMs.p95').status, 'failed'); assert.equal(r.qualityReport.verdict, 'failed'); assert.equal(r.machineGateComputed, false);
});

test('zero warmups and signed trial boundary are not replaced by defaults', async () => {
  const f = await setup('T16', b => { b.options.manifest.t16.sampling = { warmupCount: 0, trialCount: 1 }; });
  const out = await make(f).run({}); assert.equal(out.warmups.length, 0); assert.equal(out.trials.length, 1); assert.equal(posts(f).length, 4);
  for (const population of out.qualityReport.populations.filter(p => p.phase === 'warmup')) {
    assert.equal(population.caseCount, 0); assert.equal(population.armCount, 0);
    assert.equal(population.securityChecks.length, 11);
    assert.equal(population.securityChecks.every(c => c.actual === null && c.status === 'not-run'), true);
  }
  for (const population of out.qualityReport.populations.filter(p => p.phase === 'trial')) {
    assert.equal(population.caseCount, 2);
    assert.equal(population.securityChecks.filter(c => c.actual === 0 && c.status === 'passed').length, 7);
    assert.equal(population.securityChecks.filter(c => c.actual === null && c.status === 'not-run').length, 4);
  }
});

test('runner config carriers never call getters proxy traps or allow injected producers or enterprise profile', async () => {
  const f = await setup(); let hooks = 0; const trap = () => { hooks++; throw Error('secret-token'); };
  for (const value of [null, new Proxy(f.options, { get: trap, ownKeys: trap }), { ...f.options, producer: {} }, { ...f.options, executionProfile: 'enterprise' }]) assert.throws(() => subject.createReferenceProductionAskRunner(value, f.base.rawDatasetJson, f.ports), safeError('invalid-config'));
  const value = { ...f.options }; Object.defineProperty(value, 'askOptions', { enumerable: true, get: trap });
  assert.throws(() => subject.createReferenceProductionAskRunner(value, f.base.rawDatasetJson, f.ports), safeError('invalid-config'));
  assert.throws(() => subject.createReferenceProductionAskRunner(f.options, f.base.rawDatasetJson, f.ports, {}), safeError('invalid-config'));
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
});

test('empty execution selector forbids counts arms cases callbacks results and thenable carriers before IO', async () => {
  const f = await setup(), runner = make(f); let hooks = 0; const trap = () => { hooks++; throw Error('secret-token'); };
  for (const input of [null, [], { trialCount: 1 }, { rolloutMode: 'off' }, { results: [] }, { producer: () => {} }, new Proxy({}, { ownKeys: trap })]) await assert.rejects(runner.run(input), safeError('invalid-request'));
  const input = {}; Object.defineProperty(input, 'then', { enumerable: true, get: trap }); await assert.rejects(runner.run(input), safeError('invalid-request'));
  await assert.rejects(runner.run({}, {}), safeError('invalid-request')); assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
  runner.close(); await assert.rejects(runner.run({}), safeError('halted')); assert.equal(f.calls.filter(c => c.name === 'close').length, 1);
});

test('frozen input sampling and raw query cannot drift after runner construction', async () => {
  const f = await setup(), runner = make(f), expected = clone(f.base.dataset.cases.map(c => c.query));
  f.options.askOptions.manifest.t16.sampling.trialCount = 1; f.options.askOptions.manifest.base.parameters.topK = 1;
  f.base.dataset.cases[0].query = 'RAW_CHANGED_QUERY';
  const out = await runner.run({}); assert.equal(out.trials.length, 2);
  assert.deepEqual(posts(f).slice(0, 2).map(x => JSON.parse(Buffer.from(x.request.bodyBase64url, 'base64url')).question), expected);
  assert.equal(posts(f).every(x => JSON.parse(Buffer.from(x.request.bodyBase64url, 'base64url')).topK === 8), true);
});

test('warmup observations remain separate and missing citations cannot inherit warmup coverage', async () => {
  const f = await setup(); f.changeResponse = (payload, request) => { if (request.requestPlan.requestIdentity.phase === 'trial') delete payload.citations; };
  const out = await make(f).run({}); assert.equal(out.warmups[0].off.evaluation.summary.citation.meanCoverage, 1);
  for (const pair of out.trials) for (const arm of [pair.off, pair.treatment]) {
    assert.equal(arm.cases.every(c => c.citationSource === 'absent'), true);
    // The original oracle counts available gold spans, not citation presence.
    assert.equal(arm.evaluation.summary.citation.metricCoverageRatio, 0.5);
    assert.equal(arm.evaluation.summary.citation.meanCoverage, 0);
    assert.equal(arm.evaluation.summary.tokens.inputTotal, null);
    assert.equal(arm.evaluation.summary.costUsd.total, null);
  }
});

test('original security oracle failure stops every later arm and trial without retry or private error leakage', async () => {
  const f = await setup(); f.changeResponse = payload => { payload.evidence[0].tenantId = 'foreign-tenant'; };
  const runner = make(f); await assert.rejects(runner.run({}), e => safeError('producer-failed')(e) && e.mutationMayHaveOccurred && e.requestMayHaveBeenDispatched);
  assert.equal(posts(f).length, 1); await assert.rejects(runner.run({}), safeError('halted')); assert.equal(posts(f).length, 1);
  assert.equal(f.calls.filter(c => c.name === 'close').length, 1);
});

test('busy and single-use reject concurrent duplicate dispatch without changing full approved schedule', async () => {
  const f = await setup(); let release, enter; const entered = new Promise(r => { enter = r; });
  const held = new Promise(r => { release = r; }); const original = f.ports.transport.post;
  f.ports.transport.post = request => { if (!posts(f).length) { f.calls.push({ name: 'post', request }); enter(); return held; } return original(request); };
  const runner = make(f), pending = runner.run({}); await Promise.race([entered, pending.then(() => { throw Error('unexpected terminal'); }, e => { throw e; })]);
  await assert.rejects(runner.run({}), safeError('busy')); release(response(f, posts(f)[0].request));
  const out = await pending; assert.equal(out.transportCalls, 12); await assert.rejects(runner.run({}), safeError('already-executed')); assert.equal(posts(f).length, 12);
});

test('explicit runner close fences owned producer and late post settlement before any next case', async () => {
  const f = await setup(); let release, enter; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); enter(); return held; };
  const runner = make(f), pending = runner.run({}); await Promise.race([entered, pending.then(() => { throw Error('unexpected terminal'); }, e => { throw e; })]);
  runner.close(); runner.close(); release(response(f, posts(f)[0].request));
  await assert.rejects(pending, e => safeError('halted')(e) && e.mutationMayHaveOccurred && e.requestMayHaveBeenDispatched);
  await turn(); assert.equal(posts(f).length, 1); assert.equal(f.calls.filter(c => c.name === 'close').length, 1);
});

test('complete approved pairing that cannot fit original proof budget is rejected before any port dispatch', async () => {
  const f = await setup('T16', b => {
    const dataset = clone(b.dataset), original = dataset.cases[1];
    dataset.cases = Array.from({ length: 1000 }, (_, index) => ({ ...clone(original), id: (index + 1).toString(16).padStart(32, '0'), query: 'RAW_BUDGET_QUERY_' + index }));
    bindDataset(b, dataset, { updateRoster: true }); b.options.manifest.t16.sampling = { warmupCount: 1000, trialCount: 100 };
  });
  assert.throws(() => make(f), safeError('capacity-exhausted')); assert.equal(f.calls.length, 0);
});

const zeroEffects = ['graphCache', 'pointer', 'outbox', 'buildJob', 'neo4j', 'milvus', 'index', 'mode', 'traffic'];
const allowedEffects = ['encryptedAudit', 'controlledTelemetry', 'modelBilling', 'equivalentOrdinaryCache'];
async function effectsFixture(change, configure) {
  const f = await setup('T16', configure), original = f.ports.transport.post;
  f.effectsState = { zeroMutation: Object.fromEntries(zeroEffects.map(k => [k, { mutationCount: 0, state: { value: 'RAW_INTERNAL_STATE' } }])),
    allowedEffects: Object.fromEntries(allowedEffects.map(k => [k, 0])), serving: null };
  const seal = f.ports.store.sealEncryptedArtifact;
  f.ports.store.sealEncryptedArtifact = async request => { const out = await seal(request); f.effectsState.allowedEffects.encryptedAudit++; return out; };
  f.ports.transport.post = async request => {
    const wire = await original(request), raw = JSON.parse(wire), body = JSON.parse(Buffer.from(request.bodyBase64url, 'base64url'));
    f.effectsState.serving = { requestPlanHash: request.requestPlan.planHash, requestBodySha256: request.bodySha256,
      responseBodySha256: sha(Buffer.from(raw.bodyBase64url, 'base64url')), servedEvidence: ['RAW_SERVED_EVIDENCE'], context: body.question,
      prompt: { system: 'RAW_SYSTEM_PROMPT', question: body.question }, cacheIdentity: { key: sha(body.question) } };
    f.effectsState.allowedEffects.controlledTelemetry++; f.effectsState.allowedEffects.modelBilling++;
    change?.(f, request); return wire;
  };
  f.ports.readback = { ...flags, async readShadowState(request) {
    f.calls.push({ name: 'readShadowState', request });
    const out = { schemaVersion: 'kg-reference-shadow-state/v1', requestNonce: request.requestNonce, requestHash: hash(request),
      providerRegistrationHash: request.providerRegistrationHash, binding: clone(request.binding), observedAt: request.observedAt, ...clone(f.effectsState) };
    f.changeReadback?.(out, request); return JSON.stringify(out);
  } };
  return f;
}
const makeEffects = f => effectsSubject.createReferenceShadowSideEffectAskRunner(f.options, f.base.rawDatasetJson, f.ports);
const effectsError = code => e => e instanceof effectsSubject.ShadowSideEffectError && e.code === code && e.productionAccepted === false
  && e.automaticRetryAllowed === false && !Object.hasOwn(e, 'cause') && Object.isFrozen(e) && !/RAW_|secret-token|fixture:/.test(e.message);

test('shadow effects actual private paired producer preserves complete schedule and captures every pre post boundary', async () => {
  const f = await effectsFixture(), out = await makeEffects(f).run({}); frozen(out);
  assert.equal(out.run.transportCalls, 12); assert.equal(out.sideEffects.observationCount, 26); assert.equal(out.sideEffects.pairedCaseCount, 6);
  assert.equal(out.sideEffects.zeroMutationChecks.length, 9); assert.equal(out.sideEffects.zeroMutationChecks.every(c => c.status === 'passed' && c.delta === 0), true);
  assert.equal(out.sideEffects.servingChecks.length, 4); assert.equal(out.sideEffects.servingChecks.every(c => c.status === 'passed' && c.pairs === 6), true);
  assert.equal(out.sideEffects.allowedEffectDeltas.modelBilling, 12); assert.equal(out.sideEffects.allowedEffectDeltas.controlledTelemetry, 12);
  // The terminal source reading precedes its own audit archive. Keep actual
  // source-window counters separate from that explicit terminal archive proof.
  assert.equal(out.sideEffects.allowedEffectDeltas.encryptedAudit,
    f.calls.filter(c => c.name === 'sealEncryptedArtifact').length - out.sideEffects.observations.at(-1).archive.partCount);
  for (const key of ['productionAccepted', 'stageAcceptanceComplete', 'machineGateComputed', 'sideEffectPolicyVerified', 'sourceAuthenticated']) assert.equal(out[key], false);
  assert.ok(out.sideEffects.blockers.includes('ordinary-cache-equivalence-definition-unavailable'));
  assert.equal(/RAW_|"context":|"prompt":|"question":|"serving":/.test(JSON.stringify(out)), false);
  assert.equal(f.calls.filter(c => c.name === 'close').length, 1);
});

test('shadow effects every forbidden mutation fails after first actual POST without retries', async () => {
  for (const field of zeroEffects) {
    const f = await effectsFixture(s => { s.effectsState.zeroMutation[field].mutationCount++; });
    const runner = makeEffects(f); await assert.rejects(runner.run({}), effectsError('side-effect-mismatch'));
    assert.equal(posts(f).length, 1); await assert.rejects(runner.run({}), effectsError('halted')); assert.equal(posts(f).length, 1);
  }
});

test('shadow effects content changes cannot hide behind unchanged mutation counters', async () => {
  const f = await effectsFixture(s => { s.effectsState.zeroMutation.pointer.state.value = 'RAW_CHANGED_CONTENT'; });
  await assert.rejects(makeEffects(f).run({}), effectsError('side-effect-mismatch')); assert.equal(posts(f).length, 1);
});

test('shadow effects all serving fields compare complete actual off shadow observations', async () => {
  for (const field of ['servedEvidence', 'context', 'prompt', 'cacheIdentity']) {
    const f = await effectsFixture((s, r) => { if (r.requestPlan.requestIdentity.rolloutMode === 'shadow') s.effectsState.serving[field] = 'RAW_CHANGED_SERVING'; });
    await assert.rejects(makeEffects(f).run({}), effectsError('side-effect-mismatch')); assert.equal(posts(f).length, 3);
  }
});

test('shadow effects reject missing fields counter reset foreign scope and response replay without inventing defaults', async () => {
  for (const alter of [o => { delete o.zeroMutation.graphCache; }, o => { o.allowedEffects.modelBilling = null; },
    o => { o.binding.tenantId = 'foreign'; }, o => { o.requestNonce = '0'.repeat(32); },
    (o, r) => { if (r.point === 'post-after') o.serving.responseBodySha256 = '0'.repeat(64); },
    (o, r) => { if (r.point === 'post-after') o.allowedEffects.modelBilling = 0; }]) {
    const f = await effectsFixture(); f.effectsState.allowedEffects.modelBilling = 10; f.changeReadback = alter;
    await assert.rejects(makeEffects(f).run({}), e => effectsError('invalid-readback')(e) || effectsError('side-effect-mismatch')(e));
    assert.ok(posts(f).length <= 1);
  }
});

test('shadow effects public selectors reject forged reports getters and proxies before any IO', async () => {
  const f = await effectsFixture(), runner = makeEffects(f); let hooks = 0; const trap = () => { hooks++; throw Error('RAW_SECRET'); };
  const getter = {}; Object.defineProperty(getter, 'report', { get: trap, enumerable: true });
  for (const input of [{ passed: true }, { snapshots: [] }, getter, new Proxy({}, { ownKeys: trap }), null]) await assert.rejects(runner.run(input), effectsError('invalid-request'));
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0); runner.close();
  await assert.rejects(runner.run({}), effectsError('halted'));
});

test('shadow effects freezes readback provider identity and rejects T17 or replaced methods at config boundary', async () => {
  const f = await effectsFixture(), runner = makeEffects(f); f.ports.readback.readShadowState = () => { throw Error('RAW_REPLACED'); };
  const out = await runner.run({}); assert.equal(out.run.transportCalls, 12);
  const foreign = await setup('T17'); assert.throws(() => makeEffects(foreign), effectsError('invalid-config'));
});

test('shadow effects held initial readback closes permanently without dispatching after late completion', async () => {
  const f = await effectsFixture(); let enter, release; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const raw = f.ports.readback.readShadowState; let request;
  f.ports.readback.readShadowState = r => { request = r; enter(); return held; };
  const runner = makeEffects(f), pending = runner.run({});
  await Promise.race([entered, pending.then(() => { throw Error('unexpected terminal'); }, e => { throw e; })]);
  runner.close(); release(await raw(request)); await assert.rejects(pending, e => effectsError('halted')(e) && e.pendingCompletionUnknown);
  await turn(); assert.equal(posts(f).length, 0); assert.equal(f.calls.filter(c => c.name === 'sealEncryptedArtifact').length, 0);
});

test('shadow effects raw SDK carriers are rejected without async adopting their getters', async () => {
  const f = await effectsFixture(); let hooks = 0; const object = {}, returned = Promise.resolve(object);
  Object.defineProperty(object, 'then', { get() { hooks++; throw Error('RAW_SDK_SECRET'); } });
  f.ports.readback.readShadowState = () => returned;
  await assert.rejects(makeEffects(f).run({}), effectsError('invalid-readback')); assert.equal(hooks, 0); assert.equal(posts(f).length, 0);
});

test('shadow effects state beyond the control object ceiling is complete and late content changes are not truncated', async () => {
  const f = await effectsFixture(); f.effectsState.zeroMutation.pointer.state.long = 'A'.repeat(270000);
  const out = await makeEffects(f).run({}); assert.equal(out.sideEffects.observationCount, 26); assert.equal(out.run.transportCalls, 12);
  const changed = await effectsFixture(s => { s.effectsState.zeroMutation.pointer.state.long = 'A'.repeat(269999) + 'B'; });
  changed.effectsState.zeroMutation.pointer.state.long = 'A'.repeat(270000);
  await assert.rejects(makeEffects(changed).run({}), effectsError('side-effect-mismatch')); assert.equal(posts(changed).length, 1);
});

test('shadow effects absolute POST deadline includes synchronous pre-readback work and prevents overdue dispatch', async () => {
  const f = await effectsFixture(undefined, b => { b.options.deploymentPolicy.registrations.find(p => p.purpose === 'ask').networkPolicy.requestTimeoutMs = 100; });
  f.changeReadback = (out, request) => { if (request.point === 'post-before') {
    const end = performance.now() + 150; while (performance.now() < end) { /* Expose deadline starvation without waiting for timers. */ }
  } };
  const failure = await makeEffects(f).run({}).then(() => null, e => e);
  assert.equal(posts(f).length, 0); assert.ok(effectsError('operation-timeout')(failure));
});

test('shadow effects concurrent busy refusal cannot replace the primary native provider failure', async () => {
  const f = await effectsFixture(); let enter, reject; const entered = new Promise(r => { enter = r; }), held = new Promise((_, r) => { reject = r; });
  f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); enter(); return held; };
  const runner = makeEffects(f), pending = runner.run({});
  await Promise.race([entered, pending.then(() => { throw Error('unexpected terminal'); }, e => { throw e; })]);
  await assert.rejects(runner.run({}), effectsError('busy')); reject(Error('RAW_NATIVE_REJECTION'));
  const failure = await pending.then(() => null, e => e);
  assert.equal(failure.code === 'busy' ? 1 : 0, 0); assert.ok(effectsError('operation-failed')(failure) && failure.requestMayHaveBeenDispatched);
  assert.equal(posts(f).length, 1);
});

test('shadow effects response byte and tree caps are checked before any after-readback dispatch', async () => {
  for (const kind of ['decoded', 'nodes', 'depth']) {
    const f = await effectsFixture(undefined, kind === 'decoded' ? b => { b.options.deploymentPolicy.registrations.find(p => p.purpose === 'ask').networkPolicy.maxResponseBytes = 128; } : undefined);
    const raw = f.ports.transport.post;
    f.ports.transport.post = async request => { const wire = JSON.parse(await raw(request));
      if (kind === 'nodes') wire.extra = Array(200000).fill(null);
      if (kind === 'depth') { wire.extra = {}; let next = wire.extra; for (let i = 0; i < 65; i++) { next.child = {}; next = next.child; } }
      return JSON.stringify(wire);
    };
    const failure = await makeEffects(f).run({}).then(() => null, e => e);
    assert.equal(f.calls.filter(c => c.name === 'readShadowState' && c.request.point === 'post-after').length, 0);
    assert.ok(effectsError('capacity-exhausted')(failure)); assert.equal(posts(f).length, 1);
  }
});

test('shadow effects oversized response envelope is refused before JSON parsing', async t => {
  const f = await effectsFixture(), huge = '{"extra":"' + 'A'.repeat(24 * 1024 * 1024) + '"}'; let oversizedParses = 0;
  const parse = JSON.parse; t.mock.method(JSON, 'parse', function (value, ...args) {
    if (typeof value === 'string' && Buffer.byteLength(value) > 24 * 1024 * 1024) oversizedParses++;
    return Reflect.apply(parse, JSON, [value, ...args]);
  });
  f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); return Promise.resolve(huge); };
  await assert.rejects(makeEffects(f).run({}), effectsError('capacity-exhausted'));
  assert.equal(oversizedParses, 0); assert.equal(f.calls.filter(c => c.name === 'readShadowState' && c.request.point === 'post-after').length, 0);
});

function archivePayload(f, bytes = Buffer.from('RAW_SHADOW_ARCHIVE'), observationIndex = 0) {
  const ask = f.options.askOptions, binding = createReferenceProductionAskDatasetBinding(ask, f.base.rawDatasetJson).bindingProof.binding;
  const registration = ask.deploymentPolicy.registrations.find(p => p.purpose === 'publication-readback');
  return JSON.stringify({ schemaVersion: 'kg-reference-shadow-artifact-payload/v1', observationIndex,
    request: { schemaVersion: 'kg-reference-shadow-state-request/v1', binding, actorId: ask.expectedExecutionPayload.participants.readOnlyId,
      authorizationDigest: ask.executionAuthorizationRef.sha256, providerRegistrationHash: hash(registration), requestNonce: 'f'.repeat(32),
      observedAt: new Date(Date.parse(ask.expectedExecutionPayload.notBefore) + 60000).toISOString(), point: 'run-before',
      requestPlanHash: null, requestBodySha256: null, responseBodySha256: null }, payloadBase64url: bytes.toString('base64url') });
}
const makeShadowWriter = f => shadowWriter.createReferenceShadowArtifactWriter(f.options, f.base.rawDatasetJson,
  { clock: f.ports.clock, kms: f.ports.kms, store: f.ports.store });

test('shadow archive complete native byte framing preserves full eight MiB and reserves receipt ordinal zero', async () => {
  const f = await effectsFixture(), framer = shadowFramer.createReferenceShadowArtifactFramer(f.options.askOptions, f.base.rawDatasetJson);
  const body = Buffer.alloc(8 * 1024 * 1024, 0xc3), frame = framer.frame(archivePayload(f, body, 4999)); frozen(frame.layout);
  assert.equal(frame.layout.parts.length, 128); assert.equal(frame.layout.bodySha256, sha(body)); assert.equal(frame.layout.bodyByteLength, body.length);
  assert.equal(frame.layout.parts[0].aad.ordinal, 639873); assert.equal(frame.layout.parts.at(-1).aad.ordinal, 640000);
  assert.equal(frame.layout.parts.every(p => p.aad.artifactType === 'readback-proof' && p.aad.caseId === null && p.byteLength === 65536), true);
  const parts = frame.layout.parts.map(p => ({ partIndex: p.partIndex, ...frame.forEncryption(p.partIndex) }));
  const proof = frame.verifyDecryptedParts(JSON.stringify({ schemaVersion: 'kg-shadow-decrypted-state-parts/v1', layoutHash: frame.layout.layoutHash, parts }));
  assert.equal(proof.bodySha256, sha(body)); assert.equal(proof.byteLength, body.length); assert.equal(proof.partCount, 128);
  assert.equal(proof.productionAuthorized, false); assert.equal(/RAW_SHADOW_ARCHIVE|payloadBase64url/.test(JSON.stringify(frame.layout)), false);
});

test('shadow archive frame binding rejects foreign source selector budget overruns and caller labels', async () => {
  const f = await effectsFixture(), framer = shadowFramer.createReferenceShadowArtifactFramer(f.options.askOptions, f.base.rawDatasetJson);
  for (const change of [p => { p.request.binding.tenantId = 'foreign'; }, p => { p.request.authorizationDigest = '0'.repeat(64); },
    p => { p.request.providerRegistrationHash = '0'.repeat(64); }, p => { p.request.actorId = f.options.askOptions.expectedExecutionPayload.participants.executorId; },
    p => { p.observationIndex = 5000; }, p => { p.passed = true; }, p => { p.request.point = 'post-after'; }]) {
    const p = JSON.parse(archivePayload(f)); change(p); assert.throws(() => framer.frame(JSON.stringify(p)));
  }
  assert.throws(() => framer.frame(archivePayload(f, Buffer.alloc(8 * 1024 * 1024 + 1))));
  let hooks = 0; assert.throws(() => framer.frame(new Proxy({}, { ownKeys() { hooks++; throw Error('RAW_SECRET'); } }))); assert.equal(hooks, 0);
  assert.equal(f.calls.length, 0);
});

test('shadow archive exact full part readback rejects missing reordered foreign AAD and changed bytes', async () => {
  const f = await effectsFixture(), framer = shadowFramer.createReferenceShadowArtifactFramer(f.options.askOptions, f.base.rawDatasetJson);
  const frame = framer.frame(archivePayload(f, Buffer.alloc(65537, 97)));
  const parts = frame.layout.parts.map(p => ({ partIndex: p.partIndex, ...frame.forEncryption(p.partIndex) }));
  for (const change of [p => { p.parts.pop(); }, p => { p.parts.reverse(); }, p => { p.parts[0].aad.ordinal++; },
    p => { p.parts[0].plaintextBase64url = Buffer.alloc(65536, 98).toString('base64url'); }, p => { p.layoutHash = '0'.repeat(64); }]) {
    const p = { schemaVersion: 'kg-shadow-decrypted-state-parts/v1', layoutHash: frame.layout.layoutHash, parts: clone(parts) }; change(p);
    assert.throws(() => frame.verifyDecryptedParts(JSON.stringify(p)));
  }
  assert.equal(f.calls.length, 0);
});

test('shadow archive actual pinned KMS seal independent read decrypt and clock cover every byte', async () => {
  const f = await effectsFixture(), body = Buffer.alloc(270001, 97), writer = makeShadowWriter(f), payload = archivePayload(f, body);
  const out = await writer.sealReadback(payload); frozen(out); writer.close();
  assert.equal(out.schemaVersion, 'kg-shadow-artifact-observation/v1'); assert.equal(out.bodySha256, sha(body)); assert.equal(out.bodyByteLength, body.length);
  assert.equal(out.partCount, 5); assert.equal(out.encryptedReadbackMatched, true); assert.equal(out.observationIndex, 0);
  assert.equal(out.readbackRequestHash, hash(JSON.parse(payload).request)); assert.equal(Object.hasOwn(out, 'requestPlanHash'), false);
  assert.equal(out.artifactIndex.entries.every(e => e.artifactType === 'readback-proof' && e.ordinal >= 1 && e.ordinal <= 5), true);
  for (const method of ['encryptArtifact', 'sealEncryptedArtifact', 'readExact', 'decryptArtifact']) assert.equal(f.calls.filter(c => c.name === method).length, 5);
  assert.equal(f.calls.filter(c => c.name === 'readTime').length, 21);
  assert.equal(f.calls.filter(c => c.name === 'readExact').every(c => c.request.context.actorId === f.options.askOptions.expectedExecutionPayload.participants.readOnlyId), true);
  assert.equal(out.productionAccepted, false); assert.equal(out.stageAcceptanceComplete, false); assert.equal(out.bodySourceAuthenticated, false);
});

test('shadow archive seal failure permanently fences later fragments and cannot upgrade source authenticity', async () => {
  const f = await effectsFixture(); const original = f.ports.store.readExact;
  f.ports.store.readExact = async request => { const value = clone(await original(request)); value.object.aad.ordinal++; return value; };
  const writer = makeShadowWriter(f); await assert.rejects(writer.sealReadback(archivePayload(f)), e => e.code === 'invalid-readback' && e.mutationMayHaveOccurred);
  const before = f.calls.length; await assert.rejects(writer.sealReadback(archivePayload(f)), e => e.code === 'halted'); assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter(c => c.name === 'decryptArtifact').length, 0);
});

test('shadow archive private consumer seals all twenty six actual state observations with exact correlated indices', async () => {
  const f = await effectsFixture(), readbacks = [], actual = f.ports.readback.readShadowState;
  f.ports.readback.readShadowState = async request => { const raw = await actual(request); readbacks.push({ request, raw }); return raw; };
  const out = await makeEffects(f).run({}); frozen(out);
  assert.equal(out.run.transportCalls, 12); assert.equal(out.sideEffects.observationCount, 26); assert.equal(readbacks.length, 26);
  assert.equal(out.sideEffects.rawReadbacksEncryptedAndMatched, true); assert.equal(out.sideEffects.blockers.includes('readback-raw-artifacts-not-sealed'), false);
  assert.equal(out.sideEffects.comparisonWindow, 'first-to-last-source-observation');
  for (const [index, observation] of out.sideEffects.observations.entries()) {
    assert.equal(observation.archive.observationIndex, index); assert.equal(observation.archive.bodySha256, sha(readbacks[index].raw));
    assert.equal(observation.archive.readbackRequestHash, hash(readbacks[index].request)); assert.equal(observation.archive.encryptedReadbackMatched, true);
    assert.equal(observation.archive.artifactIndex.entries.length, 1); assert.equal(observation.archive.artifactIndex.entries[0].ordinal, 1 + index * 128);
  }
  assert.equal(f.calls.filter(c => c.name === 'sealEncryptedArtifact' && c.request.aad.artifactType === 'readback-proof').length, 26);
  assert.equal(f.calls.filter(c => c.name === 'sealEncryptedArtifact' && c.request.aad.artifactType !== 'readback-proof').length, 48);
  assert.equal(/RAW_|"context":|"prompt":|"question":|"serving":/.test(JSON.stringify(out)), false);
  for (const key of ['productionAccepted', 'stageAcceptanceComplete', 'machineGateComputed', 'sideEffectPolicyVerified', 'sourceAuthenticated']) assert.equal(out[key], false);
});

test('shadow archive private consumer refuses failed exact readback before any Ask deployment or POST', async () => {
  const f = await effectsFixture(), actual = f.ports.store.readExact;
  f.ports.store.readExact = async request => { const out = clone(await actual(request)); if (out.object.aad.artifactType === 'readback-proof') out.proof.readerId = 'foreign'; return out; };
  const runner = makeEffects(f); await assert.rejects(runner.run({}), e => effectsError('invalid-readback')(e) && e.mutationMayHaveOccurred);
  assert.equal(posts(f).length, 0); assert.equal(f.calls.filter(c => c.name === 'readDeployment').length, 0);
  const before = f.calls.length; await assert.rejects(runner.run({}), effectsError('halted')); assert.equal(f.calls.length, before);
});

test('shadow archive late initial seal cannot dispatch independent read decrypt deployment or POST after close', async t => {
  const f = await effectsFixture(), actual = f.ports.store.sealEncryptedArtifact;
  let enter, release; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  f.ports.store.sealEncryptedArtifact = request => { const result = actual(request); enter(); return held.then(() => result); };
  const runner = makeEffects(f), pending = runner.run({});
  t.after(async () => { release(); runner.close(); await pending.catch(() => {}); });
  await Promise.race([entered, pending.then(() => { throw Error('unexpected terminal'); }, e => { throw e; })]);
  runner.close(); const before = f.calls.length; release(); const fault = await pending.then(() => null, e => e);
  assert.ok(effectsError('halted')(fault)); assert.equal(fault.pendingCompletionUnknown, true); assert.equal(fault.mutationMayHaveOccurred, true);
  await turn(); await turn(); assert.equal(f.calls.length, before);
  for (const name of ['readExact', 'decryptArtifact', 'readDeployment', 'post']) assert.equal(f.calls.filter(c => c.name === name).length, 0);
});

test('shadow archive synchronous encrypt overrun preserves the parent POST deadline without later seal or POST', async () => {
  const f = await effectsFixture(undefined, b => { b.options.deploymentPolicy.registrations.find(p => p.purpose === 'ask').networkPolicy.requestTimeoutMs = 100; });
  const actual = f.ports.kms.encryptArtifact;
  f.ports.kms.encryptArtifact = request => { const result = actual(request);
    if (request.aad.artifactType === 'readback-proof' && request.aad.ordinal === 129) {
      const end = performance.now() + 150; while (performance.now() < end) { /* Check the same parent deadline while timers cannot run. */ }
    }
    return result;
  };
  const fault = await makeEffects(f).run({}).then(() => null, e => e);
  assert.ok(effectsError('operation-timeout')(fault)); assert.equal(fault.mutationMayHaveOccurred, true); assert.equal(posts(f).length, 0);
  const rawSeals = f.calls.filter(c => c.name === 'sealEncryptedArtifact' && c.request.aad.artifactType === 'readback-proof');
  assert.equal(rawSeals.length, 1); assert.equal(rawSeals[0].request.aad.ordinal, 1);
});

test('shadow archive every actual raw callback checks the original source window after delayed fresh clock', async () => {
  const f = await effectsFixture(), p = f.options.askOptions.expectedExecutionPayload;
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: p.scope,
    allowedActorIds: [p.participants.executorId, p.participants.readOnlyId], sourceIdentityRef: f.options.artifacts.clockIdentityRef,
    initialObservedAt: new Date(Math.min(Date.parse(p.window.endsAt), Date.parse(p.expiresAt)) - 200).toISOString(),
    uncertaintyMs: 0, maxReadings: 10000, maxAdvanceMs: 86400000 });
  let reads = 0, crossedWindow = false;
  f.ports.clock = { ...flags, readTime(request) {
    f.calls.push({ name: 'readTime', request }); const result = clock.readTime(request);
    if (++reads === 2) { crossedWindow = true; const end = performance.now() + 250;
      while (performance.now() < end) { /* A structurally valid inner reading cannot refresh the original authorization window. */ }
    }
    return result;
  } };
  const fault = await makeEffects(f).run({}).then(() => null, e => e);
  assert.equal(crossedWindow, true); assert.equal(f.calls.filter(c => c.name === 'encryptArtifact').length, 0);
  assert.equal(f.calls.filter(c => c.name === 'sealEncryptedArtifact').length, 0); assert.equal(posts(f).length, 0);
  assert.ok(effectsError('invalid-clock')(fault)); assert.equal(fault.automaticRetryAllowed, false);
});

test('shadow archive source clock retrieval elapsed belongs to its original authorized window before state readback', async () => {
  const f = await effectsFixture(), p = f.options.askOptions.expectedExecutionPayload;
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: p.scope,
    allowedActorIds: [p.participants.executorId, p.participants.readOnlyId], sourceIdentityRef: f.options.artifacts.clockIdentityRef,
    initialObservedAt: new Date(Math.min(Date.parse(p.window.endsAt), Date.parse(p.expiresAt)) - 200).toISOString(),
    uncertaintyMs: 0, maxReadings: 10000, maxAdvanceMs: 86400000 });
  let crossedWindow = false;
  f.ports.clock = { ...flags, readTime(request) { f.calls.push({ name: 'readTime', request }); const result = clock.readTime(request);
    if (!crossedWindow) { crossedWindow = true; const end = performance.now() + 250;
      while (performance.now() < end) { /* Reading transit time is not a fresh authorization interval. */ }
    }
    return result;
  } };
  const fault = await makeEffects(f).run({}).then(() => null, e => e);
  assert.equal(crossedWindow, true); assert.equal(f.calls.filter(c => c.name === 'readShadowState').length, 0);
  assert.equal(f.calls.filter(c => c.name === 'encryptArtifact').length, 0); assert.equal(posts(f).length, 0);
  assert.ok(effectsError('invalid-clock')(fault)); assert.equal(fault.automaticRetryAllowed, false);
});
