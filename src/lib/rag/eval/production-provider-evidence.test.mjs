import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fixture as signedFixture } from './production-provider-fixtures.test-support.mjs';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';

const registry = await import('./production-provider-registry.ts');
const authority = await import('./production-authority-ports.ts');
const trust = await import('./production-provider-trust.ts');
let subject;
try { subject = await import('./production-provider-evidence.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const keys = Object.fromEntries(['conformance', 'runtime'].map(kind => [kind, generateKeyPairSync('ed25519')]));
function attest(kind, body, signerKind = kind) {
  const signer = { algorithm: 'Ed25519', keyId: `${signerKind}-key`, keyVersion: 'v1' };
  return { kind, body, signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({
    signatureProfile: 'kg-provider-attestation-signature/v1', kind, body, signer })), keys[signerKind].privateKey).toString('base64url') } };
}
function resignAll(f) {
  for (const object of f.request.conformanceObjects) {
    object.attestation = attest('conformance', clone(object.attestation.body)); object.ref.sha256 = hash(object.attestation);
    f.request.providers.bindings.find(b => b.purpose === object.attestation.body.provider.purpose).conformanceRef = clone(object.ref);
  }
  f.request.executionProvidersHash = hash(f.request.providers);
  for (const object of f.request.runtimeObjects) {
    const body = clone(object.attestation.body); body.providersHash = f.request.executionProvidersHash;
    object.attestation = attest('runtime', body); object.ref.sha256 = hash(object.attestation);
  }
}
function fixture(stage = 'T16', allPurposes = false) {
  const f = signedFixture(stage);
  if (allPurposes) {
    const registered = f.policy.registrations.at(-1);
    const identity = Object.fromEntries(Object.keys(f.request.conformanceObjects[0].attestation.body.provider).map(k => [k, clone(registered[k])]));
    const conformance = clone(f.request.conformanceObjects[0]); conformance.ref.objectId = 'citation-conformance';
    Object.assign(conformance.attestation.body, { provider: identity, checks: trust.PROVIDER_CONFORMANCE_REQUIREMENTS['citation-locator'].map(check => ({ check, verdict: 'passed' })) });
    const runtime = clone(f.request.runtimeObjects[0]); runtime.ref.objectId = 'citation-runtime';
    Object.assign(runtime.attestation.body, { provider: clone(identity), instanceId: 'citation-instance' });
    f.request.conformanceObjects.push(conformance); f.request.runtimeObjects.push(runtime);
    f.request.providers.bindings.push({ purpose: registered.purpose, providerId: registered.providerId,
      adapterDigest: registered.adapterDigest, version: registered.version, configHash: registered.configHash, conformanceRef: clone(conformance.ref) });
  }
  f.options.authorityKeys.forEach(key => { key.publicKeySpki = keys[key.kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'); });
  resignAll(f);
  f.binding = { ...f.request.scope, runNonce: f.request.runNonce, manifestHash: f.request.manifestHash };
  f.evidenceIdentityRefs = { conformance: ref('conformance-store-source'), runtime: ref('runtime-measurement-source') };
  const { observedAt: _at, conformanceObjects: _conf, runtimeObjects: _run, ...selection } = f.request; void _at; void _conf; void _run;
  f.verifierOptions = { ...f.options, expectedSelection: clone(selection), clockIdentityRef: ref('evidence-clock'),
    maxClockUncertaintyMs: 1000, evidenceIdentityRefs: clone(f.evidenceIdentityRefs),
    observationWindow: { startsAt: '2026-10-09T04:00:00.000Z', endsAt: '2026-10-09T04:03:00.000Z' } };
  f.storeOptions = { executionProfile: 'local-reference', binding: clone(f.binding), readerId: f.options.readerId,
    authorizationDigest: f.options.readerAuthorizationDigest, sourceIdentityRefs: clone(f.evidenceIdentityRefs),
    validFrom: '2026-10-09T04:00:00.000Z', validUntil: '2026-10-09T04:03:00.000Z', maxReads: 256,
    objects: { conformance: clone(f.request.conformanceObjects), runtime: clone(f.request.runtimeObjects) } };
  f.clock = authority.createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: f.request.scope,
    allowedActorIds: [f.options.readerId], sourceIdentityRef: f.verifierOptions.clockIdentityRef,
    initialObservedAt: '2026-10-09T04:01:00.000Z', uncertaintyMs: 0, maxReadings: 1000, maxAdvanceMs: 86400000 });
  f.calls = [];
  f.context = { executionProfile: 'local-reference', binding: clone(f.binding), actorId: f.options.readerId,
    authorizationDigest: f.options.readerAuthorizationDigest, observedAt: '2026-10-09T04:01:00.000Z' };
  return f;
}
function ports(f, alter) {
  const evidence = subject.createReferenceProviderEvidenceStore(f.storeOptions);
  const sources = { registry: registry.createReferenceProviderRegistry({ ...f.registryConfig, maxReads: 256 }), clock: f.clock, evidence };
  const port = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, {
    executionProfile: 'local-reference', productionCapable: false,
    ...Object.fromEntries(({ registry: ['readExactPolicy'], clock: ['readTime'], evidence: ['readExactConformance', 'readRuntimeMeasurement'] })[name].map(method => [method,
      request => { f.calls.push({ name, method, request: clone(request) }); return source[method](request); }])) }]));
  if (alter) alter(port, f); return port;
}
const failure = code => error => error instanceof subject.ProviderEvidenceError && (!code || error.code === code)
  && error.productionAuthorized === false && !error.message.includes('SENSITIVE');
