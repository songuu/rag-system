import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { PublicationIdentityError, validatePublicationIdentity, PUBLICATION_SOURCE_PROOF_SCHEMA } from '../../knowledge-graph/publication-identity';
import type { PublicationSourceReadRequest } from '../../knowledge-graph/publication-identity';
import type { RagTrustLevel } from '../../security/retrieval-scope';
import { boundedProviderCallWithRejection } from './bounded-provider-call';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { ArtifactRunBinding } from './production-controlled-artifacts';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import type { ArtifactReference } from './production-gate-manifest';

type Fields = Record<string, unknown>;
type Source = 'postgres' | 'neo4j' | 'milvus';
type Scope = Pick<ArtifactRunBinding, 'environment' | 'tenantId' | 'corpusId'>;
type Call = (request: unknown) => unknown;
const SOURCE_NAMES = ['postgres', 'neo4j', 'milvus'] as const;
const MAX_NORMALIZED_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENTS = 512;
const ownErrors = new WeakSet<object>();

export type PublicationStateObserverErrorCode = 'invalid-config' | 'invalid-request' | 'invalid-clock' | 'invalid-proof' | 'invalid-state'
  | 'read-limit' | 'operation-failed' | 'operation-timeout' | 'provider-contract-invalid' | 'busy' | 'halted' | 'observation-capacity';
const ERROR_CODES: readonly PublicationStateObserverErrorCode[] = ['invalid-config', 'invalid-request', 'invalid-clock', 'invalid-proof', 'invalid-state',
  'read-limit', 'operation-failed', 'operation-timeout', 'provider-contract-invalid', 'busy', 'halted', 'observation-capacity'];

/** A conservative local failure, not a source attestation or cancellation receipt. */
export class PublicationStateObserverError extends Error {
  readonly code: PublicationStateObserverErrorCode;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: PublicationStateObserverErrorCode, pendingCompletionUnknown = false) {
    const safeCode = ERROR_CODES.includes(code) ? code : 'invalid-state';
    super(`[publication state observer] ${safeCode}`); this.name = 'PublicationStateObserverError';
    this.code = safeCode; this.pendingCompletionUnknown = pendingCompletionUnknown === true;
    ownErrors.add(this); Object.freeze(this);
  }
}

export interface PublicationObservedRow {
  readonly tenantId: string; readonly corpusId: string; readonly documentId: string; readonly documentVersion: string;
  readonly trustLevel: RagTrustLevel; readonly chunkId: string; readonly chunkIndex: number; readonly totalChunks: number; readonly contentSha256: string;
}
interface ObservedDocument { readonly documentId: string; readonly documentVersion: string; readonly trustLevel: RagTrustLevel }
interface ObservedPointer { readonly tenantId: string; readonly corpusId: string; readonly graphVersion: string; readonly revision: number }
interface ObservedGraph {
  readonly tenantId: string; readonly corpusId: string; readonly graphVersion: string; readonly status: string;
  readonly artifactDigest: string; readonly documents: readonly ObservedDocument[];
}
interface ObservedOutbox extends ObservedPointer {
  readonly eventType: string; readonly publishedAt: string | null; readonly deadLetteredAt: string | null;
}
export interface PublicationStateProjection {
  readonly postgres: { readonly scope: Scope; readonly pointer: ObservedPointer; readonly outbox: ObservedOutbox; readonly buildJob: ObservedGraph };
  readonly neo4j: { readonly scope: Scope; readonly pointer: ObservedPointer; readonly snapshot: ObservedGraph };
  readonly milvus: { readonly scope: Scope; readonly collection: string; readonly schemaManifest: Readonly<Fields>;
    readonly indexManifest: Readonly<Fields>; readonly rows: readonly PublicationObservedRow[] };
}
export interface PublicationStateObservation {
  readonly projection: PublicationStateProjection; readonly stateHash: string; readonly rowCount: number; readonly rowsManifestHash: string;
}
export interface IsolatedPublicationStateObserver {
  readonly executionProfile: 'local-reference'; readonly productionCapable: false;
  observeActualState(request: unknown): Promise<PublicationStateObservation>;
  /** Fence subsequent dispatch; already issued provider IO cannot be cancelled here. */
  close(): void;
}
export interface IsolatedPublicationStateObserverOptions {
  readonly readerOptions: unknown; readonly challengeNonce: string; readonly maxObservations: number; readonly operationTimeoutMs: number;
}

