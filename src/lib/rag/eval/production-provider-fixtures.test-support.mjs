import { generateKeyPairSync, sign } from 'node:crypto';
import { registerHooks } from 'node:module';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('./') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });
const trust = await import('./production-provider-trust.ts');
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
export const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const observedAt = '2026-10-09T04:01:00.000Z';
const runNonce = '0123456789abcdef0123456789abcdef';
const manifestHash = hash('manifest');
const keys = Object.fromEntries(['conformance', 'runtime'].map(kind => [kind, generateKeyPairSync('ed25519')]));
const issuers = { conformance: 'independent-harness', runtime: 'independent-runtime-reader' };

export function fixture(stage = 'T16', changes = {}) {
  const selectedManifestHash = changes.manifestHash ?? manifestHash;
  const policy = { schemaVersion: trust.PROVIDER_TRUST_POLICY_SCHEMA_VERSION, policyId: 'registry-policy', version: 'v1',
    scope: clone(scope), validFrom: changes.validFrom ?? '2026-10-09T03:00:00.000Z', validUntil: '2026-10-10T03:00:00.000Z',
    conformanceRequirementsHash: trust.PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    registrations: trust.PROVIDER_PURPOSES.map(purpose => ({ purpose, providerId: `${purpose}-provider`,
      adapterDigest: hash(`${purpose}-adapter`), version: 'v1', imageDigest: `sha256:${hash(`${purpose}-image`)}`,
      artifactSignatureRef: ref(`${purpose}-signature`), configHash: hash(`${purpose}-config`),
      endpointOrigin: `https://${purpose}.example.test`, executionProfile: 'enterprise', fallback: false,
      operatorId: `${purpose}-operator`, credentialPolicyRef: ref(`${purpose}-credential`),
      networkPolicy: { port: 443, redirects: 'forbidden', proxy: 'disabled', tlsHostnameVerification: true,
        tlsChainVerification: true, tlsTrustRootsRef: ref('roots'), dnsPolicyRef: ref('dns'), requestTimeoutMs: 5000,
        maxCompressedBytes: 1048576, maxResponseBytes: 2097152, maxStreamBytes: 2097152 } })) };
  const policyRef = { objectId: 'provider-registry', objectVersion: 'v1', sha256: hash(policy) };
  const sourceIdentityRef = ref('registry-reader-source');
  const registryConfig = { executionProfile: 'local-reference', scope: clone(scope), sourceIdentityRef,
    readOnlyActorIds: ['registry-reader'], maxReads: 32, policies: [{ ref: policyRef, policy }] };
  const options = { executionProfile: 'local-reference', scope: clone(scope), registryRef: policyRef,
    registryIdentityRef: sourceIdentityRef, readerId: 'registry-reader', readerAuthorizationDigest: hash('authorization'),
    operationTimeoutMs: 1000, maxVerifications: 32,
    authorityKeys: ['conformance', 'runtime'].map(kind => ({ kind, keyId: `${kind}-key`, keyVersion: 'v1',
      issuerId: issuers[kind], publicKeySpki: keys[kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      validFrom: policy.validFrom, validUntil: policy.validUntil, revoked: false })) };
  const selected = policy.registrations.filter(value => stage === 'T17' ? value.purpose !== 'citation-locator'
    : trust.PROVIDER_PURPOSES.slice(0, 8).includes(value.purpose) && (stage !== 'R18' || value.purpose !== 'ask'));
  const identity = value => Object.fromEntries(['purpose', 'providerId', 'adapterDigest', 'version', 'imageDigest',
    'artifactSignatureRef', 'configHash', 'endpointOrigin', 'executionProfile', 'fallback'].map(key => [key, clone(value[key])]));
  const object = (kind, purpose, body) => {
    const signer = { algorithm: 'Ed25519', keyId: `${kind}-key`, keyVersion: 'v1' };
    const attestation = { kind, body, signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({
      signatureProfile: 'kg-provider-attestation-signature/v1', kind, body, signer })), keys[kind].privateKey).toString('base64url') } };
    return { ref: { objectId: `${purpose}-${kind}`, objectVersion: 'v1', sha256: hash(attestation) }, attestation };
  };
  const conformanceObjects = selected.map(value => object('conformance', value.purpose, {
    schemaVersion: 'kg-provider-conformance-attestation/v1', registryRef: clone(policyRef), scope: clone(scope),
    provider: identity(value), issuerId: issuers.conformance, issuedAt: changes.issuedAt ?? '2026-10-09T04:00:00.000Z',
    expiresAt: '2026-10-09T05:00:00.000Z', runNonce: hash(`harness-${value.purpose}`).slice(0, 32),
    requirementsHash: trust.PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    checks: trust.PROVIDER_CONFORMANCE_REQUIREMENTS[value.purpose].map(check => ({ check, verdict: 'passed' })), verdict: 'passed' }));
  const providers = { registryRef: clone(policyRef), bindings: selected.map((value, index) => ({ purpose: value.purpose,
    providerId: value.providerId, adapterDigest: value.adapterDigest, version: value.version,
    configHash: value.configHash, conformanceRef: clone(conformanceObjects[index].ref) })) };
  const request = { stage, scope: clone(scope), runNonce, manifestHash: selectedManifestHash, providers, executionProvidersHash: hash(providers),
    observedAt, conformanceObjects, runtimeObjects: selected.map(value => object('runtime', value.purpose, {
      schemaVersion: 'kg-provider-runtime-attestation/v1', registryRef: clone(policyRef), scope: clone(scope),
      provider: identity(value), issuerId: issuers.runtime, issuedAt: changes.issuedAt ?? '2026-10-09T04:00:00.000Z',
      expiresAt: '2026-10-09T04:03:00.000Z', runNonce, manifestHash: selectedManifestHash, stage, providersHash: hash(providers),
      instanceId: `${value.purpose}-instance` })) };
  const readRequest = { context: { executionProfile: 'local-reference', binding: { ...scope, runNonce, manifestHash: selectedManifestHash },
    actorId: options.readerId, authorizationDigest: options.readerAuthorizationDigest, observedAt },
    policyRef: clone(policyRef), requestNonce: hash('read-request').slice(0, 32) };
  return { policy, policyRef, sourceIdentityRef, registryConfig, options, request, readRequest };
}
