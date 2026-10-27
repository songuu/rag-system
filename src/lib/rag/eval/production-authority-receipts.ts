import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { boundedProviderCall } from './bounded-provider-call';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { ACCEPTANCE_BUNDLE_SCHEMA, RECEIPT_READBACK_PROOF_SCHEMA, validateAcceptanceBundle, createReceiptCore, validateReceiptCore, sealReferenceReceiptCore, ReferenceReceiptSealError } from './production-receipts';
import type { ReceiptCore, ReferenceReceiptSeal, StageAcceptanceBundle, ReceiptReadbackProof } from './production-receipts';
import { validateManifestExecutionBinding, validateForT17, validateForRetention } from './production-gate-manifest';
import type { ArtifactReference, ManifestExecutionBinding } from './production-gate-manifest';
import { createReferenceAuthorityApprovalVerifier, createReferenceAuthorityApprovalVerificationPair, AuthorityApprovalError } from './production-authority-approval';
import type { NonceOutcome } from './production-authority-approval';
import { createReferenceAuthorizationSignatureVerifier, validateAuthorizationEnvelope } from './production-authorization';
import type { AuthorizationEnvelope, ExecutionAuthorizationPayload, ResultAttestationPayload } from './production-authorization';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading, AuthorityClockRequest } from './production-authority-ports';
import { validateJournalChain } from './production-run-journal';
import { validateProviderRegistryReadback } from './production-provider-registry';
import { createReferenceProviderTrustVerifier } from './production-provider-trust';
import { validateArtifactAad, validateEncryptedArtifact, CONTROLLED_ARTIFACT_OBJECT_SCHEMA } from './production-controlled-artifacts';
import type { ArtifactRunBinding, KmsEnvelopePort, TamperResistantArtifactStore } from './production-controlled-artifacts';
import { STAGE_EXECUTION_ACTIONS } from './production-authorized-journal';

type Fields = Record<string, unknown>;
type Phase = 'configuration' | 'preflight' | 'registry' | 'journal' | 'store' | 'decrypt' | 'result-approval' | 'final-validation';
type ErrorCode = 'invalid-config' | 'invalid-evidence' | 'operation-failed' | 'operation-timeout'
  | 'provider-contract-invalid' | 'approval-failed' | 'busy' | 'halted' | 'attempt-capacity';
export class AuthorityReceiptError extends Error {
  readonly productionAccepted = false;
  readonly code: ErrorCode; readonly phase: Phase; readonly nonceOutcome: NonceOutcome;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: ErrorCode, phase: Phase, outcome: NonceOutcome = 'not-attempted', pending = false) {
    super(`[authority receipt] ${phase}: ${code}`); this.name = 'AuthorityReceiptError';
    this.code = code; this.phase = phase; this.nonceOutcome = outcome; this.pendingCompletionUnknown = pending;
    Object.freeze(this);
  }
}
export interface ReferenceAuthorityReceiptDecision {
  readonly schemaVersion: 'kg-authority-receipt-observation/v1'; readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-authority-readback'; readonly productionAccepted: false;
  readonly stageAcceptanceComplete: false; readonly signatureVerified: true; readonly machinePassed: boolean;
  readonly bundleDigest: string; readonly receiptCoreDigest: string; readonly journalHeadHash: string;
  readonly storeReadbackHash: string; readonly registryProofHash: string; readonly approvalDecisionHash: string;
  readonly providerPolicyHash: string; readonly verifiedAt: string; readonly uncertaintyMs: number; readonly decisionHash: string;
}
/** Historical readback proves an existing claim, never a renewed grant. */
export interface ReferenceExistingAuthorityReceiptDecision extends Omit<ReferenceAuthorityReceiptDecision, 'schemaVersion' | 'validationLevel'> {
  readonly schemaVersion: 'kg-existing-authority-receipt-observation/v1';
  readonly validationLevel: 'local-reference-existing-authority-readback';
  readonly executionAuthorized: false; readonly nonceConsumedByThisVerifier: false;
  readonly approvalProvenanceVerified: true;
}
export interface ReferenceAuthorityReceiptVerifier {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  verifyBundle(input: unknown): Promise<ReferenceAuthorityReceiptDecision>;
  verifyExistingBundle(input: unknown): Promise<ReferenceExistingAuthorityReceiptDecision>;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function detached(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields;
}
function exact(value: Fields, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error();
}
function same(left: unknown, right: unknown): void { if (canonicalJson(left) !== canonicalJson(right)) throw new Error(); }
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(); return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error(); return value;
}
function reference(value: unknown): Fields {
  const data = record(value); exact(data, ['objectId', 'objectVersion', 'sha256']);
  identifier(data.objectId); identifier(data.objectVersion);
  if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error(); return data;
}
/** Signed metadata is supplied by the attestor; every execution/result binding
 * is independently derived from the private core and frozen execution input. */
function independentResultPayload(metadata: ResultAttestationPayload, expected: ExecutionAuthorizationPayload,
  executionAuthorizationRef: ArtifactReference, core: ReceiptCore, receiptCoreRef: ArtifactReference): ResultAttestationPayload {
  return freeze({ authorizationId: metadata.authorizationId, nonce: metadata.nonce, issuerId: metadata.issuerId,
    issuedAt: metadata.issuedAt, notBefore: metadata.notBefore, expiresAt: metadata.expiresAt,
    operation: 'attest-stage-result', scope: expected.scope, runNonce: expected.runNonce,
    manifestHash: expected.manifestHash, stage: expected.stage, participants: expected.participants,
    executionAuthorizationRef, receiptCoreRef, reportHash: core.reportRef.sha256,
    artifactIndexHash: core.artifactIndexRef.sha256, machineVerdict: core.machineVerdict,
    executionIdentityId: core.executionIdentityId, finalStateHash: core.finalStateHash, completedAt: core.completedAt });
}
/** Reflect descriptor data only; do not run getters, proxies or subclass hooks. */
function surface(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || types.isProxy(input)) throw new Error();
  const proto = Object.getPrototypeOf(input); if (proto !== Object.prototype && proto !== null) throw new Error();
  const names = Reflect.ownKeys(input); if (names.length > 32) throw new Error();
  const result: Fields = Object.create(null);
  for (const name of names) {
    if (typeof name !== 'string') throw new Error(); const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error(); result[name] = descriptor.value;
  }
  return result;
}
type Operation = (...args: unknown[]) => unknown;
function capture(input: unknown, methods: readonly string[]): Record<string, Operation> {
  const data = surface(input); if (data.executionProfile !== 'local-reference' || data.productionCapable !== false) throw new Error();
  const captured: Record<string, Operation> = Object.create(null);
  for (const name of methods) {
    const method = data[name]; if (typeof method !== 'function' || types.isProxy(method)) throw new Error();
    captured[name] = (...args) => Reflect.apply(method, input, args);
  }
  return Object.freeze(captured);
}
/** Preserve the existing journal 16 MiB/10000-entry profile without adopting
 * provider-controlled then. Each entry is independently canonical/detached. */
function detachedEntries(input: unknown, allowEmpty = false): readonly unknown[] {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
  const length = allowEmpty && descriptor?.value === 0 ? 0 : integer(descriptor?.value, 10000);
  if (Reflect.ownKeys(input).length !== length + 1) throw new Error();
  let bytes = 2; const entries: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(index));
    if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable) throw new Error();
    const json = canonicalJson(entry.value); bytes += Buffer.byteLength(json, 'utf8') + (index ? 1 : 0);
    if (bytes > 16 * 1024 * 1024) throw new Error(); entries.push(freeze(JSON.parse(json)));
  }
  return Object.freeze(entries);
}

type WriterPhase = 'configuration' | 'preflight' | 'journal' | 'clock' | 'registry' | 'execution-approval' | 'result-approval'
  | 'encrypt' | 'store-seal' | 'store-read' | 'decrypt' | 'final-validation';
type WriterCode = 'invalid-config' | 'invalid-evidence' | 'operation-failed' | 'operation-timeout'
  | 'provider-contract-invalid' | 'approval-failed' | 'busy' | 'halted' | 'attempt-capacity'
  | 'not-started' | 'already-started' | 'already-sealed' | 'core-not-sealed' | 'already-bundle-sealed';
