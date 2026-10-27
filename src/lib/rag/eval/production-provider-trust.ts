import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import type { ArtifactReference, ProductionGateStage } from './production-gate-manifest';
import type { AuthorizationScope } from './production-authorization';

export const PROVIDER_TRUST_POLICY_SCHEMA_VERSION = 'kg-provider-trust-policy/v1' as const;
export const PROVIDER_PURPOSES = Object.freeze(['secret', 'kms', 'approval', 'tamper-store', 'clock', 'ask',
  'publication-readback', 'run-journal', 'lease', 'fencing', 'deployment', 'traffic', 'fault', 'citation-locator'] as const);
export type ProviderPurpose = typeof PROVIDER_PURPOSES[number];
export const PROVIDER_REQUIRED_PURPOSES_BY_STAGE: Readonly<Record<ProductionGateStage, readonly ProviderPurpose[]>> = Object.freeze({
  T16: Object.freeze(PROVIDER_PURPOSES.slice(0, 8)), T17: Object.freeze(PROVIDER_PURPOSES.slice(0, 13)),
  R18: Object.freeze(PROVIDER_PURPOSES.slice(0, 8).filter(purpose => purpose !== 'ask')),
});

const COMMON_CHECKS = ['exact-identity', 'scoped-authorization', 'no-fallback', 'bounded-io', 'structured-redaction'];
const PURPOSE_CHECKS: Record<ProviderPurpose, readonly string[]> = {
  secret: ['origin-before-credential', 'minimum-scope', 'no-argv-or-dump'],
  kms: ['unique-object-nonce', 'aad-swap-rejection', 'rotation-and-revocation'],
  approval: ['kind-and-duty-separation', 'expiry-and-revocation', 'durable-nonce-replay-rejection'],
  'tamper-store': ['immutable-exclusive-create', 'exact-version-readback', 'lifecycle-and-legal-hold'],
  clock: ['authority-proof', 'monotonic-time', 'unavailable-fail-closed'],
  ask: ['origin-dns-tls-enforcement', 'paired-arm-identity', 'deadline-and-response-limits'],
  'publication-readback': ['exact-three-store-identity', 'superset-subset-rejection', 'read-only-identity'],
  'run-journal': ['transactional-cas', 'chain-and-authoritative-head', 'stale-fence-rejection'],
  lease: ['distributed-scope-exclusion', 'renewal-and-expiry', 'monotonic-fencing'],
  fencing: ['monotonic-generation', 'every-mutation-enforced', 'stale-owner-rejection'],
  deployment: ['canary-only-mode', 'actual-process-readback', 'stale-fence-rejection'],
  traffic: ['exact-selector', 'lease-ttl-zero-deadman', 'stale-fence-rejection'],
  fault: ['closed-canary-fault', 'ttl-automatic-revocation', 'stale-fence-rejection'],
  'citation-locator': ['opaque-and-purpose-bound', 'shared-ttl-and-key-rotation', 'current-principal-reauthorization'],
};
/** This freezes REQUIRED tests, not a claim that those behavioral suites ran. */
export const PROVIDER_CONFORMANCE_REQUIREMENTS = Object.freeze(Object.fromEntries(PROVIDER_PURPOSES.map(
  purpose => [purpose, Object.freeze([...COMMON_CHECKS, ...PURPOSE_CHECKS[purpose]])]
)) as Record<ProviderPurpose, readonly string[]>);
export const PROVIDER_CONFORMANCE_REQUIREMENTS_HASH = canonicalJsonSha256({
  schemaVersion: 'kg-provider-conformance-requirements/v1', purposes: PROVIDER_CONFORMANCE_REQUIREMENTS,
});

