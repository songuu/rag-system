import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from '../rag/eval/canonical-json';
import { boundedProviderCallWithRejection } from '../rag/eval/bounded-provider-call';
import { validateArtifactAad } from '../rag/eval/production-controlled-artifacts';
import type { ArtifactOperationContext, ArtifactRunBinding } from '../rag/eval/production-controlled-artifacts';
import { validateAuthorityClockReading } from '../rag/eval/production-authority-ports';
import type { AuthorityClockReading } from '../rag/eval/production-authority-ports';
import type { ArtifactReference } from '../rag/eval/production-gate-manifest';
import type { RagTrustLevel } from '../security/retrieval-scope';
import { KNOWLEDGE_GRAPH_LIMITS } from './contracts';

export const PUBLICATION_IDENTITY_SCHEMA = 'kg-publication-identity/v1' as const;
export const PUBLICATION_SOURCE_PROOF_SCHEMA = 'kg-publication-source-proof/v1' as const;
type Fields = Record<string, unknown>;
type Source = 'postgres' | 'neo4j' | 'milvus';
type Scope = Pick<ArtifactRunBinding, 'environment' | 'tenantId' | 'corpusId'>;
type Phase = 'configuration' | 'preflight' | 'clock' | Source | 'final-validation';
type Code = 'invalid-identity' | 'invalid-config' | 'invalid-request' | 'invalid-readback' | 'identity-mismatch' | 'invalid-clock'
  | 'unstable-publication' | 'read-limit' | 'source-replay' | 'source-capacity' | 'source-unavailable' | 'operation-failed'
  | 'operation-timeout' | 'provider-contract-invalid' | 'busy' | 'halted' | 'attempt-capacity';
const SOURCES = ['postgres', 'neo4j', 'milvus'] as const;
// Only classify constructor-owned frozen failures. This local marker can stop
// work conservatively; it never authenticates a source or authorizes success.
const ownedPublicationErrors = new WeakSet<object>();
export class PublicationIdentityError extends Error {
  readonly productionAuthorized = false; readonly automaticRetryAllowed = false;
  readonly code: Code; readonly phase: Phase; readonly pendingCompletionUnknown: boolean;
  constructor(code: Code, phase: Phase, pendingCompletionUnknown = false) {
    super(`[publication readback] ${phase}: ${code}`); this.name = 'PublicationIdentityError';
    this.code = code; this.phase = phase; this.pendingCompletionUnknown = pendingCompletionUnknown;
    ownedPublicationErrors.add(this); Object.freeze(this);
  }
}
function ownedUnknownFailureCode(reason: unknown): Code | null {
  if (reason === null || typeof reason !== 'object' || !ownedPublicationErrors.has(reason)) return null;
  if (Object.getOwnPropertyDescriptor(reason, 'pendingCompletionUnknown')?.value !== true) return null;
  const code = Object.getOwnPropertyDescriptor(reason, 'code')?.value;
  // Public JS callers can pass invalid constructor arguments. Never reuse their
  // message/phase/code text in the outward error, even on this owned path.
  return code === 'operation-timeout' ? 'operation-timeout' : 'provider-contract-invalid';
}
export interface PublicationDocumentIdentity {
  readonly documentId: string; readonly documentVersion: string; readonly trustLevel: RagTrustLevel;
  readonly expectedChunkCount: number | null; readonly contentManifestHash: string | null;
}
export interface PublicationIdentity {
  readonly schemaVersion: typeof PUBLICATION_IDENTITY_SCHEMA; readonly scope: Scope;
  readonly graph: { readonly graphVersion: string; readonly artifactDigest: string; readonly pointerRevision: number };
  readonly documents: readonly PublicationDocumentIdentity[];
  readonly milvus: { readonly collection: string; readonly schemaManifestHash: string; readonly indexManifestHash: string };
}
export interface PublicationSourceReadRequest {
  readonly context: ArtifactOperationContext;
  readonly selector: { readonly scope: Scope; readonly graphVersion: string; readonly collection: string };
  readonly requestNonce: string; readonly cursor: string | null;
}
export interface PublicationSourceReadback {
  readonly data: unknown;
  readonly proof: { readonly schemaVersion: typeof PUBLICATION_SOURCE_PROOF_SCHEMA; readonly source: Source;
    readonly assurance: 'enterprise' | 'local-reference'; readonly productionSourceAuthenticated: boolean;
    readonly sourceIdentityRef: ArtifactReference; readonly context: ArtifactOperationContext;
    readonly selector: PublicationSourceReadRequest['selector']; readonly requestNonce: string; readonly cursor: string | null; readonly dataHash: string };
}
/** Sources enumerate the full frozen scope/publication view, NOT a filtered
 * expected-document list, which could conceal unexpected versions/rows. */
