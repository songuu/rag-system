import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { canonicalJsonSha256 as hash } from './canonical-json.ts';
import { fixture, scope } from './production-provider-fixtures.test-support.mjs';

const registry = await import('./production-provider-registry.ts');
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
function instrument(port, transform = value => value) {
  const requests = [];
  return { requests, port: { executionProfile: 'local-reference', productionCapable: false,
    readExactPolicy(request) { requests.push(clone(request)); return port.readExactPolicy(request).then(transform); } } };
}
const code = expected => error => error instanceof registry.ProviderRegistryError && error.code === expected
  && error.productionAuthorized === false && !error.message.includes('SENSITIVE');

test('registry readback is exact, detached, immutable and explicitly local', async () => {
  const f = fixture(); const port = registry.createReferenceProviderRegistry(f.registryConfig);
  f.registryConfig.policies[0].policy.registrations[0].endpointOrigin = 'https://changed.example.test';
  const result = await port.readExactPolicy(f.readRequest);
  const validated = registry.validateProviderRegistryReadback(result, { request: f.readRequest, sourceIdentityRef: f.sourceIdentityRef });
  assert.equal(port.productionCapable, false); assert.equal(result.proof.productionRegistryAuthenticated, false);
  assert.equal(validated.validationLevel, 'structural-only'); assert.equal(validated.productionAuthorized, false);
  assert.equal(validated.policyHash, f.policyRef.sha256); assert.equal(validated.proofHash, hash(result.proof));
  assert.equal(Object.isFrozen(validated.policy.registrations[0].networkPolicy), true);
  assert.equal(validated.policy.registrations[0].endpointOrigin, 'https://secret.example.test');
  await assert.rejects(port.readExactPolicy(f.readRequest), code('registry-replay'));
});

test('registry denies scope, principal, profile, exact reference, validity and capacity substitutions', async () => {
  for (const change of [r => { r.context.binding.tenantId = 'other'; }, r => { r.context.actorId = 'other'; },
    r => { r.context.executionProfile = 'enterprise'; }, r => { r.policyRef.objectVersion = 'other'; },
    r => { r.policyRef.sha256 = hash('other'); }, r => { r.context.observedAt = '2026-10-10T03:00:00.000Z'; },
    r => { r.requestNonce = 'bad'; }, r => { r.extra = true; }]) {
    const f = fixture(); const port = registry.createReferenceProviderRegistry(f.registryConfig); change(f.readRequest);
    await assert.rejects(port.readExactPolicy(f.readRequest), error => error instanceof registry.ProviderRegistryError);
  }
  const f = fixture(); f.registryConfig.maxReads = 1;
  const port = registry.createReferenceProviderRegistry(f.registryConfig); await port.readExactPolicy(f.readRequest);
  f.readRequest.requestNonce = hash('second').slice(0, 32);
  await assert.rejects(port.readExactPolicy(f.readRequest), code('registry-capacity'));
});

test('registry configuration rejects enterprise claims, duplicate versions, wrong digests and unbounded controls', () => {
  for (const change of [c => { c.executionProfile = 'enterprise'; }, c => { c.maxReads = 0; },
    c => { c.maxReads = 4097; }, c => { c.readOnlyActorIds.push(c.readOnlyActorIds[0]); },
    c => { c.policies.push(clone(c.policies[0])); }, c => { c.policies[0].ref.sha256 = hash('wrong'); },
    c => { c.scope.corpusId = 'other'; }, c => { c.productionCapable = true; }]) {
    const f = fixture(); change(f.registryConfig);
    assert.throws(() => registry.createReferenceProviderRegistry(f.registryConfig), error => error instanceof registry.ProviderRegistryError);
  }
});

