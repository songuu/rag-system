import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
  throw e;
} } });
const { fixture, bindDataset, rebindExecution } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const { canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { createReferenceProductionAskDatasetBinding, createReferenceProductionAskEvaluator } = await import('./production-ask-dataset-binding.ts');
const { createReferenceProductionAskArtifactWriter } = await import('./production-ask-artifact-writer.ts');
const { createReferenceAuthorityClock } = await import('./production-authority-ports.ts');
const { createReferenceKmsEnvelope, createReferenceArtifactStore } = await import('./production-controlled-artifacts.ts');
let subject; try { subject = await import('./production-ask-producer.ts'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; subject = {}; }
const clone = x => structuredClone(x), sha = x => createHash('sha256').update(x).digest('hex');
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const flags = { executionProfile: 'local-reference', productionCapable: false };
const arm = (rolloutMode = 'off', phase = 'trial', ordinal = 0) => ({ rolloutMode, phase, ordinal });
const make = f => subject.createReferenceProductionAskProducer(f.options, f.base.rawDatasetJson, f.ports);
const count = (f, name) => f.calls.filter(x => x.name === name).length;
function frozen(x) { if (x && typeof x === 'object') { assert.ok(Object.isFrozen(x)); for (const v of Object.values(x)) frozen(v); } }
const safeError = code => e => typeof subject.ProductionAskProducerError === 'function' && e instanceof subject.ProductionAskProducerError
  && e.code === code && e.productionAccepted === false && e.automaticRetryAllowed === false && Object.isFrozen(e)
  && !Object.hasOwn(e, 'cause') && !/RAW_|secret-token|fixture:|CANARY/.test(e.message);
function deployment(f, plan) {
  const b = f.base.options.manifest.base, r = plan.requestIdentity;
  return { schemaVersion: 'kg-reference-ask-deployment/v1', requestPlanHash: plan.planHash,
    origin: plan.target.origin, providerRegistrationHash: plan.providerRegistrationHash,
    scope: clone(plan.binding), rolloutMode: r.rolloutMode, sharedConfigHash: r.sharedConfigHash,
    armConfigHash: r.armConfigHash, models: { llm: b.models.llm.id, embedding: b.models.embedding.id }, parameters: clone(b.parameters) };
}
function response(f, request, changes = {}) {
  const body = JSON.parse(Buffer.from(request.bodyBase64url, 'base64url').toString('utf8'));
  const index = f.base.dataset.cases.findIndex(c => c.id === request.requestPlan.requestIdentity.caseId);
  const e = clone(f.base.dataset.corpus[0]); delete e.metadata;
  const payload = { success: true, question: body.question, answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '',
    models: { llm: body.llmModel, embedding: body.embeddingModel }, storageBackend: 'milvus', traceId: 'trace-' + index,
    evidence: index === 0 ? [{ ...e, id: e.evidenceId, retrievalScore: 1, laneId: 'dense', startOffset: 0, endOffset: 7 }] : [],
    citations: index === 0 ? [{ evidenceId: e.evidenceId, startOffset: 0, endOffset: 7 }] : [],
    laneExecutions: [{ laneId: 'dense', status: 'completed' }],
    retrievalDetails: { graph: { requestedMode: request.requestPlan.requestIdentity.rolloutMode },
      abstention: { mode: 'active', abstain: index !== 0 }, searchTime: 1, vectorizationTime: 0, llmTime: 2 }, ...changes };
  const bytes = Buffer.from(JSON.stringify(payload));
  return { schemaVersion: 'kg-reference-ask-response/v1', requestPlanHash: request.requestPlan.planHash,
    requestBodySha256: request.bodySha256, deploymentHash: request.deploymentHash, url: request.requestPlan.target.url, status: 200,
    headers: { 'x-rag-policy': 'strict-grounding', 'x-rag-trace-id': payload.traceId, 'x-rag-status': 'completed' },
    bodyBase64url: bytes.toString('base64url'),
    measurement: { schemaVersion: 'kg-reference-ask-measurement/v1', requestPlanHash: request.requestPlan.planHash,
      requestBodySha256: request.bodySha256, responseBodySha256: sha(bytes), abstained: index !== 0,
      usage: { retrievalLatencyMs: 1, generationLatencyMs: 2, totalLatencyMs: 3, tokenMeasurement: 'unavailable',
        costMeasurement: 'unavailable', embeddingCalls: 1, generationCalls: 1 } } };
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
  const storeRef = ref('producer-store'), clockRef = ref('producer-clock');
  const store = createReferenceArtifactStore({ ...common, storeIdentityRef: storeRef, maxObjectBytes: 256 * 1024 });
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: p.scope,
    allowedActorIds: [p.participants.executorId, p.participants.readOnlyId], sourceIdentityRef: clockRef,
    initialObservedAt: at, uncertaintyMs: 1, maxReadings: 10000, maxAdvanceMs: 86400000 });
  const f = { base, binding, kms, store, clock, calls: [] };
  const own = (native, names) => ({ ...flags, ...Object.fromEntries(names.map(name => [name, function (request) {
    f.calls.push({ name, request }); return Reflect.apply(native[name], native, [request]);
  }])) });
  f.ports = { clock: own(clock, ['readTime']), kms: own(kms, ['encryptArtifact', 'decryptArtifact']), store: own(store, ['sealEncryptedArtifact', 'readExact']),
    transport: { ...flags, readDeployment(plan) { f.calls.push({ name: 'readDeployment', request: plan }); return Promise.resolve(JSON.stringify(deployment(f, plan))); },
      post(request) { f.calls.push({ name: 'post', request }); return Promise.resolve(JSON.stringify(response(f, request))); } } };
  f.options = { executionProfile: 'local-reference', askOptions: clone(base.options), artifacts: { expectedKeyRef: clone(expectedKeyRef), storeIdentityRef: storeRef,
    clockIdentityRef: clockRef, maxClockUncertaintyMs: 10, retainUntil: new Date(Date.parse(p.window.endsAt) + 3600000).toISOString(), operationTimeoutMs: 10000 } };
  return f;
}
async function goldOracle(f) {
  const evaluator = createReferenceProductionAskEvaluator(f.base.options, f.base.rawDatasetJson);
  const entries = f.base.dataset.cases.map((c, i) => {
    const e = clone(f.base.dataset.corpus[0]); delete e.metadata;
    return { request: { caseId: c.id, ...arm() }, result: { answer: i === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '', abstained: i !== 0,
      evidence: i === 0 ? [{ ...e, score: 1, laneId: 'dense' }] : [], citations: i === 0 ? [{ evidenceId: e.evidenceId, startOffset: 0, endOffset: 7 }] : [],
      policyId: 'strict-grounding', laneIds: ['dense'], usage: response(f, { requestPlan: createReferenceProductionAskDatasetBinding(f.base.options, f.base.rawDatasetJson).planRequest({ caseId: c.id, ...arm() }).requestPlan,
        bodyBase64url: Buffer.from(JSON.stringify({ question: c.query })).toString('base64url'), bodySha256: sha(''), deploymentHash: hash('') }).measurement.usage } };
  });
  return evaluator.evaluateReferenceResults(JSON.stringify({ schemaVersion: 'kg-reference-ask-results/v1', bindingHash: evaluator.bindingProof.bindingHash, entries }));
}

