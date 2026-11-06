import { createHash, randomBytes } from 'node:crypto';
import type { ElasticsearchLexicalDocument } from './lexical-index';
import {
  buildGenerationLexicalMapping,
  generationDocumentDigest,
  type GenerationIdentity,
} from './generation-index';
import { canonicalJson } from '../rag/eval/canonical-json';

// Experimental, in-process capability: never accepts a caller-selected index.
// Elasticsearch's block API addresses names, not UUIDs. Its safety requires
// trusted administrators not to delete/recreate or unblock the index between
// checks; UUID rechecks detect, but cannot undo, such a concurrent replacement.
// This is not a durable seal, trusted access policy, or production attestation.
type Response = Record<string, unknown>;
type SealClient = {
  search(input: Response, options?: { signal?: AbortSignal }): Promise<unknown>;
  openPointInTime(input: Response, options?: { signal?: AbortSignal }): Promise<unknown>;
  closePointInTime(input: { id: string }): Promise<unknown>;
  indices: {
    refresh(input: { index: string }): Promise<unknown>;
    create(input: { index: string; mappings: Response }): Promise<unknown>;
    get(input: { index: string; allow_no_indices: false; ignore_unavailable: false; expand_wildcards: 'none' }): Promise<unknown>;
    addBlock(input: { index: string; block: 'write'; allow_no_indices: false; ignore_unavailable: false; expand_wildcards: 'none' }): Promise<unknown>;
  };
};

export interface OwnedGenerationIndex {
  readonly indexName: string;
  readonly indexUuid: string;
}

/** Persist this value before create; it permits inspection, never mutation. */
export interface GenerationIndexOperation {
  readonly version: 1;
  readonly indexName: string;
  readonly marker: string;
  readonly identity: GenerationIdentity;
}

interface State {
  client: SealClient;
  identity: GenerationIdentity;
  marker: string;
  indexName: string;
  indexUuid: string;
  consumed: boolean;
}

const capabilities = new WeakMap<OwnedGenerationIndex, State>();
const pitCleanupDiagnostics = new WeakMap<object, string>();
const PIT_CLEANUP_FAILURE = 'Generation seal PIT close failed.';

/** Returns a redacted cleanup diagnostic without changing the primary error. */
export function getGenerationSealPitCleanupDiagnostic(error: unknown): string | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? pitCleanupDiagnostics.get(error as object) : undefined;
}

function attachPitCleanupDiagnostic(error: unknown): void {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return;
  const target = error as object;
  pitCleanupDiagnostics.set(target, PIT_CLEANUP_FAILURE);
  try { Object.defineProperty(target, 'pitCleanupDiagnostic', { value: PIT_CLEANUP_FAILURE, configurable: true }); }
  catch { /* Frozen errors remain retrievable through the WeakMap. */ }
}

export class GenerationSealError extends Error {
  readonly code = 'ELASTICSEARCH_GENERATION_SEAL_FAILED';
  constructor(message: string) { super(message); this.name = 'GenerationSealError'; }
}

/** Prepare and durably save this operation before making any ES create request. */
export function prepareGenerationIndexOperation(identityInput: GenerationIdentity): GenerationIndexOperation {
  const identity = copyIdentity(identityInput);
  const indexName = `codex-generation-seal-${randomBytes(16).toString('hex')}`;
  const marker = createHash('sha256').update(JSON.stringify([identity, randomBytes(32).toString('hex')])).digest('hex');
  return Object.freeze({ version: 1, indexName, marker, identity });
}

/** Only inspection is permitted after unknown create completion; never delete by name. */
export async function inspectGenerationIndexOperation(input: {
  client: SealClient;
  operation: GenerationIndexOperation;
}): Promise<{ kind: 'matching-marker'; indexName: string; indexUuid: string } | { kind: 'not-visible' }> {
  const operation = copyOperation(input.operation);
  try {
    const found = await readIndex(input.client, operation.indexName, operation.marker);
    return { kind: 'matching-marker', indexName: operation.indexName, indexUuid: found.uuid };
  } catch (error) {
    const value = error && typeof error === 'object' ? error as { statusCode?: unknown; meta?: { statusCode?: unknown } } : {};
    if (value.statusCode === 404 || value.meta?.statusCode === 404) return { kind: 'not-visible' };
    throw error;
  }
}

