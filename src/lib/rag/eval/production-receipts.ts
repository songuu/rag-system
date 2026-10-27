import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall } from './bounded-provider-call';
import { validateAuthorizationEnvelope } from './production-authorization';
import type { AuthorizationScope } from './production-authorization';
import { CONTROLLED_ARTIFACT_OBJECT_SCHEMA, validateEncryptedArtifact } from './production-controlled-artifacts';
import type { ArtifactOperationContext, ArtifactObjectProof, ArtifactRunBinding, KmsEnvelopePort,
  TamperResistantArtifactStore } from './production-controlled-artifacts';
import type { ArtifactReference, ProductionGateStage } from './production-gate-manifest';
import { validateJournalChain } from './production-run-journal';

export const RECEIPT_CORE_SCHEMAS = Object.freeze({ T16: 'kg-t16-shadow-receipt-core/v1',
  T17: 'kg-t17-canary-receipt-core/v1', R18: 'kg-retention-receipt-core/v1' } as const);
export const ACCEPTANCE_BUNDLE_SCHEMA = 'kg-stage-acceptance-bundle/v1' as const;
export const RECEIPT_READBACK_PROOF_SCHEMA = 'kg-receipt-readback-proof/v1' as const;

export interface ReceiptCore {
  readonly schemaVersion: typeof RECEIPT_CORE_SCHEMAS[ProductionGateStage];
  readonly classification: 'confidential';
  readonly stage: ProductionGateStage;
  readonly scope: AuthorizationScope;
  readonly runNonce: string;
  readonly manifestHash: string;
  readonly executionAuthorizationRef: ArtifactReference;
  readonly recoveryAuthorizationRefs: readonly ArtifactReference[];
  readonly predecessorAcceptanceRef: ArtifactReference | null;
  readonly identities: {
    readonly datasetHash: string; readonly rosterHash: string; readonly sharedConfigHash: string;
    readonly artifactsHash: string; readonly indexIdentityRef: ArtifactReference;
    readonly registryRef: ArtifactReference; readonly providersHash: string; readonly thresholdsHash: string;
    readonly armConfigHashes: Readonly<Record<string, string>> | null;
  };
  readonly reportRef: ArtifactReference;
  readonly artifactIndexRef: ArtifactReference;
  readonly providerReadbackRefs: readonly ArtifactReference[];
  readonly journal: { readonly headRef: ArtifactReference; readonly rootDigest: string;
    readonly entryCount: number; readonly fencingGeneration: number; readonly terminal: true };
  readonly stageEvidence: Readonly<Record<string, ArtifactReference | string | number>>;
  readonly executionIdentityId: string;
  readonly terminalActorId: string;
  readonly terminalAuthorizationDigest: string;
  readonly machineVerdict: 'passed' | 'failed' | 'aborted';
  readonly finalStateHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sealedAt: string;
}
export interface ReceiptCoreView {
  readonly validationLevel: 'structural-only'; readonly productionAccepted: false;
  readonly coreDigest: string; readonly core: ReceiptCore;
}
export interface ReceiptReadbackProof {
  readonly schemaVersion: typeof RECEIPT_READBACK_PROOF_SCHEMA;
  readonly assurance: 'enterprise' | 'local-reference';
  readonly productionTamperResistant: boolean;
  readonly receiptCoreRef: ArtifactReference;
  readonly storageObjectRef: ArtifactReference;
  readonly storeProof: ArtifactObjectProof;
  readonly observedAt: string;
}
export interface ReferenceReceiptSeal {
  readonly validationLevel: 'local-reference-readback'; readonly productionAccepted: false;
  readonly core: ReceiptCore; readonly receiptCoreRef: ArtifactReference;
  readonly storageObjectRef: ArtifactReference; readonly readbackProof: ReceiptReadbackProof;
}
export interface StageAcceptanceBundle {
  readonly schemaVersion: typeof ACCEPTANCE_BUNDLE_SCHEMA;
  readonly classification: 'confidential'; readonly stage: ProductionGateStage;
  readonly scope: AuthorizationScope; readonly runNonce: string; readonly manifestHash: string;
  readonly receiptCoreRef: ArtifactReference; readonly receiptStorageRef: ArtifactReference;
  readonly resultAttestationRef: ArtifactReference; readonly readbackProofRef: ArtifactReference;
  readonly createdAt: string;
}

export type ReceiptSealOperation = 'encrypt' | 'store-seal' | 'store-read' | 'decrypt';
export type ReceiptSealFailureCode = 'operation-timeout' | 'provider-contract-invalid'
  | 'provider-operation-failed' | 'provider-payload-invalid';