test('existing dataset oracle and actual encrypted writer fixture are valid before producer exists', async () => {
  const f = await setup(), proof = await goldOracle(f); assert.equal(proof.summary.completedCases, 2);
  const writer = createReferenceProductionAskArtifactWriter(f.options, f.base.rawDatasetJson, { clock: f.ports.clock, kms: f.ports.kms, store: f.ports.store });
  const out = await writer.sealReadback(JSON.stringify({ schemaVersion: 'kg-reference-ask-artifact-payload/v1', request: { caseId: f.base.dataset.cases[0].id, ...arm() },
    artifactType: 'gold', payloadBase64url: Buffer.from(f.base.rawDatasetJson).toString('base64url') }));
  assert.equal(out.bodySha256, sha(f.base.rawDatasetJson)); assert.equal(out.encryptedReadbackMatched, true);
});

test('producer owns queries, complete raw gold and actual response bytes through original writer and oracle', async () => {
  const f = await setup(), expected = await goldOracle(f), producer = make(f); frozen(producer); assert.equal(f.calls.length, 0);
  const proof = await producer.runArm(arm()); frozen(proof);
  assert.equal(proof.schemaVersion, 'kg-reference-ask-producer-run/v1'); assert.deepEqual(proof.evaluation.summary, expected.summary);
  assert.equal(proof.measurements.schemaVersion, 'kg-reference-ask-measurements/v1'); assert.deepEqual(proof.measurements.evaluation, proof.evaluation);
  assert.equal(proof.measurements.caseMeasurements.length, proof.cases.length); assert.equal(proof.measurements.caseMeasurements[0].usage.totalLatencyMs, 3);
  assert.equal(proof.cases.length, 2); assert.equal(proof.transportCalls, 2); assert.equal(proof.requestBodiesOwned, true);
  assert.equal(proof.transportCallsObserved, true); assert.equal(proof.oracleConsumed, true);
  for (const key of ['productionAccepted', 'stageAcceptanceComplete', 'registryAuthenticated', 'networkEnforced', 'serverBindingAuthenticated']) assert.equal(proof[key], false);
  assert.equal(count(f, 'post'), 2); assert.equal(count(f, 'sealEncryptedArtifact'), 8);
  for (const c of proof.cases) assert.deepEqual(c.artifacts.map(x => x.artifactType), ['request', 'gold', 'response', 'telemetry']);
  for (const c of proof.cases) assert.equal(c.artifacts[1].observation.bodySha256, sha(f.base.rawDatasetJson));
  for (const post of f.calls.filter(x => x.name === 'post')) {
    frozen(post.request); const body = JSON.parse(Buffer.from(post.request.bodyBase64url, 'base64url').toString());
    assert.deepEqual(Object.keys(body).sort(), ['question', 'topK', 'corpusId', 'llmModel', 'embeddingModel', 'storageBackend', 'executionMode', 'maxRetries'].sort());
    assert.equal(body.topK, 8); assert.equal(body.storageBackend, 'milvus'); assert.equal(body.maxRetries, 0);
    assert.equal(JSON.stringify(post.request).includes('RAW_EXPECTED_FACT_CANARY'), false);
    assert.equal(JSON.stringify(post.request).includes('RAW_SECURITY_PATTERN_CANARY'), false);
  }
  for (const marker of ['RAW_QUERY_CANARY', 'RAW_EXPECTED_FACT_CANARY', 'RAW_SECURITY_PATTERN_CANARY', 'fixture://']) assert.equal(JSON.stringify(proof).includes(marker), false);
});

