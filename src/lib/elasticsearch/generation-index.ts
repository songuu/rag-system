import { createHash } from 'node:crypto';
import { canonicalJson } from '../rag/eval/canonical-json';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import { buildElasticsearchLexicalMapping, type ElasticsearchLexicalDocument } from './lexical-index';

// Experimental storage primitives only. A successful observation does not fence
// a late writer and MUST NOT be used alone to authorize a production publication.
const MAX_GENERATION_CHUNKS = 1_000;
// Four clauses per pair plus scope/query clauses; keep well below common
// Elasticsearch boolean-clause budgets and fail rather than truncate a view.
const MAX_VIEW_PAIRS = 128;
// Match the issued publication view while keeping the single-generation cap.
const MAX_VIEW_CHUNKS = 4096;
const MAX_VIEW_BYTES = 24 * 1024 * 1024;
const MAX_GENERATION_BYTES = 4 * 1024 * 1024;
const READBACK_PAGE_SIZE = 16;
// This bounds returned hits, not the HTTP client's pre-decode response buffer.
const MAX_SEARCH_HITS = 100;
const SOURCE_FIELDS = ['chunk_id', 'tenant_id', 'corpus_id', 'document_id', 'document_version',
  'publication_generation', 'trust_level', 'content', 'source', 'page', 'start_offset', 'end_offset', 'metadata'];
const PIT_CLEANUP_FAILURE = 'Generation point-in-time close failed.';
const pitCleanupDiagnostics = new WeakMap<object, string>();

export interface GenerationIdentity {
  tenantId: string;
  corpusId: string;
  documentId: string;
  generation: string;
  documentVersion: string;
}
export interface GenerationPair {
  documentId: string;
  generation: string;
  documentVersion: string;
  /** Supplied by the authoritative publication manifest, not from ES. */
  chunks: readonly { chunkId: string; digest: string }[];
}
export interface GenerationDocument extends ElasticsearchLexicalDocument { publication_generation: string }
type Request = Record<string, unknown>;
type Options = { signal?: AbortSignal };
type SearchPort = { search(input: Request, options?: Options): Promise<unknown> };
type BulkPort = { bulk(input: Request, options?: Options): Promise<unknown> };
type DeletePort = { deleteByQuery(input: Request, options?: Options): Promise<unknown> };
type RefreshSearchPort = SearchPort & {
  indices: { refresh(input: { index: string }): Promise<unknown> };
  openPointInTime(input: Request, options?: Options): Promise<unknown>;
  closePointInTime(input: { id: string }): Promise<unknown>;
};

export class GenerationIndexError extends Error {
  readonly code = 'ELASTICSEARCH_GENERATION_INVALID';
  constructor(message: string) { super(message); this.name = 'GenerationIndexError'; }
}

/** A separate index is required: the legacy index has a strict v1 mapping. */
export function buildGenerationLexicalMapping() {
  const legacy = buildElasticsearchLexicalMapping();
  return { ...legacy, mappings: { ...legacy.mappings, properties: {
    ...legacy.mappings.properties, publication_generation: { type: 'keyword' },
  } } } as const;
}

/** Create is immutable. Conflicts only mean an existing ID; callers must read back. */
export async function writeGenerationDocuments(input: {
  client: BulkPort; indexName: string; identity: GenerationIdentity;
  documents: readonly ElasticsearchLexicalDocument[]; signal?: AbortSignal;
}): Promise<{ attempted: number; conflicts: number }> {
  const index = indexName(input.indexName);
  const identity = validateIdentity(input.identity);
  const documents = validateDocuments(identity, input.documents);
  const operations: Request[] = [];
  for (const document of documents) {
    operations.push({ create: { _index: index, _id: generationDocumentId(identity, document.chunk_id) } }, { ...document });
  }
  if (Buffer.byteLength(JSON.stringify({ operations }), 'utf8') > MAX_GENERATION_BYTES) {
    throw new GenerationIndexError('Generation bulk serialized byte budget exceeded.');
  }
  const result = object(body(await input.client.bulk({ operations, refresh: false }, { signal: input.signal })));
  if (!Array.isArray(result.items) || result.items.length !== documents.length || typeof result.errors !== 'boolean') {
    throw new GenerationIndexError('Elasticsearch generation bulk response is malformed.');
  }
  let conflicts = 0;
  for (const item of result.items) {
    const create = object(object(item).create);
    if (create.status === 409) conflicts++;
    else if (create.status !== 201) throw new GenerationIndexError('Elasticsearch generation bulk create failed.');
  }
  if (result.errors !== (conflicts > 0)) throw new GenerationIndexError('Elasticsearch generation bulk status is inconsistent.');
  return { attempted: documents.length, conflicts };
}