export class AuthorityReceiptWriterError extends Error {
  readonly productionAccepted = false;
  readonly automaticRetryAllowed = false;
  readonly code: WriterCode; readonly phase: WriterPhase; readonly nonceOutcome: NonceOutcome;
  readonly pendingCompletionUnknown: boolean; readonly mutationMayHaveOccurred: boolean;
  constructor(code: WriterCode, phase: WriterPhase, nonceOutcome: NonceOutcome = 'not-attempted',
    pendingCompletionUnknown = false, mutationMayHaveOccurred = false) {
    super(`[authority receipt writer] ${phase}: ${code}`); this.name = 'AuthorityReceiptWriterError';
    this.code = code; this.phase = phase; this.nonceOutcome = nonceOutcome;
    this.pendingCompletionUnknown = pendingCompletionUnknown; this.mutationMayHaveOccurred = mutationMayHaveOccurred; Object.freeze(this);
  }
}
export interface ReferenceAuthorityExecutionStart {
  readonly validationLevel: 'local-reference-execution-session'; readonly productionAccepted: false;
  readonly stageAcceptanceComplete: false; readonly startNotBefore: string; readonly approvalDecisionHash: string;
}
export interface ReferenceAuthorityReceiptSeal extends ReferenceReceiptSeal {
  readonly stageAcceptanceComplete: false;
  readonly authorityObservation: {
    readonly validationLevel: 'local-reference-authority-seal'; readonly productionAccepted: false;
    readonly stageAcceptanceComplete: false; readonly approvalDecisionHash: string; readonly clockReadingHash: string;
    readonly registryProofHash: string; readonly verifiedAt: string; readonly uncertaintyMs: number; readonly decisionHash: string;
  };
}
export interface ReferenceAuthorityAcceptanceSeal {
  readonly productionAccepted: false; readonly stageAcceptanceComplete: false; readonly machineGateComputed: false;
  readonly bundle: StageAcceptanceBundle; readonly acceptanceBundleRef: ArtifactReference;
  readonly bundleStorageRef: ArtifactReference; readonly resultAttestationStorageRef: ArtifactReference;
  readonly readbackProofStorageRef: ArtifactReference;
  readonly evidence: { readonly core: ReceiptCore; readonly executionEnvelope: AuthorizationEnvelope;
    readonly resultEnvelope: AuthorizationEnvelope; readonly readbackProof: ReceiptReadbackProof };
  readonly resultApprovalProvenance: { readonly nonceClaimRef: ArtifactReference; readonly claimedClockReading: AuthorityClockReading };
  readonly authorityObservation: { readonly validationLevel: 'local-reference-authority-bundle-seal';
    readonly productionAccepted: false; readonly stageAcceptanceComplete: false; readonly machineGateComputed: false;
    readonly executionApprovalDecisionHash: string; readonly resultApprovalDecisionHash: string;
    readonly clockReadingHash: string; readonly registryProofHash: string; readonly bundleReadbackHash: string;
    readonly verifiedAt: string; readonly uncertaintyMs: number; readonly decisionHash: string };
}
export interface ReferenceAuthorityReceiptWriter {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  beginExecution(input: unknown): Promise<ReferenceAuthorityExecutionStart>;
  sealCore(input: unknown): Promise<ReferenceAuthorityReceiptSeal>;
  sealBundle(input: unknown): Promise<ReferenceAuthorityAcceptanceSeal>;
}

type ManifestBindingPhase = 'configuration' | 'seal-preflight' | 'verify-preflight';
export class ManifestReceiptBindingError extends Error {
  readonly productionAccepted = false;
  readonly automaticRetryAllowed = false;
  readonly phase: ManifestBindingPhase;
  constructor(phase: ManifestBindingPhase) {
    // Never include caller/provider diagnostics or imply an unconsumed nonce:
    // seal preflight can occur after the private execution session began.
    super(`[manifest receipt binding] ${phase}: invalid manifest correspondence`);
    this.name = 'ManifestReceiptBindingError'; this.phase = phase; Object.freeze(this);
  }
}
const MANIFEST_READER_OPTIONS = ['executionProfile', 'expectedExecutionPayload', 'executionAuthorizationRef', 'providers',
  'expectedFencingGeneration', 'registryOptions', 'storeIdentityRef', 'approvalOptions', 'operationTimeoutMs', 'maxVerifications'];
function manifestConfiguration(input: unknown, writer: boolean): { options: Fields; binding: ManifestExecutionBinding } {
  const options = record(detached(input));
  exact(options, [...MANIFEST_READER_OPTIONS, 'manifest', ...(writer ? ['artifactId', 'retainUntil'] : [])]);
  const binding = validateManifestExecutionBinding({ manifest: options.manifest,
    expectedExecutionPayload: options.expectedExecutionPayload, executionAuthorizationRef: options.executionAuthorizationRef });
  same(options.providers, binding.providers);
  return { options, binding };
}
function requireManifestCore(core: ReceiptCore, binding: ManifestExecutionBinding): void {
  same(core.stage, binding.stage); same(core.scope, binding.scope); same(core.runNonce, binding.runNonce);
  same(core.manifestHash, binding.manifestHash); same(core.executionAuthorizationRef, binding.executionAuthorizationRef);
  same(core.identities, binding.identities);
  same(core.predecessorAcceptanceRef, binding.predecessor?.acceptanceBundleRef ?? null);
  // References alone cannot authorize recovery or prove predecessor acceptance.
  if (core.recoveryAuthorizationRefs.length !== 0) throw new Error();
  if (binding.stage === 'R18') {
    const evidence = record(core.stageEvidence);
    same(evidence.retentionPolicyHash, binding.frozenRetention?.policyHash);
    same(evidence.oldStoreManifestHash, binding.frozenRetention?.oldStoreManifestHash);
    same(evidence.elapsedEvidenceRef, binding.elapsedEvidenceRef);
  }
}

/** Complete-manifest entry point. Its private authority session remains local;
 * derived identities cannot be replaced with caller-supplied receipt labels. */
export function createReferenceManifestAuthorityReceiptWriter(inputOptions: unknown, inputPorts: unknown): ReferenceAuthorityReceiptWriter {
  let binding: ManifestExecutionBinding; let writer: ReferenceAuthorityReceiptWriter;
  try {
    const config = manifestConfiguration(inputOptions, true); binding = config.binding;
    const { manifest: _manifest, ...options } = config.options; void _manifest;
    writer = createReferenceAuthorityReceiptWriter({ ...options, expectedCoreIdentities: binding.identities }, inputPorts);
  } catch { throw new ManifestReceiptBindingError('configuration'); }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    beginExecution: (input: unknown) => writer.beginExecution(input),
    sealBundle: (input: unknown) => writer.sealBundle(input),
    async sealCore(input: unknown): Promise<ReferenceAuthorityReceiptSeal> {
      let request: Fields;
      try {
        request = record(detached(input)); exact(request, ['coreDraft']);
        const draft = record(request.coreDraft); if (Object.hasOwn(draft, 'sealedAt')) throw new Error();
        const core = validateReceiptCore({ ...draft, sealedAt: draft.completedAt }).core;
        requireManifestCore(core, binding);
      } catch { throw new ManifestReceiptBindingError('seal-preflight'); }
      return writer.sealCore(request);
    } });
}

/** Check manifest correspondence before any provider IO or result nonce use.
 * This does not promote reference readback into production stage acceptance. */
export function createReferenceManifestAuthorityReceiptVerifier(inputOptions: unknown, inputPorts: unknown): ReferenceAuthorityReceiptVerifier {
  let binding: ManifestExecutionBinding; let verifier: ReferenceAuthorityReceiptVerifier;
  try {
    const config = manifestConfiguration(inputOptions, false); binding = config.binding;
    const { manifest: _manifest, ...options } = config.options; void _manifest;
    verifier = createReferenceAuthorityReceiptVerifier(options, inputPorts);
  } catch { throw new ManifestReceiptBindingError('configuration'); }
  const preflight = (input: unknown, existing: boolean): Fields => {
    try {
      const request = record(detached(input));
      exact(request, ['bundle', 'evidence', 'conformanceObjects', 'runtimeObjects', ...(existing ? ['resultApprovalProvenance'] : [])]);
      requireManifestCore(validateReceiptCore(record(request.evidence).core).core, binding); return request;
    } catch { throw new ManifestReceiptBindingError('verify-preflight'); }
  };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    async verifyBundle(input: unknown): Promise<ReferenceAuthorityReceiptDecision> {
      return verifier.verifyBundle(preflight(input, false));
    },
    async verifyExistingBundle(input: unknown): Promise<ReferenceExistingAuthorityReceiptDecision> {
      return verifier.verifyExistingBundle(preflight(input, true));
    } });
}

type PredecessorPhase = 'configuration' | 'preflight' | 'bundle-store' | 'decrypt' | 'receipt' | 'final-validation';
type PredecessorCode = 'invalid-config' | 'invalid-evidence' | 'operation-failed' | 'operation-timeout'
  | 'provider-contract-invalid' | 'receipt-invalid' | 'busy' | 'halted' | 'attempt-capacity';