test('full approved arm and warmup trial slots are distinct without caller case/body/result injection', async () => {
  for (const stage of ['T16', 'T17']) {
    const f = await setup(stage), producer = make(f), policy = f.base.options.manifest[stage === 'T16' ? 't16' : 't17'];
    for (const mode of ['off', stage === 'T16' ? 'shadow' : 'active']) for (const phase of ['warmup', 'trial']) {
      const size = policy.sampling[phase === 'trial' ? 'trialCount' : 'warmupCount'];
      for (let n = 0; n < size; n++) { const proof = await producer.runArm(arm(mode, phase, n)); assert.equal(proof.cases.length, 2); }
    }
    const posts = f.calls.filter(x => x.name === 'post'); assert.equal(posts.length, 4 * (policy.sampling.trialCount + policy.sampling.warmupCount));
    assert.equal(new Set(posts.map(x => x.request.requestPlan.planHash)).size, posts.length);
    await assert.rejects(producer.runArm(arm()), safeError('already-executed'));
  }
});

test('dataset hash mismatch and topK 51 reject configuration before any port or business IO', async () => {
  const f = await setup(); const changed = clone(f.base.dataset); changed.cases[0].query += '-swap';
  assert.throws(() => subject.createReferenceProductionAskProducer(f.options, JSON.stringify(changed), f.ports), safeError('invalid-config'));
  const g = await setup('T16', b => { b.options.manifest.base.parameters.topK = 51; });
  assert.throws(() => make(g), safeError('invalid-config')); assert.equal(f.calls.length + g.calls.length, 0);
});