export interface PublicationReadbackSources {
  readonly executionProfile: 'enterprise' | 'local-reference'; readonly productionCapable: boolean;
  readPostgres(request: PublicationSourceReadRequest): Promise<PublicationSourceReadback>;
  readNeo4j(request: PublicationSourceReadRequest): Promise<PublicationSourceReadback>;
  readMilvusPage(request: PublicationSourceReadRequest): Promise<PublicationSourceReadback>;
}
export interface PublicationReadbackDecision {
  readonly schemaVersion: 'kg-publication-observation/v1'; readonly validationLevel: 'local-reference-three-store-readback';
  readonly classification: 'confidential'; readonly productionAuthorized: false; readonly stageAcceptanceComplete: false;
  readonly sourceAuthenticated: false; readonly linearizableSnapshotProven: false; readonly consistencyVerified: true;
  readonly identityRef: ArtifactReference; readonly identityHash: string; readonly rowCount: number; readonly rowsManifestHash: string;
  readonly readbacks: readonly { readonly source: Source; readonly proofHash: string }[];
  readonly completionClockHash: string; readonly observedAt: string; readonly uncertaintyMs: number; readonly observationHash: string;
}
export interface PublicationReadbackPort {
  readonly executionProfile: 'enterprise' | 'local-reference'; readonly productionCapable: boolean;
  readPublication(request: unknown): Promise<PublicationReadbackDecision>;
}
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function snapshot(input: unknown): unknown { return freeze(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(value: Fields, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error(); }
function same(a: unknown, b: unknown): void { if (canonicalJson(a) !== canonicalJson(b)) throw new Error(); }
function id(input: unknown, max = 128): string { if (typeof input !== 'string' || input.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)) throw new Error(); return input; }
// Business document/chunk identities are opaque text under the existing KG
// contract, not endpoint/path selectors. Hash and compare their exact values.
function opaqueId(input: unknown): string { if (typeof input !== 'string' || !input || input.trim() !== input
  || input.length > KNOWLEDGE_GRAPH_LIMITS.maxIdentifierCharacters || /[\u0000-\u001f]/.test(input)) throw new Error(); return input; }
function hex(input: unknown, length = 64): string { if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) throw new Error(); return input; }
function integer(input: unknown, min: number, max: number): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); return input; }
function time(input: unknown): number { if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
  || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new Error(); return Date.parse(input); }
function reference(input: unknown): ArtifactReference { const v = record(input); exact(v, ['objectId', 'objectVersion', 'sha256']);
  id(v.objectId); id(v.objectVersion); hex(v.sha256); return v as unknown as ArtifactReference; }
function scope(input: unknown): Scope { const v = record(input); exact(v, ['environment', 'tenantId', 'corpusId']); for (const field of Object.values(v)) id(field); return v as unknown as Scope; }
function binding(input: unknown): ArtifactRunBinding { const v = record(input); exact(v, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash']);
  validateArtifactAad({ ...v, artifactType: 'report', artifactId: 'publication-observation', caseId: null, ordinal: 0, schemaVersion: 'publication/v1' }); return v as unknown as ArtifactRunBinding; }
function scopeFrom(run: ArtifactRunBinding): Scope { return { environment: run.environment, tenantId: run.tenantId, corpusId: run.corpusId }; }
function trust(input: unknown): RagTrustLevel { if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(input as string)) throw new Error(); return input as RagTrustLevel; }
function collection(input: unknown): string { if (typeof input !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(input)) throw new Error(); return input; }
function document(input: unknown): { documentId: string; documentVersion: string; trustLevel: RagTrustLevel } { const v = record(input); exact(v, ['documentId', 'documentVersion', 'trustLevel']);
  return { documentId: opaqueId(v.documentId), documentVersion: opaqueId(v.documentVersion), trustLevel: trust(v.trustLevel) }; }
