import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { boundedProviderCall } from './bounded-provider-call';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createReferenceProviderTrustVerifier, validateProviderTrustPolicy } from './production-provider-trust';
import type { ProviderTrustPolicy, ReferenceProviderTrustDecision } from './production-provider-trust';
import type { ArtifactOperationContext } from './production-controlled-artifacts';
import type { ArtifactReference } from './production-gate-manifest';
import type { AuthorizationScope } from './production-authorization';

export const PROVIDER_REGISTRY_READBACK_SCHEMA = 'kg-provider-registry-readback-proof/v1' as const;
export interface RegistryReadRequest {
  readonly context: ArtifactOperationContext;
  readonly policyRef: ArtifactReference;
  readonly requestNonce: string;
}
export interface RegistryExactReadback {
  readonly policy: ProviderTrustPolicy;
  readonly proof: {
    readonly schemaVersion: typeof PROVIDER_REGISTRY_READBACK_SCHEMA;
    readonly assurance: 'enterprise' | 'local-reference';
    readonly productionRegistryAuthenticated: boolean;
    readonly sourceIdentityRef: ArtifactReference;
    readonly policyRef: ArtifactReference;
    readonly context: ArtifactOperationContext;
    readonly requestNonce: string;
  };
}
/** Context and proof labels are not IAM capabilities. An enterprise adapter must
 * authenticate its deployment source, current reader and authorization itself. */
export interface ProviderRegistryPort {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly productionCapable: boolean;
  readExactPolicy(request: RegistryReadRequest): Promise<RegistryExactReadback>;
}
export interface RegistryBoundTrustDecision extends ReferenceProviderTrustDecision {
  readonly schemaVersion: 'kg-registry-bound-trust-decision/v1';
  readonly classification: 'confidential';
  readonly registryRef: ArtifactReference;
  readonly registryReadbackProofHash: string;
  readonly decisionHash: string;
}
export interface ReferenceRegistryBoundTrustVerifier {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  verifySelection(request: unknown): Promise<RegistryBoundTrustDecision>;
}
type RegistryErrorCode = 'registry-configuration-invalid' | 'registry-request-invalid' | 'registry-replay'
  | 'registry-capacity' | 'registry-proof-invalid' | 'selection-invalid' | 'verifier-busy' | 'verifier-capacity'
  | 'verifier-halted' | 'registry-read-failed' | 'registry-return-invalid' | 'registry-timeout' | 'provider-trust-invalid';