test('config and port carriers never invoke accessors, Proxy traps or upgrade to enterprise', async () => {
  const f = await setup(); let hooks = 0; const trap = () => { hooks++; throw Error('secret-token'); };
  for (const options of [null, { ...f.options, executionProfile: 'enterprise' }, { ...f.options, extra: true }, new Proxy(f.options, { get: trap, ownKeys: trap })]) {
    assert.throws(() => subject.createReferenceProductionAskProducer(options, f.base.rawDatasetJson, f.ports), safeError('invalid-config'));
  }
  const ports = { ...f.ports }; Object.defineProperty(ports, 'transport', { enumerable: true, get: trap });
  assert.throws(() => subject.createReferenceProductionAskProducer(f.options, f.base.rawDatasetJson, ports), safeError('invalid-config'));
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
});

test('malformed arm requests cannot choose endpoint, credentials, body, results or roster case', async () => {
  const f = await setup(), producer = make(f); let hooks = 0;
  for (const input of [null, { ...arm(), caseId: f.base.dataset.cases[0].id }, { ...arm(), body: 'RAW_QUERY_CANARY' },
    { ...arm(), result: {} }, { ...arm(), url: 'https://evil.test' }, { ...arm(), ordinal: 999 },
    { ...arm(), rolloutMode: 'active' }, new Proxy(arm(), { get() { hooks++; } })]) {
    await assert.rejects(producer.runArm(input), safeError('invalid-request'));
  }
  await assert.rejects(producer.runArm(arm(), {}), safeError('invalid-request'));
  assert.equal(hooks, 0); assert.equal(f.calls.length, 0);
});

test('deployment scope arm parameters model and origin mismatches fence before request or gold sealing', async () => {
  for (const mutate of [x => { x.scope.tenantId = 'other'; }, x => { x.rolloutMode = 'shadow'; }, x => { x.origin = 'https://evil.test'; },
    x => { x.armConfigHash = hash('swap'); }, x => { x.models.llm = 'wrong'; }, x => { x.parameters.topK = 7; }]) {
    const f = await setup(); f.ports.transport.readDeployment = plan => { const d = deployment(f, plan); mutate(d); return Promise.resolve(JSON.stringify(d)); };
    await assert.rejects(make(f).runArm(arm()), safeError('invalid-deployment')); assert.equal(count(f, 'post') + count(f, 'encryptArtifact'), 0);
  }
});

test('request and full gold must actually seal and independently read back before any post', async () => {
  const f = await setup(); f.ports.store.readExact = () => Promise.reject(Error('RAW_SECRET_STORE'));
  await assert.rejects(make(f).runArm(arm()), safeError('artifact-failed')); assert.equal(count(f, 'post'), 0);
});

test('response identity bytes trace and measurement swaps halt before the next corpus request', async () => {
  for (const mutate of [x => { x.requestPlanHash = hash('swap'); }, x => { x.requestBodySha256 = hash('swap'); }, x => { x.url = 'https://evil.test'; },
    x => { x.measurement.responseBodySha256 = hash('swap'); }, x => { x.headers['x-rag-trace-id'] = 'wrong'; }, x => { x.bodyBase64url += '='; }]) {
    const f = await setup(); f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); const r = response(f, request); mutate(r); return Promise.resolve(JSON.stringify(r)); };
    await assert.rejects(make(f).runArm(arm()), safeError('invalid-response')); assert.equal(count(f, 'post'), 1);
  }
});