/** Only unreferenced, fenced generations may be deleted by an authorized caller. */
export async function deleteGenerationDocuments(input: {
  client: DeletePort; indexName: string; identity: GenerationIdentity; signal?: AbortSignal;
}): Promise<void> {
  const identity = validateIdentity(input.identity);
  const result = object(body(await input.client.deleteByQuery({
    index: indexName(input.indexName), conflicts: 'abort', refresh: true,
    query: { bool: { filter: identityFilters(identity) } },
  }, { signal: input.signal })));
  if (result.timed_out !== false || Number(result.version_conflicts) !== 0
    || !Array.isArray(result.failures) || result.failures.length !== 0) {
    throw new GenerationIndexError('Elasticsearch generation deletion was not confirmed.');
  }
}

/** The caller supplies an already-authorized, frozen view and must reauthorize it. */
export async function searchGenerationDocuments(input: {
  client: SearchPort; indexName: string; scope: RagRetrievalScope;
  pairs: readonly GenerationPair[]; query: string; topK: number; signal?: AbortSignal;
}): Promise<Array<{ document: GenerationDocument; score: number }>> {
  const scope = validateScope(input.scope);
  const pairs = validatePairs(input.pairs);
  const query = scalar(input.query, 'query', 8_000);
  if (!Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > MAX_SEARCH_HITS) {
    throw new GenerationIndexError('Invalid generation search limit.');
  }
  if (!pairs.length) return [];
  const result = object(body(await input.client.search({
    index: indexName(input.indexName), size: input.topK, track_total_hits: false, _source: SOURCE_FIELDS,
    query: { bool: {
      must: [{ multi_match: { query, fields: ['content', 'source^0.2'], type: 'best_fields' } }],
      filter: [
        { term: { tenant_id: scope.tenantId } }, { term: { corpus_id: scope.corpusId } },
        { terms: { trust_level: [...scope.allowedTrustLevels] } },
        { bool: { should: pairs.map(pair => ({ bool: { filter: [
          { term: { document_id: pair.documentId } }, { term: { publication_generation: pair.generation } },
          { term: { document_version: pair.documentVersion } }, { terms: { chunk_id: pair.chunks.map(chunk => chunk.chunkId) } },
        ] } })), minimum_should_match: 1 } },
      ],
    } },
  }, { signal: input.signal })));
  assertSearchComplete(result);
  const hits = object(result.hits).hits;
  if (!Array.isArray(hits) || hits.length > input.topK) throw new GenerationIndexError('Malformed generation search results.');
  const allowed = new Map(pairs.map(pair => [pairKey(pair.documentId, pair.generation), pair]));
  const ids = new Set<string>();
  let returnedBytes = 0;
  return hits.map(raw => {
    const hit = object(raw);
    const document = hitDocument(hit);
    returnedBytes += Buffer.byteLength(canonicalJson(document), 'utf8');
    if (returnedBytes > MAX_GENERATION_BYTES) throw new GenerationIndexError('Generation result byte budget exceeded.');
    const identity = { tenantId: scope.tenantId, corpusId: scope.corpusId,
      documentId: document.document_id, generation: document.publication_generation,
      documentVersion: document.document_version };
    const pair = allowed.get(pairKey(document.document_id, document.publication_generation));
    const manifestChunk = pair?.chunks.find(chunk => chunk.chunkId === document.chunk_id);
    if (document.tenant_id !== scope.tenantId || document.corpus_id !== scope.corpusId
      || !scope.allowedTrustLevels.includes(document.trust_level)
      || !pair || pair.documentVersion !== document.document_version || !manifestChunk
      || manifestChunk.digest !== generationDocumentDigest(document)
      || hit._id !== generationDocumentId(identity, document.chunk_id) || ids.has(String(hit._id))) {
      throw new GenerationIndexError('Generation search returned mismatched provenance.');
    }
    const score = hit._score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) throw new GenerationIndexError('Generation search returned an invalid score.');
    ids.add(String(hit._id));
    return { document, score };
  });
}

