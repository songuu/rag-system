import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCallWithRejection } from './bounded-provider-call';
import { createReferencePublicationReadback, PublicationIdentityError } from '../../knowledge-graph/publication-identity';
import type { PublicationReadbackDecision } from '../../knowledge-graph/publication-identity';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import { CONTROLLED_ARTIFACT_INDEX_SCHEMA, CONTROLLED_ARTIFACT_OBJECT_SCHEMA,
  validateArtifactAad, validateControlledArtifactIndex, validateEncryptedArtifact } from './production-controlled-artifacts';
import type { ArtifactOperationContext, ArtifactRunBinding, ControlledArtifactIndex } from './production-controlled-artifacts';
import type { ArtifactReference } from './production-gate-manifest';

type Fields = Record<string, unknown>;
type Call = (request: unknown) => unknown;
const monotonicNow = performance.now.bind(performance);
const CODES = ['invalid-config', 'invalid-request', 'busy', 'already-sealed', 'halted', 'publication-mismatch',
  'invalid-clock', 'invalid-key', 'invalid-readback', 'operation-failed', 'operation-timeout', 'provider-contract-invalid'] as const;
const PHASES = ['configuration', 'preflight', 'publication-read', 'clock', 'encrypt', 'seal', 'readback', 'decrypt', 'final-validation'] as const;
type Code = typeof CODES[number];
type Phase = typeof PHASES[number];
const ownedErrors = new WeakSet<object>();

/** Only static outward context; provider failures may contain credentials or
 * hooks. This marker permits conservative halting, never authenticates success. */
export class PublicationArtifactError extends Error {
  readonly code: Code; readonly phase: Phase;
  readonly pendingCompletionUnknown: boolean; readonly mutationMayHaveOccurred: boolean;
  readonly automaticRetryAllowed = false; readonly productionAccepted = false;
  constructor(code: Code, phase: Phase, pendingCompletionUnknown = false, mutationMayHaveOccurred = false) {
    const safeCode = CODES.includes(code) ? code : 'operation-failed';
    const safePhase = PHASES.includes(phase) ? phase : 'preflight';
    super(`[publication artifact] ${safePhase}: ${safeCode}`); this.name = 'PublicationArtifactError';
    this.code = safeCode; this.phase = safePhase;
    this.pendingCompletionUnknown = pendingCompletionUnknown === true;
    this.mutationMayHaveOccurred = mutationMayHaveOccurred === true;
    ownedErrors.add(this); Object.freeze(this);
  }
}
interface CapturedPort { readonly receiver: object; readonly methods: Readonly<Record<string, Call>> }
interface Configuration {
  readonly executionProfile: 'local-reference'; readonly readerOptions: Readonly<Fields>;
  readonly artifactId: string; readonly writerId: string; readonly writerAuthorizationDigest: string;
  readonly expectedKeyRef: ArtifactReference; readonly storeIdentityRef: ArtifactReference;
  readonly retainUntil: string; readonly operationTimeoutMs: number;
}
export interface ReferencePublicationArtifactDecision {
  readonly schemaVersion: 'kg-publication-artifact-observation/v1';
  readonly validationLevel: 'local-reference-publication-artifact-readback'; readonly classification: 'confidential';
  readonly productionAccepted: false; readonly stageAcceptanceComplete: false;
  readonly sourceAuthenticated: false; readonly storeAuthenticated: false; readonly linearizableSnapshotProven: false;
  readonly optionsHash: string; readonly identityRef: ArtifactReference; readonly identityHash: string;
  readonly publicationObservationHash: string; readonly objectRef: ArtifactReference; readonly keyRef: ArtifactReference;
  readonly artifactIndex: ControlledArtifactIndex; readonly storeReadbackHash: string; readonly decryptedDecisionHash: string;
  readonly completedAt: string; readonly uncertaintyMs: number; readonly completionClockHash: string; readonly observationHash: string;
}

/** Volatile reference-only composition: actual private whole publication reader
 * -> pinned AES-GCM envelope -> exclusive seal -> independent exact read/decrypt.
 * No caller decisions/factories/times, production attestation, IAM or WORM claim.
 * Failure fences later dispatch; it cannot cancel or undo already-started IO. */