export class ProviderRegistryError extends Error {
  readonly productionAuthorized = false;
  readonly code: RegistryErrorCode;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: RegistryErrorCode, pendingCompletionUnknown = false) {
    // Provider-controlled diagnostics must not leak policy bodies or credentials.
    super(`[provider registry] ${code}`); this.name = 'ProviderRegistryError';
    this.code = code; this.pendingCompletionUnknown = pendingCompletionUnknown;
  }
}
type Fields = Record<string, unknown>;
const SCOPE_FIELDS = ['environment', 'tenantId', 'corpusId'];
function fail(code: RegistryErrorCode): never { throw new ProviderRegistryError(code); }
function guarded<T>(code: RegistryErrorCode, operation: () => T): T {
  try { return operation(); } catch { return fail(code); }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(input: unknown, code: RegistryErrorCode): Fields {
  return guarded(code, () => freeze(record(JSON.parse(canonicalJson(input)), code)));
}
function record(input: unknown, code: RegistryErrorCode): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code);
  return input as Fields;
}
function exact(value: Fields, fields: readonly string[], code: RegistryErrorCode): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail(code);
}
function id(input: unknown, code: RegistryErrorCode): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(code);
  return input;
}
function hex(input: unknown, length: number, code: RegistryErrorCode): string {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(code);
  return input;
}
function time(input: unknown, code: RegistryErrorCode): number {
  if (typeof input !== 'string') fail(code);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input) fail(code);
  return parsed;
}
function integer(input: unknown, max: number, code: RegistryErrorCode): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > max) fail(code);
  return input;
}
function array(input: unknown, max: number, code: RegistryErrorCode): readonly unknown[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > max) fail(code);
  return input;
}
function scope(input: unknown, code: RegistryErrorCode): AuthorizationScope {
  const value = record(input, code); exact(value, SCOPE_FIELDS, code);
  for (const field of SCOPE_FIELDS) id(value[field], code);
  return value as unknown as AuthorizationScope;
}
function reference(input: unknown, code: RegistryErrorCode): ArtifactReference {
  const value = record(input, code); exact(value, ['objectId', 'objectVersion', 'sha256'], code);
  id(value.objectId, code); id(value.objectVersion, code); hex(value.sha256, 64, code);
  return value as unknown as ArtifactReference;
}
function same(actual: unknown, expected: unknown, code: RegistryErrorCode): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code);
}
function readRequest(input: unknown, code: RegistryErrorCode): RegistryReadRequest {
  const value = snapshot(input, code); exact(value, ['context', 'policyRef', 'requestNonce'], code);
  const context = record(value.context, code);
  exact(context, ['executionProfile', 'binding', 'actorId', 'authorizationDigest', 'observedAt'], code);
  if (context.executionProfile !== 'enterprise' && context.executionProfile !== 'local-reference') fail(code);
  const binding = record(context.binding, code); exact(binding, [...SCOPE_FIELDS, 'runNonce', 'manifestHash'], code);
  for (const field of SCOPE_FIELDS) id(binding[field], code);
  hex(binding.runNonce, 32, code); hex(binding.manifestHash, 64, code);
  id(context.actorId, code); hex(context.authorizationDigest, 64, code); time(context.observedAt, code);
  reference(value.policyRef, code); hex(value.requestNonce, 32, code);
  return value as unknown as RegistryReadRequest;
}
function bindingScope(context: ArtifactOperationContext): AuthorizationScope {
  const { environment, tenantId, corpusId } = context.binding;
  return { environment, tenantId, corpusId };
}

/** Read-only, instance-bounded fixture store. Labels, caller time and this local
 * nonce ledger prove neither enterprise identity nor durable replay protection. */
export function createReferenceProviderRegistry(options: unknown): ProviderRegistryPort {
  const code = 'registry-configuration-invalid'; const config = snapshot(options, code);
  exact(config, ['executionProfile', 'scope', 'sourceIdentityRef', 'readOnlyActorIds', 'maxReads', 'policies'], code);
  if (config.executionProfile !== 'local-reference') fail(code);
  const expectedScope = scope(config.scope, code); const sourceIdentityRef = reference(config.sourceIdentityRef, code);
  const readers = array(config.readOnlyActorIds, 16, code).map(value => id(value, code));
  if (new Set(readers).size !== readers.length) fail(code);
  const maxReads = integer(config.maxReads, 4096, code);
  const policies = new Map<string, ProviderTrustPolicy>(); const versions = new Set<string>();
  for (const entry of array(config.policies, 64, code)) {
    const value = record(entry, code); exact(value, ['ref', 'policy'], code); const ref = reference(value.ref, code);
    const validated = guarded(code, () => validateProviderTrustPolicy(value.policy));
    same(validated.policy.scope, expectedScope, code);
    if (ref.sha256 !== validated.policyHash) fail(code);
    const version = canonicalJson([ref.objectId, ref.objectVersion]); if (versions.has(version)) fail(code);
    versions.add(version); policies.set(canonicalJson(ref), validated.policy);
  }
  const nonces = new Set<string>();
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false,
    async readExactPolicy(input: RegistryReadRequest): Promise<RegistryExactReadback> {
      const request = readRequest(input, 'registry-request-invalid');
      if (request.context.executionProfile !== 'local-reference' || !readers.includes(request.context.actorId)) fail('registry-request-invalid');
      same(bindingScope(request.context), expectedScope, 'registry-request-invalid');
      const policy = policies.get(canonicalJson(request.policyRef)); if (!policy) fail('registry-request-invalid');
      const observed = time(request.context.observedAt, 'registry-request-invalid');
      if (observed < Date.parse(policy.validFrom) || observed >= Date.parse(policy.validUntil)) fail('registry-request-invalid');
      if (nonces.has(request.requestNonce)) fail('registry-replay');
      if (nonces.size >= maxReads) fail('registry-capacity');
      nonces.add(request.requestNonce);
      return freeze({ policy, proof: { schemaVersion: PROVIDER_REGISTRY_READBACK_SCHEMA,
        assurance: 'local-reference' as const, productionRegistryAuthenticated: false, sourceIdentityRef,
        policyRef: request.policyRef, context: request.context, requestNonce: request.requestNonce } });
    },
  });
}