/**
 * Observes a bounded, refreshed generation and compares its exact content. This
 * is NOT a durable attestation: a late writer can mutate it after this returns.
 */
export async function observeGenerationDocuments(input: {
  client: RefreshSearchPort; indexName: string; identity: GenerationIdentity;
  documents: readonly ElasticsearchLexicalDocument[]; signal?: AbortSignal;
}): Promise<{ kind: 'point-in-time-observation'; count: number; digest: string; productionAuthorized: false }> {
  const index = indexName(input.indexName);
  const identity = validateIdentity(input.identity);
  const expected = validateDocuments(identity, input.documents);
  const refreshed = object(body(await input.client.indices.refresh({ index })));
  if (object(refreshed._shards).failed !== 0) throw new GenerationIndexError('Generation refresh failed.');
  const opened = object(body(await input.client.openPointInTime({ index, keep_alive: '1m',
    allow_partial_search_results: false }, { signal: input.signal })));
  let pitId = scalar(opened.id, 'point-in-time ID', 65_536);
  let primaryFailed = false;
  let primaryError: unknown;
  try {
  if (opened._shards !== undefined && object(opened._shards).failed !== 0) {
    throw new GenerationIndexError('Generation point-in-time has failed shards.');
  }
  const expectedById = new Map(expected.map(document => [generationDocumentId(identity, document.chunk_id), canonicalJson(document)]));
  const seen = new Set<string>();
  const seenSortValues = new Set<string>();
  let returnedBytes = 0;
  const returned: Array<{ hit: Request; document: GenerationDocument }> = [];
  let searchAfter: [string, number] | undefined;
  while (returned.length < expected.length) {
    const response = object(body(await input.client.search({
      pit: { id: pitId, keep_alive: '1m' }, size: READBACK_PAGE_SIZE, track_total_hits: true,
      sort: [{ chunk_id: 'asc' }, { _shard_doc: 'asc' }],
      _source: SOURCE_FIELDS,
      ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
      query: { bool: { filter: identityFilters(identity) } },
    }, { signal: input.signal })));
    pitId = scalar(response.pit_id, 'point-in-time ID', 65_536);
    assertSearchComplete(response);
    const hitsContainer = object(response.hits);
    const total = object(hitsContainer.total);
    const hits = hitsContainer.hits;
    if (total.relation !== 'eq' || total.value !== expected.length || !Array.isArray(hits)
      || hits.length < 1 || hits.length > READBACK_PAGE_SIZE || hits.length > expected.length - returned.length) {
      throw new GenerationIndexError('Generation readback is incomplete or has unexpected chunks.');
    }
    for (const raw of hits) {
      const hit = object(raw);
      const document = hitDocument(hit);
      if (!Array.isArray(hit.sort) || hit.sort.length !== 2 || hit.sort[0] !== document.chunk_id
        || !Number.isSafeInteger(hit.sort[1]) || Number(hit.sort[1]) < 0
        || seenSortValues.has(document.chunk_id)) throw new GenerationIndexError('Generation readback has invalid pagination.');
      seenSortValues.add(document.chunk_id);
      searchAfter = [document.chunk_id, Number(hit.sort[1])];
      returnedBytes += Buffer.byteLength(canonicalJson(document), 'utf8');
      if (returnedBytes > MAX_GENERATION_BYTES) throw new GenerationIndexError('Generation result byte budget exceeded.');
      returned.push({ hit, document });
    }
  }
  for (const { hit, document } of returned) {
    const id = scalar(hit._id, 'hit ID', 256);
    if (seen.has(id) || generationDocumentId(identity, document.chunk_id) !== id
      || expectedById.get(id) !== canonicalJson(document)) {
      throw new GenerationIndexError('Generation readback does not match its manifest.');
    }
    seen.add(id);
  }
  // Hash each row first so a complete 1,000-chunk manifest stays within the
  // canonical JSON profile's size bound, even when individual chunks are long.
  const rowDigests = [...expectedById.entries()].map(([id, value]) =>
    [id, createHash('sha256').update(value).digest('hex')]);
  rowDigests.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const digest = createHash('sha256').update(canonicalJson(rowDigests)).digest('hex');
  return { kind: 'point-in-time-observation', count: seen.size, digest, productionAuthorized: false };
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      const closed = object(body(await input.client.closePointInTime({ id: pitId })));
      if (closed.succeeded !== true) throw new GenerationIndexError(PIT_CLEANUP_FAILURE);
    } catch {
      if (!primaryFailed) throw new GenerationIndexError(PIT_CLEANUP_FAILURE);
      attachPitCleanupDiagnostic(primaryError);
    }
  }
}

