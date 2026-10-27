import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCallWithRejection } from './bounded-provider-call';
import { createReferenceProductionAskArtifactFramer } from './production-ask-artifact-framing';
import { createReferenceShadowArtifactFramer } from './production-shadow-artifact-framing';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import { CONTROLLED_ARTIFACT_INDEX_SCHEMA, CONTROLLED_ARTIFACT_OBJECT_SCHEMA,
  validateControlledArtifactIndex, validateEncryptedArtifact } from './production-controlled-artifacts';
import type { ArtifactOperationContext, ArtifactRunBinding, ControlledArtifactIndex,
  ControlledArtifactIndexEntry } from './production-controlled-artifacts';
import type { ArtifactReference } from './production-gate-manifest';

type Fields = Record<string, unknown>;
type Call = (request: unknown) => unknown;
interface CapturedPort { readonly receiver: object; readonly methods: Readonly<Record<string, Call>> }
const monotonicNow = performance.now.bind(performance);
const apply = Reflect.apply;
const MAX_RETENTION_MS = 3650 * 86400000;
const CODES = ['invalid-config', 'invalid-request', 'busy', 'already-sealed', 'halted', 'capacity-exhausted',
  'invalid-clock', 'invalid-key', 'invalid-readback', 'operation-failed', 'operation-timeout', 'provider-contract-invalid'] as const;
const PHASES = ['configuration', 'preflight', 'clock', 'encrypt', 'seal', 'readback', 'decrypt', 'final-validation'] as const;
type Code = typeof CODES[number];
type Phase = typeof PHASES[number];
const ownedErrors = new WeakSet<object>();

/** Ownership only permits conservative failure merging, never authentication.
 * No provider rejection or plaintext is copied into an outward error. */
export class ProductionAskArtifactWriterError extends Error {
  readonly code: Code;
  readonly phase: Phase;
  readonly pendingCompletionUnknown: boolean;
  readonly mutationMayHaveOccurred: boolean;
  readonly automaticRetryAllowed = false;
  readonly productionAccepted = false;
  constructor(code: Code, phase: Phase, pending = false, mutation = false) {
    const safeCode = CODES.includes(code) ? code : 'operation-failed';
    const safePhase = PHASES.includes(phase) ? phase : 'preflight';
    super('[production Ask artifact writer] ' + safePhase + ': ' + safeCode);
    this.name = 'ProductionAskArtifactWriterError';
    this.code = safeCode; this.phase = safePhase;
    this.pendingCompletionUnknown = pending === true;
    this.mutationMayHaveOccurred = mutation === true;
    ownedErrors.add(this); Object.freeze(this);
  }
}

interface ArtifactConfiguration {
  readonly expectedKeyRef: ArtifactReference;
  readonly storeIdentityRef: ArtifactReference;
  readonly clockIdentityRef: ArtifactReference;
  readonly maxClockUncertaintyMs: number;
  readonly retainUntil: string;
  readonly operationTimeoutMs: number;
}

export interface ReferenceAskArtifactObservation {
  readonly schemaVersion: 'kg-ask-artifact-observation/v1';
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-complete-encrypted-readback';
  readonly productionAccepted: false;
  readonly stageAcceptanceComplete: false;
  readonly bodySourceAuthenticated: false;
  readonly encryptionAuthenticated: false;
  readonly storeAuthenticated: false;
  readonly timeAuthenticated: false;
  readonly encryptedReadbackMatched: true;
  readonly optionsHash: string;
  readonly bindingHash: string;
  readonly requestPlanHash: string;
  readonly layoutHash: string;
  readonly bodyByteLength: number;
  readonly bodySha256: string;
  readonly partCount: number;
  readonly fragmentRootSha256: string;
  readonly artifactIndex: ControlledArtifactIndex;
  readonly indexHash: string;
  readonly exactReadbackRootSha256: string;
  readonly byteProofHash: string;
  readonly completedAt: string;
  readonly uncertaintyMs: number;
  readonly completionClockHash: string;
  readonly observationHash: string;
}

export interface ReferenceShadowArtifactObservation extends Omit<ReferenceAskArtifactObservation, 'schemaVersion' | 'requestPlanHash'> {
  readonly schemaVersion: 'kg-shadow-artifact-observation/v1';
  readonly readbackRequestHash: string;
  readonly observationIndex: number;
}
interface ReferenceArtifactWriter<T> {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  close(): void;
  sealReadback(input: unknown, ...extras: unknown[]): Promise<T>;
}