const documentKey = (v: { documentId: string; documentVersion: string }) => canonicalJson([v.documentId, v.documentVersion]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function documents(input: unknown): ReturnType<typeof document>[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 512) throw new Error(); const result = input.map(document);
  const seen = new Set<string>(); for (const value of result) { const key = documentKey(value); if (seen.has(key)) throw new Error(); seen.add(key); }
  return result.sort((a, b) => compare(a.documentId, b.documentId) || compare(a.documentVersion, b.documentVersion) || compare(a.trustLevel, b.trustLevel));
}
/** Structural, confidential identity only; does not authenticate its issuer. */
export function validatePublicationIdentity(input: unknown): { readonly productionAuthorized: false; readonly identity: PublicationIdentity; readonly identityHash: string } {
  try {
    const v = record(snapshot(input)); exact(v, ['schemaVersion', 'scope', 'graph', 'documents', 'milvus']); if (v.schemaVersion !== PUBLICATION_IDENTITY_SCHEMA) throw new Error(); scope(v.scope);
    const g = record(v.graph); exact(g, ['graphVersion', 'artifactDigest', 'pointerRevision']); id(g.graphVersion, 512); integer(g.pointerRevision, 1, Number.MAX_SAFE_INTEGER);
    if (typeof g.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(g.artifactDigest)) throw new Error();
    if (!Array.isArray(v.documents) || v.documents.length < 1 || v.documents.length > 512) throw new Error();
    const base = v.documents.map(inputDoc => { const d = record(inputDoc); exact(d, ['documentId', 'documentVersion', 'trustLevel', 'expectedChunkCount', 'contentManifestHash']);
      if (d.expectedChunkCount !== null) integer(d.expectedChunkCount, 1, 65536); if (d.contentManifestHash !== null) hex(d.contentManifestHash);
      if (d.expectedChunkCount === null && d.contentManifestHash === null) throw new Error();
      return document({ documentId: d.documentId, documentVersion: d.documentVersion, trustLevel: d.trustLevel }); });
    same(base, documents(base)); const m = record(v.milvus); exact(m, ['collection', 'schemaManifestHash', 'indexManifestHash']); collection(m.collection); hex(m.schemaManifestHash); hex(m.indexManifestHash);
    return freeze({ productionAuthorized: false as const, identity: v as unknown as PublicationIdentity, identityHash: canonicalJsonSha256(v) });
  } catch { throw new PublicationIdentityError('invalid-identity', 'configuration'); }
}
interface Chunk { chunkId: string; chunkIndex: number; contentSha256: string }
function chunksHash(chunks: readonly Chunk[]): string {
  // Stream canonical array members so a large complete document manifest is
  // not silently truncated by the single-object canonical JSON size bound.
  const hash = createHash('sha256'); hash.update('['); [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex || compare(a.chunkId, b.chunkId))
    .forEach((chunk, index) => { if (index) hash.update(','); hash.update(canonicalJson(chunk)); }); return hash.update(']').digest('hex');
}
function row(input: unknown): { documentId: string; documentVersion: string; trustLevel: RagTrustLevel; tenantId: string; corpusId: string; total: number; chunk: Chunk } {
  const v = record(input); exact(v, ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks']);
  if (typeof v.content !== 'string' || v.content.length < 1 || Buffer.byteLength(v.content, 'utf8') > 65536) throw new Error();
  return { documentId: opaqueId(v.document_id), documentVersion: opaqueId(v.document_version), trustLevel: trust(v.trust_level), tenantId: id(v.tenant_id), corpusId: id(v.corpus_id),
    total: integer(v.total_chunks, 1, 65536), chunk: { chunkId: opaqueId(v.id), chunkIndex: integer(v.chunk_index, 0, 65535), contentSha256: createHash('sha256').update(v.content).digest('hex') } };
}
export function publicationChunkManifestHash(input: unknown): string {
  try {
    if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > 65536) throw new Error();
    if (Reflect.ownKeys(input).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))) throw new Error();
    const rows = Array.from({ length: input.length }, (_, index) => { const d = Object.getOwnPropertyDescriptor(input, String(index)); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) throw new Error(); return row(snapshot(d.value)); });
    const first = rows[0]; const ids = new Set<string>(); const positions = new Set<number>();
    for (const value of rows) { if (documentKey(value) !== documentKey(first) || value.trustLevel !== first.trustLevel || value.tenantId !== first.tenantId || value.corpusId !== first.corpusId
      || value.total !== rows.length || ids.has(value.chunk.chunkId) || positions.has(value.chunk.chunkIndex) || value.chunk.chunkIndex >= rows.length) throw new Error();
      ids.add(value.chunk.chunkId); positions.add(value.chunk.chunkIndex); }
    return chunksHash(rows.map(v => v.chunk));
  } catch { throw new PublicationIdentityError('identity-mismatch', 'milvus'); }
}
function context(input: unknown): ArtifactOperationContext { const v = record(input); exact(v, ['executionProfile', 'binding', 'actorId', 'authorizationDigest', 'observedAt']);
  if (v.executionProfile !== 'local-reference') throw new Error(); binding(v.binding); id(v.actorId); hex(v.authorizationDigest); time(v.observedAt); return v as unknown as ArtifactOperationContext; }
