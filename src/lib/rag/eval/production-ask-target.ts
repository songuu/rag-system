import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { validateManifestExecutionBinding } from './production-gate-manifest';
import type { ArtifactReference } from './production-gate-manifest';
import { validateProviderTrustPolicy } from './production-provider-trust';
import type { ProviderNetworkPolicy } from './production-provider-trust';
import type { ArtifactRunBinding } from './production-controlled-artifacts';

type Fields = Record<string, unknown>;
type PlanErrorCode = 'invalid-config' | 'invalid-request';
type AskStage = 'T16' | 'T17';
type RolloutMode = 'off' | 'shadow' | 'active';
type RequestPhase = 'trial' | 'warmup';
interface AskProviderBinding {
  readonly purpose: 'ask'; readonly providerId: string; readonly adapterDigest: string;
  readonly version: string; readonly configHash: string; readonly conformanceRef: ArtifactReference;
}

/** Static errors reveal neither endpoints nor rejected credentials/data. */
export class ProductionAskTargetPlanError extends Error {
  readonly code: PlanErrorCode;
  readonly phase: 'configuration' | 'request';
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;
  constructor(code: PlanErrorCode = 'invalid-config') {
    const safeCode = code === 'invalid-request' ? 'invalid-request' : 'invalid-config';
    super(`[production Ask target plan] ${safeCode}`);
    this.name = 'ProductionAskTargetPlanError'; this.code = safeCode;
    this.phase = safeCode === 'invalid-config' ? 'configuration' : 'request';
    Object.freeze(this);
  }
}

export interface ReferenceProductionAskRequestPlan {
  readonly schemaVersion: 'kg-production-ask-request-plan/v1';
  readonly validationLevel: 'local-reference-ask-target-plan';
  readonly classification: 'confidential';
  readonly productionAuthorized: false; readonly stageAcceptanceComplete: false;
  readonly executionAuthorized: false; readonly registryAuthenticated: false;
  readonly networkEnforced: false; readonly rawDatasetVerified: false;
  readonly manifestRosterMembershipVerified: true;
  readonly stage: AskStage; readonly binding: ArtifactRunBinding;
  readonly executionAuthorizationRef: ArtifactReference; readonly registryRef: ArtifactReference;
  readonly providerBinding: AskProviderBinding; readonly providerRegistrationHash: string;
  readonly configurationHash: string;
  readonly target: {
    readonly method: 'POST'; readonly origin: string; readonly url: string;
    readonly networkPolicy: ProviderNetworkPolicy; readonly credentialPolicyRef: ArtifactReference;
  };
  readonly requestIdentity: {
    readonly caseId: string; readonly rolloutMode: RolloutMode; readonly phase: RequestPhase; readonly ordinal: number;
    readonly datasetHash: string; readonly rosterHash: string; readonly sharedConfigHash: string; readonly armConfigHash: string;
  };
  readonly effectiveWindow: { readonly startsAt: string; readonly endsAt: string };
  readonly planHash: string;
}

/** Pure reference planning, not a network client or a production permit.
 * The manifest selects a registration from an independently supplied deployment
 * policy. No request can choose an origin/path, acquire secrets or weaken TLS.
 * Live registry authority, DNS/IP pinning, TLS, dataset and approval checks must
 * still be enforced by the eventual runner BEFORE any credential/request IO. */