function fail(code: PublicationStateObserverErrorCode, pending = false): never { throw new PublicationStateObserverError(code, pending); }
function record(value: unknown): Fields { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Fields; }
function exact(value: Fields, names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error(); }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(); return value; }
function hex(value: unknown, length = 64): string { if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/.test(value)) throw new Error(); return value; }
function identifier(value: unknown, max = 128): string { if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(); return value; }
function opaque(value: unknown): string { if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new Error(); return value; }
function trust(value: unknown): RagTrustLevel { if (value !== 'trusted' && value !== 'reviewed' && value !== 'external' && value !== 'quarantined') throw new Error(); return value; }
function timestamp(value: unknown): number { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(); return Date.parse(value); }
function same(left: unknown, right: unknown): void { if (canonicalJson(left) !== canonicalJson(right)) throw new Error(); }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function snapshot(value: unknown): unknown { return freeze(JSON.parse(canonicalJson(value))); }
function parseScope(value: unknown): Scope { const scope = record(value); exact(scope, ['environment', 'tenantId', 'corpusId']);
  for (const child of Object.values(scope)) identifier(child); return scope as unknown as Scope; }
function reference(value: unknown): ArtifactReference { const ref = record(value); exact(ref, ['objectId', 'objectVersion', 'sha256']);
  identifier(ref.objectId); identifier(ref.objectVersion); hex(ref.sha256); return ref as unknown as ArtifactReference; }
function descriptors(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const keys = Reflect.ownKeys(value); if (keys.length > 16) throw new Error(); const result: Fields = Object.create(null);
  for (const key of keys) { if (typeof key !== 'string') throw new Error(); const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error(); result[key] = descriptor.value; }
  return result;
}
function capture(value: unknown, names: readonly string[]): Readonly<Record<string, Call>> {
  const fields = descriptors(value); if (fields.executionProfile !== 'local-reference' || fields.productionCapable !== false) throw new Error();
  return Object.freeze(Object.fromEntries(names.map(name => { const method = fields[name]; if (typeof method !== 'function' || types.isProxy(method)) throw new Error();
    return [name, (request: unknown) => Reflect.apply(method, value, [request])]; })));
}
function ownedFailure(value: unknown): PublicationStateObserverError | null {
  return value !== null && typeof value === 'object' && ownErrors.has(value) ? value as PublicationStateObserverError : null;
}
function nativeUnknown(value: unknown): boolean {
  // This descriptor-only check can only make a failure more conservative. It
  // cannot certify issuer identity, success, permissions or an external source.
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== PublicationIdentityError.prototype || !Object.isFrozen(value)) return false;
  return Object.getOwnPropertyDescriptor(value, 'pendingCompletionUnknown')?.value === true;
}
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
function normalizeDocuments(value: unknown): readonly ObservedDocument[] {
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) throw new Error();
  return value.map(input => { const doc = record(input); exact(doc, ['documentId', 'documentVersion', 'trustLevel']);
    return { documentId: opaque(doc.documentId), documentVersion: opaque(doc.documentVersion), trustLevel: trust(doc.trustLevel) }; })
    .sort((left, right) => compare(left.documentId, right.documentId) || compare(left.documentVersion, right.documentVersion) || compare(left.trustLevel, right.trustLevel));
}
function scoped(value: Fields, scope: Scope): void { if (value.tenantId !== scope.tenantId || value.corpusId !== scope.corpusId) throw new Error(); }
function normalizePointer(input: unknown, scope: Scope): ObservedPointer { const value = record(input); exact(value, ['tenantId', 'corpusId', 'graphVersion', 'revision']); scoped(value, scope);
  return { tenantId: identifier(value.tenantId), corpusId: identifier(value.corpusId), graphVersion: identifier(value.graphVersion, 512), revision: integer(value.revision, 1, Number.MAX_SAFE_INTEGER) }; }