export interface ProviderNetworkPolicy {
  readonly port: number;
  readonly redirects: 'forbidden';
  readonly proxy: 'disabled';
  readonly tlsHostnameVerification: true;
  readonly tlsChainVerification: true;
  readonly tlsTrustRootsRef: ArtifactReference;
  readonly dnsPolicyRef: ArtifactReference;
  readonly requestTimeoutMs: number;
  readonly maxCompressedBytes: number;
  readonly maxResponseBytes: number;
  readonly maxStreamBytes: number;
}
export interface ProviderIdentity {
  readonly purpose: ProviderPurpose;
  readonly providerId: string;
  readonly adapterDigest: string;
  readonly version: string;
  readonly imageDigest: string;
  readonly artifactSignatureRef: ArtifactReference;
  readonly configHash: string;
  readonly endpointOrigin: string;
  readonly executionProfile: 'enterprise';
  readonly fallback: false;
}
export interface ProviderRegistration extends ProviderIdentity {
  readonly operatorId: string;
  readonly networkPolicy: ProviderNetworkPolicy;
  readonly credentialPolicyRef: ArtifactReference;
}
export interface ProviderTrustPolicy {
  readonly schemaVersion: typeof PROVIDER_TRUST_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly version: string;
  readonly scope: AuthorizationScope;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly conformanceRequirementsHash: string;
  readonly registrations: readonly ProviderRegistration[];
}
export interface ProviderManifestBinding {
  readonly purpose: ProviderPurpose;
  readonly providerId: string;
  readonly adapterDigest: string;
  readonly version: string;
  readonly configHash: string;
  readonly conformanceRef: ArtifactReference;
}
export interface ReferenceProviderTrustDecision {
  readonly validationLevel: 'local-reference-cryptographic';
  readonly productionAuthorized: false;
  readonly signaturesVerified: true;
  readonly policyHash: string;
  readonly providersHash: string;
  readonly stage: ProductionGateStage;
  readonly scope: AuthorizationScope;
  readonly runNonce: string;
  readonly manifestHash: string;
  readonly verifiedAt: string;
  readonly providers: readonly ProviderRegistration[];
}
export interface ReferenceProviderTrustVerifier {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  verifySelection(request: unknown): ReferenceProviderTrustDecision;
}

type Fields = Record<string, unknown>;
type AttestationKind = 'conformance' | 'runtime';
interface AuthorityKey {
  readonly kind: AttestationKind;
  readonly issuerId: string;
  readonly publicKey: KeyObject;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly revoked: boolean;
}
const IDENTITY_FIELDS = ['purpose', 'providerId', 'adapterDigest', 'version', 'imageDigest', 'artifactSignatureRef',
  'configHash', 'endpointOrigin', 'executionProfile', 'fallback'];
const BINDING_FIELDS = ['purpose', 'providerId', 'adapterDigest', 'version', 'configHash', 'conformanceRef'];
const BODY_FIELDS = ['schemaVersion', 'registryRef', 'scope', 'provider', 'issuerId', 'issuedAt', 'expiresAt', 'runNonce'];
const MAX_POLICY_MS = 31 * 86400000;
const MAX_ATTESTATION_MS = { conformance: 30 * 86400000, runtime: 300000 };

/** Only structural consistency. Deployment policy authenticity is external. */
export function validateProviderTrustPolicy(input: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAuthorized: false;
  readonly policyHash: string; readonly policy: ProviderTrustPolicy;
} {
  const policy = snapshot(input, '$.policy');
  exactKeys(policy, ['schemaVersion', 'policyId', 'version', 'scope', 'validFrom', 'validUntil',
    'conformanceRequirementsHash', 'registrations'], '$.policy');
  if (policy.schemaVersion !== PROVIDER_TRUST_POLICY_SCHEMA_VERSION) fail('$.policy.schemaVersion', 'unsupported registry schema');
  identifier(policy.policyId, '$.policy.policyId'); identifier(policy.version, '$.policy.version');
  validateScope(policy.scope, '$.policy.scope');
  const start = timestamp(policy.validFrom, '$.policy.validFrom'); const end = timestamp(policy.validUntil, '$.policy.validUntil');
  if (end <= start || end - start > MAX_POLICY_MS) fail('$.policy', 'registry validity outside profile bounds');
  if (policy.conformanceRequirementsHash !== PROVIDER_CONFORMANCE_REQUIREMENTS_HASH) fail('$.policy.conformanceRequirementsHash', 'requirements cannot be replaced or weakened');
  const registrations = boundedArray(policy.registrations, '$.policy.registrations', 1, 64);
  const seen = new Set<string>();
  registrations.forEach((inputRegistration, index) => {
    const path = `$.policy.registrations[${index}]`;
    const registration = record(inputRegistration, path);
    exactKeys(registration, [...IDENTITY_FIELDS, 'operatorId', 'networkPolicy', 'credentialPolicyRef'], path);
    validateIdentity(registration, path, false);
    identifier(registration.operatorId, `${path}.operatorId`);
    reference(registration.credentialPolicyRef, `${path}.credentialPolicyRef`);
    validateNetworkPolicy(registration.networkPolicy, registration.endpointOrigin as string, `${path}.networkPolicy`);
    const tuple = canonicalJson([registration.purpose, registration.providerId]);
    if (seen.has(tuple)) fail(path, 'duplicate purpose/provider registration');
    seen.add(tuple);
  });
  return freeze({ validationLevel: 'structural-only', productionAuthorized: false,
    policyHash: canonicalJsonSha256(policy), policy: policy as unknown as ProviderTrustPolicy });
}