/** Structural readback validation, including digest recomputation. Even a
 * well-formed enterprise assurance flag is not authenticated by this function. */
export function validateProviderRegistryReadback(input: unknown, expectation: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAuthorized: false;
  readonly policy: ProviderTrustPolicy; readonly policyHash: string; readonly proofHash: string;
} {
  return guarded('registry-proof-invalid', () => {
    const code = 'registry-proof-invalid'; const expected = snapshot(expectation, code);
    exact(expected, ['request', 'sourceIdentityRef'], code);
    const request = readRequest(expected.request, code); const source = reference(expected.sourceIdentityRef, code);
    const readback = snapshot(input, code); exact(readback, ['policy', 'proof'], code);
    const proof = record(readback.proof, code);
    exact(proof, ['schemaVersion', 'assurance', 'productionRegistryAuthenticated', 'sourceIdentityRef', 'policyRef', 'context', 'requestNonce'], code);
    if (proof.schemaVersion !== PROVIDER_REGISTRY_READBACK_SCHEMA || proof.assurance !== request.context.executionProfile
      || proof.productionRegistryAuthenticated !== (proof.assurance === 'enterprise')) fail(code);
    same(reference(proof.sourceIdentityRef, code), source, code);
    same(readRequest({ context: proof.context, policyRef: proof.policyRef, requestNonce: proof.requestNonce }, code), request, code);
    const validated = validateProviderTrustPolicy(readback.policy);
    if (validated.policyHash !== request.policyRef.sha256) fail(code);
    same(validated.policy.scope, bindingScope(request.context), code);
    const observed = time(request.context.observedAt, code);
    if (observed < Date.parse(validated.policy.validFrom) || observed >= Date.parse(validated.policy.validUntil)) fail(code);
    return freeze({ validationLevel: 'structural-only' as const, productionAuthorized: false as const,
      policy: validated.policy, policyHash: validated.policyHash, proofHash: canonicalJsonSha256(proof) });
  });
}

/** Capture the method/receiver without calling dependency getters or Proxies. */
function captureRegistry(dependencies: unknown): (request: RegistryReadRequest) => unknown {
  const code = 'registry-configuration-invalid';
  function ownFields(input: unknown, names: readonly string[]): Fields {
    if (input === null || typeof input !== 'object' || types.isProxy(input)) fail(code);
    const proto = Object.getPrototypeOf(input); if (proto !== Object.prototype && proto !== null) fail(code);
    const keys = Reflect.ownKeys(input); if (keys.length !== names.length) fail(code);
    const result: Fields = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code);
      result[name] = descriptor.value;
    }
    return result;
  }
  const deps = ownFields(dependencies, ['registry']);
  const port = ownFields(deps.registry, ['executionProfile', 'productionCapable', 'readExactPolicy']);
  if (port.executionProfile !== 'local-reference' || port.productionCapable !== false
    || typeof port.readExactPolicy !== 'function' || types.isProxy(port.readExactPolicy)) fail(code);
  const method = port.readExactPolicy; const receiver = deps.registry;
  return request => Reflect.apply(method as (request: RegistryReadRequest) => unknown, receiver, [request]);
}

/** Uses a separately configured local deployment anchor and public roots. No
 * caller-supplied policy, cached success or fallback can bypass exact readback.
 * Enterprise registry authentication/trusted time remain external obligations. */
