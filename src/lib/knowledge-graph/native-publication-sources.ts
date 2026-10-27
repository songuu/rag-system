import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from '../rag/eval/canonical-json';
import { validateArtifactAad } from '../rag/eval/production-controlled-artifacts';
import type { ArtifactRunBinding } from '../rag/eval/production-controlled-artifacts';
import type { ArtifactReference } from '../rag/eval/production-gate-manifest';
import { PUBLICATION_SOURCE_PROOF_SCHEMA, PublicationIdentityError } from './publication-identity';
import type { PublicationReadbackSources, PublicationSourceReadRequest, PublicationSourceReadback } from './publication-identity';
import { PostgresKnowledgeGraphPublicationReadback } from './postgres-publication-readback';
import { Neo4jKnowledgeGraphPublicationReadback } from './neo4j-publication-readback';
import { MilvusKnowledgeGraphPublicationReadback } from './milvus-publication-readback';
import type { MilvusPublicationData } from './milvus-publication-readback';

type Fields = Record<string, unknown>;
type Source = 'postgres' | 'neo4j' | 'milvus';
type Scope = Pick<ArtifactRunBinding, 'environment' | 'tenantId' | 'corpusId'>;
type NativeCall = (request: unknown) => Promise<unknown>;
const MAX_REPLY_BYTES = 128 * 1024;
const SOURCES = ['postgres', 'neo4j', 'milvus'] as const;

function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function snapshot(value: unknown): unknown { return freeze(JSON.parse(canonicalJson(value))); }
function record(value: unknown): Fields {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const result: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) { if (typeof key !== 'string') throw new Error(); const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) throw new Error(); result[key] = d.value; }
  return result;
}
function exact(value: Fields, names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error(); }
function identifier(value: unknown, maximum = 128): string { if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(); return value; }
function hex(value: unknown, length = 64): string { if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/.test(value)) throw new Error(); return value; }
function integer(value: unknown, maximum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(); return value; }
function time(value: unknown): number { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(); return Date.parse(value); }
function same(a: unknown, b: unknown): void { if (canonicalJson(a) !== canonicalJson(b)) throw new Error(); }
function reference(value: unknown): ArtifactReference { const ref = record(value); exact(ref, ['objectId', 'objectVersion', 'sha256']);
  identifier(ref.objectId); identifier(ref.objectVersion); hex(ref.sha256); return Object.freeze(ref) as unknown as ArtifactReference; }
function nativeMethod(prototype: object): NativeCall {
  const d = Object.getOwnPropertyDescriptor(prototype, 'readPublication');
  if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'function' || types.isProxy(d.value)) throw new Error(); return d.value as NativeCall;
}
// Capture before any caller-controlled client can participate in construction.
const POSTGRES_READ = nativeMethod(PostgresKnowledgeGraphPublicationReadback.prototype);
const NEO4J_READ = nativeMethod(Neo4jKnowledgeGraphPublicationReadback.prototype);
const MILVUS_READ = nativeMethod(MilvusKnowledgeGraphPublicationReadback.prototype);

/** Native business-data binding, not environment/source authentication. Clients
 * may still be fake, so every proof remains explicitly local-reference. The
 * actual two scans/barriers belong to the existing PublicationIdentity reader. */