function selector(input: unknown): PublicationSourceReadRequest['selector'] { const v = record(input); exact(v, ['scope', 'graphVersion', 'collection']); scope(v.scope); id(v.graphVersion, 512); collection(v.collection); return v as unknown as PublicationSourceReadRequest['selector']; }
function sourceRefs(input: unknown): Record<Source, ArtifactReference> { const v = record(input); exact(v, SOURCES); const ids = new Set<string>();
  for (const source of SOURCES) { const ref = reference(v[source]); if (ids.has(ref.objectId)) throw new Error(); ids.add(ref.objectId); } return v as unknown as Record<Source, ArtifactReference>; }
function request(input: unknown): PublicationSourceReadRequest { const v = record(snapshot(input)); exact(v, ['context', 'selector', 'requestNonce', 'cursor']);
  context(v.context); selector(v.selector); hex(v.requestNonce, 32); if (v.cursor !== null) hex(v.cursor); return v as unknown as PublicationSourceReadRequest; }

/** Volatile immutable, test-only source data. No real database, environment
 * authenticity, independent IAM, durable version pinning or measurements. */
export function createReferencePublicationSources(input: unknown): PublicationReadbackSources & { setAvailability(value: boolean): void } {
  let cfg: Fields; let run: ArtifactRunBinding; let selected: PublicationSourceReadRequest['selector']; let refs: Record<Source, ArtifactReference>;
  let starts: number; let ends: number; let limit: number; let size: number; let data: Fields;
  try {
    cfg = record(snapshot(input)); exact(cfg, ['executionProfile', 'binding', 'readerId', 'readerAuthorizationDigest', 'selector', 'sourceIdentityRefs', 'validFrom', 'validUntil', 'maxReads', 'pageSize', 'data']);
    if (cfg.executionProfile !== 'local-reference') throw new Error(); run = binding(cfg.binding); id(cfg.readerId); hex(cfg.readerAuthorizationDigest); selected = selector(cfg.selector); same(selected.scope, scopeFrom(run)); refs = sourceRefs(cfg.sourceIdentityRefs);
    starts = time(cfg.validFrom); ends = time(cfg.validUntil); if (ends <= starts || ends - starts > 86400000) throw new Error(); limit = integer(cfg.maxReads, 1, 4096); size = integer(cfg.pageSize, 1, 128);
    data = record(cfg.data); exact(data, SOURCES); const m = record(data.milvus); exact(m, ['scope', 'collection', 'schemaManifest', 'indexManifest', 'rows']);
    if (!Array.isArray(m.rows) || m.rows.length > 65536) throw new Error();
  } catch { throw new PublicationIdentityError('invalid-config', 'configuration'); }
  const m = record(data.milvus); const rows = m.rows as unknown[]; const cursors = new Map<string | null, number>([[null, 0]]);
  for (let offset = size; offset < rows.length; offset += size) cursors.set(canonicalJsonSha256({ binding: run, source: refs.milvus, offset }), offset);
  let available = true; const challenges = new Set<string>(); let lastTime = -Infinity;
  function read(inputRequest: unknown, source: Source): PublicationSourceReadback {
    if (!available) throw new PublicationIdentityError('source-unavailable', source); let r: PublicationSourceReadRequest; let offset = 0;
    try { r = request(inputRequest); same(r.context.binding, run); same(r.selector, selected);
      const observed = time(r.context.observedAt); if (r.context.actorId !== cfg.readerId || r.context.authorizationDigest !== cfg.readerAuthorizationDigest || observed < starts || observed >= ends || observed < lastTime) throw new Error();
      if (source !== 'milvus' && r.cursor !== null || source === 'milvus' && !cursors.has(r.cursor)) throw new Error(); if (source === 'milvus') offset = cursors.get(r.cursor)!;
    } catch { throw new PublicationIdentityError('invalid-request', source); }
    if (challenges.has(r.requestNonce)) throw new PublicationIdentityError('source-replay', source); if (challenges.size >= limit) throw new PublicationIdentityError('source-capacity', source);
    challenges.add(r.requestNonce); lastTime = time(r.context.observedAt);
    const next = offset + size < rows.length ? canonicalJsonSha256({ binding: run, source: refs.milvus, offset: offset + size }) : null;
    const observed = source !== 'milvus' ? data[source] : { scope: m.scope, collection: m.collection, schemaManifest: m.schemaManifest, indexManifest: m.indexManifest,
      rows: rows.slice(offset, offset + size), completion: next === null ? 'complete' : 'more', nextCursor: next };
    return freeze({ data: observed, proof: { schemaVersion: PUBLICATION_SOURCE_PROOF_SCHEMA, source, assurance: 'local-reference', productionSourceAuthenticated: false,
      sourceIdentityRef: refs[source], context: r.context, selector: r.selector, requestNonce: r.requestNonce, cursor: r.cursor, dataHash: canonicalJsonSha256(observed) } });
  }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false,
    async readPostgres(r: PublicationSourceReadRequest) { return read(r, 'postgres'); }, async readNeo4j(r: PublicationSourceReadRequest) { return read(r, 'neo4j'); },
    async readMilvusPage(r: PublicationSourceReadRequest) { return read(r, 'milvus'); }, setAvailability(value: boolean) { if (typeof value !== 'boolean') throw new PublicationIdentityError('invalid-request', 'preflight'); available = value; } });
}
type Call = (input: unknown) => unknown;
function descriptors(input: unknown): Fields { if (input === null || typeof input !== 'object' || types.isProxy(input)) throw new Error();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(); const keys = Reflect.ownKeys(input); if (keys.length > 16) throw new Error(); const v: Fields = Object.create(null);
  for (const key of keys) { if (typeof key !== 'string') throw new Error(); const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) throw new Error(); v[key] = d.value; } return v; }