export class PredecessorReceiptError extends Error {
  readonly productionAccepted = false; readonly executionAuthorized = false; readonly nonceConsumedByThisVerifier = false;
  readonly automaticRetryAllowed = false; readonly code: PredecessorCode; readonly phase: PredecessorPhase;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: PredecessorCode, phase: PredecessorPhase, pending = false) {
    super(`[predecessor receipt] ${phase}: ${code}`); this.name = 'PredecessorReceiptError';
    this.code = code; this.phase = phase; this.pendingCompletionUnknown = pending; Object.freeze(this);
  }
}
export interface ReferencePredecessorReceiptDecision {
  readonly schemaVersion: 'kg-predecessor-receipt-observation/v1'; readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-predecessor-object-readback'; readonly predecessorLinkVerified: true;
  readonly productionAccepted: false; readonly stageAcceptanceComplete: false; readonly executionAuthorized: false;
  readonly nonceConsumedByThisVerifier: false; readonly machineGateComputed: false; readonly predecessorChainComplete: false;
  readonly predecessorStage: 'T16' | 'T17'; readonly successorStage: 'T17' | 'R18';
  readonly predecessorManifestHash: string; readonly successorManifestHash: string;
  readonly acceptanceBundleRef: ArtifactReference; readonly bundleStorageRef: ArtifactReference;
  readonly bundleStoreReadbackHash: string; readonly receiptObservationHash: string;
  readonly verifiedAt: string; readonly uncertaintyMs: number; readonly decisionHash: string;
}
export interface ReferencePredecessorReceiptVerifier {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  verifyPredecessor(input: unknown): Promise<ReferencePredecessorReceiptDecision>;
}
function receiptTimestamp(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new Error();
  return Date.parse(input);
}

/** Exact object linkage is a prerequisite, not complete predecessor acceptance.
 * No caller bundle/decision substitutes for store readback + actual decryption.
 * Historical signature/claim/journal checks run inside the captured authority
 * reader; machine-gate recomputation and recursive stage acceptance remain open. */
export function createReferencePredecessorReceiptVerifier(inputOptions: unknown, inputPorts: unknown): ReferencePredecessorReceiptVerifier {
  let prior: ManifestExecutionBinding; let successor: ReturnType<typeof validateForT17> | ReturnType<typeof validateForRetention>;
  let logicalRef: ArtifactReference; let receiptOptions: Fields; let reader: ReferenceAuthorityReceiptVerifier;
  let store: Record<string, Operation>; let kms: Record<string, Operation>; let timeoutMs: number; let maxAttempts: number; let readOnlyId: string;
  try {
    const options = record(detached(inputOptions)); exact(options, ['executionProfile', 'successorManifest', 'predecessorReceiptOptions']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const config = manifestConfiguration(options.predecessorReceiptOptions, false); prior = config.binding; receiptOptions = config.options;
    if (prior.stage === 'R18') throw new Error();
    successor = prior.stage === 'T16' ? validateForT17(options.successorManifest) : validateForRetention(options.successorManifest);
    const policy = record(successor.manifest.policy); const predecessor = record(policy.predecessor);
    same(predecessor.stage, prior.stage); same(predecessor.manifestHash, prior.manifestHash);
    const scope = record(successor.manifest.base.scope);
    same(prior.scope, { environment: scope.environment, tenantId: scope.tenantId, corpusId: scope.corpusId });
    if (successor.stage === 'R18') {
      // The actual prior T17 manifest, not R18's self-consistent declarations,
      // freezes both the policy and the complete old-store manifest.
      same(policy.frozenRetention, prior.frozenRetention);
      same(predecessor.retentionPolicyHash, prior.frozenRetention?.policyHash);
      same(predecessor.oldStoreManifestHash, prior.frozenRetention?.oldStoreManifestHash);
    }
    logicalRef = reference(predecessor.acceptanceBundleRef) as unknown as ArtifactReference;
    reader = createReferenceManifestAuthorityReceiptVerifier(receiptOptions, inputPorts);
    readOnlyId = identifier(record(record(receiptOptions.expectedExecutionPayload).participants).readOnlyId);
    const ports = surface(inputPorts); store = capture(ports.store, ['readExact']); kms = capture(ports.kms, ['decryptArtifact']);
    timeoutMs = receiptOptions.operationTimeoutMs as number; maxAttempts = receiptOptions.maxVerifications as number;
  } catch { throw new PredecessorReceiptError('invalid-config', 'configuration'); }
  let busy = false; let halted = false; let attempts = 0;
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    async verifyPredecessor(input: unknown): Promise<ReferencePredecessorReceiptDecision> {
      if (halted) throw new PredecessorReceiptError('halted', 'preflight');
      if (busy) throw new PredecessorReceiptError('busy', 'preflight');
      if (attempts >= maxAttempts) throw new PredecessorReceiptError('attempt-capacity', 'preflight');
      let phase: PredecessorPhase = 'preflight'; let active = false;
      try {
        const request = record(detached(input));
        exact(request, ['bundleStorageRef', 'bundle', 'evidence', 'conformanceObjects', 'runtimeObjects', 'resultApprovalProvenance']);
        const storageRef = reference(request.bundleStorageRef);
        if (storageRef.objectId !== logicalRef.objectId || storageRef.objectVersion !== logicalRef.objectVersion) throw new Error();
        const bundle = record(request.bundle); const structural = validateAcceptanceBundle(bundle, request.evidence);
        const core = validateReceiptCore(record(request.evidence).core).core; requireManifestCore(core, prior);
        if (!structural.machinePassed || structural.bundleDigest !== logicalRef.sha256) throw new Error();
        // The candidate's complete content digest is independently frozen; its
        // historical time is only a correlation label, not a fresh clock or
        // permission. Exact storage/decryption still must prove these bytes.
        const context = freeze({ executionProfile: 'local-reference', binding: { ...prior.scope, runNonce: prior.runNonce,
          manifestHash: prior.manifestHash }, actorId: readOnlyId,
          authorizationDigest: prior.executionAuthorizationRef.sha256, observedAt: bundle.createdAt });
        busy = true; active = true; attempts++;
        const observe = async (operation: () => unknown): Promise<unknown> => {
          const result = await boundedProviderCall(operation, timeoutMs);
          if (result.status === 'rejected') throw new PredecessorReceiptError('operation-failed', phase);
          if (result.status === 'timeout' || result.status === 'invalid-return') throw new PredecessorReceiptError(
            result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid', phase, result.pendingCompletionUnknown);
          return detached(result.value);
        };
        phase = 'bundle-store'; const stored = record(await observe(() => store.readExact(freeze({ context, ref: storageRef }))));
        exact(stored, ['object', 'proof']); const object = record(stored.object); exact(object, ['schemaVersion', 'aad', 'envelope', 'retainUntil']);
        if (object.schemaVersion !== CONTROLLED_ARTIFACT_OBJECT_SCHEMA || canonicalJsonSha256(object) !== storageRef.sha256
          || receiptTimestamp(object.retainUntil) <= receiptTimestamp(bundle.createdAt)) throw new Error();
        const aad = validateArtifactAad(object.aad); same(aad, { ...context.binding, artifactType: 'acceptance-bundle',
          artifactId: storageRef.objectId, caseId: null, ordinal: 0, schemaVersion: ACCEPTANCE_BUNDLE_SCHEMA });
        const encrypted = validateEncryptedArtifact(object.envelope);
        if (encrypted.aadSha256 !== canonicalJsonSha256(aad)) throw new Error();
        same(stored.proof, { assurance: 'local-reference', productionTamperResistant: false,
          storeIdentityRef: receiptOptions.storeIdentityRef, objectRef: storageRef, lockMode: 'local-reference-immutable',
          retainUntil: object.retainUntil, readerId: context.actorId, observedAt: context.observedAt });
        phase = 'decrypt'; const plaintext = await observe(() => kms.decryptArtifact(freeze({ context, aad, envelope: encrypted })));
        // Exact canonical base64url equality also rejects malformed/oversized
        // JSON, alternate encoding, noncanonical text and invalid UTF-8.
        if (plaintext !== Buffer.from(canonicalJson(bundle), 'utf8').toString('base64url')) throw new Error();
        same(bundle.stage, prior.stage); same(bundle.scope, prior.scope);
        same(bundle.runNonce, prior.runNonce); same(bundle.manifestHash, prior.manifestHash);
        if (successor.stage === 'T17' && receiptTimestamp(record(successor.manifest.policy.window).startsAt) < receiptTimestamp(bundle.createdAt)) throw new Error();
        phase = 'receipt';
        const decision = await reader.verifyExistingBundle({ bundle, evidence: request.evidence,
          conformanceObjects: request.conformanceObjects, runtimeObjects: request.runtimeObjects,
          resultApprovalProvenance: request.resultApprovalProvenance });
        phase = 'final-validation';
        if (!decision.machinePassed || decision.bundleDigest !== logicalRef.sha256
          || receiptTimestamp(decision.verifiedAt) + decision.uncertaintyMs >= receiptTimestamp(object.retainUntil)) throw new Error();
        if (successor.stage === 'T17') {
          // A bundle timestamp alone cannot establish approval-before-window:
          // the actual original claim was independently verified above.
          const claimedClock = record(record(request.resultApprovalProvenance).claimedClockReading);
          if (receiptTimestamp(claimedClock.observedAt) + (claimedClock.uncertaintyMs as number)
            > receiptTimestamp(record(successor.manifest.policy.window).startsAt)) throw new Error();
        }
        const observation = freeze({ schemaVersion: 'kg-predecessor-receipt-observation/v1' as const, classification: 'confidential' as const,
          validationLevel: 'local-reference-predecessor-object-readback' as const, predecessorLinkVerified: true as const,
          productionAccepted: false as const, stageAcceptanceComplete: false as const, executionAuthorized: false as const,
          nonceConsumedByThisVerifier: false as const, machineGateComputed: false as const, predecessorChainComplete: false as const,
          predecessorStage: prior.stage as 'T16' | 'T17', successorStage: successor.stage,
          predecessorManifestHash: prior.manifestHash, successorManifestHash: successor.manifestHash,
          acceptanceBundleRef: logicalRef, bundleStorageRef: storageRef as unknown as ArtifactReference,
          bundleStoreReadbackHash: canonicalJsonSha256(stored), receiptObservationHash: decision.decisionHash,
          verifiedAt: decision.verifiedAt, uncertaintyMs: decision.uncertaintyMs });
        return freeze({ ...observation, decisionHash: canonicalJsonSha256(observation) });
      } catch (error) {
        const failure = error instanceof PredecessorReceiptError ? error : new PredecessorReceiptError(
          phase === 'receipt' ? 'receipt-invalid' : 'invalid-evidence', phase,
          error instanceof AuthorityReceiptError && error.pendingCompletionUnknown);
        if (failure.pendingCompletionUnknown || failure.code === 'provider-contract-invalid'
          || error instanceof AuthorityReceiptError && (error.code === 'halted' || error.code === 'provider-contract-invalid')) halted = true;
        throw failure;
      } finally { if (active) busy = false; }
    } });
}