function normalizeGraph(input: unknown, scope: Scope): ObservedGraph { const value = record(input); exact(value, ['tenantId', 'corpusId', 'graphVersion', 'status', 'artifactDigest', 'documents']); scoped(value, scope);
  if (typeof value.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.artifactDigest)) throw new Error();
  return { tenantId: identifier(value.tenantId), corpusId: identifier(value.corpusId), graphVersion: identifier(value.graphVersion, 512), status: opaque(value.status),
    artifactDigest: value.artifactDigest, documents: normalizeDocuments(value.documents) }; }
function normalizePostgres(input: unknown, scope: Scope): PublicationStateProjection['postgres'] {
  const value = record(input); exact(value, ['scope', 'pointer', 'outbox', 'buildJob']); same(parseScope(value.scope), scope);
  const outbox = record(value.outbox); exact(outbox, ['tenantId', 'corpusId', 'graphVersion', 'revision', 'eventType', 'publishedAt', 'deadLetteredAt']); scoped(outbox, scope);
  for (const field of ['publishedAt', 'deadLetteredAt']) if (outbox[field] !== null) timestamp(outbox[field]);
  return { scope, pointer: normalizePointer(value.pointer, scope), outbox: { tenantId: identifier(outbox.tenantId), corpusId: identifier(outbox.corpusId),
    graphVersion: identifier(outbox.graphVersion, 512), revision: integer(outbox.revision, 1, Number.MAX_SAFE_INTEGER), eventType: opaque(outbox.eventType),
    publishedAt: outbox.publishedAt as string | null, deadLetteredAt: outbox.deadLetteredAt as string | null }, buildJob: normalizeGraph(value.buildJob, scope) };
}
function normalizeNeo4j(input: unknown, scope: Scope): PublicationStateProjection['neo4j'] {
  const value = record(input); exact(value, ['scope', 'pointer', 'snapshot']); same(parseScope(value.scope), scope);
  return { scope, pointer: normalizePointer(value.pointer, scope), snapshot: normalizeGraph(value.snapshot, scope) };
}
function normalizeRow(input: unknown, scope: Scope): PublicationObservedRow {
  const value = record(input); exact(value, ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks']);
  if (value.tenant_id !== scope.tenantId || value.corpus_id !== scope.corpusId || typeof value.content !== 'string' || value.content.length < 1 || Buffer.byteLength(value.content, 'utf8') > 65536) throw new Error();
  return { tenantId: identifier(value.tenant_id), corpusId: identifier(value.corpus_id), documentId: opaque(value.document_id), documentVersion: opaque(value.document_version),
    trustLevel: trust(value.trust_level), chunkId: opaque(value.id), chunkIndex: integer(value.chunk_index, 0, 65535), totalChunks: integer(value.total_chunks, 1, 65536),
    contentSha256: createHash('sha256').update(value.content, 'utf8').digest('hex') };
}

/** Encode the complete normalized value, not a truncated canonical snapshot.
 * Members already passed the strict bounded per-response canonical profile. */
function streamingHash(value: unknown, checkGate: () => void): string {
  const digest = createHash('sha256'); let bytes = 0;
  const append = (text: string): void => { checkGate(); bytes += Buffer.byteLength(text, 'utf8'); if (bytes > MAX_NORMALIZED_BYTES) fail('read-limit'); digest.update(text, 'utf8'); };
  const visit = (input: unknown): void => {
    if (input === null || typeof input !== 'object') { append(canonicalJson(input)); return; }
    if (Array.isArray(input)) { append('['); input.forEach((member, index) => { if (index) append(','); visit(member); }); append(']'); return; }
    const fields = input as Fields; append('{'); Object.keys(fields).sort().forEach((key, index) => {
      if (index) append(','); append(canonicalJson(key)); append(':'); visit(fields[key]); }); append('}');
  };
  visit(value); checkGate(); return digest.digest('hex');
}
function rowKey(row: PublicationObservedRow): string { return canonicalJson([row.documentId, row.documentVersion, row.trustLevel, row.chunkIndex, row.chunkId,
  row.tenantId, row.corpusId, row.totalChunks, row.contentSha256]); }
function manifestHash(rows: readonly PublicationObservedRow[], checkGate: () => void): string {
  const groups = new Map<string, { documentId: string; documentVersion: string; trustLevel: RagTrustLevel; chunks: PublicationObservedRow[] }>();
  for (const row of rows) { checkGate(); const key = canonicalJson([row.documentId, row.documentVersion, row.trustLevel]); let group = groups.get(key);
    if (!group) { group = { documentId: row.documentId, documentVersion: row.documentVersion, trustLevel: row.trustLevel, chunks: [] }; groups.set(key, group); } group.chunks.push(row); }
  const manifests = [...groups.values()].sort((left, right) => compare(left.documentId, right.documentId) || compare(left.documentVersion, right.documentVersion) || compare(left.trustLevel, right.trustLevel))
    .map(group => ({ documentId: group.documentId, documentVersion: group.documentVersion, trustLevel: group.trustLevel, chunkCount: group.chunks.length,
      contentManifestHash: streamingHash([...group.chunks].sort((left, right) => left.chunkIndex - right.chunkIndex || compare(left.chunkId, right.chunkId)
        || compare(left.contentSha256, right.contentSha256)).map(row => ({ chunkId: row.chunkId, chunkIndex: row.chunkIndex, contentSha256: row.contentSha256 })), checkGate) }));
  // Incomplete and duplicate chunks remain observable. Their hash is not a
  // declaration that a legal publication manifest has been verified.
  return streamingHash(manifests, checkGate);
}

/** Independently observe every actual row and business projection. Structural
 * proof echoes establish correlation only; all output remains local-reference. */
export function createIsolatedPublicationStateObserver(inputOptions: IsolatedPublicationStateObserverOptions,
  inputPorts: unknown): IsolatedPublicationStateObserver {
  let options: Fields; let cfg: Fields; let run: ArtifactRunBinding; let scope: Scope; let selected: PublicationSourceReadRequest['selector'];
  let refs: Record<Source, ArtifactReference>; let clock: Readonly<Record<string, Call>>; let sources: Readonly<Record<string, Call>>;
  let starts: number; let ends: number; let maxPages: number; let maxRows: number; let maxObservations: number; let timeout: number; let rawTimeout: number; let challengeNonce: string;
  try {
    options = record(snapshot(inputOptions)); exact(options, ['readerOptions', 'challengeNonce', 'maxObservations', 'operationTimeoutMs']);
    challengeNonce = hex(options.challengeNonce, 32); maxObservations = integer(options.maxObservations, 1, 64); timeout = integer(options.operationTimeoutMs, 1, 30000);
    cfg = record(options.readerOptions); exact(cfg, ['executionProfile', 'binding', 'expectedIdentity', 'expectedIdentityRef', 'readerId', 'readerAuthorizationDigest',
      'sourceIdentityRefs', 'clockIdentityRef', 'maxClockUncertaintyMs', 'observationWindow', 'operationTimeoutMs', 'maxVerifications', 'maxPages', 'maxRows']);
    if (cfg.executionProfile !== 'local-reference') throw new Error(); const parsedBinding = record(cfg.binding); exact(parsedBinding, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash']);
    validateArtifactAad({ ...parsedBinding, artifactType: 'report', artifactId: 'publication-state-observation', caseId: null, ordinal: 0, schemaVersion: 'publication-state/v1' });
    run = parsedBinding as unknown as ArtifactRunBinding; scope = freeze({ environment: run.environment, tenantId: run.tenantId, corpusId: run.corpusId }); parseScope(scope);
    const expected = validatePublicationIdentity(cfg.expectedIdentity).identity; same(expected.scope, scope);
    if (reference(cfg.expectedIdentityRef).sha256 !== canonicalJsonSha256(expected)) throw new Error();
    identifier(cfg.readerId); hex(cfg.readerAuthorizationDigest); reference(cfg.clockIdentityRef); integer(cfg.maxClockUncertaintyMs, 0, 60000);
    const sourceRefs = record(cfg.sourceIdentityRefs); exact(sourceRefs, SOURCE_NAMES); const ids = new Set<string>();
    for (const name of SOURCE_NAMES) { const ref = reference(sourceRefs[name]); if (ids.has(ref.objectId)) throw new Error(); ids.add(ref.objectId); } refs = sourceRefs as unknown as Record<Source, ArtifactReference>;
    const window = record(cfg.observationWindow); exact(window, ['startsAt', 'endsAt']); starts = timestamp(window.startsAt); ends = timestamp(window.endsAt);
    if (ends <= starts || ends - starts > 86400000) throw new Error(); maxPages = integer(cfg.maxPages, 1, 1024); maxRows = integer(cfg.maxRows, 1, 65536);
    integer(cfg.maxVerifications, 1, 64); rawTimeout = integer(cfg.operationTimeoutMs, 1, 30000);
    const ports = descriptors(inputPorts); exact(ports, ['sources', 'clock']); sources = capture(ports.sources, ['readPostgres', 'readNeo4j', 'readMilvusPage']); clock = capture(ports.clock, ['readTime']);
    selected = freeze({ scope, graphVersion: expected.graph.graphVersion, collection: expected.milvus.collection });
  } catch { fail('invalid-config'); }
  const clockContext = freeze({ executionProfile: 'local-reference', binding: run, actorId: cfg.readerId });
  let previous: AuthorityClockReading | null = null; let ordinal = 0; let observations = 0; let halted = false; let busy = false;
  let activeGate: { closed: boolean; deadline: number } | null = null;
  const challenge = (): string => { ordinal++; return createHash('sha256').update(canonicalJson({ domain: 'kg-publication-state-challenge/v1', challengeNonce, ordinal }), 'utf8').digest('hex').slice(0, 32); };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const,
    close(): void { halted = true; if (activeGate) activeGate.closed = true; },
    async observeActualState(input: unknown): Promise<PublicationStateObservation> {
      if (halted) fail('halted'); if (busy) fail('busy');
      try { exact(record(snapshot(input)), []); } catch { fail('invalid-request'); }
      if (observations >= maxObservations) fail('observation-capacity'); observations++; busy = true;
      const gate = { closed: false, deadline: performance.now() + timeout }; activeGate = gate;
      const checkGate = (): void => { if (halted || gate.closed) fail('halted'); if (performance.now() >= gate.deadline) { halted = true; fail('operation-timeout'); } };
      const invoke = async (operation: () => unknown): Promise<{ readonly value: unknown }> => {
        checkGate(); const remaining = Math.floor(gate.deadline - performance.now()); if (remaining < 1) { halted = true; fail('operation-timeout'); }
        const observed = await boundedProviderCallWithRejection(() => { checkGate(); return operation(); }, Math.min(rawTimeout, remaining));
        // No callback performs follow-up IO. Re-enter only through this closed
        // gate after settlement, including synchronous dispatch starvation.
        if (halted || gate.closed) fail('halted');
        if (observed.status === 'timeout' || observed.status === 'invalid-return') {
          halted = true; const pending = observed.pendingCompletionUnknown || observed.status === 'timeout' && Object.hasOwn(observed, 'reason') && nativeUnknown(observed.reason);
          fail(observed.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid', pending);
        }
        if (observed.status === 'rejected') { const own = ownedFailure(observed.reason); if (own) throw own;
          if (nativeUnknown(observed.reason)) { halted = true; fail('operation-timeout', true); } fail('operation-failed'); }
        checkGate(); let value: unknown; try { value = snapshot(observed.value); } catch { fail('invalid-state'); } checkGate();
        // Return only a self-owned nonthenable envelope, never raw SDK values.
        return Object.freeze({ value });
      };
      const readClock = async (): Promise<AuthorityClockReading> => {
        checkGate(); const request = freeze({ context: clockContext, requestNonce: challenge() }); const actual = await invoke(() => clock.readTime(request)); checkGate();
        try { const reading = validateAuthorityClockReading(actual.value, { request, sourceIdentityRef: cfg.clockIdentityRef, maxUncertaintyMs: cfg.maxClockUncertaintyMs, previousReading: previous }).reading;
          if (reading.assurance !== 'local-reference' || reading.productionTimeAuthenticated !== false || timestamp(reading.observedAt) - reading.uncertaintyMs < starts
            || timestamp(reading.observedAt) + reading.uncertaintyMs >= ends) throw new Error(); previous = reading; checkGate(); return reading;
        } catch (error) { const own = ownedFailure(error); if (own) throw own; fail('invalid-clock'); }
      };
      const read = async (source: Source, cursor: string | null): Promise<{ readonly value: unknown }> => {
        const reading = await readClock(); checkGate(); const request = freeze({ context: { executionProfile: 'local-reference' as const, binding: run,
          actorId: cfg.readerId as string, authorizationDigest: cfg.readerAuthorizationDigest as string, observedAt: reading.observedAt }, selector: selected, requestNonce: challenge(), cursor });
        const raw = await invoke(() => sources[{ postgres: 'readPostgres', neo4j: 'readNeo4j', milvus: 'readMilvusPage' }[source]](request)); checkGate();
        try { const value = record(raw.value); exact(value, ['data', 'proof']); same(value.proof, { schemaVersion: PUBLICATION_SOURCE_PROOF_SCHEMA, source, assurance: 'local-reference',
          productionSourceAuthenticated: false, sourceIdentityRef: refs[source], context: request.context, selector: selected, requestNonce: request.requestNonce, cursor, dataHash: canonicalJsonSha256(value.data) });
          checkGate(); return Object.freeze({ value: value.data });
        } catch (error) { const own = ownedFailure(error); if (own) throw own; fail('invalid-proof'); }
      };
      try {
        const pgReadback = await read('postgres', null); checkGate(); let postgres: PublicationStateProjection['postgres'];
        try { postgres = normalizePostgres(pgReadback.value, scope); } catch { fail('invalid-state'); } checkGate();
        const neoReadback = await read('neo4j', null); checkGate(); let neo4j: PublicationStateProjection['neo4j'];
        try { neo4j = normalizeNeo4j(neoReadback.value, scope); } catch { fail('invalid-state'); } checkGate();
        const rows: PublicationObservedRow[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
        let base: { scope: Scope; collection: string; schemaManifest: Fields; indexManifest: Fields } | null = null;
        for (let page = 0; ; page++) {
          checkGate(); if (page >= maxPages) fail('read-limit'); const readback = await read('milvus', cursor); checkGate(); let next: string | null;
          try { const value = record(readback.value); exact(value, ['scope', 'collection', 'schemaManifest', 'indexManifest', 'rows', 'completion', 'nextCursor']);
            same(parseScope(value.scope), scope); if (value.collection !== selected.collection) throw new Error();
            const schema = record(value.schemaManifest); const index = record(value.indexManifest); if (!Object.keys(schema).length || !Object.keys(index).length) throw new Error();
            const manifests = { scope, collection: selected.collection, schemaManifest: schema, indexManifest: index }; if (base) same(base, manifests); else base = manifests;
            if (!Array.isArray(value.rows)) throw new Error(); if (value.rows.length > 128 || rows.length + value.rows.length > maxRows) fail('read-limit');
            next = value.nextCursor === null ? null : hex(value.nextCursor);
            if (value.completion !== (next === null ? 'complete' : 'more') || value.rows.length === 0 && next !== null || next !== null && (next === cursor || cursors.has(next))) throw new Error();
            for (const inputRow of value.rows) { checkGate(); rows.push(normalizeRow(inputRow, scope)); }
          } catch (error) { const own = ownedFailure(error); if (own) throw own; fail('invalid-state'); }
          checkGate(); if (next === null) break; cursors.add(next); cursor = next;
        }
        checkGate(); if (!base) fail('invalid-state'); const keyed = rows.map(row => { checkGate(); return { row, key: rowKey(row) }; });
        keyed.sort((left, right) => compare(left.key, right.key)); checkGate();
        const projection: PublicationStateProjection = freeze({ postgres, neo4j, milvus: { ...base, rows: keyed.map(value => value.row) } }); checkGate();
        const stateHash = streamingHash(projection, checkGate); const rowsManifestHash = manifestHash(projection.milvus.rows, checkGate); checkGate();
        return freeze({ projection, stateHash, rowCount: rows.length, rowsManifestHash });
      } catch (error) { halted = true; const own = ownedFailure(error); if (own) throw own; fail('invalid-state'); }
      finally { gate.closed = true; if (activeGate === gate) activeGate = null; busy = false; }
    },
  });
}