export function createReferenceRegistryBoundTrustVerifier(options: unknown, dependencies: unknown): ReferenceRegistryBoundTrustVerifier {
  const code = 'registry-configuration-invalid'; const config = snapshot(options, code);
  exact(config, ['executionProfile', 'scope', 'registryRef', 'registryIdentityRef', 'readerId',
    'readerAuthorizationDigest', 'authorityKeys', 'operationTimeoutMs', 'maxVerifications'], code);
  if (config.executionProfile !== 'local-reference') fail(code);
  const expectedScope = scope(config.scope, code); const policyRef = reference(config.registryRef, code);
  const sourceIdentityRef = reference(config.registryIdentityRef, code);
  const actorId = id(config.readerId, code); const authorizationDigest = hex(config.readerAuthorizationDigest, 64, code);
  array(config.authorityKeys, 128, code);
  const timeoutMs = integer(config.operationTimeoutMs, 60000, code); const maxAttempts = integer(config.maxVerifications, 4096, code);
  const read = captureRegistry(dependencies); let busy = false; let halted = false; let attempts = 0;
  let lastObservedTime = -Infinity; const challenges = new Set<string>();
  function preflight(input: unknown): Fields {
    const error = 'selection-invalid'; const value = snapshot(input, error);
    exact(value, ['stage', 'scope', 'runNonce', 'manifestHash', 'providers', 'executionProvidersHash',
      'observedAt', 'conformanceObjects', 'runtimeObjects'], error);
    if (value.stage !== 'T16' && value.stage !== 'T17' && value.stage !== 'R18') fail(error);
    same(scope(value.scope, error), expectedScope, error);
    hex(value.runNonce, 32, error); hex(value.manifestHash, 64, error);
    if (time(value.observedAt, error) < lastObservedTime) fail(error);
    const providers = record(value.providers, error); exact(providers, ['registryRef', 'bindings'], error);
    same(reference(providers.registryRef, error), policyRef, error);
    if (hex(value.executionProvidersHash, 64, error) !== canonicalJsonSha256(providers)) fail(error);
    const count = array(providers.bindings, 14, error).length;
    if (array(value.conformanceObjects, 14, error).length !== count || array(value.runtimeObjects, 14, error).length !== count) fail(error);
    return value;
  }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false,
    async verifySelection(input: unknown): Promise<RegistryBoundTrustDecision> {
      if (halted) fail('verifier-halted'); if (busy) fail('verifier-busy');
      const selection = preflight(input); if (attempts >= maxAttempts) fail('verifier-capacity');
      let requestNonce = '';
      for (let retry = 0; retry < 4 && !requestNonce; retry++) {
        const candidate = randomBytes(16).toString('hex'); if (!challenges.has(candidate)) requestNonce = candidate;
      }
      if (!requestNonce) fail('verifier-capacity');
      challenges.add(requestNonce); attempts++; busy = true;
      try {
        const request = readRequest({ context: { executionProfile: 'local-reference',
          binding: { ...expectedScope, runNonce: selection.runNonce, manifestHash: selection.manifestHash },
          actorId, authorizationDigest, observedAt: selection.observedAt }, policyRef, requestNonce }, 'selection-invalid');
        const observation = await boundedProviderCall(() => read(request), timeoutMs);
        if (observation.status === 'timeout' || observation.status === 'invalid-return') {
          halted = observation.pendingCompletionUnknown;
          throw new ProviderRegistryError(observation.status === 'timeout' ? 'registry-timeout' : 'registry-return-invalid', halted);
        }
        if (observation.status === 'rejected') fail('registry-read-failed');
        // Never return the raw payload through an async boundary: that would
        // adopt a provider-controlled `then` accessor after safe observation.
        const validated = validateProviderRegistryReadback(observation.value, { request, sourceIdentityRef });
        const decision = guarded('provider-trust-invalid', () => createReferenceProviderTrustVerifier({
          executionProfile: 'local-reference', policy: validated.policy, policyRef, authorityKeys: config.authorityKeys,
        }).verifySelection(selection));
        lastObservedTime = time(selection.observedAt, 'selection-invalid');
        const result = { ...decision, schemaVersion: 'kg-registry-bound-trust-decision/v1' as const,
          classification: 'confidential' as const, registryRef: policyRef, registryReadbackProofHash: validated.proofHash };
        return freeze({ ...result, decisionHash: canonicalJsonSha256(result) });
      } finally { busy = false; }
    },
  });
}
