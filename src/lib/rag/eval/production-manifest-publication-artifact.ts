import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { validateManifestExecutionBinding } from './production-gate-manifest';
import type { ArtifactReference, ProductionGateStage } from './production-gate-manifest';
import { createReferencePublicationArtifactWriter } from './production-publication-artifact';
import type { ReferencePublicationArtifactDecision } from './production-publication-artifact';

type Fields = Record<string, unknown>;

/** Correspondence is not approval. Configuration failures carry no caller text
 * and occur before constructing any provider-backed operation. */
export class ManifestPublicationArtifactError extends Error {
  readonly code = 'invalid-manifest-correspondence';
  readonly phase = 'configuration';
  readonly productionAccepted = false;
  readonly automaticRetryAllowed = false;
  constructor() {
    super('[manifest publication artifact] configuration: invalid-manifest-correspondence');
    this.name = 'ManifestPublicationArtifactError';
    Object.freeze(this);
  }
}

export interface ReferenceManifestPublicationArtifactDecision
  extends Omit<ReferencePublicationArtifactDecision, 'schemaVersion' | 'validationLevel' | 'observationHash'> {
  readonly schemaVersion: 'kg-manifest-publication-artifact-observation/v1';
  readonly validationLevel: 'local-reference-manifest-publication-artifact-readback';
  readonly stage: ProductionGateStage;
  readonly executionAuthorizationRef: ArtifactReference;
  readonly manifestCorrespondenceHash: string;
  readonly configurationHash: string;
  readonly artifactObservationHash: string;
  readonly executionAuthorized: false;
  readonly signatureVerified: false;
  readonly providerEvidenceVerified: false;
  readonly machineGateComputed: false;
  readonly observationHash: string;
}

/** Bind the actual private publication writer to a complete frozen manifest.
 * This local entry proves correspondence only: signature, registry/evidence,
 * serving policy and production acceptance remain separate authority checks. */
export function createReferenceManifestPublicationArtifactWriter(inputOptions: unknown, inputPorts: unknown) {
  let writer: ReturnType<typeof createReferencePublicationArtifactWriter>;
  let stage: ProductionGateStage;
  let executionAuthorizationRef: ArtifactReference;
  let manifestCorrespondenceHash: string;
  let configurationHash: string;
  try {
    // Reject accessors/Proxies without invoking hooks, then own every expectation.
    const options = record(freezeDeep(JSON.parse(canonicalJson(inputOptions))));
    exact(options, ['executionProfile', 'manifest', 'expectedExecutionPayload', 'executionAuthorizationRef', 'writerOptions']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const binding = validateManifestExecutionBinding({ manifest: options.manifest,
      expectedExecutionPayload: options.expectedExecutionPayload, executionAuthorizationRef: options.executionAuthorizationRef });
    const payload = record(options.expectedExecutionPayload);
    const participants = record(payload.participants);
    const writerOptions = record(options.writerOptions);
    const readerOptions = record(writerOptions.readerOptions);
    const identity = record(readerOptions.expectedIdentity);
    const milvus = record(identity.milvus);
    const manifest = record(options.manifest);
    const manifestIndex = record(record(manifest.base).indexIdentity);
    match(readerOptions.binding, { ...binding.scope, runNonce: binding.runNonce, manifestHash: binding.manifestHash });
    match(readerOptions.expectedIdentityRef, binding.identities.indexIdentityRef);
    match(milvus.schemaManifestHash, manifestIndex.schemaManifestHash);
    match(milvus.indexManifestHash, manifestIndex.indexManifestHash);
    match(writerOptions.writerId, participants.executorId);
    match(readerOptions.readerId, participants.readOnlyId);
    match(writerOptions.writerAuthorizationDigest, binding.executionAuthorizationRef.sha256);
    match(readerOptions.readerAuthorizationDigest, binding.executionAuthorizationRef.sha256);
    const window = record(payload.window);
    // Neither narrowing nor widening may silently redefine the approved run.
    match(readerOptions.observationWindow, {
      startsAt: new Date(Math.max(time(window.startsAt), time(payload.notBefore), time(payload.issuedAt))).toISOString(),
      endsAt: new Date(Math.min(time(window.endsAt), time(payload.expiresAt))).toISOString(),
    });
    if (binding.stage === 'T17') {
      const lineage = record(record(manifest.t17).lineage);
      // This entry observes the active TARGET after CAS. A recovered baseline
      // at N+2 is a distinct observation, not interchangeable with this target.
      match(record(identity.graph).pointerRevision, (lineage.expectedPointerRevision as number) + 1);
    }
    stage = binding.stage;
    executionAuthorizationRef = binding.executionAuthorizationRef;
    manifestCorrespondenceHash = canonicalJsonSha256(binding);
    configurationHash = canonicalJsonSha256(options);
    // Private construction also validates the original closed options/ports.
    // No caller factory, decision, report or reset cursor enters this path.
    writer = createReferencePublicationArtifactWriter(writerOptions, inputPorts);
  } catch { throw new ManifestPublicationArtifactError(); }

  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    async sealReadback(input: unknown): Promise<ReferenceManifestPublicationArtifactDecision> {
      // Preserve the producer's lifecycle, whole-operation deadline and UNKNOWN
      // mutation evidence; this metadata-only layer performs no additional IO.
      const { observationHash: artifactObservationHash, ...artifact } = await writer.sealReadback(input);
      const core = { ...artifact, schemaVersion: 'kg-manifest-publication-artifact-observation/v1' as const,
        validationLevel: 'local-reference-manifest-publication-artifact-readback' as const, stage,
        executionAuthorizationRef, manifestCorrespondenceHash, configurationHash, artifactObservationHash,
        executionAuthorized: false as const, signatureVerified: false as const,
        providerEvidenceVerified: false as const, machineGateComputed: false as const };
      return freezeDeep({ ...core, observationHash: canonicalJsonSha256(core) });
    },
    close(): void { writer.close(); },
  });
}

function record(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Fields;
}
function exact(value: Fields, names: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error();
}
function match(actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error();
}
function time(value: unknown): number { return Date.parse(value as string); }
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