/**
 * The manifest cannot supply roots or endpoints. This local factory receives a
 * detached deployment-policy TEST anchor and two independent public-key roles.
 * It is not an enterprise registry/clock/store/measurement implementation.
 */
export function createReferenceProviderTrustVerifier(options: unknown): ReferenceProviderTrustVerifier {
  const config = snapshot(options, '$.reference');
  exactKeys(config, ['executionProfile', 'policy', 'policyRef', 'authorityKeys'], '$.reference');
  if (config.executionProfile !== 'local-reference') fail('$.reference.executionProfile', 'reference verifier cannot serve production');
  const validatedPolicy = validateProviderTrustPolicy(config.policy);
  const { policy, policyHash } = validatedPolicy;
  const policyRef = reference(config.policyRef, '$.reference.policyRef');
  if (policyRef.sha256 !== policyHash) fail('$.reference.policyRef', 'out-of-band registry digest mismatch');
  const keys = parseAuthorityKeys(config.authorityKeys, policy);
  const registered = new Map(policy.registrations.map(value => [canonicalJson([value.purpose, value.providerId]), value]));
  let lastObservedTime = -Infinity;
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    verifySelection(input: unknown): ReferenceProviderTrustDecision {
      const request = snapshot(input, '$.selection');
      exactKeys(request, ['stage', 'scope', 'runNonce', 'manifestHash', 'providers', 'executionProvidersHash',
        'observedAt', 'conformanceObjects', 'runtimeObjects'], '$.selection');
      const stage = select(request.stage, ['T16', 'T17', 'R18'], '$.selection.stage') as ProductionGateStage;
      validateScope(request.scope, '$.selection.scope');
      if (canonicalJson(request.scope) !== canonicalJson(policy.scope)) fail('$.selection.scope', 'registry scope mismatch');
      hex(request.runNonce, 32, '$.selection.runNonce'); digest(request.manifestHash, '$.selection.manifestHash');
      const now = timestamp(request.observedAt, '$.selection.observedAt');
      if (now < lastObservedTime) fail('$.selection.observedAt', 'local clock moved backwards');
      if (now < Date.parse(policy.validFrom) || now >= Date.parse(policy.validUntil)) fail('$.selection.observedAt', 'registry expired or not yet valid');
      const providers = record(request.providers, '$.selection.providers');
      exactKeys(providers, ['registryRef', 'bindings'], '$.selection.providers');
      if (canonicalJson(reference(providers.registryRef, '$.selection.providers.registryRef')) !== canonicalJson(policyRef)) fail('$.selection.providers.registryRef', 'unapproved registry identity/version');
      if (request.executionProvidersHash !== canonicalJsonSha256(providers)) fail('$.selection.executionProvidersHash', 'execution provider set digest mismatch');
      const bindings = boundedArray(providers.bindings, '$.selection.providers.bindings', 1, 14);
      const conformance = boundedArray(request.conformanceObjects, '$.selection.conformanceObjects', bindings.length, bindings.length);
      const runtime = boundedArray(request.runtimeObjects, '$.selection.runtimeObjects', bindings.length, bindings.length);
      const conformanceByRef = attestationObjects(conformance, 'conformance');
      const runtimeByProvider = attestationObjects(runtime, 'runtime');
      const seen = new Set<string>();
      const resolved: ProviderRegistration[] = [];
      bindings.forEach((inputBinding, index) => {
        const path = `$.selection.providers.bindings[${index}]`;
        const binding = record(inputBinding, path); exactKeys(binding, BINDING_FIELDS, path);
        const purpose = select(binding.purpose, PROVIDER_PURPOSES, `${path}.purpose`) as ProviderPurpose;
        identifier(binding.providerId, `${path}.providerId`); identifier(binding.version, `${path}.version`);
        digest(binding.adapterDigest, `${path}.adapterDigest`); digest(binding.configHash, `${path}.configHash`);
        if (seen.has(purpose)) fail(path, 'ambiguous or duplicate selected purpose');
        seen.add(purpose);
        const provider = registered.get(canonicalJson([purpose, binding.providerId]));
        if (!provider || ['adapterDigest', 'version', 'configHash'].some(field => binding[field] !== provider[field as keyof ProviderRegistration])) fail(path, 'provider identity is not registered');
        const conformanceRef = reference(binding.conformanceRef, `${path}.conformanceRef`);
        const certificate = conformanceByRef.get(canonicalJson(conformanceRef));
        const measurement = runtimeByProvider.get(canonicalJson([purpose, binding.providerId]));
        if (!certificate || !measurement) fail(path, 'exact independent conformance/runtime readback absent');
        verifyAttestation(certificate, 'conformance', provider, request, policyRef, policy, keys, now);
        verifyAttestation(measurement, 'runtime', provider, request, policyRef, policy, keys, now);
        const harnessIssuer = record(certificate.body, '$.conformance.body').issuerId;
        const runtimeIssuer = record(measurement.body, '$.runtime.body').issuerId;
        if (harnessIssuer === runtimeIssuer) fail(path, 'harness and runtime reader must be independent');
        resolved.push(provider);
      });
      const required = PROVIDER_REQUIRED_PURPOSES_BY_STAGE[stage];
      if (required.some(purpose => !seen.has(purpose))) fail('$.selection.providers', 'required stage provider absent');
      // No unmatched/extra proof may be presented as part of a successful run.
      if (conformanceByRef.size !== seen.size || runtimeByProvider.size !== seen.size) fail('$.selection', 'unexpected attestation object');
      lastObservedTime = now;
      return freeze({ validationLevel: 'local-reference-cryptographic', productionAuthorized: false, signaturesVerified: true,
        policyHash, providersHash: canonicalJsonSha256(providers), stage, scope: policy.scope,
        runNonce: request.runNonce as string, manifestHash: request.manifestHash as string,
        verifiedAt: request.observedAt as string, providers: resolved });
    },
  });
}