/** Creates a new prepared physical index. It never attaches to an existing index. */
export async function createOwnedGenerationIndex(input: {
  client: SealClient;
  operation: GenerationIndexOperation;
}): Promise<OwnedGenerationIndex> {
  const { identity, indexName, marker } = copyOperation(input.operation);
  const mapping = buildGenerationLexicalMapping().mappings;
  const created = object(body(await input.client.indices.create({ index: indexName,
    mappings: { ...mapping, _meta: { generation_owner: marker } } })));
  if (created.acknowledged !== true || created.index !== indexName) {
    throw new GenerationSealError('Generation index creation was not acknowledged.');
  }
  const initial = await readIndex(input.client, indexName, marker);
  if (initial.writeBlocked) throw new GenerationSealError('New generation index is unexpectedly write-blocked.');
  const handle = Object.freeze({ indexName, indexUuid: initial.uuid });
  capabilities.set(handle, { client: input.client, identity, marker, indexName, indexUuid: initial.uuid, consumed: false });
  return handle;
}

/**
 * Adds the dedicated write block API and observes the expected manifest in one
 * PIT. Failed or uncertain operations consume the handle; callers must abandon
 * the index rather than assuming a retry is safe. The return value is explicitly
 * non-production because admin isolation and global publication are not proven.
 */
export async function sealOwnedGenerationIndex(input: {
  client: SealClient;
  handle: OwnedGenerationIndex;
  documents: readonly ElasticsearchLexicalDocument[];
  signal?: AbortSignal;
}): Promise<{ indexName: string; indexUuid: string; productionAuthorized: false;
  observation: { kind: 'point-in-time-observation'; count: number; digest: string; productionAuthorized: false } }> {
  const state = capabilities.get(input.handle);
  if (!state || state.consumed || state.client !== input.client) throw new GenerationSealError('Invalid or consumed generation index handle.');
  state.consumed = true;
  if (input.signal?.aborted) throw input.signal.reason ?? new GenerationSealError('Generation seal was aborted.');
  const before = await readIndex(state.client, state.indexName, state.marker);
  if (before.uuid !== state.indexUuid || before.writeBlocked) throw new GenerationSealError('Generation index identity changed before blocking.');
  const blocked = object(body(await state.client.indices.addBlock({
    index: state.indexName, block: 'write', allow_no_indices: false, ignore_unavailable: false, expand_wildcards: 'none',
  })));
  if (blocked.acknowledged !== true || blocked.shards_acknowledged !== true || !Array.isArray(blocked.indices)
    || blocked.indices.length !== 1 || object(blocked.indices[0]).name !== state.indexName
    || object(blocked.indices[0]).blocked !== true) throw new GenerationSealError('Generation write block was not fully acknowledged.');
  const afterBlock = await readIndex(state.client, state.indexName, state.marker);
  if (afterBlock.uuid !== state.indexUuid || !afterBlock.writeBlocked) throw new GenerationSealError('Generation index identity changed after blocking.');
  const refreshed = object(body(await state.client.indices.refresh({ index: state.indexName })));
  if (object(refreshed._shards).failed !== 0) throw new GenerationSealError('Generation index refresh failed.');
  const observation = await observeEntireIndex(state.client, state.indexName, state.identity, input.documents, input.signal);
  const afterObservation = await readIndex(state.client, state.indexName, state.marker);
  if (afterObservation.uuid !== state.indexUuid || !afterObservation.writeBlocked) {
    throw new GenerationSealError('Generation index identity changed during observation.');
  }
  return { indexName: state.indexName, indexUuid: state.indexUuid, productionAuthorized: false, observation };
}

/** Read-only reconciliation: never refresh, block, create or modify an index.
 * The returned observation describes this read window, not a new durable seal. */