/** Actual volatile reference KMS/store composition for one complete body per
 * call, not an Ask producer, whole-run receipt, WORM or source authentication.
 * Raw bodies are handed only to the private framer/KMS; outward observations
 * are confidential indexes/hashes. Every dispatch uses a fresh correlated
 * clock and the same absolute deadline. Failure permanently fences this
 * writer: no retry, eviction, rollback, cancellation or restart claim.
 * Reference lifetime bounds match existing 10,000-object/reading profiles. */
export function createReferenceProductionAskArtifactWriter(
  inputOptions: unknown, actualDatasetJson: unknown, inputPorts: unknown, ...extraInputs: unknown[]
) {
  return createArtifactWriter('ask', inputOptions, actualDatasetJson, inputPorts, ...extraInputs);
}
/** Separate existing readback-proof namespace, NOT an Ask body or source
 * attestation. Both factories privately select framing; callers cannot inject
 * a framer or a successful proof into the shared actual crypto/readback path. */
export function createReferenceShadowArtifactWriter(
  inputOptions: unknown, actualDatasetJson: unknown, inputPorts: unknown, ...extraInputs: unknown[]
) {
  return createArtifactWriter('shadow', inputOptions, actualDatasetJson, inputPorts, ...extraInputs);
}
function createArtifactWriter(kind: 'ask', options: unknown, dataset: unknown, ports: unknown, ...extras: unknown[]): ReferenceArtifactWriter<ReferenceAskArtifactObservation>;
function createArtifactWriter(kind: 'shadow', options: unknown, dataset: unknown, ports: unknown, ...extras: unknown[]): ReferenceArtifactWriter<ReferenceShadowArtifactObservation>;
function createArtifactWriter(kind: 'ask' | 'shadow',
  inputOptions: unknown, actualDatasetJson: unknown, inputPorts: unknown, ...extraInputs: unknown[]
): ReferenceArtifactWriter<ReferenceAskArtifactObservation | ReferenceShadowArtifactObservation> {
  let cfg: ArtifactConfiguration;
  let framer: ReturnType<typeof createReferenceProductionAskArtifactFramer> | ReturnType<typeof createReferenceShadowArtifactFramer>;
  let clock: CapturedPort; let kms: CapturedPort; let store: CapturedPort;
  let binding: ArtifactRunBinding; let executorId: string; let readOnlyId: string;
  let authorizationDigest: string; let starts: number; let ends: number; let retention: number; let optionsHash: string;
  let closed = false; let busy = false; let deadline = Infinity; let mutation = false; let phase: Phase = 'preflight';
  const sealedSlots = new Set<string>();
  const challenges = new Set<string>();
  // A pinned key may never reuse a nonce within this writer's lifetime. This
  // detects local contract violations, not restart/other-writer authenticity.
  const encryptedNonces = new Set<string>();
  const previousByActor = new Map<string, AuthorityClockReading>();
  let lastSequence = 0; let lastObservedAt = -Infinity;
  const failure = (code: Code, pending = false) => new ProductionAskArtifactWriterError(code, phase, pending, mutation);
  const mergeOwnedFailure = (reason: unknown): boolean => {
    if (!isOwned(reason)) return false;
    // A readonly dispatch cannot disprove work reported by an inner owned
    // failure. Merge even when the outer observer already reports UNKNOWN.
    mutation = mutation || reason.mutationMayHaveOccurred;
    return reason.pendingCompletionUnknown;
  };
  const assertOpen = () => {
    if (closed) throw failure('halted');
    if (monotonicNow() >= deadline) throw failure('operation-timeout');
  };
  try {
    if (extraInputs.length !== 0) throw new Error();
    const options = record(snapshot(inputOptions));
    exact(options, ['executionProfile', 'askOptions', 'artifacts']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const ask = record(options.askOptions);
    framer = kind === 'ask' ? createReferenceProductionAskArtifactFramer(ask, actualDatasetJson)
      : createReferenceShadowArtifactFramer(ask, actualDatasetJson);
    binding = framer.bindingProof.binding;
    const artifacts = record(options.artifacts);
    exact(artifacts, ['expectedKeyRef', 'storeIdentityRef', 'clockIdentityRef', 'maxClockUncertaintyMs', 'retainUntil', 'operationTimeoutMs']);
    reference(artifacts.expectedKeyRef); reference(artifacts.storeIdentityRef); reference(artifacts.clockIdentityRef);
    integer(artifacts.maxClockUncertaintyMs, 0, 60000); integer(artifacts.operationTimeoutMs, 1, 30000);
    cfg = artifacts as unknown as ArtifactConfiguration;
    const payload = record(ask.expectedExecutionPayload);
    const participants = record(payload.participants);
    executorId = identifier(participants.executorId); readOnlyId = identifier(participants.readOnlyId);
    if (executorId === readOnlyId) throw new Error();
    authorizationDigest = reference(ask.executionAuthorizationRef).sha256;
    const window = record(payload.window);
    starts = Math.max(timestamp(window.startsAt), timestamp(payload.notBefore));
    ends = Math.min(timestamp(window.endsAt), timestamp(payload.expiresAt));
    retention = timestamp(cfg.retainUntil);
    // The store measures retention from actual observedAt, not run start. Only
    // reject impossible windows here; each fresh reading checks the exact bound.
    if (starts >= ends || retention <= starts || retention - ends >= MAX_RETENTION_MS) throw new Error();
    const ports = descriptors(inputPorts, ['clock', 'kms', 'store']); exact(ports, ['clock', 'kms', 'store']);
    clock = capture(ports.clock, ['readTime'], ['advanceTo', 'setAvailability']);
    kms = capture(ports.kms, ['encryptArtifact', 'decryptArtifact'], ['rotateKey', 'revokeKey']);
    store = capture(ports.store, ['sealEncryptedArtifact', 'readExact']);
    optionsHash = canonicalJsonSha256(options);
  } catch { throw new ProductionAskArtifactWriterError('invalid-config', 'configuration'); }

  const invoke = async <T>(currentPhase: Phase, execute: () => unknown, detach: (raw: unknown) => T,
    invalid: Code = 'invalid-readback', mayMutate = false): Promise<{ readonly value: T }> => {
    phase = currentPhase; assertOpen();
    const remaining = Math.min(cfg.operationTimeoutMs, Math.max(1, Math.ceil(deadline - monotonicNow())));
    const observed = await boundedProviderCallWithRejection(() => {
      assertOpen(); if (mayMutate) mutation = true; return execute();
    }, remaining);
    phase = currentPhase;
    if (observed.status === 'timeout' || observed.status === 'invalid-return') {
      const reason = observed.status === 'timeout' && Object.hasOwn(observed, 'reason') ? observed.reason : undefined;
      const innerPending = mergeOwnedFailure(reason);
      throw failure(observed.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid',
        observed.pendingCompletionUnknown || innerPending);
    }
    if (observed.status === 'rejected') {
      if (isOwned(observed.reason)) throw failure(observed.reason.code, mergeOwnedFailure(observed.reason));
      assertOpen(); throw failure('operation-failed');
    }
    assertOpen();
    let value: T;
    try { value = detach(observed.value); } catch { throw failure(invalid); }
    assertOpen(); return Object.freeze({ value });
  };

  const readTime = async (actorId: string) => {
    phase = 'clock'; assertOpen();
    if (challenges.size >= 10000) throw failure('capacity-exhausted');
    let requestNonce = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = randomBytes(16).toString('hex');
      if (!challenges.has(candidate)) { requestNonce = candidate; break; }
    }
    if (!requestNonce) throw failure('invalid-clock');
    const request = freeze({ context: { executionProfile: 'local-reference', binding, actorId }, requestNonce });
    const { value } = await invoke('clock', () => apply(clock.methods.readTime, clock.receiver, [request]), raw => {
      const actual = validateAuthorityClockReading(snapshot(raw), { request, sourceIdentityRef: cfg.clockIdentityRef,
        maxUncertaintyMs: cfg.maxClockUncertaintyMs, previousReading: previousByActor.get(actorId) ?? null });
      const reading = actual.reading; const at = timestamp(reading.observedAt);
      if (reading.sequence <= lastSequence || at < lastObservedAt || at - reading.uncertaintyMs < starts
        || at + reading.uncertaintyMs >= ends || at + reading.uncertaintyMs >= retention
        || retention - at > MAX_RETENTION_MS) throw new Error();
      challenges.add(requestNonce); previousByActor.set(actorId, reading);
      lastSequence = reading.sequence; lastObservedAt = at;
      return freeze({ reading, hash: actual.readingHash });
    }, 'invalid-clock');
    return value;
  };
  const context = (actorId: string, reading: AuthorityClockReading): ArtifactOperationContext =>
    freeze({ executionProfile: 'local-reference', binding, actorId, authorizationDigest, observedAt: reading.observedAt });

  return Object.freeze({
    executionProfile: 'local-reference' as const, productionCapable: false as const,
    close(): void { closed = true; },
    async sealReadback(input: unknown, ...extraRequests: unknown[]): Promise<ReferenceAskArtifactObservation | ReferenceShadowArtifactObservation> {
      if (closed) throw new ProductionAskArtifactWriterError('halted', 'preflight', false, mutation);
      if (busy) throw new ProductionAskArtifactWriterError('busy', 'preflight', false, mutation);
      if (extraRequests.length !== 0) throw new ProductionAskArtifactWriterError('invalid-request', 'preflight');
      const started = monotonicNow();
      let frame: ReturnType<typeof framer.frame>;
      try { frame = framer.frame(input); } catch { throw new ProductionAskArtifactWriterError('invalid-request', 'preflight'); }
      const first = frame.layout.parts[0].aad;
      const slot = canonicalJson([first.artifactType, first.caseId, first.ordinal]);
      if (sealedSlots.has(slot)) throw new ProductionAskArtifactWriterError('already-sealed', 'preflight', false, mutation);
      if (sealedSlots.size >= 10000) throw new ProductionAskArtifactWriterError('capacity-exhausted', 'preflight', false, mutation);
      busy = true; mutation = false; phase = 'preflight'; deadline = started + cfg.operationTimeoutMs;
      const decrypted: { partIndex: number; aad: typeof first; plaintextBase64url: string }[] = [];
      try {
        assertOpen();
        const entries: ControlledArtifactIndexEntry[] = [];
        const readbacks = createHash('sha256').update('kg-ask-encrypted-body-readbacks/v1\0')
          .update(frame.layout.layoutHash).update('\0').update(String(frame.layout.parts.length)).update('\0');
        for (const part of frame.layout.parts) {
          assertOpen();
          const handoff = frame.forEncryption(part.partIndex);
          const beforeEncrypt = await readTime(executorId);
          const { value: envelope } = await invoke('encrypt', () => apply(kms.methods.encryptArtifact, kms.receiver,
            [freeze({ context: context(executorId, beforeEncrypt.reading), ...handoff })]), raw => {
            const value = validateEncryptedArtifact(snapshot(raw));
            if (canonicalJson(value.keyRef) !== canonicalJson(cfg.expectedKeyRef) || value.aadSha256 !== part.aadSha256) throw new Error();
            if (Buffer.from(value.ciphertext, 'base64url').byteLength !== part.byteLength
              || encryptedNonces.has(value.nonce) || encryptedNonces.size >= 10000) throw new Error();
            encryptedNonces.add(value.nonce);
            return value;
          }, 'invalid-key', true);
          const object = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA, aad: part.aad, envelope, retainUntil: cfg.retainUntil });
          const objectJson = canonicalJson(object); const objectDigest = canonicalJsonSha256(object);
          const beforeSeal = await readTime(executorId);
          const { value: objectRef } = await invoke('seal', () => apply(store.methods.sealEncryptedArtifact, store.receiver,
            [freeze({ context: context(executorId, beforeSeal.reading), aad: part.aad, envelope, retainUntil: cfg.retainUntil })]), raw => {
            const value = reference(snapshot(raw));
            if (value.objectId !== part.aad.artifactId || value.sha256 !== objectDigest) throw new Error();
            return value;
          }, 'invalid-readback', true);
          const beforeRead = await readTime(readOnlyId);
          const readContext = context(readOnlyId, beforeRead.reading);
          const { value: readback } = await invoke('readback', () => apply(store.methods.readExact, store.receiver,
            [freeze({ context: readContext, ref: objectRef })]), raw => {
            const value = record(snapshot(raw)); exact(value, ['object', 'proof']);
            if (canonicalJson(value.object) !== objectJson || canonicalJson(value.proof) !== canonicalJson({
              assurance: 'local-reference', productionTamperResistant: false, storeIdentityRef: cfg.storeIdentityRef, objectRef,
              lockMode: 'local-reference-immutable', retainUntil: cfg.retainUntil, readerId: readOnlyId, observedAt: readContext.observedAt,
            })) throw new Error();
            return value;
          });
          readbacks.update(canonicalJsonSha256(readback));
          const beforeDecrypt = await readTime(readOnlyId);
          const { value: plaintext } = await invoke('decrypt', () => apply(kms.methods.decryptArtifact, kms.receiver,
            [freeze({ context: context(readOnlyId, beforeDecrypt.reading), aad: part.aad, envelope })]), raw => {
            if (typeof raw !== 'string' || raw !== handoff.plaintextBase64url) throw new Error();
            return raw;
          });
          decrypted.push({ partIndex: part.partIndex, aad: part.aad, plaintextBase64url: plaintext });
          entries.push({ artifactId: part.aad.artifactId, artifactType: part.aad.artifactType, caseId: part.aad.caseId,
            ordinal: part.aad.ordinal, schemaVersion: part.aad.schemaVersion, objectRef, keyRef: cfg.expectedKeyRef, aadSha256: part.aadSha256 });
        }
        phase = 'final-validation'; assertOpen();
        const byteProof = frame.verifyDecryptedParts(JSON.stringify({
          schemaVersion: kind === 'ask' ? 'kg-ask-decrypted-body-parts/v1' : 'kg-shadow-decrypted-state-parts/v1', layoutHash: frame.layout.layoutHash, parts: decrypted,
        }));
        const index = validateControlledArtifactIndex({ schemaVersion: CONTROLLED_ARTIFACT_INDEX_SCHEMA,
          classification: 'confidential', binding, entries });
        const completion = await readTime(readOnlyId);
        phase = 'final-validation'; assertOpen();
        const shared: Omit<ReferenceAskArtifactObservation, 'schemaVersion' | 'requestPlanHash' | 'observationHash'> = {
          classification: 'confidential',
          validationLevel: 'local-reference-complete-encrypted-readback', productionAccepted: false, stageAcceptanceComplete: false,
          bodySourceAuthenticated: false, encryptionAuthenticated: false, storeAuthenticated: false, timeAuthenticated: false,
          encryptedReadbackMatched: true, optionsHash, bindingHash: frame.layout.bindingHash,
          layoutHash: frame.layout.layoutHash, bodyByteLength: frame.layout.bodyByteLength, bodySha256: frame.layout.bodySha256,
          partCount: entries.length, fragmentRootSha256: frame.layout.fragmentRootSha256, artifactIndex: index.index, indexHash: index.indexHash,
          exactReadbackRootSha256: readbacks.digest('hex'), byteProofHash: byteProof.proofHash,
          completedAt: completion.reading.observedAt, uncertaintyMs: completion.reading.uncertaintyMs, completionClockHash: completion.hash,
        };
        let core: Omit<ReferenceAskArtifactObservation, 'observationHash'> | Omit<ReferenceShadowArtifactObservation, 'observationHash'>;
        if (kind === 'ask') {
          if (!('requestPlanHash' in frame.layout)) throw failure('invalid-readback');
          core = { schemaVersion: 'kg-ask-artifact-observation/v1', ...shared, requestPlanHash: frame.layout.requestPlanHash };
        } else {
          if (!('requestHash' in frame.layout)) throw failure('invalid-readback');
          core = { schemaVersion: 'kg-shadow-artifact-observation/v1', ...shared,
            readbackRequestHash: frame.layout.requestHash, observationIndex: frame.layout.observationIndex };
        }
        const result = freeze({ ...core, observationHash: canonicalJsonSha256(core) });
        assertOpen(); sealedSlots.add(slot); return result;
      } catch (reason) {
        closed = true;
        if (isOwned(reason)) throw failure(reason.code, mergeOwnedFailure(reason));
        throw failure('operation-failed', mergeOwnedFailure(reason));
      } finally { busy = false; decrypted.length = 0; }
    },
  });
}

