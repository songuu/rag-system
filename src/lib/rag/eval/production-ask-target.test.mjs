import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { canonicalJson, canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { manifest: manifestFixture, arm } = await import('./production-manifest-fixtures.test-support.mjs');
const { fixture: providerFixture } = await import('./production-provider-fixtures.test-support.mjs');
const { validateManifestExecutionBinding } = await import('./production-gate-manifest.ts');
const { validateProviderTrustPolicy } = await import('./production-provider-trust.ts');
let subject;
try { subject = await import('./production-ask-target.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = (name, digest = hash(name)) => ({ objectId: name, objectVersion: 'v1', sha256: digest });
const policyName = stage => ({ T16: 't16', T17: 't17', R18: 'retention' })[stage];
const commonConfig = base => ({ artifacts: base.artifacts, models: base.models, indexIdentity: base.indexIdentity, parameters: base.parameters });

// Fixture correspondence is derived from raw policy/manifest fields, never from
// the planner or a binding validator's output. The approval ref is synthetic;
// no signature, registry authenticity or runtime network behavior is claimed.
function rebind(f) {
  const options = f.options; const manifest = options.manifest; const base = manifest.base; const policy = manifest[policyName(f.stage)];
  options.policyRef = { ...options.policyRef, sha256: hash(options.deploymentPolicy) };
  base.providers.registryRef = clone(options.policyRef);
  base.sharedConfigHash = hash(commonConfig(base));
  if (policy.arms) policy.arms = Object.fromEntries(Object.keys(policy.arms).map(mode => [mode, arm(base, mode)]));
  const thresholds = { schemaVersion: 'kg-stage-thresholds/v1', stage: f.stage, hardGates: base.hardGates,
    quality: policy.quality ?? null, sampling: policy.sampling ?? null, sideEffectPolicy: policy.sideEffectPolicy ?? null,
    rampAbort: policy.rampPlan?.abort ?? null, retentionPolicy: f.stage === 'R18' ? policy.frozenRetention.policy : null };
  const unsignedPolicy = Object.fromEntries(Object.entries(policy).filter(([name]) => name !== 'executionAuthorizationRef'));
  const manifestHash = hash({ schemaVersion: manifest.schemaVersion, stage: f.stage, base, policy: unsignedPolicy });
  const payload = options.expectedExecutionPayload;
  Object.assign(payload, { manifestHash, registryRef: clone(options.policyRef), providersHash: hash(base.providers), thresholdsHash: hash(thresholds) });
  const syntheticEnvelope = { schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload: clone(payload),
    signature: { algorithm: 'Ed25519', keyId: 'synthetic-shape-only', keyVersion: 'v1', value: Buffer.alloc(64).toString('base64url') } };
  options.executionAuthorizationRef = ref(`execution-${f.stage.toLowerCase()}`, hash(syntheticEnvelope));
  policy.executionAuthorizationRef = clone(options.executionAuthorizationRef);
  const identities = { datasetHash: base.dataset.normalizedSha256, rosterHash: base.dataset.rosterSha256, sharedConfigHash: base.sharedConfigHash,
    artifactsHash: hash(base.artifacts), indexIdentityRef: clone(base.indexIdentity.publicationIdentityRef), registryRef: clone(options.policyRef),
    providersHash: hash(base.providers), thresholdsHash: hash(thresholds),
    armConfigHashes: policy.arms ? Object.fromEntries(Object.entries(policy.arms).map(([mode, value]) => [mode, value.armConfigHash])) : null };
  f.expectedBinding = { validationLevel: 'structural-only', productionAuthorized: false, stage: f.stage, scope: clone(payload.scope),
    runNonce: payload.runNonce, manifestHash, executionAuthorizationRef: clone(options.executionAuthorizationRef), providers: clone(base.providers),
    identities, thresholdsProfile: 'kg-stage-thresholds/v1', thresholds: clone(thresholds), predecessor: clone(policy.predecessor ?? null),
    frozenRetention: clone(policy.frozenRetention ?? null), elapsedEvidenceRef: clone(f.stage === 'R18' ? policy.elapsedEvidenceRef : null) };
}
function fixture(stage = 'T16') {
  const manifest = manifestFixture(stage);
  // Give the valid R18 fixture an ask binding too: its rejection must be the
  // explicit stage restriction, not absence of a selected provider.
  const providers = providerFixture(stage === 'R18' ? 'T16' : stage);
  manifest.base.providers = clone(providers.request.providers);
  const scope = Object.fromEntries(['environment', 'tenantId', 'corpusId'].map(name => [name, manifest.base.scope[name]]));
  const window = stage === 'T17' ? { startsAt: manifest.t17.window.startsAt, endsAt: manifest.t17.window.endsAt }
    : { startsAt: '2026-10-09T04:00:00.000Z', endsAt: '2026-10-09T05:00:00.000Z' };
  const participants = { executionApproverId: 'execution-approver', executorId: 'executor', readOnlyId: 'independent-reader',
    resultAuthorityId: 'synthetic-result-authority', recoveryAuthorityId: stage === 'T17' ? manifest.t17.recoveryPolicy.authorityId : null };
  const payload = { stage, scope, runNonce: manifest.base.runNonce, manifestHash: hash('draft'), authorizationId: `execution-${stage.toLowerCase()}`,
    nonce: '3'.repeat(32), issuerId: participants.executionApproverId, participants,
    issuedAt: new Date(Date.parse(window.startsAt) + 5000).toISOString(), notBefore: new Date(Date.parse(window.startsAt) + 10000).toISOString(),
    expiresAt: new Date(Date.parse(window.endsAt) - 10000).toISOString(),
    operation: stage === 'T16' ? 'execute-t16-shadow' : stage === 'T17' ? 'execute-t17-canary' : 'verify-retention',
    registryRef: clone(providers.policyRef), providersHash: hash(manifest.base.providers), thresholdsHash: hash('draft-thresholds'), window };
  const options = { executionProfile: 'local-reference', manifest, expectedExecutionPayload: payload,
    executionAuthorizationRef: ref('draft-authorization'), deploymentPolicy: clone(providers.policy), policyRef: clone(providers.policyRef) };
  const f = { stage, options }; rebind(f); return f;
}
const bindingInput = f => ({ manifest: f.options.manifest, expectedExecutionPayload: f.options.expectedExecutionPayload,
  executionAuthorizationRef: f.options.executionAuthorizationRef });
const request = (f, changes = {}) => ({ caseId: f.options.manifest.base.dataset.roster[0], rolloutMode: 'off', phase: 'trial', ordinal: 0, ...changes });
const selected = f => {
  const binding = f.options.manifest.base.providers.bindings.find(value => value.purpose === 'ask');
  const registration = f.options.deploymentPolicy.registrations.find(value => value.purpose === binding.purpose && value.providerId === binding.providerId);
  return { binding, registration };
};
const create = f => subject.createReferenceProductionAskTargetPlanner(f.options);
const failure = (code, phase) => error => error instanceof subject.ProductionAskTargetPlanError && error.code === code && error.phase === phase
  && error.productionAuthorized === false && error.automaticRetryAllowed === false && Object.isFrozen(error)
  && !/secret-token|raw-question|raw-gold|ask\.example\.test/.test(error.message);
const configFailure = failure('invalid-config', 'configuration');
const requestFailure = failure('invalid-request', 'request');
function expectedCore(f, input) {
  const options = f.options; const payload = options.expectedExecutionPayload; const { binding, registration } = selected(f);
  const startsAt = new Date(Math.max(Date.parse(payload.window.startsAt), Date.parse(payload.issuedAt), Date.parse(payload.notBefore))).toISOString();
  const endsAt = new Date(Math.min(Date.parse(payload.window.endsAt), Date.parse(payload.expiresAt))).toISOString();
  const identity = f.expectedBinding.identities;
  return { schemaVersion: 'kg-production-ask-request-plan/v1', validationLevel: 'local-reference-ask-target-plan', classification: 'confidential', productionAuthorized: false,
    stageAcceptanceComplete: false, executionAuthorized: false, registryAuthenticated: false, networkEnforced: false, rawDatasetVerified: false,
    manifestRosterMembershipVerified: true, stage: f.stage,
    binding: { ...payload.scope, runNonce: payload.runNonce, manifestHash: payload.manifestHash }, executionAuthorizationRef: options.executionAuthorizationRef,
    registryRef: options.policyRef, providerBinding: binding, providerRegistrationHash: hash(registration), configurationHash: hash(options),
    target: { method: 'POST', origin: registration.endpointOrigin, url: `${registration.endpointOrigin}/api/ask`, networkPolicy: registration.networkPolicy,
      credentialPolicyRef: registration.credentialPolicyRef }, requestIdentity: { ...input, datasetHash: identity.datasetHash, rosterHash: identity.rosterHash,
      sharedConfigHash: identity.sharedConfigHash, armConfigHash: identity.armConfigHashes[input.rolloutMode] }, effectiveWindow: { startsAt, endsAt } };
}

test('production Ask target planner and owned static error entry points exist', () => {
  assert.equal(typeof subject.createReferenceProductionAskTargetPlanner, 'function'); assert.equal(typeof subject.ProductionAskTargetPlanError, 'function');
});
test('T16 and T17 plans exactly bind complete raw manifest, independent policy registration, arm and roster request hashes', () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
    const policy = validateProviderTrustPolicy(f.options.deploymentPolicy); assert.equal(policy.policyHash, f.options.policyRef.sha256);
    const planner = create(f); const input = request(f); const result = planner.planRequest(input); const core = expectedCore(f, input);
    assert.deepEqual(result, { ...core, planHash: hash(core) }); assert.ok(Object.isFrozen(planner)); assert.ok(Object.isFrozen(result));
    assert.equal(planner.executionProfile, 'local-reference'); assert.equal(planner.productionCapable, false);
    assert.equal(typeof result.then, 'undefined'); assert.ok(Object.isFrozen(result.target.networkPolicy));
    assert.ok(Object.isFrozen(result.target.credentialPolicyRef)); assert.ok(Object.isFrozen(result.requestIdentity));
    assert.equal(/"manifest"|"deploymentPolicy"|"signature"|"headers"|raw-question|raw-gold/.test(canonicalJson(result)), false);
  }
});
test('paired arms keep common configuration and request roster identities while their exact arm config hashes differ', () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); const planner = create(f); const candidate = stage === 'T16' ? 'shadow' : 'active';
    const off = planner.planRequest(request(f)); const other = planner.planRequest(request(f, { rolloutMode: candidate }));
    assert.equal(off.requestIdentity.sharedConfigHash, other.requestIdentity.sharedConfigHash);
    assert.equal(off.requestIdentity.datasetHash, other.requestIdentity.datasetHash); assert.equal(off.requestIdentity.rosterHash, other.requestIdentity.rosterHash);
    assert.notEqual(off.requestIdentity.armConfigHash, other.requestIdentity.armConfigHash); assert.notEqual(off.planHash, other.planHash);
    assert.deepEqual(off.target, other.target);
  }
});
test('stage restriction rejects a fully bound R18 manifest even with a valid selected Ask registration', () => {
  const f = fixture('R18'); assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
  assert.equal(validateProviderTrustPolicy(f.options.deploymentPolicy).productionAuthorized, false); assert.ok(selected(f).registration);
  assert.throws(() => create(f), configFailure);
});
test('raw manifest, scope, run, execution ref, providers and threshold substitutions cannot create a planner', () => {
  for (const change of [o => { o.manifest.base.dataset.normalizedSha256 = hash('other'); }, o => { o.expectedExecutionPayload.scope.tenantId = 'other'; },
    o => { o.expectedExecutionPayload.runNonce = '4'.repeat(32); }, o => { o.executionAuthorizationRef.objectVersion = 'other'; },
    o => { o.expectedExecutionPayload.providersHash = hash('other'); }, o => { o.expectedExecutionPayload.thresholdsHash = hash('other'); },
    o => { o.expectedExecutionPayload.manifestHash = hash('other'); }, o => { o.expectedExecutionPayload.participants.executorId = o.expectedExecutionPayload.participants.readOnlyId; },
    o => { o.manifest = { validationLevel: 'structural-only', productionAuthorized: true }; }]) {
    const f = fixture(); change(f.options); assert.throws(() => create(f), configFailure);
  }
});
test('policy exact physical registry identity and immutable digest remain out-of-band', () => {
  for (const field of ['objectId', 'objectVersion', 'sha256']) {
    const f = fixture(); f.options.policyRef[field] = field === 'sha256' ? hash('other') : 'other'; assert.throws(() => create(f), configFailure);
  }
  const f = fixture(); f.options.deploymentPolicy.registrations[0].operatorId = 'different-operator'; assert.throws(() => create(f), configFailure);
});
test('well-formed independent policy scope mismatch rejects even after complete raw manifest and execution rebinding', () => {
  const f = fixture(); f.options.deploymentPolicy.scope.corpusId = 'other-corpus'; rebind(f);
  assert.equal(validateProviderTrustPolicy(f.options.deploymentPolicy).policyHash, f.options.policyRef.sha256);
  assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding); assert.throws(() => create(f), configFailure);
});
test('selected Ask adapter digest, version, config or purpose/provider identity must exactly match the independent registration', () => {
  for (const field of ['adapterDigest', 'version', 'configHash', 'providerId', 'purpose']) {
    const f = fixture(); const registration = selected(f).registration;
    registration[field] = field === 'version' ? 'v2' : field === 'providerId' ? 'other-provider' : field === 'purpose' ? 'clock' : hash(`other-${field}`);
    rebind(f); assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
    assert.equal(validateProviderTrustPolicy(f.options.deploymentPolicy).policyHash, f.options.policyRef.sha256);
    assert.throws(() => create(f), configFailure);
  }
});
test('policy dates must cover the entire effective authorization interval and permit exact equality at its boundaries', () => {
  for (const stage of ['T16', 'T17']) {
    const valid = fixture(stage); const effective = expectedCore(valid, request(valid)).effectiveWindow;
    valid.options.deploymentPolicy.validFrom = effective.startsAt; valid.options.deploymentPolicy.validUntil = effective.endsAt; rebind(valid);
    assert.deepEqual(create(valid).planRequest(request(valid)).effectiveWindow, effective);
    for (const field of ['validFrom', 'validUntil']) {
      const f = fixture(stage); f.options.deploymentPolicy[field] = new Date(Date.parse(effective[field === 'validFrom' ? 'startsAt' : 'endsAt'])
        + (field === 'validFrom' ? 1 : -1)).toISOString(); rebind(f);
      assert.equal(validateProviderTrustPolicy(f.options.deploymentPolicy).productionAuthorized, false); assert.throws(() => create(f), configFailure);
    }
  }
});
test('canonical TLS origins reject credentials, paths, queries, fragments, normalized aliases and non-TLS schemes', () => {
  const origins = ['http://ask.example.test', 'https://user:secret-token@ask.example.test', 'https://ask.example.test/api/ask',
    'https://ask.example.test?target=other', 'https://ask.example.test#other', 'https://ask.example.test/', 'https://ASK.example.test',
    'https://ask.example.test:443', ' https://ask.example.test', 'file:///secret-token', 'javascript:secret-token', 'not-an-origin'];
  for (const origin of origins) {
    const f = fixture(); selected(f).registration.endpointOrigin = origin; rebind(f); assert.throws(() => create(f), configFailure);
  }
});
test('explicit canonical nondefault TLS port is preserved, without claiming DNS, IP or TLS enforcement', () => {
  const f = fixture(); const registration = selected(f).registration; registration.endpointOrigin = 'https://ask.example.test:8443';
  registration.networkPolicy.port = 8443; rebind(f); const plan = create(f).planRequest(request(f));
  assert.equal(plan.target.url, 'https://ask.example.test:8443/api/ask'); assert.equal(plan.target.networkPolicy.port, 8443);
  assert.equal(plan.networkEnforced, false); assert.equal(plan.registryAuthenticated, false); assert.equal(plan.productionAuthorized, false);
});
test('network/TLS relaxations, invalid limits, origin port drift and duplicate or reference/fallback registrations reject the whole policy', () => {
  for (const change of [r => { r.networkPolicy.redirects = 'follow'; }, r => { r.networkPolicy.proxy = 'enabled'; },
    r => { r.networkPolicy.tlsHostnameVerification = false; }, r => { r.networkPolicy.tlsChainVerification = false; },
    r => { r.networkPolicy.port = 8443; }, r => { r.networkPolicy.requestTimeoutMs = 0; }, r => { r.networkPolicy.requestTimeoutMs = 300001; },
    r => { r.networkPolicy.maxCompressedBytes = -1; }, r => { r.networkPolicy.maxResponseBytes = 16777217; },
    r => { r.networkPolicy.maxStreamBytes = 1.5; }, r => { r.networkPolicy.tlsTrustRootsRef = ref('../roots'); },
    r => { r.networkPolicy.dnsPolicyRef = null; }, r => { r.credentialPolicyRef = null; }, r => { r.executionProfile = 'local-reference'; }, r => { r.fallback = true; }]) {
    const f = fixture(); change(selected(f).registration); rebind(f); assert.throws(() => create(f), configFailure);
  }
  const f = fixture(); f.options.deploymentPolicy.registrations.push(clone(selected(f).registration)); rebind(f); assert.throws(() => create(f), configFailure);
});
test('unsafe unselected policy registrations are not ignored just because the Ask registration is valid', () => {
  for (const change of [r => { r.endpointOrigin = 'http://unselected.example.test'; }, r => { r.fallback = true; }, r => { r.networkPolicy.proxy = 'enabled'; }]) {
    const f = fixture(); const unselected = f.options.deploymentPolicy.registrations.find(value => value.purpose === 'citation-locator');
    change(unselected); rebind(f); assert.throws(() => create(f), configFailure);
  }
});
test('T16 off/shadow and T17 off/active mode sets are closed and reject cross-stage or arbitrary modes', () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); const planner = create(f); const candidate = stage === 'T16' ? 'shadow' : 'active';
    for (const rolloutMode of ['off', candidate]) assert.equal(planner.planRequest(request(f, { rolloutMode })).requestIdentity.rolloutMode, rolloutMode);
    for (const rolloutMode of [stage === 'T16' ? 'active' : 'shadow', 'reference', '', null, true]) assert.throws(() => planner.planRequest(request(f, { rolloutMode })), requestFailure);
  }
});
test('request case identity must match the exact raw 32-hex manifest roster, not just look like a pseudonym', () => {
  const f = fixture(); const planner = create(f);
  for (const caseId of f.options.manifest.base.dataset.roster) assert.equal(planner.planRequest(request(f, { caseId })).requestIdentity.caseId, caseId);
  for (const caseId of ['0'.repeat(32), '1'.repeat(31), '1'.repeat(33), 'A'.repeat(32), 'raw-question', '', null, 1]) {
    assert.throws(() => planner.planRequest(request(f, { caseId })), requestFailure);
  }
});
test('trial and warmup ordinals are independently zero-based bounded safe integers from the raw stage sampling policy', () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); const planner = create(f); const sampling = f.options.manifest[policyName(stage)].sampling;
    for (const phase of ['trial', 'warmup']) {
      const limit = sampling[phase === 'trial' ? 'trialCount' : 'warmupCount'];
      for (let ordinal = 0; ordinal < limit; ordinal++) assert.equal(planner.planRequest(request(f, { phase, ordinal })).requestIdentity.ordinal, ordinal);
      for (const ordinal of [-1, limit, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null]) {
        assert.throws(() => planner.planRequest(request(f, { phase, ordinal })), requestFailure);
      }
    }
    for (const phase of ['probe', '', null, true]) assert.throws(() => planner.planRequest(request(f, { phase })), requestFailure);
  }
});
test('zero warmup count rejects every warmup ordinal without changing valid trial planning', () => {
  const f = fixture(); f.options.manifest.t16.sampling.warmupCount = 0; rebind(f); const planner = create(f);
  for (const ordinal of [0, 1, -1]) assert.throws(() => planner.planRequest(request(f, { phase: 'warmup', ordinal })), requestFailure);
  assert.equal(planner.planRequest(request(f)).requestIdentity.phase, 'trial');
});
test('exact request shape rejects URL, path, headers, credentials, questions, verdicts and extra labels before any planning result', () => {
  const f = fixture(); const planner = create(f);
  for (const change of [r => { r.url = 'https://other.example.test/api/ask'; }, r => { r.path = '/other'; }, r => { r.headers = { Authorization: 'secret-token' }; },
    r => { r.credentials = 'secret-token'; }, r => { r.question = 'raw-question'; }, r => { r.gold = 'raw-gold'; },
    r => { r.passed = true; }, r => { delete r.ordinal; }, r => { r[Symbol('secret-token')] = true; }]) {
    const input = request(f); change(input); assert.throws(() => planner.planRequest(input), requestFailure);
  }
});
test('configuration and request getter, Proxy and thenable hooks remain unexecuted', () => {
  let hooks = 0; const hook = () => { hooks++; throw Error('secret-token'); };
  for (const field of ['manifest', 'expectedExecutionPayload', 'executionAuthorizationRef', 'deploymentPolicy', 'policyRef']) for (const kind of ['getter', 'proxy']) {
    const f = fixture(); if (kind === 'getter') Object.defineProperty(f.options, field, { enumerable: true, get: hook });
    else f.options[field] = new Proxy(f.options[field], { ownKeys: hook, get: hook, getPrototypeOf: hook });
    assert.throws(() => create(f), configFailure);
  }
  const f = fixture(); const planner = create(f);
  const getter = Object.defineProperty(request(f), 'caseId', { enumerable: true, get: hook });
  for (const input of [getter, new Proxy(request(f), { ownKeys: hook, get: hook, getPrototypeOf: hook }),
    { ...request(f), get then() { hooks++; return hook; } }]) assert.throws(() => planner.planRequest(input), requestFailure);
  assert.equal(hooks, 0);
});
test('closed options reject enterprise planner, inline endpoint, headers, ports, factories, claimed decisions and extra constructor arguments', () => {
  for (const change of [o => { o.executionProfile = 'enterprise'; }, o => { o.endpointOrigin = 'https://other.example.test'; },
    o => { o.headers = { Authorization: 'secret-token' }; }, o => { o.ports = {}; }, o => { o.factory = () => ({ passed: true }); },
    o => { o.decision = { productionAuthorized: true }; }, o => { delete o.deploymentPolicy; }]) {
    const f = fixture(); change(f.options); assert.throws(() => create(f), configFailure);
  }
  const f = fixture(); let hooks = 0; const extra = new Proxy({}, { ownKeys() { hooks++; throw Error('secret-token'); } });
  for (const second of [undefined, {}, () => true, extra]) assert.throws(() => subject.createReferenceProductionAskTargetPlanner(f.options, second), configFailure);
  const planner = create(f); for (const second of [undefined, {}, extra]) assert.throws(() => planner.planRequest(request(f), second), requestFailure);
  assert.equal(hooks, 0);
});
test('constructor snapshot and result snapshots are detached while planning remains stateless after failures or caller drift', () => {
  const f = fixture(); const planner = create(f); const input = request(f); const frozenExpected = clone(expectedCore(f, input));
  const first = planner.planRequest(input); const canonicalFirst = canonicalJson(first);
  f.options.manifest.base.dataset.roster[0] = '4'.repeat(32); f.options.deploymentPolicy.registrations.find(value => value.purpose === 'ask').endpointOrigin = 'https://changed.example.test';
  f.options.expectedExecutionPayload.manifestHash = hash('changed'); f.options.policyRef.objectVersion = 'changed'; input.ordinal = 999;
  assert.equal(canonicalJson(first), canonicalFirst); assert.throws(() => planner.planRequest(input), requestFailure);
  const originalInput = { caseId: frozenExpected.requestIdentity.caseId, rolloutMode: 'off', phase: 'trial', ordinal: 0 };
  for (let index = 0; index < 5; index++) {
    const next = planner.planRequest(originalInput); assert.deepEqual(next, { ...frozenExpected, planHash: hash(frozenExpected) });
  }
});