export async function observeSealedGenerationIndex(input: {
  client: SealClient; indexName: string; indexUuid: string; ownerMarker: string;
  identity: GenerationIdentity; documents: readonly ElasticsearchLexicalDocument[]; signal?: AbortSignal;
}) {
  if (!/^codex-generation-seal-[a-f0-9]{32}$/.test(input.indexName)
    || !/^[a-f0-9]{64}$/.test(input.ownerMarker)) throw new GenerationSealError('Invalid sealed index identity.');
  const identity = copyIdentity(input.identity);
  const expectedUuid = scalar(input.indexUuid, 'index UUID', 128);
  const assertIdentity = async () => {
    input.signal?.throwIfAborted();
    const current = await readIndex(input.client, input.indexName, input.ownerMarker);
    if (current.uuid !== expectedUuid || !current.writeBlocked) throw new GenerationSealError('Sealed index identity or write block changed.');
  };
  await assertIdentity();
  const observation = await observeEntireIndex(input.client, input.indexName, identity, input.documents, input.signal);
  await assertIdentity();
  return observation;
}

/** Every document in the physical index must match the expected manifest in the same PIT. */
async function observeEntireIndex(client: SealClient, index: string, identity: GenerationIdentity,
  documents: readonly ElasticsearchLexicalDocument[], signal?: AbortSignal): Promise<{
    kind: 'point-in-time-observation'; count: number; digest: string; productionAuthorized: false;
  }> {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 1_000) throw new GenerationSealError('Invalid generation manifest.');
  const expected = new Map<string, { chunkId: string; digest: string }>();
  let bytes = 0;
  for (const item of documents) {
    if (item.tenant_id !== identity.tenantId || item.corpus_id !== identity.corpusId
      || item.document_id !== identity.documentId || item.document_version !== identity.documentVersion) {
      throw new GenerationSealError('Generation manifest identity is inconsistent.');
    }
    const document = { ...item, publication_generation: identity.generation };
    const chunkId = scalar(item.chunk_id, 'chunk ID', 256);
    const id = createHash('sha256').update(JSON.stringify([identity.tenantId, identity.corpusId,
      identity.documentId, identity.generation, chunkId])).digest('hex');
    if (expected.has(id)) throw new GenerationSealError('Duplicate generation manifest chunk.');
    bytes += Buffer.byteLength(canonicalJson(document), 'utf8');
    if (bytes > 4 * 1024 * 1024) throw new GenerationSealError('Generation manifest exceeds byte budget.');
    expected.set(id, { chunkId, digest: generationDocumentDigest(document) });
  }
  const opened = object(body(await client.openPointInTime({ index, keep_alive: '1m', allow_partial_search_results: false }, { signal })));
  let pitId = scalar(opened.id, 'point-in-time ID', 65_536);
  let failed = false;
  let primaryError: unknown;
  try {
    if (opened._shards !== undefined && object(opened._shards).failed !== 0) throw new GenerationSealError('Generation PIT has failed shards.');
    const seen = new Set<string>();
    let after: [string, number] | undefined;
    let returnedBytes = 0;
    while (seen.size < expected.size) {
      const response = object(body(await client.search({ pit: { id: pitId, keep_alive: '1m' }, size: 16,
        track_total_hits: true, sort: [{ chunk_id: 'asc' }, { _shard_doc: 'asc' }],
        _source: ['chunk_id', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'publication_generation',
          'trust_level', 'content', 'source', 'page', 'start_offset', 'end_offset', 'metadata'],
        query: { match_all: {} }, ...(after ? { search_after: after } : {}) }, { signal })));
      pitId = scalar(response.pit_id, 'point-in-time ID', 65_536);
      if (response.timed_out !== false || object(response._shards).failed !== 0) throw new GenerationSealError('Generation readback was incomplete.');
      const container = object(response.hits); const total = object(container.total); const hits = container.hits;
      if (total.relation !== 'eq' || total.value !== expected.size || !Array.isArray(hits)
        || hits.length < 1 || hits.length > 16 || hits.length > expected.size - seen.size) {
        throw new GenerationSealError('Physical index contents do not match the generation manifest.');
      }
      for (const raw of hits) {
        const hit = object(raw); const id = scalar(hit._id, 'hit ID', 256); const doc = object(hit._source);
        const entry = expected.get(id);
        if (!entry || seen.has(id) || doc.chunk_id !== entry.chunkId
          || generationDocumentDigest(doc as unknown as Parameters<typeof generationDocumentDigest>[0]) !== entry.digest) {
          throw new GenerationSealError('Physical index contains an unexpected or modified chunk.');
        }
        if (!Array.isArray(hit.sort) || hit.sort.length !== 2 || hit.sort[0] !== entry.chunkId
          || !Number.isSafeInteger(hit.sort[1]) || Number(hit.sort[1]) < 0) throw new GenerationSealError('Invalid generation PIT pagination.');
        returnedBytes += Buffer.byteLength(canonicalJson(doc), 'utf8');
        if (returnedBytes > 4 * 1024 * 1024) throw new GenerationSealError('Generation observation exceeds byte budget.');
        after = [entry.chunkId, Number(hit.sort[1])]; seen.add(id);
      }
    }
    const rows = [...expected.entries()].map(([id, item]) => [id, item.digest]);
    rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { kind: 'point-in-time-observation', count: seen.size,
      digest: createHash('sha256').update(canonicalJson(rows)).digest('hex'), productionAuthorized: false };
  } catch (error) { failed = true; primaryError = error; throw error; }
  finally {
    try {
      const closed = object(body(await client.closePointInTime({ id: pitId })));
      if (closed.succeeded !== true) throw new GenerationSealError(PIT_CLEANUP_FAILURE);
    } catch {
      if (!failed) throw new GenerationSealError(PIT_CLEANUP_FAILURE);
      attachPitCleanupDiagnostic(primaryError);
    }
  }
}