/** A failed local seal is not permission to retry a potentially committed write.
 * Fixed diagnostics deliberately omit provider exceptions and artifact data. */
export class ReferenceReceiptSealError extends Error {
  readonly code: ReceiptSealFailureCode;
  readonly operation: ReceiptSealOperation;
  readonly pendingCompletionUnknown: boolean;
  readonly mutationMayHaveOccurred: boolean;
  readonly automaticRetryAllowed = false as const;

  constructor(code: ReceiptSealFailureCode, operation: ReceiptSealOperation,
    pendingCompletionUnknown: boolean, mutationMayHaveOccurred: boolean) {
    const detail = code === 'provider-payload-invalid' && operation === 'decrypt' ? ': plaintext readback invalid' : '';
    super(`[production receipt] seal.${operation}: ${code}${detail}`);
    this.name = 'ReferenceReceiptSealError'; this.code = code; this.operation = operation;
    this.pendingCompletionUnknown = pendingCompletionUnknown;
    this.mutationMayHaveOccurred = mutationMayHaveOccurred; Object.freeze(this);
  }
}
type Fields = Record<string, unknown>;
const CORE_FIELDS = ['schemaVersion', 'classification', 'stage', 'scope', 'runNonce', 'manifestHash',
  'executionAuthorizationRef', 'recoveryAuthorizationRefs', 'predecessorAcceptanceRef', 'identities',
  'reportRef', 'artifactIndexRef', 'providerReadbackRefs', 'journal', 'stageEvidence', 'executionIdentityId',
  'terminalActorId', 'terminalAuthorizationDigest', 'machineVerdict', 'finalStateHash', 'startedAt', 'completedAt', 'sealedAt'];
const BUNDLE_FIELDS = ['schemaVersion', 'classification', 'stage', 'scope', 'runNonce', 'manifestHash',
  'receiptCoreRef', 'receiptStorageRef', 'resultAttestationRef', 'readbackProofRef', 'createdAt'];
const T16_EVIDENCE = ['gateReportRef', 'sideEffectReportRef', 'offArmReadbackRef', 'shadowArmReadbackRef'];
const T17_REFS = ['preTrafficGateReportRef', 'rampReportRef', 'faultReportRef', 'recoveryReportRef', 'finalReadbackRef', 'finalPublicationIdentityRef'];