function capture(input: unknown, methods: readonly string[]): Record<string, Call> { const v = descriptors(input); if (v.executionProfile !== 'local-reference' || v.productionCapable !== false) throw new Error();
  return Object.freeze(Object.fromEntries(methods.map(name => { const method = v[name]; if (typeof method !== 'function' || types.isProxy(method)) throw new Error(); return [name, (r: unknown) => Reflect.apply(method, input, [r])]; }))); }
function verifyGraphData(data: unknown, expected: PublicationIdentity, source: 'postgres' | 'neo4j'): void {
  const v = record(data); exact(v, source === 'postgres' ? ['scope', 'pointer', 'outbox', 'buildJob'] : ['scope', 'pointer', 'snapshot']); same(scope(v.scope), expected.scope);
  const pointer = record(v.pointer); exact(pointer, ['tenantId', 'corpusId', 'graphVersion', 'revision']); same(pointer, { tenantId: expected.scope.tenantId, corpusId: expected.scope.corpusId, graphVersion: expected.graph.graphVersion, revision: expected.graph.pointerRevision });
  if (source === 'postgres') { const outbox = record(v.outbox); exact(outbox, ['tenantId', 'corpusId', 'graphVersion', 'revision', 'eventType', 'publishedAt', 'deadLetteredAt']);
    same({ tenantId: outbox.tenantId, corpusId: outbox.corpusId, graphVersion: outbox.graphVersion, revision: outbox.revision }, pointer);
    if (outbox.eventType !== 'graph.snapshot.activated' || outbox.deadLetteredAt !== null) throw new Error(); time(outbox.publishedAt); }
  const graph = record(source === 'postgres' ? v.buildJob : v.snapshot); exact(graph, ['tenantId', 'corpusId', 'graphVersion', 'status', 'artifactDigest', 'documents']);
  same({ tenantId: graph.tenantId, corpusId: graph.corpusId, graphVersion: graph.graphVersion }, { tenantId: pointer.tenantId, corpusId: pointer.corpusId, graphVersion: pointer.graphVersion });
  if (graph.status !== (source === 'postgres' ? 'published' : 'active') || graph.artifactDigest !== expected.graph.artifactDigest) throw new Error();
  same(documents(graph.documents), expected.documents.map(({ documentId, documentVersion, trustLevel }) => ({ documentId, documentVersion, trustLevel })));
}