export function createReferenceProductionAskTargetPlanner(inputOptions: unknown, ...extraInputs: unknown[]) {
  try {
    if (extraInputs.length !== 0) throw new Error();
    const options = record(snapshot(inputOptions));
    exact(options, ['executionProfile', 'manifest', 'expectedExecutionPayload', 'executionAuthorizationRef', 'deploymentPolicy', 'policyRef']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const binding = validateManifestExecutionBinding({ manifest: options.manifest,
      expectedExecutionPayload: options.expectedExecutionPayload, executionAuthorizationRef: options.executionAuthorizationRef });
    if (binding.stage === 'R18') throw new Error();
    const stage = binding.stage;
    const deployment = validateProviderTrustPolicy(options.deploymentPolicy);
    match(options.policyRef, binding.identities.registryRef);
    const policyRef = record(options.policyRef);
    match(policyRef.sha256, deployment.policyHash);
    match(deployment.policy.scope, binding.scope);
    const payload = record(options.expectedExecutionPayload);
    const window = record(payload.window);
    const starts = Math.max(time(window.startsAt), time(payload.issuedAt), time(payload.notBefore));
    const ends = Math.min(time(window.endsAt), time(payload.expiresAt));
    // Coverage of the frozen interval is not a claim about the current clock.
    if (Date.parse(deployment.policy.validFrom) > starts || Date.parse(deployment.policy.validUntil) < ends) throw new Error();
    const effectiveWindow = freezeDeep({ startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString() });
    const selected = (record(binding.providers).bindings as unknown[]).map(record).find(value => value.purpose === 'ask');
    if (!selected) throw new Error();
    const registration = deployment.policy.registrations.find(value => value.purpose === 'ask' && value.providerId === selected.providerId);
    if (!registration) throw new Error();
    for (const field of ['adapterDigest', 'version', 'configHash'] as const) match(selected[field], registration[field]);
    const providerBinding = selected as unknown as AskProviderBinding;
    const providerRegistrationHash = canonicalJsonSha256(registration);
    // Existing policy validation owns canonical HTTPS origin, credentials,
    // port, redirects/proxy, TLS and bounded-response policy validation.
    const target = freezeDeep({ method: 'POST' as const, origin: registration.endpointOrigin,
      url: `${registration.endpointOrigin}/api/ask`, networkPolicy: registration.networkPolicy,
      credentialPolicyRef: registration.credentialPolicyRef });
    const manifest = record(options.manifest);
    const roster = record(record(manifest.base).dataset).roster as readonly string[];
    const sampling = record(record(manifest[stage === 'T16' ? 't16' : 't17']).sampling);
    const armHashes = binding.identities.armConfigHashes;
    if (!armHashes) throw new Error();
    const configurationHash = canonicalJsonSha256(options);
    const run = freezeDeep({ ...binding.scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash });
    return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
      planRequest(input: unknown, ...extraRequests: unknown[]): ReferenceProductionAskRequestPlan {
        try {
          if (extraRequests.length !== 0) throw new Error();
          const request = record(snapshot(input)); exact(request, ['caseId', 'rolloutMode', 'phase', 'ordinal']);
          if (typeof request.caseId !== 'string' || !roster.includes(request.caseId)) throw new Error();
          if (request.rolloutMode !== 'off' && request.rolloutMode !== (stage === 'T16' ? 'shadow' : 'active')) throw new Error();
          if (request.phase !== 'trial' && request.phase !== 'warmup') throw new Error();
          const count = sampling[request.phase === 'trial' ? 'trialCount' : 'warmupCount'] as number;
          if (typeof request.ordinal !== 'number' || !Number.isSafeInteger(request.ordinal) || request.ordinal < 0 || request.ordinal >= count) throw new Error();
          const rolloutMode = request.rolloutMode as RolloutMode;
          const core: Omit<ReferenceProductionAskRequestPlan, 'planHash'> = { schemaVersion: 'kg-production-ask-request-plan/v1' as const,
            validationLevel: 'local-reference-ask-target-plan' as const, classification: 'confidential' as const,
            productionAuthorized: false as const, stageAcceptanceComplete: false as const, executionAuthorized: false as const,
            registryAuthenticated: false as const, networkEnforced: false as const, rawDatasetVerified: false as const,
            manifestRosterMembershipVerified: true as const, stage, binding: run,
            executionAuthorizationRef: binding.executionAuthorizationRef, registryRef: binding.identities.registryRef,
            providerBinding, providerRegistrationHash, configurationHash, target,
            requestIdentity: { caseId: request.caseId, rolloutMode, phase: request.phase, ordinal: request.ordinal,
              datasetHash: binding.identities.datasetHash, rosterHash: binding.identities.rosterHash,
              sharedConfigHash: binding.identities.sharedConfigHash, armConfigHash: armHashes[rolloutMode] }, effectiveWindow };
          return freezeDeep({ ...core, planHash: canonicalJsonSha256(core) });
        } catch { throw new ProductionAskTargetPlanError('invalid-request'); }
      },
    });
  } catch { throw new ProductionAskTargetPlanError('invalid-config'); }
}

function record(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Fields;
}
function exact(value: Fields, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error();
}
function match(actual: unknown, expected: unknown): void { if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(); }
function time(value: unknown): number { return Date.parse(value as string); }
function snapshot(value: unknown): unknown { return freezeDeep(JSON.parse(canonicalJson(value))); }
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}