/** Schema/hash consistency only. No caller-provided verdict/ref becomes authority. */
export function validateReceiptCore(input: unknown): ReceiptCoreView {
  const core = snapshot(input); exact(core, CORE_FIELDS, 'core');
  const stage = select(core.stage, ['T16', 'T17', 'R18'], 'core.stage') as ProductionGateStage;
  if (core.schemaVersion !== RECEIPT_CORE_SCHEMAS[stage] || core.classification !== 'confidential') fail('core', 'versioned confidential stage core required');
  validateScope(core.scope); hex(core.runNonce, 32, 'core.runNonce'); hex(core.manifestHash, 64, 'core.manifestHash');
  const execution = reference(core.executionAuthorizationRef, 'core.executionAuthorizationRef');
  const recovery = refs(core.recoveryAuthorizationRefs, 0, 16, 'core.recoveryAuthorizationRefs');
  if (stage !== 'T17' && recovery.length !== 0) fail('core.recoveryAuthorizationRefs', 'recovery is canary-only');
  if (stage === 'T16' ? core.predecessorAcceptanceRef !== null : core.predecessorAcceptanceRef === null) fail('core.predecessorAcceptanceRef', 'stage predecessor relation missing or unexpected');
  if (core.predecessorAcceptanceRef !== null) reference(core.predecessorAcceptanceRef, 'core.predecessorAcceptanceRef');
  const identities = record(core.identities, 'core.identities');
  exact(identities, ['datasetHash', 'rosterHash', 'sharedConfigHash', 'artifactsHash', 'indexIdentityRef',
    'registryRef', 'providersHash', 'thresholdsHash', 'armConfigHashes'], 'core.identities');
  for (const field of ['datasetHash', 'rosterHash', 'sharedConfigHash', 'artifactsHash', 'providersHash', 'thresholdsHash']) hex(identities[field], 64, `core.identities.${field}`);
  for (const field of ['indexIdentityRef', 'registryRef']) reference(identities[field], `core.identities.${field}`);
  if (stage === 'R18') { if (identities.armConfigHashes !== null) fail('core.identities.armConfigHashes', 'retention has no serving arms'); }
  else {
    const arms = record(identities.armConfigHashes, 'core.identities.armConfigHashes');
    const candidate = stage === 'T16' ? 'shadow' : 'active'; exact(arms, ['off', candidate], 'core.identities.armConfigHashes');
    hex(arms.off, 64, 'core.identities.armConfigHashes.off'); hex(arms[candidate], 64, 'core.identities.armConfigHashes.candidate');
    if (arms.off === arms[candidate]) fail('core.identities.armConfigHashes', 'arms must bind different modes');
  }
  reference(core.reportRef, 'core.reportRef'); reference(core.artifactIndexRef, 'core.artifactIndexRef');
  refs(core.providerReadbackRefs, 1, 14, 'core.providerReadbackRefs');
  const head = record(core.journal, 'core.journal'); exact(head, ['headRef', 'rootDigest', 'entryCount', 'fencingGeneration', 'terminal'], 'core.journal');
  reference(head.headRef, 'core.journal.headRef'); hex(head.rootDigest, 64, 'core.journal.rootDigest');
  integer(head.entryCount, 1, 10000, 'core.journal.entryCount'); integer(head.fencingGeneration, 1, Number.MAX_SAFE_INTEGER, 'core.journal.fencingGeneration');
  if (head.terminal !== true || head.rootDigest === '0'.repeat(64)) fail('core.journal', 'nonempty terminal journal required');
  const evidence = record(core.stageEvidence, 'core.stageEvidence');
  if (stage === 'T16') { exact(evidence, T16_EVIDENCE, 'core.stageEvidence'); T16_EVIDENCE.forEach(field => reference(evidence[field], `core.stageEvidence.${field}`)); }
  else if (stage === 'T17') {
    exact(evidence, [...T17_REFS, 'terminalMode', 'terminalTrafficWeightBps'], 'core.stageEvidence');
    T17_REFS.forEach(field => reference(evidence[field], `core.stageEvidence.${field}`));
    if (evidence.terminalMode !== 'off' || evidence.terminalTrafficWeightBps !== 0) fail('core.stageEvidence', 'canary terminal must be off and zero traffic');
  } else {
    exact(evidence, ['retentionPolicyHash', 'oldStoreManifestHash', 'elapsedEvidenceRef', 'retentionReportRef'], 'core.stageEvidence');
    hex(evidence.retentionPolicyHash, 64, 'core.stageEvidence.retentionPolicyHash'); hex(evidence.oldStoreManifestHash, 64, 'core.stageEvidence.oldStoreManifestHash');
    reference(evidence.elapsedEvidenceRef, 'core.stageEvidence.elapsedEvidenceRef'); reference(evidence.retentionReportRef, 'core.stageEvidence.retentionReportRef');
  }
  validateCoreReferenceRoles(core);
  identifier(core.executionIdentityId, 'core.executionIdentityId'); identifier(core.terminalActorId, 'core.terminalActorId');
  hex(core.terminalAuthorizationDigest, 64, 'core.terminalAuthorizationDigest');
  if (core.terminalAuthorizationDigest === execution.sha256) {
    if (core.terminalActorId !== core.executionIdentityId) fail('core.terminalActorId', 'execution terminal actor mismatch');
  } else if (!recovery.some(ref => ref.sha256 === core.terminalAuthorizationDigest)) fail('core.terminalAuthorizationDigest', 'terminal authority is not referenced');
  select(core.machineVerdict, ['passed', 'failed', 'aborted'], 'core.machineVerdict'); hex(core.finalStateHash, 64, 'core.finalStateHash');
  const start = timestamp(core.startedAt, 'core.startedAt'); const completed = timestamp(core.completedAt, 'core.completedAt'); const sealed = timestamp(core.sealedAt, 'core.sealedAt');
  if (completed < start || sealed < completed || sealed - start > 86400000) fail('core.time', 'core time order/run limit invalid');
  return freeze({ validationLevel: 'structural-only', productionAccepted: false,
    coreDigest: canonicalJsonSha256(core), core: core as unknown as ReceiptCore });
}

/** Build only after validating the complete chain against a detached head. The
 * head's authenticity still requires an independent enterprise journal port. */