/** A private, single-use local session: consume execution approval BEFORE a
 * fresh run, then authorize sealing without replaying its nonce. This is not a
 * portable grant, enterprise writer, computed machine gate, manifest authority,
 * predecessor acceptance or recovery/renewal composer. Those remain fail closed. */
export function createReferenceAuthorityReceiptWriter(inputOptions: unknown, inputPorts: unknown): ReferenceAuthorityReceiptWriter {
  let options: Fields; let expected: ExecutionAuthorizationPayload; let binding: ArtifactRunBinding;
  let registryOptions: Fields; let authorityOptions: Fields; let timeoutMs: number; let maxAttempts: number; let generation: number;
  let signatureVerifier: ReturnType<typeof createReferenceAuthorizationSignatureVerifier>;
  let registry: Record<string, Operation>; let journal: Record<string, Operation>; let store: Record<string, Operation>;
  let kms: Record<string, Operation>; let clock: Record<string, Operation>; let nonceStore: Record<string, Operation>;
  try {
    options = record(detached(inputOptions));
    const { expectedCoreIdentities, artifactId, retainUntil, ...readerOptions } = options;
    exact(options, ['executionProfile', 'expectedExecutionPayload', 'executionAuthorizationRef', 'providers',
      'expectedFencingGeneration', 'registryOptions', 'storeIdentityRef', 'approvalOptions', 'operationTimeoutMs', 'maxVerifications',
      'expectedCoreIdentities', 'artifactId', 'retainUntil']);
    // Reuse the reader's constructor-only configuration checks. It performs
    // no IO and never supplies this writer with a caller approval decision.
    createReferenceAuthorityReceiptVerifier(readerOptions, inputPorts);
    const shape = validateAuthorizationEnvelope({ schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution',
      payload: options.expectedExecutionPayload, signature: { algorithm: 'Ed25519', keyId: 'shape-only', keyVersion: 'v1', value: Buffer.alloc(64).toString('base64url') } }).envelope;
    if (shape.kind !== 'execution') throw new Error(); expected = shape.payload;
    const identities = record(expectedCoreIdentities);
    exact(identities, ['datasetHash', 'rosterHash', 'sharedConfigHash', 'artifactsHash', 'indexIdentityRef', 'registryRef', 'providersHash', 'thresholdsHash', 'armConfigHashes']);
    for (const field of ['datasetHash', 'rosterHash', 'sharedConfigHash', 'artifactsHash', 'providersHash', 'thresholdsHash']) {
      if (typeof identities[field] !== 'string' || !/^[a-f0-9]{64}$/.test(identities[field] as string)) throw new Error();
    }
    reference(identities.indexIdentityRef); same(identities.registryRef, expected.registryRef);
    same(identities.providersHash, expected.providersHash); same(identities.thresholdsHash, expected.thresholdsHash);
    if (expected.stage === 'R18') { if (identities.armConfigHashes !== null) throw new Error(); }
    else {
      const arms = record(identities.armConfigHashes); exact(arms, ['off', expected.stage === 'T16' ? 'shadow' : 'active']);
      for (const value of Object.values(arms)) if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error();
    }
    identifier(artifactId);
    if (typeof retainUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(retainUntil)
      || !Number.isFinite(Date.parse(retainUntil)) || new Date(retainUntil).toISOString() !== retainUntil) throw new Error();
    binding = freeze({ ...expected.scope, runNonce: expected.runNonce, manifestHash: expected.manifestHash });
    registryOptions = record(options.registryOptions); authorityOptions = record(options.approvalOptions);
    timeoutMs = options.operationTimeoutMs as number; maxAttempts = options.maxVerifications as number; generation = options.expectedFencingGeneration as number;
    signatureVerifier = createReferenceAuthorizationSignatureVerifier({ executionProfile: 'local-reference', keys: authorityOptions.keys });
    const ports = surface(inputPorts);
    registry = capture(ports.registry, ['readExactPolicy']); journal = capture(ports.journal, ['readHead', 'readEntries']);
    store = capture(ports.store, ['sealEncryptedArtifact', 'readExact']); kms = capture(ports.kms, ['encryptArtifact', 'decryptArtifact']);
    clock = capture(ports.clock, ['readTime']); nonceStore = capture(ports.nonceStore, ['consumeAuthorizationNonce', 'readExactNonceClaim']);
  } catch { throw new AuthorityReceiptWriterError('invalid-config', 'configuration'); }
  let state: 'idle' | 'starting' | 'armed' | 'sealing' | 'sealed' | 'bundle-sealing' | 'bundle-sealed' | 'halted' = 'idle'; let attempts = 0;
  let phase: WriterPhase = 'preflight'; let outcome: NonceOutcome = 'not-attempted'; let mutationDispatched = false;
  let lastClock: AuthorityClockReading | null = null; let envelope: AuthorizationEnvelope | null = null;
  let selection: Fields | null = null; let startUpper = Infinity; let approvalHash = ''; let registryProofHash = '';
  let innerFailure: AuthorityReceiptWriterError | null = null; const challenges = new Set<string>();
  let sealedCore: ReferenceAuthorityReceiptSeal | null = null; let sealedHead: unknown;
  let resultEnvelope: AuthorizationEnvelope | null = null; let resultPayload: ResultAttestationPayload | null = null;
  let resultClaimedClock: AuthorityClockReading | null = null;
  const fail = (code: WriterCode, pending = false) => new AuthorityReceiptWriterError(code, phase, outcome, pending, mutationDispatched);
  const active = () => { if (state === 'halted' || state === 'sealed' || state === 'bundle-sealed') throw fail('halted'); };
  const challenge = () => {
    // A complete bounded session needs 7 begin + 18 core + 55 bundle
    // challenges. This IO budget is separate from approval/nonce attempts.
    if (challenges.size >= maxAttempts * 80) throw fail('attempt-capacity');
    for (let retry = 0; retry < 4; retry++) {
      const value = randomBytes(16).toString('hex'); if (!challenges.has(value)) { challenges.add(value); return value; }
    }
    throw fail('attempt-capacity');
  };
  const observe = async (operation: () => unknown, entries = false): Promise<unknown> => {
    active(); const result = await boundedProviderCall(operation, timeoutMs); active();
    if (result.status === 'rejected') throw fail('operation-failed');
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      throw fail(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid', result.pendingCompletionUnknown);
    }
    try { return entries ? detachedEntries(result.value, true) : detached(result.value); }
    catch { throw fail('invalid-evidence'); }
  };
  const rawClock = async (request: AuthorityClockRequest): Promise<AuthorityClockReading> => {
    phase = 'clock';
    const reading = validateAuthorityClockReading(await observe(() => clock.readTime(request)), { request,
      sourceIdentityRef: authorityOptions.clockIdentityRef, maxUncertaintyMs: authorityOptions.maxClockUncertaintyMs, previousReading: lastClock }).reading;
    if (reading.assurance !== 'local-reference' || reading.productionTimeAuthenticated !== false) throw fail('invalid-evidence');
    lastClock = reading; return reading;
  };
  const checkTime = (reading: AuthorityClockReading, trust: ReturnType<typeof createReferenceProviderTrustVerifier>) => {
    if (!envelope || !selection) throw fail('invalid-evidence');
    const current = Date.parse(reading.observedAt);
    for (const observed of [current - reading.uncertaintyMs, current + reading.uncertaintyMs]) {
      if (observed < Date.parse(expected.window.startsAt) || observed >= Date.parse(expected.window.endsAt)
        || observed >= Date.parse(options.retainUntil as string)) throw fail('invalid-evidence');
      const observedAt = new Date(observed).toISOString();
      signatureVerifier.verifySignature({ envelope, expectedPayload: expected, observedAt });
      if (resultEnvelope && resultPayload) signatureVerifier.verifySignature({ envelope: resultEnvelope, expectedPayload: resultPayload, observedAt });
      trust.verifySelection({ ...selection, observedAt });
    }
  };
  const clockContext = freeze({ executionProfile: 'local-reference' as const, binding, actorId: expected.participants.executorId });
  /** Read time around an independently challenged registry read, and validate
   * the complete uncertainty interval with no await after the final reading. */
  const checkpoint = async (inputRequest?: AuthorityClockRequest): Promise<AuthorityClockReading> => {
    const first = await rawClock(freeze({ context: clockContext, requestNonce: challenge() }));
    phase = 'registry';
    const request = freeze({ context: { executionProfile: 'local-reference', binding, actorId: registryOptions.readerId,
      authorizationDigest: reference(options.executionAuthorizationRef).sha256, observedAt: first.observedAt },
      policyRef: expected.registryRef, requestNonce: challenge() });
    const readback = validateProviderRegistryReadback(await observe(() => registry.readExactPolicy(request)),
      { request, sourceIdentityRef: registryOptions.sourceIdentityRef });
    const createTrust = () => createReferenceProviderTrustVerifier({ executionProfile: 'local-reference', policy: readback.policy,
      policyRef: expected.registryRef, authorityKeys: registryOptions.authorityKeys });
    checkTime(first, createTrust());
    const second = await rawClock(inputRequest ?? freeze({ context: clockContext, requestNonce: challenge() }));
    // Real readings remain sequence/time monotonic, but their uncertainty
    // intervals may overlap. Do not feed the next lower edge to a verifier
    // whose previous upper edge would falsely look like clock regression.
    checkTime(second, createTrust()); registryProofHash = readback.proofHash; return second;
  };
  const guardedCheckpoint = async (request?: AuthorityClockRequest) => {
    try { return await checkpoint(request); }
    catch (error) { innerFailure = error instanceof AuthorityReceiptWriterError ? error : fail('invalid-evidence'); throw innerFailure; }
  };
  const approval = createReferenceAuthorityApprovalVerifier(authorityOptions, {
    clock: { executionProfile: 'local-reference', productionCapable: false, readTime: guardedCheckpoint },
    nonceStore: { executionProfile: 'local-reference', productionCapable: false,
      consumeAuthorizationNonce(request: unknown) {
        active(); outcome = 'unknown';
        if (record(request).authorizationKind === 'result') resultClaimedClock = record(request).clockReading as AuthorityClockReading;
        return nonceStore.consumeAuthorizationNonce(request);
      },
      readExactNonceClaim(request: unknown) { active(); return nonceStore.readExactNonceClaim(request); } },
  });
  const readJournal = async () => {
    phase = 'journal'; const first = await observe(() => journal.readHead());
    const entries = await observe(() => journal.readEntries(), true) as readonly Fields[];
    const head = await observe(() => journal.readHead()); same(first, head);
    validateJournalChain(entries, { ...binding, scopeHash: canonicalJsonSha256(expected.scope) }, head);
    if (record(head).fencingGeneration !== generation) throw fail('invalid-evidence'); return freeze({ head, entries });
  };
  const normalizeFailure = (error: unknown): AuthorityReceiptWriterError => {
    if (error instanceof AuthorityApprovalError) outcome = error.nonceOutcome;
    const detail = innerFailure ?? (error instanceof AuthorityReceiptWriterError ? error : null);
    const code = detail?.code ?? (error instanceof AuthorityApprovalError ? 'approval-failed'
      : error instanceof ReferenceReceiptSealError ? error.code === 'provider-operation-failed' ? 'operation-failed'
        : error.code === 'provider-payload-invalid' ? 'invalid-evidence' : error.code : 'invalid-evidence');
    return new AuthorityReceiptWriterError(code, detail?.phase ?? phase, outcome,
      Boolean(detail?.pendingCompletionUnknown || (error instanceof AuthorityApprovalError || error instanceof ReferenceReceiptSealError) && error.pendingCompletionUnknown),
      mutationDispatched);
  };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false,
    async beginExecution(input: unknown): Promise<ReferenceAuthorityExecutionStart> {
      if (state === 'halted') throw new AuthorityReceiptWriterError('halted', 'preflight', outcome, false, mutationDispatched);
      if (state === 'starting' || state === 'sealing' || state === 'bundle-sealing') throw new AuthorityReceiptWriterError('busy', 'preflight', outcome, false, mutationDispatched);
      if (state !== 'idle') throw new AuthorityReceiptWriterError('already-started', 'preflight', outcome, false, mutationDispatched);
      phase = 'preflight'; if (attempts >= maxAttempts) throw fail('attempt-capacity');
      let started = false;
      try {
        const request = record(detached(input)); exact(request, ['executionEnvelope', 'conformanceObjects', 'runtimeObjects']);
        const candidate = validateAuthorizationEnvelope(request.executionEnvelope).envelope;
        if (candidate.kind !== 'execution') throw new Error(); same(candidate.payload, expected);
        if (canonicalJsonSha256(candidate) !== reference(options.executionAuthorizationRef).sha256) throw new Error();
        signatureVerifier.verifySignature({ envelope: candidate, expectedPayload: expected, observedAt: expected.notBefore });
        envelope = candidate; selection = freeze({ stage: expected.stage, scope: expected.scope, runNonce: expected.runNonce,
          manifestHash: expected.manifestHash, providers: options.providers, executionProvidersHash: expected.providersHash,
          conformanceObjects: request.conformanceObjects, runtimeObjects: request.runtimeObjects });
        state = 'starting'; started = true; attempts++; innerFailure = null;
        const before = await readJournal(); if (before.entries.length !== 0 || record(before.head).terminal !== false) throw fail('invalid-evidence');
        phase = 'execution-approval';
        const decision = await approval.verifyAndConsume({ context: clockContext, envelope: candidate, expectedPayload: expected });
        outcome = 'reported-consumed'; approvalHash = decision.decisionHash;
        const after = await readJournal(); same(before, after);
        const reading = await guardedCheckpoint(); startUpper = Date.parse(reading.observedAt) + reading.uncertaintyMs;
        state = 'armed';
        return freeze({ validationLevel: 'local-reference-execution-session' as const, productionAccepted: false as const,
          stageAcceptanceComplete: false as const, startNotBefore: new Date(startUpper).toISOString(), approvalDecisionHash: approvalHash });
      } catch (error) { const failure = normalizeFailure(error); if (started) state = 'halted'; throw failure; }
    },
    async sealCore(input: unknown): Promise<ReferenceAuthorityReceiptSeal> {
      if (state === 'halted') throw new AuthorityReceiptWriterError('halted', 'preflight', outcome, false, mutationDispatched);
      if (state === 'starting' || state === 'sealing' || state === 'bundle-sealing') throw new AuthorityReceiptWriterError('busy', 'preflight', outcome, false, mutationDispatched);
      if (state === 'sealed' || state === 'bundle-sealed') throw new AuthorityReceiptWriterError('already-sealed', 'preflight', outcome, false, mutationDispatched);
      if (state !== 'armed') throw new AuthorityReceiptWriterError('not-started', 'preflight', outcome, false, mutationDispatched);
      phase = 'preflight';
      let started = false;
      try {
        const request = record(detached(input)); exact(request, ['coreDraft']); const draft = record(request.coreDraft);
        if (Object.hasOwn(draft, 'sealedAt')) throw new Error();
        const structural = validateReceiptCore({ ...draft, sealedAt: draft.completedAt }).core;
        same(structural.scope, expected.scope); same(structural.runNonce, expected.runNonce); same(structural.manifestHash, expected.manifestHash);
        same(structural.stage, expected.stage); same(structural.identities, options.expectedCoreIdentities);
        same(structural.executionAuthorizationRef, options.executionAuthorizationRef);
        if (structural.executionIdentityId !== expected.participants.executorId || structural.terminalActorId !== expected.participants.executorId
          || structural.terminalAuthorizationDigest !== reference(options.executionAuthorizationRef).sha256
          || structural.journal.fencingGeneration !== generation || structural.recoveryAuthorizationRefs.length !== 0
          || Date.parse(structural.startedAt) < startUpper || !envelope || !selection) throw new Error();
        const runtimeRefs = (selection.runtimeObjects as Fields[]).map(value => canonicalJson(reference(value.ref))).sort();
        same(structural.providerReadbackRefs.map(value => canonicalJson(value)).sort(), runtimeRefs);
        for (const observedAt of [structural.startedAt, structural.completedAt]) {
          if (Date.parse(observedAt) >= Date.parse(expected.window.endsAt)) throw new Error();
          signatureVerifier.verifySignature({ envelope, expectedPayload: expected, observedAt });
        }
        state = 'sealing'; started = true; innerFailure = null;
        const readback = await readJournal(); createReceiptCore(structural, readback);
        for (const entry of readback.entries) {
          if (entry.actorId !== expected.participants.executorId || entry.authorizationDigest !== reference(options.executionAuthorizationRef).sha256
            || entry.fencingGeneration !== generation || !STAGE_EXECUTION_ACTIONS[expected.stage].includes(entry.action as string)
            || Date.parse(entry.trustedTime as string) < startUpper || Date.parse(entry.trustedTime as string) >= Date.parse(expected.window.endsAt)) throw new Error();
          signatureVerifier.verifySignature({ envelope, expectedPayload: expected, observedAt: entry.trustedTime });
        }
        const reading = await guardedCheckpoint();
        if (Date.parse(reading.observedAt) - reading.uncertaintyMs < Date.parse(structural.completedAt)) throw new Error();
        const core = createReceiptCore({ ...draft, sealedAt: reading.observedAt }, readback).core;
        const context = (actorId: string) => freeze({ executionProfile: 'local-reference', binding, actorId,
          authorizationDigest: reference(options.executionAuthorizationRef).sha256, observedAt: core.sealedAt });
        const guardedOperation = async (operation: WriterPhase, execute: () => unknown, mutation: boolean) => {
          try {
            phase = 'journal'; same(await observe(() => journal.readHead()), readback.head);
            // Journal IO can outlive authorization. Final time/trust checks
            // must follow it, immediately before invoking the real callback.
            await guardedCheckpoint(); active();
            phase = operation; active(); if (mutation) mutationDispatched = true;
            return await observe(execute);
          } catch (error) { innerFailure = error instanceof AuthorityReceiptWriterError ? error : fail('invalid-evidence'); throw innerFailure; }
        };
        // The core/proof context time is a local correlation label. Fresh
        // authority checks surround actual operations; the final observation
        // separately records completion time, not enterprise time attestation.
        const seal = await sealReferenceReceiptCore({ executionProfile: 'local-reference', core, journalReadback: readback,
          executorContext: context(expected.participants.executorId), readerContext: context(expected.participants.readOnlyId),
          artifactId: options.artifactId, retainUntil: options.retainUntil, expectedStoreIdentityRef: options.storeIdentityRef },
        { executionProfile: 'local-reference', productionCapable: false,
          encryptArtifact: (request: unknown) => guardedOperation('encrypt', () => kms.encryptArtifact(request), true),
          decryptArtifact: (request: unknown) => guardedOperation('decrypt', () => kms.decryptArtifact(request), false) } as unknown as KmsEnvelopePort,
        { executionProfile: 'local-reference', productionCapable: false,
          sealEncryptedArtifact: (request: unknown) => guardedOperation('store-seal', () => store.sealEncryptedArtifact(request), true),
          readExact: (request: unknown) => guardedOperation('store-read', () => store.readExact(request), false) } as unknown as TamperResistantArtifactStore, timeoutMs);
        phase = 'final-validation'; same(await observe(() => journal.readHead()), readback.head);
        const finalClock = await guardedCheckpoint(); phase = 'final-validation';
        const observation = freeze({ validationLevel: 'local-reference-authority-seal' as const, productionAccepted: false as const,
          stageAcceptanceComplete: false as const, approvalDecisionHash: approvalHash, clockReadingHash: canonicalJsonSha256(finalClock),
          registryProofHash, verifiedAt: finalClock.observedAt, uncertaintyMs: finalClock.uncertaintyMs });
        sealedCore = freeze({ ...seal, stageAcceptanceComplete: false as const, authorityObservation: { ...observation, decisionHash: canonicalJsonSha256(observation) } });
        sealedHead = readback.head; state = 'sealed'; return sealedCore;
      } catch (error) { const failure = normalizeFailure(error); if (started) state = 'halted'; throw failure; }
    },
    async sealBundle(input: unknown): Promise<ReferenceAuthorityAcceptanceSeal> {
      if (state === 'halted') throw new AuthorityReceiptWriterError('halted', 'preflight', outcome, false, mutationDispatched);
      if (state === 'starting' || state === 'sealing' || state === 'bundle-sealing') throw new AuthorityReceiptWriterError('busy', 'preflight', outcome, false, mutationDispatched);
      if (state === 'bundle-sealed') throw new AuthorityReceiptWriterError('already-bundle-sealed', 'preflight', outcome, false, mutationDispatched);
      if (state !== 'sealed' || !sealedCore || !envelope) throw new AuthorityReceiptWriterError('core-not-sealed', 'preflight', outcome, false, mutationDispatched);
      phase = 'preflight'; let started = false;
      try {
        const request = record(detached(input)); exact(request, ['resultEnvelope']);
        const candidate = validateAuthorizationEnvelope(request.resultEnvelope).envelope;
        if (candidate.kind !== 'result') throw new Error();
        const payload = independentResultPayload(candidate.payload, expected, options.executionAuthorizationRef as ArtifactReference,
          sealedCore.core, sealedCore.receiptCoreRef);
        signatureVerifier.verifySignature({ envelope: candidate, expectedPayload: payload, observedAt: payload.notBefore });
        // The proof's context time is only a correlation label. Result
        // issuance must follow actual core completion, including uncertainty.
        const completion = sealedCore.authorityObservation;
        if (Date.parse(payload.issuedAt) < Date.parse(sealedCore.readbackProof.observedAt)
          || Date.parse(payload.issuedAt) < Date.parse(completion.verifiedAt) + completion.uncertaintyMs) throw new Error();
        const coreSeal = sealedCore; const executionEnvelope = envelope;
        resultEnvelope = candidate; resultPayload = payload; state = 'bundle-sealing'; started = true; innerFailure = null;
        phase = 'result-approval';
        const decision = await approval.verifyAndConsume({ context: clockContext, envelope: candidate, expectedPayload: payload });
        outcome = 'reported-consumed';
        if (!resultClaimedClock) throw fail('invalid-evidence');
        const provenance = freeze({ nonceClaimRef: decision.nonceClaimRef, claimedClockReading: resultClaimedClock });
        const guardedOperation = async (operation: WriterPhase, execute: () => unknown, mutation: boolean) => {
          phase = 'journal'; same(await observe(() => journal.readHead()), sealedHead);
          // IO can outlive both grants. Recheck live signatures, registry and
          // the shared clock after journal IO, immediately before dispatch.
          await guardedCheckpoint(); phase = operation; active(); if (mutation) mutationDispatched = true;
          return observe(execute);
        };
        const sealArtifact = async (artifactType: 'result-attestation' | 'readback-proof' | 'acceptance-bundle',
          value: unknown, schemaVersion: string) => {
          const plaintextHash = canonicalJsonSha256(value);
          const artifactId = `receipt-${artifactType}-${canonicalJsonSha256({ binding, receiptCoreRef: coreSeal.receiptCoreRef, plaintextHash })}`;
          const aad = freeze(validateArtifactAad({ ...binding, artifactType, artifactId, caseId: null, ordinal: 0, schemaVersion }));
          const label = await guardedCheckpoint();
          const context = (actorId: string) => freeze({ executionProfile: 'local-reference', binding, actorId,
            authorizationDigest: reference(options.executionAuthorizationRef).sha256, observedAt: label.observedAt });
          const executor = context(expected.participants.executorId); const reader = context(expected.participants.readOnlyId);
          const plaintext = Buffer.from(canonicalJson(value), 'utf8').toString('base64url');
          const encrypted = freeze(validateEncryptedArtifact(await guardedOperation('encrypt',
            () => kms.encryptArtifact(freeze({ context: executor, aad, plaintextBase64url: plaintext })), true)));
          if (encrypted.aadSha256 !== canonicalJsonSha256(aad)) throw fail('invalid-evidence');
          const object = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA, aad, envelope: encrypted, retainUntil: options.retainUntil });
          const storageRef = reference(await guardedOperation('store-seal',
            () => store.sealEncryptedArtifact(freeze({ context: executor, aad, envelope: encrypted, retainUntil: options.retainUntil })), true)) as unknown as ArtifactReference;
          if (storageRef.objectId !== artifactId || storageRef.sha256 !== canonicalJsonSha256(object)) throw fail('invalid-evidence');
          const stored = record(await guardedOperation('store-read', () => store.readExact(freeze({ context: reader, ref: storageRef })), false));
          exact(stored, ['object', 'proof']); same(stored.object, object);
          const proof = record(stored.proof);
          exact(proof, ['assurance', 'productionTamperResistant', 'storeIdentityRef', 'objectRef', 'lockMode', 'retainUntil', 'readerId', 'observedAt']);
          same(proof, { assurance: 'local-reference', productionTamperResistant: false, storeIdentityRef: options.storeIdentityRef,
            objectRef: storageRef, lockMode: 'local-reference-immutable', retainUntil: options.retainUntil,
            readerId: reader.actorId, observedAt: reader.observedAt });
          const decrypted = await guardedOperation('decrypt', () => kms.decryptArtifact(freeze({ context: reader, aad, envelope: encrypted })), false);
          if (decrypted !== plaintext) throw fail('invalid-evidence');
          return freeze({ storageRef, logicalRef: { ...storageRef, sha256: plaintextHash }, readbackHash: canonicalJsonSha256(stored) });
        };
        const result = await sealArtifact('result-attestation', candidate, candidate.schemaVersion);
        const proof = await sealArtifact('readback-proof', coreSeal.readbackProof, RECEIPT_READBACK_PROOF_SCHEMA);
        const created = await guardedCheckpoint();
        const evidence = freeze({ core: coreSeal.core, executionEnvelope, resultEnvelope: candidate, readbackProof: coreSeal.readbackProof });
        const bundle: StageAcceptanceBundle = freeze({ schemaVersion: ACCEPTANCE_BUNDLE_SCHEMA, classification: 'confidential',
          stage: expected.stage, scope: expected.scope, runNonce: expected.runNonce, manifestHash: expected.manifestHash,
          receiptCoreRef: coreSeal.receiptCoreRef, receiptStorageRef: coreSeal.storageObjectRef,
          resultAttestationRef: result.logicalRef, readbackProofRef: proof.logicalRef, createdAt: created.observedAt });
        validateAcceptanceBundle(bundle, evidence);
        const sealed = await sealArtifact('acceptance-bundle', bundle, ACCEPTANCE_BUNDLE_SCHEMA);
        phase = 'journal'; same(await observe(() => journal.readHead()), sealedHead);
        const finalClock = await guardedCheckpoint(); phase = 'final-validation';
        const observation = freeze({ validationLevel: 'local-reference-authority-bundle-seal' as const,
          productionAccepted: false as const, stageAcceptanceComplete: false as const, machineGateComputed: false as const,
          executionApprovalDecisionHash: approvalHash, resultApprovalDecisionHash: decision.decisionHash,
          clockReadingHash: canonicalJsonSha256(finalClock), registryProofHash, bundleReadbackHash: sealed.readbackHash,
          verifiedAt: finalClock.observedAt, uncertaintyMs: finalClock.uncertaintyMs });
        state = 'bundle-sealed';
        return freeze({ productionAccepted: false as const, stageAcceptanceComplete: false as const, machineGateComputed: false as const,
          bundle, acceptanceBundleRef: sealed.logicalRef, bundleStorageRef: sealed.storageRef,
          resultAttestationStorageRef: result.storageRef, readbackProofStorageRef: proof.storageRef,
          evidence, resultApprovalProvenance: provenance, authorityObservation: { ...observation, decisionHash: canonicalJsonSha256(observation) } });
      } catch (error) { const failure = normalizeFailure(error); if (started) state = 'halted'; throw failure; }
    },
  });
}