function isOwned(reason: unknown): reason is ProductionAskArtifactWriterError {
  return reason !== null && typeof reason === 'object' && ownedErrors.has(reason);
}
function capture(input: unknown, methods: readonly string[], optional: readonly string[] = []): CapturedPort {
  const flags = ['executionProfile', 'productionCapable'];
  const value = descriptors(input, [...flags, ...methods, ...optional]);
  const presentOptional = optional.filter(key => Object.hasOwn(value, key));
  exact(value, [...flags, ...methods, ...presentOptional]);
  if (value.executionProfile !== 'local-reference' || value.productionCapable !== false) throw new Error();
  for (const name of [...methods, ...presentOptional]) if (typeof value[name] !== 'function' || types.isProxy(value[name])) throw new Error();
  return Object.freeze({ receiver: input as object, methods: Object.freeze(Object.fromEntries(methods.map(name => [name, value[name] as Call]))) });
}
function descriptors(input: unknown, allowed: readonly string[]): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
  const output: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
    output[key] = descriptor.value;
  }
  return output;
}
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, fields: readonly string[]): void { if (Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))) throw new Error(); }
function identifier(input: unknown): string { if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) throw new Error(); return input; }
function reference(input: unknown): ArtifactReference {
  const value = record(input); exact(value, ['objectId', 'objectVersion', 'sha256']);
  identifier(value.objectId); identifier(value.objectVersion);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error();
  return freeze(value) as unknown as ArtifactReference;
}
function integer(input: unknown, min: number, max: number): void {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error();
}
function timestamp(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new Error(); return Date.parse(input);
}
function freeze<T>(input: T): T { if (input !== null && typeof input === 'object') { for (const child of Object.values(input)) freeze(child); Object.freeze(input); } return input; }