test('original oracle rejects forged provenance and stops further transport without copying its error', async () => {
  const f = await setup(); f.ports.transport.post = request => { f.calls.push({ name: 'post', request });
    const r = response(f, request), body = JSON.parse(Buffer.from(r.bodyBase64url, 'base64url').toString()); body.evidence[0].documentVersion = 'forged';
    const bytes = Buffer.from(JSON.stringify(body)); r.bodyBase64url = bytes.toString('base64url'); r.measurement.responseBodySha256 = sha(bytes); return Promise.resolve(JSON.stringify(r)); };
  await assert.rejects(make(f).runArm(arm()), safeError('oracle-failed')); assert.equal(count(f, 'post'), 1);
});

test('HTTP failure preserves complete error body in encrypted sink and never returns a complete arm proof', async () => {
  const f = await setup(); const errorBytes = Buffer.from('{"error":"RAW_SECRET_HTTP_FAILURE"}');
  f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); const r = response(f, request); r.status = 503;
    r.bodyBase64url = errorBytes.toString('base64url'); r.measurement.responseBodySha256 = sha(errorBytes); return Promise.resolve(JSON.stringify(r)); };
  const producer = make(f); await assert.rejects(producer.runArm(arm()), safeError('request-failed'));
  const encrypted = f.calls.filter(x => x.name === 'encryptArtifact').map(x => Buffer.from(x.request.plaintextBase64url, 'base64url'));
  assert.ok(encrypted.some(x => x.equals(errorBytes))); assert.equal(count(f, 'post'), 1);
  await assert.rejects(producer.runArm(arm('shadow')), safeError('halted'));
});

test('unknown token and cost measurements stay unavailable and missing call counts are never fabricated', async () => {
  const f = await setup(), proof = await make(f).runArm(arm());
  assert.equal(proof.evaluation.summary.tokens.inputTotal, null); assert.equal(proof.evaluation.summary.costUsd.total, null);
  const g = await setup(); g.ports.transport.post = request => { g.calls.push({ name: 'post', request }); const r = response(g, request); delete r.measurement.usage.embeddingCalls; return Promise.resolve(JSON.stringify(r)); };
  await assert.rejects(make(g).runArm(arm()), safeError('invalid-response')); assert.equal(count(g, 'post'), 1);
});

test('missing structured citations are explicitly absent and cannot claim complete citation coverage', async () => {
  const f = await setup(); f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); return Promise.resolve(JSON.stringify(response(f, request, { citations: undefined }))); };
  const proof = await make(f).runArm(arm()); assert.equal(proof.cases[0].citationSource, 'absent'); assert.equal(proof.evaluation.summary.citation.meanCoverage, 0);
});

test('captured transport receiver and methods survive caller replacement without mutable artifact observations', async () => {
  const f = await setup(), producer = make(f); f.ports.transport.post = () => { throw Error('RAW_REPLACEMENT'); };
  const proof = await producer.runArm(arm()); assert.equal(proof.transportCalls, 2); frozen(proof);
});

test('the complete 64-case roster and every encrypted index survive a proof larger than the control-object budget', async () => {
  const f = await setup('T16', b => {
    const data = clone(b.dataset), original = clone(data.cases);
    data.cases = Array.from({ length: 64 }, (_, i) => ({ ...clone(original[i === 0 ? 0 : 1]), id: (i + 1).toString(16).padStart(32, '0') }));
    bindDataset(b, data, { updateRoster: true });
  });
  const proof = await make(f).runArm(arm());
  assert.equal(proof.cases.length, 64); assert.equal(proof.evaluation.summary.completedCases, 64);
  assert.equal(proof.transportCalls, 64); assert.equal(count(f, 'post'), 64);
  assert.equal(proof.cases.reduce((n, x) => n + x.artifacts.length, 0), 256);
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) > 256 * 1024);
  assert.match(proof.proofHash, /^[a-f0-9]{64}$/);
});

