import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const trust = await import('./production-provider-trust.ts');
const hash = canonicalJsonSha256;
const clone = value => structuredClone(value);
const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const ref = name => ({ objectId: name, objectVersion: 'version-1', sha256: hash(name) });
const purposes = ['secret', 'kms', 'approval', 'tamper-store', 'clock', 'ask', 'publication-readback',
  'run-journal', 'lease', 'fencing', 'deployment', 'traffic', 'fault', 'citation-locator'];
const kinds = ['conformance', 'runtime'];
const keys = Object.fromEntries(kinds.map(kind => [kind, generateKeyPairSync('ed25519')]));
const issuers = { conformance: 'independent-harness', runtime: 'independent-runtime-reader' };
const signedAt = '2026-10-09T04:00:00.000Z';
const observedAt = '2026-10-09T04:01:00.000Z';
const runNonce = '0123456789abcdef0123456789abcdef';
const manifestHash = hash('manifest');

function registration(purpose) {
  return { purpose, providerId: `${purpose}-provider`, operatorId: `${purpose}-operator`,
    executionProfile: 'enterprise', fallback: false, adapterDigest: hash(`${purpose}-adapter`), version: 'adapter-v1',
    imageDigest: `sha256:${hash(`${purpose}-image`)}`, artifactSignatureRef: ref(`${purpose}-artifact-signature`),
    configHash: hash(`${purpose}-config`), endpointOrigin: `https://${purpose}.example.test`,
    networkPolicy: { port: 443, redirects: 'forbidden', proxy: 'disabled',
      tlsHostnameVerification: true, tlsChainVerification: true, tlsTrustRootsRef: ref('tls-roots'), dnsPolicyRef: ref('dns-policy'),
      requestTimeoutMs: 5000, maxCompressedBytes: 1048576, maxResponseBytes: 2097152, maxStreamBytes: 2097152 },
    credentialPolicyRef: ref(`${purpose}-credential-policy`) };
}

function policy() {
  return { schemaVersion: 'kg-provider-trust-policy/v1', policyId: 'deployment-provider-registry', version: 'registry-v1',
    scope: clone(scope), validFrom: '2026-10-09T03:00:00.000Z', validUntil: '2026-10-10T03:00:00.000Z',
    conformanceRequirementsHash: trust.PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    registrations: purposes.map(registration) };
}

function signed(kind, body, signer = {}) {
  const signatureIdentity = { algorithm: 'Ed25519', keyId: `${kind}-key`, keyVersion: 'key-v1', ...signer };
  const signedValue = { signatureProfile: 'kg-provider-attestation-signature/v1', kind, body,
    signer: signatureIdentity };
  return { kind, body: clone(body), signature: { ...signatureIdentity,
    value: sign(null, Buffer.from(canonicalJson(signedValue)), keys[kind].privateKey).toString('base64url') } };
}

function identity(value) {
  const { purpose, providerId, adapterDigest, version, imageDigest, artifactSignatureRef, configHash,
    endpointOrigin, executionProfile, fallback } = value;
  return { purpose, providerId, adapterDigest, version, imageDigest, artifactSignatureRef: clone(artifactSignatureRef),
    configHash, endpointOrigin, executionProfile, fallback };
}

function object(name, attestation) {
  return { ref: { objectId: name, objectVersion: 'object-v1', sha256: hash(attestation) }, attestation };
}