test('proof must bind the independently expected context, challenge, policy and source', async () => {
  const f = fixture(); const readback = await registry.createReferenceProviderRegistry(f.registryConfig).readExactPolicy(f.readRequest);
  const changes = [r => { r.proof.requestNonce = hash('other').slice(0, 32); },
    r => { r.proof.context.binding.runNonce = hash('other').slice(0, 32); }, r => { r.proof.context.actorId = 'other'; },
    r => { r.proof.context.authorizationDigest = hash('other'); }, r => { r.proof.context.observedAt = '2026-10-09T04:02:00.000Z'; },
    r => { r.proof.sourceIdentityRef.objectVersion = 'other'; }, r => { r.proof.policyRef.objectId = 'other'; },
    r => { r.proof.assurance = 'enterprise'; }, r => { r.proof.productionRegistryAuthenticated = true; },
    r => { r.policy.registrations[0].configHash = hash('other'); }, r => { r.proof.extra = true; }];
  for (const change of changes) {
    const value = clone(readback); change(value);
    assert.throws(() => registry.validateProviderRegistryReadback(value, { request: f.readRequest,
      sourceIdentityRef: f.sourceIdentityRef }), code('registry-proof-invalid'));
  }
});

test('registry-bound verifier executes real signatures for every stage without claiming production authority', async () => {
  for (const [stage, count] of [['T16', 8], ['T17', 13], ['R18', 7]]) {
    const f = fixture(stage); const tracked = instrument(registry.createReferenceProviderRegistry(f.registryConfig));
    const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: tracked.port });
    for (let index = 0; index < 2; index++) {
      const decision = await verifier.verifySelection(f.request);
      assert.equal(decision.validationLevel, 'local-reference-cryptographic');
      assert.equal(decision.productionAuthorized, false); assert.equal(decision.signaturesVerified, true);
      assert.equal(decision.providers.length, count); assert.equal(decision.registryRef.sha256, f.policyRef.sha256);
      assert.equal(decision.registryReadbackProofHash.length, 64); assert.equal(Object.isFrozen(decision.providers), true);
      const { decisionHash, ...preimage } = decision; assert.equal(decisionHash, hash(preimage));
    }
    assert.equal(tracked.requests.length, 2); assert.notEqual(tracked.requests[0].requestNonce, tracked.requests[1].requestNonce);
  }
});

test('successful selection is not cached when a later registry call fails or changes its proof', async () => {
  for (const mode of ['reject', 'change']) {
    const f = fixture(); let calls = 0; const base = registry.createReferenceProviderRegistry(f.registryConfig);
    const port = { executionProfile: 'local-reference', productionCapable: false, async readExactPolicy(request) {
      calls++; if (calls > 1 && mode === 'reject') throw new Error('SENSITIVE credential');
      const result = clone(await base.readExactPolicy(request));
      if (calls > 1) result.proof.sourceIdentityRef = ref('other'); return result;
    } };
    const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port });
    await verifier.verifySelection(f.request);
    await assert.rejects(verifier.verifySelection(f.request), code(mode === 'reject' ? 'registry-read-failed' : 'registry-proof-invalid'));
    assert.equal(calls, 2);
  }
});

test('selection preflight and local monotonic time fail before registry I/O', async () => {
  for (const change of [r => { r.scope.tenantId = 'other'; }, r => { r.providers.registryRef.objectVersion = 'other'; },
    r => { r.executionProvidersHash = hash('other'); }, r => { r.stage = 'OTHER'; }, r => { r.extra = true; }]) {
    const f = fixture(); const tracked = instrument(registry.createReferenceProviderRegistry(f.registryConfig));
    const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: tracked.port }); change(f.request);
    await assert.rejects(verifier.verifySelection(f.request), code('selection-invalid')); assert.equal(tracked.requests.length, 0);
  }
  const f = fixture(); const tracked = instrument(registry.createReferenceProviderRegistry(f.registryConfig));
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: tracked.port });
  await verifier.verifySelection(f.request); f.request.observedAt = '2026-10-09T04:00:59.000Z';
  await assert.rejects(verifier.verifySelection(f.request), code('selection-invalid')); assert.equal(tracked.requests.length, 1);
});