/** Retrieves the redacted cleanup diagnostic, including for frozen errors. */
export function getPitCleanupDiagnostic(error: unknown): string | undefined {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  return pitCleanupDiagnostics.get(error as object);
}

function attachPitCleanupDiagnostic(error: unknown): void {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return;
  const target = error as object;
  pitCleanupDiagnostics.set(target, PIT_CLEANUP_FAILURE);
  try {
    Object.defineProperty(target, 'pitCleanupDiagnostic', { value: PIT_CLEANUP_FAILURE, configurable: true });
  } catch {
    // Frozen errors remain retrievable through getPitCleanupDiagnostic.
  }
}

function validateDocuments(identity: GenerationIdentity, documents: readonly ElasticsearchLexicalDocument[]): GenerationDocument[] {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > MAX_GENERATION_CHUNKS) {
    throw new GenerationIndexError('Invalid generation chunk count.');
  }
  const seen = new Set<string>();
  let serializedBytes = 0;
  return documents.map(input => {
    const document = object(input) as unknown as ElasticsearchLexicalDocument;
    const chunkId = scalar(document.chunk_id, 'chunk ID', 256);
    if (seen.has(chunkId) || document.tenant_id !== identity.tenantId || document.corpus_id !== identity.corpusId
      || document.document_id !== identity.documentId) throw new GenerationIndexError('Generation document identity is inconsistent.');
    seen.add(chunkId);
    if (scalar(document.document_version, 'document version', 256) !== identity.documentVersion) {
      throw new GenerationIndexError('Generation document version is inconsistent.');
    }
    if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(document.trust_level)) throw new GenerationIndexError('Invalid generation trust level.');
    if (typeof document.content !== 'string' || !document.content.trim() || document.content.length > 65_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(document.content)) throw new GenerationIndexError('Invalid generation content.');
    object(document.metadata);
    const allowed = new Set(['chunk_id', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'content', 'source', 'page', 'start_offset', 'end_offset', 'metadata']);
    if (Object.keys(document).some(key => !allowed.has(key))) throw new GenerationIndexError('Unexpected generation document field.');
    if (document.source !== undefined) scalar(document.source, 'source', 8_000);
    for (const value of [document.page, document.start_offset, document.end_offset]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new GenerationIndexError('Invalid generation document offset.');
    }
    const result = { ...document, publication_generation: identity.generation };
    serializedBytes += Buffer.byteLength(canonicalJson(result), 'utf8');
    if (serializedBytes > MAX_GENERATION_BYTES) throw new GenerationIndexError('Generation serialized byte budget exceeded.');
    return result;
  });
}