test('late transport timeout remains UNKNOWN, closes owned writer and never dispatches a next case', async () => {
  const f = await setup('T16', b => { b.options.deploymentPolicy.registrations.find(x => x.purpose === 'ask').networkPolicy.requestTimeoutMs = 30; });
  let release; f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); return new Promise(resolve => { release = () => resolve(JSON.stringify(response(f, request))); }); };
  const producer = make(f); await assert.rejects(producer.runArm(arm()), e => safeError('operation-timeout')(e) && e.pendingCompletionUnknown && e.requestMayHaveBeenDispatched);
  const reads = f.calls.length; release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, reads); await assert.rejects(producer.runArm(arm('shadow')), safeError('halted'));
});

test('a synchronous post overrun preserves pending UNKNOWN at the whole-case deadline', async () => {
  const f = await setup('T16', b => { b.options.deploymentPolicy.registrations.find(x => x.purpose === 'ask').networkPolicy.requestTimeoutMs = 50; });
  f.options.artifacts.operationTimeoutMs = 100;
  let release;
  f.ports.transport.post = request => {
    f.calls.push({ name: 'post', request });
    const end = performance.now() + 600; while (performance.now() < end) { /* Native synchronous work cannot be cancelled. */ }
    return new Promise(resolve => { release = () => resolve(JSON.stringify(response(f, request))); });
  };
  const producer = make(f);
  try {
    await assert.rejects(producer.runArm(arm()), e => safeError('operation-timeout')(e)
      && e.pendingCompletionUnknown === true && e.requestMayHaveBeenDispatched === true);
  } finally { release?.(); }
  const reads = f.calls.length; await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(count(f, 'post'), 1); assert.equal(f.calls.length, reads);
  await assert.rejects(producer.runArm(arm('shadow')), safeError('halted'));
});

test('measured call and token counts reject fractional or unsafe integers without fabricated totals', async () => {
  for (const [key, value] of [['embeddingCalls', 0.5], ['generationCalls', Number.MAX_SAFE_INTEGER + 1], ['inputTokens', 1.5]]) {
    const f = await setup();
    f.ports.transport.post = request => {
      f.calls.push({ name: 'post', request }); const r = response(f, request);
      if (key === 'inputTokens') { r.measurement.usage.tokenMeasurement = 'provider'; r.measurement.usage.outputTokens = 1; }
      r.measurement.usage[key] = value; return Promise.resolve(JSON.stringify(r));
    };
    await assert.rejects(make(f).runArm(arm()), safeError('invalid-response'));
    assert.equal(count(f, 'post'), 1);
  }
});

test('whole-arm result capacity stops before the next post without truncating earlier encrypted responses', async () => {
  const f = await setup('T16', b => {
    const data = clone(b.dataset), original = clone(data.cases);
    data.cases = Array.from({ length: 8 }, (_, i) => ({ ...clone(original[i === 0 ? 0 : 1]), id: (i + 1).toString(16).padStart(32, '0') }));
    bindDataset(b, data, { updateRoster: true });
  });
  let maximumBodyBytes = 0;
  f.ports.transport.post = request => {
    f.calls.push({ name: 'post', request }); const r = response(f, request);
    const body = JSON.parse(Buffer.from(r.bodyBase64url, 'base64url').toString('utf8'));
    body.answer += 'x'.repeat(1536 * 1024); const bytes = Buffer.from(JSON.stringify(body));
    maximumBodyBytes = Math.max(maximumBodyBytes, bytes.length);
    r.bodyBase64url = bytes.toString('base64url'); r.measurement.responseBodySha256 = sha(bytes);
    return Promise.resolve(JSON.stringify(r));
  };
  const producer = make(f);
  await assert.rejects(producer.runArm(arm()), safeError('capacity-exhausted'));
  assert.equal(count(f, 'post'), 6);
  assert.ok(maximumBodyBytes < f.base.options.deploymentPolicy.registrations.find(x => x.purpose === 'ask').networkPolicy.maxResponseBytes);
  const responseParts = f.calls.filter(x => x.name === 'encryptArtifact').map(x => Buffer.from(x.request.plaintextBase64url, 'base64url'));
  assert.ok(responseParts.reduce((n, x) => n + x.length, 0) > 8 * 1024 * 1024);
  const reads = f.calls.length; await assert.rejects(producer.runArm(arm('shadow')), safeError('halted'));
  assert.equal(f.calls.length, reads);
});