const count = (f, name) => f.calls.filter(c => c.name === name).length;

test('actual evidence store and authority-bound readback entry points exist', () => {
  assert.equal(typeof subject?.createReferenceProviderEvidenceStore, 'function');
  assert.equal(typeof subject?.createReferenceProviderEvidenceVerifier, 'function');
  assert.equal(typeof subject?.validateProviderEvidenceReadback, 'function');
});

test('reference evidence objects are actually exact-read, detached, immutable and explicitly nonproduction', async () => {
  const f = fixture(); const store = subject.createReferenceProviderEvidenceStore(f.storeOptions);
  f.storeOptions.objects.conformance[0].attestation.body.verdict = 'failed';
  const requests = [
    ['conformance', { context: f.context, ref: f.request.providers.bindings[0].conformanceRef, requestNonce: hash('conf').slice(0, 32) }, 'readExactConformance'],
    ['runtime', { context: f.context, provider: f.request.providers.bindings[0], requestNonce: hash('runtime').slice(0, 32) }, 'readRuntimeMeasurement'],
  ];
  for (const [kind, request, method] of requests) {
    const value = await store[method](request);
    const checked = subject.validateProviderEvidenceReadback(value, { kind, request, sourceIdentityRef: f.evidenceIdentityRefs[kind] });
    assert.equal(checked.productionAuthorized, false); assert.equal(checked.validationLevel, 'structural-only');
    assert.equal(checked.object.ref.sha256, hash(checked.object.attestation)); assert.equal(Object.isFrozen(checked.object.attestation.body), true);
    assert.equal(value.proof.productionSourceAuthenticated, false); assert.equal(value.proof.assurance, 'local-reference');
    await assert.rejects(store[method](request), failure('source-replay'));
  }
  assert.equal(store.productionCapable, false);
});

test('reference evidence configuration denies aliases, bad digests, profiles and invalid bounds', () => {
  for (const edit of [c => { c.executionProfile = 'enterprise'; }, c => { c.maxReads = 0; }, c => { c.maxReads = 4097; },
    c => { c.objects.runtime.push(clone(c.objects.runtime[0])); }, c => { c.objects.conformance[0].ref.sha256 = hash('wrong'); },
    c => { c.sourceIdentityRefs.runtime = clone(c.sourceIdentityRefs.conformance); }, c => { c.binding.tenantId = '*'; },
    c => { c.validUntil = c.validFrom; }, c => { c.objects.runtime[0].attestation.body.runNonce = 'e'.repeat(32); },
    c => { c.productionCapable = true; }]) {
    const f = fixture(); edit(f.storeOptions); assert.throws(() => subject.createReferenceProviderEvidenceStore(f.storeOptions), failure('invalid-config'));
  }
});

test('source methods enforce exact role/scope/run/authorization/ref/time, availability and capacity', async () => {
  for (const edit of [r => { r.context.actorId = 'other'; }, r => { r.context.executionProfile = 'enterprise'; },
    r => { r.context.binding.corpusId = 'other'; }, r => { r.context.binding.runNonce = 'e'.repeat(32); },
    r => { r.context.authorizationDigest = hash('other'); }, r => { r.ref.objectVersion = 'other'; },
    r => { r.context.observedAt = '2026-10-09T04:03:00.000Z'; }, r => { r.extra = true; }]) {
    const f = fixture(); const store = subject.createReferenceProviderEvidenceStore(f.storeOptions);
    const request = { context: clone(f.context), ref: clone(f.request.providers.bindings[0].conformanceRef), requestNonce: hash('x').slice(0, 32) };
    edit(request); await assert.rejects(store.readExactConformance(request), failure());
  }
  const f = fixture(); f.storeOptions.maxReads = 1; const store = subject.createReferenceProviderEvidenceStore(f.storeOptions);
  const request = { context: f.context, ref: f.request.providers.bindings[0].conformanceRef, requestNonce: hash('one').slice(0, 32) };
  await store.readExactConformance(request); await assert.rejects(store.readExactConformance({ ...request, requestNonce: hash('two').slice(0, 32) }), failure('source-capacity'));
  store.setAvailability(false); await assert.rejects(store.readExactConformance(request), failure('source-unavailable'));
});

test('proof validator recomputes content and pins actual source, context, selector, challenge and object version', async () => {
  const f = fixture(); const store = subject.createReferenceProviderEvidenceStore(f.storeOptions);
  const request = { context: f.context, ref: f.request.providers.bindings[0].conformanceRef, requestNonce: hash('proof').slice(0, 32) };
  const original = await store.readExactConformance(request);
  for (const edit of [v => { v.object.attestation.body.verdict = 'failed'; }, v => { v.proof.requestNonce = 'e'.repeat(32); },
    v => { v.proof.context.actorId = 'other'; }, v => { v.proof.sourceIdentityRef.objectVersion = 'other'; },
    v => { v.proof.objectRef.sha256 = hash('other'); }, v => { v.proof.kind = 'runtime'; },
    v => { v.proof.productionSourceAuthenticated = true; }, v => { v.proof.extra = true; }]) {
    const value = clone(original); edit(value); assert.throws(() => subject.validateProviderEvidenceReadback(value,
      { kind: 'conformance', request, sourceIdentityRef: f.evidenceIdentityRefs.conformance }), failure('invalid-evidence'));
  }
});

test('all stages and all fourteen purposes use actual registry/clock/evidence IO with independent signatures', async () => {
  for (const [stage, all, size] of [['T16', false, 8], ['T17', false, 13], ['R18', false, 7], ['T17', true, 14]]) {
    const f = fixture(stage, all); const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, ports(f));
    const value = await verifier.verifySelection({});
    assert.equal(value.providers.length, size); assert.equal(value.signaturesVerified, true); assert.equal(value.productionAuthorized, false);
    assert.equal(value.stageAcceptanceComplete, false); assert.equal(value.behavioralConformanceComplete, false);
    assert.equal(value.registryRef.sha256, f.policyRef.sha256); assert.equal(value.providerEvidenceReadbacks.length, size * 2);
    assert.equal(count(f, 'registry'), 2); assert.equal(count(f, 'evidence'), size * 2); assert.equal(count(f, 'clock'), size * 2 + 3);
    const nonces = f.calls.map(c => c.request.requestNonce); assert.equal(new Set(nonces).size, nonces.length);
    const { decisionHash, ...preimage } = value; assert.equal(decisionHash, hash(preimage)); assert.equal(Object.isFrozen(value.providers[0]), true);
  }
});