export function createReferencePublicationArtifactWriter(inputOptions: unknown, inputPorts: unknown) {
  let cfg: Configuration; let sources: CapturedPort; let clock: CapturedPort; let kms: CapturedPort; let store: CapturedPort;
  let reader: ReturnType<typeof createReferencePublicationReadback>; let run: ArtifactRunBinding;
  let starts: number; let ends: number; let retention: number; let aad: ReturnType<typeof validateArtifactAad>;
  let optionsHash: string;
  let closed = false; let busy = false; let sealed = false; let deadline = Infinity;
  let mutation = false; let phase: Phase = 'preflight';
  let coreClockFailure: PublicationArtifactError | null = null;
  const failure = (code: Code, pending = false) => new PublicationArtifactError(code, phase, pending, mutation);
  const assertOpen = () => {
    if (closed) throw failure('halted');
    if (monotonicNow() >= deadline) throw failure('operation-timeout');
  };
  try {
    const value = object(snapshot(inputOptions));
    exact(value, ['executionProfile', 'readerOptions', 'artifactId', 'writerId', 'writerAuthorizationDigest',
      'expectedKeyRef', 'storeIdentityRef', 'retainUntil', 'operationTimeoutMs']);
    const options = object(value.readerOptions);
    if (value.executionProfile !== 'local-reference' || options.executionProfile !== 'local-reference' || options.maxVerifications !== 1) throw new Error();
    identifier(value.artifactId); identifier(value.writerId);
    // Use the artifact actor grammar, not broader business/document identifiers.
    identifier(options.readerId);
    if (value.writerId === options.readerId) throw new Error();
    hex(value.writerAuthorizationDigest);
    reference(value.expectedKeyRef); reference(value.storeIdentityRef);
    integer(value.operationTimeoutMs, 1, 30000);
    const window = object(options.observationWindow);
    starts = timestamp(window.startsAt); ends = timestamp(window.endsAt); retention = timestamp(value.retainUntil);
    if (retention <= starts || retention - starts > 10 * 366 * 86400000) throw new Error();
    const refs = [options.expectedIdentityRef, options.clockIdentityRef, value.expectedKeyRef, value.storeIdentityRef,
      ...Object.values(object(options.sourceIdentityRefs))];
    if (refs.some(ref => object(ref).objectId === value.artifactId)) throw new Error();
    cfg = freeze(value) as unknown as Configuration;
    run = options.binding as unknown as ArtifactRunBinding;
    aad = validateArtifactAad({ ...run, artifactType: 'report', artifactId: cfg.artifactId,
      caseId: null, ordinal: 0, schemaVersion: 'kg-publication-observation/v1' });
    const ports = descriptors(inputPorts, ['sources', 'clock', 'kms', 'store']); exact(ports, ['sources', 'clock', 'kms', 'store']);
    sources = capture(ports.sources, ['readPostgres', 'readNeo4j', 'readMilvusPage'], ['setAvailability']);
    clock = capture(ports.clock, ['readTime'], ['advanceTo', 'setAvailability']);
    kms = capture(ports.kms, ['encryptArtifact', 'decryptArtifact'], ['rotateKey', 'revokeKey']);
    store = capture(ports.store, ['sealEncryptedArtifact', 'readExact']);
    // Sources keep raw synchronous forwarding. Clock returns OUR native promise
    // after bounded observation and exact validation, never an adopted SDK value.
    reader = createReferencePublicationReadback(cfg.readerOptions, {
      sources: forwarding(sources, ['readPostgres', 'readNeo4j', 'readMilvusPage'], assertOpen),
      clock: Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
        readTime(request: unknown) { assertOpen(); return readCoreClock(request); } }),
    });
    optionsHash = canonicalJsonSha256(cfg);
  } catch { throw new PublicationArtifactError('invalid-config', 'configuration'); }
  const readonlyId = cfg.readerOptions.readerId as string;
  const readonlyDigest = cfg.readerOptions.readerAuthorizationDigest as string;
  const previousByActor = new Map<string, AuthorityClockReading>();
  const challenges = new Set<string>(); let lastObservedAt = -Infinity; let lastSequence = 0;
  let lastClockReadingHash: string | null = null;

  // Every helper resolves a self-owned carrier, never a raw provider object.
  const invoke = async <T>(currentPhase: Phase, execute: () => unknown, detach: (value: unknown) => T,
    invalid: Code = 'invalid-readback', encryptDispatch = false): Promise<{ readonly value: T }> => {
    phase = currentPhase; assertOpen();
    const remaining = Math.min(cfg.operationTimeoutMs, Math.max(1, Math.ceil(deadline - monotonicNow())));
    const result = await boundedProviderCallWithRejection(() => {
      assertOpen(); if (encryptDispatch) mutation = true; return execute();
    }, remaining);
    phase = currentPhase;
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      const reason = result.status === 'timeout' && Object.hasOwn(result, 'reason') ? result.reason : undefined;
      throw failure(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid',
        result.pendingCompletionUnknown || pendingUnknown(reason)
        || currentPhase === 'publication-read' && coreClockFailure?.pendingCompletionUnknown === true);
    }
    if (result.status === 'rejected') {
      if (currentPhase === 'publication-read' && coreClockFailure !== null) {
        phase = 'clock';
        throw failure(coreClockFailure.code, coreClockFailure.pendingCompletionUnknown || pendingUnknown(result.reason));
      }
      // Module ownership only validates static fields, not the originating
      // operation. A provider can construct this error after OUR mutation.
      if (isOwned(result.reason)) throw failure(result.reason.code, result.reason.pendingCompletionUnknown);
      const publication = publicationFailure(result.reason);
      if (publication?.pending) throw failure(publication.code === 'operation-timeout' ? 'operation-timeout' : 'provider-contract-invalid', true);
      assertOpen();
      if (currentPhase === 'publication-read' && publication?.code === 'identity-mismatch') throw failure('publication-mismatch');
      if (currentPhase === 'publication-read' && publication?.code === 'invalid-clock') throw failure('invalid-clock');
      throw failure('operation-failed');
    }
    assertOpen();
    let value: T;
    try { value = detach(result.value); } catch { throw failure(invalid); }
    assertOpen(); return Object.freeze({ value });
  };
  const observeClock = async (inputRequest: unknown, actorId: string): Promise<{ readonly reading: AuthorityClockReading; readonly hash: string }> => {
    phase = 'clock'; assertOpen();
    const request = object(snapshot(inputRequest)); exact(request, ['context', 'requestNonce']);
    const requestedContext = object(request.context); exact(requestedContext, ['executionProfile', 'binding', 'actorId']);
    if (requestedContext.executionProfile !== 'local-reference' || requestedContext.actorId !== actorId
      || canonicalJson(requestedContext.binding) !== canonicalJson(run)
      || typeof request.requestNonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.requestNonce)
      || challenges.has(request.requestNonce)) throw failure('invalid-clock');
    const { value } = await invoke('clock', () => Reflect.apply(clock.methods.readTime, clock.receiver, [request]), raw => {
      const actual = validateAuthorityClockReading(snapshot(raw), { request, sourceIdentityRef: cfg.readerOptions.clockIdentityRef,
        maxUncertaintyMs: cfg.readerOptions.maxClockUncertaintyMs, previousReading: previousByActor.get(actorId) ?? null });
      const reading = actual.reading; const at = timestamp(reading.observedAt);
      // The SAME physical clock has one sequence even across actor transitions.
      // Keep each actor's history as well; never reset the core reader's cursor.
      if (reading.sequence <= lastSequence || at < lastObservedAt || at - reading.uncertaintyMs < starts || at + reading.uncertaintyMs >= ends
        || at + reading.uncertaintyMs >= retention) throw new Error();
      previousByActor.set(actorId, reading); lastObservedAt = at; lastSequence = reading.sequence;
      challenges.add(reading.requestNonce); lastClockReadingHash = actual.readingHash;
      return Object.freeze({ reading, hash: actual.readingHash });
    }, 'invalid-clock');
    return value;
  };
  const readClock = async (actorId: string): Promise<{ readonly reading: AuthorityClockReading; readonly hash: string }> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const nonce = randomBytes(16).toString('hex');
      if (!challenges.has(nonce)) return observeClock(freeze({ context: {
        executionProfile: 'local-reference', binding: run, actorId }, requestNonce: nonce }), actorId);
    }
    throw failure('invalid-clock');
  };
  async function readCoreClock(request: unknown): Promise<AuthorityClockReading> {
    try {
      const actual = await observeClock(request, readonlyId);
      // Exact validation guarantees this self-owned frozen reading has no then
      // field. It is not the raw SDK fulfillment or a caller-controlled carrier.
      return actual.reading;
    } catch (reason) {
      coreClockFailure = new PublicationArtifactError(isOwned(reason) ? reason.code : 'operation-failed',
        'clock', pendingUnknown(reason), mutation);
      // Core's own observer only conservatively preserves its owned UNKNOWN.
      // Also retain OUR private failure above for precise outer classification.
      throw new PublicationIdentityError(coreClockFailure.code === 'operation-timeout' ? 'operation-timeout'
        : 'provider-contract-invalid', 'clock', coreClockFailure.pendingCompletionUnknown);
    }
  }
  const context = (actorId: string, authorizationDigest: string, reading: AuthorityClockReading): ArtifactOperationContext =>
    freeze({ executionProfile: 'local-reference', binding: run, actorId, authorizationDigest, observedAt: reading.observedAt });
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    close(): void { closed = true; },
    async sealReadback(input: unknown): Promise<ReferencePublicationArtifactDecision> {
      try { exact(descriptors(input, []), []); } catch { throw new PublicationArtifactError('invalid-request', 'preflight'); }
      if (closed) throw new PublicationArtifactError('halted', 'preflight', false, mutation);
      if (busy) throw new PublicationArtifactError('busy', 'preflight', false, mutation);
      if (sealed) throw new PublicationArtifactError('already-sealed', 'preflight', false, mutation);
      busy = true; deadline = monotonicNow() + cfg.operationTimeoutMs;
      try {
        const { value: decision } = await invoke('publication-read', () => reader.readPublication(Object.freeze({})), raw => {
          const value = snapshot(raw) as PublicationReadbackDecision;
          const { observationHash, ...body } = value;
          if (observationHash !== canonicalJsonSha256(body)) throw new Error(); return value;
        });
        if (timestamp(decision.observedAt) !== lastObservedAt || decision.completionClockHash !== lastClockReadingHash) throw failure('invalid-clock');
        const plaintextBytes = Buffer.from(canonicalJson(decision));
        let plaintext: string;
        try { if (plaintextBytes.byteLength > 65536) throw failure('invalid-readback'); plaintext = plaintextBytes.toString('base64url'); }
        finally { plaintextBytes.fill(0); }
        const writerClock = await readClock(cfg.writerId);
        const writerContext = context(cfg.writerId, cfg.writerAuthorizationDigest, writerClock.reading);
        const aadSha256 = canonicalJsonSha256(aad);
        const { value: envelope } = await invoke('encrypt', () => Reflect.apply(kms.methods.encryptArtifact, kms.receiver,
          [freeze({ context: writerContext, aad, plaintextBase64url: plaintext })]), raw => {
          const value = validateEncryptedArtifact(snapshot(raw));
          if (canonicalJson(value.keyRef) !== canonicalJson(cfg.expectedKeyRef) || value.aadSha256 !== aadSha256) throw new Error();
          return value;
        }, 'invalid-key', true);
        const object = freeze({ schemaVersion: CONTROLLED_ARTIFACT_OBJECT_SCHEMA, aad, envelope, retainUntil: cfg.retainUntil });
        const objectJson = canonicalJson(object); const objectDigest = canonicalJsonSha256(object);
        const beforeSeal = await readClock(cfg.writerId);
        const sealContext = context(cfg.writerId, cfg.writerAuthorizationDigest, beforeSeal.reading);
        const { value: objectRef } = await invoke('seal', () => Reflect.apply(store.methods.sealEncryptedArtifact, store.receiver,
          [freeze({ context: sealContext, aad, envelope, retainUntil: cfg.retainUntil })]), raw => {
          const ref = reference(snapshot(raw)); if (ref.objectId !== cfg.artifactId || ref.sha256 !== objectDigest) throw new Error(); return ref;
        });
        const beforeRead = await readClock(readonlyId);
        const readContext = context(readonlyId, readonlyDigest, beforeRead.reading);
        const { value: storeReadback } = await invoke('readback', () => Reflect.apply(store.methods.readExact, store.receiver,
          [freeze({ context: readContext, ref: objectRef })]), raw => {
          const value = objectRecord(snapshot(raw)); exact(value, ['object', 'proof']);
          if (canonicalJson(value.object) !== objectJson) throw new Error();
          const expectedProof = { assurance: 'local-reference', productionTamperResistant: false,
            storeIdentityRef: cfg.storeIdentityRef, objectRef, lockMode: 'local-reference-immutable',
            retainUntil: cfg.retainUntil, readerId: readonlyId, observedAt: readContext.observedAt };
          if (canonicalJson(value.proof) !== canonicalJson(expectedProof)) throw new Error(); return value;
        });
        // Actual IO may outlive the previously checked time; re-observe before
        // exposing decrypted bytes, and once more before declaring completion.
        const beforeDecrypt = await readClock(readonlyId);
        const decryptContext = context(readonlyId, readonlyDigest, beforeDecrypt.reading);
        await invoke('decrypt', () => Reflect.apply(kms.methods.decryptArtifact, kms.receiver,
          [freeze({ context: decryptContext, aad, envelope })]), raw => {
          if (typeof raw !== 'string' || raw !== plaintext) throw new Error(); return true;
        });
        const completion = await readClock(readonlyId);
        phase = 'final-validation'; assertOpen();
        const artifactIndex = validateControlledArtifactIndex({ schemaVersion: CONTROLLED_ARTIFACT_INDEX_SCHEMA,
          classification: 'confidential', binding: run, entries: [{ artifactId: cfg.artifactId, artifactType: 'report',
            caseId: null, ordinal: 0, schemaVersion: decision.schemaVersion, objectRef, keyRef: cfg.expectedKeyRef, aadSha256 }] }).index;
        const core = freeze({ schemaVersion: 'kg-publication-artifact-observation/v1' as const,
          validationLevel: 'local-reference-publication-artifact-readback' as const, classification: 'confidential' as const,
          productionAccepted: false as const, stageAcceptanceComplete: false as const, sourceAuthenticated: false as const,
          storeAuthenticated: false as const, linearizableSnapshotProven: false as const, optionsHash,
          identityRef: decision.identityRef, identityHash: decision.identityHash, publicationObservationHash: decision.observationHash,
          objectRef, keyRef: cfg.expectedKeyRef, artifactIndex, storeReadbackHash: canonicalJsonSha256(storeReadback),
          decryptedDecisionHash: canonicalJsonSha256(decision), completedAt: completion.reading.observedAt,
          uncertaintyMs: completion.reading.uncertaintyMs, completionClockHash: completion.hash });
        const result = freeze({ ...core, observationHash: canonicalJsonSha256(core) });
        assertOpen(); sealed = true; return result;
      } catch (reason) {
        closed = true;
        if (isOwned(reason)) throw failure(reason.code, reason.pendingCompletionUnknown);
        throw failure('operation-failed', pendingUnknown(reason));
      } finally { busy = false; }
    },
  });
}