test('unsigned or tampered certificates cannot pass after a valid registry read', async () => {
  const f = fixture(); f.request.runtimeObjects[0].attestation.body.instanceId = 'changed-instance';
  f.request.runtimeObjects[0].ref.sha256 = hash(f.request.runtimeObjects[0].attestation);
  const tracked = instrument(registry.createReferenceProviderRegistry(f.registryConfig));
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: tracked.port });
  await assert.rejects(verifier.verifySelection(f.request), code('provider-trust-invalid')); assert.equal(tracked.requests.length, 1);
});

test('captured registry method, request and roots cannot be replaced while the read is pending', async () => {
  const f = fixture(); const base = registry.createReferenceProviderRegistry(f.registryConfig);
  let release; const barrier = new Promise(resolve => { release = resolve; }); let entered;
  const started = new Promise(resolve => { entered = resolve; }); let calls = 0;
  const port = { executionProfile: 'local-reference', productionCapable: false, readExactPolicy(request) {
    calls++; entered(); return barrier.then(() => base.readExactPolicy(request));
  } };
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port });
  const pending = verifier.verifySelection(f.request); await started;
  port.readExactPolicy = () => { throw new Error('replacement'); }; f.request.scope.tenantId = 'other';
  f.options.authorityKeys[0].revoked = true; release();
  const decision = await pending; assert.equal(decision.scope.tenantId, scope.tenantId); assert.equal(calls, 1);
});

test('overlapping calls are denied and verification attempts are bounded', async () => {
  const f = fixture(); f.options.maxVerifications = 1; const base = registry.createReferenceProviderRegistry(f.registryConfig);
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const port = { executionProfile: 'local-reference', productionCapable: false, readExactPolicy: request => barrier.then(() => base.readExactPolicy(request)) };
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port });
  const pending = verifier.verifySelection(f.request);
  await assert.rejects(verifier.verifySelection(f.request), code('verifier-busy')); release(); await pending;
  await assert.rejects(verifier.verifySelection(f.request), code('verifier-capacity'));
});

test('unknown completion halts this verifier and never returns a cached decision', async context => {
  // Timer expiry with a pending native promise is distinct from elapsed host
  // dispatch/settlement; keep only the former deterministic in this fixture.
  context.mock.method(performance, 'now', () => 0);
  const f = fixture(); f.options.operationTimeoutMs = 10; let calls = 0;
  const port = { executionProfile: 'local-reference', productionCapable: false,
    readExactPolicy() { calls++; return new Promise(() => {}); } };
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port });
  await assert.rejects(verifier.verifySelection(f.request), error => code('registry-timeout')(error) && error.pendingCompletionUnknown === true);
  await assert.rejects(verifier.verifySelection(f.request), code('verifier-halted')); assert.equal(calls, 1);
});

test('hostile return carriers and payload then accessors are never invoked', async () => {
  for (const mode of ['carrier', 'payload']) {
    const f = fixture(); let getters = 0;
    const value = {}; Object.defineProperty(value, 'then', { enumerable: true, get() { getters++; throw new Error('SENSITIVE'); } });
    const port = { executionProfile: 'local-reference', productionCapable: false,
      readExactPolicy() { if (mode === 'carrier') return value; return new Promise(resolve => {
        const payload = {}; resolve(payload); Object.defineProperty(payload, 'then', Object.getOwnPropertyDescriptor(value, 'then'));
      }); } };
    const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port });
    await assert.rejects(verifier.verifySelection(f.request), code(mode === 'carrier' ? 'registry-return-invalid' : 'registry-proof-invalid'));
    assert.equal(getters, 0);
  }
});

test('configuration and dependency accessors/proxies are rejected without execution', () => {
  const f = fixture(); let traps = 0;
  const port = { executionProfile: 'local-reference', productionCapable: false };
  Object.defineProperty(port, 'readExactPolicy', { enumerable: true, get() { traps++; throw new Error('SENSITIVE'); } });
  for (const dependency of [{ registry: port }, new Proxy({}, { ownKeys() { traps++; throw new Error('SENSITIVE'); } })]) {
    assert.throws(() => registry.createReferenceRegistryBoundTrustVerifier(f.options, dependency), code('registry-configuration-invalid'));
  }
  const options = clone(f.options); Object.defineProperty(options, 'scope', { enumerable: true, get() { traps++; throw new Error('SENSITIVE'); } });
  assert.throws(() => registry.createReferenceRegistryBoundTrustVerifier(options, { registry: port }), code('registry-configuration-invalid'));
  assert.equal(traps, 0);
});