test('successful verification never caches the next registry or evidence readback', async () => {
  const f = fixture(); let reads = 0;
  const port = ports(f, p => { const read = p.evidence.readRuntimeMeasurement;
    p.evidence.readRuntimeMeasurement = request => { reads++; if (reads > 8) return Promise.reject(Error('SENSITIVE')); return read(request); }; });
  const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port); await verifier.verifySelection({});
  await assert.rejects(verifier.verifySelection({}), failure('operation-failed')); assert.equal(reads, 9); assert.equal(count(f, 'registry'), 3);
});

test('repeated successful invocations reread every source with fresh challenges and clock proofs', async () => {
  const f = fixture(); const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, ports(f));
  const first = await verifier.verifySelection({}); const second = await verifier.verifySelection({});
  assert.equal(count(f, 'registry'), 4); assert.equal(count(f, 'evidence'), 32); assert.equal(count(f, 'clock'), 38);
  assert.notEqual(first.clockReadingHash, second.clockReadingHash); assert.notEqual(first.decisionHash, second.decisionHash);
  const nonces = f.calls.map(c => c.request.requestNonce); assert.equal(new Set(nonces).size, nonces.length);
});

test('different evidence roles cannot alias one actual object ID/version with different content digests', async () => {
  for (const aliasKind of ['current-certificate', 'future-certificate', 'previous-runtime']) {
    const f = fixture(); let firstRuntime; const port = ports(f, p => { const read = p.evidence.readRuntimeMeasurement;
      p.evidence.readRuntimeMeasurement = async request => { const value = clone(await read(request));
        if (aliasKind === 'previous-runtime' && !firstRuntime) { firstRuntime = clone(value.object.ref); return value; }
        const alias = aliasKind === 'current-certificate' ? request.provider.conformanceRef
          : aliasKind === 'future-certificate' ? f.verifierOptions.expectedSelection.providers.bindings[1].conformanceRef : firstRuntime;
        value.object.ref.objectId = alias.objectId; value.object.ref.objectVersion = alias.objectVersion;
        value.proof.objectRef = clone(value.object.ref); return value; }; });
    const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port);
    await assert.rejects(verifier.verifySelection({}), failure('invalid-evidence'));
    assert.equal(count(f, 'evidence'), aliasKind === 'previous-runtime' ? 4 : 2);
  }
});

test('caller certificate, runtime, time and cached success labels cannot substitute for actual IO', async () => {
  const f = fixture(); const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, ports(f));
  for (const request of [{ conformanceObjects: f.request.conformanceObjects }, { runtimeObjects: f.request.runtimeObjects },
    { observedAt: f.context.observedAt }, { decision: true }, { expectedSelection: f.request }]) {
    await assert.rejects(verifier.verifySelection(request), failure('invalid-request')); assert.equal(f.calls.length, 0);
  }
});

test('configuration independently freezes selection and rejects malformed provider sets before IO', () => {
  for (const edit of [o => { o.executionProfile = 'enterprise'; }, o => { o.expectedSelection.executionProvidersHash = hash('wrong'); },
    o => { o.expectedSelection.scope.tenantId = 'other'; }, o => { o.expectedSelection.providers.bindings.pop(); o.expectedSelection.executionProvidersHash = hash(o.expectedSelection.providers); },
    o => { o.expectedSelection.providers.bindings.push(clone(o.expectedSelection.providers.bindings[0])); o.expectedSelection.executionProvidersHash = hash(o.expectedSelection.providers); },
    o => { o.maxVerifications = 0; }, o => { o.maxClockUncertaintyMs = -1; },
    o => { o.evidenceIdentityRefs.runtime = clone(o.evidenceIdentityRefs.conformance); }]) {
    const f = fixture(); const port = ports(f); edit(f.verifierOptions);
    assert.throws(() => subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port), failure('invalid-config')); assert.equal(f.calls.length, 0);
  }
});