/** Normal validation consumes an actual local result approval, not a decision
 * label. Historical observation reads its exact existing nonce claim instead.
 * It independently reads registry/journal/encrypted storage and decrypts the
 * core. It does NOT authenticate enterprise sources, compute the machine gate,
 * validate predecessor acceptance or support frozen-policy rescue; no result
 * can be promoted to complete stage acceptance or production authorization. */
export function createReferenceAuthorityReceiptVerifier(inputOptions: unknown, inputPorts: unknown): ReferenceAuthorityReceiptVerifier {
  let options: Fields; let expected: ExecutionAuthorizationPayload; let binding: ArtifactRunBinding;
  let registryOptions: Fields; let timeoutMs: number; let maxAttempts: number; let generation: number;
  let registry: Record<string, Operation>; let journal: Record<string, Operation>; let store: Record<string, Operation>; let kms: Record<string, Operation>;
  let signatureVerifier: ReturnType<typeof createReferenceAuthorizationSignatureVerifier>;
  let approval: ReturnType<typeof createReferenceAuthorityApprovalVerifier>;
  let provenance: ReturnType<typeof createReferenceAuthorityApprovalVerificationPair>['provenance'];
  try {
    options = record(detached(inputOptions));
    exact(options, ['executionProfile', 'expectedExecutionPayload', 'executionAuthorizationRef', 'providers',
      'expectedFencingGeneration', 'registryOptions', 'storeIdentityRef', 'approvalOptions', 'operationTimeoutMs', 'maxVerifications']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const shape = validateAuthorizationEnvelope({ schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution',
      payload: options.expectedExecutionPayload, signature: { algorithm: 'Ed25519', keyId: 'shape-only', keyVersion: 'v1', value: Buffer.alloc(64).toString('base64url') } });
    if (shape.envelope.kind !== 'execution') throw new Error(); expected = shape.envelope.payload;
    reference(options.executionAuthorizationRef); reference(options.storeIdentityRef);
    const providers = record(options.providers); exact(providers, ['registryRef', 'bindings']);
    same(providers.registryRef, expected.registryRef);
    if (canonicalJsonSha256(providers) !== expected.providersHash) throw new Error();
    binding = freeze({ ...expected.scope, runNonce: expected.runNonce, manifestHash: expected.manifestHash });
    registryOptions = record(options.registryOptions); exact(registryOptions, ['sourceIdentityRef', 'readerId', 'authorityKeys']);
    reference(registryOptions.sourceIdentityRef); identifier(registryOptions.readerId);
    if (!Array.isArray(registryOptions.authorityKeys) || registryOptions.authorityKeys.length < 1 || registryOptions.authorityKeys.length > 128) throw new Error();
    timeoutMs = integer(options.operationTimeoutMs, 60000); maxAttempts = integer(options.maxVerifications, 4096);
    generation = integer(options.expectedFencingGeneration, Number.MAX_SAFE_INTEGER);
    const authorityOptions = record(options.approvalOptions);
    if (authorityOptions.executionProfile !== 'local-reference') throw new Error();
    same(authorityOptions.scope, expected.scope);
    same(authorityOptions.actors, { verifierId: expected.participants.executorId, readOnlyId: expected.participants.readOnlyId });
    signatureVerifier = createReferenceAuthorizationSignatureVerifier({ executionProfile: 'local-reference', keys: authorityOptions.keys });
    const ports = surface(inputPorts); exact(ports, ['registry', 'journal', 'store', 'kms', 'clock', 'nonceStore']);
    registry = capture(ports.registry, ['readExactPolicy']); journal = capture(ports.journal, ['readHead', 'readEntries']);
    store = capture(ports.store, ['readExact']); kms = capture(ports.kms, ['decryptArtifact']);
    const clock = capture(ports.clock, ['readTime']); const nonceStore = capture(ports.nonceStore, ['consumeAuthorizationNonce', 'readExactNonceClaim']);
    const approvalPorts = {
      clock: { executionProfile: 'local-reference', productionCapable: false, ...clock },
      nonceStore: { executionProfile: 'local-reference', productionCapable: false, ...nonceStore },
    };
    const pair = createReferenceAuthorityApprovalVerificationPair(authorityOptions, approvalPorts);
    approval = pair.approval; provenance = pair.provenance;
  } catch { throw new AuthorityReceiptError('invalid-config', 'configuration'); }
  let busy = false; let halted = false; let attempts = 0; const challenges = new Set<string>();
  function verify(input: unknown, existing: false): Promise<ReferenceAuthorityReceiptDecision>;
  function verify(input: unknown, existing: true): Promise<ReferenceExistingAuthorityReceiptDecision>;
  async function verify(input: unknown, existing: boolean): Promise<ReferenceAuthorityReceiptDecision | ReferenceExistingAuthorityReceiptDecision> {
      if (halted) throw new AuthorityReceiptError('halted', 'preflight');
      if (busy) throw new AuthorityReceiptError('busy', 'preflight');
      if (attempts >= maxAttempts) throw new AuthorityReceiptError('attempt-capacity', 'preflight');
      let phase: Phase = 'preflight'; let outcome: NonceOutcome = 'not-attempted'; let active = false;
      try {
        const request = record(detached(input));
        exact(request, ['bundle', 'evidence', 'conformanceObjects', 'runtimeObjects', ...(existing ? ['resultApprovalProvenance'] : [])]);
        const history = existing ? record(request.resultApprovalProvenance) : null;
        if (history) { exact(history, ['nonceClaimRef', 'claimedClockReading']); reference(history.nonceClaimRef); }
        const evidence = record(request.evidence); const bundle = record(request.bundle);
        const structural = validateAcceptanceBundle(bundle, evidence); const core = record(evidence.core);
        const execution = validateAuthorizationEnvelope(evidence.executionEnvelope).envelope;
        const result = validateAuthorizationEnvelope(evidence.resultEnvelope).envelope;
        if (execution.kind !== 'execution' || result.kind !== 'result') throw new Error();
        same(execution.payload, expected); same(core.executionAuthorizationRef, options.executionAuthorizationRef);
        if (core.journal === null || record(core.journal).fencingGeneration !== generation) throw new Error();
        signatureVerifier.verifySignature({ envelope: execution, expectedPayload: expected, observedAt: core.startedAt });
        signatureVerifier.verifySignature({ envelope: execution, expectedPayload: expected, observedAt: core.completedAt });
        // Receipt encryption/sealing is also an execution-authorized mutation;
        // a valid terminal event must not launder a later expired-label write.
        signatureVerifier.verifySignature({ envelope: execution, expectedPayload: expected, observedAt: core.sealedAt });
        const sealedAt = Date.parse(core.sealedAt as string);
        if (sealedAt < Date.parse(expected.window.startsAt) || sealedAt >= Date.parse(expected.window.endsAt)) throw new Error();
        const resultPayload = independentResultPayload(result.payload, expected, options.executionAuthorizationRef as ArtifactReference,
          core as unknown as ReceiptCore, bundle.receiptCoreRef as ArtifactReference);
        signatureVerifier.verifySignature({ envelope: result, expectedPayload: resultPayload, observedAt: bundle.createdAt });
        const historicalProof = record(evidence.readbackProof); const historicalStore = record(historicalProof.storeProof);
        if (historicalProof.assurance !== 'local-reference' || historicalProof.productionTamperResistant !== false) throw new Error();
        same(historicalStore.storeIdentityRef, options.storeIdentityRef);
        busy = true; active = true; attempts++;
        const observe = async (operation: () => unknown, entries = false): Promise<unknown> => {
          const observation = await boundedProviderCall(operation, timeoutMs);
          if (observation.status === 'rejected') throw new AuthorityReceiptError('operation-failed', phase, outcome);
          if (observation.status === 'timeout' || observation.status === 'invalid-return') {
            throw new AuthorityReceiptError(observation.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid',
              phase, outcome, observation.pendingCompletionUnknown);
          }
          // Detach synchronously before an async return can adopt the payload.
          return entries ? detachedEntries(observation.value) : detached(observation.value);
        };
        let challenge = '';
        for (let retry = 0; retry < 4 && !challenge; retry++) { const candidate = randomBytes(16).toString('hex'); if (!challenges.has(candidate)) challenge = candidate; }
        if (!challenge) throw new AuthorityReceiptError('attempt-capacity', phase); challenges.add(challenge);
        const context = freeze({ executionProfile: 'local-reference' as const, binding, actorId: expected.participants.readOnlyId,
          authorizationDigest: reference(options.executionAuthorizationRef).sha256, observedAt: bundle.createdAt });
        phase = 'registry'; const registryRequest = freeze({ context: { ...context, actorId: registryOptions.readerId },
          policyRef: expected.registryRef, requestNonce: challenge });
        const policy = validateProviderRegistryReadback(await observe(() => registry.readExactPolicy(registryRequest)),
          { request: registryRequest, sourceIdentityRef: registryOptions.sourceIdentityRef });
        const trust = createReferenceProviderTrustVerifier({ executionProfile: 'local-reference', policy: policy.policy,
          policyRef: expected.registryRef, authorityKeys: registryOptions.authorityKeys });
        const selection = freeze({ stage: expected.stage, scope: expected.scope, runNonce: expected.runNonce, manifestHash: expected.manifestHash,
          providers: options.providers, executionProvidersHash: expected.providersHash, observedAt: bundle.createdAt,
          conformanceObjects: request.conformanceObjects, runtimeObjects: request.runtimeObjects });
        // These are the frozen pre-run selection proofs, not later renewals.
        // A newly issued registry/certificate cannot retroactively qualify it.
        trust.verifySelection({ ...selection, observedAt: core.startedAt });
        trust.verifySelection(selection);
        const runtimeRefs = (request.runtimeObjects as Fields[]).map(value => canonicalJson(reference(value.ref))).sort();
        same((core.providerReadbackRefs as unknown[]).map(value => canonicalJson(value)).sort(), runtimeRefs);
        phase = 'journal'; const firstHead = await observe(() => journal.readHead());
        const entries = await observe(() => journal.readEntries(), true) as readonly Fields[];
        const lastHead = await observe(() => journal.readHead()); same(firstHead, lastHead);
        createReceiptCore(core, { head: lastHead, entries });
        for (const entry of entries) {
          if (entry.actorId !== expected.participants.executorId || entry.authorizationDigest !== reference(options.executionAuthorizationRef).sha256
            || entry.fencingGeneration !== generation || !STAGE_EXECUTION_ACTIONS[expected.stage].includes(entry.action as string)
            || Date.parse(entry.trustedTime as string) >= Date.parse(expected.window.endsAt)) throw new Error();
          signatureVerifier.verifySignature({ envelope: execution, expectedPayload: expected, observedAt: entry.trustedTime });
        }
        phase = 'store'; const stored = record(await observe(() => store.readExact(freeze({ context, ref: bundle.receiptStorageRef }))));
        exact(stored, ['object', 'proof']); const object = record(stored.object); exact(object, ['schemaVersion', 'aad', 'envelope', 'retainUntil']);
        if (object.schemaVersion !== CONTROLLED_ARTIFACT_OBJECT_SCHEMA || canonicalJsonSha256(object) !== reference(bundle.receiptStorageRef).sha256
          || object.retainUntil !== historicalStore.retainUntil) throw new Error();
        const aad = validateArtifactAad(object.aad); same(aad, { ...binding, artifactType: 'receipt-core',
          artifactId: reference(bundle.receiptStorageRef).objectId, caseId: null, ordinal: 0, schemaVersion: core.schemaVersion });
        const envelope = validateEncryptedArtifact(object.envelope); if (envelope.aadSha256 !== canonicalJsonSha256(aad)) throw new Error();
        const proof = record(stored.proof); exact(proof, ['assurance', 'productionTamperResistant', 'storeIdentityRef', 'objectRef', 'lockMode', 'retainUntil', 'readerId', 'observedAt']);
        same(proof, { assurance: 'local-reference', productionTamperResistant: false, storeIdentityRef: options.storeIdentityRef,
          objectRef: bundle.receiptStorageRef, lockMode: 'local-reference-immutable', retainUntil: object.retainUntil,
          readerId: context.actorId, observedAt: context.observedAt });
        phase = 'decrypt'; const plaintext = await observe(() => kms.decryptArtifact(freeze({ context, aad, envelope })));
        if (plaintext !== Buffer.from(canonicalJson(core), 'utf8').toString('base64url')) throw new Error();
        phase = 'result-approval';
        const approvalRequest = { context: { executionProfile: 'local-reference' as const, binding,
          actorId: expected.participants.executorId }, envelope: result, expectedPayload: resultPayload };
        // The mode is fixed by the public entry point, not a caller "skip nonce"
        // flag. Both paths use independently derived result payloads and fresh IO.
        const decision = history
          ? await provenance.verifyExistingClaim({ ...approvalRequest, nonceClaimRef: history.nonceClaimRef as ArtifactReference,
            claimedClockReading: history.claimedClockReading as AuthorityClockReading })
          : await approval.verifyAndConsume(approvalRequest);
        if (!existing) outcome = 'reported-consumed'; phase = 'final-validation';
        const current = Date.parse(decision.verifiedAt); const lower = current - decision.uncertaintyMs; const upper = current + decision.uncertaintyMs;
        if (lower < Date.parse(bundle.createdAt as string) || upper >= Date.parse(object.retainUntil as string)) throw new Error();
        // No await from the final time checks through the immutable result.
        for (const observed of [lower, upper]) trust.verifySelection({ ...selection, observedAt: new Date(observed).toISOString() });
        const evidenceObservation = { classification: 'confidential' as const, productionAccepted: false as const,
          stageAcceptanceComplete: false as const, signatureVerified: true as const, machinePassed: structural.machinePassed,
          bundleDigest: structural.bundleDigest, receiptCoreDigest: canonicalJsonSha256(core), journalHeadHash: canonicalJsonSha256(lastHead),
          storeReadbackHash: canonicalJsonSha256(stored), registryProofHash: policy.proofHash, approvalDecisionHash: decision.decisionHash,
          providerPolicyHash: policy.policyHash, verifiedAt: decision.verifiedAt, uncertaintyMs: decision.uncertaintyMs };
        if (existing) {
          const historical = freeze({ ...evidenceObservation, schemaVersion: 'kg-existing-authority-receipt-observation/v1' as const,
            validationLevel: 'local-reference-existing-authority-readback' as const, executionAuthorized: false as const,
            nonceConsumedByThisVerifier: false as const, approvalProvenanceVerified: true as const });
          return freeze({ ...historical, decisionHash: canonicalJsonSha256(historical) });
        }
        const observation = freeze({ ...evidenceObservation, schemaVersion: 'kg-authority-receipt-observation/v1' as const,
          validationLevel: 'local-reference-authority-readback' as const });
        return freeze({ ...observation, decisionHash: canonicalJsonSha256(observation) });
      } catch (error) {
        const failure = error instanceof AuthorityReceiptError ? error : error instanceof AuthorityApprovalError
          ? new AuthorityReceiptError('approval-failed', phase, error.nonceOutcome, error.pendingCompletionUnknown)
          : new AuthorityReceiptError('invalid-evidence', phase, outcome);
        if (failure.pendingCompletionUnknown || failure.code === 'provider-contract-invalid'
          || failure.nonceOutcome === 'unknown' || failure.nonceOutcome === 'reported-consumed') halted = true;
        throw failure;
      } finally { if (active) busy = false; }
  }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    verifyBundle: (input: unknown) => verify(input, false),
    verifyExistingBundle: (input: unknown) => verify(input, true) });
}