function copyOperation(operation: GenerationIndexOperation): GenerationIndexOperation {
  if (!operation || operation.version !== 1 || !/^codex-generation-seal-[0-9a-f]{32}$/.test(operation.indexName)
    || !/^[0-9a-f]{64}$/.test(operation.marker)) throw new GenerationSealError('Invalid generation index operation.');
  return { version: 1, indexName: operation.indexName, marker: operation.marker, identity: copyIdentity(operation.identity) };
}

async function readIndex(client: SealClient, indexName: string, marker: string): Promise<{ uuid: string; writeBlocked: boolean }> {
  const response = object(body(await client.indices.get({ index: indexName, allow_no_indices: false,
    ignore_unavailable: false, expand_wildcards: 'none' })));
  if (Object.keys(response).length !== 1 || !Object.hasOwn(response, indexName)) throw new GenerationSealError('Generation index identity is ambiguous.');
  const entry = object(response[indexName]);
  if (Object.keys(object(entry.aliases)).length !== 0 || object(object(entry.mappings)._meta).generation_owner !== marker) {
    throw new GenerationSealError('Generation index ownership marker changed.');
  }
  const settings = object(object(entry.settings).index);
  const uuid = scalar(settings.uuid, 'index UUID', 128);
  const blocks = settings.blocks === undefined ? {} : object(settings.blocks);
  const write = blocks.write;
  if (write !== undefined && write !== true && write !== false && write !== 'true' && write !== 'false') {
    throw new GenerationSealError('Generation index write-block setting is invalid.');
  }
  return { uuid, writeBlocked: write === true || write === 'true' };
}

function copyIdentity(identity: GenerationIdentity): GenerationIdentity {
  const generation = scalar(identity?.generation, 'generation', 19);
  if (!/^[1-9]\d{0,18}$/.test(generation) || BigInt(generation) > BigInt('9223372036854775807')) {
    throw new GenerationSealError('Invalid generation.');
  }
  return Object.freeze({ tenantId: scalar(identity?.tenantId, 'tenant ID', 128),
    corpusId: scalar(identity?.corpusId, 'corpus ID', 128),
    documentId: scalar(identity?.documentId, 'document ID', 256), generation,
    documentVersion: scalar(identity?.documentVersion, 'document version', 256) });
}

function scalar(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GenerationSealError(`Invalid ${label}.`);
  }
  return value;
}
function body(value: unknown): unknown {
  const entry = object(value);
  return Object.hasOwn(entry, 'body') ? entry.body : entry;
}
function object(value: unknown): Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GenerationSealError('Malformed Elasticsearch seal response.');
  return value as Response;
}