export function createReceiptCore(input: unknown, journalReadback: unknown): ReceiptCoreView {
  const view = validateReceiptCore(input); const { core } = view;
  // A journal can be 16 MiB; do not truncate it to the 256 KiB JSON-object profile.
  const data = journalFields(journalReadback); const head = snapshot(data.head);
  const binding = { ...core.scope, scopeHash: canonicalJsonSha256(core.scope), runNonce: core.runNonce, manifestHash: core.manifestHash };
  const chain = validateJournalChain(data.entries, binding, head);
  if (!chain.terminal || chain.entryCount !== core.journal.entryCount || chain.rootDigest !== core.journal.rootDigest
    || head.fencingGeneration !== core.journal.fencingGeneration || canonicalJsonSha256(head) !== core.journal.headRef.sha256) fail('core.journal', 'exact terminal head differs from receipt');
  const entries = data.entries as unknown[];
  const first = snapshot(Object.getOwnPropertyDescriptor(entries, '0')?.value);
  const terminal = snapshot(Object.getOwnPropertyDescriptor(entries, String(entries.length - 1))?.value);
  if (timestamp(first.trustedTime, 'journal.first.trustedTime') < Date.parse(core.startedAt)
    || terminal.kind !== 'terminal' || terminal.afterDigest !== core.finalStateHash || terminal.outcome !== core.machineVerdict
    || terminal.trustedTime !== core.completedAt || terminal.actorId !== core.terminalActorId
    || terminal.authorizationDigest !== core.terminalAuthorizationDigest) fail('core.journal', 'terminal state/outcome/time/actor/authority differs from receipt');
  return view;
}

/** Only trusted, local-reference executable dependencies are accepted here;
 * never deserialize port functions from a manifest or treat this as approval. */
export async function sealReferenceReceiptCore(input: unknown, kms: KmsEnvelopePort,
  store: TamperResistantArtifactStore, operationTimeoutMs = 30000): Promise<ReferenceReceiptSeal> {
  integer(operationTimeoutMs, 1, 60000, 'seal.operationTimeoutMs');
  const kmsCapability = referencePort(kms, ['encryptArtifact', 'decryptArtifact'], 'kms');
  const storeCapability = referencePort(store, ['sealEncryptedArtifact', 'readExact'], 'store');
  const raw = plainDataFields(input, ['executionProfile', 'core', 'journalReadback', 'executorContext', 'readerContext',
    'artifactId', 'retainUntil', 'expectedStoreIdentityRef'], 'seal');
  const request = freeze(snapshot(Object.fromEntries(Object.entries(raw).filter(([field]) => field !== 'journalReadback'))));
  if (request.executionProfile !== 'local-reference') fail('seal.executionProfile', 'reference workflow cannot serve enterprise');
  const { core, coreDigest } = createReceiptCore(request.core, raw.journalReadback);
  const executor = operationContext(request.executorContext, core); const reader = operationContext(request.readerContext, core);
  if (executor.actorId !== core.executionIdentityId || reader.actorId === executor.actorId) fail('seal.context', 'independent executor/read-only role required');
  if (Date.parse(executor.observedAt) < Date.parse(core.sealedAt) || Date.parse(reader.observedAt) < Date.parse(executor.observedAt)) fail('seal.context', 'seal/readback time order invalid');
  identifier(request.artifactId, 'seal.artifactId'); const artifactId = request.artifactId as string;
  if (collectRefs(core).some(ref => ref.objectId === artifactId)) fail('seal.artifactId', 'core cannot reference its own sealed object');
  const retainUntil = timestamp(request.retainUntil, 'seal.retainUntil');
  if (retainUntil <= Date.parse(reader.observedAt)) fail('seal.retainUntil', 'retention expires before readback');
  const expectedStore = reference(request.expectedStoreIdentityRef, 'seal.expectedStoreIdentityRef');
  const binding: ArtifactRunBinding = freeze({ ...core.scope, runNonce: core.runNonce, manifestHash: core.manifestHash });
  const aad = freeze({ ...binding, artifactType: 'receipt-core' as const, artifactId, caseId: null, ordinal: 0, schemaVersion: core.schemaVersion });
  // Pin expectations before invoking callbacks: rebasing after await would let
  // an adapter redefine the authenticated object or prechecked reader time.
  const expectedAadDigest = canonicalJsonSha256(aad);
  const plaintext = Buffer.from(canonicalJson(core)).toString('base64url');
  const operationState = { mutationDispatched: false };
  const invokeProvider = <T>(operation: ReceiptSealOperation, execute: () => Promise<unknown>,
    detach: (value: unknown) => T): Promise<T> => providerOperation(operation, execute, operationTimeoutMs, operationState, detach);
  const envelope = await invokeProvider('encrypt', () => kmsCapability.encryptArtifact(freeze({ context: executor, aad, plaintextBase64url: plaintext })),
    value => {
      const envelope = freeze(validateEncryptedArtifact(value));
      if (envelope.aadSha256 !== expectedAadDigest) fail('seal.envelope', 'KMS returned another AAD');
      return envelope;
    });
  const object = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA, aad, envelope, retainUntil: request.retainUntil as string });
  const expectedObjectDigest = canonicalJsonSha256(object); const expectedObjectJson = canonicalJson(object);
  const storageObjectRef = await invokeProvider('store-seal', () => storeCapability.sealEncryptedArtifact(freeze({ context: executor, aad, envelope, retainUntil: object.retainUntil })),
    value => {
      const ref = freeze(reference(snapshot(value), 'seal.storageRef'));
      if (ref.objectId !== artifactId || ref.sha256 !== expectedObjectDigest) fail('seal.storageRef', 'store seal object identity/digest mismatch');
      return ref;
    });
  const readback = await invokeProvider('store-read', () => storeCapability.readExact(freeze({ context: reader, ref: storageObjectRef })),
    value => {
      const readback = freeze(snapshot(value)); exact(readback, ['object', 'proof'], 'seal.readback');
      if (canonicalJson(readback.object) !== expectedObjectJson) fail('seal.readback', 'stored object readback differs');
      const proof = storeProofFields(readback.proof);
      if (proof.assurance !== 'local-reference' || proof.productionTamperResistant !== false
        || proof.lockMode !== 'local-reference-immutable' || !same(proof.storeIdentityRef, expectedStore)
        || !same(proof.objectRef, storageObjectRef) || proof.retainUntil !== object.retainUntil
        || proof.readerId !== reader.actorId || proof.observedAt !== reader.observedAt) fail('seal.readback.proof', 'independent exact local store proof differs');
      return readback;
    });
  const storeProof = readback.proof as Fields;
  await invokeProvider('decrypt', () => kmsCapability.decryptArtifact(freeze({ context: reader, aad, envelope })), value => {
    if (typeof value !== 'string') fail('seal.decrypt', 'primitive plaintext required');
    if (value !== plaintext) fail('seal.readback', 'plaintext readback differs from immutable core'); return value;
  });
  const receiptCoreRef = freeze({ objectId: storageObjectRef.objectId, objectVersion: storageObjectRef.objectVersion, sha256: coreDigest });
  const readbackProof: ReceiptReadbackProof = { schemaVersion: RECEIPT_READBACK_PROOF_SCHEMA,
    assurance: 'local-reference', productionTamperResistant: false, receiptCoreRef, storageObjectRef,
    storeProof: storeProof as unknown as ArtifactObjectProof, observedAt: reader.observedAt };
  return freeze({ validationLevel: 'local-reference-readback', productionAccepted: false, core,
    receiptCoreRef, storageObjectRef, readbackProof });
}