test('busy and explicit close preserve permanent fencing even when a pending deployment settles later', async () => {
  const f = await setup(); let release;
  f.ports.transport.readDeployment = plan => new Promise(resolve => { release = () => resolve(JSON.stringify(deployment(f, plan))); });
  const producer = make(f), pending = producer.runArm(arm()); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(producer.runArm(arm('shadow')), safeError('busy')); producer.close(); release();
  await assert.rejects(pending, safeError('halted')); assert.equal(count(f, 'post') + count(f, 'encryptArtifact'), 0);
});

test('non200 without measurement seals complete actual error bytes while 200 or invalid measurements remain strict', async () => {
  const f = await setup(), errorBytes = Buffer.from('complete synthetic HTTP failure');
  f.ports.transport.post = request => { f.calls.push({ name: 'post', request }); const r = response(f, request);
    r.status = 503; r.bodyBase64url = errorBytes.toString('base64url'); delete r.measurement; return Promise.resolve(JSON.stringify(r)); };
  await assert.rejects(make(f).runArm(arm()), safeError('request-failed'));
  assert.equal(count(f, 'post'), 1); assert.equal(count(f, 'sealEncryptedArtifact'), 4);
  assert.ok(f.calls.filter(x => x.name === 'encryptArtifact').some(x => Buffer.from(x.request.plaintextBase64url, 'base64url').equals(errorBytes)));
  for (const mutate of [r => { delete r.measurement; }, r => { r.status = 503; r.measurement.responseBodySha256 = sha('swap'); }]) {
    const g = await setup(); g.ports.transport.post = request => { g.calls.push({ name: 'post', request }); const r = response(g, request);
      mutate(r); return Promise.resolve(JSON.stringify(r)); };
    await assert.rejects(make(g).runArm(arm()), safeError('invalid-response')); assert.equal(count(g, 'post'), 1);
  }
});

test('optional transport close is captured once and synchronously fenced on explicit close or failure without exposing throws', async () => {
  for (const explicit of [true, false]) {
    const f = await setup(); let closes = 0;
    f.ports.transport.close = () => { closes++; throw Error('RAW_CLOSE_SECRET'); };
    f.ports.transport.post = () => Promise.reject(Error('RAW_TRANSPORT_SECRET'));
    const producer = make(f);
    if (explicit) producer.close(); else await assert.rejects(producer.runArm(arm()), safeError('invalid-response'));
    producer.close(); assert.equal(closes, 1); await assert.rejects(producer.runArm(arm('shadow')), safeError('halted'));
  }
});

test('already rejected close return is synchronously handled before queued dispatch can expire', async () => {
  const f = await setup(); let closes = 0;
  f.ports.transport.close = () => { closes++; return Promise.reject(Error('RAW_CLOSE_SECRET')); };
  const producer = make(f); producer.close();
  const until = performance.now() + 10; while (performance.now() < until) { /* Force the queued 1ms observer past dispatch. */ }
  await new Promise(resolve => setImmediate(resolve)); producer.close(); assert.equal(closes, 1);
});