test('actual registry rejection or unregistered binding stops before any evidence source call', async () => {
  for (const mode of ['registry', 'provider']) {
    const f = fixture(); if (mode === 'provider') { f.verifierOptions.expectedSelection.providers.bindings[0].version = 'other';
      f.verifierOptions.expectedSelection.executionProvidersHash = hash(f.verifierOptions.expectedSelection.providers); }
    const port = ports(f, p => { if (mode === 'registry') p.registry.readExactPolicy = () => Promise.reject(Error('SENSITIVE')); });
    const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port);
    await assert.rejects(verifier.verifySelection({}), failure()); assert.equal(count(f, 'evidence'), 0);
  }
});

test('wrong source proof or actual object digest stops subsequent evidence IO', async () => {
  for (const mode of ['proof', 'digest']) {
    const f = fixture(); const port = ports(f, p => { const read = p.evidence.readExactConformance;
      p.evidence.readExactConformance = async request => { const value = clone(await read(request));
        if (mode === 'proof') value.proof.sourceIdentityRef = ref('other'); else value.object.attestation.body.verdict = 'failed'; return value; }; });
    const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port);
    await assert.rejects(verifier.verifySelection({}), failure('invalid-evidence')); assert.equal(count(f, 'evidence'), 1);
  }
});

test('actual evidence signatures, independent signer role, stage and failed behavioral claim remain mandatory', async () => {
  for (const mode of ['signature', 'role', 'stage', 'failed', 'revoked']) {
    const f = fixture();
    if (mode === 'stage') { f.request.runtimeObjects[0].attestation.body.stage = 'R18'; resignAll(f); }
    if (mode === 'failed') { f.request.conformanceObjects[0].attestation.body.checks[0].verdict = 'failed'; resignAll(f); }
    if (mode === 'signature' || mode === 'role') {
      const value = f.request.runtimeObjects[0];
      value.attestation = mode === 'role' ? attest('runtime', clone(value.attestation.body), 'conformance') : clone(value.attestation);
      if (mode === 'signature') value.attestation.signature.value = Buffer.alloc(64).toString('base64url'); value.ref.sha256 = hash(value.attestation);
    }
    f.storeOptions.objects = { conformance: clone(f.request.conformanceObjects), runtime: clone(f.request.runtimeObjects) };
    f.verifierOptions.expectedSelection.providers = clone(f.request.providers);
    f.verifierOptions.expectedSelection.executionProvidersHash = f.request.executionProvidersHash;
    if (mode === 'revoked') f.verifierOptions.authorityKeys[0].revoked = true;
    const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, ports(f));
    await assert.rejects(verifier.verifySelection({}), failure('invalid-evidence'));
  }
});

test('expiry during actual source IO prevents the next source callback', async () => {
  const f = fixture(); const port = ports(f, p => { const read = p.evidence.readExactConformance;
    p.evidence.readExactConformance = async request => { const result = await read(request); f.clock.advanceTo('2026-10-09T04:03:00.000Z'); return result; }; });
  const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port);
  await assert.rejects(verifier.verifySelection({}), failure('invalid-evidence')); assert.equal(count(f, 'evidence'), 1);
});

test('final registry readback and the complete clock uncertainty interval are mandatory', async () => {
  for (const mode of ['registry', 'uncertainty']) {
    const f = fixture(); let reads = 0;
    const port = ports(f, p => {
      const registryRead = p.registry.readExactPolicy; p.registry.readExactPolicy = async request => {
        reads++; if (mode === 'registry' && reads === 2) throw Error('SENSITIVE'); return registryRead(request); };
      const clockRead = p.clock.readTime; p.clock.readTime = async request => { const value = clone(await clockRead(request));
        if (mode === 'uncertainty' && count(f, 'evidence') === 16) { value.observedAt = '2026-10-09T04:02:59.500Z'; value.uncertaintyMs = 500; } return value; };
    });
    const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port);
    await assert.rejects(verifier.verifySelection({}), failure()); assert.equal(count(f, 'evidence'), 16);
  }
});