/** Strict forward-reference/schema consistency, NOT signature/trust acceptance.
 * An unsigned syntactically valid envelope intentionally remains nonproduction. */
export function validateAcceptanceBundle(input: unknown, evidenceInput: unknown): {
  readonly validationLevel: 'structural-only'; readonly productionAccepted: false;
  readonly machinePassed: boolean; readonly bundleDigest: string; readonly bundle: StageAcceptanceBundle;
} {
  const bundle = snapshot(input); exact(bundle, BUNDLE_FIELDS, 'bundle');
  const evidence = snapshot(evidenceInput); exact(evidence, ['core', 'executionEnvelope', 'resultEnvelope', 'readbackProof'], 'bundle.evidence');
  const { core, coreDigest } = validateReceiptCore(evidence.core);
  if (bundle.schemaVersion !== ACCEPTANCE_BUNDLE_SCHEMA || bundle.classification !== 'confidential') fail('bundle', 'versioned confidential bundle required');
  matchRun(bundle, core, 'bundle'); const created = timestamp(bundle.createdAt, 'bundle.createdAt');
  const coreRef = reference(bundle.receiptCoreRef, 'bundle.receiptCoreRef'); const storageRef = reference(bundle.receiptStorageRef, 'bundle.receiptStorageRef');
  const resultRef = reference(bundle.resultAttestationRef, 'bundle.resultAttestationRef'); const proofRef = reference(bundle.readbackProofRef, 'bundle.readbackProofRef');
  if (coreRef.sha256 !== coreDigest || coreRef.objectId !== storageRef.objectId || coreRef.objectVersion !== storageRef.objectVersion) fail('bundle.receiptCoreRef', 'logical core/storage object identity mismatch');
  const identity = (ref: ArtifactReference) => canonicalJson([ref.objectId, ref.objectVersion]);
  if (new Set([coreRef, resultRef, proofRef, core.executionAuthorizationRef].map(identity)).size !== 4
    || collectRefs(core).some(ref => identity(ref) === identity(coreRef) || identity(ref) === identity(resultRef) || identity(ref) === identity(proofRef))) fail('bundle', 'backward/self/object-role reference alias forbidden');
  const proof = readbackProofFields(evidence.readbackProof);
  if (!same(proof.receiptCoreRef, coreRef) || !same(proof.storageObjectRef, storageRef)
    || canonicalJsonSha256(proof) !== proofRef.sha256) fail('bundle.readbackProofRef', 'exact proof/core/storage reference mismatch');
  const storeProof = storeProofFields(proof.storeProof);
  if (!same(storeProof.objectRef, storageRef) || storeProof.observedAt !== proof.observedAt
    || timestamp(proof.observedAt, 'bundle.readback.observedAt') < Date.parse(core.sealedAt)
    || timestamp(storeProof.retainUntil, 'bundle.readback.retainUntil') <= created) fail('bundle.readback', 'store readback identity/time/retention mismatch');
  const execution = validateAuthorizationEnvelope(evidence.executionEnvelope);
  const result = validateAuthorizationEnvelope(evidence.resultEnvelope);
  if (execution.envelope.kind !== 'execution' || result.envelope.kind !== 'result') fail('bundle.envelopes', 'pre-run and post-run envelopes cannot be interchanged');
  if (execution.envelopeDigest !== core.executionAuthorizationRef.sha256 || result.envelopeDigest !== resultRef.sha256) fail('bundle.envelopes', 'exact authorization/result object digest mismatch');
  const pre = execution.envelope.payload; const post = result.envelope.payload;
  matchRun(pre as unknown as Fields, core, 'bundle.execution'); matchRun(post as unknown as Fields, core, 'bundle.result');
  if (!same(pre.registryRef, core.identities.registryRef) || pre.providersHash !== core.identities.providersHash
    || pre.thresholdsHash !== core.identities.thresholdsHash || pre.participants.executorId !== core.executionIdentityId
    || canonicalJson(pre.participants) !== canonicalJson(post.participants)
    || storeProof.readerId !== pre.participants.readOnlyId) fail('bundle.execution', 'frozen providers/thresholds/duties differ from core/readback');
  // References are forensic data, not recovery authority or an extension of
  // execution. Fail closed until the manifest/policy/envelope/fence composer
  // exists; do not silently accept a partially checked rescue bundle.
  if (core.recoveryAuthorizationRefs.length !== 0) fail('bundle.recovery', 'complete frozen-policy recovery validation is required and not supported by this structural helper');
  if (Date.parse(core.startedAt) < Date.parse(pre.notBefore) || Date.parse(core.startedAt) < Date.parse(pre.window.startsAt)
    || Date.parse(core.startedAt) >= Date.parse(pre.window.endsAt)
    || Date.parse(core.completedAt) >= Date.parse(pre.expiresAt)
    || Date.parse(core.completedAt) > Date.parse(pre.window.endsAt)) fail('bundle.execution', 'run not inside execution window');
  if (!same(post.executionAuthorizationRef, core.executionAuthorizationRef) || !same(post.receiptCoreRef, coreRef)
    || post.reportHash !== core.reportRef.sha256 || post.artifactIndexHash !== core.artifactIndexRef.sha256
    || post.machineVerdict !== core.machineVerdict || post.executionIdentityId !== core.executionIdentityId
    || post.finalStateHash !== core.finalStateHash || post.completedAt !== core.completedAt) fail('bundle.result', 'post-run claims differ from exact core');
  if (Date.parse(post.issuedAt) < timestamp(proof.observedAt, 'bundle.readback.observedAt') || created < Date.parse(post.issuedAt)
    || created < Date.parse(post.notBefore) || created >= Date.parse(post.expiresAt)) fail('bundle.result', 'result signature/bundle must follow independent readback within result validity');
  return freeze({ validationLevel: 'structural-only', productionAccepted: false,
    machinePassed: core.machineVerdict === 'passed', bundleDigest: canonicalJsonSha256(bundle), bundle: bundle as unknown as StageAcceptanceBundle });
}