/** Two full row scans and fresh PG/Neo4j barriers observe consistency, not an
 * atomic/linearizable cross-database snapshot or permission to mutate. */
export function createReferencePublicationReadback(inputOptions: unknown, inputPorts: unknown): PublicationReadbackPort {
  let cfg: Fields; let run: ArtifactRunBinding; let expected: PublicationIdentity; let expectedRef: ArtifactReference; let refs: Record<Source, ArtifactReference>;
  let clock: Record<string, Call>; let sources: Record<string, Call>; let selected: PublicationSourceReadRequest['selector'];
  let starts: number; let ends: number; let maxPages: number; let maxRows: number; let maxAttempts: number; let timeout: number;
  try {
    cfg = record(snapshot(inputOptions)); exact(cfg, ['executionProfile', 'binding', 'expectedIdentity', 'expectedIdentityRef', 'readerId', 'readerAuthorizationDigest',
      'sourceIdentityRefs', 'clockIdentityRef', 'maxClockUncertaintyMs', 'observationWindow', 'operationTimeoutMs', 'maxVerifications', 'maxPages', 'maxRows']);
    if (cfg.executionProfile !== 'local-reference') throw new Error(); run = binding(cfg.binding); expected = validatePublicationIdentity(cfg.expectedIdentity).identity; same(expected.scope, scopeFrom(run));
    expectedRef = reference(cfg.expectedIdentityRef); if (expectedRef.sha256 !== canonicalJsonSha256(expected)) throw new Error(); id(cfg.readerId); hex(cfg.readerAuthorizationDigest); refs = sourceRefs(cfg.sourceIdentityRefs);
    reference(cfg.clockIdentityRef); integer(cfg.maxClockUncertaintyMs, 0, 60000); const window = record(cfg.observationWindow); exact(window, ['startsAt', 'endsAt']); starts = time(window.startsAt); ends = time(window.endsAt);
    // 512 full 128-row pages are required to reach the existing 65536-row
    // bound. Keep a finite proof-list budget within the canonical profile;
    // oversized/long-row scans still fail closed, never complete a prefix.
    if (ends <= starts || ends - starts > 86400000) throw new Error(); maxPages = integer(cfg.maxPages, 1, 1024); maxRows = integer(cfg.maxRows, 1, 65536); maxAttempts = integer(cfg.maxVerifications, 1, 64); timeout = integer(cfg.operationTimeoutMs, 1, 30000);
    const p = descriptors(inputPorts); exact(p, ['sources', 'clock']); sources = capture(p.sources, ['readPostgres', 'readNeo4j', 'readMilvusPage']); clock = capture(p.clock, ['readTime']);
    selected = freeze({ scope: expected.scope, graphVersion: expected.graph.graphVersion, collection: expected.milvus.collection });
  } catch { throw new PublicationIdentityError('invalid-config', 'configuration'); }
  const clockContext = freeze({ executionProfile: 'local-reference', binding: run, actorId: cfg.readerId });
  const challenges = new Set<string>(); let previous: AuthorityClockReading | null = null; let attempts = 0; let busy = false; let halted = false; let phase: Phase = 'preflight';
  const fail = (code: Code, pending = false) => new PublicationIdentityError(code, phase, pending);
  const challenge = () => { if (challenges.size >= maxAttempts * (9 + 4 * maxPages)) throw fail('attempt-capacity');
    for (let retry = 0; retry < 4; retry++) { const value = randomBytes(16).toString('hex'); if (!challenges.has(value)) { challenges.add(value); return value; } } throw fail('attempt-capacity'); };
  const observe = async (operation: () => unknown): Promise<unknown> => { if (halted) throw fail('halted'); const result = await boundedProviderCallWithRejection(operation, timeout); if (halted) throw fail('halted');
    if (result.status === 'timeout' || result.status === 'invalid-return') { halted = true;
      const pending = result.pendingCompletionUnknown || result.status === 'timeout' && Object.hasOwn(result, 'reason') && ownedUnknownFailureCode(result.reason) !== null;
      throw fail(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid', pending); }
    if (result.status === 'rejected') { const code = ownedUnknownFailureCode(result.reason); if (code !== null) { halted = true; throw fail(code, true); }
      throw fail('operation-failed'); } try { return snapshot(result.value); } catch { throw fail('invalid-readback'); } };
  const readClock = async () => { phase = 'clock'; const r = freeze({ context: clockContext, requestNonce: challenge() }); const actual = await observe(() => clock.readTime(r));
    try { const reading = validateAuthorityClockReading(actual, { request: r, sourceIdentityRef: cfg.clockIdentityRef, maxUncertaintyMs: cfg.maxClockUncertaintyMs, previousReading: previous }).reading;
      if (reading.assurance !== 'local-reference' || reading.productionTimeAuthenticated !== false || time(reading.observedAt) - reading.uncertaintyMs < starts || time(reading.observedAt) + reading.uncertaintyMs >= ends) throw new Error();
      previous = reading; return reading; } catch { throw fail('invalid-clock'); } };
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false,
    async readPublication(input: unknown): Promise<PublicationReadbackDecision> {
      if (halted) throw new PublicationIdentityError('halted', 'preflight'); if (busy) throw new PublicationIdentityError('busy', 'preflight');
      try { exact(record(snapshot(input)), []); } catch { throw new PublicationIdentityError('invalid-request', 'preflight'); }
      if (attempts >= maxAttempts) throw new PublicationIdentityError('attempt-capacity', 'preflight'); attempts++; busy = true;
      const readbacks: { source: Source; proofHash: string }[] = [];
      let latestAcknowledgedAt = -Infinity;
      const read = async (source: Source, cursor: string | null = null): Promise<unknown> => {
        const reading = await readClock(); phase = source; const r = freeze({ context: { executionProfile: 'local-reference', binding: run, actorId: cfg.readerId,
          authorizationDigest: cfg.readerAuthorizationDigest, observedAt: reading.observedAt }, selector: selected, requestNonce: challenge(), cursor });
        const raw = await observe(() => sources[{ postgres: 'readPostgres', neo4j: 'readNeo4j', milvus: 'readMilvusPage' }[source]](r));
        try { const value = record(raw); exact(value, ['data', 'proof']); const proof = record(value.proof);
          same(proof, { schemaVersion: PUBLICATION_SOURCE_PROOF_SCHEMA, source, assurance: 'local-reference', productionSourceAuthenticated: false,
            sourceIdentityRef: refs[source], context: r.context, selector: selected, requestNonce: r.requestNonce, cursor, dataHash: canonicalJsonSha256(value.data) });
          readbacks.push({ source, proofHash: canonicalJsonSha256(proof) }); return value.data;
        } catch { throw fail('invalid-readback'); }
      };
      const graph = async (source: 'postgres' | 'neo4j') => { const data = await read(source); try {
        verifyGraphData(data, expected, source);
        if (source === 'postgres') latestAcknowledgedAt = Math.max(latestAcknowledgedAt, time(record(record(data).outbox).publishedAt));
        return canonicalJsonSha256(data);
      } catch { throw fail('identity-mismatch'); } };
      const scan = async () => {
        const groups = new Map(expected.documents.map(doc => [documentKey(doc), { doc, chunks: new Map<number, Chunk>(), total: 0 }]));
        const chunkIds = new Set<string>(); const cursors = new Set<string>(); let cursor: string | null = null; let rowCount = 0; let pages = 0;
        for (;;) {
          if (pages++ >= maxPages) throw fail('read-limit'); const data = await read('milvus', cursor); let next: string | null;
          try {
            const v = record(data); exact(v, ['scope', 'collection', 'schemaManifest', 'indexManifest', 'rows', 'completion', 'nextCursor']); same(scope(v.scope), expected.scope);
            // A matching digest of an absent manifest is not readback evidence.
            // Keep the minimum record shape provider-neutral; adapters own SDK-specific semantics.
            for (const manifest of [v.schemaManifest, v.indexManifest]) if (Object.keys(record(manifest)).length === 0) throw new Error();
            if (v.collection !== expected.milvus.collection || canonicalJsonSha256(v.schemaManifest) !== expected.milvus.schemaManifestHash || canonicalJsonSha256(v.indexManifest) !== expected.milvus.indexManifestHash) throw new Error();
            if (!Array.isArray(v.rows) || v.rows.length > 128 || v.rows.length === 0 && v.completion !== 'complete') throw new Error();
            if (v.nextCursor !== null) hex(v.nextCursor); next = v.nextCursor as string | null;
            if (v.completion !== (next === null ? 'complete' : 'more') || next !== null && (next === cursor || cursors.has(next))) throw new Error();
            for (const inputRow of v.rows) {
              if (++rowCount > maxRows) throw fail('read-limit'); const value = row(inputRow); const group = groups.get(documentKey(value));
              if (!group || value.tenantId !== expected.scope.tenantId || value.corpusId !== expected.scope.corpusId || value.trustLevel !== group.doc.trustLevel
                || chunkIds.has(value.chunk.chunkId) || group.chunks.has(value.chunk.chunkIndex) || value.chunk.chunkIndex >= value.total || group.total !== 0 && group.total !== value.total) throw new Error();
              group.total = value.total; chunkIds.add(value.chunk.chunkId); group.chunks.set(value.chunk.chunkIndex, value.chunk);
            }
          } catch (error) { if (error instanceof PublicationIdentityError) throw error; throw fail('identity-mismatch'); }
          if (next === null) break; cursors.add(next); cursor = next;
        }
        try {
          const manifests = [...groups.values()].map(group => {
            if (group.chunks.size !== group.total || group.total < 1 || group.doc.expectedChunkCount !== null && group.total !== group.doc.expectedChunkCount) throw new Error();
            for (let index = 0; index < group.total; index++) if (!group.chunks.has(index)) throw new Error(); const contentManifestHash = chunksHash([...group.chunks.values()]);
            if (group.doc.contentManifestHash !== null && contentManifestHash !== group.doc.contentManifestHash) throw new Error();
            return { documentId: group.doc.documentId, documentVersion: group.doc.documentVersion, trustLevel: group.doc.trustLevel, chunkCount: group.total, contentManifestHash };
          }); return { rowCount, hash: canonicalJsonSha256(manifests) };
        } catch { throw fail('identity-mismatch'); }
      };
      try {
        const pgBefore = await graph('postgres'); const neoBefore = await graph('neo4j'); const first = await scan(); const second = await scan();
        if (first.hash !== second.hash || first.rowCount !== second.rowCount) throw fail('unstable-publication');
        const neoAfter = await graph('neo4j'); const pgAfter = await graph('postgres'); if (pgBefore !== pgAfter || neoBefore !== neoAfter) throw fail('unstable-publication');
        const completion = await readClock(); phase = 'final-validation';
        // An acknowledgement dated after the earliest possible real completion
        // has not been proven to precede this read, regardless of proof labels.
        if (latestAcknowledgedAt > time(completion.observedAt) - completion.uncertaintyMs) throw fail('identity-mismatch');
        const result = freeze({ schemaVersion: 'kg-publication-observation/v1' as const,
          validationLevel: 'local-reference-three-store-readback' as const, classification: 'confidential' as const, productionAuthorized: false as const,
          stageAcceptanceComplete: false as const, sourceAuthenticated: false as const, linearizableSnapshotProven: false as const, consistencyVerified: true as const,
          identityRef: expectedRef, identityHash: canonicalJsonSha256(expected), rowCount: first.rowCount, rowsManifestHash: first.hash,
          readbacks, completionClockHash: canonicalJsonSha256(completion), observedAt: completion.observedAt, uncertaintyMs: completion.uncertaintyMs });
        return freeze({ ...result, observationHash: canonicalJsonSha256(result) });
      } catch (error) { throw error instanceof PublicationIdentityError ? error : fail('identity-mismatch'); } finally { busy = false; }
    } });
}