function verifyAttestation(attestation: Fields, kind: AttestationKind, provider: ProviderRegistration,
  request: Fields, policyRef: ArtifactReference, policy: ProviderTrustPolicy, keys: Map<string, AuthorityKey>, now: number): void {
  const path = `$.${kind}`;
  exactKeys(attestation, ['kind', 'body', 'signature'], path);
  if (attestation.kind !== kind) fail(path, 'attestation roles cannot be interchanged');
  const body = record(attestation.body, `${path}.body`);
  exactKeys(body, [...BODY_FIELDS, ...(kind === 'conformance' ? ['requirementsHash', 'checks', 'verdict']
    : ['manifestHash', 'instanceId', 'stage', 'providersHash'])], `${path}.body`);
  if (body.schemaVersion !== `kg-provider-${kind === 'conformance' ? 'conformance' : 'runtime'}-attestation/v1`) fail(`${path}.body.schemaVersion`, 'unsupported attestation schema');
  validateScope(body.scope, `${path}.body.scope`);
  if (canonicalJson(body.scope) !== canonicalJson(policy.scope)
    || canonicalJson(reference(body.registryRef, `${path}.body.registryRef`)) !== canonicalJson(policyRef)) fail(path, 'attestation registry/scope mismatch');
  const measuredIdentity = record(body.provider, `${path}.body.provider`);
  validateIdentity(measuredIdentity, `${path}.body.provider`, true);
  const expectedIdentity = Object.fromEntries(IDENTITY_FIELDS.map(field => [field, provider[field as keyof ProviderIdentity]]));
  if (canonicalJson(measuredIdentity) !== canonicalJson(expectedIdentity)) fail(path, 'measured identity does not match registered artifact/image/config/origin');
  identifier(body.issuerId, `${path}.body.issuerId`);
  if (body.issuerId === provider.operatorId) fail(path, 'provider operator cannot attest its own conformance/runtime');
  const issued = timestamp(body.issuedAt, `${path}.body.issuedAt`); const expires = timestamp(body.expiresAt, `${path}.body.expiresAt`);
  if (expires <= issued || expires - issued > MAX_ATTESTATION_MS[kind] || now < issued || now >= expires
    || issued < Date.parse(policy.validFrom) || expires > Date.parse(policy.validUntil)) fail(path, 'attestation validity/TTL outside policy/profile');
  hex(body.runNonce, 32, `${path}.body.runNonce`);
  if (kind === 'conformance') {
    if (body.requirementsHash !== PROVIDER_CONFORMANCE_REQUIREMENTS_HASH || body.verdict !== 'passed') fail(path, 'independent conformance failed or requirements changed');
    const required = PROVIDER_CONFORMANCE_REQUIREMENTS[provider.purpose];
    const checks = boundedArray(body.checks, `${path}.body.checks`, required.length, required.length);
    const seen = new Set<string>();
    checks.forEach((input, index) => {
      const check = record(input, `${path}.body.checks[${index}]`);
      exactKeys(check, ['check', 'verdict'], `${path}.body.checks[${index}]`);
      const name = select(check.check, required, `${path}.body.checks[${index}].check`);
      if (check.verdict !== 'passed' || seen.has(name)) fail(`${path}.body.checks`, 'failed/duplicate required behavioral check');
      seen.add(name);
    });
  } else {
    identifier(body.instanceId, `${path}.body.instanceId`); digest(body.manifestHash, `${path}.body.manifestHash`);
    digest(body.providersHash, `${path}.body.providersHash`);
    // An unsigned caller must not relabel a T17 measurement as T16 or remove
    // providers while preserving an otherwise valid manifest/run digest.
    if (body.runNonce !== request.runNonce || body.manifestHash !== request.manifestHash
      || body.stage !== request.stage || body.providersHash !== request.executionProvidersHash) fail(path, 'runtime measurement belongs to another run/manifest/stage/provider set');
  }
  const signature = record(attestation.signature, `${path}.signature`);
  exactKeys(signature, ['algorithm', 'keyId', 'keyVersion', 'value'], `${path}.signature`);
  if (signature.algorithm !== 'Ed25519') fail(`${path}.signature`, 'unsupported attestation signature profile');
  identifier(signature.keyId, `${path}.signature.keyId`); identifier(signature.keyVersion, `${path}.signature.keyVersion`);
  const signatureBytes = base64url(signature.value, `${path}.signature.value`, 64);
  const key = keys.get(canonicalJson([signature.keyId, signature.keyVersion]));
  if (!key || key.kind !== kind || key.revoked || key.issuerId !== body.issuerId || issued < key.validFrom
    || expires > key.validUntil || now < key.validFrom || now >= key.validUntil) fail(`${path}.signature`, 'unknown/revoked/expired/wrong-role authority');
  const signer = { algorithm: signature.algorithm, keyId: signature.keyId, keyVersion: signature.keyVersion };
  const bytes = canonicalJson({ signatureProfile: 'kg-provider-attestation-signature/v1', kind, body, signer });
  let validSignature = false;
  try { validSignature = verify(null, Buffer.from(bytes), key.publicKey, signatureBytes); }
  catch { fail(`${path}.signature`, 'attestation signature verification failed'); }
  if (!validSignature) fail(`${path}.signature`, 'attestation signature verification failed');
}

function attestationObjects(objects: unknown[], kind: AttestationKind): Map<string, Fields> {
  const selected = new Map<string, Fields>();
  objects.forEach((input, index) => {
    const path = `$.${kind}Objects[${index}]`; const object = record(input, path);
    exactKeys(object, ['ref', 'attestation'], path);
    const ref = reference(object.ref, `${path}.ref`);
    const attestation = record(object.attestation, `${path}.attestation`);
    if (ref.sha256 !== canonicalJsonSha256(attestation)) fail(path, 'object digest/readback mismatch');
    const body = record(attestation.body, `${path}.attestation.body`);
    const provider = record(body.provider, `${path}.attestation.body.provider`);
    const key = kind === 'conformance' ? canonicalJson(ref) : canonicalJson([provider.purpose, provider.providerId]);
    if (selected.has(key)) fail(path, 'duplicate or ambiguous attestation readback');
    selected.set(key, attestation);
  });
  return selected;
}

function parseAuthorityKeys(input: unknown, policy: ProviderTrustPolicy): Map<string, AuthorityKey> {
  const keys = new Map<string, AuthorityKey>(); const material = new Set<string>();
  const issuers = new Map<string, AttestationKind>(); const kinds = new Set<AttestationKind>();
  boundedArray(input, '$.reference.authorityKeys', 2, 16).forEach((inputKey, index) => {
    const path = `$.reference.authorityKeys[${index}]`; const key = record(inputKey, path);
    exactKeys(key, ['kind', 'keyId', 'keyVersion', 'issuerId', 'publicKeySpki', 'validFrom', 'validUntil', 'revoked'], path);
    const kind = select(key.kind, ['conformance', 'runtime'], `${path}.kind`) as AttestationKind;
    for (const field of ['keyId', 'keyVersion', 'issuerId']) identifier(key[field], `${path}.${field}`);
    if (typeof key.revoked !== 'boolean') fail(`${path}.revoked`, 'explicit revoked state required');
    const from = timestamp(key.validFrom, `${path}.validFrom`); const until = timestamp(key.validUntil, `${path}.validUntil`);
    if (until <= from) fail(path, 'empty authority key validity');
    const bytes = base64url(key.publicKeySpki, `${path}.publicKeySpki`, 44);
    let publicKey: KeyObject;
    try { publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' }); }
    catch { fail(`${path}.publicKeySpki`, 'invalid Ed25519 public key'); }
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
      || publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') !== key.publicKeySpki) fail(`${path}.publicKeySpki`, 'invalid canonical Ed25519 public key');
    const identity = canonicalJson([key.keyId, key.keyVersion]);
    if (keys.has(identity) || material.has(key.publicKeySpki as string)) fail(path, 'duplicate/reused authority key material');
    const issuer = key.issuerId as string;
    if ((issuers.has(issuer) && issuers.get(issuer) !== kind) || policy.registrations.some(provider => provider.operatorId === issuer)) fail(path, 'harness/runtime/provider authority duties must be independent');
    material.add(key.publicKeySpki as string); issuers.set(issuer, kind); kinds.add(kind);
    keys.set(identity, { kind, issuerId: issuer, publicKey, validFrom: from, validUntil: until, revoked: key.revoked });
  });
  if (kinds.size !== 2) fail('$.reference.authorityKeys', 'both independent authority roles required');
  return keys;
}

function validateIdentity(identity: Fields, path: string, exact: boolean): void {
  if (exact) exactKeys(identity, IDENTITY_FIELDS, path);
  select(identity.purpose, PROVIDER_PURPOSES, `${path}.purpose`);
  identifier(identity.providerId, `${path}.providerId`); identifier(identity.version, `${path}.version`);
  digest(identity.adapterDigest, `${path}.adapterDigest`); digest(identity.configHash, `${path}.configHash`);
  if (typeof identity.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(identity.imageDigest)) fail(`${path}.imageDigest`, 'immutable image digest required');
  reference(identity.artifactSignatureRef, `${path}.artifactSignatureRef`);
  if (identity.executionProfile !== 'enterprise' || identity.fallback !== false) fail(path, 'reference/fake/fallback provider is forbidden');
  origin(identity.endpointOrigin, `${path}.endpointOrigin`);
}
function validateNetworkPolicy(input: unknown, endpoint: string, path: string): void {
  const policy = record(input, path);
  exactKeys(policy, ['port', 'redirects', 'proxy', 'tlsHostnameVerification', 'tlsChainVerification',
    'tlsTrustRootsRef', 'dnsPolicyRef', 'requestTimeoutMs', 'maxCompressedBytes', 'maxResponseBytes', 'maxStreamBytes'], path);
  const port = positiveInteger(policy.port, `${path}.port`, 65535);
  if (port !== Number(new URL(endpoint).port || 443)) fail(`${path}.port`, 'origin port and network policy mismatch');
  if (policy.redirects !== 'forbidden' || policy.proxy !== 'disabled'
    || policy.tlsHostnameVerification !== true || policy.tlsChainVerification !== true) fail(path, 'network/TLS safety policy cannot be relaxed');
  reference(policy.tlsTrustRootsRef, `${path}.tlsTrustRootsRef`); reference(policy.dnsPolicyRef, `${path}.dnsPolicyRef`);
  positiveInteger(policy.requestTimeoutMs, `${path}.requestTimeoutMs`, 300000);
  for (const field of ['maxCompressedBytes', 'maxResponseBytes', 'maxStreamBytes']) positiveInteger(policy[field], `${path}.${field}`, 16 * 1024 * 1024);
}
function validateScope(input: unknown, path: string): void {
  const scope = record(input, path); exactKeys(scope, ['environment', 'tenantId', 'corpusId'], path);
  for (const field of ['environment', 'tenantId', 'corpusId']) identifier(scope[field], `${path}.${field}`);
}
function origin(input: unknown, path: string): void {
  if (typeof input !== 'string' || input.length > 512) fail(path, 'bounded canonical TLS origin required');
  let parsed: URL;
  try { parsed = new URL(input); } catch { fail(path, 'invalid canonical TLS origin'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash || parsed.origin !== input || !parsed.hostname) fail(path, 'canonical TLS origin cannot contain credentials/path/query/fragment');
  // Address classification, resolution pinning and TLS are enforced by the
  // outbound adapter against dnsPolicyRef, not proved by parsing this string.
}
function snapshot(input: unknown, path: string): Fields { return record(JSON.parse(canonicalJson(input)), path); }
function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'required object absent'); return input as Fields;
}
function exactKeys(input: Fields, expected: readonly string[], path: string): void {
  if (expected.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !expected.includes(key))) fail(path, 'required fields absent or unsupported fields present');
}
function boundedArray(input: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) fail(path, 'array outside profile bounds'); return input;
}
function reference(input: unknown, path: string): ArtifactReference {
  const value = record(input, path); exactKeys(value, ['objectId', 'objectVersion', 'sha256'], path);
  identifier(value.objectId, `${path}.objectId`); identifier(value.objectVersion, `${path}.objectVersion`); digest(value.sha256, `${path}.sha256`);
  return value as unknown as ArtifactReference;
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'bounded opaque identifier required');
}
function positiveInteger(input: unknown, path: string, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > max) fail(path, 'integer outside profile bounds'); return input;
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'exact lowercase hexadecimal identity required');
}
function digest(input: unknown, path: string): void { hex(input, 64, path); }
function select(input: unknown, allowed: readonly string[], path: string): string {
  if (typeof input !== 'string' || !allowed.includes(input)) fail(path, 'outside closed set'); return input;
}
function timestamp(input: unknown, path: string): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(path, 'canonical UTC timestamp required'); return Date.parse(input);
}
function base64url(input: unknown, path: string, bytes: number): Buffer {
  if (typeof input !== 'string' || input.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input)) fail(path, 'invalid public key/signature encoding');
  const decoded = Buffer.from(input, 'base64url');
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== input) fail(path, 'invalid public key/signature encoding/length'); return decoded;
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input;
}
function fail(path: string, reason: string): never { throw new Error(`[production provider trust] ${path}: ${reason}`); }