function storeProofFields(input: unknown): Fields {
  const proof = record(input, 'storeProof'); exact(proof, ['assurance', 'productionTamperResistant', 'storeIdentityRef',
    'objectRef', 'lockMode', 'retainUntil', 'readerId', 'observedAt'], 'storeProof');
  const assurance = select(proof.assurance, ['local-reference', 'enterprise'], 'storeProof.assurance');
  if (proof.productionTamperResistant !== (assurance === 'enterprise')
    || proof.lockMode !== (assurance === 'enterprise' ? 'compliance-worm' : 'local-reference-immutable')) fail('storeProof', 'assurance/lock profile inconsistent');
  reference(proof.storeIdentityRef, 'storeProof.storeIdentityRef'); reference(proof.objectRef, 'storeProof.objectRef');
  timestamp(proof.retainUntil, 'storeProof.retainUntil'); timestamp(proof.observedAt, 'storeProof.observedAt'); identifier(proof.readerId, 'storeProof.readerId'); return proof;
}
async function providerOperation<T>(operation: ReceiptSealOperation, execute: () => Promise<unknown>,
  timeoutMs: number, state: { mutationDispatched: boolean }, detach: (value: unknown) => T): Promise<T> {
  const observed = await boundedProviderCall(() => {
    if (operation === 'encrypt' || operation === 'store-seal') state.mutationDispatched = true;
    return execute();
  }, timeoutMs);
  if (observed.status !== 'fulfilled') {
    const code = observed.status === 'timeout' ? 'operation-timeout'
      : observed.status === 'invalid-return' ? 'provider-contract-invalid' : 'provider-operation-failed';
    throw new ReferenceReceiptSealError(code, operation,
      observed.status !== 'rejected' && observed.pendingCompletionUnknown, state.mutationDispatched);
  }
  // Returning the raw fulfilled value from an async function would adopt its
  // then property again, before the caller can inspect descriptors or schema.
  try { return detach(observed.value); }
  catch { throw new ReferenceReceiptSealError('provider-payload-invalid', operation, false, state.mutationDispatched); }
}
function readbackProofFields(input: unknown): Fields {
  const proof = record(input, 'readbackProof'); exact(proof, ['schemaVersion', 'assurance', 'productionTamperResistant',
    'receiptCoreRef', 'storageObjectRef', 'storeProof', 'observedAt'], 'readbackProof');
  if (proof.schemaVersion !== RECEIPT_READBACK_PROOF_SCHEMA) fail('readbackProof', 'unsupported readback schema');
  reference(proof.receiptCoreRef, 'readbackProof.receiptCoreRef'); reference(proof.storageObjectRef, 'readbackProof.storageObjectRef');
  const store = storeProofFields(proof.storeProof); timestamp(proof.observedAt, 'readbackProof.observedAt');
  if (proof.assurance !== store.assurance || proof.productionTamperResistant !== store.productionTamperResistant) fail('readbackProof', 'store/readback assurance mismatch'); return proof;
}
function operationContext(input: unknown, core: ReceiptCore): ArtifactOperationContext {
  const context = record(input, 'seal.context'); exact(context, ['executionProfile', 'binding', 'actorId', 'authorizationDigest', 'observedAt'], 'seal.context');
  if (context.executionProfile !== 'local-reference') fail('seal.context', 'reference operation profile required');
  const binding = record(context.binding, 'seal.context.binding'); exact(binding, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash'], 'seal.context.binding');
  if (!same(binding, { ...core.scope, runNonce: core.runNonce, manifestHash: core.manifestHash })) fail('seal.context.binding', 'scope/run/manifest mismatch');
  identifier(context.actorId, 'seal.context.actorId'); hex(context.authorizationDigest, 64, 'seal.context.authorizationDigest'); timestamp(context.observedAt, 'seal.context.observedAt');
  if (context.authorizationDigest !== core.executionAuthorizationRef.sha256) fail('seal.context.authorizationDigest', 'local operation authority differs from core');
  return context as unknown as ArtifactOperationContext;
}
function referencePort<T extends object, K extends keyof T & string>(input: T, methods: readonly K[], path: string): Pick<T, K> {
  if (input === null || typeof input !== 'object' || types.isProxy(input)) fail(path, 'trusted local reference dependency required');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = (name: string) => { const descriptor = descriptors[name]; if (!descriptor || !('value' in descriptor)) fail(path, 'accessor/missing dependency member forbidden'); return descriptor.value; };
  if (value('executionProfile') !== 'local-reference' || value('productionCapable') !== false
    || methods.some(name => typeof value(name) !== 'function' || types.isProxy(value(name)))) fail(path, 'enterprise/fake/proxy capability or required operation mismatch');
  // Resolve once, before the first callback. A later property replacement must
  // not change the decrypt/readback capability that was checked at entry.
  // Do not call method.bind or the built-in bind algorithm: a function may have
  // bind/length/name accessors. Reflect.apply reads no such function metadata.
  return Object.freeze(Object.fromEntries(methods.map(name => {
    const method = value(name);
    return [name, (...args: unknown[]) => Reflect.apply(method, input, args)];
  }))) as Pick<T, K>;
}
function journalFields(input: unknown): Fields {
  return plainDataFields(input, ['head', 'entries'], 'journalReadback');
}
function plainDataFields(input: unknown, fields: readonly string[], path: string): Fields {
  if (input === null || typeof input !== 'object' || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(path, 'plain data object required');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== fields.length || fields.some(field => !descriptors[field]
    || !('value' in descriptors[field]) || !descriptors[field].enumerable)) fail(path, 'required data fields absent');
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}
function collectRefs(input: unknown): ArtifactReference[] {
  if (input === null || typeof input !== 'object') return [];
  const value = input as Fields;
  if (Object.hasOwn(value, 'objectId') && Object.hasOwn(value, 'objectVersion') && Object.hasOwn(value, 'sha256')) return [value as unknown as ArtifactReference];
  return Object.values(value).flatMap(collectRefs);
}
function validateCoreReferenceRoles(core: Fields): void {
  const roles: { path: string; ref: ArtifactReference }[] = [];
  const visit = (input: unknown, path: string): void => {
    if (input === null || typeof input !== 'object') return;
    const value = input as Fields;
    if (Object.hasOwn(value, 'objectId') && Object.hasOwn(value, 'objectVersion') && Object.hasOwn(value, 'sha256')) {
      roles.push({ path, ref: value as unknown as ArtifactReference }); return;
    }
    Object.entries(value).forEach(([field, child]) => visit(child, `${path}.${field}`));
  };
  visit(core, 'core');
  for (let index = 0; index < roles.length; index += 1) {
    const current = roles[index];
    for (const prior of roles.slice(0, index)) {
      if (current.ref.objectId !== prior.ref.objectId || current.ref.objectVersion !== prior.ref.objectVersion) continue;
      // Both fields name a PublicationIdentity; the terminal readback can
      // legitimately equal the frozen index identity, but not change its hash.
      const publicationPair = new Set([current.path, prior.path]);
      if (publicationPair.has('core.identities.indexIdentityRef')
        && publicationPair.has('core.stageEvidence.finalPublicationIdentityRef') && same(current.ref, prior.ref)) continue;
      fail('core.references', 'incompatible object-role alias forbidden');
    }
  }
}
function matchRun(input: Fields, core: ReceiptCore, path: string): void {
  if (input.stage !== core.stage || !same(input.scope, core.scope) || input.runNonce !== core.runNonce || input.manifestHash !== core.manifestHash) fail(path, 'cross-stage/run/scope/manifest mismatch');
}
function validateScope(input: unknown): void {
  const scope = record(input, 'scope'); exact(scope, ['environment', 'tenantId', 'corpusId'], 'scope');
  ['environment', 'tenantId', 'corpusId'].forEach(field => identifier(scope[field], `scope.${field}`));
}
function refs(input: unknown, min: number, max: number, path: string): ArtifactReference[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) fail(path, 'reference count outside bounds');
  const result = input.map((value, ordinal) => reference(value, `${path}[${ordinal}]`));
  if (new Set(result.map(ref => canonicalJson([ref.objectId, ref.objectVersion]))).size !== result.length) fail(path, 'duplicate or ambiguous object version'); return result;
}
function reference(input: unknown, path: string): ArtifactReference {
  const ref = record(input, path); exact(ref, ['objectId', 'objectVersion', 'sha256'], path);
  identifier(ref.objectId, `${path}.objectId`); identifier(ref.objectVersion, `${path}.objectVersion`); hex(ref.sha256, 64, `${path}.sha256`); return ref as unknown as ArtifactReference;
}
function snapshot(input: unknown): Fields {
  let encoded: string; try { encoded = canonicalJson(input); } catch { fail('input', 'invalid bounded canonical data'); }
  return record(JSON.parse(encoded), 'input');
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'required object absent'); return input as Fields;
}
function exact(input: Fields, fields: readonly string[], path: string): void {
  if (fields.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !fields.includes(field))) fail(path, 'required fields missing or unsupported fields present');
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'bounded opaque identifier required');
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'exact lowercase hexadecimal required');
}
function integer(input: unknown, min: number, max: number, path: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) fail(path, 'integer outside profile bounds'); return input;
}
function select(input: unknown, values: readonly string[], path: string): string {
  if (typeof input !== 'string' || !values.includes(input)) fail(path, 'outside closed set'); return input;
}
function timestamp(input: unknown, path: string): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(path, 'canonical UTC timestamp required'); return Date.parse(input);
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input); } return input;
}
function fail(path: string, reason: string): never { throw new Error(`[production receipt] ${path}: ${reason}`); }