test('clock regression is denied across successful invocations without resetting the private cursor', async () => {
  const f = fixture(); let last; let regress = false;
  const port = ports(f, p => { const read = p.clock.readTime; p.clock.readTime = async request => { const result = clone(await read(request));
    if (regress) result.sequence = last.sequence; else last = result; return result; }; });
  const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port); await verifier.verifySelection({});
  regress = true; const before = count(f, 'evidence'); await assert.rejects(verifier.verifySelection({}), failure('invalid-evidence'));
  assert.equal(count(f, 'evidence'), before);
});

test('one minimum verification budget completes a full readback and then refuses further IO', async () => {
  const f = fixture('T17', true); f.verifierOptions.maxVerifications = 1;
  const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, ports(f)); await verifier.verifySelection({});
  const before = f.calls.length; await assert.rejects(verifier.verifySelection({}), failure('attempt-capacity')); assert.equal(f.calls.length, before);
});

test('busy lock and frozen roots/callbacks survive the first await without caller evidence replacement', async t => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  const port = ports(f, p => { const read = p.clock.readTime; p.clock.readTime = async request => { entered.resolve(); await release.promise; return read(request); }; });
  const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port); const pending = verifier.verifySelection({});
  t.after(async () => { release.resolve(); await pending.catch(() => {}); }); await entered.promise;
  const before = f.calls.length; await assert.rejects(verifier.verifySelection({}), failure('busy')); assert.equal(f.calls.length, before);
  f.verifierOptions.authorityKeys.forEach(k => { k.revoked = true; }); f.verifierOptions.expectedSelection.providers.bindings[0].version = 'other';
  let traps = 0; Object.defineProperty(port.evidence, 'readRuntimeMeasurement', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
  release.resolve(); const result = await pending; assert.equal(result.signaturesVerified, true); assert.equal(traps, 0);
});

test('UNKNOWN completion halts retry and late fulfillment cannot resume source IO', async t => {
  const f = fixture(); f.verifierOptions.operationTimeoutMs = 50; const entered = deferred(); const release = deferred(); let raw;
  const port = ports(f, p => { const read = p.evidence.readExactConformance;
    p.evidence.readExactConformance = request => { raw = read(request); entered.resolve(); return release.promise; }; });
  const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port); const pending = verifier.verifySelection({});
  t.after(async () => { release.resolve(await raw); await pending.catch(() => {}); });
  const observed = assert.rejects(pending, error => failure('operation-timeout')(error) && error.pendingCompletionUnknown);
  await entered.promise; await observed; const before = f.calls.length; release.resolve(await raw); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(verifier.verifySelection({}), failure('halted')); assert.equal(f.calls.length, before);
});

test('getter, Proxy, thenable and hostile fulfilled payload hooks never execute', async () => {
  for (const mode of ['getter', 'proxy', 'thenable', 'payload']) {
    const f = fixture(); let traps = 0;
    const port = ports(f, p => { if (mode === 'thenable') p.evidence.readExactConformance = () => ({ then() { traps++; } });
      if (mode === 'payload') p.evidence.readExactConformance = () => Promise.resolve({ get object() { traps++; throw Error('SENSITIVE'); } }); });
    const verifier = subject.createReferenceProviderEvidenceVerifier(f.verifierOptions, port); let request = {};
    if (mode === 'getter') Object.defineProperty(request, 'decision', { enumerable: true, get() { traps++; throw Error('SENSITIVE'); } });
    if (mode === 'proxy') request = new Proxy(request, { ownKeys() { traps++; throw Error('SENSITIVE'); } });
    await assert.rejects(verifier.verifySelection(request), failure());
    assert.equal(traps, 0);
  }
});