function fixtures(stage = 'T16') {
  const config = { executionProfile: 'local-reference', policy: policy(), policyRef: null,
    authorityKeys: kinds.map(kind => ({ kind, keyId: `${kind}-key`, keyVersion: 'key-v1', issuerId: issuers[kind],
      publicKeySpki: keys[kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      validFrom: '2026-10-09T03:00:00.000Z', validUntil: '2026-10-10T03:00:00.000Z', revoked: false })) };
  config.policyRef = { objectId: 'provider-registry', objectVersion: 'registry-object-v1', sha256: hash(config.policy) };
  const selected = config.policy.registrations.filter(value => stage === 'T17'
    ? value.purpose !== 'citation-locator' : purposes.slice(0, 8).includes(value.purpose) && (stage !== 'R18' || value.purpose !== 'ask'));
  const conformanceObjects = [], runtimeObjects = [], bindings = [];
  for (const value of selected) {
    const provider = identity(value);
    const conformance = object(`${value.purpose}-conformance`, signed('conformance', {
      schemaVersion: 'kg-provider-conformance-attestation/v1', registryRef: clone(config.policyRef), scope: clone(scope),
      provider, issuerId: issuers.conformance, issuedAt: signedAt, expiresAt: '2026-10-09T05:00:00.000Z',
      requirementsHash: trust.PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
      checks: trust.PROVIDER_CONFORMANCE_REQUIREMENTS[value.purpose].map(check => ({ check, verdict: 'passed' })),
      runNonce: hash(`harness-${value.purpose}`).slice(0, 32), verdict: 'passed',
    }));
    conformanceObjects.push(conformance);
    bindings.push({ purpose: value.purpose, providerId: value.providerId, adapterDigest: value.adapterDigest,
      version: value.version, configHash: value.configHash, conformanceRef: clone(conformance.ref) });
  }
  const providers = { registryRef: clone(config.policyRef), bindings };
  // Conformance -> provider set -> runtime measurement. Runtime object refs
  // never enter the provider-set preimage, so there is no signature/hash cycle.
  for (const value of selected) runtimeObjects.push(object(`${value.purpose}-runtime`, signed('runtime', {
    schemaVersion: 'kg-provider-runtime-attestation/v1', registryRef: clone(config.policyRef), scope: clone(scope),
    provider: identity(value), issuerId: issuers.runtime, issuedAt: signedAt, expiresAt: '2026-10-09T04:03:00.000Z',
    stage, providersHash: hash(providers), runNonce, manifestHash, instanceId: `${value.purpose}-instance`,
  })));
  const request = { stage, scope: clone(scope), runNonce, manifestHash, providers,
    executionProvidersHash: hash(providers), observedAt, conformanceObjects, runtimeObjects };
  return { config, request };
}

function verify(fixture = fixtures()) {
  return trust.createReferenceProviderTrustVerifier(fixture.config).verifySelection(fixture.request);
}
function refresh(objectValue) { objectValue.ref.sha256 = hash(objectValue.attestation); }
function resign(objectValue) {
  const { kind, body } = objectValue.attestation; objectValue.attestation = signed(kind, body); refresh(objectValue);
}
function refreshConformanceBinding(request, index) {
  request.providers.bindings[index].conformanceRef = clone(request.conformanceObjects[index].ref);
  request.executionProvidersHash = hash(request.providers);
  for (const measurement of request.runtimeObjects) {
    measurement.attestation.body.providersHash = request.executionProvidersHash; resign(measurement);
  }
}

test('stage-specific provider trust resolves only registered identities, with local proof but no production authority', () => {
  assert.equal(trust.PROVIDER_TRUST_POLICY_SCHEMA_VERSION, 'kg-provider-trust-policy/v1');
  assert.deepEqual([...trust.PROVIDER_PURPOSES], purposes);
  for (const [stage, count] of [['T16', 8], ['T17', 13], ['R18', 7]]) {
    const fixture = fixtures(stage); const result = verify(fixture);
    assert.equal(result.validationLevel, 'local-reference-cryptographic');
    assert.equal(result.productionAuthorized, false); assert.equal(result.providers.length, count);
    assert.equal(Object.isFrozen(result.providers[0].networkPolicy), true);
    assert.equal(result.providersHash, hash(fixture.request.providers));
    fixture.config.policy.registrations[0].endpointOrigin = 'https://changed.example.test';
    assert.equal(result.providers[0].endpointOrigin, 'https://secret.example.test');
  }
});

test('manifest selections cannot bootstrap a registry, inject origins, weaken network policy or change signed provider hashes', () => {
  for (const change of [request => { request.providers.registryRef = ref('untrusted-registry'); },
    request => { request.providers.bindings[0].endpointOrigin = 'https://injected.example.test'; },
    request => { request.providers.bindings[0].adapterDigest = hash('unregistered'); },
    request => { request.providers.bindings[0].version = 'unknown-version'; },
    request => { request.providers.bindings[0].configHash = hash('unregistered-config'); },
    request => { request.executionProvidersHash = hash('other-provider-set'); },
    request => { request.policy = policy(); }]) {
    const fixture = fixtures(); change(fixture.request);
    assert.throws(() => verify(fixture), /provider trust/);
  }
});

test('deployment policy has an exact scope and out-of-band object digest/version', () => {
  for (const change of [fixture => { fixture.config.policyRef.sha256 = hash('other-policy'); },
    fixture => { fixture.request.scope.corpusId = 'other-corpus'; },
    fixture => { fixture.request.providers.registryRef.objectVersion = 'other-version'; },
    fixture => { fixture.config.policy.registrations.push(clone(fixture.config.policy.registrations[0])); }]) {
    const fixture = fixtures(); change(fixture);
    assert.throws(() => verify(fixture), /provider trust/);
  }
});

test('production/fake/reference/fallback profiles are fail closed even with recomputed local signatures', () => {
  const config = fixtures().config; config.executionProfile = 'production';
  assert.throws(() => trust.createReferenceProviderTrustVerifier(config), /provider trust/);
  for (const change of [provider => { provider.executionProfile = 'local-reference'; },
    provider => { provider.executionProfile = 'fake'; }, provider => { provider.fallback = true; }]) {
    const fixture = fixtures(); change(fixture.request.runtimeObjects[0].attestation.body.provider);
    resign(fixture.request.runtimeObjects[0]); assert.throws(() => verify(fixture), /provider trust/);
    const another = fixtures(); change(another.config.policy.registrations[0]);
    another.config.policyRef.sha256 = hash(another.config.policy);
    assert.throws(() => trust.createReferenceProviderTrustVerifier(another.config), /provider trust/);
  }
});

test('conformance is an independently signed sealed object, never adapter self-report', () => {
  for (const change of [body => { body.issuerId = 'secret-operator'; }, body => { body.verdict = 'failed'; },
    body => { body.checks[0].verdict = 'failed'; }, body => { body.checks.pop(); },
    body => { body.checks.push(clone(body.checks[0])); }, body => { body.requirementsHash = hash('weaker-suite'); },
    body => { body.provider.configHash = hash('other-config'); }]) {
    const fixture = fixtures(); change(fixture.request.conformanceObjects[0].attestation.body);
    resign(fixture.request.conformanceObjects[0]); refreshConformanceBinding(fixture.request, 0);
    assert.throws(() => verify(fixture), /provider trust/);
  }
  const unsigned = fixtures(); unsigned.request.conformanceObjects[0].attestation.signature.value = Buffer.alloc(64).toString('base64url');
  refresh(unsigned.request.conformanceObjects[0]); refreshConformanceBinding(unsigned.request, 0);
  assert.throws(() => verify(unsigned), /provider trust/);
});

test('runtime measurement is separately signed and exact run/manifest/scope/image/origin bound', () => {
  for (const change of [body => { body.issuerId = 'secret-operator'; },
    body => { body.issuerId = issuers.conformance; }, body => { body.runNonce = 'a'.repeat(32); },
    body => { body.manifestHash = hash('other-run-manifest'); }, body => { body.scope.tenantId = 'other-tenant'; },
    body => { body.provider.imageDigest = `sha256:${hash('other-image')}`; },
    body => { body.provider.endpointOrigin = 'https://different.example.test'; },
    body => { body.provider.artifactSignatureRef.objectVersion = 'other-version'; }]) {
    const fixture = fixtures(); change(fixture.request.runtimeObjects[0].attestation.body);
    resign(fixture.request.runtimeObjects[0]); assert.throws(() => verify(fixture), /provider trust/);
  }
});

test('unsigned request stage relabeling or provider-set substitution cannot reuse runtime proofs', () => {
  const relabeled = fixtures('T17'); relabeled.request.stage = 'T16';
  assert.throws(() => verify(relabeled), /provider trust/);
  const subset = fixtures('T16'); subset.request.stage = 'R18';
  for (const field of ['bindings']) subset.request.providers[field] = subset.request.providers[field].filter(value => value.purpose !== 'ask');
  for (const field of ['conformanceObjects', 'runtimeObjects']) {
    subset.request[field] = subset.request[field].filter(value => value.attestation.body.provider.purpose !== 'ask');
  }
  subset.request.executionProvidersHash = hash(subset.request.providers);
  assert.throws(() => verify(subset), /provider trust/);
});

test('missing/extra/duplicate providers or readbacks cannot turn a subset into conformance success', () => {
  for (const change of [request => { request.providers.bindings.pop(); },
    request => { request.providers.bindings.push(clone(request.providers.bindings[0])); },
    request => { request.conformanceObjects.pop(); }, request => { request.runtimeObjects.pop(); },
    request => { request.runtimeObjects.push(clone(request.runtimeObjects[0])); },
    request => { request.conformanceObjects[0].ref.objectVersion = 'replaced-object-version'; },
    request => { request.runtimeObjects[0].ref.sha256 = hash('modified-runtime-readback'); }]) {
    const fixture = fixtures(); change(fixture.request); fixture.request.executionProvidersHash = hash(fixture.request.providers);
    assert.throws(() => verify(fixture), /provider trust/);
  }
});

test('policy and authorities reject stale/revoked/unknown keys and reused signer material', () => {
  for (const change of [key => { key.revoked = true; }, key => { key.keyVersion = 'other-version'; },
    key => { key.issuerId = 'other-reader'; }, key => { key.validUntil = observedAt; }]) {
    const fixture = fixtures(); change(fixture.config.authorityKeys[0]);
    assert.throws(() => verify(fixture), /provider trust/);
  }
  const reused = fixtures(); reused.config.authorityKeys[1].publicKeySpki = reused.config.authorityKeys[0].publicKeySpki;
  assert.throws(() => trust.createReferenceProviderTrustVerifier(reused.config), /provider trust/);
  const merged = fixtures(); merged.config.authorityKeys[1].issuerId = issuers.conformance;
  assert.throws(() => trust.createReferenceProviderTrustVerifier(merged.config), /provider trust/);
});

test('runtime measurement expires quickly, future/stale attestations and clock rollback are rejected', () => {
  for (const time of ['2026-10-09T03:59:59.999Z', '2026-10-09T04:03:00.000Z', '2026-10-10T04:00:00.000Z']) {
    const fixture = fixtures(); fixture.request.observedAt = time;
    assert.throws(() => verify(fixture), /provider trust/);
  }
  const longLived = fixtures(); longLived.request.runtimeObjects[0].attestation.body.expiresAt = '2026-10-09T04:05:00.001Z';
  resign(longLived.request.runtimeObjects[0]); assert.throws(() => verify(longLived), /provider trust/);
  const fixture = fixtures(); const verifier = trust.createReferenceProviderTrustVerifier(fixture.config);
  assert.equal(verifier.verifySelection(fixture.request).productionAuthorized, false);
  fixture.request.observedAt = '2026-10-09T04:00:59.999Z';
  assert.throws(() => verifier.verifySelection(fixture.request), /provider trust.*clock/);
});

test('origin/network/credential policy is closed, bounded, TLS-only and free of inline secrets', () => {
  for (const change of [value => { value.endpointOrigin = 'http://provider.example.test'; },
    value => { value.endpointOrigin = 'https://user:password@provider.example.test'; },
    value => { value.endpointOrigin += '/api'; }, value => { value.endpointOrigin += '?key=secret'; },
    value => { value.networkPolicy.redirects = 'allowed'; }, value => { value.networkPolicy.tlsChainVerification = false; },
    value => { value.networkPolicy.proxy = 'ambient'; }, value => { value.networkPolicy.port = 8443; },
    value => { value.networkPolicy.maxResponseBytes = 0; }, value => { value.credentialPolicyRef.objectId = '../secrets'; },
    value => { value.token = 'inline-secret'; }]) {
    const fixture = fixtures(); change(fixture.config.policy.registrations[0]);
    fixture.config.policyRef.sha256 = hash(fixture.config.policy);
    assert.throws(() => trust.createReferenceProviderTrustVerifier(fixture.config), /provider trust/);
  }
});

test('opaque fields/getters/proxies/extra payloads never execute caller code or leak diagnostics', () => {
  const secret = 'secret-not-for-diagnostics'; let calls = 0;
  const trap = () => { calls += 1; throw new Error(secret); };
  const fixture = fixtures();
  for (const input of [new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    Object.defineProperty({}, 'policy', { enumerable: true, get: trap }),
    { ...fixture.config, [secret]: true }]) {
    assert.throws(() => trust.createReferenceProviderTrustVerifier(input), error => {
      assert.equal(error.message.includes(secret), false); assert.match(error.message, /provider trust|canonical JSON/); return true;
    });
  }
  const bad = fixtures(); bad.request.runtimeObjects[0].attestation.body[secret] = secret;
  resign(bad.request.runtimeObjects[0]);
  assert.throws(() => verify(bad), error => {
    assert.equal(error.message.includes(secret), false); assert.match(error.message, /provider trust/); return true;
  });
  assert.equal(calls, 0);
});