function isOwned(reason: unknown): reason is PublicationArtifactError {
  return reason !== null && typeof reason === 'object' && ownedErrors.has(reason);
}
function publicationFailure(reason: unknown): { code: unknown; pending: boolean } | null {
  if (reason === null || typeof reason !== 'object' || types.isProxy(reason) || Object.getPrototypeOf(reason) !== PublicationIdentityError.prototype) return null;
  return { code: Object.getOwnPropertyDescriptor(reason, 'code')?.value,
    pending: Object.getOwnPropertyDescriptor(reason, 'pendingCompletionUnknown')?.value === true };
}
function pendingUnknown(reason: unknown): boolean {
  return isOwned(reason) ? reason.pendingCompletionUnknown : publicationFailure(reason)?.pending === true;
}
function forwarding(port: CapturedPort, methods: readonly string[], assertOpen: () => void): Readonly<Fields> {
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    ...Object.fromEntries(methods.map(method => [method, (request: unknown) => {
      assertOpen(); return Reflect.apply(port.methods[method], port.receiver, [request]);
    }])) });
}
function capture(input: unknown, methods: readonly string[], optional: readonly string[] = []): CapturedPort {
  const flags = ['executionProfile', 'productionCapable'];
  const value = descriptors(input, [...flags, ...methods, ...optional]);
  exact(value, [...flags, ...methods, ...optional.filter(key => Object.hasOwn(value, key))]);
  if (value.executionProfile !== 'local-reference' || value.productionCapable !== false) throw new Error();
  for (const name of [...methods, ...optional.filter(key => Object.hasOwn(value, key))]) {
    if (typeof value[name] !== 'function' || types.isProxy(value[name])) throw new Error();
  }
  return Object.freeze({ receiver: input as object,
    methods: Object.freeze(Object.fromEntries(methods.map(name => [name, value[name] as Call]))) });
}
function descriptors(input: unknown, allowed: readonly string[]): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
  const result: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(); result[key] = descriptor.value;
  }
  return result;
}
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function object(input: unknown): Fields { return objectRecord(input); }
function objectRecord(input: unknown): Fields { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(value: Fields, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error(); }
function identifier(input: unknown): void { if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) throw new Error(); }
function hex(input: unknown): void { if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new Error(); }
function integer(input: unknown, min: number, max: number): void { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); }
function timestamp(input: unknown): number { if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
  || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new Error(); return Date.parse(input); }
function reference(input: unknown): ArtifactReference { const value = objectRecord(input); exact(value, ['objectId', 'objectVersion', 'sha256']);
  identifier(value.objectId); identifier(value.objectVersion); hex(value.sha256); return value as unknown as ArtifactReference; }
function freeze<T>(input: T): T { if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }
