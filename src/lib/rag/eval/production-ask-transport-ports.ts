import type { ArtifactRunBinding } from './production-controlled-artifacts';
import type { ArtifactReference } from './production-gate-manifest';
import type { ReferenceProductionAskRequestPlan } from './production-ask-target';
import type { ReferenceOwnedAskRequest } from './production-ask-producer';

/** Confidential provider handoffs, not authenticated identities or permits.
 * Enterprise adapters must supply their own authority/conformance evidence;
 * the native reference implementation accepts only isolated local ports. */
interface ProviderProfile {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly productionCapable: boolean;
}
export interface ReferenceAskCredentialRequest {
  readonly schemaVersion: 'kg-reference-ask-secret-request/v1';
  readonly requestNonce: string;
  readonly requestPlanHash: string;
  readonly requestBodySha256: string;
  readonly audience: string;
  readonly binding: ArtifactRunBinding;
  readonly credentialPolicyRef: ArtifactReference;
  readonly tlsPeerFingerprintSha256: string;
}
export interface SecretProvider extends ProviderProfile {
  /** Primitive JSON only. Never emit credentials in logs, argv or receipts. */
  readAskCredential(request: ReferenceAskCredentialRequest): Promise<string>;
}
export interface ProductionAskDeploymentPort extends ProviderProfile {
  readDeployment(plan: ReferenceProductionAskRequestPlan): Promise<string>;
}
export interface ReferenceAskMeasurementRequest {
  readonly schemaVersion: 'kg-reference-ask-measurement-request/v1';
  readonly requestNonce: string;
  readonly requestPlanHash: string;
  readonly requestBodySha256: string;
  readonly responseBodySha256: string;
  readonly binding: ArtifactRunBinding;
}
export interface ProductionAskMeasurementPort extends ProviderProfile {
  /** Original usage data from the provider; never infer model counts from HTTP. */
  readMeasurement(request: ReferenceAskMeasurementRequest): Promise<string>;
}
export interface ReferenceAskHttpsTransportPort extends ProductionAskDeploymentPort {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  post(request: ReferenceOwnedAskRequest): Promise<string>;
  /** Fence local work/destroy owned sockets; NOT proof of remote cancellation. */
  close(): void;
}

/** Full confidential state readback. Correlation is not source authentication.
 * The selector originates inside the private runner; no snapshots or verdicts
 * are accepted from its public execution request. */
export interface ShadowSideEffectReadbackRequest {
  readonly schemaVersion: 'kg-reference-shadow-state-request/v1';
  readonly binding: ArtifactRunBinding;
  readonly actorId: string;
  readonly authorizationDigest: string;
  readonly providerRegistrationHash: string;
  readonly requestNonce: string;
  readonly observedAt: string;
  readonly point: 'run-before' | 'post-before' | 'post-after' | 'run-after';
  readonly requestPlanHash: string | null;
  readonly requestBodySha256: string | null;
  readonly responseBodySha256: string | null;
}
export interface ProductionShadowSideEffectReadbackPort extends ProviderProfile {
  /** Complete primitive JSON; never return raw SDK objects or log contents. */
  readShadowState(request: ShadowSideEffectReadbackRequest): Promise<string>;
}