function hitDocument(hit: Request): GenerationDocument {
  const raw = object(hit._source);
  const identity = validateIdentity({ tenantId: raw.tenant_id as string, corpusId: raw.corpus_id as string,
    documentId: raw.document_id as string, generation: raw.publication_generation as string,
    documentVersion: raw.document_version as string });
  const { publication_generation: _generation, ...document } = raw;
  void _generation;
  return validateDocuments(identity, [document as unknown as ElasticsearchLexicalDocument])[0];
}
/** Computes a content digest for inclusion in a separately authorized manifest. */
export function generationDocumentDigest(document: GenerationDocument): string {
  return createHash('sha256').update(canonicalJson(hitDocument({ _source: document })), 'utf8').digest('hex');
}
function generationDocumentId(identity: GenerationIdentity, chunkId: string): string {
  return createHash('sha256').update(JSON.stringify([identity.tenantId, identity.corpusId, identity.documentId,
    identity.generation, scalar(chunkId, 'chunk ID', 256)])).digest('hex');
}
function identityFilters(identity: GenerationIdentity): Request[] {
  return [{ term: { tenant_id: identity.tenantId } }, { term: { corpus_id: identity.corpusId } },
    { term: { document_id: identity.documentId } }, { term: { publication_generation: identity.generation } }];
}
function validateIdentity(identity: GenerationIdentity): GenerationIdentity {
  return { tenantId: scalar(identity?.tenantId, 'tenant ID', 128), corpusId: scalar(identity?.corpusId, 'corpus ID', 128),
    documentId: scalar(identity?.documentId, 'document ID', 256), generation: generation(identity?.generation),
    documentVersion: scalar(identity?.documentVersion, 'document version', 256) };
}
function validateScope(scope: RagRetrievalScope): RagRetrievalScope {
  scalar(scope?.tenantId, 'tenant ID', 128); scalar(scope?.corpusId, 'corpus ID', 128);
  if (scope.enforceIsolation !== true || !Array.isArray(scope?.allowedTrustLevels) || !scope.allowedTrustLevels.length
    || scope.allowedTrustLevels.some(level => !['trusted', 'reviewed', 'external', 'quarantined'].includes(level))) {
    throw new GenerationIndexError('Invalid generation retrieval scope.');
  }
  return scope;
}
function validatePairs(pairs: readonly GenerationPair[]): GenerationPair[] {
  if (!Array.isArray(pairs) || pairs.length > MAX_VIEW_PAIRS) throw new GenerationIndexError('Generation view capacity exceeded.');
  const seen = new Set<string>();
  let totalChunks = 0;
  const result = pairs.map(pair => {
    if (!Array.isArray(pair?.chunks) || pair.chunks.length < 1 || pair.chunks.length > MAX_GENERATION_CHUNKS) {
      throw new GenerationIndexError('Generation view requires a bounded chunk manifest.');
    }
    const chunkIds = new Set<string>();
    const chunks = pair.chunks.map((chunk: GenerationPair['chunks'][number]) => {
      const chunkId = scalar(chunk?.chunkId, 'chunk ID', 256);
      if (chunkIds.has(chunkId) || typeof chunk.digest !== 'string' || !/^[0-9a-f]{64}$/.test(chunk.digest)) {
        throw new GenerationIndexError('Invalid generation chunk manifest.');
      }
      chunkIds.add(chunkId);
      return { chunkId, digest: chunk.digest };
    });
    totalChunks += chunks.length;
    if (totalChunks > MAX_VIEW_CHUNKS) throw new GenerationIndexError('Generation view chunk capacity exceeded.');
    const result = { documentId: scalar(pair?.documentId, 'document ID', 256), generation: generation(pair?.generation),
      documentVersion: scalar(pair?.documentVersion, 'document version', 256), chunks };
    if (seen.has(result.documentId)) throw new GenerationIndexError('Generation view must contain at most one generation per document.');
    seen.add(result.documentId);
    return result;
  });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_VIEW_BYTES) throw new GenerationIndexError('Generation view byte budget exceeded.');
  return result;
}
function pairKey(documentId: string, value: string): string { return JSON.stringify([documentId, value]); }
function generation(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > BigInt('9223372036854775807')) {
    throw new GenerationIndexError('Invalid publication generation.');
  }
  return value;
}
function indexName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(value)) throw new GenerationIndexError('Invalid generation index name.');
  return value;
}
function scalar(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GenerationIndexError(`Invalid ${name}.`);
  }
  return value;
}
function object(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GenerationIndexError('Malformed Elasticsearch generation response.');
  return value as Request;
}
function assertSearchComplete(result: Request): void {
  if (result.timed_out !== false || object(result._shards).failed !== 0) {
    throw new GenerationIndexError('Elasticsearch generation search was incomplete.');
  }
}
function body(value: unknown): unknown {
  return value && typeof value === 'object' && 'body' in value ? (value as Request).body : value;
}