test('a well-formed enterprise readback label remains structural, never authenticated by the validator', async () => {
  const f = fixture(); const result = clone(await registry.createReferenceProviderRegistry(f.registryConfig).readExactPolicy(f.readRequest));
  f.readRequest.context.executionProfile = 'enterprise'; result.proof.context.executionProfile = 'enterprise';
  result.proof.assurance = 'enterprise'; result.proof.productionRegistryAuthenticated = true;
  const validated = registry.validateProviderRegistryReadback(result, { request: f.readRequest, sourceIdentityRef: f.sourceIdentityRef });
  assert.equal(validated.validationLevel, 'structural-only'); assert.equal(validated.productionAuthorized, false);
});

test('consumer configuration cannot supply a policy, claim enterprise capability or remove resource bounds', () => {
  for (const change of [c => { c.executionProfile = 'enterprise'; }, c => { c.policy = fixture().policy; },
    c => { c.operationTimeoutMs = 0; }, c => { c.operationTimeoutMs = 60001; }, c => { c.maxVerifications = 4097; },
    c => { c.authorityKeys = []; }, c => { c.readerAuthorizationDigest = 'bad'; }]) {
    const f = fixture(); change(f.options);
    assert.throws(() => registry.createReferenceRegistryBoundTrustVerifier(f.options,
      { registry: registry.createReferenceProviderRegistry(f.registryConfig) }), code('registry-configuration-invalid'));
  }
  for (const [executionProfile, productionCapable] of [['enterprise', true], ['local-reference', true]]) {
    const f = fixture(); assert.throws(() => registry.createReferenceRegistryBoundTrustVerifier(f.options, {
      registry: { executionProfile, productionCapable, readExactPolicy: async () => null },
    }), code('registry-configuration-invalid'));
  }
});

test('native promise own then getter is bypassed while the registry proof is still fully verified', async () => {
  const f = fixture(); const base = registry.createReferenceProviderRegistry(f.registryConfig); let getters = 0;
  const port = { executionProfile: 'local-reference', productionCapable: false, readExactPolicy(request) {
    const pending = base.readExactPolicy(request);
    Object.defineProperty(pending, 'then', { get() { getters++; throw new Error('SENSITIVE'); } }); return pending;
  } };
  const decision = await registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port }).verifySelection(f.request);
  assert.equal(decision.signaturesVerified, true); assert.equal(getters, 0);
});

test('a synchronously settled but over-budget registry call is rejected without claiming unknown completion', async () => {
  const f = fixture(); f.options.operationTimeoutMs = 20; let calls = 0;
  const base = registry.createReferenceProviderRegistry(f.registryConfig);
  const port = { executionProfile: 'local-reference', productionCapable: false, readExactPolicy(request) {
    calls++; const until = performance.now() + 50; while (performance.now() < until) { /* Fixture host blocking. */ }
    return base.readExactPolicy(request);
  } };
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: port });
  await assert.rejects(verifier.verifySelection(f.request), error => code('registry-timeout')(error) && error.pendingCompletionUnknown === false);
  assert.equal(calls, 1);
});

test('revoked local signing roots are refused after exact registry readback', async () => {
  const f = fixture(); f.options.authorityKeys[0].revoked = true;
  const tracked = instrument(registry.createReferenceProviderRegistry(f.registryConfig));
  const verifier = registry.createReferenceRegistryBoundTrustVerifier(f.options, { registry: tracked.port });
  await assert.rejects(verifier.verifySelection(f.request), code('provider-trust-invalid')); assert.equal(tracked.requests.length, 1);
});