export function createNativePublicationSources(inputOptions: unknown, inputClients: unknown): PublicationReadbackSources {
  let cfg: Fields; let run: ArtifactRunBinding; let scope: Scope; let selected: PublicationSourceReadRequest['selector']; let refs: Record<Source, ArtifactReference>;
  let starts: number; let ends: number; let readLimit: number; let pageSize: number;
  let native: Readonly<Record<Source, () => Promise<unknown>>>;
  try {
    cfg = record(snapshot(inputOptions)); exact(cfg, ['executionProfile', 'binding', 'readerId', 'readerAuthorizationDigest', 'selector', 'sourceIdentityRefs', 'validFrom', 'validUntil', 'maxReads', 'pageSize', 'native']);
    if (cfg.executionProfile !== 'local-reference') throw new Error(); const binding = record(cfg.binding); exact(binding, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash']);
    validateArtifactAad({ ...binding, artifactType: 'report', artifactId: 'publication-observation', caseId: null, ordinal: 0, schemaVersion: 'publication/v1' });
    run = binding as unknown as ArtifactRunBinding; scope = freeze({ environment: identifier(run.environment), tenantId: identifier(run.tenantId), corpusId: identifier(run.corpusId) });
    identifier(cfg.readerId); hex(cfg.readerAuthorizationDigest); const selector = record(cfg.selector); exact(selector, ['scope', 'graphVersion', 'collection']);
    same(selector.scope, scope); identifier(selector.graphVersion, 512);
    if (typeof selector.collection !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(selector.collection)) throw new Error();
    selected = cfg.selector as PublicationSourceReadRequest['selector']; const identities = record(cfg.sourceIdentityRefs); exact(identities, SOURCES);
    const seenRefs = new Set<string>(); refs = Object.fromEntries(SOURCES.map(source => { const ref = reference(identities[source]);
      if (seenRefs.has(ref.objectId)) throw new Error(); seenRefs.add(ref.objectId); return [source, ref]; })) as Record<Source, ArtifactReference>;
    starts = time(cfg.validFrom); ends = time(cfg.validUntil); if (ends <= starts || ends - starts > 86400000) throw new Error();
    readLimit = integer(cfg.maxReads, 4096); pageSize = integer(cfg.pageSize, 128);
    const limits = record(cfg.native); exact(limits, ['operationTimeoutMs', 'maxReads', 'milvus']);
    const milvus = record(limits.milvus); exact(milvus, ['pageSize', 'maxRows', 'maxTotalRowBytes', 'maxQueryParameterBytes']);
    const clients = record(inputClients); exact(clients, SOURCES);
    const options = { executionProfile: 'local-reference', scope, operationTimeoutMs: limits.operationTimeoutMs, maxReads: limits.maxReads };
    const pg = new PostgresKnowledgeGraphPublicationReadback(clients.postgres as ConstructorParameters<typeof PostgresKnowledgeGraphPublicationReadback>[0], options);
    const neo = new Neo4jKnowledgeGraphPublicationReadback(clients.neo4j as ConstructorParameters<typeof Neo4jKnowledgeGraphPublicationReadback>[0], options);
    const mil = new MilvusKnowledgeGraphPublicationReadback(clients.milvus, { ...options, collection: selected.collection, ...milvus });
    native = Object.freeze({ postgres: () => Reflect.apply(POSTGRES_READ, pg, [{}]), neo4j: () => Reflect.apply(NEO4J_READ, neo, [{}]), milvus: () => Reflect.apply(MILVUS_READ, mil, [{}]) });
  } catch { throw new PublicationIdentityError('invalid-config', 'configuration'); }
  const challenges = new Set<string>(); let lastTime = -Infinity; let busy = false; let halted = false;
  let scan: { readonly bulk: MilvusPublicationData; offset: number; cursor: string | null } | null = null;

  function failure(error: unknown, source: Source): PublicationIdentityError {
    // Public error shapes have no unforgeable provenance. Use their own data
    // only for conservative stopping, never to grant trust or authorization.
    let code: string; let pending: boolean;
    try {
      if (!error || typeof error !== 'object' || types.isProxy(error)) throw new Error();
      const own = (name: string): unknown => { const d = Object.getOwnPropertyDescriptor(error, name); if (!d || !Object.hasOwn(d, 'value')) throw new Error(); return d.value; };
      const value = own('code'); const completion = own('pendingCompletionUnknown');
      if (typeof value !== 'string' || value.length > 64 || typeof completion !== 'boolean' || own('productionAuthorized') !== false || own('automaticRetryAllowed') !== false) throw new Error();
      code = value; pending = completion;
    } catch { halted = true; scan = null; return new PublicationIdentityError('provider-contract-invalid', source, true); }
    if (pending || ['query-timeout', 'provider-contract-invalid', 'halted'].includes(code)) { halted = true; scan = null; }
    const mapped = code === 'query-timeout' ? 'operation-timeout' : code === 'provider-contract-invalid' ? 'provider-contract-invalid'
      : code === 'halted' ? 'halted' : code === 'busy' ? 'busy' : code === 'read-limit' ? 'read-limit'
        : ['row-capacity', 'parameter-capacity'].includes(code) ? 'source-capacity' : code === 'invalid-readback' ? 'invalid-readback' : 'operation-failed';
    return new PublicationIdentityError(mapped, source, pending);
  }
  function admit(input: unknown, source: Source): PublicationSourceReadRequest {
    if (halted) throw new PublicationIdentityError('halted', source); if (busy) throw new PublicationIdentityError('busy', source);
    let request: PublicationSourceReadRequest;
    try {
      const r = record(snapshot(input)); exact(r, ['context', 'selector', 'requestNonce', 'cursor']); const context = record(r.context);
      exact(context, ['executionProfile', 'binding', 'actorId', 'authorizationDigest', 'observedAt']);
      if (context.executionProfile !== 'local-reference' || context.actorId !== cfg.readerId || context.authorizationDigest !== cfg.readerAuthorizationDigest) throw new Error();
      same(context.binding, run); same(r.selector, selected); hex(r.requestNonce, 32);
      const observed = time(context.observedAt); if (observed < starts || observed >= ends || observed < lastTime) throw new Error();
      if (source !== 'milvus' && r.cursor !== null) throw new Error();
      if (source === 'milvus') {
        if (r.cursor === null) { if (scan !== null) throw new Error(); }
        else { hex(r.cursor); if (scan === null || scan.cursor !== r.cursor) throw new Error(); }
      }
      request = r as unknown as PublicationSourceReadRequest;
    } catch { throw new PublicationIdentityError('invalid-request', source); }
    if (challenges.has(request.requestNonce)) throw new PublicationIdentityError('source-replay', source);
    if (challenges.size >= readLimit) throw new PublicationIdentityError('source-capacity', source);
    // Spend the nonce before business dispatch, including a known failed read.
    challenges.add(request.requestNonce); lastTime = time(request.context.observedAt); return request;
  }
  function reply(source: Source, request: PublicationSourceReadRequest, data: unknown, dataHash = canonicalJsonSha256(data)): PublicationSourceReadback {
    return Object.freeze({ data, proof: Object.freeze({ schemaVersion: PUBLICATION_SOURCE_PROOF_SCHEMA, source, assurance: 'local-reference',
      productionSourceAuthenticated: false, sourceIdentityRef: refs[source], context: request.context, selector: selected,
      requestNonce: request.requestNonce, cursor: request.cursor, dataHash }) });
  }
  function boundedReply(source: Source, request: PublicationSourceReadRequest, data: unknown): PublicationSourceReadback {
    try { const result = reply(source, request, data); if (Buffer.byteLength(canonicalJson(result), 'utf8') >= MAX_REPLY_BYTES) throw new Error(); return result; }
    catch { scan = null; throw new PublicationIdentityError('source-capacity', source); }
  }
  function page(request: PublicationSourceReadRequest): PublicationSourceReadback {
    const active = scan!; const { rows: allRows, ...base } = active.bulk;
    try {
      const worstData = { ...base, rows: [], completion: 'more', nextCursor: '0'.repeat(64) };
      let bytes = Buffer.byteLength(canonicalJson(reply('milvus', request, worstData, '0'.repeat(64))), 'utf8');
      const rows: MilvusPublicationData['rows'][number][] = []; let nextOffset = active.offset;
      for (; nextOffset < allRows.length && rows.length < pageSize; nextOffset++) {
        const additional = Buffer.byteLength(canonicalJson(allRows[nextOffset]), 'utf8') + Number(rows.length > 0);
        if (bytes + additional >= MAX_REPLY_BYTES) break; bytes += additional; rows.push(allRows[nextOffset]);
      }
      if (!rows.length) throw new Error();
      const nextCursor = nextOffset < allRows.length ? randomBytes(32).toString('hex') : null;
      const data = Object.freeze({ ...base, rows: Object.freeze(rows), completion: nextCursor === null ? 'complete' : 'more', nextCursor });
      const result = boundedReply('milvus', request, data);
      // Only a successfully encoded full page consumes the previous cursor.
      if (nextCursor === null) scan = null; else { active.offset = nextOffset; active.cursor = nextCursor; }
      return result;
    } catch { scan = null; throw new PublicationIdentityError('source-capacity', 'milvus'); }
  }
  async function read(input: unknown, source: Source): Promise<PublicationSourceReadback> {
    const request = admit(input, source); busy = true;
    try {
      if (source === 'milvus' && request.cursor !== null) return page(request);
      let data: unknown; try { data = await native[source](); } catch (error) { throw failure(error, source); }
      if (halted) throw new PublicationIdentityError('halted', source);
      if (source !== 'milvus') return boundedReply(source, request, data);
      // These are outputs of our directly constructed native adapter, not a
      // caller-supplied business-data fixture. Never clone/snapshot the bulk.
      scan = { bulk: data as MilvusPublicationData, offset: 0, cursor: null }; return page(request);
    } finally { busy = false; }
  }
  return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false,
    readPostgres(request: PublicationSourceReadRequest) { return read(request, 'postgres'); },
    readNeo4j(request: PublicationSourceReadRequest) { return read(request, 'neo4j'); },
    readMilvusPage(request: PublicationSourceReadRequest) { return read(request, 'milvus'); } });
}
